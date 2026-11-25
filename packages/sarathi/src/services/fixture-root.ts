/**
 * The contract between a live-service test fixture, which creates temporary
 * service roots, and the reaper, which must tell an abandoned one from a live
 * test's. Both sides live here.
 *
 * A fixture root is named `<name>-service-test-XXXXXX`, `<name>` being the
 * project's `worktree.name`, so each project's reaper judges only its own.
 */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Written into a fixture root by the process whose test owns its services. */
export const FIXTURE_OWNER_FILE = 'fixture-owner.json';
/**
 * Beyond this age a fixture root is abandoned whatever its owner record says.
 * An hour covers any starved live-service test, and bounds the cost of a
 * reused PID passing for the dead owner.
 */
export const FIXTURE_MAX_AGE_MS = 60 * 60_000;

export interface FixtureOwner {
  readonly pid: number;
  readonly createdAt: number;
}

/** The `mkdtemp` prefix of `name`'s fixture roots. */
export const fixturePrefix = (name: string): string => `${name}-service-test-`;

/**
 * A temporary root for live services, stamped with this process as its owner,
 * so a run killed before its cleanup leaves a root the reaper recognises as
 * abandoned.
 */
export function createFixtureRoot(name: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), fixturePrefix(name))));
  const owner: FixtureOwner = { pid: process.pid, createdAt: Date.now() };
  writeFileSync(join(root, FIXTURE_OWNER_FILE), JSON.stringify(owner));
  return root;
}

/** Runs a command and resolves its stdout; `execFileSync`, replaced in tests. */
export type RunSync = (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string;

/** A PID's `ps` state (`S`, `R`, `Z`…), or undefined when `ps` cannot say. */
export function processStatus(pid: number, run: RunSync = execFileSync): string | undefined {
  try {
    const state = run('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
    if (state !== '') return state;
  } catch {
    // fail-open: `ps` exits non-zero for a PID that does not exist; the caller keeps the owner alive.
  }
  return undefined;
}

/**
 * Signal 0 checks a PID without touching it; EPERM means it is alive. A
 * zombie (a killed worker its parent has not waited for) still answers the
 * signal, so its `ps` state decides. A `ps` that cannot say keeps it alive.
 */
export function processAlive(pid: number, status: (pid: number) => string | undefined = processStatus): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // fail-open: only ESRCH proves no such process; EPERM and the rest count as alive.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  return status(pid)?.startsWith('Z') !== true;
}

/**
 * The system temporary directories a fixture root is created in: this
 * process's `os.tmpdir()`, `/tmp`, and macOS's per-user `/var/folders/…/T`
 * (peers' TMPDIR differs from this process's, so one tmpdir() is not enough).
 * A worktree is never created directly inside one of them.
 */
export function temporaryDirectory(path: string): boolean {
  const own = tmpdir();
  let resolved = own;
  try {
    resolved = realpathSync(own);
  } catch {
    // fail-open: an unresolvable TMPDIR still matches by its own spelling.
  }
  return path === own || path === resolved || /^(\/private)?\/tmp$/.test(path) || /^(\/private)?\/var\/folders\/[^/]+\/[^/]+\/T$/.test(path);
}

function fixtureOwner(root: string): FixtureOwner | undefined {
  try {
    const value: unknown = JSON.parse(String(readFileSync(join(root, FIXTURE_OWNER_FILE))));
    // A non-object has no such fields, and null throws here, caught below.
    const { pid, createdAt } = value as { pid?: unknown; createdAt?: unknown };
    // Number.isInteger and Number.isFinite are false for every non-number.
    if (Number.isInteger(pid) && (pid as number) > 0 && Number.isFinite(createdAt)) return { pid: pid as number, createdAt: createdAt as number };
  } catch {
    // fail-open: missing or half-written, so the root's own age decides.
  }
  return undefined;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `root` is one of `name`'s fixture roots whose test can no longer be
 * running: its owner process is gone, or it is older than
 * {@link FIXTURE_MAX_AGE_MS}. A killed or timed-out test run leaves its root
 * on disk, so the deleted-worktree rule alone would keep those services
 * forever. A fixture-named root qualifies only with an owner record, or
 * directly inside a system temporary directory, so a worktree that merely
 * shares the name is never judged here.
 */
export function fixtureAbandoned(root: string, name: string, now: number = Date.now(), alive: (pid: number) => boolean = processAlive): boolean {
  if (!new RegExp(`^${escape(fixturePrefix(name))}[A-Za-z0-9]{6}$`).test(basename(root))) return false;
  const owner = fixtureOwner(root);
  // The owner record proves a fixture wherever its run's TMPDIR pointed.
  if (owner !== undefined) return !alive(owner.pid) || now - owner.createdAt > FIXTURE_MAX_AGE_MS;
  // Roots from before the owner record, or caught between mkdtemp and its
  // write: only a system temporary directory makes the name evidence, and
  // only age, measured from the root's last change, says it is abandoned.
  if (!temporaryDirectory(dirname(root))) return false;
  try {
    return now - statSync(root).mtimeMs > FIXTURE_MAX_AGE_MS;
  } catch {
    // fail-open: vanished between listing and inspection, so not this rule's call.
    return false;
  }
}
