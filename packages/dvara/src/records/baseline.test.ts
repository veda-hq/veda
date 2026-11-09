import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  baselineIncreases,
  countFindings,
  parseBaseline,
  ratchet,
  renderBaseline,
  staleEntries,
  type Baseline,
} from "./baseline.ts";
import type { Finding, RuleId } from "./types.ts";

const WHERE = "records-baseline.json";
const parse = (text: string | null) => parseBaseline(text, WHERE);

const at = (file: string, rule: RuleId, line: number): Finding => ({
  rule,
  check: rule,
  file,
  line,
  message: "m",
});

describe("baseline", () => {
  it("parses, renders sorted and drops zero counts", () => {
    const parsed = parse(
      '{"files": {"b": {"EVIDENCE-02": 1}, "a": {"EVIDENCE-01": 2}}}',
    );
    assert.equal(
      renderBaseline(parsed),
      '{\n  "files": {\n    "a": {\n      "EVIDENCE-01": 2\n    },\n    "b": {\n      "EVIDENCE-02": 1\n    }\n  }\n}\n',
    );
    assert.deepEqual(Object.keys(parse(null).files), []);
    assert.deepEqual(Object.keys(parse("  \n").files), []);
  });

  it("keeps a file named __proto__ as its own entry", () => {
    const parsed = parse('{"files": {"__proto__": {"EVIDENCE-01": 1}}}');
    assert.deepEqual(Object.keys(parsed.files), ["__proto__"]);
    assert.match(renderBaseline(parsed), /"__proto__"/);
    assert.equal(parse(null).files["constructor"], undefined);
  });

  it("refuses what it cannot read, naming the file", () => {
    for (const [text, message] of [
      ['{"files": ', "JSON"],
      ["not json", "JSON"],
      ["[]", 'expected {"files": {...}}'],
      ["null", 'expected {"files": {...}}'],
      ["1", 'expected {"files": {...}}'],
      ["{}", 'expected {"files": {...}}'],
      ['{"files": []}', '"files" must be an object'],
      ['{"files": null}', '"files" must be an object'],
      ['{"files": 1}', '"files" must be an object'],
      ['{"files": {"a": 1}}', "a must map rule ids to counts"],
      ['{"files": {"a": null}}', "a must map rule ids to counts"],
      ['{"files": {"a": [1]}}', "a must map rule ids to counts"],
      ['{"files": {"a": {"NOPE-01": 1}}}', "a names unknown rule NOPE-01"],
      [
        '{"files": {"a": {"EVIDENCE-01": 0}}}',
        "EVIDENCE-01 must be a positive",
      ],
      [
        '{"files": {"a": {"EVIDENCE-01": 1.5}}}',
        "EVIDENCE-01 must be a positive",
      ],
      [
        '{"files": {"a": {"EVIDENCE-01": "2"}}}',
        "EVIDENCE-01 must be a positive",
      ],
    ] as const)
      assert.throws(
        () => parse(text),
        (error: Error) =>
          error.message.startsWith(`${WHERE}: `) &&
          error.message.includes(message),
        text,
      );
  });

  it("renders only positive counts, and no file left with none", () => {
    const rendered = renderBaseline({
      files: {
        a: { "EVIDENCE-01": 0, "EVIDENCE-02": 1 },
        b: { "EVIDENCE-01": 0 },
      },
    });
    assert.deepEqual(JSON.parse(rendered), {
      files: { a: { "EVIDENCE-02": 1 } },
    });
  });

  it("counts findings per file and rule", () => {
    assert.deepEqual(
      [
        ...countFindings([
          at("a", "EVIDENCE-01", 1),
          at("a", "EVIDENCE-01", 2),
          at("b", "EVIDENCE-02", 1),
        ]),
      ],
      [
        ["a", { "EVIDENCE-01": 2 }],
        ["b", { "EVIDENCE-02": 1 }],
      ],
    );
  });

  it("lists only the held findings of the file and rule that went over", () => {
    const findings: Finding[] = [
      at("a", "EVIDENCE-01", 1),
      at("a", "EVIDENCE-01", 2),
      at("a", "EVIDENCE-02", 3),
      at("b", "EVIDENCE-01", 4),
      { ...at("a", "EVIDENCE-01", 5), ratchet: false },
    ];
    const result = ratchet(
      ["a"],
      findings,
      parse('{"files": {"a": {"EVIDENCE-01": 1}}}'),
    );
    assert.deepEqual(
      result.over.map((o) => [
        o.rule,
        o.allowed,
        o.now,
        o.findings.map((f) => f.line),
      ]),
      [
        ["EVIDENCE-01", 0, 1, [5]],
        ["EVIDENCE-01", 1, 2, [1, 2]],
        ["EVIDENCE-02", 0, 1, [3]],
      ],
    );
  });

  it("goes over past the allowance alone, listing every finding of that rule", () => {
    const one = parse('{"files": {"a": {"EVIDENCE-01": 1}}}');
    const [f1, f2] = [at("a", "EVIDENCE-01", 1), at("a", "EVIDENCE-01", 2)];
    assert.deepEqual(ratchet(["a"], [f1], one), { over: [], under: [] });
    assert.deepEqual(ratchet(["a"], [f1, f2], one).over, [
      {
        file: "a",
        rule: "EVIDENCE-01",
        allowed: 1,
        now: 2,
        findings: [f1, f2],
      },
    ]);
    // A file the change did not check answers for nothing.
    assert.deepEqual(ratchet([], [f1, f2], one), { over: [], under: [] });
  });

  it("carries a renamed entry only when the old one is gone and no count rises", () => {
    const before: Baseline = { files: { a: { "EVIDENCE-01": 2 } } };
    const renamed = new Map([["b", "a"]]);
    const refused = (after: Baseline, renames = renamed) =>
      baselineIncreases(before, after, renames);
    assert.deepEqual(refused({ files: { b: { "EVIDENCE-01": 2 } } }), []);
    // The old entry is still there: the rename would fund a second file.
    assert.deepEqual(
      refused({ files: { a: { "EVIDENCE-01": 2 }, b: { "EVIDENCE-01": 1 } } }),
      [
        "b: a new baseline entry; fix the file instead of recording its findings",
      ],
    );
    // The old path had no entry to carry.
    assert.equal(
      refused({ files: { b: { "EVIDENCE-01": 1 } } }, new Map([["b", "z"]]))
        .length,
      1,
    );
    // A count higher than the old entry's, or a rule it never held.
    assert.equal(refused({ files: { b: { "EVIDENCE-01": 3 } } }).length, 1);
    assert.equal(refused({ files: { b: { "EVIDENCE-02": 1 } } }).length, 1);
  });

  it("names a raised count with both numbers", () => {
    const before: Baseline = { files: { a: { "EVIDENCE-01": 2 } } };
    assert.deepEqual(
      baselineIncreases(before, {
        files: { a: { "EVIDENCE-01": 3, "EVIDENCE-02": 1 } },
      }),
      [
        "a: EVIDENCE-01 raised from 2 to 3; counts only fall",
        "a: EVIDENCE-02 raised from 0 to 1; counts only fall",
      ],
    );
  });

  it("ratchets, finds stale entries and refuses raises but carries a rename", () => {
    const base: Baseline = { files: { a: { "EVIDENCE-01": 2 } } };
    const finding = at("a", "EVIDENCE-01", 1);
    assert.equal(ratchet(["a"], [finding], base).under.length, 1);
    assert.equal(
      ratchet(["a"], [finding, finding, finding], base).over[0]?.now,
      3,
    );
    assert.deepEqual(
      staleEntries(base, () => false),
      ["a"],
    );
    assert.deepEqual(
      staleEntries(base, () => true),
      [],
    );
    // A finding no baseline may hold cannot spend another's allowance.
    const unheld: Finding = { ...finding, ratchet: false };
    const spent = ratchet(["a"], [finding, finding, unheld], base);
    assert.deepEqual(
      spent.over.map((o) => [o.allowed, o.now]),
      [[0, 1]],
    );
    assert.deepEqual(spent.under, []);
    assert.deepEqual(
      baselineIncreases(
        base,
        { files: { b: { "EVIDENCE-01": 1 } } },
        new Map([["b", "a"]]),
      ),
      [],
    );
    // Fixing a and dropping its entry funds nothing elsewhere: no rename.
    assert.match(
      baselineIncreases(base, { files: { b: { "EVIDENCE-01": 1 } } })[0] ?? "",
      /new baseline entry/,
    );
    assert.match(
      baselineIncreases(base, { files: { a: { "EVIDENCE-01": 3 } } })[0] ?? "",
      /raised/,
    );
  });
});
