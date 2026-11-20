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

  it('keeps the other handlers’ block reasons, then their context, in a blocked Stop’s stderr', () => {
    const context = (text: unknown): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } });
    const others = [
      outcome({ stdout: context('research before you ask.\n') }),
      outcome({ stdout: JSON.stringify({ decision: 'block', reason: '  push the branch  ', systemMessage: 'for the user' }) }),
      outcome({ stdout: JSON.stringify({ decision: 'approve', reason: 'not a block' }) }),
      outcome({ stdout: JSON.stringify({ decision: 'block', reason: 7 }) }),
      outcome({ stdout: context('  ') }),
      outcome({ stdout: JSON.stringify({ hookSpecificOutput: 'not a record' }) }),
      outcome({ stdout: 'plain text, not context on Stop' }),
      outcome({ label: 'broke', code: 1, stdout: context('from a failed handler'), stderr: 'oops' }),
    ];
    for (const event of ['Stop', 'SubagentStop']) {
      assert.deepEqual(merge(event, [outcome({ code: 2, stderr: 'keep going' }), ...others, outcome({ code: 2, stderr: 'and merge\n' })]), {
        code: 2,
        stdout: '',
        stderr: 'keep going\nand merge\n\npush the branch\n\nresearch before you ask.\n',
      });
    }
    const guard = merge('Stop', [outcome({ label: 'guard', code: 1, failClosed: true }), outcome({ stdout: context('ctx') })]);
    assert.equal(guard.stderr, 'BLOCKED: guard exited 1 instead of giving a verdict, so the call is refused.\n\nctx\n');
    assert.deepEqual(merge('Stop', [outcome({ code: 2 })]), { code: 2, stdout: '', stderr: '' });
    assert.deepEqual(merge('Stop', [outcome({ code: 2, stderr: 'kept as it is\n\n' })]), { code: 2, stdout: '', stderr: 'kept as it is\n\n' });
    const silent = merge('Stop', [outcome({ code: 2 }), outcome({ stdout: context('ctx') })]);
    assert.deepEqual(silent, { code: 2, stdout: '', stderr: 'ctx\n' });
    assert.deepEqual(merge('Stop', [outcome({ code: 2, stderr: 'keep going\n' }), outcome({ stdout: '{"systemMessage":"only"}' })]), {
      code: 2,
      stdout: '',
      stderr: 'keep going\n',
    });
  });

  it('keeps only the blockers’ reasons when another event blocks', () => {
    const others = [
      outcome({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'lessons' } }) }),
      outcome({ stdout: JSON.stringify({ decision: 'block', reason: 'stop' }) }),
    ];
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit']) {
      assert.deepEqual(merge(event, [outcome({ code: 2, stderr: 'BLOCKED: one\n' }), ...others]), {
        code: 2,
        stdout: '',
        stderr: 'BLOCKED: one\n',
      });
    }
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
