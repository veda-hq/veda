// masked-exit-codes: a gate must be able to fail.
//
// A check that keeps reporting success after it stopped checking is the most
// dangerous defect a repository's tooling can have: a hook that runs a commit
// message linter and then `exit 0`, a review step whose every failure reads
// as "no issues found", a baseline read with `2>/dev/null || true`. Each
// produces a green run, precisely where it matters.
//
// `|| true` is legitimate in plenty of places (probing for an optional tool,
// tolerating "no matches" from grep), so this does not ban it. It flags only
// the shapes that silence a real verdict:
//
//   1. `exit 0` at the end of a script that ran a gate, with no branch on
//      that gate's status;
//   2. `|| true`, a handler that does not exit non-zero, or `2>/dev/null`
//      with the status unchecked, applied to a gate command (the config's
//      `gateCommands`: a linter, test runner, validator or reviewer);
//   3. in a file under `pipefailScope`, `echo`/`printf` of a variable piped
//      into a reader that stops early (`grep -q`, `-m`, `-l`, `head`), which
//      under pipefail reads a match as a miss and skips the check it gates.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ShellToken, splitAndOrLists, splitSegmentsWithSeparators, substitutionBodies, tokenize } from './shell-command.ts';

export interface MaskedConfig {
  /** What the messages call this check: a project's rule id, say. */
  readonly id: string;
  /**
   * Commands whose exit status is the verdict; masking one is the defect. A
   * command of several words (`prettier --check`) must appear whole. Keep it
   * narrow: a broad list fires on every optional-tool probe.
   */
  readonly gateCommands: readonly string[];
  /** Path prefixes whose files are shell whatever their name (git hook directories). */
  readonly hookDirs: readonly string[];
  /** Regexes over a path: the files that run under `set -o pipefail`, which shape 3 holds. */
  readonly pipefailScope: readonly RegExp[];
}

export const DEFAULT_GATE_COMMANDS: readonly string[] = ['eslint', 'tsc', 'vitest', 'prettier --check', 'commitlint', 'cubic review', 'gitleaks', 'actionlint', 'shellcheck', 'depcruise', 'stryker'];

export const DEFAULT_MASKED_CONFIG: MaskedConfig = {
  id: 'masked-exit-codes',
  gateCommands: DEFAULT_GATE_COMMANDS,
  hookDirs: ['.husky/'],
  pipefailScope: [/^\.husky\//],
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const KEYS = ['id', 'gateCommands', 'hookDirs', 'pipefailScope'];

/**
 * `{ "id"?: "<label>", "gateCommands"?: ["<command>", …], "hookDirs"?:
 * ["<path prefix>", …], "pipefailScope"?: ["<regex>", …] }`; absent keys
 * take the defaults. Throws on anything else, so a mistyped key never passes
 * as the default.
 */
export const parseMaskedConfig = (text: string): MaskedConfig => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('the config must be a JSON object');
  const unknown = Object.keys(raw).find((k) => !KEYS.includes(k));
  if (unknown !== undefined) throw new Error(`unknown key "${unknown}"`);
  const id = raw['id'] ?? DEFAULT_MASKED_CONFIG.id;
  if (typeof id !== 'string' || id.trim() === '') throw new Error('"id" must be a non-empty string');
  const list = (key: string, fallback: readonly string[], what: string): readonly string[] => {
    const value = raw[key] ?? fallback;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) throw new Error(`"${key}" must be a list of ${what}`);
    return value as string[];
  };
  const gateCommands = list('gateCommands', DEFAULT_MASKED_CONFIG.gateCommands, 'commands');
  if (gateCommands.length === 0) throw new Error('"gateCommands" names no command, so nothing would be checked');
  const hookDirs = list('hookDirs', DEFAULT_MASKED_CONFIG.hookDirs, 'path prefixes');
  const scope = list(
    'pipefailScope',
    DEFAULT_MASKED_CONFIG.pipefailScope.map((r) => r.source),
    'regexes',
  ).map((source) => {
    try {
      return new RegExp(source);
    } catch (e) {
      throw new Error(`"pipefailScope" holds a bad regex: ${(e as Error).message}`);
    }
  });
  return { id, gateCommands, hookDirs, pipefailScope: scope };
};

export interface MaskedExit {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly reason: string;
}

/** Files git tracks under `root` that are shell scripts (`*.sh`) or under a hook directory. */
export const shellFiles = (root: string, config: MaskedConfig = DEFAULT_MASKED_CONFIG): string[] =>
  execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
    .filter((path) => path.endsWith('.sh') || config.hookDirs.some((prefix) => path.startsWith(prefix)))
    .filter((path) => !path.includes('/node_modules/'));

