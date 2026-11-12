// How a shell script splits into the commands it runs: heredoc bodies
// dropped, segments cut at the shell's own separators, and-or lists kept
// whole, words with their quoting removed, and the bodies of the command
// substitutions the shell would run. masked-exit-codes reads with it.
//
// Not a parser. Quote state is tracked so a separator or `#` inside a string
// splits nothing; anything this reader does not understand reads as text,
// never as a command.

/**
 * One piece of a line as `heredocsOpened` reads it: an escaped character; a
 * `$'…'`, `'…'` or `"…"` string (open to the end of the line when unclosed;
 * `\` escapes in all but `'…'`); a comment, from a `#` that starts a word to
 * the end of the line; `((` or `))` around arithmetic, where `<<` is a shift;
 * a `<<<` here-string, which opens no body; a heredoc operator and its word;
 * or any other character.
 *
 * The delimiter is any shell WORD, not an identifier: `<<'END-OF'` is a
 * heredoc. Quoted and bare parts concatenate into one word, as bash reads
 * them: `<<'END'-OF` ends at `END-OF`.
 */
const LINE_PIECE =
  /\\[\s\S]?|\$'(?:[^'\\]|\\[\s\S])*'?|'[^']*'?|"(?:[^"\\]|\\[\s\S])*"?|(?<=^|[\s;&|(])#[\s\S]*|\(\(|\)\)|<<<+|<<(-?)\s*((?:\$'(?:[^'\\]|\\.)*'|'[^']*'|"[^"]*"|\\.|[^\s;&|<>()'"\\])+)|[\s\S]/g;

/**
 * The delimiter a heredoc word names, with its quoting removed: `$'EOF'` is
 * `EOF` (its escapes reduced to the escaped character, enough for a name).
 */
const heredocDelimiter = (word: string): string =>
  word.replace(
    /\$'((?:[^'\\]|\\.)*)'|'([^']*)'|"([^"]*)"|\\(.)/g,
    // One alternative matched: when none of the first three did, the fourth,
    // an escaped character, did.
    (_all: string, ansi: string | undefined, single: string | undefined, double: string | undefined, escaped: string) => ansi?.replace(/\\(.)/g, '$1') ?? single ?? double ?? escaped,
  );

interface Heredoc {
  readonly delimiter: string;
  /** `<<-`: bash strips leading tabs from the body and its terminator. */
  readonly tabs: boolean;
}

/**
 * The heredocs a line opens, in order. Only a `<<` the shell sees counts: one
 * inside quotes (`echo "use <<EOF"`), a comment or arithmetic (`$((1 << 2))`,
 * a shift) is none.
 */
const heredocsOpened = (line: string): Heredoc[] => {
  const heredocs: Heredoc[] = [];
  /** Open `((` arithmetic, where `<<` is a shift. */
  let arithmetic = 0;
  for (const [piece, tabs, word] of line.matchAll(LINE_PIECE)) {
    if (piece === '((') arithmetic += 1;
    else if (piece === '))') arithmetic = Math.max(0, arithmetic - 1);
    else if (word !== undefined && arithmetic === 0) heredocs.push({ delimiter: heredocDelimiter(word), tabs: tabs === '-' });
  }
  return heredocs;
};

/**
 * The script with its heredoc bodies removed, the lines that open them kept.
 * A body is text handed to a command's stdin, never commands. Every
 * delimiter a line opens is collected: `cmd <<A <<B` opens two bodies in
 * sequence. A body ends only at its exact terminator (`<<-` strips tabs
 * first); an unterminated one consumes the rest of the script.
 */
export const stripHeredocBodies = (script: string): string => {
  const out: string[] = [];
  // Bodies arrive in the order the redirections were written: the first
  // still open is the one the next line belongs to.
  const open: Heredoc[] = [];
  for (const line of script.split('\n')) {
    const [body] = open;
    if (body === undefined) {
      out.push(line);
      open.push(...heredocsOpened(line));
      continue;
    }
    const text = body.tabs ? line.replace(/^\t+/, '') : line;
    if (text === body.delimiter) open.shift();
  }
  return out.join('\n');
};

/**
 * `$'…'` is an ANSI-C string: single-quoted, except that a backslash escapes
 * the next character, `\'` included.
 */
const ANSI_C = "$'";
type Quote = "'" | '"' | typeof ANSI_C | null;

/**
 * The escapes of `$'…'` decoded here. Bash keeps the backslash of an unknown
 * escape (`$'pnp\m'` is `pnp\m`), and so does this reader; octal, `\u` and
 * `\c` forms stay undecoded, which can only fail to match.
 */
