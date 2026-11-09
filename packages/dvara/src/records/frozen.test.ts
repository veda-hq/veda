// A commit or branch that adds, changes or deletes a frozen path is refused;
// the paths kept editable pass. The git cases run in throwaway repositories,
// so what is proven is what git itself reports for a commit, a merge and a
// branch.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { FrozenPaths } from "../config.ts";
import { repo as emptyRepo, template, type Repo } from "./fixture.test.ts";
import {
  changes,
  frozen,
  isCleanMerge,
  mergedTree,
  mergeHeads,
  parseArgs,
  parseNameStatus,
  report,
  type Mode,
} from "./frozen.ts";
import { runner, type GitRun } from "./git.ts";

const CLI = resolve(import.meta.dirname, "..", "cli.ts");
const EVIDENCE = "docs/archive/0001-old/evidence/run.md";
const ARCHIVE_README = "docs/archive/README.md";
const NOTE = "docs/journal/2026-09-07-a-note.md";
const PATHS: FrozenPaths = {
  paths: ["docs/archive/", "docs/journal/"],
  except: [
    ARCHIVE_README,
    "docs/journal/README.md",
    "docs/journal/_TEMPLATE.md",
  ],
};

/** A repository with frozen files, their live entry points and some code. */
const repo = template(() => {
  const r = emptyRepo("dvara-frozen-");
  r.write(EVIDENCE, "evidence\n");
  r.write(ARCHIVE_README, "readme\n");
  r.write(NOTE, "note\n");
  r.write("docs/journal/README.md", "readme\n");
  r.write("docs/journal/_TEMPLATE.md", "template\n");
  r.write("src/a.ts", "a\n");
  r.write(".dvara.json", `${JSON.stringify({ records: { frozen: PATHS } })}\n`);
  r.commit("base");
  return r;
});

const gitOf = (r: Repo): GitRun => runner({ cwd: r.root, env: r.env });

const staged = (r: Repo, env: Record<string, string> = {}) =>
  frozen({ kind: "staged" }, gitOf(r), PATHS, env);

const range = (r: Repo, base: string, head = "HEAD") =>
  frozen({ kind: "range", base, head }, gitOf(r), PATHS);

/** A branch `side` that edits `path`, and main moved on with `src/a.ts`. */
const forked = (path: string): Repo => {
  const r = repo();
  r.git("checkout", "-q", "-b", "side");
  r.write(path, "from side\n");
  r.commit("side edits");
  r.git("checkout", "-q", "main");
  r.write("src/a.ts", "main moved\n");
  r.commit("main moves");
  return r;
};

const gitPath = (r: Repo, name: string): string =>
  r.git("rev-parse", "--path-format=absolute", "--git-path", name).trim();

describe("parseArgs", () => {
  it("takes --staged alone, or --base with HEAD as the default head", () => {
    assert.deepEqual(parseArgs(["--staged"]), { kind: "staged" });
    assert.deepEqual(parseArgs(["--base", "origin/main"]), {
      kind: "range",
      base: "origin/main",
      head: "HEAD",
    });
    assert.deepEqual(parseArgs(["--base=main", "--head", "pr"]), {
      kind: "range",
      base: "main",
      head: "pr",
    });
  });

  it("refuses anything else", () => {
    for (const args of [
      [],
      ["--staged", "--base", "main"],
      ["--staged", "--head", "pr"],
      ["--head", "pr"],
    ])
      assert.deepEqual(parseArgs(args), {
        error: "give --staged, or --base REF [--head REF]",
      });
    for (const args of [["--nope"], ["stray"], ["--base"]]) {
      const parsed = parseArgs(args);
      assert.ok("error" in parsed && parsed.error !== "", args.join(" "));
    }
  });
});

describe("parseNameStatus", () => {
  it("pairs each status with its path, a newline in a path included", () => {
    assert.deepEqual(parseNameStatus("M\0a\nb.md\0D\0c.md\0"), [
      { status: "M", path: "a\nb.md" },
      { status: "D", path: "c.md" },
    ]);
    assert.deepEqual(parseNameStatus(""), []);
  });
});

