/**
 * One pass over the corpus: every row executed once for the truth, and judged
 * by every consumer that faces it. One function, so every suite that runs
 * the corpus runs it the same way.
 */

import { CONSUMERS, type Consumer, standIn } from './consumers.ts';
import { CORPUS, type CorpusRow, isStrict, render } from './corpus.ts';
import {
  cloneFixture,
  createFixture,
  disposeFixture,
  type Fixture,
  passGate,
} from './fixture.ts';
import { happened, observe } from './oracle.ts';
import { mapPool } from './pool.ts';

export interface Verdict {
  readonly consumer: string;
  readonly row: string;
  readonly flagged: boolean;
}

export interface RowResult {
  readonly row: CorpusRow;
  /** What bash/git did; null when the pass skipped execution. */
  readonly truth: boolean | null;
  readonly verdicts: readonly Verdict[];
}

export interface Disagreement {
  readonly consumer: string;
  readonly row: string;
  readonly text: string;
  readonly expected: boolean;
  readonly got: boolean;
  readonly kind: 'bypass' | 'false-pass' | 'strict' | 'over-refusal';
}

/** Does `consumer` face `row`? Its intents, minus rows it declares outside. */
export function faces(consumer: Consumer, row: CorpusRow): boolean {
  return (
    consumer.intents.includes(row.intent) &&
    consumer.outOfModel?.[row.id] === undefined
  );
}

export interface EvaluateOptions {
  readonly rows?: readonly CorpusRow[];
  readonly consumers?: readonly Consumer[];
  /** Execute rows for their truth; off to judge the consumers alone. */
  readonly execute?: boolean;
  /** How a row is run and observed: the oracle's, unless a test stands in. */
  readonly observe?: typeof observe;
}

export async function evaluate(
  options: EvaluateOptions = {},
): Promise<RowResult[]> {
  const rows = options.rows ?? CORPUS;
  const consumers = options.consumers ?? CONSUMERS;
  const execute = options.execute ?? true;
  const run = options.observe ?? observe;
  const needsWorld = (row: CorpusRow): boolean =>
    execute || consumers.some(c => c.needsFixture && faces(c, row));
  const template = rows.some(needsWorld) ? await createFixture() : null;
  try {
    return await mapPool(rows, async row => {
      const world: Fixture | null =
        template !== null && needsWorld(row) ? cloneFixture(template) : null;
      // Rendered for the checkout it runs and is judged in, so `{UP}` names
      // the main checkout from there.
      const textIn = (fixture: Fixture): string =>
        render(row.text, {
          primary: fixture.primary,
          gitPath: fixture.gitPath,
          cwd: standIn(row, fixture),
        });
      try {
        const text = world ? textIn(world) : row.text;
        // Judge BEFORE executing: a row may rewrite the very repository a
        // guard reads (git config, a new commit). Judges only read, so they
        // may run side by side.
        // Every judge settles before the fixture is disposed (finally below):
        // one failing judge must not leave the others reading a deleted tree.
        const settled = await Promise.allSettled(
          consumers
            .filter(consumer => faces(consumer, row))
            .map(async consumer => ({
              consumer: consumer.id,
              row: row.id,
              flagged: await consumer.judge(row, text, world),
            })),
        );
        const verdicts: Verdict[] = settled.map(outcome => {
          if (outcome.status === 'rejected') throw outcome.reason;
          return outcome.value;
        });
        let truth: boolean | null = null;
        if (execute && world !== null) {
          // A gate row runs twice: again on its own copy with the gate
          // passing, since wiring is the caller's status following the
          // gate's (happened). Copied before the row runs in `world` (the
          // judges only read). Every other row runs once.
          const twin =
            row.intent === 'gate-invocation' ? cloneFixture(world) : null;
          try {
            if (twin !== null) passGate(twin);
            // Both runs settle before either fixture is disposed, as the
            // judges do: one failing run must not delete the other's tree.
            const [seen, passing] = await Promise.allSettled([
              run(world, text, standIn(row, world)),
              twin === null
                ? undefined
                : run(twin, textIn(twin), standIn(row, twin)),
            ]);
            if (seen.status === 'rejected') throw seen.reason;
            if (passing.status === 'rejected') throw passing.reason;
            truth = happened(row.intent, seen.value, passing.value);
          } finally {
            if (twin !== null) disposeFixture(twin);
          }
        }
        return { row, truth, verdicts };
      } finally {
        if (world !== null) disposeFixture(world);
      }
    });
  } finally {
    if (template !== null) disposeFixture(template);
  }
}

/**
 * Every verdict that breaks its consumer's contract (plus over-refusals),
 * judged against the consumers that gave the verdicts: pass the same set
 * given to evaluate(). A verdict from a consumer outside it is an error, not
 * a silent pass.
 */
export function disagreements(
  results: readonly RowResult[],
  consumers: readonly Consumer[] = CONSUMERS,
): Disagreement[] {
  const out: Disagreement[] = [];
  const byId = new Map(consumers.map(consumer => [consumer.id, consumer]));
  for (const { row, verdicts } of results) {
    for (const verdict of verdicts) {
      // Checked before the agreement skip: an outside consumer's verdict is
      // an error even when it happens to agree.
      const consumer = byId.get(verdict.consumer);
      if (consumer === undefined) {
        throw new Error(
          `verdict from ${verdict.consumer}, which is not among the consumers judged`,
        );
      }
      if (verdict.flagged === row.happens) continue;
      const base = {
        consumer: verdict.consumer,
        row: row.id,
        text: row.text,
        expected: row.happens,
        got: verdict.flagged,
      };
      const floor =
        verdict.flagged === consumer.safe &&
        consumer.floorRefuses?.[row.id] !== undefined;
      if (isStrict(row) && !floor) {
        out.push({ ...base, kind: 'strict' });
      } else if (verdict.flagged === consumer.safe) {
        out.push({ ...base, kind: 'over-refusal' });
      } else {
        out.push({
          ...base,
          kind: consumer.kind === 'guard' ? 'bypass' : 'false-pass',
        });
      }
    }
  }
  return out;
}
