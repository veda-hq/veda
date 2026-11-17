/**
 * The repository's facts, read from `agnipariksha.json` at its root: which
 * lanes there are, which files each mutates, the variables its Stryker config
 * reads, and what goes into a reuse key. Nothing about a repository is
 * compiled in.
 */
import { join } from 'node:path';

import type { Lane } from './lanes.ts';
import type { KeyPolicy } from './reuse-key.ts';

export const CONFIG_FILE = 'agnipariksha.json';
export const DEFAULT_UPSTREAM = 'origin/main';
/** In a lane's `env` or `fallbackEnv` value, replaced by the owning suites, comma-joined. */
export const SUITES_PLACEHOLDER = '{suites}';

export interface LaneConfig {
  name: string;
  /** Repo-relative directory Stryker runs in; '' is the repo root. */
  cwd: string;
  /** The lane's Stryker config, relative to `cwd`. */
  config: string;
  /** Whether results may be reused (`--incremental`). */
  reuse: boolean;
  /** Regular expressions over repo-relative paths: a file the lane mutates matches one. */
  include: string[];
  /** Regular expressions: a file matching one is not this lane's. */
  exclude: string[];
  /** A file the lane mutates ends with one of these; empty means any. */
  extensions: string[];
  env: Record<string, string>;
  /** Variables for one rerun when the dry run fails on a fallback trigger; absent means no rerun. */
  fallbackEnv?: Record<string, string>;
}

export interface Config {
  /** The ref a push is compared with, through its merge-base. */
  upstream: string;
  /** Regular expressions: a file matching one is in no lane (tests, declarations). */
  ignore: string[];
  /**
   * Variables removed from the environment every Stryker run inherits, before
   * a lane's `env` (which may set one again) and the run's temp variables.
   */
  unsetEnv: string[];
  lanes: LaneConfig[];
  reuseKey: KeyPolicy;
}

class ConfigError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fields(value: unknown, where: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new ConfigError(`${where}.${key} is missing`);
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) throw new ConfigError(`${where}.${key} is not a known field`);
  }
  return value;
}

function text(value: unknown, where: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && value === '')) throw new ConfigError(`${where} must be a ${empty ? '' : 'non-empty '}string`);
  return value;
}

function texts(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new ConfigError(`${where} must be an array of strings`);
  return value.map((item, i) => text(item, `${where}[${i}]`));
}

function patterns(value: unknown, where: string): string[] {
  const sources = texts(value, where);
  sources.forEach((source, i) => {
    try {
      new RegExp(source);
    } catch (error: unknown) {
      throw new ConfigError(`${where}[${i}] is not a regular expression: ${(error as Error).message}`);
    }
  });
  return sources;
}

function envNames(value: unknown, where: string): string[] {
  const names = texts(value, where);
  names.forEach((name, i) => {
    if (name.includes('=')) throw new ConfigError(`${where}[${i}] is not a variable name: it holds "="`);
  });
  return names;
}

function variables(value: unknown, where: string): Record<string, string> {
  if (!isRecord(value)) throw new ConfigError(`${where} must be an object of strings`);
  for (const [key, item] of Object.entries(value)) text(item, `${where}.${key}`, true);
  return value as Record<string, string>;
}

function laneConfig(value: unknown, where: string): LaneConfig {
  const raw = fields(value, where, ['name', 'cwd', 'config', 'reuse', 'include'], ['exclude', 'extensions', 'env', 'fallbackEnv']);
  if (typeof raw.reuse !== 'boolean') throw new ConfigError(`${where}.reuse must be true or false`);
  const lane: LaneConfig = {
    name: text(raw.name, `${where}.name`),
    cwd: text(raw.cwd, `${where}.cwd`, true),
    config: text(raw.config, `${where}.config`),
    reuse: raw.reuse,
    include: patterns(raw.include, `${where}.include`),
    exclude: raw.exclude === undefined ? [] : patterns(raw.exclude, `${where}.exclude`),
    extensions: raw.extensions === undefined ? [] : texts(raw.extensions, `${where}.extensions`),
    env: raw.env === undefined ? {} : variables(raw.env, `${where}.env`),
  };
  // `--lane` splits on commas and takes nothing that looks like a flag, so every lane stays nameable.
  if (lane.name.includes(',') || lane.name.startsWith('--')) throw new ConfigError(`${where}.name must not contain a comma or start with --`);
  if (lane.include.length === 0) throw new ConfigError(`${where}.include must name at least one pattern`);
  if (raw.fallbackEnv !== undefined) lane.fallbackEnv = variables(raw.fallbackEnv, `${where}.fallbackEnv`);
  return lane;
}

