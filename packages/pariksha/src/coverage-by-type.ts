// coverage-by-type: a source file in a category needs the tests its category names,
// and a test counts only if it loads its subject at runtime.
//
// A suite named after its subject that never imports it is no test of it: a page
// sat at 0% covered while `Page.test.tsx` tested a helper, and a filename match
// called the page covered. So a candidate suite counts only when it reaches the
// subject through a runtime import, directly or through one module it imports.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type * as TS from 'typescript';

/** What a product configures: every key replaces its default when present. */
export interface Config {
  /** Category name to a regex over the root-relative POSIX path; the first match wins, in order. */
  readonly categories: ReadonlyArray<readonly [string, RegExp]>;
  /** Category name to the test kinds it needs. */
  readonly required: ReadonlyMap<string, readonly string[]>;
  /** Root-relative POSIX paths matching any of these are not judged. */
  readonly exclude: readonly RegExp[];
  /** Test kind to candidate paths: `{dir}` is the source's directory, `{name}` its base name without extension. */
  readonly tests: ReadonlyMap<string, readonly string[]>;
  /** Specifier prefix to a directory under the importing file's workspace (nearest package.json). */
  readonly aliases: ReadonlyMap<string, string>;
  /** Import hops past the test file that still count as testing the subject. */
  readonly maxHops: number;
  /** A line printed under a failing report, pointing at the product's own rules. */
  readonly hint: string | undefined;
}

const KINDS_AT = (dirs: readonly string[], suffixes: readonly string[]): string[] =>
  dirs.flatMap((d) => suffixes.map((s) => `${d}{name}${s}`));

export const DEFAULT_CONFIG: Config = {
  categories: [
    ['service', /\/(services|domain)\/.+\.(ts|tsx)$/],
    ['repository', /\/repositories?\/.+\.(ts|tsx)$/],
    ['component', /\/components?\/.+\.(tsx)$/],
    ['screen', /\/screens?\/.+\.(tsx)$/],
    ['hook', /\/hooks?\/use[A-Z].+\.(ts|tsx)$/],
    ['utility', /\/(utils|helpers|lib)\/.+\.(ts|tsx)$/],
    ['context', /\/context\/.+\.(tsx)$/],
  ],
  required: new Map([
    ['service', ['unit']],
    ['repository', ['unit', 'integration']],
    ['component', ['ui']],
    ['screen', ['ui']],
    ['hook', ['unit']],
    ['utility', ['unit']],
    ['context', ['unit']],
  ]),
  exclude: [
    /\.(test|spec|test-d|spec-d|perf-test)\.(ts|tsx)$/,
    /\.d\.ts$/,
    /\.config\.(ts|js|mts|mjs)$/,
    /index\.(ts|tsx)$/,
    /types?\.(ts|tsx)$/,
    /(^|\/)types\//,
    /__mocks__\//,
    /__tests__\//,
    /\/e2e\//,
    /\/test\//,
    /node_modules/,
  ],
  tests: new Map([
    ['unit', KINDS_AT(['{dir}/', '{dir}/__tests__/', '{dir}/test/', '{dir}/tests/'], ['.test.ts', '.test.tsx'])],
    [
      'integration',
      [
        ...KINDS_AT(['{dir}/'], ['.integration.test.ts', '.integration.test.tsx']),
        ...KINDS_AT(['{dir}/__tests__/integration/', '{dir}/test/integration/', '{dir}/tests/integration/'], ['.test.ts', '.test.tsx']),
      ],
    ],
    ['ui', KINDS_AT(['{dir}/', '{dir}/__tests__/', '{dir}/test/', '{dir}/tests/'], ['.test.tsx'])],
  ]),
  aliases: new Map(),
  maxHops: 1,
  hint: undefined,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

const regex = (source: string, where: string): RegExp => {
  try {
    // The product's own config file, read from its own checkout.
    return new RegExp(source);
  } catch (e) {
    throw new Error(`${where}: ${(e as Error).message}`);
  }
};

const KEYS = new Set(['categories', 'required', 'exclude', 'tests', 'aliases', 'maxHops', 'hint']);

/** The config a JSON text names, over the defaults; throws naming the first bad key. */
export const parseConfig = (text: string): Config => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('the config must be a JSON object');
  const unknown = Object.keys(raw).find((k) => !KEYS.has(k));
  if (unknown !== undefined) throw new Error(`unknown key "${unknown}"`);

  const stringMap = (key: string): Map<string, string> | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (!isRecord(v) || !Object.values(v).every((s) => typeof s === 'string')) throw new Error(`"${key}" must map names to strings`);
    return new Map(Object.entries(v as Record<string, string>));
  };
  const listMap = (key: string): Map<string, string[]> | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (!isRecord(v) || !Object.values(v).every(isStrings)) throw new Error(`"${key}" must map names to lists of strings`);
    return new Map(Object.entries(v as Record<string, string[]>));
  };

  const cats = stringMap('categories');
  const categories = cats ? [...cats].map(([name, src]): [string, RegExp] => [name, regex(src, `categories.${name}`)]) : DEFAULT_CONFIG.categories;
  const required = listMap('required') ?? DEFAULT_CONFIG.required;
  const tests = listMap('tests') ?? DEFAULT_CONFIG.tests;
  const aliases = stringMap('aliases') ?? DEFAULT_CONFIG.aliases;

  let exclude = DEFAULT_CONFIG.exclude;
  if (raw['exclude'] !== undefined) {
    if (!isStrings(raw['exclude'])) throw new Error('"exclude" must be a list of strings');
    exclude = raw['exclude'].map((src, i) => regex(src, `exclude[${i}]`));
  }
  const maxHops = raw['maxHops'] ?? DEFAULT_CONFIG.maxHops;
  if (typeof maxHops !== 'number' || !Number.isInteger(maxHops) || maxHops < 0) throw new Error('"maxHops" must be a whole number, 0 or more');
  const hint = raw['hint'] ?? DEFAULT_CONFIG.hint;
  if (hint !== undefined && typeof hint !== 'string') throw new Error('"hint" must be a string');

  for (const [name] of categories) {
    const kinds = required.get(name);
    if (kinds === undefined) throw new Error(`category "${name}" has no "required" entry`);
    const missing = kinds.find((k) => !tests.has(k));
    if (missing !== undefined) throw new Error(`category "${name}" requires "${missing}", which "tests" does not define`);
  }
  for (const [kind, paths] of tests) {
    const bad = paths.find((p) => !p.includes('{name}'));
    if (bad !== undefined) throw new Error(`tests.${kind}: "${bad}" has no {name}, so it names one file for every source`);
  }
  return { categories, required, exclude, tests, aliases, maxHops, hint };
};

