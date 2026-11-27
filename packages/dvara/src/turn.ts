// dvara turn: heavy work takes turns through one machine-wide queue.
//
//   dvara turn [--exclusive] [--class push|other] [--label <text>] -- <command> [args…]
//
// A request joins the machine's line, waits for a turn (two by default; an
// exclusive request takes them all), runs the command as its child and gives
// the turn back when it exits. Pushes are served first, then first come first
// served (turn-queue.ts). A waiting request prints a ⏳ line naming the
// holders when it starts waiting and every minute after; at the bound (30
// minutes by default) it runs anyway with a warning. It never exits for
// capacity: its exit status is its command's.
//
// The mode decides whether anything waits. `record`, the default, runs every
// command at once and keeps the same line virtually, so each request records
// who it found and when it would have been served; `enforce` waits; `off`
// runs the command directly and records nothing.
//
// A command already holding a turn passes it to its children
// (`DVARA_TURN_HELD`): a nested request runs at once and never asks again, so
// a nested exclusive request under a shared turn cannot wait on itself. It is
// never upgraded: ask for the widest turn at the outermost level.
//
// State is the machine's alone, under the home directory as `dvara slot`'s is:
// one ticket file per request, judged by its process's liveness, so a dead
// holder or waiter frees its place with no cleanup step. Each decision is
// made under a short lock (`dvara slot`'s, by the same liveness rule). A
// request blocked in enforce mode also writes `waiters/<pid>`, which the hook
// watchdog reads as a wait on the outside world, not a hang. Every request
// appends one JSON line to `turns.jsonl`, from which `dvara turn-replay`
// recomputes the waits at any count.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { defaultLivenessSystem, isGone, type LivenessSystem } from "./liveness.ts";
import {
  exitStatus,
  FORWARDED_SIGNALS,
  tryTakeSlot,
  type SignalSource,
  type SlotChild,
  type SpawnSlotChild,
} from "./slot.ts";
import {
  grants,
  inLine,
  inUse,
  summarize,
  widthOf,
  type Logged,
  type Request,
  type TurnClass,
} from "./turn-queue.ts";

export type TurnMode = "record" | "enforce" | "off";

/** The whole queue directory, as given (tests and measurements). */
export const TURN_DIR_ENV = "DVARA_TURN_DIR";
/** `record`, `enforce` or `off`; wins over the settings file. */
export const TURN_MODE_ENV = "DVARA_TURN_MODE";
/** How many turns the machine has; wins over the settings file. */
export const TURNS_ENV = "DVARA_TURNS";
/** The bound on a wait, in minutes; wins over the settings file. */
export const TURN_WAIT_ENV = "DVARA_TURN_WAIT_MINUTES";
/** Set for a command holding a turn, inherited by its children: the holder's id. */
export const TURN_HELD_ENV = "DVARA_TURN_HELD";
/** The machine's settings, `{ "mode", "turns", "waitMinutes" }`, in the queue directory. */
export const SETTINGS_FILENAME = "settings.json";
/** One JSON line per request. */
export const TURN_LOG_FILENAME = "turns.jsonl";
export const TICKETS_DIRNAME = "tickets";
/**
 * The ticket format. A later format only adds fields, which this one's
 * readers drop, and keeps every field here: dvaras of different versions,
 * pinned by different repositories, share one queue.
 */
export const TICKET_SCHEMA = 1;
export const WAITERS_DIRNAME = "waiters";
/** The short lock each decision is made under: `dvara slot`'s lock, named `queue`. */
export const QUEUE_LOCK_NAME = "queue";
export const DEFAULT_TURNS = 2;
export const DEFAULT_WAIT_MINUTES = 30;
/** How often a waiting request looks again. */
export const POLL_MS = 1000;
/** How often a waiting request says so. */
export const NOTICE_MS = 60_000;
/** How many times a decision tries the queue lock before deciding without it. */
export const LOCK_TRIES = 100;
export const LOCK_RETRY_MS = 10;

export const TURN_USAGE =
  "usage: dvara turn [--exclusive] [--class push|other] [--label <text>] -- <command> [args…]";
export const REPLAY_USAGE =
  "usage: dvara turn-replay [--count N]… [--wait-minutes M] [--since <ISO time>] [--file <turns.jsonl>]";

type Env = Readonly<Record<string, string | undefined>>;

const MODES: readonly unknown[] = ["record", "enforce", "off"];
const isMode = (value: unknown): value is TurnMode => MODES.includes(value);

