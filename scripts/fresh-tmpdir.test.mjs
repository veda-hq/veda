import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
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
  // A space in the name: a run's paths are reported, and matched, with any characters a TMPDIR holds.
  const root = mkdtempSync(join(tmpdir(), 'fresh tmpdir test-'));
  roots.push(root);
  return root;
}

/** A sink for what a run prints. */
function sink() {
  const lines = [];
  return { lines, write: text => lines.push(text) };
}

/**
 * The report of one path left in a run's directory under `base`, matched
 * exactly: any characters `base` holds, the run's own `vt-*` name, then `name`.
 */
function leftOne(base, name) {
  const dir = `${RegExp.escape(join(base, PREFIX))}[^${RegExp.escape(sep)}]+`;
  return new RegExp(`left 1 path in its TMPDIR:\\n {2}${dir}${RegExp.escape(sep + name)}\\n`);
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
    assert.deepEqual(leftovers('/d', () => ['b', 'a']), [join('/d', 'a'), join('/d', 'b')]);
  });
  test('is undefined when the directory is gone', () => {
    assert.equal(leftovers(join(scratch(), 'gone')), undefined);
  });
  test('is undefined when the directory is no longer one', () => {
    const notDir = Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    assert.equal(leftovers('/d', () => { throw notDir; }), undefined);
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
    assert.match(message, /TMPDIR \/d was removed or replaced during the run/);
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
    const { code, base, stderr } = await runNode(`require('node:fs').mkdirSync(require('node:path').join(require('node:os').tmpdir(), 'leak'));`);
    assert.equal(code, 1);
    assert.match(stderr, leftOne(base, 'leak'));
    assert.deepEqual(readdirSync(base), [], 'the directory is removed with what was left in it');
  });

  test('a failing command keeps its code and still names what it left', async () => {
    const { code, base, stderr } = await runNode(`require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'a'), ''); process.exit(3);`);
    assert.equal(code, 3);
    assert.match(stderr, leftOne(base, 'a'));
  });

  test('a command that removes its own directory fails', async () => {
    const { code, stderr } = await runNode(`require('node:fs').rmSync(require('node:os').tmpdir(), { recursive: true });`);
    assert.equal(code, 1);
    assert.match(stderr, /was removed or replaced during the run/);
  });

  test('a command that replaces its directory with a file fails, and the file is removed', async () => {
    const { code, base, stderr } = await runNode(`const fs = require('node:fs'); const d = require('node:os').tmpdir(); fs.rmSync(d, { recursive: true }); fs.writeFileSync(d, '');`);
    assert.equal(code, 1);
    assert.match(stderr, /was removed or replaced during the run/);
    assert.deepEqual(readdirSync(base), []);
  });

  test('a directory it cannot read fails the run, and is still removed', async () => {
    const base = scratch();
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const read = () => {
      throw denied;
    };
    await assert.rejects(run([process.execPath, '-e', ''], { base, stderr: sink(), signals: new EventEmitter(), read }), error => {
      assert.match(error.message, /^fresh-tmpdir: cannot read or remove the run's TMPDIR /);
      assert.equal(error.cause, denied);
      return true;
    });
    assert.deepEqual(readdirSync(base), []);
  });

  test('a directory it cannot remove fails the run, after naming what was left', async () => {
    const base = scratch();
    const stderr = sink();
    const busy = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    const tried = [];
    const remove = dir => {
      tried.push(dir);
      throw busy;
    };
    const program = `require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'stuck'), '')`;
    await assert.rejects(run([process.execPath, '-e', program], { base, stderr, signals: new EventEmitter(), remove }), error => {
      assert.match(error.message, /^fresh-tmpdir: cannot read or remove the run's TMPDIR /);
      assert.equal(error.cause, busy);
      return true;
    });
    assert.match(stderr.lines.join(''), leftOne(base, 'stuck'));
    assert.equal(tried.length, 1);
    rmSync(tried[0], { recursive: true, force: true });
  });

  test('when spawn refuses the command, it throws and leaves no directory or handler behind', () => {
    const base = scratch();
    const signals = new EventEmitter();
    assert.throws(() => run([process.execPath, 'nul\0byte'], { base, stderr: sink(), signals }), { code: 'ERR_INVALID_ARG_VALUE' });
    assert.deepEqual(readdirSync(base), []);
    for (const signal of FORWARDED) assert.equal(signals.listenerCount(signal), 0, signal);
  });

  test('when the directory cannot be made, it throws and leaves no handler behind', () => {
    const signals = new EventEmitter();
    assert.throws(() => run([process.execPath], { base: join(scratch(), 'missing'), signals }), { code: 'ENOENT' });
    for (const signal of FORWARDED) assert.equal(signals.listenerCount(signal), 0, signal);
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
    const r = spawnSync(process.execPath, [SCRIPT, process.execPath, '-e', `require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'left'), '')`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, TMPDIR: base },
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, leftOne(base, 'left'));
    assert.deepEqual(readdirSync(base), []);
  });
});
