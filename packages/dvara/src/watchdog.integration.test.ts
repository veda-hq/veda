import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CONFIG_FILE } from "./config.ts";
import {
  DVARA_CLI,
  STAGE_HELPERS,
  supervisorSandbox,
  type SupervisorSandbox,
} from "./supervisor.fixture.ts";

/**
 * The watchdog against real processes, through the real supervisor.
 *
 * Each hook runs under `dvara run`, from this package's source, with a 2 s
 * idle window so a verdict lands in seconds. The kill cases are the shape of
 * the hang the watchdog was built for; the spare cases are the shapes a
 * slow-but-working stage takes. macOS only: the fd rules are written against
 * macOS `lsof`, and elsewhere the watchdog records `unsupported` (asserted in
 * supervisor.test.ts and watchdog.test.ts).
 *
 * Each run gets its own sandbox, so its history row, its hang dump and what
 * its processes leave in their temp folder land there, and go with it.
 */
const IDLE_MS = 2000;
const node = process.execPath;

const DEADLOCK = `"${node}" -e "require('node:child_process').spawnSync('bash', ['-c', 'read -r _ <&3'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })"`;

// The same deadlock, but the leaf first waits a second without CPU (a timed
// read on the silent pipe), then spends a little CPU in shell arithmetic (no
// subprocess, so membership is unchanged), and only then blocks for good.
const CPU_THEN_DEADLOCK = `"${node}" -e "require('node:child_process').spawnSync('bash', ['-c', 'read -t 1 -u 3 _; i=0; while [ \\$i -lt 30000 ]; do i=\\$((i+1)); done; read -r _ <&3'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })"`;

/** The fields of a history row these cases read. */
interface HistoryRow {
  readonly id: string;
  readonly kind: string;
  readonly exitCode: number;
  readonly stages: readonly { readonly name: string; readonly status: string }[];
  readonly watchdog: {
    readonly mode: string;
    readonly acted?: boolean;
    readonly verdict?: {
      readonly kind: string;
      readonly core: { readonly leaf: number; readonly peers: number[] } | null;
    } | null;
  };
}

function hookRecord(run: Run): HistoryRow {
  const matches = existsSync(run.history)
    ? readFileSync(run.history, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as HistoryRow)
        .filter((record) => record.kind === run.kind)
    : [];
  assert.equal(matches.length, 1, run.stderr());
  const [record] = matches;
  assert.ok(record);
  return record;
}

interface Run extends SupervisorSandbox {
  readonly kind: string;
  readonly child: ChildProcess;
  readonly exit: Promise<number | null>;
  /** Settles once the hook itself runs, so the supervisor's signal handlers are in place. */
  readonly started: Promise<void>;
  readonly stderr: () => string;
}

/** The line the hook prints before its body, once the supervisor has launched it. */
const STARTED = "hook-body-started";

/**
 * Every sandbox this file creates, until its run is cleaned up. A run that
 * throws between creating its sandbox and entering the test's `try` (a failed
 * write or spawn) never reaches `cleanup`, so the file sweeps whatever is left
 * once all its tests are done.
 */
const sandboxes = new Set<string>();
after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** This process's environment without git's: a hook running this suite must not point the runs at its repository. */
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

function startHook(body: string, mode: "enforce" | "report" | "off"): Run {
  const sandbox = supervisorSandbox("hook-watchdog-");
  sandboxes.add(sandbox.dir);
  const { dir, tmp } = sandbox;
  const kind = basename(dir);
  const hook = join(dir, kind);
  writeFileSync(
    hook,
    `#!/bin/bash\nsource "${STAGE_HELPERS}"\ntrap 'touch "${dir}/cleanup"' EXIT\ndvara_stage validation\necho ${STARTED}\n${body}\n`,
  );
  const child = spawn(node, [DVARA_CLI, "run", hook], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...baseEnv,
      TMPDIR: tmp,
      TEMP: tmp,
      TMP: tmp,
      DVARA_CONFIG: CONFIG_FILE,
      DVARA_MEASUREMENT_CONTEXT: "manual-benchmark",
      DVARA_BOOTSTRAP_SECONDS: "0",
      DVARA_WATCHDOG: mode,
      DVARA_WATCHDOG_IDLE_MS: String(IDLE_MS),
      DVARA_WATCHDOG_EXTERNAL_IDLE_MS: "600000",
      DVARA_WATCHDOG_SAMPLE_MS: "250",
      DVARA_WATCHDOG_GRACE_MS: "1000",
    },
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exit = new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => done(code));
  });
  // The supervisor spends its first moments in git probes before it installs
  // its signal handlers; under load that took longer than three idle windows,
  // and a SIGTERM sent then killed it by default (exit null, not 143).
  // Anything timed from launch waits for this.
  let stdout = "";
  const started = new Promise<void>((done, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes(STARTED)) done();
    });
    child.once("exit", (code) =>
      reject(new Error(`hook exited ${code} before it started: ${stderr}`)),
    );
  });
  // A run that never awaits it must not surface as an unhandled rejection.
  started.catch(() => undefined);
  return { ...sandbox, kind, child, exit, started, stderr: () => stderr };
}

