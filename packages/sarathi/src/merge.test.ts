import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { merge } from './merge.ts';
import type { Outcome } from './run.ts';

const outcome = (over: Partial<Outcome>): Outcome => ({
  label: 'h',
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  failClosed: false,
  ...over,
});
const json = (answer: string): Record<string, unknown> => JSON.parse(answer) as Record<string, unknown>;

describe('merge', () => {
  it('passes quietly when every handler passes quietly', () => {
    assert.deepEqual(merge('PreToolUse', []), { code: 0, stdout: '', stderr: '' });
    assert.deepEqual(merge('PreToolUse', [outcome({}), outcome({})]), { code: 0, stdout: '', stderr: '' });
  });

  it('blocks when any handler blocks, with every blocker’s reason', () => {
    const answer = merge('PreToolUse', [
      outcome({ code: 2, stderr: 'BLOCKED: one' }),
      outcome({ stdout: '{"systemMessage":"ignored"}' }),
      outcome({ code: 2, stderr: 'BLOCKED: two\n' }),
    ]);
    assert.deepEqual(answer, { code: 2, stdout: '', stderr: 'BLOCKED: one\nBLOCKED: two\n' });
  });

  it('turns a fail-closed handler’s crash, timeout or failed start into a refusal', () => {
    const crash = merge('PreToolUse', [outcome({ label: 'guard', code: 1, stderr: 'Traceback', failClosed: true })]);
    assert.equal(crash.code, 2);
    assert.match(crash.stderr, /^Traceback\nBLOCKED: guard exited 1 instead of giving a verdict/);
    const slow = merge('PreToolUse', [outcome({ label: 'guard', code: null, timedOut: true, failClosed: true })]);
    assert.match(slow.stderr, /^BLOCKED: guard ran out of time/);
    const gone = merge('PreToolUse', [outcome({ label: 'guard', code: null, failClosed: true })]);
    assert.match(gone.stderr, /guard did not finish/);
  });

  it('reports a non-blocking failure on stderr with exit 1', () => {
    const answer = merge('PostToolUse', [
      outcome({ label: 'fmt', code: 1, stderr: 'prettier crashed\n' }),
      outcome({ label: 'slow', code: null, timedOut: true }),
      outcome({ label: 'quiet', code: 3 }),
      outcome({ stdout: 'plain text only the transcript shows' }),
    ]);
    assert.deepEqual(answer, {
      code: 1,
      stdout: '',
      stderr: 'fmt exited 1: prettier crashed\nslow ran out of time\nquiet exited 3\n',
    });
  });

  it('joins plain output when nothing failed or answered in JSON', () => {
    assert.deepEqual(merge('SessionStart', [outcome({ stdout: 'one\n' }), outcome({ stdout: 'two' })]), {
      code: 0,
      stdout: 'one\n\ntwo\n',
      stderr: '',
    });
  });

  it('merges JSON answers: strictest permission, all reasons and context', () => {
    const answer = merge('PreToolUse', [
      outcome({ stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow', permissionDecisionReason: 'fine' } }) }),
      outcome({
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'check', additionalContext: 'a' },
        }),
      }),
      outcome({ stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'again', additionalContext: 'b' } }) }),
      outcome({ stdout: '{"not json' }),
    ]);
    assert.equal(answer.code, 0);
    assert.deepEqual(json(answer.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'check\n\nagain',
        additionalContext: 'a\n\nb',
      },
    });
  });

  it('lets deny win and drops an empty reason; an unknown decision is kept as given', () => {
    const deny = merge('PreToolUse', [
      outcome({ stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow', permissionDecisionReason: 'ok' } }) }),
      outcome({ stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } }) }),
    ]);
    assert.deepEqual(json(deny.stdout), { hookSpecificOutput: { permissionDecision: 'deny', hookEventName: 'PreToolUse' } });
    const odd = merge('PreToolUse', [outcome({ stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'defer' } }) })]);
    assert.deepEqual(json(odd.stdout), { hookSpecificOutput: { permissionDecision: 'defer', hookEventName: 'PreToolUse' } });
  });

  it('merges stop, block, suppress and messages, and carries failures in systemMessage', () => {
    const answer = merge('Stop', [
      outcome({ stdout: JSON.stringify({ decision: 'block', reason: 'keep going', systemMessage: 'one' }) }),
      outcome({ stdout: JSON.stringify({ decision: 'block' }) }),
      outcome({ stdout: JSON.stringify({ continue: false, stopReason: 'done', suppressOutput: true }) }),
      outcome({ stdout: JSON.stringify({ continue: false }) }),
      outcome({ label: 'ledger', code: 1, stderr: 'disk full' }),
      outcome({ stdout: 'plain text, not context on Stop' }),
    ]);
    assert.deepEqual(json(answer.stdout), {
      continue: false,
      stopReason: 'done',
      suppressOutput: true,
      decision: 'block',
      reason: 'keep going',
      systemMessage: 'one\n\nledger exited 1: disk full',
    });
  });

  it('keeps plain output as context on context events when another handler failed', () => {
    const answer = merge('SessionStart', [outcome({ stdout: 'identity set' }), outcome({ label: 'reap', code: 1 })]);
    assert.deepEqual(json(answer.stdout), {
      systemMessage: 'reap exited 1',
      hookSpecificOutput: { additionalContext: 'identity set', hookEventName: 'SessionStart' },
    });
  });

  it('keeps hook-specific fields the first answer gave', () => {
    const answer = merge('PreToolUse', [
      outcome({ stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'a' } } }) }),
      outcome({ stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'b' } }, decision: 'approve' }) }),
    ]);
    assert.deepEqual(json(answer.stdout), { hookSpecificOutput: { updatedInput: { command: 'a' }, hookEventName: 'PreToolUse' } });
  });
});
