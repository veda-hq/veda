import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { expect, it, vi } from '../test/expect.test.ts';
import { STDERR_TAIL_BYTES, appendTail, classifyChildExit, failure, runChild, signalExitCode, type ChildExitFacts } from './run-child.ts';

const facts = (over: Partial<ChildExitFacts>): ChildExitFacts => ({
  code: null,
  signal: null,
  spawnError: null,
  timedOut: false,
  timeoutMs: 0,
  stdout: 'out',
  stderrTail: 'err',
  ...over,
});

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`spawn x ${code}`), { code });

/**
 * Is `pid` still running? A killed orphan can linger as a zombie until init
 * reaps it, so "running" means signalable and not in state Z.
 */
const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    // fail-open: ESRCH means gone, which is the answer.
    return false;
  }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return ps.status !== 0 || !ps.stdout.trim().startsWith('Z');
};

/** Polls until `pid` stops, or `ms` passes; true when it stopped. */
async function stopsWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (running(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

describe('classifyChildExit', () => {
  it.each([
    ['exit 0 is ok', facts({ code: 0 }), 'ok', 0],
    ['a non-zero code is exit', facts({ code: 3 }), 'exit', 3],
    ['no code and no signal is exit 1', facts({}), 'exit', 1],
    ['SIGTERM is 143', facts({ signal: 'SIGTERM' }), 'signal', 143],
    // SIGINT and SIGHUP must not collapse into 143.
    ['SIGINT is 130', facts({ signal: 'SIGINT' }), 'signal', 130],
    ['SIGHUP is 129', facts({ signal: 'SIGHUP' }), 'signal', 129],
    ['SIGKILL is 137', facts({ signal: 'SIGKILL' }), 'signal', 137],
    ['a signal beats a code', facts({ code: 0, signal: 'SIGINT' }), 'signal', 130],
    ['a trapped SIGTERM exiting 0 is still a timeout', facts({ code: 0, timedOut: true, timeoutMs: 50 }), 'timeout', 124],
    ['a timeout beats the kill signal it caused', facts({ signal: 'SIGKILL', timedOut: true }), 'timeout', 124],
    ['ENOENT is 127', facts({ spawnError: errno('ENOENT') }), 'spawn-error', 127],
    ['EAGAIN is 126', facts({ spawnError: errno('EAGAIN') }), 'spawn-error', 126],
    ['EACCES is 126', facts({ spawnError: errno('EACCES') }), 'spawn-error', 126],
    ['a spawn error beats a timeout', facts({ spawnError: errno('ENOENT'), timedOut: true }), 'spawn-error', 127],
  ] as const)('%s', (_title, input, kind, code) => {
    const outcome = classifyChildExit(input);
    expect(outcome.kind).toBe(kind);
    expect(outcome.code).toBe(code);
    expect(outcome.stderrTail).toBe('err');
  });

  test('names the errno and keeps the message of a spawn error', () => {
    expect(classifyChildExit(facts({ spawnError: errno('EAGAIN') }))).toMatchObject({ errno: 'EAGAIN', message: 'spawn x EAGAIN' });
  });

  test('reports an errno-less spawn error as UNKNOWN, 126', () => {
    expect(classifyChildExit(facts({ spawnError: new Error('odd') }))).toMatchObject({ kind: 'spawn-error', errno: 'UNKNOWN', code: 126 });
  });
});

describe('signalExitCode', () => {
  test('adds the platform signal number to 128', () => {
    expect(signalExitCode('SIGQUIT')).toBe(131);
  });

  test('falls back to 128 for a name the platform does not know', () => {
    expect(signalExitCode('SIGNOPE' as NodeJS.Signals)).toBe(128);
  });
});

describe('failure', () => {
  const base = { stdout: '', stderrTail: '' };
  test('names how a child ended, with the last stderr line', () => {
    expect(failure({ ...base, kind: 'exit', code: 2, stderrTail: 'a\nconflict\n' })).toBe('exit 2: conflict');
    expect(failure({ ...base, kind: 'signal', signal: 'SIGTERM', code: 143 })).toBe('signal SIGTERM');
    expect(failure({ ...base, kind: 'timeout', timeoutMs: 5, code: 124 })).toBe('timed out after 5 ms');
    expect(failure({ ...base, kind: 'spawn-error', errno: 'ENOENT', message: 'spawn x ENOENT', code: 127 })).toBe('spawn x ENOENT');
  });
});

describe('appendTail', () => {
  test('keeps everything under the limit', () => {
    expect(appendTail('ab', 'cd', 10)).toBe('abcd');
  });

  test('keeps only the last bytes over the limit', () => {
    expect(appendTail('abcdef', 'gh', 4)).toBe('efgh');
  });

  test('counts UTF-8 bytes, not UTF-16 units', () => {
    // 'é' is 2 bytes: 3 of them are 6 bytes, over a 4-byte limit.
    expect(appendTail('', 'ééé', 4)).toBe('éé');
    expect(Buffer.byteLength(appendTail('', '日本語', 5))).toBeLessThanOrEqual(5);
  });

  test('never starts mid-character', () => {
    // 'a' + '€' (3 bytes) = 4 bytes; a 2-byte tail would cut the euro sign.
    expect(appendTail('a', '€', 2)).toBe('');
    expect(appendTail('😀', 'x', 3)).toBe('x');
  });
});

const node = process.execPath;

/**
 * Answers every kill(-pgid, …) for the rest of the test: the first whose
 * signal `throwsOn` picks fails with `code`; every other one is delivered.
 * Returns the restore and the signals the group calls carried, in order.
 */
function groupKills(throwsOn: (signal: string | number | undefined) => boolean, code: string): { calls: unknown[]; restore: () => void } {
  const realKill = process.kill.bind(process);
  const calls: unknown[] = [];
  let thrown = false;
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    if (pid >= 0) return realKill(pid, signal);
    calls.push(signal);
    if (!thrown && throwsOn(signal)) {
      thrown = true;
      throw Object.assign(new Error(`kill ${code}`), { code });
    }
    return realKill(pid, signal);
  });
  return { calls, restore: () => spy.mockRestore() };
}

