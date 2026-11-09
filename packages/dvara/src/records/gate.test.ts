// The record gate against throwaway repositories: additions, modifications,
// deletions and renames at pre-commit; staged-invalid with a valid working
// tree and the inverse; the baseline ratchet; branch and whole-tree modes;
// skipped and frozen paths read by no mode.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULTS, type RecordsConfig } from "../config.ts";
import { repo, template, type Repo } from "./fixture.test.ts";
import { parseArgs, records, type Options } from "./gate.ts";
import { durablePaths } from "./paths.ts";
import type { Finding, Rule } from "./types.ts";

const BASELINE = DEFAULTS.records.baseline;
const LEGACY = "docs/rfcs/0001-old.md";
const LEGACY_TEXT = "# Old notes\n\nRan in /Users/someone/code/app.\n";
const DOC = "docs/notes/guide.md";
const GOOD_DOC = "# Guide\n\nReproduced twice.\n";
/** A document citing a machine-local path: one EVIDENCE-02 finding. */
const BAD_DOC = "# Guide\n\nReproduced in /Users/someone/app.\n";
const HOME =
  "[EVIDENCE-02/home-path] a /Users/<name> home path names one machine and its operator";
const UNRESOLVED = "0123456789abcdef0123456789abcdef01234567";
/** Frozen: no mode reads these, whatever they hold. */
const FROZEN = [
  "docs/archive/0003-x/evidence/F.md",
  "docs/archive/0003-x/README.md",
  "docs/journal/2026-09-30-y.md",
];
/** The live entry points beside the frozen paths, read like any file. */
const LIVE = [
  "docs/archive/README.md",
  "docs/journal/README.md",
  "docs/journal/_TEMPLATE.md",
];

const RECORDS: RecordsConfig = {
  ...DEFAULTS.records,
  skip: ["tools/records/"],
  frozen: { paths: ["docs/archive/", "docs/journal/"], except: LIVE },
  packageManager: "pnpm",
};

/**
 * A stand-in for a commit-id rule, to prove the seam the tree answers
 * through: under `docs/rfcs/`, every 40-hex id the store does not have as a
 * commit is a finding, unless the file already cited it at the base; one the
 * branch adds is held by no baseline.
 */
const ids: Rule = (path, text, tree) => {
  if (!path.startsWith("docs/rfcs/")) return [];
  const base = tree.baseText(path);
  const found: Finding[] = [];
  text.split("\n").forEach((line, i) => {
    for (const [sha] of line.matchAll(/\b[0-9a-f]{40}\b/g)) {
      const type = tree.typesOf([sha]).get(sha);
      if (type === "commit" || base?.includes(sha)) continue;
      found.push({
        rule: "EVIDENCE-01",
        check: "EVIDENCE-01",
        file: path,
        line: i + 1,
        message:
          type === undefined
            ? `${sha} does not resolve in this repository`
            : `${sha} is cited as a commit but is a ${type}`,
        ...(base === undefined ? {} : { ratchet: false as const }),
      });
    }
  });
  return found;
};

const baseline = (files: Record<string, Record<string, number>>): string =>
  `${JSON.stringify({ files }, null, 2)}\n`;

/** A repository with a legacy file its baseline holds, and a clean document. */
const init = template(() => {
  const r = repo();
  r.write("config.json", "{}\n");
  r.write(".gitignore", ".tmp/\n");
  r.write(LEGACY, LEGACY_TEXT);
  r.write(BASELINE, baseline({ [LEGACY]: { "EVIDENCE-02": 1 } }));
  r.write(DOC, GOOD_DOC);
  r.commit("init");
  return r;
});

const gate = (
  r: Repo,
  options: Partial<Options> & { mode: Options["mode"] },
  settings: Partial<RecordsConfig> = {},
): { code: number; out: string } => {
  const lines: string[] = [];
  const records_ = { ...RECORDS, ...settings };
  const code = records(
    { base: null, writeBaseline: false, survey: false, ...options },
    { cwd: r.root, env: r.env },
    (line) => lines.push(line),
    {
      records: records_,
      baseRefs: ["origin/main"],
      own: [".dvara.json"],
      rules: [durablePaths(records_), ids],
    },
  );
  return { code, out: lines.join("\n") };
};

