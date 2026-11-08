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
