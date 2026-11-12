// python-floor: every tracked Python source runs on the interpreter a repository
// declares. The check is python/python-floor.py, run under the interpreter the
// caller names; pariksha never chooses or bundles a Python, and passes the
// script's stdout, stderr and exit code through unchanged.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** The packaged script: beside src/ in the repository, beside dist/ in the npm package. */
export const SCRIPT = join(import.meta.dirname, '..', 'python', 'python-floor.py');

export interface Spawned {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

/** Runs `python` on `args` (the script first), its output going straight to this process's. */
export type PythonRunner = (python: string, args: readonly string[]) => Spawned;

export const inheritRunner: PythonRunner = (python, args) => spawnSync(python, args, { stdio: 'inherit' });

export interface Options {
  readonly python: string;
  readonly floorFile: string;
  readonly root?: string;
  readonly exclude?: string;
  readonly selector?: string;
}

/** The script's arguments: each option only when given, so its own defaults hold. */
export const scriptArgs = (options: Options): string[] => [
  SCRIPT,
  '--floor-file',
  options.floorFile,
  ...(options.root === undefined ? [] : ['--root', options.root]),
  ...(options.exclude === undefined ? [] : ['--exclude', options.exclude]),
  ...(options.selector === undefined ? [] : ['--selector', options.selector]),
];

/** The script's exit code; 2, with a reason on `err`, when it could not run or did not exit. */
export const runPythonFloor = (options: Options, runner: PythonRunner, err: (line: string) => void): number => {
  const P = 'pariksha python-floor:';
  const result = runner(options.python, scriptArgs(options));
  if (result.error !== undefined) {
    err(`${P} cannot run ${options.python}: ${result.error.message}; nothing was checked, so this is not a pass`);
    return 2;
  }
  if (result.status === null) {
    err(`${P} ${options.python} was stopped by ${String(result.signal)}; nothing was checked, so this is not a pass`);
    return 2;
  }
  return result.status;
};
