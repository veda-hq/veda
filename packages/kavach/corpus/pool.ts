/**
 * Run `work` over `items` with at most `limit` in flight, results in order.
 *
 * Each corpus row spawns bash, git and a guard process, and those wait on I/O
 * far more than on CPU, so rows overlap well. The limit keeps a run on a
 * loaded machine from forking hundreds of processes at once.
 */

import { availableParallelism } from 'node:os';

export const DEFAULT_LIMIT = Math.max(2, Math.min(8, availableParallelism()));

export async function mapPool<T, R>(
  items: readonly T[],
  work: (item: T, index: number) => Promise<R>,
  limit: number = DEFAULT_LIMIT,
): Promise<R[]> {
  // A limit below one starts no lane, so the pool would settle with no item run.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(
      `mapPool limit must be a whole number >= 1: ${String(limit)}`,
    );
  }
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  // Each lane takes the next item when its last one settles. After a failure
  // no lane starts another item, and every lane is awaited before the pool
  // settles, so a caller's cleanup (evaluate() disposes the shared template)
  // never runs under a lane still using what it removes.
  const lane = async (): Promise<void> => {
    if (failed || next >= items.length) return;
    const index = next;
    next += 1;
    try {
      // index < items.length (the check above), so the item is there.
      results[index] = await work(items[index] as T, index);
    } catch (error) {
      failed = true;
      throw error;
    }
    await lane();
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, () => lane()),
  );
  const rejected = settled.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === 'rejected',
  );
  if (rejected !== undefined) throw rejected.reason;
  return results;
}
