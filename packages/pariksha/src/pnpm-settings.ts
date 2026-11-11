// pnpm-settings: pnpm settings live where pnpm reads them, and took effect.
//
// pnpm 11 stopped reading the `pnpm` field of package.json, silently
// (pnpm/pnpm#11536): an `overrides` or `patchedDependencies` left there gives
// a green install in which every security pin has reverted and every patch
// has stopped applying. A green install proves nothing, so this reads the
// evidence out of the resolved lockfile:
//
//   1. package.json carries no pnpm setting pnpm 11 ignores;
//   2. every override in pnpm-workspace.yaml is in the lockfile, and back;
//   3. every patch is in the lockfile and back, its file exists, and its
//      sha256 is the one the lockfile records;
//   4. no resolved version sits inside a range an override excludes (or, for
//      a bare-name override, outside the range it forces);
//   5. every `minimumReleaseAgeExclude` entry is an exact version the lockfile
//      still resolves, under a comment that says why and `EXPIRES:` when, and
//      that expiry has not passed. The config's own scopes are standing
//      entries, exempt.
//
// Version ranges are read by semver-range.ts: a form it does not read (`^`,
// `~`, `1.x`, a hyphen range) is reported as unchecked, never passed.
// pnpm 12 writes the lockfile as two YAML documents, the package manager's
// first: the last one with content is the project's.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_SCHEMA, load, loadAll } from 'js-yaml';
import { satisfies, validRange, validVersion } from './semver-range.ts';

export interface PnpmConfig {
  /** What the messages call this check: a project's rule id, say. */
  readonly id: string;
  /** `minimumReleaseAgeExclude` entries that are standing (the project's own scopes): no expiry or exact version asked. */
  readonly ownScopes: readonly string[];
}

export const DEFAULT_PNPM_CONFIG: PnpmConfig = { id: 'pnpm-settings', ownScopes: [] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `{ "id"?: "<label>", "ownScopes"?: ["@scope/*", …] }`; absent keys take the defaults, anything else throws. */
export const parsePnpmConfig = (text: string): PnpmConfig => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('the config must be a JSON object');
  const unknown = Object.keys(raw).find((k) => k !== 'id' && k !== 'ownScopes');
  if (unknown !== undefined) throw new Error(`unknown key "${unknown}"`);
  const id = raw['id'] ?? DEFAULT_PNPM_CONFIG.id;
  if (typeof id !== 'string' || id.trim() === '') throw new Error('"id" must be a non-empty string');
  const ownScopes = raw['ownScopes'] ?? [];
  if (!Array.isArray(ownScopes) || ownScopes.some((s) => typeof s !== 'string' || s === '')) throw new Error('"ownScopes" must be a list of entries');
  return { id, ownScopes: ownScopes as string[] };
};

/** pnpm 11 reads none of these from package.json. Leaving one there disarms it. */
export const IGNORED_IN_V11 = [
  'overrides',
  'patchedDependencies',
  'auditConfig',
  'onlyBuiltDependencies',
  'onlyBuiltDependenciesFile',
  'neverBuiltDependencies',
  'ignoredBuiltDependencies',
  'ignoreDepScripts',
  'packageExtensions',
  'peerDependencyRules',
  'allowedDeprecatedVersions',
  'updateConfig',
  'allowBuilds',
] as const;

interface WorkspaceConfig {
  overrides?: Record<string, string>;
  patchedDependencies?: Record<string, string>;
  /** `unknown`: a hand-mangled scalar here must be reported, not crash. */
  minimumReleaseAgeExclude?: unknown;
}

export interface PatchRecord {
  /** sha256 of the .patch file, when the lockfile records one. */
  hash?: string;
  /** Patch path: only pnpm 10 and earlier record this. */
  path?: string;
}

export interface LockfileFacts {
  /** `overrides:` as the resolver recorded it: empty means the overrides were dropped. */
  overrides: Record<string, string>;
  /** `patchedDependencies:`, keyed by `name@version`. */
  patchedDependencies: Record<string, PatchRecord>;
  /** Resolved versions per package name, from `packages:`. */
  resolvedVersions: Map<string, string[]>;
}

