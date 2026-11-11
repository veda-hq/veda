import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULTS } from "./config.ts";
import {
  parseStageLists,
  readStageLists,
  stageRefusal,
  stageViolation,
} from "./stages.ts";

const LISTS = { "pre-push": ["deps", "lint", "test", "lint", "review"] };

describe("stageViolation", () => {
  it("passes marks that keep to the list, its own stages included", () => {
    for (const marked of [
      [],
      ["startup"],
      ["runtime-selection", "startup", "deps", "test"],
      ["deps", "lint", "test", "lint", "review"],
      ["lint", "lint", "review"],
      ["test", "lint"],
    ])
      assert.equal(
        stageViolation("pre-push", marked, LISTS),
        null,
        marked.join(","),
      );
  });

  it("names a stage the list lacks, one out of order, and a hook with no list", () => {
    assert.equal(
      stageViolation("pre-push", ["startup", "deps", "typo"], LISTS),
      'pre-push marked stage "typo", which its stage list does not have',
    );
    assert.equal(
      stageViolation("pre-push", ["review", "deps"], LISTS),
      'pre-push marked stage "deps" after "review", out of its stage list\'s order',
    );
    assert.equal(
      stageViolation("pre-commit", ["startup", "format"], LISTS),
      'pre-commit marked stage "format", but the stage list has no pre-commit list',
    );
    assert.equal(
      stageViolation("toString", ["format"], LISTS),
      'toString marked stage "format", but the stage list has no toString list',
    );
  });
});

describe("stageRefusal", () => {
  it("reads nothing for a run that marked only its own stages", () => {
    assert.equal(
      stageRefusal("post-merge", ["startup"], () => {
        throw new Error("read");
      }),
      null,
    );
  });

  it("refuses a run whose list cannot be read, or that broke it", () => {
    assert.equal(
      stageRefusal("pre-push", ["lint"], () => {
        throw new Error("dvara: cannot read the stage list x");
      }),
      "dvara: cannot read the stage list x",
    );
    assert.equal(
      stageRefusal("pre-push", ["typo"], () => LISTS),
      'dvara: pre-push marked stage "typo", which its stage list does not have.',
    );
    assert.equal(
      stageRefusal("pre-push", ["lint"], () => LISTS),
      null,
    );
    assert.equal(
      stageRefusal("pre-push", ["anything"], () => null),
      null,
    );
  });
});

describe("parseStageLists", () => {
  it("keeps each hook's names", () => {
    assert.deepEqual(parseStageLists(LISTS, "x"), LISTS);
    assert.deepEqual(parseStageLists({}, "x"), {});
    const odd = parseStageLists(JSON.parse('{"__proto__": ["a"]}'), "x");
    assert.equal(stageViolation("__proto__", ["a"], odd), null);
  });

  it("refuses anything but a map of name lists", () => {
    for (const value of [
      null,
      [],
      "a",
      { a: "b" },
      { a: [1] },
      { a: [""] },
      { a: ["x\ty"] },
      { a: ["x\ny"] },
    ])
      assert.throws(
        () => parseStageLists(value, "the stage list"),
        /the stage list/,
        JSON.stringify(value),
      );
  });
});

describe("readStageLists", () => {
  const root = () => mkdtempSync(join(tmpdir(), "dvara-stages-"));

  it("uses the config's lists when no file is named, and none when they are empty", () => {
    assert.equal(readStageLists("/", DEFAULTS), null);
    assert.deepEqual(
      readStageLists("/", { ...DEFAULTS, stages: LISTS }),
      LISTS,
    );
  });

  it("reads the named file from the root", () => {
    const dir = root();
    writeFileSync(join(dir, "stages.json"), JSON.stringify(LISTS));
    assert.deepEqual(
      readStageLists(dir, { ...DEFAULTS, stageList: "stages.json" }),
      LISTS,
    );
  });

  it("names a file it cannot read, and one it cannot use", () => {
    const dir = root();
    const config = { ...DEFAULTS, stageList: "stages.json" };
    assert.throws(
      () => readStageLists(dir, config),
      /cannot read the stage list .*stages\.json: .*Is the package that ships it installed\?/,
    );
    writeFileSync(join(dir, "stages.json"), "{");
    assert.throws(() => readStageLists(dir, config), /stages\.json: /);
    writeFileSync(join(dir, "stages.json"), '{"pre-push": "lint"}');
    assert.throws(
      () => readStageLists(dir, config),
      /stages\.json: the stage list\.pre-push must be a list/,
    );
  });
});