/** The machine's queue directory: `DVARA_TURN_DIR` when set and not empty, else `~/.dvara/turns/<hostname>`. */
export const turnDirectory = (env: Env): string =>
  env[TURN_DIR_ENV] || join(homedir(), ".dvara", "turns", hostname());

export interface TurnSettings {
  readonly mode: TurnMode;
  readonly turns: number;
  readonly waitMinutes: number;
  /** Why the mode is what it is: `env`, `settings`, `default` or `CI`. */
  readonly reason: string;
}

/** A positive integer, from text or a number, or null. */
const positiveInteger = (value: unknown): number | null => {
  // Text is read as a number; "" reads as 0, which is no count.
  const number = typeof value === "string" ? Number(value) : value;
  return Number.isInteger(number) && (number as number) > 0 ? (number as number) : null;
};

/** CI is any `CI` value but empty, `false` and `0`, as `dvara slot` reads it. */
const isCi = (env: Env): boolean => {
  const ci = env["CI"];
  return ci !== undefined && ci !== "" && ci !== "false" && ci !== "0";
};

/** The settings file's object, or an empty one when it is missing or not an object. */
export const readSettingsFile = (dir: string): Readonly<Record<string, unknown>> => {
  try {
    const value: unknown = JSON.parse(String(readFileSync(join(dir, SETTINGS_FILENAME))));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    // fail-open: no settings, or unreadable ones, are the defaults.
    return {};
  }
};

/** Each setting from the environment, else the settings file, else its default. CI is always `off`. */
export const resolveSettings = (
  env: Env,
  file: Readonly<Record<string, unknown>>,
): TurnSettings => {
  const turns =
    positiveInteger(env[TURNS_ENV]) ?? positiveInteger(file["turns"]) ?? DEFAULT_TURNS;
  const waitMinutes =
    positiveInteger(env[TURN_WAIT_ENV]) ??
    positiveInteger(file["waitMinutes"]) ??
    DEFAULT_WAIT_MINUTES;
  const fromEnv = env[TURN_MODE_ENV];
  const fromFile = file["mode"];
  const [mode, reason]: [TurnMode, string] = isCi(env)
    ? ["off", "CI"]
    : isMode(fromEnv)
      ? [fromEnv, "env"]
      : isMode(fromFile)
        ? [fromFile, "settings"]
        : ["record", "default"];
  return { mode, turns, waitMinutes, reason };
};

/** Who asks: the repository, its worktree when it is a linked one, and the branch. */
export interface Asker {
  readonly repo: string;
  readonly worktree: string | null;
  readonly branch: string | null;
}

/** Runs git in a directory: its trimmed output, or null when it fails. */
export type Git = (cwd: string, args: readonly string[]) => string | null;

/** The real git, with a 5-second limit. */
export const gitIn: Git = (cwd, args) => {
  // Its output and errors are captured, never printed: outside a repository the request still runs.
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
};

/** Who asks from `cwd`, read off git; outside a repository, the folder's name. */
export const whoAsks = (cwd: string, git: Git): Asker => {
  const folder = { repo: basename(cwd), worktree: null, branch: null };
  const paths = git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ]);
  if (paths === null) return folder;
  const [top, common] = paths.split("\n");
  if (common === undefined) return folder;
  const main = basename(common) === ".git" ? dirname(common) : common;
  return {
    repo: basename(main).replace(/\.git$/, ""),
    worktree: top === main ? null : basename(top as string),
    branch: git(cwd, ["branch", "--show-current"]) || null,
  };
};

/** A request's ticket: the request, who holds it, and what it is. */
export interface Ticket extends Request, Asker {
  readonly pid: number;
  readonly startIdentity: string | null;
  readonly label: string;
  readonly overBound: boolean;
}

const isText = (value: unknown): value is string => typeof value === "string";
const isTextOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isTime = (value: unknown): value is number => Number.isFinite(value);

/** JSON text's value, or null when it is not JSON. */
const parseJson = (raw: string): unknown => {
  let value: unknown = null;
  try {
    value = JSON.parse(raw);
  } catch {
    // fail-open: text that is not JSON reads as null, which no reader takes for a record.
  }
  return value;
};

