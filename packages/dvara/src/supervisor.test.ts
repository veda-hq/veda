import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { DEFAULTS, type Config } from "./config.ts";
import {
  judgedAgainst,
  supervise,
  type Options,
  type WatchdogModule,
} from "./supervisor.ts";

const STAGES = resolve(import.meta.dirname, "..", "shell", "stages.sh");

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      stdio: "pipe",
    },
  ).toString();

/** A repository with one commit, and a hook file whose body is `body` after the stage helpers. */
const repo = (
  body: string,
  name = "pre-push",
  commit = true,
): { root: string; hook: string } => {
  const root = mkdtempSync(join(tmpdir(), "dvara-run-"));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".dvara/\nhooks/\n");
  if (commit) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "first");
  }
  mkdirSync(join(root, "hooks"));
  const hook = join(root, "hooks", name);
  writeFileSync(hook, `#!/usr/bin/env bash\nsource '${STAGES}'\n${body}\n`);
  chmodSync(hook, 0o755);
  return { root, hook };
};

class FakeSignals extends EventEmitter {
  count(): number {
    return ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"].reduce(
      (n, s) => n + this.listenerCount(s),
      0,
    );
  }
}

interface Captured {
  out: string;
  err: string;
}

const options = (
  root: string,
  extra: Partial<Options> = {},
  config: Partial<Config> = {},
) => {
  const captured: Captured = { out: "", err: "" };
  const signals = new FakeSignals();
  const opts: Options = {
    root,
    config: { ...DEFAULTS, ...config },
    env: { ...process.env, DVARA_VERBOSE: "" },
    signals,
    exit: () => {
      throw new Error("exit called");
    },
    sampleIntervalMs: 20,
    ppid: 1,
    stdout: (t) => (captured.out += t.toString()),
    stderr: (t) => (captured.err += t.toString()),
    ...extra,
  };
  return { opts, captured, signals };
};

const rows = (root: string, dir = ".dvara") =>
  readFileSync(join(root, dir, "history.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as Record<string, unknown> & {
          stages: Record<string, unknown>[];
        },
    );

