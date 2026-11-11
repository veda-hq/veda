// absolute-paths: no document names a path on the writer's own machine.
//
// A doc that says `see /Users/me/code/app/notes.md` or `file:///home/me/x`
// points at something nobody else has. This check refuses a line of prose
// that holds such a path: `file://`, `/Users/`, `/home/<name>/`, `/tmp/<x>`,
// `/var/<x>`, `/private/var`, `~/`, or a drive (`C:\x`). Not refused: a line
// inside a fenced block (between lines that start with three backticks), a
// path inside an inline code span, and a line that says it is an example
// ("forbidden", "example", "not allowed", "should not", "must not", any case).
//
// Ported from a shell check unchanged, quirks included: only the first path on
// a line is tested for a code span, and that path runs to the next `/`, so a
// span's closing backtick may fall inside it.
import { linesOf, type DocConfig } from './doc-files.ts';

/** A local path, as the shell check's grep and awk matched it. */
export const LOCAL_PATH = /(file:\/\/|\/Users\/|\/home\/[^/]+\/|C:\\[^/]|\/tmp\/[^/]+|\/var\/[^/]+|\/private\/var|~\/|[A-Z]:\\[^/])/;

/** A line that says it shows what not to do. */
export const EXAMPLE_LINE = /(forbidden|example|not allowed|should not|must not)/i;

export const DEFAULT_GUIDANCE: readonly string[] = ['Please use relative paths only.'];

const FENCE = /^```/;

const backticks = (text: string): number => text.split('`').length - 1;

/**
 * Whether the first local path on `line` sits inside an inline code span: an
 * odd number of backticks before it and at least one after it.
 */
export const inBackticks = (line: string): boolean => {
  const match = LOCAL_PATH.exec(line);
  if (match === null) return false;
  const before = backticks(line.slice(0, match.index));
  const after = backticks(line.slice(match.index + match[0].length));
  return before > 0 && after > 0 && before % 2 === 1;
};

/** `file:line:text` for each refused line of one document. */
export const findInDoc = (file: string, text: string): string[] => {
  const found: string[] = [];
  let inFence = false;
  linesOf(text).forEach((line, index) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence || !LOCAL_PATH.test(line) || inBackticks(line) || EXAMPLE_LINE.test(line)) return;
    found.push(`${file}:${index + 1}:${line}`);
  });
  return found;
};

export interface Outcome {
  readonly ok: boolean;
  readonly out: string[];
}

/** The report for `docs` (path and text, in order), printed as the shell check printed it. */
export const checkAbsolutePaths = (docs: ReadonlyArray<{ readonly file: string; readonly text: () => string }>, config: DocConfig): Outcome => {
  const out = ['→ Checking for absolute paths in documentation...'];
  if (docs.length === 0) return { ok: true, out: [...out, '✅ No documentation files to check.'] };
  out.push(`   Checking ${docs.length} documentation file(s)...`);
  const found = docs.flatMap((doc) => findInDoc(doc.file, doc.text()));
  if (found.length === 0) return { ok: true, out: [...out, '✅ No absolute paths found in documentation'] };
  return { ok: false, out: [...out, '', '❌ Error: Absolute paths or local file references found:', '', ...found, '', ...config.guidance] };
};
