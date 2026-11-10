// fault-injection-registry: every unit whose dependencies can fail runs under
// the repository's fault-injection harness, or says why it need not.
//
// A consumer is a unit (a CLI's entry, a service method) whose suite fails its
// dependencies call by call through the harness and asserts each declared
// check (an exit contract, containment of a best-effort step, convergence on a
// rerun) with zero violations. Discovery finds the units that owe one by their
// text: under each configured group's roots, a tracked source matching the
// group's marker (a CLI entry point, a best-effort step). Whatever it finds is
// registered, exempt with a reason, or in the baseline, and the baseline only
// shrinks.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  audit,
  checkExamples,
  checkFindingIds,
  formatOutcome,
  importsModule,
  importsPackage,
  isCollected,
  isRecord,
  list,
  object,
  onlyKeys,
  optionalText,
  parseBaseline as parseLists,
  parseExamples,
  parseJson,
  path,
  paths,
  readText,
  reason,
  records,
  regex,
  regexes,
  text,
  type Baseline,
  type Examples,
} from './registry-ratchet.ts';

export interface Group {
  /** Tracked folders (or files) the group's discovery reads. */
  readonly roots: readonly string[];
  /** The paths under the roots that are source, as a regex. */
  readonly include: RegExp;
  /** The text that makes a source owe a suite. */
  readonly marker: RegExp;
}

export interface Consumer {
  readonly source: string;
  /** The function or method the scenarios drive; its leading name must appear in the source. */
  readonly unit: string;
  readonly checks: readonly string[];
  readonly test: string;
  readonly motivatedBy: string | undefined;
  /** Behaviour of the source the scenarios do not reach, stated plainly. */
  readonly uncovered: string | undefined;
}

