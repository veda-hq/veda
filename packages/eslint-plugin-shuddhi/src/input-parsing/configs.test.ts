import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Linter } from 'eslint';

import {
  TEST_FILE_GLOBS,
  inputParsingConfigs,
  inputParsingRules,
} from './configs.js';
import plugin, { rules } from './index.js';

/**
 * The config blocks: the severities, the test-code exemption, the env-module
 * and typed-file blocks, the caller's namespace and the per-rule options.
 */

/** One path per exemption glob, matched by that glob alone. */
const TEST_PATH_BY_GLOB: Record<string, string> = {
  '**/*.test.*': 'src/a.test.ts',
  '**/*.spec.*': 'src/a.spec.ts',
  '**/__tests__/**': 'src/__tests__/a.ts',
  '**/__mocks__/**': 'src/__mocks__/a.ts',
  '**/test/**': 'src/test/a.ts',
  '**/tests/**': 'src/tests/a.ts',
  '**/e2e/**': 'src/e2e/a.ts',
  '**/fixtures/**': 'src/fixtures/a.ts',
  '**/*.fixture.*': 'src/a.fixture.ts',
};

/** The argv rule's findings on `code` in `filename`. */
const argvFindings = (
  filename: string,
  namespace?: string,
  code = 'const target = process.argv[2];',
) =>
  new Linter({ configType: 'flat' })
    .verify(
      code,
      [
        { files: ['**/*.ts'] },
        ...(inputParsingConfigs({
          files: ['**/*.ts'],
          ...(namespace === undefined ? {} : { namespace }),
        }) as Linter.Config[]),
      ],
      filename,
    )
    .filter(
      message =>
        message.ruleId === `${namespace ?? 'shuddhi'}/no-hand-rolled-argv`,
    );

describe('test-code exemption', () => {
  it('lists exactly the globs exercised here', () => {
    assert.deepEqual(
      [...TEST_FILE_GLOBS].sort(),
      Object.keys(TEST_PATH_BY_GLOB).sort(),
    );
  });

  it('lints production code at error severity', () => {
    const findings = argvFindings('src/a.ts');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.messageId, 'index');
    assert.equal(findings[0]?.severity, 2);
  });

  for (const [glob, filename] of Object.entries(TEST_PATH_BY_GLOB)) {
    it(`${glob} exempts ${filename}`, () => {
      assert.deepEqual(argvFindings(filename), []);
    });
  }

  it('turns every rule on at error severity', () => {
    assert.deepEqual(
      inputParsingRules(),
      Object.fromEntries(
        Object.keys(rules).map(name => [`shuddhi/${name}`, 'error']),
      ),
    );
  });
});

describe('namespace', () => {
  it("binds the rules under the caller's namespace", () => {
    assert.deepEqual(
      inputParsingRules('parse'),
      Object.fromEntries(
        Object.keys(rules).map(name => [`parse/${name}`, 'error']),
      ),
    );
    const findings = argvFindings('src/a.ts', 'parse');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.ruleId, 'parse/no-hand-rolled-argv');
  });
});

describe('inputParsingConfigs', () => {
  it('exempts test code and registers the plugin once per workspace', () => {
    const blocks = inputParsingConfigs({ files: ['src/**/*.ts'] });
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0]?.ignores, TEST_FILE_GLOBS);
    assert.equal(Object.keys(blocks[0]?.rules ?? {}).length, 7);
    assert.equal(blocks[0]?.plugins?.shuddhi, plugin);
    assert.equal(blocks[0]?.plugins?.shuddhi?.rules, rules);
  });

  it('turns on no-unsafe-member-access where types exist (VAL-09)', () => {
    const blocks = inputParsingConfigs({
      files: ['**/*.ts', '**/*.mjs'],
      typedFiles: ['**/*.ts'],
    });
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[1], {
      files: ['**/*.ts'],
      ignores: TEST_FILE_GLOBS,
      rules: { '@typescript-eslint/no-unsafe-member-access': 'error' },
    });
  });

  it('lets env-schema modules read literally, still under the shape checks', () => {
    const blocks = inputParsingConfigs({
      files: ['src/**/*.ts'],
      envModules: ['src/config/env.ts'],
      ignores: ['src/generated/**'],
      namespace: 'parse',
    });
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0]?.ignores.includes('src/generated/**'));
    assert.deepEqual(blocks[1], {
      files: ['src/config/env.ts'],
      ignores: [...TEST_FILE_GLOBS, 'src/generated/**'],
      plugins: { parse: { rules } },
      rules: {
        'parse/env-through-schema': ['error', { allowDirectRead: true }],
      },
    });
  });
});

describe('ruleOptions', () => {
  const hints = { direct: 'Use `readEnv` (lib/env.ts).' };
  const pageReaders = ['readPage'];

  it('passes each rule its options in every block that turns it on', () => {
    const blocks = inputParsingConfigs({
      files: ['src/**/*.ts'],
      envModules: ['src/config/env.ts'],
      ruleOptions: {
        'env-through-schema': { hints },
        'strict-scalar-parse': { pageReaders },
      },
    });
    const [main, env] = blocks;
    assert.deepEqual(main?.rules['shuddhi/env-through-schema'], [
      'error',
      { hints },
    ]);
    assert.deepEqual(main?.rules['shuddhi/strict-scalar-parse'], [
      'error',
      { pageReaders },
    ]);
    assert.equal(main?.rules['shuddhi/no-hand-rolled-argv'], 'error');
    assert.deepEqual(env?.rules, {
      'shuddhi/env-through-schema': [
        'error',
        { hints, allowDirectRead: true },
      ],
    });
  });

  it('renders the configured hint when linted', () => {
    const [message] = new Linter({ configType: 'flat' }).verify(
      'const ci = process.env.CI;',
      [
        { files: ['**/*.ts'] },
        ...(inputParsingConfigs({
          files: ['**/*.ts'],
          ruleOptions: { 'env-through-schema': { hints } },
        }) as Linter.Config[]),
      ],
      'src/a.ts',
    );
    assert.equal(message?.message, hints.direct);
  });

  it('refuses options for a rule the plugin does not have', () => {
    assert.throws(
      () =>
        inputParsingConfigs({
          files: ['**/*.ts'],
          ruleOptions: { 'strict-scalar-parsing': {} },
        }),
      /no rule named "strict-scalar-parsing"/,
    );
  });
});
