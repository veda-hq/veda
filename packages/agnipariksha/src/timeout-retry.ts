/** Retry each timed-out mutant once, alone. */
import type { Mutant } from './verdict.ts';

/** The retry's `timeoutMS`: three minutes. */
export const RETRY_TIMEOUT_MS = 180_000;
/** The pass stops once it has run this long: the machine is busy. */
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

/**
 * Give every Timeout one retry, in order. The retry's status replaces the
 * Timeout; a second Timeout stays Timeout, which the verdict counts as caught.
 * A busy machine (a retry's dry run timed out, or the budget ran out) stops
 * the pass and refuses; so does a retry that cannot run, lacks the mutant or
 * ignored it.
 */
export async function retryTimeouts(
  mutants: readonly Mutant[],
  rerun: (m: Mutant) => Promise<RetryRun>,
  now: () => number,
): Promise<RetryPass> {
  const startedAt = now();
  const refusals: string[] = [];
  let stopped = false;
  let retried = 0;
  const out: Mutant[] = [];
  for (const m of mutants) {
    if (m.status !== 'Timeout') {
      out.push(m);
      continue;
    }
    if (stopped) continue;
    const where = `${m.file}:${m.line} (${m.mutator})`;
    if (now() - startedAt > RETRY_BUDGET_MS) {
      stopped = true;
      refusals.push(`the timeout retry pass outgrew its ${RETRY_BUDGET_MS / 60_000}-minute budget; the machine is busy, push again when it is quieter`);
      continue;
    }
    const run = await rerun(m);
    if ('refusal' in run) {
      stopped ||= run.busy;
      refusals.push(`retry of ${where}: ${run.refusal}`);
      continue;
    }
    const again = run.mutants.find((candidate) => sameMutant(candidate, m));
    if (again === undefined) {
      refusals.push(`retry of ${where}: its report does not hold the mutant`);
      continue;
    }
    // The verdict counts no Ignored mutant, so a retry that ignored its own would pass a hang.
    if (again.status === 'Ignored') {
      refusals.push(`retry of ${where}: Stryker ignored the mutant it was retrying`);
      continue;
    }
    retried += 1;
    out.push({ ...m, status: again.status });
  }
  return { mutants: out, retried, refusals };
}
