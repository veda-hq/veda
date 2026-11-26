/** Retry each timed-out mutant once, alone. */
import type { Mutant } from './verdict.ts';

/** The retry's `timeoutMS`: three minutes. */
export const RETRY_TIMEOUT_MS = 180_000;
/** The retry pass's budget: it starts no retry that its longest so far says would end past this. */
export const RETRY_BUDGET_MS = 15 * 60_000;

/** One retry: the run's mutants, or why it could not run (`busy`: its dry run timed out). */
export type RetryRun = { mutants: Mutant[] } | { refusal: string; busy: boolean };

/**
 * The mutant's span, `line:column-endLine:endColumn`, lines 1-based and
 * columns 0-based: a `--mutate` range after `file:`, and the value of the
 * retry ignorer's `RETRY_SPAN_VAR`. As a range it selects every mutant nested
 * in this one too; the ignorer drops those.
 */
export function mutantSpan(m: Mutant): string | null {
  const parts = [m.line, m.column, m.endLine, m.endColumn];
  if (!parts.every(Number.isInteger)) return null;
  return `${m.line}:${m.column - 1}-${m.endLine}:${m.endColumn - 1}`;
}

/**
 * The same mutant: file, full location, mutator and replacement. A retry's
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

export interface RetryPass {
  mutants: Mutant[];
  retried: number;
  refusals: string[];
}

/** A mutant as a log line names it: where it is (its report's 1-based column), its mutator and its replacement. */
export const describeMutant = (m: Mutant): string => `${m.file}:${m.line}:${m.column} ${m.mutator} (${JSON.stringify(m.replacement)})`;

/** Milliseconds as minutes, to a tenth. */
export const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;

/** What to do about a Timeout that costs a retry, said wherever one is named. */
export const KILL_IT_FAST = 'make the suite that owns its file kill it fast';

/**
 * Give every Timeout one retry, in order, and log each: the mutant as it
 * starts, its status and minutes as it ends. The retry's status replaces the
 * Timeout; a second Timeout stays Timeout, which the verdict counts as caught,
 * and the pass names each such mutant at its end: every run pays a whole
 * retry for it.
 *
 * The budget is a wall: a retry starts only when the time gone plus the
 * longest retry so far fits in `RETRY_BUDGET_MS`, so the pass ends near its
 * budget, never a whole retry past it. The first retry always runs. A pass
 * the budget stops, or a busy dry run, refuses once, naming every mutant it
 * left unretried. A retry that cannot run, lacks the mutant or ignored it
 * refuses that mutant, and the pass goes on.
 */
export async function retryTimeouts(
  mutants: readonly Mutant[],
  rerun: (m: Mutant) => Promise<RetryRun>,
  now: () => number,
  log: (line: string) => void,
): Promise<RetryPass> {
  const startedAt = now();
  const total = mutants.filter((m) => m.status === 'Timeout').length;
  const refusals: string[] = [];
  /** Why the pass stopped, once it has. */
  let stopped: string | null = null;
  let retried = 0;
  let started = 0;
  let longest = 0;
  const left: Mutant[] = [];
  const hung: Mutant[] = [];
  const out: Mutant[] = [];
  for (const m of mutants) {
    if (m.status !== 'Timeout') {
      out.push(m);
      continue;
    }
    if (stopped !== null) {
      left.push(m);
      continue;
    }
    const where = `${m.file}:${m.line} (${m.mutator})`;
    const begun = now();
    const gone = begun - startedAt;
    if (gone + longest > RETRY_BUDGET_MS) {
      stopped = `the timeout retry pass would outgrow its ${RETRY_BUDGET_MS / 60_000}-minute budget: ${minutes(gone)} gone, and its longest retry took ${minutes(longest)}`;
      left.push(m);
      continue;
    }
    started += 1;
    const label = `retry ${started} of ${total}`;
    log(`  ${label}: ${describeMutant(m)}`);
    const run = await rerun(m);
    const took = now() - begun;
    longest = Math.max(longest, took);
    if ('refusal' in run) {
      log(`  ${label}: refused after ${minutes(took)}`);
      if (run.busy) stopped = 'a retry found the machine busy';
      refusals.push(`retry of ${where}: ${run.refusal}`);
      continue;
    }
    const again = run.mutants.find((candidate) => sameMutant(candidate, m));
    if (again === undefined) {
      log(`  ${label}: not in its report, after ${minutes(took)}`);
      refusals.push(`retry of ${where}: its report does not hold the mutant`);
      continue;
    }
    // The verdict counts no Ignored mutant, so a retry that ignored its own would pass a hang.
    if (again.status === 'Ignored') {
      log(`  ${label}: Ignored, after ${minutes(took)}`);
      refusals.push(`retry of ${where}: Stryker ignored the mutant it was retrying`);
      continue;
    }
    log(`  ${label}: ${again.status} after ${minutes(took)}`);
    if (again.status === 'Timeout') hung.push(m);
    retried += 1;
    out.push({ ...m, status: again.status });
  }
  for (const m of hung) log(`  timed out again (caught, but every run pays a whole retry for it; ${KILL_IT_FAST}): ${describeMutant(m)}`);
  if (left.length > 0) {
    refusals.push(`${stopped}; ${left.length} timed-out mutant(s) left unretried: ${left.map(describeMutant).join(', ')}. For each, ${KILL_IT_FAST}, or push again when the machine is quieter`);
  }
  return { mutants: out, retried, refusals };
}
