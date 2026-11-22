import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import {
  DEFAULT_EXTERNAL_IDLE_MS,
  DEFAULT_GRACE_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_SAMPLE_MS,
  MAX_TIMER_MS,
  WATCHDOG_EXIT_CODE,
  advanceWindow,
  buildTree,
  classifyFds,
  coreSharedOutside,
  createWatchdog,
  decide,
  exitDisposition,
  findHangCore,
  lsofCoversTree,
  parseCpuTime,
  parseLsof,
  parsePs,
  resolveWatchdogConfig,
  type ClassifiedFd,
  type Exec,
  type LsofFd,
  type Observation,
  type PsRow,
  type QuietWindow,
} from "./watchdog.ts";

/**
 * Fixtures are real `ps`/`lsof` output captured on an Apple M5 Max
 * (2026-09-13). The `deadlock` scenario replays the hang the watchdog was
 * built for: a node parent blocked in spawnSync whose bash child waits to read
 * a socketpair the parent never writes to or closes.
 */
const FIXTURES = resolve(
  import.meta.dirname,
  "..",
  "fixtures/watchdog/apple-m5-max-18c",
);

interface ScenarioInfo {
  readonly name: string;
  readonly rootPid: number;
  readonly supervisorPid: number;
  readonly treePids: readonly number[];
}
const meta = JSON.parse(readFileSync(join(FIXTURES, "meta.json"), "utf8")) as {
  scenarios: ScenarioInfo[];
};

function scenario(name: string) {
  const info = meta.scenarios.find((s) => s.name === name);
  if (!info) throw new Error(`no captured scenario ${name}`);
  const psText = readFileSync(join(FIXTURES, `${name}.ps.txt`), "utf8");
  const lsofText = readFileSync(join(FIXTURES, `${name}.lsof.txt`), "utf8");
  const ps = parsePs(psText);
  const lsof = parseLsof(lsofText);
  const tree = buildTree(ps.rows, info.rootPid);
  return {
    info,
    psText,
    lsofText,
    ps,
    lsof,
    tree,
    supervisorFds: lsof.get(info.supervisorPid) ?? [],
  };
}

/** The two pids of a two-process scenario: the root and the leaf under it. */
const pair = (info: ScenarioInfo): [number, number] => {
  const [first, second] = info.treePids;
  if (first === undefined || second === undefined)
    throw new Error(`${info.name} is not a two-process tree`);
  return [first, second];
};

const config = resolveWatchdogConfig({}, "darwin", []);
const zeroDeltas = (tree: readonly PsRow[]) =>
  new Map(tree.map((row) => [row.pid, 0]));
const classesOf = (
  classes: ReadonlyMap<number, readonly ClassifiedFd[]>,
  pid: number,
): readonly ClassifiedFd[] => classes.get(pid) ?? [];

describe("parseCpuTime", () => {
  for (const [text, ms] of [
    ["0:00.07", 70],
    ["1234:05.07", (1234 * 60 + 5) * 1000 + 70],
    ["02:03:04", (2 * 3600 + 3 * 60 + 4) * 1000],
    ["1-02:03:04", (26 * 3600 + 3 * 60 + 4) * 1000],
  ] as const)
    it(`reads ${text} as ${ms} ms`, () => {
      assert.equal(parseCpuTime(text), ms);
    });

  for (const text of ["", "0:00", "abc", "1:2.3"])
    it(`refuses to guess a CPU time from ${JSON.stringify(text)}`, () => {
      assert.equal(parseCpuTime(text), null);
    });
});

describe("parsePs and buildTree on captured output", () => {
  it("reads every captured row, keying processes by pid and start time", () => {
    const { ps, info } = scenario("deadlock");
    assert.equal(ps.malformed, 0);
    const bash = ps.rows.find((row) => row.comm === "bash");
    assert.partialDeepStrictEqual(bash, {
      ppid: info.rootPid,
      state: "S",
      cpuMs: 0,
    });
    assert.equal(bash?.key, `${bash?.pid}@Sun Sep 13 17:16:29 2026`);
    assert.equal(ps.rows.find((row) => row.pid === info.rootPid)?.cpuMs, 20);
  });

  it("counts an unreadable row as malformed instead of a quiet process", () => {
    const parsed = parsePs("not a ps row\n  12  1  12 S  bogus  x\n");
    assert.deepEqual(parsed.rows, []);
    assert.equal(parsed.malformed, 2);
  });

  it("takes only descendants of the hook, never the supervisor above it", () => {
    const { tree, info } = scenario("deadlock");
    const pids = tree.map((row) => row.pid);
    assert.deepEqual(pids, info.treePids);
    assert.ok(!pids.includes(info.supervisorPid));
  });
});

