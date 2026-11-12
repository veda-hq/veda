import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HarnessReportError, parseVitestJsonReport, readVitestJsonReports } from './vitest-json-report.ts';

const report = (statuses: string[], totals: Record<string, unknown> = {}): Record<string, unknown> => {
  const failed = statuses.filter((s) => s === 'failed').length;
  return {
    numTotalTests: statuses.length,
    numPassedTests: statuses.filter((s) => s === 'passed').length,
    numFailedTests: failed,
    numFailedTestSuites: 0,
    success: failed === 0,
    testResults: [
      {
        name: '/repo/src/a.test.ts',
        status: failed > 0 ? 'failed' : 'passed',
        message: '',
        assertionResults: statuses.map((status, i) => ({ title: `t${String(i)}`, fullName: `a t${String(i)}`, status, failureMessages: status === 'failed' ? ['boom'] : [] })),
      },
    ],
    ...totals,
  };
};

/** `report(statuses)` with its one file's fields replaced. */
const withFile = (statuses: string[], file: Record<string, unknown>, totals: Record<string, unknown> = {}): Record<string, unknown> => {
  const raw = report(statuses, totals);
  const [first] = raw['testResults'] as Array<Record<string, unknown>>;
  return { ...raw, testResults: [{ ...first, ...file }] };
};

const withAssertions = (assertionResults: unknown[]): Record<string, unknown> => withFile([], { assertionResults }, { numTotalTests: 1 });

const PREFIX = 'vitest JSON report rejected: ';
const rejects = (raw: unknown, problem: string): void => {
  assert.throws(() => parseVitestJsonReport(raw), { name: 'HarnessReportError', message: `${PREFIX}${problem}` });
};

