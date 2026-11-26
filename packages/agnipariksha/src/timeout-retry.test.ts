import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeMutant, minutes, mutantSpan, RETRY_BUDGET_MS, RETRY_TIMEOUT_MS, retryTimeouts, sameMutant, type RetryRun } from './timeout-retry.ts';
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

test('sameMutant compares file, start, end, mutator and replacement', () => {
  assert.equal(sameMutant(mutant('Killed'), { ...mutant('Killed'), line: 2 }), false, 'a mutant from line 2 to 3 is not the one on line 3');
  assert.equal(sameMutant(mutant('Killed'), { ...mutant('Killed'), endLine: 4 }), false);
  assert.equal(sameMutant(mutant('Killed'), { ...mutant('Killed'), endColumn: 10 }), false);
  assert.equal(sameMutant(mutant('Killed'), mutant('Timeout')), true);
  assert.equal(sameMutant(mutant('Killed'), { ...mutant('Killed'), replacement: '"x"' }), false);
  assert.equal(sameMutant(mutant('Killed'), mutant('Killed', 4)), false);
  assert.equal(sameMutant(mutant('Killed'), { ...mutant('Killed'), file: 'scripts/b.ts' }), false);
  assert.equal(sameMutant(mutant('Killed'), { ...mutant('Killed'), column: 6 }), false);
  assert.equal(sameMutant(mutant('Killed'), { ...mutant('Killed'), mutator: 'BooleanLiteral' }), false);
});

/** A clock that reads `times` in order: the pass start, then each retry's start and end. */
const clock = (...times: number[]) => () => times.shift() ?? Number.NaN;
const MIN = 60_000;
const quiet = () => {};
/** A log that keeps its lines. */
const kept = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line) };
};
const killed = async (m: Mutant): Promise<RetryRun> => ({ mutants: [mutant('Killed', m.line)] });
const LEAVE = 'For each, make the suite that owns its file kill it fast, or push again when the machine is quieter';

test('a mutant is named by its file, line, report column, mutator and replacement; minutes to a tenth', () => {
  assert.equal(describeMutant(mutant('Timeout', 7)), 'scripts/a.ts:7:5 StringLiteral ("\\"\\"")');
  assert.equal(minutes(0), '0.0 min');
  assert.equal(minutes(5.26 * MIN), '5.3 min');
  assert.equal(minutes(10 * MIN), '10.0 min');
});

test('each Timeout is retried once and takes the retry status; a second Timeout stays Timeout', async () => {
  const seen: number[] = [];
  const { lines, log } = kept();
  const pass = await retryTimeouts(
    [mutant('Killed', 1), mutant('Timeout', 2), mutant('Timeout', 3)],
    async (m): Promise<RetryRun> => {
      seen.push(m.line);
      return { mutants: [mutant('Survived', 9), mutant(m.line === 2 ? 'Survived' : 'Timeout', m.line)] };
    },
    clock(0, 0, 2 * MIN, 2 * MIN, 7 * MIN),
    log,
  );
  assert.deepEqual(seen, [2, 3]);
  assert.deepEqual(pass.mutants.map((m) => `${m.line}:${m.status}`), ['1:Killed', '2:Survived', '3:Timeout']);
  assert.equal(pass.retried, 2);
  assert.deepEqual(pass.refusals, []);
  assert.deepEqual(lines, [
    '  retry 1 of 2: scripts/a.ts:2:5 StringLiteral ("\\"\\"")',
    '  retry 1 of 2: Survived after 2.0 min',
    '  retry 2 of 2: scripts/a.ts:3:5 StringLiteral ("\\"\\"")',
    '  retry 2 of 2: Timeout after 5.0 min',
    '  timed out again (caught, but every run pays a whole retry for it; make the suite that owns its file kill it fast): scripts/a.ts:3:5 StringLiteral ("\\"\\"")',
  ]);
});

test('a pass with no Timeout logs nothing and reads the clock once', async () => {
  const { lines, log } = kept();
  let reads = 0;
  const pass = await retryTimeouts([mutant('Killed', 1)], killed, () => reads++, log);
  assert.deepEqual(lines, []);
  assert.equal(reads, 1);
  assert.deepEqual(pass.refusals, []);
});

test('a retry that cannot run refuses that mutant, says so in the log, and the pass goes on', async () => {
  const { lines, log } = kept();
  const pass = await retryTimeouts(
    [mutant('Timeout', 2), mutant('Timeout', 3)],
    async (m) => (m.line === 2 ? { refusal: 'Stryker exited 1', busy: false } : { mutants: [] }),
    clock(0, 0, MIN, MIN, 2 * MIN),
    log,
  );
  assert.deepEqual(pass.refusals, ['retry of scripts/a.ts:2 (StringLiteral): Stryker exited 1', 'retry of scripts/a.ts:3 (StringLiteral): its report does not hold the mutant']);
  assert.deepEqual(pass.mutants, []);
  assert.equal(pass.retried, 0);
  assert.deepEqual(lines.filter((line) => !line.includes('StringLiteral')), ['  retry 1 of 2: refused after 1.0 min', '  retry 2 of 2: not in its report, after 1.0 min']);
});

