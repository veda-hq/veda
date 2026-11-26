// The doc-references engine's shared part: which snapshot of the repository a
// reference resolves against, how a Markdown line splits into prose, code
// spans and fences, which tracked files carry references, and the per-file
// baseline whose counts only fall.
//
// A reference resolves against the SNAPSHOT being committed or pushed, never
// the worktree: a doc naming a file that exists on disk but is not staged
// would pass a worktree check and land broken.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import type { Config } from './doc-references-config.ts';
import { gitEnv, PINNED } from './git.ts';
import { isRecord } from './registry-ratchet.ts';

export type CheckId = 'DOC-DRIFT-01' | 'DOC-DRIFT-02' | 'DOC-DRIFT-04';

/** The three checks: paths and links, commands and scripts, code identifiers. */
export const CHECK_IDS: readonly CheckId[] = ['DOC-DRIFT-01', 'DOC-DRIFT-02', 'DOC-DRIFT-04'];

export interface ReferenceProblem {
  readonly check: CheckId;
  readonly file: string;
  readonly line: number;
  readonly ref: string;
  readonly reason: string;
}

/** Where file names and contents come from. */
export type SnapshotSource = { readonly kind: 'index' } | { readonly kind: 'worktree' } | { readonly kind: 'ref'; readonly ref: string };

export interface RepoSnapshot {
  readonly root: string;
  readonly source: SnapshotSource;
  /** Every tracked path in the snapshot. */
  readonly files: ReadonlySet<string>;
  /** Every directory that holds at least one tracked path ('' is the root). */
  readonly dirs: ReadonlySet<string>;
  /** Tracked paths grouped by basename, for `name.ts:12` citations. */
  readonly byBasename: ReadonlyMap<string, readonly string[]>;
  /** Content of a tracked path, or undefined when it is not tracked. */
  read(path: string): string | undefined;
  /** Contents of many tracked paths in one pass; untracked ones are absent. */
  readMany(paths: readonly string[]): Map<string, string>;
  /** The subset of `paths` that tracked .gitignore rules ignore. */
  ignored(paths: readonly string[]): Set<string>;
}

/** Every git read, a whole-tree `cat-file --batch` included, fits in this. */
const MAX_BUFFER = 1 << 30;

const gitOptions = (root: string) =>
  ({
    cwd: root,
    env: gitEnv(process.env),
    maxBuffer: MAX_BUFFER,
    // Captured, not inherited: a failure's stderr travels on the error.
    stdio: 'pipe',
  }) as const;

/** Git's stdout as text; throws (stderr on the error) when git exits non-zero. */
export const git = (root: string, args: readonly string[]): string => execFileSync('git', [...PINNED, ...args], gitOptions(root)).toString('utf8');

/** Git's stdout, or undefined when git exits non-zero. */
export const gitOrUndefined = (root: string, args: readonly string[]): string | undefined => {
  try {
    return git(root, args);
  } catch {
    // A non-zero exit reads as nothing.
  }
  return undefined;
};

const listFiles = (root: string, source: SnapshotSource): string[] =>
  (source.kind === 'ref' ? git(root, ['ls-tree', '-r', '-z', '--name-only', source.ref]) : git(root, ['ls-files', '-z'])).split('\0').filter(Boolean);

/** path → blob id for an index or ref snapshot (gitlinks excluded). */
const blobIds = (root: string, source: SnapshotSource): Map<string, string> => {
  const ids = new Map<string, string>();
  const output = source.kind === 'ref' ? git(root, ['ls-tree', '-r', '-z', source.ref]) : git(root, ['ls-files', '-s', '-z']);
  // Each entry is its metadata, a tab, and its path.
  for (const [, fields, path] of output.matchAll(/([^\0\t]*)\t([^\0]*)/g)) {
    const meta = String(fields).split(' ');
    if (meta[0] === '160000') continue;
    // ls-tree: mode type oid; ls-files -s: mode oid stage
    ids.set(String(path), String(source.kind === 'ref' ? meta[2] : meta[1]));
  }
  return ids;
};

