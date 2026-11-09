// coverage-exemptions: each vitest config excludes from coverage what the product
// exempts (tests, mocks, declarations), and no production build config includes
// those files back.
//
// An exemption list that drifts lets test files count as covered source, and a
// build config that includes `__mocks__` ships them. Both are configuration a
// reviewer reads past, so the lists are named once, in the product's config,
// and every config is held to them.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Ts } from './typescript.ts';

export interface Config {
  /** Vitest configs, root-relative, and the patterns each one's `coverage.exclude` must hold. */
  readonly vitest: { readonly configs: readonly string[]; readonly requiredExcludes: readonly string[] };
  /** Production tsconfig files, root-relative, and the substrings no `include` entry may hold. */
  readonly build: { readonly configs: readonly string[]; readonly forbiddenIncludes: readonly string[] };
  /** A module Node imports before a vitest config (`tsx`), resolved from the root. */
  readonly loader: string | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '');

const section = (raw: Record<string, unknown>, key: string, list: string): { configs: string[]; rules: string[] } => {
  const v = raw[key] ?? { configs: [], [list]: [] };
  if (!isRecord(v)) throw new Error(`"${key}" must be an object`);
  const extra = Object.keys(v).find((k) => k !== 'configs' && k !== list);
  if (extra !== undefined) throw new Error(`${key}: unknown key "${extra}"`);
  const configs = v['configs'] ?? [];
  const rules = v[list] ?? [];
  if (!isStrings(configs)) throw new Error(`${key}.configs must be a list of non-empty paths`);
  if (!isStrings(rules)) throw new Error(`${key}.${list} must be a list of non-empty strings`);
  const bad = configs.find((c) => !isRepoPath(c));
  if (bad !== undefined) throw new Error(`${key}.configs: "${bad}" is not a normalized root-relative path`);
  // A config with nothing to hold it to would pass whatever it says.
  if (configs.length > 0 && rules.length === 0) throw new Error(`${key}.${list} is empty, so its configs would always pass`);
  return { configs, rules };
};

/** The config a JSON text names; throws naming the first bad key. */
export const parseConfig = (text: string): Config => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('the config must be a JSON object');
  const unknown = Object.keys(raw).find((k) => !['vitest', 'build', 'loader'].includes(k));
  if (unknown !== undefined) throw new Error(`unknown key "${unknown}"`);
  const vitest = section(raw, 'vitest', 'requiredExcludes');
  const build = section(raw, 'build', 'forbiddenIncludes');
  if (vitest.configs.length + build.configs.length === 0) throw new Error('no vitest or build config is named, so nothing would be checked');
  const loader = raw['loader'];
  if (loader !== undefined && (typeof loader !== 'string' || loader === '')) throw new Error('"loader" must be a module name');
  return {
    vitest: { configs: vitest.configs, requiredExcludes: vitest.rules },
    build: { configs: build.configs, forbiddenIncludes: build.rules },
    loader,
  };
};

/** A normalized relative POSIX path that stays inside the root. */
const isRepoPath = (p: string): boolean => !isAbsolute(p) && posix.normalize(p) === p && p !== '.' && p !== '..' && !p.startsWith('../') && !p.endsWith('/');

/** A `--package` folder, checked: a value that matches no config would check nothing and pass. */
export const checkPackage = (root: string, dir: string): string | undefined => {
  if (!isRepoPath(dir)) return `"${dir}" is not a normalized root-relative folder`;
  const full = join(root, dir);
  if (statSync(full, { throwIfNoEntry: false })?.isDirectory() !== true) return `"${dir}" is not a folder under the root`;
  // On a case-insensitive disk `Apps/Server` is a folder too, but owns no config spelled `apps/server/…`.
  if (realpathSync.native(full) !== join(realpathSync.native(root), dir)) return `"${dir}" is not spelled as the folder on disk is`;
  return undefined;
};

/** The configs that belong to `dir`, or all of them. */
export const ownedBy = (configs: readonly string[], dir: string | undefined): string[] => (dir === undefined ? [...configs] : configs.filter((c) => c.startsWith(`${dir}/`)));

/** A vitest config's `coverage.exclude`, as the config file exports it. */
export const readExclude = async (file: string): Promise<unknown> => {
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  const raw = mod.default;
  // A config may export a factory, sync or async (`defineConfig(async () => …)`).
  const config = (await (typeof raw === 'function' ? (raw as () => unknown)() : raw)) as { test?: { coverage?: { exclude?: unknown } }; coverage?: { exclude?: unknown } } | undefined;
  return config?.test?.coverage?.exclude || config?.coverage?.exclude;
};

/** The child script beside a module: the `.ts` source under test, the `.js` build when installed. */
export const loaderScriptBeside = (moduleUrl: string): string => fileURLToPath(new URL(`./load-vitest-config${moduleUrl.endsWith('.ts') ? '.ts' : '.js'}`, moduleUrl));

const LOADER_SCRIPT = loaderScriptBeside(import.meta.url);

export type Load = { ok: true; exclude: unknown } | { ok: false; error: string };

