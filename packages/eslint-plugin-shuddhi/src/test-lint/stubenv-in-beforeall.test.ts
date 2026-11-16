import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin, { rules } from './index.js';

/**
 * The cases for `stubenv-in-beforeall.js` (`no-stubenv-in-beforeall`), the
 * module this suite owns.
 *
 * Each `invalid` case is the lesson's shape, reduced: a `vi.stubEnv` that
 * `unstubEnvs: true` undoes before the first test. Each `valid` case is the
 * corrected code or a near miss. The `guard removal` block moves the stub
 * back into `beforeAll` and proves the rule fires again.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

const TEST_FILE = 'probe.test.ts';
const inBeforeAll = { messageId: 'beforeAll' };

ruleTester.run('no-stubenv-in-beforeall', rules['no-stubenv-in-beforeall']!, {
  valid: [
    // Corrected: stubbed before every test, so unstubEnvs cannot undo it first.
    {
      filename: TEST_FILE,
      code: `beforeEach(() => { vi.stubEnv('DATABASE_URL', url); });
      it('reads it', () => { expect(config().db).toBe(url); });`,
    },
    // Corrected: stubbed in the test itself, nested callbacks included.
    {
      filename: TEST_FILE,
      code: `describe('a', () => {
        beforeAll(() => { start(); });
        it('b', async () => { await run(() => vi.stubEnv('X', '1')); });
      });`,
    },
    // The other hooks are not the finding.
    {
      filename: TEST_FILE,
      code: `afterAll(() => { vi.stubEnv('X', ''); });
      afterEach(() => { vi.stubEnv('Y', ''); });`,
    },
    // A helper beforeAll calls is not read.
    {
      filename: TEST_FILE,
      code: `function setup() { vi.stubEnv('X', '1'); }
      beforeAll(() => setup());`,
    },
    // Other members of vi, stubEnv on another object, a bare stubEnv, a
    // computed member that names no method.
    {
      filename: TEST_FILE,
      code: `beforeAll(() => {
        vi.stubGlobal('fetch', fake);
        vi.unstubAllEnvs();
        env.stubEnv('X', '1');
        stubEnv('X', '1');
        vi[name]('X', '1');
        (getVi()).stubEnv('X', '1');
      });`,
    },
    // A local function that shares the hook's name is ordinary code.
    {
      filename: TEST_FILE,
      code: `const beforeAll = (fn: () => void) => fn();
      beforeAll(() => { vi.stubEnv('X', '1'); });`,
    },
  ],
  invalid: [
    // The lesson: the suite's one stub, undone before its first test.
    {
      filename: TEST_FILE,
      code: `beforeAll(() => { vi.stubEnv('DATABASE_URL', url); });
      it('reads it', () => { expect(config().db).toBe(url); });`,
      errors: [inBeforeAll],
    },
    // Inside a describe, as an expression body.
    {
      filename: TEST_FILE,
      code: `describe('a', () => { describe('b', () => { beforeAll(() => vi.stubEnv('X', '1')); }); });`,
      errors: [inBeforeAll],
    },
    // The hook imported from vitest; a nested callback, a computed member and
    // a non-null assertion.
    {
      filename: TEST_FILE,
      code: `import { beforeAll, vi } from 'vitest';
      beforeAll(async () => { await setup(() => { vi['stubEnv']('Y', '1'); }); vi!.stubEnv('Z', '1'); });`,
      errors: [inBeforeAll, inBeforeAll],
    },
  ],
});

// ---------------------------------------------------------------------------
// Deleting the guard from a corrected case brings the rule back
// ---------------------------------------------------------------------------

function messageIds(code: string): string[] {
  return new Linter({ configType: 'flat' })
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          plugins: { shuddhi: plugin },
          rules: { 'shuddhi/no-stubenv-in-beforeall': 'error' },
        },
      ],
      TEST_FILE,
    )
    .map(message => message.messageId ?? message.message);
}

describe('guard removal flips each corrected case', () => {
  it('no-stubenv-in-beforeall/beforeAll', () => {
    const corrected = `beforeEach(() => { vi.stubEnv('DATABASE_URL', url); });`;
    assert.deepEqual(messageIds(corrected), []);
    const broken = corrected.replace('beforeEach(', 'beforeAll(');
    assert.notEqual(broken, corrected);
    assert.deepEqual(messageIds(broken), ['beforeAll']);
  });
});

describe('no-stubenv-in-beforeall rule metadata', () => {
  it('states the rule and its message verbatim', () => {
    assert.deepEqual(rules['no-stubenv-in-beforeall']?.meta, {
      type: 'problem',
      docs: {
        description: 'vi.stubEnv runs per test, never in beforeAll',
      },
      schema: [],
      messages: {
        beforeAll:
          '`vi.stubEnv` in `beforeAll` is undone before the first test when the Vitest config sets `unstubEnvs: true`, so the tests run against the real value; without it, the stub outlives this file. Stub the variable in `beforeEach` or in the test.',
      },
    });
  });
});