describe("advanceWindow", () => {
  const { tree } = scenario("deadlock");
  const observe = (
    previous: QuietWindow | null,
    at: number,
    overrides: Partial<Observation> = {},
  ) =>
    advanceWindow(
      previous,
      { at, wallAt: at, tree, stageBytes: 10, ...overrides },
      config,
    );

  it("keeps counting quiet time while nothing changes", () => {
    let window = observe(null, 0);
    window = observe(window, 5000);
    window = observe(window, 10_000);
    assert.equal(window.quietSince, 0);
    assert.equal(window.resetReason, null);
  });

  const later = tree.map((row) => ({ ...row }));
  const cases: [string, Partial<Observation>][] = [
    ["stage-marker", { stageBytes: 42 }],
    ["membership", { tree: tree.slice(0, 1) }],
    [
      "membership",
      {
        tree: later.map((row, i) =>
          i === 1 ? { ...row, key: `${row.pid}@reused` } : row,
        ),
      },
    ],
    [
      "process-state",
      { tree: later.map((row, i) => (i === 1 ? { ...row, state: "R" } : row)) },
    ],
    [
      "cpu",
      {
        tree: later.map((row, i) =>
          i === 0 ? { ...row, cpuMs: row.cpuMs + 1500 } : row,
        ),
      },
    ],
    ["sampling-gap", { at: 30_000, wallAt: 30_000 }],
    ["clock-jump", { at: 10_000, wallAt: 20_000 }],
  ];
  for (const [reason, overrides] of cases)
    it(`restarts the window on ${reason}`, () => {
      const first = observe(observe(null, 0), 5000);
      const next = advanceWindow(
        first,
        { at: 10_000, wallAt: 10_000, tree, stageBytes: 10, ...overrides },
        config,
      );
      assert.equal(next.resetReason, reason);
      // The cases without their own `at` observe at the 10_000 passed above.
      assert.equal(next.quietSince, overrides.at ?? 10_000);
    });

  it("tolerates the few CPU milliseconds a hung tree still ticks", () => {
    const first = observe(null, 0);
    const next = observe(first, 5000, {
      tree: tree.map((row, i) =>
        i === 0 ? { ...row, cpuMs: row.cpuMs + 10 } : row,
      ),
    });
    assert.equal(next.resetReason, null);
    assert.equal(next.windowCpuMs, 10);
  });
});

describe("classifyFds", () => {
  it("pairs the incident socketpair to the process on its other end", () => {
    const { lsof, tree, info, supervisorFds } = scenario("deadlock");
    const [parent, reader] = pair(info);
    const classes = classifyFds(
      lsof,
      tree.map((row) => row.pid),
      supervisorFds,
    );
    const readerIpc = classesOf(classes, reader).filter(
      (fd) => fd.class !== "ignored",
    );
    assert.deepEqual(
      readerIpc.map((fd) => fd.fd),
      ["0", "3"],
    );
    assert.ok(
      readerIpc.every(
        (fd) => fd.class === "internal" && fd.peerPid === parent,
      ),
    );
  });

  it("ignores channels shared with the supervisor, which otherwise read as external", () => {
    const { lsof, tree, info, supervisorFds } = scenario("deadlock");
    const [, reader] = pair(info);
    // The reader also holds a socket inherited from the supervisor (as a real
    // hook inherits git's or the terminal's stdio). Only subtracting the
    // supervisor's own objects keeps it from counting as a wait on the
    // outside world.
    const inherited: LsofFd = {
      fd: "7",
      type: "unix",
      device: "0xfeedfacefeedface",
      inode: null,
      name: "->0x0123456789abcdef",
      tcpState: null,
    };
    const withInherited = new Map(lsof);
    withInherited.set(reader, [...(lsof.get(reader) ?? []), inherited]);
    const supervisorWithSocket = [...supervisorFds, { ...inherited, fd: "9" }];
    const pids = tree.map((row) => row.pid);
    const subtracted = classifyFds(withInherited, pids, supervisorWithSocket);
    const notSubtracted = classifyFds(withInherited, pids, supervisorFds);
    const fd7 = (classes: ReadonlyMap<number, readonly ClassifiedFd[]>) =>
      classesOf(classes, reader).find((fd) => fd.fd === "7")?.class;
    assert.equal(fd7(subtracted), "ignored");
    assert.equal(fd7(notSubtracted), "external");
  });

  it("treats loopback TCP with both ends in the tree as internal", () => {
    const { lsof, tree, info } = scenario("tcp-internal");
    const [server, client] = pair(info);
    const classes = classifyFds(
      lsof,
      tree.map((row) => row.pid),
    );
    const clientTcp = classesOf(classes, client).find(
      (fd) => fd.type === "IPv4",
    );
    assert.partialDeepStrictEqual(clientTcp, {
      class: "internal",
      peerPid: server,
    });
    const listener = classesOf(classes, server).find(
      (fd) => fd.tcpState === "LISTEN",
    );
    assert.equal(listener?.class, "external");
  });

  it("treats TCP to a peer outside the tree as external", () => {
    const { lsof, tree, info } = scenario("tcp-external");
    const classes = classifyFds(
      lsof,
      tree.map((row) => row.pid),
    );
    const tcp = classesOf(classes, info.rootPid).find(
      (fd) => fd.type === "IPv4",
    );
    assert.equal(tcp?.class, "external");
  });

  it("treats the Docker client socket to the daemon as external", () => {
    const { lsof, tree, info } = scenario("docker-client");
    const classes = classifyFds(
      lsof,
      tree.map((row) => row.pid),
    );
    const socket = classesOf(classes, info.rootPid).find(
      (fd) => fd.type === "unix",
    );
    assert.equal(socket?.class, "external");
  });

  const shapes: [
    string,
    Pick<LsofFd, "type" | "name" | "tcpState">,
    ClassifiedFd["class"],
  ][] = [
    [
      "CLOSE_WAIT TCP",
      { type: "IPv4", name: "a:1->b:2", tcpState: "CLOSE_WAIT" },
      "ignored",
    ],
    ["UDP", { type: "IPv4", name: "*:5353", tcpState: null }, "external"],
    [
      "an unknown fd type",
      { type: "WEIRD", name: "x", tcpState: null },
      "external",
    ],
    [
      "a regular file",
      { type: "REG", name: "/tmp/log", tcpState: null },
      "ignored",
    ],
  ];
  for (const [label, shape, expected] of shapes)
    it(`classifies ${label} as ${expected}`, () => {
      const fd: LsofFd = { fd: "5", device: "0xabc", inode: null, ...shape };
      const classes = classifyFds(new Map([[1, [fd]]]), [1]);
      assert.equal(classesOf(classes, 1)[0]?.class, expected);
    });
});