export interface Config {
  readonly baseline: string;
  /** Discovery groups by the baseline list each one owes into. */
  readonly discover: Readonly<Record<string, Group>>;
  /** Paths a test runner collects, as regexes. */
  readonly collected: readonly RegExp[];
  readonly harness: {
    /** The harness's entry module, root-relative. */
    readonly module: string;
    /** Bare specifiers the harness is imported by too (a workspace package's export). */
    readonly imports: readonly string[];
    /** The harness function each check id is asserted through. */
    readonly checks: Readonly<Record<string, string>>;
    /** The harness function that holds a run to zero violations. */
    readonly heldBy: string;
  };
  readonly consumers: readonly Consumer[];
  readonly exempt: ReadonlyArray<{ readonly source: string; readonly reason: string }>;
  readonly examples: Examples | undefined;
  readonly findingId: RegExp | undefined;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const LIST_NAME = /^[A-Za-z_][\w-]*$/;

/** The config a JSON text names; throws naming the first bad key. */
export const parseConfig = (source: string): Config => {
  const raw = parseJson(source);
  onlyKeys(raw, ['baseline', 'discover', 'collected', 'harness', 'consumers', 'exempt', 'examples', 'findingId'], '');
  const groupsRaw = object(raw, 'discover', '');
  const discover: Record<string, Group> = {};
  for (const [name, group] of Object.entries(groupsRaw)) {
    const where = `discover.${name}: `;
    if (!LIST_NAME.test(name)) throw new Error(`discover: "${name}" is not a baseline list name`);
    if (!isRecord(group)) throw new Error(`discover.${name} must be an object`);
    onlyKeys(group, ['roots', 'include', 'marker'], where);
    const marker = object(group, 'marker', where);
    onlyKeys(marker, ['pattern', 'flags'], `${where}marker: `);
    const flags = marker['flags'] ?? '';
    if (typeof flags !== 'string' || !/^[imsu]*$/.test(flags)) throw new Error(`${where}marker.flags must be some of i, m, s, u`);
    discover[name] = { roots: paths(group, 'roots', where), include: regex(group['include'], `${where}"include"`), marker: regex(marker['pattern'], `${where}marker.pattern`, flags) };
  }
  if (Object.keys(discover).length === 0) throw new Error('"discover" is empty, so nothing would be discovered');
  const harnessRaw = object(raw, 'harness', '');
  onlyKeys(harnessRaw, ['module', 'imports', 'checks', 'heldBy'], 'harness: ');
  const imports = list(harnessRaw, 'imports', 'harness: ').map((s, i) => {
    if (typeof s !== 'string' || s === '' || s.startsWith('.')) throw new Error(`harness.imports[${i}] must be a bare module specifier`);
    return s;
  });
  const checksRaw = object(harnessRaw, 'checks', 'harness: ');
  const checks: Record<string, string> = {};
  for (const [id, fn] of Object.entries(checksRaw)) {
    if (typeof fn !== 'string' || !IDENTIFIER.test(fn)) throw new Error(`harness.checks.${id} must be a function name`);
    checks[id] = fn;
  }
  if (Object.keys(checks).length === 0) throw new Error('harness: "checks" is empty, so no suite would assert anything');
  const heldBy = text(harnessRaw, 'heldBy', 'harness: ');
  if (!IDENTIFIER.test(heldBy)) throw new Error('harness: "heldBy" must be a function name');
  const harness = { module: path(harnessRaw, 'module', 'harness: '), imports, checks, heldBy };
  const consumers = records(list(raw, 'consumers', ''), 'consumers').map(({ raw: e, where }): Consumer => {
    onlyKeys(e, ['source', 'unit', 'checks', 'test', 'motivatedBy', 'uncovered'], where);
    const declared = e['checks'];
    if (!Array.isArray(declared) || declared.length === 0) throw new Error(`${where}"checks" must be a non-empty list of check ids`);
    const unknown = declared.find((c) => typeof c !== 'string' || checks[c] === undefined);
    if (unknown !== undefined) throw new Error(`${where}${JSON.stringify(unknown)} is not a check in harness.checks`);
    return {
      source: path(e, 'source', where),
      unit: text(e, 'unit', where),
      checks: declared as string[],
      test: path(e, 'test', where),
      motivatedBy: optionalText(e, 'motivatedBy', where),
      uncovered: optionalText(e, 'uncovered', where),
    };
  });
  const exempt = records(list(raw, 'exempt', ''), 'exempt').map(({ raw: e, where }) => {
    onlyKeys(e, ['source', 'reason'], where);
    return { source: path(e, 'source', where), reason: reason(e, where) };
  });
  const sources = [...consumers.map((c) => c.source), ...exempt.map((e) => e.source)];
  const twice = sources.find((s, i) => sources.indexOf(s) !== i);
  if (twice !== undefined) throw new Error(`"${twice}" is registered or exempt more than once`);
  const examples = parseExamples(raw);
  const unchecked = Object.keys(examples?.fixtures ?? {}).find((id) => checks[id] === undefined);
  if (unchecked !== undefined) throw new Error(`examples.fixtures.${unchecked}: not a check in harness.checks`);
  const findingId = raw['findingId'] === undefined ? undefined : regex(raw['findingId'], '"findingId"');
  checkFindingIds(findingId, [
    ...consumers.map((c) => [`consumers ${c.source}: motivatedBy`, c.motivatedBy] as const),
    ...Object.entries(examples?.fixtures ?? {}).map(([id, f]) => [`examples.fixtures.${id}: example`, f.example] as const),
  ]);
  return { baseline: path(raw, 'baseline', ''), discover, collected: regexes(raw, 'collected', ''), harness, consumers, exempt, examples, findingId };
};

/** The baseline a JSON text holds: one list of paths per discovery group. */
export const parseBaseline = (source: string, where: string, config: Pick<Config, 'discover'>): Baseline => parseLists(source, Object.keys(config.discover), where, 'paths');

// ── discovery ───────────────────────────────────────────────────────────────

const NOT_SOURCE = /\.test\.|\.spec\.|\.d\.ts$|(^|\/)fixtures?\//;

/** The sources among `files` (tracked, root-relative, under the group's roots) that owe a suite. */
export const discoverGroup = (root: string, files: readonly string[], group: Group): string[] =>
  files
    .filter((file) => group.include.test(file) && !NOT_SOURCE.test(file))
    .filter((file) => group.marker.test(readFileSync(join(root, file)).toString()))
    .sort();

// ── accounting ──────────────────────────────────────────────────────────────

/** What the baseline must be now: everything discovered that no consumer or exemption covers. */
export const expectedBaseline = (found: Baseline, config: Pick<Config, 'consumers' | 'exempt'>): Baseline => {
  const covered = new Set([...config.consumers.map((c) => c.source), ...config.exempt.map((e) => e.source)]);
  return Object.fromEntries(Object.entries(found).map(([name, sources]) => [name, sources.filter((s) => !covered.has(s))]));
};

/** The identifier a consumer's `unit` opens with, or '' when it opens with none. */
export const leadName = (unit: string): string => /^[A-Za-z_$][\w$]*/.exec(unit)?.[0] ?? '';

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Findings about the harness module: it exists and exports every function the config names. */
export const checkHarness = (root: string, config: Config): string[] => {
  const { module, checks, heldBy } = config.harness;
  const body = readText(root, module);
  if (body === undefined) return [`harness: ${module} does not exist`];
  return [...new Set([...Object.values(checks), heldBy])].filter((fn) => !new RegExp(String.raw`\bexport\b[^;]*?\b${escape(fn)}\b`).test(body)).map((fn) => `harness: ${module} does not export ${fn}`);
};

/** Findings about the registered consumers: each suite runs every declared check through the harness. */
export const checkConsumers = (root: string, config: Config): string[] => {
  const out: string[] = [];
  const { harness } = config;
  for (const consumer of config.consumers) {
    const what = `${consumer.source}`;
    const source = readText(root, consumer.source);
    if (source === undefined) out.push(`${what}: the registered source does not exist`);
    if (!isCollected(config.collected, consumer.test)) out.push(`${what}: no runner collects ${consumer.test}`);
    const suite = readText(root, consumer.test);
    if (suite === undefined) {
      out.push(`${what}: the suite ${consumer.test} does not exist`);
      continue;
    }
    if (!importsModule(consumer.test, suite, harness.module) && !harness.imports.some((s) => importsPackage(suite, s))) out.push(`${what}: ${consumer.test} does not import the harness (${[harness.module, ...harness.imports].join(' or ')})`);
    if (!importsModule(consumer.test, suite, consumer.source)) out.push(`${what}: ${consumer.test} does not import ${consumer.source}`);
    for (const check of consumer.checks) {
      const fn = harness.checks[check] ?? '';
      if (!suite.includes(`${fn}(`)) out.push(`${what}: ${consumer.test} declares ${check} but never calls ${fn}(`);
    }
    // Registered means held to zero violations, not merely explored.
    if (!suite.includes(`${harness.heldBy}(`)) out.push(`${what}: ${consumer.test} never calls ${harness.heldBy}(, so no run is held to zero violations`);
    const unit = leadName(consumer.unit);
    if (unit === '') out.push(`${what}: unit "${consumer.unit}" opens with no name`);
    else if (source !== undefined && !new RegExp(String.raw`(?<![\w$])${escape(unit)}(?![\w$])`).test(source)) out.push(`${what}: unit ${unit} is not named in the source`);
  }
  return out;
};

/** Every finding: harness, consumers, examples, accounting against the baseline, and growth. */
export const findings = (root: string, config: Config, found: Baseline, baseline: Baseline, grown: readonly string[]): string[] => {
  const { unaccounted, stale } = audit(expectedBaseline(found, config), baseline);
  const discovered = new Set(Object.values(found).flat());
  const callsCheck = (id: string, body: string): string[] => {
    const fn = config.harness.checks[id] ?? '';
    return body.includes(`${fn}(`) ? [] : [`the ${id} example suite never calls ${fn}(`];
  };
  return [
    ...checkHarness(root, config),
    ...checkConsumers(root, config),
    ...(config.examples === undefined ? [] : checkExamples(root, config.examples, config.collected, callsCheck)),
    ...config.exempt.filter((e) => !discovered.has(e.source)).map((e) => `${e.source}: exempt, but discovery does not find it; drop the exemption`),
    ...unaccounted.map((s) => `${s}: discovered and unaccounted; register it with a fault-injection suite, or exempt it with a reason`),
    ...stale.map((s) => `${s}: in ${config.baseline}, but registered, exempt, renamed or gone; remove it from the baseline`),
    ...grown.map((s) => `${s}: added to ${config.baseline} since the merge base; the baseline only shrinks, so register a suite instead`),
  ];
};

export const formatFindings = (list: readonly string[], found: Baseline, baseline: Baseline): { ok: boolean; out: string[]; err: string[] } =>
  formatOutcome(
    'pariksha fault-injection-registry:',
    list,
    `${Object.entries(found)
      .map(([name, s]) => `${s.length} ${name}`)
      .join(' and ')} source(s) discovered, each registered, exempt or among the ${Object.values(baseline).flat().length} baselined; the baseline does not grow`,
    'Register a fault-injection suite for a discovered source, or exempt it with a reason; the baseline only shrinks.',
  );