describe("supervise", () => {
  it("needs a hook", async () => {
    await assert.rejects(supervise([], options("/").opts), /no hook given/);
  });

  it("records a passing run with its stages and leaves no listener behind", async () => {
    const { root, hook } = repo(
      "dvara_stage lint\nsleep 0.05\ndvara_stage test\necho done",
    );
    const { opts, signals } = options(root);
    assert.equal(await supervise([hook], opts), 0);
    const [row] = rows(root);
    assert.equal(row?.kind, "pre-push");
    assert.equal(row?.invocation, "manual");
    assert.equal(row?.status, "success");
    assert.equal(row?.exitCode, 0);
    assert.equal(row?.branch, "main");
    assert.equal(row?.clean, true);
    assert.equal(typeof row?.tree, "string");
    assert.deepEqual(
      row?.stages.map((s) => [s.name, s.status]),
      [
        ["startup", "completed"],
        ["lint", "completed"],
        ["test", "success"],
      ],
    );
    assert.deepEqual(row?.stages[0]?.input, {
      kind: "tree",
      digest: row?.tree,
    });
    assert.equal(signals.count(), 0);
    assert.equal(
      existsSync(join(root, ".dvara", `${String(row?.id)}.stages`)),
      false,
    );
  });

  it("records a failing run, its exit code and its failed stage", async () => {
    const { root, hook } = repo("dvara_stage lint\nexit 3");
    const { opts } = options(root);
    assert.equal(await supervise([hook], opts), 3);
    const [row] = rows(root);
    assert.equal(row?.status, "failure");
    assert.equal(row?.stages.at(-1)?.status, "failed");
  });

  it("hands the hook its name and where to write, and keeps what it recorded", async () => {
    const { root, hook } = repo(
      [
        'echo "$DVARA_MEASURED_HOOK" > "$DVARA_RECORD_FILE.name"',
        'dvara_record_refs "a1 aaa r1 bbb"',
        "dvara_stage lint",
        "dvara_record stage-input lint digest d1",
        "dvara_record proof tests reused 12",
      ].join("\n"),
    );
    const { opts } = options(root);
    assert.equal(await supervise([hook, "origin", "url"], opts), 0);
    const [row] = rows(root);
    assert.deepEqual(row?.pushed, {
      source: "stdin",
      refs: [{ local: "aaa", remote: "bbb" }],
    });
    assert.deepEqual(row?.stages.find((s) => s.name === "lint")?.input, {
      kind: "digest",
      digest: "d1",
    });
    assert.deepEqual(row?.proof, [
      { check: "tests", outcome: "reused", ms: 12 },
    ]);
    assert.equal(
      readFileSync(
        `${join(root, ".dvara", String(row?.id))}.records.name`,
        "utf8",
      ).trim(),
      "pre-push",
    );
  });

  it("counts the runtime selection in the total and offsets the stages", async () => {
    const { root, hook } = repo("true");
    const { opts } = options(root, {
      env: { ...process.env, DVARA_BOOTSTRAP_SECONDS: "2" },
    });
    await supervise([hook], opts);
    const [row] = rows(root);
    assert.equal(row?.stages[0]?.name, "runtime-selection");
    assert.ok(Number(row?.durationMs) >= 2000);
  });

  it("samples the hook process tree", async () => {
    const { root, hook } = repo("sleep 0.2");
    const { opts } = options(root);
    await supervise([hook], opts);
    const [row] = rows(root);
    assert.ok(Number(row?.resourceSamples) >= 1);
  });

  it("writes to the process and exits it by default", async (t) => {
    const out = t.mock.method(process.stdout, "write", () => true);
    const err = t.mock.method(process.stderr, "write", () => true);
    const exit = t.mock.method(process, "exit", () => undefined as never);
    const pass = repo("true", "pre-commit");
    const fail = repo("exit 1", "pre-commit");
    const early = repo("true");
    const base = (root: string) => {
      const { opts } = options(root);
      const { stdout: _o, stderr: _e, exit: _x, ...rest } = opts;
      return rest;
    };
    assert.equal(await supervise([pass.hook], base(pass.root)), 0);
    assert.equal(await supervise([fail.hook], base(fail.root)), 1);
    const signals = new FakeSignals();
    const earlyOpts = {
      ...base(early.root),
      signals,
      config: { ...DEFAULTS, watchdog: "w.mjs" },
      loadWatchdog: async () => {
        signals.emit("SIGQUIT");
        throw new Error("none");
      },
    };
    assert.equal(await supervise([early.hook], earlyOpts), 131);
    t.mock.restoreAll();
    assert.ok(
      out.mock.calls.some((c) =>
        /pre-commit passed/.test(String(c.arguments[0])),
      ),
    );
    assert.ok(err.mock.calls.length > 0);
    assert.deepEqual(exit.mock.calls[0]?.arguments, [131]);
  });

  it("keeps running when the process table cannot be read", async () => {
    const { root, hook } = repo("sleep 0.2");
    const { opts } = options(root, {
      processTable: () => {
        throw new Error("no ps");
      },
    });
    assert.equal(await supervise([hook], opts), 0);
    const [row] = rows(root);
    assert.equal(row?.resourceSamples, 0);
    assert.equal(row?.sampledPeakTreeRssKiB, null);
  });

  it("rejects the run when recording it throws", async () => {
    const { root, hook } = repo("true");
    const throwing: WatchdogModule = {
      createWatchdog: () => ({
        disarm: () => undefined,
        stop: () => undefined,
        summary: () => {
          throw new Error("summary broke");
        },
        enforced: () => false,
      }),
      resolveWatchdogConfig: () => ({}),
      exitDisposition: () => null,
    };
    const { opts, signals } = options(
      root,
      { loadWatchdog: async () => throwing },
      { watchdog: "w.mjs" },
    );
    await assert.rejects(supervise([hook], opts), /summary broke/);
    assert.equal(signals.count(), 0);
  });

  it("records a hook that could not start", async () => {
    const { root, hook } = repo("true");
    const { opts } = options(root, { env: { PATH: "/nonexistent" } });
    assert.equal(await supervise([hook], opts), 127);
    assert.match(String(rows(root)[0]?.error), /ENOENT/);
  });

  it("keeps the verdict when the history cannot be written", async () => {
    const { root, hook } = repo("exit 4");
    writeFileSync(join(root, "blocker"), "");
    const { opts, captured } = options(root, {}, { historyDir: "blocker" });
    assert.equal(await supervise([hook], opts), 4);
    assert.match(captured.err, /History unavailable/);
  });

  it("runs outside a repository, knowing nothing of it", async () => {
    const root = mkdtempSync(join(tmpdir(), "dvara-bare-"));
    const hook = join(root, "pre-commit");
    writeFileSync(hook, "echo hi");
    const { opts } = options(root, {}, { quietHooks: [] });
    assert.equal(await supervise([hook], opts), 0);
    const [row] = rows(root);
    assert.equal(row?.branch, null);
    assert.equal(row?.tree, null);
    assert.equal(row?.fingerprint, null);
    assert.equal(row?.pushed, null);
  });
});

