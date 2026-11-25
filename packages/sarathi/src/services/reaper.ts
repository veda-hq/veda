/**
 * `sarathi services reap`: removes the Docker resources of worktree services
 * whose worktree is gone.
 *
 * Archiving a conversation deletes its worktree directory, but nothing stops
 * the Compose project `sarathi services` started there: its containers keep
 * running and its volume keeps its disk. No repository hook sees a desktop
 * app archive (Claude's WorktreeRemove hook would REPLACE git's own removal,
 * not run beside it), so this sweep is keyed on the one durable fact left
 * behind, the worktree root, which Compose stamps on every container as
 * working_dir and the project's Compose file stamps on the project's volume
 * (and network) under the services file's `rootLabel`. It reaps a project only
 * when that directory provably no longer exists. Its credentials lived in that
 * directory, so the volume cannot be reopened by the tooling either.
 *
 * A live-service test fixture's temporary roots are the one exception to
 * "present means live": a killed or timed-out test leaves its root behind, so
 * a fixture root whose owner process died, or that outlived any test, counts
 * as gone (the rules: fixture-root.ts).
 */
import { execFile, execFileSync, type ExecFileOptions, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { fixtureAbandoned } from './fixture-root.ts';

/**
 * Runs one Docker CLI command and resolves its trimmed stdout. Asynchronous so
 * a sweep inside a service start never blocks the event loop while other
 * worktree projects are starting in the same process.
 */
export type Docker = (args: string[]) => Promise<string>;
/** `unknown` means the path could not be inspected: never evidence of deletion. */
export type WorktreeState = 'present' | 'gone' | 'unknown';
export type Inspect = (path: string) => WorktreeState;

export interface ServiceProject {
  readonly project: string;
  readonly root: string;
}

/** What the reaper needs to know of the project: the services file's names and `worktree.name`. */
export interface ReapSettings {
  /** The Compose project prefix. */
  readonly project: string;
  readonly rootLabel: string;
  /** `worktree.name`: names the log and the fixture roots. */
  readonly name: string;
}

const PROJECT_LABEL = 'com.docker.compose.project';
const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';
const SERVICES_DIRECTORY = '/.tmp/services';
const execute = promisify(execFile);

/** The Compose project of the worktree at `root`: `<prefix>-` and 16 hex of the root's SHA-256. */
export function projectName(prefix: string, root: string): string {
  return `${prefix}-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
}

/**
 * Only a missing path is gone; a permission or I/O error proves nothing.
 * `throwIfNoEntry: false` answers `undefined` for exactly the two codes that
 * prove absence, ENOENT and ENOTDIR (a path component is a file), and throws
 * every other error.
 */
export function worktreeState(path: string): WorktreeState {
  try {
    return statSync(path, { throwIfNoEntry: false }) === undefined ? 'gone' : 'present';
  } catch {
    // fail-open: an uninspectable path is never evidence of deletion.
    return 'unknown';
  }
}

/**
 * The reaper's verdict on a project root: a deleted worktree, or an abandoned
 * fixture root of `name`'s, is `gone`; anything else is what
 * {@link worktreeState} says.
 */
export function serviceRootState(path: string, name: string): WorktreeState {
  const state = worktreeState(path);
  if (state !== 'present') return state;
  return fixtureAbandoned(path, name) ? 'gone' : 'present';
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Projects `sarathi services` created, with the worktree root each belongs to. */
export async function serviceProjects(docker: Docker, settings: Pick<ReapSettings, 'project' | 'rootLabel'>, warn: (message: string) => void = () => undefined): Promise<ServiceProject[]> {
  const projectAnd = (label: string): string => `{{.Label "${PROJECT_LABEL}"}}\t{{.Label "${label}"}}`;
  const roots = new Map<string, string>();
  /** Records each `project<TAB>label` line whose label names the project's root. */
  const add = (listing: string, rootsOf: (label: string) => string[]): void => {
    for (const line of listing.split('\n')) {
      const [project, label] = line.split('\t');
      // Empty output is one line with no tab, and so no label.
      if (label === undefined) continue;
      // The name is a hash of the root, so a matching label proves the project
      // was created for exactly this directory, and every resource of the
      // project therefore names the same root, which is why the listings may
      // record their projects in any order. A candidate that is not the root
      // cannot match that hash, so the project is the name the root hashes to.
      const root = rootsOf(label).find(candidate => candidate !== '' && projectName(settings.project, candidate) === project);
      if (root !== undefined) roots.set(projectName(settings.project, root), root);
    }
  };
  await Promise.all([
    docker(['ps', '--all', '--filter', `label=${PROJECT_LABEL}`, '--format', projectAnd(WORKING_DIR_LABEL)]).then(listing =>
      // A root Compose file makes the root the working directory; projects
      // started from a generated .tmp/services/compose.json have that instead.
      // Both are tried, so a root that itself ends in /.tmp/services is found.
      add(listing, workingDir => [workingDir, workingDir.slice(0, -SERVICES_DIRECTORY.length)]),
    ),
    // A volume, and a network, outlive the containers after `down` or after a
    // reap that stopped part-way, so each records its root as well. A failed
    // label listing narrows discovery to containers, so those projects are
    // still reaped; the narrowing is reported.
    ...['volume', 'network'].map(kind =>
      docker([kind, 'ls', '--filter', `label=${settings.rootLabel}`, '--format', projectAnd(settings.rootLabel)])
        .then(listing => add(listing, root => [root]))
        .catch((error: unknown) => {
          // fail-open: the container listing still names its projects; the narrowing is reported.
          warn(`Could not list ${kind}s by worktree root, so projects without containers went unchecked: ${message(error)}`);
        }),
    ),
  ]);
  return [...roots].map(([project, root]) => ({ project, root })).sort((a, b) => a.project.localeCompare(b.project));
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes a project's containers (with anonymous volumes), volumes and networks. */
export async function reapProject(docker: Docker, prefix: string, project: string): Promise<void> {
  if (!new RegExp(`^${escape(prefix)}-[0-9a-f]{16}$`).test(project)) throw new Error(`Refusing to reap non-worktree project ${project}`);
  const filter = ['--filter', `label=${PROJECT_LABEL}=${project}`];
  const ids = async (kind: string[]): Promise<string[]> => (await docker([...kind, ...filter])).split('\n').filter(Boolean);
  // In order: a network cannot be removed while a container still uses it.
  const containers = await ids(['ps', '--all', '--quiet']);
  if (containers.length > 0) await docker(['rm', '--force', '--volumes', ...containers]);
  const volumes = await ids(['volume', 'ls', '--quiet']);
  if (volumes.length > 0) await docker(['volume', 'rm', '--force', ...volumes]);
  const networks = await ids(['network', 'ls', '--quiet']);
  if (networks.length > 0) await docker(['network', 'rm', ...networks]);
}

export interface SweepResult {
  reaped: string[];
  skipped: Array<{ project: string; reason: string }>;
  failed: Array<{ project: string; error: string }>;
  /** Discovery that ran narrower than it should have; the sweep still ran. */
  warnings: string[];
}

/**
 * Reaps every project whose worktree is gone, or whose fixture root is
 * abandoned ({@link serviceRootState}); one failure never stops the others.
 *
 * Each root is inspected again immediately before its removal: a worktree
 * recreated at the same path gets the same project name, so a verdict taken
 * when the containers were listed is not enough to delete on. This NARROWS the
 * race to the moments between that re-check and `docker rm`; it does not close
 * it. Closing it needs a lock shared with every service start, which would
 * serialize `compose up --wait` across all worktrees; rejected, since the race
 * also needs a worktree recreated at the identical path within that window,
 * and provider worktree paths carry random suffixes. Concurrent sweeps need no
 * lock: they converge on the same removals, and a loser's failure is
 * reported, not acted on.
 *
 * Distinct projects share no Docker resource, so they are reaped concurrently.
 * Each one's re-check still runs synchronously immediately before its own
 * removal starts, and the result lists projects in listing order.
 */
export async function reapOrphanedServices(docker: Docker, settings: ReapSettings, inspect: Inspect = path => serviceRootState(path, settings.name)): Promise<SweepResult> {
  /** Resolves the removal's error message, or `undefined` once it succeeded. */
  const removal = async (project: string): Promise<string | undefined> => {
    try {
      await reapProject(docker, settings.project, project);
      return undefined;
    } catch (error) {
      // fail-open: one project's failure never stops the others; it is reported in `failed`.
      return message(error);
    }
  };
  const warnings: string[] = [];
  const projects = await serviceProjects(docker, settings, text => warnings.push(text));
  const result: SweepResult = { reaped: [], skipped: [], failed: [], warnings };
  const removals: Array<Promise<{ project: string; error: string | undefined }>> = [];
  for (const { project, root } of projects) {
    const listed = inspect(root);
    if (listed === 'present') continue;
    // An uninspectable root is never re-inspected: nothing would be removed on it.
    const current = listed === 'gone' ? inspect(root) : listed;
    if (current === 'gone') {
      // Started before the next project's re-check, so each re-check runs
      // immediately before its own project's first `docker` call.
      removals.push(removal(project).then(error => ({ project, error })));
      continue;
    }
    result.skipped.push({ project, reason: current === 'present' ? `${root} reappeared before removal` : `cannot inspect ${root}` });
  }
  // Promise.all keeps listing order, whatever order the removals finish in.
  for (const { project, error } of await Promise.all(removals)) {
    if (error === undefined) result.reaped.push(project);
    else result.failed.push({ project, error });
  }
  return result;
}

/** The Docker CLI, run with `env`, never inside a checkout: Compose would otherwise read a Compose file there. */
export function dockerCli(env: Readonly<Record<string, string | undefined>> = process.env): Docker {
  return async args => (await execute('docker', args, { cwd: tmpdir(), encoding: 'utf8', timeout: 60_000, env: { ...env } })).stdout.trim();
}

/** What the sweep touches outside this module, so a test can fake it. */
export interface SweepHost {
  readonly docker: Docker;
  /** Rejects on a non-zero exit, and with code ENOENT when the binary is missing. */
  readonly execFile: (file: string, args: string[], options: ExecFileOptions) => Promise<unknown>;
  readonly execFileSync: (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string;
  readonly appendFileSync: (path: string, data: string) => void;
  /** Standard output. */
  readonly write: (text: string) => void;
}

export function nodeSweepHost(write: (text: string) => void, env: Readonly<Record<string, string | undefined>> = process.env): SweepHost {
  return {
    docker: dockerCli(env),
    execFile: (file, args, options) => execute(file, args, { ...options, env: { ...env } }),
    execFileSync: (file, args, options) => execFileSync(file, args, { ...options, env: { ...env } }),
    appendFileSync,
    write,
  };
}

/** True when a Docker engine answers, without waking a stopped OrbStack. */
async function dockerRunning(host: SweepHost): Promise<boolean> {
  try {
    await host.execFile('orbctl', ['status'], { timeout: 5_000 });
  } catch (error) {
    // fail-open: orbctl exits non-zero when stopped; only its absence means "not OrbStack".
    if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT')) return false;
  }
  try {
    await host.docker(['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    // fail-open: an engine that does not answer is not running, and the sweep waits for the next start.
  }
  return false;
}

function record(host: SweepHost, settings: ReapSettings, cwd: string, entry: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  host.write(`${line}\n`);
  try {
    const common = host.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // The common git dir outlives every worktree, so the record survives the
    // removals it describes.
    host.appendFileSync(join(common, `${settings.name}-services-reaper.log`), `${line}\n`);
  } catch {
    // fail-open: logging is diagnostic only, and the record was printed above.
  }
}

/** The sweep, from `cwd`'s checkout; resolves the exit code (1: a removal failed). */
export async function sweep(host: SweepHost, settings: ReapSettings, cwd: string): Promise<number> {
  if (!(await dockerRunning(host))) {
    host.write('Docker is not running; nothing to sweep\n');
    return 0;
  }
  const result = await reapOrphanedServices(host.docker, settings);
  if (result.reaped.length > 0 || result.skipped.length > 0 || result.failed.length > 0 || result.warnings.length > 0) {
    record(host, settings, cwd, { event: 'sweep', ...result });
  } else host.write('No services of deleted worktrees found\n');
  return result.failed.length > 0 ? 1 : 0;
}
