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
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The variables a temp directory is read from: TMPDIR on POSIX, TEMP and TMP on Windows. */
export const TMPDIR_KEYS = Object.freeze(['TMPDIR', 'TEMP', 'TMP']);
/** Short, so a Unix socket a test opens under it stays inside macOS's 104-byte limit. */
export const PREFIX = 'vt-';
/** The signals passed on to the command, so the directory is still removed when the run is stopped. */
export const FORWARDED = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']);
/** The exit code when the command cannot be started, as a shell gives it. */
export const NOT_STARTED = 127;

/** `env` with every temp variable at `dir`. @param {NodeJS.ProcessEnv} env @param {string} dir */
export function tmpEnv(env, dir) {
  return { ...env, ...Object.fromEntries(TMPDIR_KEYS.map(key => [key, dir])) };
}

/**
 * What a run left in `dir`: each entry as a full path, sorted. Undefined when
 * `dir` is gone, or is no longer a directory.
 * @param {string} dir
 * @param {(dir: string) => string[]} [read]
 * @returns {string[] | undefined}
 */
export function leftovers(dir, read = readdirSync) {
  try {
    return read(dir).sort().map(name => join(dir, name));
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
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
      message: `fresh-tmpdir: the run's TMPDIR ${dir} was removed or replaced during the run: something in it removed files outside its own scratch.`,
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
 * The signal handlers go on before the directory is made, so a signal never
 * takes Node's default exit between the two and leaves the directory behind.
 * @param {readonly string[]} command
 * @param {{ env?: NodeJS.ProcessEnv, base?: string, stderr?: { write(text: string): unknown }, signals?: NodeJS.EventEmitter, read?: (dir: string) => string[], remove?: (dir: string) => void, spawn?: typeof nodeSpawn }} [options]
 * @returns {Promise<number>}
 */
export function run(
  command,
  { env = process.env, base = tmpdir(), stderr = process.stderr, signals = process, read = readdirSync, remove = dir => rmSync(dir, { recursive: true, force: true }), spawn = nodeSpawn } = {},
) {
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  // A handler runs from the event loop, never between these lines and the
  // spawn below, so it always finds the child.
  /** @type {Array<[string, () => void]>} */
  const handlers = FORWARDED.map(signal => [signal, () => child?.kill(/** @type {NodeJS.Signals} */ (signal))]);
  const unlisten = () => {
    for (const [name, handler] of handlers) signals.off(name, handler);
  };
  for (const [signal, handler] of handlers) signals.on(signal, handler);
  /** @type {string} */
  let dir;
  try {
    dir = mkdtempSync(join(base, PREFIX));
  } catch (error) {
    unlisten();
    throw error;
  }
  /** @type {import('node:child_process').ChildProcess} */
  let started;
  try {
    started = spawn(/** @type {string} */ (command[0]), command.slice(1), { stdio: 'inherit', env: tmpEnv(env, dir) });
  } catch (error) {
    // spawn refuses some arguments before it starts anything, by throwing.
    unlisten();
    remove(dir);
    throw error;
  }
  child = started;
  return new Promise((resolve, reject) => {
    let done = false;
    /** @param {number} code */
    const finish = code => {
      if (done) return;
      done = true;
      unlisten();
      // What was left is printed before the removal is tried, so a folder
      // that cannot be removed is still named. A failure to read or remove
      // the directory, or to print, rejects the run with that error as it is
      // (an fs error names its path).
      try {
        /** @type {number} */
        let exit;
        try {
          const result = verdict(code, leftovers(dir, read), dir);
          if (result.message) stderr.write(`${result.message}\n`);
          exit = result.code;
        } finally {
          remove(dir);
        }
        resolve(exit);
      } catch (error) {
        reject(error);
      }
    };
    started.on('error', error => {
      stderr.write(`fresh-tmpdir: ${command[0]}: ${error.message}\n`);
      // A command that never started ends here: the 'close' Node sends after it,
      // with a negative code, finds the run done. One that did start still ends with its own 'close'.
      if (started.pid === undefined) finish(NOT_STARTED);
    });
    started.on('close', (code, signal) => finish(exitCode(code, signal)));
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

/**
 * The exit code of `node <argv[1]> …` when `argv[1]` is the module at `url`,
 * or undefined when it is not (the module was imported). A suite calls it
 * in-process, so a mutant that would run main on import, or never, dies there.
 * @param {readonly string[]} argv
 * @param {string} url
 * @param {Parameters<typeof run>[1]} [options]
 */
export function entry(argv, url, options) {
  return argv[1] && url === pathToFileURL(argv[1]).href ? main(argv.slice(2), options) : undefined;
}

process.exitCode = await entry(process.argv, import.meta.url);