/** Contents of `oids` from one `git cat-file --batch`, in order. */
export const catFileBatch = (root: string, oids: readonly string[]): string[] => {
  const buffer = execFileSync('git', [...PINNED, 'cat-file', '--batch'], { ...gitOptions(root), input: `${oids.join('\n')}\n` });
  const out: string[] = [];
  let offset = 0;
  for (let i = 0; i < oids.length; i += 1) {
    const headerEnd = buffer.indexOf(0x0a, offset);
    const header = buffer.subarray(offset, headerEnd).toString('utf8');
    const size = Number(header.split(' ')[2]);
    if (!Number.isSafeInteger(size)) throw new Error(`git cat-file --batch: unexpected header "${header}"`);
    out.push(buffer.subarray(headerEnd + 1, headerEnd + 1 + size).toString('utf8'));
    offset = headerEnd + 1 + size + 1;
  }
  return out;
};

export const createSnapshot = (root: string, source: SnapshotSource): RepoSnapshot => {
  const files = new Set(listFiles(root, source));
  const dirs = new Set<string>(['']);
  const byBasename = new Map<string, string[]>();
  for (const file of files) {
    let dir = posix.dirname(file);
    while (dir !== '.' && !dirs.has(dir)) {
      dirs.add(dir);
      dir = posix.dirname(dir);
    }
    const base = posix.basename(file);
    const list = byBasename.get(base);
    if (list === undefined) byBasename.set(base, [file]);
    else list.push(file);
  }

  // A tracked file the worktree holds unchanged is read from disk; only paths
  // whose worktree copy differs from the snapshot go through git. A tracked
  // symlink is read as its link text, which is what git stores.
  let dirty: Set<string> | undefined;
  const fromDisk = (path: string): boolean => {
    if (source.kind === 'worktree') return true;
    // Named, not defaulted: only the index compares with no revision. The
    // last NUL leaves an empty name, which no tracked path is.
    dirty ??= new Set(git(root, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', ...(source.kind === 'index' ? [] : [source.ref]), '--']).split('\0'));
    return !dirty.has(path);
  };
  const diskRead = (path: string): string | undefined => {
    const full = join(root, path);
    try {
      return lstatSync(full).isSymbolicLink() ? readlinkSync(full) : readFileSync(full, 'utf8');
    } catch {
      // An unreadable disk copy falls back to the git blob below.
    }
    return undefined;
  };

  // path → content; undefined when a tracked path has nothing to read (a
  // submodule entry, or a worktree file deleted after it was listed).
  const cache = new Map<string, string | undefined>();
  let oids: Map<string, string> | undefined;
  const blobId = (path: string): string | undefined => (oids ??= blobIds(root, source)).get(path);
  const readMany = (paths: readonly string[]): Map<string, string> => {
    const unread = paths.filter((p) => files.has(p) && !cache.has(p));
    for (const path of unread) {
      const content = fromDisk(path) ? diskRead(path) : undefined;
      // A worktree snapshot has no blob behind its files: absent is absent.
      if (content !== undefined || source.kind === 'worktree') cache.set(path, content);
    }
    const viaGit = unread.filter((path) => !cache.has(path));
    const wanted = viaGit.flatMap((path) => {
      const oid = blobId(path);
      return oid === undefined ? [] : [{ path, oid }];
    });
    if (wanted.length !== 0) {
      const texts = catFileBatch(
        root,
        wanted.map((w) => w.oid),
      );
      wanted.forEach((w, i) => cache.set(w.path, texts[i]));
    }
    const out = new Map<string, string>();
    for (const path of paths) {
      const content = cache.get(path);
      if (content !== undefined) out.set(path, content);
    }
    return out;
  };
  const read = (path: string): string | undefined => readMany([path]).get(path);

  let rules: IgnoreRules | undefined;
  const ignored = (paths: readonly string[]): Set<string> => {
    rules ??= ignoreRules(dirs, readMany);
    const matcher = rules;
    return new Set(paths.filter((path) => isIgnored(matcher, path)));
  };

  return { root, source, files, dirs, byBasename, read, readMany, ignored };
};

// ── .gitignore rules, read from the snapshot ────────────────────────────────

/**
 * Ignore rules come from the snapshot's own tracked `.gitignore` files, not
 * from `git check-ignore`: that also reads `.git/info/exclude` and the user's
 * global excludes, so a reference could pass on one machine and fail in CI.
 */
interface IgnoreRule {
  /** Directory of the .gitignore ('' for the root). */
  readonly base: string;
  readonly pattern: RegExp;
  readonly negated: boolean;
  readonly dirOnly: boolean;
}

type IgnoreRules = readonly IgnoreRule[];

/** One line of the `.gitignore` in `base`; null for a blank line or a `#` comment, which hold no rule. */
const ignoreRule = (base: string, raw: string): IgnoreRule | null => {
  let line = raw.replace(/(?<!\\)\s+$/, '');
  if (!/^[^#]/.test(line)) return null;
  const negated = line.startsWith('!');
  if (negated) line = line.slice(1);
  const dirOnly = line.endsWith('/');
  if (dirOnly) line = line.slice(0, -1);
  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);
  const body = globToRegExp(line.replace(/\\(.)/g, '$1')).source.slice(1, -1);
  return { base, pattern: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`), negated, dirOnly };
};

const ignoreRules = (dirs: ReadonlySet<string>, readMany: (paths: readonly string[]) => Map<string, string>): IgnoreRules => {
  // Lexical order puts every directory before its descendants, so a nested
  // file's rules come later and override. A folder with no tracked
  // `.gitignore` reads as nothing.
  const texts = readMany([...dirs].sort().map((dir) => (dir === '' ? '.gitignore' : `${dir}/.gitignore`)));
  return [...texts].flatMap(([source, text]) => {
    const base = posix.dirname(source) === '.' ? '' : posix.dirname(source);
    return text
      .split('\n')
      .map((raw) => ignoreRule(base, raw))
      .filter((rule) => rule !== null);
  });
};

/** Whether `path` (a trailing `/` marks a directory) is ignored. */
const isIgnored = (rules: IgnoreRules, path: string): boolean => {
  const isDir = path.endsWith('/');
  const segments = path.replace(/\/$/, '').split('/');
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const prefix = segments.slice(0, depth).join('/');
    const prefixIsDir = depth < segments.length || isDir;
    let verdict = false;
    for (const rule of rules) {
      if (rule.dirOnly && !prefixIsDir) continue;
      if (rule.base !== '' && !prefix.startsWith(`${rule.base}/`)) continue;
      if (rule.pattern.test(posix.relative(rule.base, prefix))) verdict = !rule.negated;
    }
    // Git never looks inside an ignored directory, so nothing below it can be re-included.
    if (verdict) return true;
  }
  return false;
};

// ── which tracked files carry references ────────────────────────────────────

export type DocKind = 'markdown' | 'html' | 'code';

const any = (patterns: readonly RegExp[], path: string): boolean => patterns.some((p) => p.test(path));

/** What a tracked path is to the checks, by the config's `files`; null when it carries no references. */
export const docKind = (config: Config, path: string): DocKind | null => {
  const { files } = config;
  if (any(files.exclude, path)) return null;
  if (any(files.markdown, path)) return 'markdown';
  if (any(files.html, path)) return 'html';
  if (any(files.code, path)) return any(files.codeExclude, path) ? null : 'code';
  return null;
};

/** Every tracked file a reference check reads, in git's order, which sorts them. */
export const referenceFiles = (config: Config, snapshot: RepoSnapshot): string[] => [...snapshot.files].filter((path) => docKind(config, path) !== null);

// ── Markdown structure ──────────────────────────────────────────────────────

export interface DocLine {
  readonly number: number;
  /** The line with HTML comments and strikethrough removed. */
  readonly text: string;
  /** Fence info string ('' when bare) for a line inside a fence; else null. */
  readonly fence: string | null;
  /** Which fence of the document a fenced line is in (the first is 1); else null. */
  readonly block: number | null;
  readonly frontmatter: boolean;
  /** The author marked this line `<marker>: <reason>`. */
  readonly exempt: boolean;
}

/**
 * A fence line: the marker, the info word, and the rest. CommonMark: a
 * backtick fence's info string holds no backtick, and a closer carries
 * nothing after its marker but spaces.
 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)([\s\S]*)/;

/** The first `<!--` in `text` outside every code span, or -1. */
const commentOpener = (text: string): number => {
  // A span's interior holds no backtick, so no `<!--` straddles its edge.
  const masked = codeSpans(text).reduce((out, span) => out.slice(0, span.start) + ' '.repeat(span.end - span.start) + out.slice(span.end), text);
  return masked.indexOf('<!--');
};

/** `rest` with its HTML comments cut out, and whether a comment is still open at its end. */
const stripComments = (rest: string, comment: boolean): { text: string; comment: boolean } => {
  if (comment) {
    const end = rest.indexOf('-->');
    return end === -1 ? { text: '', comment: true } : stripComments(rest.slice(end + 3), false);
  }
  // Code spans first: a `<!--` quoted in a span opens no comment.
  const start = commentOpener(rest);
  if (start === -1) return { text: rest, comment: false };
  const after = stripComments(rest.slice(start + 4), true);
  return { text: rest.slice(0, start) + after.text, comment: after.comment };
};

/** Every line of a Markdown document, placed: prose, fence, frontmatter, exempt. */
export const scanMarkdown = (content: string, exemptMarker: RegExp): DocLine[] => {
  const lines = content.split('\n');
  const out: DocLine[] = [];
  let fence: { marker: string; info: string; block: number } | null = null;
  let blocks = 0;
  // `split` gives at least one line.
  let frontmatter = String(lines[0]).trim() === '---';
  let comment = false;

  lines.forEach((raw, index) => {
    const number = index + 1;
    const exempt = exemptMarker.test(raw);
    if (frontmatter) {
      // Only an unindented `---` ends the YAML document.
      if (index > 0 && raw.trimEnd() === '---') {
        frontmatter = false;
        return;
      }
      if (index > 0) out.push({ number, text: raw, fence: null, block: null, frontmatter: true, exempt });
      return;
    }
    // The marker, the info word, and the rest of the line.
    const opener = FENCE.exec(raw) as unknown as [string, string, string, string] | null;
    if (fence !== null) {
      if (opener !== null && opener[1].charAt(0) === fence.marker.charAt(0) && opener[1].length >= fence.marker.length && opener[2] === '') {
        fence = null;
        return;
      }
      out.push({ number, text: raw, fence: fence.info, block: fence.block, frontmatter: false, exempt });
      return;
    }
    // A fence line inside an HTML comment is part of the comment.
    if (opener !== null && !comment && !(opener[1].charAt(0) === '`' &&`${opener[2]}${opener[3]}`.includes('`'))) {
      blocks += 1;
      fence = { marker: opener[1], info: opener[2].toLowerCase(), block: blocks };
      return;
    }
    // HTML comments, possibly spanning lines, carry no references.
    const stripped = stripComments(raw, comment);
    comment = stripped.comment;
    // Struck-through text records what used to be true.
    out.push({ number, text: stripped.text.replace(/~~[^~]+~~/g, ''), fence: null, block: null, frontmatter: false, exempt });
  });
  return out;
};

export interface CodeSpan {
  /** Offset just past the opening run. */
  readonly start: number;
  /** Offset of the closing run. */
  readonly end: number;
  /** Length of each delimiter run. */
  readonly delimiter: number;
  readonly content: string;
}

/** An escaped ASCII punctuation character, or a whole backtick run. */
const ESCAPE_OR_RUN = /\\[!-/:-@[-`{-~]|`+/g;

/** A backtick run that opens a code span, and the offset of the run that closes it (-1: none, the run is literal). */
export interface BacktickRun {
  readonly open: number;
  readonly length: number;
  readonly close: number;
}

/**
 * Every opening backtick run in `text`, by CommonMark's rule: a span opens
 * at a whole backtick run no backslash escapes and closes at the next run of
 * the same length; escapes do not apply inside a span.
 */
export const backtickRuns = (text: string): BacktickRun[] => {
  const runs: BacktickRun[] = [];
  const scan = new RegExp(ESCAPE_OR_RUN);
  for (let match = scan.exec(text); match !== null; match = scan.exec(text)) {
    if (match[0].startsWith('\\')) continue;
    const open = match.index;
    const { length } = match[0];
    const closer = new RegExp(`(?<!\`)\`{${length}}(?!\`)`, 'g');
    closer.lastIndex = open + length;
    const close = closer.exec(text);
    runs.push({ open, length, close: close?.index ?? -1 });
    // Past the closing run; a failed search resets closer to 0, so an unclosed run resumes right after itself.
    scan.lastIndex = Math.max(scan.lastIndex, closer.lastIndex);
  }
  return runs;
};

/** Inline code spans that close: interior offsets and trimmed content. */
export const codeSpans = (text: string): CodeSpan[] =>
  backtickRuns(text).flatMap((run) => {
    if (run.close === -1) return [];
    const start = run.open + run.length;
    return [{ start, end: run.close, delimiter: run.length, content: text.slice(start, run.close).trim() }];
  });

/** Text with every code span, delimiter runs included, blanked to spaces, so offsets survive. */
export const proseOnly = (text: string, spans: readonly CodeSpan[]): string => {
  let out = text;
  for (const span of spans) {
    const from = span.start - span.delimiter;
    const to = span.end + span.delimiter;
    out = out.slice(0, from) + ' '.repeat(to - from) + out.slice(to);
  }
  return out;
};

/** Fence info strings that mark a block as shell; '' (a bare fence) among them. */
const SHELL_FENCES: ReadonlySet<string> = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal']);

/** Whether a fence's info string marks its lines as shell commands. */
export const isShellFence = (info: string): boolean => SHELL_FENCES.has(info);

/**
 * Comment text of a source line, or null when the line has no comment. Only
 * full-line comments and JSDoc bodies count: a `//` inside a string is far
 * more often a URL than a remark.
 */
export const commentText = (hashComments: RegExp, path: string, line: string): string | null => {
  const trimmed = line.trimStart();
  if (hashComments.test(path)) {
    if (trimmed.startsWith('#!')) return null;
    return trimmed.startsWith('#') ? trimmed.slice(1) : null;
  }
  if (trimmed.startsWith('//') || trimmed.startsWith('/*')) return trimmed.slice(2);
  if (trimmed.startsWith('*') && !trimmed.startsWith('*/')) return trimmed.slice(1);
  return null;
};

// ── the baseline: per-file counts that only fall ────────────────────────────

export interface Baseline {
  readonly version: 1;
  /** file → check → count of problems that predate the check. */
  readonly files: Record<string, Partial<Record<CheckId, number>>>;
}

export const emptyBaseline = (): Baseline => ({ version: 1, files: Object.create(null) as Baseline['files'] });

/** The baseline at `where` (named in messages) from its text. */
export const parseBaseline = (text: string, where: string): Baseline => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${where}: not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw) || raw['version'] !== 1 || !isRecord(raw['files']) || Object.keys(raw).some((k) => k !== 'version' && k !== 'files')) {
    throw new Error(`${where}: expected { "version": 1, "files": {} }`);
  }
  const files = emptyBaseline().files;
  for (const [file, counts] of Object.entries(raw['files'])) {
    if (!isRecord(counts)) throw new Error(`${where}: ${file} must map check ids to counts`);
    const entry: Partial<Record<CheckId, number>> = {};
    for (const [check, count] of Object.entries(counts)) {
      if (!(CHECK_IDS as readonly string[]).includes(check)) throw new Error(`${where}: ${file} names unknown check ${check}`);
      // Only a number is a safe integer.
      if (!Number.isSafeInteger(count) || (count as number) < 1) throw new Error(`${where}: ${file} ${check} must be a positive integer`);
      entry[check as CheckId] = count as number;
    }
    files[file] = entry;
  }
  return { version: 1, files };
};