const staged = (r: Repo) => gate(r, { mode: "staged" });

const passed = (files: number) =>
  new RegExp(String.raw`^✅ records: ${files} file\(s\) checked, `);

describe("pre-commit: what is staged", () => {
  it("passes a clean commit, reading only what it adds", () => {
    const r = init();
    r.write("docs/notes.md", "# Notes\n");
    r.git("add", "docs/notes.md");
    const result = staged(r);
    assert.equal(result.code, 0);
    assert.match(
      result.out,
      /^✅ records: 1 file\(s\) checked, 0 legacy finding\(s\) held by \.dvara\/records-baseline\.json \(\d+ ms\)$/,
    );
  });

  it("refuses an added document citing a machine-local path (A)", () => {
    const r = init();
    r.write("docs/notes/other.md", BAD_DOC);
    r.git("add", "-A");
    const result = staged(r);
    assert.equal(result.code, 1);
    assert.ok(result.out.includes(`docs/notes/other.md:3 ${HOME}`), result.out);
  });

  it("refuses a document modified to cite a machine-local path (M)", () => {
    const r = init();
    r.write(DOC, BAD_DOC);
    r.git("add", "-A");
    assert.equal(staged(r).code, 1);
  });

  it("reads the index: staged-invalid with a valid working tree is refused", () => {
    const r = init();
    r.write(DOC, BAD_DOC);
    r.git("add", "-A");
    r.write(DOC, GOOD_DOC);
    assert.equal(staged(r).code, 1);
  });

  it("reads the index: staged-valid with an invalid working tree passes", () => {
    const r = init();
    r.write(DOC, "# Guide\n\nReproduced twice on main.\n");
    r.git("add", "-A");
    r.write(DOC, BAD_DOC);
    assert.equal(staged(r).code, 0);
  });

  it("refuses deleting a baselined file without its entry (D), then accepts both", () => {
    const r = init();
    r.git("rm", "-q", LEGACY);
    const refused = staged(r);
    assert.equal(refused.code, 1);
    assert.ok(
      refused.out.includes(
        `${LEGACY} — gone; remove its entry from ${BASELINE}`,
      ),
    );
    r.write(BASELINE, baseline({}));
    r.git("add", BASELINE);
    assert.equal(staged(r).code, 0);
  });

  it("refuses a rename that leaves the entry behind (R), accepts one that carries it", () => {
    const r = init();
    const moved = "docs/rfcs/0002-old.md";
    r.git("mv", LEGACY, moved);
    assert.equal(staged(r).code, 1);
    r.write(BASELINE, baseline({ [moved]: { "EVIDENCE-02": 1 } }));
    r.git("add", BASELINE);
    assert.equal(staged(r).code, 0);
  });

  it("prints each refusal with its rule, check and allowance", () => {
    const r = init();
    const added = "docs/rfcs/0003-x.md";
    r.write(LEGACY, `${LEGACY_TEXT}And /Users/someone/other.\n`);
    r.write(added, `# T\n\nBuilt from ${UNRESOLVED}.\n`);
    r.git("add", "-A");
    const result = staged(r);
    assert.equal(result.code, 1);
    const lines = result.out.split("\n");
    const home = (n: number): string =>
      `  ${LEGACY}:${n} ${HOME}: "/Users/someone"`;
    assert.deepEqual(lines.slice(0, -1), [
      "❌ records: refused",
      // No allowance: no note, and a check that is its rule is not repeated.
      `${added} — EVIDENCE-01:`,
      `  ${added}:3 [EVIDENCE-01] ${UNRESOLVED} does not resolve in this repository`,
      `${LEGACY} — EVIDENCE-02 (baseline allows 1, now 2):`,
      home(3),
      home(4),
    ]);
    assert.match(lines.at(-1) ?? "", /^\(\d{1,5} ms\)$/);
  });

  it("reads no skipped path, nor the baseline or the config file", () => {
    const r = init();
    r.write("tools/records/notes.md", "# Notes\n\nRan in /Users/someone/x.\n");
    r.write(".dvara.json", '{"note": "/Users/someone/x"}\n');
    r.write(
      BASELINE,
      baseline({
        [LEGACY]: { "EVIDENCE-02": 1 },
      }).replace("{", '{"_": "/Users/someone/x",'),
    );
    r.git("add", "tools/records/notes.md", ".dvara.json", BASELINE);
    assert.match(staged(r).out, passed(0));
  });

  it("reads no frozen path, however bad", () => {
    const r = init();
    for (const path of FROZEN)
      r.write(path, `${BAD_DOC}Built ${UNRESOLVED}.\n\0`);
    r.git("add", "-A");
    const result = staged(r);
    assert.equal(result.code, 0);
    assert.match(result.out, passed(0));
  });

  it("still reads the live entry points beside the frozen paths", () => {
    const r = init();
    for (const path of LIVE) r.write(path, BAD_DOC);
    r.git("add", "-A");
    const result = staged(r);
    assert.equal(result.code, 1);
    for (const path of LIVE)
      assert.ok(result.out.includes(`${path}:3 ${HOME}`));
  });

  it("reads no frozen file a baseline edit lowers, even an unreadable one", () => {
    const r = init();
    const [frozen = ""] = FROZEN;
    r.write(frozen, BAD_DOC);
    r.write(
      BASELINE,
      baseline({
        [LEGACY]: { "EVIDENCE-02": 1 },
        [frozen]: { "EVIDENCE-02": 1 },
      }),
    );
    r.commit("an old allowance for a frozen file");
    r.breakObject(`HEAD:${frozen}`);
    r.write(BASELINE, baseline({ [LEGACY]: { "EVIDENCE-02": 1 } }));
    r.git("add", BASELINE);
    const result = staged(r);
    assert.equal(result.code, 0);
    assert.match(result.out, passed(0));
  });

  it("refuses a new finding in a legacy file", () => {
    const r = init();
    r.write(LEGACY, `${LEGACY_TEXT}And /Users/someone/other.\n`);
    r.git("add", "-A");
    const result = staged(r);
    assert.equal(result.code, 1);
    assert.ok(result.out.includes("baseline allows 1, now 2"));
  });

  it("refuses a fix that leaves the allowance, accepts it with the entry lowered", () => {
    const r = init();
    r.write(LEGACY, "# Old notes\n\nRan in the repository root.\n");
    r.git("add", "-A");
    const refused = staged(r);
    assert.equal(refused.code, 1);
    assert.ok(
      refused.out.includes(
        `${LEGACY} — EVIDENCE-02: 0 left of 1; lower its count in ${BASELINE} to 0`,
      ),
    );
    r.write(BASELINE, baseline({}));
    r.git("add", BASELINE);
    assert.equal(staged(r).code, 0);
  });

  it("refuses raising an allowance or recording a new file", () => {
    const r = init();
    r.write(LEGACY, `${LEGACY_TEXT}And /Users/someone/other.\n`);
    r.write(BASELINE, baseline({ [LEGACY]: { "EVIDENCE-02": 2 } }));
    r.git("add", "-A");
    assert.ok(
      staged(r).out.includes(
        `${BASELINE}: ${LEGACY}: EVIDENCE-02 raised from 1 to 2; counts only fall`,
      ),
    );
    r.write("docs/rfcs/0003-old.md", LEGACY_TEXT);
    r.write(
      BASELINE,
      baseline({
        [LEGACY]: { "EVIDENCE-02": 1 },
        "docs/rfcs/0003-old.md": { "EVIDENCE-02": 1 },
      }),
    );
    r.write(LEGACY, LEGACY_TEXT);
    r.git("add", "-A");
    assert.ok(staged(r).out.includes("a new baseline entry"));
  });

  it("refuses moving a fixed file's allowance to an unrelated file", () => {
    const r = init();
    const other = "docs/rfcs/0009-old.md";
    r.write(LEGACY, "# Old notes\n\nRan in the repository root.\n");
    r.write(other, "# Other notes\n\nRan in /Users/someone/other.\n");
    r.write(BASELINE, baseline({ [other]: { "EVIDENCE-02": 1 } }));
    r.git("add", "-A");
    const result = staged(r);
    assert.equal(result.code, 1);
    assert.ok(result.out.includes(`${other}: a new baseline entry`));
  });

  it("answers a rule's object questions from the store", () => {
    const r = init();
    const blob = r.git("rev-parse", "HEAD:config.json").trim();
    r.write("docs/rfcs/0003-b.md", `# B\n\nBuilt from ${blob}.\n`);
    r.git("add", "-A");
    const result = staged(r);
    assert.equal(result.code, 1);
    assert.ok(result.out.includes("is cited as a commit but is a blob"));
  });

  it("gives a rule a renamed file's base text under its old path", () => {
    const r = init();
    r.write("docs/rfcs/0003-r.md", `# R\n\nBuilt from ${UNRESOLVED}.\n`);
    r.commit("legacy document");
    r.git("update-ref", "refs/remotes/origin/main", "HEAD");
    r.git("mv", "docs/rfcs/0003-r.md", "docs/rfcs/0003-s.md");
    assert.equal(staged(r).code, 0);
    r.write(
      "docs/rfcs/0003-s.md",
      `# R\n\nBuilt from ${UNRESOLVED}.\nThen fedcba9876543210fedcba9876543210fedcba98.\n`,
    );
    r.git("add", "-A");
    assert.ok(
      staged(r).out.includes(
        "fedcba9876543210fedcba9876543210fedcba98 does not resolve",
      ),
    );
  });

  it("re-checks a file whose entry a baseline-only edit lowers", () => {
    const r = init();
    r.write(BASELINE, baseline({}));
    r.git("add", BASELINE);
    const result = staged(r);
    assert.equal(result.code, 1);
    assert.ok(result.out.includes(`${LEGACY} — EVIDENCE-02`));
  });

  it("does not answer for the upstream's files when merging it in", () => {
    const r = init();
    r.git("checkout", "-q", "-b", "feature");
    r.write("docs/rfcs/0003-f.md", "# F\n");
    r.commit("feature");
    r.git("checkout", "-q", "main");
    r.write("docs/rfcs/0002-b.md", `# B\n\nBuilt from ${UNRESOLVED}.\n`);
    r.write("docs/notes/from-main.md", BAD_DOC);
    r.commit("main moves on");
    r.git("update-ref", "refs/remotes/origin/main", "HEAD");
    r.git("checkout", "-q", "feature");
    r.git("merge", "-q", "--no-commit", "--no-ff", "main");
    // The merge does stage main's files; only the merge rule drops them.
    assert.match(r.git("diff", "--cached", "--name-only"), /from-main\.md/);
    const result = staged(r);
    assert.ok(!result.out.includes("0002-b.md"));
    assert.ok(!result.out.includes("from-main.md"));
    assert.equal(result.code, 0);
  });

  it("stops when a staged path's object cannot be read", () => {
    const r = init();
    r.write("docs/notes/l.md", "# L\n");
    r.git("add", "-A");
    r.breakObject(":docs/notes/l.md");
    assert.deepEqual(staged(r), {
      code: 2,
      out: "dvara records: docs/notes/l.md is in the index but its object cannot be read",
    });
  });

  it("stops when an unchanged file a baseline edit re-reads is unreadable", () => {
    const r = init();
    r.breakObject(`:${LEGACY}`);
    r.write(BASELINE, baseline({}));
    r.git("add", BASELINE);
    assert.deepEqual(staged(r), {
      code: 2,
      out: `dvara records: ${LEGACY} is in the index but its object cannot be read`,
    });
  });

  it("stops when the base baseline is listed but unreadable", () => {
    const r = init();
    r.breakObject(`HEAD:${BASELINE}`);
    r.write(BASELINE, baseline({}));
    r.git("add", BASELINE);
    const result = staged(r);
    assert.equal(result.code, 2);
    assert.match(result.out, /^dvara records: .*its object cannot be read$/);
  });

  it("stops when the staged baseline is listed but unreadable", () => {
    const r = init();
    r.write(BASELINE, baseline({}));
    r.git("add", BASELINE);
    r.breakObject(`:${BASELINE}`);
    assert.equal(staged(r).code, 2);
  });

  it("reads a staged file whose name holds a newline", () => {
    const r = init();
    r.write("docs/notes/two\nlines.md", "# T\n\nRan in /Users/someone/x.\n");
    r.write("docs/notes/ok.md", "# ok\n");
    r.git("add", "-A");
    const result = staged(r);
    assert.equal(result.code, 1);
    assert.ok(result.out.includes("two\nlines.md"));
    assert.ok(result.out.includes("/Users/someone"));
  });

  it("refuses a Markdown document carrying a NUL byte", () => {
    const r = init();
    r.write("docs/notes/n.md", "# N\n\0\n");
    r.git("add", "-A");
    assert.deepEqual(staged(r), {
      code: 1,
      out: "dvara records: docs/notes/n.md contains a NUL byte; a Markdown record must be text",
    });
  });

  it("skips another text file carrying a NUL byte, and a binary by name", () => {
    const r = init();
    r.write("docs/notes/n.txt", "Ran in /Users/someone/x.\n\0\n");
    r.write("docs/notes/n.png", "Ran in /Users/someone/x.\n");
    r.git("add", "-A");
    const result = staged(r);
    assert.equal(result.code, 0);
    assert.match(result.out, passed(0));
  });

  it("skips a symlink: its blob is a target's path, not a record", () => {
    const r = init();
    // Read as text, the link's target would be a home-path finding.
    symlinkSync("/Users/someone/notes.md", join(r.root, "docs/notes/link.md"));
    r.write("docs/notes/ok.md", "# ok\n");
    r.git("add", "-A");
    const result = staged(r);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, passed(1));
    r.commit("a link");
    assert.equal(gate(r, { mode: "all" }).code, 0);
    // An allowance for a link answers to no file the gate reads.
    r.write(
      BASELINE,
      baseline({
        [LEGACY]: { "EVIDENCE-02": 1 },
        "docs/notes/link.md": { "EVIDENCE-02": 1 },
      }),
    );
    r.commit("an allowance for the link");
    const refused = gate(r, { mode: "all" });
    assert.match(
      refused.out,
      /docs\/notes\/link\.md — not a file the gate reads/,
    );
    assert.equal(refused.code, 1);
  });

  it("skips a submodule, whose commit this store need not have", () => {
    const r = init();
    r.git(
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${UNRESOLVED},vendor/lib`,
    );
    const result = staged(r);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, passed(0));
    r.git("commit", "-q", "-m", "a submodule");
    assert.equal(gate(r, { mode: "all" }).code, 0);
  });

  it("compares a branch's baseline edits with the upstream's, not the last commit", () => {
    const r = init();
    r.git("rm", "-q", BASELINE);
    r.commit("main has no baseline");
    r.git("update-ref", "refs/remotes/origin/main", "HEAD");
    r.write(BASELINE, baseline({ [LEGACY]: { "EVIDENCE-02": 1 } }));
    r.git("add", BASELINE);
    r.git("commit", "-q", "-m", "branch adds the baseline");
    r.write(LEGACY, `${LEGACY_TEXT}And /Users/someone/other.\n`);
    r.write(BASELINE, baseline({ [LEGACY]: { "EVIDENCE-02": 2 } }));
    r.git("add", "-A");
    assert.equal(staged(r).code, 0);
  });

  it("holds a root commit's baseline to every entry", () => {
    const r = repo();
    r.write(LEGACY, LEGACY_TEXT);
    r.write(
      BASELINE,
      baseline({
        [LEGACY]: { "EVIDENCE-02": 1 },
        "docs/gone.md": { "EVIDENCE-02": 1 },
      }),
    );
    r.git("add", "-A");
    const result = staged(r);
    assert.equal(result.code, 1);
    assert.ok(result.out.includes("docs/gone.md — gone"));
  });

  it("accepts adding the baseline only when every entry matches the tree", () => {
    const r = init();
    r.git("rm", "-q", BASELINE);
    r.commit("no baseline");
    r.write(BASELINE, baseline({ [LEGACY]: { "EVIDENCE-02": 1 } }));
    r.git("add", BASELINE);
    assert.equal(staged(r).code, 0);
    r.write(BASELINE, baseline({ [LEGACY]: { "EVIDENCE-02": 2 } }));
    r.git("add", BASELINE);
    assert.ok(staged(r).out.includes("lower its count"));
    r.write(
      BASELINE,
      baseline({
        [LEGACY]: { "EVIDENCE-02": 1 },
        "docs/gone.md": { "EVIDENCE-02": 1 },
      }),
    );
    r.git("add", BASELINE);
    assert.ok(staged(r).out.includes("docs/gone.md — gone"));
  });

  it("answers a rule's questions for many files in batches", () => {
    const r = init();
    const head = r.git("rev-parse", "HEAD").trim();
    for (let i = 0; i < 12; i += 1)
      r.write(`docs/rfcs/0003-e-${i}.md`, `# E\n\nBuilt from ${head}.\n`);
    r.write("docs/rfcs/0003-f.md", `# F\n\nBuilt from ${UNRESOLVED}.\n`);
    r.git("add", "-A");
    const result = staged(r);
    assert.equal(result.code, 1);
    assert.ok(result.out.includes("does not resolve in this repository"));
    assert.ok(!result.out.includes("0003-e-"));
  });

  it("refuses a baseline it cannot read", () => {
    const r = init();
    r.write(BASELINE, '{"files": {"x": {"NOPE": 1}}}\n');
    r.git("add", "-A");
    assert.deepEqual(staged(r), {
      code: 1,
      out: `dvara records: ${BASELINE}: x names unknown rule NOPE`,
    });
  });

  it("runs the shipped rules when given none", () => {
    const r = init();
    r.write(DOC, BAD_DOC);
    r.git("add", "-A");
    const lines: string[] = [];
    const code = records(
      { mode: "staged", base: null, writeBaseline: false, survey: false },
      { cwd: r.root, env: r.env },
      (line) => lines.push(line),
      { records: RECORDS, baseRefs: [] },
    );
    assert.equal(code, 1);
    assert.ok(lines.includes(`  ${DOC}:3 ${HOME}: "/Users/someone"`));
  });
});