type RawPatchEntry = string | { hash?: string; path?: string };

interface RawLockfile {
  overrides?: Record<string, string>;
  patchedDependencies?: Record<string, RawPatchEntry>;
  packages?: Record<string, unknown>;
}

/** A lockfile key as name and version, split on the last `@` (scoped names hold one too). */
export const splitNameVersion = (key: string): { name: string; version: string } | null => {
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: key.slice(0, at), version: key.slice(at + 1) };
};

/** The project document: the last one with content. Every document must still parse. */
const projectDocument = (text: string): RawLockfile => {
  const filled = loadAll(text, null, { schema: CORE_SCHEMA }).filter((value) => value !== null && value !== undefined);
  return (filled.at(-1) ?? {}) as RawLockfile;
};

/** What the lockfile records: overrides, patches (pnpm 10's `{ hash, path }` or pnpm 11's bare hash) and resolved versions. */
export const readLockfileFacts = (text: string): LockfileFacts => {
  const doc = projectDocument(text);
  const resolvedVersions = new Map<string, string[]>();
  for (const key of Object.keys(doc.packages ?? {})) {
    const parsed = splitNameVersion(key);
    if (!parsed) continue;
    resolvedVersions.set(parsed.name, [...(resolvedVersions.get(parsed.name) ?? []), parsed.version]);
  }
  const patchedDependencies: Record<string, PatchRecord> = {};
  for (const [key, entry] of Object.entries(doc.patchedDependencies ?? {})) {
    // String(), not a typeof check: an all-digit hash parses as a number.
    patchedDependencies[key] = entry !== null && typeof entry === 'object' ? { ...entry } : { hash: String(entry) };
  }
  return { overrides: doc.overrides ?? {}, patchedDependencies, resolvedVersions };
};

/**
 * The comment block right above `minimumReleaseAgeExclude:`, the decision
 * record YAML parsing drops. A blank line or a setting ends it, so a comment
 * on another key is never read as this one's.
 */
export const releaseAgeExclusionComment = (workspaceText: string): string => {
  const lines = workspaceText.split('\n');
  const at = lines.findIndex((line) => /^minimumReleaseAgeExclude\s*:/.test(line));
  if (at === -1) return '';
  const collected: string[] = [];
  for (let i = at - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('#')) break;
    collected.unshift(line.replace(/^#\s?/, ''));
  }
  return collected.join('\n');
};

/** `absent`: no `EXPIRES:` line; `invalid`: one this cannot read; `at`: when the exception ends. */
export type ExclusionExpiry = { kind: 'absent' } | { kind: 'invalid'; raw: string } | { kind: 'at'; at: Date; raw: string };

/** A date, optionally a UTC time: `2026-09-02`, `2026-09-02T18:54Z`, `2026-09-02T18:54:00.000Z`. */
const ISO_8601_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z)?$/;

/**
 * `EXPIRES: <ISO-8601>` from a line that opens with it (a mention mid-sentence
 * records nothing), its trailing punctuation dropped. A value that is not an
 * ISO-8601 date, or names a day its month lacks, is invalid.
 */
export const parseExclusionExpiry = (comment: string): ExclusionExpiry => {
  const match = /^[ \t]*EXPIRES[ \t]*:[ \t]*(\S*)/im.exec(comment);
  if (match === null) return { kind: 'absent' };
  const raw = (match[1] ?? '').replace(/[.,;:]+$/, '');
  const at = new Date(raw);
  if (!ISO_8601_DATE.test(raw) || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== raw.slice(0, 10)) return { kind: 'invalid', raw };
  return { kind: 'at', at, raw };
};

/** An override or exclusion selector as name and range: `tar@<=7.5.20`, `@babel/core@>=7 <8`; a bare name targets `*`. */
export const parseSelector = (selector: string): { name: string; range: string } => {
  const at = selector.lastIndexOf('@');
  if (at <= 0) return { name: selector, range: '*' };
  return { name: selector.slice(0, at), range: selector.slice(at + 1) };
};

