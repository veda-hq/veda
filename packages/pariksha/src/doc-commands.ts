// The commands a Markdown document shows (DOC-DRIFT-02): each simple command
// in a shell fence or an inline code span, read into the words bash would
// hand the program. doc-command-rules.ts judges them.
import { posix } from 'node:path';
import { codeSpans, isShellFence, scanMarkdown } from './doc-references.ts';
import { maskQuoted, stripComment } from './shell-text.ts';

/** One simple command a doc shows: words after env assignments. */
export interface DocCommand {
  readonly file: string;
  readonly line: number;
  readonly words: string[];
  /** The simple command as written, assignments and quotes included. */
  readonly text: string;
  /** Directory a preceding `cd` moved to ('' = root): earlier on the line, or on an earlier line of the same shell fence. */
  readonly cwd: string;
  /** In a fence (a command to type) rather than an inline mention. */
  readonly fenced: boolean;
}

/** A command word: what makes a code span or a bare fence line a command. */
const COMMAND_HEAD = /^(?:cd\s+\S+\s*&&\s*)?(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:pnpm|npx|node|tsx|python3?|bash|sh)\s/;

/**
 * In a fence declared as shell, a script path may itself be the command
 * (`./scripts/x.ts --flag`). Elsewhere a lone path is a mention.
 */
const SCRIPT_HEAD = /^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*\.{0,2}\/?[\w./-]+\.(?:ts|mjs|js|sh|py)(?:[\s;&|]|$)/;

/** Fence info strings that declare a block as shell (a bare fence only may be). */
const DECLARED_SHELL: ReadonlySet<string> = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'terminal']);

/** The value of digits a pattern already matched in base `radix`. */
const digitsValue = (digits: string, radix: 8 | 16): number => {
  let value = 0;
  for (const digit of digits.toLowerCase()) value = value * radix + '0123456789abcdef'.indexOf(digit);
  return value;
};

