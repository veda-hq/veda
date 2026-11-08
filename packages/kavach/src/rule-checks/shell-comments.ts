/**
 * The comments of a shell command line: what follows each `#` that starts a
 * comment, outside quotes and heredoc bodies.
 *
 * A `# rule-pass` counts only as a real comment. Text inside a quoted string
 * or a heredoc body is data the command passes on (a commit message, a file
 * written with `cat <<EOF`), so a marker there must not pass a check.
 *
 * A static reading, like the command guard's. It models single, double and
 * `$'…'` quotes (a quote may span lines), backslash escapes outside single
 * quotes, backslash-newline joining two lines, and heredocs (`<<WORD`,
 * `<<-WORD`, quoted words, several on one line; `<<<` is a here-string). A `#`
 * starts a comment where it starts a word: at the start of the command or
 * after a blank or an operator character. What this reading does not model
 * ends it: a heredoc word it cannot settle (`<<\EOF`, `<<E"O"F`, `<<"$x"`),
 * `${…}`, backquotes, and `$(…)` inside double quotes. No comment after that
 * point counts, which can only withhold a pass, never grant one.
 */

/** Characters after which a `#` starts a word: bash's metacharacters. */
const WORD_BREAK = /[ \t\n;|&()<>]/;
const HEREDOC = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"\\$`]*)"|([A-Za-z_]\w*))(?=[ \t;|&()<>]|$)/;

/**
 * Openers of text the shell reads with its own quoting and comments: a
 * parameter expansion and a backquoted command anywhere, and a command
 * substitution inside double quotes. Unquoted, `$(…)` reads flat: a comment
 * inside it swallows its `)`, so a command ending in one never runs.
 */
const NESTING = ['${', '`'];
const QUOTED_NESTING = ['$(', ...NESTING];

const opensAt = (line: string, i: number, openers: readonly string[]): boolean =>
  openers.some((opener) => line.startsWith(opener, i));

type Quote = "'" | '"' | "$'" | null;
type Body = { readonly word: string; readonly tabs: boolean };

/** One comment: its 0-based line in the command and the text after `#`. */
export type Comment = { readonly line: number; readonly text: string };

export function shellComments(command: string): Comment[] {
  const comments: Comment[] = [];
  let quote: Quote = null;
  let bodies: Body[] = [];
  let opened: Body[] = [];
  // The character the shell read last; an escaped one reads as a word's.
  let before = '\n';
  for (const [index, line] of command.split('\n').entries()) {
    const [body] = bodies;
    if (body !== undefined) {
      const end = body.tabs ? line.replace(/^\t+/, '') : line;
      if (end === body.word) bodies.shift();
      continue;
    }
    // Characters already read, each standing for what the shell saw there.
    let skip = '';
    for (const [i, char] of line.split('').entries()) {
      if (skip !== '') {
        before = skip.charAt(0);
        skip = skip.slice(1);
        continue;
      }
      if (quote === "'") {
        if (char === "'") quote = null;
      } else if (char === '\\') {
        skip = 'x';
        continue;
      } else if (quote !== null) {
        if (quote === '"' && opensAt(line, i, QUOTED_NESTING)) return comments;
        if (char === quote.slice(-1)) quote = null;
      } else if (char === "'" || char === '"') {
        quote = char;
      } else if (line.startsWith("$'", i)) {
        [quote, skip] = ["$'", "'"];
      } else if (opensAt(line, i, NESTING)) {
        return comments;
      } else if (char === '#' && WORD_BREAK.test(before)) {
        comments.push({ line: index, text: line.slice(i + 1) });
        break;
      } else if (line.startsWith('<<<', i)) {
        skip = '<<';
      } else if (line.startsWith('<<', i)) {
        const marker = HEREDOC.exec(line.slice(i));
        if (marker === null) return comments;
        // The word's own characters are read on as usual: its quotes open and
        // close, and the character after it breaks a word.
        const [, dash, single, double, bare] = marker;
        opened.push({ word: single ?? double ?? bare ?? '', tabs: dash === '-' });
      }
      before = char;
    }
    // A backslash ending the line joins the next one to it.
    if (skip !== '') continue;
    before = '\n';
    if (quote === null) [bodies, opened] = [opened, []];
  }
  return comments;
}
