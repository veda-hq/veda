/** A lane is one Stryker config: plan its files, run it, judge it. */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
}

/** Stryker's line when the initial test run outlives its cap: the machine is busy. */
export const DRY_RUN_TIMEOUT = 'Initial test run timed out!';
/** Dry-run failures a lane's fallback mode may cure: no related suite found, or one fails in the sandbox. */
export const FALLBACK_TRIGGERS: readonly string[] = [
  'Vitest failed to find test files related to mutated files',
  'No tests were executed',
  'There were failed tests in the initial test run',
];
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
   * Run Stryker; `seen` lists the `MARKERS` its output carried, and `refusal`
   * says why the run cannot be trusted whatever it exited with.
   */
  runStryker: (cwd: string, args: string[], env: Record<string, string>) => Promise<{ code: number; seen: readonly string[]; refusal?: string }>;
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

  type Run = RetryRun & { trigger?: string | undefined };
  const run = async (mutate: string[], extra: string[], env: Record<string, string>): Promise<Run> => {
    deps.removeFile(report);
    const result = await deps.runStryker(cwd, ['run', wrapper, ...extra, '--mutate', mutate.join(',')], env);
    if (result.refusal !== undefined) return { refusal: result.refusal, busy: false };
    if (result.code !== 0) {
      if (result.seen.includes(DRY_RUN_TIMEOUT)) return { refusal: BUSY, busy: true };
      const trigger = FALLBACK_TRIGGERS.find((line) => result.seen.includes(line));
      return { refusal: `Stryker exited ${result.code}${trigger === undefined ? '' : ` (${trigger})`}`, busy: false, trigger };
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

  const refused = (refusal: string, fellBack: string | null): LaneResult => ({ judgement: judge([]), retried: 0, refusals: [refusal], noMutants: [], fellBack });
  /** Files judged in the fallback mode; their timeouts retry in it too. */
  const ownSuite = new Set<string>();
  let fellBack: string | null = null;
  let first = await run(plan.targets.map(local), reuseArgs, firstEnv);
  if ('refusal' in first && first.trigger !== undefined && fallbackEnv !== undefined) {
    fellBack = `its dry run failed: "${first.trigger}"`;
    plan.targets.forEach((target) => ownSuite.add(target));
    first = await run(plan.targets.map(local), reuseArgs, fallbackEnv);
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
      return run([range], ['--concurrency', '1', '--timeoutMS', String(RETRY_TIMEOUT_MS)], env);
    },
    deps.now,
  );
  const judgement = judge(pass.mutants);
  const refusals = [...pass.refusals, ...judgement.unknown.map((u) => `unknown status: ${u}`)];
  return { judgement, retried: pass.retried, refusals, noMutants, fellBack };
}
