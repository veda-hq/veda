import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { hermeticEnv, repo, type Repo } from "./fixture.test.ts";
import {
  batchObjectSize,
  git,
  isShallow,
  listedIn,
  listModes,
  listTree,
  mergeBase,
  noQuestions,
  OBJECT_BUFFER,
  objectName,
  objectTypes,
  readBlobs,
  recordingContext,
  resolveRef,
  runner,
  treeContext,
  treeLists,
  tryGit,
  unreachable,
  UnreadableObject,
  type Git,
} from "./git.ts";

/** A repository with one commit holding `a.md` and `docs/b.md`. */
const committed = (): { r: Repo; at: Git } => {
  const r = repo();
  r.write("a.md", "alpha\n");
  r.write("docs/b.md", "beta\n");
  r.commit("first");
  return { r, at: { cwd: r.root, env: r.env } };
};

/**
 * `first` then `head` on main; `merged` on a branch origin/main points at,
 * never merged into main; `side` on a local branch nothing else reaches.
 */
const histories = () => {
  const { r, at } = committed();
  const first = r.git("rev-parse", "HEAD").trim();
  r.write("a.md", "second\n");
  r.commit("second");
  const head = r.git("rev-parse", "HEAD").trim();
  r.git("checkout", "-q", "-b", "upstream", first);
  r.write("u.md", "upstream\n");
  r.commit("upstream");
  const merged = r.git("rev-parse", "HEAD").trim();
  r.git("update-ref", "refs/remotes/origin/main", merged);
  r.git("checkout", "-q", "-b", "side", first);
  r.write("s.md", "side\n");
  r.commit("side");
  const side = r.git("rev-parse", "HEAD").trim();
  r.git("checkout", "-q", "main");
  r.git("branch", "-q", "-D", "upstream");
  return { r, at, first, head, merged, side };
};

/** A 4-hex prefix two blobs written to the store share. */
const ambiguousPrefix = (at: Git): string => {
  const seen = new Map<string, string>();
  for (let i = 0; ; i += 1) {
    const text = `ambiguous ${i}\n`;
    const oid = createHash("sha1")
      .update(`blob ${Buffer.byteLength(text)}\0${text}`)
      .digest("hex");
    const prefix = oid.slice(0, 4);
    const other = seen.get(prefix);
    if (other !== undefined) {
      for (const input of [other, text])
        git(at, ["hash-object", "-w", "--stdin"], input);
      return prefix;
    }
    seen.set(prefix, text);
  }
};

describe("batchObjectSize", () => {
  it("reads the size field of a header", () => {
    assert.equal(batchObjectSize("abc blob 12"), 12);
    assert.equal(batchObjectSize("abc blob 0"), 0);
  });

  it("throws on any other header", () => {
    for (const header of [
      "abc blob",
      "abc blob -1",
      "abc blob 1.5",
      "abc blob x",
    ])
      assert.throws(() => batchObjectSize(header), /unexpected header/, header);
  });
});

describe("git and tryGit", () => {
  it("returns output as text, and through a runner", () => {
    const { at } = committed();
    assert.equal(git(at, ["rev-parse", "--is-inside-work-tree"]), "true\n");
    assert.equal(runner(at)(["rev-parse", "--is-inside-work-tree"]), "true\n");
    // Without an env of its own it runs in this process's.
    assert.match(git({ cwd: at.cwd }, ["--version"]), /^git version/);
  });

  it("reads exit 1 as no and throws any other failure", () => {
    const { at } = committed();
    assert.equal(
      tryGit(at, ["rev-parse", "--verify", "--quiet", "nope"]),
      null,
    );
    assert.throws(
      () => tryGit(at, ["cat-file", "-t", "nope"]),
      /git cat-file failed \(128\): fatal: /,
    );
    // A git that could not start, asked nothing.
    assert.throws(
      () => tryGit({ cwd: at.cwd, env: { PATH: "" } }, []),
      /^Error: git  failed \(Error: spawnSync git ENOENT\)/,
    );
  });
});

