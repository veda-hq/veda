// The authority-citations check: a line that invokes an authority ("owner
// decision", "approved by the founder", "per the CTO") must cite something only
// that authority could have produced, outside the file making the claim.
//
// A claim asserted inside the file it justifies cannot be checked from inside
// that file: an agent that deletes a public API and calls it "an owner
// decision" passes every internal-consistency gate, because a coherent
// fabrication is consistent. So the check asks for an anchor within three lines
// of the claim:
//
//   resolved here:      an ADR number whose file exists (not the claiming file),
//                       a commit id that names a commit in this repository
//   shape-checked only: an issue id with a configured prefix (ABC-123), a
//                       GitHub pull request or issue URL, "PR #123"
//
// `ALLOW-AUTHORITY-PHRASE: <reason>` in the same window marks words that are
// used without asserting authority; the reason is required.
//
// staged mode judges only lines the commit adds; on a merge, only lines new
// against every parent, so text a merged branch already carried is not judged
// again. tree mode judges every tracked file.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { must, PLAIN_DIFF, type Git } from './git.ts';

export interface Options {
  /** Names that count as an authority besides the built-in offices. */
  readonly authorities: readonly string[];
  /** Issue-tracker prefixes whose ids (PREFIX-123) count as a citation. */
  readonly issuePrefixes: readonly string[];
  /** Where numbered ADRs live, as NNNN-title.md, relative to the root. */
  readonly adrDir: string;
}

export const DEFAULTS: Options = { authorities: [], issuePrefixes: [], adrDir: 'docs/adr' };

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An authority is a person or an office, never a subsystem: requiring one after
 * "approved by" and "per" keeps "decided by the diff status" out.
 */
export const phrasePattern = (authorities: readonly string[]): RegExp => {
  const names = ['owner', 'founder', 'CTO', 'CEO', 'management', 'leadership', ...authorities.map(escape), '@[A-Za-z0-9._-]+'];
  const who = `(?:the )?(?:${names.join('|')})`;
  return new RegExp(`owner (?:decision|decided)|founder (?:decision|decided)|product rule|(?:approved|decided|authorized|mandated) by ${who}|per ${who}`, 'i');
};

const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|sql|prisma|sh|md)$/;
/** Vendored, generated and scratch trees carry no authored claims. */
const SKIPPED_PATH = /(^|\/)(node_modules|dist|build|coverage|\.tmp|\.local|generated)\//;
const WINDOW = 3;

/** The lines within WINDOW of the 1-based line `center`, joined. */
export const windowOf = (lines: readonly string[], center: number): string =>
  lines.slice(Math.max(0, center - 1 - WINDOW), center + WINDOW).join('\n');

/** True when the window holds the pragma with a reason, or a citation that resolves. */
export const hasCitation = (window: string, claimingFile: string, opts: Options, git: Git, adrFiles: readonly string[]): boolean => {
  if (/ALLOW-AUTHORITY-PHRASE:[^\S\n]*\S/.test(window)) return true;
  if (opts.issuePrefixes.length > 0 && new RegExp(`\\b(?:${opts.issuePrefixes.map(escape).join('|')})-[0-9]+\\b`).test(window)) return true;
  if (/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues)\/[0-9]+/.test(window)) return true;
  if (/\bPR #[0-9]+\b/.test(window)) return true;
  for (const [, n] of window.matchAll(new RegExp(`(?:ADR-|${escape(opts.adrDir)}/)([0-9]{4})`, 'g'))) {
    if (adrFiles.some((f) => f.startsWith(`${opts.adrDir}/${n}-`) && f.endsWith('.md') && f !== claimingFile)) return true;
  }
  for (const [sha] of window.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    if (git.run(['cat-file', '-e', `${sha}^{commit}`]) !== undefined) return true;
  }
  return false;
};

