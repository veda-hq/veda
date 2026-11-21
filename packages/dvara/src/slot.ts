// dvara slot: one named slot per machine, tried once when a command starts.
//
//   dvara slot --name <name> [--dir <dir>] [--set NAME=VALUE]… [--unset NAME]… -- <command> [args…]
//
// When the command starts it tries, ONCE, to take the machine's slot
// `<name>`. If the slot is free it runs the command with each `--set`
// variable added and holds the slot until the command exits. If another run
// holds it, or anything fails, the command runs without them. Nothing ever
// waits for a slot, and failing to take one is never an error. Every run
// removes each `--unset` variable from the command's environment, slot or no
// slot.
//
// The slot is a lock file, taken with `link` (atomic: it refuses an existing
// name) and released on exit. A holder that died without releasing is
// reclaimed by the next run, by the gate lock's liveness rule (`isGone`: a
// dead PID, or a reused PID by start time). Reclaim happens under a
// short-lived reclaim directory and re-judges the holder inside it, so two
// runs that both find a dead holder cannot each remove the other's fresh lock.
//
// Ported from the plateau-slot wrapper of the repository that first ran it. Runs on
// that code and runs of this one hold the same lock: the file names, the
// record and the protocol are the same, byte for byte.
//
// The slot is never tried in CI, when a `--set` name is already in the
// environment (an explicit value wins), or with `DVARA_SLOT=off`.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  defaultLivenessSystem,
  errorCode,
  isGone,
  parseParty,
  UNREADABLE_GRACE_MS,
  type LivenessSystem,
  type Party,
} from "./liveness.ts";

/** A slot's lock file inside the slot directory. */
export const lockFilename = (name: string): string => `${name}.lock`;
/** Held only while a dead holder's lock for that slot is being removed. */
export const reclaimDirname = (name: string): string => `${name}.reclaim`;
/** One JSON line per start: whether it took the slot. Evidence, never read to decide. */
export const SLOT_LOG_FILENAME = "slots.jsonl";
/** A reclaim directory older than this was abandoned by a crashed reclaimer. */
export const RECLAIM_STALE_MS = 30_000;
/** Set to `off` to run without ever taking a slot. */
export const SLOT_SWITCH_ENV = "DVARA_SLOT";
/** The whole slot directory, as given, with no hostname appended (tests and measurements). */
export const SLOT_DIR_ENV = "DVARA_SLOT_DIR";
/** Where the per-machine slot directories live when `--dir` is not given. */
export const DEFAULT_SLOT_DIR = "~/.dvara/slots";

export const SLOT_USAGE =
  "usage: dvara slot --name <name> [--dir <dir>] [--set NAME=VALUE]… [--unset NAME]… -- <command> [args…]";

/** A slot name: also the lock's file name. */
const SLOT_NAME = /^[a-z][a-z0-9-]*$/;
/** An environment variable name, as `--set` and `--unset` take one. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Env = Readonly<Record<string, string | undefined>>;

/** The filesystem calls a fault can be injected into; everything else is the real directory. */
export interface SlotFiles {
  link(existing: string, path: string): void;
  rm(path: string, options: { recursive?: boolean; force: boolean }): void;
}

const realFiles: SlotFiles = {
  link: (existing, path) => {
    linkSync(existing, path);
  },
  rm: (path, options) => {
    rmSync(path, options);
  },
};

/**
 * The machine's slot directory: `DVARA_SLOT_DIR` as given when it is set and
 * not empty, else `<dir>/<hostname>`, a leading `~` read as the home directory.
 */
export const slotDirectory = (dir: string, env: Env): string => {
  const override = env[SLOT_DIR_ENV];
  if (override !== undefined && override !== "") return override;
  const base =
    dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : dir;
  return join(base, hostname());
};

/** CI is any `CI` value but empty, `false` and `0`: the rule plateau-slot.ts applied. */
const isCi = (env: Env): boolean => {
  const ci = env["CI"];
  return ci !== undefined && ci !== "" && ci !== "false" && ci !== "0";
};

/** Why the slot is not even tried, or `null` when it should be. */
export const skipReason = (env: Env, setNames: readonly string[]): string | null => {
  if (isCi(env)) return "CI";
  const preset = setNames.find((name) => env[name] !== undefined);
  if (preset !== undefined) return `${preset} already set`;
  if (env[SLOT_SWITCH_ENV] === "off") return `${SLOT_SWITCH_ENV}=off`;
  return null;
};

