/** One gate run per machine: a lock file all worktrees share. */

export interface LockDeps {
  /** Exclusive create (`wx`); false when the file already exists. */
  create: (path: string, text: string) => boolean;
  read: (path: string) => string | undefined;
  remove: (path: string) => void;
  alive: (pid: number) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export const LOCK_WAIT_MS = 30 * 60_000;
export const LOCK_POLL_MS = 5_000;

/** Take the lock, waiting for a live holder up to `waitMs`. Resolves to its release. */
export async function acquireLock(path: string, pid: number, deps: LockDeps, waitMs = LOCK_WAIT_MS): Promise<() => void> {
  const mine = `${pid} ${new Date(deps.now()).toISOString()}`;
  const startedAt = deps.now();
  let announced = '';
  let sawEmpty = false;
  for (;;) {
    if (deps.create(path, mine)) {
      return () => {
        if (deps.read(path) === mine) deps.remove(path);
      };
    }
    const held = deps.read(path);
    if (held === undefined) continue; // released between create and read
    const holder = Number.parseInt(held, 10);
    // `wx` creates the file before its writer fills it: an empty lock gets one poll.
    if (held === '' && !sawEmpty) {
      sawEmpty = true;
      await deps.sleep(LOCK_POLL_MS);
      continue;
    }
    if (!Number.isInteger(holder) || !deps.alive(holder)) {
      // Remove only what was read as stale, never a lock another run just took.
      if (deps.read(path) === held) {
        deps.log(`agnipariksha: taking over a stale lock (${held.trim() || 'empty'})`);
        deps.remove(path);
      }
      continue;
    }
    if (deps.now() - startedAt >= waitMs) {
      throw new Error(`another mutation run (pid ${held.trim()}) held ${path} for over ${Math.round(waitMs / 60_000)} min`);
    }
    if (announced !== held) deps.log(`agnipariksha: waiting for pid ${held.trim()}, which holds ${path}`);
    announced = held;
    await deps.sleep(LOCK_POLL_MS);
  }
}

/** Whether a pid is alive: EPERM means it is, under another user. */
export function pidAlive(pid: number, kill: (pid: number, signal: 0) => void = (p, s) => process.kill(p, s)): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // fail-open: the error is the answer; ESRCH means no such process.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
