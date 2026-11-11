// Just enough shell lexing for the commands a doc shows and for line-oriented
// shell rules: a `#` comment cut off, quoted text masked so an operator
// inside a string splits nothing, heredoc bodies skipped and backslash
// continuations folded (`codeLines`), and where a command runs
// (`commandPositions`). Not a parser; each caller says what it reads.

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
 * Open quoting at a point in a line, outermost first: a `$(…)` inside
 * double quotes (`)`) has its own quotes, so `"$(printf "%s` is `"`, `)`, `"`.
 */
type QuoteStack = readonly Quote[];

/**
 * Scans `line` starting inside `open`. With `stopWhenClosed`, returns the
 * index of the character that closes the outermost quote (-1 if none does);
 * the stack is what is still open at the line's end either way. `comment` is
 * where an unquoted `#` comment starts (-1 if none); the scan stops there.
 */
const scanQuotes = (line: string, open: QuoteStack, stopWhenClosed: boolean): { close: number; stack: QuoteStack; comment: number } => {
  const stack = [...open];
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
      // The rest is a comment, at top level or inside a quoted `$(…)` body,
      // which stays open for the next line.
      return { close: -1, stack, comment: at };
    } else if (char === '"' || char === "'") {
      stack.push(char);
    } else if (top === ')' && char === '(') {
      stack.push(')');
    } else if (top === ')' && char === ')') {
      stack.pop();
    }
    // The scan starts inside `open` (never empty when it stops at a close), so
    // an empty stack means this character closed the outermost quote.
    if (stopWhenClosed && stack.length === 0) return { close: at, stack, comment: -1 };
  }
  return { close: -1, stack, comment: -1 };
};

/**
 * The code before a comment at `at`, trailing blanks trimmed, except an
 * escaped one: `echo ok \ # note` keeps `\ `, which is no continuation.
 */
const beforeComment = (line: string, at: number): string => {
  const trimmed = line.slice(0, at).trimEnd();
  return CONTINUATION.test(trimmed) ? `${trimmed} ` : trimmed;
};

/**
 * `line` without a `#` comment that starts a word outside quotes, trailing
 * blanks trimmed, except an escaped one: `echo ok \ # note` keeps `\ `,
 * which is no continuation. A `$(…)` inside double quotes has its own
 * quotes, so `"$(printf "%s" " #")"` holds no comment.
 */