describe("trees", () => {
  it("lists the index or a commit, every path whole", () => {
    const { r, at } = committed();
    r.write("two\nlines.md", "x\n");
    r.git("add", "-A");
    assert.deepEqual(listTree(at, "HEAD"), ["a.md", "docs/b.md"]);
    assert.deepEqual(listTree(at, ":"), ["a.md", "docs/b.md", "two\nlines.md"]);
  });

  it("lists each path's mode, and tells a symlink or a submodule from a file", () => {
    const { r, at } = committed();
    symlinkSync("a.md", join(r.root, "link.md"));
    r.write("two\nlines.md", "x\n");
    r.git("add", "-A");
    const sub = "0123456789abcdef0123456789abcdef01234567";
    r.git("update-index", "--add", "--cacheinfo", `160000,${sub},vendor/lib`);
    const expected = new Map([
      ["a.md", "100644"],
      ["docs/b.md", "100644"],
      ["link.md", "120000"],
      ["two\nlines.md", "100644"],
      ["vendor/lib", "160000"],
    ]);
    assert.deepEqual(listModes(at, ":"), expected);
    r.git("commit", "-q", "-m", "links");
    assert.deepEqual(listModes(at, "HEAD"), expected);
    for (const ref of [":", "HEAD"]) {
      const tree = treeContext(at, ref, undefined);
      assert.deepEqual(
        ["a.md", "link.md", "vendor/lib", "none.md"].map(tree.isLink),
        [false, true, true, false],
        ref,
      );
    }
  });

  it("reads a blob above 64 MiB asked on its own, as the batch would", () => {
    const { r, at } = committed();
    const big = `${"x".repeat(65 * 1024 * 1024)}\n`;
    r.write("big\nname.txt", big);
    r.git("add", "-A");
    assert.equal(OBJECT_BUFFER, 1024 * 1024 * 1024);
    assert.equal(
      readBlobs(at, [":big\nname.txt"]).get(":big\nname.txt")?.length,
      big.length,
    );
  });

  it("asks a tree which paths it lists, from the root", () => {
    const { at } = committed();
    assert.deepEqual(listedIn(at, "HEAD", []), new Set());
    assert.deepEqual(
      listedIn({ ...at, cwd: `${at.cwd}/docs` }, "HEAD", ["a.md", "z.md"]),
      new Set(["a.md"]),
    );
    assert.equal(treeLists(at, "HEAD", "docs/b.md"), true);
    assert.equal(treeLists(at, "HEAD", "docs"), true);
    assert.equal(treeLists(at, "HEAD", "c.md"), false);
  });

  it("names an object in the index or a commit", () => {
    assert.equal(objectName(":", "a.md"), ":a.md");
    assert.equal(objectName("HEAD", "a.md"), "HEAD:a.md");
  });

  it("names the object it could not read", () => {
    const error = new UnreadableObject("HEAD:a.md");
    assert.equal(error.object, "HEAD:a.md");
    assert.equal(
      error.message,
      "HEAD:a.md is listed but its object cannot be read",
    );
  });
});

describe("readBlobs and objectTypes", () => {
  it("reads many blobs in one batch, a newline-bearing name on its own", () => {
    const { r, at } = committed();
    const big = "x".repeat(200_000);
    r.write("big.md", big);
    r.write("two\nlines.md", "two\n");
    r.git("add", "-A");
    const blobs = readBlobs(at, [
      ":a.md",
      ":big.md",
      ":two\nlines.md",
      ":none\nhere.md",
      ":missing.md",
    ]);
    assert.deepEqual(
      [...blobs],
      [
        [":two\nlines.md", "two\n"],
        [":none\nhere.md", null],
        [":a.md", "alpha\n"],
        [":big.md", big],
        [":missing.md", null],
      ],
    );
    assert.deepEqual(
      [...readBlobs(at, [":two\nlines.md"])],
      [[":two\nlines.md", "two\n"]],
    );
    assert.deepEqual(readBlobs(at, []), new Map());
  });

  it("maps an ambiguous name to null, and types neither it nor an empty one", () => {
    const { at } = committed();
    const prefix = ambiguousPrefix(at);
    assert.deepEqual(
      [...readBlobs(at, [prefix, "HEAD:a.md"])],
      [
        [prefix, null],
        ["HEAD:a.md", "alpha\n"],
      ],
    );
    assert.deepEqual(
      [...objectTypes(at, [prefix, "", "HEAD:a.md"])],
      [["HEAD:a.md", "blob"]],
    );
  });

  it("throws when the batch cannot run", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "dvara-no-repo-"));
    assert.throws(
      () => readBlobs({ cwd: elsewhere, env: hermeticEnv }, ["HEAD:a.md"]),
      /git cat-file --batch failed: .*not a git repository/,
    );
  });

  it("types every name the store has, a newline-bearing one on its own", () => {
    const { r, at } = committed();
    r.write("two\nlines.md", "two\n");
    r.git("add", "-A");
    const head = r.git("rev-parse", "HEAD").trim();
    const types = objectTypes(at, [
      head,
      "HEAD:a.md",
      "HEAD:docs",
      ":two\nlines.md",
      ":none\nhere.md",
      "0123456789abcdef0123456789abcdef01234567",
    ]);
    assert.deepEqual(
      [...types],
      [
        [":two\nlines.md", "blob"],
        [head, "commit"],
        ["HEAD:a.md", "blob"],
        ["HEAD:docs", "tree"],
      ],
    );
    assert.deepEqual(
      [...objectTypes(at, [":two\nlines.md"])],
      [[":two\nlines.md", "blob"]],
    );
  });
});