test('a busy dry run stops the pass: later Timeouts are never launched, and one refusal names them', async () => {
  let runs = 0;
  const pass = await retryTimeouts(
    [mutant('Timeout', 2), mutant('Timeout', 3), mutant('Killed', 4), mutant('Timeout', 5)],
    async () => {
      runs += 1;
      return { refusal: 'busy', busy: true };
    },
    clock(0, 0, 0),
    quiet,
  );
  assert.equal(runs, 1);
  assert.deepEqual(pass.refusals, [
    'retry of scripts/a.ts:2 (StringLiteral): busy',
    `a retry found the machine busy; 2 timed-out mutant(s) left unretried: scripts/a.ts:3:5 StringLiteral ("\\"\\""), scripts/a.ts:5:5 StringLiteral ("\\"\\""). ${LEAVE}`,
  ]);
  assert.deepEqual(pass.mutants.map((m) => m.line), [4]);
});

test('the budget is a wall: no retry starts that the longest so far says would end past it', async () => {
  // Five 5-minute retries in a 15-minute budget: three fit exactly, the fourth would end at 20.
  let runs = 0;
  const pass = await retryTimeouts(
    [2, 3, 4, 5, 6].map((line) => mutant('Timeout', line)),
    async (m) => {
      runs += 1;
      return killed(m);
    },
    clock(0, 0, 5 * MIN, 5 * MIN, 10 * MIN, 10 * MIN, 15 * MIN, 15 * MIN),
    quiet,
  );
  assert.equal(runs, 3);
  assert.equal(RETRY_BUDGET_MS, 15 * MIN);
  assert.deepEqual(pass.mutants.map((m) => `${m.line}:${m.status}`), ['2:Killed', '3:Killed', '4:Killed']);
  assert.deepEqual(pass.refusals, [
    `the timeout retry pass would outgrow its 15-minute budget: 15.0 min gone, and its longest retry took 5.0 min; 2 timed-out mutant(s) left unretried: scripts/a.ts:5:5 StringLiteral ("\\"\\""), scripts/a.ts:6:5 StringLiteral ("\\"\\""). ${LEAVE}`,
  ]);
});

test('the wall counts from the pass start and holds the longest retry, not the last', async () => {
  // 1 ms past the wall stops; exactly at it runs.
  const past = await retryTimeouts([mutant('Timeout', 2), mutant('Timeout', 3)], killed, clock(MIN, MIN, 6 * MIN, 11 * MIN + 1), quiet);
  assert.deepEqual(past.mutants.map((m) => m.line), [2], 'a 5-minute retry leaves no room at 10 minutes plus 1 ms');
  assert.equal(past.refusals.length, 1);
  const at = await retryTimeouts([mutant('Timeout', 2), mutant('Timeout', 3)], killed, clock(MIN, MIN, 6 * MIN, 11 * MIN, 12 * MIN), quiet);
  assert.deepEqual(at.mutants.map((m) => m.line), [2, 3], 'the budget itself is in, and elapsed is now minus the pass start');
  assert.deepEqual(at.refusals, []);

  // A long first retry, then a short one: the third is judged by the long one.
  const longest = await retryTimeouts([2, 3, 4].map((line) => mutant('Timeout', line)), killed, clock(0, 0, 6 * MIN, 6 * MIN, 7 * MIN, 9 * MIN + 1), quiet);
  assert.deepEqual(longest.mutants.map((m) => m.line), [2, 3]);
  assert.match(longest.refusals[0] ?? '', /longest retry took 6\.0 min/);
});

test('the first retry runs whatever it costs, and stops the pass once if it outgrows the budget', async () => {
  const { lines, log } = kept();
  const pass = await retryTimeouts([2, 3, 4].map((line) => mutant('Timeout', line)), killed, clock(0, 0, 20 * MIN, 20 * MIN), log);
  assert.deepEqual(pass.mutants.map((m) => m.line), [2]);
  assert.equal(pass.refusals.length, 1, 'once stopped, the pass refuses once');
  assert.match(pass.refusals[0] ?? '', /20\.0 min gone, and its longest retry took 20\.0 min; 2 timed-out/);
  assert.deepEqual(lines, ['  retry 1 of 3: scripts/a.ts:2:5 StringLiteral ("\\"\\"")', '  retry 1 of 3: Killed after 20.0 min']);
});

test('a retry takes its own mutant, not a nested one that starts at the same place (#557)', async () => {
  // `if (held === '' && !sawEmpty)`: the outer condition and the nested `held === ''` both start at 3:5.
  const outer: Mutant = { ...mutant('Timeout'), mutator: 'ConditionalExpression', replacement: 'true', endColumn: 30 };
  const nested: Mutant = { ...outer, endColumn: 16 };
  const pass = await retryTimeouts(
    [outer],
    async () => ({ mutants: [{ ...nested, status: 'Ignored' }, { ...outer, status: 'Killed' }] }),
    clock(0, 0, 0),
    quiet,
  );
  assert.deepEqual(pass.refusals, []);
  assert.deepEqual(pass.mutants.map((m) => `${m.line}:${m.endColumn}:${m.status}`), ['3:30:Killed']);
  assert.equal(pass.retried, 1);
});

test('a retry that reports its own mutant Ignored refuses: the verdict would not count it', async () => {
  const { lines, log } = kept();
  const pass = await retryTimeouts(
    [mutant('Timeout', 2), mutant('Timeout', 3)],
    async (m) => ({ mutants: [mutant(m.line === 2 ? 'Ignored' : 'Killed', m.line)] }),
    clock(0, 0, 0, 0, 0),
    log,
  );
  assert.deepEqual(pass.refusals, ['retry of scripts/a.ts:2 (StringLiteral): Stryker ignored the mutant it was retrying']);
  assert.deepEqual(pass.mutants.map((m) => `${m.line}:${m.status}`), ['3:Killed']);
  assert.equal(pass.retried, 1);
  assert.equal(lines[1], '  retry 1 of 2: Ignored, after 0.0 min');
});
