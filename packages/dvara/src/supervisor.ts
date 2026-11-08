// The hook supervisor: runs a git hook under bash, forwards the terminal's
// signals to it, and writes one history row per run. It never changes the
// hook's verdict except to report a signalled run as cancelled; every failure
// of its own (telemetry, watchdog, quiet output) is fail-open.
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, totalmem } from "node:os";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "./config.ts";
import { hookKind, invocationContext, perfLevelNames } from "./context.ts";
import { isQuiet, successLine, successNotices } from "./quiet.ts";
import { parseRecords, parseStages, treeUsage } from "./records.ts";

/** Exit code per signal, shared by the pre-launch path and the exit handler. */
export const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
  SIGQUIT: 131,
};
const FORWARDED = Object.keys(SIGNAL_EXIT_CODES) as NodeJS.Signals[];

export interface WatchdogSummary {
  readonly mode: string;
  readonly [key: string]: unknown;
}

/** One run's watchdog, as a watchdog module's `createWatchdog` returns it. */
export interface Watchdog {
  disarm(): void;
  stop(): void;
  summary(): WatchdogSummary;
  enforced(): boolean;
}

/**
 * A watchdog module (`watchdog` in the config): a safety net that may stop a
 * hung hook. Loaded dynamically and fail-open: the hook runs exactly as it
 * would without one.
 */
export interface WatchdogModule {
  createWatchdog(options: {
    rootPid: number;
    stageFile: string;
    hangsDir: string;
    runId: string;
    config: unknown;
  }): Watchdog;
  resolveWatchdogConfig(
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    perfLevels: string[],
  ): unknown;
  /** The verdict an enforced stop imposes, or null to keep the hook's own. */
  exitDisposition(
    summary: WatchdogSummary,
  ): { code: number; status: string } | null;
}

export interface Signals {
  on(name: NodeJS.Signals, listener: () => void): unknown;
  off(name: NodeJS.Signals, listener: () => void): unknown;
}

export interface Options {
  readonly root: string;
  readonly config: Config;
  readonly env?: NodeJS.ProcessEnv;
  readonly signals?: Signals;
  readonly exit?: (code: number) => void;
  readonly platform?: NodeJS.Platform;
  readonly sampleIntervalMs?: number;
  readonly drainLimitMs?: number;
  readonly ppid?: number;
  readonly loadWatchdog?: (path: string) => Promise<WatchdogModule>;
  readonly stdout?: (text: string | Uint8Array) => void;
  readonly stderr?: (text: string | Uint8Array) => void;
  /** The `ps -axo pid=,ppid=,rss=` table the run samples its memory from. */
  readonly processTable?: () => string;
}

// A hung `ps` must not hang the supervisor that exists to report hangs.
const psTable = (): string =>
  execFileSync("ps", ["-axo", "pid=,ppid=,rss="], {
    encoding: "utf8",
    timeout: 10_000,
  });

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const importWatchdog = async (path: string): Promise<WatchdogModule> =>
  (await import(pathToFileURL(path).href)) as WatchdogModule;

