import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RecordsConfig } from "../config.ts";
import { citesAsCommit, commitIdentity, hexRole } from "./identity.ts";
import type { Finding, TreeContext } from "./types.ts";

const F = "```";

/** Commits the fake object store has. */
const COMMIT = "303d6a0be64dae6588efd4cf4a86c40be6638301";
const OTHER_COMMIT = "f560997d61f8333ea037b5a4a624e4f910be2e71";
/** A blob the fake object store has. */
const BLOB = "8f2a1c0d9e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39";
/** Ids the store does not have. */
const UNKNOWN = "fedcba9876543210fedcba9876543210fedcba98";
const UNKNOWN_2 = "0123456789abcdef0123456789abcdef01234567";

const typesOf: TreeContext["typesOf"] = (shas) => {
  const types = new Map<string, string>();
  for (const sha of shas) {
    if (sha === COMMIT || sha === OTHER_COMMIT) types.set(sha, "commit");
    else if (sha === BLOB) types.set(sha, "blob");
  }
  return types;
};

const PATH = "docs/research/0001-a/x.md";
const LOG = "docs/research/0001-a/run.txt";

const records: Pick<RecordsConfig, "identityPaths" | "repository"> = {
  identityPaths: [/./],
  repository: "acme/widgets",
};

/** Every commit the fake store has is on pushed history. */
const pushed: TreeContext["onHistory"] = () => ({
  unreached: new Set(),
  refs: ["origin/main"],
});

const check = (
  text: string,
  path = PATH,
  baseText: string | null = null,
  config: Pick<RecordsConfig, "identityPaths" | "repository"> = records,
  onHistory: TreeContext["onHistory"] = pushed,
): Finding[] =>
  commitIdentity(config)(path, text, {
    typesOf,
    onHistory,
    baseText: () => baseText,
  });

/** With no branch to compare (baseText undefined), no full id is asked. */
const unbranched = (text: string, path = PATH): Finding[] =>
  commitIdentity(records)(path, text, {
    typesOf,
    onHistory: pushed,
    baseText: () => undefined,
  });

const messages = (found: readonly Finding[]): string =>
  found.map((f) => f.message).join("\n");

const includes = (found: readonly Finding[], part: string): void => {
  const all = messages(found);
  assert.ok(all.includes(part), `expected "${part}" in:\n${all}`);
};

