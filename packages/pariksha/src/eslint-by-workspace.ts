// Runs each file through the ESLint of the workspace that owns it.
//
// Flat config does not cascade: `eslint.config.*` is found from the folder
// ESLint runs in, so one ESLint run from the root lints a workspace's files
// with the root's config, under different rules, and says nothing. ESLint
// 9's `v10_config_lookup_from_file` finds each file's nearest config, but
// reads one suppressions file per run, and a workspace keeps its own
// `eslint-suppressions.json` beside its config. So the files are grouped by
// owning workspace, and each group runs with that workspace's own ESLint
// binary, from that workspace's folder.
//
// A route sends a path elsewhere: a tooling file that lives inside a
// workspace but is linted by the root's config, say. Routes are exact paths,
// or prefixes ending in `/`; the longest match wins.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join, relative } from 'node:path';

export interface Config {
  /** Folders whose subfolders are workspaces. */
  readonly workspaces: readonly string[];
  /** Path (or `prefix/`) to the workspace that lints it; `.` is the root. */
  readonly routes: Readonly<Record<string, string>>;
}

export const DEFAULT_CONFIG: Config = { workspaces: ['apps', 'packages'], routes: {} };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
  const workspaces = 'workspaces' in raw ? raw['workspaces'] : DEFAULT_CONFIG.workspaces;
  if (!Array.isArray(workspaces) || !workspaces.every((w) => typeof w === 'string' && w !== '' && !w.includes('/'))) throw new Error('"workspaces" must be a list of folder names');
  const routes = 'routes' in raw ? raw['routes'] : DEFAULT_CONFIG.routes;
  if (!isRecord(routes) || !Object.entries(routes).every(([k, v]) => k !== '' && typeof v === 'string' && v !== '')) throw new Error('"routes" must map paths to workspace folders');
  return { workspaces: workspaces as string[], routes: routes as Record<string, string> };
};

/** The workspace that lints `path`: a route, else the workspace folder holding it, else the root. */
export const owner = (config: Config, path: string): string => {
  const routed = Object.keys(config.routes)
    .filter((key) => (key.endsWith('/') ? path.startsWith(key) : path === key))
    .sort((a, b) => b.length - a.length)[0];
  if (routed !== undefined) return config.routes[routed] as string;
  // A workspace folder holds the path when it has a file below `<group>/<name>/`.
  const parts = path.split('/');
  return parts.length > 2 && config.workspaces.includes(parts[0] as string) ? parts.slice(0, 2).join('/') : '.';
};

/** `files` grouped by owner, in first-seen order; a leading `./` dropped, repeats once. */
export const groupFiles = (config: Config, files: readonly string[]): Map<string, string[]> => {
  const groups = new Map<string, string[]>();
  for (const raw of files) {
    const file = raw.replace(/^(\.\/)+/, '');
    if (file === '') continue;
    const ws = owner(config, file);
    const group = groups.get(ws) ?? [];
    if (!group.includes(file)) group.push(file);
    groups.set(ws, group);
  }
  return groups;
};

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    // fail-open: no executable here means try the next binary; with none, the group fails.
    return false;
  }
  return true;
};

/** The ESLint a workspace runs: its own, else the root's. */
export const eslintFor = (root: string, ws: string): string | undefined =>
  [join(root, ws, 'node_modules/.bin/eslint'), join(root, 'node_modules/.bin/eslint')].find(executable);

/** How one group's ESLint runs: in `cwd`, its output on this process's own streams. */
export type EslintRunner = (bin: string, args: readonly string[], cwd: string) => Pick<SpawnSyncReturns<string>, 'status' | 'error'>;

export const inheritEslint: EslintRunner = (bin, args, cwd) => spawnSync(bin, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });

/** Lints every group; the exit code, 1 when any group failed or could not run. */
export const lintByWorkspace = (root: string, config: Config, files: readonly string[], eslintArgs: readonly string[], runner: EslintRunner, io: { out: (l: string) => void; err: (l: string) => void }): number => {
  const groups = groupFiles(config, files);
  if (groups.size === 0) {
    io.out('✅ ESLint: no files to check');
    return 0;
  }
  let failed = false;
  let checked = 0;
  for (const [ws, group] of groups) {
    const bin = eslintFor(root, ws);
    if (bin === undefined) {
      io.err(`❌ ESLint: no eslint binary for ${ws}`);
      failed = true;
      continue;
    }
    const cwd = join(root, ws);
    checked += group.length;
    const result = runner(bin, ['--no-warn-ignored', ...eslintArgs, ...group.map((f) => relative(cwd, join(root, f)))], cwd);
    if (result.status !== 0) {
      io.err(result.error === undefined ? `❌ ESLint failed in ${ws}` : `❌ ESLint could not run in ${ws}: ${result.error.message}`);
      failed = true;
    }
  }
  if (failed) return 1;
  io.out(`✅ ESLint passed (${checked} file(s), routed per workspace)`);
  return 0;
};