describe("decide", () => {
  const verdictFor = (
    name: string,
    quietMs: number,
    edit: (tree: PsRow[]) => PsRow[] = (tree) => tree,
    lsofFailed = false,
  ) => {
    const { lsof, tree, supervisorFds } = scenario(name);
    const edited = edit(tree);
    const classes = lsofFailed
      ? null
      : classifyFds(
          lsof,
          edited.map((row) => row.pid),
          supervisorFds,
        );
    return decide({
      tree: edited,
      classes,
      cpuDeltaByPid: zeroDeltas(edited),
      quietMs,
      config,
    });
  };

  it("finds the incident deadlock once the idle window has passed", () => {
    const [parent, reader] = pair(scenario("deadlock").info);
    assert.deepEqual(verdictFor("deadlock", config.idleMs), {
      kind: "internal-deadlock",
      core: { leaf: reader, peers: [parent] },
      quietMs: config.idleMs,
    });
  });

  it("does not decide anything a moment before the window ends", () => {
    assert.equal(verdictFor("deadlock", config.idleMs - 1), null);
  });

  it("measured the hung tree spending no CPU across 10 seconds", () => {
    // The drift measurement behind cpuQuietMs: the same tree 10 s later.
    const before = scenario("deadlock").tree;
    const after = scenario("deadlock-later").tree;
    const spent = after.reduce(
      (sum, row) =>
        sum + row.cpuMs - (before.find((b) => b.key === row.key)?.cpuMs ?? 0),
      0,
    );
    assert.ok(spent < config.cpuQuietMs);
  });

  it("spares the deadlock when either process spent CPU in the window", () => {
    const { lsof, tree, supervisorFds } = scenario("deadlock");
    const classes = classifyFds(
      lsof,
      tree.map((row) => row.pid),
      supervisorFds,
    );
    for (const busy of tree) {
      const deltas = zeroDeltas(tree);
      deltas.set(busy.pid, 5);
      assert.equal(
        decide({
          tree,
          classes,
          cpuDeltaByPid: deltas,
          quietMs: config.idleMs,
          config,
        }),
        null,
      );
    }
  });

  it("spares a tree containing an exempt command such as sleep", () => {
    const withSleep = (tree: PsRow[]): PsRow[] => {
      const [root, reader] = tree;
      if (!root || !reader) throw new Error("the deadlock tree has two rows");
      return [
        ...tree,
        { ...reader, pid: 999_991, ppid: root.pid, comm: "sleep", key: "sleep" },
      ];
    };
    assert.equal(verdictFor("deadlock", config.idleMs, withSleep), null);
  });

  it("spares a leaf waiting on a TCP peer outside the tree", () => {
    assert.equal(verdictFor("tcp-external", config.idleMs), null);
  });

  it("spares an in-tree client whose server is still listening", () => {
    assert.equal(verdictFor("tcp-internal", config.idleMs), null);
  });

  it("spares a Docker client waiting on the daemon", () => {
    assert.equal(verdictFor("docker-client", config.idleMs), null);
  });

  it("never decides a deadlock from a failed lsof", () => {
    assert.equal(
      verdictFor("deadlock", config.idleMs, undefined, true),
      null,
    );
  });

  describe("a chain of internal channels", () => {
    // root(1) → middle(2) → leaf(3): the leaf waits on the middle, which waits
    // on the root. Only the root holds a channel to the outside.
    const row = (pid: number, ppid: number): PsRow => ({
      pid,
      ppid,
      pgid: 1,
      state: "S",
      cpuMs: 0,
      started: "Sun Sep 13 17:16:29 2026",
      comm: "node",
      key: `${pid}@start`,
    });
    const fd = (
      n: string,
      cls: ClassifiedFd["class"],
      peerPid: number | null,
    ): ClassifiedFd => ({
      fd: n,
      type: cls === "external" ? "IPv4" : "unix",
      device: null,
      inode: null,
      name: null,
      tcpState: null,
      class: cls,
      peerPid,
    });
    const tree = [row(1, 0), row(2, 1), row(3, 2)];
    const chain = (rootOutside: boolean) =>
      new Map<number, ClassifiedFd[]>([
        [1, [fd("3", "internal", 2), ...(rootOutside ? [fd("4", "external", null)] : [])]],
        [2, [fd("3", "internal", 3), fd("4", "internal", 1)]],
        [3, [fd("3", "internal", 2)]],
      ]);

    it("spares a leaf whose chain reaches an outside wait beyond its direct peer", () => {
      assert.equal(findHangCore(tree, chain(true), zeroDeltas(tree)), null);
    });

    it("spares a chain any of whose processes spent CPU", () => {
      const deltas = zeroDeltas(tree);
      deltas.set(1, 5);
      assert.equal(findHangCore(tree, chain(false), deltas), null);
    });

    it("finds the whole chain as the core when nothing in it waits outside", () => {
      assert.deepEqual(findHangCore(tree, chain(false), zeroDeltas(tree)), {
        leaf: 3,
        peers: [2, 1],
      });
    });
  });

  it("warns about external idleness only at the external ceiling", () => {
    assert.equal(verdictFor("tcp-external", config.externalIdleMs - 1), null);
    assert.deepEqual(verdictFor("tcp-external", config.externalIdleMs), {
      kind: "idle-external",
      quietMs: config.externalIdleMs,
    });
    assert.equal(
      verdictFor("deadlock", config.externalIdleMs, undefined, true)?.kind,
      "idle-external",
    );
  });
});

