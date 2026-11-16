// repo-rules over any tracked file's bytes and lines.
import { join } from 'node:path';
import { lineAt, positiveInteger, stringList, type Finding, type Repo, type Rule } from './repo-rules.ts';

/** The extension of `path`, lower-cased, with its dot; '' for none. */
const extensionOf = (path: string): string => /(\.[^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';

/** A line over 1 MB: what one grep hit of a review bot cannot carry. */
export const DEFAULT_MAX_LINE_BYTES = 1_000_000;

/** The 1-based line holding the first line longer than `max` bytes, and its length; undefined when none is. */
export const longLineOf = (bytes: Buffer, max: number): { line: number; length: number } | undefined => {
  let start = 0;
  let line = 1;
  for (;;) {
    const end = bytes.indexOf(10, start);
    const stop = end === -1 ? bytes.length : end;
    if (stop - start > max) return { line, length: stop - start };
    if (end === -1) return undefined;
    start = end + 1;
    line += 1;
  }
};

/** Ignore files a ripgrep-based reviewer reads at the root, besides `.gitignore`. */
const RG_IGNORES = ['.rgignore', '.ignore'] as const;

/** The paths among `paths` that ripgrep would skip: matched by `.gitignore`, or the root `.rgignore` or `.ignore`. */
export const rgIgnored = (repo: Repo, paths: readonly string[]): Set<string> => {
  if (paths.length === 0) return new Set();
  const from = RG_IGNORES.filter((name) => repo.size(name) !== undefined).map((name) => `--exclude-from=${join(repo.root, name)}`);
  const out = repo.git.run(['ls-files', '-z', '--cached', '--ignored', '--exclude-standard', ...from, '--', ...paths.map((p) => `:(literal)${p}`)]);
  if (out === undefined) throw new Error('git ls-files --ignored failed, so the .rgignore entries could not be read');
  return new Set(out.split('\0').filter(Boolean));
};

export const longLineNotRgignored: Rule = {
  id: 'long-line-not-rgignored',
  lesson:
    'A review bot that greps the tree (Cubic) gets whole lines back, so one tracked file with a multi-MB line (generated HTML or JSON) makes its request fail with "413 Request Entity Too Large", at random, whatever the diff\'s size. List the file in the root `.rgignore`, instead of splitting commits.',
  settings: { maxLineBytes: positiveInteger },
  run: (repo, settings) => {
    const max = (settings['maxLineBytes'] as number | undefined) ?? DEFAULT_MAX_LINE_BYTES;
    const long: Array<{ file: string; line: number; length: number }> = [];
    for (const file of repo.files) {
      if ((repo.size(file) ?? 0) <= max) continue;
      const bytes = repo.bytes(file);
      const hit = bytes === undefined ? undefined : longLineOf(bytes, max);
      if (hit !== undefined) long.push({ file, ...hit });
    }
    const ignored = rgIgnored(
      repo,
      long.map((l) => l.file),
    );
    return long.filter((l) => !ignored.has(l.file)).map((l) => ({ file: l.file, line: l.line, detail: `a ${l.length}-byte line, and no .rgignore entry covers the file` }));
  },
};

/** Text sources a raw NUL byte hides from a diff, by default. */
export const SOURCE_EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sh', '.bash', '.zsh', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.cs', '.php',
  '.json', '.jsonc', '.yml', '.yaml', '.toml', '.md', '.mdx', '.css', '.scss', '.html', '.sql', '.prisma', '.graphql',
] as const;

export const rawNulInSource: Rule = {
  id: 'raw-nul-in-source',
  lesson:
    'A raw NUL byte in a source file makes git treat the file as binary: its diff shows "Bin N -> M bytes", so the change is invisible to review and blame while tsc, lint and tests pass. Write a NUL separator as the `\\0` or `\\x00` escape.',
  settings: { extensions: stringList },
  run: (repo, settings) => {
    const extensions = (settings['extensions'] as readonly string[] | undefined) ?? SOURCE_EXTENSIONS;
    const findings: Finding[] = [];
    for (const file of repo.files) {
      if (!extensions.includes(extensionOf(file))) continue;
      const bytes = repo.bytes(file);
      const at = bytes?.indexOf(0) ?? -1;
      if (bytes === undefined || at === -1) continue;
      findings.push({ file, line: lineAt(bytes.subarray(0, at).toString('latin1'), at), detail: 'a raw NUL byte, so git shows the file as binary' });
    }
    return findings;
  },
};

/** Files CodeQL reads suppression comments in. */
const CODEQL_SOURCES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.java', '.kt', '.cs', '.swift', '.c', '.h', '.cc', '.cpp', '.vue', '.html'];

/** The comment openers a suppression can follow. */
const OPENER = /(\/\/|\/\*|#)\s*codeql\[/;

/** What is wrong with a line's `codeql[...]` suppression comment, or undefined when it is well formed or not one. */
export const suppressionProblem = (line: string): string | undefined => {
  const match = OPENER.exec(line);
  if (match === null) return undefined;
  const prefix = line.slice(0, match.index);
  // A quote before the comment opener means the text is likely inside a string, not a comment.
  if (/['"`]/.test(prefix)) return undefined;
  const rest = line.slice(match.index);
  if (/codeql\[[^\]]*,[^\]]*\]/.test(rest)) return 'names several queries in one codeql[...]; write codeql[a] codeql[b]';
  if (prefix.trim() !== '') return 'shares its line with code, so CodeQL ignores it; put it alone on the line above the alert';
  return undefined;
};

export const codeqlSuppressionCommentForm: Rule = {
  id: 'codeql-suppression-comment-form',
  lesson:
    'A `// codeql[rule-id]` comment suppresses an alert only alone on its line, directly above the alert\'s start line (JSX `{/* */}` is ignored), one query per brackets: `codeql[a] codeql[b]`, not a comma list. It also does nothing unless `AlertSuppression.ql` runs with the suite; `security-and-quality` omits it, so add it through `packs:`.',
  run: (repo) => {
    const findings: Finding[] = [];
    for (const file of repo.files) {
      if (!CODEQL_SOURCES.includes(extensionOf(file))) continue;
      const text = repo.read(file);
      if (text === undefined || !text.includes('codeql[')) continue;
      text.split('\n').forEach((line, i) => {
        const problem = suppressionProblem(line);
        if (problem !== undefined) findings.push({ file, line: i + 1, detail: `the suppression comment ${problem}` });
      });
    }
    return findings;
  },
};

export const FILE_RULES: readonly Rule[] = [longLineNotRgignored, rawNulInSource, codeqlSuppressionCommentForm];