describe("EVIDENCE-01: commit identity", () => {
  it("refuses each abbreviated citation", () => {
    for (const text of [
      "Between abc1234..def5678 the gate moved.",
      "The head was abc1234… when it failed.",
      '{"sha": "abc1234d"}',
      "Commit abc1234d fixed it.",
      "$ git log --format=%h -1",
    ])
      assert.ok(check(`${text}\n`).length > 0, text);
  });

  it("passes hashes, numbers, words and another repository's commit URL", () => {
    for (const text of [
      "A sha256 of `abc1234def` matched.",
      "Hash `abcdef0123456789` of the task.",
      "Numbers 1234567 and words deadbeef.",
      `https://github.com/octo/tools/commit/${UNKNOWN_2}`,
    ])
      assert.deepEqual(check(`${text}\n`), [], text);
  });

  it("lets a hash label at the token outrank a commit word farther back", () => {
    assert.deepEqual(
      check("The merged archive has checksum `abc1234def`.\n"),
      [],
    );
    includes(check("Merged commit `abc1234def`.\n"), "abbreviated commit");
  });

  it("refuses an all-digit or all-letter id a commit word names", () => {
    for (const text of [
      "Commit 1234567 fixed it.",
      "sha: abcdefa",
      "Range 1234567..7654321",
    ])
      includes(check(`${text}\n`), "abbreviated commit");
    // Suggested, not named: a number or a word stays prose.
    assert.deepEqual(check("A commit landed; 1234567 rows moved.\n"), []);
  });

  it("reads commit ids in upper case too", () => {
    includes(
      check("Commit ABC1234D fixed it.\n"),
      'abbreviated commit "ABC1234D"',
    );
    const upper = "FEDCBA9876543210FEDCBA9876543210FEDCBA98";
    includes(
      check(`resolved-by: ${upper}\n`),
      `${upper.toLowerCase()} does not resolve`,
    );
  });

  it("refuses an abbreviated right endpoint after a full left one", () => {
    const found = check(
      `Range ${UNKNOWN_2}..abc1234 and ${UNKNOWN_2}...def5678\n`,
    );
    includes(found, '"abc1234" ends a range');
    includes(found, '"def5678" ends a range');
    assert.ok(
      !messages(check(`Range ${UNKNOWN_2}..${UNKNOWN_2}\n`)).includes(
        "ends a range",
      ),
    );
  });

  it("refuses an abbreviated right endpoint after a ref", () => {
    for (const [line, token] of [
      ["Compare main..abc1234 first.", "abc1234"],
      ["Compare HEAD...abc1234 first.", "abc1234"],
      ["Compare origin/main..abc1234 first.", "abc1234"],
      ["Compare HEAD~2..def5678.", "def5678"],
      ["Compare v1.2..def5678.", "def5678"],
      ["see compare/main...abc1234", "abc1234"],
    ] as const) {
      const found = unbranched(`${line}\n`).filter((f) =>
        f.message.includes("ends a range"),
      );
      assert.equal(found.length, 1, line);
      includes(found, `"${token}" ends a range`);
    }
    // A diff's `index a..b` pairs blobs; a full right end is no abbreviation.
    assert.deepEqual(unbranched("index main..abc1234\n"), []);
    assert.ok(
      !messages(unbranched(`Compare main..${UNKNOWN_2}\n`)).includes(
        "ends a range",
      ),
    );
  });

  it("refuses an abbreviated commit URL of this repository, not another's", () => {
    includes(
      check("See https://github.com/acme/widgets/commit/abc1234.\n"),
      "abbreviated commit URL",
    );
    assert.deepEqual(
      check("See https://github.com/octo/tools/commit/abc1234.\n"),
      [],
    );
  });

  it("resolves this repository's full commit URL, not a fork's", () => {
    assert.equal(
      check(`https://github.com/acme/widgets/commit/${UNKNOWN}\n`).length,
      1,
    );
    assert.deepEqual(
      check(`https://github.com/someone/widgets/commit/${UNKNOWN}\n`),
      [],
    );
  });

  it("passes another repository's action commit in an Actions log, not this one's", () => {
    for (const name of ["actions/checkout@v4", "github/codeql-action/init@v3"])
      assert.deepEqual(
        check(`Download action repository '${name}' (SHA:${UNKNOWN})\n`, LOG),
        [],
        name,
      );
    assert.equal(
      check(
        `Download action repository 'acme/widgets@main' (SHA:${UNKNOWN})\n`,
        LOG,
      ).length,
      1,
    );
    assert.equal(
      check(`Downloaded 'actions/checkout@v4' (SHA:${UNKNOWN})\n`, LOG).length,
      1,
    );
  });

  it("passes a pull request's test merge, not its head", () => {
    for (const ref of ["refs/remotes/pull/1432/merge", "refs/pull/7/merge"])
      assert.deepEqual(
        check(`git fetch origin +${UNKNOWN}:${ref}\n`, LOG),
        [],
        ref,
      );
    for (const ref of [
      "refs/remotes/pull/1432/head",
      "refs/remotes/pull/1432/merged",
      "refs/remotes/pull/x/merge",
    ])
      assert.equal(
        check(`git fetch origin +${UNKNOWN}:${ref}\n`, LOG).length,
        1,
        ref,
      );
    assert.equal(
      check(`git fetch origin +${UNKNOWN} :refs/pull/7/merge\n`, LOG).length,
      1,
    );
  });

  it("passes a test merge on every line once the log names it", () => {
    for (const named of [
      ` * [new ref]   ${UNKNOWN} -> pull/1432/merge`,
      ` * [new ref]   ${UNKNOWN} -> refs/remotes/pull/1432/merge`,
    ])
      assert.deepEqual(
        check(`${UNKNOWN}\n${named}\n${UNKNOWN}\n`, LOG),
        [],
        named,
      );
    // Only the named id: another bare id in the same log is still asked.
    assert.deepEqual(
      check(`${UNKNOWN} -> pull/1/merge\n${UNKNOWN_2}\n`, LOG).map(
        (f) => f.line,
      ),
      [2],
    );
    assert.equal(check(`${UNKNOWN} -> pull/1/head\n`, LOG).length, 1);
  });

  it("reads no file outside identityPaths", () => {
    const scoped = { identityPaths: [/^docs\//], repository: "acme/widgets" };
    const text = `Merged as \`303d6a0be\`.\nBuilt from ${UNKNOWN}.\n`;
    assert.deepEqual(check(text, "src/x.md", null, scoped), []);
    assert.equal(check(text, PATH, null, scoped).length, 2);
  });

  it("with no repository, asks no commit URL but still resolves bare ids", () => {
    const none = { identityPaths: [/./], repository: null };
    assert.deepEqual(
      check(
        "See https://github.com/acme/widgets/commit/abc1234.\n",
        PATH,
        null,
        none,
      ),
      [],
    );
    const found = check(
      `https://github.com/octo/tools/commit/${UNKNOWN}\ncommit ${UNKNOWN_2}\n`,
      PATH,
      null,
      none,
    );
    assert.deepEqual(
      found.map((f) => [f.line, f.check]),
      [[2, "unresolved-id"]],
    );
  });

  it("reads no token of a captured log, but resolves its full ids", () => {
    for (const ext of ["txt", "log", "diff", "patch"])
      assert.deepEqual(
        check("merged abc1234d\n", `docs/research/0001-a/run.${ext}`),
        [],
        ext,
      );
    assert.equal(check(`${UNKNOWN_2}\n`, LOG).length, 1);
  });

  it("does not resolve a full-length checksum, but does a commit", () => {
    assert.deepEqual(check(`The archive's checksum is ${UNKNOWN}.\n`), []);
    assert.deepEqual(check(`{"digest": "${UNKNOWN}"}\n`), []);
    assert.deepEqual(
      check(`The shipped archive's checksum is ${UNKNOWN}.\n`),
      [],
    );
    assert.equal(
      check(`Merged commit ${UNKNOWN} (its checksum matched).\n`).length,
      1,
    );
    // A commit word right before the id outranks a label after it, as for
    // an abbreviation.
    assert.equal(check(`commit ${UNKNOWN} (checksum verified)\n`).length, 1);
    assert.equal(check("commit abc1234def (checksum verified)\n").length, 1);
  });

  it("accepts a blob id git printed, not one cited as a commit", () => {
    assert.deepEqual(check(`index 0000000..${BLOB}\n`), []);
    assert.deepEqual(check(`$ git rev-parse HEAD:x\n\n${BLOB}\n`), []);
    includes(check(`Built from ${BLOB}.\n`), "is a blob");
  });

  it("holds both full ends of a range to commits", () => {
    includes(check(`Range ${COMMIT}..${BLOB}\n`), "is a blob");
    includes(check(`Range ${BLOB}...${COMMIT}\n`), "is a blob");
    assert.deepEqual(check(`Range ${COMMIT}..${COMMIT}\n`), []);
    assert.deepEqual(check(`Merged as \`${OTHER_COMMIT}\`.\n`), []);
  });

  it("reads every line of a script fence as a command", () => {
    includes(
      check(`${F}bash\ngit log --oneline -3\n${F}\n`),
      "abbreviated commits",
    );
    assert.deepEqual(check(`${F}text\ngit log --oneline -3\n${F}\n`), []);
    // A transcript's `$ ` line is a command; a quoted file's is its text.
    includes(
      check(`${F}text\n$ git log --oneline -3\n${F}\n`),
      "abbreviated commits",
    );
    assert.deepEqual(check(`${F}md\n$ git log --oneline -3\n${F}\n`), []);
    // A quoted transcript's `> $ ` line is a command too.
    includes(
      check(`> ${F}text\n> $ git log --oneline -3\n> ${F}\n`),
      "abbreviated commits",
    );
    // `--no-abbrev-commit` after `--oneline` prints full ids.
    assert.deepEqual(
      check(`${F}sh\ngit log --oneline --no-abbrev-commit -1\n${F}\n`),
      [],
    );
    includes(
      check(`${F}sh\ngit log --no-abbrev-commit --oneline -1\n${F}\n`),
      "abbreviated commits",
    );
    // `%h` is abbreviated whatever `--no-abbrev-commit` says.
    includes(
      check(`${F}sh\ngit log --oneline --no-abbrev-commit --format=%h\n${F}\n`),
      "abbreviated commits",
    );
    // `rev-parse --short` and `--abbrev-commit` print abbreviations too.
    for (const command of [
      "git rev-parse --short HEAD",
      "git log --abbrev-commit -1",
    ])
      includes(check(`${command}\n`), "abbreviated commits");
  });

  it("reads a command a trailing backslash continues as one, at its first line", () => {
    const at = (text: string): number[] =>
      check(text)
        .filter((f) => f.check === "abbreviating-command")
        .map((f) => f.line);
    // Every line of a script fence; a transcript's continued `$ ` line.
    assert.deepEqual(at(`${F}sh\ngit log \\\n  --oneline -3\n${F}\n`), [2]);
    assert.deepEqual(
      at(`${F}text\n$ git log \\\n  --format=x \\\n  --oneline\nabc\n${F}\n`),
      [2],
    );
    assert.deepEqual(at(`Run git log \\\n--oneline here.\n`), [1]);
    // `--no-abbrev-commit` on a continuation line restores full ids.
    assert.deepEqual(
      at(`${F}sh\ngit log --oneline \\\n  --no-abbrev-commit\n${F}\n`),
      [],
    );
    // A transcript's printed output is no continuation, nor a later command.
    assert.deepEqual(at(`${F}text\n$ git log\n--oneline\n${F}\n`), []);
    assert.deepEqual(
      at(`${F}text\n$ git status \\\n  -s\n--oneline\n${F}\n`),
      [],
    );
    // Lines join only when adjacent: a skipped output line breaks the command.
    assert.deepEqual(at(`${F}sh\ngit log \\\n${F}\n--oneline\n`), []);
  });

  it("skips git's null id and holds a commit URL to a commit", () => {
    assert.deepEqual(
      check(`index 0000000000000000000000000000000000000000..${BLOB}\n`),
      [],
    );
    includes(
      check(`https://github.com/acme/widgets/commit/${BLOB}\n`),
      "is a blob",
    );
    assert.deepEqual(
      check(`https://github.com/acme/widgets/blob/${BLOB}/x.md\n`),
      [],
    );
  });

  it("checks again an id the base printed but a new line calls a commit", () => {
    const base = `$ git rev-parse HEAD:x\n\n${BLOB}\n`;
    assert.equal(check(`${base}Built from ${BLOB}.\n`, PATH, base).length, 1);
    assert.deepEqual(check(base, PATH, base), []);
  });

  it("treats as legacy only ids the base cited as commits", () => {
    assert.equal(
      check(`Built from ${UNKNOWN}.\n`, PATH, `The checksum is ${UNKNOWN}.\n`)
        .length,
      1,
    );
    assert.deepEqual(
      check(`Built from ${UNKNOWN}.\n`, PATH, `Built from ${UNKNOWN}.\n`),
      [],
    );
  });

  it("asks only about the ids the change adds, and none without a base", () => {
    const text = `Built from ${UNKNOWN_2} and ${UNKNOWN}.\n`;
    assert.equal(check(text, PATH, `Built from ${UNKNOWN_2}.\n`).length, 1);
    assert.equal(check(text, PATH, null).length, 2);
    assert.deepEqual(unbranched(text), []);
  });

  it("names both ends of an abbreviated range and an id cut off", () => {
    const found = check("Between abc1234..def5678 the gate moved.\n");
    includes(found, 'abbreviated commit "abc1234"');
    includes(found, '"def5678" ends a range');
    includes(
      check("It stopped at 1234567… then.\n"),
      'abbreviated commit "1234567"',
    );
  });

  it("reads a commit word farther back as implying a commit", () => {
    includes(
      check("The fix landed earlier, see abc1234d for it.\n"),
      'abbreviated commit "abc1234d"',
    );
    includes(
      check(`The fix landed earlier, see ${BLOB} for it.\n`),
      "is a blob",
    );
  });

  it("reads a backticked token on its own as a commit", () => {
    includes(
      check("`abc1234def` is the one.\n"),
      'abbreviated commit "abc1234def"',
    );
    // A number or a word is not, nor a token only one side quotes.
    assert.deepEqual(check("Rows `1234567` moved.\n"), []);
    assert.deepEqual(check("Tag abc1234def` only.\n"), []);
    assert.deepEqual(check("Tag `abc1234def only.\n"), []);
    // Sixteen hex digits with no commit word: a Turbo task hash.
    assert.deepEqual(check("Task `abcdef0123456789` ran.\n"), []);
  });

  it("reads a label as naming the token, near or farther back", () => {
    assert.deepEqual(check("replaying `abc1234def`\n"), []);
    assert.deepEqual(
      check("The digest we kept from a long time ago was `abc1234def`.\n"),
      [],
    );
    assert.deepEqual(check(`cache miss, executing ${UNKNOWN}\n`), []);
  });

  it("reads no output line of a transcript", () => {
    assert.deepEqual(check(`${F}text\n$ run\nmerged abc1234d\n${F}\n`), []);
  });

  it("reads a data file line by line, commands included", () => {
    const path = "docs/research/0001-a/runs.csv";
    assert.deepEqual(check("name,sha\nrun,commit abc1234d\n", path), [
      {
        rule: "EVIDENCE-01",
        check: "abbreviated-id",
        file: path,
        line: 2,
        message:
          'abbreviated commit "abc1234d": cite the full 40-hex sha (git rev-parse abc1234d)',
      },
    ]);
    assert.deepEqual(check("step\ngit log --oneline -1\n", path), [
      {
        rule: "EVIDENCE-01",
        check: "abbreviating-command",
        file: path,
        line: 2,
        message:
          "a git command that prints abbreviated commits (--oneline, %h, --abbrev-commit, rev-parse --short); use %H or git rev-parse",
      },
    ]);
  });

  it("reports a range end, a URL and an unknown id with their checks", () => {
    assert.deepEqual(unbranched(`x\nRange ${UNKNOWN_2}..abc1234\n`), [
      {
        rule: "EVIDENCE-01",
        check: "abbreviated-id",
        file: PATH,
        line: 2,
        message:
          'abbreviated commit "abc1234" ends a range: cite the full 40-hex sha (git rev-parse abc1234)',
      },
    ]);
    assert.deepEqual(
      check("x\nhttps://github.com/acme/widgets/commit/abc1234\n"),
      [
        {
          rule: "EVIDENCE-01",
          check: "abbreviated-id",
          file: PATH,
          line: 2,
          message:
            'abbreviated commit URL "abc1234": link the full 40-hex sha (git rev-parse abc1234)',
        },
      ],
    );
    assert.deepEqual(check(`x\nBuilt from ${UNKNOWN_2}.\n`), [
      {
        rule: "EVIDENCE-01",
        check: "unresolved-id",
        file: PATH,
        line: 2,
        message: `${UNKNOWN_2} does not resolve in this repository (git cat-file -t ${UNKNOWN_2})`,
        ratchet: false,
      },
    ]);
    assert.deepEqual(check(`x\nBuilt from ${BLOB}.\n`), [
      {
        rule: "EVIDENCE-01",
        check: "unresolved-id",
        file: PATH,
        line: 2,
        message: `${BLOB} is cited as a commit but is a blob (git cat-file -t ${BLOB})`,
        ratchet: false,
      },
    ]);
  });

  it("asks the store nothing when the change adds no full id", () => {
    const asked: string[][] = [];
    commitIdentity(records)(PATH, "No ids here.\n", {
      typesOf: (shas) => {
        asked.push([...shas]);
        return new Map();
      },
      onHistory: (commits) => {
        asked.push([...commits]);
        return null;
      },
      baseText: () => null,
    });
    assert.deepEqual(asked, []);
  });

  it("asks the store once, for each new id once, and history only of commits", () => {
    const asked: string[][] = [];
    const history: string[][] = [];
    commitIdentity(records)(
      PATH,
      `Built from ${UNKNOWN}.\nMerged ${UNKNOWN} and ${COMMIT}.\nBlob ${BLOB}.\n`,
      {
        typesOf: (shas) => {
          asked.push([...shas]);
          return typesOf(shas);
        },
        onHistory: (commits) => {
          history.push([...commits]);
          return pushed(commits);
        },
        baseText: () => null,
      },
    );
    assert.deepEqual(asked, [[UNKNOWN, COMMIT, BLOB]]);
    assert.deepEqual(history, [[COMMIT]]);
    // No commit among the new ids: history is not asked.
    history.length = 0;
    commitIdentity(records)(PATH, `Built from ${UNKNOWN}.\n`, {
      typesOf,
      onHistory: (commits) => {
        history.push([...commits]);
        return null;
      },
      baseText: () => null,
    });
    assert.deepEqual(history, []);
  });

  it("refuses an added commit on no pushed history, however the line names it", () => {
    const offMain: TreeContext["onHistory"] = (commits) => ({
      unreached: new Set(commits.filter((c) => c === OTHER_COMMIT)),
      refs: ["origin/main", "origin/develop"],
    });
    const message = `${OTHER_COMMIT} is not on pushed history: it is neither an ancestor of HEAD nor of origin/main or origin/develop, so CI cannot resolve it. Cite a commit that is merged or on this branch.`;
    assert.deepEqual(
      check(
        `x\nBuilt from ${OTHER_COMMIT} and ${COMMIT}.\n${OTHER_COMMIT}\n`,
        PATH,
        null,
        records,
        offMain,
      ),
      [2, 3].map((line) => ({
        rule: "EVIDENCE-01",
        check: "unpushed-id",
        file: PATH,
        line,
        message,
        ratchet: false,
      })),
    );
    // Cited at the base already: legacy, not asked again.
    assert.deepEqual(
      check(
        `Built from ${OTHER_COMMIT}.\n`,
        PATH,
        `Built from ${OTHER_COMMIT}.\n`,
        records,
        offMain,
      ),
      [],
    );
  });

  it("says so when no base ref resolves, and judges nothing a shallow clone cannot", () => {
    const text = `Built from ${OTHER_COMMIT}.\n`;
    includes(
      check(text, PATH, null, records, (commits) => ({
        unreached: new Set(commits),
        refs: [],
      })),
      "neither an ancestor of HEAD nor of a base ref (none resolves in this clone), so CI",
    );
    assert.deepEqual(
      check(text, PATH, null, records, () => null),
      [],
    );
  });

  it("reads a megabyte line by bounded windows around each token", () => {
    const pad = "x ".repeat(500_000);
    const page = `<p>${pad}merged abc1234d ${pad}git ${pad}--oneline ${pad}https://github.com/octo/tools/commit/${UNKNOWN_2}</p>`;
    const found = check(`${page}\n`, "docs/research/0001-a/review.html");
    // The count first: a mutant that finds a token in every pad word fails
    // here, before assert prints and diffs half a million findings (veda#469).
    assert.equal(found.length, 1);
    assert.deepEqual(
      found.map((f) => f.check),
      ["abbreviated-id"],
    );
  });
});

describe("hexRole and citesAsCommit", () => {
  const roleOf = (line: string, token: string) =>
    hexRole(line, line.indexOf(token), token);
  const citedOf = (line: string, token: string) =>
    citesAsCommit(line, line.indexOf(token), token);

  it("reads a token's role from the words around it", () => {
    for (const [line, token, role] of [
      ["commit abc1234", "abc1234", "explicit"],
      ["abc1234..def5678", "abc1234", "explicit"],
      ["abc1234..def5678", "def5678", "explicit"],
      ["stopped at abc1234… then", "abc1234", "explicit"],
      ["stopped at abc1234... then", "abc1234", "explicit"],
      ["index abc1234..def5678 100644", "abc1234", "none"],
      ["cache hit, replaying abc1234def", "abc1234def", "label"],
      ["checksum abc1234def", "abc1234def", "label"],
      ["abc1234def is its digest", "abc1234def", "label"],
      ["a commit landed, see abc1234 for it", "abc1234", "implied"],
      [
        "the digest we kept from a long time ago was abc1234",
        "abc1234",
        "label",
      ],
      ["see abc1234 here", "abc1234", "none"],
    ] as const)
      assert.equal(roleOf(line, token), role, line);
  });

  it("cites a token as a commit by its role, length and quotes", () => {
    for (const [line, token, cited] of [
      ["commit abc1234", "abc1234", "explicit"],
      ["a commit landed, see abc1234", "abc1234", "implied"],
      ["checksum abc1234def", "abc1234def", null],
      ["see `abc1234def`", "abc1234def", "implied"],
      ["see `abcdef0123456789`", "abcdef0123456789", null],
      ["see abc1234def", "abc1234def", null],
      ["see `abc1234def", "abc1234def", null],
    ] as const)
      assert.equal(citedOf(line, token), cited, line);
  });

  it("reads a range only with an id on each side, at the token", () => {
    for (const [line, token, role] of [
      // The other side of the dots is a ref, not an id.
      ["abc1234d..feature", "abc1234d", "none"],
      ["feature..abc1234d", "abc1234d", "none"],
      // A range or an ellipsis farther along the line is not this token's.
      ["abc1234d and main..def5678", "abc1234d", "none"],
      ["abc1234..def5678 then 7654321", "7654321", "none"],
      ["see abc1234d, then... more", "abc1234d", "none"],
    ] as const)
      assert.equal(roleOf(line, token), role, line);
  });
});

describe("EVIDENCE-01: each word and boundary the rule reads", () => {
  const abbreviated = (line: number, token: string, file = PATH): Finding => ({
    rule: "EVIDENCE-01",
    check: "abbreviated-id",
    file,
    line,
    message: `abbreviated commit "${token}": cite the full 40-hex sha (git rev-parse ${token})`,
  });
  const rangeEnd = (line: number, token: string): Finding => ({
    rule: "EVIDENCE-01",
    check: "abbreviated-id",
    file: PATH,
    line,
    message: `abbreviated commit "${token}" ends a range: cite the full 40-hex sha (git rev-parse ${token})`,
  });
  const unresolved = (line: number, sha: string, file = PATH): Finding => ({
    rule: "EVIDENCE-01",
    check: "unresolved-id",
    file,
    line,
    message: `${sha} does not resolve in this repository (git cat-file -t ${sha})`,
    ratchet: false,
  });
  const at = (text: string): number[] =>
    check(text)
      .filter((f) => f.check === "abbreviating-command")
      .map((f) => f.line);

  it("reads each commit word in its bare form", () => {
    for (const word of [
      "merge",
      "push",
      "revert",
      "cherry-pick",
      "rebase",
      "fix in",
    ])
      assert.deepEqual(
        check(`${word} abc1234d\n`),
        [abbreviated(1, "abc1234d")],
        word,
      );
  });

  it("reads a JSON base key with or without a space before its colon", () => {
    for (const line of ['{"base":"abc1234d"}', '{"base" : "abc1234d"}'])
      assert.deepEqual(
        check(`${line}\n`),
        [abbreviated(1, "abc1234d")],
        line,
      );
  });

  it("reads each hash label in its singular and joined forms", () => {
    for (const label of [
      "sha512",
      "fingerprint",
      "etag",
      "hash",
      "key",
      "nonce",
      "uuid",
      "runid",
      "run-id",
      "version",
      "state-list",
    ])
      assert.deepEqual(check(`The ${label} \`abc1234def\`.\n`), [], label);
  });

  it("reads a label within twenty characters before or 24 after the token", () => {
    // The checksum ends 21 characters before the token, the commit word
    // farther back: the label is not at the token, so the word implies it.
    assert.deepEqual(
      check("merged a while; the checksum, read it back as: `abc1234def`.\n"),
      [abbreviated(1, "abc1234def")],
    );
    assert.deepEqual(
      check("merged then `abc1234def` and, much later on, its checksum.\n"),
      [abbreviated(1, "abc1234def")],
    );
  });

  it("reads a task hash's prefix only right before the token", () => {
    assert.deepEqual(check("Replaying the log found commit abc1234d.\n"), [
      abbreviated(1, "abc1234d"),
    ]);
  });

  it("holds an implied all-letter token to be a word", () => {
    assert.deepEqual(
      check("The fix landed earlier, see deadbeef for it.\n"),
      [],
    );
  });

  it("reads a one-character ref and a bare ~ or ^ before a range's dots", () => {
    assert.deepEqual(unbranched("Compare v..abc1234 first.\n"), [
      rangeEnd(1, "abc1234"),
    ]);
    assert.deepEqual(unbranched("Compare HEAD^..abc1234 first.\n"), [
      rangeEnd(1, "abc1234"),
    ]);
    assert.deepEqual(unbranched("Compare HEAD~..abc1234 first.\n"), [
      rangeEnd(1, "abc1234"),
    ]);
  });

  it("reads no range across dots a path leaves", () => {
    assert.deepEqual(unbranched("Path docs/...abc1234 here.\n"), []);
    assert.deepEqual(unbranched("Path x. ..abc1234 here.\n"), []);
  });

  it("reads a diff's index header only where it starts the line", () => {
    assert.deepEqual(unbranched("Reindex main..abc1234 first.\n"), [
      rangeEnd(1, "abc1234"),
    ]);
  });

  it("reads a captured log by its last extension only", () => {
    const path = "docs/research/0001-a/notes.txt.md";
    assert.deepEqual(check("merged abc1234d\n", path), [
      abbreviated(1, "abc1234d", path),
    ]);
  });

  it("reads a data file by its last extension, fences as lines", () => {
    const path = "docs/research/0001-a/notes.md.csv";
    assert.deepEqual(check(`${F}text\nmerged abc1234d\n${F}\n`, path), [
      abbreviated(2, "abc1234d", path),
    ]);
  });

  it("reads a transcript command only at a bare `$ ` prompt", () => {
    assert.deepEqual(
      check(`${F}text\n$ run\nuser@host:~$ git log --oneline\n${F}\n`),
      [],
    );
    // A command continued into the closing marker ends there.
    assert.deepEqual(check(`${F}text\n$ git log \\\n${F}\n`), []);
    // Printed output ending in a backslash continues no command.
    assert.deepEqual(
      check(`${F}text\n$ run\nsome output \\\ngit log --oneline\n${F}\n`),
      [],
    );
  });

  it("joins a continued command only at a trailing backslash", () => {
    assert.deepEqual(at("Run git log 'a\\b' x\n--oneline here.\n"), []);
    // The backslash goes, so `rev-parse` and `--short` still meet.
    assert.deepEqual(at(`${F}sh\ngit rev-parse \\\n  --short HEAD\n${F}\n`), [
      2,
    ]);
    // A command after a continued one is reported at its own line.
    assert.deepEqual(at(`${F}sh\ngit log \\\n  -1\ngit log --oneline\n${F}\n`), [
      4,
    ]);
  });

  it("reads rev-parse --short across any run of spaces", () => {
    assert.deepEqual(at("git rev-parse  --short HEAD\n"), [1]);
  });

  it("restores full ids after --abbrev-commit, and with a bare --no-abbrev", () => {
    for (const command of [
      "git log --abbrev-commit --no-abbrev-commit -1",
      "git log --oneline --no-abbrev -1",
    ])
      assert.deepEqual(check(`${command}\n`), [], command);
    // `--no-abbrev-commit` undoes no `rev-parse --short`.
    assert.deepEqual(
      at("git rev-parse --short HEAD && git log --no-abbrev-commit -1\n"),
      [1],
    );
  });

  it("escapes the repository's name in its commit URL", () => {
    const dotted = { identityPaths: [/./], repository: "acme/my.repo" };
    assert.deepEqual(
      check(
        "See https://github.com/acme/my.repo/commit/abc1234.\n",
        PATH,
        null,
        dotted,
      ),
      [
        {
          rule: "EVIDENCE-01",
          check: "abbreviated-id",
          file: PATH,
          line: 1,
          message:
            'abbreviated commit URL "abc1234": link the full 40-hex sha (git rev-parse abc1234)',
        },
      ],
    );
  });

  it("with no repository, reads the word null as no URL", () => {
    const none = { identityPaths: [/./], repository: null };
    assert.deepEqual(check("Its result was null.\n", PATH, null, none), []);
  });

  it("reads a test merge's arrow across any run of spaces, and a refs/ prefix", () => {
    const sha = "fedcba9876543210fedcba9876543210fedcba98";
    for (const named of [
      `${sha}  ->  pull/1/merge`,
      `${sha} -> refs/pull/7/merge`,
    ])
      assert.deepEqual(check(`${sha}\n${named}\n`, LOG), [], named);
  });

  it("skips only git's all-zero null id", () => {
    const sha = "fedcba9876543210fedcba9876543210fedcba90";
    assert.deepEqual(check(`Built from ${sha}.\n`), [unresolved(1, sha)]);
  });

  it("reads another repository's URL or action only right before the id", () => {
    const sha = "fedcba9876543210fedcba9876543210fedcba98";
    assert.deepEqual(
      check(`https://github.com/octo/tools/commit/x is not it; built from ${sha}.\n`),
      [unresolved(1, sha)],
    );
    const other = "0123456789abcdef0123456789abcdef01234567";
    assert.deepEqual(
      check(
        `Download action repository 'actions/checkout@v4' (SHA:${other}) then ${sha}\n`,
        LOG,
      ),
      [unresolved(1, sha, LOG)],
    );
  });

  it("treats as legacy an id the base printed bare", () => {
    const sha = "fedcba9876543210fedcba9876543210fedcba98";
    assert.deepEqual(check(`${sha}\n`, LOG, `${sha}\n`), []);
  });

  it("asks pushed history only of commits, whatever it answers", () => {
    const commit = "303d6a0be64dae6588efd4cf4a86c40be6638301";
    const blob = "8f2a1c0d9e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39";
    assert.deepEqual(
      check(`${commit}\n${blob}\n`, LOG, null, records, () => ({
        unreached: new Set([blob]),
        refs: ["origin/main"],
      })),
      [],
    );
  });

  it("reads a file only when an identity path matches it", () => {
    const two = { identityPaths: [/^docs\//, /^notes\//], repository: null };
    assert.deepEqual(check("merged abc1234d\n", PATH, null, two), [
      abbreviated(1, "abc1234d"),
    ]);
  });
});
