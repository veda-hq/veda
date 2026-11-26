/**
 * dvara's built-in watchdog (`"watchdog": "dvara"`): stops a hook that is
 * provably deadlocked, and never a hook that is slow.
 *
 * It was built after two pushes sat 88 and 18 minutes in one test stage. A
 * test worker was blocked in `execFileSync` writing a child's stdin while the
 * child waited in `read()` for EOF: both at 0% CPU, each waiting only on the
 * other, and nothing in the hook could time them out.
 *
 * The rule is built so that "quiet" alone never kills. A kill needs POSITIVE
 * evidence of a deadlock: after a long quiet window, some leaf process whose
 * every open IPC channel leads to another idle process inside the same tree,
 * and none of whose processes still has a live child outside that set: a
 * parent waits on its children's exit, which `lsof` never shows (2026-11-26:
 * a push was killed while a child polled for a lock another worktree held).
 * Anything waiting on the outside world (a network peer, the Docker daemon, a
 * database, a terminal) or on an opaque or timed wait (`sleep`, Xcode's XPC
 * services) is spared. A missing or unreadable measurement is also never
 * evidence.
 *
 * Pure functions (parsing, classification, decisions) are exported for tests;
 * the effectful part (`createWatchdog`) takes its `exec` and `clock` by
 * injection and registers no signal handlers: the supervisor owns signals.
 */
import { execFile } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Quiet this long before the deadlock check runs: twice a 300 s test timeout. */
export const DEFAULT_IDLE_MS = 600_000;
/** Quiet this long while waiting on something external before warning: above the longest outside wait a hook is expected to make. */
export const DEFAULT_EXTERNAL_IDLE_MS = 3_600_000;
export const DEFAULT_SAMPLE_MS = 5000;
export const DEFAULT_GRACE_MS = 10_000;
/** Node's `setTimeout` ceiling; a larger delay overflows and fires immediately. */
export const MAX_TIMER_MS = 2_147_483_647;
/** GNU timeout(1)'s status for "the deadline expired". */
export const WATCHDOG_EXIT_CODE = 124;
/** How long diagnostics of past hangs are kept. */
export const HANG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Whether enforce mode is verified on CPUs with efficiency cores (M1-class
 * Macs). Flip only once fixtures captured on such a machine are committed
 * under `fixtures/watchdog/` and pass the tests.
 */
export const EFFICIENCY_CORE_ENFORCE_VERIFIED = false;

/** The modes `DVARA_WATCHDOG` may set. */
export type ExplicitMode = "enforce" | "report" | "off";
export type WatchdogMode = ExplicitMode | "unsupported";

const MODES: readonly (string | undefined)[] = ["enforce", "report", "off"];
const isMode = (value: string | undefined): value is ExplicitMode =>
  MODES.includes(value);

/**
 * Processes whose waits `lsof` cannot see (XPC/Mach ports) or that are timed
 * and finish on their own. Their presence anywhere in the tree rules out a
 * deadlock verdict.
 */
export const EXEMPT_COMMANDS =
  /(?:^|\/)(?:sleep|xcodebuild|xcrun|simctl|actool|ibtool|SWBBuildService|XCBBuildService|docker|docker-buildx|com\.docker\.cli|osascript|pod)$/;

/** TCP states that no longer carry a live wait on a peer. */
const CLOSED_TCP = new Set([
  "CLOSE_WAIT",
  "TIME_WAIT",
  "FIN_WAIT_1",
  "FIN_WAIT_2",
  "CLOSED",
  "LAST_ACK",
  "CLOSING",
]);
/** fd types that are not a channel to another process. */
const NON_IPC_TYPES = new Set([
  "REG",
  "DIR",
  "CHR",
  "KQUEUE",
  "systm",
  "NPOLICY",
  "NEXUS",
  "CHAN",
  "PSXSHM",
  "PSXSEM",
  "ATALK",
  "FSEVENT",
]);

export interface WatchdogConfig {
  readonly mode: WatchdogMode;
  /** Why the mode is what it is: explicit, default, non-darwin or efficiency-cores-unverified. */
  readonly reason: string;
  readonly idleMs: number;
  readonly externalIdleMs: number;
  readonly sampleMs: number;
  readonly graceMs: number;
  readonly cpuQuietMs: number;
}

function positiveMs(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  const usable = Number.isInteger(value) && value > 0;
  return Math.min(usable ? value : fallback, MAX_TIMER_MS);
}

/**
 * Resolve the watchdog's configuration.
 *
 * An explicit `DVARA_WATCHDOG` is honoured as written. With it unset the
 * default is `enforce`, except on a CPU with efficiency cores while that is
 * unverified, where it is `report`. Non-macOS platforms are `unsupported`: the
 * fd rules are written against macOS `lsof`. Numeric settings
 * (`DVARA_WATCHDOG_IDLE_MS`, `_EXTERNAL_IDLE_MS`, `_SAMPLE_MS`, `_GRACE_MS`)
 * fall back to the default for anything but a positive integer, so `0` never
 * means "no limit".
 */
