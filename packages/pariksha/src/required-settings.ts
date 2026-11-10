// required-settings: a settings file carries every value a project requires of it.
//
// A setting a project depends on (Claude Code's `advisorModel`, say) lives in
// one committed line, and one edit deletes it without any test noticing. The
// project lists what it requires, with why, and this check refuses a settings
// file that lacks a key, holds another value, or drops an entry from a list
// (a permission rule, say) the project requires.
import { isDeepStrictEqual } from 'node:util';

interface RequirementBase {
  /** The key, a dotted path for a nested one (`env.FOO`). */
  readonly key: string;
  /** Why the project requires it; shown when it is missing. */
  readonly why: string;
}

/** `value`: the key holds exactly `expected`; `includes`: the key is a list holding each entry of `expected`. Compared as JSON. */
export type Requirement =
  | (RequirementBase & { readonly kind: 'value'; readonly expected: unknown })
  | (RequirementBase & { readonly kind: 'includes'; readonly expected: readonly unknown[] });

export interface Finding {
  readonly key: string;
  readonly kind: 'value' | 'includes';
  /** The value it must hold, or the required entries the list lacks. */
  readonly expected: unknown;
  /** The value found; absent when the key is missing. */
  readonly found?: unknown;
  readonly why: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses the requirements file:
 * `{ "<key>": { "value": <any JSON>, "why": "…" } | { "includes": [<any JSON>, …], "why": "…" }, … }`.
 * Throws on anything else, so a malformed list never passes as an empty one.
 */
export function parseRequirements(text: string): Requirement[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`the requirements are not JSON (${(e as Error).message})`);
  }
  if (!isRecord(raw)) throw new Error('the requirements must be an object of keys');
  const out: Requirement[] = [];
  for (const [key, spec] of Object.entries(raw)) {
    if (key === '$schema') continue;
    if (key === '' || key.split('.').some((part) => part === '')) throw new Error(`"${key}" is not a key or dotted path`);
    const shape = `"${key}" needs { "value": …, "why": "…" } or { "includes": […], "why": "…" }`;
    if (!isRecord(spec)) throw new Error(shape);
    const hasValue = Object.hasOwn(spec, 'value');
    const hasIncludes = Object.hasOwn(spec, 'includes');
    if (hasValue === hasIncludes) throw new Error(shape);
    const extra = Object.keys(spec).filter((k) => k !== 'value' && k !== 'includes' && k !== 'why');
    if (extra.length > 0) throw new Error(`"${key}": unknown key ${extra.map((k) => `"${k}"`).join(', ')}`);
    if (typeof spec.why !== 'string' || spec.why.trim() === '') throw new Error(`"${key}" needs a "why"`);
    if (!hasIncludes) {
      out.push({ key, kind: 'value', expected: spec.value, why: spec.why });
      continue;
    }
    const includes: unknown = spec.includes;
    if (!Array.isArray(includes) || includes.length === 0) throw new Error(`"${key}": "includes" must list at least one entry`);
    out.push({ key, kind: 'includes', expected: includes, why: spec.why });
  }
  if (out.length === 0) throw new Error('the requirements list no key');
  return out;
}

/** The value at a dotted path, or `{ missing: true }`. */
const lookup = (settings: unknown, key: string): { missing: true } | { missing: false; value: unknown } => {
  let at: unknown = settings;
  for (const part of key.split('.')) {
    if (!isRecord(at) || !Object.hasOwn(at, part)) return { missing: true };
    at = at[part];
  }
  return { missing: false, value: at };
};

/** The finding for one requirement, or undefined when the settings meet it. */
const judge = (settings: unknown, r: Requirement): Finding | undefined => {
  const got = lookup(settings, r.key);
  const base = { key: r.key, kind: r.kind, why: r.why };
  if (r.kind === 'value') {
    if (got.missing) return { ...base, expected: r.expected };
    return isDeepStrictEqual(got.value, r.expected) ? undefined : { ...base, expected: r.expected, found: got.value };
  }
  const wanted = r.expected;
  if (got.missing) return { ...base, expected: wanted };
  if (!Array.isArray(got.value)) return { ...base, expected: wanted, found: got.value };
  const list: readonly unknown[] = got.value;
  const lacking = wanted.filter((entry) => !list.some((have) => isDeepStrictEqual(have, entry)));
  return lacking.length === 0 ? undefined : { ...base, expected: lacking, found: got.value };
};

/** Every requirement the settings break: a missing key, a different value, or a list without a required entry. */
export function findMissing(settingsText: string, requirements: readonly Requirement[]): Finding[] {
  let settings: unknown;
  try {
    settings = JSON.parse(settingsText);
  } catch (e) {
    throw new Error(`the settings are not JSON (${(e as Error).message})`);
  }
  if (!isRecord(settings)) throw new Error('the settings must hold an object');
  return requirements.flatMap((r) => judge(settings, r) ?? []);
}

/** One finding as a line: what is wrong and how to fix it. */
const describe = (f: Finding): string => {
  if (f.kind === 'value') {
    const has = Object.hasOwn(f, 'found') ? `holds ${JSON.stringify(f.found)}` : 'is missing';
    return `"${f.key}" ${has}; it must be ${JSON.stringify(f.expected)}`;
  }
  const entries = (f.expected as readonly unknown[]).map((e) => JSON.stringify(e)).join(', ');
  if (!Object.hasOwn(f, 'found')) return `"${f.key}" is missing; it must be a list holding ${entries}`;
  if (!Array.isArray(f.found)) return `"${f.key}" holds ${JSON.stringify(f.found)}, not a list; it must be a list holding ${entries}`;
  return `"${f.key}" lacks ${entries}`;
};

/** The check's lines: one per finding on err, or one pass line on out. */
export function formatFindings(findings: readonly Finding[], count: number, settingsPath: string, requirePath: string): { ok: boolean; out: string[]; err: string[] } {
  const P = 'pariksha required-settings:';
  if (findings.length === 0) return { ok: true, out: [`${P} ${settingsPath} carries all ${count} required settings (${requirePath})`], err: [] };
  return {
    ok: false,
    out: [],
    err: findings.map((f) => `${P} ${settingsPath}: ${describe(f)} (${f.why}). Put it back; to change the requirement, edit ${requirePath}.`),
  };
}
