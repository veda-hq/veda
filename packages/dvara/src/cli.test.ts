import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import {
  isEntry,
  ownVersion,
  processIo,
  run,
  shellHelper,
  USAGE,
} from "./cli.ts";
import { repo } from "./records/fixture.test.ts";

/** Every folder the tests made, removed once they are done. */
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    out,
    err,
  };
};

describe("dvara", () => {
  it("prints its version", async () => {
    const { io, out } = capture();
    assert.equal(await run(["--version"], { io, cwd: "/", env: {} }), 0);
    assert.deepEqual(out, [ownVersion()]);
    assert.match(ownVersion(), /^\d+\.\d+\.\d+$/);
  });

  it("names the shell helpers it ships", async () => {
    const { io, out } = capture();
    assert.equal(
      await run(["shell", "keep-going"], { io, cwd: "/", env: {} }),
      0,
    );
    assert.equal(out[0], shellHelper("keep-going"));
    assert.ok(existsSync(shellHelper("stages")));
    assert.ok(existsSync(shellHelper("keep-going")));
  });

  it("lists a hook stages from the config, and none for an unlisted hook", async () => {
    const root = scratch("dvara-cli-");
    writeFileSync(
      join(root, ".dvara.json"),
      JSON.stringify({ stages: { "pre-push": ["lint", "test"] } }),
    );
    const { io, out } = capture();
    assert.equal(
      await run(["stages", "pre-push"], { io, cwd: root, env: {} }),
      0,
    );
    assert.equal(
      await run(["stages", "pre-commit"], { io, cwd: root, env: {} }),
      0,
    );
    assert.equal(
      await run(["stages", "toString"], { io, cwd: root, env: {} }),
      0,
    );
    assert.deepEqual(out, ["lint", "test"]);
  });

  it("lists a hook stages from the stage list file, and refuses one it cannot read", async () => {
    const root = scratch("dvara-cli-");
    writeFileSync(
      join(root, ".dvara.json"),
      JSON.stringify({ stageList: "stages.json" }),
    );
    const { io, out, err } = capture();
    assert.equal(
      await run(["stages", "pre-push"], { io, cwd: root, env: {} }),
      2,
    );
    assert.match(err[0] ?? "", /cannot read the stage list .*stages\.json/);
    writeFileSync(
      join(root, "stages.json"),
      JSON.stringify({ "pre-push": ["lint"] }),
    );
    assert.equal(
      await run(["stages", "pre-push"], { io, cwd: root, env: {} }),
      0,
    );
    assert.deepEqual(out, ["lint"]);
  });

  it("hands a run to the supervisor with the config", async () => {
    const root = scratch("dvara-cli-");
    writeFileSync(join(root, ".dvara.json"), '{"historyDir": "h"}');
    const { io } = capture();
    let seen: unknown;
    const code = await run(["run", "hooks/pre-push", "origin"], {
      io,
      cwd: root,
      env: { X: "1" },
      supervise: async (args, options) => {
        seen = [args, options.root, options.config.historyDir, options.env?.X];
        return 7;
      },
    });
    assert.equal(code, 7);
    assert.deepEqual(seen, [["hooks/pre-push", "origin"], root, "h", "1"]);
  });

  it("runs a real hook through the supervisor by default", async () => {
    const root = scratch("dvara-cli-");
    writeFileSync(join(root, "pre-push"), "exit 5");
    const { io } = capture();
    assert.equal(
      await run(["run", join(root, "pre-push")], {
        io,
        cwd: root,
        env: process.env,
        options: { ppid: 1 },
      }),
      5,
    );
    assert.match(
      readFileSync(join(root, ".dvara", "history.jsonl"), "utf8"),
      /"exitCode":5/,
    );
  });

  it("refuses a config it cannot read", async () => {
    const root = scratch("dvara-cli-");
    writeFileSync(join(root, ".dvara.json"), "{");
    const { io, err } = capture();
    assert.equal(
      await run(["stages", "pre-push"], { io, cwd: root, env: {} }),
      2,
    );
    assert.match(err[0] ?? "", /dvara: /);
  });

  it("prints its usage for anything else", async () => {
    for (const argv of [[], ["run"], ["stages"], ["shell", "nope"], ["help"]]) {
      const { io, err } = capture();
      assert.equal(await run(argv, { io, cwd: "/", env: {} }), 2);
      assert.deepEqual(err, [USAGE]);
    }
  });

  it("offers --write-baseline and --survey with --all only, as the gate takes them", () => {
    assert.ok(
      USAGE.includes(
        "dvara records <--staged | --all [--base REF] [--write-baseline | --survey] | --base REF>",
      ),
      USAGE,
    );
  });
});

