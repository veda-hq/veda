// A repository's dvara settings: `.dvara.json` at its root, or the file
// DVARA_CONFIG names (relative to the root). Every field is optional.
import { readFileSync } from "node:fs";
import { isAbsolute, posix, resolve } from "node:path";
import { parseStageLists } from "./stages.ts";

/** Paths no file under which is added, changed or deleted. */
export interface FrozenPaths {
  /** Path prefixes, repository-relative with `/`. */
  readonly paths: readonly string[];
  /** Exact paths under those prefixes that stay editable. */
  readonly except: readonly string[];
}

export const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** The settings of `dvara records` and `dvara frozen`. */
export interface RecordsConfig {
  /** The per-file baseline, relative to the root; it must be tracked to count. */
  readonly baseline: string;
  /** Path prefixes no rule reads (a checker's own sources and fixtures, say). */
  readonly skip: readonly string[];
  /** Frozen paths: `dvara frozen` refuses changing them, and no rule reads them. */
  readonly frozen: FrozenPaths;
  /** Paths where a commit must be cited by its full id. */
  readonly identityPaths: readonly RegExp[];
  /** The repository on GitHub, `owner/name`, that commit ids are cited from. */
  readonly repository: string | null;
  /** Machine paths that are durable by agreement, matched from where the path starts. */
  readonly allowPaths: readonly RegExp[];
  /** The one package manager the repository installs with; null: install commands are not checked. */
  readonly packageManager: PackageManager | null;
}

export interface Config {
  /** Where history.jsonl, the last quiet log and the run's scratch files go, relative to the root. */
  readonly historyDir: string;
  /** Hooks whose passing output is reduced to one line. */
  readonly quietHooks: readonly string[];
  /** A watchdog module to attach to each run (see Watchdog in supervisor.ts), relative to the root; none by default. */
  readonly watchdog: string | null;
  /** Refs tried in order for the base a run is judged against. */
  readonly baseRefs: readonly string[];
  /** Each hook's stages, in the order they run; a passing run must keep to them (stages.ts). */
  readonly stages: Readonly<Record<string, readonly string[]>>;
  /** A JSON file holding the same map instead, relative to the root and read when a run ends; none by default. */
  readonly stageList: string | null;
  /** Hooks a stage list that cannot be read refuses; any other hook passes with a warning. */
  readonly stageListRequired: readonly string[];
  /** The record gate and the frozen-path check. */
  readonly records: RecordsConfig;
}

export const DEFAULTS: Config = {
  historyDir: ".dvara",
  quietHooks: ["pre-commit"],
  watchdog: null,
  baseRefs: ["origin/main", "origin/develop", "origin/master"],
  stages: {},
  stageList: null,
  stageListRequired: ["pre-push"],
  records: {
    baseline: ".dvara/records-baseline.json",
    skip: [],
    frozen: { paths: [], except: [] },
    identityPaths: [],
    repository: null,
    allowPaths: [],
    packageManager: null,
  },
};

export const CONFIG_FILE = ".dvara.json";

/** The config file's name relative to the root, as `loadConfig` reads it. */
export const configName = (env: NodeJS.ProcessEnv): string =>
  posix.normalize(env.DVARA_CONFIG || CONFIG_FILE);