describe("report", () => {
  const staged_: Mode = { kind: "staged" };

  it("passes with nothing frozen changed", () => {
    assert.deepEqual(report(staged_, [], PATHS), {
      code: 0,
      stdout: ["✅ frozen: no frozen path changes"],
      stderr: [],
    });
  });

  it("names each file, the frozen paths and the ones still editable", () => {
    assert.deepEqual(
      report(staged_, [{ status: "M", path: EVIDENCE }], PATHS),
      {
        code: 1,
        stdout: [],
        stderr: [
          "❌ frozen: this commit changes 1 file(s) under docs/archive/, docs/journal/:",
          `     M ${EVIDENCE}`,
          "   These paths are frozen: no file there is added, changed or deleted.",
          `   Still editable: ${PATHS.except.join(", ")}.`,
          "   Unstage them (git restore --staged -- <path>), then commit again.",
        ],
      },
    );
  });

  it("says how to drop a branch change, and lists no editable paths when none are", () => {
    const out = report(
      { kind: "range", base: "origin/main", head: "HEAD" },
      [{ status: "A", path: "docs/archive/x.md" }],
      { paths: ["docs/archive/"], except: [] },
    );
    assert.deepEqual(out.stderr, [
      "❌ frozen: this branch (since origin/main) changes 1 file(s) under docs/archive/:",
      "     A docs/archive/x.md",
      "   These paths are frozen: no file there is added, changed or deleted.",
      "   Drop them from the branch: restore each path to its content at the merge base with origin/main (git restore --source=<merge base> --staged --worktree -- <path>; git merge-base names it), then commit.",
    ]);
  });
});

describe("--staged: a commit", () => {
  it("refuses an edit, an addition and a deletion under the frozen paths", () => {
    const r = repo();
    r.write(EVIDENCE, "changed\n");
    r.write("docs/archive/0002-new/spec.md", "new\n");
    r.git("rm", "-q", NOTE);
    r.git("add", "-A");
    const out = staged(r);
    assert.equal(out.code, 1);
    assert.ok(out.stderr.includes(`     M ${EVIDENCE}`));
    assert.ok(out.stderr.includes("     A docs/archive/0002-new/spec.md"));
    assert.ok(out.stderr.includes(`     D ${NOTE}`));
  });

  it("refuses both sides of a rename out of a frozen path", () => {
    const r = repo();
    r.git("mv", EVIDENCE, "docs/evidence.md");
    const out = staged(r);
    assert.equal(out.code, 1);
    assert.ok(out.stderr.includes(`     D ${EVIDENCE}`));
    assert.ok(!out.stderr.join("\n").includes("docs/evidence.md"));
  });

  it("passes the paths kept editable, and code", () => {
    const r = repo();
    for (const path of [...PATHS.except, "src/a.ts"]) r.write(path, "edited\n");
    r.git("add", "-A");
    assert.deepEqual(staged(r), {
      code: 0,
      stdout: ["✅ frozen: no frozen path changes"],
      stderr: [],
    });
  });

  it("judges the index, not the working tree", () => {
    const r = repo();
    r.write(EVIDENCE, "unstaged edit\n");
    assert.equal(staged(r).code, 0);
  });

  it("asks git nothing when no path is frozen", () => {
    const git: GitRun = () => {
      throw new Error("git was asked");
    };
    assert.deepEqual(
      frozen({ kind: "staged" }, git, { paths: [], except: [] }),
      {
        code: 0,
        stdout: ["✅ frozen: no paths are frozen"],
        stderr: [],
      },
    );
  });
});

