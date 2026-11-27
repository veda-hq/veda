// The repository's pariksha settings: `.pariksha.json` at the top level of
// the checkout pariksha runs in, or the file PARIKSHA_CONFIG names. One file
// holds every check's settings, so a hook or a CI step calls `pariksha
// <check> --staged` and nothing more.
//
// The file is found from the working directory, never from `--root`: a hook
// may point `--root` at a snapshot of the index, and the settings are the
// checkout's own.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { topOf } from './git.ts';

export const CONFIG_FILE = '.pariksha.json';
export const CONFIG_ENV = 'PARIKSHA_CONFIG';

/** One check's entry: a file holding its settings, or the settings inline. */
export type Entry = { readonly kind: 'file'; readonly path: string; readonly shown: string } | { readonly kind: 'inline'; readonly value: Readonly<Record<string, unknown>> };

export interface ProjectConfig {
  /** The file read, absolute; undefined when there is none. */
  readonly file: string | undefined;
  readonly checks: ReadonlyMap<string, Entry>;
}

export const NO_CONFIG: ProjectConfig = { file: undefined, checks: new Map() };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A settings file's text, as each reader here takes it. */
const readUtf8 = (path: string): string => readFileSync(path, 'utf8');

/**
 * The settings `text` holds, the file it came from at `file`. Every key must
 * be known: a field this version does not read would be a setting nobody
 * applies, so it is refused, naming the key and the version.
 */
export const parseProjectConfig = (text: string, file: string, known: readonly string[], version: string): ProjectConfig => {
  const at = `${file} (pariksha ${version})`;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${at}: not JSON: ${(e as Error).message}`);
  }
  if (!isObject(raw)) throw new Error(`${at}: must be a JSON object`);
  for (const key of Object.keys(raw)) {
    if (key !== 'checks' && key !== '$schema') throw new Error(`${at}: unknown key "${key}"; this version reads "checks"`);
  }
  const checks = new Map<string, Entry>();
  if (raw.checks === undefined) return { file, checks };
  if (!isObject(raw.checks)) throw new Error(`${at}: "checks" must be an object of check names`);
  for (const [name, value] of Object.entries(raw.checks)) {
    if (!known.includes(name)) throw new Error(`${at}: unknown check "${name}" in "checks"; this version reads settings for ${known.join(', ')}`);
    if (typeof value === 'string') {
      if (value === '') throw new Error(`${at}: checks.${name} is an empty path`);
      checks.set(name, { kind: 'file', path: resolve(dirname(file), value), shown: value });
    } else if (isObject(value)) {
      checks.set(name, { kind: 'inline', value });
    } else {
      throw new Error(`${at}: checks.${name} must be a path to the check's settings or the settings inline, an object`);
    }
  }
  return { file, checks };
};

/**
 * Where the settings are for a run started in `cwd`: the file PARIKSHA_CONFIG
 * names (relative to `cwd`), or `.pariksha.json` at the top level of the git
 * repository holding `cwd` (`cwd` itself outside one).
 */
export const configLocation = (cwd: string, env: NodeJS.ProcessEnv): { readonly path: string; readonly named: boolean } => {
  const named = env[CONFIG_ENV];
  if (named !== undefined && named !== '') return { path: resolve(cwd, named), named: true };
  return { path: resolve(topOf(cwd) ?? cwd, CONFIG_FILE), named: false };
};

/**
 * The settings for a run started in `cwd`. No file is no settings, unless
 * PARIKSHA_CONFIG named one: then a missing file is an error, since the
 * caller meant settings that are not there.
 */
export const loadProjectConfig = (cwd: string, env: NodeJS.ProcessEnv, known: readonly string[], version: string): ProjectConfig => {
  const { path, named } = configLocation(cwd, env);
  let text: string;
  try {
    text = readUtf8(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !named) return NO_CONFIG;
    throw new Error(`cannot read ${path}${named ? ` (${CONFIG_ENV})` : ''} (pariksha ${version}): ${(e as Error).message}`);
  }
  return parseProjectConfig(text, path, known, version);
};

/** An entry's settings as the text a check's `--config` file would hold. */
export const entryText = (entry: Entry): string => (entry.kind === 'inline' ? JSON.stringify(entry.value) : readUtf8(entry.path));

/** An entry's settings as an object: the inline value, or the file's JSON. */
export const entryObject = (entry: Entry, check: string, version: string): Readonly<Record<string, unknown>> => {
  if (entry.kind === 'inline') return entry.value;
  let raw: unknown;
  try {
    raw = JSON.parse(readUtf8(entry.path));
  } catch (e) {
    throw new Error(`checks.${check} (${entry.shown}, pariksha ${version}): ${(e as Error).message}`);
  }
  if (!isObject(raw)) throw new Error(`checks.${check} (${entry.shown}, pariksha ${version}): must be a JSON object`);
  return raw;
};
