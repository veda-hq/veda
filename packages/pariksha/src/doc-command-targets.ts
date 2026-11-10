// The repository script a documented command runs (DOC-DRIFT-02): how pnpm
// reads its options, which words start an interpreter or a nested command,
// and the script file an interpreter or a package script reaches.
import { NPX_VALUE_OPTIONS, shellWords, simpleCommands, withoutAssignments } from './doc-commands.ts';

export interface Target {
  /** Repo-relative script the command runs. */
  readonly path: string;
  /** Words after the script path: flags and positionals the doc passes. */
  readonly args: string[];
}

/** pnpm options that take a value, before the script name. */
const PNPM_VALUE_OPTIONS: ReadonlySet<string> = new Set(['--filter', '-F', '--dir', '-C', '--workspace-concurrency', '--reporter']);

export interface PnpmInvocation {
  filter?: string;
  dir?: string;
  script?: string;
  /** `exec`/`dlx`: the words that follow. */
  exec?: string[];
  args: string[];
}

export const parsePnpm = (words: readonly string[]): PnpmInvocation => {
  let at = 1;
  const out: PnpmInvocation = { args: [] };
  for (let word = words[at]; word?.startsWith('-') === true; word = words[at]) {
    const [name = '', inline] = word.split(/=(.*)/s);
    if (PNPM_VALUE_OPTIONS.has(name)) {
      const value = inline ?? words[at + 1];
      if (value !== undefined && (name === '--filter' || name === '-F')) out.filter = value;
      if (value !== undefined && (name === '--dir' || name === '-C')) out.dir = value;
      at += inline === undefined ? 2 : 1;
    } else {
      at += 1;
    }
  }
  if (words[at] === 'exec' || words[at] === 'dlx') {
    out.exec = words.slice(at + 1);
    return out;
  }
  if (words[at] === 'run') at += 1;
  const script = words[at];
  if (script !== undefined) out.script = script;
  out.args = words.slice(at + 1);
  return out;
};

/** Commands that run the script file named after them. */
export const INTERPRETERS: ReadonlySet<string> = new Set(['tsx', 'node', 'python', 'python3', 'bash', 'sh']);

/** Words that start a nested command a wrapper script runs for you: interpreters, pnpm, npx and the config's `commands.nested`. */
export const nestedCommands = (nested: readonly string[]): ReadonlySet<string> => new Set([...INTERPRETERS, 'pnpm', 'npx', ...nested]);

/**
 * The arguments the script itself parses: everything before a `--` or a
 * nested command (`test-db.ts vitest run --coverage` hands `--coverage` to
 * vitest, not to test-db.ts).
 */
export const ownArgs = (args: readonly string[], nested: ReadonlySet<string>): string[] => {
  const end = args.findIndex((word) => word === '--' || nested.has(word));
  return end === -1 ? [...args] : args.slice(0, end);
};

/** Options of node, and of tsx, which hands them to node, whose value may be the next word: that word is not the script. */
const NODE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--import',
  '--loader',
  '--experimental-loader',
  '--require',
  '-r',
  '--env-file',
  '--env-file-if-exists',
  '--title',
  '--conditions',
  '-C',
  '--input-type',
  '--disable-warning',
  '--redirect-warnings',
  '--watch-path',
  '--inspect-port',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-name-pattern',
  '--test-skip-pattern',
]);

/**
 * Where the script an interpreter at `words[at]` runs sits: the first word
 * after its options. Only node and tsx options take a separate value; bash's
 * `-r` and `-C` take none. `--` ends the options.
 */
export const scriptIndex = (words: readonly string[], at: number): number => {
  const valueOptions = words[at] === 'node' || words[at] === 'tsx' ? NODE_VALUE_OPTIONS : new Set<string>();
  let index = at + 1;
  for (let word = words[index]; word?.startsWith('-') === true; word = words[index]) {
    if (word === '--') return index + 1;
    index += valueOptions.has(word) ? 2 : 1;
  }
  return index;
};

/** Options of `pnpm exec` whose value is the next word; its `-c` is `--shell-mode`, a switch. */
const PNPM_EXEC_VALUE_OPTIONS: ReadonlySet<string> = new Set(['--resume-from']);

/**
 * The repository script an interpreter command runs, if it names one: `tsx
 * scripts/x.ts --a`, `python3 scripts/y.py b`, `bash scripts/z.sh`. The
 * runner's own options before the interpreter are skipped, a value option's
 * value with them (`npx --yes tsx …`, `npx -p tsx tsx …`).
 */
export const interpreterTarget = (words: readonly string[], resolve: (path: string) => string | undefined): Target | undefined => {
  let at = 0;
  if (words[0] === 'npx' || words[0] === 'pnpm') at += 1;
  if (words[at] === 'exec') at += 1;
  const valueOptions = words[0] === 'npx' ? NPX_VALUE_OPTIONS : PNPM_EXEC_VALUE_OPTIONS;
  // The commands an `npx -c '…'` runs are documentedCommands' to read; here its value is skipped like any other.
  for (let word = words[at]; word?.startsWith('-') === true; word = words[at]) at += valueOptions.has(word) ? 2 : 1;
  if (!INTERPRETERS.has(String(words[at]))) return undefined;
  at = scriptIndex(words, at);
  const script = words[at];
  if (script === undefined) return undefined;
  const path = resolve(script);
  return path === undefined ? undefined : { path, args: words.slice(at + 1) };
};

/** The single command a package script runs, as a Target, if it is one. */
export const scriptTarget = (command: string, manifestDir: string, resolveFrom: (dir: string, path: string) => string | undefined, nested: ReadonlySet<string>): Target | undefined => {
  if (simpleCommands(command).length > 1) return undefined;
  const target = interpreterTarget(withoutAssignments(shellWords(command)), (path) => resolveFrom(manifestDir, path));
  // A script that wraps another command passes the doc's words on to it.
  if (target === undefined || ownArgs(target.args, nested).length < target.args.length) return undefined;
  return target;
};
