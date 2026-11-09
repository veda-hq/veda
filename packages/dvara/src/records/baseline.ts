// The ratchet for files written before the gate existed.
//
// A legacy file's current count of findings per rule is recorded here, and the
// gate holds each count where it is or lower. Three refusals keep the numbers
// honest:
//
// - a file over its recorded count (a new violation in a legacy file);
// - a file under it (the fix lands with the lower number, so it cannot creep
//   back up to the old allowance), and an entry for a file that is gone or
//   that the gate does not read;
// - a baseline edit that raises a count or adds a file, other than a rename
//   git detects in the same change carrying its entry forward at the same or
//   lower counts.
//
// The commit that adds the baseline has no earlier one to compare with; the
// gate then checks every file it names, so each entry must equal the tree.
import { RULE_IDS, type Finding, type RuleId } from "./types.ts";

export type Counts = Partial<Record<RuleId, number>>;

export interface Baseline {
  readonly files: Record<string, Counts>;
}

/**
 * A map keyed by repository path with no prototype: a tracked file named
 * `__proto__` or `constructor` is an entry like any other.
 */
export const pathMap = (): Record<string, Counts> =>
  Object.create(null) as Record<string, Counts>;

/** A JSON object: not an array, not null. */
const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRuleId = (rule: string): rule is RuleId =>
  (RULE_IDS as readonly string[]).includes(rule);

/** The baseline in `text`; `where` names it in errors. Absent or blank is empty. */
export const parseBaseline = (text: string | null, where: string): Baseline => {
  if (text === null || text.trim() === "") return { files: pathMap() };
  const raw: unknown = JSON.parse(text);
  if (!isJsonObject(raw) || !("files" in raw))
    throw new Error(`${where}: expected {"files": {...}}`);
  const files = raw.files;
  if (!isJsonObject(files))
    throw new Error(`${where}: "files" must be an object`);
  const out = pathMap();
  for (const [path, counts] of Object.entries(files)) {
    if (!isJsonObject(counts))
      throw new Error(`${where}: ${path} must map rule ids to counts`);
    const entry: Counts = {};
    for (const [rule, count] of Object.entries(counts)) {
      if (!isRuleId(rule))
        throw new Error(`${where}: ${path} names unknown rule ${rule}`);
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1)
        throw new Error(`${where}: ${path} ${rule} must be a positive integer`);
      entry[rule] = count;
    }
    out[path] = entry;
  }
  return { files: out };
};

/** The baseline as committed: paths sorted, zero counts and empty entries dropped. */
export const renderBaseline = (baseline: Baseline): string => {
  const files = pathMap();
  for (const path of Object.keys(baseline.files).sort()) {
    const counts: Counts = {};
    for (const rule of RULE_IDS) {
      const count = baseline.files[path]?.[rule];
      if (count !== undefined && count > 0) counts[rule] = count;
    }
    if (Object.keys(counts).length > 0) files[path] = counts;
  }
  return `${JSON.stringify({ files }, null, 2)}\n`;
};

export const countFindings = (
  findings: readonly Finding[],
): Map<string, Counts> => {
  const out = new Map<string, Counts>();
  for (const finding of findings) {
    const counts = out.get(finding.file) ?? {};
    counts[finding.rule] = (counts[finding.rule] ?? 0) + 1;
    out.set(finding.file, counts);
  }
  return out;
};

export interface Over {
  readonly file: string;
  readonly rule: RuleId;
  readonly allowed: number;
  readonly now: number;
  /** Every finding of that file and rule. */
  readonly findings: Finding[];
}

export interface Under {
  readonly file: string;
  readonly rule: RuleId;
  readonly allowed: number;
  readonly now: number;
}

export interface RatchetResult {
  /** Findings beyond a file's allowance. */
  readonly over: Over[];
  /** Allowances the tree no longer uses: lower them in the baseline. */
  readonly under: Under[];
}

/** Compare the checked files' findings with their allowances. */
export const ratchet = (
  checked: readonly string[],
  findings: readonly Finding[],
  baseline: Baseline,
): RatchetResult => {
  const result: RatchetResult = { over: [], under: [] };
  const held = findings.filter((f) => f.ratchet !== false);
  const counts = countFindings(held);
  // A finding no baseline may hold is over, whatever the file's allowance.
  const unheld = findings.filter((f) => f.ratchet === false);
  for (const file of new Set(unheld.map((f) => f.file))) {
    for (const rule of RULE_IDS) {
      const mine = unheld.filter((f) => f.file === file && f.rule === rule);
      if (mine.length === 0) continue;
      result.over.push({
        file,
        rule,
        allowed: 0,
        now: mine.length,
        findings: mine,
      });
    }
  }
  for (const file of checked) {
    const now = counts.get(file) ?? {};
    const allowed = baseline.files[file] ?? {};
    for (const rule of RULE_IDS) {
      const n = now[rule] ?? 0;
      const a = allowed[rule] ?? 0;
      if (n > a)
        result.over.push({
          file,
          rule,
          allowed: a,
          now: n,
          findings: held.filter((f) => f.file === file && f.rule === rule),
        });
      else if (n < a) result.under.push({ file, rule, allowed: a, now: n });
    }
  }
  return result;
};

/** Baseline entries for files `exists` does not vouch for. */
export const staleEntries = (
  baseline: Baseline,
  exists: (path: string) => boolean,
): string[] => Object.keys(baseline.files).filter((path) => !exists(path));

/**
 * Refusals for a baseline edit that raises any allowance. A new entry is
 * accepted only as a rename git detected in the same change (`renames`, new
 * path to old path), whose old entry is removed and whose counts are no
 * higher: fixing one legacy file must not fund a violation in another.
 */
export const baselineIncreases = (
  before: Baseline,
  after: Baseline,
  renames: ReadonlyMap<string, string> = new Map(),
): string[] => {
  const problems: string[] = [];
  const carriesForward = (from: string, counts: Counts): boolean => {
    const old = before.files[from];
    return (
      !(from in after.files) &&
      old !== undefined &&
      RULE_IDS.every((rule) => (counts[rule] ?? 0) <= (old[rule] ?? 0))
    );
  };
  for (const [path, counts] of Object.entries(after.files)) {
    const old = before.files[path];
    if (old === undefined) {
      const from = renames.get(path);
      if (from === undefined || !carriesForward(from, counts))
        problems.push(
          `${path}: a new baseline entry; fix the file instead of recording its findings`,
        );
      continue;
    }
    for (const rule of RULE_IDS)
      if ((counts[rule] ?? 0) > (old[rule] ?? 0))
        problems.push(
          `${path}: ${rule} raised from ${old[rule] ?? 0} to ${counts[rule] ?? 0}; counts only fall`,
        );
  }
  return problems;
};
