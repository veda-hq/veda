import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { EXIT_DRAIN_MS, runChild } from './run-child.ts';

function scratch(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kavach-run-')));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

describe('runChild', () => {
  it('reports a clean exit with its stdout, and feeds its input', async () => {
    assert.deepEqual(await runChild('cat', [], { input: 'fed\n' }), {
      kind: 'ok',
      code: 0,
      stdout: 'fed\n',
      stderrTail: '',
    });
  });

  it('reports a failing exit with its code and stderr', async () => {
    assert.deepEqual(
      await runChild('/bin/sh', ['-c', 'echo why >&2; exit 3']),
      { kind: 'exit', code: 3, stdout: '', stderrTail: 'why\n' },
    );
  });

  it('keeps only the tail of stderr', async () => {
    const outcome = await runChild(
      '/bin/sh',
      ['-c', 'printf abcdef >&2'],
      { stderrTailChars: 2 },
    );
    assert.equal(outcome.stderrTail, 'ef');
  });

  it('reports a signal as 128 plus its number', async () => {
    const outcome = await runChild('/bin/sh', ['-c', 'kill -TERM $$']);
    assert.equal(outcome.kind, 'signal');
    assert.equal(outcome.code, 143);
  });

  it('reports a missing binary as a spawn error, 127', async () => {
    const outcome = await runChild('/nonexistent/kavach-no-such-binary', []);
    assert.equal(outcome.kind, 'spawn-error');
    assert.equal(outcome.code, 127);
  });

  it('reports a spawn refused before it starts as a spawn error, 126', async () => {
    const outcome = await runChild('/bin/sh', ['-c', 'true\0']);
    assert.equal(outcome.kind, 'spawn-error');
    assert.equal(outcome.code, 126);
  });

  it('kills the child at the deadline and reports a timeout', async () => {
    const started = Date.now();
    const outcome = await runChild('/bin/sh', ['-c', 'sleep 5'], {
      timeoutMs: 50,
    });
    assert.equal(outcome.kind, 'timeout');
    assert.equal(outcome.code, 124);
    assert.ok(Date.now() - started < 4000);
  });

  it('never calls a child that ended on its own a timeout', async () => {
    const outcome = await runChild('true', [], { timeoutMs: 10_000 });
    assert.equal(outcome.kind, 'ok');
  });

  it('kills a background descendant the moment the child exits', async t => {
    const dir = scratch(t);
    const late = join(dir, 'late');
    const outcome = await runChild('/bin/sh', [
      '-c',
      `(sleep 0.3; : > '${late}') & echo $!`,
    ]);
    assert.equal(outcome.kind, 'ok');
    const job = Number(outcome.stdout.trim());
    assert.ok(job > 1);
    // The group was emptied before the outcome came back.
    assert.throws(() => process.kill(job, 0), { code: 'ESRCH' });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(existsSync(late), false);
  });

  it('cuts the pipes a descendant outside the group holds open', async () => {
    // The descendant starts a session of its own, so the group kill misses
    // it, and it keeps stdout open past the child's exit. The child waits
    // for it to have left the group before exiting.
    const started = Date.now();
    const outcome = await runChild('/bin/sh', [
      '-c',
      `python3 -c 'import os, time; os.setsid(); print("left", flush=True); time.sleep(3)' & sleep 0.5; echo started`,
    ]);
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.stdout, 'left\nstarted\n');
    const took = Date.now() - started;
    assert.ok(took >= EXIT_DRAIN_MS - 50, `took ${String(took)} ms`);
    assert.ok(took < 2900, `took ${String(took)} ms`);
  });
});
