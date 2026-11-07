import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import {
  ERROR_HANDLING_EXEMPT,
  errorHandling,
  errorHandlingBlocks,
} from './configs.js';
import { rules } from './index.js';

const HELPER_SOURCE = '^(?:@acme\\/shared|\\.{1,2}\\/(?:.*\\/)?error-handling)$';

const RULE_NAMES = [
  'no-swallowed-catch',
  'safe-log',
  'no-raw-error-string',
  'no-direct-child-process',
];

/** The rule ids that fire on `code` linted as `filename` under `blocks`. */
function ruleIds(blocks: unknown[], code: string, filename: string): string[] {
  const linter = new Linter({ configType: 'flat', cwd: '/work/repo' });
  return linter
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser as never },
        },
        ...(blocks as Linter.Config[]),
      ],
      `/work/repo/${filename}`,
    )
    .map(message => message.ruleId ?? message.message);
}

describe('errorHandling', () => {
  it('turns every rule on under shuddhi with no options', () => {
    assert.deepEqual(errorHandling(), {
      'shuddhi/no-swallowed-catch': 'error',
      'shuddhi/safe-log': 'error',
      'shuddhi/no-raw-error-string': 'error',
      'shuddhi/no-direct-child-process': 'error',
    });
  });

  it("passes a project's helpers, runner and root to the rules", () => {
    assert.deepEqual(
      errorHandling({
        namespace: 'acme',
        helperModule: '@acme/shared',
        helperSourcePattern: HELPER_SOURCE,
        runChildPath: 'scripts/lib/run-child.ts',
        root: '/work/repo',
      }),
      {
        'acme/no-swallowed-catch': 'error',
        'acme/safe-log': [
          'error',
          { helperModule: '@acme/shared', helperSourcePattern: HELPER_SOURCE },
        ],
        'acme/no-raw-error-string': ['error', { helperModule: '@acme/shared' }],
        'acme/no-direct-child-process': [
          'error',
          {
            allow: ['scripts/lib/run-child.ts'],
            runner: 'scripts/lib/run-child.ts',
            root: '/work/repo',
          },
        ],
      },
    );
  });
});

describe('errorHandlingBlocks', () => {
  it('binds the family plugin under shuddhi by default', () => {
    const [on, off] = errorHandlingBlocks(['src/**/*.ts']);
    assert.deepEqual(on?.files, ['src/**/*.ts']);
    assert.equal(on?.plugins?.shuddhi?.rules, rules);
    // Calling twice binds the same object, which flat config requires.
    assert.equal(
      errorHandlingBlocks(['x'])[0]?.plugins?.shuddhi,
      on?.plugins?.shuddhi,
    );
    assert.equal(off?.plugins?.shuddhi, on?.plugins?.shuddhi);
    assert.deepEqual(
      off?.rules,
      Object.fromEntries(RULE_NAMES.map(name => [`shuddhi/${name}`, 'off'])),
    );
    assert.deepEqual(
      off?.files,
      ERROR_HANDLING_EXEMPT.map(glob => [
        glob,
        '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
      ]),
    );
  });

  it("binds the caller's plugin under the caller's namespace", () => {
    const plugin = { rules };
    const [on, off] = errorHandlingBlocks(['**/*.ts'], {
      namespace: 'acme',
      plugin,
      runChildPath: 'scripts/lib/run-child.ts',
    });
    assert.equal(on?.plugins?.acme, plugin);
    assert.equal(off?.plugins?.acme, plugin);
    assert.deepEqual(on?.rules?.['acme/no-direct-child-process'], [
      'error',
      {
        allow: ['scripts/lib/run-child.ts'],
        runner: 'scripts/lib/run-child.ts',
      },
    ]);
    assert.equal(off?.rules?.['acme/safe-log'], 'off');
  });

  it('lints source and leaves tests, fixtures and mocks alone', () => {
    const blocks = errorHandlingBlocks(['**/*.ts'], {
      runChildPath: 'scripts/lib/run-child.ts',
    });
    const code = "import { spawn } from 'node:child_process';";
    assert.deepEqual(ruleIds(blocks, code, 'src/run.ts'), [
      'shuddhi/no-direct-child-process',
    ]);
    assert.deepEqual(ruleIds(blocks, code, 'scripts/lib/run-child.ts'), []);
    for (const exempt of [
      'src/run.test.ts',
      'src/__mocks__/run.ts',
      'test/utils/run.ts',
      'src/fixtures/run.ts',
    ])
      assert.deepEqual(ruleIds(blocks, code, exempt), [], exempt);
  });
});