/** The TypeScript compiler API, from the product's own install. */
export type Ts = typeof TS;

/** TypeScript from the product's install; a message naming why when it cannot be used. */
export const loadTypescript = (load: (id: string) => unknown = createRequire(import.meta.url)): Ts | string => {
  let mod: unknown;
  try {
    mod = load('typescript');
  } catch {
    return 'needs the typescript package (>=5.4 <6); install it beside pariksha';
  }
  const ts = mod as Partial<Ts>;
  if (typeof ts.createSourceFile !== 'function') {
    return `needs the TypeScript compiler API, which typescript ${String(ts.version)} does not export; install typescript >=5.4 <6`;
  }
  return ts as Ts;
};

const toPosix = (p: string): string => p.split(sep).join('/');

/** Extensions a specifier may omit, or carry as its ESM-facing `.js` form. */
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];
/** The call forms that load a module at runtime, by callee name. */
const RUNTIME_LOADERS = new Set(['require', 'importActual', 'requireActual']);

/**
 * Whether an import or export clause survives to runtime. `import type` is erased
 * and loads nothing; so is a named clause whose every binding is type-only. A
 * clause-less import runs its module.
 */
const clauseReachesRuntime = (ts: Ts, node: TS.ImportDeclaration | TS.ExportDeclaration): boolean => {
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return false;
    const b = node.exportClause;
    return b && ts.isNamedExports(b) ? b.elements.some((e) => !e.isTypeOnly) : true;
  }
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const b = clause.namedBindings;
  return b && ts.isNamedImports(b) ? b.elements.some((e) => !e.isTypeOnly) : true;
};

/**
 * Every module specifier a file loads at runtime: surviving imports and re-exports,
 * `import()`, `require()`, and `importActual`/`requireActual`. Parsed, not matched:
 * `typeof import('./x')` in a type loads nothing, and only syntax tells it apart.
 * A template with substitutions is not resolved; its target needs evaluating.
 */
export const moduleSpecifiers = (ts: Ts, source: string, fileName = 'file.tsx'): string[] => {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest);
  const found: string[] = [];
  const visit = (node: TS.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (clauseReachesRuntime(ts, node)) found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const specifier = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : undefined;
      if (specifier !== undefined && (isDynamicImport || (name !== undefined && RUNTIME_LOADERS.has(name)))) found.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return found;
};

const stripModuleExtension = (p: string): string => {
  const ext = MODULE_EXTENSIONS.find((e) => p.endsWith(e));
  return ext ? p.slice(0, -ext.length) : p;
};

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

/** The workspace a file belongs to: its nearest ancestor holding a package.json. */
const workspaceRootOf = (file: string): string | undefined => {
  for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
};

/** The walk from a test to its subject, with each file's specifiers read once. */
export class ImportWalk {
  readonly #specifiers = new Map<string, string[]>();
  readonly #ts: Ts;
  readonly #config: Config;

  constructor(ts: Ts, config: Config) {
    this.#ts = ts;
    this.#config = config;
  }

