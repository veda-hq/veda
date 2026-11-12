// Shell portability and pitfall rules: each a construct that works on the
// author's machine and fails elsewhere or on unusual input. The classic is
// `grep -E "lines:\s*[0-9]+"`: `\s` is not POSIX ERE, so BSD grep on macOS
// matches nothing and the gate behind it falls back to its defaults.
//
// Every rule is line-oriented over code with comments and heredoc bodies
// removed (shell-text.ts). The rules, and what each deliberately leaves alone:
//
//   grep-ere-perl-class    grep -E / egrep pattern using \s \S \d \D
//                          (not -F, -P, or sed)
//   xargs-gnu-flag         xargs -d / -r / --delimiter / --no-run-if-empty
//   xargs-no-null          xargs without -0 fed by a file list (git diff,
//                          ls-files, find, grep -l, a *FILES/*PATHS variable);
//                          a bare `| xargs` used to trim is left alone
//   missing-double-dash    file operands reach grep (or rm/cat/sed/...) after
//                          xargs, or grep gets a list expansion, with no `--`
//                          (a quoted scalar such as "$CONFIG" is left alone)
//   process-substitution-in-validator
//                          <(...) in a file the config's `validatorPaths`
//                          match: needs /dev/fd and hides the inner command's
//                          status
//   fixed-tmp-path         a literal /tmp/<name> path (use mktemp)
//   machine-local-literal  /opt/homebrew or /Users/ literals not guarded by an
//                          existence test, a literal `-avd <name>`, or a
//                          personal "<name>'s iPhone" device
//   nvm-dir-no-default     NVM_DIR assigned, or $HOME/.nvm used, without
//                          honouring an existing ${NVM_DIR:-...}
//   lockf-without-k        lockf without -k deletes the lock path on exit
//   octal-arithmetic       $(( ... )) over a value from `read` or `date`
//                          without 10#: 08 and 09 are invalid octal
//   dirname-dollar0-beside-bash-source
//                          dirname "$0" in a file that also resolves itself
//                          through BASH_SOURCE
//   worktree-list-no-porcelain
//                          `git worktree list` parsed without --porcelain
//   grep-json-key          grep -o over a "key": pattern (parse JSON with node
//                          or jq)
import type { ShellFinding, ShellSource } from './shell-sources.ts';
import { codeLines, type CodeLine, commandPositions, maskQuoted, messageView, words } from './shell-text.ts';

export interface PitfallsConfig {
  /** What a finding's check column says. */
  readonly id: string;
  /** Regexes over a path: the validators, where process substitution is refused. */
  readonly validatorPaths: readonly RegExp[];
}

type Rule = (line: CodeLine, context: FileContext) => string | null;

interface FileContext {
  readonly path: string;
  readonly lines: readonly CodeLine[];
  readonly usesBashSource: boolean;
  readonly octalVariables: ReadonlySet<string>;
  readonly validatorPaths: readonly RegExp[];
}

