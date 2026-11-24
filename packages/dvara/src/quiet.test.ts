import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isQuiet, successLine, successNotices } from "./quiet.ts";

describe("isQuiet", () => {
  it("holds only the listed hooks, unless verbose", () => {
    assert.equal(isQuiet("pre-commit", ["pre-commit"], {}), true);
    assert.equal(isQuiet("pre-push", ["pre-commit"], {}), false);
    assert.equal(
      isQuiet("pre-commit", ["pre-commit"], { DVARA_VERBOSE: "1" }),
      false,
    );
  });
});

describe("successNotices", () => {
  it("keeps each warning and the indented lines that continue it", () => {
    const text = [
      "→ checking",
      "⚠️  partial staging",
      "   only some hunks",
      "next",
      "  indented but not a notice",
      " ⚠ second",
    ].join("\n");
    assert.deepEqual(successNotices(text), [
      "⚠️  partial staging",
      "   only some hunks",
      " ⚠ second",
    ]);
  });

  it("keeps no indented line before the first warning", () => {
    assert.deepEqual(successNotices("  indented first\n⚠ warned"), [
      "⚠ warned",
    ]);
  });

  it("continues a warning only with lines indented before their text", () => {
    const text = [
      "⚠ warned",
      " one space",
      "\tone tab",
      "   ",
      "  after a blank",
      "⚠ again",
      "text  with inner spaces",
    ].join("\n");
    assert.deepEqual(successNotices(text), [
      "⚠ warned",
      " one space",
      "\tone tab",
      "⚠ again",
    ]);
  });
});

describe("successLine", () => {
  it("names the hook, its time and the log", () => {
    assert.equal(
      successLine("pre-commit", 1234, ".dvara/pre-commit.log"),
      "✅ pre-commit passed in 1.2s (full output: .dvara/pre-commit.log)",
    );
  });
});