  #specifiersOf(file: string): string[] {
    let found = this.#specifiers.get(file);
    if (found === undefined) {
      found = moduleSpecifiers(this.#ts, readFileSync(file, 'utf8'), file);
      this.#specifiers.set(file, found);
    }
    return found;
  }

  /** An absolute extensionless path, or undefined for what cannot be followed (a package, an unknown alias). */
  #resolveSpecifier(specifier: string, fromFile: string): string | undefined {
    if (specifier.startsWith('.')) return stripModuleExtension(resolve(dirname(fromFile), specifier));
    for (const [prefix, dir] of this.#config.aliases) {
      if (!specifier.startsWith(prefix)) continue;
      const root = workspaceRootOf(fromFile);
      return root === undefined ? undefined : stripModuleExtension(resolve(root, dir, specifier.slice(prefix.length)));
    }
    return undefined;
  }

  /** Whether a test reaches its subject, directly or through up to maxHops modules it imports. */
  reaches(testFile: string, sourceFile: string): boolean {
    const target = stripModuleExtension(resolve(sourceFile));
    const start = resolve(testFile);
    const visited = new Set([start]);
    let frontier = [start];
    for (let hop = 0; hop <= this.#config.maxHops; hop++) {
      const next: string[] = [];
      for (const file of frontier) {
        for (const specifier of this.#specifiersOf(file)) {
          const resolved = this.#resolveSpecifier(specifier, file);
          if (resolved === undefined) continue;
          if (resolved === target) return true;
          const onDisk = resolveToFile(resolved);
          if (onDisk === undefined) continue;
          if (stripModuleExtension(onDisk) === target) return true;
          if (!visited.has(onDisk)) {
            visited.add(onDisk);
            next.push(onDisk);
          }
        }
      }
      frontier = next;
    }
    return false;
  }
}

/** The file an extensionless path names: itself with an extension, or its directory's index. */
const resolveToFile = (extensionless: string): string | undefined =>
  MODULE_EXTENSIONS.map((e) => `${extensionless}${e}`).find(isFile) ?? MODULE_EXTENSIONS.map((e) => join(extensionless, `index${e}`)).find(isFile);

export interface Gap {
  readonly file: string;
  readonly category: string;
  readonly missing: readonly string[];
}

/** The category of a root-relative path, or undefined when none matches. */
export const categoryOf = (config: Config, path: string): string | undefined => config.categories.find(([, re]) => re.test(toPosix(path)))?.[0];

export const isExcluded = (config: Config, path: string): boolean => config.exclude.some((re) => re.test(toPosix(path)));

/** The test kinds found for one source file: a candidate that exists and reaches it. */
export const foundKinds = (config: Config, walk: ImportWalk, root: string, path: string): Set<string> => {
  const full = resolve(root, path);
  const dir = dirname(full);
  const name = full.slice(dir.length + 1).replace(/\.(ts|tsx)$/, '');
  const found = new Set<string>();
  for (const [kind, patterns] of config.tests) {
    const hit = patterns.some((p) => {
      const candidate = p.replaceAll('{dir}', dir).replaceAll('{name}', name);
      return isFile(candidate) && walk.reaches(candidate, full);
    });
    if (hit) found.add(kind);
  }
  return found;
};

/** The gaps among root-relative `paths`: each `.ts`/`.tsx` file, not excluded, in a category, missing a kind. */
export const findGaps = (ts: Ts, config: Config, root: string, paths: readonly string[]): Gap[] => {
  const walk = new ImportWalk(ts, config);
  const gaps: Gap[] = [];
  for (const path of paths) {
    const rel = toPosix(relative(root, resolve(root, path)));
    if (!/\.(ts|tsx)$/.test(rel) || isExcluded(config, rel)) continue;
    const category = categoryOf(config, rel);
    if (category === undefined) continue;
    const found = foundKinds(config, walk, root, rel);
    const missing = (config.required.get(category) ?? []).filter((k) => !found.has(k));
    if (missing.length > 0) gaps.push({ file: rel, category, missing });
  }
  return gaps;
};

const P = 'pariksha coverage-by-type:';

export const formatGaps = (config: Config, gaps: readonly Gap[], checked: number): { ok: boolean; out: string[]; err: string[] } => {
  if (gaps.length === 0) return { ok: true, out: [`${P} ${checked} file(s) checked, each has the tests its category needs`], err: [] };
  const err: string[] = [];
  const byCategory = new Map<string, Gap[]>();
  for (const g of gaps) byCategory.set(g.category, [...(byCategory.get(g.category) ?? []), g]);
  for (const [category, list] of byCategory) {
    err.push(`${P} ${category} (needs: ${(config.required.get(category) ?? []).join(', ')} tests)`);
    for (const g of list) err.push(`  ${g.file}: missing ${g.missing.join(', ')}`);
  }
  err.push('', `${P} ${gaps.length} file(s) missing required tests. A suite counts only when it imports its subject at runtime.`);
  if (config.hint !== undefined) err.push(config.hint);
  return { ok: false, out: [], err };
};
