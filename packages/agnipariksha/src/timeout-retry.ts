/** Retry the timed-out mutants once, in rounds: one Stryker run retries many. */
import type { Mutant } from './verdict.ts';

/** The retry's `timeoutMS`: three minutes. */
export const RETRY_TIMEOUT_MS = 180_000;
/** The retry pass's budget: a wall from the pass's start, at which the round running is stopped. */
export const RETRY_BUDGET_MS = 15 * 60_000;

/** A mutant as Stryker finished it in a round, and when (on the pass's clock). */
export interface Tested {
  mutant: Mutant;
  at: number;
}

/**
 * One round: why it could not run (`busy`: its dry run timed out), or what it
 * did. `dryRunEnd` is when its initial test run ended (null if it never
 * did), `tested` each mutant as Stryker finished it, `stopped` whether the
 * wall stopped it, and `report` every status from Stryker's JSON report,
 * when Stryker ended by itself and wrote one.
 */
export type RoundRun = { refusal: string; busy: boolean } | { dryRunEnd: number | null; tested: Tested[]; stopped: boolean; report: Mutant[] | null };

/**
 * The mutant's span, `line:column-endLine:endColumn`, lines 1-based and
 * columns 0-based: a `--mutate` range after `file:`, and the span the retry
 * ignorer reads. As a range it selects every mutant nested in this one too;
 * the ignorer drops those.
 */
export function mutantSpan(m: Mutant): string | null {
  const parts = [m.line, m.column, m.endLine, m.endColumn];
  if (!parts.every(Number.isInteger)) return null;
  return `${m.line}:${m.column - 1}-${m.endLine}:${m.endColumn - 1}`;
}

/**
 * The same mutant: file, full location, mutator and replacement. A round's
 * `--mutate` range also selects mutants nested in this one, and a nested one
 * can share its start, mutator and replacement (`a === b && c`), so the end
 * tells them apart (veda#557).
 */
export const sameMutant = (a: Mutant, b: Mutant): boolean =>
  a.file === b.file &&
  a.line === b.line &&
  a.column === b.column &&
  a.endLine === b.endLine &&
  a.endColumn === b.endColumn &&
  a.mutator === b.mutator &&
  a.replacement === b.replacement;

const before = (line: number, column: number, otherLine: number, otherColumn: number): boolean =>
  line < otherLine || (line === otherLine && column <= otherColumn);

/** Whether `outer`'s place holds `inner`'s, in one file, and is not the same place. */
export function holds(outer: Mutant, inner: Mutant): boolean {
  const samePlace = outer.line === inner.line && outer.column === inner.column && outer.endLine === inner.endLine && outer.endColumn === inner.endColumn;
  return (
    outer.file === inner.file &&
    !samePlace &&
    before(outer.line, outer.column, inner.line, inner.column) &&
    before(inner.endLine, inner.endColumn, outer.endLine, outer.endColumn)
  );
}

/**
 * The mutants in rounds. The retry ignorer drops what lies inside a retried
 * span, so no round holds a mutant whose place holds another's: each mutant
 * goes in the round of its height, 0 for one that holds none of the others,
 * else one more than the highest it holds. Mutants `group` keys apart (the
 * lane's own and its fallback mode) never share a round. Rounds come in the
 * order their first mutant does.
 */
export function planRounds(mutants: readonly Mutant[], group: (m: Mutant) => string): Mutant[][] {
  const heights = new Map<Mutant, number>();
  const height = (m: Mutant): number => {
    const known = heights.get(m);
    if (known !== undefined) return known;
    const found = Math.max(-1, ...mutants.filter((other) => holds(m, other)).map(height)) + 1;
    heights.set(m, found);
    return found;
  };
  const rounds = new Map<string, Mutant[]>();
  for (const m of mutants) {
    const key = `${group(m)}\n${height(m)}`;
    rounds.set(key, [...(rounds.get(key) ?? []), m]);
  }
  return [...rounds.values()];
}

