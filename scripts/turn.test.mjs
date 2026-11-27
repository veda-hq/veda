import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FIRST_WITH_TURN, FORWARDED, NOT_STARTED, USAGE, atLeast, dvaraWithTurn, entry, exitCode, main, parse, plan } from './turn.mjs';

const SCRIPT = fileURLToPath(new URL('turn.mjs', import.meta.url));
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

/** A scratch directory with `@veda-hq/dvara` installed at `version`, its CLI at `bin`. */
function installed(version, bin = 'dist/cli.js') {
  // Real, so resolution's answer (through macOS's /var → /private/var) matches it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'turn test-')));
  roots.push(root);
  const pkg = join(root, 'node_modules', '@veda-hq', 'dvara');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@veda-hq/dvara', version, bin: { dvara: bin }, exports: { './package.json': './package.json' } }));
  return { root, pkg };
}

/** A sink for what a run prints. */
function sink() {
  const lines = [];
  return { lines, write: text => lines.push(text) };
}

/** A child of the test's own: it records each signal sent; the test ends it by emitting 'close'. */
function fakeChild({ started = true } = {}) {
  const sent = [];
  return Object.assign(new EventEmitter(), { pid: started ? 4242 : undefined, sent, kill: signal => sent.push(signal) });
}

/**
 * What `pending` settled to by the next turn of the event loop, or 'pending'.
 * A fake child ends a run synchronously, so a run still pending then never
 * settles: the test fails at once instead of hanging to Stryker's limit.
 */
function settled(pending) {
  return Promise.race([pending, new Promise(resolve => setImmediate(() => resolve('pending')))]);
}

/** Start `main` on a fake child, with every effect recorded. */
function start(argv, { cli = null, started = true } = {}) {
  const child = fakeChild({ started });
  const calls = [];
  const signals = new EventEmitter();
  const stderr = sink();
  const looked = [];
  const env = { KEEP: 'x' };
  const status = main(argv, {
    from: '/veda/scripts',
    node: '/bin/node',
    env,
    stderr,
    signals,
    spawn: (...args) => (calls.push(args), child),
    find: from => (looked.push(from), cli),
  });
  return { child, calls, signals, stderr, looked, env, status };
}

describe('atLeast', () => {
  test('compares each part in turn, as numbers', () => {
    assert.equal(atLeast('0.8.19', [0, 8, 19]), true);
    assert.equal(atLeast('0.8.20', [0, 8, 19]), true);
    assert.equal(atLeast('0.8.18', [0, 8, 19]), false);
    assert.equal(atLeast('0.9.0', [0, 8, 19]), true);
    assert.equal(atLeast('1.0.0', [0, 8, 19]), true);
    assert.equal(atLeast('0.8.17', [0, 8, 19]), false);
    assert.equal(atLeast('0.8.9', [0, 8, 19]), false);
    assert.equal(atLeast('0.7.99', [0, 8, 19]), false);
  });

  test('names 0.8.19 as the first release with turn', () => {
    assert.deepEqual(FIRST_WITH_TURN, [0, 8, 19]);
    assert.ok(Object.isFrozen(FIRST_WITH_TURN));
  });
});

describe('dvaraWithTurn', () => {
  test("gives the installed dvara's CLI when it has turn", () => {
    const { root, pkg } = installed('0.8.19');
    assert.equal(dvaraWithTurn(root), join(pkg, 'dist/cli.js'));
  });

  test('gives null for a dvara older than turn', () => {
    const { root } = installed('0.8.15');
    assert.equal(dvaraWithTurn(root), null);
  });

  test('gives null when no dvara is installed, or its manifest cannot be read', () => {
    const empty = mkdtempSync(join(tmpdir(), 'turn test-'));
    roots.push(empty);
    assert.equal(dvaraWithTurn(empty), null);
    const { root } = installed('0.8.19');
    assert.equal(
      dvaraWithTurn(root, () => '{'),
      null,
    );
  });

  test('reads the manifest it resolved', () => {
    const { root, pkg } = installed('0.8.15');
    const read = [];
    const cli = dvaraWithTurn(root, path => (read.push(path), JSON.stringify({ version: '0.9.0', bin: { dvara: 'x.js' } })));
    assert.deepEqual(read, [join(pkg, 'package.json')]);
    assert.equal(cli, join(pkg, 'x.js'));
  });

  test("resolves veda's own pin from beside the script by default", () => {
    const status = start(['--label', 'l', '--', 'true']);
    assert.deepEqual(status.looked, ['/veda/scripts']);
    const child = fakeChild();
    let looked;
    main(['--label', 'l', '--', 'true'], { signals: new EventEmitter(), spawn: () => child, find: from => ((looked = from), null) });
    assert.equal(looked, fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, ''));
    child.emit('close', 0, null);
  });
});

describe('plan', () => {
  test("wraps the command in dvara's turn when there is one", () => {
    assert.deepEqual(plan('/d/cli.js', 'veda check', ['pnpm', 'check:run'], '/bin/node'), [
      '/bin/node',
      '/d/cli.js',
      'turn',
      '--label',
      'veda check',
      '--',
      'pnpm',
      'check:run',
    ]);
  });

  test('runs the command alone without one, as a copy', () => {
    const command = ['tsc', '-p', 'tsconfig.json'];
    const planned = plan(null, 'x', command, '/bin/node');
    assert.deepEqual(planned, command);
    assert.notEqual(planned, command);
  });
});

describe('exitCode', () => {
  test("is the code, or 128 plus the signal's number", () => {
    assert.equal(exitCode(0, null), 0);
    assert.equal(exitCode(3, null), 3);
    assert.equal(exitCode(null, 'SIGTERM'), 143);
    assert.equal(exitCode(null, 'SIGINT'), 130);
  });
});