export const serializeBaseline = (baseline: Baseline): string => {
  const sorted: Record<string, Partial<Record<CheckId, number>>> = {};
  for (const file of Object.keys(baseline.files).sort()) {
    const counts = baseline.files[file] ?? {};
    const entry: Partial<Record<CheckId, number>> = {};
    for (const check of CHECK_IDS) {
      const count = counts[check];
      if (count !== undefined && count > 0) entry[check] = count;
    }
    if (Object.keys(entry).length > 0) sorted[file] = entry;
  }
  return `${JSON.stringify({ version: 1, files: sorted }, null, 2)}\n`;
};

export const countProblems = (problems: readonly ReferenceProblem[]): Map<string, Map<CheckId, number>> => {
  const counts = new Map<string, Map<CheckId, number>>();
  for (const problem of problems) {
    const byCheck = counts.get(problem.file) ?? new Map<CheckId, number>();
    counts.set(problem.file, byCheck);
    byCheck.set(problem.check, (byCheck.get(problem.check) ?? 0) + 1);
  }
  return counts;
};

export interface Slack {
  readonly file: string;
  readonly check: CheckId;
  readonly baseline: number;
  readonly actual: number;
}

export interface RatchetResult {
  /** Problems in files whose count rose above the baseline. */
  readonly failures: ReferenceProblem[];
  /** Files whose count fell: the baseline must be lowered to match. */
  readonly slack: Slack[];
}

