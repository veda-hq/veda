// The engine the registry ratchets share (codec-registry, fault-injection-registry).
//
// A registry ratchet holds three things to account. Discovery finds every
// item that owes a suite. The config registers an item with its suite, or
// exempts it with a reason. The baseline lists the items still owed, and only
// shrinks: an entry the merge base did not have is growth, unless its file
// only moved. Everything here is the shared part: config validation helpers,
// the baseline's shape, the audit, the growth check and the suite wiring a
// runner must collect.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { fileAt, mergeBaseOf, renamesSince, type Git } from './git.ts';

export type Raw = Record<string, unknown>;

export const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A normalized relative POSIX path that stays inside the root. */
export const isRepoPath = (p: string): boolean => !isAbsolute(p) && posix.normalize(p) === p && p !== '.' && p !== '..' && !p.startsWith('../') && !p.endsWith('/');

/** Throws naming the first key of `raw` that `allowed` lacks. */
export const onlyKeys = (raw: Raw, allowed: readonly string[], where: string): void => {
  const extra = Object.keys(raw).find((k) => !allowed.includes(k));
  if (extra !== undefined) throw new Error(`${where}unknown key "${extra}"`);
};

/** The object at `raw[key]`; throws when it is not one. */
export const object = (raw: Raw, key: string, where: string): Raw => {
  const v = raw[key];
  if (!isRecord(v)) throw new Error(`${where}"${key}" must be an object`);
  return v;
};

/** A required non-blank string. */
export const text = (raw: Raw, key: string, where: string): string => {
  const v = raw[key];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${where}"${key}" must be a non-empty string`);
  return v;
};

/** An optional string, non-blank when present. */
export const optionalText = (raw: Raw, key: string, where: string): string | undefined => (raw[key] === undefined ? undefined : text(raw, key, where));

/** A required root-relative path. */
export const path = (raw: Raw, key: string, where: string): string => {
  const v = text(raw, key, where);
  if (!isRepoPath(v)) throw new Error(`${where}"${key}": "${v}" is not a normalized root-relative path`);
  return v;
};

/** A list, empty when absent; throws when present and not a list. */
export const list = (raw: Raw, key: string, where: string): unknown[] => {
  const v = raw[key] ?? [];
  if (!Array.isArray(v)) throw new Error(`${where}"${key}" must be a list`);
  return v;
};

/** A non-empty list of root-relative paths. */
export const paths = (raw: Raw, key: string, where: string): string[] => {
  const v = list(raw, key, where);
  if (v.length === 0) throw new Error(`${where}"${key}" is empty, so nothing would be read`);
  return v.map((p, i) => {
    if (typeof p !== 'string' || !isRepoPath(p)) throw new Error(`${where}${key}[${i}]: ${JSON.stringify(p)} is not a normalized root-relative path`);
    return p;
  });
};

/** A regular expression from its source text. */
export const regex = (source: unknown, where: string, flags = ''): RegExp => {
  if (typeof source !== 'string' || source === '') throw new Error(`${where} must be a non-empty regular expression`);
  try {
    return new RegExp(source, flags);
  } catch (e) {
    throw new Error(`${where}: "${source}" is not a regular expression: ${(e as Error).message}`);
  }
};

/** A non-empty list of regular expressions. */
export const regexes = (raw: Raw, key: string, where: string): RegExp[] => {
  const v = list(raw, key, where);
  if (v.length === 0) throw new Error(`${where}"${key}" is empty, so nothing would match`);
  return v.map((s, i) => regex(s, `${where}${key}[${i}]`));
};

/** Each entry of `items` is a record; `where` names it in a message. */
export const records = (items: readonly unknown[], key: string): Array<{ raw: Raw; where: string }> =>
  items.map((raw, i) => {
    const where = `${key}[${i}]: `;
    if (!isRecord(raw)) throw new Error(`${key}[${i}] must be an object`);
    return { raw, where };
  });

/** An exemption must say why, in words a reviewer reads. */
export const reason = (raw: Raw, where: string): string => {
  const v = raw['reason'];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${where}an exemption needs a reason`);
  return v;
};

/** The config text as JSON; throws naming why not. */
export const parseJson = (source: string): Raw => {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('the config must be a JSON object');
  return raw;
};

// ── the baseline ────────────────────────────────────────────────────────────

/** A baseline: named lists of the ids still owed a suite. Only shrinks. */
export type Baseline = Readonly<Record<string, readonly string[]>>;

/**
 * The baseline a JSON text holds: exactly the `lists` named, each a list of
 * strings. Throws naming the first list that is wrong, so a malformed
 * baseline fails loudly rather than reading as empty.
 */
