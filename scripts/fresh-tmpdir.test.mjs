import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FORWARDED, NOT_STARTED, PREFIX, TMPDIR_KEYS, exitCode, leftovers, main, run, tmpEnv, verdict } from './fresh-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('fresh-tmpdir.mjs', import.meta.url));
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A scratch root of the test's own, removed after the suite. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'fresh-tmpdir-test-'));
  roots.push(root);
  return root;
}

/** A sink for what a run prints. */
function sink() {
  const lines = [];
  return { lines, write: text => lines.push(text) };
}

/** Run a Node program under the wrapper, in this process, with `base` as the parent temp directory. */
async function runNode(program, { base = scratch(), env = {}, signals = new EventEmitter() } = {}) {
  const stderr = sink();
  const code = await run([process.execPath, '-e', program], { env: { PATH: process.env.PATH, ...env }, base, stderr, signals });
  return { code, base, stderr: stderr.lines.join(''), signals };
}

describe('tmpEnv', () => {
  test('points every temp variable at the directory and keeps the rest', () => {
    assert.deepEqual(tmpEnv({ PATH: '/bin', TMPDIR: '/tmp' }, '/x'), { PATH: '/bin', TMPDIR: '/x', TEMP: '/x', TMP: '/x' });
    assert.deepEqual(TMPDIR_KEYS, ['TMPDIR', 'TEMP', 'TMP']);
  });
});

describe('leftovers', () => {
  test('names each entry as a full path, sorted', () => {
    assert.deepEqual(leftovers('/d', () => ['b', 'a']), ['/d/a', '/d/b']);
  });
  test('is undefined when the directory is gone', () => {
    assert.equal(leftovers(join(scratch(), 'gone')), undefined);
  });
  test('passes on any other error', () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    assert.throws(() => leftovers('/d', () => { throw denied; }), denied);
  });
});

describe('verdict', () => {
  test('a clean run keeps its code and prints nothing', () => {
    assert.deepEqual(verdict(0, [], '/d'), { code: 0, message: undefined });
    assert.deepEqual(verdict(3, [], '/d'), { code: 3, message: undefined });
  });
  test('a passing run that left a path fails with 1 and names it', () => {
    const { code, message } = verdict(0, ['/d/a-1'], '/d');
    assert.equal(code, 1);
    assert.match(message, /left 1 path in its TMPDIR:\n {2}\/d\/a-1\n/);
    assert.match(message, /docs\/lessons\/testing\.md, "Temp folders"/);
  });
  test('a failing run keeps its own code and still names what it left', () => {
    const { code, message } = verdict(4, ['/d/a', '/d/b'], '/d');
    assert.equal(code, 4);
    assert.match(message, /left 2 paths in its TMPDIR:\n {2}\/d\/a\n {2}\/d\/b\n/);
  });
  test('a run whose directory was removed fails', () => {
    const { code, message } = verdict(0, undefined, '/d');
    assert.equal(code, 1);
    assert.match(message, /TMPDIR \/d was removed during the run/);
    assert.equal(verdict(5, undefined, '/d').code, 5);
  });
});

describe('exitCode', () => {
  test('is the code, or 128 plus the signal number', () => {
    assert.equal(exitCode(0, null), 0);
    assert.equal(exitCode(2, null), 2);
    assert.equal(exitCode(null, 'SIGTERM'), 128 + constants.signals.SIGTERM);
    assert.equal(exitCode(null, null), 128);
  });
});

