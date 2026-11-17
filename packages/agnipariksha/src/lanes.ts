/** A lane is one Stryker config: plan its files, run it, judge it. */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { nameTests } from './failed-tests.ts';
import { forReuse, pruneToTargets } from './reuse-filter.ts';
import { ownerOf, type Exists } from './suite-owner.ts';
import { mutantRange, RETRY_TIMEOUT_MS, retryTimeouts, type RetryRun } from './timeout-retry.ts';
import { judge, readMutants, type Judgement } from './verdict.ts';

export interface Lane {
  name: string;
  /** Repo-relative directory Stryker runs in; '' is the repo root. */
  cwd: string;
  /** The lane's own Stryker config, relative to `cwd`. */
  config: string;
  selects: (path: string) => boolean;
  /** Whether results may be reused (`--incremental`). */
  reuse: boolean;
  /** Variables the config reads, given the owning suites. */
  env: (suites: readonly string[]) => Record<string, string>;
  /** Variables for one rerun when the dry run fails on a `FALLBACK_TRIGGERS` line. */
  fallback?: (suites: readonly string[]) => Record<string, string>;
  /** Whether the lane's own run is narrowed to the owning suites (its `env` names them). */
  ownSuites?: boolean;
}

/** Stryker's line when the initial test run outlives its cap: the machine is busy. */
export const DRY_RUN_TIMEOUT = 'Initial test run timed out!';
/** Stryker's line when a test failed in the initial test run; it names the tests just above it. */
export const FAILED_INITIAL_RUN = 'There were failed tests in the initial test run';
/** Dry-run failures a lane's fallback mode may cure: no related suite found, or one fails in the sandbox. */
export const FALLBACK_TRIGGERS: readonly string[] = [
  'Vitest failed to find test files related to mutated files',
  'No tests were executed',
  FAILED_INITIAL_RUN,
];
/** What to do about a flaky test, said wherever one shows. */
const FIX_THE_FLAKE = 'fix the flake first (an injected, pinned clock is the usual cure), then run again';

/** The refusal for a timeout retry whose initial test run failed: the lane's own run had passed it. */
export function flakyRetry(failedTests: readonly string[]): string {
  const on = failedTests.length > 0 ? ` on ${nameTests(failedTests)}` : '';
  return `the initial test run was flaky: it passed in the lane's run and failed in this retry${on}; ${FIX_THE_FLAKE}, and apply each hung mutant by hand to see that it dies fast`;
}
/** Every console line `runStryker` reports seeing. */
export const MARKERS: readonly string[] = [DRY_RUN_TIMEOUT, ...FALLBACK_TRIGGERS];

export interface Plan {
  lane: Lane;
  /** Repo-relative files to mutate whole. */
  targets: string[];
  suites: string[];
  notJudged: string[];
}

export function planLane(lane: Lane, files: readonly string[], exists: Exists, commentOnly: (file: string) => boolean): Plan {
  const plan: Plan = { lane, targets: [], suites: [], notJudged: [] };
  for (const file of files.filter((path) => lane.selects(path))) {
    const suite = ownerOf(file, exists);
    if (suite === null) plan.notJudged.push(`not judged (no colocated suite): ${file}`);
    else if (commentOnly(file)) plan.notJudged.push(`not judged (comment-only change): ${file}`);
    else {
      plan.targets.push(file);
      if (!plan.suites.includes(suite)) plan.suites.push(suite);
    }
  }
  return plan;
}

export interface LaneDeps {
  /** Absolute paths. */
  root: string;
  reportsDir: string;
  /**
   * Run Stryker; `seen` lists the `MARKERS` its output carried, `refusal`
   * says why the run cannot be trusted whatever it exited with, and
   * `failedTests` names the tests its initial test run failed on.
   */
  runStryker: (
    cwd: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<{ code: number; seen: readonly string[]; refusal?: string; failedTests?: readonly string[] }>;
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, text: string) => void;
  removeFile: (path: string) => void;
  /** The lane's reuse key, or null to run in full. */
  reuseKey: (lane: Lane) => string | null;
  now: () => number;
}