/** 1-based line numbers a `-U0` diff adds. */
export const addedLines = (diff: string): Set<number> => {
  const out = new Set<number>();
  for (const line of diff.split('\n')) {
    const m = /^@@ [^+]*\+([0-9]+)(?:,([0-9]+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) out.add(start + i);
  }
  return out;
};

/**
 * The other parents of the merge being committed; none outside a merge.
 * MERGE_HEAD exists once a merge stops (a conflict, --no-commit). A clean
 * merge runs the pre-merge-commit hook before writing MERGE_HEAD, leaving only
 * the GITHEAD_<sha> variables `git merge` exports: one counts only when git is
 * merging (AUTO_MERGE is the index tree) and the index is exactly the clean
 * merge of HEAD and that commit, so a stale or hand-set variable hides nothing.
 * Anything else falls back to the HEAD diff, which judges more, never less.
 */
export const mergeParents = (git: Git, env: NodeJS.ProcessEnv, readFile: (path: string) => string | undefined): string[] => {
  const parents: string[] = [];
  const listed = readFile(must(git, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD']).trim());
  for (const candidate of (listed ?? '').split('\n').filter(Boolean)) {
    const sha = git.run(['rev-parse', '-q', '--verify', `${candidate}^{commit}`])?.trim();
    if (sha) parents.push(sha);
  }
  // An index with unresolved conflicts has no tree, and nothing can be committed from it.
  const indexTree = git.run(['write-tree'])?.trim();
  if (!indexTree || git.run(['rev-parse', '-q', '--verify', 'AUTO_MERGE^{tree}'])?.trim() !== indexTree) return parents;
  for (const name of Object.keys(env)) {
    const sha = /^GITHEAD_([0-9a-f]{40}|[0-9a-f]{64})$/.exec(name)?.[1];
    if (sha === undefined || parents.includes(sha)) continue;
    if (git.run(['merge-tree', '--write-tree', 'HEAD', sha])?.trim() === indexTree) parents.push(sha);
  }
  return parents;
};

export interface Claim {
  readonly file: string;
  readonly line: number;
  readonly phrase: string;
  readonly text: string;
}

export interface Source {
  /** Candidate files: staged (A, C, M) or every tracked file. */
  readonly files: readonly string[];
  /** A file's content as judged: the index for staged, the working file for tree. */
  readonly content: (file: string) => string | undefined;
  /** Lines to judge in a file; undefined judges every line. */
  readonly judged: (file: string) => Set<number> | undefined;
}

const nulList = (out: string): string[] => out.split('\0').filter(Boolean);
const literal = (file: string): string => `:(literal)${file}`;

/** The staged change: what the commit being made adds. */
export const stagedSource = (git: Git, env: NodeJS.ProcessEnv, readFile: (path: string) => string | undefined): Source => {
  const parents = mergeParents(git, env, readFile);
  const added = (file: string, against: readonly string[]): Set<number> =>
    addedLines(must(git, ['diff', ...PLAIN_DIFF, '--cached', '-U0', ...against, '--', literal(file)]));
  return {
    // T: a symlink or submodule replaced by a file brings in its every line.
    files: nulList(must(git, ['diff', ...PLAIN_DIFF, '--cached', '-z', '--name-only', '--diff-filter=ACMT'])),
    // `:0:` names stage 0 explicitly, so a path such as `0:a.md` is read as itself.
    content: (file) => must(git, ['show', `:0:${file}`]),
    judged: (file) => {
      let lines = added(file, []);
      for (const parent of parents) {
        const vsParent = added(file, [parent]);
        lines = new Set([...lines].filter((n) => vsParent.has(n)));
      }
      return lines;
    },
  };
};

/** Every tracked file, as it is in the working tree. */
export const treeSource = (git: Git, root: string, readFile: (path: string) => string | undefined): Source => ({
  files: nulList(must(git, ['ls-files', '-z'])),
  content: (file) => readFile(join(root, file)),
  judged: () => undefined,
});

/** Every uncited claim the source holds. */
export const findUncited = (source: Source, opts: Options, git: Git, adrFiles: readonly string[]): Claim[] => {
  const phrase = phrasePattern(opts.authorities);
  const claims: Claim[] = [];
  for (const file of source.files) {
    if (!SOURCE_EXT.test(file) || SKIPPED_PATH.test(file)) continue;
    const text = source.content(file);
    if (text === undefined || !phrase.test(text)) continue;
    const lines = text.split('\n');
    const judged = source.judged(file);
    lines.forEach((line, i) => {
      const n = i + 1;
      const m = phrase.exec(line);
      if (!m || (judged !== undefined && !judged.has(n))) return;
      if (hasCitation(windowOf(lines, n), file, opts, git, adrFiles)) return;
      claims.push({ file, line: n, phrase: m[0], text: line.slice(0, 120) });
    });
  }
  return claims;
};

/**
 * An ADR directory as the claiming files' paths spell it: `./docs//adr/`
 * is `docs/adr`, so an ADR citing itself is still recognised as itself.
 */
export const adrDirOf = (dir: string): string => posix.normalize(dir).replace(/\/+$/, '') || '.';

/** Files (not directories) under the ADR directory, relative to the root. */
export const listAdrs = (root: string, adrDir: string): string[] => {
  const dir = join(root, adrDir);
  return existsSync(dir) ? readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).map((f) => `${adrDir}/${f}`) : [];
};

/** A file's text, or undefined when it is not there (gone, or now a directory); any other failure throws. */
export const readOrUndefined = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw e;
  }
};

export const formatClaims = (claims: readonly Claim[], opts: Options): { ok: boolean; out: string[]; err: string[] } => {
  if (claims.length === 0) return { ok: true, out: ['pariksha authority-citations: every authority claim cites an anchor'], err: [] };
  const err: string[] = [];
  let last = '';
  for (const c of claims) {
    if (c.file !== last) err.push(`pariksha authority-citations: uncited authority claim(s) in ${c.file}:`);
    last = c.file;
    err.push(`  ${c.line}: [${c.phrase}] ${c.text}`);
  }
  const files = new Set(claims.map((c) => c.file)).size;
  err.push(
    '',
    'An authority claim must anchor in something only that authority can produce. Cite one of:',
    '  a commit id                       (owner decision, f1a0da2d)',
    `  an existing ADR                   ADR-0040, in ${opts.adrDir}/`,
    ...(opts.issuePrefixes.length > 0 ? [`  an issue id                       ${opts.issuePrefixes[0]}-447`] : []),
    '  a GitHub pull request or issue    PR #269, or its full URL',
    'A comment or a document an agent could have written is not a citation. If no such',
    'artifact exists, the decision has not been made. Not an authority claim? Add',
    '  ALLOW-AUTHORITY-PHRASE: <reason>',
    '',
    `${claims.length} claim(s) across ${files} file(s).`,
  );
  return { ok: false, out: [], err };
};
