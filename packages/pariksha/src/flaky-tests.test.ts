import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  evaluateRuns,
  groupByRoot,
  harnessFailure,
  isEmptyFailure,
  npxVitest,
  parseConfig,
  parseRuns,
  parseTestResults,
  readRootRun,
  runFlakyTests,
  runnerNoise,
  type Config,
  type FlakyTestResult,
  type RunOutcome,
  type SpawnOutcome,
} from './flaky-tests.ts';

/** One file's results as a complete JSON reporter object (totals included). */
const report = (files: Array<{ name: string; message?: string; status?: 'passed' | 'failed'; tests: Array<{ title: string; status: string; failureMessages?: string[] }> }>): Record<string, unknown> => {
  const tests = files.flatMap((f) => f.tests);
  const failed = tests.filter((t) => t.status === 'failed').length;
  const fileFailed = files.some((f) => f.status === 'failed' || (f.message ?? '') !== '');
  return {
    numTotalTestSuites: files.length,
    numFailedTestSuites: 0,
    numTotalTests: tests.length,
    numPassedTests: tests.filter((t) => t.status === 'passed').length,
    numFailedTests: failed,
    numPendingTests: 0,
    numTodoTests: 0,
    success: failed === 0 && !fileFailed,
    testResults: files.map((f) => ({
      name: f.name,
      message: f.message ?? '',
      ...(f.status ? { status: f.status } : {}),
      assertionResults: f.tests.map((t) => ({ ancestorTitles: [], title: t.title, fullName: t.title, status: t.status, failureMessages: t.failureMessages ?? [] })),
    })),
  };
};

const vitestJson = (file: string, tests: Array<{ title: string; status: 'passed' | 'failed'; message?: string }>): string =>
  JSON.stringify(
    report([
      {
        name: file,
        status: tests.some((t) => t.status === 'failed') ? 'failed' : 'passed',
        tests: tests.map((t) => ({ title: t.title, status: t.status, failureMessages: t.message ? [t.message] : [] })),
      },
    ]),
  );

const collect = (runs: string[]): Map<string, FlakyTestResult> => {
  const results = new Map<string, FlakyTestResult>();
  for (const stdout of runs) parseTestResults(stdout, results);
  return results;
};

const FAILED_RUN: RunOutcome = { passed: false, emptyFailure: true, output: '[apps/mobile] vitest exited with status 1\nError: Failed to resolve import "./missing-module"' };
const PASSED_RUN: RunOutcome = { passed: true, emptyFailure: false, output: '' };
/** A run that exited non-zero AFTER delivering its test cases. */
const FAILED_RUN_WITH_TESTS: RunOutcome = { ...FAILED_RUN, emptyFailure: false };

const result = (overrides: Partial<FlakyTestResult>): FlakyTestResult => ({ testName: 't', file: 'src/f.test.ts', runs: 2, passes: 2, failures: 0, isFlaky: false, flakinessRate: 0, failureMessages: [], ...overrides });

const EVERY_RUN = ['', '❌ No flaky tests found, but the tests failed in EVERY run.', '   A deterministic failure is not flakiness — it is a broken test or environment.', ''];

