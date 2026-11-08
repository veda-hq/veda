// A repository's dvara settings: `.dvara.json` at its root, or the file
// DVARA_CONFIG names (relative to the root). Every field is optional.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  /** Where history.jsonl, the last quiet log and the run's scratch files go, relative to the root. */
  readonly historyDir: string;
  /** Hooks whose passing output is reduced to one line. */
  readonly quietHooks: readonly string[];
  /** A watchdog module to attach to each run (see Watchdog in supervisor.ts), relative to the root; none by default. */
  readonly watchdog: string | null;
  /** Refs tried in order for the base a run is judged against. */
  readonly baseRefs: readonly string[];
  /** Each hook's stages, in the order they run; a hook not listed is not checked. */
  readonly stages: Readonly<Record<string, readonly string[]>>;
}

export const DEFAULTS: Config = {
  historyDir: ".dvara",
  quietHooks: ["pre-commit"],
  watchdog: null,
  baseRefs: ["origin/main", "origin/develop", "origin/master"],
  stages: {},
};

export const CONFIG_FILE = ".dvara.json";

const strings = (value: unknown, field: string): readonly string[] => {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    throw new Error(`${field} must be a list of strings`);
  return value;
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
  if ("stages" in entries) {
    const stages = entries.stages;
    if (typeof stages !== "object" || stages === null || Array.isArray(stages))
      throw new Error("stages must map each hook to its stage names");
    const out: Record<string, readonly string[]> = {};
    for (const [hook, names] of Object.entries(stages))
      out[hook] = strings(names, `stages.${hook}`);
    config.stages = out;
  }
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