describe("refs", () => {
  it("finds the merge base, or null for unrelated histories", () => {
    const { r, at } = committed();
    const first = r.git("rev-parse", "HEAD").trim();
    r.git("checkout", "-q", "-b", "side");
    r.write("c.md", "c\n");
    r.commit("side");
    assert.equal(mergeBase(at, "side", "main"), first);
    r.git("checkout", "-q", "--orphan", "lone");
    r.commit("lone");
    assert.equal(mergeBase(at, "lone", "main"), null);
    // Against a merge of several: what side shares with any of them.
    assert.equal(mergeBase(at, "side", "lone", "main"), first);
    assert.throws(
      () => mergeBase(at, "no-such-ref", "HEAD"),
      /git merge-base failed/,
    );
  });

  it("resolves a ref to its commit, or null", () => {
    const { r, at } = committed();
    assert.equal(resolveRef(at, "main"), r.git("rev-parse", "HEAD").trim());
    assert.equal(resolveRef(at, "no-such-ref"), null);
  });
});

describe("recordingContext", () => {
  it("records each question and answers without git", () => {
    const asked = noQuestions();
    const context = recordingContext({ base: "abc" }, asked);
    assert.deepEqual(
      [...context.typesOf(["s1", "s2"])],
      [
        ["s1", "commit"],
        ["s2", "commit"],
      ],
    );
    assert.equal(context.baseText("a.md"), null);
    assert.equal(context.onHistory(["s1"]), null);
    assert.deepEqual([...asked.shas], ["s1", "s2"]);
    assert.deepEqual([...asked.bases], ["a.md"]);
    assert.deepEqual([...asked.history], ["s1"]);
  });

  it("answers the base text itself when there is no base commit", () => {
    for (const base of [null, undefined]) {
      const asked = noQuestions();
      assert.equal(recordingContext({ base }, asked).baseText("a.md"), base);
      assert.deepEqual([...asked.bases], []);
    }
  });
});

