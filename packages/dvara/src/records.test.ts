import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRecords, parseStages, recordedMs, treeUsage } from "./records.ts";

describe("parseRecords", () => {
  it("tells no records file from an empty one", () => {
    assert.equal(parseRecords(null).pushed, null);
    assert.deepEqual(parseRecords("").pushed, { source: "none", refs: [] });
  });

  it("parses every record kind and ignores the rest", () => {
    const text = [
      "refs-source\tstdin",
      "ref\taaa\tbbb",
      "stage-input\tlint\tdigest\tabc",
      "proof\ttests\treused\t120",
      "proof\ttests\tran\tjunk",
      "proof-reason\ttests\tunchanged\t5\t\tInfinity",
      "something-else\tx",
      "",
    ].join("\n");
    const records = parseRecords(text);
    assert.deepEqual(records.pushed, {
      source: "stdin",
      refs: [{ local: "aaa", remote: "bbb" }],
    });
    assert.deepEqual(
      [...records.declared],
      [["lint", { kind: "digest", digest: "abc" }]],
    );
    assert.deepEqual(records.proof, [
      { check: "tests", outcome: "reused", ms: 120 },
      { check: "tests", outcome: "ran", ms: null },
    ]);
    assert.deepEqual(records.proofDiagnostics, [
      {
        check: "tests",
        reason: "unchanged",
        waitMs: 5,
        executionMs: null,
        previousExecutionMs: null,
      },
    ]);
  });

  it("fills missing fields with empty text", () => {
    const records = parseRecords(
      "refs-source\nref\nstage-input\nproof\nproof-reason",
    );
    assert.deepEqual(records.pushed, {
      source: "",
      refs: [{ local: "", remote: "" }],
    });
    assert.deepEqual([...records.declared], [["", { kind: "", digest: "" }]]);
    assert.deepEqual(records.proof, [{ check: "", outcome: "", ms: null }]);
    assert.equal(records.proofDiagnostics[0]?.check, "");
    assert.equal(records.proofDiagnostics[0]?.reason, "");
  });
});

describe("recordedMs", () => {
  it("reads empty and non-finite as null", () => {
    assert.equal(recordedMs(undefined), null);
    assert.equal(recordedMs(""), null);
    assert.equal(recordedMs("NaN"), null);
    assert.equal(recordedMs("7"), 7);
  });
});

describe("parseStages", () => {
  it("reads markers in seconds and keeps junk times as NaN", () => {
    assert.deepEqual(parseStages("0\tstartup\n2\tlint\nx\tbad\n", 0), [
      { name: "startup", startMs: 0 },
      { name: "lint", startMs: 2000 },
      { name: "bad", startMs: Number.NaN },
    ]);
  });

  it("offsets markers by the runtime selection, a stage of its own", () => {
    assert.deepEqual(parseStages("1\tlint", 3000), [
      { name: "runtime-selection", startMs: 0 },
      { name: "lint", startMs: 4000 },
    ]);
  });

  it("has no stages without markers, and names a nameless one empty", () => {
    assert.deepEqual(parseStages(null, 0), []);
    assert.deepEqual(parseStages("4", 0), [{ name: "", startMs: 4000 }]);
  });
});

describe("treeUsage", () => {
  it("sums the resident memory of one process tree", () => {
    const table = [
      "  10   1  100",
      "  11  10  200",
      "  12  11  300",
      "  20   1  999",
      "",
    ].join("\n");
    assert.deepEqual(treeUsage(table, 10), { rssKiB: 600, processes: 3 });
  });

  it("counts a root missing from the table as one process using nothing", () => {
    assert.deepEqual(treeUsage("5 1 50", 99), { rssKiB: 0, processes: 1 });
    assert.deepEqual(treeUsage("99", 99), { rssKiB: 0, processes: 1 });
  });
});