describe("resolveWatchdogConfig", () => {
  it("enforces by default on Apple silicon without efficiency cores", () => {
    assert.partialDeepStrictEqual(
      resolveWatchdogConfig({}, "darwin", ["Super", "Performance"]),
      {
        mode: "enforce",
        reason: "default",
        idleMs: DEFAULT_IDLE_MS,
        externalIdleMs: DEFAULT_EXTERNAL_IDLE_MS,
        sampleMs: DEFAULT_SAMPLE_MS,
        graceMs: DEFAULT_GRACE_MS,
        cpuQuietMs: 1200,
      },
    );
  });

  it("only reports by default on a CPU with efficiency cores", () => {
    assert.partialDeepStrictEqual(
      resolveWatchdogConfig({}, "darwin", ["Performance", "Efficiency"]),
      { mode: "report", reason: "efficiency-cores-unverified" },
    );
  });

  it("honours an explicit mode even with efficiency cores", () => {
    assert.equal(
      resolveWatchdogConfig({ DVARA_WATCHDOG: "enforce" }, "darwin", [
        "Efficiency",
      ]).mode,
      "enforce",
    );
    assert.equal(
      resolveWatchdogConfig({ DVARA_WATCHDOG: "off" }, "darwin").mode,
      "off",
    );
  });

  it("is unsupported off macOS unless switched off", () => {
    assert.equal(resolveWatchdogConfig({}, "linux").mode, "unsupported");
    assert.equal(
      resolveWatchdogConfig({ DVARA_WATCHDOG: "off" }, "linux").mode,
      "off",
    );
  });

  for (const raw of [undefined, "", "0", "-1", "abc", "1.5"])
    it(`keeps the default idle window rather than removing it for ${String(JSON.stringify(raw))}`, () => {
      assert.equal(
        resolveWatchdogConfig({ DVARA_WATCHDOG_IDLE_MS: raw }, "darwin").idleMs,
        DEFAULT_IDLE_MS,
      );
    });

  it("clamps an override past the timer ceiling", () => {
    assert.equal(
      resolveWatchdogConfig(
        { DVARA_WATCHDOG_IDLE_MS: String(2 ** 40) },
        "darwin",
      ).idleMs,
      MAX_TIMER_MS,
    );
  });

  it("never lets the external ceiling fall below the idle window", () => {
    assert.equal(
      resolveWatchdogConfig(
        {
          DVARA_WATCHDOG_IDLE_MS: "5000",
          DVARA_WATCHDOG_EXTERNAL_IDLE_MS: "1000",
        },
        "darwin",
      ).externalIdleMs,
      5000,
    );
  });
});

describe("exitDisposition", () => {
  it("imposes 124 and timed_out only for an enforced deadlock", () => {
    assert.deepEqual(
      exitDisposition({ acted: true, verdict: { kind: "internal-deadlock" } }),
      { code: WATCHDOG_EXIT_CODE, status: "timed_out" },
    );
    assert.equal(
      exitDisposition({ acted: false, verdict: { kind: "internal-deadlock" } }),
      null,
    );
    assert.equal(
      exitDisposition({ acted: true, verdict: { kind: "idle-external" } }),
      null,
    );
    assert.equal(exitDisposition(undefined), null);
  });
});

describe("lsofCoversTree", () => {
  it("accepts a listing that includes every process in the tree", () => {
    const { lsof, info } = scenario("deadlock");
    assert.equal(lsofCoversTree(lsof, info.treePids), true);
  });

  it("refuses a listing that is missing any one tree process", () => {
    const { lsof, info } = scenario("deadlock");
    for (const pid of info.treePids) {
      const partial = new Map(lsof);
      partial.delete(pid);
      assert.equal(lsofCoversTree(partial, info.treePids), false);
    }
  });
});

