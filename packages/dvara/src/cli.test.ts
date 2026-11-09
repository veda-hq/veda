import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  isEntry,
  ownVersion,
  processIo,
  run,
  shellHelper,
  USAGE,
} from "./cli.ts";
import { repo } from "./records/fixture.test.ts";

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
    const root = mkdtempSync(join(tmpdir(), "dvara-cli-"));
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
    assert.deepEqual(out, ["lint", "test"]);
  });

  it("hands a run to the supervisor with the config", async () => {
    const root = mkdtempSync(join(tmpdir(), "dvara-cli-"));
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
    const root = mkdtempSync(join(tmpdir(), "dvara-cli-"));
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
    const root = mkdtempSync(join(tmpdir(), "dvara-cli-"));
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
    const elsewhere = mkdtempSync(join(tmpdir(), "dvara-cli-none-"));
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

describe("isEntry", () => {
  const self = resolve(import.meta.dirname, "cli.ts");

  it("is true for the module itself, through a symlink too", () => {
    assert.equal(isEntry(self, pathToFileURL(self).href), true);
    const link = join(mkdtempSync(join(tmpdir(), "dvara-link-")), "cli.ts");
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
    const out = t.mock.method(process.stdout, "write", () => true);
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