describe("dvara records and dvara frozen", () => {
  /** A repository whose config freezes `docs/archive/` and names pnpm. */
  const configured = () => {
    const r = repo("dvara-cli-records-");
    r.write(
      ".dvara.json",
      `${JSON.stringify({
        records: {
          baseline: "tools/records-baseline.json",
          frozen: { paths: ["docs/archive/"], except: [] },
          // The config quotes machine paths; the gate never reads it.
          allowPaths: ["^/private/tmp/shared(?![\\w.-])"],
          packageManager: "pnpm",
        },
      })}\n`,
    );
    r.write("docs/archive/old.md", "old\n");
    r.write("docs/guide.md", "Install with pnpm install.\n");
    r.commit("init");
    return r;
  };

  it("runs the record gate on the index, with the config's settings", async () => {
    const r = configured();
    r.write("docs/guide.md", "Install with npm install.\n");
    r.git("add", "-A");
    const { io, out, err } = capture();
    const context = { io, cwd: r.root, env: r.env };
    assert.equal(await run(["records", "--staged"], context), 1);
    assert.deepEqual(err, []);
    assert.deepEqual(out.slice(0, 3), [
      "❌ records: refused",
      "docs/guide.md — EVIDENCE-02:",
      '  docs/guide.md:1 [EVIDENCE-02/install-command] npm/yarn install: this repository installs with pnpm only: "npm install"',
    ]);
    r.commit("a legacy finding");
    out.length = 0;
    assert.equal(
      await run(["records", "--all", "--write-baseline"], context),
      0,
    );
    assert.deepEqual(out, [
      "dvara records: wrote tools/records-baseline.json (1 files, 1 findings)",
    ]);
    r.commit("held");
    out.length = 0;
    assert.equal(await run(["records", "--all"], context), 0);
    assert.match(
      out[0] ?? "",
      /^✅ records: 1 file\(s\) checked, 1 legacy finding/,
    );
  });

  it("refuses bad arguments, a bad config and a git that cannot answer", async () => {
    const { io, err } = capture();
    assert.equal(await run(["records"], { io, cwd: "/", env: {} }), 2);
    assert.deepEqual(err, [
      "dvara records: nothing to check",
      "usage: dvara records --staged | --all [--base REF] [--write-baseline | --survey] | --base REF",
    ]);
    const r = configured();
    r.write(".dvara.json", '{"records": {"typo": 1}}');
    err.length = 0;
    assert.equal(
      await run(["records", "--staged"], { io, cwd: r.root, env: r.env }),
      2,
    );
    assert.match(
      err[0] ?? "",
      /^dvara records: dvara: .*unknown field records\.typo$/,
    );
    const elsewhere = scratch("dvara-cli-none-");
    err.length = 0;
    assert.equal(
      await run(["records", "--staged"], { io, cwd: elsewhere, env: r.env }),
      2,
    );
    assert.match(err[0] ?? "", /^dvara records: .*not a git repository/);
  });

  it("refuses a change to a frozen path, and passes one elsewhere", async () => {
    const r = configured();
    const { io, out, err } = capture();
    const context = { io, cwd: r.root, env: r.env };
    r.write("docs/guide.md", "Install with pnpm install, twice.\n");
    r.git("add", "-A");
    assert.equal(await run(["frozen", "--staged"], context), 0);
    assert.deepEqual(out, ["✅ frozen: no frozen path changes"]);
    r.write("docs/archive/old.md", "edited\n");
    r.git("add", "-A");
    assert.equal(await run(["frozen", "--staged"], context), 1);
    assert.deepEqual(err.slice(0, 2), [
      "❌ frozen: this commit changes 1 file(s) under docs/archive/:",
      "     M docs/archive/old.md",
    ]);
    err.length = 0;
    assert.equal(await run(["frozen", "--base", "nope"], context), 2);
    assert.match(err[0] ?? "", /^dvara frozen: .*nope/);
    err.length = 0;
    assert.equal(await run(["frozen"], context), 2);
    assert.deepEqual(err, [
      "dvara frozen: give --staged, or --base REF [--head REF]",
      "usage: dvara frozen --staged | --base REF [--head REF]",
    ]);
  });
});

