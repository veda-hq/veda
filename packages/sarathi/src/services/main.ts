/**
 * `sarathi services <action>`: finds the worktree, its settings and its
 * services file, then runs the action (`runner.ts`), the sweep
 * (`reaper.ts`) or the hourly Docker prune (`prune.ts`). Errors are one line
 * on stderr and exit 1.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { readSettings } from '../worktree/settings.ts';
import { BUILT_IN_ACTIONS, loadServicesFile, servicesPath, ServicesError, type ServicesFile } from './file.ts';
import { cli as pruneCli, defaultEnv as defaultPruneEnv, type Env as PruneEnv } from './prune.ts';
import { nodeSweepHost, sweep, type SweepHost } from './reaper.ts';
import { runChild } from './run-child.ts';
import { reapSettings, services, type ServicesIo } from './runner.ts';

export const USAGE = `usage: sarathi services up|down|status|web|server|<action> [args]
       sarathi services run -- <command>
       sarathi services reap
       sarathi services prune install|run|run-now|status|uninstall [--dry-run] [--docker <path>] [--settings <file>]
`;

export interface Io extends ServicesIo {
  readonly cwd: string;
  /** Builds the sweep's host; replaced in tests. */
  readonly sweepHost?: (write: (text: string) => void) => SweepHost;
  /** Replaces parts of the Docker prune's environment; for tests. */
  readonly prune?: Partial<PruneEnv>;
}

/** The hourly Docker prune's environment: this checkout's directory and variables. */
function pruneEnv(io: Io): PruneEnv {
  return {
    ...defaultPruneEnv(),
    run: (command, args, timeoutMs) => runChild(command, args, { timeoutMs, cwd: io.cwd, env: { ...io.env } }),
    variables: io.env,
    stdout: line => io.out(`${line}\n`),
    stderr: line => io.err(`${line}\n`),
    ...io.prune,
  };
}

function toplevel(io: Io): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: io.cwd, encoding: 'utf8', stdio: 'pipe', env: { ...io.env } }).trim();
  } catch {
    throw new ServicesError(`${io.cwd} is not in a git checkout`);
  }
}

function load(root: string, io: Io): { file: ServicesFile; name: string } | undefined {
  const settings = readSettings(root);
  if (settings.services === undefined) return undefined;
  return { file: loadServicesFile(servicesPath(settings.services, root, io.env)), name: settings.name };
}

export async function servicesMain(args: readonly string[], io: Io): Promise<number> {
  const [action, ...rest] = args;
  if (action === undefined || action.startsWith('-')) {
    io.err(USAGE);
    return 1;
  }
  // The prune finds its own checkout (the primary one), or reads launchd's snapshot.
  if (action === 'prune') return pruneCli(rest, pruneEnv(io));
  try {
    if (action === 'reap') {
      if (rest.length > 0) {
        io.err(USAGE);
        return 1;
      }
      // The project checkout: a fresh worktree has no node_modules for a package path.
      const dir = io.env.CLAUDE_PROJECT_DIR;
      const root = dir === undefined || dir === '' ? toplevel(io) : dir;
      const project = load(root, io);
      if (project === undefined) {
        io.out('No services file configured; nothing to sweep\n');
        return 0;
      }
      return await sweep(io.sweepHost?.(io.out) ?? nodeSweepHost(io.out, io.env), reapSettings(project), root);
    }
    const root = toplevel(io);
    const project = load(root, io);
    if (project === undefined) throw new ServicesError(`${join(root, '.claude', 'sarathi.json')} names no services file; set "worktree.services"`);
    if (!(BUILT_IN_ACTIONS as readonly string[]).includes(action) && project.file.actions[action] === undefined) {
      const known = [...BUILT_IN_ACTIONS, ...Object.keys(project.file.actions)].join(', ');
      io.err(`sarathi services: unknown action ${action}; the actions are ${known}\n${USAGE}`);
      return 1;
    }
    return await services(root, action, rest[0] === '--' ? rest.slice(1) : rest, project, io);
  } catch (error) {
    // fail-open: the action stops here; its reason is printed and the exit code is 1.
    io.err(`sarathi services: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