describe('runChild', () => {
  test('returns ok with stdout and a stderr tail', async () => {
    const outcome = await runChild(node, ['-e', 'process.stdout.write("hi"); process.stderr.write("warn")']);
    expect(outcome).toEqual({ kind: 'ok', code: 0, stdout: 'hi', stderrTail: 'warn' });
  });

  test('closes stdin empty', async () => {
    expect(await runChild(node, ['-e', 'process.stdin.pipe(process.stdout)'])).toMatchObject({ kind: 'ok', stdout: '' });
  });

  test('keeps a character split across chunks, and flushes an incomplete last one as U+FFFD', async () => {
    const outcome = await runChild(node, [
      '-e',
      [
        'const [a, b] = [Buffer.from("é").subarray(0, 1), Buffer.from("é").subarray(1)];',
        'process.stdout.write(a, () => setTimeout(() => process.stdout.write(Buffer.concat([b, a])), 50));',
        'process.stderr.write(Buffer.from([0x41, 0xc3]));',
      ].join(' '),
    ]);
    expect(outcome).toMatchObject({ kind: 'ok', stdout: 'é�', stderrTail: 'A�' });
  });

  test('passes cwd and env through', async () => {
    const outcome = await runChild(node, ['-e', 'process.stdout.write(process.cwd() + ":" + process.env.RUN_CHILD_PROBE)'], { cwd: '/', env: { ...process.env, RUN_CHILD_PROBE: 'yes' } });
    expect(outcome.stdout).toBe('/:yes');
  });

  test('returns exit with the code', async () => {
    expect(await runChild(node, ['-e', 'process.exit(3)'])).toMatchObject({ kind: 'exit', code: 3 });
  });

  test('reports a SIGHUP death as signal 129, not 143', async () => {
    expect(await runChild(node, ['-e', 'process.kill(process.pid, "SIGHUP")'])).toMatchObject({ kind: 'signal', signal: 'SIGHUP', code: 129 });
  });

  test('reports a missing binary as spawn-error 127', async () => {
    expect(await runChild('/nonexistent/run-child-binary', [], { timeoutMs: 1000 })).toMatchObject({ kind: 'spawn-error', errno: 'ENOENT', code: 127 });
  });

  test('reports a synchronous spawn failure as spawn-error, never a rejection', async () => {
    expect(await runChild('', [])).toMatchObject({ kind: 'spawn-error', code: 126 });
  });

  test('keeps only the stderr tail', async () => {
    const outcome = await runChild(node, ['-e', `process.stderr.write("x".repeat(${STDERR_TAIL_BYTES * 2}) + "END")`]);
    expect(outcome.stderrTail).toHaveLength(STDERR_TAIL_BYTES);
    expect(outcome.stderrTail.endsWith('END')).toBe(true);
  });

  test('reports a child that traps SIGTERM and exits 0 as a timeout', async () => {
    const outcome = await runChild(node, ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)'], { timeoutMs: 300 });
    expect(outcome).toMatchObject({ kind: 'timeout', code: 124, timeoutMs: 300 });
  });

  test('settles a timeout once the group is empty, not after the grace', async () => {
    const started = Date.now();
    const outcome = await runChild('sleep', ['30'], { timeoutMs: 200, killGraceMs: 10_000 });
    expect(outcome).toMatchObject({ kind: 'timeout', code: 124 });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('escalates to SIGKILL when the child ignores SIGTERM, still a timeout', async () => {
    const outcome = await runChild(node, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { timeoutMs: 200, killGraceMs: 100 });
    expect(outcome).toMatchObject({ kind: 'timeout', code: 124 });
  });

  test('stops descendants holding the pipes when the deadline fires', async () => {
    const started = Date.now();
    const outcome = await runChild('sh', ['-c', 'sleep 30 & echo $!; wait'], { timeoutMs: 200, killGraceMs: 100 });
    const pid = Number(outcome.stdout.trim());
    expect(outcome).toMatchObject({ kind: 'timeout', code: 124 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(pid).toBeGreaterThan(1);
    expect(await stopsWithin(pid, 2000)).toBe(true);
  });

  test('kills a descendant still holding the pipes when the drain ends', async () => {
    const outcome = await runChild('sh', ['-c', 'sleep 30 & echo $!']);
    const pid = Number(outcome.stdout.trim());
    expect(outcome).toMatchObject({ kind: 'ok', code: 0 });
    expect(pid).toBeGreaterThan(1);
    expect(await stopsWithin(pid, 2000)).toBe(true);
  });

  test('settles after a short drain when a background descendant keeps the pipes', async () => {
    const started = Date.now();
    const outcome = await runChild('sh', ['-c', 'sleep 3 & echo started']);
    expect(outcome).toMatchObject({ kind: 'ok', stdout: 'started\n' });
    expect(Date.now() - started).toBeLessThan(2900);
  });

  it.each(['EPERM', 'EINTR'])('holds the outcome for SIGKILL when the group probe fails with %s', async code => {
    // Only ESRCH from kill(-pgid, 0) means the group is gone; EPERM means a
    // member exists that we may not signal, and anything else proves nothing.
    const { restore } = groupKills(signal => signal === 0, code);
    try {
      const started = Date.now();
      const outcome = await runChild('sleep', ['30'], { timeoutMs: 100, killGraceMs: 500 });
      expect(outcome).toMatchObject({ kind: 'timeout', code: 124 });
      expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    } finally {
      restore();
    }
  });

  it.each([
    ['ESRCH', ['SIGTERM']],
    ['EPERM', ['SIGTERM', 'SIGKILL']],
  ] as const)('escalates to the child alone, or to the group too, after a stop that failed with %s', async (code, sent) => {
    // Only ESRCH proves the group gone; a refused signal (EPERM) does not, so
    // its escalation still goes to the group. Either way the child, which
    // ignores SIGTERM, ends at the SIGKILL.
    const { calls, restore } = groupKills(signal => signal === 'SIGTERM', code);
    try {
      const outcome = await runChild(node, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { timeoutMs: 300, killGraceMs: 300 });
      expect(outcome).toMatchObject({ kind: 'timeout', code: 124 });
      expect(calls.filter(signal => signal !== 0)).toEqual([...sent]);
    } finally {
      restore();
    }
  });
});