describe("dvara trailers", () => {
  const MESSAGE = "feat: x\n\nSlice: L-04\n\nCo-Authored-By: A <a@a>\n";

  it("passes a message whose trailers are all in its last paragraph", async () => {
    const root = scratch("dvara-cli-trailers-");
    writeFileSync(
      join(root, "msg"),
      "feat: x\n\nSlice: L-04\nCo-Authored-By: A\n",
    );
    const { io, out, err } = capture();
    assert.equal(await run(["trailers", "msg"], { io, cwd: root, env: {} }), 0);
    assert.deepEqual([out, err], [[], []]);
  });

  it("refuses a known trailer above a blank line, with the config's keys", async () => {
    const root = scratch("dvara-cli-trailers-");
    writeFileSync(join(root, "msg"), MESSAGE);
    const { io, err } = capture();
    // Without the repository's key, Slice is prose.
    assert.equal(await run(["trailers", "msg"], { io, cwd: root, env: {} }), 0);
    writeFileSync(
      join(root, ".dvara.json"),
      JSON.stringify({ trailerKeys: ["Slice"] }),
    );
    assert.equal(await run(["trailers", "msg"], { io, cwd: root, env: {} }), 1);
    assert.deepEqual(err, [
      "❌ trailers: msg has trailer lines git does not read (above a blank line, or in the title's paragraph):",
      "  msg:3 Slice: L-04",
      "Git reads trailers only from the last paragraph. Move these lines into the final block with no blank line between them (one `-F <file>` message), then check with `git log -1 --format=%(trailers)`.",
    ]);
  });

  it("takes a repository's keys from --key too, with no config field", async () => {
    const root = scratch("dvara-cli-trailers-");
    writeFileSync(join(root, "msg"), MESSAGE);
    const { io, err } = capture();
    assert.equal(
      await run(["trailers", "--key", "Slice", "msg"], { io, cwd: root, env: {} }),
      1,
    );
    assert.equal(err[1], "  msg:3 Slice: L-04");
    assert.equal(
      await run(["trailers", "msg", "--key", "State"], { io, cwd: root, env: {} }),
      0,
    );
  });

  it("refuses a --key with no key or a key git would not read", async () => {
    const root = scratch("dvara-cli-trailers-");
    for (const args of [["msg", "--key"], ["--key", "Bad key", "msg"]]) {
      const { io, err } = capture();
      assert.equal(
        await run(["trailers", ...args], { io, cwd: root, env: {} }),
        2,
      );
      assert.deepEqual(err, [
        "dvara trailers: --key takes a trailer key: letters, digits and -",
        "usage: dvara trailers [--key KEY]… <commit-msg-file>",
      ]);
    }
  });

  it("refuses bad arguments, a bad config and a file it cannot read", async () => {
    const root = scratch("dvara-cli-trailers-");
    for (const args of [[], ["a", "b"]]) {
      const { io, err } = capture();
      assert.equal(
        await run(["trailers", ...args], { io, cwd: root, env: {} }),
        2,
      );
      assert.deepEqual(err, [
        "dvara trailers: give one commit message file",
        "usage: dvara trailers [--key KEY]… <commit-msg-file>",
      ]);
    }
    const { io, err } = capture();
    assert.equal(
      await run(["trailers", "missing"], { io, cwd: root, env: {} }),
      2,
    );
    assert.match(err[0] ?? "", /^dvara trailers: cannot read missing: ENOENT/);
    writeFileSync(join(root, ".dvara.json"), '{"trailerKeys": [""]}');
    err.length = 0;
    assert.equal(
      await run(["trailers", "missing"], { io, cwd: root, env: {} }),
      2,
    );
    assert.match(err[0] ?? "", /^dvara trailers: dvara: .*trailerKeys must/);
  });

  it("is in the usage", () => {
    assert.ok(USAGE.includes("dvara trailers [--key KEY]… <commit-msg-file>"), USAGE);
  });
});