export interface RetryPass {
  mutants: Mutant[];
  retried: number;
  refusals: string[];
}

/** A mutant as a log line names it: where it is (its report's 1-based column), its mutator and its replacement. */
export const describeMutant = (m: Mutant): string => `${m.file}:${m.line}:${m.column} ${m.mutator} (${JSON.stringify(m.replacement)})`;

/** Milliseconds as minutes, to a tenth. */
export const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;
/** Milliseconds as seconds, to a tenth. */
export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** What to do about a Timeout that costs a retry, said wherever one is named. */
export const KILL_IT_FAST = 'make the suite that owns its file kill it fast';

/** Where a stopped pass's time went. */
export interface Spent {
  /** From the pass's start to the wall's refusal. */
  gone: number;
  /** In starting Stryker and its initial test run, summed over the rounds. */
  dryRuns: number;
  rounds: number;
  /** In the mutants that timed out again. */
  hangs: number;
  hung: readonly Mutant[];
  /** The slowest mutant that did not time out again, and its time. */
  slowest: { mutant: Mutant; ms: number } | null;
}

/**
 * Why the wall stopped the pass: where its time went, and the largest share
 * of it named as the cause. Hangs come first on a tie, then the dry runs.
 */
export function outgrew(spent: Spent, left: readonly Mutant[]): string {
  const rest = spent.gone - spent.dryRuns - spent.hangs;
  const head =
    `the timeout retry pass reached its ${RETRY_BUDGET_MS / 60_000}-minute budget after ${minutes(spent.gone)}: ` +
    `${minutes(spent.dryRuns)} went to starting Stryker and its initial test run (${spent.rounds} run(s)), ` +
    `${minutes(spent.hangs)} to ${spent.hung.length} mutant(s) that timed out again, and ${minutes(rest)} to the rest; ` +
    `${left.length} timed-out mutant(s) left unretried: ${left.map(describeMutant).join(', ')}`;
  if (spent.hangs >= spent.dryRuns && spent.hangs >= rest) {
    return `${head}. Mostly hangs: each mutant that timed out again took the whole ${RETRY_TIMEOUT_MS / 60_000}-minute limit, so a re-run will not pass. For each (${spent.hung.map(describeMutant).join(', ')}), ${KILL_IT_FAST}`;
  }
  if (spent.dryRuns >= rest) {
    return `${head}. Mostly Stryker's start and initial test runs: the owning suites are slow to start here, or the machine is busy; push again when it is quieter`;
  }
  const slowest = spent.slowest === null ? '' : `; the slowest, ${describeMutant(spent.slowest.mutant)}, took ${seconds(spent.slowest.ms)}`;
  return `${head}. Mostly mutants that ended before the limit, but slowly${slowest}: for each, ${KILL_IT_FAST}, or push again when the machine is quieter`;
}

const where = (m: Mutant): string => `${m.file}:${m.line} (${m.mutator})`;

/**
 * Give every Timeout one retry, in rounds (`planRounds`): one Stryker run a
 * round, which pays its initial test run once for all its mutants. A
 * retried mutant takes its retry's status; a second Timeout stays Timeout,
 * which the verdict counts as caught, and the pass names each such mutant at
 * its end: every run pays a whole retry for it.
 *
 * The budget is a wall at `RETRY_BUDGET_MS` from the pass's start. A round
 * starts only before it, and `rerun` is given it, to stop its Stryker there.
 * A stopped round keeps what Stryker finished, and the pass refuses once,
 * naming where its time went and every mutant it left unretried. A busy dry
 * run stops the pass too. A round that cannot run refuses its mutants, a
 * retry missing from its report or ignored refuses that mutant, and the pass
 * goes on.
 */