const strings = (value: unknown, field: string): readonly string[] => {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    throw new Error(`${field} must be a list of strings`);
  return value;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const onlyKnown = (
  entries: Record<string, unknown>,
  known: readonly string[],
  field: string,
): void => {
  for (const key of Object.keys(entries))
    if (!known.includes(key)) throw new Error(`unknown field ${field}${key}`);
};

/** Whether `path`, normalized, leaves the root: `..`, `../x`, `a/../../x`. */
const escapes = (path: string): boolean => {
  const normal = posix.normalize(path);
  return normal === ".." || normal.startsWith("../");
};

/**
 * Repository-relative path prefixes or paths: none empty, none absolute, none
 * leaving the root (git prints no path there, so it would match nothing).
 */
const repoPaths = (value: unknown, field: string): readonly string[] => {
  const list = strings(value, field);
  for (const path of list)
    if (path === "" || isAbsolute(path) || escapes(path))
      throw new Error(`${field} must hold repository-relative paths`);
  return list;
};

const patterns = (value: unknown, field: string): readonly RegExp[] =>
  strings(value, field).map((source, i) => {
    try {
      return new RegExp(source);
    } catch (error) {
      throw new Error(
        `${field}[${i}] is not a regular expression: ${(error as Error).message}`,
      );
    }
  });

const parseRecordsConfig = (value: unknown): RecordsConfig => {
  if (!isObject(value)) throw new Error("records must be an object");
  onlyKnown(value, Object.keys(DEFAULTS.records), "records.");
  const records = { ...DEFAULTS.records } as {
    -readonly [K in keyof RecordsConfig]: RecordsConfig[K];
  };
  if ("baseline" in value) {
    const path = value.baseline;
    // Compared with the paths git prints: `./a/../b.json` is `b.json`. A
    // folder (`.`, `archive/`) names no tracked file, so it is no baseline.
    const normal = typeof path === "string" ? posix.normalize(path) : "";
    if (
      typeof path !== "string" ||
      path === "" ||
      isAbsolute(path) ||
      escapes(path) ||
      normal === "." ||
      normal.endsWith("/")
    )
      throw new Error(
        "records.baseline must be a file path inside the repository",
      );
    records.baseline = normal;
  }
  if ("skip" in value) records.skip = repoPaths(value.skip, "records.skip");
  if ("frozen" in value) {
    const frozen = value.frozen;
    if (!isObject(frozen)) throw new Error("records.frozen must be an object");
    onlyKnown(frozen, ["paths", "except"], "records.frozen.");
    records.frozen = {
      paths:
        "paths" in frozen
          ? repoPaths(frozen.paths, "records.frozen.paths")
          : [],
      except:
        "except" in frozen
          ? repoPaths(frozen.except, "records.frozen.except")
          : [],
    };
  }
  if ("identityPaths" in value)
    records.identityPaths = patterns(
      value.identityPaths,
      "records.identityPaths",
    );
  if ("repository" in value) {
    const repository = value.repository;
    if (
      repository !== null &&
      (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    )
      throw new Error('records.repository must be "owner/name" or null');
    records.repository = repository;
  }
  if ("allowPaths" in value)
    records.allowPaths = patterns(value.allowPaths, "records.allowPaths");
  if ("packageManager" in value) {
    const manager = value.packageManager;
    if (
      manager !== null &&
      !(PACKAGE_MANAGERS as readonly unknown[]).includes(manager)
    )
      throw new Error(
        `records.packageManager must be one of ${PACKAGE_MANAGERS.join(", ")}, or null`,
      );
    records.packageManager = manager as PackageManager | null;
  }
  return records;
};

/** The settings in `text` over the defaults; a field of the wrong type is an error, an unknown one too. */
export const parseConfig = (text: string): Config => {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("the config must be an object");
  const entries = raw as Record<string, unknown>;
  const known = new Set(Object.keys(DEFAULTS));
  for (const key of Object.keys(entries))
    if (!known.has(key)) throw new Error(`unknown field ${key}`);
  const config = { ...DEFAULTS } as {
    -readonly [K in keyof Config]: Config[K];
  };
  if ("historyDir" in entries) {
    if (typeof entries.historyDir !== "string" || entries.historyDir === "")
      throw new Error("historyDir must be a non-empty string");
    config.historyDir = entries.historyDir;
  }
  if ("quietHooks" in entries)
    config.quietHooks = strings(entries.quietHooks, "quietHooks");
  if ("watchdog" in entries) {
    if (entries.watchdog !== null && typeof entries.watchdog !== "string")
      throw new Error("watchdog must be a path or null");
    config.watchdog = entries.watchdog;
  }
  if ("baseRefs" in entries)
    config.baseRefs = strings(entries.baseRefs, "baseRefs");
  if ("stages" in entries)
    config.stages = parseStageLists(entries.stages, "stages");
  if ("stageList" in entries) {
    const path = entries.stageList;
    if (
      path !== null &&
      (typeof path !== "string" ||
        path === "" ||
        isAbsolute(path) ||
        escapes(path) ||
        // Read with the platform's resolve: on Windows `..\x` and `C:x` leave the root.
        path.includes("\\") ||
        /^[A-Za-z]:/.test(path))
    )
      throw new Error(
        "stageList must be a file path inside the repository, with / separators, or null",
      );
    if (path !== null && "stages" in entries)
      throw new Error("give stages or stageList, not both");
    config.stageList = path;
  }
  if ("stageListRequired" in entries)
    config.stageListRequired = strings(
      entries.stageListRequired,
      "stageListRequired",
    );
  if ("records" in entries)
    config.records = parseRecordsConfig(entries.records);
  return config;
};

/**
 * The settings for `root`. No file is the defaults. A file that cannot be
 * parsed is an error: a hook that silently ran on the defaults would write its
 * history somewhere nobody reads.
 */
export const loadConfig = (root: string, env: NodeJS.ProcessEnv): Config => {
  const path = resolve(root, env.DVARA_CONFIG || CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !env.DVARA_CONFIG)
      return DEFAULTS;
    throw new Error(`dvara: cannot read ${path}: ${(error as Error).message}`);
  }
  try {
    return parseConfig(text);
  } catch (error) {
    throw new Error(`dvara: ${path}: ${(error as Error).message}`);
  }
};
