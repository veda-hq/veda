import assert from "node:assert/strict";
import fs, {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import {
  DEFAULT_EXTERNAL_IDLE_MS,
  DEFAULT_GRACE_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_SAMPLE_MS,
  EXEMPT_COMMANDS,
  HANG_RETENTION_MS,
  LSOF_ARGS,
  MAX_TIMER_MS,
  PS_ARGS,
  WATCHDOG_EXIT_CODE,
  advanceWindow,
  buildTree,
  classifyFds,
  coreIdentity,
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
  type Clock,
  type Exec,
  type ExecResult,
  type RunWatchdog,
  type WatchdogConfig,
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
      [],
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
      [],
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
      [],
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
      const classes = classifyFds(new Map([[1, [fd]]]), [1], []);
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

  it("finds no deadlock in a tree waiting in the heavy-work queue, until the external ceiling", () => {
    const { lsof, tree, supervisorFds } = scenario("deadlock");
    const classes = classifyFds(
      lsof,
      tree.map((row) => row.pid),
      supervisorFds,
    );
    const at = (quietMs: number, queued?: boolean) =>
      decide({
        tree,
        classes,
        cpuDeltaByPid: zeroDeltas(tree),
        quietMs,
        config,
        ...(queued === undefined ? {} : { queued }),
      });
    assert.equal(at(config.idleMs, true), null);
    assert.equal(at(config.idleMs, false)?.kind, "internal-deadlock");
    assert.equal(at(config.idleMs)?.kind, "internal-deadlock");
    assert.deepEqual(at(config.externalIdleMs, true), {
      kind: "idle-external",
      quietMs: config.externalIdleMs,
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
      const [, reader] = tree;
      if (!reader) throw new Error("the deadlock tree has two rows");
      // Under no member of the core, so only the exemption can spare it.
      return [
        ...tree,
        { ...reader, pid: 999_991, ppid: 999_990, comm: "sleep", key: "sleep" },
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
      resolveWatchdogConfig({ DVARA_WATCHDOG: "off" }, "darwin", []).mode,
      "off",
    );
  });

  it("is unsupported off macOS unless switched off", () => {
    assert.equal(resolveWatchdogConfig({}, "linux", []).mode, "unsupported");
    assert.equal(
      resolveWatchdogConfig({ DVARA_WATCHDOG: "off" }, "linux", []).mode,
      "off",
    );
  });

  for (const raw of [undefined, "", "0", "-1", "abc", "1.5"])
    it(`keeps the default idle window rather than removing it for ${String(JSON.stringify(raw))}`, () => {
      assert.equal(
        resolveWatchdogConfig({ DVARA_WATCHDOG_IDLE_MS: raw }, "darwin", []).idleMs,
        DEFAULT_IDLE_MS,
      );
    });

  it("clamps an override past the timer ceiling", () => {
    assert.equal(
      resolveWatchdogConfig(
        { DVARA_WATCHDOG_IDLE_MS: String(2 ** 40) },
        "darwin",
        [],
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
        [],
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

/** A `ps` row with only what a case sets; the key is the pid and `started`. */
const psRow = (pid: number, ppid: number, fields: Partial<PsRow> = {}): PsRow => ({
  pid,
  ppid,
  pgid: 1,
  state: "S",
  cpuMs: 0,
  started: "start",
  comm: "node",
  key: `${pid}@start`,
  ...fields,
});

/** An `lsof` fd with only the fields a case sets. */
const lsofFd = (fd: string, fields: Partial<LsofFd> = {}): LsofFd => ({
  fd,
  type: null,
  device: null,
  inode: null,
  name: null,
  tcpState: null,
  ...fields,
});

/** A classified fd, for the functions that read `classifyFds`' result. */
const classified = (
  cls: ClassifiedFd["class"],
  peerPid: number | null,
  fields: Partial<LsofFd> = {},
): ClassifiedFd => ({ ...lsofFd("3", fields), class: cls, peerPid });

describe("the watchdog's fixed arguments and tables", () => {
  it("lists every process with the columns PS_ROW reads", () => {
    assert.deepEqual(PS_ARGS, [
      "-axo",
      "pid=,ppid=,pgid=,state=,time=,lstart=,comm=",
    ]);
  });

  it("lists open files without name lookups, warnings or anything but the fields read", () => {
    assert.deepEqual(LSOF_ARGS, ["-nP", "-w", "-F", "pftdinT"]);
  });

  it("keeps hang diagnostics for fourteen days", () => {
    assert.equal(HANG_RETENTION_MS, 1_209_600_000);
  });

  it("exempts each opaque or timed command, by name or by path", () => {
    for (const name of [
      "sleep",
      "xcodebuild",
      "xcrun",
      "simctl",
      "actool",
      "ibtool",
      "SWBBuildService",
      "XCBBuildService",
      "docker",
      "docker-buildx",
      "com.docker.cli",
      "osascript",
      "pod",
    ]) {
      assert.equal(EXEMPT_COMMANDS.test(name), true, name);
      assert.equal(EXEMPT_COMMANDS.test(`/usr/bin/${name}`), true, name);
    }
  });

  it("exempts no command that only contains an exempt name", () => {
    for (const name of [
      "nosleep",
      "sleepy",
      "/bin/sleep2",
      "a-sleep",
      "dockerd",
      "comXdockerXcli",
      "podman",
    ])
      assert.equal(EXEMPT_COMMANDS.test(name), false, name);
  });
});

describe("parseCpuTime's edges", () => {
  it("reads hundredths in the long form and multi-digit days and hours", () => {
    for (const [text, ms] of [
      ["02:03:04.56", 7_384_560],
      ["1-02:03:04.56", 93_784_560],
      ["12-02:03:04", 1_044_184_000],
      ["123:03:04", 442_984_000],
      ["02:03.04", 123_040],
    ] as const)
      assert.equal(parseCpuTime(text), ms, text);
  });

  it("refuses a time with anything before or after it, or a short fraction", () => {
    for (const text of [
      "x0:00.07",
      "0:00.07x",
      "0:00.071",
      "x02:03:04",
      "02:03:04x",
      "02:03:04.5",
      "02:03:04.ab",
      "02:03:04.",
      "x-02:03:04",
    ])
      assert.equal(parseCpuTime(text), null, text);
  });
});

describe("parsePs's row shapes", () => {
  it("reads a row with no padding and single spaces", () => {
    assert.deepEqual(
      parsePs("123 1 123 Ss 0:00.07 Sun Sep 13 17:16:29 2026 bash\n"),
      {
        rows: [
          {
            pid: 123,
            ppid: 1,
            pgid: 123,
            state: "Ss",
            cpuMs: 70,
            started: "Sun Sep 13 17:16:29 2026",
            comm: "bash",
            key: "123@Sun Sep 13 17:16:29 2026",
          },
        ],
        malformed: 0,
      },
    );
  });

  it("reads padded columns, a one-digit day and a command with spaces", () => {
    assert.deepEqual(
      parsePs(
        "  40375   40365   40351   S+    12:03.45   Thu  Sep   3   07:06:05   2026    Google Chrome Helper   \n",
      ),
      {
        rows: [
          {
            pid: 40375,
            ppid: 40365,
            pgid: 40351,
            state: "S+",
            cpuMs: 723_450,
            started: "Thu Sep 3 07:06:05 2026",
            comm: "Google Chrome Helper",
            key: "40375@Thu Sep 3 07:06:05 2026",
          },
        ],
        malformed: 0,
      },
    );
  });

  it("skips blank and whitespace-only lines without counting them", () => {
    assert.deepEqual(parsePs("\n   \n\t\n"), { rows: [], malformed: 0 });
  });

  it("counts a well-shaped row whose CPU time does not parse as malformed", () => {
    assert.deepEqual(
      parsePs("123 1 123 S 1:2.3 Sun Sep 13 17:16:29 2026 bash\n"),
      { rows: [], malformed: 1 },
    );
  });

  it("counts a row with anything before its pid as malformed", () => {
    assert.deepEqual(
      parsePs("x123 1 123 S 0:00.07 Sun Sep 13 17:16:29 2026 bash\n"),
      { rows: [], malformed: 1 },
    );
  });
});

describe("buildTree's shapes", () => {
  it("takes every child of a parent, then their children, and nothing else", () => {
    const rows = [
      psRow(4, 2),
      psRow(1, 0),
      psRow(2, 1),
      psRow(3, 1),
      psRow(9, 8),
    ];
    assert.deepEqual(
      buildTree(rows, 1).map((row) => row.pid),
      [1, 2, 3, 4],
    );
  });

  it("is empty when the root is not in the snapshot", () => {
    assert.deepEqual(buildTree([psRow(1, 0), psRow(2, 1)], 7), []);
  });

  it("takes a root that is its own parent once", () => {
    assert.deepEqual(
      buildTree([psRow(1, 1), psRow(2, 1)], 1).map((row) => row.pid),
      [1, 2],
    );
  });
});

describe("advanceWindow's thresholds", () => {
  const observation = (
    at: number,
    wallAt: number,
    tree: readonly PsRow[],
  ): Observation => ({ at, wallAt, tree, stageBytes: 0 });

  it("starts a window with the tree's keys sorted and joined", () => {
    const tree = [psRow(2, 1, { key: "2@b", cpuMs: 7 }), psRow(1, 0, { key: "1@a" })];
    assert.deepEqual(
      advanceWindow(null, observation(0, 0, tree), {
        sampleMs: 1000,
        cpuQuietMs: 100,
      }),
      {
        quietSince: 0,
        lastAt: 0,
        lastWallAt: 0,
        members: "1@a|2@b",
        stageBytes: 0,
        baseCpu: new Map([
          ["2@b", 7],
          ["1@a", 0],
        ]),
        windowCpuMs: 0,
        lastCheckAt: null,
        checkCpu: null,
        resetReason: "start",
      },
    );
  });

  it("allows a gap of three samples when that is above 15 s, and not a millisecond more", () => {
    const tree = [psRow(1, 0)];
    const config = { sampleMs: 10_000, cpuQuietMs: 100 };
    const first = advanceWindow(null, observation(0, 0, tree), config);
    for (const [at, reason] of [
      [20_000, null],
      [30_000, null],
      [30_001, "sampling-gap"],
    ] as const)
      assert.equal(
        advanceWindow(first, observation(at, at, tree), config).resetReason,
        reason,
        String(at),
      );
  });

  it("allows a gap of 15 s when three samples are shorter, and not a millisecond more", () => {
    const tree = [psRow(1, 0)];
    const config = { sampleMs: 1000, cpuQuietMs: 100 };
    const first = advanceWindow(null, observation(0, 0, tree), config);
    for (const [at, reason] of [
      [15_000, null],
      [15_001, "sampling-gap"],
    ] as const)
      assert.equal(
        advanceWindow(first, observation(at, at, tree), config).resetReason,
        reason,
        String(at),
      );
  });

  it("allows 5 s of drift between the clocks, and not a millisecond more", () => {
    const tree = [psRow(1, 0)];
    const config = { sampleMs: 5000, cpuQuietMs: 100 };
    const first = advanceWindow(null, observation(0, 0, tree), config);
    for (const [wallAt, reason] of [
      [10_000, null],
      [0, null],
      [10_001, "clock-jump"],
    ] as const)
      assert.equal(
        advanceWindow(first, observation(5000, wallAt, tree), config)
          .resetReason,
        reason,
        String(wallAt),
      );
  });

  it("restarts on a running, uninterruptible, disk-waiting or stopped process, by its first letter", () => {
    const config = { sampleMs: 5000, cpuQuietMs: 100 };
    const first = advanceWindow(
      null,
      observation(0, 0, [psRow(1, 0)]),
      config,
    );
    for (const [state, reason] of [
      ["R", "process-state"],
      ["U", "process-state"],
      ["D", "process-state"],
      ["T", "process-state"],
      ["Ss", null],
      ["SR", null],
    ] as const)
      assert.equal(
        advanceWindow(
          first,
          observation(5000, 5000, [psRow(1, 0, { state })]),
          config,
        ).resetReason,
        reason,
        state,
      );
  });

  it("tolerates CPU up to cpuQuietMs, and not a millisecond more", () => {
    const config = { sampleMs: 5000, cpuQuietMs: 100 };
    const first = advanceWindow(
      null,
      observation(0, 0, [psRow(1, 0, { cpuMs: 50 })]),
      config,
    );
    const at = advanceWindow(
      first,
      observation(5000, 5000, [psRow(1, 0, { cpuMs: 150 })]),
      config,
    );
    assert.equal(at.resetReason, null);
    assert.equal(at.windowCpuMs, 100);
    assert.equal(
      advanceWindow(
        first,
        observation(5000, 5000, [psRow(1, 0, { cpuMs: 151 })]),
        config,
      ).resetReason,
      "cpu",
    );
  });
});

describe("parseLsof's fields", () => {
  it("reads each field of each fd, and only the TCP state of the T lines", () => {
    const text = [
      "p12",
      "fcwd",
      "tDIR",
      "n/home",
      "f3",
      "tIPv4",
      "d0xabc",
      "i123",
      "n1.2.3.4:5->6.7.8.9:10",
      "TST=ESTABLISHED",
      "TQR=0",
      "TQS=0",
      "p13",
      "",
      "f0",
      "tPIPE",
      "",
    ].join("\n");
    assert.deepEqual(
      parseLsof(text),
      new Map([
        [
          12,
          [
            lsofFd("cwd", { type: "DIR", name: "/home" }),
            lsofFd("3", {
              type: "IPv4",
              device: "0xabc",
              inode: "123",
              name: "1.2.3.4:5->6.7.8.9:10",
              tcpState: "ESTABLISHED",
            }),
          ],
        ],
        [13, [lsofFd("0", { type: "PIPE" })]],
      ]),
    );
  });

  it("lists a process with no open files as an empty list", () => {
    assert.deepEqual(parseLsof("p7\n"), new Map([[7, []]]));
  });

  it("takes a TCP state only from a T line", () => {
    assert.deepEqual(
      parseLsof("p1\nf3\ntIPv4\nTST=LISTEN\naST=CLOSED\n"),
      new Map([[1, [lsofFd("3", { type: "IPv4", tcpState: "LISTEN" })]]]),
    );
  });

  it("drops fields that belong to no process or to no fd", () => {
    assert.deepEqual(
      parseLsof("f3\ntREG\np1\ntCHR\nf4\n"),
      new Map([[1, [lsofFd("4")]]]),
    );
  });
});

describe("classifyFds by shape", () => {
  it("classifies only numeric fds of tree processes", () => {
    const keep = lsofFd("10", { type: "REG" });
    const lsof = new Map([
      [
        1,
        [
          lsofFd("cwd", { type: "DIR" }),
          lsofFd("txt", { type: "REG" }),
          keep,
          lsofFd("x3", { type: "REG" }),
          lsofFd("3x", { type: "REG" }),
        ],
      ],
      [99, [lsofFd("4", { type: "REG" })]],
    ]);
    assert.deepEqual(
      classifyFds(lsof, [1], []),
      new Map([[1, [{ ...keep, class: "ignored", peerPid: null }]]]),
    );
  });

  it("ignores every fd type that is not a channel to another process", () => {
    const types = [
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
    ];
    const fds = types.map((type, i) => lsofFd(String(i), { type, name: "x" }));
    assert.deepEqual(
      classesOf(classifyFds(new Map([[1, fds]]), [1], []), 1).map((fd) => fd.class),
      types.map(() => "ignored"),
    );
  });

  it("ignores TCP in every closed state, and only in those", () => {
    const states = [
      "CLOSE_WAIT",
      "TIME_WAIT",
      "FIN_WAIT_1",
      "FIN_WAIT_2",
      "CLOSED",
      "LAST_ACK",
      "CLOSING",
      "LISTEN",
      "SYN_SENT",
    ];
    const fds = states.map((tcpState, i) =>
      lsofFd(String(i), { type: "IPv6", name: "a:1->b:2", tcpState }),
    );
    assert.deepEqual(
      classesOf(classifyFds(new Map([[1, fds]]), [1], []), 1).map((fd) => fd.class),
      [
        "ignored",
        "ignored",
        "ignored",
        "ignored",
        "ignored",
        "ignored",
        "ignored",
        "external",
        "external",
      ],
    );
  });

  it("reads only IPv4 and IPv6 as TCP", () => {
    const fds = ["XIPv4", "IPv4x", "IPv5", "IPv4"].map((type, i) =>
      lsofFd(String(i), { type, name: "a:1->b:2", tcpState: "CLOSE_WAIT" }),
    );
    assert.deepEqual(
      classesOf(classifyFds(new Map([[1, fds]]), [1], []), 1).map((fd) => fd.class),
      ["external", "external", "external", "ignored"],
    );
  });

  it("pairs a TCP connection only with the IPv4 or IPv6 fd on its other end", () => {
    const client = lsofFd("3", {
      type: "IPv4",
      name: "a:1->b:2",
      tcpState: "ESTABLISHED",
    });
    const clientClass = (peer: LsofFd) =>
      classesOf(classifyFds(new Map([[1, [client]], [2, [peer]]]), [1, 2], []), 1);
    for (const type of ["XIPv4", "IPv4x", "IPv5", "unix"])
      assert.deepEqual(
        clientClass(lsofFd("3", { type, name: "b:2->a:1" })),
        [{ ...client, class: "external", peerPid: null }],
        type,
      );
    assert.deepEqual(
      clientClass(lsofFd("3", { type: "IPv4" })),
      [{ ...client, class: "external", peerPid: null }],
    );
    assert.deepEqual(
      clientClass(
        lsofFd("3", {
          type: "IPv6",
          name: "b:2->a:1",
          tcpState: "ESTABLISHED",
        }),
      ),
      [{ ...client, class: "internal", peerPid: 2 }],
    );
  });

  it("reads a connection only from a name that is wholly one", () => {
    const server = lsofFd("3", {
      type: "IPv4",
      name: "b:2->a:1",
      tcpState: "ESTABLISHED",
    });
    for (const name of ["x a:1->b:2", "a:1->b:2 x"]) {
      const client = lsofFd("3", { type: "IPv4", name, tcpState: "ESTABLISHED" });
      assert.deepEqual(
        classesOf(
          classifyFds(new Map([[1, [client]], [2, [server]]]), [1, 2], []),
          1,
        ),
        [{ ...client, class: "external", peerPid: null }],
        JSON.stringify(name),
      );
    }
  });

  it("pairs only an established connection", () => {
    const server = lsofFd("3", {
      type: "IPv4",
      name: "b:2->a:1",
      tcpState: "ESTABLISHED",
    });
    for (const tcpState of ["SYN_SENT", null]) {
      const client = lsofFd("3", { type: "IPv4", name: "a:1->b:2", tcpState });
      assert.deepEqual(
        classesOf(
          classifyFds(new Map([[1, [client]], [2, [server]]]), [1, 2], []),
          1,
        ),
        [{ ...client, class: "external", peerPid: null }],
        String(tcpState),
      );
    }
  });

  it("ignores a socket whose peer the supervisor holds", () => {
    const socket = lsofFd("3", { type: "unix", device: "0xa", name: "->0x5" });
    const supervisor = [lsofFd("9", { type: "unix", device: "0x5" })];
    assert.deepEqual(
      classifyFds(new Map([[1, [socket]]]), [1], supervisor),
      new Map([[1, [{ ...socket, class: "ignored", peerPid: null }]]]),
    );
    assert.deepEqual(
      classifyFds(new Map([[1, [socket]]]), [1], []),
      new Map([[1, [{ ...socket, class: "external", peerPid: null }]]]),
    );
  });

  it("ignores a socket with a zero peer, and no other", () => {
    const fds = [
      "->0x0000000000000000",
      "->0x00",
      "->0X0",
      "->0x01",
      "->0x10",
    ].map((name, i) => lsofFd(String(i), { type: "unix", name }));
    assert.deepEqual(
      classesOf(classifyFds(new Map([[1, fds]]), [1], []), 1).map((fd) => fd.class),
      ["ignored", "ignored", "ignored", "external", "external"],
    );
  });

  it("ignores a nameless pipe and keeps a named socket with no peer external", () => {
    const fds = [
      lsofFd("3", { type: "PIPE" }),
      lsofFd("4", { type: "unix", name: "/var/run/docker.sock" }),
    ];
    assert.deepEqual(
      classesOf(classifyFds(new Map([[1, fds]]), [1], []), 1).map((fd) => fd.class),
      ["ignored", "external"],
    );
  });

  it("reads a peer address only from a name that is exactly an arrow and an address", () => {
    const holder = lsofFd("5", { type: "unix", device: "0xb" });
    const fds = ["x->0xb", "->0xbz", "->0xb"].map((name, i) =>
      lsofFd(String(i), { type: "unix", name }),
    );
    assert.deepEqual(
      classesOf(
        classifyFds(new Map([[1, fds], [2, [holder]]]), [1, 2], []),
        1,
      ).map((fd) => [fd.class, fd.peerPid]),
      [
        ["external", null],
        ["external", null],
        ["internal", 2],
      ],
    );
  });

  it("names another holder of a socket's peer as its peer, and itself only when it is the only one", () => {
    const lsof = new Map([
      [
        1,
        [
          lsofFd("3", { type: "unix", device: "0xa", name: "->0xb" }),
          lsofFd("4", { type: "unix", device: "0xb", name: "->0xa" }),
        ],
      ],
      [2, [lsofFd("3", { type: "unix", device: "0xb", name: "->0xa" })]],
      [
        3,
        [
          lsofFd("3", { type: "unix", device: "0xc", name: "->0xd" }),
          lsofFd("4", { type: "unix", device: "0xd", name: "->0xc" }),
        ],
      ],
    ]);
    const classes = classifyFds(lsof, [1, 2, 3], []);
    const peers = (pid: number) =>
      classesOf(classes, pid).map((fd) => [fd.class, fd.peerPid]);
    assert.deepEqual(peers(1), [
      ["internal", 2],
      ["internal", 1],
    ]);
    assert.deepEqual(peers(3), [
      ["internal", 3],
      ["internal", 3],
    ]);
  });

  it("pairs a FIFO with the other tree process that holds it, and no FIFO without one", () => {
    const lsof = new Map([
      [
        1,
        [
          lsofFd("3", { type: "FIFO", device: "0xf" }),
          lsofFd("4", { type: "FIFO", device: "0xg" }),
          lsofFd("5", { type: "FIFO" }),
          lsofFd("6", { type: "FIFO", device: "" }),
        ],
      ],
      [
        2,
        [
          lsofFd("3", { type: "FIFO", device: "0xf" }),
          lsofFd("6", { type: "FIFO", device: "" }),
        ],
      ],
    ]);
    const classes = classifyFds(lsof, [1, 2], []);
    const peers = (pid: number) =>
      classesOf(classes, pid).map((fd) => [fd.class, fd.peerPid]);
    assert.deepEqual(peers(1), [
      ["internal", 2],
      ["external", null],
      ["external", null],
      ["external", null],
    ]);
    assert.deepEqual(peers(2), [
      ["internal", 1],
      ["external", null],
    ]);
  });
});

describe("findHangCore by shape", () => {
  it("spares a leaf that also holds an external channel", () => {
    const tree = [psRow(1, 0), psRow(2, 1)];
    const classes = new Map([
      [1, [classified("internal", 2)]],
      [2, [classified("internal", 1), classified("external", null)]],
    ]);
    assert.equal(findHangCore(tree, classes, zeroDeltas(tree)), null);
  });

  it("spares a leaf whose only channels lead back to itself", () => {
    const tree = [psRow(1, 0), psRow(2, 1)];
    const classes = new Map([
      [2, [classified("internal", 2), classified("internal", null)]],
    ]);
    assert.equal(findHangCore(tree, classes, zeroDeltas(tree)), null);
  });

  it("follows only internal channels with a peer", () => {
    const tree = [psRow(1, 0), psRow(2, 1), psRow(3, 0)];
    const classes = new Map([
      [
        1,
        [
          classified("internal", 2),
          classified("ignored", 3),
          classified("internal", null),
        ],
      ],
      [2, [classified("internal", 1)]],
    ]);
    assert.deepEqual(findHangCore(tree, classes, zeroDeltas(tree)), {
      leaf: 2,
      peers: [1],
    });
  });
});

describe("coreIdentity", () => {
  it("joins the sorted keys of the core's processes, and of no other", () => {
    const tree = [
      psRow(3, 2, { key: "3@c" }),
      psRow(1, 0, { key: "1@a" }),
      psRow(2, 1, { key: "2@b" }),
    ];
    assert.equal(coreIdentity(tree, { leaf: 3, peers: [1] }), "1@a|3@c");
  });
});

describe("coreSharedOutside by shape", () => {
  it("finds an outside holder of an internal fd's object", () => {
    const core = { leaf: 2, peers: [1] };
    const classes = new Map([
      [2, [classified("internal", 1, { device: "0xa" })]],
      [1, [classified("internal", 2)]],
    ]);
    const wide = new Map([
      [1, [lsofFd("3")]],
      [2, [lsofFd("3", { device: "0xa" })]],
      [50, [lsofFd("3", { device: "0xq" }), lsofFd("4", { device: "0xa" })]],
    ]);
    assert.equal(coreSharedOutside(core, classes, wide, [1, 2]), true);
  });

  it("finds an outside holder of an internal socket's peer", () => {
    const core = { leaf: 2, peers: [1] };
    const classes = new Map([
      [2, [classified("internal", 1, { name: "->0x9" })]],
    ]);
    const wide = new Map([[50, [lsofFd("3", { device: "0x9" })]]]);
    assert.equal(coreSharedOutside(core, classes, wide, [1, 2]), true);
  });

  it("does not count an outside holder of an ignored fd's object, or a tree holder", () => {
    const core = { leaf: 2, peers: [1] };
    const classes = new Map([
      [2, [classified("ignored", null, { device: "0xe", name: "->0x7" })]],
      [1, [classified("internal", 2, { device: "0xa" })]],
    ]);
    const wide = new Map([
      [50, [lsofFd("3", { device: "0xe" }), lsofFd("4", { device: "0x7" })]],
      [1, [lsofFd("3", { device: "0xa" })]],
      [2, [lsofFd("3", { device: "0xa" })]],
    ]);
    assert.equal(coreSharedOutside(core, classes, wide, [1, 2]), false);
  });

  it("does not take an empty device for an object", () => {
    const core = { leaf: 2, peers: [1] };
    const classes = new Map([
      [2, [classified("internal", 1, { device: "" })]],
    ]);
    const wide = new Map([[50, [lsofFd("3", { device: "" })]]]);
    assert.equal(coreSharedOutside(core, classes, wide, [1, 2]), false);
  });
});

describe("decide by shape", () => {
  it("spares a core when another leaf holds an external channel", () => {
    const config = { idleMs: 1000, externalIdleMs: 5000 };
    const tree = [psRow(1, 0), psRow(2, 1), psRow(3, 0)];
    const classes = new Map([
      [1, [classified("internal", 2)]],
      [2, [classified("internal", 1)]],
      [3, [classified("ignored", null), classified("external", null)]],
    ]);
    assert.equal(
      decide({
        tree,
        classes,
        cpuDeltaByPid: zeroDeltas(tree),
        quietMs: 1000,
        config,
      }),
      null,
    );
  });

  it("does not count an external channel of a process with children", () => {
    const config = { idleMs: 1000, externalIdleMs: 5000 };
    const tree = [psRow(1, 0), psRow(2, 1), psRow(3, 2), psRow(4, 1)];
    const classes = new Map([
      [1, [classified("external", null)]],
      [2, [classified("internal", 3)]],
      [3, [classified("internal", 2)]],
    ]);
    assert.deepEqual(
      decide({
        tree,
        classes,
        cpuDeltaByPid: zeroDeltas(tree),
        quietMs: 1000,
        config,
      }),
      { kind: "internal-deadlock", core: { leaf: 3, peers: [2] }, quietMs: 1000 },
    );
  });
});

describe("exitDisposition's shapes", () => {
  it("imposes 124 and timed_out for an acted-on internal deadlock", () => {
    assert.deepEqual(
      exitDisposition({ acted: true, verdict: { kind: "internal-deadlock" } }),
      { code: 124, status: "timed_out" },
    );
  });

  it("keeps the hook's outcome for a verdict that is not an object with a kind", () => {
    for (const verdict of ["internal-deadlock", null, {}])
      assert.equal(
        exitDisposition({ acted: true, verdict }),
        null,
        JSON.stringify(verdict),
      );
    assert.equal(exitDisposition(null), null);
  });
});

describe("resolveWatchdogConfig's reasons", () => {
  it("says an explicit mode is explicit", () => {
    assert.deepEqual(
      resolveWatchdogConfig({ DVARA_WATCHDOG: "report" }, "darwin", []),
      {
        mode: "report",
        reason: "explicit",
        idleMs: 600_000,
        externalIdleMs: 3_600_000,
        sampleMs: 5000,
        graceMs: 10_000,
        cpuQuietMs: 1200,
      },
    );
  });

  it("says why it is unsupported off macOS", () => {
    assert.partialDeepStrictEqual(resolveWatchdogConfig({}, "linux", []), {
      mode: "unsupported",
      reason: "non-darwin",
    });
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
    /** The heavy-work queue's answer; the machine's queue when left out. */
    queued?: (pids: readonly number[]) => boolean,
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
        ...resolveWatchdogConfig({ DVARA_WATCHDOG: mode }, "darwin", []),
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
      ...(queued ? { queued } : {}),
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

  describe("a hook waiting in the heavy-work queue (RFC-0060 S7)", () => {
    it("is never stopped as a deadlock, and the queue is asked about the tree's processes", async () => {
      const asked: number[][] = [];
      const { fixture, kills, watchdog } = harness(
        "deadlock",
        "enforce",
        undefined,
        {},
        {},
        undefined,
        (pids) => {
          asked.push([...pids]);
          return true;
        },
      );
      await advance(16_000);
      watchdog.stop();
      assert.deepEqual(kills, []);
      assert.equal(watchdog.summary().verdict, null);
      assert.ok(asked.length > 0);
      assert.deepEqual(
        asked[0]?.toSorted((a, b) => a - b),
        fixture.tree.map((row) => row.pid).toSorted((a, b) => a - b),
      );
    });

    it("withdraws a verdict when the hook starts waiting before the kill", async () => {
      let checks = 0;
      const [, reader] = pair(scenario("deadlock").info);
      // Only the re-check before the kill finds the waiter, and only among the tree's own processes.
      const { kills, watchdog } = harness(
        "deadlock",
        "enforce",
        undefined,
        {},
        {},
        undefined,
        (pids) => ++checks > 2 && pids.includes(reader),
      );
      await advance(16_000);
      watchdog.stop();
      assert.deepEqual(kills, []);
      assert.ok(
        watchdog
          .summary()
          .warnings.includes(
            "verdict withdrawn: the deadlock's channels changed before termination",
          ),
        JSON.stringify(watchdog.summary().warnings),
      );
    });

    it("reads the machine's queue by default, from DVARA_TURN_DIR", async () => {
      const queue = mkdtempSync(join(tmpdir(), "watchdog-turns-"));
      dirs.push(queue);
      const saved = process.env["DVARA_TURN_DIR"];
      process.env["DVARA_TURN_DIR"] = queue;
      try {
        mkdirSync(join(queue, "waiters"));
        // An entry with no start identity: spared without asking `ps`.
        const [, reader] = pair(scenario("deadlock").info);
        writeFileSync(join(queue, "waiters", String(reader)), "");
        const { kills, watchdog } = harness("deadlock", "enforce");
        await advance(16_000);
        watchdog.stop();
        assert.deepEqual(kills, []);
      } finally {
        if (saved === undefined) delete process.env["DVARA_TURN_DIR"];
        else process.env["DVARA_TURN_DIR"] = saved;
      }
    });
  });

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

/**
 * The watchdog driven step by step through a strict `exec`: every command
 * must carry exactly the arguments and options the watchdog is meant to
 * send, and anything else throws, which the watchdog records as a warning.
 * Each case asserts whole values: the commands in order, the signals, the
 * log lines, the summary and the diagnostics files.
 *
 * The tree is synthetic: a node root (40467) under the supervisor (40375),
 * a bash leaf (40479) on a socketpair with the root, and a zombie cat leaf
 * (40480) that holds nothing: an exited child wakes no parent, so the core
 * stays closed. The root also holds a pipe whose other end is
 * the supervisor's, so the supervisor's own listing decides whether it is
 * inherited.
 */
describe("createWatchdog, step by step", () => {
  const START = Date.UTC(2026, 8, 13, 12, 0, 0);
  const dirs: string[] = [];
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  const STEP_MS = 50;
  const advance = async (ms: number): Promise<void> => {
    for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
      mock.timers.tick(STEP_MS);
      await new Promise((done) => setImmediate(done));
    }
  };

  const ok = (stdout: string): ExecResult => ({ ok: true, stdout, stderr: "" });
  const times = (n: number, call: string): string[] =>
    Array.from({ length: n }, () => call);
  const psLine = (
    pid: number,
    ppid: number,
    pgid: number,
    comm: string,
    { state = "S", time = "0:00.00" } = {},
  ): string =>
    `${pid} ${ppid} ${pgid} ${state}      ${time} Sun Sep 13 17:16:29 2026     ${comm}`;
  const psOf = (...rows: string[]): string => `${rows.join("\n")}\n`;

  /** The synthetic deadlock's rows and listings. */
  function fixture() {
    const supervisor = psLine(40375, 40365, 40351, "node", { time: "0:00.03" });
    const root = psLine(40467, 40375, 40351, "node", { time: "0:00.03" });
    const leaf = psLine(40479, 40467, 40351, "bash");
    const idle = psLine(40480, 40467, 40351, "cat", { state: "Z" });
    const supLsof =
      "p40375\nf0\ntCHR\nd0x10\nn/dev/ttys001\nf1\ntPIPE\nd0x11\nn->0x12\n";
    const treeLsof =
      "p40467\nf1\ntPIPE\nd0x12\nn->0x11\nf5\ntunix\nd0xa1\nn->0xb1\n" +
      "p40479\nf0\ntunix\nd0xb1\nn->0xa1\n" +
      "p40480\n";
    return {
      supervisor,
      root,
      leaf,
      idle,
      ps: psOf(supervisor, root, leaf, idle),
      supLsof,
      treeLsof,
      wideLsof: `${supLsof}${treeLsof}p1\nf3\ntunix\nd0xf1\nn->0xf2\n`,
    };
  }

  type Responder = (call: number) => ExecResult | Promise<ExecResult>;
  interface Script {
    readonly mode?: "enforce" | "report" | "off" | "unsupported";
    readonly reason?: string;
    readonly config?: Partial<WatchdogConfig>;
    readonly ps?: Responder;
    readonly supervisor?: Responder;
    readonly tree?: Responder;
    readonly wide?: Responder;
    readonly sample?: (pid: string) => Promise<ExecResult>;
    readonly hangsDir?: string;
    readonly stageFile?: string;
    readonly clock?: Clock;
    readonly treePids?: string;
    /** Real timers, the default clock and the default log. */
    readonly realTime?: boolean;
  }

  function watch(script: Script = {}) {
    const f = fixture();
    if (!script.realTime) {
      mock.timers.reset();
      mock.timers.enable({
        apis: ["setInterval", "setTimeout", "Date"],
        now: START,
      });
    }
    const base = mkdtempSync(join(tmpdir(), "watchdog-627-"));
    dirs.push(base);
    const hangsDir = script.hangsDir ?? join(base, "hangs");
    const runDir = join(hangsDir, "run-627");
    const calls: string[] = [];
    const kills: [number, string][] = [];
    const logs: string[] = [];
    const counts = { ps: 0, supervisor: 0, tree: 0, wide: 0 };
    const lsof = ["-nP", "-w", "-F", "pftdinT"];
    const exec: Exec = async (command, args, options) => {
      if (command === "ps") {
        assert.deepEqual(args, [
          "-axo",
          "pid=,ppid=,pgid=,state=,time=,lstart=,comm=",
        ]);
        assert.deepEqual(Object.keys(options).sort(), ["env", "timeout"]);
        assert.equal(options.timeout, 10_000);
        assert.equal(options.env?.["LC_ALL"], "C");
        assert.equal(options.env?.["PATH"], process.env["PATH"]);
        calls.push("ps");
        return (script.ps ?? (() => ok(f.ps)))(++counts.ps);
      }
      if (command === "lsof") {
        assert.deepEqual(options, { timeout: 20_000 });
        if (args.length === 4) {
          assert.deepEqual(args, lsof);
          calls.push("lsof wide");
          return (script.wide ?? (() => ok(f.wideLsof)))(++counts.wide);
        }
        if (args[5] === "40375") {
          assert.deepEqual(args, [...lsof, "-p", "40375"]);
          calls.push("lsof supervisor");
          return (script.supervisor ?? (() => ok(f.supLsof)))(
            ++counts.supervisor,
          );
        }
        assert.deepEqual(args, [
          ...lsof,
          "-p",
          script.treePids ?? "40467,40479,40480",
        ]);
        calls.push("lsof tree");
        return (script.tree ?? (() => ok(f.treeLsof)))(++counts.tree);
      }
      if (command === "sample") {
        const pid = String(args[0]);
        assert.deepEqual(args, [
          pid,
          "1",
          "-mayDie",
          "-file",
          join(runDir, `sample-${pid}.txt`),
        ]);
        assert.deepEqual(options, { timeout: 10_000 });
        calls.push(`sample ${pid}`);
        return (script.sample ?? (async () => ok("")))(pid);
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };
    const watchdog = createWatchdog({
      rootPid: 40467,
      supervisorPid: 40375,
      stageFile: script.stageFile ?? join(base, "no-stage-file"),
      hangsDir,
      runId: "run-627",
      config: {
        mode: script.mode ?? "enforce",
        reason: script.reason ?? "explicit",
        idleMs: 5000,
        externalIdleMs: 60_000,
        sampleMs: 1000,
        graceMs: 500,
        cpuQuietMs: 1000,
        ...script.config,
      },
      exec,
      kill: (pid, signal) => {
        kills.push([pid, signal]);
      },
      ...(script.realTime
        ? {}
        : {
            clock: script.clock ?? {
              now: () => Date.now() - START,
              wall: () => Date.now(),
            },
            log: (message: string) => {
              logs.push(message);
            },
          }),
    });
    return { f, base, hangsDir, runDir, calls, kills, logs, watchdog };
  }

  /** The commands of a deadlock found at ~6 s, confirmed at ~11 s and acted on. */
  const confirmed = (): string[] => [
    ...times(6, "ps"),
    "lsof supervisor",
    "lsof tree",
    "lsof wide",
    ...times(5, "ps"),
    "lsof tree",
    "lsof wide",
    "sample 40479",
    "sample 40467",
  ];
  const term = (): [number, string][] => [
    [-40467, "SIGTERM"],
    [40467, "SIGTERM"],
    [40479, "SIGTERM"],
    [40480, "SIGTERM"],
  ];
  const withdrawnByActivity =
    "verdict withdrawn: activity resumed before termination";
  const withdrawnByChannels =
    "verdict withdrawn: the deadlock's channels changed before termination";

  it("stops a deadlock found twice: these commands, signals, words and files", async () => {
    const base = mkdtempSync(join(tmpdir(), "watchdog-627-nested-"));
    dirs.push(base);
    // The hangs folder's parent does not exist yet: diagnostics create both.
    const hangsDir = join(base, "missing", "hangs");
    const { f, runDir, calls, kills, logs, watchdog } = watch({ hangsDir });
    await advance(11_600);
    watchdog.stop();
    assert.deepEqual(calls, [
      ...confirmed(),
      "ps",
      "lsof tree",
      "lsof wide",
      "ps",
    ]);
    assert.deepEqual(kills, [
      ...term(),
      [-40467, "SIGKILL"],
      [40467, "SIGKILL"],
      [40479, "SIGKILL"],
      [40480, "SIGKILL"],
    ]);
    assert.deepEqual(logs, [
      `\n❌ Hook watchdog: no progress for 0 min, and the stuck processes are waiting only on each other (40467 node, 40479 bash).\n` +
        `   This is a hang in the gate, not a test failure. Diagnostics: ${runDir}\n` +
        `   Stopping the hook; re-run it.\n`,
    ]);
    assert.deepEqual(watchdog.summary(), {
      mode: "enforce",
      reason: "explicit",
      idleMs: 5000,
      verdict: {
        kind: "internal-deadlock",
        quietMs: 10_000,
        core: { leaf: 40479, peers: [40467] },
      },
      acted: true,
      diagnostics: runDir,
      warnings: [],
    });
    assert.equal(watchdog.enforced(), true);
    assert.equal(statSync(runDir).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(runDir).sort(), [
      "lsof.txt",
      "ps.txt",
      "verdict.json",
    ]);
    assert.equal(readFileSync(join(runDir, "ps.txt"), "utf8"), f.ps);
    assert.equal(readFileSync(join(runDir, "lsof.txt"), "utf8"), f.treeLsof);
    assert.deepEqual(
      JSON.parse(readFileSync(join(runDir, "verdict.json"), "utf8")),
      {
        verdict: {
          kind: "internal-deadlock",
          core: { leaf: 40479, peers: [40467] },
          quietMs: 10_000,
        },
        tree: [
          { pid: 40467, ppid: 40375, pgid: 40351, state: "S", cpuMs: 30, comm: "node" },
          { pid: 40479, ppid: 40467, pgid: 40351, state: "S", cpuMs: 0, comm: "bash" },
          { pid: 40480, ppid: 40467, pgid: 40351, state: "Z", cpuMs: 0, comm: "cat" },
        ],
      },
    );
  });

  it("prunes diagnostics older than fourteen days by the wall clock, and only those", async () => {
    const base = mkdtempSync(join(tmpdir(), "watchdog-627-prune-"));
    dirs.push(base);
    const hangsDir = join(base, "hangs");
    // The verdict, and so the pruning, comes at 11 s on the wall clock.
    const pruneAt = START + 11_000;
    const fourteenDays = 1_209_600_000;
    const expired = join(hangsDir, "expired");
    mkdirSync(expired, { recursive: true });
    writeFileSync(join(expired, "ps.txt"), "old\n");
    utimesSync(expired, (pruneAt - fourteenDays - 1000) / 1000, (pruneAt - fourteenDays - 1000) / 1000);
    writeFileSync(join(hangsDir, "boundary"), "kept\n");
    utimesSync(join(hangsDir, "boundary"), (pruneAt - fourteenDays) / 1000, (pruneAt - fourteenDays) / 1000);
    writeFileSync(join(hangsDir, "fresh"), "kept\n");
    utimesSync(join(hangsDir, "fresh"), pruneAt / 1000, pruneAt / 1000);
    const { watchdog } = watch({ hangsDir, mode: "report" });
    await advance(11_000);
    watchdog.stop();
    assert.equal(watchdog.summary().verdict?.kind, "internal-deadlock");
    assert.deepEqual(readdirSync(hangsDir).sort(), [
      "boundary",
      "fresh",
      "run-627",
    ]);
  });

  it("times nothing when it stops without a verdict", async () => {
    const { watchdog } = watch();
    await advance(1000);
    watchdog.stop();
    assert.equal(watchdog.summary().verdict, null);
    assert.equal(Object.hasOwn(watchdog.summary(), "resolvedAfterMs"), false);
  });

  it("prunes every expired entry when one vanishes between its stat and its removal", async () => {
    const base = mkdtempSync(join(tmpdir(), "watchdog-627-prune-"));
    dirs.push(base);
    const hangsDir = join(base, "hangs");
    const expiredAt = (START + 11_000 - 1_209_600_000 - 1000) / 1000;
    for (const name of ["expired-a", "expired-b"]) {
      mkdirSync(join(hangsDir, name), { recursive: true });
      utimesSync(join(hangsDir, name), expiredAt, expiredAt);
    }
    // The first expired entry stat-ed is removed right after, as another
    // run's pruning would: its removal must not end the pruning.
    const realStat = fs.statSync;
    let vanished = "";
    mock.method(fs, "statSync", (path: string) => {
      const stats = realStat(path);
      if (vanished === "" && basename(path).startsWith("expired-")) {
        vanished = basename(path);
        rmSync(path, { recursive: true });
      }
      return stats;
    });
    syncBuiltinESMExports();
    try {
      const { watchdog } = watch({ hangsDir, mode: "report" });
      await advance(11_000);
      watchdog.stop();
      assert.equal(watchdog.summary().verdict?.kind, "internal-deadlock");
      assert.match(vanished, /^expired-[ab]$/);
      assert.deepEqual(readdirSync(hangsDir), ["run-627"]);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it("only reports in report mode, says when diagnostics fail, and times how the hook ended", async () => {
    const { calls, kills, logs, watchdog } = watch({
      mode: "report",
      sample: async () => {
        throw new Error("sample refused");
      },
    });
    await advance(13_000);
    watchdog.stop();
    assert.deepEqual(calls, [...confirmed(), "ps", "ps"]);
    assert.deepEqual(kills, []);
    assert.deepEqual(logs, [
      "\n⚠️  Hook watchdog (report): internal-deadlock after 0 min quiet. Diagnostics: unavailable\n",
    ]);
    assert.deepEqual(watchdog.summary(), {
      mode: "report",
      reason: "explicit",
      idleMs: 5000,
      verdict: {
        kind: "internal-deadlock",
        quietMs: 10_000,
        core: { leaf: 40479, peers: [40467] },
      },
      acted: false,
      diagnostics: null,
      warnings: ["diagnostics unavailable: sample refused"],
      resolvedAfterMs: 2000,
    });
    assert.equal(watchdog.enforced(), false);
  });

  it("still stops the deadlock when its diagnostics fail, and says they are unavailable", async () => {
    const { kills, logs, watchdog } = watch({
      sample: async () => {
        throw new Error("sample refused");
      },
    });
    await advance(11_600);
    watchdog.stop();
    assert.deepEqual(kills.slice(0, 4), term());
    assert.deepEqual(logs, [
      `\n❌ Hook watchdog: no progress for 0 min, and the stuck processes are waiting only on each other (40467 node, 40479 bash).\n` +
        `   This is a hang in the gate, not a test failure. Diagnostics: unavailable\n` +
        `   Stopping the hook; re-run it.\n`,
    ]);
    assert.deepEqual(watchdog.summary().warnings, [
      "diagnostics unavailable: sample refused",
    ]);
  });

  it("withdraws the verdict when ps fails at the re-check, whatever it printed", async () => {
    const { f, calls, kills, watchdog } = watch({
      ps: (call) =>
        call === 12
          ? { ok: false, stdout: f.ps, stderr: "ps: interrupted\n" }
          : ok(f.ps),
    });
    await advance(11_600);
    watchdog.stop();
    assert.deepEqual(calls, [...confirmed(), "ps"]);
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
    assert.deepEqual(watchdog.summary().warnings, [withdrawnByActivity]);
  });

  it("withdraws the verdict as activity when disarmed during its diagnostics", async () => {
    const { calls, kills, watchdog } = watch({
      sample: async (pid) => {
        if (pid === "40479") watchdog.disarm();
        return ok("");
      },
    });
    await advance(16_000);
    watchdog.stop();
    assert.deepEqual(calls, [...confirmed(), "ps"]);
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
    assert.deepEqual(watchdog.summary().warnings, [withdrawnByActivity]);
  });

  it("withdraws the verdict when the re-check finds a different core", async () => {
    // At the re-check the leaf's socketpair leads to the cat leaf instead of
    // the root: a deadlock still, but not the one the verdict named.
    const moved =
      "p40467\nf1\ntPIPE\nd0x12\nn->0x11\n" +
      "p40479\nf0\ntunix\nd0xb1\nn->0xc1\n" +
      "p40480\nf0\ntunix\nd0xc1\nn->0xb1\n";
    const { f, calls, kills, watchdog } = watch({
      tree: (call) => ok(call === 3 ? moved : f.treeLsof),
    });
    await advance(11_600);
    watchdog.stop();
    assert.deepEqual(calls, [...confirmed(), "ps", "lsof tree", "lsof wide"]);
    assert.deepEqual(kills, []);
    assert.deepEqual(watchdog.summary().warnings, [withdrawnByChannels]);
  });

  it("withdraws the verdict when the root spent CPU after the confirming check", async () => {
    const { f, kills, watchdog } = watch({
      ps: (call) =>
        ok(
          call === 12
            ? psOf(f.supervisor, psLine(40467, 40375, 40351, "node", { time: "0:00.06" }), f.leaf, f.idle)
            : f.ps,
        ),
    });
    await advance(11_600);
    watchdog.stop();
    assert.deepEqual(kills, []);
    assert.deepEqual(watchdog.summary().warnings, [withdrawnByChannels]);
  });

  it("withdraws the verdict when the re-check measures less than an idle window of quiet", async () => {
    // The clock steps back 6 s just before the re-check: by its own reading
    // the tree has been quiet 4 s, short of the 5 s window.
    let back = 0;
    const { f, kills, watchdog } = watch({
      clock: {
        now: () => Date.now() - START - back,
        wall: () => Date.now() - back,
      },
      ps: (call) => {
        if (call === 12) back = 6000;
        return ok(f.ps);
      },
    });
    await advance(11_600);
    watchdog.stop();
    assert.deepEqual(kills, []);
    assert.deepEqual(watchdog.summary().warnings, [withdrawnByChannels]);
  });

  it("measures each check's CPU from the check before it, not from the root's zero", async () => {
    // The root spends 30 ms between the first and second checks: not a
    // deadlock at the second, then two quiet checks after it are.
    const { f, kills, watchdog } = watch({
      ps: (call) =>
        ok(
          call >= 11
            ? psOf(f.supervisor, psLine(40467, 40375, 40351, "node", { time: "0:00.06" }), f.leaf, f.idle)
            : f.ps,
        ),
    });
    await advance(14_000);
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
    await advance(7600);
    watchdog.stop();
    assert.deepEqual(kills.slice(0, 4), term());
    assert.deepEqual(watchdog.summary().warnings, []);
  });

  it("forgets the core it saw once when the window restarts", async () => {
    // The leaf runs at the 7th sample: the window restarts, and the core it
    // saw at the first check must be seen twice again.
    const { f, kills, watchdog } = watch({
      ps: (call) =>
        ok(
          call === 7
            ? psOf(f.supervisor, f.root, psLine(40479, 40467, 40351, "bash", { state: "R" }), f.idle)
            : f.ps,
        ),
    });
    await advance(14_000);
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
    await advance(3600);
    watchdog.stop();
    assert.deepEqual(kills.slice(0, 4), term());
    assert.deepEqual(watchdog.summary().warnings, []);
  });

  it("forgets the core it saw once when a check in between finds none", async () => {
    // The second check's tree listing fails: no verdict there, so the core
    // seen at the first check needs two more sightings.
    const { f, calls, kills, watchdog } = watch({
      tree: (call) =>
        call === 2 ? { ok: false, stdout: f.treeLsof, stderr: "" } : ok(f.treeLsof),
    });
    await advance(19_000);
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
    assert.deepEqual(watchdog.summary().warnings, []);
    assert.deepEqual(calls.slice(0, 16), [
      ...times(6, "ps"),
      "lsof supervisor",
      "lsof tree",
      "lsof wide",
      ...times(5, "ps"),
      "lsof tree",
      "ps",
    ]);
    await advance(2600);
    watchdog.stop();
    assert.deepEqual(kills.slice(0, 4), term());
  });

  it("decides an outside wait at exactly the external ceiling, sampling at most four processes", async () => {
    const rows = [40481, 40482, 40483, 40484, 40485].map((pid) =>
      psLine(pid, 40467, 40351, "cat"),
    );
    const { f, calls, kills, logs, runDir, watchdog } = watch({
      config: { idleMs: 7000 },
      ps: () => ok(psOf(f.supervisor, f.root, ...rows)),
      treePids: "40467,40481,40482,40483,40484,40485",
      tree: () => ({ ok: false, stdout: "p40467\n", stderr: "lsof: gone\n" }),
    });
    await advance(61_000);
    watchdog.stop();
    assert.deepEqual(watchdog.summary().verdict, {
      kind: "idle-external",
      quietMs: 60_000,
      core: null,
    });
    assert.deepEqual(
      calls.filter((call) => call.startsWith("sample")),
      ["sample 40467", "sample 40481", "sample 40482", "sample 40483"],
    );
    assert.equal(calls.includes("lsof wide"), false);
    assert.deepEqual(kills, []);
    assert.deepEqual(logs, [
      `\n⚠️  Hook watchdog (enforce): idle-external after 1 min quiet. Diagnostics: ${runDir}\n`,
    ]);
    assert.equal(
      readFileSync(join(runDir, "lsof.txt"), "utf8"),
      "p40467\nlsof: gone\n",
    );
    assert.deepEqual(watchdog.summary().warnings, []);
  });

  it("decides a core shared with an outside process at exactly the external ceiling", async () => {
    const { f, kills, watchdog } = watch({
      config: { idleMs: 7000 },
      wide: () => ok(`${f.wideLsof}p77777\nf5\ntunix\nd0xa1\nn->0x1\n`),
    });
    await advance(61_000);
    watchdog.stop();
    assert.deepEqual(watchdog.summary().verdict, {
      kind: "idle-external",
      quietMs: 60_000,
      core: null,
    });
    assert.deepEqual(kills, []);
    assert.deepEqual(watchdog.summary().warnings, []);
  });

  it("without the supervisor's listing decides nothing but the ceiling, and keeps lsof's words", async () => {
    const { calls, runDir, kills, watchdog } = watch({
      config: { idleMs: 7000 },
      supervisor: () => ({ ok: false, stdout: "", stderr: "lsof: denied\n" }),
    });
    await advance(61_000);
    watchdog.stop();
    assert.deepEqual(watchdog.summary().verdict, {
      kind: "idle-external",
      quietMs: 60_000,
      core: null,
    });
    assert.equal(calls.includes("lsof tree"), false);
    assert.equal(calls.filter((call) => call === "lsof supervisor").length, 9);
    assert.equal(
      readFileSync(join(runDir, "lsof.txt"), "utf8"),
      "lsof: denied\n",
    );
    assert.deepEqual(kills, []);
    assert.deepEqual(watchdog.summary().warnings, []);
  });

  it("asks for the supervisor's listing again after one failure, then keeps it", async () => {
    const { f, calls, kills, watchdog } = watch({
      supervisor: (call) =>
        call === 1 ? { ok: false, stdout: f.supLsof, stderr: "" } : ok(f.supLsof),
    });
    await advance(14_000);
    assert.deepEqual(kills, []);
    assert.deepEqual(calls, [
      ...times(6, "ps"),
      "lsof supervisor",
      ...times(5, "ps"),
      "lsof supervisor",
      "lsof tree",
      "lsof wide",
      ...times(3, "ps"),
    ]);
    await advance(2600);
    watchdog.stop();
    assert.deepEqual(kills.slice(0, 4), term());
    assert.equal(calls.filter((call) => call === "lsof supervisor").length, 2);
  });

  it("kills a child the root spawned during the grace period, once", async () => {
    const { f, kills, watchdog } = watch({
      ps: (call) =>
        ok(call >= 13 ? psOf(f.supervisor, f.root, f.leaf, f.idle, psLine(40490, 40467, 40351, "sh")) : f.ps),
    });
    await advance(11_600);
    watchdog.stop();
    assert.deepEqual(kills, [
      ...term(),
      [-40467, "SIGKILL"],
      [40467, "SIGKILL"],
      [40479, "SIGKILL"],
      [40480, "SIGKILL"],
      [40490, "SIGKILL"],
    ]);
  });

  it("kills only the survivors by pid once the root is gone", async () => {
    const { f, kills, watchdog } = watch({
      ps: (call) => ok(call >= 13 ? psOf(f.supervisor, f.leaf, f.idle) : f.ps),
    });
    await advance(11_600);
    watchdog.stop();
    assert.deepEqual(kills, [
      ...term(),
      [40479, "SIGKILL"],
      [40480, "SIGKILL"],
    ]);
    assert.deepEqual(watchdog.summary().warnings, []);
  });

  it("signals the hook's group, not its members, while a survivor still belongs to it", async () => {
    const { f, kills, watchdog } = watch({
      ps: (call) => {
        const leaf = psLine(40479, 40467, 40467, "bash");
        return ok(
          call >= 13
            ? psOf(f.supervisor, leaf, f.idle)
            : psOf(f.supervisor, f.root, leaf, f.idle),
        );
      },
    });
    await advance(11_600);
    watchdog.stop();
    assert.deepEqual(kills, [
      [-40467, "SIGTERM"],
      [40467, "SIGTERM"],
      [40480, "SIGTERM"],
      [-40467, "SIGKILL"],
      [40480, "SIGKILL"],
    ]);
  });

  it("retries ps after the grace period, 250 ms apart, three times in all", async () => {
    const failing = { ok: false, stdout: "", stderr: "ps: busy\n" };
    const twice = watch({
      ps: (call) => (call === 13 || call === 14 ? failing : ok(twice.f.ps)),
    });
    await advance(12_400);
    twice.watchdog.stop();
    assert.deepEqual(twice.calls, [
      ...confirmed(),
      "ps",
      "lsof tree",
      "lsof wide",
      "ps",
      "ps",
      "ps",
    ]);
    assert.deepEqual(twice.kills, [
      ...term(),
      [-40467, "SIGKILL"],
      [40467, "SIGKILL"],
      [40479, "SIGKILL"],
      [40480, "SIGKILL"],
    ]);
    assert.deepEqual(twice.watchdog.summary().warnings, []);
    const thrice = watch({
      ps: (call) => (call >= 13 && call <= 15 ? failing : ok(thrice.f.ps)),
    });
    await advance(12_400);
    thrice.watchdog.stop();
    assert.deepEqual(thrice.kills, term());
    assert.deepEqual(thrice.watchdog.summary().warnings, [
      "post-grace ps unavailable: SIGKILL escalation skipped, process identity unverifiable",
    ]);
  });

  it("starts no tick while the previous one is still waiting on ps", async () => {
    let release = (): void => {};
    const { f, calls, watchdog } = watch({
      ps: () =>
        new Promise<ExecResult>((done) => {
          release = () => done(ok(f.ps));
        }),
    });
    await advance(3500);
    assert.deepEqual(calls, ["ps"]);
    watchdog.stop();
    release();
  });

  it("records a tick that throws as a warning, and decides nothing from it", async () => {
    const { calls, kills, watchdog } = watch({
      ps: () => {
        throw new Error("ps refused");
      },
    });
    await advance(2000);
    watchdog.stop();
    assert.deepEqual(calls, ["ps", "ps"]);
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
    assert.deepEqual(watchdog.summary().warnings, [
      "watchdog tick failed: ps refused",
      "watchdog tick failed: ps refused",
    ]);
  });

  it("does nothing with a snapshot that does not hold the root", async () => {
    const { f, calls, watchdog } = watch({ ps: () => ok(psOf(f.supervisor)) });
    await advance(16_000);
    watchdog.stop();
    assert.deepEqual(calls, times(16, "ps"));
    assert.deepEqual(watchdog.summary().warnings, []);
    assert.equal(watchdog.summary().verdict, null);
  });

  it("restarts the window when the stage file grows", async () => {
    const base = mkdtempSync(join(tmpdir(), "watchdog-627-stage-"));
    dirs.push(base);
    const stageFile = join(base, "stage");
    writeFileSync(stageFile, "test\n");
    const { f, kills, watchdog } = watch({
      stageFile,
      ps: (call) => {
        if (call === 7) appendFileSync(stageFile, "lint\n");
        return ok(f.ps);
      },
    });
    await advance(14_000);
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
    await advance(3600);
    watchdog.stop();
    assert.deepEqual(kills.slice(0, 4), term());
  });

  it("reads a stage file that appears empty as no stage marker, like no file", async () => {
    const base = mkdtempSync(join(tmpdir(), "watchdog-627-stage-"));
    dirs.push(base);
    const stageFile = join(base, "stage");
    const { f, kills, watchdog } = watch({
      stageFile,
      ps: (call) => {
        if (call === 7) writeFileSync(stageFile, "");
        return ok(f.ps);
      },
    });
    await advance(11_600);
    watchdog.stop();
    assert.deepEqual(kills.slice(0, 4), term());
  });

  it("decides nothing when disarmed while a check reads the tree's files", async () => {
    const { f, calls, kills, watchdog } = watch({
      tree: (call) => {
        if (call === 2) watchdog.disarm();
        return ok(f.treeLsof);
      },
    });
    await advance(16_000);
    watchdog.stop();
    assert.deepEqual(calls, [
      ...times(6, "ps"),
      "lsof supervisor",
      "lsof tree",
      "lsof wide",
      ...times(5, "ps"),
      "lsof tree",
    ]);
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
    assert.deepEqual(watchdog.summary().warnings, []);
  });

  it("decides nothing when disarmed while a check reads every process's files", async () => {
    const { f, calls, kills, watchdog } = watch({
      wide: (call) => {
        if (call === 2) watchdog.disarm();
        return ok(f.wideLsof);
      },
    });
    await advance(16_000);
    watchdog.stop();
    assert.deepEqual(calls, [
      ...times(6, "ps"),
      "lsof supervisor",
      "lsof tree",
      "lsof wide",
      ...times(5, "ps"),
      "lsof tree",
      "lsof wide",
    ]);
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
    assert.deepEqual(watchdog.summary().warnings, []);
  });

  it("begins no kill when stopped while a check is in flight", async () => {
    const { f, kills, watchdog } = watch({
      tree: (call) => {
        if (call === 2) watchdog.stop();
        return ok(f.treeLsof);
      },
    });
    await advance(16_000);
    assert.deepEqual(kills, []);
    assert.equal(watchdog.summary().verdict, null);
  });

  it("checks on a monotonic clock whose readings are negative", async () => {
    const { kills, watchdog } = watch({
      clock: {
        now: () => Date.now() - START - 100_000,
        wall: () => Date.now(),
      },
    });
    await advance(11_600);
    watchdog.stop();
    assert.deepEqual(kills.slice(0, 4), term());
  });

  it("runs nothing when off or unsupported, and says so", async () => {
    for (const [mode, reason] of [
      ["off", "explicit"],
      ["unsupported", "non-darwin"],
    ] as const) {
      const { calls, kills, watchdog } = watch({ mode, reason });
      await advance(16_000);
      watchdog.disarm();
      watchdog.stop();
      assert.equal(watchdog.mode, mode);
      assert.equal(watchdog.enforced(), false);
      assert.deepEqual(watchdog.summary(), {
        mode,
        reason,
        idleMs: 5000,
        verdict: null,
        acted: false,
        diagnostics: null,
        warnings: [],
      });
      assert.deepEqual(calls, []);
      assert.deepEqual(kills, []);
    }
  });

  it("samples on an unreferenced interval, and stop() clears it", () => {
    const realSetInterval = globalThis.setInterval;
    const timers: { delay: number | undefined; timer: NodeJS.Timeout }[] = [];
    mock.method(
      globalThis,
      "setInterval",
      (callback: () => void, delay?: number) => {
        const timer = realSetInterval(callback, delay);
        timers.push({ delay, timer });
        return timer;
      },
    );
    const cleared = mock.method(globalThis, "clearInterval");
    let watchdog: RunWatchdog | undefined;
    try {
      watchdog = createWatchdog({
        rootPid: 40467,
        supervisorPid: 40375,
        stageFile: join(tmpdir(), "watchdog-627-no-stage-file"),
        hangsDir: join(tmpdir(), "watchdog-627-no-hangs"),
        runId: "run-627",
        config: {
          mode: "enforce",
          reason: "explicit",
          idleMs: 5000,
          externalIdleMs: 60_000,
          sampleMs: 3_600_000,
          graceMs: 500,
          cpuQuietMs: 1000,
        },
        exec: async () => {
          throw new Error("no command expected");
        },
        kill: () => {
          throw new Error("no signal expected");
        },
      });
      assert.equal(timers.length, 1);
      assert.equal(timers[0]?.delay, 3_600_000);
      assert.equal(timers[0]?.timer.hasRef(), false);
      assert.equal(cleared.mock.callCount(), 0);
      watchdog.stop();
      assert.equal(cleared.mock.callCount(), 1);
      assert.equal(cleared.mock.calls[0]?.arguments[0], timers[0]?.timer);
    } finally {
      for (const { timer } of timers) clearInterval(timer);
    }
  });

  it("by default reads the clocks and writes to stderr", { timeout: 15_000 }, async () => {
    const base = mkdtempSync(join(tmpdir(), "watchdog-627-defaults-"));
    dirs.push(base);
    const hangsDir = join(base, "hangs");
    const expired = join(hangsDir, "expired");
    mkdirSync(expired, { recursive: true });
    const old = (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(expired, old, old);
    const written: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    mock.method(process.stderr, "write", (chunk: string | Uint8Array, ...rest: never[]) => {
      written.push(String(chunk));
      return write(chunk, ...rest);
    });
    const { runDir, watchdog } = watch({
      realTime: true,
      mode: "report",
      hangsDir,
      config: { idleMs: 100, sampleMs: 20, graceMs: 20 },
    });
    try {
      const deadline = performance.now() + 5000;
      while (watchdog.summary().verdict === null && performance.now() < deadline)
        await new Promise((done) => setTimeout(done, 10));
    } finally {
      watchdog.stop();
      mock.restoreAll();
    }
    const quietMs = watchdog.summary().verdict?.quietMs ?? Number.NaN;
    assert.ok(Number.isFinite(quietMs) && quietMs >= 200, `quietMs ${quietMs}`);
    assert.ok(
      written.includes(
        `\n⚠️  Hook watchdog (report): internal-deadlock after 0 min quiet. Diagnostics: ${runDir}\n`,
      ),
    );
    assert.deepEqual(readdirSync(hangsDir), ["run-627"]);
  });

  it("by default runs ps, lsof and sample from PATH, and signals with process.kill", { timeout: 15_000 }, async () => {
    // Stand-ins earlier on PATH than the real commands. ps prints the tree
    // only in the C locale, padded past 256 bytes; lsof prints one listing
    // for every query. process.kill is a spy: nothing is really signalled.
    const base = mkdtempSync(join(tmpdir(), "watchdog-627-path-"));
    dirs.push(base);
    const bin = join(base, "bin");
    mkdirSync(bin);
    const f = fixture();
    const supLsof = f.supLsof.replace("p40375", `p${process.pid}`);
    writeFileSync(
      join(base, "ps.txt"),
      `${psOf(f.root, f.leaf, f.idle)}${" ".repeat(300)}\n`,
    );
    writeFileSync(join(base, "lsof.txt"), `${supLsof}${f.treeLsof}`);
    writeFileSync(
      join(bin, "ps"),
      `#!/bin/sh\n[ "$LC_ALL" = C ] || exit 3\ncat '${join(base, "ps.txt")}'\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "lsof"), `#!/bin/sh\ncat '${join(base, "lsof.txt")}'\n`, {
      mode: 0o755,
    });
    writeFileSync(join(bin, "sample"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const kills: [number, string][] = [];
    mock.method(process, "kill", (pid: number, signal?: string | number) => {
      kills.push([pid, String(signal)]);
      return true;
    });
    const path = process.env["PATH"];
    const locale = process.env["LC_ALL"];
    process.env["PATH"] = `${bin}:${path ?? ""}`;
    process.env["LC_ALL"] = "en_US.UTF-8";
    const watchdog = createWatchdog({
      rootPid: 40467,
      stageFile: join(base, "no-stage-file"),
      hangsDir: join(base, "hangs"),
      runId: "run-627",
      config: {
        mode: "enforce",
        reason: "explicit",
        idleMs: 150,
        externalIdleMs: 60_000,
        sampleMs: 25,
        graceMs: 25,
        cpuQuietMs: 1000,
      },
      log: () => {},
    });
    try {
      const deadline = performance.now() + 8000;
      while (
        !kills.some(([, signal]) => signal === "SIGKILL") &&
        performance.now() < deadline
      )
        await new Promise((done) => setTimeout(done, 10));
    } finally {
      watchdog.stop();
      if (path === undefined) delete process.env["PATH"];
      else process.env["PATH"] = path;
      if (locale === undefined) delete process.env["LC_ALL"];
      else process.env["LC_ALL"] = locale;
      mock.restoreAll();
    }
    assert.deepEqual(watchdog.summary().warnings, []);
    assert.deepEqual(kills, [
      ...term(),
      [-40467, "SIGKILL"],
      [40467, "SIGKILL"],
      [40479, "SIGKILL"],
      [40480, "SIGKILL"],
    ]);
  });
});

describe("a core whose member still has a live child outside it", () => {
  // The 2026-11-26 incident: a pre-push's pnpm (91855) ran sh (91890) and
  // node (91869). sh reads a pipe only pnpm holds, so the two look closed.
  // node was polling for a lock file another worktree's run held: a pid file
  // made with `wx`, so it holds no fd on it, and only its exit could wake
  // pnpm. ps and lsof rows are the captured ones, with private paths scrubbed.
  const row = (
    pid: number,
    ppid: number,
    pgid: number,
    comm: string,
    state = "S",
  ): PsRow => ({
    pid,
    ppid,
    pgid,
    state,
    cpuMs: 0,
    started: "Thu Nov 26 13:34:22 2026",
    comm,
    key: `${pid}@start`,
  });
  const bash = row(71035, 70683, 71035, "bash", "Ss");
  const pnpm = row(91855, 71035, 71035, "pnpm");
  const waiter = row(91869, 91855, 91869, "node");
  const sh = row(91890, 91855, 91890, "sh");
  const stdio = ["f0", "tPIPE", "d0xa33bcc12b81239e8", "n", "f1", "tREG", "n/tmp/out", "f2", "tREG", "n/tmp/out"];
  const lsof = parseLsof(
    [
      "p71035", "fcwd", "tDIR", "n/repo", ...stdio, "f255", "tREG", "n/repo/pre-push",
      "p91855", "fcwd", "tDIR", "n/repo", ...stdio,
      "f3", "tKQUEUE", "ncount=0, state=0xa",
      "f6", "tunix", "d0x84e3da3ac615990a", "n->0xd48a751a0f556f7",
      "f7", "tunix", "d0xd48a751a0f556f7", "n->0x84e3da3ac615990a",
      "f8", "tunix", "d0x84e3da3ac615990a", "n->0xd48a751a0f556f7",
      "f10", "tPIPE", "d0xae6eae1251bf2818", "n->0xf79ddb45dd5536bf",
      "p91869", "fcwd", "tDIR", "n/repo", ...stdio,
      "f3", "tKQUEUE", "ncount=0, state=0x8",
      "f4", "tPIPE", "d0x3b09fa9ffebd1e74", "n->0x145c55caea053ecc",
      "f5", "tPIPE", "d0x145c55caea053ecc", "n->0x3b09fa9ffebd1e74",
      "f6", "tDIR", "n/",
      "f11", "tPIPE", "d0x3e9710632ae67bc3", "n->0x68d4116fb964f951",
      "f12", "tPIPE", "d0x68d4116fb964f951", "n->0x3e9710632ae67bc3",
      "p91890", "fcwd", "tDIR", "n/repo",
      "f0", "tPIPE", "d0xf79ddb45dd5536bf", "n->0xae6eae1251bf2818",
      "f1", "tCHR", "n/dev/null", "f2", "tCHR", "n/dev/null",
    ].join("\n"),
  );
  const classesOf = (tree: readonly PsRow[]) =>
    classifyFds(
      lsof,
      tree.map((r) => r.pid),
      [],
    );
  const verdictOf = (tree: PsRow[]) =>
    decide({
      tree,
      classes: classesOf(tree),
      cpuDeltaByPid: zeroDeltas(tree),
      quietMs: config.idleMs,
      config,
    });
  const deadlock = {
    kind: "internal-deadlock",
    core: { leaf: sh.pid, peers: [pnpm.pid] },
    quietMs: config.idleMs,
  };

  it("spares the incident: pnpm is woken when the lock waiter exits", () => {
    const tree = [bash, pnpm, waiter, sh];
    assert.equal(findHangCore(tree, classesOf(tree), zeroDeltas(tree)), null);
    assert.equal(verdictOf(tree), null);
  });

  it("convicts the same pair once the waiter has gone, or is a zombie", () => {
    assert.deepEqual(verdictOf([bash, pnpm, sh]), deadlock);
    assert.deepEqual(
      verdictOf([bash, pnpm, { ...waiter, state: "Z+" }, sh]),
      deadlock,
    );
  });

  it("counts only a member's own child: a live child of the core's parent does not spare it", () => {
    const sibling = row(91900, 71035, 91900, "node");
    assert.deepEqual(verdictOf([bash, pnpm, sibling, sh]), deadlock);
  });
});

describe("the pure functions with a field or an entry missing", () => {
  it("classifies an fd lsof gave no type as external", () => {
    assert.deepEqual(classifyFds(new Map([[1, [lsofFd("3")]]]), [1], []), new Map([
      [1, [{ ...lsofFd("3"), class: "external", peerPid: null }]],
    ]));
  });

  it("shares no FIFO through fds that have no device", () => {
    const classes = classifyFds(
      new Map([
        [1, [lsofFd("3", { type: "FIFO" })]],
        [2, [lsofFd("4", { type: "FIFO" })]],
      ]),
      [1, 2],
      [],
    );
    assert.deepEqual(
      [...classes.values()].flat().map((fd) => [fd.class, fd.peerPid]),
      [
        ["external", null],
        ["external", null],
      ],
    );
  });

  it("finds a core whose peer has no classified fds, past a leaf that has none", () => {
    const tree = [psRow(1, 0), psRow(3, 0), psRow(2, 1)];
    const classes = new Map([[2, [classified("internal", 1)]]]);
    const core = { leaf: 2, peers: [1] };
    assert.deepEqual(findHangCore(tree, classes, zeroDeltas(tree)), core);
    assert.deepEqual(
      decide({
        tree,
        classes,
        cpuDeltaByPid: zeroDeltas(tree),
        quietMs: 1000,
        config: { idleMs: 1000, externalIdleMs: 5000 },
      }),
      { kind: "internal-deadlock", core, quietMs: 1000 },
    );
  });

  it("shares nothing outside through a member with no classified fds, or a channel with no device or address", () => {
    assert.equal(
      coreSharedOutside(
        { leaf: 2, peers: [1] },
        new Map([[2, [classified("internal", 1)]]]),
        new Map([[9, [lsofFd("3")]]]),
        [1, 2],
      ),
      false,
    );
  });
});
