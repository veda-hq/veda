/**
 * Is a push or a preflight running in this worktree? Checks that refuse
 * commits or heavy work while one runs read it from here.
 *
 * A push: the consumer's pre-push hook runs `cli.js push-marker write
 * <git-dir> <pid>` when a real push starts and `cli.js push-marker clear
 * <git-dir> <pid>` on exit. Each push writes its own marker, named by its pid
 * ({@link markerName}), into the worktree's own git folder, so a second push
 * in the same worktree neither overwrites nor clears the first's. A
 * preflight: a background preflight keeps the run that owns the copy in a
 * run record ({@link PREFLIGHT_RECORD} by default). Both records name a pid
 * and its start identity, judged as {@link isGone} judges them: a dead pid,
 * or a live one that provably started later (a reused pid), is no run. So a
 * marker a killed push left behind blocks nothing, and a push in another
 * worktree, with its own git folder, never blocks this one.
 *
 * `clear` removes that pid's marker only, and `write` first removes the
 * markers of pushes that ended.
 */
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** The push markers' name prefix, in the worktree's git folder. */
export const PUSH_MARKER_PREFIX = 'kavach-push-in-progress.';
/** The default preflight run record, relative to the worktree. */
export const PREFLIGHT_RECORD = join('.tmp', 'preflight-bg', 'current.json');

/** `startIdentity` is null when the run could not read its own; it then lives while its pid does. */
export type Run = {
  readonly pid: number;
  readonly startIdentity: string | null;
};

/** How a run's liveness is read: is the pid alive, and when did it start. */
export type Probe = {
  readonly isAlive: (pid: number) => boolean;
  readonly startIdentityOf: (pid: number) => string | null;
};

/**
 * The format every start identity is written in, as a prefix of the identity.
 *
 * Two identities are only comparable when they were read the same way. A
 * record written by a reader that read `lstart` in local time, or in any
 * future format, would differ from this reading for a process that is still
 * the same one, and a difference is what declares a run ended. So an identity
 * in any other format is treated like an unknown one: liveness alone decides.
 */
export const START_IDENTITY_FORMAT = 'lstart-utc-c/1';

function isCurrentIdentity(identity: string | null): identity is string {
  return identity !== null && identity.startsWith(`${START_IDENTITY_FORMAT} `);
}

/**
 * Has the run provably ended: its pid is dead, or now belongs to a process
 * that started later (a reused pid)?
 *
 * An unreadable current start is asked about liveness once more: a reused pid
 * held by a short-lived process can pass the first probe and exit before `ps`
 * reads its start, and the first answer is then stale. The recheck is
 * `kill(0)` again, so a process that still runs, but whose start `ps` cannot
 * read, stays live (a stale push marker once refused an edit this way).
 */
export function isGone(run: Run, probe: Probe): boolean {
  if (!probe.isAlive(run.pid)) return true;
  if (!isCurrentIdentity(run.startIdentity)) return false;
  const current = probe.startIdentityOf(run.pid);
  if (current === null) return !probe.isAlive(run.pid);
  return isCurrentIdentity(current) && current !== run.startIdentity;
}

/** The operating-system calls the real probe makes, injectable so their arguments are testable. */
export type ProcessCalls = {
  readonly exec: (file: string, args: string[], options: ExecFileSyncOptions) => unknown;
  readonly kill: (pid: number, signal: 0) => void;
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

/** The real probe over `calls`. A `ps` reading is decoded with `String()`, which reads a Buffer as UTF-8. */
export function processProbe(calls: ProcessCalls): Probe {
  return {
    isAlive: (pid) => {
      try {
        calls.kill(pid, 0);
      } catch (error: unknown) {
        // Only ESRCH says no such process. EPERM (it exists and belongs to
        // someone else) or anything else is no evidence, so `ps` decides.
        if (errorCode(error) === 'ESRCH') return false;
      }
      // Signal 0 also reaches a zombie (exited, not yet reaped), which would
      // read as a live run for as long as its parent never waits. Only a
      // state that says `Z` is dead; a `ps` that fails or prints nothing is
      // not evidence, and the conservative reading of "unknown" is alive.
      try {
        const state = String(
          calls.exec('ps', ['-o', 'stat=', '-p', String(pid)], {
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, LC_ALL: 'C' },
          }),
        ).trim();
        return !state.startsWith('Z');
      } catch {
        return true;
      }
    },
    startIdentityOf: (pid) => {
      try {
        // Pinned to UTC and the C locale. `lstart` is printed in local time, so
        // without this two readers whose shells carry different TZ values read
        // different strings for the same live process, and the second judges
        // a live run a reused pid.
        const started = String(
          calls.exec('ps', ['-o', 'lstart=', '-p', String(pid)], {
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
          }),
        ).trim();
        return started === '' ? null : `${START_IDENTITY_FORMAT} ${started}`;
      } catch {
        return null;
      }
    },
  };
}

/** The real probe. */
export const defaultProbe: Probe = processProbe({
  exec: (file, args, options) => execFileSync(file, args, options),
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
});

export type Read = (path: string) => string;
export type List = (dir: string) => readonly string[];

/** A run record's pid and start identity; `null` for anything else. */
export function parseRun(raw: string): Run | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // fail-open: a torn or foreign record names no run.
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { pid, startIdentity } = value as Record<string, unknown>;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) return null;
  if (startIdentity !== null && typeof startIdentity !== 'string') return null;
  return { pid, startIdentity };
}