describe('evaluateRuns', () => {
  it('fails when every run exits non-zero and no test case was collected', () => {
    const evaluation = evaluateRuns(
      new Map(),
      Array.from({ length: 5 }, () => FAILED_RUN),
    );
    assert.equal(evaluation.verdict, 'runner-failure');
    assert.equal(evaluation.exitCode, 1);
    const text = evaluation.lines.join('\n');
    assert.ok(!text.includes('No flaky tests found'));
    assert.ok(text.includes('5/5 run(s) failed that way'));
    assert.ok(text.includes('Failed to resolve import "./missing-module"'));
  });

  it('fails when a single run exits non-zero and nothing was collected', () => {
    const evaluation = evaluateRuns(new Map(), [PASSED_RUN, FAILED_RUN, PASSED_RUN]);
    assert.equal(evaluation.verdict, 'runner-failure');
    assert.ok(evaluation.lines.join('\n').includes('1/3 run(s) failed that way'));
  });

  it('fails when a later run collects zero tests after earlier runs collected some', () => {
    const pass = vitestJson('src/d.test.ts', [{ title: 'ok', status: 'passed' }]);
    const evaluation = evaluateRuns(collect([pass, pass]), [PASSED_RUN, FAILED_RUN, PASSED_RUN]);
    assert.equal(evaluation.verdict, 'runner-failure');
    assert.equal(evaluation.exitCode, 1);
    assert.ok(evaluation.lines.join('\n').includes('1/3 run(s) failed that way'));
  });

  it('tells the reader when the runner produced no output at all', () => {
    const evaluation = evaluateRuns(new Map(), [{ passed: false, emptyFailure: true, output: '' }]);
    assert.equal(evaluation.exitCode, 1);
    assert.ok(evaluation.lines.join('\n').includes('produced no output'));
  });

  it('fails, not passes, when a test fails deterministically in every run', () => {
    const failing = vitestJson('src/a.test.ts', [{ title: 'adds', status: 'failed', message: 'expected 2 to be 3\n  at a' }]);
    const evaluation = evaluateRuns(
      collect([failing, failing, failing]),
      Array.from({ length: 3 }, () => FAILED_RUN_WITH_TESTS),
    );
    assert.equal(evaluation.verdict, 'consistent-failure');
    assert.equal(evaluation.exitCode, 1);
    const text = evaluation.lines.join('\n');
    for (const part of ['failed in EVERY run', 'src/a.test.ts', 'Test: adds', 'Error: expected 2 to be 3...', 'Runner output (last failing run)']) assert.ok(text.includes(part), part);
  });

  it('reports a test that passes in some runs and fails in others as flaky', () => {
    const pass = vitestJson('src/b.test.ts', [{ title: 'races', status: 'passed' }]);
    const fail = vitestJson('src/b.test.ts', [{ title: 'races', status: 'failed', message: 'timeout' }]);
    const evaluation = evaluateRuns(collect([pass, fail, pass, pass, fail]), [PASSED_RUN, FAILED_RUN_WITH_TESTS, PASSED_RUN, PASSED_RUN, FAILED_RUN_WITH_TESTS]);
    assert.equal(evaluation.verdict, 'flaky');
    assert.equal(evaluation.exitCode, 1);
    const text = evaluation.lines.join('\n');
    for (const part of ['Found flaky tests', 'Rate: 40% (2/5 failed)', 'Test: races']) assert.ok(text.includes(part), part);
  });

  it('reports both, with the runner failure taking the verdict, when an empty run and a flaky test coincide', () => {
    const pass = vitestJson('src/e.test.ts', [{ title: 'races', status: 'passed' }]);
    const fail = vitestJson('src/e.test.ts', [{ title: 'races', status: 'failed', message: 'timeout' }]);
    const evaluation = evaluateRuns(collect([pass, fail, pass]), [PASSED_RUN, FAILED_RUN_WITH_TESTS, PASSED_RUN, FAILED_RUN]);
    assert.equal(evaluation.verdict, 'runner-failure');
    const text = evaluation.lines.join('\n');
    assert.ok(text.includes('Failed to resolve import "./missing-module"'));
    assert.ok(text.includes('also found flaky tests'));
    assert.ok(text.indexOf('without collecting') < text.indexOf('Test: races'));
  });

  it('passes when every run passes', () => {
    const pass = vitestJson('src/c.test.ts', [
      { title: 'one', status: 'passed' },
      { title: 'two', status: 'passed' },
    ]);
    const evaluation = evaluateRuns(collect([pass, pass, pass]), [PASSED_RUN, PASSED_RUN, PASSED_RUN]);
    assert.equal(evaluation.verdict, 'clean');
    assert.equal(evaluation.exitCode, 0);
    assert.ok(evaluation.lines.join('\n').includes('No flaky tests found across 2 test cases'));
  });

  it('still passes with zero test cases when no run failed (--passWithNoTests)', () => {
    assert.deepEqual(evaluateRuns(new Map(), [PASSED_RUN, PASSED_RUN]).exitCode, 0);
  });

  it('lays out a runner failure line by line, with no flaky section when none flaked', () => {
    assert.deepEqual(evaluateRuns(new Map(), [FAILED_RUN]).lines, [
      '',
      '❌ Test execution failed: the runner exited non-zero without collecting a single test case.',
      '   1/1 run(s) failed that way. The file under test is not flaky — it did not run at all.',
      '',
      '   Runner output (last failing run):',
      '',
      FAILED_RUN.output,
    ]);
  });

  it('lays out the flaky tests found beside a runner failure', () => {
    const pass = vitestJson('src/e.test.ts', [{ title: 'races', status: 'passed' }]);
    const fail = vitestJson('src/e.test.ts', [{ title: 'races', status: 'failed', message: 'timeout' }]);
    assert.deepEqual(evaluateRuns(collect([pass, fail, pass]), [PASSED_RUN, FAILED_RUN_WITH_TESTS, FAILED_RUN]).lines.slice(7), [
      '',
      '⚠️  The runs that did execute also found flaky tests:',
      '',
      '   src/e.test.ts',
      '     Rate: 33% (1/3 failed)',
      '     Test: races',
      '     Error: timeout...',
    ]);
  });

  it('lays out a flaky test, with no Error line when it left no message', () => {
    const results = new Map([['src/f.test.ts::quiet', result({ testName: 'quiet', runs: 2, passes: 1, failures: 1, isFlaky: true, flakinessRate: 0.5 })]]);
    assert.deepEqual(evaluateRuns(results, [PASSED_RUN, FAILED_RUN_WITH_TESTS]), {
      verdict: 'flaky',
      exitCode: 1,
      lines: ['', '⚠️  Found flaky tests:', '', '   src/f.test.ts', '     Rate: 50% (1/2 failed)', '     Test: quiet'],
    });
  });

  it('cuts a flaky error at 200 characters', () => {
    const results = new Map([['k', result({ passes: 1, failures: 1, isFlaky: true, flakinessRate: 0.5, failureMessages: ['e'.repeat(300), 'second'] })]]);
    assert.equal(evaluateRuns(results, [PASSED_RUN]).lines.at(-1), `     Error: ${'e'.repeat(200)}...`);
  });

  it('lays out a deterministic failure line by line, its error cut at its first line and 150 characters', () => {
    const failing = vitestJson('src/a.test.ts', [{ title: 'adds', status: 'failed', message: 'expected 2 to be 3\n  at a' }]);
    assert.deepEqual(evaluateRuns(collect([failing, failing]), [FAILED_RUN_WITH_TESTS, FAILED_RUN_WITH_TESTS]).lines, [
      ...EVERY_RUN,
      '   ❌ src/a.test.ts',
      '      Test: adds',
      '      Error: expected 2 to be 3...',
      '',
      '   Runner output (last failing run):',
      '',
      FAILED_RUN.output,
    ]);
    const long = new Map([['k', result({ failures: 2, passes: 0, failureMessages: ['x'.repeat(200)] })]]);
    assert.equal(evaluateRuns(long, [PASSED_RUN]).lines.at(-2), `      Error: ${'x'.repeat(150)}...`);
  });

  it('lays out a deterministic failure that left no message and no output', () => {
    const results = new Map([['src/g.test.ts::mute', result({ testName: 'mute', file: 'src/g.test.ts', runs: 1, passes: 0, failures: 1 })]]);
    assert.deepEqual(evaluateRuns(results, [{ ...FAILED_RUN_WITH_TESTS, output: '' }]).lines, [...EVERY_RUN, '   ❌ src/g.test.ts', '      Test: mute', '']);
  });

  it('fails when every run failed even though no single test failed in all of them', () => {
    for (const results of [new Map<string, FlakyTestResult>(), new Map([['t', result({})]])]) {
      assert.deepEqual(evaluateRuns(results, [FAILED_RUN_WITH_TESTS, FAILED_RUN_WITH_TESTS]), {
        verdict: 'consistent-failure',
        exitCode: 1,
        lines: [...EVERY_RUN, '   Runner output (last failing run):', '', FAILED_RUN.output],
      });
    }
  });

  it('does not read a test that never ran as one that failed every time', () => {
    const results = new Map([['src/h.test.ts::never', result({ runs: 0, passes: 0, failures: 0 })]]);
    assert.deepEqual(evaluateRuns(results, [PASSED_RUN]), { verdict: 'clean', exitCode: 0, lines: ['', '✅ No flaky tests found across 1 test cases.'] });
  });

  it('is clean with no runs at all', () => {
    assert.deepEqual(evaluateRuns(new Map(), []), { verdict: 'clean', exitCode: 0, lines: ['', '✅ No flaky tests found across 0 test cases.'] });
  });

  it('keeps an output of exactly 6000 characters whole, and cuts one more to its tail', () => {
    const lastLine = (output: string): string | undefined => evaluateRuns(new Map(), [{ passed: false, emptyFailure: true, output }]).lines.at(-1);
    const whole = 'x'.repeat(6_000);
    assert.equal(lastLine(whole), whole);
    assert.equal(lastLine(`y${whole}`), `…(truncated)…\n${whole}`);
    const text = lastLine(`${'x'.repeat(10_000)}LAST`) ?? '';
    assert.ok(text.includes('(truncated)') && text.includes('LAST') && text.length < 7_000);
  });

  it('lists a flaky test line by line, with its first error', () => {
    const pass = vitestJson('src/b.test.ts', [{ title: 'races', status: 'passed' }]);
    const fail = vitestJson('src/b.test.ts', [{ title: 'races', status: 'failed', message: 'timeout' }]);
    assert.deepEqual(evaluateRuns(collect([pass, fail]), [PASSED_RUN, FAILED_RUN_WITH_TESTS]).lines, ['', '⚠️  Found flaky tests:', '', '   src/b.test.ts', '     Rate: 50% (1/2 failed)', '     Test: races', '     Error: timeout...']);
  });

  it('puts the flaky list under the runner failure, after a blank line', () => {
    const results = new Map([['t', result({ failures: 1, passes: 1, isFlaky: true, flakinessRate: 0.5 })]]);
    assert.deepEqual(evaluateRuns(results, [FAILED_RUN]).lines.slice(7), ['', '⚠️  The runs that did execute also found flaky tests:', '', '   src/f.test.ts', '     Rate: 50% (1/2 failed)', '     Test: t']);
  });

  it('lists a consistent failure with no recorded error, and no Error line', () => {
    assert.deepEqual(evaluateRuns(new Map([['t', result({ failures: 2, passes: 0 })]]), [PASSED_RUN]).lines, [...EVERY_RUN, '   ❌ src/f.test.ts', '      Test: t', '']);
  });
});

