// A strict reader for Vitest's JSON reporter output.
//
// A gate that reads a test harness's report must not mistake a malformed or
// inconsistent report for a run: a `testResults` that is not an array, a
// status it does not know, or totals that disagree with the results they sum
// read as "fewer tests" rather than "the harness lied", so each is refused.
// Shape and invariants follow Vitest's JsonReporter (vitest 4); unknown extra
// fields are allowed, so a reporter that adds data does not break the gate.

export const TEST_STATUSES = ['passed', 'failed', 'skipped', 'pending', 'todo'] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export interface VitestAssertion {
  readonly title: string;
  readonly fullName: string;
  readonly status: TestStatus;
  readonly failureMessages: readonly string[];
}

export interface VitestFileResult {
  readonly name: string;
  /** Optional: a report without a file status is still read; when present it must agree. */
  readonly status?: 'passed' | 'failed';
  /** Suite-level error (an unloadable file); empty when the file loaded. */
  readonly message: string;
  readonly assertionResults: readonly VitestAssertion[];
}

export interface VitestJsonReport {
  readonly numTotalTests: number;
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly success: boolean;
  readonly testResults: readonly VitestFileResult[];
}

export class HarnessReportError extends Error {
  constructor(problem: string) {
    super(`vitest JSON report rejected: ${problem}`);
    this.name = 'HarnessReportError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (raw: Record<string, unknown>, key: string): number => {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HarnessReportError(`${key} is not a non-negative integer`);
  return value;
};

const text = (raw: Record<string, unknown>, key: string, where: string): string => {
  const value = raw[key];
  if (typeof value !== 'string') throw new HarnessReportError(`${where}.${key} is not a string`);
  return value;
};

const assertionOf = (raw: unknown, where: string): VitestAssertion => {
  if (!isRecord(raw)) throw new HarnessReportError(`${where} is not an object`);
  const status = raw['status'];
  if (!(TEST_STATUSES as readonly unknown[]).includes(status)) throw new HarnessReportError(`${where}.status ${String(JSON.stringify(status))} is not a known test status`);
  const messages = raw['failureMessages'];
  if (!Array.isArray(messages) || !messages.every((m) => typeof m === 'string')) throw new HarnessReportError(`${where}.failureMessages is not a string[]`);
  return { title: text(raw, 'title', where), fullName: text(raw, 'fullName', where), status: status as TestStatus, failureMessages: messages as string[] };
};

const fileOf = (raw: unknown, index: number): VitestFileResult => {
  const where = `testResults[${String(index)}]`;
  if (!isRecord(raw)) throw new HarnessReportError(`${where} is not an object`);
  const name = text(raw, 'name', where);
  if (name.length === 0) throw new HarnessReportError(`${where}.name is empty`);
  const status = raw['status'];
  if (status !== undefined && status !== 'passed' && status !== 'failed') throw new HarnessReportError(`${where}.status ${JSON.stringify(status)} is not passed or failed`);
  const message = text(raw, 'message', where);
  const results = raw['assertionResults'];
  if (!Array.isArray(results)) throw new HarnessReportError(`${where}.assertionResults is not an array`);
  const assertionResults = results.map((item, i) => assertionOf(item, `${where}.assertionResults[${String(i)}]`));
  // The converse is not checked: a failed hook fails the file with its error on a nested suite, which this report does not carry.
  if (status === 'passed' && (assertionResults.some((t) => t.status === 'failed') || message.length > 0)) {
    throw new HarnessReportError(`${where} says passed but carries a failed test or a suite error`);
  }
  return { name, ...(status === undefined ? {} : { status }), message, assertionResults };
};

/** One JSON reporter object, parsed; throws {@link HarnessReportError}. */
export const parseVitestJsonReport = (raw: unknown): VitestJsonReport => {
  if (!isRecord(raw)) throw new HarnessReportError('report is not an object');
  const files = raw['testResults'];
  if (!Array.isArray(files)) throw new HarnessReportError('testResults is not an array');
  const success = raw['success'];
  if (typeof success !== 'boolean') throw new HarnessReportError('success is not a boolean');
  const testResults = files.map(fileOf);
  const tests = testResults.flatMap((f) => f.assertionResults);
  const report: VitestJsonReport = {
    numTotalTests: count(raw, 'numTotalTests'),
    numPassedTests: count(raw, 'numPassedTests'),
    numFailedTests: count(raw, 'numFailedTests'),
    success,
    testResults,
  };
  const failedSuites = count(raw, 'numFailedTestSuites');
  const failed = tests.filter((t) => t.status === 'failed').length;
  const passed = tests.filter((t) => t.status === 'passed').length;
  if (report.numTotalTests !== tests.length) throw new HarnessReportError(`numTotalTests ${String(report.numTotalTests)} but ${String(tests.length)} test results`);
  if (report.numFailedTests !== failed || report.numPassedTests !== passed) {
    throw new HarnessReportError(`passed/failed totals ${String(report.numPassedTests)}/${String(report.numFailedTests)} but results say ${String(passed)}/${String(failed)}`);
  }
  const anyFileFailed = testResults.some((f) => f.status === 'failed' || f.message.length > 0);
  if (report.success && (failed > 0 || anyFileFailed || failedSuites > 0)) throw new HarnessReportError('success is true over a failed run');
  if (!report.success && failed === 0 && !anyFileFailed && failedSuites === 0 && tests.length > 0) throw new HarnessReportError('success is false over a clean run');
  return report;
};

/** A line that claims to be a report: a JSON object with its own `testResults` key. */
const claim = (line: string): Record<string, unknown> | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    // fail-open: a stdout line that is not JSON is runner noise, not a report.
    return undefined;
  }
  return isRecord(value) && Object.hasOwn(value, 'testResults') ? value : undefined;
};

/**
 * The reports in a runner's stdout: every line that claims to be one, parsed
 * strictly. Other JSON lines (a test's own logged object) are ignored; a
 * claim that breaks the contract is returned as an error, never dropped.
 */
export const readVitestJsonReports = (stdout: string): { reports: VitestJsonReport[]; errors: string[] } => {
  const reports: VitestJsonReport[] = [];
  const errors: string[] = [];
  for (const line of stdout.split('\n')) {
    const raw = claim(line);
    if (raw === undefined) continue;
    try {
      reports.push(parseVitestJsonReport(raw));
    } catch (error) {
      if (!(error instanceof HarnessReportError)) throw error;
      errors.push(error.message);
    }
  }
  return { reports, errors };
};
