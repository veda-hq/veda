import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FORWARDED, NOT_STARTED, PREFIX, TMPDIR_KEYS, entry, exitCode, leftovers, main, run, tmpEnv, verdict } from './fresh-tmpdir.mjs';

const SCRIPT = fileURLToPath(new URL('fresh-tmpdir.mjs', import.meta.url));
/** Long enough for a real child under load; a run that never settles fails here, not at Stryker's timeout. */
const REAL = { timeout: 10_000 };

// One turn of the event loop before each test lets the TAP line of a failed
// test reach stdout at once, so Stryker's tap runner bails on a mutant's first
// failure instead of running the whole file.
beforeEach(() => new Promise(resolve => setImmediate(resolve)));

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

/**
 * A child process of the test's own: one that started has a pid, one that
 * never started has none. It records each signal it is sent; the test ends it
 * by emitting 'close'.
 */
function fakeChild({ started = true } = {}) {
  const sent = [];
  return Object.assign(new EventEmitter(), { pid: started ? 4242 : undefined, sent, kill: signal => sent.push(signal) });
}

/** A spawn that records each call and hands back `child`. */
function fakeSpawn(child) {
  const calls = [];
  return { calls, spawn: (...args) => (calls.push(args), child) };
}

/** A remove that records each directory and removes it: always the run's own, under a scratch root. */
function recordedRemove() {
  const removed = [];
  return { removed, remove: dir => (removed.push(dir), rmSync(dir, { recursive: true, force: true })) };
}

/**
 * What `pending` has settled to by the next turn of the event loop, or
 * 'pending'. A fake child ends a run synchronously, so a run that is still
 * pending then never settles.
 */
function settled(pending) {
  return Promise.race([pending.then(value => ({ value }), error => ({ error })), new Promise(resolve => setImmediate(() => resolve('pending')))]);
}

/** Start a run of `command` on a fake child, in a scratch base, with every effect recorded. */
function fakeRun(command, { started = true, env = { PATH: '/bin' }, signals = new EventEmitter(), stderr = sink(), read } = {}) {
  const base = scratch();
  const child = fakeChild({ started });
  const { calls, spawn } = fakeSpawn(child);
  const { removed, remove } = recordedRemove();
  const pending = run(command, { env, base, stderr, signals, spawn, remove, ...(read ? { read } : {}) });
  return { base, child, calls, removed, stderr, signals, pending };
}

/**
 * `program`, run only when its temp directory is a run's own under `base`. A
 * mutant that hands the child the real temp directory, or none, must not let
 * it write or remove anything there: the child exits 9 first.
 */
function guarded(base, program) {
  return `if (require('node:path').dirname(require('node:os').tmpdir()) !== ${JSON.stringify(base)}) process.exit(9); ${program}`;
}

