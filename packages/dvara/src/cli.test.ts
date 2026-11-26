import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
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
  entry,
  isEntry,
  ownVersion,
  parseTrailersArgs,
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

  it("prints the whole usage, word for word", async () => {
    const { io, err } = capture();
    assert.equal(await run(["help"], { io, cwd: "/", env: {} }), 2);
    assert.deepEqual(err, [
      [
        "usage: dvara run <hook-file> [hook args…]   run a git hook under the supervisor",
        "       dvara stages <hook>                  the hook stages the config lists, one per line",
        "       dvara shell <stages|keep-going>      the path of a shell helper to source",
        "       dvara records <--staged | --all [--base REF] [--write-baseline | --survey] | --base REF>",
        "                                            the record gate: no new non-durable paths, a baseline that only falls",
        "       dvara frozen <--staged | --base REF [--head REF]>",
        "                                            refuse changes to the frozen paths",
        "       dvara trailers [--key KEY]… <commit-msg-file>",
        "                                            refuse trailer lines git would not read (commit-msg)",
        "       dvara exec-bits --staged [--refuse]",
        "                                            warn on (or refuse) a dropped executable bit (pre-commit)",
        "       dvara review-size --cap N [--ignore GLOB]… [--base REF]",
        "                                            warn when the branch is over a reviewer's line cap (pre-push)",
        "       dvara slot --name <name> [--dir <dir>] [--set NAME=VALUE]… [--unset NAME]… -- <command> [args…]",
        "                                            run a command, with the variables set while it holds the machine's slot",
        "       dvara turn [--exclusive] [--class push|other] [--label <text>] -- <command> [args…]",
        "                                            run heavy work in its turn in the machine's queue (record-only by default)",
        "       dvara turn-replay [--count N]… [--wait-minutes M] [--since <ISO time>] [--file <turns.jsonl>]",
        "                                            the waits the logged requests would have had at each count",
        "       dvara --version",
      ].join("\n"),
    ]);
  });

  it("prints each shell helper's path in the package's shell folder", async () => {
    const shell = resolve(import.meta.dirname, "..", "shell");
    for (const name of ["stages", "keep-going"]) {
      const { io, out, err } = capture();
      assert.equal(await run(["shell", name], { io, cwd: "/", env: {} }), 0);
      assert.deepEqual([out, err], [[join(shell, `${name}.sh`)], []]);
    }
    assert.equal(shellHelper("x"), join(shell, "x.sh"));
  });

  it("names a shell helper only for `shell` with one known name", async () => {
    const root = scratch("dvara-cli-");
    for (const argv of [
      ["shell"],
      ["shell", "keep-going", "extra"],
      ["help", "keep-going"],
    ]) {
      const { io, out, err } = capture();
      assert.equal(await run(argv, { io, cwd: root, env: {} }), 2, argv.join(" "));
      assert.deepEqual(out, [], argv.join(" "));
      assert.equal(err.length, 1, argv.join(" "));
    }
    // `stages` with a helper's name lists that hook's stages: none here.
    const { io, out, err } = capture();
    assert.equal(await run(["stages", "keep-going"], { io, cwd: root, env: {} }), 0);
    assert.deepEqual([out, err], [[], []]);
  });

  it("lists no stages when the config has none", async () => {
    const root = scratch("dvara-cli-");
    const { io, out, err } = capture();
    assert.equal(await run(["stages", "pre-push"], { io, cwd: root, env: {} }), 0);
    assert.deepEqual([out, err], [[], []]);
  });

  it("refuses review-size's bad arguments with the reason and the usage", async () => {
    const { io, out, err } = capture();
    assert.equal(await run(["review-size"], { io, cwd: "/", env: {} }), 2);
    assert.deepEqual(out, []);
    assert.deepEqual(err, [
      "dvara review-size: give --cap",
      "usage: dvara review-size --cap N [--ignore GLOB]… [--base REF]",
    ]);
  });

  it("says review-size was not checked when no base ref resolves in the repository", async () => {
    const r = repo("dvara-cli-size-");
    r.write("a.md", "a\n");
    r.commit("one");
    const { io, out, err } = capture();
    assert.equal(await run(["review-size", "--cap", "10"], { io, cwd: r.root, env: r.env }), 0);
    assert.deepEqual(out, []);
    assert.deepEqual(err, ["⚠ review-size: no base ref resolves, so the branch's size was not checked."]);
  });

  it("warns when the branch is over its cap, against the base it is given", async () => {
    const r = repo("dvara-cli-size-");
    r.write("a.md", "a\n");
    r.commit("one");
    const base = r.git("rev-parse", "HEAD").trim();
    r.write("big.md", "1\n2\n3\n");
    r.commit("two");
    const { io, out, err } = capture();
    assert.equal(await run(["review-size", "--cap", "2", "--base", base], { io, cwd: r.root, env: r.env }), 0);
    assert.deepEqual(out, []);
    assert.deepEqual(err, [
      `⚠ review-size: this branch changes 3 lines against ${base} outside the reviewer's ignore globs, over its cap of 2: the reviewer will skip the pull request, and a merge rule that needs its pass can never be met.`,
      "  Split it before the pull request opens, by workspace: rebuild each branch from this tree by path, and check `git diff --stat <this branch> HEAD -- <workspace>` is empty for each. Largest files:",
      "    3 big.md",
    ]);
  });

  it("says review-size was not checked, with the first line of why", async () => {
    const root = scratch("dvara-cli-");
    writeFileSync(join(root, ".dvara.json"), JSON.stringify({ "first\nsecond": 1 }));
    const { io, out, err } = capture();
    assert.equal(await run(["review-size", "--cap", "10"], { io, cwd: root, env: {} }), 0);
    assert.deepEqual(out, []);
    assert.deepEqual(err, [
      `⚠ review-size: not checked: dvara: ${join(root, ".dvara.json")}: unknown field first`,
    ]);
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

  it("parses one file and each --key, in any order", () => {
    assert.deepEqual(parseTrailersArgs(["msg"]), { file: "msg", keys: [] });
    assert.deepEqual(
      parseTrailersArgs(["--key", "Slice", "msg", "--key", "--key"]),
      { file: "msg", keys: ["Slice", "--key"] },
    );
    assert.deepEqual(parseTrailersArgs(["--key", "Slice"]), {
      error: "give one commit message file",
    });
    assert.deepEqual(parseTrailersArgs(["a", "--key", "Bad key", "b"]), {
      error: "--key takes a trailer key: letters, digits and -",
    });
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
    // An empty entry would resolve to the working folder; it is still no entry.
    assert.equal(isEntry("", pathToFileURL(process.cwd()).href), false);
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

  it("leaves an importer's exit code alone", () => {
    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `process.exitCode = 7; await import(${JSON.stringify(pathToFileURL(self).href)});`,
      ],
      { encoding: "utf8" },
    );
    assert.deepEqual([imported.status, imported.stdout], [7, ""]);
  });

  it("runs the command after the script's path when that path is the module", async () => {
    const root = scratch("dvara-cli-");
    writeFileSync(
      join(root, ".dvara.json"),
      JSON.stringify({ stages: { "pre-push": ["lint"] } }),
    );
    const { io, out, err } = capture();
    const url = pathToFileURL(self).href;
    assert.equal(
      await entry(["node", self, "stages", "pre-push"], url, io, () => root, {}),
      0,
    );
    assert.deepEqual([out, err], [["lint"], []]);
    const asked: string[] = [];
    const cwd = () => {
      asked.push("cwd");
      return root;
    };
    assert.equal(
      await entry(["node", resolve(root, "other.js"), "stages", "pre-push"], url, io, cwd, {}),
      undefined,
    );
    assert.equal(await entry(["node"], url, io, cwd, {}), undefined);
    assert.deepEqual([out, err, asked], [["lint"], [], []]);
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
      // The command also ends itself after 20 s: a run that is killed before
      // the cleanup below (a mutation run's bail or limit) leaves nothing for long.
      const childScript = [
        `process.on('SIGINT', () => process.exit(0));`,
        `require('node:fs').writeFileSync(${JSON.stringify(ready)}, '');`,
        `setTimeout(() => process.exit(0), 20000);`,
      ].join(" ");
      const wrapper = spawn(
        process.execPath,
        [cli, "slot", "--name", "mobile", "--", process.execPath, "-e", childScript],
        // Its own process group, so cleanup can reach the command too.
        { env: slotEnv(dir), stdio: "ignore", detached: true },
      );
      const group = wrapper.pid ?? 0;
      // Whatever failed, leave no wrapper or command running, also when this
      // process exits before the test settles.
      const reap = (): void => {
        try {
          if (group > 0) process.kill(-group, "SIGKILL");
        } catch {
          // fail-open: the group already exited.
        }
      };
      process.once("exit", reap);
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
        const stuck = new Promise<string>((resolve) =>
          setTimeout(() => resolve("still running 10 s after SIGINT"), 10_000).unref(),
        );
        assert.equal(await Promise.race([exited, stuck]), 130);
        assert.equal(existsSync(lock(dir, "mobile")), false);
      } finally {
        process.off("exit", reap);
        reap();
      }
    },
  );
});

