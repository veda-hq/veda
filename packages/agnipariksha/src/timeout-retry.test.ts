import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeMutant,
  holds,
  minutes,
  mutantSpan,
  outgrew,
  planRounds,
  RETRY_BUDGET_MS,
  RETRY_TIMEOUT_MS,
  retryTimeouts,
  sameMutant,
  seconds,
  type RoundRun,
  type Spent,
} from './timeout-retry.ts';
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
/** A mutant at `line:column-endLine:endColumn` (report columns). */
const at = (line: number, column: number, endLine: number, endColumn: number, status = 'Timeout', file = 'scripts/a.ts'): Mutant => ({
  ...mutant(status),
  file,
  line,
  column,
  endLine,
  endColumn,
});

const SEC = 1000;
const MIN = 60_000;
/** A log that keeps its lines. */
const kept = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line) };
};
/** A clock the fake rounds move. */
const clock = (start = 0) => {
  const state = { t: start };
  return { state, now: () => state.t };
};
const named = (ms: readonly Mutant[]) => ms.map((m) => `${m.line}:${m.status}`);

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

test('a mutant is named by its file, line, report column, mutator and replacement; minutes and seconds to a tenth', () => {
  assert.equal(describeMutant(mutant('Timeout', 7)), 'scripts/a.ts:7:5 StringLiteral ("\\"\\"")');
  assert.equal(minutes(0), '0.0 min');
  assert.equal(minutes(5.26 * MIN), '5.3 min');
  assert.equal(minutes(10 * MIN), '10.0 min');
  assert.equal(seconds(0), '0.0 s');
  assert.equal(seconds(6.26 * SEC), '6.3 s');
  assert.equal(seconds(180 * SEC), '180.0 s');
});

test('holds: a place strictly around another in the same file, ends included', () => {
  const outer = at(3, 5, 9, 2);
  assert.equal(holds(outer, at(4, 1, 5, 1)), true, 'inside on other lines');
  assert.equal(holds(outer, at(3, 5, 9, 1)), true, 'same start, earlier end');
  assert.equal(holds(outer, at(3, 6, 9, 2)), true, 'later start, same end');
  assert.equal(holds(outer, at(4, 5, 9, 2)), true, 'a later start line, all else the same');
  assert.equal(holds(outer, at(3, 5, 8, 2)), true, 'an earlier end line, all else the same');
  assert.equal(holds(outer, at(3, 5, 9, 2)), false, 'the same place is not held');
  assert.equal(holds(outer, { ...at(3, 5, 9, 2), mutator: 'BlockStatement' }), false, 'nor another mutant at the same place');
  assert.equal(holds(outer, at(4, 1, 5, 1, 'Timeout', 'scripts/b.ts')), false, 'nor a place in another file');
  assert.equal(holds(outer, at(3, 4, 5, 1)), false, 'starts a column before');
  assert.equal(holds(outer, at(2, 9, 5, 1)), false, 'starts a line before');
  assert.equal(holds(outer, at(4, 1, 9, 3)), false, 'ends a column after');
  assert.equal(holds(outer, at(4, 1, 10, 1)), false, 'ends a line after');
  assert.equal(holds(at(4, 1, 5, 1), outer), false, 'the inner one holds nothing');
  // Same line on both ends.
  assert.equal(holds(at(3, 5, 3, 30), at(3, 9, 3, 12)), true);
  assert.equal(holds(at(3, 5, 3, 30), at(3, 4, 3, 12)), false);
  assert.equal(holds(at(3, 5, 3, 30), at(3, 9, 3, 31)), false);
});

