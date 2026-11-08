// The export-deletions check: a public export that disappears from the whole
// tree on a branch needs a stated reason, a commit trailer naming it.
//
// An agent that removes a public function can also remove its callers and the
// tests that used it: everything typechecks and passes, so nothing internal
// tells a correct removal from a coherent mistake. Only a statement of intent
// can, so the check asks for one, and stays quiet for anything that moved:
// a symbol still named anywhere in the tree's source is not reported.
//
//   Removes-Export: <symbol> — <why>     covers one symbol
//   Removes-File: <path> — <why>         covers every export of a file that
//                                        no longer exists at HEAD
import { must, type Git } from './git.ts';

export const SOURCE_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.mts', '*.cts'] as const;

/** Build output and vendored code never count as a source change. */
const SKIPPED_DIR = /(^|\/)(node_modules|dist|build|coverage|generated)\//;

/**
 * A removed named declaration on a `-` diff line. Bare re-export lists
 * (`export { a, b }`) are left out: they shuffle in refactors and name nothing new.
 */
const EXPORT_DECL =
  /^-\s*export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

/**
 * A grep hit (`HEAD:path:line:text`) whose text starts a comment (`//`, `*`,
 * `/*`) is a mention, not a use. Unanchored, so a colon in a path still matches.
 */
const COMMENT_HIT = /:\d+:\s*(?:\/\/|\*|\/\*)/;

const unique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/** Symbols named by `Removes-Export:` trailers: the first word, trailing punctuation dropped. */
export const declaredExports = (messages: string): string[] =>
  unique(
    messages
      .split('\n')
      .map((line) => /^\s*removes-export:\s*(\S+)/i.exec(line)?.[1]?.replace(/[,;()]+$/, ''))
      .filter((s): s is string => s !== undefined && s !== ''),
  );

/**
 * Paths named by `Removes-File:` trailers. The path runs up to the " — " or
 * " - " that starts the reason, so a path with a space in it survives.
 */
export const declaredFiles = (messages: string): string[] =>
  unique(
    messages
      .split('\n')
      .map((line) =>
        /^\s*removes-file:\s*(.*)$/i
          .exec(line)?.[1]
          ?.replace(/\s+(?:—|-)\s.*$/, '')
          .trim()
          .replace(/[,;()]+$/, ''),
      )
      .filter((s): s is string => s !== undefined && s !== ''),
  );

/** The symbols a unified diff removes from export declarations. */
export const removedExports = (diff: string): string[] =>
  diff
    .split('\n')
    .map((line) => EXPORT_DECL.exec(line)?.[1])
    .filter((s): s is string => s !== undefined);

/** True when some `git grep -n <sym> HEAD` hit is code rather than a comment. */
export const usedOutsideComments = (hits: string): boolean =>
  hits.split('\n').some((hit) => hit !== '' && !COMMENT_HIT.test(hit));

export interface Finding {
  readonly symbol: string;
  readonly file: string;
}

export interface Report {
  readonly base: string;
  readonly violations: readonly Finding[];
  /** Symbols a trailer declared, with the file they left. */
  readonly declared: readonly Finding[];
  /** Deleted files whose exports one `Removes-File:` trailer covered. */
  readonly declaredFiles: readonly string[];
}

/**
 * Compares `base...HEAD`: every export removed and named nowhere in HEAD's
 * source must be declared. A git failure throws (with no merge base, say, in a
 * shallow clone): the check cannot pass without having read the branch.
 */
export const checkExportDeletions = (git: Git, base: string): Report => {
  const messages = must(git, ['log', '--format=%B', `${base}..HEAD`]);
  const symbols = new Set(declaredExports(messages));
  const files = new Set(declaredFiles(messages));
  const changed = must(git, ['diff', '--name-only', '--diff-filter=ACMRD', `${base}...HEAD`, '--', ...SOURCE_GLOBS])
    .split('\n')
    .filter((f) => f !== '' && !SKIPPED_DIR.test(f));
  const violations: Finding[] = [];
  const declared: Finding[] = [];
  const coveredFiles: string[] = [];
  const used = new Map<string, boolean>();
  for (const file of changed) {
    const removed = removedExports(must(git, ['diff', '-U0', `${base}...HEAD`, '--', file]));
    if (removed.length === 0) continue;
    // A file trailer covers a file only once no blob is left at its path.
    if (files.has(file) && git.run(['cat-file', '-t', `HEAD:${file}`])?.trim() !== 'blob') {
      coveredFiles.push(file);
      continue;
    }
    for (const symbol of removed) {
      let stillUsed = used.get(symbol);
      if (stillUsed === undefined) {
        // git grep exits 1 when nothing matches, so undefined here is "no hit".
        stillUsed = usedOutsideComments(git.run(['grep', '-nwF', '-e', symbol, 'HEAD', '--', ...SOURCE_GLOBS]) ?? '');
        used.set(symbol, stillUsed);
      }
      if (stillUsed) continue;
      (symbols.has(symbol) ? declared : violations).push({ symbol, file });
    }
  }
  return { base, violations, declared, declaredFiles: coveredFiles };
};

/** The report as output lines; a refusal tells the author how to declare a removal. */
export const formatReport = (report: Report): { ok: boolean; out: string[]; err: string[] } => {
  const out = [
    ...report.declaredFiles.map((f) => `pariksha export-deletions: ${f} deleted; a Removes-File trailer declares its exports`),
    ...report.declared.map((d) => `pariksha export-deletions: ${d.symbol} removed from ${d.file}; a Removes-Export trailer declares it`),
  ];
  if (report.violations.length === 0) {
    out.push(`pariksha export-deletions: no undeclared export removals since ${report.base}`);
    return { ok: true, out, err: [] };
  }
  const err = [
    `pariksha export-deletions: ${report.violations.length} export(s) removed from the whole tree since ${report.base} with no stated reason:`,
    ...report.violations.map((v) => `  ${v.symbol}   (removed from ${v.file})`),
    '',
    'Each is gone from every source file, not moved or renamed. If the removal is intended,',
    'say so in a commit body:',
    '',
    '  Removes-Export: <symbol> — <why it is safe to remove>',
    '',
    'A file deleted outright can be declared once, covering all its exports:',
    '',
    '  Removes-File: <path> — <why the file is gone>',
  ];
  return { ok: false, out, err };
};
