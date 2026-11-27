// Which lint targets a change to ESLint's configuration reaches.
//
// A delta lint checks the files a change touched. A change that touches only
// configuration (a rule switched on, a suppression dropped, a shared rule
// tightened, a tsconfig a typed rule reads) touches no source file, so the
// delta lint checks nothing, and every file the new configuration fails
// merges green. This names the targets that need a whole sweep instead.
//
// A target is the repository root (`.`) or a workspace (a folder under one
// of `workspaces`) with its own `eslint.config.*` and the lint `script`. Its
// inputs are what its ESLint run reads:
//
//   - its `eslint.config.*`, and every repository file that config reaches
//     through a relative import, a require or `path.resolve(__dirname, …)`,
//     transitively;
//   - its `eslint-suppressions.json`, which ESLint reads from the folder it
//     runs in;
//   - for a workspace, every `tsconfig*.json` at its top level.
//
// Rules from installed packages are outside the repository and its graph, so
// a change that moves one of `lintPackages` in the pinning files sweeps every
// target.
//
// The graph is read from the configs themselves, never kept as a list: a list
// is what drifts. Paths that no longer exist still count. The fixed names are
// inputs whether or not they exist, a specifier that resolves to nothing adds
// every path it could name, and a deleted workspace tsconfig still reaches its
// workspace. A deletion therefore still sweeps the target it broke.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { must, type Git } from './git.ts';

export interface Config {
  /** Folders whose subfolders are workspaces. */
  readonly workspaces: readonly string[];
  /** The package script a workspace's whole lint runs; a workspace without it is not a target. */
  readonly script: string;
  /** Packages a lint loads rules from; a change naming one in `pinFiles` sweeps every target. */
  readonly lintPackages: readonly string[];
  /** The files that pin those packages, at the root. */
  readonly pinFiles: readonly string[];
}

export const DEFAULT_CONFIG: Config = { workspaces: ['apps', 'packages'], script: 'lint:ci', lintPackages: [], pinFiles: ['package.json', 'pnpm-lock.yaml'] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '');

/** The settings `text` holds; an absent field takes its default. */
export const parseConfig = (text: string): Config => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error('the config must be a JSON object');
  const unknown = Object.keys(raw).find((k) => !Object.hasOwn(DEFAULT_CONFIG, k));
  if (unknown !== undefined) throw new Error(`unknown key "${unknown}"`);
  const list = (key: 'workspaces' | 'lintPackages' | 'pinFiles'): readonly string[] => {
    if (!(key in raw)) return DEFAULT_CONFIG[key];
    if (!isStrings(raw[key])) throw new Error(`"${key}" must be a list of non-empty strings`);
    return raw[key];
  };
  const script = 'script' in raw ? raw['script'] : DEFAULT_CONFIG.script;
  if (typeof script !== 'string' || script === '') throw new Error('"script" must be a non-empty string');
  return { workspaces: list('workspaces'), script, lintPackages: list('lintPackages'), pinFiles: list('pinFiles') };
};

const CONFIG_NAMES = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map((ext) => `eslint.config.${ext}`);
const SCRIPT_FILE = /\.[cm]?[jt]s$/;
const RESOLVE_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.ts', '/index.js', '/index.mjs'];
/** A quoted relative specifier: `'./x'`, `"../../y.mjs"`. */
const RELATIVE_SPECIFIER = /['"](\.\.?\/[^'"\n]+)['"]/g;
/** `path.resolve(__dirname, 'apps/server/x.js')`: relative without a `./`. */
const DIRNAME_SPECIFIER = /(?:resolve|join)\(\s*__dirname\s*,\s*['"]([^'"\n]+)['"]/g;
/** A workspace's top-level tsconfig, which typed rules read. */
const TSCONFIG = /^tsconfig[^/]*\.json$/;

const isDir = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/** Lint targets: `.`, and each workspace with a config and the lint script. */
export const lintTargets = (root: string, config: Config): string[] => {
  const workspaces = config.workspaces.filter((group) => isDir(join(root, group))).flatMap((group) => readdirSync(join(root, group)).map((name) => `${group}/${name}`));
  const linted = workspaces.filter((dir) => {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) return false;
    const scripts = (JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> }).scripts;
    return scripts?.[config.script] !== undefined && CONFIG_NAMES.some((name) => existsSync(join(root, dir, name)));
  });
  return ['.', ...linted.sort()];
};

