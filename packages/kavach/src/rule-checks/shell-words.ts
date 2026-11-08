/**
 * The simple commands of a shell command line, each as its words.
 *
 * For checks that look for a command (`git merge main`), not for text that
 * merely contains one: a commit message, an `echo`, a quoted heredoc body. A
 * static reading, like `shell-comments.ts`: single, double and `$'…'` quotes
 * join a word (`$'…'` escapes decoded); a backslash escapes the next
 * character, and before a newline joins two lines; `;`, `&`, `|`, `(`, `)` and
 * a newline end a command; a redirection drops its target (and a
 * file-descriptor number before it); a `#` that starts a word comments out the
 * rest of its line. `$(…)` and backquotes are read as commands of their own,
 * also inside double quotes and unquoted heredoc bodies, where the shell runs
 * them, and leave `FILLED` in the word they sit in; a quoted heredoc body is
 * skipped. A plain `${…}` or arithmetic `$((…))` leaves `FILLED` too; a
 * `${…}` that could nest or run a command stops the reading.
 *
 * A subshell's parentheses nest, so its `)` never closes an enclosing `$(…)`.
 * The script of `bash -c` (`sh`, `zsh`, `dash`) reads as commands after its
 * own, so a command hidden in one is still seen.
 *
 * Where it cannot follow the shell (an unterminated quote or substitution, a
 * heredoc word it cannot settle, a `case` inside a substitution, whose
 * patterns end in an unpaired `)`) it stops, and `unread` holds the text from
 * the start of the command it stopped in, so a check can fail closed on it;
 * `everyCommand` adds a rough reading of that text for checks that refuse.
 *
 * One pass over the characters, so no input can make it loop.
 *
 * `invoked`, `program`, `subcommand` and `gitSubcommand` then read what a
 * command runs: a commit, a container build, a merge of the main branch, a git
 * or pull-request command.
 *
 * `programOf` reads the program past runners, `resolvePath` the paths a word
 * names, and `steps` the folder each command runs in.
 */
import { dirname, isAbsolute, resolve } from 'node:path';

/** Characters that end a simple command. */
const OPERATORS = ';&|()\n';
/** Characters a backslash escapes inside double quotes. */
const DOUBLE_ESCAPES = '"\\$`\n';
const HEREDOC = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"\\$`]*)"|([A-Za-z_]\w*))(?=[ \t\n;|&()<>]|$)/;
/**
 * What `$(…)`, backquotes and `${…}` leave in a word: the value the shell
 * fills in, unknown here, so a check can tell `origin/${B}` from `origin/`.
 */
