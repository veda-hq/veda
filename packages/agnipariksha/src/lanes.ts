/** A lane is one Stryker config: plan its files, run it, judge it. */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { nameTests } from './failed-tests.ts';
import { RETRY_IGNORER_NAME, RETRY_SPANS_VAR } from './retry-ignorer.ts';
import { readEvents, RETRY_EVENTS_VAR, RETRY_REPORTER_NAME } from './retry-reporter.ts';
import { forReuse, pruneToTargets } from './reuse-filter.ts';
import { ownerOf, type Exists } from './suite-owner.ts';
import { mutantSpan, RETRY_TIMEOUT_MS, retryTimeouts } from './timeout-retry.ts';
import { judge, readMutants, type Judgement, type Mutant } from './verdict.ts';

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
  /** Whether its fallback rerun is narrowed to the owning suites (its `fallbackEnv` names them). */
  fallbackOwnSuites?: boolean;
  /** The cut-off: a run that names no lane leaves this one out when its targets hold more lines. */
  maxLines?: number;
}

/**
 * A file's lines as `wc -l` counts them, plus a last line with no newline:
 * '' is 0, 'a' and 'a\n' are 1, 'a\n\n' is 2. Blank and comment lines count.
 */
export function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/**
 * Why a run that names no lane leaves this plan out, or null to judge it.
 * The count is over the targets whole, since Stryker mutates them whole. A
 * target that cannot be read counts 0, so a failed read never causes a skip:
 * the lane is judged, and Stryker's own run says what is wrong.
 */
export function overCutoff(plan: Plan, read: (repoPath: string) => string | undefined): string | null {
  const { maxLines, name } = plan.lane;
  if (maxLines === undefined) return null;
  const lines = plan.targets.reduce((sum, file) => sum + countLines(read(file) ?? ''), 0);
  if (lines <= maxLines) return null;
  return `${name}: ${lines} lines in ${plan.targets.length} file(s), over its cut-off of ${maxLines} - not judged in this run, CI judges it (--lane "${name}" judges it here)`;
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
   * `failedTests` names the tests its initial test run failed on. Given
   * `stopAfterMs`, it stops Stryker that long after the start, and says
   * `stopped`.
   */
  runStryker: (
    cwd: string,
    args: string[],
    env: Record<string, string>,
    stopAfterMs?: number,
  ) => Promise<{ code: number; seen: readonly string[]; refusal?: string; failedTests?: readonly string[]; stopped?: boolean }>;
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, text: string) => void;
  removeFile: (path: string) => void;
  /** The lane's reuse key, or null to run in full. */
  reuseKey: (lane: Lane) => string | null;
  now: () => number;
  /** One line of the gate's output; the timeout retry pass writes its progress here as it goes. */
  log: (line: string) => void;
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
   * Targets judged with only the changed files' own suites run, by the run
   * whose results count for each: `fallbackOwnSuites` for a file the fallback
   * reran, `ownSuites` otherwise. Elsewhere a related filter lets any suite
   * that imports a file kill its mutants, a sibling suite included.
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

/** The compiled retry ignorer, beside this module in `dist/`. */
export const RETRY_PLUGIN = fileURLToPath(new URL('retry-ignorer.js', import.meta.url));
/** The compiled retry reporter, beside this module in `dist/`. */
export const RETRY_REPORTER = fileURLToPath(new URL('retry-reporter.js', import.meta.url));

/**
 * A timeout retry round's config: the wrapper's with its own report path,
 * plus the retry ignorer (which drops the mutants nested in the retried
 * ones), the retry reporter (which writes each result as it comes) and the
 * mutators to leave out (the ones no retried mutant of the round's files
 * uses). The lane's own plugins, reporters, ignorers and exclusions stay.
 */
export function retryConfig(configPath: string, reportPath: string, plugins: { ignorer: string; reporter: string }, excluded: readonly string[]): string {
  return [
    `import base from ${JSON.stringify(pathToFileURL(configPath).href)};`,
    'export default {',
    '  ...base,',
    `  jsonReporter: { ...base.jsonReporter, fileName: ${JSON.stringify(reportPath)} },`,
    `  appendPlugins: [...(base.appendPlugins ?? []), ${JSON.stringify(plugins.ignorer)}, ${JSON.stringify(plugins.reporter)}],`,
    `  reporters: [...(base.reporters ?? []), ${JSON.stringify(RETRY_REPORTER_NAME)}],`,
    `  ignorers: [...(base.ignorers ?? []), ${JSON.stringify(RETRY_IGNORER_NAME)}],`,
    `  mutator: { ...base.mutator, excludedMutations: [...(base.mutator?.excludedMutations ?? []), ...${JSON.stringify(excluded)}] },`,
    '};',
    '',
  ].join('\n');
}
const BUSY = "Stryker's initial test run timed out: the machine is busy; push again when it is quieter";