/**
 * The repository file a specifier names, if one exists, and every path it
 * could name: when the file is gone, a config still importing it is broken,
 * and the deletion must still reach it.
 */
const resolveSpecifier = (root: string, base: string, spec: string): { found: string | undefined; candidates: string[] } => {
  const target = resolve(base, spec);
  const candidates = RESOLVE_SUFFIXES.map((suffix) => relative(root, target + suffix)).filter((rel) => !rel.startsWith('..') && !rel.split('/').includes('node_modules'));
  const found = candidates.find((rel) => {
    const path = join(root, rel);
    return existsSync(path) && statSync(path).isFile();
  });
  return { found, candidates };
};

/** Repository files a target's ESLint run reads, root-relative and `/`-separated. */
export const configInputs = (root: string, target: string): Set<string> => {
  const prefix = target === '.' ? '' : `${target}/`;
  const inputs = new Set<string>([...CONFIG_NAMES.map((name) => prefix + name), `${prefix}eslint-suppressions.json`]);
  if (target !== '.') for (const name of readdirSync(join(root, target))) if (TSCONFIG.test(name)) inputs.add(prefix + name);
  // A Set's loop visits what is added while it runs, and adding a file it
  // holds is a no-op, so each file reached is read once, cycles included.
  const reached = new Set(CONFIG_NAMES.map((name) => prefix + name).filter((file) => existsSync(join(root, file))));
  for (const file of reached) {
    inputs.add(file);
    if (!SCRIPT_FILE.test(file)) continue;
    const text = readFileSync(join(root, file), 'utf8');
    const here = dirname(join(root, file));
    const specs = [...text.matchAll(RELATIVE_SPECIFIER), ...text.matchAll(DIRNAME_SPECIFIER)].map((m) => m[1] as string);
    for (const spec of specs) {
      const { found, candidates } = resolveSpecifier(root, here, spec);
      if (found) reached.add(found);
      else for (const candidate of candidates) inputs.add(candidate);
    }
  }
  return inputs;
};

/** The targets whose inputs any changed path touches, in target order. */
export const affectedTargets = (root: string, config: Config, changed: readonly string[]): string[] => {
  const touched = new Set(changed.map((file) => file.replace(/^\.\//, '')));
  return lintTargets(root, config).filter(
    (target) =>
      [...configInputs(root, target)].some((file) => touched.has(file)) ||
      // A deleted tsconfig is no longer on disk for configInputs to list.
      (target !== '.' && [...touched].some((file) => file.startsWith(`${target}/`) && TSCONFIG.test(file.slice(target.length + 1)))),
  );
};

/** Whether a unified diff adds or removes a line naming one of `packages`. */
export const lintPackagesMoved = (diff: string, packages: readonly string[]): boolean =>
  diff.split('\n').some((line) => /^[+-](?!\+\+ |-- )/.test(line) && packages.some((name) => line.includes(name)));

/** The targets `range` reaches: every target when it moves a lint package, else those its changed paths touch. */
export const rangeTargets = (git: Git, root: string, config: Config, range: string): string[] => {
  // With no lint package named, the pinning files are not read at all.
  if (config.lintPackages.length > 0 && lintPackagesMoved(must(git, ['diff', '--no-color', '--no-ext-diff', range, '--', ...config.pinFiles]), config.lintPackages)) return lintTargets(root, config);
  const changed = must(git, ['diff', '--name-only', '-z', '--no-renames', range, '--']).split('\0').filter(Boolean);
  return affectedTargets(root, config, changed);
};
