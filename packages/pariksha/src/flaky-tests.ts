// flaky-tests: run the listed test files several times with Vitest and
// refuse a test that passes in some runs and fails in others.
//
// Verdicts (evaluateRuns):
//   - a test passes in some runs and fails in others   → flaky, exit 1
//   - every run fails                                   → not flaky, still exit 1
//   - a run fails without collecting a test case        → runner failure, exit 1
//   - every run passes                                  → exit 0
// A file that fails every time is not flaky, but it is not a pass either.
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { readVitestJsonReports } from './vitest-json-report.ts';

export interface FlakyTestResult {
  testName: string;
  file: string;
  runs: number;
  passes: number;
  failures: number;
  isFlaky: boolean;
  flakinessRate: number;
  failureMessages: string[];
}

/** One run's outcome, across every package root. */
export interface RunOutcome {
  /** Every package-root invocation exited 0 over a report it could trust. */
  readonly passed: boolean;
  /** At least one root in this run exited non-zero without delivering a test case, or left an untrusted report. */
  readonly emptyFailure: boolean;
  /** The failing roots' status lines, suite errors and runner noise. */
  readonly output: string;
}

/** What one run's JSON reporter output contributed. */
export interface ParsedRun {
  /** Suite-level failure messages (an unloadable file). */
  readonly suiteErrors: string[];
  /** Test cases delivered, whatever their status. */
  readonly collected: number;
  /** Reports that passed the strict reader. */
  readonly reports: number;
  /** Strict reports whose own `success` is false. */
  readonly failedReports: number;
  /** Lines that claimed to be a report and broke its contract. */
  readonly reportErrors: string[];
}

export type Verdict = 'flaky' | 'consistent-failure' | 'runner-failure' | 'clean';

export interface Evaluation {
  readonly verdict: Verdict;
  readonly exitCode: 0 | 1;
  readonly lines: string[];
}

/** One `vitest run`: stdout and stderr are null when the spawn failed; `error` when the runner never started. */
export interface SpawnOutcome {
  readonly status: number | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly error?: Error;
}

/** Runs Vitest with these arguments (after `vitest`) in `cwd`. */
export type VitestRunner = (args: readonly string[], cwd: string) => SpawnOutcome;

/** `npx vitest …`, its output captured. */
export const npxVitest: VitestRunner = (args, cwd) =>
  spawnSync('npx', ['vitest', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });

export interface Config {
  /** Which listed paths are test files. */
  readonly include: RegExp;
  /** Directories, relative to the root, whose files Vitest runs from there; the rest run from the root. */
  readonly packageRoots: readonly string[];
  /** Globs passed to Vitest as `--exclude`. */
  readonly exclude: readonly string[];
}