export function resolveWatchdogConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  perfLevelNames: readonly string[] = [],
): WatchdogConfig {
  const requested = env.DVARA_WATCHDOG;
  const explicit = isMode(requested) ? requested : null;
  let mode: WatchdogMode = explicit ?? "enforce";
  let reason = explicit ? "explicit" : "default";
  if (mode !== "off" && platform !== "darwin") {
    mode = "unsupported";
    reason = "non-darwin";
  } else if (
    !explicit &&
    !EFFICIENCY_CORE_ENFORCE_VERIFIED &&
    perfLevelNames.some((name) => /efficiency/i.test(name))
  ) {
    mode = "report";
    reason = "efficiency-cores-unverified";
  }
  const idleMs = positiveMs(env.DVARA_WATCHDOG_IDLE_MS, DEFAULT_IDLE_MS);
  return {
    mode,
    reason,
    idleMs,
    externalIdleMs: Math.max(
      idleMs,
      positiveMs(env.DVARA_WATCHDOG_EXTERNAL_IDLE_MS, DEFAULT_EXTERNAL_IDLE_MS),
    ),
    sampleMs: positiveMs(env.DVARA_WATCHDOG_SAMPLE_MS, DEFAULT_SAMPLE_MS),
    graceMs: positiveMs(env.DVARA_WATCHDOG_GRACE_MS, DEFAULT_GRACE_MS),
    // CPU the whole tree may spend in one quiet window and still count as
    // quiet: a hung tree's bookkeeping (a runner's timer tick) is not work.
    // Absolute, so it means the same on 10 and 18 cores.
    cpuQuietMs: Math.max(1000, Math.round(idleMs * 0.002)),
  };
}

/** macOS `ps` CPU time (`M:SS.cc`, minutes may exceed 59) or `[D-]HH:MM:SS[.cc]`, in ms; null if unreadable. */
export function parseCpuTime(text: string): number | null {
  const short = /^(\d+):(\d{2})\.(\d{2})$/.exec(text);
  if (short)
    return (
      (Number(short[1]) * 60 + Number(short[2])) * 1000 + Number(short[3]) * 10
    );
  const long = /^(?:(\d+)-)?(\d+):(\d{2}):(\d{2})(?:\.(\d{2}))?$/.exec(text);
  if (long)
    return (
      ((Number(long[1] ?? 0) * 24 + Number(long[2])) * 3600 +
        Number(long[3]) * 60 +
        Number(long[4])) *
        1000 +
      Number(long[5] ?? 0) * 10
    );
  return null;
}

/** One process in a `ps` snapshot. `key` (pid and start time) survives pid reuse. */
export interface PsRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly state: string;
  readonly cpuMs: number;
  readonly started: string;
  readonly comm: string;
  readonly key: string;
}

export const PS_ARGS = ["-axo", "pid=,ppid=,pgid=,state=,time=,lstart=,comm="];
const PS_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;

/**
 * Parse `ps -axo pid=,ppid=,pgid=,state=,time=,lstart=,comm=`.
 * A row that does not parse is kept as `malformed`, never read as a quiet,
 * zero-CPU process.
 */
export function parsePs(text: string): {
  rows: PsRow[];
  malformed: number;
} {
  const rows: PsRow[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = PS_ROW.exec(line);
    const cpuMs = m ? parseCpuTime(String(m[5])) : null;
    if (!m || cpuMs === null) {
      malformed++;
      continue;
    }
    // Every group of PS_ROW is mandatory, so each one matched.
    const [, pid, ppid, pgid, state, , lstart, comm] = m.map(String);
    const started = String(lstart).replace(/\s+/g, " ");
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      state: String(state),
      cpuMs,
      started,
      comm: String(comm),
      key: `${pid}@${started}`,
    });
  }
  return { rows, malformed };
}

/** Every process descending from `rootPid` (inclusive), by parent pid. */
export function buildTree(rows: readonly PsRow[], rootPid: number): PsRow[] {
  const children = new Map<number, PsRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return [];
  const tree = [root];
  // The iterator reads the length each step, so the rows pushed are visited too.
  for (const parent of tree) {
    for (const child of children.get(parent.pid) ?? []) {
      if (child.pid !== parent.pid) tree.push(child);
    }
  }
  return tree;
}

/** The quiet window `advanceWindow` keeps between observations. */
export interface QuietWindow {
  readonly quietSince: number;
  readonly lastAt: number;
  readonly lastWallAt: number;
  readonly members: string;
  readonly stageBytes: number;
  readonly baseCpu: ReadonlyMap<string, number>;
  readonly windowCpuMs: number;
  /** When the deadlock check last ran in this window; the watchdog sets it. */
  lastCheckAt: number | null;
  /** Each process's CPU at that check, by key; the watchdog sets it. */
  checkCpu: ReadonlyMap<string, number> | null;
  readonly resetReason: string | null;
}

export interface Observation {
  /** Monotonic time, in ms. */
  readonly at: number;
  /** Wall-clock time, in ms. */
  readonly wallAt: number;
  readonly tree: readonly PsRow[];
  /** The size of the run's stage file: it grows with every stage marker. */
  readonly stageBytes: number;
}

/**
 * Advance the quiet window by one observation.
 *
 * The window resets on: the first observation; a stage marker; any process
 * starting or exiting (pid+start time, so pid reuse counts); a process
 * running, in disk wait or stopped; more CPU across the tree than
 * `cpuQuietMs` since the window began; or a sampling gap / wall-clock jump
 * (the supervisor was starved, or the laptop slept: the monotonic clock stops
 * during sleep).
 */