/** Parse a ticket; null for anything that is not a complete one. */
export const parseTicket = (raw: string): Ticket | null => {
  const value = parseJson(raw) as Record<string, unknown> | null;
  // A number or a string destructures to nothing, which the checks refuse.
  if (value === null) return null;
  const { token, pid, startIdentity, askedAt, grantedAt, label, repo, worktree, branch } =
    value;
  const ok =
    isText(token) &&
    token !== "" &&
    typeof pid === "number" &&
    positiveInteger(pid) !== null &&
    isTextOrNull(startIdentity) &&
    (value["class"] === "push" || value["class"] === "other") &&
    typeof value["exclusive"] === "boolean" &&
    isTime(askedAt) &&
    (grantedAt === null || isTime(grantedAt)) &&
    typeof value["overBound"] === "boolean" &&
    isText(label) &&
    isText(repo) &&
    isTextOrNull(worktree) &&
    isTextOrNull(branch);
  if (!ok) return null;
  // Field by field: `schema` and any field a later dvara adds are dropped, so
  // every dvara sharing the machine's queue reads every other's tickets.
  return {
    token,
    pid,
    startIdentity,
    class: value["class"] as TurnClass,
    exclusive: value["exclusive"] as boolean,
    askedAt,
    grantedAt,
    overBound: value["overBound"] as boolean,
    label,
    repo,
    worktree,
    branch,
  };
};

/** The files a queue keeps, in its directory. */
export const ticketPath = (dir: string, token: string): string =>
  join(dir, TICKETS_DIRNAME, `${token}.json`);
export const waiterPath = (dir: string, pid: number): string =>
  join(dir, WAITERS_DIRNAME, String(pid));

/** Write a ticket whole: a reader sees the old one or the new one, never part of one. */
export const writeTicket = (dir: string, ticket: Ticket): void => {
  const path = ticketPath(dir, ticket.token);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify({ schema: TICKET_SCHEMA, ...ticket }), { mode: 0o600 });
  renameSync(temp, path);
};

/** Every readable ticket in the queue. */
export const readTickets = (dir: string): Ticket[] => {
  let names: string[];
  try {
    names = readdirSync(join(dir, TICKETS_DIRNAME));
  } catch {
    // fail-open: no tickets folder is an empty queue.
    return [];
  }
  const tickets: Ticket[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const ticket = parseTicket(String(readFileSync(join(dir, TICKETS_DIRNAME, name))));
      if (ticket !== null) tickets.push(ticket);
    } catch {
      // fail-open: a ticket removed between the listing and the read is no request.
    }
  }
  return tickets;
};

/** Remove a file. Best effort: a ticket or entry left behind names a dead process, which every reader skips. */
const remove = (path: string): void => {
  try {
    rmSync(path);
  } catch {
    // fail-open: the next look by any request drops a dead process's ticket.
  }
};

/**
 * Whether a ticket's process still runs. A ticket's start identity is checked
 * the first time it is seen; after that its pid's liveness is enough, so a
 * waiter polling every second does not read every holder's start each time.
 */
export const liveness = (system: LivenessSystem) => {
  const verified = new Set<string>();
  return (ticket: Ticket): boolean => {
    if (verified.has(ticket.token)) return system.isAlive(ticket.pid);
    if (isGone(ticket, system)) return false;
    verified.add(ticket.token);
    return true;
  };
};

export type Sleep = (ms: number) => Promise<void>;
/** The real sleep. */
export const sleepFor: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Run `decide` under the queue lock. A lock that cannot be had after
 * `LOCK_TRIES` tries is decided without: the queue is a courtesy, and a rare
 * double grant costs less than a request that cannot proceed.
 */
export const underQueueLock = async <T>(
  dir: string,
  system: LivenessSystem,
  sleep: Sleep,
  decide: () => T,
): Promise<T> => {
  for (let attempt = 1; attempt <= LOCK_TRIES; attempt += 1) {
    const lock = tryTakeSlot({ dir, name: QUEUE_LOCK_NAME, cwd: dir, system });
    if (lock.taken)
      try {
        return decide();
      } finally {
        lock.release();
      }
    await sleep(LOCK_RETRY_MS);
  }
  return decide();
};

export interface Look {
  /** This request's ticket as it now stands. */
  readonly me: Ticket;
  /** The other granted requests. */
  readonly holders: readonly Ticket[];
  /** The turns they hold. */
  readonly inUse: number;
  /** This request's place in line, from 1; 0 once granted. */
  readonly place: number;
}

/**
 * Look at the queue once, under its lock: drop the tickets of dead processes,
 * and grant this request if its turn has come (or it waited the bound).
 */