describe('isEmptyFailure', () => {
  it('is true for a non-zero exit, or a signal-killed runner, that delivered no test case', () => {
    assert.equal(isEmptyFailure(1, 0), true);
    assert.equal(isEmptyFailure(null, 0), true);
  });

  it('is false for a non-zero exit that delivered test cases, and for a clean exit with none', () => {
    assert.equal(isEmptyFailure(1, 3), false);
    assert.equal(isEmptyFailure(0, 0), false);
  });
});

describe('parseTestResults', () => {
  it('returns the suite-level message of an unloadable file (zero assertions)', () => {
    const results = new Map<string, FlakyTestResult>();
    const parsed = parseTestResults(JSON.stringify(report([{ name: 'src/unloadable.test.ts', status: 'failed', message: "Cannot find module './does-not-exist'", tests: [] }])), results);
    assert.equal(results.size, 0);
    assert.equal(parsed.collected, 0);
    assert.deepEqual(parsed.suiteErrors, ["src/unloadable.test.ts\n  Cannot find module './does-not-exist'"]);
  });

  it('keeps the suite message when the reporter omits the suite status', () => {
    const parsed = parseTestResults(JSON.stringify(report([{ name: 'src/syntax.test.ts', message: 'SyntaxError: Unexpected token', tests: [] }])), new Map());
    assert.deepEqual(parsed.reportErrors, []);
    assert.deepEqual(parsed.suiteErrors, ['src/syntax.test.ts\n  SyntaxError: Unexpected token']);
  });

  it('ignores the empty message a passing suite carries', () => {
    const parsed = parseTestResults(JSON.stringify(report([{ name: 'src/ok.test.ts', status: 'passed', tests: [{ title: 'ok', status: 'passed' }] }])), new Map());
    assert.deepEqual(parsed.suiteErrors, []);
    assert.equal(parsed.collected, 1);
  });

  it('ignores a test that logs its own JSON object, which is not a report', () => {
    const parsed = parseTestResults(`{"event":"guardrail_job_started","jobId":"1"}\n${vitestJson('src/a.test.ts', [{ title: 'ok', status: 'passed' }])}`, new Map());
    assert.equal(parsed.reports, 1);
    assert.deepEqual(parsed.reportErrors, []);
    assert.equal(parsed.collected, 1);
  });

  it('rejects a suite the reporter left unnamed rather than filing it as "unknown"', () => {
    const raw = report([{ name: 'src/a.test.ts', tests: [{ title: 'ok', status: 'passed' }] }]) as { testResults: Array<Record<string, unknown>> };
    delete raw.testResults[0]?.['name'];
    const results = new Map<string, FlakyTestResult>();
    const parsed = parseTestResults(JSON.stringify(raw), results);
    assert.deepEqual(parsed.reportErrors, ['vitest JSON report rejected: testResults[0].name is not a string']);
    assert.equal(parsed.collected, 0);
    assert.equal(results.size, 0);
  });

  it('counts a failure that carries no message, and reads on past it; skipped tests are collected, not outcomes', () => {
    const results = new Map<string, FlakyTestResult>();
    const parsed = parseTestResults(
      JSON.stringify(
        report([
          {
            name: 'src/m.test.ts',
            status: 'failed',
            tests: [
              { title: 'empty', status: 'failed', failureMessages: [] },
              { title: 'after', status: 'passed' },
              { title: 'later', status: 'skipped' },
            ],
          },
        ]),
      ),
      results,
    );
    assert.equal(parsed.collected, 3);
    assert.deepEqual(
      [...results.values()].map((r) => [r.testName, r.runs, r.passes, r.failures, r.failureMessages]),
      [
        ['empty', 1, 0, 1, []],
        ['after', 1, 1, 0, []],
        ['later', 1, 0, 0, []],
      ],
    );
  });

  it('marks a test flaky once it has both passed and failed, at its failure rate', () => {
    const pass = vitestJson('src/a.test.ts', [{ title: 'r', status: 'passed' }]);
    const fail = vitestJson('src/a.test.ts', [{ title: 'r', status: 'failed', message: 'm1' }]);
    const results = collect([fail, pass, fail]);
    assert.deepEqual(results.get('src/a.test.ts::r'), { testName: 'r', file: 'src/a.test.ts', runs: 3, passes: 1, failures: 2, isFlaky: true, flakinessRate: 2 / 3, failureMessages: ['m1', 'm1'] });
  });

  for (const [label, title, fullName, key] of [
    ['its title', 't', 'suite t', 'src/a.test.ts::t'],
    ['its full name when the title is empty', '', 'suite t', 'src/a.test.ts::suite t'],
    ['"unknown" when both are empty', '', '', 'src/a.test.ts::unknown'],
  ] as const) {
    it(`keys a test by ${label}`, () => {
      const raw = report([{ name: 'src/a.test.ts', tests: [{ title, status: 'passed' }] }]) as { testResults: Array<{ assertionResults: Array<{ fullName: string }> }> };
      const first = raw.testResults[0]?.assertionResults[0];
      if (first) first.fullName = fullName;
      assert.deepEqual([...collect([JSON.stringify(raw)]).keys()], [key]);
    });
  }
});