/** Longest a kill case may take; a missed verdict fails here instead of hanging the suite. */
const KILL_DEADLINE_MS = 60_000;
/** Longest any one case may take, its cleanup included. */
const CASE_TIMEOUT_MS = KILL_DEADLINE_MS + 30_000;

/** The hook's exit code, or null when it is still running after `ms`. The timer never outlives it. */
async function exitWithin(run: Run, ms: number): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run.exit,
      new Promise<null>((done) => {
        timer = setTimeout(() => done(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Poll `condition` every 100 ms until it holds; fail after `ms`. */
async function waitFor(
  condition: () => boolean,
  ms: number,
  what: () => string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline)
      assert.fail(`not within ${ms} ms: ${what()}`);
    await delay(100);
  }
}

/**
 * Stop a hook that is still running. SIGTERM goes to the supervisor first,
 * which forwards it to the hook's process group: a SIGKILL to the supervisor
 * alone would orphan the detached hook tree.
 */
async function stop(run: Run): Promise<void> {
  if (run.child.exitCode !== null || run.child.signalCode !== null) return;
  run.child.kill("SIGTERM");
  await exitWithin(run, 5000);
  if (run.child.exitCode === null && run.child.signalCode === null)
    run.child.kill("SIGKILL");
}

/** Remove a finished run's sandbox: its hook, history row, hang dump and temp folder all live there. */
function cleanup(run: Run): void {
  rmSync(run.dir, { recursive: true, force: true });
  sandboxes.delete(run.dir);
}

describe(
  "hook watchdog on real processes",
  {
    skip:
      process.platform === "darwin"
        ? false
        : "macOS only: the fd rules are written against macOS lsof",
    concurrency: true,
  },
  () => {
    it(
      "stops the incident deadlock with exit 124, diagnostics, and no survivors",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const run = startHook(DEADLOCK, "enforce");
        try {
          const code = await exitWithin(run, KILL_DEADLINE_MS);
          assert.equal(code, 124, run.stderr());
          const record = hookRecord(run);
          assert.equal(record.exitCode, 124);
          assert.partialDeepStrictEqual(record.watchdog, {
            mode: "enforce",
            acted: true,
            verdict: { kind: "internal-deadlock" },
          });
          assert.partialDeepStrictEqual(record.stages.at(-1), {
            name: "validation",
            status: "timed_out",
          });
          const hangDir = join(run.hangs, record.id);
          const dumped = readdirSync(hangDir);
          for (const file of ["verdict.json", "ps.txt", "lsof.txt"])
            assert.ok(dumped.includes(file), `${file} in ${dumped.join(", ")}`);
          const core = record.watchdog.verdict?.core;
          assert.ok(core);
          const saved = JSON.parse(
            readFileSync(join(hangDir, "verdict.json"), "utf8"),
          ) as { tree: { pid: number }[] };
          const savedPids = saved.tree.map((row) => row.pid);
          for (const pid of [core.leaf, ...core.peers]) {
            assert.ok(savedPids.includes(pid));
            assert.throws(() => process.kill(pid, 0), /ESRCH/);
          }
          assert.ok(existsSync(join(run.dir, "cleanup")));
          assert.ok(run.stderr().includes("Hook watchdog"), run.stderr());
          assert.ok(run.stderr().includes(hangDir), run.stderr());
        } finally {
          await stop(run);
          cleanup(run);
        }
      },
    );

    it(
      "leaves the same deadlock running when the watchdog is off (negative control)",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        // The kill above must come from the watchdog. With it off, the
        // identical hook is still alive after three idle windows: the
        // assertion that fails without the watchdog is the `exitCode === null`
        // check below, not a timeout or a fixture error.
        const run = startHook(DEADLOCK, "off");
        try {
          await run.started;
          await delay(IDLE_MS * 3 + 1000);
          assert.equal(run.child.exitCode, null, run.stderr());
        } finally {
          run.child.kill("SIGTERM");
          assert.equal(await run.exit, 143);
          cleanup(run);
        }
      },
    );

    it(
      "stops an in-tree TCP pair that no longer listens for anyone else",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const tcpPair = `"${node}" -e "const net=require('node:net');const {spawn}=require('node:child_process');const s=net.createServer(()=>s.close()).listen(0,'127.0.0.1',()=>{spawn(process.execPath,['-e','require(\\'node:net\\').connect('+s.address().port+',\\'127.0.0.1\\')'],{stdio:'ignore'})})"`;
        const run = startHook(tcpPair, "enforce");
        try {
          const code = await exitWithin(run, KILL_DEADLINE_MS);
          assert.equal(code, 124, run.stderr());
          assert.equal(
            hookRecord(run).watchdog.verdict?.kind,
            "internal-deadlock",
          );
        } finally {
          await stop(run);
          cleanup(run);
        }
      },
    );

    it(
      "stops a deadlock whose leaf spent CPU after the idle window began",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        // Under load a leaf can still spend CPU after the quiet window has
        // begun: too little to restart the window, yet enough to disqualify
        // the leaf at every later check while CPU was measured from the
        // window's start. It was never judged.
        const run = startHook(CPU_THEN_DEADLOCK, "enforce");
        try {
          const code = await exitWithin(run, KILL_DEADLINE_MS);
          assert.equal(code, 124, run.stderr());
          assert.equal(
            hookRecord(run).watchdog.verdict?.kind,
            "internal-deadlock",
          );
        } finally {
          await stop(run);
          cleanup(run);
        }
      },
    );

    it(
      "reports but never kills in report mode",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const run = startHook(DEADLOCK, "report");
        try {
          // Same deadline as the kill cases: under a loaded machine a verdict
          // takes well over 15 s.
          await waitFor(
            () => run.stderr().includes("Hook watchdog (report)"),
            KILL_DEADLINE_MS,
            run.stderr,
          );
          assert.equal(run.child.exitCode, null, run.stderr());
          run.child.kill("SIGTERM");
          assert.equal(await run.exit, 143);
          const record = hookRecord(run);
          assert.partialDeepStrictEqual(record.watchdog, {
            mode: "report",
            acted: false,
            verdict: { kind: "internal-deadlock" },
          });
          assert.equal(record.stages.at(-1)?.status, "cancelled");
        } finally {
          await stop(run);
          cleanup(run);
        }
      },
    );

    it(
      "spares a leaf waiting on a TCP peer outside the tree",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const sockets: net.Socket[] = [];
        const server = net.createServer((socket) => sockets.push(socket));
        await new Promise<void>((done) =>
          server.listen(0, "127.0.0.1", done),
        );
        // Everything after listen is inside the try, so the server closes
        // even when the hook cannot be set up.
        let run: Run | undefined;
        try {
          const address = server.address();
          assert.ok(address !== null && typeof address === "object");
          run = startHook(
            `"${node}" -e "require('node:net').connect(${address.port},'127.0.0.1').on('close',()=>process.exit(0))"`,
            "enforce",
          );
          await run.started;
          await delay(IDLE_MS * 3 + 1000);
          assert.equal(run.child.exitCode, null, run.stderr());
          for (const socket of sockets) socket.destroy();
          assert.equal(await run.exit, 0);
          assert.equal(hookRecord(run).watchdog.verdict, null);
        } finally {
          server.close();
          if (run) {
            await stop(run);
            cleanup(run);
          }
        }
      },
    );

    for (const [label, body] of [
      [
        "a CPU-bound stage",
        `"${node}" -e "const e=Date.now()+${IDLE_MS * 3};while(Date.now()<e){}"`,
      ],
      [
        "subprocess churn",
        `d="$(mktemp -d)"; mkfifo "$d/f"; exec 3<>"$d/f"; end=$((SECONDS+${(IDLE_MS * 3) / 1000})); while [ "$SECONDS" -lt "$end" ]; do /usr/bin/true; read -t 0.2 -u 3 _ || true; done; rm -rf "$d"`,
      ],
      ["a sleep", `sleep ${(IDLE_MS * 3) / 1000}`],
    ] as const)
      it(
        `spares ${label} that outlasts the idle window`,
        { timeout: CASE_TIMEOUT_MS },
        async () => {
          const run = startHook(body, "enforce");
          try {
            const code = await exitWithin(run, KILL_DEADLINE_MS);
            assert.equal(code, 0, run.stderr());
            assert.partialDeepStrictEqual(hookRecord(run).watchdog, {
              mode: "enforce",
              acted: false,
              verdict: null,
            });
          } finally {
            await stop(run);
            cleanup(run);
          }
        },
      );
  },
);
