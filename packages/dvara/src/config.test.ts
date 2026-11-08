import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONFIG_FILE, DEFAULTS, loadConfig, parseConfig } from "./config.ts";

const dir = () => mkdtempSync(join(tmpdir(), "dvara-config-"));

describe("parseConfig", () => {
  it("lays the given fields over the defaults", () => {
    const config = parseConfig(
      JSON.stringify({
        historyDir: ".tmp/history",
        quietHooks: [],
        watchdog: "tools/watchdog.mjs",
        baseRefs: ["origin/trunk"],
        stages: { "pre-push": ["lint", "test"] },
      }),
    );
    assert.deepEqual(config, {
      historyDir: ".tmp/history",
      quietHooks: [],
      watchdog: "tools/watchdog.mjs",
      baseRefs: ["origin/trunk"],
      stages: { "pre-push": ["lint", "test"] },
    });
    assert.deepEqual(parseConfig("{}"), DEFAULTS);
    assert.equal(parseConfig('{"watchdog": null}').watchdog, null);
  });

  it("refuses what it cannot use", () => {
    for (const [text, message] of [
      ["[]", /must be an object/],
      ["null", /must be an object/],
      ['{"typo": 1}', /unknown field typo/],
      ['{"historyDir": ""}', /historyDir/],
      ['{"historyDir": 3}', /historyDir/],
      ['{"quietHooks": "pre-commit"}', /quietHooks must be a list/],
      ['{"baseRefs": [1]}', /baseRefs must be a list/],
      ['{"watchdog": 1}', /watchdog must be a path/],
      ['{"stages": []}', /stages must map/],
      ['{"stages": null}', /stages must map/],
      ['{"stages": {"pre-push": "lint"}}', /stages.pre-push must be a list/],
    ] as const)
      assert.throws(() => parseConfig(text), message, text);
  });
});

describe("loadConfig", () => {
  it("uses the defaults when the repository has no file", () => {
    assert.equal(loadConfig(dir(), {}), DEFAULTS);
  });

  it("reads the root file, or the one DVARA_CONFIG names", () => {
    const root = dir();
    writeFileSync(join(root, CONFIG_FILE), '{"historyDir": "a"}');
    writeFileSync(join(root, "other.json"), '{"historyDir": "b"}');
    assert.equal(loadConfig(root, {}).historyDir, "a");
    assert.equal(
      loadConfig(root, { DVARA_CONFIG: "other.json" }).historyDir,
      "b",
    );
  });

  it("fails on a named file that is missing, or any file it cannot parse", () => {
    const root = dir();
    assert.throws(
      () => loadConfig(root, { DVARA_CONFIG: "missing.json" }),
      /dvara: cannot read .*missing\.json/,
    );
    writeFileSync(join(root, CONFIG_FILE), "{");
    assert.throws(() => loadConfig(root, {}), /dvara: .*\.dvara\.json: /);
  });

  it("fails on a root file it cannot read", () => {
    const root = dir();
    // A directory where the file should be: EISDIR, not ENOENT.
    mkdirSync(join(root, CONFIG_FILE));
    assert.throws(
      () => loadConfig(root, {}),
      /cannot read/,
    );
  });
});