export const DEFAULT_CONFIG: Config = { include: /\.(test|spec)\.(ts|tsx|js|jsx)$/, packageRoots: [], exclude: [] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** The config a product passes; each field replaces its default, and an unknown field is refused. */
export const parseConfig = (text: string | undefined): Config => {
  if (text === undefined) return DEFAULT_CONFIG;
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error('the config is not a JSON object');
  const unknown = Object.keys(raw).filter((k) => !['include', 'packageRoots', 'exclude'].includes(k));
  if (unknown.length > 0) throw new Error(`the config has unknown field(s): ${unknown.join(', ')}`);
  const { include, packageRoots, exclude } = raw;
  if (include !== undefined && typeof include !== 'string') throw new Error('include is not a regex string');
  if (packageRoots !== undefined && !isStrings(packageRoots)) throw new Error('packageRoots is not a list of strings');
  if (exclude !== undefined && !isStrings(exclude)) throw new Error('exclude is not a list of strings');
  return {
    include: include === undefined ? DEFAULT_CONFIG.include : new RegExp(include),
    packageRoots: packageRoots ?? DEFAULT_CONFIG.packageRoots,
    exclude: exclude ?? DEFAULT_CONFIG.exclude,
  };
};

/** A run count: an integer from 1 to 1000, or null. */
export const parseRuns = (text: string): number | null => {
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 && value <= 1000 ? value : null;
};

export const DEFAULT_RUNS = 5;

/** Keep the tail of the runner output so a huge stack trace stays readable. */
const MAX_OUTPUT_CHARS = 6000;

/** A JSON line: the reporter's payload, or a test's own logged object. */
const isReporterPayload = (line: string): boolean => line.trim().startsWith('{');

/** The output that is not the JSON payload: what a human needs when a suite fails to load. */
export const runnerNoise = (stdout: string, stderr: string): string => {
  const stdoutNoise = stdout
    .split('\n')
    .filter((l) => l.trim().length > 0 && !isReporterPayload(l))
    .join('\n');
  return [stderr.trim(), stdoutNoise.trim()].filter(Boolean).join('\n');
};

/** A root's run that exited non-zero delivering no test case: an unloadable file or a crashed runner. */
export const isEmptyFailure = (status: number | null, collected: number): boolean => status !== 0 && collected === 0;

const tail = (text: string): string => (text.length > MAX_OUTPUT_CHARS ? `…(truncated)…\n${text.slice(-MAX_OUTPUT_CHARS)}` : text);

/** The verdict on the collected per-test stats and per-run outcomes; no I/O. */
export const evaluateRuns = (results: ReadonlyMap<string, FlakyTestResult>, runOutcomes: readonly RunOutcome[]): Evaluation => {
  const lines: string[] = [];
  const allTests = Array.from(results.values());
  const flakyTests = allTests.filter((r) => r.isFlaky);
  const consistentFailures = allTests.filter((r) => r.failures === r.runs && r.runs > 0);
  const failedRuns = runOutcomes.filter((r) => !r.passed);
  // Judged per root and per run, never in aggregate: a run that collected
  // tests must not launder one that could not.
  const emptyFailedRuns = failedRuns.filter((r) => r.emptyFailure);
  const allRunsFailed = runOutcomes.length > 0 && failedRuns.length === runOutcomes.length;
  const lastFailureOutput = failedRuns
    .map((r) => r.output)
    .filter(Boolean)
    .at(-1);

  const flakyLines: string[] = [];
  for (const t of flakyTests) {
    flakyLines.push('', `   ${t.file}`, `     Rate: ${(t.flakinessRate * 100).toFixed(0)}% (${String(t.failures)}/${String(t.runs)} failed)`, `     Test: ${t.testName}`);
    const [first] = t.failureMessages;
    if (first !== undefined) flakyLines.push(`     Error: ${first.substring(0, 200)}...`);
  }

  // A run that did not execute the file takes the verdict; flaky tests seen in the other runs are still listed.
  if (emptyFailedRuns.length > 0) {
    lines.push(
      '',
      '❌ Test execution failed: the runner exited non-zero without collecting a single test case.',
      `   ${String(emptyFailedRuns.length)}/${String(runOutcomes.length)} run(s) failed that way. The file under test is not flaky — it did not run at all.`,
      '',
      '   Runner output (last failing run):',
      '',
      tail(lastFailureOutput ?? '   (the runner produced no output)'),
    );
    if (flakyTests.length > 0) lines.push('', '⚠️  The runs that did execute also found flaky tests:', ...flakyLines);
    return { verdict: 'runner-failure', exitCode: 1, lines };
  }

  if (flakyTests.length > 0) {
    lines.push('', '⚠️  Found flaky tests:', ...flakyLines);
    return { verdict: 'flaky', exitCode: 1, lines };
  }

  if (allRunsFailed || consistentFailures.length > 0) {
    lines.push('', '❌ No flaky tests found, but the tests failed in EVERY run.', '   A deterministic failure is not flakiness — it is a broken test or environment.', '');
    for (const t of consistentFailures) {
      lines.push(`   ❌ ${t.file}`, `      Test: ${t.testName}`);
      const [first] = t.failureMessages;
      if (first !== undefined) lines.push(`      Error: ${(first.split('\n')[0] as string).substring(0, 150)}...`);
      lines.push('');
    }
    if (lastFailureOutput) lines.push('   Runner output (last failing run):', '', tail(lastFailureOutput));
    return { verdict: 'consistent-failure', exitCode: 1, lines };
  }

  lines.push('', `✅ No flaky tests found across ${String(results.size)} test cases.`);
  return { verdict: 'clean', exitCode: 0, lines };
};

/**
 * Fold one run's JSON reporter output into `results`. An unloadable file is a
 * suite with a non-empty `message` and no assertion results, and the reporter
 * prints nothing to stderr, so the message alone is its cause.
 */
export const parseTestResults = (output: string, results: Map<string, FlakyTestResult>): ParsedRun => {
  const suiteErrors: string[] = [];
  let collected = 0;
  const { reports, errors } = readVitestJsonReports(output);
  for (const report of reports) {
    for (const testResult of report.testResults) {
      const file = testResult.name;
      if (testResult.message) suiteErrors.push(`${file}\n  ${testResult.message}`);
      for (const test of testResult.assertionResults) {
        const testName = test.title || test.fullName || 'unknown';
        const key = `${file}::${testName}`;
        const stats = results.get(key) ?? { testName, file, runs: 0, passes: 0, failures: 0, isFlaky: false, flakinessRate: 0, failureMessages: [] };
        results.set(key, stats);
        stats.runs++;
        collected++;
        if (test.status === 'passed') stats.passes++;
        else if (test.status === 'failed') {
          stats.failures++;
          const [first] = test.failureMessages;
          if (first !== undefined) stats.failureMessages.push(first);
        }
        // 'skipped', 'todo' and 'pending' count as collected, not as outcomes.
        if (stats.passes > 0 && stats.failures > 0) {
          stats.isFlaky = true;
          stats.flakinessRate = stats.failures / stats.runs;
        }
      }
    }
  }
  return { suiteErrors, collected, reports: reports.length, failedReports: reports.filter((r) => !r.success).length, reportErrors: errors };
};

/**
 * Did this root's run leave a report the detector can trust? A clean exit
 * with no report, a report that broke the contract, or a clean exit over a
 * report saying `success: false` is a harness failure.
 */
export const harnessFailure = (status: number | null, parsed: ParsedRun): string | null => {
  if (parsed.reportErrors.length > 0) return parsed.reportErrors.join('\n');
  if (status === 0 && parsed.reports === 0) return 'vitest exited 0 but printed no JSON report';
  if (status === 0 && parsed.failedReports > 0) return 'vitest exited 0 but its JSON report says success: false';
  return null;
};

/** One package root's run, folded into `results` and judged. */
export interface RootRun {
  readonly parsed: ParsedRun;
  /** False when the report cannot be trusted (see {@link harnessFailure}). */
  readonly trusted: boolean;
  /** Nothing usable was collected: an empty or untrusted run. */
  readonly emptyFailure: boolean;
  /** Why it is untrusted, ready for the run's error output. */
  readonly errors: string;
}

export const readRootRun = (root: string, status: number | null, stdout: string, results: Map<string, FlakyTestResult>): RootRun => {
  // Judged on a scratch map first: an untrusted root's outcomes must not reach the shared results.
  const parsed = parseTestResults(stdout, new Map());
  const harness = harnessFailure(status, parsed);
  if (harness === null) parseTestResults(stdout, results);
  return {
    parsed,
    trusted: harness === null,
    emptyFailure: harness !== null || isEmptyFailure(status, parsed.collected),
    errors: harness === null ? '' : `[${root}] untrusted test report: ${harness}\n`,
  };
};

/**
 * The files grouped by package root, each relative to its root; '.' (the
 * repository root) first, for files under none. A root holds a file at
 * `<root>/…`, or the path equal to it.
 */
export const groupByRoot = (config: Config, files: readonly string[]): Map<string, string[]> => {
  const byRoot = new Map<string, string[]>([['.', []]]);
  for (const file of files) {
    const root = config.packageRoots.find((r) => file.startsWith(`${r}/`) || file === r) ?? '.';
    const list = byRoot.get(root) ?? [];
    byRoot.set(root, list);
    list.push(file);
  }
  return byRoot;
};

/**
 * The detector: `runs` passes over the listed files (paths relative to
 * `projectRoot`), each package root's files in one Vitest call from that root.
 * Lines go to `out` as the original printed them.
 */
export const runFlakyTests = (config: Config, runs: number, mode: string, projectRoot: string, files: readonly string[], runner: VitestRunner, out: (line: string) => void): 0 | 1 => {
  out(`🔄 Detecting flaky tests (${String(runs)} runs)...`);
  out(`   Mode: ${mode}`);
  if (files.length === 0) {
    out('No files found to analyze.');
    return 0;
  }
  out(`   Running on ${String(files.length)} files...`);
  const results = new Map<string, FlakyTestResult>();
  const byRoot = groupByRoot(config, files);
  const runOutcomes: RunOutcome[] = [];
  for (let i = 1; i <= runs; i++) {
    let runSuccess = true;
    let runEmptyFailure = false;
    let groupErrors = '';
    for (const [root, rootFiles] of byRoot) {
      if (rootFiles.length === 0) continue;
      const args = ['run', '--reporter=json', '--passWithNoTests', ...config.exclude.flatMap((g) => ['--exclude', g]), ...rootFiles.map((f) => relative(root, f))];
      try {
        const result = runner(args, resolve(projectRoot, root));
        // A runner that never started has no output to judge.
        if (result.error) throw result.error;
        // A runner killed before it wrote anything leaves null streams.
        const stdout = result.stdout ?? '';
        const stderr = result.stderr ?? '';
        const rootRun = readRootRun(root, result.status, stdout, results);
        runEmptyFailure ||= rootRun.emptyFailure;
        runSuccess &&= rootRun.trusted;
        groupErrors += rootRun.errors;
        if (result.status !== 0) {
          runSuccess = false;
          const noise = runnerNoise(stdout, stderr);
          groupErrors += `[${root}] vitest exited with status ${String(result.status)}\n`;
          for (const suiteError of rootRun.parsed.suiteErrors) groupErrors += `${suiteError}\n`;
          if (noise) groupErrors += `${noise}\n`;
        }
      } catch (e) {
        runSuccess = false;
        runEmptyFailure = true;
        groupErrors += `[${root}] Spawn Error: ${(e as Error).message}\n`;
      }
    }
    out(`   Run ${String(i)}/${String(runs)}: ${runSuccess ? '✅ Passed' : '❌ Failed'}`);
    runOutcomes.push({ passed: runSuccess, emptyFailure: runEmptyFailure, output: groupErrors });
  }
  const evaluation = evaluateRuns(results, runOutcomes);
  evaluation.lines.forEach(out);
  return evaluation.exitCode;
};