export type SlotAttempt =
  | { readonly taken: true; readonly release: () => void }
  | {
      readonly taken: false;
      /** Who holds it, when that could be read. */
      readonly holder: Party | null;
      readonly reason: string;
    };

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
};

const ageMs = (path: string, now: number): number | null => {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    // fail-open: a file gone before it could be read has no age; the caller reads null as fresh.
    return null;
  }
};

/** Create the lock atomically from a complete record. False when the name already exists. */
const linkLock = (
  lock: string,
  record: string,
  token: string,
  files: SlotFiles,
): boolean => {
  const temp = `${lock}.${token}.tmp`;
  writeFileSync(temp, record, { mode: 0o600 });
  try {
    files.link(temp, lock);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    files.rm(temp, { force: true });
  }
};

/**
 * Remove the lock if it still holds exactly `seen` and is still stale, under
 * the reclaim directory. False when another reclaimer is at work or the
 * holder changed.
 */
const reclaim = (
  guard: string,
  lock: string,
  seen: string,
  stillStale: (raw: string) => boolean,
  system: LivenessSystem,
  files: SlotFiles,
): boolean => {
  try {
    mkdirSync(guard);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const age = ageMs(guard, system.now());
    if (age !== null && age > RECLAIM_STALE_MS)
      files.rm(guard, { recursive: true, force: true });
    return false;
  }
  try {
    const now = readOrNull(lock);
    if (now !== seen || !stillStale(now)) return false;
    unlinkSync(lock);
    return true;
  } finally {
    files.rm(guard, { recursive: true, force: true });
  }
};

export interface TakeOptions {
  /** The machine's slot directory. Created if absent. */
  readonly dir: string;
  readonly name: string;
  /** Recorded as the holder's `rootDir`. */
  readonly cwd: string;
  readonly system: LivenessSystem;
  readonly files?: SlotFiles;
}

/** Try the slot once. Never waits. */
export const tryTakeSlot = (options: TakeOptions): SlotAttempt => {
  const { dir, name, cwd, system } = options;
  const files = options.files ?? realFiles;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, lockFilename(name));
  const guard = join(dir, reclaimDirname(name));
  const token = randomBytes(12).toString("hex");
  // The gate lock's record, key for key and in its order, so a run on the old
  // code parses it and judges it by the same rule. `branch` carries the slot's name.
  const me: Party = {
    pid: system.pid,
    startIdentity: system.startIdentityOf(system.pid),
    branch: name,
    rootDir: cwd,
    token,
    since: system.now(),
  };
  const record = JSON.stringify(me);
  const release = (): void => {
    const raw = readOrNull(lock);
    if (raw !== null && parseParty(raw)?.token === token)
      files.rm(lock, { force: true });
  };

  // Two attempts: the second only after removing a dead holder's lock.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (linkLock(lock, record, token, files)) return { taken: true, release };
    const raw = readOrNull(lock);
    if (raw === null) continue; // Released between our link and our read: try again.
    const holder = parseParty(raw);
    if (holder !== null) {
      if (!isGone(holder, system))
        return {
          taken: false,
          holder,
          reason: `held by pid ${holder.pid} (${holder.branch})`,
        };
      const stillGone = (r: string): boolean => {
        const p = parseParty(r);
        return p !== null && isGone(p, system);
      };
      if (!reclaim(guard, lock, raw, stillGone, system, files))
        return { taken: false, holder, reason: "a dead holder is being reclaimed" };
      continue;
    }
    // Unreadable. Holders are linked into place complete, so this is
    // corruption; the grace period only guards against a clock-skewed mtime.
    const age = ageMs(lock, system.now());
    if (age === null || age <= UNREADABLE_GRACE_MS)
      return { taken: false, holder: null, reason: "unreadable holder" };
    if (!reclaim(guard, lock, raw, () => true, system, files))
      return { taken: false, holder: null, reason: "unreadable holder" };
  }
  return { taken: false, holder: null, reason: "contended" };
};

export interface SlotArgs {
  readonly name: string;
  readonly dir: string;
  /** The variables the command gets with the slot, in the order given. */
  readonly set: ReadonlyArray<readonly [string, string]>;
  /** The variables the command never gets. */
  readonly unset: readonly string[];
  readonly command: readonly string[];
}