describe("what a run is judged against", () => {
  it("records the base, its merge-base and an unclean tree", () => {
    const { root } = repo("true");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(root, "new.txt"), "x");
    const judged = judgedAgainst(root, process.env, [
      "origin/missing",
      "origin/main",
    ]);
    assert.equal(judged.base?.ref, "origin/main");
    assert.equal(judged.base?.mergeBase, judged.base?.commit);
    assert.equal(judged.clean, false);
  });

  it('records "none" for a base with no shared history and no branch on a detached HEAD', () => {
    const { root } = repo("true");
    git(root, "checkout", "-q", "--orphan", "other");
    git(root, "commit", "-q", "--allow-empty", "-m", "other");
    git(root, "update-ref", "refs/remotes/origin/main", "main");
    git(root, "checkout", "-q", "--detach");
    const judged = judgedAgainst(root, process.env, ["origin/main"]);
    assert.equal(judged.base?.mergeBase, "none");
    assert.equal(judged.branch, null);
  });

  it("knows nothing of a HEAD with no commit yet", () => {
    const { root } = repo("true", "pre-push", false);
    const judged = judgedAgainst(root, process.env, ["origin/main"]);
    assert.equal(judged.fingerprint, null);
    assert.equal(judged.clean, null);
    assert.equal(judged.base, null);
  });

  it("calls a merge-base git cannot compute unknown", () => {
    const { root } = repo("true");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const judged = judgedAgainst(
      root,
      {
        ...process.env,
        GIT_DIR: join(root, ".git"),
        GIT_INDEX_FILE: "/nonexistent/index",
      },
      ["origin/main"],
    );
    assert.ok(judged.base);
  });
});