describe('harnessFailure', () => {
  const parse = (stdout: string) => parseTestResults(stdout, new Map());
  const empty = (success: boolean): string => JSON.stringify({ ...report([]), success });

  it('fails a clean exit that printed no report: exit 0 is not proof the tests ran', () => {
    assert.equal(harnessFailure(0, parse('✓ done\n')), 'vitest exited 0 but printed no JSON report');
  });

  it('fails a run whose report broke the contract, whatever the exit code, naming each error on its own line', () => {
    const typo = (title: string): string => JSON.stringify(report([{ name: `src/${title}.test.ts`, tests: [{ title, status: 'passd' }] }]));
    assert.ok(harnessFailure(0, parse(typo('a')))?.includes('"passd" is not a known test status'));
    const parsed = parse(`${typo('a')}\n${typo('b')}\n`);
    assert.equal(parsed.reportErrors.length, 2);
    assert.deepEqual(harnessFailure(1, parsed)?.split('\n'), parsed.reportErrors);
  });

  it('trusts a well-formed report, passing or failing, and leaves a crash with no report to the empty verdict', () => {
    assert.equal(harnessFailure(0, parse(vitestJson('src/a.test.ts', [{ title: 'ok', status: 'passed' }]))), null);
    assert.equal(harnessFailure(1, parse(vitestJson('src/a.test.ts', [{ title: 'ok', status: 'failed', message: 'boom' }]))), null);
    assert.equal(harnessFailure(1, parse('')), null);
  });

  it('fails a clean exit whose report says success: false', () => {
    const parsed = parse(empty(false));
    assert.equal(parsed.reports, 1);
    assert.equal(parsed.failedReports, 1);
    assert.equal(harnessFailure(0, parsed), 'vitest exited 0 but its JSON report says success: false');
  });

  it('trusts an empty report that says success: true, and a failed exit that agrees with its report', () => {
    const passing = parse(empty(true));
    assert.equal(passing.failedReports, 0);
    assert.equal(harnessFailure(0, passing), null);
    assert.equal(harnessFailure(1, parse(empty(false))), null);
  });
});

