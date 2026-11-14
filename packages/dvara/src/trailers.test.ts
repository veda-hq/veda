import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { hermeticEnv, repo } from "./records/fixture.test.ts";
import {
  ADVICE,
  GIT_TRAILER_KEYS,
  misplacedTrailers,
  refusal,
} from "./trailers.ts";

const KEYS = [...GIT_TRAILER_KEYS, "Slice", "Removes-File"];

const lines = (message: string, keys: readonly string[] = KEYS) =>
  misplacedTrailers(message, keys).map(({ line, text }) => `${line} ${text}`);

describe("misplacedTrailers", () => {
  it("passes trailers in the final block", () => {
    assert.deepEqual(
      lines("feat: x\n\nBody text.\n\nSlice: L-04\nCo-Authored-By: A <a@a>\n"),
      [],
    );
  });

  it("finds a trailer line above a blank line, by its line in the file", () => {
    assert.deepEqual(
      lines(
        "feat: x\n\nSlice: L-04\n\nCo-Authored-By: A <a@a>\nSigned-off-by: B <b@b>\n",
      ),
      ["3 Slice: L-04"],
    );
  });

  it("finds every misplaced one, in every earlier paragraph", () => {
    assert.deepEqual(
      lines(
        "feat: x\nslice: L-04\n\nRemoves-File: a.ts\nprose\n\nCO-AUTHORED-BY: A <a@a>\n",
      ),
      ["2 slice: L-04", "4 Removes-File: a.ts"],
    );
  });

  it("reads a key case-insensitively, with or without space before the value", () => {
    assert.deepEqual(
      lines("feat: x\n\nsigned-off-by :B\nco-authored-by:A\n\nend\n"),
      ["3 signed-off-by :B", "4 co-authored-by:A"],
    );
  });

  it("ignores keys it does not know, and lines that only look like one", () => {
    assert.deepEqual(
      lines(
        "feat: x\n\nNote: not a trailer\n  Slice: indented\nA Slice: mid-line\nSlice-Two: other\n\nSlice: L-04\n",
      ),
      [],
    );
  });

  it("reads a repository's keys only when given", () => {
    const message = "feat: x\n\nSlice: L-04\n\nCo-Authored-By: A <a@a>\n";
    assert.deepEqual(lines(message, GIT_TRAILER_KEYS), []);
    assert.deepEqual(lines(message), ["3 Slice: L-04"]);
  });

  it("drops comment lines: they neither split nor end a paragraph", () => {
    assert.deepEqual(
      lines(
        "feat: x\n\nBody.\n# a comment\nSlice: L-04\n# Please enter the commit message\n#\n",
      ),
      [],
    );
    assert.deepEqual(
      lines("feat: x\n\nSlice: L-04\n\n# comment\nCo-Authored-By: A <a@a>\n"),
      ["3 Slice: L-04"],
    );
  });

  it("counts a whitespace-only line as blank, and trailing blanks start no paragraph", () => {
    assert.deepEqual(
      lines("feat: x\n\nSlice: L-04\n \t\nCo-Authored-By: A <a@a>\n\n\n  \n"),
      ["3 Slice: L-04"],
    );
    assert.deepEqual(lines("feat: x\n\nCo-Authored-By: A <a@a>\n\n\n"), []);
  });

  it("stops at the scissors line, so a diff below it is not the message", () => {
    assert.deepEqual(
      lines(
        [
          "feat: x",
          "",
          "Slice: L-04",
          "# ------------------------ >8 ------------------------",
          "# Do not modify or remove the line above.",
          "diff --git a/x b/x",
          "",
          "+Signed-off-by: someone in the diff",
          "",
          "more diff",
        ].join("\n"),
      ),
      [],
    );
  });

  it("reads CRLF messages", () => {
    assert.deepEqual(
      lines("feat: x\r\n\r\nSlice: L-04\r\n\r\nCo-Authored-By: A\r\n"),
      ["3 Slice: L-04"],
    );
  });

  it("never judges the title line, even one that reads as a trailer", () => {
    assert.deepEqual(lines("Slice: L-04\n\nBody.\n"), []);
    assert.deepEqual(lines("Slice: L-04\n"), []);
    assert.deepEqual(lines(""), []);
    assert.deepEqual(lines("# only a comment\n"), []);
  });

  it("agrees with git about which trailers it reads", () => {
    const r = repo("dvara-trailers-");
    r.write("a", "a\n");
    const message =
      "feat: x\n\nCo-Authored-By: Lost <l@l>\n\nSigned-off-by: Kept <k@k>\n";
    r.write("msg", message);
    r.git("add", "a");
    r.git("commit", "-q", "-F", "msg");
    const read = execFileSync(
      "git",
      ["log", "-1", "--format=%(trailers:only,unfold)"],
      { cwd: r.root, env: hermeticEnv, encoding: "utf8" },
    );
    assert.equal(read.trim(), "Signed-off-by: Kept <k@k>");
    assert.deepEqual(lines(message), ["3 Co-Authored-By: Lost <l@l>"]);
  });

  it("refuses a trailer in the title's paragraph, which git never reads", () => {
    // Git takes the first paragraph for the title, so a trailer in it is
    // lost even when it is the only paragraph.
    const r = repo("dvara-trailers-");
    r.write("a", "a\n");
    const message = "feat: x\nSigned-off-by: Lost <l@l>\n";
    r.write("msg", message);
    r.git("add", "a");
    r.git("commit", "-q", "-F", "msg");
    const read = execFileSync(
      "git",
      ["log", "-1", "--format=%(trailers:only,unfold)"],
      { cwd: r.root, env: hermeticEnv, encoding: "utf8" },
    );
    assert.equal(read.trim(), "");
    assert.deepEqual(lines(message), ["2 Signed-off-by: Lost <l@l>"]);
    assert.deepEqual(lines("feat: x\nSlice: L-04\n\nBody.\n"), [
      "2 Slice: L-04",
    ]);
  });
});

describe("refusal", () => {
  it("names the file, each line and what to do", () => {
    assert.deepEqual(
      refusal(".git/COMMIT_EDITMSG", [{ line: 3, text: "Slice: L-04" }]),
      [
        "❌ trailers: .git/COMMIT_EDITMSG has trailer lines git does not read (above a blank line, or in the title's paragraph):",
        "  .git/COMMIT_EDITMSG:3 Slice: L-04",
        ADVICE,
      ],
    );
    assert.equal(
      ADVICE,
      "Git reads trailers only from the last paragraph. Move these lines into the final block with no blank line between them (one `-F <file>` message), then check with `git log -1 --format=%(trailers)`.",
    );
  });
});