export const look = (
  dir: string,
  me: Ticket,
  settings: TurnSettings,
  now: number,
  alive: (ticket: Ticket) => boolean,
): Look => {
  const others: Ticket[] = [];
  for (const ticket of readTickets(dir)) {
    if (ticket.token === me.token) continue;
    if (alive(ticket)) others.push(ticket);
    else remove(ticketPath(dir, ticket.token));
  }
  let current = me;
  const waitMs = settings.waitMinutes * 60_000;
  const grant = grants([me, ...others], settings.turns, now, waitMs).find(
    (candidate) => candidate.token === me.token,
  );
  // `grants` names waiting requests only, so a granted one is never granted again.
  if (grant !== undefined) {
    current = { ...me, grantedAt: now, overBound: grant.overBound };
    writeTicket(dir, current);
  }
  // Longest held first.
  const holders = others
    .filter((ticket) => ticket.grantedAt !== null)
    .sort((a, b) => (a.grantedAt as number) - (b.grantedAt as number));
  const line = inLine([current, ...others]);
  return {
    me: current,
    holders,
    inUse: inUse(holders, settings.turns),
    place: line.indexOf(current) + 1,
  };
};

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export const ordinal = (n: number): string => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
};

const minutes = (ms: number): number => Math.floor(ms / 60_000);

/** Where a holder works: its worktree, else its branch, else nothing. */
const where = (ticket: Asker): string =>
  ticket.worktree !== null
    ? `(worktree ${ticket.worktree})`
    : ticket.branch !== null
      ? `(branch ${ticket.branch})`
      : "";

/** The ⏳ lines: the count in use, this request's place and wait, then one line per holder. */
export const waitingLines = (
  view: Look,
  settings: TurnSettings,
  now: number,
): string[] => {
  const head =
    `⏳ Waiting for a heavy-work turn (${view.inUse} of ${settings.turns} in use, ` +
    `you are ${ordinal(view.place)} in line); waited ${minutes(now - view.me.askedAt)} min ` +
    `of up to ${settings.waitMinutes}.`;
  const repoWidth = Math.max(0, ...view.holders.map((holder) => holder.repo.length));
  const labelWidth = Math.max(0, ...view.holders.map((holder) => holder.label.length));
  const rows = view.holders.map((holder) =>
    `   ${holder.repo.padEnd(repoWidth)}  ${holder.label.padEnd(labelWidth)}  ` +
    `for ${minutes(now - (holder.grantedAt as number))} min  ${where(holder)}`.trimEnd(),
  );
  return [head, ...rows];
};

export interface TurnArgs {
  readonly exclusive: boolean;
  readonly class: TurnClass;
  /** null: the command, as typed. */
  readonly label: string | null;
  readonly command: readonly string[];
}

/** Parse `[--exclusive] [--class push|other] [--label <text>] -- <command…>`. */
export const parseTurnArgs = (argv: readonly string[]): TurnArgs | { error: string } => {
  const split = argv.indexOf("--");
  if (split < 0 || split === argv.length - 1) return { error: "missing -- <command>" };
  const flags = argv.slice(0, split);
  let exclusive = false;
  let turnClass: TurnClass | null = null;
  let label: string | null = null;
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (flag === "--exclusive" && !exclusive) exclusive = true;
    else if (flag === "--class" && turnClass === null && (value === "push" || value === "other")) {
      turnClass = value;
      i += 1;
    } else if (flag === "--label" && label === null && value !== undefined && value.trim() !== "") {
      label = value;
      i += 1;
    } else return { error: `bad or repeated option ${flag}` };
  }
  return {
    exclusive,
    class: turnClass ?? "other",
    label,
    command: argv.slice(split + 1),
  };
};

/** A label fit for one tab-separated record and one line: whitespace runs become one space, at most 80 characters. */
export const cleanLabel = (text: string): string =>
  text.replace(/\s+/g, " ").trim().slice(0, 80);

/** The hook stage running now: the last marker in `DVARA_STAGE_FILE`, or null outside a hook. */
export const currentStage = (env: Env): string | null => {
  try {
    // Unset or empty, the read fails as a missing file does.
    const last = readFileSync(env["DVARA_STAGE_FILE"] as string, "utf8").trim().split("\n").at(-1);
    return (last as string).split("\t")[1] || null;
  } catch {
    // fail-open: no stage file yet is no stage.
    return null;
  }
};

