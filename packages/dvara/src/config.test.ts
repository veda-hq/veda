import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CONFIG_FILE,
  configName,
  DEFAULTS,
  loadConfig,
  parseConfig,
} from "./config.ts";

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
      stageList: null,
      records: DEFAULTS.records,
    });
    assert.deepEqual(parseConfig("{}"), DEFAULTS);
    assert.equal(parseConfig('{"watchdog": null}').watchdog, null);
  });

  it("reads a stage list path, or none", () => {
    const path = "node_modules/@acme/rules/dvara/stages.json";
    assert.equal(
      parseConfig(JSON.stringify({ stageList: path })).stageList,
      path,
    );
    assert.equal(parseConfig('{"stageList": null}').stageList, null);
    assert.equal(
      parseConfig('{"stages": {}, "stageList": null}').stageList,
      null,
    );
  });

  it("lays the given record settings over theirs", () => {
    const records = {
      baseline: "./tools/../records/baseline.json",
      skip: ["tools/records/"],
      frozen: { paths: ["docs/archive/"], except: ["docs/archive/README.md"] },
      identityPaths: ["^docs/research/.*\\.md$"],
      repository: "someone/project",
      allowPaths: ["^/private/tmp/shared/cache(?![\\w.-])"],
      packageManager: "pnpm",
    };
    assert.deepEqual(parseConfig(JSON.stringify({ records })).records, {
      ...records,
      baseline: "records/baseline.json",
      identityPaths: [/^docs\/research\/.*\.md$/],
      allowPaths: [/^\/private\/tmp\/shared\/cache(?![\w.-])/],
    });
    assert.deepEqual(parseConfig('{"records": {}}').records, DEFAULTS.records);
    assert.deepEqual(
      parseConfig('{"records": {"frozen": {}, "packageManager": null}}')
        .records,
      DEFAULTS.records,
    );
    assert.deepEqual(
      parseConfig('{"records": {"frozen": {"paths": ["a/"]}}}').records.frozen,
      { paths: ["a/"], except: [] },
    );
    assert.equal(
      parseConfig('{"records": {"repository": null}}').records.repository,
      null,
    );
  });

  it("refuses record settings it cannot use", () => {
    for (const [records, message] of [
      [[], /records must be an object/],
      [{ typo: 1 }, /unknown field records\.typo/],
      [{ baseline: "" }, /records\.baseline must be a file path/],
      [{ baseline: 1 }, /records\.baseline must be a file path/],
      [{ baseline: "/abs.json" }, /records\.baseline must be a file path/],
      [{ baseline: "../out.json" }, /records\.baseline must be a file path/],
      [{ baseline: "a/../.." }, /records\.baseline must be a file path/],
      [{ baseline: "." }, /records\.baseline must be a file path/],
      [{ baseline: "a/.." }, /records\.baseline must be a file path/],
      [{ baseline: "archive/" }, /records\.baseline must be a file path/],
      [{ baseline: "./" }, /records\.baseline must be a file path/],
      [{ skip: "a/" }, /records\.skip must be a list/],
      [{ skip: [""] }, /records\.skip must hold repository-relative paths/],
      [{ skip: ["/a"] }, /records\.skip must hold repository-relative/],
      [{ skip: ["../archive/"] }, /records\.skip must hold repository-rel/],
      [{ skip: [".."] }, /records\.skip must hold repository-relative/],
      [{ frozen: { paths: ["a/../../b/"] } }, /records\.frozen\.paths must/],
      [{ frozen: { except: ["../x.md"] } }, /records\.frozen\.except must/],
      [{ frozen: [] }, /records\.frozen must be an object/],
      [{ frozen: { typo: [] } }, /unknown field records\.frozen\.typo/],
      [{ frozen: { paths: [1] } }, /records\.frozen\.paths must be a list/],
      [{ frozen: { except: [""] } }, /records\.frozen\.except must hold/],
      [
        { identityPaths: ["("] },
        /records\.identityPaths\[0\] is not a regular/,
      ],
      [{ allowPaths: ["a", "["] }, /records\.allowPaths\[1\] is not a regular/],
      [{ allowPaths: "a" }, /records\.allowPaths must be a list/],
      [{ repository: "project" }, /records\.repository must be "owner\/name"/],
      [{ repository: 1 }, /records\.repository must be/],
      [{ packageManager: "bun" }, /records\.packageManager must be one of/],
    ] as const)
      assert.throws(
        () => parseConfig(JSON.stringify({ records })),
        message,
        JSON.stringify(records),
      );
  });

  it("names the config file as loadConfig reads it", () => {
    assert.equal(configName({}), CONFIG_FILE);
    assert.equal(
      configName({ DVARA_CONFIG: "./tools/dvara.json" }),
      "tools/dvara.json",
    );
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
      ['{"stages": {"pre-push": [""]}}', /stages.pre-push must be a list/],
      ['{"stageList": 1}', /stageList must be a file path/],
      ['{"stageList": ""}', /stageList must be a file path/],
      ['{"stageList": "/abs.json"}', /stageList must be a file path/],
      ['{"stageList": "../out.json"}', /stageList must be a file path/],
      [
        '{"stages": {}, "stageList": "s.json"}',
        /give stages or stageList, not both/,
      ],
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
    assert.throws(() => loadConfig(root, {}), /cannot read/);
  });
});