describe('runnerNoise', () => {
  it('keeps stderr and non-JSON stdout, drops the JSON reporter payload', () => {
    assert.equal(runnerNoise('{"testResults":[]}\n\nFAIL src/a.test.ts\n', 'Error: boom\n'), 'Error: boom\nFAIL src/a.test.ts');
  });

  it('is empty when there is nothing but the payload', () => {
    assert.equal(runnerNoise('{"numTotalTests":0}\n', ''), '');
  });

  it('keeps every noise line, one per line, and drops blank and indented-JSON ones', () => {
    assert.equal(runnerNoise('FAIL a\n\n   \nFAIL b\n{"x":1}\n', ''), 'FAIL a\nFAIL b');
    assert.equal(runnerNoise('FAIL a\n\n   \n  {"x":1}\nFAIL b\n', ''), 'FAIL a\nFAIL b');
  });
});

describe('readRootRun', () => {
  const pass = vitestJson('src/a.test.ts', [{ title: 'ok', status: 'passed' }]);

  it('trusts a clean run that reported its tests, and folds them into the shared results', () => {
    const results = new Map<string, FlakyTestResult>();
    const run = readRootRun('apps/web', 0, pass, results);
    assert.equal(run.parsed.collected, 1);
    assert.deepEqual([run.trusted, run.emptyFailure, run.errors], [true, false, '']);
    assert.deepEqual([...results.keys()], ['src/a.test.ts::ok']);
  });

  it('distrusts a clean exit with no report, and says why', () => {
    const run = readRootRun('apps/web', 0, '✓ done\n', new Map());
    assert.deepEqual([run.trusted, run.emptyFailure, run.errors], [false, true, '[apps/web] untrusted test report: vitest exited 0 but printed no JSON report\n']);
  });

  it('marks a crash that collected nothing as empty, not untrusted', () => {
    const run = readRootRun('.', 1, '', new Map());
    assert.deepEqual([run.parsed.collected, run.trusted, run.emptyFailure, run.errors], [0, true, true, '']);
  });

  it('distrusts a clean exit over a report that says success: false', () => {
    const run = readRootRun('apps/web', 0, JSON.stringify({ ...report([]), success: false }), new Map());
    assert.deepEqual([run.parsed.failedReports, run.trusted, run.emptyFailure, run.errors], [1, false, true, '[apps/web] untrusted test report: vitest exited 0 but its JSON report says success: false\n']);
  });

  for (const [name, stdout] of [
    ['a clean exit over a report that failed its tests', vitestJson('src/a.test.ts', [{ title: 'ok', status: 'failed' }])],
    ['a good report beside one that broke the contract', `${pass}\n${JSON.stringify(report([{ name: 'src/b.test.ts', tests: [{ title: 'ok', status: 'passd' }] }]))}`],
  ] as const) {
    it(`adds nothing to the shared results for ${name}`, () => {
      const results = new Map<string, FlakyTestResult>();
      assert.equal(readRootRun('.', 0, stdout, results).trusted, false);
      assert.deepEqual([...results.keys()], []);
    });
  }
});

