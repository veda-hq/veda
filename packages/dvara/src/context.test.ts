import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hookKind,
  invocationContext,
  perfLevelNames,
  processTable,
} from "./context.ts";

describe("hookKind", () => {
  it("calls a pre-push in preflight mode without a remote a preflight", () => {
    assert.equal(
      hookKind("pre-push", [], { DVARA_MODE: "preflight" }),
      "preflight",
    );
    assert.equal(
      hookKind("pre-push", ["origin", "url"], { DVARA_MODE: "preflight" }),
      "pre-push",
    );
    assert.equal(hookKind("pre-push", [], {}), "pre-push");
    assert.equal(
      hookKind("pre-commit", [], { DVARA_MODE: "preflight" }),
      "pre-commit",
    );
  });
});

describe("processTable", () => {
  it("maps each pid to its parent and command, dropping rows that are no process", () => {
    const table = processTable(
      [
        "  1     0 launchd",
        " 50     1 /usr/bin/git",
        "junk",
        `${"9".repeat(400)} 1 big`,
        "",
      ].join("\n"),
    );
    assert.deepEqual(
      [...table],
      [
        [1, { parent: 0, command: "launchd" }],
        [50, { parent: 1, command: "/usr/bin/git" }],
      ],
    );
  });
});

describe("invocationContext", () => {
  const ps = (rows: string) => () => rows;

  it("takes a benchmark and a background preflight from the environment", () => {
    const never = () => {
      throw new Error("not called");
    };
    assert.equal(
      invocationContext(
        "pre-push",
        { DVARA_MEASUREMENT_CONTEXT: "manual-benchmark" },
        9,
        never,
      ),
      "manual-benchmark",
    );
    assert.equal(
      invocationContext("preflight", { DVARA_BACKGROUND: "1" }, 9, never),
      "background",
    );
  });

  it("finds git in the parent chain", () => {
    assert.equal(
      invocationContext(
        "pre-push",
        {},
        30,
        ps("30 20 bash\n20 10 /opt/bin/git\n10 1 zsh"),
      ),
      "git-hook",
    );
  });

  it("calls a chain ending at init manual, and any other end unknown", () => {
    assert.equal(
      invocationContext("pre-push", {}, 30, ps("30 20 bash\n20 1 zsh")),
      "manual",
    );
    assert.equal(
      invocationContext("pre-push", {}, 30, ps("30 20 bash")),
      "unknown",
    );
    assert.equal(
      invocationContext("pre-push", {}, 30, ps("30 31 bash\n31 30 bash")),
      "unknown",
    );
  });

  it("calls an unreadable process table unknown", () => {
    const broken = () => {
      throw new Error("ps failed");
    };
    assert.equal(invocationContext("pre-push", {}, 30, broken), "unknown");
  });

  it("reads the real process table by default", () => {
    assert.match(
      invocationContext("pre-push", {}, process.pid),
      /^(git-hook|manual|unknown)$/,
    );
  });
});

describe("perfLevelNames", () => {
  it("names the performance levels on macOS only", () => {
    const sysctl = (_file: string, args: readonly string[]) =>
      args[1] === "hw.nperflevels"
        ? "2\n"
        : args[1] === "hw.perflevel0.name"
          ? "Performance\n"
          : "Efficiency\n";
    assert.deepEqual(perfLevelNames("darwin", sysctl), [
      "Performance",
      "Efficiency",
    ]);
    assert.deepEqual(perfLevelNames("linux", sysctl), []);
  });

  it("names none when sysctl fails or answers junk", () => {
    const broken = () => {
      throw new Error("no sysctl");
    };
    assert.deepEqual(perfLevelNames("darwin", broken), []);
    assert.deepEqual(
      perfLevelNames("darwin", () => "junk"),
      [],
    );
  });

  it("reads the real sysctl by default", () => {
    assert.ok(Array.isArray(perfLevelNames(process.platform)));
  });
});