/** Check 5: cooling-off exceptions are scoped to one version, still resolved, documented and unexpired. */
export const checkReleaseAgeExclusions = (workspaceText: string, declared: unknown, lock: LockfileFacts, ownScopes: readonly string[], now: number): { failures: string[]; count: number } => {
  const failures: string[] = [];
  if (declared === undefined || declared === null) return { failures, count: 0 };
  if (!Array.isArray(declared)) {
    return {
      failures: [
        `minimumReleaseAgeExclude must be a list of \`name@version\` strings, but it is ` +
          `\`${typeof declared}\`. pnpm cannot apply it in this shape, so the exception it ` +
          `was meant to record is not in force either.`,
      ],
      count: 0,
    };
  }
  const exceptions = declared.filter((entry) => !(typeof entry === 'string' && ownScopes.includes(entry)));
  // An empty list is the post-expiry steady state, not something to document.
  if (exceptions.length === 0) return { failures, count: 0 };
  const comment = releaseAgeExclusionComment(workspaceText);
  if (comment === '') {
    failures.push(
      `minimumReleaseAgeExclude declares ${exceptions.length} cooling-off exception(s) with no ` +
        `comment above the block. pnpm writes entries here on its own when ` +
        `minimumReleaseAgeStrict is false, so an undocumented entry is a supply-chain ` +
        `exception nobody took. Record why it was taken, what took it, and when it expires.`,
    );
  } else {
    const expiry = parseExclusionExpiry(comment);
    if (expiry.kind === 'absent') {
      failures.push(
        `the comment above minimumReleaseAgeExclude does not say when the exception expires. ` +
          `Add an \`EXPIRES: <YYYY-MM-DD…>\` line — an exception with no end date is a ` +
          `permanent hole in the cooling-off.`,
      );
    } else if (expiry.kind === 'invalid') {
      failures.push(
        `the EXPIRES value above minimumReleaseAgeExclude (\`${expiry.raw}\`) is not a date this ` +
          `check can read, so the expiry cannot be enforced and the exception is open-ended in ` +
          `practice. Write an ISO-8601 UTC instant, e.g. \`EXPIRES: 2026-09-02T18:54Z\`.`,
      );
    } else if (expiry.at.getTime() <= now) {
      failures.push(
        `the minimumReleaseAgeExclude exception expired at ${expiry.at.toISOString()} and is ` +
          `still in force for ${exceptions.map((e) => `\`${String(e)}\``).join(', ')}. ` +
          `The pinned versions have aged past minimumReleaseAge, so pnpm will not re-add them: ` +
          `exception expired; delete the entries.`,
      );
    }
  }
  for (const entry of exceptions) {
    if (typeof entry !== 'string') {
      failures.push(`minimumReleaseAgeExclude entry \`${String(entry)}\` is not a string, so pnpm cannot ` + `match it against a package.`);
      continue;
    }
    const { name, range } = parseSelector(entry);
    if (!validVersion(range)) {
      failures.push(
        `minimumReleaseAgeExclude entry \`${entry}\` is not pinned to an exact version. ` +
          `Scoped this way it exempts versions nobody has reviewed from the cooling-off — ` +
          `write \`${name}@<exact version>\`.`,
      );
      continue;
    }
    const resolved = lock.resolvedVersions.get(name) ?? [];
    // Peer-suffixed keys, `1.2.3(react@19.0.0)`: the base version counts.
    if (!resolved.some((version) => version.split('(')[0] === range)) {
      failures.push(
        `minimumReleaseAgeExclude entry \`${entry}\` is stale: the lockfile no longer resolves ` +
          `${name}@${range}. The exception has outlived the pin it was taken for — delete the line.`,
      );
    }
  }
  return { failures, count: exceptions.length };
};

export interface ParityReport {
  failures: string[];
  /** Selectors that could not be version-checked: reported, never passed silently. */
  notes: string[];
  overrideCount: number;
  patchCount: number;
  versionsChecked: number;
  /** Cooling-off exceptions declared in `minimumReleaseAgeExclude`. */
  releaseAgeExclusionCount: number;
}