export function advanceWindow(
  previous: QuietWindow | null,
  observation: Observation,
  config: Pick<WatchdogConfig, "sampleMs" | "cpuQuietMs">,
): QuietWindow {
  const { at, wallAt, tree, stageBytes } = observation;
  const members = tree
    .map((row) => row.key)
    .sort()
    .join("|");
  const cpu = new Map(tree.map((row) => [row.key, row.cpuMs]));
  const reset = (reason: string): QuietWindow => ({
    quietSince: at,
    lastAt: at,
    lastWallAt: wallAt,
    members,
    stageBytes,
    baseCpu: cpu,
    windowCpuMs: 0,
    lastCheckAt: null,
    checkCpu: null,
    resetReason: reason,
  });
  if (!previous) return reset("start");
  const gap = at - previous.lastAt;
  const drift = Math.abs(wallAt - previous.lastWallAt - gap);
  if (gap > Math.max(15_000, config.sampleMs * 3)) return reset("sampling-gap");
  if (drift > 5000) return reset("clock-jump");
  if (stageBytes !== previous.stageBytes) return reset("stage-marker");
  if (members !== previous.members) return reset("membership");
  if (tree.some((row) => /^[RUDT]/.test(row.state)))
    return reset("process-state");
  let windowCpuMs = 0;
  for (const [key, ms] of cpu)
    windowCpuMs += Math.max(0, ms - (previous.baseCpu.get(key) ?? ms));
  if (windowCpuMs > config.cpuQuietMs) return reset("cpu");
  return {
    ...previous,
    lastAt: at,
    lastWallAt: wallAt,
    windowCpuMs,
    resetReason: null,
  };
}

/** One open file of a process, as `lsof -F pftdinT` lists it. */
export interface LsofFd {
  readonly fd: string;
  type: string | null;
  device: string | null;
  inode: string | null;
  name: string | null;
  tcpState: string | null;
}

export const LSOF_ARGS = ["-nP", "-w", "-F", "pftdinT"];

/** Parse `lsof -F pftdinT` output into `Map<pid, fd[]>`. */
export function parseLsof(text: string): Map<number, LsofFd[]> {
  const byPid = new Map<number, LsofFd[]>();
  let fds: LsofFd[] | null = null;
  let fd: LsofFd | null = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      const pid = Number(value);
      fds = byPid.get(pid) ?? [];
      byPid.set(pid, fds);
      fd = null;
    } else if (tag === "f" && fds !== null) {
      fd = {
        fd: value,
        type: null,
        device: null,
        inode: null,
        name: null,
        tcpState: null,
      };
      fds.push(fd);
    } else if (fd) {
      if (tag === "t") fd.type = value;
      else if (tag === "d") fd.device = value;
      else if (tag === "i") fd.inode = value;
      else if (tag === "n") fd.name = value;
      else if (tag === "T" && value.startsWith("ST="))
        fd.tcpState = value.slice(3);
    }
  }
  return byPid;
}

export type FdClass = "internal" | "external" | "ignored";

/** An fd with where it leads: `peerPid` is the tree process on its other end, for an internal one. */
export interface ClassifiedFd extends LsofFd {
  class: FdClass;
  peerPid: number | null;
}

const isNumericFd = (fd: LsofFd): boolean => /^\d+$/.test(fd.fd);
const peerAddress = (name: string | null): string | null =>
  /^->(0x[0-9a-f]+)$/i.exec(name ?? "")?.[1] ?? null;

/**
 * Classify every IPC fd of the tree as `internal` (its peer is a tree
 * process), `external`, or `ignored`.
 *
 * `supervisorFds` are the supervisor's own fds: anything the tree shares with
 * it (the inherited stdio of git, the terminal or a coding agent) is ignored;
 * otherwise every hook would always look like it waits on the outside world
 * and the rule could never fire. An fd type or shape this function does not
 * recognise is `external`: unknown is never evidence of a deadlock.
 */
