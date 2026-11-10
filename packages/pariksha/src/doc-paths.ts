// DOC-DRIFT-01, backticked paths: a repository path written in backticks, in
// prose, a shell fence, frontmatter or a code comment (`dir/file.ext`,
// `dir/`, `dir/**/*.ts`), resolves; so does `file.ext:12`, and a backticked
// symbol cited beside it is at those lines. No link checker reads code spans,
// so this is the repository's own check. It needs only the snapshot's file
// list, so it runs at commit with the link check. A path the repository's
// ignore rules cover is out of scope.
import { posix } from 'node:path';
import type { Config } from './doc-references-config.ts';
import { ancestorDirs, codeSpans, commentText, docKind, globToRegExp, isShellFence, normalizeRepoPath, scanMarkdown, type CodeSpan, type DocLine, type ReferenceProblem, type RepoSnapshot } from './doc-references.ts';
import { boundedWord, manifestObject } from './doc-identifiers.ts';

/** `0123abcd:path` and `origin/main:path` name a blob in history, not the tree. */
const HISTORICAL_BLOB = /^(?:[0-9a-f]{7,40}|HEAD[~^\d]*|origin\/[\w./-]+|main):/;

const DOMAIN = /\.(com|org|io|dev|net|ai|app|co|so|sh)$/i;

export interface PathRef {
  readonly path: string;
  readonly glob: boolean;
  readonly dir: boolean;
  readonly lines: readonly [number, number] | undefined;
}

/**
 * Trims wrapping punctuation from a token cut out of prose or a command:
 * opening brackets and quotes before it, closing ones and sentence
 * punctuation (a final `.` or `:` included) after it.
 */