const stopped = (failures: string[], notes: string[]): ParityReport => ({ failures, notes, overrideCount: 0, patchCount: 0, versionsChecked: 0, releaseAgeExclusionCount: 0 });

/** Every check on the repository at `root`; `now` decides whether an expiry has passed. */
export const checkPnpmSettings = (root: string, config: PnpmConfig, now: number = Date.now()): ParityReport => {
  const failures: string[] = [];
  const notes: string[] = [];
  const pkgPath = join(root, 'package.json');
  const wsPath = join(root, 'pnpm-workspace.yaml');
  const lockPath = join(root, 'pnpm-lock.yaml');
  for (const p of [pkgPath, wsPath, lockPath]) {
    // Fail closed: a missing input is not a pass.
    if (!existsSync(p)) return stopped([`required file missing: ${p}`], notes);
  }

  // 1. package.json carries no setting pnpm 11 ignores.
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { pnpm?: Record<string, unknown> };
  const stranded = IGNORED_IN_V11.filter((k) => pkg.pnpm?.[k] !== undefined);
  if (stranded.length > 0) {
    failures.push(
      `package.json#pnpm still declares ${stranded.map((s) => `\`${s}\``).join(', ')}. ` +
        `pnpm 11 does not read these and will not warn. Move them to pnpm-workspace.yaml. ` +
        `See https://github.com/pnpm/pnpm/issues/11536`,
    );
  }

  let ws: WorkspaceConfig;
  let wsText: string;
  try {
    wsText = readFileSync(wsPath, 'utf8');
    ws = (load(wsText, { schema: CORE_SCHEMA }) ?? {}) as WorkspaceConfig;
  } catch (error) {
    failures.push(`pnpm-workspace.yaml is not valid YAML, so no setting in it is being applied: ${String(error)}`);
    return stopped(failures, notes);
  }
  let lock: LockfileFacts;
  try {
    lock = readLockfileFacts(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    failures.push(`pnpm-lock.yaml could not be parsed, so override and patch parity cannot be verified: ${String(error)}`);
    return stopped(failures, notes);
  }

  // 2. Override parity, workspace and lockfile.
  const declared = ws.overrides ?? {};
  const declaredKeys = Object.keys(declared);
  const lockedKeys = Object.keys(lock.overrides);
  if (declaredKeys.length > 0 && lockedKeys.length === 0) {
    failures.push(
      `pnpm-workspace.yaml declares ${declaredKeys.length} overrides but pnpm-lock.yaml records none. ` +
        `This is the signature of pnpm ignoring the settings source entirely. ` +
        `Re-run \`pnpm install --lockfile-only\` and confirm the lockfile's overrides: block is populated.`,
    );
  }
  for (const [selector, target] of Object.entries(declared)) {
    if (!(selector in lock.overrides)) {
      failures.push(`override \`${selector}\` is declared in pnpm-workspace.yaml but absent from the lockfile.`);
    } else if (lock.overrides[selector] !== target) {
      failures.push(`override \`${selector}\` disagrees: workspace says \`${target}\`, lockfile says \`${lock.overrides[selector]}\`.`);
    }
  }
  for (const selector of lockedKeys) {
    if (!(selector in declared)) failures.push(`override \`${selector}\` is in the lockfile but no longer declared in pnpm-workspace.yaml.`);
  }

  // 3. Patch parity, and the patch files exist and are the ones applied.
  const declaredPatches = ws.patchedDependencies ?? {};
  for (const [key, patchPath] of Object.entries(declaredPatches)) {
    const record = lock.patchedDependencies[key];
    if (!(key in lock.patchedDependencies) || record === undefined) {
      failures.push(`patch \`${key}\` is declared in pnpm-workspace.yaml but absent from the lockfile — it is not being applied.`);
      continue;
    }
    // pnpm 10 recorded a path, pnpm 11 only the hash: compare a path only when there is one.
    if (record.path !== undefined && record.path !== patchPath) {
      failures.push(`patch \`${key}\` path disagrees: workspace says \`${patchPath}\`, lockfile says \`${record.path}\`.`);
    }
    const absolutePatch = join(root, patchPath);
    if (!existsSync(absolutePatch)) {
      failures.push(`patch file for \`${key}\` does not exist on disk: ${patchPath}`);
      continue;
    }
    if (record.hash !== undefined) {
      const actual = createHash('sha256').update(readFileSync(absolutePatch)).digest('hex');
      if (actual !== record.hash) {
        failures.push(
          `patch \`${key}\` content does not match the lockfile: ${patchPath} hashes to ` +
            `${actual.slice(0, 16)}… but the lockfile recorded ${record.hash.slice(0, 16)}…. ` +
            `Re-run \`pnpm patch-commit\` so the applied patch and the committed file agree.`,
        );
      }
    }
  }
  for (const key of Object.keys(lock.patchedDependencies)) {
    if (!(key in declaredPatches)) failures.push(`patch \`${key}\` is in the lockfile but no longer declared in pnpm-workspace.yaml.`);
  }

  // 4. Each override took effect on every resolved version. `tar@<=7.5.20`
  // names the vulnerable range, so no resolved version may be inside it;
  // bare `tar` forces every version to its target, which each must satisfy.
  let versionsChecked = 0;
  for (const selector of declaredKeys) {
    const { name, range } = parseSelector(selector);
    const resolved = lock.resolvedVersions.get(name);
    if (!resolved || resolved.length === 0) continue;
    const isBareName = !selector.slice(1).includes('@');
    const assertion = isBareName ? declared[selector] : range;
    if (!validRange(assertion)) {
      notes.push(`override \`${selector}\` has no parseable semver range (\`${assertion}\`); ` + `version compliance not checked.`);
      continue;
    }
    for (const version of resolved) {
      const base = version.split('(')[0] ?? '';
      if (!validRange(base)) continue;
      versionsChecked++;
      const inAssertedRange = satisfies(base, assertion as string);
      if (isBareName && !inAssertedRange) {
        failures.push(`override \`${selector}\` did not take effect: ${name}@${base} is resolved, ` + `but the override forces every version to \`${assertion}\`.`);
      } else if (!isBareName && inAssertedRange) {
        failures.push(`override \`${selector}\` did not take effect: ${name}@${base} is still resolved, ` + `and it falls inside the excluded range \`${assertion}\`.`);
      }
    }
  }

  // 5. Cooling-off exceptions are scoped, live and decided.
  const exclusions = checkReleaseAgeExclusions(wsText, ws.minimumReleaseAgeExclude, lock, config.ownScopes, now);
  failures.push(...exclusions.failures);
  return { failures, notes, overrideCount: declaredKeys.length, patchCount: Object.keys(declaredPatches).length, versionsChecked, releaseAgeExclusionCount: exclusions.count };
};

