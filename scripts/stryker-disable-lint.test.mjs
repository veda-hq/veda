// veda's lint refuses a `// Stryker disable` comment (#326): agnipariksha
// doesn't count Ignored mutants, so one comment would take a file's mutants
// out of the gate. These cases lint text through the repository's own
// eslint.config.js, at paths its CODE globs cover, so they test the rule
// veda runs, not a copy. The comments sit in string literals, so this file
// passes its own lint.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: ROOT });

/** Linted paths: TypeScript sources, a .tsx hook, a .mjs hook, a root script. */
const PATHS = [
  'packages/agnipariksha/src/probe.ts',
  'packages/agnipariksha/src/probe.tsx',
  'packages/needs-you/hooks/probe.tsx',
  'packages/sarathi/hooks/probe.mjs',
  'scripts/probe.mjs',
];

/**
 * The lines `no-warning-comments` refuses in `code`, linted as `path`.
 * @param {string} code @param {string} path @returns {Promise<number[]>}
 */
async function refused(code, path) {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, path) });
  assert.ok(result, `no lint result for ${path}`);
  // A parse failure has no rule messages, so an allowed case would pass on it.
  assert.deepEqual(result.messages.filter(message => message.fatal), [], `${path} did not parse`);
  return result.messages
    .filter(message => message.ruleId === 'no-warning-comments' && message.severity === 2)
    .map(message => message.line);
}

describe('lint refuses a Stryker disable comment', () => {
  for (const path of PATHS) {
    test(`the line form, in ${path}`, async () => {
      assert.deepEqual(await refused('export const a = 1;\n// Stryker disable next-line all\nexport const b = 2;\n', path), [2]);
    });

    test(`the block form, in ${path}`, async () => {
      assert.deepEqual(await refused('/* Stryker disable all */\nexport const a = 1;\n', path), [1]);
    });

    test(`inline ESLint config is off for ${path}`, async () => {
      const config = await eslint.calculateConfigForFile(join(ROOT, path));
      assert.equal(config.linterOptions.noInlineConfig, true);
    });
  }

  test('in lower case too', async () => {
    assert.deepEqual(await refused('// stryker disable all\n', 'scripts/probe.mjs'), [1]);
  });
});

describe('lint allows', () => {
  test('// Stryker restore', async () => {
    assert.deepEqual(await refused('// Stryker restore all\nexport const a = 1;\n', 'scripts/probe.mjs'), []);
  });

  test("a doc comment that only mentions the comment, as arid-nodes.mjs's does", async () => {
    const text = readFileSync(join(ROOT, 'packages/agnipariksha/arid-nodes.mjs'), 'utf8');
    assert.match(text, /`\/\/ Stryker disable`/);
    assert.deepEqual(await refused(text, 'packages/agnipariksha/src/arid-nodes.mjs'), []);
  });
});

describe('lint refuses a comment that switches the rule off', () => {
  const BYPASSES = {
    'eslint-disable-next-line': '// eslint-disable-next-line no-warning-comments\n// Stryker disable all\n',
    'eslint-disable-line': '/* Stryker disable all */ // eslint-disable-line no-warning-comments\n',
    'a bare eslint-disable': '/* eslint-disable */\n// Stryker disable all\n',
    'eslint-disable of the rule': '/* eslint-disable no-warning-comments */\n// Stryker disable all\n',
    'an inline rule config': '/* eslint no-warning-comments: "off" */\n// Stryker disable all\n',
  };
  for (const [name, code] of Object.entries(BYPASSES)) {
    test(name, async () => {
      const line = code.split('\n').findIndex(text => text.includes('Stryker disable')) + 1;
      assert.deepEqual(await refused(code, 'packages/agnipariksha/src/probe.ts'), [line]);
    });
  }
});