describe("CI: the branch and the whole tree", () => {
  const feature = (): Repo => {
    const r = init();
    r.git("checkout", "-q", "-b", "feature");
    return r;
  };

  it("refuses a committed bad document against the base", () => {
    const r = feature();
    r.write("docs/notes/other.md", BAD_DOC);
    r.commit("bad");
    assert.equal(gate(r, { mode: "base", base: "main" }).code, 1);
    assert.equal(gate(r, { mode: "all", base: "main" }).code, 1);
  });

  it("reads no frozen file in either CI mode", () => {
    const r = feature();
    // Each its own blob, so each can be broken on its own.
    for (const path of FROZEN) r.write(path, `${BAD_DOC}${path}\n`);
    r.commit("frozen history");
    for (const path of FROZEN) r.breakObject(`HEAD:${path}`);
    const base = gate(r, { mode: "base", base: "main" });
    assert.equal(base.code, 0);
    assert.match(base.out, passed(0));
    const all = gate(r, { mode: "all", base: "main" });
    assert.equal(all.code, 0);
    assert.match(all.out, passed(4));
  });

  it("stops when a document the base lists cannot be read there", () => {
    const r = feature();
    const path = "docs/rfcs/0003-u.md";
    r.git("checkout", "-q", "main");
    r.write(path, "# U\n\nOnly at the base.\n");
    r.commit("base document");
    r.git("checkout", "-q", "feature");
    r.git("merge", "-q", "--ff-only", "main");
    const id = r.git("rev-parse", `main:${path}`).trim();
    r.write(path, "# U\n\nChanged on the branch.\n");
    r.commit("branch edit");
    r.breakObject(id);
    const result = gate(r, { mode: "base", base: "main" });
    assert.equal(result.code, 2);
    assert.match(result.out, /its object cannot be read/);
  });

  it("stops when a committed document cannot be read", () => {
    const r = feature();
    r.write("docs/notes/v.md", "# V\n");
    r.commit("a document");
    r.breakObject("HEAD:docs/notes/v.md");
    assert.deepEqual(gate(r, { mode: "base", base: "main" }), {
      code: 2,
      out: "dvara records: docs/notes/v.md is in the commit but its object cannot be read",
    });
  });

  it("passes the whole tree within its baseline", () => {
    const r = feature();
    const all = gate(r, { mode: "all" });
    assert.equal(all.code, 0);
    assert.match(
      all.out,
      /^✅ records: 4 file\(s\) checked, 1 legacy finding\(s\) held by \.dvara\/records-baseline\.json \(\d{1,5} ms\)$/,
    );
    assert.equal(gate(r, { mode: "all", base: "main" }).code, 0);
  });

  it("refuses a branch raising an allowance in either CI mode", () => {
    const r = feature();
    r.write(BASELINE, baseline({ [LEGACY]: { "EVIDENCE-02": 2 } }));
    r.commit("raise only");
    for (const mode of ["base", "all"] as const) {
      const result = gate(r, { mode, base: "main" });
      assert.equal(result.code, 1);
      assert.ok(result.out.includes("raised from 1 to 2"));
    }
  });

  it("carries a renamed file's allowance in either CI mode", () => {
    const r = feature();
    const moved = "docs/rfcs/0002-old.md";
    r.git("mv", LEGACY, moved);
    r.write(BASELINE, baseline({ [moved]: { "EVIDENCE-02": 1 } }));
    r.commit("rename with its allowance");
    assert.equal(gate(r, { mode: "base", base: "main" }).code, 0);
    assert.equal(gate(r, { mode: "all", base: "main" }).code, 0);
  });

  it("writes no allowance for a finding no baseline may hold", () => {
    const r = feature();
    r.write("docs/rfcs/0003-b.md", `# B\n\nBuilt from ${UNRESOLVED}.\n`);
    r.commit("an unresolved id");
    assert.equal(
      gate(r, { mode: "all", base: "main", writeBaseline: true }).code,
      0,
    );
    assert.deepEqual(JSON.parse(readFileSync(join(r.root, BASELINE), "utf8")), {
      files: { [LEGACY]: { "EVIDENCE-02": 1 } },
    });
  });

  it("refuses an allowance for a file the gate does not read", () => {
    const r = feature();
    const [frozen = ""] = FROZEN;
    r.write("docs/notes/raw.txt", "bytes\0here\n");
    r.write(frozen, BAD_DOC);
    r.write(
      BASELINE,
      baseline({
        [LEGACY]: { "EVIDENCE-02": 1 },
        "docs/notes/raw.txt": { "EVIDENCE-02": 1 },
        [frozen]: { "EVIDENCE-02": 1 },
        "docs/gone.md": { "EVIDENCE-02": 1 },
      }),
    );
    r.commit("allowances the gate cannot answer to");
    const lines = gate(r, { mode: "all" }).out.split("\n");
    for (const path of ["docs/notes/raw.txt", frozen])
      assert.ok(
        lines.includes(
          `${path} — not a file the gate reads; remove its entry from ${BASELINE}`,
        ),
        path,
      );
    assert.ok(
      lines.includes(`docs/gone.md — gone; remove its entry from ${BASELINE}`),
    );
  });

  it("refuses a base it cannot resolve, or one with no merge base", () => {
    const r = feature();
    assert.deepEqual(gate(r, { mode: "base", base: "nope" }), {
      code: 2,
      out: "dvara records: cannot resolve nope or HEAD",
    });
    r.git("checkout", "-q", "--orphan", "lone");
    r.git("commit", "-q", "-m", "unrelated history");
    r.git("checkout", "-q", "feature");
    assert.deepEqual(gate(r, { mode: "base", base: "lone" }), {
      code: 2,
      out: "dvara records: no merge base between HEAD and lone",
    });
  });

  it("surveys and writes a baseline, making its folder", () => {
    const r = feature();
    r.write(LEGACY, `${LEGACY_TEXT}And /Users/someone/other.\n`);
    // Neither mode reads the committed baseline: an unreadable one is no
    // obstacle to replacing it.
    r.write(BASELINE, '{"files": {"x": {"NOPE": 1}}}\n');
    r.commit("more");
    assert.deepEqual(gate(r, { mode: "all", survey: true }), {
      code: 0,
      out: [
        "files checked: 4; files with findings: 1; findings: 2",
        "rule EVIDENCE-01: 0 findings in 0 files",
        "rule EVIDENCE-02: 2 findings in 1 files",
        "check home-path: 2",
      ].join("\n"),
    });
    const elsewhere = "records/nested/baseline.json";
    assert.deepEqual(
      gate(r, { mode: "all", writeBaseline: true }, { baseline: elsewhere }),
      {
        code: 0,
        out: `dvara records: wrote ${elsewhere} (1 files, 2 findings)`,
      },
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(r.root, elsewhere), "utf8")),
      {
        files: { [LEGACY]: { "EVIDENCE-02": 2 } },
      },
    );
    assert.equal(gate(r, { mode: "all", writeBaseline: true }).code, 0);
    r.commit("baseline");
    assert.equal(gate(r, { mode: "all" }).code, 0);
  });

  it("refuses to write the baseline through a symlink", () => {
    const r = feature();
    const outside = join(
      mkdtempSync(join(tmpdir(), "dvara-outside-")),
      "kept.json",
    );
    writeFileSync(outside, "kept\n");
    rmSync(join(r.root, BASELINE));
    symlinkSync(outside, join(r.root, BASELINE));
    assert.deepEqual(gate(r, { mode: "all", writeBaseline: true }), {
      code: 2,
      out: `dvara records: ${BASELINE} is a symlink; replace it with a file before writing the baseline`,
    });
    assert.equal(readFileSync(outside, "utf8"), "kept\n");
  });

  it("sorts the survey's checks by name", () => {
    const r = feature();
    r.write(
      "docs/notes/many.md",
      "at /private/tmp/x\nfile:///x\nat /home/someone/x/\n",
    );
    r.commit("three checks");
    assert.deepEqual(
      gate(r, { mode: "all", survey: true }).out.split("\n").slice(3),
      ["check file-url: 1", "check home-path: 2", "check temp-root: 1"],
    );
  });
});