/**
 * Applies the baseline to problems found in `checked` files for `checks`. A
 * file over its count fails with every problem it has (the new one cannot be
 * told apart); a file under its count is slack the baseline must give up.
 */
export const applyBaseline = (problems: readonly ReferenceProblem[], baseline: Baseline, checked: readonly string[], checks: readonly CheckId[]): RatchetResult => {
  const counts = countProblems(problems);
  const failures: ReferenceProblem[] = [];
  const slack: Slack[] = [];
  for (const file of checked) {
    for (const check of checks) {
      const allowed = baseline.files[file]?.[check] ?? 0;
      const actual = counts.get(file)?.get(check) ?? 0;
      if (actual > allowed) failures.push(...problems.filter((p) => p.file === file && p.check === check));
      else if (actual < allowed) slack.push({ file, check, baseline: allowed, actual });
    }
  }
  return { failures, slack };
};

/** A baseline may only lose entries and lower counts: one message per entry added or raised since `previous`. */
export const baselineGrowth = (previous: Baseline, next: Baseline): string[] => {
  const growth: string[] = [];
  for (const [file, counts] of Object.entries(next.files)) {
    for (const check of CHECK_IDS) {
      const now = counts[check] ?? 0;
      const before = previous.files[file]?.[check] ?? 0;
      if (now > before) growth.push(`${file} ${check}: ${before} → ${now} (a baseline only falls; fix the reference instead)`);
    }
  }
  return growth;
};