describe("dvara turn", () => {
  const cli = resolve(import.meta.dirname, "cli.ts");
  /**
   * The environment a real run gets: this machine's queue never, CI never, no
   * outer turn or hook, and the mode and count each test sets.
   */
  const turnEnv = (dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "", DVARA_TURN_DIR: dir, ...extra };
    for (const name of [
      "DVARA_TURN_HELD",
      "DVARA_TURN_MODE",
      "DVARA_TURNS",
      "DVARA_TURN_WAIT_MINUTES",
      "DVARA_MEASURED_HOOK",
      "DVARA_STAGE_FILE",
      "DVARA_RECORD_FILE",
    ])
      if (!(name in extra)) delete env[name];
    return env;
  };
  const log = (dir: string): Array<Record<string, unknown>> =>
    readFileSync(join(dir, "turns.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it("lists both commands in its usage", () => {
    assert.ok(USAGE.includes("dvara turn [--exclusive] [--class push|other] [--label <text>] -- <command> [args…]"));
    assert.ok(USAGE.includes("dvara turn-replay [--count N]… [--wait-minutes M]"));
  });

  it("runs the turn on the wiring it is given", async () => {
    const dir = scratch("dvara-cli-turn-");
    const { io, err } = capture();
    const status = await run(["turn", "--", "cmd"], {
      io,
      cwd: dir,
      env: { DVARA_TURN_DIR: dir },
      turn: {
        git: () => null,
        spawn: () => {
          const child = Object.assign(new EventEmitter(), { kill: () => true });
          setImmediate(() => child.emit("exit", 5, null));
          return child;
        },
      },
    });
    assert.equal(status, 5);
    assert.deepEqual(err, []);
    assert.equal(log(dir)[0]?.["exitCode"], 5);
  });

  it("replays the machine's log", async () => {
    const dir = scratch("dvara-cli-turn-");
    writeFileSync(
      join(dir, "turns.jsonl"),
      `${JSON.stringify({ id: "a", nested: false, class: "other", exclusive: false, askedAt: 0, startedAt: 0, endedAt: 10 })}\n`,
    );
    const { io, out } = capture();
    assert.equal(await run(["turn-replay", "--count", "1"], { io, cwd: dir, env: { DVARA_TURN_DIR: dir } }), 0);
    assert.equal((JSON.parse(out[0] ?? "{}") as Record<string, unknown>)["requests"], 1);
  });

  it("passes a real command's exit status through and logs the request", () => {
    const dir = scratch("dvara-cli-turn-");
    const result = spawnSync(
      process.execPath,
      [cli, "turn", "--label", "exit 7", "--", process.execPath, "-e", "process.exit(7)"],
      { encoding: "utf8", env: turnEnv(dir), timeout: 60_000, killSignal: "SIGKILL" },
    );
    assert.equal(result.status, 7, result.stderr);
    const [line] = log(dir);
    assert.equal(line?.["label"], "exit 7");
    assert.equal(line?.["mode"], "record");
    assert.equal(line?.["exitCode"], 7);
  });

  it(
    "makes a third request wait behind two holders in enforce mode, naming them, then run",
    { timeout: 90_000 },
    async (t) => {
      const dir = scratch("dvara-cli-turn-");
      const env = turnEnv(dir, { DVARA_TURN_MODE: "enforce", DVARA_TURNS: "2" });
      const release = join(dir, "release");
      // Each holder waits for the release file, and ends itself after 30 s whatever happens.
      const hold = (name: string) => [
        process.execPath,
        "-e",
        [
          `const fs = require('node:fs');`,
          `fs.writeFileSync(${JSON.stringify(join(dir, name))}, '');`,
          `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(t); process.exit(0); } }, 50);`,
          `setTimeout(() => process.exit(0), 30000);`,
        ].join(" "),
      ];
      const children: ReturnType<typeof spawn>[] = [];
      const runTurn = (label: string, command: string[]) => {
        const child = spawn(process.execPath, [cli, "turn", "--label", label, "--", ...command], {
          env,
          stdio: ["ignore", "ignore", "pipe"],
        });
        children.push(child);
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
        return { exited, stderr: () => stderr };
      };
      const until = async (path: string): Promise<void> => {
        const deadline = Date.now() + 30_000;
        while (!existsSync(path) && Date.now() < deadline)
          await new Promise((done) => setTimeout(done, 50));
        assert.ok(existsSync(path), `${path} never appeared`);
      };
      try {
        const first = runTurn("first holder", hold("a"));
        await until(join(dir, "a"));
        const second = runTurn("second holder", hold("b"));
        await until(join(dir, "b"));
        const third = runTurn("waiter", [process.execPath, "-e", "process.exit(3)"]);
        const deadline = Date.now() + 30_000;
        while (!third.stderr().includes("⏳") && Date.now() < deadline)
          await new Promise((done) => setTimeout(done, 50));
        writeFileSync(release, "");
        assert.equal(await third.exited, 3);
        assert.equal(await first.exited, 0);
        assert.equal(await second.exited, 0);
        t.diagnostic(third.stderr());
        const lines = third.stderr().split("\n");
        assert.match(
          lines[0] ?? "",
          /^⏳ Waiting for a heavy-work turn \(2 of 2 in use, you are 1st in line\); waited 0 min of up to 30\.$/,
        );
        assert.match(lines[1] ?? "", /^ {3}\S+ {2}first holder {3}for 0 min/);
        assert.match(lines[2] ?? "", /^ {3}\S+ {2}second holder {2}for 0 min/);
        const waiter = log(dir).find((line) => line["label"] === "waiter");
        t.diagnostic(JSON.stringify(waiter));
        assert.equal(waiter?.["mode"], "enforce");
        assert.ok(Number(waiter?.["waitedMs"]) > 0);
        assert.equal((waiter?.["holders"] as unknown[]).length, 2);
        assert.equal(existsSync(join(dir, "waiters")) && readdirSync(join(dir, "waiters")).length, 0);
        assert.deepEqual(readdirSync(join(dir, "tickets")), []);
      } finally {
        for (const child of children) child.kill("SIGKILL");
      }
    },
  );
});
