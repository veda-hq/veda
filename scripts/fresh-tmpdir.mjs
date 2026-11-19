#!/usr/bin/env node
// Runs a test command under a fresh, empty temp directory, and fails the run
// if the command leaves anything in it (veda#270).
//
//   fresh-tmpdir.mjs <command> [args…]
//
// TMPDIR, TEMP and TMP all point at a new directory under this process's own
// temp directory. Node's os.tmpdir(), Python's tempfile, git and the shell's
// mktemp read them, so a suite's scratch, a helper's and a child process's
// all land in it. When the command ends, every entry still in the directory
// is named as a full path and the run fails, even when the command passed.
// The directory is removed either way. docs/lessons/testing.md, "Temp
// folders", says how to read the failure.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The variables a temp directory is read from: TMPDIR on POSIX, TEMP and TMP on Windows. */
export const TMPDIR_KEYS = Object.freeze(['TMPDIR', 'TEMP', 'TMP']);
/** Short, so a Unix socket a test opens under it stays inside macOS's 104-byte limit. */
export const PREFIX = 'vt-';
/** The signals passed on to the command, so the directory is still removed when the run is stopped. */
export const FORWARDED = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);
/** The exit code when the command cannot be started, as a shell gives it. */
export const NOT_STARTED = 127;

/** `env` with every temp variable at `dir`. @param {NodeJS.ProcessEnv} env @param {string} dir */
export function tmpEnv(env, dir) {
  return { ...env, ...Object.fromEntries(TMPDIR_KEYS.map(key => [key, dir])) };
}

/**
 * What a run left in `dir`: each entry as a full path, sorted. Undefined when
 * `dir` itself is gone.
 * @param {string} dir
 * @param {(dir: string) => string[]} [read]
 * @returns {string[] | undefined}
 */
export function leftovers(dir, read = readdirSync) {
  try {
    return read(dir).sort().map(name => join(dir, name));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The exit code a run ends with, and what to print. A command that failed
 * keeps its own code; one that passed fails with 1 when it left anything.
 * @param {number} code the command's own exit code
 * @param {string[] | undefined} left from `leftovers`
 * @param {string} dir
 * @returns {{ code: number, message: string | undefined }}
 */
export function verdict(code, left, dir) {
  const failed = code === 0 ? 1 : code;
  if (left === undefined) {
    return {
      code: failed,
      message: `fresh-tmpdir: the run's TMPDIR ${dir} was removed during the run: something in it removed files outside its own scratch.`,
    };
  }
  if (left.length === 0) return { code, message: undefined };
  return {
    code: failed,
    message: [
      `fresh-tmpdir: the run left ${left.length} ${left.length === 1 ? 'path' : 'paths'} in its TMPDIR:`,
      ...left.map(path => `  ${path}`),
      'fresh-tmpdir: each is a suite\'s temp folder that nothing removed. Remove it in the suite, in after() or finally (docs/lessons/testing.md, "Temp folders").',
    ].join('\n'),
  };
}

/** The exit code of a command a signal ended, as a shell gives it. @param {number | null} code @param {NodeJS.Signals | null} signal */
export function exitCode(code, signal) {
  if (code !== null) return code;
  return 128 + (signal ? constants.signals[signal] : 0);
}

/**
 * Run `command` under a fresh temp directory and resolve to the run's exit code.
 * @param {readonly string[]} command
 * @param {{ env?: NodeJS.ProcessEnv, base?: string, stderr?: { write(text: string): unknown }, signals?: NodeJS.EventEmitter }} [options]
 * @returns {Promise<number>}
 */
export function run(command, { env = process.env, base = tmpdir(), stderr = process.stderr, signals = process } = {}) {
  const dir = mkdtempSync(join(base, PREFIX));
  return new Promise(resolve => {
    const child = spawn(/** @type {string} */ (command[0]), command.slice(1), { stdio: 'inherit', env: tmpEnv(env, dir) });
    /** @type {Array<[string, () => void]>} */
    const handlers = FORWARDED.map(signal => [signal, () => child.kill(/** @type {NodeJS.Signals} */ (signal))]);
    for (const [signal, handler] of handlers) signals.on(signal, handler);
    let done = false;
    /** @param {number} code */
    const finish = code => {
      if (done) return;
      done = true;
      for (const [name, handler] of handlers) signals.off(name, handler);
      const left = leftovers(dir);
      rmSync(dir, { recursive: true, force: true });
      const result = verdict(code, left, dir);
      if (result.message) stderr.write(`${result.message}\n`);
      resolve(result.code);
    };
    child.on('error', error => {
      stderr.write(`fresh-tmpdir: ${command[0]}: ${error.message}\n`);
      // A command that never started gets no 'close'; one that did still ends with its own.
      if (child.pid === undefined) finish(NOT_STARTED);
    });
    child.on('close', (code, signal) => finish(exitCode(code, signal)));
  });
}

/** The command line's exit code. @param {readonly string[]} argv @param {Parameters<typeof run>[1]} [options] */
export async function main(argv, options = {}) {
  if (argv.length === 0) {
    (options.stderr ?? process.stderr).write('usage: fresh-tmpdir.mjs <command> [args…]\n');
    return 2;
  }
  return run(argv, options);
}

/* node:coverage disable */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
/* node:coverage enable */
