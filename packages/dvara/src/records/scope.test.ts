import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULTS, type RecordsConfig } from "../config.ts";
import { rulesFor } from "./rules.ts";
import { isCodePath, isFrozenPath, isReadPath, isTextPath } from "./scope.ts";

const RECORDS: RecordsConfig = {
  ...DEFAULTS.records,
  skip: ["tools/records/"],
  frozen: { paths: ["docs/archive/"], except: ["docs/archive/README.md"] },
};

describe("scope", () => {
  it("freezes what is under a frozen prefix, except the exact live paths", () => {
    const { frozen } = RECORDS;
    assert.equal(isFrozenPath("docs/archive/0001/x.md", frozen), true);
    assert.equal(isFrozenPath("docs/archive/README.md", frozen), false);
    assert.equal(isFrozenPath("docs/archive/0001/README.md", frozen), true);
    assert.equal(isFrozenPath("docs/archived.md", frozen), false);
    assert.equal(
      isFrozenPath("docs/archive/x.md", DEFAULTS.records.frozen),
      false,
    );
  });

  it("tells binaries, lockfiles and code from text", () => {
    for (const path of [
      "a.png",
      "b.PDF",
      "pnpm-lock.yaml",
      "x/package-lock.json",
      "yarn.lock",
    ])
      assert.equal(isTextPath(path), false, path);
    for (const path of ["a.md", "b.json", "c.txt", "lock.md"])
      assert.equal(isTextPath(path), true, path);
    assert.equal(isCodePath("src/a.ts"), true);
    assert.equal(isCodePath("docs/a.md"), false);
  });

  it("reads no binary, own, skipped or frozen path", () => {
    const own = [".dvara.json", DEFAULTS.records.baseline];
    for (const path of [
      "a.png",
      ".dvara.json",
      DEFAULTS.records.baseline,
      "tools/records/notes.md",
      "docs/archive/x.md",
    ])
      assert.equal(isReadPath(path, RECORDS, own), false, path);
    for (const path of [
      "docs/a.md",
      "docs/archive/README.md",
      "tools/other.md",
    ])
      assert.equal(isReadPath(path, RECORDS, own), true, path);
  });
});

describe("rulesFor", () => {
  it("ships the durable-path rule under the configured settings", () => {
    const tree = { typesOf: () => new Map(), baseText: () => undefined };
    const rules = rulesFor({ ...RECORDS, packageManager: "pnpm" });
    assert.equal(rules.length, 1);
    assert.deepEqual(
      rules
        .flatMap((rule) => rule("docs/a.md", "run npm install\n", tree))
        .map((f) => f.check),
      ["install-command"],
    );
  });
});