describe('parseVitestJsonReport', () => {
  it('near miss: skipped, todo and pending tests are results, not errors', () => {
    const parsed = parseVitestJsonReport(report(['passed', 'skipped', 'todo', 'pending']));
    assert.equal(parsed.numPassedTests, 1);
    assert.equal(parsed.numTotalTests, 4);
  });

  it('near miss: a run with no tests may report failure', () => {
    assert.equal(parseVitestJsonReport(report([], { success: false })).success, false);
  });

  it('reads the reporter fields it judges and keeps a file status only when given', () => {
    const given = parseVitestJsonReport(report(['passed', 'failed'], { success: false }));
    assert.deepEqual(given, {
      numTotalTests: 2,
      numPassedTests: 1,
      numFailedTests: 1,
      success: false,
      testResults: [
        {
          name: '/repo/src/a.test.ts',
          status: 'failed',
          message: '',
          assertionResults: [
            { title: 't0', fullName: 'a t0', status: 'passed', failureMessages: [] },
            { title: 't1', fullName: 'a t1', status: 'failed', failureMessages: ['boom'] },
          ],
        },
      ],
    });
    const absent = parseVitestJsonReport(withFile(['passed'], { status: undefined }));
    assert.deepEqual(Object.keys(absent.testResults[0] ?? {}), ['name', 'message', 'assertionResults']);
  });

  it('names itself in every rejection', () => {
    assert.throws(() => parseVitestJsonReport([]), (e: unknown) => e instanceof HarnessReportError && e.name === 'HarnessReportError' && e.message === `${PREFIX}report is not an object`);
  });

  const cases: Array<[string, unknown, string]> = [
    ['an unknown test status', report(['passd']), 'testResults[0].assertionResults[0].status "passd" is not a known test status'],
    ['a missing test status', withAssertions([{ title: 't', fullName: 't', failureMessages: [] }]), 'testResults[0].assertionResults[0].status undefined is not a known test status'],
    ['testResults that is not an array', { ...report([]), testResults: {} }, 'testResults is not an array'],
    ['a total that disagrees with the results', report(['passed'], { numTotalTests: 2 }), 'numTotalTests 2 but 1 test results'],
    ['passed/failed totals swapped', report(['passed', 'failed'], { numPassedTests: 0, numFailedTests: 2 }), 'passed/failed totals 0/2 but results say 1/1'],
    ['a passed total alone that disagrees', report(['passed', 'failed'], { numPassedTests: 2 }), 'passed/failed totals 2/1 but results say 1/1'],
    ['success over a failed test', report(['failed'], { success: true }), 'success is true over a failed run'],
    ['success over a failed suite', report(['passed'], { numFailedTestSuites: 1 }), 'success is true over a failed run'],
    ['success over a file marked failed', withFile(['passed'], { status: 'failed' }), 'success is true over a failed run'],
    ['success over a file that did not load', withFile(['passed'], { status: undefined, message: 'boom' }), 'success is true over a failed run'],
    ['failure over a clean run', report(['passed'], { success: false }), 'success is false over a clean run'],
    ['a missing success flag', report(['passed'], { success: undefined }), 'success is not a boolean'],
    ['a negative total', report([], { numTotalTests: -1 }), 'numTotalTests is not a non-negative integer'],
    ['a fractional total', report(['passed'], { numPassedTests: 0.5 }), 'numPassedTests is not a non-negative integer'],
    ['a total given as text', report([], { numFailedTests: '0' }), 'numFailedTests is not a non-negative integer'],
    ['a missing failed-suite total', report([], { numFailedTestSuites: undefined }), 'numFailedTestSuites is not a non-negative integer'],
    ['a file that says passed over a failed test', withFile(['failed'], { status: 'passed' }), 'testResults[0] says passed but carries a failed test or a suite error'],
    ['a file that says passed over a suite error', withFile([], { message: 'boom' }), 'testResults[0] says passed but carries a failed test or a suite error'],
    ['a non-object result', withAssertions([1]), 'testResults[0].assertionResults[0] is not an object'],
    ['a non-string title', withAssertions([{ status: 'passed', failureMessages: [], fullName: 'x' }]), 'testResults[0].assertionResults[0].title is not a string'],
    ['a non-string full name', withAssertions([{ status: 'passed', failureMessages: [], title: 'x' }]), 'testResults[0].assertionResults[0].fullName is not a string'],
    ['non-string failure messages', withAssertions([{ title: 't', fullName: 't', status: 'failed', failureMessages: [{}] }]), 'testResults[0].assertionResults[0].failureMessages is not a string[]'],
    ['missing failure messages', withAssertions([{ title: 't', fullName: 't', status: 'passed' }]), 'testResults[0].assertionResults[0].failureMessages is not a string[]'],
    ['a nameless file', { ...report([]), testResults: [{ name: '', message: '', assertionResults: [] }] }, 'testResults[0].name is empty'],
    ['a file whose name is not text', { ...report([]), testResults: [{ message: '', assertionResults: [] }] }, 'testResults[0].name is not a string'],
    ['a file status outside passed/failed', { ...report([]), testResults: [{ name: 'a', status: 'skipped', message: '', assertionResults: [] }] }, 'testResults[0].status "skipped" is not passed or failed'],
    ['a file without a message', { ...report([]), testResults: [{ name: 'a', assertionResults: [] }] }, 'testResults[0].message is not a string'],
    ['a file without results', { ...report([]), testResults: [{ name: 'a', message: '' }] }, 'testResults[0].assertionResults is not an array'],
    ['a non-object second file', { ...report([]), testResults: [{ name: 'a', message: '', assertionResults: [] }, null] }, 'testResults[1] is not an object'],
  ];
  for (const [name, raw, problem] of cases) {
    it(`rejects ${name}`, () => {
      rejects(raw, problem);
    });
  }
});

describe('readVitestJsonReports', () => {
  it('bad: a mistyped report is an error, not a silently shorter run', () => {
    const typo = JSON.stringify(report(['passd']));
    assert.deepEqual(readVitestJsonReports(`noise\n${typo}\n`), {
      reports: [],
      errors: [`${PREFIX}testResults[0].assertionResults[0].status "passd" is not a known test status`],
    });
  });

  it('skips runner noise and JSON that does not claim to be a report', () => {
    const { reports, errors } = readVitestJsonReports(`{not json\n{"event":"log"}\n[1]\n42\n"text"\nnull\n[{"testResults":[]}]\n{"__proto__":{"testResults":[]}}\n  ${JSON.stringify(report(['passed']))}  \n`);
    assert.equal(reports.length, 1);
    assert.deepEqual(errors, []);
  });

  it('judges a claim whose testResults is not an array, and a line ending in a carriage return', () => {
    assert.deepEqual(readVitestJsonReports('{"testResults":1}\r\n').errors, [`${PREFIX}testResults is not an array`]);
  });
});