describe("arguments", () => {
  it("reads each mode", () => {
    for (const [args, expected] of [
      [["--staged"], { mode: "staged", base: null }],
      [
        ["--all", "--base", "origin/main"],
        { mode: "all", base: "origin/main" },
      ],
      [["--base", "origin/main"], { mode: "base", base: "origin/main" }],
      [["--all", "--survey"], { mode: "all", survey: true }],
      [["--all", "--write-baseline"], { mode: "all", writeBaseline: true }],
    ] as const) {
      const parsed = parseArgs(args);
      assert.ok(!("error" in parsed));
      for (const [key, value] of Object.entries(expected))
        assert.equal(
          parsed[key as keyof Options],
          value,
          `${args.join(" ")}: ${key}`,
        );
    }
  });

  it("refuses what it cannot run", () => {
    for (const [args, message] of [
      [[], "nothing to check"],
      [["--staged", "--all"], "one of"],
      [["--base"], "needs a ref"],
      [["--base", "--all"], "needs a ref"],
      [["--base", "origin/main", "--base", "HEAD"], "given twice"],
      [["--staged", "--base", "x"], "drop --base"],
      [["--survey", "--base", "x"], "add --all"],
      [["--nope"], "unknown argument: --nope"],
      [["--all", "--survey", "--write-baseline"], "pick one"],
    ] as const) {
      const parsed = parseArgs(args);
      assert.ok(
        "error" in parsed && parsed.error.includes(message),
        args.join(" "),
      );
    }
  });
});