/** The named escapes of ANSI-C quoting. */
const ANSI_C_NAMED: Readonly<Record<string, string>> = { a: '\u0007', b: '\b', e: '\u001b', E: '\u001b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/**
 * The value of a `$'…'` body, as bash decodes it: the named escapes, octal
 * `\N` to `\NNN` (low eight bits), `\xH`/`\xHH`, `\uHHHH`, `\UHHHHHHHH` and
 * `\cX` (X's low five bits); an unknown escape keeps its backslash, and the
 * value ends at its first NUL.
 */
const ansiC = (body: string): string =>
  String(
    body
      .replace(/\\(?:([0-7]{1,3})|x([\da-fA-F]{1,2})|u([\da-fA-F]{1,4})|U([\da-fA-F]{1,8})|c([^])|[^])/g, (escape: string, octal?: string, x?: string, u?: string, bigU?: string, control?: string) => {
        if (octal !== undefined) return String.fromCharCode(digitsValue(octal, 8) & 0xff);
        const hex = x ?? u ?? bigU;
        if (hex !== undefined) {
          const code = digitsValue(hex, 16);
          // Past Unicode bash writes no character; keep the escape.
          return code > 0x10ffff ? escape : String.fromCodePoint(code);
        }
        if (control !== undefined) return String.fromCharCode(control.charCodeAt(0) & 0x1f);
        return ANSI_C_NAMED[escape.slice(1)] ?? escape;
      })
      .split('\0')[0],
  );

/**
 * Shell words of one simple command, as bash hands them to the program. A
 * word runs to unquoted whitespace and joins its parts (`--mode="a b"` is one
 * word): single quotes keep every character, double quotes every character
 * but a backslash before `$`, `` ` ``, `"` or `\`, and outside quotes a
 * backslash keeps the character after it. `$'…'` is ANSI-C quoting, its
 * escapes decoded, and `$"…"` a double-quoted string. A quote that never
 * closes stays a character (bash refuses the line). Expansions, operators and
 * line continuations are the callers' or out of reach.
 */
export const shellWords = (text: string): string[] =>
  Array.from(text.matchAll(/(?:\$'(?:[^'\\]|\\[^])*'|'[^']*'|\$?"(?:[^"\\]|\\[^])*"|\\[^]|[^\s'"\\]|['"\\])+/g), ([word]) =>
    Array.from(
      word.matchAll(/\$'((?:[^'\\]|\\[^])*)'|'([^']*)'|\$?"((?:[^"\\]|\\[^])*)"|\\([^])|([^])/g),
      (part) => (part[1] === undefined ? undefined : ansiC(part[1])) ?? part[2] ?? part[3]?.replace(/\\([$`"\\])/g, '$1') ?? part[4] ?? String(part[5]),
    ).join(''),
  );

/** Whether code ends in a backslash that escapes what follows: an odd run of them. */
const continues = (code: string): boolean => /(?:^|[^\\])(?:\\\\)*\\$/.test(code);

const withoutCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

/** `code` without its outer blanks, but one a backslash escapes (`a\ `). */
const trimCode = (code: string): string => {
  const trimmed = code.trim();
  if (!continues(trimmed)) return trimmed;
  const end = code.length - code.trimStart().length + trimmed.length;
  return `${trimmed}${code.charAt(end)}`;
};

/**
 * The simple commands of one shell line, as written: split at `&&`, `||`, `;`
 * and `|` outside quotes and escapes (found in the quote-masked line, which
 * keeps every index).
 */
export const simpleCommands = (line: string): string[] => {
  const masked = maskQuoted(line);
  const commands: string[] = [];
  let start = 0;
  for (const match of masked.matchAll(/&&|\|\||;|\|/g)) {
    commands.push(trimCode(line.slice(start, match.index)));
    start = match.index + match[0].length;
  }
  commands.push(trimCode(line.slice(start)));
  return commands;
};

/** Words after any leading `NAME=value` environment assignments. */
export const withoutAssignments = (words: readonly string[]): string[] => {
  const first = words.findIndex((word) => !/^[A-Z_][A-Z0-9_]*=/.test(word));
  return first === -1 ? [] : words.slice(first);
};

/** The directory a `cd` command's words name: after bash's own options (`-L`, `-P`, `-e`, `-@`) and a `--`. `cd -` is no option. */
const cdOperand = (words: readonly string[]): string | undefined => {
  let at = 1;
  while (/^-[LPe@]+$/.test(String(words[at]))) at += 1;
  if (words[at] === '--') at += 1;
  return words[at];
};

/** Options of npx (npm exec) whose value is the next word, `-c`/`--call` among them. */
export const NPX_VALUE_OPTIONS: ReadonlySet<string> = new Set(['--package', '-p', '--cache', '--userconfig', '--shell', '--call', '-c', '--workspace', '-w']);

/**
 * The shell command an `npx -c '…'` runs, if `words` are one: the value of
 * `-c`/`--call` after npx's other options. npm refuses a call with words
 * after it, so `npx -c tsx x.ts` runs nothing.
 */
export const npxCall = (words: readonly string[]): string | undefined => {
  if (words[0] !== 'npx') return undefined;
  let at = 1;
  for (let word = words[at]; word?.startsWith('-') === true; word = words[at]) {
    const [name, inline] = word.split(/=(.*)/s);
    if (name === '--call' || name === '-c') {
      const call = inline ?? words[at + 1];
      const next = at + (inline === undefined ? 2 : 1);
      // npm reads an empty call as none: its words run.
      return call === '' || next < words.length ? undefined : call;
    }
    at += NPX_VALUE_OPTIONS.has(word) ? 2 : 1;
  }
  return undefined;
};

/** Every simple command shown in a Markdown document. */
export const documentedCommands = (file: string, content: string, exemptMarker: RegExp): DocCommand[] => {
  const commands: DocCommand[] = [];
  /** Reads `text` from directory `from`, recording its commands when `shown`; returns the directory its `cd`s leave the shell in. */
  const read = (line: number, text: string, fenced: boolean, from: string, shown: boolean): string => {
    let cwd = from;
    for (const part of simpleCommands(text)) {
      const words = withoutAssignments(shellWords(part));
      const dir = words[0] === 'cd' ? cdOperand(words) : undefined;
      if (dir !== undefined) {
        // An absolute operand replaces the directory.
        cwd = posix.normalize(posix.isAbsolute(dir) ? dir : posix.join(cwd, dir)).replace(/^\.$/, '');
        continue;
      }
      // `npx -c '…'` runs its call's commands, each one judged; npm runs the
      // call in a shell of its own, so a `cd` in it moves only the call's later commands.
      const call = npxCall(words);
      if (call !== undefined) {
        read(line, call, fenced, cwd, shown);
        continue;
      }
      if (shown && words.length > 0) commands.push({ file, line, words, text: part, cwd, fenced });
    }
    return cwd;
  };

  const lines = scanMarkdown(content, exemptMarker);
  // A fence's lines are one shell session: a `cd` on its own line moves the
  // lines after it. The next fence starts from the root again.
  let fenceCwd = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.fence === null) {
      if (line.exempt || line.frontmatter) continue;
      // An inline span is a command of its own, run from the root.
      for (const span of codeSpans(line.text)) {
        if (COMMAND_HEAD.test(`${span.content} `)) read(line.number, span.content, false, '', true);
      }
      continue;
    }
    if (isShellFence(line.fence)) {
      // A `#` outside quotes starts a comment, and a backslash inside one
      // continues nothing, so the comment goes before a trailing backslash is
      // read. That backslash joins the next line as bash joins it, and the
      // joined text is read for a comment again. A CRLF line's CR is its line break.
      let text = stripComment(withoutCr(line.text).replace(/^\s*\$\s+/, ''));
      const start = line.number;
      // Only a line of the same fence continues it.
      for (let next = lines[index + 1]; continues(text) && next?.block === line.block; next = lines[index + 1]) {
        index += 1;
        text = stripComment(`${text.slice(0, -1)}${withoutCr(next.text)}`);
      }
      text = trimCode(text);
      // Every line's `cd` counts, an exempt line's included (the shell still
      // runs it); only a line that runs something, unexempt, is judged.
      fenceCwd = read(start, text, true, fenceCwd, !line.exempt && (COMMAND_HEAD.test(`${text} `) || (DECLARED_SHELL.has(line.fence) && SCRIPT_HEAD.test(text))));
    }
    // The fence's last line: the next fence starts from the root.
    if (lines[index + 1]?.block !== line.block) fenceCwd = '';
  }
  return commands;
};