describe('parseConfig and parseRuns', () => {
  it('defaults each field, and replaces the ones given', () => {
    assert.equal(parseConfig(undefined), DEFAULT_CONFIG);
    assert.deepEqual(parseConfig('{}'), DEFAULT_CONFIG);
    const config = parseConfig('{"include":"\\\\.test\\\\.ts$","packageRoots":["apps/a"],"exclude":["**/tmp/**"]}');
    assert.deepEqual([config.include.source, config.packageRoots, config.exclude], ['\\.test\\.ts$', ['apps/a'], ['**/tmp/**']]);
  });

  for (const [text, message] of [
    ['[]', 'the config is not a JSON object'],
    ['{"roots":[]}', 'the config has unknown field(s): roots'],
    ['{"include":1}', 'include is not a regex string'],
    ['{"packageRoots":"apps"}', 'packageRoots is not a list of strings'],
    ['{"exclude":[1]}', 'exclude is not a list of strings'],
  ] as const) {
    it(`refuses ${text}`, () => {
      assert.throws(() => parseConfig(text), { message });
    });
  }

  it('reads a run count from 1 to 1000, and refuses anything else', () => {
    assert.deepEqual(['1', '1000', '+3', '007'].map(parseRuns), [1, 1000, 3, 7]);
    assert.deepEqual(['abc', 'many', '2.5', '0', '-2', '1001', '', ' 3', '1e2', '99999999999999999999'].map(parseRuns), Array.from({ length: 10 }, () => null));
  });
});

describe('groupByRoot', () => {
  it('puts a file under the first root that holds it, the rest under the repository root', () => {
    const config: Config = { ...DEFAULT_CONFIG, packageRoots: ['apps/server', 'apps', 'packages/shared'] };
    assert.deepEqual(
      [...groupByRoot(config, ['apps/server/a.test.ts', 'apps/serverless/h.test.ts', 'scripts/g.test.ts', 'packages/shared', 'apps/web/c.test.ts'])],
      [
        ['.', ['scripts/g.test.ts']],
        ['apps/server', ['apps/server/a.test.ts']],
        ['apps', ['apps/serverless/h.test.ts', 'apps/web/c.test.ts']],
        ['packages/shared', ['packages/shared']],
      ],
    );
  });
});

interface Call {
  readonly args: readonly string[];
  readonly cwd: string;
}

const PROJECT = '/repo';
/** Six package roots and an exclude, as a product's config gives them. */
const PRODUCT: Config = { ...DEFAULT_CONFIG, packageRoots: ['apps/server', 'apps/mobile', 'apps/web', 'packages/shared', 'packages/test-utils', 'packages/claude-mods'], exclude: ['**/.stryker-tmp/**'] };
const VITEST_ARGS = ['run', '--reporter=json', '--passWithNoTests', '--exclude', '**/.stryker-tmp/**'];
const filesOf = (call: Call): string[] => call.args.slice(VITEST_ARGS.length);

/** A run in which every file given delivered one passing test. */
const passEveryFile = (call: Call): SpawnOutcome => ({ status: 0, stdout: JSON.stringify(report(filesOf(call).map((name) => ({ name, tests: [{ title: 'ok', status: 'passed' }] })))), stderr: '' });

const ran = (stdout: string, status: number | null = 0, stderr = ''): SpawnOutcome => ({ status, stdout, stderr });