/** Run a Node program under the wrapper, in this process, with `base` as the parent temp directory. */
async function runNode(program, { base = scratch(), env = {}, signals = new EventEmitter() } = {}) {
  const stderr = sink();
  const code = await run([process.execPath, '-e', guarded(base, program)], { env: { PATH: process.env.PATH, ...env }, base, stderr, signals });
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

describe('run, on a fake child', () => {
  test('spawns the command with inherited stdio and every temp variable at a fresh directory, removed after', async () => {
    const { base, calls, removed, child, stderr, pending } = fakeRun(['cmd', 'a', 'b'], { env: { PATH: '/bin', TMPDIR: '/elsewhere' } });
    const [dir] = readdirSync(base);
    assert.ok(dir.startsWith('vt-'), dir);
    const made = join(base, dir);
    assert.deepEqual(calls, [['cmd', ['a', 'b'], { stdio: 'inherit', env: { PATH: '/bin', TMPDIR: made, TEMP: made, TMP: made } }]]);
    assert.equal(await settled(pending), 'pending');
    child.emit('close', 0, null);
    assert.deepEqual(await settled(pending), { value: 0 });
    assert.deepEqual(removed, [made]);
    assert.deepEqual(readdirSync(base), []);
    assert.deepEqual(stderr.lines, []);
  });

  test('passes each of SIGINT, SIGTERM, SIGHUP and SIGQUIT on to the command, until it ends', async () => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
    assert.deepEqual(FORWARDED, signals);
    const started = fakeRun(['cmd']);
    for (const signal of signals) assert.equal(started.signals.listenerCount(signal), 1, signal);
    for (const signal of signals) started.signals.emit(signal);
    assert.deepEqual(started.child.sent, signals);
    started.child.emit('close', null, 'SIGHUP');
    assert.deepEqual(await settled(started.pending), { value: 128 + constants.signals.SIGHUP });
    for (const signal of signals) assert.equal(started.signals.listenerCount(signal), 0, `${signal} handler removed`);
    started.signals.emit('SIGTERM');
    assert.deepEqual(started.child.sent, signals);
  });

  test('a signal that comes before the command is spawned is dropped', async () => {
    const heard = [];
    const signals = { on: (name, handler) => (heard.push(name), handler()), off: () => {} };
    const { child, pending } = fakeRun(['cmd'], { signals });
    assert.deepEqual(heard, ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']);
    assert.deepEqual(child.sent, []);
    child.emit('close', 0, null);
    assert.deepEqual(await settled(pending), { value: 0 });
  });

  test('an error from a command that started is printed, and the run ends with its own close', async () => {
    const { child, stderr, removed, pending } = fakeRun(['cmd']);
    child.emit('error', new Error('kill EPERM'));
    assert.deepEqual(stderr.lines, ['fresh-tmpdir: cmd: kill EPERM\n']);
    assert.equal(await settled(pending), 'pending');
    assert.deepEqual(removed, []);
    child.emit('close', 5, null);
    assert.deepEqual(await settled(pending), { value: 5 });
    assert.equal(removed.length, 1);
  });

  test('a command that never started exits 127, and the close after it changes nothing', async () => {
    const { child, stderr, removed, pending } = fakeRun(['cmd'], { started: false });
    child.emit('error', new Error('spawn cmd ENOENT'));
    assert.deepEqual(await settled(pending), { value: 127 });
    assert.equal(NOT_STARTED, 127);
    child.emit('close', -2, null);
    assert.deepEqual(stderr.lines, ['fresh-tmpdir: cmd: spawn cmd ENOENT\n']);
    assert.equal(removed.length, 1);
  });

  test('a second close changes nothing', async () => {
    const { child, stderr, removed, pending } = fakeRun(['cmd']);
    child.emit('close', 3, null);
    child.emit('close', 0, null);
    assert.deepEqual(await settled(pending), { value: 3 });
    assert.deepEqual(stderr.lines, []);
    assert.equal(removed.length, 1);
  });

  test('a directory it cannot read fails the run, and is still removed', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const read = () => {
      throw denied;
    };
    const { base, child, removed, pending } = fakeRun(['cmd'], { read });
    child.emit('close', 0, null);
    assert.deepEqual(await settled(pending), { error: denied });
    assert.equal(removed.length, 1);
    assert.deepEqual(readdirSync(base), []);
  });

  test('output it cannot print fails the run with that error, and the directory is still removed', async () => {
    const broken = new Error('EPIPE: broken pipe');
    const stderr = {
      write: () => {
        throw broken;
      },
    };
    const { base, child, removed, pending } = fakeRun(['cmd'], { stderr, read: () => ['left'] });
    child.emit('close', 0, null);
    assert.deepEqual(await settled(pending), { error: broken });
    assert.equal(removed.length, 1);
    assert.deepEqual(readdirSync(base), []);
  });
});

