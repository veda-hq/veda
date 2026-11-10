// Just enough shell lexing for the commands a doc shows: a `#` comment cut
// off, and quoted text masked so an operator inside a string splits nothing.
// Not a parser; each caller says what it reads.

/**
 * The characters of `code` from `start`, each with its index. Every scanner
 * walks this bounded sequence, skipping indexes below the point a token it
 * consumed ends at, so no scan runs past the end or loops forever. Lazy: a
 * scan that stops early never builds the rest.
 */
function* charsFrom(code: string, start: number): Generator<[number, string], void, undefined> {
  for (let index = start; index < code.length; index += 1) yield [index, code.charAt(index)];
}

/** A line continued by backslash-newline: an odd run of trailing backslashes. */
const CONTINUATION = /(?:^|[^\\])(?:\\\\)*\\$/;

/**
 * Whether `#` at `at` starts a word (a comment), not `$#`, `a#b`, `${#x}` or
 * `{#a,b}`: the line starts there, or a blank, `;` or `(` precedes it.
 */
const startsWord = (line: string, at: number): boolean => /(?:^|[\s;(])$/.test(line.slice(0, at));

type Quote = '"' | "'" | ')';

/**
 * Where an unquoted `#` comment starts in `line` (-1 if none). A `$(…)`
 * inside double quotes has its own quotes, so `"$(printf "%s" " #")"` holds
 * no comment.
 */
const commentAt = (line: string): number => {
  const stack: Quote[] = [];
  let resume = 0;
  for (const [at, char] of charsFrom(line, 0)) {
    if (at < resume) continue;
    const top = stack.at(-1);
    if (top === "'") {
      if (char === "'") stack.pop();
    } else if (char === '\\') {
      resume = at + 2;
    } else if (top === '"') {
      if (char === '"') stack.pop();
      if (line.startsWith('$(', at)) {
        stack.push(')');
        resume = at + 2;
      }
    } else if (char === '#' && startsWord(line, at)) {
      // At top level or inside a quoted `$(…)` body, the rest is a comment.
      return at;
    } else if (char === '"' || char === "'") {
      stack.push(char);
    } else if (top === ')' && char === '(') {
      stack.push(')');
    } else if (top === ')' && char === ')') {
      stack.pop();
    }
  }
  return -1;
};

/**
 * `line` without a `#` comment that starts a word outside quotes, trailing
 * blanks trimmed, except an escaped one: `echo ok \ # note` keeps `\ `,
 * which is no continuation.
 */
export const stripComment = (line: string): string => {
  const at = commentAt(line);
  if (at === -1) return line;
  const trimmed = line.slice(0, at).trimEnd();
  return CONTINUATION.test(trimmed) ? `${trimmed} ` : trimmed;
};

/** Whether `$(` at `at` opens a command substitution (`$((` is arithmetic). */
const opensSubstitution = (code: string, at: number): boolean => code.startsWith('$(', at) && !code.startsWith('$((', at);

/**
 * Outside quotes, `\` makes the next character literal. An escaped operator,
 * quote, `$` or backtick is blanked with its backslash; any other stays as
 * written. Returns the index past the escape.
 */
const maskEscape = (code: string, at: number, out: string[]): number => {
  if (/^\\[;&|()<>`$"']/.test(code.slice(at))) out.fill(' ', at, at + 2);
  return at + 2;
};

/** Blanks a single-quoted body from `start`; returns the index past its close. */
const maskSingle = (code: string, start: number, out: string[]): number => {
  const close = code.indexOf("'", start);
  const end = close === -1 ? code.length : close;
  out.fill(' ', start, end);
  return end + 1;
};

/** What the substitution skippers return when the body never closes. */
const NEVER_CLOSES = Number.POSITIVE_INFINITY;

/** A case pattern just before its `)`: after `in`, `;;` or a line start. */
const CASE_PATTERN_BEFORE = /(?:^|\bin|;;|\n)\s*[^\s;&|()]+(?:\s*\|\s*[^\s;&|()]+)*\s*$/;

/** Whether a `)` after `before` ends a pattern of a `case` open in `before`. */
const closesCasePattern = (before: string): boolean => {
  const cases = before.match(/\bcase\b/g)?.length ?? 0;
  const ends = before.match(/\besac\b/g)?.length ?? 0;
  return cases > ends && CASE_PATTERN_BEFORE.test(before);
};

/** Leaves a backtick substitution's body as code, masking the strings inside it; `open` is the opening backtick. */
const skipBacktick = (code: string, open: number, out: string[]): number => {
  let resume = open;
  for (const [at, char] of charsFrom(code, open + 1)) {
    if (at < resume) continue;
    if (char === '`') return at + 1;
    if (char === '\\') resume = maskEscape(code, at, out);
    else if (char === "'") resume = maskSingle(code, at + 1, out);
    else if (char === '"') resume = maskDouble(code, at + 1, out);
  }
  return NEVER_CLOSES;
};

/** Leaves a `$( … )` body as code, masking strings inside it; returns the index past `)`. */
const skipSubstitution = (code: string, start: number, out: string[]): number => {
  let depth = 1;
  let resume = start;
  for (const [at, char] of charsFrom(code, start)) {
    if (at < resume) continue;
    if (char === '\\') resume = maskEscape(code, at, out);
    else if (char === "'") resume = maskSingle(code, at + 1, out);
    else if (char === '"') resume = maskDouble(code, at + 1, out);
    else if (char === '(') depth += 1;
    else if (char === ')' && !closesCasePattern(code.slice(start, at))) {
      // A case arm's `)` (`$(case $x in a) …; esac)`) closes nothing.
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return NEVER_CLOSES;
};

/**
 * Blanks a double-quoted body from `start`, leaving `$(…)` and backtick
 * substitutions as code; returns the index past the closing quote.
 */
function maskDouble(code: string, start: number, out: string[]): number {
  let resume = start;
  for (const [at, char] of charsFrom(code, start)) {
    if (at < resume) continue;
    if (char === '"') return at + 1;
    if (char === '\\') {
      out.fill(' ', at, at + 2);
      resume = at + 2;
    } else if (opensSubstitution(code, at)) {
      resume = skipSubstitution(code, at + 2, out);
    } else if (char === '`') {
      resume = skipBacktick(code, at, out);
    } else {
      out[at] = ' ';
    }
  }
  return code.length;
}

/**
 * Blanks the contents of quoted strings, keeping every index in place so a
 * position found in the masked text is the same position in `code`:
 * `"a b"` → `"   "`. A command substitution inside double quotes runs, so
 * it stays visible; an escaped operator or quote is blanked too.
 */
export const maskQuoted = (code: string): string => {
  const out = code.split('');
  let resume = 0;
  for (const [index, char] of charsFrom(code, 0)) {
    if (index < resume) continue;
    if (char === '\\') resume = maskEscape(code, index, out);
    else if (char === "'") resume = maskSingle(code, index + 1, out);
    else if (char === '"') resume = maskDouble(code, index + 1, out);
  }
  return out.join('');
};