const detect = (files: string[], runs = 1, spawn: (call: Call) => SpawnOutcome = passEveryFile, config: Config = PRODUCT): { code: number; out: string[]; calls: Call[] } => {
  const out: string[] = [];
  const calls: Call[] = [];
  const code = runFlakyTests(
    config,
    runs,
    'files',
    PROJECT,
    files,
    (args, cwd) => {
      const call = { args, cwd };
      calls.push(call);
      return spawn(call);
    },
    (line) => out.push(line),
  );
  return { code, out, calls };
};

const runnerFailureOut = (output: string): string[] => [
  '🔄 Detecting flaky tests (1 runs)...',
  '   Mode: files',
  '   Running on 1 files...',
  '   Run 1/1: ❌ Failed',
  '',
  '❌ Test execution failed: the runner exited non-zero without collecting a single test case.',
  '   1/1 run(s) failed that way. The file under test is not flaky — it did not run at all.',
  '',
  '   Runner output (last failing run):',
  '',
  output,
];

describe('runFlakyTests', () => {
  it('runs each package root from its own directory, the rest from the root', () => {
    const run = detect([
      'apps/server/src/a.test.ts',
      'apps/mobile/src/b.test.ts',
      'apps/web/src/c.test.ts',
      'packages/shared/src/d.test.ts',
      'packages/test-utils/src/e.test.ts',
      'packages/claude-mods/src/f.test.ts',
      'scripts/g.test.ts',
      // A sibling that merely shares a root's prefix is not under it.
      'apps/serverless/h.test.ts',
    ]);
    assert.deepEqual(run.calls, [
      { args: [...VITEST_ARGS, 'scripts/g.test.ts', 'apps/serverless/h.test.ts'], cwd: PROJECT },
      ...[
        ['apps/server', 'src/a.test.ts'],
        ['apps/mobile', 'src/b.test.ts'],
        ['apps/web', 'src/c.test.ts'],
        ['packages/shared', 'src/d.test.ts'],
        ['packages/test-utils', 'src/e.test.ts'],
        ['packages/claude-mods', 'src/f.test.ts'],
      ].map(([root, file]) => ({ args: [...VITEST_ARGS, file as string], cwd: `${PROJECT}/${root as string}` })),
    ]);
    assert.equal(run.code, 0);
    assert.deepEqual(run.out, ['🔄 Detecting flaky tests (1 runs)...', '   Mode: files', '   Running on 8 files...', '   Run 1/1: ✅ Passed', '', '✅ No flaky tests found across 8 test cases.']);
  });

  it('passes no --exclude when the config names none', () => {
    const run = detect(['a.test.ts'], 1, passEveryFile, DEFAULT_CONFIG);
    assert.deepEqual(run.calls[0]?.args, ['run', '--reporter=json', '--passWithNoTests', 'a.test.ts']);
  });

  it("runs a root's files together, every root once per run", () => {
    const run = detect(['apps/web/src/a.test.ts', 'apps/web/src/b.spec.tsx', 'scripts/x.test.ts'], 3);
    const once = [
      [PROJECT, ['scripts/x.test.ts']],
      [`${PROJECT}/apps/web`, ['src/a.test.ts', 'src/b.spec.tsx']],
    ];
    assert.deepEqual(
      run.calls.map((c) => [c.cwd, filesOf(c)]),
      [...once, ...once, ...once],
    );
    assert.deepEqual(run.out, ['🔄 Detecting flaky tests (3 runs)...', '   Mode: files', '   Running on 3 files...', '   Run 1/3: ✅ Passed', '   Run 2/3: ✅ Passed', '   Run 3/3: ✅ Passed', '', '✅ No flaky tests found across 3 test cases.']);
  });

  it('skips a root that has no files: the default root is never run empty', () => {
    const run = detect(['apps/web/src/a.test.ts']);
    assert.deepEqual(
      run.calls.map((c) => c.cwd),
      [`${PROJECT}/apps/web`],
    );
    assert.equal(run.code, 0);
  });

  it('runs nothing when no file is selected', () => {
    const run = detect([], 5);
    assert.deepEqual(run, { code: 0, out: ['🔄 Detecting flaky tests (5 runs)...', '   Mode: files', 'No files found to analyze.'], calls: [] });
  });

  it('reports an unloadable file with its status, suite error and noise', () => {
    const unloadable = JSON.stringify(report([{ name: 'x.test.ts', message: 'Cannot find module', tests: [] }]));
    const run = detect(['x.test.ts'], 1, () => ran(`${unloadable}\nFAIL x.test.ts\n`, 1, 'boom\n'));
    assert.equal(run.code, 1);
    assert.deepEqual(run.out, runnerFailureOut('[.] vitest exited with status 1\nx.test.ts\n  Cannot find module\nboom\nFAIL x.test.ts\n'));
  });

  it('reads a run that failed after delivering its tests as a test failure, not a runner one', () => {
    const run = detect(['x.test.ts'], 1, () => ran(vitestJson('x.test.ts', [{ title: 'adds', status: 'failed', message: 'expected 2 to be 3' }]), 1));
    assert.equal(run.code, 1);
    assert.deepEqual(run.out.slice(4), [...EVERY_RUN, '   ❌ x.test.ts', '      Test: adds', '      Error: expected 2 to be 3...', '', '   Runner output (last failing run):', '', '[.] vitest exited with status 1\n']);
  });

  it('reports a runner killed before it wrote anything', () => {
    assert.deepEqual(detect(['x.test.ts'], 1, () => ({ status: null, stdout: null, stderr: null })).out, runnerFailureOut('[.] vitest exited with status null\n'));
  });

  it('reports a spawn that threw, or returned a spawn error, as a run that collected nothing', () => {
    const threw = detect(['x.test.ts'], 1, () => {
      throw new Error('spawn npx ENOENT');
    });
    assert.equal(threw.code, 1);
    assert.deepEqual(threw.out, runnerFailureOut('[.] Spawn Error: spawn npx ENOENT\n'));
    const returned = detect(['x.test.ts'], 1, () => ({ status: null, stdout: null, stderr: null, error: new Error('spawn npx ENOENT') }));
    assert.deepEqual(returned.out, runnerFailureOut('[.] Spawn Error: spawn npx ENOENT\n'));
  });

  it('fails a run whose root exits non-zero, with the status, suite error and runner noise', () => {
    const failing = JSON.stringify(report([{ name: 'src/a.test.ts', status: 'failed', message: 'Error: hook failed', tests: [{ title: 'adds', status: 'failed', failureMessages: ['expected 2 to be 3'] }] }]));
    const run = detect(['apps/web/src/a.test.ts'], 1, () => ran(`FAIL src/a.test.ts\n${failing}\n`, 1, 'Error: boom\n'));
    assert.deepEqual(run.out, [
      '🔄 Detecting flaky tests (1 runs)...',
      '   Mode: files',
      '   Running on 1 files...',
      '   Run 1/1: ❌ Failed',
      ...EVERY_RUN,
      '   ❌ src/a.test.ts',
      '      Test: adds',
      '      Error: expected 2 to be 3...',
      '',
      '   Runner output (last failing run):',
      '',
      '[apps/web] vitest exited with status 1\nsrc/a.test.ts\n  Error: hook failed\nError: boom\nFAIL src/a.test.ts\n',
    ]);
    assert.equal(run.code, 1);
  });

  it('adds no blank noise line when a failing root printed only its report', () => {
    const run = detect(['apps/web/src/a.test.ts'], 1, () => ran(vitestJson('src/a.test.ts', [{ title: 'adds', status: 'failed', message: 'expected 2 to be 3' }]), 1));
    assert.equal(run.out.at(-1), '[apps/web] vitest exited with status 1\n');
  });

  it('reports a root that exits non-zero with nothing collected as a runner failure', () => {
    assert.deepEqual(detect(['apps/web/src/a.test.ts'], 1, () => ran('', 1)).out, runnerFailureOut('[apps/web] vitest exited with status 1\n'));
  });

  it('fails a clean exit that printed no report, naming the untrusted root', () => {
    const run = detect(['apps/web/src/a.test.ts'], 1, () => ran('✓ done\n', 0));
    assert.deepEqual(run.out, runnerFailureOut('[apps/web] untrusted test report: vitest exited 0 but printed no JSON report\n'));
    assert.equal(run.code, 1);
  });

  it('finds a test that passes in one run and fails in the next', () => {
    let n = 0;
    const run = detect(['x.test.ts'], 2, () => {
      n++;
      return n % 2 === 1 ? ran(vitestJson('x.test.ts', [{ title: 'races', status: 'passed' }])) : ran(vitestJson('x.test.ts', [{ title: 'races', status: 'failed', message: 'timeout' }]), 1);
    });
    assert.equal(run.code, 1);
    assert.deepEqual(run.out.slice(3), ['   Run 1/2: ✅ Passed', '   Run 2/2: ❌ Failed', '', '⚠️  Found flaky tests:', '', '   x.test.ts', '     Rate: 50% (1/2 failed)', '     Test: races', '     Error: timeout...']);
  });
});

describe('npxVitest', () => {
  it('runs in the directory given, and returns a spawn failure rather than throwing it', () => {
    // A directory that does not exist: the runner cannot start there.
    const outcome = npxVitest(['--version'], '/nonexistent/pariksha-flaky-tests');
    assert.equal(outcome.status, null);
    assert.match(String(outcome.error?.message), /ENOENT/);
  });
});