/** The report as the original printed it: notes and failures on stderr, the clean line on stdout. */
export const formatParity = (report: ParityReport, id: string): { ok: boolean; out: string[]; err: string[] } => {
  const err: string[] = [];
  if (report.notes.length > 0) {
    err.push(`⚠️  ${id}: ${report.notes.length} selector(s) not version-checked:`, ...report.notes.map((n) => `   - ${n}`));
  }
  if (report.failures.length > 0) {
    err.push(`\n❌ ${id}: pnpm settings parity FAILED (${report.failures.length} problem(s))\n`, ...report.failures.map((f) => ` • ${f}\n`));
    err.push('A successful `pnpm install` is not evidence here — pnpm 11 drops these settings without warning.\n');
    return { ok: false, out: [], err };
  }
  const extra =
    `${report.releaseAgeExclusionCount > 0 ? `, ${report.releaseAgeExclusionCount} documented cooling-off exception(s)` : ''}` +
    `${report.notes.length > 0 ? `, ${report.notes.length} selector(s) unchecked` : ''}`;
  return {
    ok: true,
    out: [`✅ ${id}: pnpm settings parity OK — ${report.overrideCount} override(s), ${report.patchCount} patch(es), ${report.versionsChecked} resolved version(s) verified${extra}.`],
    err,
  };
};
