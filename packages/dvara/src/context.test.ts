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

  it("reads a row only whole, from its first field, and the command after all the spaces", () => {
    const table = processTable(
      ["junk 7 1 cmd", "5 1 a b", "60 1    zsh", " 61 60 /bin/sh -c x  "].join("\n"),
    );
    assert.deepEqual(
      [...table],
      [
        [60, { parent: 1, command: "zsh" }],
        [61, { parent: 60, command: "/bin/sh -c x" }],
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
    // init's chain ends at once, so only an unreadable table makes it unknown.
    assert.equal(invocationContext("pre-push", {}, 1), "manual");
  });

  it("asks ps for each pid's parent and command", () => {
    const calls: unknown[] = [];
    const exec = (file: string, args: readonly string[]) => {
      calls.push([file, args]);
      return "30 1 bash";
    };
    assert.equal(invocationContext("pre-push", {}, 30, exec), "manual");
    assert.deepEqual(calls, [["ps", ["-axo", "pid=,ppid=,comm="]]]);
  });

  it("reads the process table unless the run is a background preflight", () => {
    const table = ps("30 20 git\n20 1 zsh");
    assert.equal(
      invocationContext("pre-push", { DVARA_BACKGROUND: "1" }, 30, table),
      "git-hook",
    );
    assert.equal(invocationContext("preflight", {}, 30, table), "git-hook");
    assert.equal(
      invocationContext("preflight", { DVARA_BACKGROUND: "0" }, 30, table),
      "git-hook",
    );
  });

  it("takes git by its whole name, with or without a folder", () => {
    assert.equal(
      invocationContext("pre-push", {}, 30, ps("30 20 git-lfs\n20 1 /usr/bin/gitk")),
      "manual",
    );
    assert.equal(
      invocationContext("pre-push", {}, 30, ps("30 20 /usr/bin/git-lfs\n20 1 legit")),
      "manual",
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
    assert.deepEqual(
      perfLevelNames("darwin", () => "Infinity"),
      [],
    );
  });

  it("asks sysctl for the count, then each level's name", () => {
    const calls: unknown[] = [];
    const answers = new Map([
      ["sysctl -n hw.nperflevels", "2\n"],
      ["sysctl -n hw.perflevel0.name", "Performance\n"],
      ["sysctl -n hw.perflevel1.name", "Efficiency\n"],
    ]);
    const sysctl = (file: string, args: readonly string[]) => {
      calls.push([file, args]);
      return answers.get([file, ...args].join(" ")) ?? "";
    };
    assert.deepEqual(perfLevelNames("darwin", sysctl), [
      "Performance",
      "Efficiency",
    ]);
    assert.deepEqual(calls, [
      ["sysctl", ["-n", "hw.nperflevels"]],
      ["sysctl", ["-n", "hw.perflevel0.name"]],
      ["sysctl", ["-n", "hw.perflevel1.name"]],
    ]);
  });

  it("reads the real sysctl by default", () => {
    assert.ok(Array.isArray(perfLevelNames(process.platform)));
  });
});
