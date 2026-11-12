// The git hook preamble contract: every hook follows one preamble, so the
// runtime a hook uses is decided in one place (the config's `selectScript`,
// which defines `selectFunction`) and a cancelled hook stays cancelled.
//
//   runtime-before-select-node  node/npx/pnpm/npm/tsx/corepack/yarn runs before
//                               the hook sources the select script and calls
//                               its function
//   opt-out-after-select-node   an opt-out (`[ "$VAR" = 0 ] && exit 0`) comes
//                               after runtime selection, so opting out still
//                               pays for (and can fail on) selection
//   own-runtime-path            the hook edits PATH or touches nvm/fnm/mise
//                               itself; the select script owns that
//   exec-sh-trampoline          `exec sh <hook>` ignores the target's bash
//                               shebang
//   signal-trap-continues       an INT/TERM/HUP/QUIT trap whose handler does
//                               not end in `exit`: bash resumes after the
//                               handler, so a cancelled gate carries on
import { isHook, type ShellFinding, type ShellSource } from './shell-sources.ts';
import { codeLines, commandAt, commandPositions, type CodeLine, maskQuoted, messageView, words } from './shell-text.ts';

export interface PreambleConfig {
  /** What a finding's check column says. */
  readonly id: string;
  /** The git hook directory, with its trailing `/`. */
  readonly hooksDir: string;
  /** The script that selects the runtime, repository-relative (`scripts/lib/select-node.sh`). */
  readonly selectScript: string;
  /** The function that script defines, which the hook must call. */
  readonly selectFunction: string;
  /** The commands that need the selected runtime. */
  readonly runtimes: readonly string[];
}

export const DEFAULT_RUNTIMES: readonly string[] = ['node', 'npx', 'pnpm', 'npm', 'tsx', 'corepack', 'yarn'];

const STOP_SIGNALS = new Set(['INT', 'TERM', 'HUP', 'QUIT', '1', '2', '3', '15']);

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const finding = (config: PreambleConfig, source: ShellSource, rule: string, line: number, message: string): ShellFinding => ({ check: config.id, rule, file: source.path, line, message });

/** Whether the first word of `rest` (a command's operands) matches `pattern`; no word, no match. */
const firstWordMatches = (rest: string, pattern: RegExp): boolean =>
  words(rest)
    .slice(0, 1)
    .some((word) => pattern.test(word));

/**
 * Quote-masked text after a command at this level only: each `( … )` or
 * `$( … )` group becomes one space, so `&(:)&` stays two separate `&`, and
 * the text is cut at a `)` that closes an enclosing group. Only this level's
 * separators remain; offsets are not kept.
 */
const outerLevel = (masked: string): string => {
  let depth = 0;
  const kept: string[] = [];
  for (const char of masked) {
    if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    } else if (char === '(') {
      if (depth === 0) kept.push(' ');
      depth += 1;
    } else if (depth === 0) kept.push(char);
  }
  return kept.join('');
};

/**
 * Whether the command at `start..end` runs in a child shell, so whatever it
 * defines or selects is gone afterwards: a pipeline stage (`x | cmd`,
 * `cmd | cat`, `|&` too) or a list sent to the background (`cmd &`).
 */
const runsInChildShell = (code: string, start: number, end: number): boolean => {
  if (/(?:^|[^|])\|&?\s*$/.test(code.slice(0, start))) return true;
  // The rest of its list (to `;` or a newline) and of its pipeline (to `&&`
  // or `||` too, which bind looser than `|`), read at this level only: a `;`
  // inside `"$(a; b)"` ends nothing.
  const list = outerLevel(maskQuoted(code).slice(end)).split(/[;\n]/)[0] as string;
  if (/(?:^|[^&>])&(?![&>])/.test(list)) return true;
  const pipeline = list.split(/&&|\|\|/)[0] as string;
  return /\|/.test(pipeline);
};

/**
 * Offsets of each `.`/`source` command, where it runs (never in a message or
 * quoted text), whose file operand is the select script.
 */
const selectSources = (code: string, script: RegExp): number[] =>
  ['.', 'source'].flatMap((name) => commandPositions(code, name).filter((end) => firstWordMatches(code.slice(end), script) && !runsInChildShell(code, end - name.length, end)));