test('planRounds: siblings share a round, a held mutant goes a round before what holds it, and groups never mix', () => {
  const block = at(1, 1, 20, 2);
  const inner = at(2, 3, 6, 4);
  const deepest = at(3, 5, 3, 9);
  const sibling = at(10, 1, 12, 1);
  const other = at(3, 5, 3, 9, 'Timeout', 'scripts/b.ts');
  const rounds = planRounds([block, inner, deepest, sibling, other], () => 'g');
  // Heights: block 2, inner 1, deepest 0, sibling 0, other 0; rounds in the order their first mutant comes.
  assert.deepEqual(rounds, [[block], [inner], [deepest, sibling, other]]);
  const grouped = planRounds([deepest, sibling, other], (m) => m.file);
  assert.deepEqual(grouped, [[deepest, sibling], [other]]);
  assert.deepEqual(planRounds([], () => 'g'), []);
});

test('planRounds works out each height once: a deep nesting costs a square of its depth, not a power', () => {
  // Count every read of a mutant's file: holds reads it once a call.
  let reads = 0;
  const counted = (m: Mutant): Mutant =>
    new Proxy(m, {
      get(target, key, receiver) {
        if (key === 'file') reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
  const chain = Array.from({ length: 16 }, (_, i) => counted(at(1 + i, 1, 100 - i, 1)));
  const rounds = planRounds(chain, () => 'g');
  assert.equal(rounds.length, 16);
  assert.deepEqual(rounds[0], [chain[0]]);
  assert.deepEqual(rounds.at(-1), [chain[15]]);
  // 16 heights, each holds-checked against all 16: 256 calls, two reads each. Without the memo, 2^15 heights.
  assert.ok(reads <= 2 * 16 * 16, `${reads} reads`);
});

/** A round that tests its mutants one by one, `each` ms apart after a `dry` ms dry run, and reports them with `status`. */
const steady = (c: ReturnType<typeof clock>, dry: number, each: (m: Mutant) => number, status: (m: Mutant) => string) => {
  const calls: { round: Mutant[]; deadline: number }[] = [];
  const rerun = async (round: Mutant[], deadline: number): Promise<RoundRun> => {
    calls.push({ round, deadline });
    c.state.t += dry;
    const dryRunEnd = c.state.t;
    const tested = round.map((m) => {
      c.state.t += each(m);
      return { mutant: { ...m, status: status(m) }, at: c.state.t };
    });
    return { dryRunEnd, tested, stopped: false, report: tested.map((t) => t.mutant) };
  };
  return { calls, rerun };
};

test('each Timeout is retried once in its round and takes the retry status; a second Timeout stays Timeout', async () => {
  const c = clock(5 * MIN);
  const { lines, log } = kept();
  const outer = at(2, 1, 9, 1);
  const a = at(3, 5, 3, 9);
  const b = at(5, 5, 5, 9);
  const { calls, rerun } = steady(
    c,
    15 * SEC,
    (m) => (m === b ? RETRY_TIMEOUT_MS : 6 * SEC),
    (m) => (m === b ? 'Timeout' : 'Killed'),
  );
  const pass = await retryTimeouts([mutant('Survived', 1), outer, a, b], rerun, c.now, log);
  assert.deepEqual(
    calls.map((call) => call.round),
    [[outer], [a, b]],
  );
  assert.deepEqual(
    calls.map((call) => call.deadline),
    [5 * MIN + RETRY_BUDGET_MS, 5 * MIN + RETRY_BUDGET_MS],
    'every round gets the wall, from the pass start',
  );
  assert.deepEqual(named(pass.mutants), ['1:Survived', '2:Killed', '3:Killed', '5:Timeout']);
  assert.equal(pass.retried, 3);
  assert.deepEqual(pass.refusals, []);
  assert.deepEqual(lines, [
    '  retry round 1 of 2: 1 timed-out mutant(s) in 1 file(s)',
    '  retry 1 of 3: scripts/a.ts:2:1 StringLiteral ("\\"\\""): Killed after 6.0 s',
    '  retry round 2 of 2: 2 timed-out mutant(s) in 1 file(s)',
    '  retry 2 of 3: scripts/a.ts:3:5 StringLiteral ("\\"\\""): Killed after 6.0 s',
    '  retry 3 of 3: scripts/a.ts:5:5 StringLiteral ("\\"\\""): Timeout after 180.0 s',
    '  timed out again (caught, but every run pays a whole retry for it; make the suite that owns its file kill it fast): scripts/a.ts:5:5 StringLiteral ("\\"\\"")',
  ]);
});

test('a round names the files it holds; groups keep their own rounds', async () => {
  const c = clock();
  const { lines, log } = kept();
  const { calls, rerun } = steady(
    c,
    0,
    () => 0,
    () => 'Killed',
  );
  const files = [at(3, 5, 3, 9), at(3, 5, 3, 9, 'Timeout', 'scripts/b.ts'), at(3, 5, 3, 9, 'Timeout', 'scripts/c.ts')];
  await retryTimeouts(files, rerun, c.now, log, (m) => String(m.file === 'scripts/c.ts'));
  assert.deepEqual(
    calls.map((call) => call.round.map((m) => m.file)),
    [['scripts/a.ts', 'scripts/b.ts'], ['scripts/c.ts']],
  );
  assert.equal(lines[0], '  retry round 1 of 2: 2 timed-out mutant(s) in 2 file(s)');
});

test('a pass with no Timeout logs nothing, runs no round and reads the clock once', async () => {
  const { lines, log } = kept();
  let reads = 0;
  let runs = 0;
  const pass = await retryTimeouts(
    [mutant('Killed', 1)],
    async () => {
      runs += 1;
      return { refusal: 'never', busy: false };
    },
    () => reads++,
    log,
  );
  assert.deepEqual(lines, []);
  assert.equal(reads, 1);
  assert.equal(runs, 0);
  assert.deepEqual(pass, { mutants: [mutant('Killed', 1)], retried: 0, refusals: [] });
});

test('a timed-out mutant with no full location refuses and is never retried', async () => {
  const c = clock();
  const { calls, rerun } = steady(
    c,
    0,
    () => 0,
    () => 'Killed',
  );
  const pass = await retryTimeouts([{ ...mutant('Timeout'), endColumn: Number.NaN }, mutant('Timeout', 4)], rerun, c.now, () => {});
  assert.deepEqual(pass.refusals, ['retry of scripts/a.ts:3 (StringLiteral): its report gives no full location to retry it by']);
  assert.deepEqual(
    calls.map((call) => named(call.round)),
    [['4:Timeout']],
  );
});

test('a round that cannot run refuses its mutants, says so in the log, and the pass goes on', async () => {
  const c = clock();
  const { lines, log } = kept();
  const outer = at(2, 1, 9, 1);
  let call = 0;
  const pass = await retryTimeouts(
    [outer, mutant('Timeout', 3)],
    async (round) => {
      call += 1;
      c.state.t += MIN;
      if (call === 1) return { refusal: 'Stryker exited 1', busy: false };
      return { dryRunEnd: c.state.t, tested: [], stopped: false, report: round.map((m) => ({ ...m, status: 'Killed' })) };
    },
    c.now,
    log,
  );
  assert.deepEqual(pass.refusals, ['retry round 1 of 2 (scripts/a.ts:2:1 StringLiteral ("\\"\\"")): Stryker exited 1']);
  assert.deepEqual(named(pass.mutants), ['3:Killed']);
  assert.equal(pass.retried, 1);
  assert.deepEqual(lines.slice(0, 2), ['  retry round 1 of 2: 1 timed-out mutant(s) in 1 file(s)', '  retry round 1 of 2: refused after 1.0 min']);
  assert.equal(lines[3], '  retry 1 of 2: scripts/a.ts:3:5 StringLiteral ("\\"\\""): Killed', 'a status from the report alone has no time');
});

test('a busy dry run stops the pass: later rounds never start, and one refusal names their mutants', async () => {
  const c = clock();
  let runs = 0;
  const pass = await retryTimeouts(
    [at(2, 1, 9, 1), mutant('Timeout', 3), mutant('Killed', 4), mutant('Timeout', 5)],
    async () => {
      runs += 1;
      return { refusal: 'busy', busy: true };
    },
    c.now,
    () => {},
  );
  assert.equal(runs, 1);
  assert.deepEqual(pass.refusals, [
    'retry round 1 of 2 (scripts/a.ts:2:1 StringLiteral ("\\"\\"")): busy',
    'a retry found the machine busy; 2 timed-out mutant(s) left unretried: scripts/a.ts:3:5 StringLiteral ("\\"\\""), scripts/a.ts:5:5 StringLiteral ("\\"\\""). For each, make the suite that owns its file kill it fast, or push again when the machine is quieter',
  ]);
  assert.deepEqual(named(pass.mutants), ['4:Killed']);
});

test('a pass a busy dry run stopped stays busy, even when the next round would start past the wall', async () => {
  const c = clock();
  const pass = await retryTimeouts(
    [at(2, 1, 9, 1), mutant('Timeout', 3)],
    async () => {
      c.state.t = RETRY_BUDGET_MS + MIN;
      return { refusal: 'busy', busy: true };
    },
    c.now,
    () => {},
  );
  assert.match(pass.refusals[1] ?? '', /^a retry found the machine busy; 1 timed-out mutant/);
});

test('a refused round counts as start only until its dry run ended; the rest of its time is the rest', async () => {
  const c = clock();
  let call = 0;
  const pass = await retryTimeouts(
    [at(2, 1, 9, 1), mutant('Timeout', 3), mutant('Timeout', 4)],
    async () => {
      call += 1;
      if (call === 1) {
        c.state.t = 10 * MIN;
        return { refusal: 'Stryker exited 1', busy: false, dryRunEnd: MIN };
      }
      c.state.t = RETRY_BUDGET_MS;
      return { dryRunEnd: null, tested: [], stopped: true, report: null };
    },
    c.now,
    () => {},
  );
  // The first round: 1 min of start, 9 of the rest. The second never ended its dry run: 5 min of start.
  assert.match(pass.refusals[1] ?? '', /: 6\.0 min went to starting Stryker and its initial test run \(2 run\(s\)\), 0\.0 min to 0 mutant\(s\) that timed out again, and 9\.0 min to the rest;/);
});

test('of two equally slow mutants, the first is the slowest', async () => {
  const c = clock();
  const pass = await retryTimeouts(
    [mutant('Timeout', 3), mutant('Timeout', 4), mutant('Timeout', 5)],
    async () => {
      c.state.t = RETRY_BUDGET_MS;
      return {
        dryRunEnd: 0,
        tested: [
          { mutant: mutant('Killed', 3), at: 5 * SEC },
          { mutant: mutant('Killed', 4), at: 10 * SEC },
        ],
        stopped: true,
        report: null,
      };
    },
    c.now,
    () => {},
  );
  assert.match(pass.refusals[0] ?? '', /the slowest, scripts\/a\.ts:3:5 StringLiteral \("\\"\\""\), took 5\.0 s/);
});

test('a busy last round refuses once: no mutant was left', async () => {
  const pass = await retryTimeouts([mutant('Timeout', 3)], async () => ({ refusal: 'busy', busy: true }), () => 0, () => {});
  assert.deepEqual(pass.refusals, ['retry round 1 of 1 (scripts/a.ts:3:5 StringLiteral ("\\"\\"")): busy']);
});

test('a retry missing from its report, or reported Ignored, refuses that mutant; the round goes on', async () => {
  const c = clock();
  const { lines, log } = kept();
  const pass = await retryTimeouts(
    [mutant('Timeout', 2), mutant('Timeout', 3), mutant('Timeout', 4)],
    async () => ({ dryRunEnd: 0, tested: [], stopped: false, report: [mutant('Ignored', 3), mutant('Killed', 4), mutant('Killed', 9)] }),
    c.now,
    log,
  );
  assert.deepEqual(pass.refusals, [
    'retry of scripts/a.ts:2 (StringLiteral): its report does not hold the mutant',
    'retry of scripts/a.ts:3 (StringLiteral): Stryker ignored the mutant it was retrying',
  ]);
  assert.deepEqual(named(pass.mutants), ['4:Killed']);
  assert.equal(pass.retried, 1);
  assert.equal(lines[1], '  retry 1 of 3: scripts/a.ts:4:5 StringLiteral ("\\"\\""): Killed');
});

test('a retry takes its own mutant, not a nested one that starts at the same place (#557)', async () => {
  // `if (held === '' && !sawEmpty)`: the outer condition and the nested `held === ''` both start at 3:5.
  const outer: Mutant = { ...mutant('Timeout'), mutator: 'ConditionalExpression', replacement: 'true', endColumn: 30 };
  const nested: Mutant = { ...outer, endColumn: 16 };
  const pass = await retryTimeouts(
    [outer],
    async () => ({ dryRunEnd: 0, tested: [], stopped: false, report: [{ ...nested, status: 'Ignored' }, { ...outer, status: 'Killed' }] }),
    () => 0,
    () => {},
  );
  assert.deepEqual(pass.refusals, []);
  assert.deepEqual(
    pass.mutants.map((m) => `${m.line}:${m.endColumn}:${m.status}`),
    ['3:30:Killed'],
  );
});

test("a mutant's time runs from the event before it; other mutants' events count for the gaps; no dry-run event means the whole round was its start", async () => {
  const c = clock();
  const { lines, log } = kept();
  const extra = { ...mutant('Killed', 3), replacement: '"x"' };
  await retryTimeouts(
    [mutant('Timeout', 3), mutant('Timeout', 4)],
    async () => {
      c.state.t = 100 * SEC;
      return {
        dryRunEnd: 10 * SEC,
        tested: [
          { mutant: extra, at: 12 * SEC },
          { mutant: mutant('Killed', 3), at: 15 * SEC },
          { mutant: mutant('Killed', 4), at: 22 * SEC },
        ],
        stopped: false,
        report: null,
      };
    },
    c.now,
    log,
  );
  assert.deepEqual(lines.slice(1), ['  retry 1 of 2: scripts/a.ts:3:5 StringLiteral ("\\"\\""): Killed after 3.0 s', '  retry 2 of 2: scripts/a.ts:4:5 StringLiteral ("\\"\\""): Killed after 7.0 s']);
});

/** A spent record, for outgrew's own tests. */
const spent = (over: Partial<Spent>): Spent => ({ gone: 15 * MIN, dryRuns: 0, rounds: 1, hangs: 0, hung: [], slowest: null, ...over });

test('outgrew: where the time went, what was left, and the largest share named as the cause', () => {
  const left = [mutant('Timeout', 8)];
  const head = (dry: string, hangs: string, n: number, rest: string) =>
    `the timeout retry pass reached its 15-minute budget after 15.0 min: ${dry} went to starting Stryker and its initial test run (2 run(s)), ${hangs} to ${n} mutant(s) that timed out again, and ${rest} to the rest; 1 timed-out mutant(s) left unretried: scripts/a.ts:8:5 StringLiteral ("\\"\\"")`;
  assert.equal(
    outgrew(spent({ rounds: 2, dryRuns: MIN, hangs: 12 * MIN, hung: [mutant('Timeout', 3), mutant('Timeout', 4)] }), left),
    `${head('1.0 min', '12.0 min', 2, '2.0 min')}. Mostly hangs: each mutant that timed out again took the whole 3-minute limit, so a re-run will not pass. For each (scripts/a.ts:3:5 StringLiteral ("\\"\\""), scripts/a.ts:4:5 StringLiteral ("\\"\\"")), make the suite that owns its file kill it fast`,
  );
  assert.equal(
    outgrew(spent({ rounds: 2, dryRuns: 9 * MIN, hangs: 3 * MIN, hung: [mutant('Timeout', 3)] }), left),
    `${head('9.0 min', '3.0 min', 1, '3.0 min')}. Mostly Stryker's start and initial test runs, which each round pays once: make the owning suites start faster`,
  );
  assert.equal(
    outgrew(spent({ rounds: 2, dryRuns: MIN, slowest: { mutant: mutant('Killed', 5), ms: 42 * SEC } }), left),
    `${head('1.0 min', '0.0 min', 0, '14.0 min')}. Mostly mutants that ended before the limit, but slowly; the slowest, scripts/a.ts:5:5 StringLiteral ("\\"\\""), took 42.0 s: for each, make the suite that owns its file kill it fast`,
  );
  assert.equal(
    outgrew(spent({ rounds: 2, dryRuns: MIN }), left),
    `${head('1.0 min', '0.0 min', 0, '14.0 min')}. Mostly mutants that ended before the limit, but slowly: for each, make the suite that owns its file kill it fast`,
  );
  assert.doesNotMatch(outgrew(spent({ dryRuns: 14 * MIN }), left), /busy|quieter/, 'only a dry run that times out blames the machine');
});

test('outgrew breaks a tie toward hangs, then toward the dry runs', () => {
  const cause = (over: Partial<Spent>) => /\. Mostly (\w+)/.exec(outgrew(spent(over), []))?.[1];
  assert.equal(cause({ gone: 15 * MIN, dryRuns: 5 * MIN, hangs: 5 * MIN }), 'hangs', 'all three equal');
  assert.equal(cause({ gone: 10 * MIN, dryRuns: 5 * MIN, hangs: 5 * MIN }), 'hangs', 'hangs tie the dry runs');
  assert.equal(cause({ gone: 10 * MIN, dryRuns: 0, hangs: 5 * MIN }), 'hangs', 'hangs tie the rest');
  assert.equal(cause({ gone: 10 * MIN, dryRuns: 5 * MIN, hangs: 0 }), 'Stryker', 'the dry runs tie the rest');
  assert.equal(cause({ gone: 10 * MIN, dryRuns: 4 * MIN, hangs: 5 * MIN }), 'hangs');
  assert.equal(cause({ gone: 10 * MIN, dryRuns: 6 * MIN, hangs: 3 * MIN }), 'Stryker');
  assert.equal(cause({ gone: 10 * MIN, dryRuns: 4 * MIN, hangs: 2 * MIN }), 'Stryker');
  assert.equal(cause({ gone: 10 * MIN, dryRuns: 4 * MIN + 1, hangs: 4 * MIN }), 'Stryker');
  assert.equal(cause({ gone: 10 * MIN, dryRuns: 3 * MIN, hangs: 3 * MIN }), 'mutants');
});

test('the wall stops a round: what Stryker finished counts, the rest is left, and one refusal says where the time went', async () => {
  const c = clock();
  const { lines, log } = kept();
  const hang = mutant('Timeout', 3);
  const deadlines: number[] = [];
  let runs = 0;
  const pass = await retryTimeouts(
    [hang, mutant('Timeout', 4), mutant('Timeout', 5), at(2, 1, 9, 1)],
    async (_round, deadline) => {
      runs += 1;
      deadlines.push(deadline);
      c.state.t = RETRY_BUDGET_MS;
      // The first round's 15 s dry run, then a 3-minute hang, a quick kill, and the stop.
      return {
        dryRunEnd: 15 * SEC,
        tested: [
          { mutant: hang, at: 15 * SEC + RETRY_TIMEOUT_MS },
          { mutant: { ...mutant('Killed', 4) }, at: 21 * SEC + RETRY_TIMEOUT_MS },
        ],
        stopped: true,
        report: null,
      };
    },
    c.now,
    log,
  );
  assert.equal(runs, 1, 'no round starts at the wall');
  assert.deepEqual(deadlines, [RETRY_BUDGET_MS]);
  assert.deepEqual(named(pass.mutants), ['3:Timeout', '4:Killed']);
  assert.equal(pass.retried, 2);
  assert.deepEqual(pass.refusals, [
    'the timeout retry pass reached its 15-minute budget after 15.0 min: 0.3 min went to starting Stryker and its initial test run (1 run(s)), 3.0 min to 1 mutant(s) that timed out again, and 11.8 min to the rest; 2 timed-out mutant(s) left unretried: scripts/a.ts:5:5 StringLiteral ("\\"\\""), scripts/a.ts:2:1 StringLiteral ("\\"\\""). Mostly mutants that ended before the limit, but slowly; the slowest, scripts/a.ts:4:5 StringLiteral ("\\"\\""), took 6.0 s: for each, make the suite that owns its file kill it fast',
  ]);
  assert.equal(lines.at(-1), '  timed out again (caught, but every run pays a whole retry for it; make the suite that owns its file kill it fast): scripts/a.ts:3:5 StringLiteral ("\\"\\"")');
});

test('a round stopped before its dry run ended counts wholly as start; one stopped with nothing left refuses nothing', async () => {
  const c = clock();
  const pass = await retryTimeouts(
    [mutant('Timeout', 3)],
    async () => {
      c.state.t = RETRY_BUDGET_MS;
      return { dryRunEnd: null, tested: [], stopped: true, report: null };
    },
    c.now,
    () => {},
  );
  assert.match(pass.refusals[0] ?? '', /: 15\.0 min went to starting Stryker .*Mostly Stryker's start/);

  const done = await retryTimeouts(
    [mutant('Timeout', 3)],
    async () => ({ dryRunEnd: 0, tested: [{ mutant: mutant('Killed', 3), at: 1 }], stopped: true, report: null }),
    () => 0,
    () => {},
  );
  assert.deepEqual(done.refusals, []);
  assert.deepEqual(named(done.mutants), ['3:Killed']);
});

test('the wall is the pass start plus the budget: a round starts 1 ms before it, and none at it', async () => {
  for (const [gone, rounds] of [
    [RETRY_BUDGET_MS - 1, 2],
    [RETRY_BUDGET_MS, 1],
  ] as const) {
    const c = clock(MIN);
    let runs = 0;
    const pass = await retryTimeouts(
      [at(2, 1, 9, 1), mutant('Timeout', 3)],
      async (round) => {
        runs += 1;
        c.state.t = MIN + gone;
        return { dryRunEnd: MIN, tested: [], stopped: false, report: round.map((m) => ({ ...m, status: 'Killed' })) };
      },
      c.now,
      () => {},
    );
    assert.equal(runs, rounds, `after ${gone} ms`);
    assert.equal(pass.refusals.length, 2 - rounds);
  }
});

test("#654's shape: 33 timeouts in one file pass inside the wall, where a run per mutant would outgrow it", async () => {
  // 31 mutants killed in 6 s and 2 that hang to the 3-minute limit, behind a 15 s dry run.
  const timeouts = Array.from({ length: 33 }, (_, i) => mutant('Timeout', 10 + i));
  const hangs = new Set([timeouts[30], timeouts[32]]);
  const c = clock();
  const { calls, rerun } = steady(
    c,
    15 * SEC,
    (m) => (hangs.has(m) ? RETRY_TIMEOUT_MS : 6 * SEC),
    (m) => (hangs.has(m) ? 'Timeout' : 'Killed'),
  );
  const pass = await retryTimeouts(timeouts, rerun, c.now, () => {});
  assert.equal(calls.length, 1, 'one round, so one dry run');
  assert.equal(pass.retried, 33);
  assert.deepEqual(pass.refusals, []);
  assert.ok(c.state.t < RETRY_BUDGET_MS, `${minutes(c.state.t)} inside the wall`);
  assert.equal(c.state.t, 561 * SEC, '15 s + 31 × 6 s + 2 × 180 s');
  // One run per mutant pays the dry run 33 times: 8.25 min of it.
  assert.ok(33 * 15 * SEC + 31 * 6 * SEC + 2 * RETRY_TIMEOUT_MS > RETRY_BUDGET_MS);
});
