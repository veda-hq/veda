import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readEvents, RETRY_EVENTS_VAR, RETRY_REPORTER_NAME, RetryReporter, strykerPlugins, type ReporterIo, type TestedLike } from './retry-reporter.ts';

test('the names Stryker and the retry config read', () => {
  assert.equal(RETRY_EVENTS_VAR, 'AGNIPARIKSHA_RETRY_EVENTS');
  assert.equal(RETRY_REPORTER_NAME, 'agnipariksha-retry-log');
  assert.deepEqual(strykerPlugins, [{ kind: 'Reporter', name: 'agnipariksha-retry-log', injectableClass: RetryReporter }]);
});

/** An io that keeps what it is given, on a clock the test moves. */
const fakeIo = (cwd = '/w/pkg') => {
  const appended: [string, string][] = [];
  const printed: string[] = [];
  const clock = { t: 1000 };
  const io: ReporterIo = {
    append: (path, text) => void appended.push([path, text]),
    print: (line) => void printed.push(line),
    now: () => clock.t,
    cwd,
  };
  return { io, appended, printed, clock };
};

const result = (over: Partial<TestedLike> = {}): TestedLike => ({
  fileName: '/w/pkg/src/a.ts',
  mutatorName: 'StringLiteral',
  replacement: '""',
  status: 'Killed',
  location: { start: { line: 3, column: 5 }, end: { line: 4, column: 9 } },
  ...over,
});

test('the reporter appends the dry run and each mutant as one JSON line, and prints each mutant with its seconds', () => {
  const { io, appended, printed, clock } = fakeIo();
  const reporter = new RetryReporter({ [RETRY_EVENTS_VAR]: '/r/events.jsonl' }, io);
  clock.t = 16_000;
  reporter.onDryRunCompleted();
  clock.t = 22_250;
  reporter.onMutantTested(result());
  clock.t = 202_250;
  reporter.onMutantTested(result({ status: 'Timeout', mutatorName: 'BlockStatement', replacement: '{}' }));
  // An ignored mutant ran nothing: its event is written, and no line is printed.
  reporter.onMutantTested(result({ status: 'Ignored', mutatorName: 'ConditionalExpression', replacement: 'true' }));
  assert.deepEqual(appended, [
    ['/r/events.jsonl', '{"kind":"dry-run","at":16000}\n'],
    ['/r/events.jsonl', '{"kind":"mutant","at":22250,"file":"src/a.ts","status":"Killed","mutator":"StringLiteral","replacement":"\\"\\"","line":3,"column":5,"endLine":4,"endColumn":9}\n'],
    ['/r/events.jsonl', '{"kind":"mutant","at":202250,"file":"src/a.ts","status":"Timeout","mutator":"BlockStatement","replacement":"{}","line":3,"column":5,"endLine":4,"endColumn":9}\n'],
    ['/r/events.jsonl', '{"kind":"mutant","at":202250,"file":"src/a.ts","status":"Ignored","mutator":"ConditionalExpression","replacement":"true","line":3,"column":5,"endLine":4,"endColumn":9}\n'],
  ]);
  assert.deepEqual(printed, ['agnipariksha retry: src/a.ts:3:5 StringLiteral: Killed in 6.3 s', 'agnipariksha retry: src/a.ts:3:5 BlockStatement: Timeout in 180.0 s']);
});

test('before a dry-run event, a mutant is timed from when the reporter was made; with no event file it appends nothing', () => {
  const { io, appended, printed, clock } = fakeIo();
  const reporter = new RetryReporter({}, io);
  assert.equal(reporter.path, undefined);
  clock.t = 3000;
  reporter.onMutantTested(result());
  assert.deepEqual(appended, []);
  assert.deepEqual(printed, ['agnipariksha retry: src/a.ts:3:5 StringLiteral: Killed in 2.0 s']);
});

test('by default the reporter reads process.env and appends to the real file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnipariksha-reporter-'));
  const before = process.env[RETRY_EVENTS_VAR];
  const write = process.stdout.write.bind(process.stdout);
  const printed: string[] = [];
  try {
    const file = join(dir, 'events.jsonl');
    process.env[RETRY_EVENTS_VAR] = file;
    // A capture that writes through, so the tap runner still sees the test's lines.
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
      printed.push(String(chunk));
      return write(chunk, ...rest);
    }) as typeof process.stdout.write;
    const reporter = new RetryReporter();
    reporter.onDryRunCompleted();
    reporter.onMutantTested(result({ fileName: join(process.cwd(), 'src/b.ts') }));
    process.stdout.write = write;
    const lines = readFileSync(file, 'utf8').split('\n');
    assert.equal(lines.length, 3, 'two lines and the newline after the last');
    assert.equal(lines[2], '');
    const events = lines.slice(0, 2).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(events[0]?.kind, 'dry-run');
    assert.equal(events[1]?.file, 'src/b.ts');
    assert.ok(typeof events[0]?.at === 'number' && Math.abs((events[0].at as number) - Date.now()) < 60_000, 'it reads the real clock');
    assert.ok(printed.some((chunk) => /^agnipariksha retry: src\/b\.ts:3:5 StringLiteral: Killed in \d+\.\d s\n$/.test(chunk)), printed.join(''));
  } finally {
    process.stdout.write = write;
    if (before === undefined) delete process.env[RETRY_EVENTS_VAR];
    else process.env[RETRY_EVENTS_VAR] = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEvents reads the dry run and each mutant, with repo-relative files, and skips what is not a whole event', () => {
  const text = [
    '{"kind":"dry-run","at":16000}',
    '{"kind":"mutant","at":22250,"file":"src/a.ts","status":"Killed","mutator":"StringLiteral","replacement":"\\"\\"","line":3,"column":5,"endLine":4,"endColumn":9}',
    'not json',
    '{"kind":"mutant","file":"src/a.ts"}',
    '{"kind":"other","at":5}',
    'null',
    '{"kind":"mutant","at":30000,"file":"packages/x/src/b.ts","status":"Timeout","mutator":"BlockStatement","replacement":"{}","line":"7"}',
    '{"kind":"mutant","at":31000,"file":"src/c.ts"',
  ].join('\n');
  assert.deepEqual(readEvents(text, 'packages/x'), {
    dryRunEnd: 16000,
    tested: [
      {
        at: 22250,
        mutant: { file: 'packages/x/src/a.ts', status: 'Killed', mutator: 'StringLiteral', replacement: '""', line: 3, column: 5, endLine: 4, endColumn: 9 },
      },
      {
        at: 30000,
        mutant: {
          file: 'packages/x/src/b.ts',
          status: 'Timeout',
          mutator: 'BlockStatement',
          replacement: '{}',
          line: Number.NaN,
          column: Number.NaN,
          endLine: Number.NaN,
          endColumn: Number.NaN,
        },
      },
    ],
  });
  assert.equal(readEvents('{"kind":"mutant","at":1,"file":"scripts/a.ts"}', '').tested[0]?.mutant.file, 'scripts/a.ts', 'the root lane keeps the path');
  assert.deepEqual(readEvents(undefined, ''), { dryRunEnd: null, tested: [] }, 'no file, no events');
  assert.deepEqual(readEvents('{"kind":"dry-run","at":"9"}', ''), { dryRunEnd: null, tested: [] }, 'a time that is not a number');
});