describe("isEntry", () => {
  const self = resolve(import.meta.dirname, "cli.ts");

  it("is true for the module itself, through a symlink too", () => {
    assert.equal(isEntry(self, pathToFileURL(self).href), true);
    const link = join(scratch("dvara-link-"), "cli.ts");
    symlinkSync(self, link);
    assert.equal(isEntry(link, pathToFileURL(self).href), true);
  });

  it("is false for no entry, another file or a missing one", () => {
    assert.equal(isEntry(undefined, pathToFileURL(self).href), false);
    assert.equal(
      isEntry(
        resolve(import.meta.dirname, "config.ts"),
        pathToFileURL(self).href,
      ),
      false,
    );
    assert.equal(isEntry("/nonexistent/x.js", pathToFileURL(self).href), false);
  });

  it("writes its own output a line at a time", (t) => {
    // Writes through, so no TAP line of Stryker's tap runner is lost (see
    // supervisor.test.ts).
    const write = process.stdout.write.bind(process.stdout);
    const out = t.mock.method(process.stdout, "write", ((
      ...args: Parameters<typeof write>
    ) => write(...args)) as typeof write);
    const err = t.mock.method(process.stderr, "write", () => true);
    processIo.out("a");
    processIo.err("b");
    assert.deepEqual(out.mock.calls[0]?.arguments, ["a\n"]);
    assert.deepEqual(err.mock.calls[0]?.arguments, ["b\n"]);
  });

  it("runs as a command", () => {
    const out = execFileSync(process.execPath, [self, "--version"], {
      encoding: "utf8",
    });
    assert.equal(out.trim(), ownVersion());
  });
});