/** Whether the line is a comment, or an echo or printf. */
const isCommentary = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.startsWith('#') || trimmed.startsWith('echo ') || trimmed.startsWith('printf ');
};

/** An exit status word: digits, `$?` or a variable, quoted or not. */
const EXIT_STATUS = String.raw`\d+|'\d+'|"\d+"|"?\$\?"?|"?\$\{?[A-Za-z_]\w*\}?"?`;

/**
 * Whether this list hands the gate's failure onward rather than swallow it.
 * `|| exit 1`, `|| exit '1'` and a bare `|| exit` do; `|| exit 0` converts a
 * failure into a success, so it is a mask. The exit must end its command:
 * `|| exit 1 | cat` and `|| exit 1 &` run it in a subshell, while
 * redirections after the status (`|| exit 1 2>&1`) still end the command.
 * `|| false` leaves the list failed, so `set -e` still sees the failure.
 */
const propagatesFailure = (line: string, { falseKeeps = true }: { falseKeeps?: boolean } = {}): boolean => {
  // Each redirection starts after whitespace and its target holds no `<`/`>`,
  // so the repetition has one way to match (no exponential backtracking).
  const handler = new RegExp(String.raw`^\|\|\s*(?:(?:exit|return)\b(?:\s+(${EXIT_STATUS}))?|false\b)(?:\s+\d*(?:>>?|<)&?\s*[^\s;&|)}#<>]+)*(?=\s*(?:$|;|&&|\|\||\)|\}|#))`);
  // Only the first handler runs on a failure: in `eslint . || echo failed
  // || exit 1` echo succeeds and the exit never runs. `false` fails, so the
  // handler after it runs too: `|| false || echo ok` ends in echo's success,
  // so a `false` keeps the list failed only as its last handler.
  const starts = handlerStarts(line);
  for (const at of starts) {
    const match = handler.exec(line.slice(at));
    if (match === null) return false;
    if (/^\|\|\s*false\b/.test(match[0])) {
      if (falseKeeps && at === starts.at(-1)) return true;
      continue;
    }
    // A bare `exit` and `exit $?` hand on the gate's own, non-zero, status.
    const status = match[1];
    return status === undefined || failingStatus(status, { lastIsGate: true });
  }
  return false;
};

/** The handler a failure reaches first (past any `|| false`), if any. */
const firstHandler = (list: string): string | undefined =>
  handlerStarts(list)
    .map((at) => list.slice(at))
    .find((rest) => !/^\|\|\s*false\b/.test(rest));

/**
 * One piece of an and-or list as `handlerStarts` reads it: an escaped
 * character, a quoted string (open to the end of the list when unclosed;
 * `\` escapes only inside double quotes), an `||`, or any other character.
 */
const LIST_PIECE = /\\[\s\S]?|'[^']*'?|"(?:\\[\s\S]?|[^"\\])*"?|\|\||[\s\S]/g;

/**
 * Where each top-level `||` of an and-or list starts: outside quotes and
 * outside `( … )`, `{ … }` and `$( … )`, whose own `||` handle their own
 * commands, and outside `${ … }`, whose `||` is text. A `)` with nothing
 * open (a `case` arm's) closes nothing.
 */
export const handlerStarts = (list: string): number[] => {
  const starts: number[] = [];
  let depth = 0;
  for (const { 0: piece, index } of list.matchAll(LIST_PIECE)) {
    if (piece === '(' || piece === '{') depth += 1;
    else if ((piece === ')' || piece === '}') && depth > 0) depth -= 1;
    else if (piece === '||' && depth === 0) starts.push(index);
  }
  return starts;
};

/**
 * Whether `exit STATUS` hands on a failure. A number must be non-zero, quoted
 * or not; `$?` is the gate's status only when nothing ran in between; a
 * variable counts when `before` (the handler up to the exit) sets it from
 * `$?` as its first command (`{ status=$?; echo failed; exit "$status"; }`).
 */
