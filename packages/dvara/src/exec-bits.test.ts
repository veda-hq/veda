import assert from "node:assert/strict";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { run } from "./cli.ts";
import {
  ADVICE,
  droppedBits,
  parseArgs,
  report,
  stagedDroppedBits,
} from "./exec-bits.ts";
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

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("droppedBits", () => {
  it("finds a 100755 → 100644 change whose blob is the same", () => {
    const raw = [
      `:100755 100644 ${A} ${A} M`,
      "bin/run.sh",
      // Content changed too: an edit, not a dropped bit.
      `:100755 100644 ${A} ${B} M`,
      "bin/edited.sh",
      // The bit added, or kept.
      `:100644 100755 ${A} ${A} M`,
      "bin/new-exec.sh",
      `:100755 100755 ${A} ${B} M`,
      "bin/kept.sh",
      // An added or deleted file is not a mode change.
      `:000000 100644 ${"0".repeat(40)} ${A} A`,
      "added.txt",
      `:100755 000000 ${A} ${"0".repeat(40)} D`,
      "gone.sh",
      // A path with a space, a symlink turned into a file.
      `:100755 100644 ${B} ${B} M`,
      "tools/with space.sh",
      `:120000 100644 ${A} ${A} T`,
      "link",
      "",
    ].join("\0");
    assert.deepEqual(droppedBits(raw), [
      { path: "bin/run.sh" },
      { path: "tools/with space.sh" },
    ]);
  });

  it("reads nothing from an empty diff", () => {
    assert.deepEqual(droppedBits(""), []);
  });

  it("reads no entry from a header with no path after it", () => {
    assert.deepEqual(droppedBits(`:100755 100644 ${A} ${A} M`), []);
  });

  it("drops only the bit of a modified file, from 100755 to 100644", () => {
    const raw = [
      `:100755 100644 ${A} ${A} T`,
      "typechange",
      `:100644 100644 ${A} ${A} M`,
      "plain",
      `:100755 100755 ${A} ${A} M`,
      "kept",
      // Only a leading colon is the header's: this one ends the status.
      `100755 100644 ${A} ${A} M:`,
      "colon-last",
      `:100755 100644 ${A} ${A} M`,
      "dropped",
      "",
    ].join("\0");
    assert.deepEqual(droppedBits(raw), [{ path: "dropped" }]);
  });
});

describe("stagedDroppedBits", () => {
  it("runs git in the environment it is given, and says why git failed", () => {
    const r = repo("dvara-exec-bits-");
    try {
      // Only the given environment names this index; the repository's own is fine.
      const index = join(r.root, "corrupt-index");
      writeFileSync(index, "not an index, but long enough to have a header\n");
      assert.deepEqual(
        stagedDroppedBits({ cwd: r.root, env: { ...r.env, GIT_INDEX_FILE: index } }),
        {
          error:
            "git diff failed (128): error: bad signature 0x20746f6e\nfatal: index file corrupt",
        },
      );
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});

describe("report", () => {
  it("warns by default and refuses with refuse, each path indented", () => {
    const dropped = [{ path: "a.sh" }, { path: "b/c.sh" }];
    assert.deepEqual(report(dropped, false), [
      "⚠ exec-bits: 2 staged file(s) lose the executable bit (100755 → 100644) with no change to their content:",
      "  a.sh",
      "  b/c.sh",
      `  ${ADVICE}`,
    ]);
    assert.equal(
      report(dropped, true)[0],
      "❌ exec-bits: 2 staged file(s) lose the executable bit (100755 → 100644) with no change to their content:",
    );
  });

  it("ends with the advice, word for word", () => {
    assert.equal(
      report([], false).at(-1),
      "  The content is unchanged, so this is a tool dropping the bit (Stryker's in-place restore does), not an edit. Put it back with `git update-index --chmod=+x <path>` (and `chmod +x <path>`).",
    );
  });
});

describe("parseArgs", () => {
  it("needs --staged and takes --refuse", () => {
    assert.deepEqual(parseArgs(["--staged"]), { refuse: false });
    assert.deepEqual(parseArgs(["--refuse", "--staged"]), { refuse: true });
    assert.deepEqual(parseArgs([]), { error: "give --staged" });
    assert.deepEqual(parseArgs(["--staged", "--all"]), {
      error: "unknown argument --all",
    });
  });
});

describe("dvara exec-bits", () => {
  /** A repository with an executable script committed, and a plain file. */
  const scripted = () => {
    const r = repo("dvara-exec-bits-");
    r.write("run.sh", "#!/bin/sh\necho hi\n");
    r.write("notes.txt", "notes\n");
    chmodSync(join(r.root, "run.sh"), 0o755);
    r.commit("init");
    return r;
  };

  it("passes an index with no dropped bit", async () => {
    const r = scripted();
    try {
      r.write("notes.txt", "more notes\n");
      r.git("add", "-A");
      const { io, out, err } = capture();
      assert.equal(await run(["exec-bits", "--staged"], { io, cwd: r.root, env: r.env }), 0);
      assert.deepEqual([out, err], [[], []]);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  it("warns on a dropped bit, and refuses it with --refuse", async () => {
    const r = scripted();
    try {
      chmodSync(join(r.root, "run.sh"), 0o644);
      r.git("add", "-A");
      const warned = capture();
      assert.equal(
        await run(["exec-bits", "--staged"], { io: warned.io, cwd: r.root, env: r.env }),
        0,
      );
      assert.deepEqual(warned.err.slice(0, 2), [
        "⚠ exec-bits: 1 staged file(s) lose the executable bit (100755 → 100644) with no change to their content:",
        "  run.sh",
      ]);
      const refused = capture();
      assert.equal(
        await run(["exec-bits", "--staged", "--refuse"], {
          io: refused.io,
          cwd: r.root,
          env: r.env,
        }),
        1,
      );
      assert.match(refused.err[0] ?? "", /^❌ exec-bits: 1 staged file/);
      // Putting the bit back, as the advice says, passes.
      r.git("update-index", "--chmod=+x", "run.sh");
      const fixed = capture();
      assert.equal(
        await run(["exec-bits", "--staged", "--refuse"], { io: fixed.io, cwd: r.root, env: r.env }),
        0,
      );
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  it("leaves a dropped bit that also changed the content alone", async () => {
    const r = scripted();
    try {
      r.write("run.sh", "#!/bin/sh\necho bye\n");
      chmodSync(join(r.root, "run.sh"), 0o644);
      r.git("add", "-A");
      const { io, err } = capture();
      assert.equal(await run(["exec-bits", "--staged", "--refuse"], { io, cwd: r.root, env: r.env }), 0);
      assert.deepEqual(err, []);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  it("exits 2 on bad arguments and when git cannot answer", async () => {
    const bad = capture();
    assert.equal(await run(["exec-bits"], { io: bad.io, cwd: "/", env: {} }), 2);
    assert.deepEqual(bad.err, [
      "dvara exec-bits: give --staged",
      "usage: dvara exec-bits --staged [--refuse]",
    ]);
    const r = repo("dvara-exec-bits-");
    try {
      rmSync(join(r.root, ".git"), { recursive: true, force: true });
      const broken = capture();
      assert.equal(
        await run(["exec-bits", "--staged"], {
          io: broken.io,
          cwd: r.root,
          env: { ...r.env, GIT_CEILING_DIRECTORIES: dirname(r.root) },
        }),
        2,
      );
      assert.match(broken.err[0] ?? "", /^dvara exec-bits: /);
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});
