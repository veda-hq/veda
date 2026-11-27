#!/usr/bin/env node
// Runs a check suite or a type-check in a heavy-work turn (veda#652).
//
//   turn.mjs --label <text> -- <command> [args…]
//
// It runs `dvara turn --label <text> -- <command…>` through the dvara veda
// pins, so the run joins the machine's queue: one turn, class other,
// record-only until the queue enforces. A run inside a held turn (a
// package's `check` inside the root's) does not ask again: dvara runs it at
// once. A pinned dvara without `turn` runs the command directly, as before.
// The exit code is the command's either way.
import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The first dvara release with `dvara turn`; no dvara from 0.8.16 to 0.8.18 was published. */
export const FIRST_WITH_TURN = Object.freeze([0, 8, 19]);
/** The signals passed on to the command. */
export const FORWARDED = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);
/** The exit code when the command cannot be started, as a shell gives it. */
export const NOT_STARTED = 127;
export const USAGE = 'usage: turn.mjs --label <text> -- <command> [args…]';

/** Whether the `x.y.z` `version` is at least `floor`. @param {string} version @param {readonly number[]} floor */
export function atLeast(version, floor) {
  const parts = version.split('.').map(Number);
  for (const [i, want] of floor.entries()) {
    if (parts[i] !== want) return parts[i] > want;
  }
  return true;
}

/**
 * The CLI of the dvara installed for `from`, when it has `turn`; else null.
 * @param {string} from the directory to resolve the package from
 * @param {(path: string) => string} [read]
 * @returns {string | null}
 */
export function dvaraWithTurn(from, read = path => readFileSync(path, 'utf8')) {
  try {
    const manifest = createRequire(join(from, 'turn.mjs')).resolve('@veda-hq/dvara/package.json');
    const { version, bin } = JSON.parse(read(manifest));
    return atLeast(version, FIRST_WITH_TURN) ? join(dirname(manifest), bin.dvara) : null;
  } catch {
    // fail-open: no dvara installed, or one that cannot be read, runs the command as before.
    return null;
  }
}

/**
 * What to spawn: dvara's turn around the command, or the command alone.
 * @param {string | null} cli @param {string} label @param {readonly string[]} command @param {string} node
 */
export function plan(cli, label, command, node) {
  return cli === null ? [...command] : [node, cli, 'turn', '--label', label, '--', ...command];
}

/** The exit code of a child that ended, as a shell gives it. @param {number | null} code @param {NodeJS.Signals} signal */
export function exitCode(code, signal) {
  return code ?? 128 + constants.signals[signal];
}

/**
 * `--label <text> -- <command…>`, or undefined.
 * @param {readonly string[]} argv
 * @returns {{ label: string, command: string[] } | undefined}
 */
export function parse(argv) {
  const [flag, label, split, ...command] = argv;
  if (flag !== '--label' || !label?.trim() || split !== '--' || command.length === 0) return undefined;
  return { label, command };
}

/**
 * Run the command in its turn; resolve to its exit code.
 * @param {readonly string[]} argv
 * @param {{ from?: string, node?: string, env?: NodeJS.ProcessEnv, stderr?: { write(text: string): unknown }, signals?: NodeJS.EventEmitter, spawn?: typeof nodeSpawn, find?: (from: string) => string | null }} [options]
 * @returns {Promise<number>}
 */
export function main(argv, options = {}) {
  const {
    from = import.meta.dirname,
    node = process.execPath,
    env = process.env,
    stderr = process.stderr,
    signals = process,
    spawn = nodeSpawn,
    find = dvaraWithTurn,
  } = options;
  const parsed = parse(argv);
  if (parsed === undefined) {
    stderr.write(`${USAGE}\n`);
    return Promise.resolve(2);
  }
  const [file, ...args] = plan(find(from), parsed.label, parsed.command, node);
  const child = spawn(file, args, { stdio: 'inherit', env });
  const forwards = FORWARDED.map(signal => /** @type {const} */ ([signal, () => child.kill(signal)]));
  for (const [signal, forward] of forwards) signals.on(signal, forward);
  return new Promise(resolve => {
    const finish = (/** @type {number} */ code) => {
      for (const [signal, forward] of forwards) signals.off(signal, forward);
      resolve(code);
    };
    child.on('error', error => {
      stderr.write(`turn.mjs: ${file}: ${error.message}\n`);
      if (child.pid === undefined) finish(NOT_STARTED);
    });
    child.on('close', (code, signal) => finish(exitCode(code, signal)));
  });
}

/**
 * The exit code of `node <argv[1]> …` when `argv[1]` is the module at `url`,
 * or undefined when it was imported.
 * @param {readonly string[]} argv @param {string} url @param {Parameters<typeof main>[1]} [options]
 */
export function entry(argv, url, options) {
  return url === pathToFileURL(argv[1] ?? '').href ? main(argv.slice(2), options) : undefined;
}

process.exitCode = (await entry(process.argv, import.meta.url)) ?? process.exitCode;