function keyPolicy(value: unknown, where: string): KeyPolicy {
  const raw = fields(value, where, ['always', 'pluginDir', 'helperPackages', 'sharedWorkspace']);
  return {
    always: texts(raw.always, `${where}.always`),
    pluginDir: text(raw.pluginDir, `${where}.pluginDir`),
    helperPackages: texts(raw.helperPackages, `${where}.helperPackages`),
    sharedWorkspace: text(raw.sharedWorkspace, `${where}.sharedWorkspace`),
  };
}

/** The config in `source`, or why it is refused. */
export function parseConfig(source: string): Config | string {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error: unknown) {
    // fail-open: the reason goes back to the caller, which refuses with exit 2.
    return `${CONFIG_FILE} is not JSON: ${(error as Error).message}`;
  }
  try {
    const raw = fields(json, CONFIG_FILE, ['lanes', 'reuseKey'], ['upstream', 'ignore', 'unsetEnv']);
    if (!Array.isArray(raw.lanes) || raw.lanes.length === 0) throw new ConfigError(`${CONFIG_FILE}.lanes must be a non-empty array`);
    const lanes = raw.lanes.map((lane, i) => laneConfig(lane, `${CONFIG_FILE}.lanes[${i}]`));
    const names = new Set<string>();
    for (const lane of lanes) {
      if (names.has(lane.name)) throw new ConfigError(`${CONFIG_FILE}.lanes names "${lane.name}" twice`);
      names.add(lane.name);
    }
    return {
      upstream: raw.upstream === undefined ? DEFAULT_UPSTREAM : text(raw.upstream, `${CONFIG_FILE}.upstream`),
      ignore: raw.ignore === undefined ? [] : patterns(raw.ignore, `${CONFIG_FILE}.ignore`),
      unsetEnv: raw.unsetEnv === undefined ? [] : envNames(raw.unsetEnv, `${CONFIG_FILE}.unsetEnv`),
      lanes,
      reuseKey: keyPolicy(raw.reuseKey, `${CONFIG_FILE}.reuseKey`),
    };
  } catch (error: unknown) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
}

/** The config at the root of `root`, or why it is refused (a missing file included). */
export function loadConfig(root: string, readFile: (path: string) => string | undefined): Config | string {
  const path = join(root, CONFIG_FILE);
  const source = readFile(path);
  if (source === undefined) return `no ${CONFIG_FILE} at ${root}: it names the lanes to judge (see the package README)`;
  return parseConfig(source);
}

const fill = (env: Record<string, string>, suites: readonly string[]): Record<string, string> =>
  // A function replacer: a suite path's `$&` or `$$` stays as written.
  Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.replaceAll(SUITES_PLACEHOLDER, () => suites.join(','))]));

/** The lanes a config names, in its order. */
export function lanesOf(config: Config): Lane[] {
  const ignore = config.ignore.map((source) => new RegExp(source));
  return config.lanes.map((lane) => {
    const include = lane.include.map((source) => new RegExp(source));
    const exclude = [...ignore, ...lane.exclude.map((source) => new RegExp(source))];
    const built: Lane = {
      name: lane.name,
      cwd: lane.cwd,
      config: lane.config,
      reuse: lane.reuse,
      selects: (path) =>
        include.some((pattern) => pattern.test(path)) &&
        (lane.extensions.length === 0 || lane.extensions.some((extension) => path.endsWith(extension))) &&
        !exclude.some((pattern) => pattern.test(path)),
      env: (suites) => fill(lane.env, suites),
    };
    const { fallbackEnv } = lane;
    const namesSuites = (env: Record<string, string>): boolean => Object.values(env).some((value) => value.includes(SUITES_PLACEHOLDER));
    if (fallbackEnv !== undefined) built.fallback = (suites) => fill(fallbackEnv, suites);
    if (namesSuites(lane.env)) built.ownSuites = true;
    if (fallbackEnv !== undefined && namesSuites(fallbackEnv)) built.fallbackOwnSuites = true;
    return built;
  });
}