const unquote = (word: string): string => word.replace(/^(['"])([\s\S]*)\1$/, '$2');

/** Long options (GNU and BSD grep) whose value may be the next word. */
const GREP_LONG_WITH_VALUE = /^--(?:include|exclude|exclude-dir|exclude-from|max-count|after-context|before-context|context|label|binary-files|devices|directories|group-separator)$/;

/** Short-option letters of a grep invocation, and its non-option operands. */
const parseGrep = (
  args: readonly string[],
): {
  /** Short-option letters, one per entry: `-oE` gives `o`, `E`. */
  letters: string[];
  long: string[];
  operands: string[];
  /** How many operands came before `--` (all of them when there is none). */
  beforeDash: number;
  patternGiven: boolean;
  /** Inline patterns given with -e / --regexp (a -f file holds no inline text). */
  patterns: string[];
} => {
  const letters: string[] = [];
  const long: string[] = [];
  const operands: string[] = [];
  const patterns: string[] = [];
  let doubleDash = false;
  let beforeDash = -1;
  let patternGiven = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as string;
    // An option's value is the word after it: none past the last word.
    const nextWord = args.slice(index + 1, index + 2);
    const longPattern = /^--(regexp|file)(?:=([\s\S]*))?$/.exec(word);
    if (doubleDash) {
      operands.push(word);
    } else if (word === '--') {
      doubleDash = true;
      beforeDash = operands.length;
    } else if (longPattern !== null) {
      // `--regexp X`, `--regexp=X`, `--file F`, `--file=F`.
      long.push(word);
      patternGiven = true;
      const attached = longPattern[2];
      if (longPattern[1] === 'regexp') patterns.push(...(attached === undefined ? nextWord : [attached]));
      if (attached === undefined) index += 1;
    } else if (word.startsWith('--')) {
      long.push(word);
      // `--include '*.sh'`: the next word is the option's value.
      if (GREP_LONG_WITH_VALUE.test(word)) index += 1;
    } else if (/^-[A-Za-z]/.test(word)) {
      for (const [at, letter] of [...word.slice(1)].entries()) {
        letters.push(letter);
        if ('efmABCD'.includes(letter)) {
          // What follows the letter in `word`, past its leading `-`.
          const attached = word.slice(at + 2);
          if (letter === 'e' || letter === 'f') patternGiven = true;
          if (letter === 'e') patterns.push(...(attached === '' ? nextWord : [attached]));
          if (attached === '') index += 1;
          break;
        }
      }
    } else if (/^[<>]|^\d?[<>]/.test(word)) {
      if (/^\d?[<>]{1,2}$/.test(word)) index += 1;
    } else {
      operands.push(word);
    }
  }
  return { letters, long, operands, beforeDash: beforeDash === -1 ? operands.length : beforeDash, patternGiven, patterns };
};

/**
 * The value the shell passes for a word: single-quoted text as is, double
 * quotes (and locale `$"…"`) dropping only the backslash before `$`, backtick,
 * `"`, `\`, and an unquoted backslash dropped before any character. (A lone
 * trailing backslash is dropped too; it cannot start a `\s` class.)
 *
 * ANSI-C `$'…'` text decodes only `\\` to `\`. That is exact for the class
 * this value is judged by: bash keeps an unknown escape (`\s`, `\d`) as
 * written, and every other one it decodes (`\n`, `\'`, `\"`, `\?`) leaves a
 * character that is not s, S, d or D where its backslash stood, so no run of
 * backslashes before s/d changes. Octal, hex and `\c` escapes, which can spell
 * a backslash, are read as written.
 */
const shellValue = (word: string): string =>
  word.replace(
    /\$'((?:\\[\s\S]|[^'\\])*)'?|'([^']*)'?|\$?"((?:\\[\s\S]|[^"\\])*)"?|\\([\s\S]?)/g,
    (_whole: string, ansiC?: string, single?: string, double?: string, escaped?: string) => (ansiC ?? '').replace(/\\\\/g, '\\') + (single ?? '') + (double ?? '').replace(/\\([$`"\\])/g, '$1') + (escaped ?? ''),
  );

const grepEre: Rule = (line) => {
  for (const command of ['grep', 'egrep']) {
    for (const at of commandPositions(line.code, command)) {
      const grep = parseGrep(words(line.code.slice(at)));
      const extended = command === 'egrep' || grep.letters.includes('E') || grep.long.includes('--extended-regexp');
      if (!extended || grep.letters.includes('F') || grep.letters.includes('P')) continue;
      // Only pattern text: with -e/-f every operand is a file, never a regex.
      // Each -e pattern is its own regex.
      const patterns = grep.patternGiven ? grep.patterns : grep.operands.slice(0, 1);
      // On the regex grep receives, after the shell removes quoting: an odd
      // run of backslashes before s/d is a class; `'\\s'` is a literal `\s`.
      if (patterns.some((pattern) => /(?:^|[^\\])(?:\\\\)*\\[sSdD]/.test(shellValue(pattern)))) {
        return 'grep -E pattern uses \\s/\\d, which POSIX ERE and BSD grep do not define; use [[:space:]] or [0-9]';
      }
    }
  }
  return null;
};

/** xargs short options that take a value (GNU and BSD). */
const XARGS_WITH_VALUE = 'nILPsEJdR';

/**
 * xargs option words, the command word index after them, and the
 * replacement string `-I`/`-J` names, if any. A cluster (`-0n 1`) takes its
 * value from the next word when the value letter ends it.
 */
const parseXargs = (args: readonly string[]): { options: string[]; command: number; replace: string | undefined } => {
  const options: string[] = [];
  let replace: string | undefined;
  let index = 0;
  while (index < args.length && (args[index] as string).startsWith('-')) {
    const word = args[index] as string;
    options.push(word);
    index += 1;
    if (word === '--') break;
    if (word.startsWith('--')) continue;
    const cluster = word.slice(1);
    const at = [...cluster].findIndex((letter) => XARGS_WITH_VALUE.includes(letter));
    if (at === -1) continue;
    const attached = cluster.slice(at + 1);
    const value = attached === '' ? args[index] : attached;
    if (attached === '') index += 1;
    if ((cluster[at] === 'I' || cluster[at] === 'J') && value !== undefined) replace = unquote(value);
  }
  return { options, command: index, replace };
};

const xargsGnuFlags = (options: readonly string[]): boolean =>
  options.some((word) => {
    if (/^--(?:delimiter|no-run-if-empty)\b/.test(word)) return true;
    if (!/^-[A-Za-z0-9]/.test(word)) return false;
    for (const letter of word.slice(1)) {
      if (letter === 'd' || letter === 'r') return true;
      if (XARGS_WITH_VALUE.includes(letter)) return false;
    }
    return false;
  });

const xargsGnu: Rule = (line) => {
  for (const at of commandPositions(line.code, 'xargs')) {
    const { options } = parseXargs(words(line.code.slice(at)));
    if (xargsGnuFlags(options)) return 'xargs -d/-r are GNU-only; BSD xargs on macOS rejects them (use -0 input, or a read loop)';
  }
  return null;
};

const FILE_LIST_SOURCE = /\bgit\s+(?:-C\s+\S+\s+)?(?:diff|ls-files|ls-tree|status)\b|\bfind\s|\bgrep\s+-[A-Za-z]*[lL]|\$\{?[A-Za-z0-9_]*(?:FILES|files|PATHS|paths)\b/;

const xargsNoNull: Rule = (line) => {
  for (const at of commandPositions(line.code, 'xargs')) {
    const args = words(line.code.slice(at));
    const { options, command } = parseXargs(args);
    if (command >= args.length) continue; // bare `| xargs` trims whitespace
    const nul = options.some((word) => word === '--null' || /^-[A-Za-z]*0/.test(word));
    if (nul) continue;
    if (FILE_LIST_SOURCE.test(line.code.slice(0, at))) return 'xargs splits a file list on blanks and quotes; feed it NUL-delimited paths (tr "\\n" "\\0" | xargs -0)';
  }
  return null;
};

const OPERAND_TAKERS = new Set(['grep', 'egrep', 'fgrep', 'rm', 'cat', 'wc', 'head', 'tail', 'sed', 'ls', 'mv', 'cp', 'chmod']);

/** A word that expands to several paths: array, unquoted variable, unquoted $(...). */
const listExpansion = (word: string): boolean => {
  if (/^"\$\{[A-Za-z_][A-Za-z0-9_]*\[[@*]\]\}"$/.test(word)) return true;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*(?:\[[@*]\])?\}?$/.test(word)) return true;
  return /^\$\([^)]*\)$/.test(word);
};

const missingDoubleDash: Rule = (line) => {
  for (const at of commandPositions(line.code, 'xargs')) {
    const args = words(line.code.slice(at));
    const { command, replace } = parseXargs(args);
    if (command >= args.length) continue; // xargs runs echo: no path operands
    const name = (args[command] as string).replace(/^.*\//, '');
    if (!OPERAND_TAKERS.has(name)) continue;
    const operands = args.slice(command + 1);
    const dash = operands.indexOf('--');
    // With `-I {}` the paths go where `{}` is, so `--` must come first:
    // `rm {} --` still reads a `-rf` path as an option.
    const firstPath = replace === undefined ? operands.length : operands.findIndex((word) => word.includes(replace));
    // `<=`: with `-I --` the separator itself is replaced by a path.
    if (dash === -1 || (firstPath !== -1 && firstPath <= dash)) return `xargs appends paths to ${name} with no \`--\`; a path starting with - becomes an option`;
  }
  for (const at of commandPositions(line.code, 'grep')) {
    const grep = parseGrep(words(line.code.slice(at)));
    // Only paths ahead of `--` can be read as options: a trailing `--`
    // (`grep x $FILES --`) protects nothing.
    const files = grep.operands.slice(grep.patternGiven ? 0 : 1, grep.beforeDash);
    if (files.some(listExpansion)) return 'grep gets a list of paths with no `--`; a path starting with - becomes an option';
  }
  return null;
};

const processSubstitution: Rule = (line, context) => {
  if (!context.validatorPaths.some((pattern) => pattern.test(context.path))) return null;
  return /<\(/.test(maskQuoted(line.code)) ? 'process substitution in a validator needs /dev/fd and hides the inner command status; use a here-string or temp file' : null;
};

/** Code as the shell sees it for literal checks: see {@link messageView}. */
const literalView = messageView;

/** A literal `/tmp/<name>` with no glob characters (a glob cleans up; it does not create). */
const TMP_LITERAL = String.raw`["']?\/tmp\/[A-Za-z0-9_.-]+(?![A-Za-z0-9_.*?[-])`;
const TMP_WRITERS = ['tee', 'touch', 'cat', 'rm', 'mkdir', 'cp', 'mv', 'ln', 'chmod'];

/**
 * Whether an `operator` found outside quoted text (matched on the masked
 * code, so `HELP="OUT=/tmp/x"` has none) is followed in `code` by `value`.
 */
const operatorThen = (code: string, operator: RegExp, value: RegExp): boolean => {
  for (const match of maskQuoted(code).matchAll(operator)) {
    const end = match.index + match[0].length;
    if (value.test(code.slice(end))) return true;
  }
  return false;
};

const ASSIGNED = /(?:^|[\s;&(])(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=/g;

/**
 * Only where the literal is used as a file: a redirection, an assignment, or
 * an operand of a file command. The same text inside test data or a message
 * names no file.
 */
const fixedTmp: Rule = (line) => {
  const code = literalView(line.code);
  const tmpValue = new RegExp(String.raw`^\s*${TMP_LITERAL}`);
  const used =
    operatorThen(code, /[0-9&]?>>?|</g, tmpValue) ||
    operatorThen(code, ASSIGNED, new RegExp(`^${TMP_LITERAL}`)) ||
    TMP_WRITERS.some((command) => commandPositions(code, command).some((at) => words(code.slice(at)).some((word) => new RegExp(`^${TMP_LITERAL}["']?$`).test(word))));
  return used ? 'fixed /tmp path: concurrent runs collide and another user can pre-create it; use mktemp' : null;
};

const machineLocal: Rule = (line, context) => {
  const code = literalView(line.code);
  if (/-avd\s+["']?[A-Za-z0-9_]/.test(code)) return 'literal emulator AVD name; take it from an environment variable or `emulator -list-avds`';
  if (/[A-Za-z]['’]s iPhone/.test(code)) return 'a personal device name; take the device from an argument or environment variable';
  for (const match of code.matchAll(/(?:\/opt\/homebrew|\/Users\/[A-Za-z])[^\s"':;)]*/g)) {
    const literal = match[0];
    // Both Homebrew prefixes handled, or the prefix derived, on this line.
    if (literal.startsWith('/opt/homebrew') && /\/usr\/local\b|brew\s+--prefix|HOMEBREW_PREFIX/.test(code)) continue;
    // Guarded: the literal, or a directory it lies under, was existence-tested
    // on this line or one of the three code lines before it. Counted in
    // logical lines, so comments and blank lines inside the guard are free.
    // Proximity, not control-flow scope.
    const at = context.lines.indexOf(line);
    const guarded = context.lines
      .slice(Math.max(0, at - 3), at + 1)
      .some((other) => [...other.code.matchAll(/-[dxef]\s+["']?(\/[^\s"';)\]]+)/g)].some((test) => literal === test[1] || literal.startsWith(`${(test[1] as string).replace(/\/$/, '')}/`)));
    if (!guarded) return `machine-local path ${literal}; derive it (brew --prefix, $HOME) or guard it with an existence test`;
  }
  return null;
};

const nvmDir: Rule = (line) => {
  // A help message quoting the fix is text, not an assignment.
  const code = literalView(line.code);
  if (operatorThen(code, /(?:^|[\s;&])(?:export\s+)?NVM_DIR=/g, /^(?!"?\$\{NVM_DIR:-)/)) return 'NVM_DIR overwritten; keep an existing value with ${NVM_DIR:-$HOME/.nvm}';
  if (/(?:\$HOME|\$\{HOME\}|~)\/\.nvm\b/.test(code) && !/\$\{?NVM_DIR\b/.test(code)) return '$HOME/.nvm assumed; honour a custom install with ${NVM_DIR:-$HOME/.nvm}';
  return null;
};

const lockf: Rule = (line) => {
  for (const at of commandPositions(line.code, 'lockf')) {
    const args = words(line.code.slice(at));
    const options: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const word = args[index] as string;
      if (!word.startsWith('-')) break;
      options.push(word);
      // `-t seconds` (alone or ending a cluster) takes the next word.
      if (/^-[A-Za-z]*t$/.test(word)) index += 1;
    }
    if (!options.some((word) => /^-[A-Za-z]*k/.test(word))) return 'lockf without -k removes the lock file on exit, so concurrent runs can lock different inodes';
  }
  return null;
};

const octalSources = (lines: readonly CodeLine[]): Set<string> => {
  const names = new Set<string>();
  for (const entry of lines) {
    for (const at of commandPositions(entry.code, 'read')) {
      // `-p prompt`, `-t 5`, ...: the option's value is no variable name.
      let optionValue = false;
      for (const word of words(entry.code.slice(at))) {
        if (optionValue) optionValue = false;
        else if (/^-[A-Za-z]*[pantdu]$/.test(word)) optionValue = true;
        else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) names.add(word);
      }
    }
    // A shell assignment `NAME="$(date …%d…)"`.
    const dated = /(?:^|[\s;&])([A-Za-z_][A-Za-z0-9_]*)="?(?:\$\(|`)\s*date\s+[^)`]*%[dHIjmMSUVWyCeklu]/.exec(entry.code);
    if (dated !== null) names.add(dated[1] as string);
  }
  return names;
};

/**
 * `code` as far as arithmetic is evaluated in it. Single-quoted and ANSI-C
 * `$'…'` text is removed: `'$((HOUR + 1))'` is printed, not evaluated.
 * Double-quoted `"$((HOUR + 1))"` is evaluated and stays, as do escaped
 * characters outside quotes (`\'` opens no quote). Inside double quotes only
 * `$((` opens arithmetic: escapes and a bare `((` are dropped, so `"\$((HOUR))"`
 * and `"((HOUR))"` print their text.
 */
const evaluatedText = (code: string): string =>
  // Two passes, each a plain rewrite: the first drops the printed quotes and
  // keeps the rest whole; the second rewrites what is left inside "…".
  code
    .replace(/(\\[\s\S]|"(?:\\[\s\S]|[^"\\])*"?)|\$'(?:\\[\s\S]|[^'\\])*'?|'[^']*'?/g, '$1')
    .replace(/(\\[\s\S])|"(?:\\[\s\S]|[^"\\])*"?/g, (double: string, escaped?: string) => escaped ?? double.replace(/\\[\s\S]|(\$\(\()|\(\(/g, '$1'));

const octalArithmetic: Rule = (line, context) => {
  if (context.octalVariables.size === 0) return null;
  for (const match of evaluatedText(line.code).matchAll(/\$?\(\(([^()]*(?:\([^()]*\)[^()]*)*)\)\)/g)) {
    const body = match[1] as string;
    for (const name of context.octalVariables) {
      const use = new RegExp(String.raw`(10#)?\$?\{?\b${name}\b`, 'g');
      for (const reference of body.matchAll(use)) {
        if (reference[1] === undefined) return `arithmetic on ${name} (read input or date) without 10#: 08 and 09 are invalid octal`;
      }
    }
  }
  return null;
};

const dirnameZero: Rule = (line, context) => {
  if (!context.usesBashSource) return null;
  // `dirname` where it runs (`$(dirname "$0")` included), never in quoted
  // text: `echo 'do not use dirname "$0"'` documents the pitfall.
  return commandPositions(line.code, 'dirname').some((end) => /^\s+"?\$(?:0|\{0\})"?(?=\s|$|[;&|)])/.test(line.code.slice(end)))
    ? 'dirname "$0" beside BASH_SOURCE: when the file is sourced $0 is the caller; use ${BASH_SOURCE[0]}'
    : null;
};

/** Only `git` at a command position: a message naming it runs nothing. */
const worktreeList: Rule = (line) => {
  const masked = maskQuoted(line.code);
  return commandPositions(line.code, 'git').some((at) => /^\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)\s+)?worktree\s+list\b(?![^|;&]*--porcelain)/.test(masked.slice(at)))
    ? '`git worktree list` output is for people; parse `git worktree list --porcelain`'
    : null;
};

const grepJson: Rule = (line) => {
  for (const at of commandPositions(line.code, 'grep')) {
    const args = words(line.code.slice(at));
    const grep = parseGrep(args);
    if (!grep.letters.includes('o')) continue;
    const jsonKey = /\\?"[A-Za-z_][A-Za-z0-9_]*\\?"(?:\s|\\s\*?|\[\[:space:\]\]\*?)*:/;
    if (args.some((word) => jsonKey.test(unquote(word)))) return 'grep -o over JSON keys breaks on reformatted or nested JSON; parse it with node or jq';
  }
  return null;
};

const RULES: ReadonlyArray<readonly [string, Rule]> = [
  ['grep-ere-perl-class', grepEre],
  ['xargs-gnu-flag', xargsGnu],
  ['xargs-no-null', xargsNoNull],
  ['missing-double-dash', missingDoubleDash],
  ['process-substitution-in-validator', processSubstitution],
  ['fixed-tmp-path', fixedTmp],
  ['machine-local-literal', machineLocal],
  ['nvm-dir-no-default', nvmDir],
  ['lockf-without-k', lockf],
  ['octal-arithmetic', octalArithmetic],
  ['dirname-dollar0-beside-bash-source', dirnameZero],
  ['worktree-list-no-porcelain', worktreeList],
  ['grep-json-key', grepJson],
];

export const PITFALL_RULES: readonly string[] = RULES.map(([id]) => id);

/** Runs every pitfall rule over shell `text` attributed to `path`. */
export const checkShellText = (path: string, text: string, config: PitfallsConfig): ShellFinding[] => {
  const lines = codeLines(text);
  const context: FileContext = {
    path,
    lines,
    usesBashSource: lines.some((entry) => /\bBASH_SOURCE\b/.test(entry.code)),
    octalVariables: octalSources(lines),
    validatorPaths: config.validatorPaths,
  };
  const out: ShellFinding[] = [];
  for (const entry of lines) {
    for (const [rule, check] of RULES) {
      const message = check(entry, context);
      if (message !== null) out.push({ check: config.id, rule, file: path, line: entry.line, message });
    }
  }
  return out;
};

export const checkPitfalls = (source: ShellSource, config: PitfallsConfig): ShellFinding[] => checkShellText(source.path, source.text, config);
