// The shell helpers, run in real bash.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const STAGES = resolve(import.meta.dirname, "..", "shell", "stages.sh");
const KEEP_GOING = resolve(import.meta.dirname, "..", "shell", "keep-going.sh");

const bash = (script: string, env: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
};

describe("stages.sh", () => {
  it("writes stage markers and records where the supervisor says", () => {
    const dir = mkdtempSync(join(tmpdir(), "dvara-sh-"));
    const stages = join(dir, "s");
    const records = join(dir, "r");
    const result = bash(
      [
        `source '${STAGES}'`,
        "dvara_stage lint",
        "dvara_record stage-input lint digest abc",
        'dvara_record_refs ""',
        'dvara_record_refs "l1 aaa r1 bbb"',
        'echo "$DVARA_CURRENT_STAGE"',
      ].join("\n"),
      { DVARA_STAGE_FILE: stages, DVARA_RECORD_FILE: records },
    );
    assert.equal(result.code, 0);
    assert.equal(result.out, "lint\n");
    assert.match(readFileSync(stages, "utf8"), /^\d+\tstartup\n\d+\tlint\n$/);
    assert.equal(
      readFileSync(records, "utf8"),
      "stage-input\tlint\tdigest\tabc\nrefs-source\tnone\nrefs-source\tstdin\nref\taaa\tbbb\n",
    );
  });

  it("does nothing outside the supervisor, and never fails the hook", () => {
    assert.equal(
      bash(`source '${STAGES}'; dvara_stage x; dvara_record a b; echo ok`).out,
      "ok\n",
    );
    const result = bash(
      `source '${STAGES}'; dvara_stage x; dvara_record a; echo ok`,
      {
        DVARA_STAGE_FILE: "/nonexistent/s",
        DVARA_RECORD_FILE: "/nonexistent/r",
      },
    );
    assert.equal(result.code, 0);
    assert.match(result.out, /ok/);
  });

  it("withholds one pass line after an unreported refusal", () => {
    const result = bash(
      `source '${STAGES}'; dvara_passed && echo a; DVARA_UNREPORTED_REFUSAL=1; dvara_passed && echo b; dvara_passed && echo c`,
    );
    assert.equal(result.out, "a\nc\n");
  });
});

describe("keep-going.sh", () => {
  const run = (body: string) =>
    bash([`source '${STAGES}'`, `source '${KEEP_GOING}'`, body].join("\n"));

  it("carries on past each refusal and lists them all, failing", () => {
    const result = run(
      [
        "dvara_stage lint",
        "exit 1",
        'dvara_passed && echo "✅ lint"',
        "dvara_stage test",
        "exit 1",
        "dvara_stage audit",
        "echo audited",
        "dvara_keep_going_report",
      ].join("\n"),
    );
    assert.equal(result.code, 1);
    assert.match(
      result.out,
      /✗ preflight: lint failed; carrying on to the next check/,
    );
    assert.doesNotMatch(result.out, /✅ lint/);
    assert.match(result.out, /audited/);
    assert.match(
      result.out,
      /━━━ Preflight summary ━━━\n {2}❌ lint\n {2}❌ test\n {2}2 check\(s\) failed/,
    );
  });

  it("keeps a stage written as a function going after its exit", () => {
    const result = run(
      [
        "stage_lint() { dvara_stage lint; exit 1; echo after-exit; }",
        "stage_lint",
        "dvara_keep_going_report",
      ].join("\n"),
    );
    assert.equal(result.code, 1);
    assert.match(result.out, /after-exit/);
  });

  it("lets a subshell exit, and every other status end the run", () => {
    assert.match(
      run("(exit 1) || echo sub-ended; dvara_keep_going_report").out,
      /sub-ended[\s\S]*Every check passed/,
    );
    const ended = run("dvara_stage x; exit 3; echo never");
    assert.equal(ended.code, 3);
    assert.doesNotMatch(ended.out, /never/);
    // A bare `exit` after a failure is that failure's status, 1: a refusal.
    assert.match(
      run("dvara_stage y; false; exit; echo went-on; dvara_keep_going_report")
        .out,
      /went-on[\s\S]*❌ y/,
    );
  });

  it("names an unmarked stage unknown", () => {
    const result = bash(
      [`source '${KEEP_GOING}'`, "exit 1", "dvara_keep_going_report"].join(
        "\n",
      ),
    );
    assert.match(result.out, /❌ unknown/);
  });

  it("fails when a check was held, and passes with only skips", () => {
    const held = run(
      'dvara_keep_going_held mutation "the tests failed"; dvara_keep_going_report',
    );
    assert.equal(held.code, 1);
    assert.match(
      held.out,
      /→ mutation: not run: the tests failed[\s\S]*⏸ {2}mutation: not run[\s\S]*did not run/,
    );
    const skipped = run(
      'dvara_keep_going_skipped tests "docs only"; dvara_keep_going_report',
    );
    assert.equal(skipped.code, 0);
    assert.match(
      skipped.out,
      /⏭ {2}tests: skipped: docs only[\s\S]*the push runs the skipped ones/,
    );
  });

  it("passes with nothing to report", () => {
    const result = run("dvara_keep_going_report");
    assert.equal(result.code, 0);
    assert.match(
      result.out,
      /✅ Every check passed\. Nothing was pushed and no pull request was opened\./,
    );
  });

  it("takes its name and title from the hook", () => {
    const result = bash(
      [
        `source '${STAGES}'`,
        `source '${KEEP_GOING}'`,
        'DVARA_KEEP_GOING_NAME=dry-run DVARA_KEEP_GOING_TITLE="Dry run"',
        "dvara_stage a",
        "exit 1",
        "dvara_keep_going_report",
      ].join("\n"),
    );
    assert.match(
      result.out,
      /✗ dry-run: a failed[\s\S]*━━━ Dry run summary ━━━/,
    );
  });
});