describe("--staged: a merge commit", () => {
  it("passes a frozen file staged exactly as the merged commit has it (MERGE_HEAD)", () => {
    const r = forked(EVIDENCE);
    r.git("merge", "-q", "--no-commit", "--no-ff", "side");
    assert.deepEqual(mergeHeads(gitOf(r), {}), [
      r.git("rev-parse", "side").trim(),
    ]);
    assert.equal(staged(r).code, 0);
  });

  it("refuses a hand resolution no parent had", () => {
    const r = forked(EVIDENCE);
    r.git("merge", "-q", "--no-commit", "--no-ff", "side");
    r.write(EVIDENCE, "resolved by hand\n");
    r.git("add", "--", EVIDENCE);
    const out = staged(r);
    assert.equal(out.code, 1);
    assert.ok(out.stderr.includes(`     M ${EVIDENCE}`));
  });

  it("reads a clean merge's commits from GITHEAD_<sha>, before MERGE_HEAD exists", () => {
    const r = forked(EVIDENCE);
    const side = r.git("rev-parse", "side").trim();
    // What a clean `git merge` has staged when pre-merge-commit runs: the
    // three-way merge of the fork point, HEAD and side.
    const fork = r.git("merge-base", "HEAD", side).trim();
    r.git("read-tree", "-m", "--aggressive", fork, "HEAD", side);
    r.git("checkout-index", "-a", "-f");
    const env = { [`GITHEAD_${side}`]: "side", GITHEAD_nothex: "x", PATH: "p" };
    // No AUTO_MERGE (a strategy other than ort): git's own merge of HEAD and
    // the one named commit is exactly the index, so the commit counts.
    assert.equal(mergedTree(gitOf(r), side), r.git("write-tree").trim());
    assert.equal(isCleanMerge(gitOf(r), [side]), true);
    assert.deepEqual(mergeHeads(gitOf(r), {}), []);
    assert.deepEqual(mergeHeads(gitOf(r), env), [side]);
    assert.equal(staged(r, env).code, 0);
  });

  it("takes AUTO_MERGE for several heads, and nothing without it", () => {
    const r = forked(EVIDENCE);
    const side = r.git("rev-parse", "side").trim();
    const base = r.git("rev-parse", "HEAD~1").trim();
    r.git("read-tree", "-m", "--aggressive", base, "HEAD", side);
    assert.equal(isCleanMerge(gitOf(r), [side]), true);
    // Two named heads: no single merge to compute, so AUTO_MERGE must vouch.
    assert.equal(isCleanMerge(gitOf(r), [side, base]), false);
    assert.equal(isCleanMerge(gitOf(r), []), false);
    writeFileSync(gitPath(r, "AUTO_MERGE"), `${r.git("write-tree").trim()}\n`);
    assert.equal(isCleanMerge(gitOf(r), [side, base]), true);
    const env = { [`GITHEAD_${side}`]: "a", [`GITHEAD_${base}`]: "b" };
    assert.deepEqual(mergeHeads(gitOf(r), env), [side, base]);
  });

  it("refuses a commit that forges GITHEAD_<sha> to pass a frozen edit", () => {
    const r = forked(EVIDENCE);
    const side = r.git("rev-parse", "side").trim();
    // A plain commit staging side's frozen content plus an edit of its own,
    // naming side as a "merge" head: the index is not a merge of side.
    r.write(EVIDENCE, "from side\n");
    r.write("src/a.ts", "an edit side never made\n");
    r.git("add", "-A");
    const env = { [`GITHEAD_${side}`]: "side" };
    assert.equal(isCleanMerge(gitOf(r), [side]), false);
    assert.equal(staged(r, env).code, 1);
    // A stale or planted AUTO_MERGE the index does not match counts for nothing.
    writeFileSync(
      gitPath(r, "AUTO_MERGE"),
      `${r.git("rev-parse", "HEAD^{tree}").trim()}\n`,
    );
    assert.equal(isCleanMerge(gitOf(r), [side]), false);
    const out = staged(r, env);
    assert.equal(out.code, 1);
    assert.ok(out.stderr.includes(`     M ${EVIDENCE}`));
  });

  it("does not trust a head that conflicts with HEAD", () => {
    const r = forked(EVIDENCE);
    r.git("checkout", "-q", "-b", "clash", "HEAD~1");
    r.write("src/a.ts", "clashes with main\n");
    r.commit("clash");
    r.git("checkout", "-q", "main");
    const clash = r.git("rev-parse", "clash").trim();
    assert.equal(mergedTree(gitOf(r), clash), undefined);
    assert.equal(isCleanMerge(gitOf(r), [clash]), false);
  });

  for (const strategy of ["ort", "resolve"])
    it(`runs inside a real clean \`git merge -s ${strategy}\` hook`, () => {
      const r = forked(EVIDENCE);
      const hooks = join(r.root, ".git", "test-hooks");
      mkdirSync(hooks);
      writeFileSync(
        join(hooks, "pre-merge-commit"),
        `#!/bin/sh\nexec '${process.execPath}' '${CLI}' frozen --staged\n`,
        { mode: 0o755 },
      );
      r.git("config", "core.hooksPath", hooks);
      r.git("merge", "-q", "--no-edit", "-s", strategy, "side");
      assert.equal(
        r.git("log", "-1", "--format=%p").trim().split(" ").length,
        2,
      );
    });

  it("refuses a frozen edit in a real hook", () => {
    const r = repo();
    const hooks = join(r.root, ".git", "test-hooks");
    mkdirSync(hooks);
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\nexec '${process.execPath}' '${CLI}' frozen --staged\n`,
      { mode: 0o755 },
    );
    r.git("config", "core.hooksPath", hooks);
    r.write(EVIDENCE, "edited\n");
    r.git("add", "-A");
    assert.throws(
      () => r.git("commit", "-q", "-m", "edit"),
      /frozen: this commit/,
    );
  });

  it("lists every head of an octopus merge, once", () => {
    const r = repo();
    const first = r.git("rev-parse", "HEAD").trim();
    r.write("src/a.ts", "second\n");
    r.commit("second");
    const second = r.git("rev-parse", "HEAD").trim();
    assert.notEqual(first, second);
    const file = gitPath(r, "MERGE_HEAD");
    writeFileSync(file, `${first}\nnot-a-sha\n${second}\n${first}\n`);
    assert.deepEqual(mergeHeads(gitOf(r), { [`GITHEAD_${first}`]: "x" }), [
      first,
      second,
    ]);
    rmSync(file);
  });

  it("keeps a path only when every merged commit differs from the index there", () => {
    const one = "a".repeat(40);
    const two = "b".repeat(64);
    // Against the index: EVIDENCE matches `one`, NOTE matches neither.
    const outputs: Record<string, string> = {
      "--cached": `M\0${EVIDENCE}\0M\0${NOTE}\0`,
      [one]: `M\0${NOTE}\0`,
      [two]: `M\0${EVIDENCE}\0M\0${NOTE}\0`,
    };
    // A clean merge under way: AUTO_MERGE names `tree`, the index matches it.
    const tree = "c".repeat(40);
    const auto = join(
      mkdtempSync(join(tmpdir(), "dvara-frozen-auto-")),
      "AUTO_MERGE",
    );
    mkdirSync(dirname(auto), { recursive: true });
    writeFileSync(auto, `${tree}\n`);
    const git: GitRun = (args) => {
      if (args[0] === "rev-parse")
        return args.at(-1) === "AUTO_MERGE"
          ? auto
          : join(dirname(auto), "none");
      if (args.at(-1) === tree) return "";
      return outputs[args.at(-1) ?? ""] ?? "";
    };
    const env = { [`GITHEAD_${one}`]: "x", [`GITHEAD_${two}`]: "y" };
    const paths = (e?: Record<string, string>) =>
      changes(git, { kind: "staged" }, e).map((c) => c.path);
    assert.deepEqual(paths(env), [NOTE]);
    assert.deepEqual(paths(), [EVIDENCE, NOTE]);
  });
});

describe("--base: the branch check", () => {
  it("refuses a branch whose commits edit a frozen file, from any commit", () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "pr");
    r.write(EVIDENCE, "planted\n");
    r.commit("plant");
    r.write("src/a.ts", "later\n");
    r.commit("later");
    const out = range(r, "main");
    assert.equal(out.code, 1);
    assert.ok(out.stderr.includes(`     M ${EVIDENCE}`));
  });

  it("refuses a frozen edit a merge brings in from another branch", () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "other");
    r.write(NOTE, "edited off the hook\n");
    r.commit("other edits a note");
    r.git("checkout", "-q", "-b", "pr", "main");
    r.write("src/a.ts", "pr\n");
    r.commit("pr work");
    r.git("merge", "-q", "--no-ff", "--no-edit", "other");
    const out = range(r, "main");
    assert.equal(out.code, 1);
    assert.ok(out.stderr.includes(`     M ${NOTE}`));
  });

  it("ignores what the base did after the branch forked", () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "pr");
    r.write(ARCHIVE_README, "pr edit\n");
    r.commit("readme");
    r.git("checkout", "-q", "main");
    r.write(EVIDENCE, "an edit on main\n");
    r.commit("main");
    assert.equal(range(r, "main", "pr").code, 0);
  });

  it("throws when git cannot diff a missing base", () => {
    const r = repo();
    assert.throws(() => range(r, "nope"), /nope/);
  });
});