export function classifyFds(
  lsofByPid: ReadonlyMap<number, readonly LsofFd[]>,
  treePids: readonly number[],
  supervisorFds: readonly LsofFd[] = [],
): Map<number, ClassifiedFd[]> {
  const inTree = new Set(treePids);
  const supervisorObjects = new Set(
    supervisorFds.flatMap((fd) => (fd.device ? [fd.device] : [])),
  );
  const holders = new Map<string, Set<number>>();
  const tcpByName = new Map<string, number>();
  for (const [pid, fds] of lsofByPid) {
    if (!inTree.has(pid)) continue;
    for (const fd of fds) {
      if (fd.device) {
        const held = holders.get(fd.device);
        if (held) held.add(pid);
        else holders.set(fd.device, new Set([pid]));
      }
      if (/^IPv[46]$/.test(fd.type ?? "") && fd.name)
        tcpByName.set(fd.name, pid);
    }
  }
  const result = new Map<number, ClassifiedFd[]>();
  for (const [pid, fds] of lsofByPid) {
    if (!inTree.has(pid)) continue;
    const classified: ClassifiedFd[] = [];
    for (const fd of fds) {
      if (!isNumericFd(fd)) continue;
      const entry: ClassifiedFd = { ...fd, class: "external", peerPid: null };
      const type = fd.type ?? "";
      if (NON_IPC_TYPES.has(type)) {
        entry.class = "ignored";
      } else if (fd.device && supervisorObjects.has(fd.device)) {
        entry.class = "ignored";
      } else if (type === "PIPE" || type === "unix") {
        const peer = peerAddress(fd.name);
        if (peer && supervisorObjects.has(peer)) {
          entry.class = "ignored";
        } else if (peer && /^0x0+$/i.test(peer)) {
          entry.class = "ignored";
        } else if (peer) {
          const peers = [...(holders.get(peer) ?? [])];
          if (peers.length > 0) {
            entry.class = "internal";
            // Every holder is this process when none is another.
            entry.peerPid = peers.find((p) => p !== pid) ?? pid;
          }
        } else if (!fd.name) {
          entry.class = "ignored";
        }
      } else if (type === "FIFO") {
        const sharers = [...(holders.get(fd.device ?? "") ?? [])].filter(
          (p) => p !== pid,
        );
        const [sharer] = sharers;
        if (sharer !== undefined) {
          entry.class = "internal";
          entry.peerPid = sharer;
        }
      } else if (/^IPv[46]$/.test(type)) {
        const arrow = /^(.+)->(.+)$/.exec(fd.name ?? "");
        if (fd.tcpState && CLOSED_TCP.has(fd.tcpState)) {
          entry.class = "ignored";
        } else if (arrow && fd.tcpState === "ESTABLISHED") {
          const peer = tcpByName.get(`${arrow[2]}->${arrow[1]}`);
          if (peer !== undefined) {
            entry.class = "internal";
            entry.peerPid = peer;
          }
        }
      }
      classified.push(entry);
    }
    result.set(pid, classified);
  }
  return result;
}

/** The processes of a deadlock: an idle leaf and the idle tree processes its channels lead to. */
export interface HangCore {
  readonly leaf: number;
  readonly peers: readonly number[];
}

/**
 * Every tree process reachable from `start` through internal channels,
 * `start` excluded, in the order they are reached.
 */
function internalComponent(
  start: number,
  classes: ReadonlyMap<number, readonly ClassifiedFd[]>,
): number[] {
  const reached = new Set([start]);
  const queue = [start];
  // The iterator reads the length each step, so the pids pushed are visited too.
  for (const pid of queue) {
    for (const fd of classes.get(pid) ?? []) {
      if (fd.class !== "internal" || fd.peerPid === null) continue;
      if (reached.has(fd.peerPid)) continue;
      reached.add(fd.peerPid);
      queue.push(fd.peerPid);
    }
  }
  return queue.slice(1);
}

/**
 * Find a deadlocked core: a leaf that spent no CPU in the window, holds at
 * least one IPC channel, and whose every channel leads to a tree process.
 * Every process those channels reach, directly or through further internal
 * channels, must also have spent no CPU and hold nothing external: an outside
 * wait anywhere along the chain can still wake it.
 *
 * The component must also hold every live child of its members. A parent
 * waits on its children's exit, a wait `lsof` never shows: a member with a
 * child outside the component (a run polling for a lock another process
 * holds, say, which keeps no fd on the lock) is woken when that child ends,
 * so the component is not closed. A zombie child has already ended and wakes
 * nobody. Returns `{ leaf, peers }` (peers: that whole component) or null.
 */
export function findHangCore(
  tree: readonly PsRow[],
  classes: ReadonlyMap<number, readonly ClassifiedFd[]>,
  cpuDeltaByPid: ReadonlyMap<number, number>,
): HangCore | null {
  const parents = new Set(tree.map((row) => row.ppid));
  const leaves = tree.filter((row) => !parents.has(row.pid));
  for (const leaf of leaves) {
    if ((cpuDeltaByPid.get(leaf.pid) ?? 1) !== 0) continue;
    const ipc = (classes.get(leaf.pid) ?? []).filter(
      (fd) => fd.class !== "ignored",
    );
    if (ipc.length === 0 || ipc.some((fd) => fd.class !== "internal")) continue;
    const peers = internalComponent(leaf.pid, classes);
    const peersQuiet = peers.every(
      (peer) =>
        (cpuDeltaByPid.get(peer) ?? 1) === 0 &&
        !(classes.get(peer) ?? []).some((fd) => fd.class === "external"),
    );
    const members = new Set([leaf.pid, ...peers]);
    const childOutside = tree.some(
      (row) =>
        members.has(row.ppid) &&
        !members.has(row.pid) &&
        !row.state.startsWith("Z"),
    );
    if (peers.length > 0 && peersQuiet && !childOutside)
      return { leaf: leaf.pid, peers };
  }
  return null;
}

/** A core's processes by pid and start time, so the same core is recognised again and a reused pid is not. */
export function coreIdentity(tree: readonly PsRow[], core: HangCore): string {
  const members = new Set([core.leaf, ...core.peers]);
  return tree
    .filter((row) => members.has(row.pid))
    .map((row) => row.key)
    .sort()
    .join("|");
}

/**
 * Whether a process outside the tree holds any channel the core uses.
 *
 * The tree listing names only tree processes, so an endpoint one of them
 * shares with an outside process (one that left the tree, or never was in
 * it) reads as internal there. `wideByPid` is every process `lsof` can read.
 * An outside holder could still write, so the core is not proven closed.
 */