describe('parse', () => {
  test('reads a label and the command after --', () => {
    assert.deepEqual(parse(['--label', 'veda check', '--', 'pnpm', 'check:run']), { label: 'veda check', command: ['pnpm', 'check:run'] });
  });

  test('refuses anything else', () => {
    for (const argv of [
      [],
      ['--label'],
      ['--label', 'x'],
      ['--label', 'x', '--'],
      ['--label', '', '--', 'cmd'],
      ['--label', '  ', '--', 'cmd'],
      ['--lab', 'x', '--', 'cmd'],
      ['--label', 'x', '-', 'cmd'],
      ['x', '--label', '--', 'cmd'],
    ])
      assert.equal(parse(argv), undefined, JSON.stringify(argv));
  });
});

describe('main', () => {
  test('refuses bad arguments with its usage, running nothing', async () => {
    const run = start(['--label']);
    assert.equal(await settled(run.status), 2);
    assert.deepEqual(run.stderr.lines, [`${USAGE}\n`]);
    assert.equal(USAGE, 'usage: turn.mjs --label <text> -- <command> [args…]');
    assert.deepEqual(run.calls, []);
    assert.deepEqual(run.looked, []);
  });

  test("runs the command in dvara's turn, with the environment, and exits with its code", async () => {
    const run = start(['--label', 'veda check', '--', 'pnpm', 'check:run'], { cli: '/d/cli.js' });
    assert.deepEqual(run.calls, [['/bin/node', ['/d/cli.js', 'turn', '--label', 'veda check', '--', 'pnpm', 'check:run'], { stdio: 'inherit', env: run.env }]]);
    assert.equal(run.calls[0][2].env, run.env);
    run.child.emit('close', 7, null);
    assert.equal(await settled(run.status), 7);
    assert.deepEqual(run.stderr.lines, []);
  });

  test('runs the command directly when dvara has no turn', async () => {
    const run = start(['--label', 'x', '--', 'tsc', '-p', 'tsconfig.json']);
    assert.deepEqual(run.calls[0].slice(0, 2), ['tsc', ['-p', 'tsconfig.json']]);
    run.child.emit('close', null, 'SIGTERM');
    assert.equal(await settled(run.status), 143);
  });

  test('forwards each signal to the command while it runs, and none after', async () => {
    const run = start(['--label', 'x', '--', 'cmd']);
    assert.deepEqual(FORWARDED, ['SIGINT', 'SIGTERM', 'SIGHUP']);
    assert.ok(Object.isFrozen(FORWARDED));
    for (const signal of FORWARDED) run.signals.emit(signal);
    assert.deepEqual(run.child.sent, FORWARDED);
    run.child.emit('close', 0, null);
    assert.equal(await settled(run.status), 0);
    for (const signal of FORWARDED) assert.equal(run.signals.listenerCount(signal), 0, signal);
  });

  test('a command that cannot start is 127, and says why', async () => {
    const run = start(['--label', 'x', '--', 'nope'], { started: false });
    run.child.emit('error', new Error('spawn nope ENOENT'));
    assert.equal(await settled(run.status), NOT_STARTED);
    assert.equal(NOT_STARTED, 127);
    assert.deepEqual(run.stderr.lines, ['turn.mjs: nope: spawn nope ENOENT\n']);
    for (const signal of FORWARDED) assert.equal(run.signals.listenerCount(signal), 0, signal);
  });

  test('an error from a command that started leaves its exit to close', async () => {
    const run = start(['--label', 'x', '--', 'cmd']);
    run.child.emit('error', new Error('kill EPERM'));
    run.child.emit('close', 5, null);
    assert.equal(await settled(run.status), 5);
    assert.deepEqual(run.stderr.lines, ['turn.mjs: cmd: kill EPERM\n']);
  });
});

describe('entry', () => {
  test('runs main only as the script node was given', async () => {
    const child = fakeChild();
    const options = { signals: new EventEmitter(), spawn: () => child, find: () => null };
    const url = pathToFileURL(SCRIPT).href;
    assert.equal(entry(['node', '/elsewhere.mjs', '--label', 'x', '--', 'c'], url, options), undefined);
    assert.equal(entry(['node'], url, options), undefined);
    const status = entry(['node', SCRIPT, '--label', 'x', '--', 'c'], url, options);
    child.emit('close', 4, null);
    assert.equal(await settled(status), 4);
  });

  test('as a real process, exits with the command it ran', REAL, () => {
    // veda's pinned dvara may take a turn for it: in a queue of the test's own, never the machine's.
    const queue = realpathSync(mkdtempSync(join(tmpdir(), 'turn test-')));
    roots.push(queue);
    const env = { ...process.env, DVARA_TURN_DIR: queue };
    const ran = spawnSync(process.execPath, [SCRIPT, '--label', 'x', '--', process.execPath, '-e', 'process.exit(3)'], { encoding: 'utf8', env });
    assert.equal(ran.status, 3, ran.stderr);
    const bad = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.equal(bad.stderr, `${USAGE}\n`);
  });

  test("as a real process, runs the command in an installed dvara's turn", REAL, () => {
    const { root, pkg } = installed('0.8.19');
    mkdirSync(join(pkg, 'dist'));
    // A stand-in dvara: prints the arguments it got, then exits 6.
    writeFileSync(join(pkg, 'dist', 'cli.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(6);');
    const program = `import { main } from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; process.exitCode = await main(process.argv.slice(1), { from: ${JSON.stringify(root)} });`;
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', program, '--', '--label', 'x', '--', 'cmd', 'a'], { encoding: 'utf8' });
    assert.equal(ran.status, 6, ran.stderr);
    assert.deepEqual(JSON.parse(ran.stdout), ['turn', '--label', 'x', '--', 'cmd', 'a']);
  });
});
