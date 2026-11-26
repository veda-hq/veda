// The export-deletions check: a public export that disappears from the whole
// tree on a branch needs a stated reason, a commit trailer naming it.
//
// An agent that removes a public function can also remove its callers and the
// tests that used it: everything typechecks and passes, so nothing internal
// tells a correct removal from a coherent mistake. Only a statement of intent
// can, so the check asks for one, and stays quiet for anything that moved:
// a symbol still named anywhere in the tree's source, tests aside, is not
// reported. An aliased re-export (`export { internal as publicApi }`) exports
// its alias, so removing it removes the alias.
//
//   Removes-Export: <symbol> — <why>     covers one symbol
//   Removes-Export: <a>, <b> — <why>     covers each symbol listed
//   Removes-File: <path> — <why>         covers every export of a file that
//                                        no longer exists at HEAD
import { must, PLAIN_DIFF, type Git } from './git.ts';

export const SOURCE_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.mts', '*.cts'] as const;

/** Build output and vendored code never count as a source change, or as a use. */
const SKIPPED = ['node_modules', 'dist', 'build', 'coverage', 'generated'] as const;
const SKIPPED_DIR = new RegExp(`(^|/)(${SKIPPED.join('|')})/`);
const SKIPPED_PATHSPECS = SKIPPED.map((d) => `:(exclude,glob)**/${d}/**`);

/**
 * A test is no use of an export: one asserting the export's absence is the
 * incident's own last step, so tests never count in the still-present search.
 */
const TEST_PATHSPECS = [':(exclude,glob)**/*.test.*', ':(exclude,glob)**/*.spec.*'] as const;

/**
 * A removed named declaration on a `-` diff line. Bare re-export lists
 * (`export { a, b }`) are left out: they shuffle in refactors and name nothing
 * new. An alias in a list does name something new; EXPORT_LIST reads those.
 */
const EXPORT_DECL =
  /^-\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const\s+enum|const|let|var|function|class|interface|type|enum|namespace)[\s*]+([A-Za-z_$][A-Za-z0-9_$]*)/;

/**
 * A grep hit (`HEAD:path:line:text`) whose text starts a comment (`//`, `*`,
 * `/*`) is a mention, not a use. Unanchored, so a colon in a path still matches.
 */
const COMMENT_HIT = /:\d+:\s*(?:\/\/|\*|\/\*)/;

/**
 * An export list, `export { … }` or `export type { … }`, its braces' content
 * captured. It may span lines, but not a NUL, which stands for a line the diff
 * did not remove.
 */
const EXPORT_LIST = /(?:^|\n)\s*export\s+(?:type\s+)?\{([^}\0]*)\}/g;