/** The `--import` argument for a loader: a relative path is the root's file, a bare name resolves from the config's folder. */
const importArg = (root: string, loader: string): string => (loader.startsWith('.') ? pathToFileURL(resolve(root, loader)).href : loader);

/** Why a child failed: the error's own line (`Error: …`), the value thrown when it is not an Error, else its first line. */
export const failureOf = (stderr: string, status: number | null): string => {
  const lines = stderr.split('\n');
  const named = lines.find((l) => /^\w*Error\b/.test(l));
  if (named !== undefined) return named.trim();
  // `throw 'text'` prints Node's own frame, a caret line, then the value.
  const caret = lines.findIndex((l) => /^\s*\^+\s*$/.test(l));
  const thrown = caret >= 0 ? lines.slice(caret + 1).find((l) => /\S/.test(l)) : undefined;
  return (thrown ?? lines.find((l) => /\S/.test(l)) ?? `exit ${String(status)}`).trim();
};

/**
 * One vitest config's exclusions, loaded in its own Node process under the
 * product's loader, in the config's own folder (as the product's tooling runs
 * it, so its tsconfig `paths` and relative reads hold). One process per config:
 * two configs loaded side by side in one process can race on a shared module.
 * The answer comes back on fd 3, which nothing a config prints can reach.
 */
export const loadVitestExclude = (root: string, config: string, loader: string | undefined, timeout = 120_000): Load => {
  const file = join(root, config);
  const args = [...(loader === undefined ? [] : ['--import', importArg(root, loader)]), LOADER_SCRIPT, file];
  const r = spawnSync(process.execPath, args, { cwd: dirname(file), encoding: 'utf8', timeout, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  const answer = r.status === 0 && r.error === undefined ? (r.output[3] ?? '') : '';
  if (answer === '') return { ok: false, error: r.error?.message ?? failureOf(r.stderr, r.status) };
  try {
    return { ok: true, exclude: JSON.parse(answer) as unknown };
  } catch {
    return { ok: false, error: `the config's coverage.exclude is not data: ${answer.slice(0, 80)}` };
  }
};

/** Whether the loader itself loads, from the root; a missing one would otherwise be blamed on every config. */
export const loaderFailure = (root: string, loader: string | undefined): string | undefined => {
  if (loader === undefined) return undefined;
  const r = spawnSync(process.execPath, ['--import', importArg(root, loader), '-e', ''], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  return r.status === 0 && r.error === undefined ? undefined : `loader ${loader} does not load: ${r.error?.message ?? failureOf(r.stderr, r.status)}`;
};

export interface Violation {
  readonly file: string;
  readonly message: string;
}

/** The violations among the vitest configs. */
export const checkVitest = (config: Config, configs: readonly string[], load: (config: string) => Load): Violation[] => {
  const out: Violation[] = [];
  for (const file of configs) {
    const r = load(file);
    if (!r.ok) {
      out.push({ file, message: `cannot load the config: ${r.error}` });
      continue;
    }
    if (!Array.isArray(r.exclude) || r.exclude.length === 0) {
      out.push({ file, message: 'has no coverage.exclude' });
      continue;
    }
    const exclude: unknown[] = r.exclude;
    for (const pattern of config.vitest.requiredExcludes) {
      if (!exclude.includes(pattern)) out.push({ file, message: `coverage.exclude lacks ${pattern}` });
    }
  }
  return out;
};

/** The violations among the build configs; a config that cannot be read throws. */
export const checkBuild = (ts: Ts, config: Config, root: string, configs: readonly string[]): Violation[] => {
  const out: Violation[] = [];
  for (const file of configs) {
    const read = ts.readConfigFile(join(root, file), (p) => readFileSync(p, 'utf8'));
    if (read.error !== undefined) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
    const include: unknown = (read.config as { include?: unknown } | undefined)?.include ?? [];
    if (!Array.isArray(include) || !include.every((e) => typeof e === 'string')) throw new Error(`${file}: "include" is not a list of strings`);
    for (const pattern of config.build.forbiddenIncludes) {
      if (include.some((entry: string) => entry.includes(pattern))) out.push({ file, message: `include brings test files into the build: ${pattern}` });
    }
  }
  return out;
};

/** Every listed config exists as a file; a missing one would otherwise pass unread. */
export const missingConfigs = (root: string, configs: readonly string[]): string[] => configs.filter((c) => statSync(join(root, c), { throwIfNoEntry: false })?.isFile() !== true);

const P = 'pariksha coverage-exemptions:';

export const formatViolations = (violations: readonly Violation[], vitest: number, build: number, dir: string | undefined): { ok: boolean; out: string[]; err: string[] } => {
  const scope = dir === undefined ? '' : ` under ${dir}`;
  if (violations.length === 0) return { ok: true, out: [`${P} ${vitest} vitest and ${build} build config(s)${scope} checked, none drifts`], err: [] };
  return {
    ok: false,
    out: [],
    err: [...violations.map((v) => `${P} ${v.file}: ${v.message}`), `${P} ${violations.length} problem(s). Exempt test files from coverage in every vitest config, and keep them out of every build.`],
  };
};