export const parseBaseline = (source: string, lists: readonly string[], where: string, noun: string): Baseline => {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (e) {
    throw new Error(`${where}: not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error(`${where}: must be an object with ${lists.map((l) => `"${l}"`).join(' and ')} lists`);
  const extra = Object.keys(raw).find((k) => !lists.includes(k));
  if (extra !== undefined) throw new Error(`${where}: unknown list "${extra}"`);
  const out: Record<string, string[]> = {};
  for (const name of lists) {
    const v = raw[name];
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) throw new Error(`${where}: "${name}" must be a list of ${noun}`);
    out[name] = v;
  }
  return out;
};

const all = (baseline: Baseline): string[] => Object.values(baseline).flat();

/** `unaccounted`: discovered, uncovered and not baselined. `stale`: baselined and not owed. */
export const audit = (expected: Baseline, actual: Baseline): { unaccounted: string[]; stale: string[] } => {
  const want = all(expected);
  const have = all(actual);
  return { unaccounted: want.filter((id) => !have.includes(id)), stale: have.filter((id) => !want.includes(id)) };
};

/**
 * Entries the head baseline has that the base did not. An id is a path, or a
 * path then `#` and what in it is owed; when its file was renamed (`renamed`:
 * new path to old path) it counts under its old path, so a move is not growth.
 */
export const grownEntries = (base: Baseline, head: Baseline, renamed: ReadonlyMap<string, string> = new Map()): string[] => {
  const before = new Set(all(base));
  const asBefore = (id: string): string => {
    const hash = id.indexOf('#');
    const file = hash === -1 ? id : id.slice(0, hash);
    const old = renamed.get(file);
    return old === undefined ? id : old + id.slice(file.length);
  };
  return all(head).filter((id) => !before.has(asBefore(id)));
};

/**
 * The growth of the baseline at `baselinePath` since the merge base of HEAD
 * and `base`: empty when the merge base has no baseline yet. A git failure,
 * or a baseline the merge base holds malformed, throws.
 */
export const growthSince = (git: Git, base: string, baselinePath: string, head: Baseline, parse: (source: string, where: string) => Baseline): string[] => {
  const commit = mergeBaseOf(git, base);
  const before = fileAt(git, commit, baselinePath);
  if (before === null) return [];
  return grownEntries(parse(before, `${baselinePath} at the merge base ${commit.slice(0, 12)}`), head, renamesSince(git, commit));
};

/** The roots among `roots` under which none of `files` lies: a typo'd root reads nothing and would pass. */
export const emptyRoots = (files: readonly string[], roots: readonly string[]): string[] => roots.filter((r) => !files.some((f) => f === r || f.startsWith(`${r}/`)));

/** The baseline file at `at` under the root, parsed; throws when it is missing or malformed. */
export const readBaseline = (root: string, at: string, parse: (source: string, where: string) => Baseline): Baseline => {
  const source = readText(root, at);
  if (source === undefined) throw new Error(`the baseline ${at} is not a readable file`);
  return parse(source, at);
};

// ── suite wiring ────────────────────────────────────────────────────────────

const EXTENSION = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

/** The relative specifiers a module imports from (`from './x'`, either quote). */
const relativeSpecifiers = (source: string): string[] => [...source.matchAll(/\bfrom\s*(['"])(\.{1,2}\/[^'"\n]+)\1/g)].map((m) => m[2] ?? '');

/**
 * Whether the suite at `suite` (its text `source`) imports the module at
 * `target` by a relative specifier: each specifier is resolved against the
 * suite's folder, so a same-named module elsewhere does not count. A folder's
 * `index` module may be imported by the folder.
 */
export const importsModule = (suite: string, source: string, target: string): boolean => {
  const want = target.replace(EXTENSION, '');
  const folder = posix.basename(want) === 'index' ? posix.dirname(want) : undefined;
  return relativeSpecifiers(source).some((specifier) => {
    const got = posix.join(posix.dirname(suite), specifier).replace(EXTENSION, '').replace(/\/$/, '');
    return got === want || got === folder;
  });
};

/** Whether the text imports a bare module specifier (`from 'fast-check'`, either quote). */
export const importsPackage = (source: string, specifier: string): boolean => source.includes(`from '${specifier}'`) || source.includes(`from "${specifier}"`);

/** Whether the text names a module specifier as a string, either quote. */
export const namesModule = (source: string, specifier: string): boolean => source.includes(`'${specifier}'`) || source.includes(`"${specifier}"`);

/** Whether a runner collects a suite at `path`, by the collected-path patterns. */
export const isCollected = (collected: readonly RegExp[], path: string): boolean => collected.some((p) => p.test(path));

/** Whether `path` is a regular file under `root`. */
export const isFile = (root: string, path: string): boolean => statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true;

/** The text of a file under `root`, or undefined when it is not a readable file. */
export const readText = (root: string, path: string): string | undefined => {
  if (!isFile(root, path)) return undefined;
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return undefined;
  }
};

// ── catalogue examples ──────────────────────────────────────────────────────

export interface Examples {
  /** A JSON catalogue `{ checks: [{ id, slice, example }] }` and the slice whose checks the fixtures must cover. */
  readonly catalogue: { readonly path: string; readonly slice: string } | undefined;
  /** Per check id: the finding id its example reproduces and the suite that does. */
  readonly fixtures: Readonly<Record<string, { readonly example: string; readonly test: string }>>;
}

/** The `examples` key of a config. */
export const parseExamples = (raw: Raw): Examples | undefined => {
  if (raw['examples'] === undefined) return undefined;
  const v = object(raw, 'examples', '');
  onlyKeys(v, ['catalogue', 'slice', 'fixtures'], 'examples: ');
  if ((v['catalogue'] === undefined) !== (v['slice'] === undefined)) throw new Error('examples: "catalogue" and "slice" go together');
  const catalogue = v['catalogue'] === undefined ? undefined : { path: path(v, 'catalogue', 'examples: '), slice: text(v, 'slice', 'examples: ') };
  const fixturesRaw = object(v, 'fixtures', 'examples: ');
  const fixtures: Record<string, { example: string; test: string }> = {};
  for (const [id, entry] of Object.entries(fixturesRaw)) {
    const where = `examples.fixtures.${id}: `;
    if (!isRecord(entry)) throw new Error(`examples.fixtures.${id} must be an object`);
    onlyKeys(entry, ['example', 'test'], where);
    fixtures[id] = { example: text(entry, 'example', where), test: path(entry, 'test', where) };
  }
  if (Object.keys(fixtures).length === 0) throw new Error('examples: "fixtures" is empty, so nothing would be checked');
  return { catalogue, fixtures };
};

/**
 * Findings about the catalogue examples: the fixtures cover exactly the
 * catalogue's checks for the slice, each from its own example; each fixture
 * suite exists where a runner collects it and names its finding id; `extra`
 * adds what a ratchet asks of a fixture's text. An unreadable catalogue throws.
 */
export const checkExamples = (root: string, examples: Examples, collected: readonly RegExp[], extra: (id: string, text: string) => string[] = () => []): string[] => {
  const out: string[] = [];
  if (examples.catalogue !== undefined) {
    const { path: at, slice } = examples.catalogue;
    const source = readText(root, at);
    if (source === undefined) throw new Error(`the catalogue ${at} is not a readable file`);
    let rows: unknown;
    try {
      rows = (JSON.parse(source) as { checks?: unknown }).checks;
    } catch (e) {
      throw new Error(`the catalogue ${at}: not JSON: ${(e as Error).message}`);
    }
    const isRow = (r: unknown): r is { id: string; slice: string; example: string } =>
      isRecord(r) && typeof r['id'] === 'string' && typeof r['slice'] === 'string' && typeof r['example'] === 'string';
    if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error(`the catalogue ${at}: "checks" must be a list of { id, slice, example }`);
    const mine = rows.filter((r) => r.slice === slice);
    for (const row of mine) {
      const fixture = examples.fixtures[row.id];
      if (fixture === undefined) out.push(`${at}: ${row.id} (slice ${slice}) has no example fixture`);
      else if (!row.example.startsWith(`${fixture.example}:`)) out.push(`examples.fixtures.${row.id}: the catalogue's example is not ${fixture.example} ("${row.example}")`);
    }
    for (const id of Object.keys(examples.fixtures)) {
      if (!mine.some((r) => r.id === id)) out.push(`examples.fixtures.${id}: not a check ${at} gives slice ${slice}`);
    }
  }
  for (const [id, fixture] of Object.entries(examples.fixtures)) {
    const source = readText(root, fixture.test);
    if (source === undefined) {
      out.push(`${fixture.test}: the ${id} example suite does not exist`);
      continue;
    }
    if (!isCollected(collected, fixture.test)) out.push(`${fixture.test}: no runner collects the ${id} example suite`);
    if (!source.includes(fixture.example)) out.push(`${fixture.test}: the ${id} example suite does not name ${fixture.example}`);
    out.push(...extra(id, source).map((m) => `${fixture.test}: ${m}`));
  }
  return out;
};

/** Throws when an id a finding pattern must match does not. */
export const checkFindingIds = (pattern: RegExp | undefined, ids: ReadonlyArray<readonly [string, string | undefined]>): void => {
  if (pattern === undefined) return;
  const bad = ids.find(([, id]) => id !== undefined && !pattern.test(id));
  if (bad !== undefined) throw new Error(`${bad[0]}: "${String(bad[1])}" is not a finding id (${pattern.source})`);
};

/** The verdict: findings on stderr, then what to do; a one-line summary on stdout when there are none. */
export const formatOutcome = (prefix: string, findings: readonly string[], summary: string, hint: string): { ok: boolean; out: string[]; err: string[] } =>
  findings.length === 0
    ? { ok: true, out: [`${prefix} ${summary}`], err: [] }
    : { ok: false, out: [], err: [...findings.map((f) => `${prefix} ${f}`), `${prefix} ${findings.length} problem(s). ${hint}`] };