/** Parse `--name <name> [--dir <dir>] [--set N=V]… [--unset N]… -- <command…>`. */
export const parseSlotArgs = (argv: readonly string[]): SlotArgs | { error: string } => {
  const split = argv.indexOf("--");
  if (split < 0 || split === argv.length - 1) return { error: "missing -- <command>" };
  const flags = argv.slice(0, split);
  let name: string | null = null;
  let dir: string | null = null;
  const set: Array<readonly [string, string]> = [];
  const unset: string[] = [];
  const named = new Set<string>();
  /** A variable name not yet given to `--set` or `--unset`. */
  const fresh = (variable: string): boolean =>
    ENV_NAME.test(variable) && !named.has(variable);
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i] ?? "";
    const value = flags[i + 1];
    if (value === undefined || value.startsWith("--"))
      return { error: `${flag} needs a value` };
    const eq = value.indexOf("=");
    const variable = eq < 0 ? value : value.slice(0, eq);
    if (flag === "--name" && name === null && SLOT_NAME.test(value)) name = value;
    else if (flag === "--dir" && dir === null && value !== "") dir = value;
    else if (flag === "--set" && eq > 0 && fresh(variable)) {
      named.add(variable);
      set.push([variable, value.slice(eq + 1)]);
    } else if (flag === "--unset" && fresh(value)) {
      named.add(value);
      unset.push(value);
    } else return { error: `bad or repeated option ${flag} ${value}` };
  }
  if (name === null) return { error: "--name is required" };
  return {
    name,
    dir: dir ?? DEFAULT_SLOT_DIR,
    set,
    unset,
    command: argv.slice(split + 1),
  };
};

export interface SlotDecision {
  /** The machine's slot directory, where the log goes too. */
  readonly dir: string;
  /** The environment to run the command with. */
  readonly childEnv: Record<string, string | undefined>;
  /** Called once the command has exited. */
  readonly release: () => void;
  /** One line for the person watching the run. */
  readonly line: string;
  /** The JSON line for the slot log. */
  readonly event: Record<string, unknown>;
}

export interface DecideContext {
  readonly env: Env;
  readonly cwd: string;
  readonly system: LivenessSystem;
  readonly files?: SlotFiles;
}

const noRelease = (): void => undefined;

/** Decide how the command runs: with the slot and its variables, or without. */
export const decide = (args: SlotArgs, context: DecideContext): SlotDecision => {
  const { env, cwd, system } = context;
  const dir = slotDirectory(args.dir, env);
  const base = {
    ts: new Date(system.now()).toISOString(),
    name: args.name,
    pid: system.pid,
  };
  const prefix = `[dvara slot] ${args.name}:`;
  const childEnv: Record<string, string | undefined> = { ...env };
  // An inherited value of an unset variable would beat what the slot decided.
  for (const variable of args.unset) delete childEnv[variable];
  const skip = skipReason(env, args.set.map(([variable]) => variable));
  if (skip !== null)
    return {
      dir,
      childEnv,
      release: noRelease,
      line: `${prefix} slot not tried (${skip})`,
      event: { ...base, taken: false, reason: skip },
    };
  let attempt: SlotAttempt;
  try {
    attempt = tryTakeSlot({
      dir,
      name: args.name,
      cwd,
      system,
      ...(context.files ? { files: context.files } : {}),
    });
  } catch (error) {
    // fail-open: the slot is a speed-up, never a precondition; any failure runs without it.
    const reason = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
    return {
      dir,
      childEnv,
      release: noRelease,
      line: `${prefix} slot ${reason}; running without it`,
      event: { ...base, taken: false, reason },
    };
  }
  if (attempt.taken) {
    for (const [variable, value] of args.set) childEnv[variable] = value;
    return {
      dir,
      childEnv,
      release: attempt.release,
      line: `${prefix} took the slot`,
      event: { ...base, taken: true, set: Object.fromEntries(args.set) },
    };
  }
  return {
    dir,
    childEnv,
    release: noRelease,
    line: `${prefix} slot ${attempt.reason}; running without it`,
    event: {
      ...base,
      taken: false,
      reason: attempt.reason,
      holder: attempt.holder && {
        pid: attempt.holder.pid,
        name: attempt.holder.branch,
      },
    },
  };
};