const trimToken = (token: string): string => token.replace(/^[("'[]+/, '').replace(/[)"'\],;!?.:]+$/, '');

/** Digits as a line number, or null past a safe integer: no line this check can count to. */
const lineNumber = (digits: string): number | null => {
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
};

/**
 * The repository path a single token names, or null when it is not one.
 * `requireSlash`: a bare name (`spec.md`) is too generic to resolve unless a
 * line number pins it to one file, so most callers require a directory.
 */
export const pathRef = (config: Config, raw: string, requireSlash = true): PathRef | null => {
  const { placeholder, paths } = config;
  if (placeholder.test(raw)) return null;
  let token = trimToken(raw);
  // `--root=docs/x.md` names its value; `:docs/x.md` names a staged path.
  const assigned = /^-{1,2}[\w-]+=(.+)$/.exec(token);
  if (assigned !== null) token = String(assigned[1]);
  if (HISTORICAL_BLOB.test(token)) return null;
  const blob = /^:([^:\d].*)$/.exec(token);
  if (blob !== null) token = String(blob[1]);
  // A scoped package (`@acme/core/…`) or a flag (`-x/…`). An empty token, a
  // URL, a leading `/` or `~`, `=` and `\` fail the segment test below.
  if (/^[@-]/.test(token)) return null;

  let lines: [number, number] | undefined;
  const lineSuffix = /^(.+?\.[A-Za-z0-9]+)(?::(\d+)(?:-(\d+))?(?::\d+)?|#L(\d+)(?:-L(\d+))?)$/.exec(token);
  if (lineSuffix !== null) {
    token = String(lineSuffix[1]);
    const startText = String(lineSuffix[2] ?? lineSuffix[4]);
    const start = lineNumber(startText);
    const end = lineNumber(lineSuffix[3] ?? lineSuffix[5] ?? startText);
    if (start !== null && end !== null) lines = [start, end];
  }

  const glob = /[*?]/.test(token);
  const dir = token.endsWith('/');
  const segments = token.replace(/\/$/, '').split('/');
  // An empty segment (`a//b`, a leading `/`) fails here too; `{` never gets this far: a placeholder.
  if (!segments.every((segment) => /^[\w.@+*?,-]+$/.test(segment))) return null;
  if (segments.length > 1 && DOMAIN.test(String(segments[0]))) return null;
  if (requireSlash && segments.length < 2 && lines === undefined) return null;
  const extension = /\.([A-Za-z0-9]+)$/.exec(String(segments.at(-1)))?.[1]?.toLowerCase();
  const hasExtension = extension !== undefined && paths.extensions.has(extension);
  if (!dir && !hasExtension && !(glob && segments.length > 1)) return null;
  // `0.1/2.5` and friends: a path segment has at least one letter.
  if (!segments.some((segment) => /[A-Za-z]/.test(segment))) return null;
  if (paths.examples.test(token.replace(/\/$/, ''))) return null;
  if (paths.untracked.some((prefix) => `${token}/`.startsWith(prefix))) return null;
  return { path: token, glob, dir, lines };
};

interface Resolution {
  /** The tracked file or directory the reference resolved to. */
  readonly path: string | null;
  /** Every repo-relative form tried, for the ignore check. */
  readonly tried: string[];
}

interface Resolver {
  readonly inDependency: (path: string) => boolean;
  readonly resolveLoose: (doc: string, ref: PathRef) => Resolution;
  readonly anchored: (doc: string, ref: PathRef) => boolean;
}

const DEPENDENCY_LISTS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

const resolverFor = (config: Config, snapshot: RepoSnapshot): Resolver => {
  const manifests = [...snapshot.files].filter((file) => file === 'package.json' || config.paths.workspaces.test(file));
  // A workspace's source root too: code comments cite `src`-relative paths.
  const workspaces = manifests.filter((file) => file !== 'package.json').flatMap((file) => [posix.dirname(file), `${posix.dirname(file)}/src`]);
  // Package names any tracked manifest depends on: `pg-pool/index.js` is a file inside one.
  const dependencies = new Set<string>();
  for (const text of snapshot.readMany(manifests).values()) {
    const pkg = manifestObject(text);
    for (const list of DEPENDENCY_LISTS) {
      const deps = pkg?.[list];
      // A malformed list names no dependencies; the manifest's other lists count.
      if (typeof deps === 'object' && deps !== null && !Array.isArray(deps)) for (const name of Object.keys(deps)) dependencies.add(name);
    }
  }
  const globs = new Map<string, boolean>();
  const globMatches = (glob: string): boolean => {
    const cached = globs.get(glob);
    if (cached !== undefined) return cached;
    const pattern = globToRegExp(glob);
    const found = [...snapshot.files, ...snapshot.dirs].some((path) => pattern.test(path));
    globs.set(glob, found);
    return found;
  };
  const exists = (path: string): boolean => snapshot.files.has(path) || snapshot.dirs.has(path);
  return {
    inDependency: (path) => dependencies.has(String(path.split('/')[0])),
    // A path as a reader would resolve it: next to the doc, then upwards, then from each workspace.
    resolveLoose: (doc, ref) => {
      const tried = [...new Set([...ancestorDirs(doc), ...workspaces].map((base) => normalizeRepoPath(posix.join(base, ref.path))))].filter((candidate) => candidate !== null);
      const path = tried.find((candidate) => (ref.glob ? globMatches(candidate) : exists(candidate))) ?? null;
      // A directory is asked about as one, so `dir/` ignore rules apply.
      return { path, tried: ref.dir ? tried.map((t) => `${t}/`) : tried };
    },
    // A directory or glob is anchored when its first segment exists from some base:
    // `refs/heads/*` and branch prefixes are not paths. `..` above the root is anchored.
    anchored: (doc, ref) => {
      const first = String(ref.path.split('/')[0]);
      if (first === '..') return true;
      return [...ancestorDirs(doc), ...workspaces].some((base) => {
        const candidate = normalizeRepoPath(posix.join(base, first));
        return candidate !== null && snapshot.dirs.has(candidate);
      });
    },
  };
};

interface PendingPath {
  readonly file: string;
  readonly line: number;
  readonly ref: string;
  readonly reason: string;
  /** Repo-relative forms; the problem stands only if none is ignored. */
  readonly tried: readonly string[];
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;

/** The backticked symbol cited beside a span: "`name` in `file.ts:12`", or "`file.ts:12` (`name`)". */
const symbolNear = (text: string, spans: readonly CodeSpan[], index: number): string | null => {
  const span = spans[index];
  if (span === undefined) return null;
  const before = spans[index - 1];
  if (before !== undefined && IDENTIFIER.test(before.content) && /^\s*(?:\(|at|in|—|–|-|:)?\s*\[?$/.test(text.slice(before.end + 1, span.start - 1))) return before.content;
  const after = spans[index + 1];
  if (after !== undefined && IDENTIFIER.test(after.content) && /^\]?(?:\([^)]*\))?\s*\(\s*$/.test(text.slice(span.end + 1, after.start - 1))) return after.content;
  return null;
};

/** DOC-DRIFT-01's backticked paths over `files` in `snapshot`. Links and anchors are lychee's (doc-links.ts). */
export const findPathProblems = (config: Config, snapshot: RepoSnapshot, files: readonly string[]): ReferenceProblem[] => {
  const resolver = resolverFor(config, snapshot);
  const pending: PendingPath[] = [];
  const flag = (file: string, line: number, ref: string, reason: string, tried: readonly string[] = []): void => {
    pending.push({ file, line, ref, reason, tried });
  };

  /** Checks a resolved file's line range and the symbol cited beside it. */
  const checkLines = (file: string, line: number, shown: string, target: string, lines: readonly [number, number], symbol: string | null): void => {
    // A directory has no lines to count.
    const text = snapshot.read(target);
    if (text === undefined) return;
    const content = text.split('\n');
    const count = text.endsWith('\n') ? content.length - 1 : content.length;
    const [start, end] = lines;
    if (start < 1 || end < start || end > count) {
      flag(file, line, shown, `\`${target}\` has ${count} lines; line ${end > count ? end : start} does not exist`);
      return;
    }
    if (symbol === null) return;
    // `a.b.run()` is looked for as `run`.
    const name = symbol.replace(/\(\)$/, '').replace(/^.*\./, '');
    const window = content.slice(Math.max(0, start - 4), end + 3).join('\n');
    if (!boundedWord(name).test(window)) flag(file, line, shown, `\`${symbol}\` is not at \`${target}:${start}${end === start ? '' : `-${end}`}\` — the citation drifted`);
  };

  /** A backticked or fenced token: resolve loosely, then lines and symbol. */
  const checkToken = (file: string, line: number, token: string, symbol: string | null): void => {
    const ref = pathRef(config, token, true);
    if (ref === null || config.paths.layouts.some((l) => l.pattern.test(ref.path) && !(l.except?.test(file) ?? false))) return;
    let target: string | null;
    let tried: readonly string[];
    if (!ref.path.includes('/')) {
      const near = resolver.resolveLoose(file, ref);
      tried = near.tried;
      if (near.path !== null) {
        target = near.path;
      } else {
        const matches = snapshot.byBasename.get(ref.path) ?? [];
        if (matches.length > 1) return; // ambiguous: cannot tell which file
        target = matches[0] ?? null;
      }
    } else {
      if ((ref.dir || ref.glob) && !resolver.anchored(file, ref)) return;
      if (resolver.inDependency(ref.path)) return;
      const resolved = resolver.resolveLoose(file, ref);
      target = resolved.path;
      tried = resolved.tried;
    }
    if (target === null) {
      flag(file, line, token, ref.glob ? `\`${ref.path}\` matches no tracked file` : `\`${ref.path}\` is not tracked (looked beside the doc, above it and at the root)`, tried);
      return;
    }
    if (ref.dir && snapshot.files.has(target)) {
      flag(file, line, token, `\`${ref.path}\` is a file, not a directory`);
      return;
    }
    if (ref.lines !== undefined) checkLines(file, line, token, target, ref.lines, symbol);
  };

  const checkSpans = (file: string, line: number, text: string, skipLinkLabels: boolean): void => {
    const spans = codeSpans(text);
    spans.forEach((span, index) => {
      // A span that is the label of a link is checked through its link.
      if (skipLinkLabels && /\]\(/.test(text.slice(span.end, span.end + 3))) return;
      const symbol = symbolNear(text, spans, index);
      for (const token of span.content.split(/\s+/)) checkToken(file, line, token, symbol);
    });
  };

  const checkMarkdownLine = (file: string, line: DocLine): void => {
    if (line.exempt) return;
    if (line.fence !== null) {
      if (!isShellFence(line.fence)) return;
      // A `$ ` prompt is no path (a placeholder); a `#` word starts a comment that runs to the end of the line.
      for (const token of line.text.split(/\s+/)) {
        if (token.startsWith('#')) break;
        checkToken(file, line.number, token, null);
      }
      return;
    }
    if (line.frontmatter) {
      for (const [, value] of line.text.matchAll(/^\s*(?:-\s+|[\w-]+:\s+)(.+)$/g)) {
        for (const token of String(value).split(/[\s,]+/)) checkToken(file, line.number, token, null);
      }
      return;
    }
    checkSpans(file, line.number, line.text, true);
  };

  for (const file of files) {
    const kind = docKind(config, file);
    const content = snapshot.read(file);
    if (kind === null || content === undefined) continue;
    if (kind === 'markdown') {
      for (const line of scanMarkdown(content, config.exemptMarker)) checkMarkdownLine(file, line);
    } else if (kind === 'code') {
      content.split('\n').forEach((text, index) => {
        const comment = commentText(config.files.hashComments, file, text);
        if (comment === null || config.exemptMarker.test(comment)) return;
        checkSpans(file, index + 1, comment, false);
      });
    }
  }

  const ignored = snapshot.ignored([...new Set(pending.flatMap((problem) => problem.tried))]);
  return pending.filter((problem) => !problem.tried.some((path) => ignored.has(path))).map(({ file, line, ref, reason }) => ({ check: 'DOC-DRIFT-01' as const, file, line, ref, reason }));
};