describe("treeContext", () => {
  it("reads the tree at a commit, or the index for ':'", () => {
    const { r, at } = committed();
    r.write("a.md", "staged\n");
    r.git("add", "-A");
    const head = treeContext(at, "HEAD", undefined);
    assert.equal(head.read("a.md"), "alpha\n");
    assert.equal(head.read("a.md"), "alpha\n");
    assert.equal(head.read("none.md"), null);
    assert.equal(head.pathExists("docs/b.md"), true);
    assert.equal(head.pathExists("none.md"), false);
    assert.equal(treeContext(at, ":", undefined).read("a.md"), "staged\n");
  });

  it("throws for a listed path whose object is gone", () => {
    const { r, at } = committed();
    r.breakObject("HEAD:a.md");
    assert.throws(
      () => treeContext(at, "HEAD", undefined).read("a.md"),
      UnreadableObject,
    );
  });

  it("answers the base text: none without a branch, null when added", () => {
    const { at } = committed();
    assert.equal(
      treeContext(at, "HEAD", undefined).baseText("a.md"),
      undefined,
    );
    assert.equal(treeContext(at, "HEAD", null).baseText("a.md"), null);
  });

  it("reads base texts under the base-side path, once", () => {
    const { r, at } = committed();
    const base = r.git("rev-parse", "HEAD").trim();
    r.git("mv", "a.md", "moved.md");
    r.write("new.md", "new\n");
    r.commit("rename");
    const asked: string[] = [];
    const tree = treeContext(at, "HEAD", base, (path) => {
      asked.push(path);
      return path === "moved.md" ? "a.md" : undefined;
    });
    assert.equal(tree.baseText("docs/b.md"), "beta\n");
    assert.equal(tree.baseText("moved.md"), "alpha\n");
    assert.equal(tree.baseText("new.md"), null);
    assert.equal(tree.baseText("moved.md"), "alpha\n");
    assert.deepEqual(asked, ["moved.md", "new.md"]);
  });

  it("throws for a base path, or a rename source, whose object is gone", () => {
    const { r, at } = committed();
    const base = r.git("rev-parse", "HEAD").trim();
    r.breakObject("HEAD:a.md");
    assert.throws(() => treeContext(at, "HEAD", base).baseText("a.md"), {
      message: `${base}:a.md is listed but its object cannot be read`,
    });
    assert.throws(
      () => treeContext(at, "HEAD", base, () => "a.md").baseText("moved.md"),
      { message: `${base}:a.md is listed but its object cannot be read` },
    );
  });

  it("types the ids the store has, asking git once per id", () => {
    const { r, at } = committed();
    const head = r.git("rev-parse", "HEAD").trim();
    const blob = r.git("rev-parse", "HEAD:a.md").trim();
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const tree = treeContext(at, "HEAD", undefined);
    assert.deepEqual(
      [...tree.typesOf([head, blob, missing, head])],
      [
        [head, "commit"],
        [blob, "blob"],
      ],
    );
    assert.deepEqual([...tree.typesOf([])], []);
  });

  it("judges where commits stand against HEAD and the base refs that resolve", () => {
    const { r, at, first, head, merged, side } = histories();
    const blob = r.git("rev-parse", "HEAD:a.md").trim();
    const tree = treeContext(at, "HEAD", undefined, undefined, [
      "origin/missing",
      "origin/main",
      "origin/main",
    ]);
    // A blob or a missing id is no commit: it is not sent to rev-list.
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const history = tree.onHistory([first, head, merged, side, blob, missing]);
    assert.deepEqual(history, {
      unreached: new Set([side]),
      refs: ["origin/main"],
    });
    // Asked again, from what it knows.
    assert.deepEqual(tree.onHistory([side, head]), history);
    // With no base refs, only HEAD's history counts.
    assert.deepEqual(treeContext(at, "HEAD", undefined).onHistory([merged]), {
      unreached: new Set([merged]),
      refs: [],
    });
  });

  it("counts a staged merge's other parent as the new commit's history", () => {
    const { r, at, side } = histories();
    writeFileSync(join(r.root, ".git", "MERGE_HEAD"), `${side}\n`);
    assert.deepEqual(treeContext(at, ":", undefined).onHistory([side]), {
      unreached: new Set(),
      refs: [],
    });
    // A commit's tree has no merge in progress.
    assert.deepEqual(
      [
        ...(treeContext(at, "HEAD", undefined).onHistory([side])?.unreached ??
          []),
      ],
      [side],
    );
  });

  it("judges nothing in a shallow clone, whose walk stops at its cut", () => {
    const { r } = histories();
    const clone = mkdtempSync(join(tmpdir(), "dvara-shallow-"));
    r.git("clone", "-q", "--depth", "1", pathToFileURL(r.root).href, clone);
    const at = { cwd: clone, env: r.env };
    const tip = git(at, ["rev-parse", "HEAD"]).trim();
    assert.equal(isShallow(at), true);
    assert.equal(treeContext(at, "HEAD", undefined).onHistory([tip]), null);
    assert.equal(isShallow({ cwd: r.root, env: r.env }), false);
  });

  it("answers warmed questions in batches", () => {
    const { r, at } = committed();
    const base = r.git("rev-parse", "HEAD").trim();
    const asked = noQuestions();
    asked.shas.add(base);
    asked.bases.add("a.md");
    const tree = treeContext(at, "HEAD", base);
    tree.warm(asked);
    // Answered from the cache: a broken store no longer matters.
    r.breakObject("HEAD:a.md");
    assert.equal(tree.baseText("a.md"), "alpha\n");
    assert.deepEqual([...tree.typesOf([base])], [[base, "commit"]]);
    // With no base commit, only the ids are asked.
    treeContext(at, "HEAD", null).warm(asked);
  });

  it("warms history for the commits among the ids asked", () => {
    const { r, at, head, side } = histories();
    const blob = r.git("rev-parse", "HEAD:a.md").trim();
    const asked = noQuestions();
    for (const id of [head, side, blob]) {
      asked.shas.add(id);
      asked.history.add(id);
    }
    const tree = treeContext(at, "HEAD", undefined);
    tree.warm(asked);
    // Answered from the cache: the side branch's commit is gone from git's view.
    r.git("branch", "-q", "-D", "side");
    r.git("reflog", "expire", "--expire=now", "--all");
    r.git("gc", "-q", "--prune=now");
    assert.deepEqual(tree.onHistory([head, side])?.unreached, new Set([side]));
  });
});

describe("unreachable", () => {
  it("lists the commits no tip reaches, a tip itself reached", () => {
    const { at, first, head, merged, side } = histories();
    assert.deepEqual(
      unreachable(at, [first, head, merged, side], [head, merged]),
      new Set([side]),
    );
    assert.deepEqual(
      unreachable(at, [first, side], []),
      new Set([first, side]),
    );
    assert.deepEqual(unreachable(at, [], [head]), new Set());
  });

  it("walks no blob, so it never lists one", () => {
    const { r, at, head } = histories();
    const blob = r.git("rev-parse", "HEAD:a.md").trim();
    assert.deepEqual(unreachable(at, [blob], [head]), new Set());
  });
});