describe('run', () => {
  test('the command sees a fresh, empty directory in every temp variable, removed after', async () => {
    const out = join(scratch(), 'seen.json');
    const program = `const fs = require('node:fs'); const os = require('node:os'); fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, tmpdir: os.tmpdir(), entries: fs.readdirSync(os.tmpdir()) }));`;
    const { code, base, stderr } = await runNode(program, { env: { TMPDIR: '/elsewhere' } });
    assert.equal(code, 0, stderr);
    assert.equal(stderr, '');
    const seen = JSON.parse(readFileSync(out, 'utf8'));
    assert.ok(seen.TMPDIR.startsWith(join(base, PREFIX)), seen.TMPDIR);
    assert.equal(seen.TEMP, seen.TMPDIR);
    assert.equal(seen.TMP, seen.TMPDIR);
    assert.equal(seen.tmpdir, seen.TMPDIR);
    assert.deepEqual(seen.entries, []);
    assert.deepEqual(readdirSync(base), [], 'the directory is removed');
  });

  test('a passing command that leaves a folder fails and names it', async () => {
    const { code, base, stderr } = await runNode(`require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'leak-'));`);
    assert.equal(code, 1);
    assert.match(stderr, /left 1 path in its TMPDIR:\n {2}\S+\/vt-\w+\/leak-\w+\n/);
    assert.deepEqual(readdirSync(base), [], 'the directory is removed with what was left in it');
  });

  test('a failing command keeps its code and still names what it left', async () => {
    const { code, stderr } = await runNode(`require('node:fs').writeFileSync(require('node:os').tmpdir() + '/a', ''); process.exit(3);`);
    assert.equal(code, 3);
    assert.match(stderr, /left 1 path in its TMPDIR:\n {2}\S+\/a\n/);
  });

  test('a command that removes its own directory fails', async () => {
    const { code, stderr } = await runNode(`require('node:fs').rmSync(require('node:os').tmpdir(), { recursive: true });`);
    assert.equal(code, 1);
    assert.match(stderr, /was removed during the run/);
  });

  test('a command a signal ends exits as a shell gives it', async () => {
    const { code, stderr } = await runNode(`process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 10_000);`);
    assert.equal(code, 128 + constants.signals.SIGTERM, stderr);
  });

  test('a signal to the run goes on to the command, and the directory is still removed', async () => {
    const base = scratch();
    const signals = new EventEmitter();
    const pending = runNode(`setTimeout(() => {}, 10_000);`, { base, signals });
    for (const signal of FORWARDED) assert.equal(signals.listenerCount(signal), 1, signal);
    signals.emit('SIGTERM');
    const { code } = await pending;
    assert.equal(code, 128 + constants.signals.SIGTERM);
    for (const signal of FORWARDED) assert.equal(signals.listenerCount(signal), 0, `${signal} handler removed`);
    assert.deepEqual(readdirSync(base), []);
  });

  test('a command that cannot start exits 127 and its directory is removed', async () => {
    const base = scratch();
    const stderr = sink();
    const code = await run([join(base, 'no-such-command')], { base, stderr, signals: new EventEmitter() });
    assert.equal(code, NOT_STARTED);
    assert.match(stderr.lines.join(''), /no-such-command: spawn .*ENOENT/);
    assert.deepEqual(readdirSync(base), []);
  });
});

describe('main', () => {
  test('refuses an empty command line with 2', async () => {
    const stderr = sink();
    assert.equal(await main([], { stderr }), 2);
    assert.match(stderr.lines.join(''), /^usage: fresh-tmpdir\.mjs <command>/);
  });

  test('runs the command', async () => {
    const base = scratch();
    assert.equal(await main([process.execPath, '-e', 'process.exit(6)'], { base, stderr: sink(), signals: new EventEmitter() }), 6);
    assert.equal(existsSync(base), true);
    assert.deepEqual(readdirSync(base), []);
  });

  test('as a program, exits with the run\'s code and prints what was left', () => {
    const base = scratch();
    const r = spawnSync(process.execPath, [SCRIPT, process.execPath, '-e', `require('node:fs').writeFileSync(require('node:os').tmpdir() + '/left', '')`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, TMPDIR: base },
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /left 1 path in its TMPDIR:\n {2}\S+\/left\n/);
    assert.deepEqual(readdirSync(base), []);
  });
});
