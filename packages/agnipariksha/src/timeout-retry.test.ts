import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mutantSpan, RETRY_BUDGET_MS, RETRY_TIMEOUT_MS, retryTimeouts, sameMutant, type RetryRun } from './timeout-retry.ts';
import type { Mutant } from './verdict.ts';

const mutant = (status: string, line = 3): Mutant => ({
  file: 'scripts/a.ts',
  status,
  mutator: 'StringLiteral',
  replacement: '""',
  line,
  column: 5,
  endLine: line,
  endColumn: 9,
});

test('the retry limit is three minutes and the pass budget fifteen', () => {
  assert.equal(RETRY_TIMEOUT_MS, 180_000);
  assert.equal(RETRY_BUDGET_MS, 900_000);
});

test('a span keeps lines 1-based and moves report columns to 0-based', () => {
  assert.equal(mutantSpan({ ...mutant('Timeout'), endLine: 7 }), '3:4-7:8');
  for (const field of ['line', 'column', 'endLine', 'endColumn'] as const) {
    assert.equal(mutantSpan({ ...mutant('Timeout'), [field]: Number.NaN }), null, field);
  }
});

test('sameMutant compares file, start, mutator and replacement', () => {
  assert.equal(sameMutant(mutant('Killed'), mutant('Timeout')), true);
  assert.equal(sameMutant(mutant('Killed'), { ...mutant('Killed'), replacement: '"x"' }), false);
  assert.equal(sameMutant(mutant('Killed'), mutant('Killed', 4)), false);
  assert.equal(sameMutant(mutant('Killed'), { ...mutant('Killed'), file: 'scripts/b.ts' }), false);
  assert.equal(sameMutant(mutant('Killed'), { ...mutant('Killed'), column: 6 }), false);
  assert.equal(sameMutant(mutant('Killed'), { ...mutant('Killed'), mutator: 'BooleanLiteral' }), false);
});

const clock = (...times: number[]) => () => times.shift() ?? 0;

test('each Timeout is retried once and takes the retry status; a second Timeout stays Timeout', async () => {
  const seen: number[] = [];
  const pass = await retryTimeouts(
    [mutant('Killed', 1), mutant('Timeout', 2), mutant('Timeout', 3)],
    async (m): Promise<RetryRun> => {
      seen.push(m.line);
      return { mutants: [mutant('Survived', 9), mutant(m.line === 2 ? 'Survived' : 'Timeout', m.line)] };
    },
    clock(0, 1, 2),
  );
  assert.deepEqual(seen, [2, 3]);
  assert.deepEqual(pass.mutants.map((m) => `${m.line}:${m.status}`), ['1:Killed', '2:Survived', '3:Timeout']);
  assert.equal(pass.retried, 2);
  assert.deepEqual(pass.refusals, []);
});

test('a retry that cannot run refuses that mutant and the pass goes on', async () => {
  const pass = await retryTimeouts(
    [mutant('Timeout', 2), mutant('Timeout', 3)],
    async (m) => (m.line === 2 ? { refusal: 'Stryker exited 1', busy: false } : { mutants: [] }),
    clock(0, 0, 0),
  );
  assert.deepEqual(pass.refusals, ['retry of scripts/a.ts:2 (StringLiteral): Stryker exited 1', 'retry of scripts/a.ts:3 (StringLiteral): its report does not hold the mutant']);
  assert.deepEqual(pass.mutants, []);
  assert.equal(pass.retried, 0);
});

test('a busy dry run stops the pass: later Timeouts are never launched', async () => {
  let runs = 0;
  const pass = await retryTimeouts(
    [mutant('Timeout', 2), mutant('Timeout', 3), mutant('Killed', 4)],
    async () => {
      runs += 1;
      return { refusal: 'busy', busy: true };
    },
    clock(0, 0, 0),
  );
  assert.equal(runs, 1);
  assert.equal(pass.refusals.length, 1);
  assert.deepEqual(pass.mutants.map((m) => m.line), [4]);
});

test('a pass past its budget stops before the next retry', async () => {
  let runs = 0;
  const pass = await retryTimeouts(
    [mutant('Timeout', 2), mutant('Timeout', 3)],
    async (m) => {
      runs += 1;
      return { mutants: [mutant('Killed', m.line)] };
    },
    clock(0, 10, RETRY_BUDGET_MS + 1),
  );
  assert.equal(runs, 1);
  assert.match(pass.refusals[0] ?? '', /15-minute budget/);
  assert.deepEqual(pass.mutants.map((m) => `${m.line}:${m.status}`), ['2:Killed']);
});

test('the budget counts from the pass start: a retry starts at exactly the budget, and one past it stops the pass once', async () => {
  const B = RETRY_BUDGET_MS;
  const retry = async (m: Mutant): Promise<RetryRun> => ({ mutants: [mutant('Killed', m.line)] });
  const atBudget = await retryTimeouts([mutant('Timeout', 2), mutant('Timeout', 3)], retry, clock(B, B + 10, 2 * B));
  assert.deepEqual(atBudget.mutants.map((m) => `${m.line}:${m.status}`), ['2:Killed', '3:Killed'], 'elapsed is now minus the start, and the budget itself is in');
  assert.deepEqual(atBudget.refusals, []);

  const past = await retryTimeouts([mutant('Timeout', 2), mutant('Timeout', 3), mutant('Timeout', 4)], retry, clock(0, 0, B + 1, B + 2));
  assert.deepEqual(past.mutants.map((m) => m.line), [2]);
  assert.equal(past.refusals.length, 1, 'once stopped, the pass refuses once');
});

test('a retry that reports its own mutant Ignored refuses: the verdict would not count it', async () => {
  const pass = await retryTimeouts(
    [mutant('Timeout', 2), mutant('Timeout', 3)],
    async (m) => ({ mutants: [mutant(m.line === 2 ? 'Ignored' : 'Killed', m.line)] }),
    clock(0, 0, 0),
  );
  assert.deepEqual(pass.refusals, ['retry of scripts/a.ts:2 (StringLiteral): Stryker ignored the mutant it was retrying']);
  assert.deepEqual(pass.mutants.map((m) => `${m.line}:${m.status}`), ['3:Killed']);
  assert.equal(pass.retried, 1);
});