export function coreSharedOutside(
  core: HangCore,
  classes: ReadonlyMap<number, readonly ClassifiedFd[]>,
  wideByPid: ReadonlyMap<number, readonly LsofFd[]>,
  treePids: readonly number[],
): boolean {
  const objects = new Set<string>();
  for (const pid of [core.leaf, ...core.peers]) {
    for (const fd of classes.get(pid) ?? []) {
      if (fd.class !== "internal") continue;
      if (fd.device) objects.add(fd.device);
      const peer = peerAddress(fd.name);
      if (peer) objects.add(peer);
    }
  }
  const inTree = new Set(treePids);
  for (const [pid, fds] of wideByPid) {
    if (inTree.has(pid)) continue;
    if (fds.some((fd) => fd.device !== null && objects.has(fd.device)))
      return true;
  }
  return false;
}

export type Verdict =
  | {
      readonly kind: "internal-deadlock";
      readonly core: HangCore;
      readonly quietMs: number;
    }
  | { readonly kind: "idle-external"; readonly quietMs: number };

/**
 * The verdict for a quiet tree, or null.
 *
 * - `internal-deadlock`: quiet for `idleMs`, a hang core exists, no leaf
 *   holds an external channel, and no exempt command is in the tree.
 * - `idle-external`: quiet for `externalIdleMs`, whatever the fds say (or if
 *   `lsof` failed).
 */
export function decide({
  tree,
  classes,
  cpuDeltaByPid,
  quietMs,
  config,
}: {
  readonly tree: readonly PsRow[];
  readonly classes: ReadonlyMap<number, readonly ClassifiedFd[]> | null;
  readonly cpuDeltaByPid: ReadonlyMap<number, number>;
  readonly quietMs: number;
  readonly config: Pick<WatchdogConfig, "idleMs" | "externalIdleMs">;
}): Verdict | null {
  if (quietMs < config.idleMs) return null;
  if (classes) {
    const parents = new Set(tree.map((row) => row.ppid));
    const leafHoldsExternal = tree.some(
      (row) =>
        !parents.has(row.pid) &&
        (classes.get(row.pid) ?? []).some((fd) => fd.class === "external"),
    );
    const exempt = tree.find((row) => EXEMPT_COMMANDS.test(row.comm));
    const core = findHangCore(tree, classes, cpuDeltaByPid);
    if (core && !leafHoldsExternal && !exempt)
      return { kind: "internal-deadlock", core, quietMs };
  }
  if (quietMs >= config.externalIdleMs)
    return { kind: "idle-external", quietMs };
  return null;
}

/**
 * What one run's watchdog reports, as the history row records it under
 * `watchdog`. History readers and gates downstream read this shape.
 */
export type WatchdogRunSummary = {
  mode: WatchdogMode;
  reason: string;
  idleMs: number;
  verdict: {
    kind: Verdict["kind"];
    quietMs: number;
    core: HangCore | null;
  } | null;
  acted: boolean;
  diagnostics: string | null;
  warnings: string[];
  /** How long after a verdict that was not acted on the hook ended by itself. */
  resolvedAfterMs?: number;
};

/**
 * The exit status and run status an acted-on verdict imposes, or null to keep
 * the hook's own. Only an enforced `internal-deadlock` changes the outcome.
 */
export function exitDisposition(
  summary?: { readonly [key: string]: unknown } | null,
): { code: number; status: string } | null {
  const verdict = summary?.verdict;
  if (
    summary?.acted &&
    typeof verdict === "object" &&
    verdict !== null &&
    "kind" in verdict &&
    verdict.kind === "internal-deadlock"
  )
    return { code: WATCHDOG_EXIT_CODE, status: "timed_out" };
  return null;
}

/**
 * Whether an `lsof` listing covers every process it was asked about.
 *
 * `lsof` still prints the processes it could read when one vanished or was
 * unreadable, and exits 1. A process missing from the listing has no
 * classified fds, so a missing leaf is never examined and a missing peer looks
 * like it holds nothing external: incomplete evidence that could otherwise
 * produce a kill. Coverage is therefore a precondition of classifying
 * anything.
 */
export function lsofCoversTree(
  lsofByPid: ReadonlyMap<number, unknown>,
  treePids: readonly number[],
): boolean {
  return treePids.every((pid) => lsofByPid.has(pid));
}

export interface ExecResult {
  /** Exit status 0 only: partial output from a failed command is never a measurement. */
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error | null;
}

export type Exec = (
  command: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

/**
 * `ps` in the C locale: `lstart` follows LC_TIME, and PS_ROW reads only the
 * English form. Under another locale every row would be malformed, and the
 * watchdog would decide nothing for the whole run.
 */
const psEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: "C" });

const execAsync: Exec = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options },
      (error, stdout, stderr) =>
        resolve({ ok: !error, stdout, stderr, error }),
    );
  });

