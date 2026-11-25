import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import { parseConfig, type Config } from './config.ts';
import { hooksDir, kavachDir, plan, runAll, runPlan } from './run.ts';

const config = (kavach: Record<string, string> = {}): Config => parseConfig(JSON.stringify({ kavach, hooks: {} }), 'sarathi.json', '/project');

describe('plan', () => {
  it('runs a command through sh with its timeout', () => {
    assert.deepEqual(plan({ command: 'echo hi', timeout: 5 }, config(), () => '/kavach', () => '/sarathi/hooks'), {
      label: 'echo hi',
      file: '/bin/sh',
      args: ['-c', 'echo hi'],
      env: { SARATHI_HOOKS: '/sarathi/hooks' },
      timeoutMs: 5000,
      failClosed: false,
    });
    assert.equal(plan({ command: 'x', failClosed: true }, config()).failClosed, true);
    assert.equal(plan({ command: 'x' }, config()).timeoutMs, 60_000);
  });

  it('runs a guard through the configured python with kavach’s settings, always fail-closed', () => {
    const step = plan({ guard: 'worktree' }, config({ config: 'k.json', python: 'bin/py' }), () => '/kavach');
    assert.deepEqual(step, {
      label: 'kavach worktree guard',
      file: '/project/bin/py',
      args: ['/kavach/worktree_guard.py'],
      env: { KAVACH_CONFIG: '/project/k.json' },
      timeoutMs: 60_000,
      failClosed: true,
    });
    assert.deepEqual(plan({ guard: 'command' }, config(), () => '/kavach').args, ['/kavach/command_guard.py']);
    assert.deepEqual(plan({ guard: 'command' }, config(), () => '/kavach').env, {});
    assert.deepEqual(plan({ guard: 'tool' }, config(), () => '/kavach').args, ['/kavach/tool_guard.py']);
    assert.equal(plan({ guard: 'tool' }, config(), () => '/kavach').label, 'kavach tool guard');
  });

  it('finds kavach’s guards in its own dependency', () => {
    assert.ok(existsSync(join(kavachDir(), 'worktree_guard.py')));
    assert.ok(existsSync(join(kavachDir(), 'command_guard.py')));
    assert.ok(existsSync(join(kavachDir(), 'tool_guard.py')));
  });

  it('gives every command SARATHI_HOOKS, the folder of sarathi’s own handlers', () => {
    for (const name of ['arch-guard.sh', 'code-quality-guard.sh', 'format-before-write.sh', 'format-on-edit.sh', 'session-dedupe-guard.sh', 'lib/session-root.sh']) {
      assert.ok(existsSync(join(hooksDir(), name)), name);
    }
    assert.deepEqual(plan({ command: 'x' }, config()).env, { SARATHI_HOOKS: hooksDir() });
  });
});

describe('runPlan', () => {
  const step = (command: string, timeoutMs = 10_000): Parameters<typeof runPlan>[0] => ({
    label: command,
    file: '/bin/sh',
    args: ['-c', command],
    env: { SARATHI_TEST: 'set' },
    timeoutMs,
    failClosed: false,
  });

  it('gives the handler its input and environment and collects its output', async () => {
    const outcome = await runPlan(step('read line; echo "got $line $SARATHI_TEST"; echo warn >&2; exit 2'), 'event\n', tmpdir());
    assert.deepEqual(outcome, { label: outcome.label, code: 2, stdout: 'got event set\n', stderr: 'warn\n', timedOut: false, failClosed: false });
  });

  it('tolerates a handler that never reads its input', async () => {
    const outcome = await runPlan(step('exit 0'), 'x'.repeat(1 << 20), tmpdir());
    assert.equal(outcome.code, 0);
  });

  it('stops a handler at its timeout, with its children', async () => {
    const started = Date.now();
    const outcome = await runPlan(step('sleep 30 & sleep 30', 200), '', tmpdir());
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.code, null);
    assert.ok(Date.now() - started < 10_000);
  });

  it('reports a handler that cannot start', async () => {
    const outcome = await runPlan({ ...step('x'), file: '/no/such/program' }, '', tmpdir());
    assert.equal(outcome.code, null);
    assert.match(outcome.stderr, /could not start/);
  });
});

describe('runAll', () => {
  it('runs entries side by side and keeps their order', async () => {
    const started = Date.now();
    const outcomes = await runAll(
      [{ command: 'sleep 0.4; echo first' }, { command: 'sleep 0.4; echo second' }],
      config(),
      '',
      tmpdir(),
    );
    assert.deepEqual(
      outcomes.map(outcome => outcome.stdout),
      ['first\n', 'second\n'],
    );
    assert.ok(Date.now() - started < 790, 'the two sleeps overlapped');
  });
});

describe('plan and runPlan, case by case', () => {
  it('runs an entry with neither command nor guard as an empty command', () => {
    const parsed = parseConfig(JSON.stringify({ hooks: {} }), 'sarathi.json', '/project');
    assert.deepEqual(plan({}, parsed, () => '/kavach', () => '/sarathi/hooks'), {
      label: '',
      file: '/bin/sh',
      args: ['-c', ''],
      env: { SARATHI_HOOKS: '/sarathi/hooks' },
      timeoutMs: 60_000,
      failClosed: false,
    });
  });

  it('kills a handler that ignores SIGTERM at its timeout', { timeout: 15_000 }, async () => {
    const started = Date.now();
    const outcome = await runPlan(
      { label: 'stubborn', file: '/bin/sh', args: ['-c', 'trap "" TERM; sleep 4'], env: {}, timeoutMs: 200, failClosed: false },
      '',
      tmpdir(),
    );
    assert.deepEqual(outcome, { label: 'stubborn', code: null, stdout: '', stderr: '', timedOut: true, failClosed: false });
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  });

  it('reports a handler that cannot start once, with the reason', async () => {
    const outcome = await runPlan({ label: 'ghost', file: '/no/such/program', args: [], env: {}, timeoutMs: 10_000, failClosed: true }, '', tmpdir());
    assert.deepEqual(outcome, {
      label: 'ghost',
      code: null,
      stdout: '',
      stderr: 'ghost could not start (spawn /no/such/program ENOENT)\n',
      timedOut: false,
      failClosed: true,
    });
  });
});

describe('a handler’s timer', () => {
  it('is cleared once the handler ends, so nothing kills its process group later', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const kill = mock.method(process, 'kill', () => true);
    try {
      const outcome = await runPlan(plan({ command: 'exit 0', timeout: 60 }, config(), () => '/kavach', () => '/sarathi/hooks'), '', tmpdir());
      assert.equal(outcome.code, 0);
      mock.timers.tick(60_000);
      assert.equal(kill.mock.callCount(), 0);
    } finally {
      kill.mock.restore();
      mock.timers.reset();
    }
  });
});