export async function retryTimeouts(
  mutants: readonly Mutant[],
  rerun: (round: Mutant[], deadline: number) => Promise<RoundRun>,
  now: () => number,
  log: (line: string) => void,
  group: (m: Mutant) => string = () => '',
): Promise<RetryPass> {
  const startedAt = now();
  const deadline = startedAt + RETRY_BUDGET_MS;
  const refusals: string[] = [];
  const out: Mutant[] = [];
  const pending: Mutant[] = [];
  for (const m of mutants) {
    if (m.status !== 'Timeout') out.push(m);
    else if (mutantSpan(m) === null) refusals.push(`retry of ${where(m)}: its report gives no full location to retry it by`);
    else pending.push(m);
  }
  const rounds = planRounds(pending, group);
  /** Why the pass stopped, once it has. */
  let stopped: 'wall' | 'busy' | null = null;
  const spent: Spent = { gone: 0, dryRuns: 0, rounds: 0, hangs: 0, hung: [], slowest: null };
  const hung: Mutant[] = [];
  const left: Mutant[] = [];
  let retried = 0;
  for (const [index, round] of rounds.entries()) {
    const begun = now();
    if (stopped === null && begun >= deadline) stopped = 'wall';
    if (stopped !== null) {
      left.push(...round);
      continue;
    }
    const label = `retry round ${index + 1} of ${rounds.length}`;
    log(`  ${label}: ${round.length} timed-out mutant(s) in ${new Set(round.map((m) => m.file)).size} file(s)`);
    spent.rounds += 1;
    const run = await rerun(round, deadline);
    const ended = now();
    if ('refusal' in run) {
      spent.dryRuns += ended - begun;
      log(`  ${label}: refused after ${minutes(ended - begun)}`);
      if (run.busy) stopped = 'busy';
      refusals.push(`${label} (${round.map(describeMutant).join(', ')}): ${run.refusal}`);
      continue;
    }
    const dryRunEnd = run.dryRunEnd ?? ended;
    spent.dryRuns += dryRunEnd - begun;
    // At one worker, a mutant's time runs from the event before it.
    const times = new Map<Mutant, number>();
    let previous = dryRunEnd;
    for (const tested of run.tested) {
      const mine = round.find((m) => sameMutant(m, tested.mutant));
      if (mine !== undefined) times.set(mine, tested.at - previous);
      previous = tested.at;
    }
    const results = run.report ?? run.tested.map((tested) => tested.mutant);
    for (const m of round) {
      const again = results.find((candidate) => sameMutant(candidate, m));
      if (again === undefined) {
        if (run.stopped) left.push(m);
        else refusals.push(`retry of ${where(m)}: its report does not hold the mutant`);
        continue;
      }
      // The verdict counts no Ignored mutant, so a retry that ignored its own would pass a hang.
      if (again.status === 'Ignored') {
        refusals.push(`retry of ${where(m)}: Stryker ignored the mutant it was retrying`);
        continue;
      }
      retried += 1;
      const took = times.get(m);
      log(`  retry ${retried} of ${pending.length}: ${describeMutant(m)}: ${again.status}${took === undefined ? '' : ` after ${seconds(took)}`}`);
      if (again.status === 'Timeout') {
        hung.push(m);
        spent.hangs += took ?? 0;
      } else if (took !== undefined && (spent.slowest === null || took > spent.slowest.ms)) {
        spent.slowest = { mutant: m, ms: took };
      }
      out.push({ ...m, status: again.status });
    }
    if (run.stopped) stopped = 'wall';
  }
  for (const m of hung) log(`  timed out again (caught, but every run pays a whole retry for it; ${KILL_IT_FAST}): ${describeMutant(m)}`);
  if (left.length > 0 && stopped === 'busy') {
    refusals.push(`a retry found the machine busy; ${left.length} timed-out mutant(s) left unretried: ${left.map(describeMutant).join(', ')}. For each, ${KILL_IT_FAST}, or push again when the machine is quieter`);
  }
  if (left.length > 0 && stopped === 'wall') refusals.push(outgrew({ ...spent, gone: now() - startedAt, hung }, left));
  return { mutants: out, retried, refusals };
}