/**
 * `[ "$VAR" ... ] && exit 0` or `if [ ... ]; then exit 0`, on one line or
 * several (`then` and `exit 0` on lines of their own), read over the logical
 * lines joined with newlines.
 */
const OPT_OUT = /\$\{?[A-Z][A-Z0-9_]*\b[^\]\n]*\]\]?\s*(?:&&|(?:;|\n)\s*then)\s*exit\s+0\b/g;
const PATH_EDIT = /(?:^|[\s;&|(])(?:export\s+)?PATH\+?=/;
const NVM = /\bNVM_DIR\b|\bnvm\.sh\b/;
const FNM_USE = /(?:^|[\s;&|("])fnm\s+(?:use|env)\b/;
/** `mise activate`, `mise env`, `mise exec`/`x` or `mise shell`: each edits the runtime PATH. */
const MISE_USE = /(?:^|[\s;&|("])mise\s+(?:activate|env|exec|x|shell)\b/;

/** `. "$NVM_DIR/nvm.sh"`, `\. ~/.nvm/nvm.sh` or `source …nvm.sh`: the path is often quoted. */
const sourcesNvm = (code: string): boolean => ['.', '\\.', 'source'].some((name) => commandPositions(code, name).some((end) => firstWordMatches(code.slice(end), /nvm\.sh\b/)));

export interface At {
  /** Index into the logical lines. */
  readonly index: number;
  /** Offset within that line's code. */
  readonly offset: number;
}

/** The first position, in line then offset order, that `find` yields and `keep` accepts. */
const firstAt = (lines: readonly CodeLine[], find: (code: string) => readonly number[], keep: (at: At) => boolean): At | undefined => {
  for (const [index, line] of lines.entries()) {
    const kept = find(line.code).filter((offset) => keep({ index, offset }));
    if (kept.length > 0) return { index, offset: Math.min(...kept) };
  }
  return undefined;
};

const NAME = String.raw`[A-Za-z_][\w-]*`;

/** `f() {`, `function f {` or `function f() {`, capturing the name and the rest. */
const FUNCTION_HEADER = new RegExp(String.raw`^\s*(?:function\s+(${NAME})\s*(?:\(\s*\))?|(${NAME})\s*\(\s*\))\s*\{(.*)$`);

/** `f()`, `function f` or `function f()` alone: the `{` opens the next line. */
const BARE_HEADER = new RegExp(String.raw`^\s*(?:function\s+(${NAME})\s*(?:\(\s*\))?|(${NAME})\s*\(\s*\))\s*$`);

interface FunctionDefinition {
  readonly name: string;
  /** The header's line: the definition starts at its offset 0. */
  readonly start: number;
  /** The closing `}` (inclusive); code after it on that line is top level. */
  readonly end: At;
  /** Body text between the braces, lines joined with `;`. */
  readonly body: string;
  /** Body statements, in order, split on `;`. */
  readonly statements: string[];
}

/**
 * Statements split at unquoted `;` and newlines only: `echo "a; exit 1"` is
 * one statement, and `cleanup && exit 130` is one whose exit may not run.
 */
const splitStatements = (code: string): string[] => {
  const masked = maskQuoted(code);
  const parts: string[] = [];
  let from = 0;
  for (let at = 0; at <= code.length; at += 1) {
    if (at === code.length || masked[at] === ';' || masked[at] === '\n') {
      parts.push(code.slice(from, at).trim());
      from = at + 1;
    }
  }
  return parts.filter(Boolean);
};

/** Unquoted code with `${…}` blanked, offsets preserved, for brace counting. */
const braceView = (code: string): string => maskQuoted(code).replace(/\$\{[^}]*\}/g, (match) => ' '.repeat(match.length));

/** A function header at `index`: its name, the line holding its `{`, and the code after that `{`. */
const headerAt = (lines: readonly CodeLine[], index: number): { name: string; braceLine: number; rest: string } | undefined => {
  const code = (lines[index] as CodeLine).code;
  const match = FUNCTION_HEADER.exec(code);
  if (match !== null) return { name: (match[1] ?? match[2]) as string, braceLine: index, rest: match[3] as string };
  // `f()` alone, its `{` opening the next line, is a definition too.
  const bare = BARE_HEADER.exec(code);
  const next = lines.at(index + 1);
  if (bare === null || next === undefined) return undefined;
  const brace = /^\s*\{(.*)$/.exec(next.code);
  if (brace === null) return undefined;
  return { name: (bare[1] ?? bare[2]) as string, braceLine: index + 1, rest: brace[1] as string };
};

/**
 * Every function definition, from its header to the `}` that brings the
 * brace depth back to zero, so a nested `{ …; }` group does not end it and
 * code after the closing brace on that line stays top level.
 */
const functionDefinitions = (lines: readonly CodeLine[]): FunctionDefinition[] => {
  const out: FunctionDefinition[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = index;
    const header = headerAt(lines, index);
    if (header === undefined) continue;
    const { name, braceLine, rest } = header;
    index = braceLine;
    // Where the body starts: just past the `{`, on the line holding it.
    const bodyStart = (lines[braceLine] as CodeLine).code.length - rest.length;
    let depth = 0;
    let end: At | undefined;
    for (; index < lines.length && end === undefined; index += 1) {
      for (const [offset, char] of braceView((lines[index] as CodeLine).code)
        .split('')
        .entries()) {
        if (char === '{') depth += 1;
        else if (char === '}' && --depth === 0) {
          end = { index, offset };
          break;
        }
      }
    }
    index -= 1; // back to the closing line; the outer loop steps past it
    const close = end ?? { index, offset: (lines[index] as CodeLine).code.length };
    const parts: string[] = [];
    for (let line = braceLine; line <= close.index; line += 1) parts.push((lines[line] as CodeLine).code.slice(line === braceLine ? bodyStart : 0, line === close.index ? close.offset : undefined));
    const body = parts.join(';');
    out.push({ name, start, end: close, body, statements: splitStatements(body).filter((statement) => statement !== '}' && statement !== '{') });
  }
  return out;
};

/** Strictly earlier: by logical line, then by offset within it. */
export const isBefore = (a: At, b: At): boolean => a.index < b.index || (a.index === b.index && a.offset < b.offset);

// A command ends before the `}` that closes its function: `node}` is one word.
const insideFunction = (functions: readonly FunctionDefinition[], at: At): boolean => functions.some((fn) => at.index >= fn.start && isBefore(at, fn.end));

/**
 * Whether `at` runs in the hook's own shell: no unquoted `(` left open before
 * it, across lines, and no open backtick substitution. Selection inside
 * `( … )`, `$( … )` or `` `…` `` is lost when the subshell exits.
 */
const inHookShell = (lines: readonly CodeLine[], at: At): boolean => {
  let depth = 0;
  let inBacktick = false;
  const before = lines
    .slice(0, at.index)
    .map((line) => maskQuoted(line.code))
    .concat(maskQuoted((lines[at.index] as CodeLine).code).slice(0, at.offset));
  for (const text of before) {
    for (const char of text) {
      if (char === '(') depth += 1;
      else if (char === ')') depth = Math.max(0, depth - 1);
      else if (char === '`') inBacktick = !inBacktick;
    }
  }
  return depth === 0 && !inBacktick;
};

/** `'x'` or `"x"` without its quotes; anything else as it is. */
const unquote = (word: string): string => /^(['"])([\s\S]*)\1$/.exec(word)?.[2] ?? word;

/** Leading redirections (`2>&1`, `>/dev/null`) of a command's remainder. */
const REDIRECTIONS = /^(?:\s*[0-9]*[<>]{1,2}&?\s*[^\s;&|]+)+/;

/**
 * `exit` or `exit N`, plus any redirections (`exit 130 >&2` still exits the
 * hook); `exit 130 &` or `exit 130 | cat` exits a child shell instead.
 */
const EXIT = String.raw`exit(?:\s+[^\s&|;<>]+)?(?:\s*[0-9]*[<>]{1,2}&?\s*[^\s;&|<>]+)*`;
const EXIT_STATEMENT = new RegExp(String.raw`^${EXIT}\s*$`);

/** Whether the last statement of a handler string, or of a named function's body, exits. */
const handlerEndsInExit = (handler: string, functions: readonly FunctionDefinition[]): boolean => {
  // `trap - SIG` restores the default (the hook dies); `trap '' SIG` ignores
  // the signal, so a cancelled hook runs on.
  if (handler === '-') return true;
  const body = unquote(handler).trim();
  // A function name ends in exit when its body's last statement does.
  // Otherwise split on `;` and newlines only: `cleanup && exit 130` is one
  // statement whose exit is skipped when cleanup fails. An empty handler
  // (`trap '' SIG`) has no last statement.
  const last = /^[A-Za-z_][A-Za-z0-9_]*$/.test(body) ? functions.find((entry) => entry.name === body)?.statements.at(-1) : splitStatements(body).at(-1);
  return last !== undefined && EXIT_STATEMENT.test(last);
};

const trapFindings = (config: PreambleConfig, source: ShellSource, lines: readonly CodeLine[], functions: readonly FunctionDefinition[]): ShellFinding[] => {
  const out: ShellFinding[] = [];
  for (const entry of lines) {
    // Every trap on the line: `trap 'exit 130' INT; trap '' TERM` has two.
    for (const at of commandPositions(entry.code, 'trap')) {
      let args = words(entry.code.slice(at));
      // `trap -- handler SIG` ends options; `-p` and `-l` only list.
      // `trap - SIG` restores the default, so it needs no check either.
      if (args[0] === '--') args = args.slice(1);
      else if (args[0]?.startsWith('-')) continue;
      if (args.length < 2) continue;
      const [handler, ...signals] = args as [string, ...string[]];
      const stops = signals.some((signal) => STOP_SIGNALS.has(unquote(signal).toUpperCase().replace(/^SIG/, '')));
      if (stops && !handlerEndsInExit(handler, functions)) {
        out.push(finding(config, source, 'signal-trap-continues', entry.line, `trap ${handler} on ${signals.join(' ')} does not end in exit: bash resumes after the handler, so a cancelled hook keeps running`));
      }
    }
  }
  return out;
};

export const checkHookPreamble = (source: ShellSource, config: PreambleConfig): ShellFinding[] => {
  if (!isHook(source.path, config.hooksDir)) return [];
  const lines = codeLines(source.text);
  const out: ShellFinding[] = [];
  const select = config.selectFunction;
  // Absolute or repository-relative: hooks run from the repository root.
  const script = new RegExp(String.raw`(?:^["']?|\/)${escapeRegex(config.selectScript)}\b`);

  // A function body runs where the function is called, not where it is
  // defined: selection inside one does not count as the preamble selecting,
  // and a runtime inside one counts at each call of that function.
  const functions = functionDefinitions(lines);
  const outsideFunctions = (at: At): boolean => !insideFunction(functions, at);
  const runtimeOffsets = (code: string, names: readonly string[]): number[] => names.flatMap((name) => commandPositions(code, name));
  // A function that runs a runtime, or calls a function that does, is a
  // runner. A Set's iteration also visits what is added during it, so each
  // new runner is in turn checked for callers, and each name once.
  const runners = new Set(functions.filter((definition) => runtimeOffsets(definition.body, config.runtimes).length > 0).map((definition) => definition.name));
  for (const runner of runners) {
    for (const definition of functions) if (runtimeOffsets(definition.body, [runner]).length > 0) runners.add(definition.name);
  }
  // Selection must also run in the hook's own shell: inside `( … )` or
  // `$( … )` its PATH change is gone once the subshell exits.
  const topLevel = (at: At): boolean => outsideFunctions(at) && inHookShell(lines, at);
  const sourcedAt = firstAt(lines, (code) => selectSources(code, script), topLevel);
  // And its failure must stop the hook: `<select> || exit 1`, or the
  // condition of an `if`. A bare call, `|| true`, or a top-level `|| return`
  // (which fails and carries on) runs on unselected.
  const calledAt = firstAt(
    lines,
    (code) =>
      commandPositions(code, select).filter((end) => {
        const start = end - select.length;
        // A pipeline stage runs in a subshell: `x | select`; so does a list
        // sent to the background: `select || exit 1 &`.
        if (runsInChildShell(code, start, end)) return false;
        // Redirections may sit between the call and `||`: `2>&1 || exit 1`.
        const rest = code.slice(end).replace(REDIRECTIONS, '');
        return (
          // `|| exit`, or a `|| { …; }` block whose last statement exits. The
          // exit must end the list: `|| exit 1 | cat` exits a pipeline child.
          new RegExp(String.raw`^\s*\|\|\s*${EXIT}\s*(?:$|;|&&)`).test(rest) ||
          new RegExp(String.raw`^\s*\|\|\s*\{(?:[^}]*;)?\s*${EXIT}\s*;\s*\}\s*(?:$|;|&&)`).test(rest) ||
          /(?:^|[\s;&])if\s+(?:!\s*)?$/.test(code.slice(0, start))
        );
      }),
    topLevel,
  );
  const runtimeAt = firstAt(lines, (code) => runtimeOffsets(code, [...config.runtimes, ...runners]), outsideFunctions);
  if (runtimeAt !== undefined) {
    // Ordered by logical line, then by offset within it, so
    // `. select.sh; select; node x` on one line is in order.
    const selectedBefore = sourcedAt !== undefined && calledAt !== undefined && isBefore(sourcedAt, calledAt) && isBefore(calledAt, runtimeAt);
    if (!selectedBefore) {
      out.push(
        finding(
          config,
          source,
          'runtime-before-select-node',
          (lines[runtimeAt.index] as CodeLine).line,
          `runs a Node tool before sourcing ${config.selectScript} and calling ${select}, so it uses whatever node PATH happens to hold`,
        ),
      );
    }
  }

  if (sourcedAt !== undefined) {
    // Everything after the source, its own line's rest included:
    // `. select.sh; [ "$X" ] && exit 0` opts out after selecting.
    const sourceLine = lines[sourcedAt.index] as CodeLine;
    const after: CodeLine[] = [{ line: sourceLine.line, code: sourceLine.code.slice(sourcedAt.offset) }, ...lines.slice(sourcedAt.index + 1)];
    // Messages blanked: `echo '[ "$X" ] && exit 0'` shows an opt-out.
    const texts = after.map((entry) => `${messageView(entry.code)}\n`);
    const joined = texts.join('');
    const starts = texts.map((_, index) => texts.slice(0, index).join('').length);
    const masked = maskQuoted(joined);
    for (const match of joined.matchAll(OPT_OUT)) {
      // The exit must run: in `HELP='[ "$X" ] && exit 0'` it is quoted text.
      const exitAt = match.index + match[0].lastIndexOf('exit');
      if (!masked.startsWith('exit', exitAt)) continue;
      // Reported on the condition's line: the last starting at or before it.
      const owner = starts.findLastIndex((start) => start <= match.index);
      out.push(finding(config, source, 'opt-out-after-select-node', (after[owner] as CodeLine).line, 'opt-out comes after runtime selection; check it first so an opted-out hook does no work and cannot fail'));
    }
  }

  for (const entry of lines) {
    // Code text, not command positions, with quoted literals blanked: a
    // message (echo/printf) is judged with its words blanked too, so
    // `echo export PATH=...` and `HELP="export PATH=..."` name an edit
    // without making one, while `eval "$(fnm env)"` keeps its substitution.
    const view = messageView(entry.code);
    const code = maskQuoted(view);
    if (PATH_EDIT.test(code) || NVM.test(code) || sourcesNvm(view) || commandAt(entry.code, 'nvm') !== -1 || FNM_USE.test(code) || MISE_USE.test(code)) {
      out.push(finding(config, source, 'own-runtime-path', entry.line, `hook edits PATH or drives nvm/fnm/mise itself; ${config.selectScript} owns runtime and tool PATH`));
    }
    // `exec` at a command position, never in a message; sh and dash only:
    // `exec bash <hook>` names the dialect the hook needs.
    const masked = maskQuoted(entry.code);
    if (commandPositions(entry.code, 'exec').some((end) => /^\s+(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:da)?sh(?=\s|$)/.test(masked.slice(end)))) {
      out.push(finding(config, source, 'exec-sh-trampoline', entry.line, '`exec sh <hook>` runs the target under sh whatever its shebang says; exec the hook itself'));
    }
  }

  return [...out, ...trapFindings(config, source, lines, functions)].sort((a, b) => a.line - b.line);
};