const failingStatus = (status: string, { before, lastIsGate }: { before?: string; lastIsGate: boolean }): boolean => {
  const bare = status.replace(/^(["'])(.*)\1$/, '$2');
  if (/^\d+$/.test(bare)) return !/^0+$/.test(bare);
  if (bare === '$?') return lastIsGate;
  const name = /^\$\{?(\w+)\}?$/.exec(bare)?.[1];
  if (name === undefined || before === undefined) return false;
  // The only assignment must be the handler's first command: `$?` is the
  // status of whatever ran last, so in `{ echo failed; status=$?; … }` it is
  // echo's 0, and `status=$?; status=0` exits 0 too.
  const assignments = [...before.matchAll(new RegExp(String.raw`(?:^|[\s;{])${name}=`, 'g'))];
  return assignments.length === 1 && new RegExp(String.raw`^\s*${name}=(["']?)\$\?\1(?:\s*;|\s|$)`).test(before);
};

/** The and-or list from the command that runs `gate` on, cut from the list's own text so its redirections stay as written. */
const fromGate = (list: string, gate: string): string => {
  let cursor = 0;
  for (const segment of splitSegmentsWithSeparators(list)) {
    const at = list.indexOf(segment.text, cursor);
    if (at < 0) return list;
    if (invokedAt(segment.text, gate)) return list.slice(at);
    cursor = at + segment.text.length;
  }
  return list;
};

/**
 * A `{ …; exit N; }` handler propagates when its exit hands on a failure and
 * the group ends its command: piped or backgrounded, it runs in a subshell.
 */
const braceHandlerPropagates = (list: string): boolean => {
  // A redirection may follow the status (`exit 1 >&2`), and a bare `exit`
  // hands on `$?`: the gate's own status when nothing ran before it.
  const group = new RegExp(String.raw`^\|\|\s*\{([^}]*)\b(?:exit|return)(?:\s+(${EXIT_STATUS}))?(?:\s+\d*[<>]{1,2}&?[^\s;}]+)*\s*;?\s*\}(?=\s*(?:$|;|&&|\|\||\)|\}|#))`);
  // The first handler that runs: past any `|| false`, which fails on.
  for (const at of handlerStarts(list)) {
    const rest = list.slice(at);
    if (/^\|\|\s*false\b/.test(rest)) continue;
    const match = group.exec(rest);
    if (match === null) return false;
    const before = match[1] as string;
    const status = match[2];
    // The exit must be a command of its own, first in the group or after a
    // `;` that ends a list. In `{ echo exit 1; }` it is echo's argument, in
    // `{ false && exit 1; }` a condition can skip it, and `{ echo | exit 1; }`
    // exits a pipeline subshell.
    if (!/(?:^|;)\s*$/.test(before)) return false;
    return failingStatus(status ?? '$?', { before, lastIsGate: before.trim() === '' });
  }
  return false;
};

/**
 * Whether `command` is invoked here, at a command position (line start, or
 * after `$(`, `(`, `{`, a pipe, `&&`, `;`, `then`, `do` or `if`, optionally
 * negated with `!`), not merely named in an argument: `grep -n "eslint ."`
 * searches for the string. Runners that forward to the
 * real command count (`npx`, `pnpm exec`, `bash script.sh`), as do
 * `NAME=value` prefixes and any relative directory before the command.
 */
const invokedAt = (line: string, command: string): boolean => {
  // The whole command must appear (`prettier --check`, not any prettier).
  if (!line.includes(command)) return false;
  const head = command.split(' ')[0] as string;
  const escaped = head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const RUNNER = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*` + String.raw`(?:(?:npx|pnpm|npm|yarn|bunx|exec|run|--yes|-y|dlx|bash|sh|zsh)\s+)*` + String.raw`(?:[\w.-]+/)*`;
  // `!` is a command position only directly after a real separator: alone it
  // also matched a `!` used as an argument (`grep ! file eslint`).
  const pattern = new RegExp(`(^|\\$\\(|\\(|\\{|\\||&&|;|\\bthen\\b|\\bdo\\b|\\bif\\b)\\s*!?\\s*${RUNNER}${escaped}(\\s|$)`);
  // A quoted occurrence is an argument, not an invocation.
  return pattern.test(withoutQuotedText(line));
};

const SHELL = /^(?:ba|z|da)?sh$/;

/** Words that precede a command without being it. `(` and `{` need no entry: `fromCommand` strips them from the word they open. */
const LEADING = new Set(['if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', 'time', 'command', 'exec', 'builtin', 'nohup', 'env']);

/** A segment's words from its command word on, quotes removed. */
const fromCommand = (segment: string): ShellToken[] => {
  const tokens = tokenize(segment)
    // `(eval …)`: the command starts inside the opener.
    .map((token) => (token.quoted ? token : { ...token, value: token.value.replace(/^[({]+/, '') }))
    .filter((token) => token.quoted || token.value !== '');
  const start = tokens.findIndex((token) => token.quoted || !(LEADING.has(token.value) || /^[A-Za-z_]\w*=/.test(token.value)));
  return start < 0 ? [] : tokens.slice(start);
};

/** A command word without its directory: `/bin/sh` is `sh`. */
const commandName = (word: ShellToken): string => word.value.replace(/^.*\//, '');

/**
 * The scripts this command runs as shell text, or 'stdin' for a shell that
 * reads its program from a pipe. `eval` runs its arguments joined by spaces;
 * `sh -c` runs its first operand only (later ones are `$0`, `$1`); a shell
 * given a file runs committed code this check reads on its own.
 */
const scriptsOf = (words: readonly ShellToken[]): string[] | 'stdin' => {
  const [head, ...rest] = words;
  // A quoted command word still names the command: `'eval' …` runs eval.
  if (head === undefined) return [];
  const name = commandName(head);
  if (name === 'eval') return [rest.map((word) => word.value).join(' ')];
  if (!SHELL.test(name)) return [];
  let command = false;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] as ShellToken;
    if (!word.quoted && /^[-+]o$/.test(word.value)) {
      index += 1; // `-o pipefail`: the option's value is no operand
      continue;
    }
    if (!word.quoted && /^[-+][a-zA-Z]+$/.test(word.value)) {
      if (word.value.startsWith('-') && word.value.includes('c')) command = true;
      continue;
    }
    // The first operand: the program under -c, otherwise a script file.
    return command ? [word.value] : [];
  }
  return command ? [] : 'stdin';
};

/** The value of digits a pattern already matched in base `radix`. */
const digitsValue = (digits: string, radix: 8 | 16): number => {
  let value = 0;
  for (const digit of digits.toLowerCase()) value = value * radix + '0123456789abcdef'.indexOf(digit);
  return value;
};

/** The named escapes printf decodes in its format and in a `%b` argument. */
const PRINTF_NAMED: Readonly<Record<string, string>> = {
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
};

/**
 * printf's backslash escapes as bash decodes them. Both places decode the
 * named escapes, `\xH`/`\xHH`, `\uHHHH` and `\UHHHHHHHH`, keeping the
 * backslash of any other. In the format octal is one to three digits
 * (`\0101` is `\010` then `1`) and `\"`, `\'`, `\?` drop theirs; in a `%b`
 * argument octal is `\0` and up to three digits or `\NNN`, those three keep
 * theirs, and `\c` ends all output.
 */
const printfEscapes = (text: string, where: 'format' | 'argument'): { text: string; stop: boolean } => {
  const octal = where === 'format' ? '[0-7]{1,3}' : '0[0-7]{0,3}|[1-7][0-7]{0,2}';
  const escape = new RegExp(String.raw`\\(?:x([\da-fA-F]{1,2})|u([\da-fA-F]{1,4})|U([\da-fA-F]{1,8})|(${octal})|([^]))`, 'g');
  let out = '';
  let last = 0;
  for (const match of text.matchAll(escape)) {
    out += text.slice(last, match.index);
    last = match.index + match[0].length;
    const hex = match[1] ?? match[2] ?? match[3];
    const char = match[5];
    if (where === 'argument' && char === 'c') return { text: out, stop: true };
    if (hex !== undefined) {
      const code = digitsValue(hex, 16);
      // Past Unicode bash writes no character; keep the escape as written.
      out += code > 0x10ffff ? match[0] : String.fromCodePoint(code);
    } else if (char === undefined) {
      // Bash keeps the low eight bits: `\455` is `-`.
      out += String.fromCharCode(digitsValue(match[4] as string, 8) & 0xff);
    } else {
      out += PRINTF_NAMED[char] ?? (where === 'format' && `"'?`.includes(char) ? char : match[0]);
    }
  }
  return { text: out + text.slice(last), stop: false };
};

/**
 * What `printf FORMAT ARGS…` writes, for `%s`, `%b` and `%%` with every
 * escape decoded; null for any other directive, which the caller reads word
 * by word instead. The format is reused while arguments remain, as printf
 * does, and a `\c` in a `%b` argument ends the output there.
 */
export const renderPrintf = (words: readonly string[]): string | null => {
  const [format, ...args] = words[0] === '--' ? words.slice(1) : words;
  // No format: printf fails and writes nothing a shell could run.
  if (format === undefined) return null;
  // Text and directives alternate; text with any other `%` is a directive
  // this reader does not render. An escape writes `%` (`\045`) as text.
  const pieces = format.split(/(%[sb%])/);
  if (pieces.some((piece, index) => index % 2 === 0 && piece.includes('%'))) return null;
  let rest = [...args];
  let out = '';
  for (;;) {
    let used = 0;
    for (const piece of pieces) {
      if (piece === '%%') out += '%';
      else if (piece === '%s') {
        out += rest[used] ?? '';
        used += 1;
      } else if (piece === '%b') {
        const value = printfEscapes(rest[used] ?? '', 'argument');
        used += 1;
        out += value.text;
        if (value.stop) return out;
      } else out += printfEscapes(piece, 'format').text;
    }
    rest = rest.slice(used);
    if (used === 0 || rest.length === 0) break;
  }
  return out;
};

/**
 * What `echo WORDS…` writes: its words after any `-n`/`-e`/`-E` options,
 * joined, then the same text with `-e`'s escapes decoded. Both are read,
 * since `sh`'s own echo (dash, or bash under xpg_echo) decodes them unasked.
 */
const renderEcho = (words: readonly string[]): string => {
  const text = words.join(' ').replace(/^(?:-[neE]+(?: |$))*/, '');
  return `${text}\n${printfEscapes(text, 'argument').text}`;
};

/**
 * The line, plus every script in it that a shell will run: the argument of
 * `eval`, of `bash -c`, or what `echo`/`printf` pipes straight into a stdin
 * shell. Only an `eval` or shell at a command position counts: `echo eval
 * 'eslint . || true'` prints its text and runs nothing. Any other stage
 * piped into a shell (`grep -v eslint`, `sed`, `cat file`) transforms or
 * reads text this check cannot see, so nothing is read for it.
 */
export const executedTexts = (line: string, depth = 0): string[] => {
  if (depth > 3) return [line];
  const segments = splitSegmentsWithSeparators(line);
  const scripts = segments.flatMap((segment, index) => {
    const run = scriptsOf(fromCommand(segment.text));
    if (run !== 'stdin') return run;
    const source = index === 0 ? undefined : segments[index - 1];
    if (source === undefined || source.next !== '|') return [];
    const [head, ...words] = fromCommand(source.text);
    if (head === undefined) return [];
    const name = commandName(head);
    if (!['echo', 'printf'].includes(name)) return [];
    // What the stage writes is the program: printf fills its format (reused
    // while arguments remain), echo joins its words. A printf format this
    // reader cannot render falls back to each quoted word as a program.
    // Each line written is a program; a blank one runs nothing.
    const values = words.map((token) => token.value);
    const written = name === 'printf' ? renderPrintf(values) : renderEcho(values);
    if (written !== null) return written.split('\n');
    return words.filter((token) => token.quoted).map((token) => token.value);
  });
  // A substitution's body is judged as part of the line (so a capture the
  // line then branches on stays exempt), but the scripts it hands a shell run
  // too: `echo $(printf … | sh)` and `x=$(sh -c '…')`.
  const nested = substitutionBodies(line)
    .filter((body) => body !== line)
    .flatMap((body) => executedTexts(body, depth + 1).slice(1));
  return [line, ...scripts.flatMap((text) => executedTexts(text, depth + 1)), ...nested];
};

/** One shell command, with the physical line it starts on. */
interface LogicalLine {
  readonly text: string;
  readonly line: number;
}

/**
 * Backslash-continued lines joined into the single command they are. The
 * marker is dropped and the pieces joined with a space, so `cmd \` +
 * `  || true` becomes `cmd || true`; the line number is the first physical
 * line's, where a reader looks for the command reported.
 */
export const foldContinuations = (lines: readonly string[]): readonly LogicalLine[] => {
  const folded: LogicalLine[] = [];
  let pending: string | null = null;
  let start = 0;
  lines.forEach((raw, index) => {
    const continues = /\\\s*$/.test(raw);
    const body = continues ? raw.replace(/\\\s*$/, '') : raw;
    if (pending === null) {
      pending = body;
      start = index + 1;
    } else {
      pending = `${pending} ${body.trim()}`;
    }
    if (!continues) {
      folded.push({ text: pending, line: start });
      pending = null;
    }
  });
  // A file ending mid-continuation still has a command worth checking.
  if (pending !== null) folded.push({ text: pending, line: start });
  return folded;
};

/**
 * `VAR=$(gate ... || true)` moves the verdict into the variable, which the
 * script then branches on: a wrapper that captures a linter's output and
 * inspects it. Not a masked exit, but only if a later line reads the value to
 * decide with; a capture nothing reads discards the verdict as `|| true` does.
 */
const isCaptureThenBranch = (line: string, later: readonly string[]): boolean => {
  const capture = /^\s*([A-Za-z_][A-Za-z0-9_]*)=\$\(/.exec(line);
  if (capture === null) return false;
  const referenced = new RegExp(`\\$\\{?${capture[1] as string}\\b`);
  const decides = /\bif\b|\bcase\b|\btest\b|\[|\]|&&|\|\||\bexit\b|\breturn\b/;
  return later.some((next) => referenced.test(next) && decides.test(next));
};

/** Whether `path` runs under pipefail, so shape 3 holds it: the config's `pipefailScope`. */
export const isPipefailScoped = (path: string, config: MaskedConfig = DEFAULT_MASKED_CONFIG): boolean => config.pipefailScope.some((scope) => scope.test(path));

/**
 * Bash writes `echo`/`printf` output one line per write. A reader that stops
 * at its first match exits while lines are still coming; the next write gets
 * EPIPE, pipefail takes the writer's status, and `if` reads "no match". The
 * pipe buffer is no protection: a list past 64 KB misses on every call.
 */
const VARIABLE_FEED = /\b(?:echo|printf)\b[^|;&]*\$[^|;&]*\|(?!\|)\s*(grep|head)\b([^|;&)]*)/;

/** grep's long options that stop reading early, with or without `=value`. */
const EARLY_EXIT_LONG = /^--(?:quiet|silent|max-count|files-with(?:out)?-match(?:es)?)(?:=|$)/;

/** Options whose value is the next token when not attached (`-e PAT`). */
const VALUE_LONG = /^--(?:regexp|file|max-count|context|after-context|before-context)$/;

/**
 * Whether this grep stops at its first match. Options are read the way GNU
 * grep permutes them, so `grep a --quiet` counts, but an option's value is
 * skipped: `grep -e -missing` has the pattern `-missing`, not `-m`.
 */
const grepStopsEarly = (args: string): boolean => {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === '--') return false;
    if (token.startsWith('--')) {
      if (EARLY_EXIT_LONG.test(token)) return true;
      if (VALUE_LONG.test(token)) index += 1;
      continue;
    }
    if (!token.startsWith('-')) continue;
    // A cluster's flags run up to its first value-taking flag; what follows
    // is that flag's value (`-emissing`), or, when nothing does, the next
    // token is (`-e -missing`). A lone `-` (stdin) has no flags at all.
    const flags = token.slice(1);
    const valueFlag = flags.search(/[efABC]/);
    const own = valueFlag < 0 ? flags : flags.slice(0, valueFlag);
    if (/[qmlL]/.test(own)) return true;
    if (valueFlag >= 0 && valueFlag === flags.length - 1) index += 1;
  }
  return false;
};

/**
 * `gate || rc=$?` saves the gate's failing status for a later line to decide
 * with: `if [ "$rc" -ne 0 ]; then exit "$rc"; fi`. Exempt only when a later
 * line reads it and exits with the failure, and only on failure: under
 * `[ "$rc" -ne 0 ]` (then, `&&`), or after `[ "$rc" -eq 0 ] ||` / in the
 * `else` of an `-eq 0` test. `exit 0`, a bare `exit` and `echo "$rc"` carry
 * on; any other condition (`(( rc ))`, a `case`) is not read, and reports;
 * a reassignment of the variable ends the search.
 */
const savesStatusThenBranches = (list: string, later: readonly string[]): boolean => {
  const handler = firstHandler(list);
  if (handler === undefined) return false;
  const saved = /^\|\|\s*([A-Za-z_]\w*)=(["']?)\$[?]\2\s*(?:;\s*)?$/.exec(handler);
  if (saved === null) return false;
  const name = saved[1] as string;
  const referenced = new RegExp(`\\$\\{?${name}\\b`);
  const reassigned = new RegExp(`(?:^|[\\s;&|])${name}=`);
  const failing = new RegExp(`\\b(?:exit|return)\\s+(?:["']?\\$\\{?${name}\\b|["']?0*[1-9]\\d*["']?(?![\\w$]))`);
  const operand = String.raw`["']?\$\{?${name}[^\s"'\]]*["']?\s*`;
  const zero = String.raw`\s*["']?0["']?(?![\w$])`;
  const failureTest = new RegExp(`${operand}(?:-ne|-gt|!=)${zero}`);
  const successTest = new RegExp(`${operand}(?:-eq|==?)${zero}`);
  const blockEnd = /(?:^|[\s;])(?:fi|esac)\b/;
  /** Whether this one line exits with the failure, and only on failure. */
  const exitsOnFailure = (text: string): boolean => {
    const at = failing.exec(text)?.index;
    if (at === undefined) return false;
    const head = text.slice(0, at);
    if (!failureTest.test(head) && !successTest.test(head)) {
      // No test of the status: the exit is unconditional, or under a
      // condition this reader does not judge.
      return !/\bif\b|&&|\|\||\bcase\b/.test(head);
    }
    if (/\bif\b/.test(head)) return failureTest.test(head) ? /\bthen\b/.test(head) && !/\belse\b/.test(head) : /\belse\b/.test(head);
    const operator = /(&&|\|\|)\s*$/.exec(head)?.[1];
    return failureTest.test(head) ? operator === '&&' : operator === '||';
  };
  for (const [index, reader] of later.entries()) {
    if (reassigned.test(reader)) return false;
    if (!referenced.test(reader)) continue;
    if (exitsOnFailure(reader)) return true;
    if (!/\bif\b/.test(reader) || blockEnd.test(reader)) continue;
    // A multi-line `if`: the failing branch is `then` under a failure test,
    // `else` under a success test.
    const onFailure = failureTest.test(reader) ? 'then' : successTest.test(reader) ? 'else' : null;
    if (onFailure === null) continue;
    let branch = 'then';
    for (const next of later.slice(index + 1)) {
      if (/^\s*(?:else|elif)\b/.test(next)) branch = 'else';
      else if (branch === onFailure && failing.test(next)) return true;
      if (reassigned.test(next)) return false;
      if (blockEnd.test(next)) break;
    }
  }
  return false;
};

const isEarlyExitFeed = (line: string): boolean => {
  const feed = VARIABLE_FEED.exec(withoutQuotedText(line));
  if (feed === null) return false;
  return feed[1] === 'head' || grepStopsEarly(feed[2] as string);
};

/**
 * Quoted text collapsed so a `|` inside a pattern is not read as a pipe: a
 * double-quoted string becomes `"$"` when it expands something and `""` when
 * not, a single-quoted one `''`, and an escaped character (`\$`, `\|`,
 * literal in shell) `_`.
 */
export const withoutQuotedText = (line: string): string =>
  line.replace(/"((?:[^"\\]|\\.)*)"|'[^']*'|\\./g, (match: string, inner?: string) => {
    if (inner === undefined) return match.startsWith('\\') ? '_' : "''";
    const expands = inner.split(/\\./).some((part) => part.includes('$'));
    return expands ? '"$"' : '""';
  });

const findEarlyExitFeeds = (relative: string, logical: readonly LogicalLine[], config: MaskedConfig): MaskedExit[] => {
  if (!isPipefailScoped(relative, config)) return [];
  return logical
    .filter(({ text }) => !text.trim().startsWith('#'))
    .filter(({ text }) => isEarlyExitFeed(text))
    .map(({ text, line }) => ({
      file: relative,
      line,
      snippet: text.trim(),
      reason: 'a variable piped into a reader that stops early: under pipefail the writer can hit EPIPE after the match, and the check reads it as a miss. Feed it a here-string: `grep -q … <<<"$VAR"`',
    }));
};

/**
 * Reads one file's text, or null when the file is confirmed absent. Any other
 * failure throws: a read that cannot happen is not a file with no findings.
 */
export type SourceReader = (root: string, relative: string) => string | null;

/** Absent only on ENOENT; ENOTDIR, EACCES, EISDIR and the rest throw. */
export const readWorkingTree: SourceReader = (root, relative) => {
  try {
    return readFileSync(join(root, relative), 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

/**
 * The blob the commit will record. Pre-commit must judge this, not the
 * working tree: a clean unstaged edit would otherwise hide the staged one.
 * Absent only when the index has no entry; a failing `git show` throws.
 * `env` defaults to the process's own, which carries `GIT_INDEX_FILE` for a
 * partial commit.
 */
export const stagedReader = (env: NodeJS.ProcessEnv = process.env): SourceReader => {
  const git = (root: string, args: readonly string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return (root, relative) => {
    if (git(root, ['ls-files', '--cached', '-z', '--', relative]) === '') return null;
    return git(root, ['show', `:${relative}`]);
  };
};

/** `--staged` judges the index; otherwise, the working tree. */
export const readerFor = (staged: boolean): SourceReader => (staged ? stagedReader() : readWorkingTree);

/** Every masked exit in `files` (paths under `root`), each file read with `read`. */
export const findMaskedExits = (root: string, files: readonly string[], read: SourceReader = readWorkingTree, config: MaskedConfig = DEFAULT_MASKED_CONFIG): MaskedExit[] => {
  const problems: MaskedExit[] = [];
  for (const relative of files) {
    const source = read(root, relative);
    if (source === null) continue; // deleted between listing and reading
    const lines = source.split('\n');
    // Logical lines, not physical ones: a trailing `\` puts a mask on the
    // next physical line while leaving it the same shell command.
    const logical = foldContinuations(lines);
    problems.push(...findEarlyExitFeeds(relative, logical, config));

    const maskedGate = (line: string, lineNumber: number, gate: string, later: readonly string[]): boolean => {
      // The and-or lists that run the gate, from the gate on: its handlers
      // live there, and an unrelated list's `|| exit 1` or `|| true` says
      // nothing about it. In `grep -q x f || eslint .` the `||` runs eslint
      // as the fallback, and eslint's own failure is still the list's.
      const own = splitAndOrLists(line)
        .filter((list) => invokedAt(list, gate))
        .map((list) => fromGate(list, gate))
        .filter((list) => !savesStatusThenBranches(list, later));
      // `|| true` on a gate discards its verdict outright, as the handler a
      // failure reaches, not inside a handler's own group.
      if (
        own.some((list) => {
          const handler = firstHandler(list);
          return handler !== undefined && /^\|\|\s*true\b/.test(handler);
        })
      ) {
        problems.push({ file: relative, line: lineNumber, snippet: line.trim(), reason: `\`${gate}\` is a gate, but \`|| true\` discards its exit status — the check reports success whatever it found` });
        return true;
      }
      // `gate || <handler>` where the handler neither exits nor returns
      // non-zero carries on as if the gate passed: `|| echo failed`, `|| :`,
      // and `|| exit 1 | cat`, whose exit runs in a pipeline subshell.
      if (own.some((list) => /\|\|/.test(list) && !propagatesFailure(list) && !braceHandlerPropagates(list))) {
        problems.push({ file: relative, line: lineNumber, snippet: line.trim(), reason: `\`${gate}\` fails into an \`||\` handler that does not exit non-zero — the script carries on as if it passed` });
        return true;
      }
      // `cmd 2>/dev/null` with no status branch hides the failure reason and,
      // with `set +e`, the failure itself. `|| exit 1` (or a bare `exit`)
      // propagates the failure and is no mask; `|| exit 0` forces success and
      // is; `|| false` checks nothing without `set -e`.
      if (!/\$\?/.test(line) && !/if\s/.test(line) && own.some((list) => /2>\s*\/dev\/null/.test(list) && !propagatesFailure(list, { falseKeeps: false }))) {
        problems.push({ file: relative, line: lineNumber, snippet: line.trim(), reason: `\`${gate}\` has its stderr discarded and its status unchecked — a crash is indistinguishable from a pass` });
        return true;
      }
      return false;
    };

    const maskOn = (line: string, lineNumber: number, index: number): boolean => {
      // Every gate on the line is judged: `eslint . || exit 1; tsc || true`
      // still masks tsc.
      const gates = config.gateCommands.filter((command) => invokedAt(line, command));
      if (gates.length === 0) return false;
      const later = logical.slice(index + 1).map((entry) => entry.text);
      // The verdict survives in a variable the script goes on to test.
      if (isCaptureThenBranch(line, later)) return false;
      return gates.some((gate) => maskedGate(line, lineNumber, gate, later));
    };

    logical.forEach(({ text: whole, line: lineNumber }, index) => {
      // Only a comment is skipped whole: `echo start; eslint . || true`
      // masks its gate, and `invokedAt` already refuses a gate that is only
      // echo's argument.
      if (whole.trim().startsWith('#')) return;
      // The line as written, then any quoted script it runs; one report each.
      for (const line of executedTexts(whole)) {
        if (maskOn(line, lineNumber, index)) return;
      }
    });

    // An `exit 0` on the line after a gate, with nothing branching on the
    // result: the script always succeeds, whatever the gate decided.
    lines.forEach((line, index) => {
      if (!/^\s*exit\s+0\s*$/.test(line)) return;
      for (let back = index - 1; back >= 0 && back >= index - 4; back--) {
        const previous = lines[back] as string;
        if (previous.trim() === '' || isCommentary(previous)) continue;
        // A bare `STATUS=$?` records the status without acting on it, so the
        // gate above it is still the thing being masked.
        if (/^\s*\w+=\$\?\s*$/.test(previous)) continue;
        const gate = config.gateCommands.find((command) => invokedAt(previous, command));
        if (gate !== undefined && !/\|\||&&|if\s|\$\?|exit\s+1/.test(previous)) {
          problems.push({
            file: relative,
            line: index + 1,
            snippet: `${previous.trim()}  →  ${line.trim()}`,
            reason: `unconditional \`exit 0\` right after \`${gate}\` — the script always succeeds, whatever the gate decided`,
          });
        }
        break;
      }
    });
  }
  return problems;
};

/** The report and exit code for `problems` among `scanned` files: 0 clean, 1 masked exits or no files. */
export const formatMasked = (problems: readonly MaskedExit[], scanned: number, id: string): { ok: boolean; out: string[]; err: string[] } => {
  if (scanned === 0) {
    // Fail closed: finding no shell files at all means the lookup broke, not
    // that the repository has none.
    return { ok: false, out: [], err: [`❌ ${id}: no shell files found — the file lookup failed`] };
  }
  if (problems.length > 0) {
    const err = [`\n❌ ${id}: ${String(problems.length)} masked exit code(s)\n`];
    for (const p of problems) err.push(` ${p.file}:${String(p.line)}`, `   ${p.snippet}`, `   ${p.reason}\n`);
    err.push('A gate that cannot fail is not a gate. Branch on the status, or drop the check.\n');
    return { ok: false, out: [], err };
  }
  return { ok: true, out: [`✅ ${id}: no masked exit codes (${String(scanned)} shell file(s) scanned)`], err: [] };
};