/** Append one line to a file, creating its folder. Best effort: evidence never fails a run. */
export const appendLine = (path: string, line: string): void => {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${line}\n`);
  } catch {
    // fail-open: the log is evidence for the reading, never an input to a decision.
  }
};

/** What `dvara turn` runs on: replaceable so its wiring is testable in one process. */
export interface TurnWiring {
  readonly system?: LivenessSystem;
  readonly spawn?: SpawnSlotChild;
  readonly signals?: SignalSource;
  readonly sleep?: Sleep;
  readonly git?: Git;
}

export interface TurnContext extends TurnWiring {
  readonly err: (line: string) => void;
  readonly env: Env;
  readonly cwd: string;
}

const realSpawn: SpawnSlotChild = (command, args, options) =>
  spawn(command, [...args], { stdio: options.stdio, env: options.env });

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** SIGINT and SIGTERM, taken for a run: the first one cancels it, and each is passed to its command. */
interface Relay {
  readonly cancelled: () => NodeJS.Signals | null;
  child: SlotChild | undefined;
  close(): void;
}

/** Listen for the forwarded signals. In before anything waits or runs, so no signal takes the default action. */
const relay = (signals: SignalSource): Relay => {
  let cancelled: NodeJS.Signals | null = null;
  const state: Relay = {
    cancelled: () => cancelled,
    child: undefined,
    close: () => {
      for (const signal of FORWARDED_SIGNALS) signals.off(signal, forward);
    },
  };
  const forward = (signal: NodeJS.Signals): void => {
    cancelled ??= signal;
    state.child?.kill(signal);
  };
  for (const signal of FORWARDED_SIGNALS) signals.on(signal, forward);
  return state;
};

/** Run `command` as this process's child, with inherited stdio, and resolve with its exit status. */
const runChild = (
  [command, ...args]: readonly string[],
  env: Record<string, string | undefined>,
  spawnImpl: SpawnSlotChild,
  signals: Relay,
  err: (line: string) => void,
): Promise<number> =>
  new Promise<number>((resolve) => {
    const couldNotStart = (failure: unknown): void => {
      err(`[dvara turn] could not start ${command}: ${message(failure)}`);
      resolve(127);
    };
    try {
      const child = spawnImpl(command as string, args, { stdio: "inherit", env });
      signals.child = child;
      child.once("error", couldNotStart);
      child.once("exit", (exitCode, signal) =>
        resolve(exitStatus(exitCode, signal, signals.cancelled())),
      );
    } catch (failure) {
      // fail-open: spawn refuses some arguments by throwing before it starts anything.
      couldNotStart(failure);
    }
  });

/** `dvara turn …`: resolves with the exit status, which is the command's. */
export const turn = async (argv: readonly string[], context: TurnContext): Promise<number> => {
  const args = parseTurnArgs(argv);
  if ("error" in args) {
    context.err(`dvara turn: ${args.error}`);
    context.err(TURN_USAGE);
    return 2;
  }
  const parsed: TurnArgs = args;
  const { env, cwd, err } = context;
  const spawnImpl = context.spawn ?? realSpawn;
  const signals = relay(context.signals ?? process);
  const dir = turnDirectory(env);
  const settings = resolveSettings(env, readSettingsFile(dir));
  if (settings.mode === "off")
    try {
      return await runChild(parsed.command, { ...env }, spawnImpl, signals, err);
    } finally {
      signals.close();
    }
  const real = context.system ?? defaultLivenessSystem;
  const sleep = context.sleep ?? sleepFor;
  const outer = env[TURN_HELD_ENV];
  const nested = outer !== undefined && outer !== "";
  const token = randomBytes(12).toString("hex");
  // One reading of this process's start: the queue lock asks for it at every look.
  const ownStart = real.startIdentityOf(real.pid);
  const system: LivenessSystem = {
    pid: real.pid,
    now: () => real.now(),
    isAlive: (pid) => real.isAlive(pid),
    startIdentityOf: (pid) => (pid === real.pid ? ownStart : real.startIdentityOf(pid)),
  };
  const askedAt = system.now();
  const label = cleanLabel(parsed.label ?? parsed.command.join(" "));
  const asker = whoAsks(cwd, context.git ?? gitIn);
  let me: Ticket = {
    token,
    pid: system.pid,
    startIdentity: ownStart,
    class: parsed.class,
    exclusive: parsed.exclusive,
    askedAt,
    grantedAt: null,
    overBound: false,
    label,
    ...asker,
  };
  let found: Look | null = null;
  let error: string | null = null;
  const queued = !nested;
  const alive = liveness(system);
  const lookNow = async (): Promise<Look> => {
    const view = await underQueueLock(dir, system, sleep, () =>
      look(dir, me, settings, system.now(), alive),
    );
    me = view.me;
    return view;
  };
  let startedAt = askedAt;
  let code: number;
  try {
    if (queued) {
      try {
        writeTicket(dir, me);
        found = await lookNow();
        if (settings.mode === "enforce" && me.grantedAt === null)
          await waitForTurn(found);
        else if (me.grantedAt === null)
          err(
            `[dvara turn] record mode: would wait for a heavy-work turn (${found.inUse} of ${settings.turns} in use, you are ${ordinal(found.place)} in line); running now.`,
          );
      } catch (failure) {
        // fail-open: the queue is a courtesy; a request it cannot serve runs at once.
        error = message(failure);
        err(`[dvara turn] queue unavailable (${error}); running without a turn`);
      }
    }
    const cancelled = signals.cancelled();
    if (cancelled !== null) code = exitStatus(null, cancelled);
    else {
      startedAt = system.now();
      code = await runCommand();
    }
  } finally {
    signals.close();
    remove(ticketPath(dir, token));
  }

  /** Enforce mode: wait in line, saying so every minute, until granted, cancelled or at the bound. */
  async function waitForTurn(first: Look): Promise<void> {
    const waiter = waiterPath(dir, system.pid);
    mkdirSync(dirname(waiter), { recursive: true, mode: 0o700 });
    writeFileSync(waiter, ownStart ?? "");
    try {
      let noticeAt = Number.NEGATIVE_INFINITY;
      let view = first;
      while (me.grantedAt === null && signals.cancelled() === null) {
        const now = system.now();
        if (now - noticeAt >= NOTICE_MS) {
          for (const line of waitingLines(view, settings, now)) err(line);
          noticeAt = now;
        }
        await sleep(POLL_MS);
        view = await lookNow();
      }
    } finally {
      remove(waiter);
    }
    if (me.overBound)
      err(
        `⚠️  [dvara turn] waited ${settings.waitMinutes} min for a heavy-work turn; running anyway.`,
      );
  }

  /** Run the command; in record mode, keep the virtual place in line meanwhile. */
  async function runCommand(): Promise<number> {
    const childEnv = { ...env, [TURN_HELD_ENV]: nested ? outer : token };
    let running = true;
    const exited = runChild(parsed.command, childEnv, spawnImpl, signals, err).finally(() => {
      running = false;
    });
    const virtual = async (): Promise<void> => {
      // A granted request leaves at once.
      while (running && me.grantedAt === null) {
        // The command's exit ends the wait at once: it must not hold up the exit status.
        await Promise.race([sleep(POLL_MS), exited]);
        if (running) await lookNow();
      }
    };
    const watching =
      queued && error === null
        ? virtual().catch(() => {
            // fail-open: the virtual line is evidence; losing it leaves the grant null, never the command's status.
          })
        : Promise.resolve();
    const status = await exited;
    await watching;
    return status;
  }

  const endedAt = system.now();
  {
    const event = {
      schema: 1,
      ts: new Date(endedAt).toISOString(),
      id: token,
      pid: system.pid,
      mode: settings.mode,
      turns: settings.turns,
      waitMinutes: settings.waitMinutes,
      class: parsed.class,
      exclusive: parsed.exclusive,
      width: widthOf(parsed, settings.turns),
      nested,
      outer: nested ? outer : null,
      label,
      repo: asker.repo,
      worktree: asker.worktree,
      branch: asker.branch,
      cwd,
      hook: env["DVARA_MEASURED_HOOK"] ?? null,
      stage: currentStage(env),
      askedAt,
      grantedAt: me.grantedAt,
      startedAt,
      endedAt,
      waitedMs: startedAt - askedAt,
      wouldWaitMs: me.grantedAt === null ? null : me.grantedAt - askedAt,
      ranAnyway: me.overBound,
      ahead: found === null ? 0 : Math.max(0, found.place - 1),
      holders: (found?.holders ?? []).map((holder) => ({
        id: holder.token,
        pid: holder.pid,
        repo: holder.repo,
        worktree: holder.worktree,
        branch: holder.branch,
        label: holder.label,
        class: holder.class,
        exclusive: holder.exclusive,
        heldMs: askedAt - (holder.grantedAt as number),
      })),
      exitCode: code,
      signal: signals.cancelled(),
      error,
    };
    appendLine(join(dir, TURN_LOG_FILENAME), JSON.stringify(event));
    // Outside a hook there is no records file, and the append fails as for a missing one.
    appendLine(
        env["DVARA_RECORD_FILE"] as string,
        [
          "turn",
          event.stage ?? "",
          label,
          parsed.class,
          parsed.exclusive ? "exclusive" : "shared",
          settings.mode,
          event.waitedMs,
          event.wouldWaitMs ?? "",
          event.ranAnyway ? 1 : 0,
          nested ? 1 : 0,
        ].join("\t"),
      );
  }
  return code;
};

/** Whether any of `pids` is a request blocked in the queue: a waiter entry whose start identity still matches. */
export const queuedPids = (
  dir: string,
  pids: readonly number[],
  system: Pick<LivenessSystem, "startIdentityOf">,
): boolean =>
  pids.some((pid) => {
    let recorded: string;
    try {
      recorded = readFileSync(waiterPath(dir, pid), "utf8");
    } catch {
      // fail-open: no entry is no waiter.
      return false;
    }
    // An entry with no identity cannot be told from a reused pid; it spares, which is the safe side.
    return recorded === "" || system.startIdentityOf(pid) === recorded;
  });

export interface ReplayArgs {
  readonly counts: readonly number[];
  readonly waitMinutes: number;
  readonly since: number;
  readonly file: string | null;
}

/** Parse `[--count N]… [--wait-minutes M] [--since <ISO>] [--file <path>]`. */
export const parseReplayArgs = (argv: readonly string[]): ReplayArgs | { error: string } => {
  const counts: number[] = [];
  let waitMinutes: number | null = null;
  let since: number | null = null;
  let file: string | null = null;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1] ?? "";
    const n = positiveInteger(value);
    const at = Date.parse(value);
    if (flag === "--count" && n !== null) counts.push(n);
    else if (flag === "--wait-minutes" && waitMinutes === null && n !== null) waitMinutes = n;
    else if (flag === "--since" && since === null && Number.isFinite(at)) since = at;
    else if (flag === "--file" && file === null && value !== "") file = value;
    else return { error: `bad or repeated option ${flag} ${value}`.trimEnd() };
  }
  return {
    counts: counts.length === 0 ? [1, 2, 3] : counts,
    waitMinutes: waitMinutes ?? DEFAULT_WAIT_MINUTES,
    since: since ?? Number.NEGATIVE_INFINITY,
    file,
  };
};

/** The log's requests a replay counts: outermost ones that asked, since `since`. */
export const replayable = (text: string, since: number): Logged[] => {
  const lines: Logged[] = [];
  for (const line of text.split("\n")) {
    // A torn or blank line reads as null: no request.
    const value = parseJson(line) as Record<string, unknown> | null;
    const { id, askedAt, startedAt, endedAt } = value ?? {};
    if (
      value?.["nested"] === false &&
      isText(id) &&
      (value["class"] === "push" || value["class"] === "other") &&
      isTime(askedAt) &&
      isTime(startedAt) &&
      isTime(endedAt) &&
      askedAt >= since
    )
      lines.push({
        id,
        class: value["class"],
        exclusive: value["exclusive"] === true,
        askedAt,
        startedAt,
        endedAt,
      });
  }
  return lines;
};

/** `dvara turn-replay …`: one JSON summary per count, from the machine's log. */
export const turnReplay = (
  argv: readonly string[],
  context: { readonly out: (line: string) => void; readonly err: (line: string) => void; readonly env: Env },
): number => {
  const parsed = parseReplayArgs(argv);
  if ("error" in parsed) {
    context.err(`dvara turn-replay: ${parsed.error}`);
    context.err(REPLAY_USAGE);
    return 2;
  }
  const file = parsed.file ?? join(turnDirectory(context.env), TURN_LOG_FILENAME);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (failure) {
    // fail-open: no log to replay is reported, and the command exits 1.
    context.err(`dvara turn-replay: cannot read ${file}: ${message(failure)}`);
    return 1;
  }
  const lines = replayable(text, parsed.since);
  for (const count of parsed.counts)
    context.out(JSON.stringify(summarize(lines, count, parsed.waitMinutes * 60_000)));
  return 0;
};
