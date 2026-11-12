// The python-floor wrapper: the arguments it hands the script, the exit codes it
// passes through, and the runs that never reach the script.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run, type Io } from './cli.ts';
import { inheritRunner, runPythonFloor, SCRIPT, scriptArgs, type PythonRunner, type Spawned } from './python-floor.ts';

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const capture = (python?: PythonRunner) => {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), ...(python === undefined ? {} : { python }) };
  return { io, out, err };
};

/** A runner that records its call and answers `result`. */
const fake = (result: Spawned) => {
  const calls: { python: string; args: readonly string[] }[] = [];
  const runner: PythonRunner = (python, args) => {
    calls.push({ python, args });
    return result;
  };
  return { runner, calls };
};

describe('the packaged script', () => {
  it('sits in a folder the npm package ships', () => {
    assert.ok(existsSync(SCRIPT), SCRIPT);
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { files: string[] };
    assert.ok(pkg.files.includes('python'));
    assert.equal(SCRIPT, join(import.meta.dirname, '..', 'python', 'python-floor.py'));
  });
});

describe('scriptArgs', () => {
  it('names the script and the floor file, adding --root, --exclude and --selector only when given', () => {
    assert.deepEqual(scriptArgs({ python: 'py', floorFile: 'floor' }), [SCRIPT, '--floor-file', 'floor']);
    assert.deepEqual(scriptArgs({ python: 'py', floorFile: 'floor', root: '/r', exclude: '^x/', selector: 'pick.sh' }), [SCRIPT, '--floor-file', 'floor', '--root', '/r', '--exclude', '^x/', '--selector', 'pick.sh']);
  });
});

describe('runPythonFloor', () => {
  it("returns the script's exit code, whatever it is, and says nothing of its own", () => {
    for (const status of [0, 1, 2, 7]) {
      const { runner, calls } = fake({ status, signal: null });
      const err: string[] = [];
      assert.equal(runPythonFloor({ python: '/usr/bin/py', floorFile: 'f' }, runner, (l) => err.push(l)), status);
      assert.deepEqual(calls, [{ python: '/usr/bin/py', args: [SCRIPT, '--floor-file', 'f'] }]);
      assert.deepEqual(err, []);
    }
  });

  it('fails, never passes, when the interpreter cannot be started', () => {
    const { runner } = fake({ status: null, signal: null, error: new Error('spawn nope ENOENT') });
    const err: string[] = [];
    assert.equal(runPythonFloor({ python: 'nope', floorFile: 'f' }, runner, (l) => err.push(l)), 2);
    assert.deepEqual(err, ['pariksha python-floor: cannot run nope: spawn nope ENOENT; nothing was checked, so this is not a pass']);
  });

  it('fails, never passes, when the interpreter is stopped by a signal', () => {
    const { runner } = fake({ status: null, signal: 'SIGKILL' });
    const err: string[] = [];
    assert.equal(runPythonFloor({ python: 'py', floorFile: 'f' }, runner, (l) => err.push(l)), 2);
    assert.deepEqual(err, ['pariksha python-floor: py was stopped by SIGKILL; nothing was checked, so this is not a pass']);
  });
});

describe('inheritRunner', () => {
  it('runs the named interpreter on the arguments and reports its exit code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pariksha-python-runner-'));
    made.push(dir);
    const script = join(dir, 'exit.js');
    writeFileSync(script, 'process.exitCode = Number(process.argv[2]);\n');
    const done = inheritRunner(process.execPath, [script, '5']);
    assert.equal(done.status, 5);
    assert.equal(done.signal, null);
    assert.equal(done.error, undefined);
  });

  it('reports an interpreter that does not exist as an error', () => {
    const done = inheritRunner(join(tmpdir(), 'pariksha-no-such-python'), []);
    assert.equal(done.status, null);
    assert.match(String(done.error?.message), /ENOENT/);
  });
});

describe('pariksha python-floor', () => {
  it('hands the runner the interpreter and every given option, and returns its code', () => {
    const { runner, calls } = fake({ status: 1, signal: null });
    const c = capture(runner);
    assert.equal(run(['python-floor', '--python', 'python3.11', '--selector', 'pick.sh', '--floor-file', 'scripts/lib/python-floor', '--exclude', '^old/', '--root', 'repo'], c.io), 1);
    assert.deepEqual(calls, [{ python: 'python3.11', args: [SCRIPT, '--floor-file', 'scripts/lib/python-floor', '--root', 'repo', '--exclude', '^old/', '--selector', 'pick.sh'] }]);
    assert.deepEqual([c.out, c.err], [[], []]);
  });

  it('passes no --root, --exclude or --selector it was not given', () => {
    const { runner, calls } = fake({ status: 0, signal: null });
    assert.equal(run(['python-floor', '--floor-file', 'f', '--python', 'py'], capture(runner).io), 0);
    assert.deepEqual(calls[0]?.args, [SCRIPT, '--floor-file', 'f']);
  });

  it('prints the usage and runs nothing without --python or --floor-file, or with an unknown flag', () => {
    for (const args of [['--floor-file', 'f'], ['--python', 'py'], ['--python', 'py', '--floor-file', 'f', '--floor', '3.9'], ['--python', '', '--floor-file', 'f']]) {
      const { runner, calls } = fake({ status: 0, signal: null });
      const c = capture(runner);
      assert.equal(run(['python-floor', ...args], c.io), 2, args.join(' '));
      assert.equal(calls.length, 0);
      assert.match(c.err.join('\n'), /pariksha python-floor --python <interpreter> --floor-file <path> \[--exclude <regex>\] \[--selector <path>\] \[--root <dir>\]/);
    }
  });
});