export async function judgeLane(plan: Plan, deps: LaneDeps): Promise<LaneResult> {
  const { lane } = plan;
  const slug = lane.name.replace(/[^A-Za-z0-9]+/g, '-');
  const cwd = join(deps.root, lane.cwd);
  const report = join(deps.reportsDir, `${slug}.json`);
  /** Names the tests a failed dry run named, after `lead`; '' when it named none. */
  const on = (failedTests: readonly string[], lead = ' on '): string => (failedTests.length > 0 ? `${lead}${nameTests(failedTests)}` : '');
  const wrapper = join(deps.reportsDir, `${slug}.stryker.config.mjs`);
  const retryWrapper = join(deps.reportsDir, `${slug}.retry.stryker.config.mjs`);
  // A round's own report and events, so the lane's report keeps the lane's whole run.
  const retryReport = join(deps.reportsDir, `${slug}.retry.json`);
  const events = join(deps.reportsDir, `${slug}.retry-events.jsonl`);
  deps.writeFile(wrapper, wrapperConfig(join(cwd, lane.config), report));
  const local = (file: string): string => (lane.cwd === '' ? file : file.slice(lane.cwd.length + 1));
  const firstEnv = lane.env(plan.suites);
  const fallbackEnv = lane.fallback?.(plan.suites);

  /** A `FALLBACK_TRIGGERS` line the run's output carried, and the tests it names (only `FAILED_INITIAL_RUN` names any). */
  interface Trigger {
    line: string;
    failedTests: readonly string[];
  }
  type Run = { mutants: Mutant[] } | { refusal: string; busy: boolean; trigger?: Trigger };
  /** What a finished Stryker run says: a refusal, or the targets' mutants from the report at `reportPath`. */
  const settle = (result: Awaited<ReturnType<LaneDeps['runStryker']>>, mutate: string[], reportPath: string): Run => {
    if (result.refusal !== undefined) return { refusal: result.refusal, busy: false };
    if (result.code !== 0) {
      if (result.seen.includes(DRY_RUN_TIMEOUT)) return { refusal: BUSY, busy: true };
      const line = FALLBACK_TRIGGERS.find((marker) => result.seen.includes(marker));
      if (line === undefined) return { refusal: `Stryker exited ${result.code}`, busy: false };
      const failedTests = line === FAILED_INITIAL_RUN ? (result.failedTests ?? []) : [];
      return { refusal: `Stryker exited ${result.code} (${line}${on(failedTests, ': ')})`, busy: false, trigger: { line, failedTests } };
    }
    const text = deps.readFile(reportPath);
    if (text === undefined) return { refusal: `Stryker wrote no report at ${reportPath}`, busy: false };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // fail-open: an unreadable report refuses the lane (exit 2), never passes it.
      return { refusal: `Stryker's report ${reportPath} is not JSON`, busy: false };
    }
    const mutants = readMutants(pruneToTargets(raw, lane.cwd, mutate), lane.cwd);
    return typeof mutants === 'string' ? { refusal: mutants, busy: false } : { mutants };
  };
  const run = async (mutate: string[], extra: string[], env: Record<string, string>): Promise<Run> => {
    deps.removeFile(report);
    return settle(await deps.runStryker(cwd, ['run', wrapper, ...extra, '--mutate', mutate.join(',')], env), mutate, report);
  };

  const key = lane.reuse ? deps.reuseKey(lane) : null;
  const reuseArgs: string[] = [];
  if (key !== null) {
    const file = join(deps.reportsDir, `${slug}.incremental-${key}.json`);
    // An absent file reads as "undefined", which is no reuse file.
    const kept = forReuse(String(deps.readFile(file)));
    if (kept === null) deps.removeFile(file);
    else deps.writeFile(file, kept);
    reuseArgs.push('--incremental', '--incrementalFile', file);
  }

  const refused = (refusal: string, fellBack: string | null): LaneResult => ({ judgement: judge([]), retried: 0, refusals: [refusal], noMutants: [], fellBack, ownSuites: [] });
  /** Files judged in the fallback mode; their timeouts retry in it too. */
  const ownSuite = new Set<string>();
  let fellBack: string | null = null;
  /** The tests the first dry run failed on, when a lane with no fallback ran it again. */
  let failedFirst: readonly string[] | null = null;
  let first = await run(plan.targets.map(local), reuseArgs, firstEnv);
  if ('refusal' in first && first.trigger !== undefined && fallbackEnv !== undefined) {
    fellBack = `its dry run failed: "${first.trigger.line}"${on(first.trigger.failedTests)}`;
    plan.targets.forEach((target) => ownSuite.add(target));
    first = await run(plan.targets.map(local), reuseArgs, fallbackEnv);
  } else if ('refusal' in first && first.trigger?.line === FAILED_INITIAL_RUN) {
    // No fallback mode: run the same dry run once more, as a lane with one reruns in it.
    failedFirst = first.trigger.failedTests;
    first = await run(plan.targets.map(local), reuseArgs, firstEnv);
    if ('refusal' in first && first.trigger?.line === FAILED_INITIAL_RUN) {
      return refused(`the initial test run failed on both runs, the second time: ${first.refusal}; fix those tests, then run again`, null);
    }
  }
  if ('refusal' in first) return refused(first.refusal, fellBack);
  // It failed, then passed when run again.
  const flaky = failedFirst === null ? undefined : `its initial test run failed${on(failedFirst)}, then passed when run again: the test is flaky; ${FIX_THE_FLAKE}`;
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
    async (round, deadline) => {
      // A round is never empty, and all of it is in one mode (the group below).
      const env = (ownSuite.has((round[0] as Mutant).file) ? fallbackEnv : undefined) ?? firstEnv;
      const files = new Set(round.map((m) => m.file));
      const mutators = new Set(round.map((m) => m.mutator));
      const excluded = [...new Set(mutants.filter((o) => files.has(o.file) && !mutators.has(o.mutator)).map((o) => o.mutator))];
      deps.writeFile(retryWrapper, retryConfig(join(cwd, lane.config), retryReport, { ignorer: RETRY_PLUGIN, reporter: RETRY_REPORTER }, excluded));
      deps.removeFile(retryReport);
      deps.removeFile(events);
      // Stryker mutates every node inside each `--mutate` range; the ignorer, given the spans, drops those nested in them.
      const spans = round.map((m) => `${local(m.file)}:${mutantSpan(m)}`);
      const result = await deps.runStryker(
        cwd,
        ['run', retryWrapper, '--concurrency', '1', '--timeoutMS', String(RETRY_TIMEOUT_MS), '--mutate', spans.join(',')],
        { ...env, [RETRY_SPANS_VAR]: spans.join('\n'), [RETRY_EVENTS_VAR]: events },
        deadline - deps.now(),
      );
      const { dryRunEnd, tested } = readEvents(deps.readFile(events), lane.cwd);
      if (result.stopped === true) return { dryRunEnd, tested, stopped: true, report: null };
      const retry = settle(result, spans, retryReport);
      if ('mutants' in retry) return { dryRunEnd, tested, stopped: false, report: retry.mutants };
      // The lane's own run passed its initial test run, so a test failing in the retry's is flaky.
      const refusal = retry.trigger?.line === FAILED_INITIAL_RUN ? flakyRetry(retry.trigger.failedTests) : retry.refusal;
      return { refusal, busy: retry.busy, dryRunEnd };
    },
    deps.now,
    deps.log,
    // A fallback file's round runs under the fallback's variables, so it never shares one with the lane's.
    (m) => String(ownSuite.has(m.file)),
  );
  const judgement = judge(pass.mutants);
  const refusals = [...pass.refusals, ...judgement.unknown.map((u) => `unknown status: ${u}`)];
  // Each target by the run whose results count for it: the fallback's for a file it reran, the lane's own otherwise.
  const ownSuites = plan.targets.filter((file) => (ownSuite.has(file) ? lane.fallbackOwnSuites : lane.ownSuites) === true);
  return { judgement, retried: pass.retried, refusals, noMutants, fellBack, ownSuites, ...(flaky === undefined ? {} : { flaky }) };
}