/** What a run is judged against, read once before the hook starts. */
export const judgedAgainst = (
  root: string,
  env: NodeJS.ProcessEnv,
  baseRefs: readonly string[],
) => {
  const git = (args: string[]): string | null => {
    try {
      // A fact git cannot give is null; its complaint is not the hook's output.
      return execFileSync("git", args, {
        cwd: root,
        env,
        stdio: "pipe",
      }).toString();
    } catch {
      return null;
    }
  };
  const revision = git(["rev-parse", "HEAD"]);
  // A detached HEAD abbreviates to the literal "HEAD", which is no branch.
  const branchName = git(["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  const branch = !branchName || branchName === "HEAD" ? null : branchName;
  const diff = revision === null ? null : git(["diff", "--binary", "HEAD"]);
  // Diagnostic identity only: it never authorizes reusing a result.
  const fingerprint =
    revision === null || diff === null
      ? null
      : createHash("sha256").update(revision).update(diff).digest("hex");
  // The merge-base is taken with the captured commit, not the ref, so a peer's
  // fetch between the two calls cannot pair two versions of the base. Exit 1
  // is "no common ancestor", a real state; any other failure is unknown.
  const mergeBaseOf = (commit: string): string | null => {
    const result = spawnSync("git", ["merge-base", commit, "HEAD"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    if (result.status === 0) return result.stdout.trim() || null;
    return result.status === 1 ? "none" : null;
  };
  let base: { ref: string; commit: string; mergeBase: string | null } | null =
    null;
  for (const ref of baseRefs) {
    const commit = git([
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ])?.trim();
    if (commit) {
      base = { ref, commit, mergeBase: mergeBaseOf(commit) };
      break;
    }
  }
  const tree = git(["rev-parse", "HEAD^{tree}"])?.trim() || null;
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  const clean =
    diff === null || untracked === null
      ? null
      : diff === "" && untracked === "";
  return { branch, fingerprint, base, tree, clean };
};

/**
 * Run `hook` under supervision and resolve with the exit code git must see.
 * One row per run goes to `<root>/<historyDir>/history.jsonl`.
 */
export const supervise = async (
  [hook, ...args]: readonly string[],
  options: Options,
): Promise<number> => {
  if (hook === undefined) throw new Error("supervise: no hook given");
  const {
    root,
    config,
    env = process.env,
    signals = process,
    exit = (code: number) => process.exit(code),
    platform = process.platform,
    sampleIntervalMs = 5000,
    drainLimitMs = 2000,
    ppid = process.ppid,
    loadWatchdog = importWatchdog,
    stdout = (text) => process.stdout.write(text),
    stderr = (text) => process.stderr.write(text),
    processTable = psTable,
  } = options;
  const dir = resolve(root, config.historyDir);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* telemetry cannot block the hook */
  }
  const id = randomUUID();
  const events = resolve(dir, `${id}.stages`);
  const records = resolve(dir, `${id}.records`);
  // The seconds the hook spent selecting its runtime before it started this
  // supervisor; unset, junk and negative count as none.
  const bootstrapSeconds = Number(env.DVARA_BOOTSTRAP_SECONDS);
  const bootstrapMs =
    Math.max(0, Number.isFinite(bootstrapSeconds) ? bootstrapSeconds : 0) *
    1000;
  const started = Date.now() - bootstrapMs;
  const hookName = hook.split("/").at(-1) ?? hook;
  const kind = hookKind(hookName, args, env);
  const invocation = invocationContext(kind, env, ppid);

  // The handlers go in BEFORE the hook is spawned and before the first await.
  // The child is detached, in its own process group, so it does not receive
  // the terminal's signals: forwarding them is the only thing that stops it.
  // Registered after the spawn, a signal in between kills this supervisor by
  // default instead, writing no row and orphaning the hook. Under load that
  // window opens wide.
  let child: ChildProcess | undefined;
  let watchdog: Watchdog | undefined;
  let signal: string | null = null;
  const listeners: [NodeJS.Signals, () => void][] = [];
  for (const name of FORWARDED) {
    const listener = () => {
      signal = name;
      // A person cancelled the run: the watchdog must neither act on nor relabel it.
      watchdog?.disarm();
      if (child?.pid === undefined) {
        // Nothing has run, so there is no group to signal and no row to write.
        exit(SIGNAL_EXIT_CODES[name] ?? 1);
        return;
      }
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          stderr(
            `Process-group signal forwarding failed: ${(error as NodeJS.ErrnoException).code}; forwarding to the hook directly.\n`,
          );
          child.kill(name);
        }
      }
    };
    listeners.push([name, listener]);
    signals.on(name, listener);
  }
  // A settled run answers no more signals: each run removes only its own.
  const release = () => {
    for (const [name, listener] of listeners) signals.off(name, listener);
  };

  const { branch, fingerprint, base, tree, clean } = judgedAgainst(
    root,
    env,
    config.baseRefs,
  );

  let watchdogModule: WatchdogModule | null = null;
  if (config.watchdog) {
    try {
      watchdogModule = await loadWatchdog(resolve(root, config.watchdog));
    } catch {
      /* the watchdog is a safety net, never a prerequisite for running the hook */
    }
  }
  // Signalled while the watchdog loaded: `exit` has ended the CLI already.
  if (signal) {
    release();
    return SIGNAL_EXIT_CODES[signal] ?? 1;
  }
  const quiet = isQuiet(kind, config.quietHooks, env);
  const held: Buffer[] = [];
  const spawned = spawn("bash", [hook, ...args], {
    cwd: root,
    // stdin stays inherited: pre-push reads its refs from it.
    stdio: quiet ? ["inherit", "pipe", "pipe"] : "inherit",
    detached: true,
    env: {
      ...env,
      DVARA_MEASURED_HOOK: hookName,
      DVARA_STAGE_FILE: events,
      DVARA_RECORD_FILE: records,
    },
  });
  child = spawned;
  if (quiet)
    for (const stream of [spawned.stdout, spawned.stderr])
      stream?.on("data", (chunk: Buffer) => held.push(chunk));
  if (watchdogModule && spawned.pid !== undefined) {
    try {
      watchdog = watchdogModule.createWatchdog({
        rootPid: spawned.pid,
        stageFile: events,
        hangsDir: resolve(dir, "hangs"),
        runId: id,
        config: watchdogModule.resolveWatchdogConfig(
          env,
          platform,
          perfLevelNames(platform),
        ),
      });
    } catch {
      watchdog = undefined;
    }
  }
  let peakTreeRssKiB = 0;
  let peakProcesses = 0;
  let resourceSamples = 0;
  const sample = () => {
    try {
      const table = processTable();
      const usage = treeUsage(table, spawned.pid ?? -1);
      peakTreeRssKiB = Math.max(peakTreeRssKiB, usage.rssKiB);
      peakProcesses = Math.max(peakProcesses, usage.processes);
      resourceSamples++;
    } catch {
      /* an unavailable measurement is not a verdict */
    }
  };
  const timer = setInterval(sample, sampleIntervalMs);

  /** A quiet hook's held output: all of it when the run did not pass, else its warnings and one line. */
  const report = (code: number, durationMs: number) => {
    const output = Buffer.concat(held);
    const log = resolve(dir, `${kind}.log`);
    try {
      writeFileSync(log, output);
    } catch {
      /* the log is a convenience; the verdict is printed regardless */
    }
    if (code !== 0) {
      stderr(output);
      return;
    }
    const lines = [
      ...successNotices(output.toString("utf8")),
      successLine(kind, durationMs, relative(root, log)),
    ];
    stdout(`${lines.join("\n")}\n`);
  };

  /**
   * Wait for a quiet hook's pipes to empty after it exits. A process the hook
   * left running can hold them open forever, so the wait is bounded and the
   * pipes are then closed.
   */
  const drained = async (): Promise<void> => {
    if (!quiet) return;
    const streams = [spawned.stdout, spawned.stderr].filter((s) => s !== null);
    const closed = Promise.all(
      streams.map((stream) =>
        stream.closed
          ? null
          : new Promise((done) => stream.once("close", done)),
      ),
    );
    const limit = new Promise((done) =>
      setTimeout(() => done("limit"), drainLimitMs).unref(),
    );
    const outcome = await Promise.race([closed, limit]);
    if (outcome === "limit")
      held.push(
        Buffer.from(
          `[output truncated: a process the hook started still held its output open ${drainLimitMs / 1000} s after it exited]\n`,
        ),
      );
    for (const stream of streams) stream.destroy();
  };

  const finish = (exitCode: number, error?: string): number => {
    let code = exitCode;
    clearInterval(timer);
    watchdog?.stop();
    const watchdogSummary: WatchdogSummary = watchdog?.summary() ?? {
      mode: "unavailable",
    };
    // An enforced stop decides the outcome: the hook exited because the
    // watchdog stopped it, so its own status is not the story.
    const imposed = watchdogModule?.exitDisposition(watchdogSummary) ?? null;
    if (imposed) code = imposed.code;
    const ended = Date.now();
    if (quiet) report(code, ended - started);
    const marks = parseStages(readOrNull(events), bootstrapMs);
    const { pushed, declared, proof, proofDiagnostics } = parseRecords(
      readOrNull(records),
    );
    const verdict = (last: boolean) =>
      imposed
        ? imposed.status
        : signal
          ? "cancelled"
          : code === 0
            ? "success"
            : last
              ? "failed"
              : "failure";
    // A stage's input is what it declared, else the whole tree when that tree
    // is exactly a commit: coarse, but recomputable.
    const treeInput = clean && tree ? { kind: "tree", digest: tree } : null;
    const stages = marks.map((stage, index) => ({
      ...stage,
      input: declared.get(stage.name) ?? treeInput,
      durationMs: Math.max(
        0,
        (marks[index + 1]?.startMs ?? ended - started) - stage.startMs,
      ),
      status: index === marks.length - 1 ? verdict(true) : "completed",
    }));
    try {
      appendFileSync(
        resolve(dir, "history.jsonl"),
        `${JSON.stringify({
          schema: 1,
          id,
          kind,
          invocation,
          startedAt: new Date(started).toISOString(),
          durationMs: ended - started,
          exitCode: code,
          signal,
          error,
          status: verdict(false),
          branch,
          fingerprint,
          fingerprintPurpose: "diagnostic-head-and-tracked-diff-only",
          base,
          tree,
          clean,
          pushed,
          stages,
          proof,
          proofDiagnostics,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          cpus: cpus().length,
          totalMemoryBytes: totalmem(),
          sampledPeakTreeRssKiB: peakTreeRssKiB || null,
          peakProcesses: peakProcesses || null,
          resourceSamples,
          sampleIntervalMs,
          watchdog: watchdogSummary,
        })}\n`,
      );
      rmSync(events, { force: true });
      rmSync(records, { force: true });
    } catch (failure) {
      stderr(`History unavailable: ${(failure as Error).message}\n`);
    }
    return code;
  };

  // One row per run, whichever of `error` and `exit` arrives first.
  let outcome: number | undefined;
  return new Promise<number>((done, fail) => {
    const settle = (code: number, error?: string) => {
      try {
        outcome ??= finish(code, error);
        done(outcome);
      } catch (failure) {
        fail(failure as Error);
      } finally {
        release();
      }
    };
    spawned.on("error", (error) => settle(127, error.message));
    spawned.on("exit", (code, childSignal) => {
      // The watchdog's own stop is not a cancellation; `finish` reports its verdict instead.
      if (!watchdog?.enforced()) signal ??= childSignal;
      // A signal outranks the code the hook chose: a hook that traps its
      // signal and exits 0 was still cancelled, and reporting 0 would let a
      // push through a gate its operator had just interrupted.
      const verdict =
        (signal ? SIGNAL_EXIT_CODES[signal] : undefined) ?? code ?? 1;
      void drained().then(() => settle(verdict));
    });
  });
};
