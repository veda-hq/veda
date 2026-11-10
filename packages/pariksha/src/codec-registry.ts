// codec-registry: every module that hand-parses a format, and every exported
// writer/reader pair, has a suite that holds it to a reference.
//
// A hand parser (a module that reads markdown, HTML, YAML, CSV, shell or
// TypeScript source by its own regexes) registers with a property suite that
// compares it with the format's reference parser, over both line endings. A
// producer/consumer pair (`writeX`/`readX`, `renderX`/`parseX`…) registers with
// a suite that feeds real producer output through the real consumer; a
// schema-versioned digest registers with a golden. Discovery reads tracked
// source as a syntax tree; whatever it finds is registered, exempt with a
// reason, or in the baseline, and the baseline only shrinks.
import { readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import type * as TS from 'typescript';
import {
  audit,
  checkExamples,
  checkFindingIds,
  formatOutcome,
  importsModule,
  importsPackage,
  isCollected,
  isFile,
  list,
  minNoteLength,
  namesModule,
  note,
  object,
  onlyKeys,
  optionalText,
  parseBaseline as parseLists,
  parseExamples,
  parseFindingIds,
  parseJson,
  path,
  paths,
  readText,
  reason,
  records,
  regexes,
  required,
  text,
  type Baseline,
  type Examples,
  type FindingIds,
} from './registry-ratchet.ts';
import type { Ts } from './typescript.ts';

export const FORMATS = ['markdown', 'html', 'yaml', 'csv', 'shell', 'ts'] as const;
export type Format = (typeof FORMATS)[number];

export interface HandParser {
  readonly source: string;
  readonly formats: readonly Format[];
  readonly suite: string;
  /** What the suite's generators deliberately leave out. */
  readonly outOfModel: string;
  /** Why the suite runs LF only, when it does; every other suite runs both line endings. */
  readonly lfOnly: string | undefined;
  readonly motivatedBy: string | undefined;
}

export interface CodecPair {
  /** `path#producer->consumer`, or `path#digest` for a golden-pinned encoder. */
  readonly id: string;
  readonly kind: 'round-trip' | 'golden';
  readonly suite: string;
  readonly motivatedBy: string | undefined;
}

export interface Config {
  readonly baseline: string;
  /** Tracked folders (or files) discovery reads. */
  readonly roots: readonly string[];
  /** The module each format's reference parser is imported by; discovery reports only these formats. */
  readonly oracles: Readonly<Partial<Record<Format, string>>>;
  /** Paths a test runner collects, as regexes. */
  readonly collected: readonly RegExp[];
  /** Globs a property suite must sit on (where the property library may be imported); undefined when opted out (`null`). */
  readonly surfaces: readonly string[] | undefined;
  /** The property library a differential or round-trip suite imports. */
  readonly library: string;
  /** Text a suite must hold: a fixed seed; both line endings; a golden's assertion. */
  readonly markers: { readonly seed: string; readonly lineEndings: string; readonly golden: string };
  readonly handParsers: readonly HandParser[];
  readonly pairs: readonly CodecPair[];
  readonly exempt: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  /** The fewest characters, trimmed, an exemption reason, `outOfModel` or `lfOnly` may have. */
  readonly minNoteLength: number;
  readonly examples: Examples | undefined;
  readonly findingIds: FindingIds;
  /** The checks the config opted out of with `null`, as the run prints them. */
  readonly skipped: readonly string[];
}

const PAIR_ID = /^[^#]+#(?:[A-Za-z_$][\w$]*->[A-Za-z_$][\w$]*|digest)$/;

const isFormat = (f: unknown): f is Format => typeof f === 'string' && (FORMATS as readonly string[]).includes(f);

/** The config a JSON text names; throws naming the first bad key. */
export const parseConfig = (source: string): Config => {
  const raw = parseJson(source);
  onlyKeys(raw, ['baseline', 'roots', 'oracles', 'collected', 'surfaces', 'library', 'markers', 'handParsers', 'pairs', 'exempt', 'minNoteLength', 'examples', 'findingIds'], '');
  const skipped: string[] = [];
  const min = minNoteLength(raw);
  const oraclesRaw = object(raw, 'oracles', '');
  const oracles: Partial<Record<Format, string>> = {};
  for (const [format, module] of Object.entries(oraclesRaw)) {
    if (!isFormat(format)) throw new Error(`oracles: "${format}" is not a format discovery reads (${FORMATS.join(', ')})`);
    if (typeof module !== 'string' || module === '') throw new Error(`oracles.${format} must be a module name`);
    oracles[format] = module;
  }
  if (Object.keys(oracles).length === 0) throw new Error('"oracles" is empty, so no format would be discovered');
  const surfaces = required(raw, 'surfaces', '', skipped, () => {
    const globs = list(raw, 'surfaces', '');
    if (globs.length === 0) throw new Error('"surfaces" is empty; name the globs a property suite must sit on, or null to check no surface');
    return globs.map((g, i) => {
      if (typeof g !== 'string' || g === '') throw new Error(`surfaces[${i}] must be a non-empty glob`);
      return g;
    });
  });
  const markersRaw = object(raw, 'markers', '');
  onlyKeys(markersRaw, ['seed', 'lineEndings', 'golden'], 'markers: ');
  const markers = { seed: text(markersRaw, 'seed', 'markers: '), lineEndings: text(markersRaw, 'lineEndings', 'markers: '), golden: text(markersRaw, 'golden', 'markers: ') };
  const handParsers = records(list(raw, 'handParsers', ''), 'handParsers').map(({ raw: e, where }): HandParser => {
    onlyKeys(e, ['source', 'formats', 'suite', 'outOfModel', 'lfOnly', 'motivatedBy'], where);
    const formats = e['formats'];
    if (!Array.isArray(formats) || formats.length === 0 || !formats.every(isFormat)) throw new Error(`${where}"formats" must be a non-empty list of ${FORMATS.join(', ')}`);
    const unheld = formats.find((f) => oracles[f] === undefined);
    if (unheld !== undefined) throw new Error(`${where}"${unheld}" has no entry in "oracles", so its suite has no reference to import`);
    return {
      source: path(e, 'source', where),
      formats,
      suite: path(e, 'suite', where),
      outOfModel: note(e, 'outOfModel', where, min, true) ?? '',
      lfOnly: note(e, 'lfOnly', where, min, false),
      motivatedBy: optionalText(e, 'motivatedBy', where),
    };
  });
  const pairs = records(list(raw, 'pairs', ''), 'pairs').map(({ raw: e, where }): CodecPair => {
    onlyKeys(e, ['id', 'kind', 'suite', 'motivatedBy'], where);
    const id = text(e, 'id', where);
    if (!PAIR_ID.test(id)) throw new Error(`${where}"${id}" is not path#producer->consumer or path#digest`);
    const kind = e['kind'];
    if (kind !== 'round-trip' && kind !== 'golden') throw new Error(`${where}"kind" must be "round-trip" or "golden"`);
    return { id, kind, suite: path(e, 'suite', where), motivatedBy: optionalText(e, 'motivatedBy', where) };
  });
  const exempt = records(list(raw, 'exempt', ''), 'exempt').map(({ raw: e, where }) => {
    onlyKeys(e, ['id', 'reason'], where);
    const id = text(e, 'id', where);
    if (!id.includes('#')) throw new Error(`${where}"${id}" is not path#format or a pair id`);
    return { id, reason: reason(e, where, min) };
  });
  const ids = [...handParsers.flatMap((h) => h.formats.map((f) => `${h.source}#${f}`)), ...pairs.map((p) => p.id), ...exempt.map((e) => e.id)];
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice !== undefined) throw new Error(`"${twice}" is registered or exempt more than once`);
  const examples = parseExamples(raw, skipped);
  const findingIds = parseFindingIds(raw, skipped);
  checkFindingIds(findingIds.motivatedBy, [
    ...handParsers.map((h) => [`handParsers ${h.source}: motivatedBy`, h.motivatedBy] as const),
    ...pairs.map((p) => [`pairs ${p.id}: motivatedBy`, p.motivatedBy] as const),
  ]);
  checkFindingIds(
    findingIds.example,
    Object.entries(examples?.fixtures ?? {}).map(([id, f]) => [`examples.fixtures.${id}: example`, f.example] as const),
  );
  return {
    baseline: path(raw, 'baseline', ''),
    roots: paths(raw, 'roots', ''),
    oracles,
    collected: regexes(raw, 'collected', ''),
    surfaces,
    library: raw['library'] === undefined ? 'fast-check' : text(raw, 'library', ''),
    markers,
    handParsers,
    pairs,
    exempt,
    minNoteLength: min,
    examples,
    findingIds,
    skipped,
  };
};

export const LISTS = ['handParsers', 'pairs'] as const;

/** The baseline a JSON text holds: `handParsers` and `pairs`, lists of ids (at the merge base, a missing list is empty). */
export const parseBaseline = (source: string, where: string, atBase = false): Baseline => parseLists(source, LISTS, where, 'ids', atBase);

// ── discovery ───────────────────────────────────────────────────────────────

const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const NOT_SOURCE = /\.(?:test|spec)\.|\.d\.ts$|(?:^|\/)(?:__tests__|__mocks__|__fixtures__|fixtures?)\/|\.fixture\./;

/** Regex-literal bodies that read a format's syntax. */
const REGEX_SIGNATURES: ReadonlyArray<readonly [Format, RegExp]> = [
  // ATX headings anchored at line start (CommonMark's 0-3 space indent
  // included), code fences, inline link syntax.
  ['markdown', /\^(?:\\s\*|\(\?:\\s\*\)\?| \{0,3\})?#|```|`\{3|~~~|\\\]\\\(/],
  // A frontmatter delimiter.
  ['yaml', /\^---|---\\r|---\\n|---\$/],
  // A tag, closing tag, comment or `<script>` block; an opening tag by name
  // (`<div[^>]*>`) too, but not a named group or its backreference
  // (`(?<name>`, `\k<name>`).
  ['html', /<script|<\\\/|<\/[a-z]|<\[\^>|<!--|<\[a-z|<\[A-Za-z|(?<!\(\?|\\k)<[a-z]/i],
  // Import/export/require statements in source text.
  ['ts', /\bimport\\s|\\bimport\\b|\bexport\\s|\brequire\\\(|from\\s\*\[/],
];

/** String literals that delimit a format by themselves. */
const STRING_SIGNATURES: ReadonlyMap<string, Format> = new Map([
  ['---', 'yaml'],
  ['```', 'markdown'],
  ['~~~', 'markdown'],
  ['<script', 'html'],
]);

const CSV_TOKEN = /\bcsv\b/i;
const SHELL_TOKEN = /\b(?:shell|bash|argv|tokeni[sz]e)\b/i;

export interface Scan {
  readonly formats: Set<Format>;
  readonly exported: string[];
  readonly createsHash: boolean;
  readonly schemaMarked: boolean;
}

/** What one module's source shows: the formats it reads by hand, its exported functions, a versioned hash. */
export const scanSource = (ts: Ts, file: string, source: string): Scan => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const formats = new Set<Format>();
  const exported: string[] = [];
  const quoteChars = new Set<string>();
  let createsHash = false;
  let schemaMarked = false;
  /** Functions declared in the module, exported or not, by local name. */
  const functions = new Set<string>();
  /** `export { local as name }` entries, as [local, name]. */
  const listed: Array<readonly [string, string]> = [];
  const isExported = (node: TS.Node): boolean => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const visit = (node: TS.Node): void => {
    if (ts.isRegularExpressionLiteral(node)) {
      const body = node.text.slice(1, node.text.lastIndexOf('/'));
      for (const [format, signature] of REGEX_SIGNATURES) if (signature.test(body)) formats.add(format);
      // A tokenizer written as ONE regex, naming both quotes and the backslash
      // it escapes (`\\` in its source), tracks them as a hand-written one
      // does. Quotes spread across unrelated regexes are no tokenizer.
      const named = new Set(Array.from(body.matchAll(/['"]|\\(?=\\)/g), ([quote]) => quote));
      if (named.size === 3) for (const quote of named) quoteChars.add(quote);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const format = STRING_SIGNATURES.get(node.text);
      if (format !== undefined) formats.add(format);
      if (node.text === "'" || node.text === '"' || node.text === '\\') quoteChars.add(node.text);
      if (node.text === 'schema' && ts.isCallExpression(node.parent)) schemaMarked = true;
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'split' && first !== undefined && ts.isStringLiteral(first) && first.text === ',' && CSV_TOKEN.test(source)) formats.add('csv');
      if (ts.isIdentifier(callee) && callee.text === 'createHash') createsHash = true;
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      functions.add(node.name.text);
      if (isExported(node)) exported.push(node.name.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier === undefined && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
      // `export { writeEntry, readEntry as read }`: read once every binding is known, below.
      for (const element of node.exportClause.elements) listed.push([(element.propertyName ?? element.name).text, element.name.text]);
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const init = declaration.initializer;
        const isFunction = init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        if (isFunction) functions.add(declaration.name.text);
        if (!isExported(node)) continue;
        if (isFunction) exported.push(declaration.name.text);
        if (/SCHEMA/.test(declaration.name.text) && init !== undefined && ts.isNumericLiteral(init)) schemaMarked = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  // An export list names functions as exports do, under their exported
  // names; a listed constant or class is not a function.
  for (const [local, name] of listed) if (functions.has(local)) exported.push(name);
  // A tokenizer that tracks both quote kinds and backslashes, in a module
  // about shell commands, is a shell parser.
  if (quoteChars.size === 3 && SHELL_TOKEN.test(source)) formats.add('shell');
  return { formats, exported, createsHash, schemaMarked };
};

const PRODUCER = /^(?:build|write|render|format|serialize|encode|stringify|emit)([A-Z]\w*)$/;
const CONSUMER = /^(?:parse|read|decode|load)([A-Z]\w*)$/;

/** Same-module producer/consumer pairs among exported names. */
export const pairsIn = (file: string, exported: readonly string[]): string[] => {
  const consumers = new Map<string, string[]>();
  for (const name of exported) {
    const stem = CONSUMER.exec(name)?.[1];
    if (stem !== undefined) consumers.set(stem, [...(consumers.get(stem) ?? []), name]);
  }
  const out: string[] = [];
  for (const name of exported) {
    const stem = PRODUCER.exec(name)?.[1];
    if (stem === undefined) continue;
    for (const consumer of consumers.get(stem) ?? []) out.push(`${file}#${name}->${consumer}`);
  }
  return out;
};

export type Discovery = {
  /** `path#format` for every hand parser found. */
  readonly handParsers: string[];
  /** Pair ids: `path#producer->consumer` and `path#digest`. */
  readonly pairs: string[];
};

/** Hand parsers and producer/consumer pairs among `files` (tracked, root-relative), in the `formats` given. */
export const discover = (ts: Ts, root: string, files: readonly string[], formats: ReadonlySet<Format>): Discovery => {
  const handParsers: string[] = [];
  const pairs: string[] = [];
  for (const file of files) {
    if (!SOURCE.test(file) || NOT_SOURCE.test(file)) continue;
    const scan = scanSource(ts, file, readFileSync(join(root, file), 'utf8'));
    for (const format of [...scan.formats].sort()) if (formats.has(format)) handParsers.push(`${file}#${format}`);
    pairs.push(...pairsIn(file, scan.exported));
    if (scan.createsHash && scan.schemaMarked) pairs.push(`${file}#digest`);
  }
  return { handParsers: handParsers.sort(), pairs: pairs.sort() };
};

// ── accounting ──────────────────────────────────────────────────────────────

/** Discovered ids the registered and exempt entries cover. */
export const covered = (config: Pick<Config, 'handParsers' | 'pairs' | 'exempt'>): Set<string> =>
  new Set([...config.handParsers.flatMap((e) => e.formats.map((f) => `${e.source}#${f}`)), ...config.pairs.map((p) => p.id), ...config.exempt.map((e) => e.id)]);

/** What the baseline must be: every discovered id nothing covers. */
export const expectedBaseline = (found: Discovery, cover: ReadonlySet<string>): Baseline => ({
  handParsers: found.handParsers.filter((id) => !cover.has(id)),
  pairs: found.pairs.filter((id) => !cover.has(id)),
});

/** Findings about the registered suites: each exists where a runner collects it and holds what its kind needs. */
export const checkWiring = (root: string, config: Config): string[] => {
  const out: string[] = [];
  const surfaces = config.surfaces ?? [];
  const onSurface = (suite: string): boolean => config.surfaces === undefined || surfaces.some((g) => matchesGlob(suite, g));
  const common = (what: string, source: string, suite: string): string | undefined => {
    if (!isFile(root, source)) out.push(`${what}: ${source} does not exist`);
    if (!isCollected(config.collected, suite)) out.push(`${what}: no runner collects ${suite}`);
    const body = readText(root, suite);
    if (body === undefined) {
      out.push(`${what}: the suite ${suite} does not exist`);
      return undefined;
    }
    if (!importsModule(suite, body, source)) out.push(`${what}: ${suite} does not import ${source}`);
    return body;
  };
  for (const entry of config.handParsers) {
    const what = `hand parser ${entry.source}`;
    if (!onSurface(entry.suite)) out.push(`${what}: ${entry.suite} is not on a property-suite surface (${surfaces.join(', ')})`);
    const body = common(what, entry.source, entry.suite);
    if (body === undefined) continue;
    if (!importsPackage(body, config.library)) out.push(`${what}: ${entry.suite} does not import ${config.library}`);
    for (const format of entry.formats) {
      const oracle = config.oracles[format] ?? '';
      if (!namesModule(body, oracle)) out.push(`${what}: ${entry.suite} does not import ${oracle}, the ${format} reference`);
    }
    if (!body.includes(config.markers.seed)) out.push(`${what}: ${entry.suite} runs no fixed seed (${config.markers.seed})`);
    if (entry.lfOnly === undefined && !body.includes(config.markers.lineEndings)) out.push(`${what}: ${entry.suite} runs LF only; run CRLF too (${config.markers.lineEndings}) or give lfOnly a reason`);
  }
  for (const pair of config.pairs) {
    const what = `pair ${pair.id}`;
    const source = pair.id.slice(0, pair.id.indexOf('#'));
    if (pair.kind === 'round-trip' && !onSurface(pair.suite)) out.push(`${what}: ${pair.suite} is not on a property-suite surface (${surfaces.join(', ')})`);
    const body = common(what, source, pair.suite);
    if (body === undefined) continue;
    if (pair.kind === 'golden') {
      if (!body.includes(config.markers.golden)) out.push(`${what}: ${pair.suite} pins no golden (${config.markers.golden})`);
      continue;
    }
    if (!importsPackage(body, config.library)) out.push(`${what}: ${pair.suite} does not import ${config.library}`);
    if (!body.includes(config.markers.seed)) out.push(`${what}: ${pair.suite} runs no fixed seed (${config.markers.seed})`);
  }
  return out;
};

/** Every finding: wiring, examples, accounting against the baseline, and growth when `grown` is given. */
export const findings = (root: string, config: Config, found: Discovery, baseline: Baseline, grown: readonly string[]): string[] => {
  const cover = covered(config);
  const { unaccounted, stale } = audit(expectedBaseline(found, cover), baseline);
  const discovered = new Set([...found.handParsers, ...found.pairs]);
  return [
    ...checkWiring(root, config),
    ...(config.examples === undefined ? [] : checkExamples(root, config.examples, config.collected)),
    ...[...cover].filter((id) => !discovered.has(id)).map((id) => `${id}: registered or exempt, but discovery does not find it; drop the entry, or fix what it names`),
    ...unaccounted.map((id) => `${id}: discovered and unaccounted; register a suite for it, or exempt it with a reason`),
    ...stale.map((id) => `${id}: in ${config.baseline}, but registered, exempt or gone; remove it from the baseline`),
    ...grown.map((id) => `${id}: added to ${config.baseline} since the merge base; the baseline only shrinks, so register a suite instead`),
  ];
};

export const formatFindings = (list: readonly string[], found: Discovery, baseline: Baseline, notChecked: readonly string[], compared: boolean): { ok: boolean; out: string[]; err: string[] } =>
  formatOutcome(
    'pariksha codec-registry:',
    list,
    `${found.handParsers.length} hand parser(s) and ${found.pairs.length} pair(s) discovered, each registered, exempt or among the ${(baseline['handParsers']?.length ?? 0) + (baseline['pairs']?.length ?? 0)} baselined${compared ? '; the baseline does not grow' : ''}`,
    'Register a suite for a discovered parser or pair, or exempt it with a reason; the baseline only shrinks.',
    notChecked,
  );