/** Append the event to the slot log. Best effort: evidence must never fail a run. */
export const recordEvent = (dir: string, event: Record<string, unknown>): void => {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, SLOT_LOG_FILENAME), `${JSON.stringify(event)}\n`);
  } catch {
    // fail-open: the log is evidence for later measurement, not an input to any decision.
  }
};

/** Signal numbers for the exit status of a command killed by a signal (128 + n). */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGKILL: 9,
  SIGTERM: 15,
};

/**
 * The exit status for a command that ended with `code` or `signal`. A signal
 * dvara forwarded wins over the command's own code, so an interrupted run is
 * never reported as a pass.
 */
export const exitStatus = (
  code: number | null,
  signal: string | null,
  forwarded: string | null = null,
): number => {
  const cause = forwarded ?? (code === null ? signal : null);
  if (cause === null) return code ?? 128;
  return 128 + (SIGNAL_NUMBERS[cause] ?? 0);
};

/** The signals passed on to the command. */
export const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type Forwarded = (typeof FORWARDED_SIGNALS)[number];

/** The running command, as far as the slot needs it. */
export interface SlotChild {
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export type SpawnSlotChild = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: "inherit"; readonly env: Record<string, string | undefined> },
) => SlotChild;

/** Where the forwarded signals arrive: the process, or a test's emitter. */
export interface SignalSource {
  on(signal: Forwarded, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: Forwarded, listener: (signal: NodeJS.Signals) => void): unknown;
}

/** What `dvara slot` runs on: replaceable so its wiring is testable in one process. */
export interface SlotWiring {
  readonly system?: LivenessSystem;
  readonly spawn?: SpawnSlotChild;
  readonly signals?: SignalSource;
  readonly files?: SlotFiles;
}

export interface SlotContext extends SlotWiring {
  readonly err: (line: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

const realSpawn: SpawnSlotChild = (command, args, options) =>
  spawn(command, [...args], { stdio: options.stdio, env: options.env });

/** `dvara slot …`: resolves with the exit status. */
export const slot = async (
  argv: readonly string[],
  context: SlotContext,
): Promise<number> => {
  const parsed = parseSlotArgs(argv);
  if ("error" in parsed) {
    context.err(`dvara slot: ${parsed.error}`);
    context.err(SLOT_USAGE);
    return 2;
  }
  const decision = decide(parsed, {
    env: context.env,
    cwd: context.cwd,
    system: context.system ?? defaultLivenessSystem,
    ...(context.files ? { files: context.files } : {}),
  });
  context.err(decision.line);
  recordEvent(decision.dir, decision.event);
  const [command = "", ...rest] = parsed.command;
  const signals: SignalSource = context.signals ?? process;
  // A cancelled run must never report success: once a signal was forwarded,
  // it decides the exit status even if the command handled it and exited 0.
  // The handlers go in before the spawn, so no signal can take the default
  // action and orphan a running command.
  let forwarded: NodeJS.Signals | null = null;
  let child: SlotChild | undefined;
  const forward = (signal: NodeJS.Signals): void => {
    forwarded ??= signal;
    child?.kill(signal);
  };
  for (const signal of FORWARDED_SIGNALS) signals.on(signal, forward);
  const couldNotStart = (error: unknown): number => {
    context.err(
      `[dvara slot] could not start ${command}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 127;
  };
  try {
    let started: SlotChild;
    try {
      started = (context.spawn ?? realSpawn)(command, rest, {
        stdio: "inherit",
        env: decision.childEnv,
      });
    } catch (error) {
      // fail-open: spawn refuses some arguments by throwing before it starts
      // anything; the run then exits 127, as for a command that cannot start.
      return couldNotStart(error);
    }
    child = started;
    return await new Promise<number>((resolve) => {
      started.once("error", (error) => resolve(couldNotStart(error)));
      started.once("exit", (code, signal) => resolve(exitStatus(code, signal, forwarded)));
    });
  } finally {
    for (const signal of FORWARDED_SIGNALS) signals.off(signal, forward);
    try {
      decision.release();
    } catch (error) {
      // fail-open: the slot is advisory, and a lock left behind is reclaimed
      // once its holder is gone; the command's own exit status stands.
      context.err(
        `[dvara slot] could not release the slot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
};