export const FILLED = '$';
/** What a `${…}` this reader reads through must not hold. */
const NESTING = /[$`"'{\\]/;
/**
 * What `arithmeticLength` stops at: a parenthesis; or a substitution or a
 * newline, which it does not read through. A heredoc's end line can follow a
 * newline, and each scan ends before the next `$((`, so a line of them is
 * read in one pass.
 */
const ARITHMETIC_STOPS = /[()`\n]|\$\(/g;
/** The rest of a redirection operator after its first character. */
const REDIRECTION_TAIL = /^[<>&|]*/;
/**
 * A `$'…'` escape: hex, Unicode or octal code, else the escaped character as
 * itself. `\n` reads as `n`, not a newline: a control character never makes a
 * command word, so only the codes that can spell one are decoded.
 */
const ANSI_ESCAPE = /^\\(?:x([0-9A-Fa-f]{1,2})|[uU]([0-9A-Fa-f]{1,8})|([0-7]{1,3})|[\s\S])/;
const MAX_CODE_POINT = 0x10ffff;

type Heredoc = {
  readonly word: string;
  readonly tabs: boolean;
  /** An unquoted word: the shell expands `$(…)` and backquotes in the body. */
  readonly expands: boolean;
};
/** Where the reader is: in a word or between words, a quote, a comment, a heredoc body. */
type Mode = 'plain' | "'" | '"' | "$'" | 'comment' | 'body';
/**
 * The command a substitution or subshell interrupted, and what closes it. A
 * subshell `(…)` is a frame too, so its `)` never closes an enclosing `$(…)`.
 */
type Frame = {
  readonly words: string[];
  readonly word: string | null;
  readonly target: boolean;
  readonly mode: Mode;
  readonly closer: ')' | '`';
  /** A substitution leaves a word part behind; a subshell leaves nothing. */
  readonly substitution: boolean;
  readonly start: number;
};

export type Reading = {
  readonly commands: string[][];
  /** From the start of the command the reader stopped in; empty when it read everything. */
  readonly unread: string;
};

/** Whether a body line is the word that ends its heredoc. */
const ends = (body: Heredoc, line: string): boolean => (body.tabs ? line.replace(/^\t+/, '') : line) === body.word;

/** The escape `text` starts with; null for a backslash that ends the text. */
function ansiEscape(text: string): { value: string; length: number } | null {
  const match = ANSI_ESCAPE.exec(text);
  if (match === null) return null;
  const [whole, hex, unicode, octal] = match;
  const code =
    hex === undefined
      ? unicode === undefined
        ? octal === undefined
          ? null
          : parseInt(octal, 8)
        : parseInt(unicode, 16)
      : parseInt(hex, 16);
  return {
    value:
      code === null
        ? whole.slice(1)
        : // Past Unicode's last code point no character can spell a word,
          // and String.fromCodePoint would throw.
          code > MAX_CODE_POINT
          ? ''
          : String.fromCodePoint(code),
    length: whole.length,
  };
}

/**
 * How far past its `$` an arithmetic `$((…))` at `i` runs: it runs no
 * command, so it reads as `FILLED`. 0 when `i` starts none, when its `))`
 * never comes (`$( (a) )` is a subshell), or when it holds a substitution,
 * which is then read as one.
 */
function arithmeticLength(text: string, i: number): number {
  if (!text.startsWith('$((', i)) return 0;
  ARITHMETIC_STOPS.lastIndex = i + 3;
  let depth = 0;
  for (let stop = ARITHMETIC_STOPS.exec(text); stop !== null; stop = ARITHMETIC_STOPS.exec(text)) {
    if (stop[0] === '(') {
      depth++;
    } else if (stop[0] !== ')') {
      return 0;
    } else if (depth > 0) {
      depth--;
    } else {
      return text[stop.index + 1] === ')' ? stop.index + 1 - i : 0;
    }
  }
  return 0;
}

/** A command not yet begun: at the start of the text and inside a substitution. */
const fresh = (): Pick<Frame, 'word' | 'target' | 'mode'> & {
  words: string[];
} => ({ words: [], word: null, target: false, mode: 'plain' });

export function simpleCommands(text: string): Reading {
  const commands: string[][] = [];
  let { words, word, target, mode } = fresh();
  // Characters already read as part of the one before them.
  let skip = 0;
  let escaped = false;
  // Heredocs opened on this line; their bodies start after its newline.
  let opened: Heredoc[] = [];
  let bodies: Heredoc[] = [];
  // The body line read so far; every body newline empties it, so it is empty
  // whenever a body starts.
  let line = '';
  const frames: Frame[] = [];
  let start = 0;
  // What the first `bash -c` script the reader could not follow left unread.
  let scriptUnread = '';
  const stop = (): Reading => {
    const rest = text.slice(frames[0]?.start ?? start);
    return {
      commands,
      unread: scriptUnread === '' ? rest : `${scriptUnread}\n${rest}`,
    };
  };
  const add = (char: string): void => {
    word = (word ?? '') + char;
  };
  // A `case` inside a frame: its patterns' `)` would close the frame early.
  let unfollowable = false;
  const endWord = (): void => {
    if (word === null) return;
    if (word === 'case' && words.length === 0 && frames.length > 0) {
      unfollowable = true;
    }
    if (target) target = false;
    else words.push(word);
    word = null;
  };
  const endCommand = (at: number): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    const script = shellScript(invoked(words));
    if (script !== null) {
      const inner = simpleCommands(script);
      commands.push(...inner.commands);
      if (scriptUnread === '') scriptUnread = inner.unread;
    }
    words = [];
    target = false;
    start = at;
  };
  const open = (closer: ')' | '`', substitution = true): void => {
    frames.push({ words, word, target, mode, closer, substitution, start });
    ({ words, word, target, mode } = fresh());
  };
  /**
   * Reads `${…}` as `FILLED`. False when it never closes, or when it holds
   * what could nest or run a command (`${x:-$(git merge main)}`): a
   * substitution, quote, brace or escape.
   */
  const braced = (i: number): boolean => {
    const close = text.indexOf('}', i);
    if (close === -1 || NESTING.test(text.slice(i + 2, close))) return false;
    add(FILLED);
    skip = close - i;
    return true;
  };
  for (const [i, char] of text.split('').entries()) {
    if (unfollowable) return stop();
    if (skip > 0) {
      skip--;
      continue;
    }
    const arithmetic = arithmeticLength(text, i);
    // Body mode always has a body open: entering it moves at least one there.
    const [body] = bodies;
    if (mode === 'body' && body !== undefined) {
      if (arithmetic > 0) {
        line += text.slice(i, i + arithmetic + 1);
        skip = arithmetic;
      } else if (body.expands && text.startsWith('$(', i)) {
        open(')');
        skip = 1;
      } else if (body.expands && char === '`') {
        open('`');
      } else if (char !== '\n') {
        line += char;
      } else {
        if (ends(body, line)) {
          bodies.shift();
        }
        line = '';
        if (bodies.length === 0) [mode, start] = ['plain', i + 1];
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      if (char !== '\n') add(char);
      continue;
    }
    if (mode === "'") {
      if (char === "'") mode = 'plain';
      else add(char);
      continue;
    }
    if (mode === "$'") {
      if (char === "'") {
        mode = 'plain';
      } else if (char === '\\') {
        const decoded = ansiEscape(text.slice(i));
        if (decoded === null) return stop();
        add(decoded.value);
        skip = decoded.length - 1;
      } else {
        add(char);
      }
      continue;
    }
    if (mode === '"') {
      const next = text[i + 1];
      if (char === '"') {
        mode = 'plain';
      } else if (arithmetic > 0) {
        add(FILLED);
        skip = arithmetic;
      } else if (text.startsWith('$(', i)) {
        open(')');
        skip = 1;
      } else if (char === '`') {
        open('`');
      } else if (text.startsWith('${', i)) {
        if (!braced(i)) return stop();
      } else if (char === '\\' && next !== undefined && DOUBLE_ESCAPES.includes(next)) {
        escaped = true;
      } else {
        add(char);
      }
      continue;
    }
    if (mode === 'comment') {
      if (char !== '\n') continue;
      mode = 'plain';
    }
    const frame = frames.at(-1);
    if (frame !== undefined && char === frame.closer) {
      endCommand(start);
      frames.pop();
      ({ words, word, target, mode, start } = frame);
      if (frame.substitution && mode !== 'body') add(FILLED);
    } else if (char === '(') {
      endCommand(i + 1);
      open(')', false);
    } else if (char === '\\') {
      escaped = true;
    } else if (arithmetic > 0) {
      add(FILLED);
      skip = arithmetic;
    } else if (text.startsWith('$(', i)) {
      open(')');
      skip = 1;
    } else if (char === '`') {
      open('`');
    } else if (text.startsWith('${', i)) {
      if (!braced(i)) return stop();
    } else if (char === "'" || char === '"') {
      add('');
      mode = char;
    } else if (text.startsWith("$'", i)) {
      add('');
      mode = "$'";
      skip = 1;
    } else if (char === '#' && word === null) {
      mode = 'comment';
    } else if (char === ' ' || char === '\t') {
      endWord();
    } else if (text.startsWith('<<', i) && !text.startsWith('<<<', i)) {
      const marker = HEREDOC.exec(text.slice(i));
      if (marker === null) return stop();
      endWord();
      const [whole, dash, single, double, bare] = marker;
      opened.push({
        word: single ?? double ?? bare ?? '',
        tabs: dash === '-',
        expands: bare !== undefined,
      });
      skip = whole.length - 1;
    } else if (char === '<' || char === '>' || text.startsWith('&>', i)) {
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      target = true;
      skip = REDIRECTION_TAIL.exec(text.slice(i + 1))?.[0].length ?? 0;
    } else if (char === '\n') {
      endCommand(i + 1);
      if (opened.length > 0) [mode, bodies, opened] = ['body', opened, []];
    } else if (OPERATORS.includes(char)) {
      endCommand(i + 1);
    } else {
      add(char);
    }
  }
  // A body may end at the end of the text, without a newline after its word.
  // Bodies are open only in body mode or a substitution inside one, which
  // stops below either way.
  const [last] = bodies;
  if (bodies.length === 1 && last !== undefined && ends(last, line)) {
    mode = 'plain';
  }
  if (mode !== 'plain' && mode !== 'comment') return stop();
  if (opened.length > 0 || frames.length > 0) return stop();
  endCommand(text.length);
  return { commands, unread: scriptUnread };
}

/** Where `roughCommands` splits: every operator, parenthesis and backquote. */
const ROUGH_BREAKS = /[;&|()\n`]/;

/**
 * A rough reading of text the reader could not follow: split at every
 * operator, quotes and backslashes dropped. A quoted mention may read as a
 * command here, so checks that refuse a command read it and fail closed.
 */
export function roughCommands(unread: string): string[][] {
  return unread
    .split(ROUGH_BREAKS)
    .map((part) =>
      part
        .replace(/['"\\]/g, '')
        .split(/[ \t]+/)
        .filter((word) => word !== ''),
    )
    .filter((words) => words.length > 0);
}

/**
 * Every command a check that refuses one reads: the commands read, then a
 * rough reading of any text after where the reader stopped, so a command
 * past it (`echo "$(case …)"; git commit`) is still seen.
 */
export function everyCommand(text: string): string[][] {
  const reading = simpleCommands(text);
  return [...reading.commands, ...roughCommands(reading.unread)];
}

/** Shell keywords a command can follow (`if git push; then …`). */
const KEYWORDS = ['!', '{', 'if', 'then', 'else', 'elif', 'do', 'while', 'until'];

/** Leading words that run the command after them, and their valued options. */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ...KEYWORDS.map((keyword) => [keyword, new Set<string>()] as const),
  ['command', new Set<string>()],
  ['exec', new Set(['-a'])],
  ['time', new Set(['-o', '-f'])],
  ['nohup', new Set<string>()],
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])],
  ['nice', new Set(['-n'])],
  ['sudo', new Set(['-u', '-g', '-C', '-D'])],
]);

/** Shells whose `-c` script is read as commands too (`bash -c 'git push'`). */
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash']);

/** The script a shell runs with `-c` (`sh -ec '…'`), if any. */
export function shellScript(words: readonly string[]): string | null {
  const [name, ...args] = words;
  if (name === undefined || !SHELLS.has(program(name))) return null;
  const flag = args.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
  return flag === -1 ? null : (args[flag + 1] ?? null);
}

const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** The base name of a program word: `/usr/bin/git` reads as `git`. */
export function program(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

/** The index past the options at `i` (`-x`, and `-o value` for each valued one). */
function pastOptions(words: readonly string[], i: number, takesValue: ReadonlySet<string>): number {
  let at = i;
  for (let option = words[at]; option?.startsWith('-') === true; option = words[at]) {
    at += takesValue.has(option) ? 2 : 1;
  }
  return at;
}

/**
 * The words a simple command runs, past assignments (`A=1 git …`), shell
 * keywords and the wrappers above with their options. Empty when only those
 * remain.
 */
export function invoked(words: readonly string[]): readonly string[] {
  let i = 0;
  for (let word = words[i]; word !== undefined; word = words[i]) {
    const takesValue = WRAPPERS.get(program(word));
    if (ASSIGNMENT.test(word)) {
      i++;
    } else if (takesValue !== undefined) {
      i = pastOptions(words, i + 1, takesValue);
    } else {
      break;
    }
  }
  return words.slice(i);
}

export type Subcommand = {
  readonly name: string;
  readonly rest: readonly string[];
};

/**
 * A tool's subcommand and the words after it: `git -C x commit -m y` reads as
 * `commit` and `-m y`, skipping the options before it and the value of each
 * option in `takesValue` (given as its own word). `null` when none follows.
 */
export function subcommand(args: readonly string[], takesValue: ReadonlySet<string>): Subcommand | null {
  const i = pastOptions(args, 0, takesValue);
  const name = args[i];
  return name === undefined ? null : { name, rest: args.slice(i + 1) };
}

/** Global options of git whose value is the next word (`git -C dir push`). */
export const GIT_VALUED: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--config-env',
  '--git-dir',
  '--namespace',
  '--work-tree',
]);

/** `git [options] <subcommand> …` in a simple command; `null` for any other. */
export function gitSubcommand(words: readonly string[]): Subcommand | null {
  const [name, ...args] = invoked(words);
  if (name === undefined || program(name) !== 'git') return null;
  return subcommand(args, GIT_VALUED);
}

/** Runners `programOf` also reads past, with their valued options. */
const RUNNERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['npx', new Set(['-p', '--package', '-c', '--call'])],
]);

export type Program = {
  /** Assignments written before the program (`NAME=value git push`). */
  readonly env: ReadonlyMap<string, string>;
  /** The program and its arguments, past any wrapper; never empty. */
  readonly args: readonly string[];
};

/**
 * The program a simple command runs, as `invoked` reads it, keeping the
 * assignments' values, and also past `timeout <duration>`, `npx`, and
 * `pnpm exec` / `pnpm dev:exec`. Null when nothing is left to run.
 */
export function programOf(words: readonly string[]): Program | null {
  const env = new Map<string, string>();
  let i = 0;
  for (let word = words[i]; word !== undefined; word = words[i]) {
    const name = program(word);
    const valued = WRAPPERS.get(name) ?? RUNNERS.get(name);
    if (ASSIGNMENT.test(word)) {
      const at = word.indexOf('=');
      env.set(word.slice(0, at), word.slice(at + 1));
      i += 1;
    } else if (valued !== undefined) {
      i = pastOptions(words, i + 1, valued);
      // timeout's duration comes before the program it runs.
      if (name === 'timeout') i += 1;
    } else if (name === 'pnpm' && ['exec', 'dev:exec'].includes(String(words[i + 1]))) {
      i += 2;
    } else {
      return { env, args: words.slice(i) };
    }
  }
  return null;
}

/**
 * The absolute path a word names, from folder `dir` (null when unknown): `~`
 * expands to `home` and `~user` to its sibling, as on macOS and Linux; `$HOME`
 * and `${HOME}` expand anywhere in the word. Null when any other expansion is
 * left, or the word is relative to an unknown folder.
 */
export function resolvePath(word: string, dir: string | null, home: string): string | null {
  const expanded = word
    .replace(/^~(?=\/|$)/, home)
    .replace(/^~(?=[^/])/, `${dirname(home)}/`)
    .replace(/\$HOME(?!\w)|\$\{HOME\}/g, home);
  if (expanded.includes('$')) return null;
  if (isAbsolute(expanded)) return resolve(expanded);
  return dir === null ? null : resolve(dir, expanded);
}

export type Step = Program & {
  /** The folder the command runs in after any earlier `cd`; null when unknown. */
  readonly dir: string | null;
};

/** `cd` and `pushd` options before the folder (`cd -P -- dir`). */
const CD_OPTION = /^-[LPe@]+$|^--$/;

/**
 * Each simple command with the folder it runs in. A `cd` (or `pushd`) moves
 * the folder for the commands after it; after one whose target is unknown
 * (`cd $X`, `cd -`), later commands run in an unknown folder, where only
 * absolute paths can be judged.
 */
export function steps(command: string, cwd: string, home: string): Step[] {
  const found: Step[] = [];
  let dir: string | null = cwd;
  for (const words of everyCommand(command)) {
    const run = programOf(words);
    if (run === null) continue;
    const [name, ...args] = run.args;
    if (name === 'cd' || name === 'pushd') {
      const operands = args.filter((arg) => !CD_OPTION.test(arg));
      const [target = home] = operands;
      // `cd -` goes back to a folder this reading never saw.
      dir = target === '-' ? null : resolvePath(target, dir, home);
      continue;
    }
    found.push({ ...run, dir });
  }
  return found;
}