describe('run', () => {
  test('the command sees a fresh, empty directory in every temp variable, removed after', REAL, async () => {
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

  test('a passing command that leaves a folder fails and names it', REAL, async () => {
    const { code, base, stderr } = await runNode(`require('node:fs').mkdirSync(require('node:path').join(require('node:os').tmpdir(), 'leak'));`);
    assert.equal(code, 1);
    assert.match(stderr, leftOne(base, 'leak'));
    assert.deepEqual(readdirSync(base), [], 'the directory is removed with what was left in it');
  });

  test('a failing command keeps its code and still names what it left', REAL, async () => {
    const { code, base, stderr } = await runNode(`require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'a'), ''); process.exit(3);`);
    assert.equal(code, 3);
    assert.match(stderr, leftOne(base, 'a'));
  });

  test('a command that removes its own directory fails', REAL, async () => {
    const { code, stderr } = await runNode(`require('node:fs').rmSync(require('node:os').tmpdir(), { recursive: true });`);
    assert.equal(code, 1);
    assert.match(stderr, /was removed or replaced during the run/);
  });

  test('a command that replaces its directory with a file fails, and the file is removed', REAL, async () => {
    const { code, base, stderr } = await runNode(`const fs = require('node:fs'); const d = require('node:os').tmpdir(); fs.rmSync(d, { recursive: true }); fs.writeFileSync(d, '');`);
    assert.equal(code, 1);
    assert.match(stderr, /was removed or replaced during the run/);
    assert.deepEqual(readdirSync(base), []);
  });

  test('a directory it cannot remove fails the run, after naming what was left', REAL, async () => {
    const base = scratch();
    const stderr = sink();
    const busy = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    const tried = [];
    const remove = dir => {
      tried.push(dir);
      throw busy;
    };
    const program = guarded(base, `require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'stuck'), '')`);
    await assert.rejects(run([process.execPath, '-e', program], { base, stderr, signals: new EventEmitter(), remove }), error => error === busy);
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
    const { calls, spawn } = fakeSpawn(fakeChild());
    assert.throws(() => run(['cmd'], { base: join(scratch(), 'missing'), stderr: sink(), signals, spawn }), { code: 'ENOENT' });
    assert.deepEqual(calls, []);
    for (const signal of FORWARDED) assert.equal(signals.listenerCount(signal), 0, signal);
  });

  test('a command a signal ends exits as a shell gives it', REAL, async () => {
    const { code, stderr } = await runNode(`process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5_000);`);
    assert.equal(code, 128 + constants.signals.SIGTERM, stderr);
  });

  test('a signal to the run goes on to the command, and the directory is still removed', REAL, async () => {
    const base = scratch();
    const signals = new EventEmitter();
    const pending = runNode(`setTimeout(() => {}, 5_000);`, { base, signals });
    for (const signal of FORWARDED) assert.equal(signals.listenerCount(signal), 1, signal);
    signals.emit('SIGTERM');
    const { code } = await pending;
    assert.equal(code, 128 + constants.signals.SIGTERM);
    for (const signal of FORWARDED) assert.equal(signals.listenerCount(signal), 0, `${signal} handler removed`);
    assert.deepEqual(readdirSync(base), []);
  });

  test('a command that cannot start exits 127 and its directory is removed', REAL, async () => {
    const base = scratch();
    const stderr = sink();
    const command = join(base, 'no-such-command');
    const code = await run([command], { base, stderr, signals: new EventEmitter() });
    assert.equal(code, 127);
    // Node's 'close' after the 'error' prints nothing more.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(stderr.lines, [`fresh-tmpdir: ${command}: spawn ${command} ENOENT\n`]);
    assert.deepEqual(readdirSync(base), []);
  });
});

describe('main', () => {
  test('refuses an empty command line with 2', async () => {
    const stderr = sink();
    assert.equal(await main([], { stderr }), 2);
    assert.match(stderr.lines.join(''), /^usage: fresh-tmpdir\.mjs <command>/);
  });

  test('runs the command', REAL, async () => {
    const base = scratch();
    assert.equal(await main([process.execPath, '-e', 'process.exit(6)'], { base, stderr: sink(), signals: new EventEmitter() }), 6);
    assert.equal(existsSync(base), true);
    assert.deepEqual(readdirSync(base), []);
  });

  test('as a program, exits with the run\'s code and prints what was left', REAL, () => {
    const base = scratch();
    const r = spawnSync(process.execPath, [SCRIPT, process.execPath, '-e', guarded(base, `require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'left'), '')`)], {
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

describe('entry', () => {
  const url = pathToFileURL(SCRIPT).href;
  /** Every effect of a run faked, so a mutant that runs main where it should not touches nothing real. */
  function fakes() {
    const child = fakeChild();
    const { calls, spawn } = fakeSpawn(child);
    const stderr = sink();
    return { child, calls, stderr, options: { base: scratch(), stderr, signals: new EventEmitter(), spawn, remove: recordedRemove().remove } };
  }

  test('runs main on the arguments after the script when the script is this module', async () => {
    const { child, calls, options } = fakes();
    const pending = entry(['node', SCRIPT, 'cmd', 'x'], url, options);
    assert.deepEqual(calls.map(([command, args]) => [command, args]), [['cmd', ['x']]]);
    child.emit('close', 6, null);
    assert.equal(await pending, 6);
  });

  test('is undefined when the script is another module, or there is none', () => {
    const { calls, stderr, options } = fakes();
    assert.equal(entry(['node', '/elsewhere/other.mjs'], url, options), undefined);
    assert.equal(entry(['node'], url, options), undefined);
    assert.deepEqual(calls, []);
    assert.deepEqual(stderr.lines, []);
  });
});