/** The live run recorded at `path`; `null` when none is recorded or it ended. */
export function liveRun(path: string, read: Read, probe: Probe): Run | null {
  let raw: string;
  try {
    raw = read(path);
  } catch {
    // fail-open: no record (or none readable) is no run.
    return null;
  }
  const run = parseRun(raw);
  return run === null || isGone(run, probe) ? null : run;
}

/**
 * The git folder of the checkout at `root`, read from `root/.git` without
 * running git: a folder in the primary checkout, a `gitdir:` file in a
 * linked worktree.
 */
export function gitDir(root: string, read: Read): string {
  const dotGit = join(root, '.git');
  let text: string;
  try {
    text = read(dotGit);
  } catch {
    // fail-open: a folder (the primary checkout) or nothing reads as .git itself.
    return dotGit;
  }
  const named = /^gitdir: (.+)$/m.exec(text)?.[1];
  if (named === undefined) return dotGit;
  return isAbsolute(named) ? named : resolve(root, named);
}

/** The marker push `pid` writes: one per push, so two pushes never share one. */
export function markerName(pid: number): string {
  return `${PUSH_MARKER_PREFIX}${pid}.json`;
}

const MARKER_NAME = /^kavach-push-in-progress\.\d+\.json$/;

/** A live push in the checkout at `root`, read from the first marker whose pid still runs. */
export function livePush(root: string, read: Read, list: List, probe: Probe): Run | null {
  const dir = gitDir(root, read);
  let names: readonly string[];
  try {
    names = list(dir);
  } catch {
    // fail-open: an unreadable git folder names no push.
    return null;
  }
  for (const name of names.filter((entry) => MARKER_NAME.test(entry))) {
    const run = liveRun(join(dir, name), read, probe);
    if (run !== null) return run;
  }
  return null;
}

/** The live preflight in the checkout at `root`, from its run record (relative to `root`). */
export function livePreflight(root: string, read: Read, probe: Probe, record: string = PREFLIGHT_RECORD): Run | null {
  return liveRun(resolve(root, record), read, probe);
}

export const readText: Read = (path) => readFileSync(path, 'utf8');
export const listDir: List = (dir) => readdirSync(dir);

export type Effects = {
  readonly probe: Probe;
  readonly read: Read;
  readonly list: List;
  readonly write: (path: string, text: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
  readonly now: () => Date;
};

/**
 * Remove the markers in `dir` whose push provably ended: a push killed before
 * its exit trap ran leaves one, and each left behind is one more pid to be
 * reused. A marker that does not parse names no push and stays.
 */
export function sweepMarkers(dir: string, effects: Effects): void {
  let names: readonly string[];
  try {
    names = effects.list(dir);
  } catch {
    // fail-open: an unreadable git folder has nothing to sweep.
    return;
  }
  for (const name of names.filter((entry) => MARKER_NAME.test(entry))) {
    const path = join(dir, name);
    try {
      const run = parseRun(effects.read(path));
      if (run !== null && isGone(run, effects.probe)) effects.remove(path);
    } catch {
      // fail-open: a marker another sweep took first is already gone.
    }
  }
}

/**
 * Write the marker for `pid`, atomically, after sweeping the ended pushes'
 * markers. Throws when its start is unknown.
 */
export function writeMarker(dir: string, pid: number, effects: Effects): void {
  const startIdentity = effects.probe.startIdentityOf(pid);
  if (startIdentity === null) throw new Error(`no process ${pid}`);
  sweepMarkers(dir, effects);
  const path = join(dir, markerName(pid));
  const staging = `${path}.tmp`;
  effects.write(staging, `${JSON.stringify({ pid, startIdentity, startedAt: effects.now().toISOString() })}\n`);
  effects.rename(staging, path);
}

/** Remove the marker `pid` wrote; another push's marker stays. */
export function clearMarker(dir: string, pid: number, effects: Effects): void {
  effects.remove(join(dir, markerName(pid)));
}

export const liveEffects: Effects = {
  probe: defaultProbe,
  read: readText,
  list: listDir,
  write: (path, text) => writeFileSync(path, text),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true }),
  now: () => new Date(),
};

/** A caught value as text, never throwing. */
function errorDetail(error: unknown): string {
  try {
    if (error instanceof Error) return error.message || error.name || 'Error';
    return String(error);
  } catch {
    // fail-open: describing the error must not raise a second one.
    return '[unprintable error]';
  }
}

/** `push-marker write|clear <git-dir> <pid>`; returns the exit status. Never fails a push: errors only warn. */
export function main(args: readonly string[], effects: Effects, warn: (line: string) => void): number {
  const [verb, dir, pidText] = args;
  const pid = Number(pidText);
  if ((verb !== 'write' && verb !== 'clear') || dir === undefined || dir === '' || !(pid > 1)) {
    warn('usage: push-marker write|clear <git-dir> <pid>');
    return 2;
  }
  try {
    if (verb === 'write') writeMarker(dir, pid, effects);
    else clearMarker(dir, pid, effects);
    return 0;
  } catch (error) {
    // fail-open: the marker is advisory; the push carries on after the warning.
    warn(`push marker: could not ${verb} (${errorDetail(error)})`);
    return 1;
  }
}