describe("dvara slot", () => {
  const cli = resolve(import.meta.dirname, "cli.ts");
  const GRANT = "GRANT_WORKERS";
  /** The environment a run gets: never CI, never switched off, no preset grant. */
  const slotEnv = (dir: string): NodeJS.ProcessEnv => ({
    ...process.env,
    CI: "",
    DVARA_SLOT: undefined,
    [GRANT]: undefined,
    DVARA_SLOT_DIR: dir,
  });
  const runSlot = (argv: string[], dir: string) =>
    spawnSync(process.execPath, [cli, "slot", ...argv], {
      encoding: "utf8",
      env: slotEnv(dir),
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
  const printGrant = [
    process.execPath,
    "-e",
    `process.stdout.write(String(process.env.${GRANT}))`,
  ];
  const lock = (dir: string, name: string): string => join(dir, `${name}.lock`);

  it("lists the command in its usage", () => {
    assert.ok(
      USAGE.includes(
        "dvara slot --name <name> [--dir <dir>] [--set NAME=VALUE]… [--unset NAME]… -- <command> [args…]",
      ),
      USAGE,
    );
  });

  it("runs the slot on the wiring it is given", async () => {
    const dir = scratch("dvara-cli-slot-");
    const { io, err } = capture();
    const status = await run(["slot", "--name", "mobile", "--", "cmd"], {
      io,
      cwd: dir,
      env: { DVARA_SLOT_DIR: dir },
      slot: {
        spawn: () => {
          const child = Object.assign(new EventEmitter(), { kill: () => true });
          queueMicrotask(() => child.emit("exit", 5, null));
          return child;
        },
      },
    });
    assert.equal(status, 5);
    assert.deepEqual(err, ["[dvara slot] mobile: took the slot"]);
    assert.equal(existsSync(lock(dir, "mobile")), false);
  });

  it("runs the command with the variables, releases the slot, and logs the start", () => {
    const dir = scratch("dvara-cli-slot-");
    const result = runSlot(["--name", "mobile", "--set", `${GRANT}=12`, "--", ...printGrant], dir);
    assert.equal(result.stdout, "12");
    assert.match(result.stderr, /\[dvara slot\] mobile: took the slot/);
    assert.equal(result.status, 0);
    assert.equal(existsSync(lock(dir, "mobile")), false);
    const log = JSON.parse(readFileSync(join(dir, "slots.jsonl"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(log["name"], "mobile");
    assert.equal(log["taken"], true);
    assert.deepEqual(log["set"], { [GRANT]: "12" });
  });

  it("runs the command without the variables while a live process holds the slot", () => {
    const dir = scratch("dvara-cli-slot-");
    writeFileSync(
      lock(dir, "web"),
      JSON.stringify({
        pid: process.pid,
        startIdentity: null,
        branch: "web",
        rootDir: "/elsewhere",
        token: "their-token",
        since: Date.now(),
      }),
    );
    const result = runSlot(["--name", "web", "--set", `${GRANT}=8`, "--", ...printGrant], dir);
    assert.equal(result.stdout, "undefined");
    assert.match(result.stderr, new RegExp(`held by pid ${process.pid}`));
    assert.match(readFileSync(lock(dir, "web"), "utf8"), /their-token/);
  });

  it("passes the command's exit status through and still releases the slot", () => {
    const dir = scratch("dvara-cli-slot-");
    const result = runSlot(
      ["--name", "mobile", "--", process.execPath, "-e", "process.exit(7)"],
      dir,
    );
    assert.equal(result.status, 7);
    assert.equal(existsSync(lock(dir, "mobile")), false);
  });

  it("exits 127 when the command cannot be started", () => {
    const dir = scratch("dvara-cli-slot-");
    const result = runSlot(["--name", "mobile", "--", join(dir, "no-such-command")], dir);
    assert.equal(result.status, 127);
    assert.match(result.stderr, /could not start/);
    assert.equal(existsSync(lock(dir, "mobile")), false);
  });

  it("exits 2 with usage on bad arguments", () => {
    const dir = scratch("dvara-cli-slot-");
    const result = runSlot(["--name", "mobile"], dir);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: dvara slot/);
  });

  it(
    "reports an interrupted run as 130 even when the command exits 0 on the signal",
    { timeout: 60_000 },
    async () => {
      const dir = scratch("dvara-cli-slot-");
      // The command swallows SIGINT and exits 0, as a test runner cleaning up might.
      const ready = join(dir, "ready");
      const childScript = [
        `process.on('SIGINT', () => process.exit(0));`,
        `require('node:fs').writeFileSync(${JSON.stringify(ready)}, '');`,
        `setInterval(() => {}, 1000);`,
      ].join(" ");
      const wrapper = spawn(
        process.execPath,
        [cli, "slot", "--name", "mobile", "--", process.execPath, "-e", childScript],
        // Its own process group, so cleanup can reach the command too.
        { env: slotEnv(dir), stdio: "ignore", detached: true },
      );
      const group = wrapper.pid ?? 0;
      try {
        const exited = new Promise<number | null>((resolve, reject) => {
          wrapper.on("exit", (code) => resolve(code));
          wrapper.on("error", reject);
        });
        const deadline = Date.now() + 30_000;
        while (!existsSync(ready) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(existsSync(ready), "the command never started");
        wrapper.kill("SIGINT");
        assert.equal(await exited, 130);
        assert.equal(existsSync(lock(dir, "mobile")), false);
      } finally {
        // Whatever failed above, leave no wrapper or command running.
        try {
          if (group > 0) process.kill(-group, "SIGKILL");
        } catch {
          // fail-open: the group already exited.
        }
      }
    },
  );
});
