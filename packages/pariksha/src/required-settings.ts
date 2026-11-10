// required-settings: a settings file carries every value a project requires of it.
//
// A setting a project depends on (Claude Code's `advisorModel`, say) lives in
// one committed line, and one edit deletes it without any test noticing. The
// project lists what it requires, with why, and this check refuses a settings
// file that lacks a key or holds another value.
import { isDeepStrictEqual } from 'node:util';

export interface Requirement {
  /** The key, a dotted path for a nested one (`env.FOO`). */
  readonly key: string;
  /** The value it must hold, compared as JSON. */
  readonly value: unknown;
  /** Why the project requires it; shown when it is missing. */
  readonly why: string;
}

export interface Finding {
  readonly key: string;
  readonly expected: unknown;
  /** The value found; absent when the key is missing. */
  readonly found?: unknown;
  readonly why: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses the requirements file: `{ "<key>": { "value": <any JSON>, "why": "<reason>" }, … }`.
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
    if (!isRecord(spec) || !Object.hasOwn(spec, 'value')) throw new Error(`"${key}" needs { "value": …, "why": "…" }`);
    const extra = Object.keys(spec).filter((k) => k !== 'value' && k !== 'why');
    if (extra.length > 0) throw new Error(`"${key}": unknown key ${extra.map((k) => `"${k}"`).join(', ')}`);
    if (typeof spec.why !== 'string' || spec.why.trim() === '') throw new Error(`"${key}" needs a "why"`);
    out.push({ key, value: spec.value, why: spec.why });
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

/** Every requirement the settings break: a missing key or a different value. */
export function findMissing(settingsText: string, requirements: readonly Requirement[]): Finding[] {
  let settings: unknown;
  try {
    settings = JSON.parse(settingsText);
  } catch (e) {
    throw new Error(`the settings are not JSON (${(e as Error).message})`);
  }
  if (!isRecord(settings)) throw new Error('the settings must hold an object');
  const findings: Finding[] = [];
  for (const r of requirements) {
    const got = lookup(settings, r.key);
    if (got.missing) findings.push({ key: r.key, expected: r.value, why: r.why });
    else if (!isDeepStrictEqual(got.value, r.value)) findings.push({ key: r.key, expected: r.value, found: got.value, why: r.why });
  }
  return findings;
}

/** The check's lines: one per finding on err, or one pass line on out. */
export function formatFindings(findings: readonly Finding[], count: number, settingsPath: string, requirePath: string): { ok: boolean; out: string[]; err: string[] } {
  const P = 'pariksha required-settings:';
  if (findings.length === 0) return { ok: true, out: [`${P} ${settingsPath} carries all ${count} required settings (${requirePath})`], err: [] };
  return {
    ok: false,
    out: [],
    err: findings.map((f) => {
      const has = Object.hasOwn(f, 'found') ? `holds ${JSON.stringify(f.found)}` : 'is missing';
      return `${P} ${settingsPath}: "${f.key}" ${has}; it must be ${JSON.stringify(f.expected)} (${f.why}). Put it back; to change the requirement, edit ${requirePath}.`;
    }),
  };
}
