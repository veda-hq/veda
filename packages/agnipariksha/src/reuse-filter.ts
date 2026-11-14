/** What a reuse file may offer the next run, and what a report may judge. */

export const REUSED_STATUSES: readonly string[] = ['Killed', 'Survived', 'NoCoverage', 'CompileError', 'Ignored'];
/** A static mutant never carries these over: its coverage misses new tests. */
export const STATIC_RERUN_STATUSES: readonly string[] = ['Survived', 'NoCoverage'];

interface StoredMutant {
  status?: unknown;
  static?: unknown;
}

export function reusable(mutant: StoredMutant): boolean {
  if (typeof mutant.status !== 'string' || !REUSED_STATUSES.includes(mutant.status)) return false;
  return mutant.static !== true || !STATIC_RERUN_STATUSES.includes(mutant.status);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The reuse file with only reusable results, or null if Stryker could not have written it. */
export function forReuse(text: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // fail-open: a reuse file that is not JSON is dropped, and the lane runs in full.
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.files)) return null;
  const files: Record<string, unknown> = {};
  for (const [path, entry] of Object.entries(raw.files)) {
    if (!isRecord(entry) || !Array.isArray(entry.mutants)) return null;
    files[path] = { ...entry, mutants: (entry.mutants as StoredMutant[]).filter(reusable) };
  }
  return JSON.stringify({ ...raw, files });
}

/** A target may carry a mutation range; the report keys files without it. */
export function stripRange(target: string): string {
  return target.replace(/:\d+(:\d+)?-\d+(:\d+)?$/, '');
}

/** Keep only this run's targets: the report also carries every reused file. */
export function pruneToTargets(raw: unknown, cwd: string, targets: readonly string[]): unknown {
  if (!isRecord(raw) || !isRecord(raw.files)) return raw;
  const wanted = new Set(targets.map(stripRange));
  const local = (path: string): string => (cwd !== '' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);
  return { ...raw, files: Object.fromEntries(Object.entries(raw.files).filter(([path]) => wanted.has(local(path)))) };
}