const ANSI_C_ESCAPES: Readonly<Record<string, string>> = {
  a: '\u0007',
  b: '\b',
  e: '\u001b',
  E: '\u001b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

/** A quote ends at the last character of its opener: `'`, `"`, or `$'`'s `'`. */
const closerOf = (quote: Exclude<Quote, null>): string => quote.slice(-1);

/** A `'` after a `$` that an even run of backslashes leaves unescaped. */
const ANSI_C_OPENER = /(?<=(?:^|[^\\])(?:\\\\)*\$)'/y;

/** Whether the quote at `index` is the `'` of a `$'`, with that `$` unescaped. */
const opensAnsiC = (source: string, index: number): boolean => {
  ANSI_C_OPENER.lastIndex = index;
  return ANSI_C_OPENER.test(source);
};

/** The rest of a line, up to its newline: what a comment covers. */
const LINE_REST = /[^\n]*/y;

/** The index of the newline ending the line at `from`, or the text's end. */
const lineEnd = (source: string, from: number): number => {
  LINE_REST.lastIndex = from;
  LINE_REST.exec(source);
  return LINE_REST.lastIndex;
};

/**
 * Whether the `(` at `index` opens a `<(…)` or `>(…)` process substitution:
 * its `<` or `>` must not be escaped. `escapedAt` is the index of the last
 * character a backslash escaped, so `\<(` opens nothing while `\\<(` does.
 */
const opensProcessSubstitution = (source: string, index: number, escapedAt: number): boolean => {
  const before = source[index - 1];
  return (before === '<' || before === '>') && escapedAt !== index - 1;
};

/** A command segment and the operator after it (`|`, `||`, `&&`, `;`, …). */
export interface Segment {
  readonly text: string;
  /** '' at the end of the script. */
  readonly next: string;
}

/**
 * A script's command segments, comments removed, each with the operator that
 * ends it, so a caller can tell a pipeline (`printf … | sh`) from a list
 * (`a; sh`). Inside `$( … )`, `<( … )` and `>( … )` the separators are the
 * body's, so the substitution stays one segment.
 */
export const splitSegmentsWithSeparators = (script: string): Segment[] => {
  const segments: Segment[] = [];
  const source = stripHeredocBodies(script);
  let current = '';
  let quote: Quote = null;
  let escaped = false;
  /** The index of the last character a backslash escaped. */
  let escapedAt = -1;
  let substitution = 0;
  const flush = (next = '\n'): void => {
    if (current.trim() !== '') segments.push({ text: current.trim(), next });
    current = '';
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (escaped) {
      current += char;
      escaped = false;
      escapedAt = index;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += char;
      if (char === closerOf(quote)) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = opensAnsiC(source, index) ? ANSI_C : char;
      current += char;
      continue;
    }
    if (char === '(' && (substitution > 0 || source[index - 1] === '$' || opensProcessSubstitution(source, index, escapedAt))) {
      substitution += 1;
      current += char;
      continue;
    }
    if (char === ')' && substitution > 0) {
      substitution -= 1;
      current += char;
      continue;
    }
    // A comment runs to the end of the line, but `#` opens one only at the
    // start of a word: `http://x#y` and `${VAR#prefix}` are left alone.
    const previous = index === 0 ? '\n' : source.charAt(index - 1);
    if (char === '#' && /[\s;&|(]/.test(previous)) {
      index = lineEnd(source, index);
      if (substitution > 0) current += '\n';
      else flush();
      continue;
    }
    if (substitution > 0) {
      current += char;
      continue;
    }
    if (char === '\n' || char === ';') {
      flush(char);
      continue;
    }
    if (char === '&' || char === '|') {
      // Consume a doubled operator so the second character is not re-read.
      const doubled = source[index + 1] === char;
      flush(doubled ? char + char : char);
      if (doubled) index += 1;
      continue;
    }
    current += char;
  }
  flush('');
  return segments;
};

/**
 * A script's and-or lists, comments removed: cut at `;`, a newline or a lone
 * `&`, never inside quotes (`$'…'` included) or inside `( … )`, `{ … }` or
 * `$( … )`. `&&`, `||` and `|` stay inside a list, since a command's `||`
 * handler belongs to it. A list ended by `&` keeps the `&`: it runs in the
 * background, handler and all. The same quote reading as the segments.
 */
export const splitAndOrLists = (script: string): string[] => {
  const lists: string[] = [];
  const source = stripHeredocBodies(script);
  let current = '';
  let quote: Quote = null;
  let escaped = false;
  let depth = 0;
  const flush = (): void => {
    if (current.trim() !== '') lists.push(current.trim());
    current = '';
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += char;
      if (char === closerOf(quote)) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = opensAnsiC(source, index) ? ANSI_C : char;
      current += char;
      continue;
    }
    const previous = index === 0 ? '\n' : source.charAt(index - 1);
    if (char === '#' && /[\s;&|(]/.test(previous)) {
      // Stop before the newline: it still ends the list.
      index = lineEnd(source, index) - 1;
      continue;
    }
    if (char === '(' || char === '{') depth += 1;
    if (char === ')' || char === '}') depth = Math.max(0, depth - 1);
    const loneAmpersand = char === '&' && source[index + 1] !== '&' && previous !== '&' && source[index + 1] !== '>' && !/[<>]/.test(previous);
    if (depth === 0 && (char === ';' || char === '\n' || loneAmpersand)) {
      if (loneAmpersand) current += char;
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return lists;
};

/** One shell word: its value with quotes removed. */
export interface ShellToken {
  /** The value the shell would pass, quotes stripped. */
  readonly value: string;
  /** True when any part of it was quoted. */
  readonly quoted: boolean;
}

/** The value of the hex digits a `\xHH` escape matched (one or two). */
const hexValue = (digits: string): number => {
  let value = 0;
  for (const digit of digits.toLowerCase()) value = value * 16 + '0123456789abcdef'.indexOf(digit);
  return value;
};

/**
 * A segment's shell words, quotes removed but their effect kept: `-m "a b"`
 * passes one word holding a space. A backslash-newline joins what is on
 * either side; inside double quotes a backslash is literal unless it
 * precedes `$`, a backtick, `"`, `\` or a newline.
 */
export const tokenize = (segment: string): ShellToken[] => {
  const tokens: ShellToken[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  let quote: Quote = null;
  const flush = (): void => {
    if (started) tokens.push({ value: current, quoted });
    current = '';
    quoted = false;
    started = false;
  };
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment.charAt(index);
    if (char === '\\' && quote !== "'") {
      const next = segment[index + 1];
      if (next !== undefined && quote === ANSI_C) {
        const hex = /^x([0-9A-Fa-f]{1,2})/.exec(segment.slice(index + 1));
        if (hex) {
          current += String.fromCharCode(hexValue(hex[1] as string));
          index += hex[0].length;
        } else {
          current += ANSI_C_ESCAPES[next] ?? `\\${next}`;
          index += 1;
        }
        continue;
      }
      if (next === '\n') {
        index += 1;
        continue;
      }
      if (next !== undefined) {
        const escapable = quote === '"' ? '$`"\\\n' : undefined;
        if (escapable !== undefined && !escapable.includes(next)) current += char + next;
        else current += next;
        started = true;
        index += 1;
        continue;
      }
    }
    if (quote !== null) {
      if (char === closerOf(quote)) quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      if (opensAnsiC(segment, index)) {
        // The `$` introduced the string; it is not part of the value.
        current = current.slice(0, -1);
        quote = ANSI_C;
      } else {
        quote = char;
      }
      quoted = true;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
    started = true;
  }
  flush();
  return tokens;
};

/**
 * One piece of a script outside double quotes, as `substitutionBodies` reads
 * it: an escaped character; a `$'…'` or `'…'` string or a comment, which
 * hold no substitution (an unclosed one runs to the end, as bash reads it);
 * a closed backquoted body (group 1); an unclosed backquote, which runs
 * nothing; a `"`; or a `$(` that opens no `$((` arithmetic.
 */
const SUBSTITUTION_PIECE = /\\[\s\S]?|\$'(?:[^'\\]|\\[\s\S])*'?|'[^']*'?|(?<=^|[\s;&|(])#[^\n]*|`((?:[^`\\]|\\[\s\S])*)`|`[\s\S]*|"|\$\((?!\()/g;

/** The same pieces inside double quotes, where quotes and `#` are plain. */
const DOUBLE_QUOTED_SUBSTITUTION_PIECE = /\\[\s\S]?|`((?:[^`\\]|\\[\s\S])*)`|`[\s\S]*|"|\$\((?!\()/g;

/**
 * One piece of a `$( … )` body as `substitutionBody` reads it: an escaped
 * character, a quoted string (open to the end when unclosed), a comment from
 * a `#` that starts a word to the end of its line, or any other character.
 * Parentheses inside quotes and comments close nothing.
 */
const BODY_PIECE = /\\[\s\S]?|\$'(?:[^'\\]|\\[\s\S])*'?|'[^']*'?|"(?:[^"\\]|\\[\s\S])*"?|(?<=^|[\s;&|()])#[^\n]*|[\s\S]/g;