export const stripComment = (line: string): string => {
  const at = scanQuotes(line, [], false).comment;
  return at === -1 ? line : beforeComment(line, at);
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
 * substitutions as code; returns the index past the closing quote. With
 * `closes` false (a heredoc body) a `"` is literal text, never a close, and
 * strings inside a substitution are masked into `inner` rather than `out`.
 */
function maskDouble(code: string, start: number, out: string[], closes = true, inner: string[] = out): number {
  let resume = start;
  for (const [at, char] of charsFrom(code, start)) {
    if (at < resume) continue;
    if (char === '"' && closes) return at + 1;
    if (char === '\\') {
      out.fill(' ', at, at + 2);
      resume = at + 2;
    } else if (opensSubstitution(code, at)) {
      resume = skipSubstitution(code, at + 2, inner);
    } else if (char === '`') {
      resume = skipBacktick(code, at, inner);
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

/**
 * Code as the shell runs it, with every echo/printf message's words (quoted
 * or not) blanked, offsets unchanged. A message is any echo/printf at a
 * command position (`if x; then echo "..."; fi` has one), and it ends at an
 * unquoted `;`, `&`, `|`, `)` or newline. Kept as code: the command word, its
 * `$(…)`/backtick substitutions, its redirections and their targets
 * (`> "/tmp/x"` names a file), and everything outside the messages.
 */
export const messageView = (code: string): string => {
  const starts = [...commandPositions(code, 'echo'), ...commandPositions(code, 'printf')];
  if (starts.length === 0) return code;
  const masked = maskQuoted(code);
  const keep: boolean[] = code.split('').map(() => true);
  for (const start of starts) {
    let depth = 0; // inside $( … )
    let tick = false; // inside a backtick substitution
    let resume = start;
    for (const [at, char] of charsFrom(masked, start)) {
      if (at < resume) continue;
      if (depth > 0 || tick) {
        if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        else if (char === '`') tick = false;
      } else if (masked.startsWith('$(', at)) {
        depth = 1;
        resume = at + 2;
      } else if (char === '`') {
        tick = true;
      } else if (/^(?:[<>]|&>)/.test(masked.slice(at))) {
        // A redirection and its target word are code.
        const rest = code.slice(at);
        const after = rest.replace(/^[<>&]*\s*(?:"[^"]*"|'[^']*'|[^\s;&|)]+)?/, '');
        resume = at + rest.length - after.length;
      } else if (/[;&|)\n]/.test(char)) {
        break;
      } else {
        keep[at] = false;
      }
    }
  }
  // A digit just before a redirection (`2>`) stays with it.
  return code
    .split('')
    .map((char, at) => (keep[at] === true || /^[0-9][<>]/.test(code.slice(at)) ? char : ' '))
    .join('');
};

/** Whether heredoc body `text` ends inside an unclosed `$(` or backtick. */
const substitutionOpen = (text: string): boolean => {
  let resume = 0;
  for (const [at, char] of charsFrom(text, 0)) {
    if (at < resume) continue;
    if (char === '\\') resume = at + 2;
    else if (opensSubstitution(text, at)) resume = skipSubstitution(text, at + 2, []);
    // A backtick substitution may span lines too.
    else if (char === '`') resume = skipBacktick(text, at, []);
  }
  return resume === NEVER_CLOSES;
};

/** Whether an arithmetic `((` is still open at the end of `text`. */
const insideArithmetic = (text: string): boolean => (text.match(/\(\(/g)?.length ?? 0) > (text.match(/\)\)/g)?.length ?? 0);

/** The `<<` heredoc operator; never the `<<<` here-string. */
const HEREDOC_OPERATOR = /(?<!<)<<(?!<)/g;

/**
 * What follows the operator: `-` for `<<-`, then the delimiter word up to an
 * unquoted blank or operator (`EOF`, `EOF.txt`, `'END'`, `"E O F"`, `\EOF`).
 */
const HEREDOC_TAG = /^(-?)\s*((?:'[^']*'|"[^"]*"|[^\s;&|<>()])+)/;

/** The delimiter line a heredoc word asks for: quotes and escapes removed. */
const heredocDelimiter = (word: string): string => word.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, '$1$2$3');

interface PendingHeredoc {
  readonly tag: string;
  readonly dash: boolean;
  readonly expands: boolean;
}

/**
 * The heredocs a line of code (starting outside quotes) opens, in order.
 * Operators are found in the quote-masked text, so `echo "cat <<EOF"` opens
 * none; the tag is read from the original, where a quoted `<<'EOF'` still
 * has its name.
 */
const heredocsOpenedBy = (code: string): PendingHeredoc[] => {
  const masked = maskQuoted(code);
  const out: PendingHeredoc[] = [];
  for (const match of masked.matchAll(HEREDOC_OPERATOR)) {
    // `$(( 1 << n ))` is a shift, not a heredoc.
    if (insideArithmetic(masked.slice(0, match.index))) continue;
    const tag = HEREDOC_TAG.exec(code.slice(match.index + 2));
    if (tag !== null) {
      const word = tag[2] as string;
      out.push({ tag: heredocDelimiter(word), dash: tag[1] === '-', expands: !/['"\\]/.test(word) });
    }
  }
  return out;
};

/** The quoting a line leaves open at its end (it starts outside any quote). */
const openQuoteAfter = (line: string): QuoteStack => {
  const { stack } = scanQuotes(line, [], false);
  // Only a quote holds the logical line open; a bare `$(` is not tracked.
  return stack[0] === '"' || stack[0] === "'" ? stack : [];
};

/**
 * Only the command substitutions of an expanding heredoc line, as code. A
 * heredoc body expands like a double-quoted string whose own quotes are
 * literal; a `$(…)` body is kept as written, the strings inside it masked
 * into a scratch list.
 */
const substitutionsIn = (line: string): string => {
  const out = line.split('');
  maskDouble(line, 0, out, false, []);
  return out.join('');
};

export interface CodeLine {
  /** 1-based physical line the logical line starts on. */
  readonly line: number;
  /** Code with comments removed; quotes kept. */
  readonly code: string;
}

/**
 * Logical code lines: comment-free, continuations joined onto the line they
 * start on. A quoted string spanning physical lines stays one logical line,
 * joined with newlines, so its text is quoted text to every rule (masked by
 * `maskQuoted`, substitutions still visible) and a multi-line `trap '…'`
 * keeps its whole handler. Heredoc bodies are dropped, except the
 * substitutions an expanding one runs.
 */
export const codeLines = (text: string): CodeLine[] => {
  const physical = text.split('\n');
  const result: CodeLine[] = [];
  // Heredocs whose body comes next, and those opened on a physical line the
  // shell has not ended yet.
  const pendingHeredocs: PendingHeredoc[] = [];
  const openedHeredocs: PendingHeredoc[] = [];
  let continued: CodeLine | null = null;
  // The quoting an earlier physical line left open; empty when none.
  let openQuote: QuoteStack = [];
  // Heredoc bodies start after the next newline the shell reads as a token:
  // not one inside a string (`cat <<EOF; echo "a` + `b"` puts the body after
  // `b"`), and not a backslash-newline it removes (`cat <<'EOF' \` +
  // `> /tmp/x` continues the command, and the body follows the redirection).
  // A `$(` opened in a string starts a command again, where a newline is one.
  const endOfPhysical = (line: string, open: QuoteStack): void => {
    const top = open.at(-1);
    if ((top === undefined || top === ')') && !CONTINUATION.test(line)) pendingHeredocs.push(...openedHeredocs.splice(0));
  };
  // Expanding heredoc text whose `$(` is still open, from the line it opened.
  let bodyRun: CodeLine | null = null;
  const flushBody = (): void => {
    if (bodyRun === null) return;
    const substitutions = substitutionsIn(bodyRun.code);
    if (substitutions.trim() !== '') result.push({ line: bodyRun.line, code: substitutions });
    bodyRun = null;
  };

  for (const [index, raw] of physical.entries()) {
    // Heredoc bodies come first: `X="$(cat <<EOF` opens both a heredoc and a
    // quote, and the body (through its delimiter) precedes the quote's close.
    const current = pendingHeredocs[0];
    if (current !== undefined) {
      const candidate = current.dash ? raw.replace(/^\t+/, '') : raw;
      // Exact match, as the shell requires: `EOF ` is body text.
      if (candidate === current.tag) {
        flushBody();
        pendingHeredocs.shift();
      } else if (current.expands) {
        // An unquoted delimiter expands the body like a double-quoted
        // string: its $(…) and backtick substitutions run. One spanning
        // lines is judged whole, from the line that opened it, with each
        // backslash-newline removed as bash removes it.
        // flushBody clears it, which narrowing cannot see.
        const run = bodyRun as CodeLine | null;
        if (run === null) bodyRun = { line: index + 1, code: raw };
        else if (CONTINUATION.test(run.code)) bodyRun = { line: run.line, code: `${run.code.slice(0, -1)}${raw}` };
        else bodyRun = { line: run.line, code: `${run.code}\n${raw}` };
        if (!substitutionOpen(bodyRun.code)) flushBody();
      }
      continue;
    }
    // A quote left open is always on a logical line still being built.
    if (openQuote.length > 0 && continued !== null) {
      // Inside a string that began on an earlier line: its text joins that
      // logical line verbatim (no comment stripping, no heredoc openers).
      // The whole nesting carries over, so in `"$(printf "%s` the next
      // line's first `"` closes the inner string, not the outer one.
      const scan = scanQuotes(raw, openQuote, true);
      // A comment inside a quoted `$(…)` body ends this physical line.
      const inside = scan.comment !== -1 ? beforeComment(raw, scan.comment) : scan.close === -1 ? raw : raw.slice(0, scan.close + 1);
      // In double quotes or a substitution a backslash-newline is still
      // removed: `"$(no\` + `de x)"` runs node. In single quotes both stay.
      continued = {
        line: continued.line,
        code: openQuote.at(-1) !== "'" && CONTINUATION.test(continued.code) ? `${continued.code.slice(0, -1)}${inside}` : `${continued.code}\n${inside}`,
      };
      if (scan.close === -1) {
        openQuote = scan.stack;
        endOfPhysical(raw, openQuote);
        continue;
      }
      const rest = stripComment(raw.slice(scan.close + 1));
      // Code after the close opens heredocs like every other line:
      // `printf '%s' 'help` + `'; cat <<'EOF'`.
      openedHeredocs.push(...heredocsOpenedBy(rest));
      openQuote = openQuoteAfter(rest);
      endOfPhysical(rest, openQuote);
      const restContinues = openQuote.length === 0 && CONTINUATION.test(rest);
      continued = { line: continued.line, code: continued.code + (restContinues ? rest.slice(0, -1) : rest) };
      // It holds the closing quote, so it is never blank.
      if (openQuote.length === 0 && !restContinues) {
        result.push(continued);
        continued = null;
      }
      continue;
    }
    if (continued === null && /^\s*#/.test(raw)) continue;
    const withoutComment = stripComment(raw);
    openQuote = openQuoteAfter(withoutComment);
    openedHeredocs.push(...heredocsOpenedBy(withoutComment));
    endOfPhysical(withoutComment, openQuote);
    const continues = openQuote.length === 0 && CONTINUATION.test(withoutComment);
    const body = continues ? withoutComment.slice(0, -1) : withoutComment;
    // As bash does: the backslash-newline goes, nothing replaces it, so
    // `no\` + `de x.js` is `node x.js`.
    continued = continued === null ? { line: index + 1, code: body } : { line: continued.line, code: `${continued.code}${body}` };
    if (!continues && openQuote.length === 0) {
      if (continued.code.trim() !== '') result.push(continued);
      continued = null;
    }
  }
  flushBody(); // an unterminated heredoc still ran its substitutions
  if (continued !== null && continued.code.trim() !== '') result.push(continued);
  return result;
};

/**
 * Splits shell words, keeping quotes attached (`"$f"` stays one word).
 * Command substitutions and `${…}` are kept whole. Stops at an unquoted `|`,
 * `;`, `&&`, `||`, `)`, or `&` that ends the simple command.
 */
export const words = (code: string): string[] => {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let resume = 0;
  for (const [index, char] of charsFrom(code, 0)) {
    if (index < resume) continue;
    if (char === '\\' && quote !== "'") {
      // An escape, unquoted or in double quotes, takes the next character.
      current += code.slice(index, index + 2);
      resume = index + 2;
    } else if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (/[({]/.test(char) && (code[index - 1] === '$' || depth > 0)) {
      depth += 1;
      current += char;
    } else if (/[)}]/.test(char) && depth > 0) {
      depth -= 1;
      current += char;
    } else if (depth === 0 && /[|;&)]/.test(char)) {
      break;
    } else if (depth === 0 && /\s/.test(char)) {
      if (current !== '') out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current !== '') out.push(current);
  return out;
};

/**
 * Where a simple command can start: line start, or after `$(`, a backtick,
 * `(`, `{`, `|`, `&&`, `||`, `;`, `!`, `then`, `do`, `else`, `if`, `while`,
 * `until`, or after a forwarding word (`exec`, `time`, `command`, `sudo`,
 * `env [opts]`, `xargs [opts]`), each allowing `VAR=value` prefixes.
 */
const commandStart = (): string => {
  // Reserved words that precede a command. They count only where a command
  // could start themselves (after a separator), so `echo if node` names no
  // command.
  const keyword = String.raw`(?:then|do|else|elif|if|while|until|!)`;
  // A `NAME=value ` prefix. The value may hold quoted blanks: the text is
  // quote-masked, so `LABEL="a b"` arrives as `LABEL="   "`.
  const assignment = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"'])*\s+`;
  // A redirection before the command word: `>/dev/null node x`, `2>&1 node
  // x`, `< "$in" node x`. Its target may be quoted (masked blanks).
  const leadingRedirection = String.raw`[0-9]*[<>]{1,2}&?\s*(?:"[^"]*"|'[^']*'|[^\s;&|<>()"'])+\s+`;
  return (
    // A newline separates commands inside a multi-line substitution.
    String.raw`(?:^|\$\(|[({|;&\n` +
    '`' +
    String.raw`])\s*(?:${keyword}\s+)*` +
    `(?:${assignment}|${leadingRedirection})*` +
    // An option that takes a value consumes it too: `env -u NODE_OPTIONS`,
    // `xargs -0 -n 1`, `xargs -I {}`.
    String.raw`(?:(?:exec|time|command|sudo|env(?:\s+(?:-[uCPS](?:\s*[^\s-]\S*)|-\S+))*|xargs(?:\s+(?:-[nILPsdEJR](?:\s*[^\s-]\S*)|-\S+))*)\s+` +
    `(?:${assignment})*)*`
  );
};

/** What follows a case pattern's first word: more `|word`s, then `)`. */
const CASE_LABEL_REST = /^(?:\s*\|\s*[^\s|;&()]+)*\s*\)/;

/**
 * Indexes of the `)` that close case patterns, in quote-masked text: one
 * after a pattern while a `case` on this line is open (`$(case $x in a)
 * node ;; esac)`, nested or not), or one that closes no open paren (an arm
 * of a `case` begun on an earlier line, `lint) node x ;;`). A command
 * starts after it; any other `)` closes its `(` or `$(`.
 */
const caseLabelClosers = (masked: string): Set<number> => {
  const closers = new Set<number>();
  let depth = 0;
  for (const [at, char] of charsFrom(masked, 0)) {
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0 || closesCasePattern(masked.slice(0, at))) closers.add(at);
      else depth -= 1;
    }
  }
  return closers;
};

/**
 * Every index just past `command` where it starts a simple command in `code`.
 * Quoted text never counts; a path prefix (`/usr/bin/grep`) does.
 */
export const commandPositions = (code: string, command: string): number[] => {
  // A whole quoted word (`"node"`, `'lockf'`) runs like the bare word: its
  // quotes become blanks, offsets unchanged, before quoted text is masked.
  const unquoted = code.replace(/(^|[\s;&|(!{`])(["'])([A-Za-z0-9_./-]+)\2(?=\s|$|[;&|)])/g, (_match, lead: string, _quote: string, word: string) => `${lead} ${word} `);
  const masked = maskQuoted(unquoted);
  const escaped = command.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const pattern = new RegExp(`${commandStart()}(?:[^\\s;&|()]*/)?${escaped}(?=\\s|$|[;)|&<>])`, 'g');
  const out: number[] = [];
  const labels = caseLabelClosers(masked);
  const separated = masked
    .split('')
    .map((char, at) => (labels.has(at) ? ';' : char))
    .join('');
  for (const match of separated.matchAll(pattern)) {
    const end = match.index + match[0].length;
    // A case label (`node)`, `node|npm)`) names a pattern, not a command.
    const rest = CASE_LABEL_REST.exec(masked.slice(end));
    if (rest !== null && labels.has(end + rest[0].length - 1)) continue;
    // Past a closing quote the blanking removed, so callers read the args.
    out.push(unquoted[end] === ' ' && /["']/.test(code.charAt(end)) ? end + 1 : end);
  }
  return out;
};

/** The first {@link commandPositions} index, or -1. */
export const commandAt = (code: string, command: string): number => commandPositions(code, command)[0] ?? -1;
