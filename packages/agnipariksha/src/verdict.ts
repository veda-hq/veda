/** Read Stryker's JSON report and decide what blocks. */

export interface Mutant {
  /** Repo-relative. */
  file: string;
  status: string;
  mutator: string;
  replacement: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export const BLOCKING: readonly string[] = ['Survived', 'NoCoverage'];
/** RuntimeError is caught: the mutant broke the code a test ran. A Timeout here has had its retry, so it hung twice. */
export const CAUGHT: readonly string[] = ['Killed', 'RuntimeError', 'CompileError', 'Timeout'];
export const UNCOUNTED: readonly string[] = ['Ignored'];

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null;
const num = (value: unknown): number => (typeof value === 'number' ? value : Number.NaN);

/** The report's mutants with repo-relative paths, or a reason the report cannot be read. */
export function readMutants(raw: unknown, cwd: string): Mutant[] | string {
  if (!isRecord(raw) || !isRecord(raw.files)) return 'the report has no `files`';
  const mutants: Mutant[] = [];
  for (const [path, entry] of Object.entries(raw.files)) {
    if (!isRecord(entry) || !Array.isArray(entry.mutants)) return `the report's ${path} has no mutants list`;
    const file = cwd === '' || path.startsWith(`${cwd}/`) ? path : `${cwd}/${path}`;
    for (const m of entry.mutants as unknown[]) {
      const location = isRecord(m) && isRecord(m.location) ? m.location : {};
      const start = isRecord(location.start) ? location.start : {};
      const end = isRecord(location.end) ? location.end : {};
      const fields = isRecord(m) ? m : {};
      mutants.push({
        file,
        status: String(fields.status),
        mutator: String(fields.mutatorName),
        replacement: String(fields.replacement),
        line: num(start.line),
        column: num(start.column),
        endLine: num(end.line),
        endColumn: num(end.column),
      });
    }
  }
  return mutants;
}

export interface Judgement {
  blocking: Mutant[];
  /** Statuses no rule names; any one refuses the verdict. */
  unknown: string[];
  /** Counted mutants by status (Ignored left out). */
  byStatus: Record<string, number>;
  counted: number;
  caught: number;
}

export function judge(mutants: readonly Mutant[]): Judgement {
  const result: Judgement = { blocking: [], unknown: [], byStatus: {}, counted: 0, caught: 0 };
  for (const m of mutants) {
    if (UNCOUNTED.includes(m.status)) continue;
    if (!BLOCKING.includes(m.status) && !CAUGHT.includes(m.status)) {
      result.unknown.push(`${m.status} ${m.file}:${m.line}`);
      continue;
    }
    result.counted += 1;
    result.byStatus[m.status] = (result.byStatus[m.status] ?? 0) + 1;
    if (BLOCKING.includes(m.status)) result.blocking.push(m);
    else result.caught += 1;
  }
  return result;
}

export const formatBlocking = (m: Mutant): string => `${m.status} ${m.file}:${m.line} (${m.mutator})`;