function pruneOldHangs(hangsDir: string, now: number): void {
  try {
    for (const entry of readdirSync(hangsDir)) {
      const path = join(hangsDir, entry);
      if (now - statSync(path).mtimeMs > HANG_RETENTION_MS)
        rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // fail-open: pruning is housekeeping, never part of the verdict.
  }
}

export interface Clock {
  /** Monotonic time, in ms. */
  now(): number;
  /** Wall-clock time, in ms. */
  wall(): number;
}

export interface WatchdogOptions {
  readonly rootPid: number;
  readonly supervisorPid?: number;
  readonly stageFile: string;
  readonly hangsDir: string;
  readonly runId: string;
  readonly config: WatchdogConfig;
  readonly exec?: Exec;
  readonly clock?: Clock;
  readonly log?: (message: string) => void;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/** The watchdog attached to one run. */
export interface RunWatchdog {
  readonly mode: WatchdogMode;
  /** A user signal cancels the run; the watchdog must not re-label it. */
  disarm(): void;
  /** The hook exited: no further ticks, and a tick already in flight must not begin a kill. */
  stop(): void;
  summary(): WatchdogRunSummary;
  enforced(): boolean;
}

interface Snapshot {
  readonly raw: string;
  readonly rows: readonly PsRow[];
  readonly tree: readonly PsRow[];
}

/**
 * The effectful watchdog the supervisor attaches to a spawned hook.
 *
 * Every external command runs asynchronously with a timeout so the
 * supervisor's signal forwarding is never blocked.
 */
export function createWatchdog({
  rootPid,
  supervisorPid = process.pid,
  stageFile,
  hangsDir,
  runId,
  config,
  exec = execAsync,
  clock = { now: () => performance.now(), wall: () => Date.now() },
  log = (message) => process.stderr.write(message),
  kill = (pid, signal) => process.kill(pid, signal),
}: WatchdogOptions): RunWatchdog {
  const summary: WatchdogRunSummary = {
    mode: config.mode,
    reason: config.reason,
    idleMs: config.idleMs,
    verdict: null,
    acted: false,
    diagnostics: null,
    warnings: [],
  };
  if (config.mode !== "enforce" && config.mode !== "report") {
    return {
      mode: config.mode,
      disarm() {},
      stop() {},
      summary: () => summary,
      enforced: () => false,
    };
  }
  let window: QuietWindow | null = null;
  let armed = true;
  let busy = false;
  let supervisorFds: LsofFd[] | null = null;
  let verdictAt: number | null = null;
  // The deadlock core found at the previous check. A kill needs the same core
  // twice, one idle window apart: fd topology and zero CPU cannot prove a
  // process is not waiting on its own timer, so a quiet protocol has to stay
  // exactly as it was for a second full window first.
  let pendingCore: string | null = null;

  const stageBytes = (): number => {
    try {
      return statSync(stageFile).size;
    } catch {
      // fail-open: no stage file yet is no stage marker.
      return 0;
    }
  };

  async function snapshotTree(): Promise<Snapshot | null> {
    const ps = await exec("ps", PS_ARGS, { timeout: 10_000, env: psEnv() });
    if (!ps.ok) return null;
    const parsed = parsePs(ps.stdout);
    // A row that does not parse may be a process the tree needs: dropping it
    // could hide an external waiter and make the rest look deadlocked. A
    // partial snapshot is no snapshot.
    if (parsed.malformed > 0) return null;
    return {
      raw: ps.stdout,
      rows: parsed.rows,
      tree: buildTree(parsed.rows, rootPid),
    };
  }

  /**
   * `verdict`, unless it is a deadlock whose core shares a channel with a
   * process outside the tree, or the listing of every process that would
   * show that cannot be read. The whole-machine `lsof` is taken only once a
   * core has been found; it lists the processes this user can read.
   */
  async function closedVerdict(
    verdict: Verdict | null,
    tree: readonly PsRow[],
    classes: ReadonlyMap<number, readonly ClassifiedFd[]> | null,
  ): Promise<Verdict | null> {
    if (verdict?.kind !== "internal-deadlock" || classes === null)
      return verdict;
    const wide = await exec("lsof", LSOF_ARGS, { timeout: 20_000 });
    const shared =
      !wide.ok ||
      coreSharedOutside(
        verdict.core,
        classes,
        parseLsof(wide.stdout),
        tree.map((row) => row.pid),
      );
    if (!shared) return verdict;
    // Not a proven deadlock, but still a wait: the external ceiling applies.
    return verdict.quietMs >= config.externalIdleMs
      ? { kind: "idle-external", quietMs: verdict.quietMs }
      : null;
  }

  async function inspect(
    tree: readonly PsRow[],
  ): Promise<{ classes: Map<number, ClassifiedFd[]> | null; raw: string }> {
    if (supervisorFds === null) {
      const own = await exec(
        "lsof",
        [...LSOF_ARGS, "-p", String(supervisorPid)],
        { timeout: 20_000 },
      );
      const fds = own.ok ? parseLsof(own.stdout).get(supervisorPid) : undefined;
      // Without the supervisor's fds nothing inherited can be subtracted;
      // decide nothing this time and try again next window, rather than
      // caching an empty set for the rest of the run.
      if (!fds) return { classes: null, raw: own.stderr };
      supervisorFds = fds;
    }
    const treePids = tree.map((row) => row.pid);
    const lsof = await exec("lsof", [...LSOF_ARGS, "-p", treePids.join(",")], {
      timeout: 20_000,
    });
    const byPid = parseLsof(lsof.stdout);
    if (!lsof.ok || !lsofCoversTree(byPid, treePids))
      return { classes: null, raw: `${lsof.stdout}${lsof.stderr}` };
    return {
      classes: classifyFds(byPid, treePids, supervisorFds),
      raw: lsof.stdout,
    };
  }

  async function writeDiagnostics(
    verdict: Verdict,
    tree: readonly PsRow[],
    psRaw: string,
    lsofRaw: string,
  ): Promise<string | null> {
    const dir = join(hangsDir, runId);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      pruneOldHangs(hangsDir, clock.wall());
      writeFileSync(
        join(dir, "verdict.json"),
        JSON.stringify(
          {
            verdict,
            tree: tree.map(({ pid, ppid, pgid, state, cpuMs, comm }) => ({
              pid,
              ppid,
              pgid,
              state,
              cpuMs,
              comm,
            })),
          },
          null,
          2,
        ),
      );
      writeFileSync(join(dir, "ps.txt"), psRaw);
      writeFileSync(join(dir, "lsof.txt"), lsofRaw);
      const targets =
        verdict.kind === "internal-deadlock"
          ? [verdict.core.leaf, ...verdict.core.peers]
          : tree.map((row) => row.pid);
      await Promise.all(
        targets
          .slice(0, 4)
          .map((pid) =>
            exec(
              "sample",
              [
                String(pid),
                "1",
                "-mayDie",
                "-file",
                join(dir, `sample-${pid}.txt`),
              ],
              { timeout: 10_000 },
            ),
          ),
      );
      return dir;
    } catch (error) {
      // fail-open: diagnostics explain a verdict; the summary says they are missing.
      summary.warnings.push(
        `diagnostics unavailable: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Signal `tree`. With `group`, the hook's process group is signalled once
   * and its members are skipped individually; without it (the group can no
   * longer be proven to be the hook's), every listed process is signalled by
   * pid.
   */
  function signalTree(
    tree: readonly PsRow[],
    signal: NodeJS.Signals,
    group = true,
  ): void {
    if (group) {
      try {
        kill(-rootPid, signal);
      } catch {
        // fail-open: the group is already gone.
      }
    }
    for (const row of tree) {
      if (group && row.pgid === rootPid) continue;
      try {
        kill(row.pid, signal);
      } catch {
        // fail-open: the process is already gone.
      }
    }
  }

  /** A snapshot, retried a few times 250 ms apart when `ps` fails or returns a malformed row. */
  async function snapshotWithRetry(attempts: number): Promise<Snapshot | null> {
    const snapshot = await snapshotTree();
    if (snapshot || attempts <= 1) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return snapshotWithRetry(attempts - 1);
  }

  async function act(
    verdict: Verdict,
    tree: readonly PsRow[],
    psRaw: string,
    lsofRaw: string,
  ): Promise<void> {
    verdictAt = clock.now();
    summary.verdict = {
      kind: verdict.kind,
      quietMs: Math.round(verdict.quietMs),
      core: verdict.kind === "internal-deadlock" ? verdict.core : null,
    };
    summary.diagnostics = await writeDiagnostics(verdict, tree, psRaw, lsofRaw);
    if (config.mode !== "enforce" || verdict.kind !== "internal-deadlock") {
      log(
        `\n⚠️  Hook watchdog (${config.mode}): ${verdict.kind} after ${Math.round(verdict.quietMs / 60000)} min quiet. Diagnostics: ${summary.diagnostics ?? "unavailable"}\n`,
      );
      return;
    }
    // Re-check before killing: activity since the verdict means it was not a
    // deadlock after all.
    const again = await snapshotTree();
    const settled =
      again &&
      advanceWindow(
        window,
        {
          at: clock.now(),
          wallAt: clock.wall(),
          tree: again.tree,
          stageBytes: stageBytes(),
        },
        config,
      );
    const withdraw = (warning: string, next: QuietWindow | null): void => {
      summary.warnings.push(warning);
      summary.verdict = null;
      verdictAt = null;
      window = next;
      // A new verdict needs its own two confirmations, not one more on top of
      // the withdrawn one's.
      pendingCore = null;
    };
    if (!armed || !again || !settled || settled.resetReason) {
      withdraw("verdict withdrawn: activity resumed before termination", settled);
      return;
    }
    // The channels too: a process can turn to an outside wait on less CPU
    // than the window tolerates. The kill needs the same core, found again
    // from a fresh, complete listing, with no CPU spent since the verdict.
    const fresh = await inspect(again.tree);
    const since = settled.checkCpu ?? settled.baseCpu;
    const recheck = await closedVerdict(
      decide({
        tree: again.tree,
        classes: fresh.classes,
        cpuDeltaByPid: new Map(
          again.tree.map((row) => [
            row.pid,
            row.cpuMs - (since.get(row.key) ?? row.cpuMs),
          ]),
        ),
        quietMs: settled.lastAt - settled.quietSince,
        config,
      }),
      again.tree,
      fresh.classes,
    );
    if (
      !armed ||
      recheck?.kind !== "internal-deadlock" ||
      coreIdentity(again.tree, recheck.core) !==
        coreIdentity(tree, verdict.core)
    ) {
      withdraw(
        "verdict withdrawn: the deadlock's channels changed before termination",
        settled,
      );
      return;
    }
    const core = [verdict.core.leaf, ...verdict.core.peers];
    const commands = tree
      .filter((row) => core.includes(row.pid))
      .map((row) => `${row.pid} ${row.comm}`)
      .join(", ");
    log(
      `\n❌ Hook watchdog: no progress for ${Math.round(verdict.quietMs / 60000)} min, and the stuck processes are waiting only on each other (${commands}).\n` +
        `   This is a hang in the gate, not a test failure. Diagnostics: ${summary.diagnostics ?? "unavailable"}\n` +
        `   Stopping the hook; re-run it.\n`,
    );
    summary.acted = true;
    signalTree(tree, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, config.graceMs));
    // Escalate against the ORIGINAL tree, so members that left the process
    // group or lost their parent are still reached, but only processes whose
    // pid and start time still match, so a pid the kernel reused after its
    // owner exited is never signalled. Children spawned during the grace
    // period are added from the fresh snapshot.
    const remaining = await snapshotWithRetry(3);
    if (!remaining) {
      // No readable snapshot after retrying: the original pids and process
      // group can no longer be proven to be the hook's, so nothing is
      // escalated. Killing a reused pid is worse than a TERM-resistant
      // process outliving the hook; the warning records that it may have.
      summary.warnings.push(
        "post-grace ps unavailable: SIGKILL escalation skipped, process identity unverifiable",
      );
      return;
    }
    const alive = new Set(remaining.rows.map((row) => row.key));
    const survivors = tree.filter((row) => alive.has(row.key));
    // Only a root that is still the original process owns its current
    // descendants: if the root exited and its pid was reused, the processes
    // now under that pid are unrelated. The process group can still be
    // signalled while a verified survivor belongs to it (a pgid is not reused
    // while any member lives), and otherwise must not be.
    const originalRoot = tree.find((row) => row.pid === rootPid);
    const rootIntact = originalRoot !== undefined && alive.has(originalRoot.key);
    const spawnedDuringGrace = rootIntact
      ? remaining.tree.filter(
          (row) => !tree.some((original) => original.key === row.key),
        )
      : [];
    signalTree(
      [...survivors, ...spawnedDuringGrace],
      "SIGKILL",
      rootIntact || survivors.some((row) => row.pgid === rootPid),
    );
  }

  async function tick(): Promise<void> {
    if (!armed || busy) return;
    busy = true;
    try {
      const snapshot = await snapshotTree();
      if (!snapshot || snapshot.tree.length === 0) return;
      const current = advanceWindow(
        window,
        {
          at: clock.now(),
          wallAt: clock.wall(),
          tree: snapshot.tree,
          stageBytes: stageBytes(),
        },
        config,
      );
      window = current;
      if (current.resetReason) pendingCore = null;
      const quietMs = current.lastAt - current.quietSince;
      if (quietMs < config.idleMs || summary.verdict) return;
      if (
        current.lastCheckAt !== null &&
        current.lastAt - current.lastCheckAt < config.idleMs &&
        quietMs < config.externalIdleMs
      )
        return;
      current.lastCheckAt = current.lastAt;
      // CPU for the hang core is measured since the previous check, not since
      // the window began. The window tolerates up to `cpuQuietMs` without
      // restarting, so from its start a few ms a leaf spent early (finishing
      // startup under load) would disqualify it at every later check for as
      // long as the hang lasts. Per check, that CPU counts once; a kill still
      // needs two consecutive checks, each with zero core CPU across a full
      // idle window.
      const since = current.checkCpu ?? current.baseCpu;
      const cpuDeltaByPid = new Map(
        snapshot.tree.map((row) => [
          row.pid,
          row.cpuMs - (since.get(row.key) ?? row.cpuMs),
        ]),
      );
      current.checkCpu = new Map(
        snapshot.tree.map((row) => [row.key, row.cpuMs]),
      );
      const inspection = await inspect(snapshot.tree);
      if (!armed) return;
      const verdict = await closedVerdict(
        decide({
          tree: snapshot.tree,
          classes: inspection.classes,
          cpuDeltaByPid,
          quietMs,
          config,
        }),
        snapshot.tree,
        inspection.classes,
      );
      if (!armed) return;
      if (verdict?.kind === "internal-deadlock") {
        const identity = coreIdentity(snapshot.tree, verdict.core);
        if (pendingCore !== identity) {
          pendingCore = identity;
          return;
        }
      } else {
        pendingCore = null;
      }
      if (verdict)
        await act(verdict, snapshot.tree, snapshot.raw, inspection.raw);
    } catch (error) {
      // fail-open: the watchdog is a safety net; a failed tick decides nothing, and the summary says so.
      summary.warnings.push(
        `watchdog tick failed: ${(error as Error).message}`,
      );
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => void tick(), config.sampleMs);
  timer.unref();
  return {
    mode: config.mode,
    disarm() {
      armed = false;
    },
    stop() {
      armed = false;
      clearInterval(timer);
      if (summary.verdict && !summary.acted && verdictAt !== null)
        summary.resolvedAfterMs = Math.round(clock.now() - verdictAt);
    },
    summary: () => summary,
    enforced: () => summary.acted,
  };
}
