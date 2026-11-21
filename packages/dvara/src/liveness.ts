// Is the process that wrote a lock record still the one running? Ported
// from a mutation gate lock (the first consumer's `gate-lock.ts`), whose
// records `dvara slot` must read and write byte for byte: a lock taken by
// the old code and one taken by dvara are the same lock.
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";

/**
 * An unreadable record younger than this is left alone.
 *
 * Records are linked into place complete, so an unreadable one is
 * corruption, not a write in progress. The grace exists only so a
 * clock-skewed mtime cannot reclaim a file the instant it appears.
 */
export const UNREADABLE_GRACE_MS = 10_000;

/** The largest pid a 32-bit `pid_t` holds; `process.kill` refuses anything past it. */
export const MAX_PID = 2_147_483_647;

/**
 * The format every start identity is written in, as a prefix of the identity.
 *
 * Two identities are only COMPARABLE when they were read the same way. A
 * holder recorded by code that read `lstart` in local time, or by any future
 * format, would differ from this reading for a process that is still the
 * same one, and a difference is what reclaims a lock. So an identity in any
 * other format is treated like an unknown one: liveness alone decides.
 */
export const START_IDENTITY_FORMAT = "lstart-utc-c/1";

/** Who holds a lock: the gate lock's record, field for field. */
export interface Party {
  readonly pid: number;
  /** The process start time as the OS reports it; `null` when it could not be read. */
  readonly startIdentity: string | null;
  /** What the holder is: the gate lock's branch, the slot's name. */
  readonly branch: string;
  readonly rootDir: string;
  /** Unique per acquisition, so a release can never remove someone else's lock. */
  readonly token: string;
  /** When this party took the lock. */
  readonly since: number;
}

/** The effects liveness needs, injectable so a lock is testable on a real directory. */
export interface LivenessSystem {
  readonly pid: number;
  now(): number;
  isAlive(pid: number): boolean;
  startIdentityOf(pid: number): string | null;
}

/** The operating-system calls the real effects make, injectable so their arguments are testable. */
export interface ProcessCalls {
  exec(file: string, args: string[], options: ExecFileSyncOptions): unknown;
  kill(pid: number, signal: 0): void;
}

/** An error's `code`, as a string, when it has one. */
export const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

/**
 * The real effects over `calls`. A `ps` reading is decoded with `String()`,
 * which reads a Buffer as UTF-8, as `encoding: "utf8"` would.
 */
export const processLivenessSystem = (calls: ProcessCalls): LivenessSystem => ({
  pid: process.pid,
  now: () => Date.now(),
  isAlive: (pid) => {
    // parseParty admits any integer pid, as the old schema did, but no process
    // has one past a 32-bit pid_t: such a record names no one. Node refuses it
    // before kill(0) runs, and `ps` with it fails, which would read as alive.
    if (pid > MAX_PID) return false;
    try {
      calls.kill(pid, 0);
    } catch (error) {
      // fail-open: only ESRCH says no such process. EPERM (it exists and belongs
      // to someone else) or anything else is no evidence, so `ps` decides.
      if (errorCode(error) === "ESRCH") return false;
    }
    // Signal 0 also reaches a ZOMBIE (exited, not yet reaped), and a holder
    // left one would hold the lock for as long as its parent never waits.
    // Only a state that says `Z` is dead; a `ps` that fails or prints nothing
    // is not evidence, and the conservative reading of "unknown" is alive.
    try {
      const state = String(
        calls.exec("ps", ["-o", "stat=", "-p", String(pid)], {
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, LC_ALL: "C" },
        }),
      ).trim();
      return !state.startsWith("Z");
    } catch {
      // fail-open: a `ps` that fails is no evidence of death; unknown reads as alive.
      return true;
    }
  },
  startIdentityOf: (pid) => {
    try {
      // PINNED to UTC and the C locale. `lstart` is printed in LOCAL time, so
      // without this two readers whose shells carry different TZ values read
      // different strings for the same live process, and the second judges a
      // live holder a reused PID and reclaims a lock still in use.
      const started = String(
        calls.exec("ps", ["-o", "lstart=", "-p", String(pid)], {
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
        }),
      ).trim();
      return started === "" ? null : `${START_IDENTITY_FORMAT} ${started}`;
    } catch {
      // fail-open: an unreadable start is unknown, and isGone treats unknown as no evidence.
      return null;
    }
  },
});

/** The real effects. */
export const defaultLivenessSystem: LivenessSystem = processLivenessSystem({
  exec: (file, args, options) => execFileSync(file, args, options),
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
});

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/**
 * Parse a record; `null` for anything that is not a complete party. The
 * gate lock's zod schema, by hand: an integer pid above 0 (any integer, not
 * only a safe one), a string or null start identity, string branch and
 * root, a non-empty token, a finite since. Other keys are dropped, not
 * refused.
 */
export const parseParty = (raw: string): Party | null => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // fail-open: text that is not JSON is no party; the caller judges it unreadable.
    return null;
  }
  if (!isObject(value)) return null;
  const { pid, startIdentity, branch, rootDir, token, since } = value;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startIdentity !== "string" && startIdentity !== null) return null;
  if (typeof branch !== "string" || typeof rootDir !== "string") return null;
  if (typeof token !== "string" || token === "") return null;
  // `1e999` parses to Infinity, which the schema refused.
  if (typeof since !== "number" || !Number.isFinite(since)) return null;
  return { pid, startIdentity, branch, rootDir, token, since };
};

const isCurrentIdentity = (identity: string | null): identity is string =>
  identity !== null && identity.startsWith(`${START_IDENTITY_FORMAT} `);

/**
 * Is this party gone?
 *
 * A dead PID is gone. A live PID is gone only when BOTH start times are
 * known and differ: the PID was reused. An unknown start time on either side
 * is not evidence of reuse, so it falls back to liveness alone: wrongly
 * keeping a reused-PID holder costs the lock, wrongly reclaiming a live one
 * puts two holders in at once, and the second is what a lock prevents.
 *
 * An unreadable current start is asked about liveness once more: a reused
 * PID held by a short-lived process can pass the first probe and exit before
 * `ps` reads its start, and the first answer is then stale. The recheck is
 * `kill(0)` again, so a process that still runs, but whose start `ps` cannot
 * read, stays live.
 */
export const isGone = (
  party: Pick<Party, "pid" | "startIdentity">,
  system: LivenessSystem,
): boolean => {
  if (!system.isAlive(party.pid)) return true;
  if (!isCurrentIdentity(party.startIdentity)) return false;
  const current = system.startIdentityOf(party.pid);
  if (current === null) return !system.isAlive(party.pid);
  return isCurrentIdentity(current) && current !== party.startIdentity;
};