// ── a merge in progress ─────────────────────────────────────────────────────

/** NUL-separated names; the last NUL leaves an empty name, which no path is. */
const names = (root: string, args: readonly string[]): string[] => git(root, args).split('\0');

/** Every commit MERGE_HEAD names, one per merged head of an octopus merge; empty outside a merge. */
export const mergeHeads = (root: string): string[] => {
  if (gitOrUndefined(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD^{commit}']) === undefined) return [];
  const file = git(root, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim();
  return readFileSync(resolve(root, file), 'utf8').split('\n').filter(Boolean);
};

/**
 * Staged paths a merge took from one of its merged heads unchanged; empty
 * outside a merge. A merge stages every file the other branch changed, and
 * its gates judged them: a path is taken when it differs from HEAD and
 * matches some merged head (the same blob, or absent from both).
 */
export const takenFromMerge = (root: string): ReadonlySet<string> => {
  const heads = mergeHeads(root);
  if (heads.length === 0) return new Set();
  const differsFromEach = heads.map((head) => new Set(names(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', head])));
  return new Set(names(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--diff-filter=ADMT', 'HEAD']).filter((path) => differsFromEach.some((differs) => !differs.has(path))));
};

// ── small shared helpers ────────────────────────────────────────────────────

/** A glob character class: it closes at the first `]` after its first character, so `[]a]` holds `]` and `a`. */
const CLASS = /\[([\s\S][^\]]*)\]/y;

/** Glob → anchored RegExp over repo-relative paths (`**`, `*`, `?`, `[…]`, `{a,b}`). */
export const globToRegExp = (glob: string): RegExp => {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '[') {
      CLASS.lastIndex = i;
      const match = CLASS.exec(glob);
      if (match === null) {
        out += '\\[';
      } else {
        // `]` and `\` are literal in a glob class; a RegExp class needs them escaped.
        out += `[${String(match[1])
          .replace(/^!/, '^')
          .replace(/[\\\]]/g, '\\$&')}]`;
        i = CLASS.lastIndex - 1;
      }
    } else if (char === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) {
        out += '\\{';
      } else {
        const options = glob
          .slice(i + 1, close)
          .split(',')
          .map((option) => option.replace(/[.+^$()|[\]\\]/g, '\\$&'));
        out += `(?:${options.join('|')})`;
        i = close;
      }
    } else {
      out += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
};

/** Repo-relative normalisation; null when the path escapes the root. */
export const normalizeRepoPath = (path: string): string | null => {
  const normalized = posix.normalize(path).replace(/\/$/, '');
  if (normalized === '.') return '';
  // A repo path from a git snapshot: after normalize, it escapes exactly when its first component is `..`.
  if (normalized.split('/')[0] === '..') return null;
  return normalized;
};

/** The directory of `file` and each of its ancestors, nearest first. */
export const ancestorDirs = (file: string): string[] => {
  const parts = file.split('/').slice(0, -1);
  return [...parts.map((_, depth) => parts.slice(0, parts.length - depth).join('/')), ''];
};