describe("quiet output", () => {
  it("prints the warnings and one line on success, keeping the full output", async () => {
    const { root, hook } = repo(
      'echo progress\necho "⚠️  partial staging"\necho "   kept"',
      "pre-commit",
    );
    const { opts, captured } = options(root);
    assert.equal(await supervise([hook], opts), 0);
    assert.match(
      captured.out,
      /⚠️ {2}partial staging\n {3}kept\n✅ pre-commit passed in [\d.]+s \(full output: \.dvara\/pre-commit\.log\)/,
    );
    assert.doesNotMatch(captured.out, /progress/);
    assert.match(
      readFileSync(join(root, ".dvara", "pre-commit.log"), "utf8"),
      /progress/,
    );
  });

  it("prints everything when the hook fails", async () => {
    const { root, hook } = repo("echo out\necho err >&2\nexit 1", "pre-commit");
    const { opts, captured } = options(root);
    assert.equal(await supervise([hook], opts), 1);
    assert.match(captured.err, /out\nerr/);
  });

  it("streams when verbose", async () => {
    const { root, hook } = repo("true", "pre-commit");
    const { opts, captured } = options(root, {
      env: { ...process.env, DVARA_VERBOSE: "1" },
    });
    assert.equal(await supervise([hook], opts), 0);
    assert.equal(captured.out, "");
    assert.equal(existsSync(join(root, ".dvara", "pre-commit.log")), false);
  });

  it("stops waiting on output a leftover process holds open", async () => {
    const { root, hook } = repo(
      "echo before\n(sleep 3; echo late) &\nexit 0",
      "pre-commit",
    );
    const { opts } = options(root, { drainLimitMs: 100 });
    const started = Date.now();
    assert.equal(await supervise([hook], opts), 0);
    assert.ok(Date.now() - started < 2500);
    assert.match(
      readFileSync(join(root, ".dvara", "pre-commit.log"), "utf8"),
      /before\n\[output truncated/,
    );
  });

  it("prints the verdict when the log cannot be written", async () => {
    const { root, hook } = repo("true", "pre-commit");
    mkdirSync(join(root, ".dvara", "pre-commit.log"), { recursive: true });
    const { opts, captured } = options(root);
    assert.equal(await supervise([hook], opts), 0);
    assert.match(captured.out, /✅ pre-commit passed/);
  });
});

describe("signals", () => {
  it("forwards a signal to the hook group and records the run cancelled", async () => {
    const { root, hook } = repo("dvara_stage wait\nsleep 5");
    const { opts, signals } = options(root);
    const run = supervise([hook], opts);
    await new Promise((done) => setTimeout(done, 300));
    signals.emit("SIGTERM");
    assert.equal(await run, 143);
    const [row] = rows(root);
    assert.equal(row?.status, "cancelled");
    assert.equal(row?.signal, "SIGTERM");
    assert.equal(row?.stages.at(-1)?.status, "cancelled");
  });

  it("reports a trapped signal as cancelled even when the hook exits 0", async () => {
    const { root, hook } = repo("trap 'exit 0' TERM\nsleep 5 & wait");
    const { opts, signals } = options(root);
    const run = supervise([hook], opts);
    await new Promise((done) => setTimeout(done, 300));
    signals.emit("SIGTERM");
    assert.equal(await run, 143);
  });

  it("ends a run signalled before its hook started", async () => {
    const { root, hook } = repo("true");
    let exited: number | undefined;
    const signals = new FakeSignals();
    const { opts } = options(
      root,
      {
        signals,
        exit: (code) => {
          exited = code;
        },
        loadWatchdog: async () => {
          signals.emit("SIGINT");
          throw new Error("no watchdog");
        },
      },
      { watchdog: "w.mjs" },
    );
    assert.equal(await supervise([hook], opts), 130);
    assert.equal(exited, 130);
    assert.equal(existsSync(join(root, ".dvara", "history.jsonl")), false);
  });

  it("exits 1 for a hook killed by a signal it cannot map", async () => {
    const { root, hook } = repo("kill -USR1 $$");
    const { opts } = options(root);
    assert.equal(await supervise([hook], opts), 1);
  });

  it("forwards to the hook itself when its group cannot be signalled", async () => {
    const { root, hook } = repo("sleep 5");
    const { opts, signals, captured } = options(root);
    const run = supervise([hook], opts);
    await new Promise((done) => setTimeout(done, 300));
    const kill = process.kill;
    process.kill = ((pid: number, sig?: string | number) => {
      if (pid < 0) throw Object.assign(new Error("denied"), { code: "EPERM" });
      return kill.call(process, pid, sig);
    }) as typeof process.kill;
    try {
      signals.emit("SIGTERM");
    } finally {
      process.kill = kill;
    }
    assert.equal(await run, 143);
    assert.match(captured.err, /forwarding failed: EPERM/);
  });

  it("says nothing when the hook group is already gone", async () => {
    const { root, hook } = repo("sleep 5");
    const { opts, signals, captured } = options(root);
    const run = supervise([hook], opts);
    await new Promise((done) => setTimeout(done, 300));
    const kill = process.kill;
    let real = 0;
    process.kill = ((pid: number, sig?: string | number) => {
      if (pid < 0 && real++ === 0)
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return kill.call(process, pid, sig);
    }) as typeof process.kill;
    try {
      signals.emit("SIGHUP");
      signals.emit("SIGTERM");
    } finally {
      process.kill = kill;
    }
    assert.equal(await run, 143);
    assert.equal(captured.err, "");
  });
});

describe("the watchdog", () => {
  const module = (
    overrides: Partial<WatchdogModule> = {},
    calls: string[] = [],
  ): WatchdogModule => ({
    createWatchdog: (options) => {
      calls.push(`create ${typeof options.rootPid}`);
      return {
        disarm: () => calls.push("disarm"),
        stop: () => calls.push("stop"),
        summary: () => ({ mode: "enforce" }),
        enforced: () => false,
      };
    },
    resolveWatchdogConfig: (_env, platform, levels) => ({ platform, levels }),
    exitDisposition: () => null,
    ...overrides,
  });

  it("attaches to the hook and records its summary", async () => {
    const { root, hook } = repo("true");
    const calls: string[] = [];
    const { opts } = options(
      root,
      { loadWatchdog: async () => module({}, calls) },
      { watchdog: "w.mjs" },
    );
    assert.equal(await supervise([hook], opts), 0);
    assert.deepEqual(calls, ["create number", "stop"]);
    assert.deepEqual(rows(root)[0]?.watchdog, { mode: "enforce" });
  });

  it("runs the hook without a watchdog that cannot start", async () => {
    const { root, hook } = repo("true");
    const broken = module({
      createWatchdog: () => {
        throw new Error("no");
      },
    });
    const { opts } = options(
      root,
      { loadWatchdog: async () => broken },
      { watchdog: "w.mjs" },
    );
    assert.equal(await supervise([hook], opts), 0);
    assert.deepEqual(rows(root)[0]?.watchdog, { mode: "unavailable" });
  });

  it("lets an enforced verdict decide the outcome", async () => {
    const { root, hook } = repo("dvara_stage stuck\nexit 0");
    const enforced = module({
      createWatchdog: () => ({
        disarm: () => undefined,
        stop: () => undefined,
        summary: () => ({ mode: "enforce", verdict: "deadlock" }),
        enforced: () => true,
      }),
      exitDisposition: () => ({ code: 124, status: "deadlock" }),
    });
    const { opts } = options(
      root,
      { loadWatchdog: async () => enforced },
      { watchdog: "w.mjs" },
    );
    assert.equal(await supervise([hook], opts), 124);
    const [row] = rows(root);
    assert.equal(row?.status, "deadlock");
    assert.equal(row?.stages.at(-1)?.status, "deadlock");
  });

  it("loads a watchdog module from a file by default", async () => {
    const { root, hook } = repo("true");
    writeFileSync(
      join(root, "w.mjs"),
      [
        'export const createWatchdog = () => ({ disarm() {}, stop() {}, summary: () => ({ mode: "file" }), enforced: () => false });',
        "export const resolveWatchdogConfig = () => ({});",
        "export const exitDisposition = () => null;",
      ].join("\n"),
    );
    const { opts } = options(root, {}, { watchdog: "w.mjs" });
    const { loadWatchdog: _drop, ...rest } = opts;
    assert.equal(await supervise([hook], rest), 0);
    assert.deepEqual(rows(root)[0]?.watchdog, { mode: "file" });
  });

  it("disarms the watchdog when a person cancels", async () => {
    const { root, hook } = repo("sleep 5");
    const calls: string[] = [];
    const { opts, signals } = options(
      root,
      { loadWatchdog: async () => module({}, calls) },
      { watchdog: "w.mjs" },
    );
    const run = supervise([hook], opts);
    await new Promise((done) => setTimeout(done, 300));
    signals.emit("SIGINT");
    assert.equal(await run, 130);
    assert.ok(calls.includes("disarm"));
  });
});