export interface LaneResult {
  judgement: Judgement;
  retried: number;
  refusals: string[];
  /** Targets absent from the report: Stryker lists only files with mutants. Non-blocking. */
  noMutants: string[];
  /** Why the lane reran (all or some targets) in its fallback mode; that run's results count for them. */
  fellBack: string | null;
  /**
   * Targets judged with only the changed files' own suites run: the lane's
   * `ownSuites`, or its fallback mode. Elsewhere a related filter lets any
   * suite that imports a file kill its mutants, a sibling suite included.
   */
  ownSuites: string[];
  /**
   * A lane with no fallback mode whose initial test run failed and then
   * passed when run again with the same variables: which tests flaked. That
   * second run's results count.
   */
  flaky?: string;
}

/** A config that is the lane's own, with the JSON report moved into our directory. */
export function wrapperConfig(configPath: string, reportPath: string): string {
  return [
    `import base from ${JSON.stringify(pathToFileURL(configPath).href)};`,
    `export default { ...base, jsonReporter: { ...base.jsonReporter, fileName: ${JSON.stringify(reportPath)} } };`,
    '',
  ].join('\n');
}

const BUSY = "Stryker's initial test run timed out: the machine is busy; push again when it is quieter";

export async function judgeLane(plan: Plan, deps: LaneDeps): Promise<LaneResult> {
  const { lane } = plan;
  const slug = lane.name.replace(/[^A-Za-z0-9]+/g, '-');
  const cwd = join(deps.root, lane.cwd);
  const report = join(deps.reportsDir, `${slug}.json`);
  const wrapper = join(deps.reportsDir, `${slug}.stryker.config.mjs`);
  deps.writeFile(wrapper, wrapperConfig(join(cwd, lane.config), report));
  const local = (file: string): string => (lane.cwd === '' ? file : file.slice(lane.cwd.length + 1));
  const firstEnv = lane.env(plan.suites);
  const fallbackEnv = lane.fallback?.(plan.suites);

  type Run = RetryRun & { trigger?: string | undefined; failedTests?: readonly string[] };
  const run = async (mutate: string[], extra: string[], env: Record<string, string>): Promise<Run> => {
    deps.removeFile(report);
    const result = await deps.runStryker(cwd, ['run', wrapper, ...extra, '--mutate', mutate.join(',')], env);
    if (result.refusal !== undefined) return { refusal: result.refusal, busy: false };
    if (result.code !== 0) {
      if (result.seen.includes(DRY_RUN_TIMEOUT)) return { refusal: BUSY, busy: true };
      const trigger = FALLBACK_TRIGGERS.find((line) => result.seen.includes(line));
      const failedTests = trigger === FAILED_INITIAL_RUN ? (result.failedTests ?? []) : [];
      const why = trigger === undefined ? '' : ` (${trigger}${failedTests.length > 0 ? `: ${nameTests(failedTests)}` : ''})`;
      return { refusal: `Stryker exited ${result.code}${why}`, busy: false, trigger, failedTests };
    }
    const text = deps.readFile(report);
    if (text === undefined) return { refusal: `Stryker wrote no report at ${report}`, busy: false };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // fail-open: an unreadable report refuses the lane (exit 2), never passes it.
      return { refusal: `Stryker's report ${report} is not JSON`, busy: false };
    }
    const mutants = readMutants(pruneToTargets(raw, lane.cwd, mutate), lane.cwd);
    return typeof mutants === 'string' ? { refusal: mutants, busy: false } : { mutants };
  };

  const key = lane.reuse ? deps.reuseKey(lane) : null;
  const reuseArgs: string[] = [];
  if (key !== null) {
    const file = join(deps.reportsDir, `${slug}.incremental-${key}.json`);
    const stored = deps.readFile(file);
    const kept = stored === undefined ? null : forReuse(stored);
    if (kept === null) deps.removeFile(file);
    else deps.writeFile(file, kept);
    reuseArgs.push('--incremental', '--incrementalFile', file);
  }

  const refused = (refusal: string, fellBack: string | null): LaneResult => ({ judgement: judge([]), retried: 0, refusals: [refusal], noMutants: [], fellBack, ownSuites: [] });
  /** Files judged in the fallback mode; their timeouts retry in it too. */
  const ownSuite = new Set<string>();
  let fellBack: string | null = null;
  let flaky: string | undefined;
  const on = (failedTests: readonly string[] | undefined): string =>
    failedTests !== undefined && failedTests.length > 0 ? ` on ${nameTests(failedTests)}` : '';
  let first = await run(plan.targets.map(local), reuseArgs, firstEnv);
  if ('refusal' in first && first.trigger !== undefined && fallbackEnv !== undefined) {
    fellBack = `its dry run failed: "${first.trigger}"${on(first.failedTests)}`;
    plan.targets.forEach((target) => ownSuite.add(target));
    first = await run(plan.targets.map(local), reuseArgs, fallbackEnv);
  } else if ('refusal' in first && first.trigger === FAILED_INITIAL_RUN) {
    // No fallback mode: run the same dry run once more, as a lane with one reruns in it.
    const failedFirst = first.failedTests;
    first = await run(plan.targets.map(local), reuseArgs, firstEnv);
    if ('refusal' in first && first.trigger === FAILED_INITIAL_RUN) {
      return refused(`the initial test run failed on both runs, the second time: ${first.refusal}; fix those tests, then run again`, null);
    }
    if (!('refusal' in first)) flaky = `its initial test run failed${on(failedFirst)}, then passed when run again: the test is flaky; ${FIX_THE_FLAKE}`;
  }
  if ('refusal' in first) return refused(first.refusal, fellBack);
  let mutants = first.mutants;

  // A file whose every live mutant is NoCoverage had no related suite reach it
  // (a `createRequire` source): rerun just those files once in the fallback mode.
  const live = (file: string) => mutants.filter((m) => m.file === file && m.status !== 'Ignored');
  const unreached = plan.targets.filter((file) => fellBack === null && live(file).length > 0 && live(file).every((m) => m.status === 'NoCoverage'));
  if (fallbackEnv !== undefined && unreached.length > 0) {
    fellBack = `every mutant of ${unreached.join(', ')} was NoCoverage under the related filter`;
    const again = await run(unreached.map(local), reuseArgs, fallbackEnv);
    if ('refusal' in again) return refused(again.refusal, fellBack);
    unreached.forEach((file) => ownSuite.add(file));
    mutants = [...mutants.filter((m) => !ownSuite.has(m.file)), ...again.mutants];
  }

  const noMutants = plan.targets.filter((target) => !mutants.some((m) => m.file === target));
  const pass = await retryTimeouts(
    mutants,
    async (m) => {
      const range = mutantRange(m, local(m.file));
      if (range === null) return { refusal: 'its report gives no full location to retry it by', busy: false };
      const env = (ownSuite.has(m.file) ? fallbackEnv : undefined) ?? firstEnv;
      const retry = await run([range], ['--concurrency', '1', '--timeoutMS', String(RETRY_TIMEOUT_MS)], env);
      // The lane's own run passed its initial test run, so a test failing in the retry's is flaky.
      return 'refusal' in retry && retry.trigger === FAILED_INITIAL_RUN ? { refusal: flakyRetry(retry.failedTests ?? []), busy: false } : retry;
    },
    deps.now,
  );
  const judgement = judge(pass.mutants);
  const refusals = [...pass.refusals, ...judgement.unknown.map((u) => `unknown status: ${u}`)];
  const ownSuites = lane.ownSuites === true ? [...plan.targets] : plan.targets.filter((file) => ownSuite.has(file));
  return { judgement, retried: pass.retried, refusals, noMutants, fellBack, ownSuites, ...(flaky === undefined ? {} : { flaky }) };
}
