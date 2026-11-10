import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

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
  });

  it('finds kavach’s guards in its own dependency', () => {
    assert.ok(existsSync(join(kavachDir(), 'worktree_guard.py')));
    assert.ok(existsSync(join(kavachDir(), 'command_guard.py')));
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
