import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as inputParsing from './index.js';
import * as configs from './configs.js';
import noHandRolledArgv from './no-hand-rolled-argv.js';
import envThroughSchema from './env-through-schema.js';
import strictScalarParse from './strict-scalar-parse.js';
import schemaParseUntrusted from './schema-parse-untrusted.js';
import schemaSatisfiesContract from './schema-satisfies-contract.js';
import prismaJsonThroughSchema from './prisma-json-through-schema.js';
import noRegexStructuredParse from './no-regex-structured-parse.js';

/**
 * The family entry. Each rule's catalogue example, corrected code,
 * near-misses and meta texts are pinned by the suite beside its module; this
 * suite pins what the entry adds: the rule ids, the plugin object and the
 * re-exported config helpers (pinned by ./configs.test.ts).
 */

const { rules } = inputParsing;

describe('plugin', () => {
  it('registers each rule module under its id', () => {
    assert.deepEqual(Object.keys(rules), [
      'no-hand-rolled-argv',
      'env-through-schema',
      'strict-scalar-parse',
      'schema-parse-untrusted',
      'schema-satisfies-contract',
      'prisma-json-through-schema',
      'no-regex-structured-parse',
    ]);
    assert.equal(rules['no-hand-rolled-argv'], noHandRolledArgv);
    assert.equal(rules['env-through-schema'], envThroughSchema);
    assert.equal(rules['strict-scalar-parse'], strictScalarParse);
    assert.equal(rules['schema-parse-untrusted'], schemaParseUntrusted);
    assert.equal(rules['schema-satisfies-contract'], schemaSatisfiesContract);
    assert.equal(rules['prisma-json-through-schema'], prismaJsonThroughSchema);
    assert.equal(rules['no-regex-structured-parse'], noRegexStructuredParse);
  });

  it('exports the plugin as default', () => {
    assert.deepEqual(Object.keys(inputParsing.default), ['rules']);
    assert.equal(inputParsing.default.rules, rules);
  });

  it('re-exports the config helpers', () => {
    assert.equal(inputParsing.TEST_FILE_GLOBS, configs.TEST_FILE_GLOBS);
    assert.equal(inputParsing.inputParsingRules, configs.inputParsingRules);
    assert.equal(inputParsing.inputParsingConfigs, configs.inputParsingConfigs);
  });
});