/** One aliased specifier of a list, `x as y` (`type x as y`, `default as y`): the alias. */
const ALIASED = /^(?:type\s+)?[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/;

const unique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/** A comma list of identifiers, the whole of a trailer's value before its reason: `a, b, c`. */
const SYMBOL_LIST = /^[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*$/;

/**
 * Symbols named by `Removes-Export:` trailers. The value up to the " — " or
 * " - " that starts the reason (all of it when there is none) may be a comma
 * list of identifiers, `Removes-Export: a, b, c — why`, so one line declares a
 * module's exports and the commit body stays short. Anything else names one
 * symbol, the first word, trailing punctuation dropped, so a word in the
 * reason never declares a symbol.
 */
export const declaredExports = (messages: string): string[] =>
  unique(
    messages.split('\n').flatMap((line) => {
      // `.` stops at no character of a line split on '\n', so `.*` runs to its end.
      const value = /^\s*removes-export:(.*)/i.exec(line)?.[1];
      if (value === undefined) return [];
      const head = value.replace(/\s(?:—|–|-)\s.*/, '').trim();
      if (SYMBOL_LIST.test(head)) return head.split(',').map((s) => s.trim());
      const first = (/\S+/.exec(value)?.[0] ?? '').replace(/[,;()]+$/, '');
      return first === '' ? [] : [first];
    }),
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
        (/^\s*removes-file:(.*)/i.exec(line)?.[1] ?? '')
          .replace(/\s(?:—|-)\s.*/, '')
          .trim()
          .replace(/[,;()]+$/, ''),
      )
      .filter((s) => s !== ''),
  );

/**
 * The aliases removed lines take out of export lists: `y` of each `x as y`,
 * never a bare name and never `as default`. `removed` holds the diff's removed
 * lines, each `-` dropped, and a NUL line for each other line, so a list is
 * read only when consecutive removed lines hold it whole: a line removed from
 * a multi-line list that stays is not read.
 */
export const removedAliases = (removed: string): string[] =>
  // The group always takes part in a match, so String() only narrows its type.
  // A comment in a list, `/* … */` or `// …` to the line's end, is no specifier.
  [...removed.matchAll(EXPORT_LIST)].flatMap((m) =>
    String(m[1])
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
      .split(',')
      .map((spec) => ALIASED.exec(spec.trim())?.[1])
      .filter((s): s is string => s !== undefined && s !== 'default'),
  );

/**
 * The symbols a `-U0` diff removes: each removed export declaration, then each
 * alias that consecutive removed lines take out of an export list. A
 * `--- a/file` header reads as a removed line, and holds no list.
 */
export const removedExports = (diff: string): string[] => {
  const lines = diff.split('\n');
  const declared = lines.map((line) => EXPORT_DECL.exec(line)?.[1]).filter((s): s is string => s !== undefined);
  const removed = lines.map((line) => (line.startsWith('-') ? line.slice(1) : '\0')).join('\n');
  return [...declared, ...removedAliases(removed)];
};

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
  // Renames off, so a file moved and edited lists its old path, whose removed
  // lines the per-file diff then shows; colour, external diff tools and
  // textconv off, so a user's config cannot rewrite the lines read here.
  // NUL-separated, so no name comes back quoted.
  const changed = must(git, ['diff', ...PLAIN_DIFF, '-z', '--name-only', '--diff-filter=ACMRD', `${base}...HEAD`, '--', ...SOURCE_GLOBS])
    .split('\0')
    .filter((f) => f !== '' && !SKIPPED_DIR.test(f));
  const violations: Finding[] = [];
  const declared: Finding[] = [];
  const coveredFiles: string[] = [];
  const used = new Map<string, boolean>();
  for (const file of changed) {
    // `:(literal)` so a name like `src/[id].ts` names only itself.
    const spec = `:(literal)${file}`;
    const removed = removedExports(must(git, ['diff', ...PLAIN_DIFF, '-U0', `${base}...HEAD`, '--', spec]));
    if (removed.length === 0) continue;
    // A file trailer covers a file only once HEAD has nothing at its path.
    if (files.has(file) && must(git, ['ls-tree', '--name-only', 'HEAD', '--', spec]) === '') {
      coveredFiles.push(file);
      continue;
    }
    for (const symbol of removed) {
      let stillUsed = used.get(symbol);
      if (stillUsed === undefined) {
        // git grep exits 1 when nothing matches, so undefined here is "no hit".
        // Skipped trees and tests are excluded here too: a stale committed build naming the symbol is no use.
        stillUsed = usedOutsideComments(git.run(['grep', '--no-color', '-nwF', '-e', symbol, 'HEAD', '--', ...SOURCE_GLOBS, ...SKIPPED_PATHSPECS, ...TEST_PATHSPECS]) ?? '');
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
    'Each is gone from every source file but the tests, not moved or renamed. If the removal is intended,',
    'say so in a commit body:',
    '',
    '  Removes-Export: <symbol> — <why it is safe to remove>',
    '',
    'One line can name several, so a module\'s exports fit a short commit body:',
    '',
    '  Removes-Export: <a>, <b>, <c> — <why they are safe to remove>',
    '',
    'A file deleted outright can be declared once, covering all its exports:',
    '',
    '  Removes-File: <path> — <why the file is gone>',
  ];
  return { ok: false, out, err };
};
