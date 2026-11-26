import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { run } from "./cli.ts";
import { repo } from "./records/fixture.test.ts";
import { parseArgs, sizeOf, warning } from "./review-size.ts";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    out,
    err,
  };
};

describe("parseArgs", () => {
  it("takes a cap, any number of ignore globs and a base", () => {
    assert.deepEqual(
      parseArgs(["--cap", "50000", "--ignore", "**/*.lock", "--ignore", "docs/**", "--base", "origin/main"]),
      { cap: 50000, ignore: ["**/*.lock", "docs/**"], base: "origin/main" },
    );
    assert.deepEqual(parseArgs(["--cap", "10"]), { cap: 10, ignore: [], base: null });
  });

  it("refuses a missing or bad cap, a missing value and an unknown flag", () => {
    assert.deepEqual(parseArgs([]), { error: "give --cap" });
    for (const cap of ["0", "-5", "1e3", "ten", "07"])
      assert.deepEqual(parseArgs(["--cap", cap]), {
        error: "--cap takes a positive whole number of lines",
      });
    assert.deepEqual(parseArgs(["--cap"]), { error: "--cap takes a value" });
    assert.deepEqual(parseArgs(["--cap", "5", "--ignore", ""]), {
      error: "--ignore takes a value",
    });
    assert.deepEqual(parseArgs(["--cap", "5", "--all"]), {
      error: "unknown argument --all",
    });
  });
});

describe("sizeOf", () => {
  it("adds and deletes count, binaries count nothing, ignored paths are left out", () => {
    const numstat = [
      "10\t5\tsrc/a.ts",
      "100\t0\tpnpm-lock.yaml",
      "-\t-\tassets/logo.png",
      "3\t3\tdocs/guide.md",
      // A rename: counted under its new path.
      "2\t1\t",
      "src/old.ts",
      "src/new.ts",
      "",
    ].join("\0");
    assert.deepEqual(sizeOf(numstat, ["pnpm-lock.yaml", "docs/**"]), {
      lines: 18,
      files: [
        { path: "src/a.ts", lines: 15 },
        { path: "src/new.ts", lines: 3 },
        { path: "assets/logo.png", lines: 0 },
      ],
    });
    assert.deepEqual(sizeOf("", []), { lines: 0, files: [] });
  });

  it("reads an entry cut short as a rename's counts", () => {
    // No tab: the added count alone, and the two fields after it are the paths.
    assert.deepEqual(sizeOf(["7", "old.ts", "new.ts", ""].join("\0"), []), {
      lines: 7,
      files: [{ path: "new.ts", lines: 7 }],
    });
    // One tab: the added count alone, and then a rename.
    assert.deepEqual(sizeOf(["4\t", "old.ts", "new.ts", ""].join("\0"), []), {
      lines: 4,
      files: [{ path: "new.ts", lines: 4 }],
    });
    // A rename with its new path missing is counted under no path.
    assert.deepEqual(sizeOf(["2\t1\t", "old.ts"].join("\0"), []), {
      lines: 3,
      files: [{ path: "", lines: 3 }],
    });
  });

  it("orders files of one size by path", () => {
    const numstat = ["1\t0\tb.ts", "1\t0\ta.ts", ""].join("\0");
    assert.deepEqual(
      sizeOf(numstat, []).files.map((file) => file.path),
      ["a.ts", "b.ts"],
    );
  });
});

describe("warning", () => {
  it("says nothing at or under the cap", () => {
    assert.deepEqual(warning({ lines: 50, files: [] }, 50, "origin/main"), []);
  });

  it("names the size, the cap, the base and the five largest files", () => {
    const files = [7, 6, 5, 4, 3, 2].map((lines, i) => ({ path: `f${String(i)}.ts`, lines }));
    const lines = warning({ lines: 27, files }, 20, "origin/main");
    assert.equal(
      lines[0],
      "⚠ review-size: this branch changes 27 lines against origin/main outside the reviewer's ignore globs, over its cap of 20: the reviewer will skip the pull request, and a merge rule that needs its pass can never be met.",
    );
    assert.match(lines[1] ?? "", /^ {2}Split it before the pull request opens, by workspace/);
    assert.deepEqual(lines.slice(2), ["    7 f0.ts", "    6 f1.ts", "    5 f2.ts", "    4 f3.ts", "    3 f4.ts"]);
  });
});

describe("dvara review-size", () => {
  /** A repository with a `main` base and a branch adding `lines` lines to src/ and docs/. */
  const branched = (lines: number) => {
    const r = repo("dvara-review-size-");
    r.write("README.md", "hi\n");
    r.commit("init");
    r.git("branch", "base");
    r.git("switch", "-q", "-c", "work");
    r.write("src/big.ts", "x\n".repeat(lines));
    r.write("docs/big.md", "y\n".repeat(lines));
    r.commit("grow");
    return r;
  };

  it("warns over the cap and is quiet under it, against --base", async () => {
    const r = branched(30);
    try {
      const over = capture();
      assert.equal(
        await run(["review-size", "--cap", "50", "--base", "base"], { io: over.io, cwd: r.root, env: r.env }),
        0,
      );
      assert.match(over.err[0] ?? "", /^⚠ review-size: this branch changes 60 lines against base/);
      const ignored = capture();
      assert.equal(
        await run(["review-size", "--cap", "50", "--base", "base", "--ignore", "docs/**"], {
          io: ignored.io,
          cwd: r.root,
          env: r.env,
        }),
        0,
      );
      assert.deepEqual(ignored.err, []);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  it("judges against the first base ref the config lists that resolves", async () => {
    const r = branched(30);
    try {
      writeFileSync(join(r.root, ".dvara.json"), JSON.stringify({ baseRefs: ["origin/main", "base"] }));
      const { io, err } = capture();
      assert.equal(await run(["review-size", "--cap", "10"], { io, cwd: r.root, env: r.env }), 0);
      assert.match(err[0] ?? "", /^⚠ review-size: this branch changes 60 lines against base /);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  it("passes, saying so, when no base resolves or git cannot answer", async () => {
    const r = branched(1);
    try {
      const none = capture();
      assert.equal(await run(["review-size", "--cap", "10"], { io: none.io, cwd: r.root, env: r.env }), 0);
      assert.deepEqual(none.err, [
        "⚠ review-size: no base ref resolves, so the branch's size was not checked.",
      ]);
      const missing = capture();
      assert.equal(
        await run(["review-size", "--cap", "10", "--base", "nope"], { io: missing.io, cwd: r.root, env: r.env }),
        0,
      );
      assert.match(missing.err[0] ?? "", /^⚠ review-size: not checked: /);
      rmSync(join(r.root, ".git"), { recursive: true, force: true });
      const broken = capture();
      assert.equal(
        await run(["review-size", "--cap", "10"], {
          io: broken.io,
          cwd: r.root,
          env: { ...r.env, GIT_CEILING_DIRECTORIES: dirname(r.root) },
        }),
        0,
      );
      assert.match(broken.err[0] ?? "", /^⚠ review-size: not checked: /);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  it("exits 2 on bad arguments", async () => {
    const { io, err } = capture();
    assert.equal(await run(["review-size", "--cap", "x"], { io, cwd: "/", env: {} }), 2);
    assert.deepEqual(err, [
      "dvara review-size: --cap takes a positive whole number of lines",
      "usage: dvara review-size --cap N [--ignore GLOB]… [--base REF]",
    ]);
  });
});