describe("createWatchdog", () => {
  const dirs: string[] = [];
  afterEach(() => {
    mock.timers.reset();
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Advance the mocked clock by `ms`, letting the watchdog's asynchronous work
   * finish between steps. A tick awaits its `ps` and `lsof` calls and its
   * grace and retry delays: one synchronous `tick(ms)` would fire every
   * interval at once, each finding the previous tick still busy. Small steps,
   * each followed by a real macrotask that drains the promises the step
   * started, keep the watchdog's timeline as it runs on a real clock.
   */
  const STEP_MS = 50;
  const advance = async (ms: number): Promise<void> => {
    for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
      mock.timers.tick(STEP_MS);
      await new Promise((done) => setImmediate(done));
    }
  };

  type Kill = [number, string];
  const killed = (kills: readonly Kill[], pid: number, signal: string) =>
    kills.some(([p, s]) => p === pid && s === signal);

  function harness(
    name: string,
    mode: "enforce" | "report",
    psAfterVerdict?: string,
    treeLsof: {
      text?: string;
      ok?: boolean;
      /** The tree listing for the n-th tree `lsof` call (1-based), over `text`. */
      textAt?: (call: number) => string | undefined;
      /** The whole-machine listing (no `-p`): the fixture's by default. */
      wideText?: string;
      wideOk?: boolean;
    } = {},
    psOverrides: {
      psText?: string;
      psAfterKill?: string;
      /** The `ps` output for the n-th call (1-based), before any kill or verdict override. */
      psAt?: (call: number) => string;
    } = {},
    /** Awaited by each `sample` call: the diagnostics step of a verdict. */
    sample: () => Promise<void> = async () => {},
  ) {
    // A case may build a second harness; the first one's interval is stopped.
    mock.timers.reset();
    mock.timers.enable({
      apis: ["setInterval", "setTimeout", "Date"],
      now: Date.now(),
    });
    const fixture = scenario(name);
    const hangsDir = mkdtempSync(join(tmpdir(), "watchdog-hangs-"));
    dirs.push(hangsDir);
    const kills: Kill[] = [];
    const calls: string[][] = [];
    let psCalls = 0;
    let verdictSeen = false;
    let treeLsofCalls = 0;
    const psEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const exec: Exec = async (command, args, options) => {
      calls.push([command, ...args]);
      if (command === "sample") await sample();
      if (command === "ps") {
        psCalls++;
        psEnvs.push(options.env);
        const text =
          kills.length > 0 && psOverrides.psAfterKill
            ? psOverrides.psAfterKill
            : verdictSeen && psAfterVerdict
              ? psAfterVerdict
              : (psOverrides.psAt?.(psCalls) ??
                psOverrides.psText ??
                fixture.psText);
        return { ok: true, stdout: text, stderr: "" };
      }
      if (command === "lsof") {
        if (!args.includes("-p"))
          return {
            ok: treeLsof.wideOk ?? true,
            stdout: treeLsof.wideText ?? fixture.lsofText,
            stderr: "",
          };
        // The tree query passes every pid as one comma-joined argument.
        const root = String(fixture.info.rootPid);
        if (args.some((arg) => arg.split(",").includes(root))) {
          // A kill needs two confirming checks one idle window apart; the second is the verdict.
          treeLsofCalls++;
          if (treeLsofCalls >= 2) verdictSeen = true;
          return {
            ok: treeLsof.ok ?? true,
            stdout:
              treeLsof.textAt?.(treeLsofCalls) ??
              treeLsof.text ??
              fixture.lsofText,
            stderr: "",
          };
        }
        return { ok: true, stdout: fixture.lsofText, stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    };
    const watchdog = createWatchdog({
      rootPid: fixture.info.rootPid,
      supervisorPid: fixture.info.supervisorPid,
      stageFile: join(hangsDir, "no-stage-file"),
      hangsDir,
      runId: "run-under-test",
      config: {
        ...resolveWatchdogConfig({ DVARA_WATCHDOG: mode }, "darwin"),
        idleMs: 5000,
        externalIdleMs: 60_000,
        sampleMs: 1000,
        graceMs: 500,
        cpuQuietMs: 1000,
      },
      exec,
      clock: { now: () => Date.now(), wall: () => Date.now() },
      log: () => {},
      kill: (pid, signal) => {
        kills.push([pid, signal]);
      },
    });
    return {
      fixture,
      hangsDir,
      kills,
      calls,
      watchdog,
      psCalls: () => psCalls,
      psEnvs,
    };
  }

  it("stops the incident deadlock: TERM, then KILL, with diagnostics saved", async () => {
    const { fixture, hangsDir, kills, calls, watchdog } = harness(
      "deadlock",
      "enforce",
    );
    await advance(16_000);
    watchdog.stop();
    const root = fixture.info.rootPid;
    assert.ok(killed(kills, -root, "SIGTERM"));
    assert.ok(killed(kills, -root, "SIGKILL"));
    assert.ok(
      kills.findIndex((k) => k[1] === "SIGTERM") <
        kills.findIndex((k) => k[1] === "SIGKILL"),
    );
    assert.equal(watchdog.enforced(), true);
    assert.partialDeepStrictEqual(watchdog.summary().verdict, {
      kind: "internal-deadlock",
      core: { leaf: pair(fixture.info)[1] },
    });
    const saved = readdirSync(join(hangsDir, "run-under-test")).sort();
    assert.deepEqual(saved, ["lsof.txt", "ps.txt", "verdict.json"]);
    assert.ok(
      calls.some((call) => call[0] === "sample" && call.includes("-file")),
    );
  });

  it("only reports in report mode: same verdict, nothing killed", async () => {
    const { kills, watchdog } = harness("deadlock", "report");
    await advance(16_000);
    watchdog.stop();
    assert.deepEqual(kills, []);
    assert.equal(watchdog.enforced(), false);
    assert.equal(watchdog.summary().verdict?.kind, "internal-deadlock");
  });

  it("withdraws the verdict when the tree moved again before the kill", async () => {
    const moved = scenario("deadlock").psText.replace("0:00.02", "0:09.99");
    const { kills, watchdog } = harness("deadlock", "enforce", moved);
    // 14 s covers both confirmations (~6 s, ~11 s) and the withdrawal, but not
    // two more full idle windows on the moved tree, which would be a genuine
    // new verdict rather than this one.
    await advance(14_000);
    watchdog.stop();
    assert.deepEqual(kills, []);
    assert.equal(watchdog.enforced(), false);
    assert.ok(
      watchdog
        .summary()
        .warnings.includes(
          "verdict withdrawn: activity resumed before termination",
        ),
    );
  });

  /** The deadlock fixture with the leaf's CPU time replaced by `cpu` (a `ps` time string). */
  function leafCpu(cpu: string) {
    const { info, psText } = scenario("deadlock");
    const [, leaf] = pair(info);
    return psText
      .split("\n")
      .map((line) =>
        new RegExp(`^\\s*${leaf}\\s`).test(line)
          ? line.replace(/\d+:\d{2}\.\d{2}/, cpu)
          : line,
      )
      .join("\n");
  }

  it("still stops a deadlock whose leaf spent CPU after the quiet window began", async () => {
    // 300 ms of leaf CPU on the third sample is under the 1 s the window
    // tolerates, so the window never restarts. Measured from the window's
    // start that CPU disqualified the leaf at every later check, forever;
    // measured per check it counts once.
    const { fixture, kills, watchdog } = harness(
      "deadlock",
      "enforce",
      undefined,
      {},
      {
        psAt: (call) => (call >= 3 ? leafCpu("0:00.30") : leafCpu("0:00.00")),
      },
    );
    await advance(22_000);
    watchdog.stop();
    assert.ok(killed(kills, -fixture.info.rootPid, "SIGTERM"));
    assert.partialDeepStrictEqual(watchdog.summary().verdict, {
      kind: "internal-deadlock",
      core: { leaf: pair(fixture.info)[1] },
    });
  });

  it("never kills a leaf that keeps spending a little CPU at every sample", async () => {
    // 10 ms a sample never restarts the window (it stays under the 1 s
    // tolerance), but a process that is still running, however slowly, is not
    // waiting on anything.
    const { kills, watchdog } = harness(
      "deadlock",
      "enforce",
      undefined,
      {},
      {
        psAt: (call) =>
          leafCpu(`0:00.${String(call % 100).padStart(2, "0")}`),
      },
    );
    await advance(40_000);
    watchdog.stop();
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
  });

  it("never kills a leaf waiting on a TCP peer outside the tree, past the external ceiling too", async () => {
    const { kills, watchdog } = harness("tcp-external", "enforce");
    await advance(30_000);
    assert.equal(watchdog.summary().verdict, null);
    // The harness's external ceiling is 60 s: past it the wait is reported, never stopped.
    await advance(40_000);
    watchdog.stop();
    assert.deepEqual(kills, []);
    assert.equal(watchdog.enforced(), false);
    assert.equal(watchdog.summary().verdict?.kind, "idle-external");
  });

  // Controls for the next two: the complete, successful listing of the same
  // deadlock is killed in 'stops the incident deadlock' above. Only the
  // listing's completeness differs here.
  it("never kills when lsof leaves a tree process out of its listing", async () => {
    const { info, lsofText } = scenario("deadlock");
    const [, reader] = pair(info);
    const withoutReader = lsofText.slice(0, lsofText.indexOf(`p${reader}\n`));
    const { kills, watchdog } = harness("deadlock", "enforce", undefined, {
      text: withoutReader,
      ok: true,
    });
    await advance(16_000);
    watchdog.stop();
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
  });

  it("never kills on lsof output from a failed run, even if it looks complete", async () => {
    const { kills, watchdog } = harness("deadlock", "enforce", undefined, {
      ok: false,
    });
    await advance(16_000);
    watchdog.stop();
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
  });

  it("never kills on a single confirmation; the same core found again kills", async () => {
    const { fixture, kills, watchdog } = harness("deadlock", "enforce");
    // First check at ~6 s, second at ~11 s: after 9 s only one confirmation exists.
    await advance(9000);
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
    await advance(7000);
    watchdog.stop();
    assert.ok(killed(kills, -fixture.info.rootPid, "SIGTERM"));
  });

  it("never judges from a ps snapshot with an unparseable row", async () => {
    const psText = `${scenario("deadlock").psText}garbage that is not a ps row\n`;
    const { kills, watchdog } = harness(
      "deadlock",
      "enforce",
      undefined,
      {},
      { psText },
    );
    await advance(16_000);
    watchdog.stop();
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
  });

  it("stop() prevents any later kill, including from the next confirmation", async () => {
    const { kills, watchdog } = harness("deadlock", "enforce");
    await advance(7000);
    watchdog.stop();
    await advance(20_000);
    assert.deepEqual(kills, []);
  });

  it("escalates SIGKILL only to survivors whose pid and start time still match", async () => {
    const { info, psText } = scenario("deadlock");
    const [root, reader] = pair(info);
    const rootLine = (line: string) => new RegExp(`^\\s*${root}\\s`).test(line);
    // Root gone, reader still alive: the reader is killed individually.
    const rootGone = psText
      .split("\n")
      .filter((line) => !rootLine(line))
      .join("\n");
    const survived = harness(
      "deadlock",
      "enforce",
      undefined,
      {},
      { psAfterKill: rootGone },
    );
    await advance(16_000);
    survived.watchdog.stop();
    assert.ok(killed(survived.kills, reader, "SIGKILL"));
    // The root sits outside its own process group in this fixture, so it IS
    // signalled by pid (the SIGTERM below proves it), which is what lets the
    // next line fail if a non-survivor were escalated.
    assert.ok(killed(survived.kills, root, "SIGTERM"));
    assert.ok(!killed(survived.kills, root, "SIGKILL"));
    // With the root gone and no survivor left in its group, the group is not
    // signalled again.
    assert.ok(!killed(survived.kills, -root, "SIGKILL"));
    // Reader's pid reused by a new process (different start time): never signalled.
    const reused = rootGone.replace(
      new RegExp(`^(\\s*${reader}\\s.*?)17:16:29`, "m"),
      "$117:59:59",
    );
    const recycled = harness(
      "deadlock",
      "enforce",
      undefined,
      {},
      { psAfterKill: reused },
    );
    await advance(16_000);
    recycled.watchdog.stop();
    assert.ok(killed(recycled.kills, reader, "SIGTERM"));
    assert.ok(!killed(recycled.kills, reader, "SIGKILL"));
  });

  it("never adopts processes under a reused root pid, nor signals its group", async () => {
    const { info, psText } = scenario("deadlock");
    const [root, reader] = pair(info);
    // The root exited and its pid now belongs to a new process (different
    // start time) that has a child of its own; the reader is gone.
    const reusedRoot = psText
      .split("\n")
      .filter((line) => !new RegExp(`^\\s*${reader}\\s`).test(line))
      .map((line) =>
        new RegExp(`^\\s*${root}\\s`).test(line)
          ? line.replace("17:16:29", "17:59:58")
          : line,
      )
      .concat([
        `99001 ${root} ${root} S      0:00.00 Sun Sep 13 17:59:59 2026     /bin/zsh`,
      ])
      .join("\n");
    const { kills, watchdog } = harness(
      "deadlock",
      "enforce",
      undefined,
      {},
      { psAfterKill: `${reusedRoot}\n` },
    );
    await advance(16_000);
    watchdog.stop();
    assert.ok(killed(kills, -root, "SIGTERM"));
    assert.ok(!killed(kills, -root, "SIGKILL"));
    assert.ok(!killed(kills, root, "SIGKILL"));
    assert.ok(!killed(kills, 99001, "SIGKILL"));
  });

  it("never escalates by pids it cannot re-verify when ps stays unreadable after the grace period", async () => {
    const [root] = pair(scenario("deadlock").info);
    const { kills, watchdog } = harness(
      "deadlock",
      "enforce",
      undefined,
      {},
      { psAfterKill: "not a ps row\n" },
    );
    await advance(16_000);
    watchdog.stop();
    // SIGTERM went out while identity was verified; nothing after it, by pid or by group.
    assert.ok(killed(kills, root, "SIGTERM"));
    assert.deepEqual(
      kills.filter(([, signal]) => signal === "SIGKILL"),
      [],
    );
    assert.ok(
      watchdog
        .summary()
        .warnings.includes(
          "post-grace ps unavailable: SIGKILL escalation skipped, process identity unverifiable",
        ),
    );
  });

  it("withdraws the verdict when the deadlock's channels changed before the kill", async () => {
    // The third tree listing is the re-check before the kill: by then the
    // leaf (the last process in the listing) holds a TCP channel to an
    // outside address, which ps alone cannot see.
    const outside =
      "f42\ntIPv4\nd0x5eed\nn127.0.0.1:50000->192.0.2.1:443\nTST=ESTABLISHED\n";
    const { kills, watchdog } = harness("deadlock", "enforce", undefined, {
      textAt: (call) =>
        call >= 3 ? `${scenario("deadlock").lsofText}${outside}` : undefined,
    });
    // Both confirmations and the re-check land by ~11 s; 14 s is short of a
    // new pair of confirmations on the changed tree.
    await advance(14_000);
    watchdog.stop();
    assert.deepEqual(kills, []);
    assert.equal(watchdog.enforced(), false);
    assert.equal(watchdog.summary().verdict, null);
    assert.ok(
      watchdog
        .summary()
        .warnings.includes(
          "verdict withdrawn: the deadlock's channels changed before termination",
        ),
    );
  });

  it("after a withdrawn verdict, a new kill needs two fresh confirmations", async () => {
    // Only the re-check (third tree listing) sees the outside channel; the
    // tree looks deadlocked again from the next check on.
    const outside =
      "f42\ntIPv4\nd0x5eed\nn127.0.0.1:50000->192.0.2.1:443\nTST=ESTABLISHED\n";
    const { fixture, kills, watchdog } = harness("deadlock", "enforce", undefined, {
      textAt: (call) =>
        call === 3 ? `${scenario("deadlock").lsofText}${outside}` : undefined,
    });
    const root = fixture.info.rootPid;
    // Withdrawn at ~11 s; the next check (~16 s) is only the first sighting.
    await advance(19_000);
    assert.equal(kills.length, 0);
    // The second, ~21 s, kills.
    await advance(6000);
    watchdog.stop();
    assert.ok(killed(kills, -root, "SIGTERM"));
  });

  describe("a core that shares a channel with a process outside the tree", () => {
    const { info, lsofText } = scenario("deadlock");
    const [, reader] = pair(info);
    // The other end of the reader's socketpair, as its fd names it.
    const peerEnd = /\n(?:n->)(0x[0-9a-f]+)\n/.exec(
      lsofText.slice(lsofText.indexOf(`p${reader}\n`)),
    )?.[1];
    const withOutsider = `${lsofText}p77777\nf5\ntunix\nd${peerEnd ?? "missing"}\nn->0x1\n`;

    it("names the shared end, so the case is real", () => {
      assert.ok(peerEnd);
    });

    it("is not proven closed when an outside process holds an end", () => {
      const { lsof, tree, supervisorFds } = scenario("deadlock");
      const pids = tree.map((row) => row.pid);
      const classes = classifyFds(lsof, pids, supervisorFds);
      const verdict = decide({
        tree,
        classes,
        cpuDeltaByPid: zeroDeltas(tree),
        quietMs: config.idleMs,
        config,
      });
      assert.equal(verdict?.kind, "internal-deadlock");
      if (verdict?.kind !== "internal-deadlock") return;
      assert.equal(coreSharedOutside(verdict.core, classes, lsof, pids), false);
      assert.equal(
        coreSharedOutside(verdict.core, classes, parseLsof(withOutsider), pids),
        true,
      );
    });

    it("never kills it, and reports it at the external ceiling", async () => {
      const { kills, watchdog } = harness("deadlock", "enforce", undefined, {
        wideText: withOutsider,
      });
      await advance(16_000);
      assert.deepEqual(kills, []);
      assert.equal(watchdog.summary().verdict, null);
      await advance(54_000);
      watchdog.stop();
      assert.deepEqual(kills, []);
      assert.equal(watchdog.summary().verdict?.kind, "idle-external");
    });

    it("never kills when the whole-machine listing fails", async () => {
      const { kills, watchdog } = harness("deadlock", "enforce", undefined, {
        wideOk: false,
      });
      await advance(16_000);
      watchdog.stop();
      assert.deepEqual(kills, []);
      assert.equal(watchdog.summary().verdict, null);
    });
  });

  it("a hook that exits during the grace period still has its verified survivors killed", async () => {
    // stop() is what the supervisor calls when the hook exits, which SIGTERM
    // usually causes: the kill already begun must still reach what outlived it.
    const { fixture, kills, watchdog } = harness("deadlock", "enforce");
    for (let waited = 0; waited < 20_000; waited += 50) {
      if (kills.some(([, signal]) => signal === "SIGTERM")) break;
      await advance(50);
    }
    assert.ok(killed(kills, -fixture.info.rootPid, "SIGTERM"));
    assert.ok(!kills.some(([, signal]) => signal === "SIGKILL"));
    watchdog.stop();
    await advance(2000);
    assert.ok(killed(kills, -fixture.info.rootPid, "SIGKILL"));
  });

  it("disarmed while a verdict's diagnostics run, it sends no signal", async () => {
    let release = (): void => {};
    let sampling = false;
    const paused = new Promise<void>((done) => {
      release = done;
    });
    const { kills, watchdog } = harness(
      "deadlock",
      "enforce",
      undefined,
      {},
      {},
      async () => {
        sampling = true;
        await paused;
      },
    );
    await advance(16_000);
    // The verdict is in, and its diagnostics are pending.
    assert.equal(sampling, true);
    assert.equal(watchdog.summary().verdict?.kind, "internal-deadlock");
    watchdog.disarm();
    release();
    await advance(16_000);
    watchdog.stop();
    assert.deepEqual(kills, []);
    assert.equal(watchdog.enforced(), false);
  });

  it("runs ps in the C locale, the only one its rows parse in", async () => {
    const { watchdog, psEnvs } = harness("sleep", "enforce");
    await advance(3000);
    watchdog.stop();
    assert.ok(psEnvs.length > 0);
    for (const env of psEnvs) assert.equal(env?.["LC_ALL"], "C");
  });

  it("does nothing after a user signal disarms it", async () => {
    const { kills, watchdog, psCalls } = harness("deadlock", "enforce");
    await advance(2000);
    watchdog.disarm();
    const before = psCalls();
    await advance(20_000);
    watchdog.stop();
    assert.deepEqual(kills, []);
    assert.equal(psCalls(), before);
  });
});