/** The body of a `$(` that `rest` follows, up to the `)` closing it, or undefined when nothing closes it. */
const substitutionBody = (rest: string): string | undefined => {
  let depth = 1;
  for (const { 0: piece, index } of rest.matchAll(BODY_PIECE)) {
    if (piece === '(') depth += 1;
    if (piece === ')') {
      depth -= 1;
      if (depth === 0) return rest.slice(0, index);
    }
  }
  return undefined;
};

/**
 * The bodies of the `$(…)` and backtick substitutions the shell would run.
 * Single-quoted text and comments hold none; `$((…))` is arithmetic. An
 * unterminated substitution yields nothing, the direction that can only
 * miss. Double-quoted text still runs its substitutions.
 */
export const substitutionBodies = (script: string): string[] => {
  const bodies: string[] = [];
  let double = false;
  let from = 0;
  for (;;) {
    const reader = double ? DOUBLE_QUOTED_SUBSTITUTION_PIECE : SUBSTITUTION_PIECE;
    reader.lastIndex = from;
    const piece = reader.exec(script);
    if (piece === null) return bodies;
    from = reader.lastIndex;
    const [text, backquoted] = piece;
    if (text === '"') double = !double;
    if (backquoted !== undefined) bodies.push(backquoted.replace(/\\`/g, '`'));
    if (text === '$(') {
      const body = substitutionBody(script.slice(from));
      if (body === undefined) return bodies;
      bodies.push(body);
      // Past the body and its `)`.
      from += body.length + 1;
    }
  }
};
