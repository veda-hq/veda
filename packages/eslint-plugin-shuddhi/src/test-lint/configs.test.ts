import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import {
  DEFAULT_NAMESPACE,
  DETOX_RULES,
  pluginFor,
  PROCESS_HYGIENE_RULES,
  SCRIPT_RULES,
  SERVER_TEST_RULES,
  TEST_FILE_RULES,
  testLintBlocks,
  withNamespace,
} from './configs.js';
import plugin, { C05_CANDIDATE_RULES, rules } from './index.js';

/**
 * The test-lint config blocks (`configs.js`): the blocks `testLintBlocks`
 * binds, the rules each block turns on, the namespace they are bound under
 * and the rule options it hands on. Each rule family's cases are in
 * `<family>.test.ts`, the suite that owns that family's module.
 */

interface Block {
  files: string[];
  plugins: Record<string, unknown>;
  rules: Record<string, unknown>;
}

const blocksOf = (...args: Parameters<typeof testLintBlocks>): Block[] =>
  testLintBlocks(...args) as Block[];

describe('testLintBlocks', () => {
  it('binds the test rules to the test globs and the script rules to scripts', () => {
    const blocks = blocksOf({
      tests: ['**/*.test.ts'],
      support: ['test/**/*.ts'],
      server: true,
      scripts: ['scripts/**/*.ts'],
    });
    assert.deepEqual(
      blocks.map(block => block.files),
      [['**/*.test.ts'], ['test/**/*.ts'], ['**/*.test.ts'], ['scripts/**/*.ts']],
    );
    assert.ok(
      Object.keys(blocks[0]?.rules ?? {}).includes(
        'shuddhi/no-vacuous-assertion',
      ),
    );
    assert.deepEqual(Object.keys(blocks[2]?.rules ?? {}), [
      'shuddhi/hermetic-config',
      'shuddhi/e2e-uses-supertest',
    ]);
    assert.deepEqual(Object.keys(blocks[3]?.rules ?? {}), [
      'shuddhi/no-process-exit',
      'shuddhi/cli-entry-helper',
    ]);
  });

  it('adds nothing beyond the test block when a workspace has no extras', () => {
    assert.equal(blocksOf({ tests: ['**/*.test.ts'] }).length, 1);
  });

  it('registers every rule it configures', () => {
    const configured = blocksOf({
      tests: ['a'],
      support: ['b'],
      server: true,
      scripts: ['c'],
      detox: ['d'],
    }).flatMap(block => Object.keys(block.rules));
    for (const id of configured) {
      assert.ok(Object.keys(rules).includes(id.replace('shuddhi/', '')));
    }
  });
});

describe('plugin and config blocks', () => {
  // The candidate extensions, spelled out so a name dropped from
  // C05_CANDIDATE_RULES fails here rather than leaving its rule off.
  const C05_CANDIDATES = [
    'no-fixed-sleep',
    'specific-rejection',
    'call-specific-matcher',
    'independent-expectation',
    'owned-db-schema',
    'teardown-in-finally',
    'cleanup-loop-settles',
    'parse-structured-config',
    'mock-state-reset',
    'mock-export-parity',
    'spawn-result-checked',
    'local-tool-spawn',
    'fixture-root-tracked',
  ];
  const TEST_RULE_NAMES = [
    'no-vacuous-assertion',
    'fake-timers-restored',
    'mock-factory-hoisted',
    'no-nested-test-blocks',
    'each-title-unique',
    'no-collection-time-skip-state',
    'no-collection-time-io',
    'guarded-marker-slice',
    'reset-shared-let',
    'no-void-async-iife',
    'no-path-line-literal',
    'git-spawn-env',
    'no-global-patch',
    'no-sql-fake',
    'no-silent-early-return',
    'owned-fixture-removal',
    'no-copied-production-sql',
    ...C05_CANDIDATES,
    'git-fixture-env',
    'spawn-timeout',
    'no-raw-group-kill',
    'no-partial-git-mask',
    'env-via-stub',
    'detached-teardown',
  ];
  /** The blocks every option builds, under `namespace`. */
  const expected = (namespace: string, bound: unknown) => {
    const plugins = { [namespace]: bound };
    const on = (names: string[]) =>
      Object.fromEntries(names.map(name => [`${namespace}/${name}`, 'error']));
    return {
      testBlock: { files: ['t'], plugins, rules: on(TEST_RULE_NAMES) },
      supportBlock: {
        files: ['s'],
        plugins,
        rules: on(['no-void-async-iife', 'spawn-timeout', 'no-raw-group-kill']),
      },
      serverBlock: {
        files: ['t'],
        plugins,
        rules: on(['hermetic-config', 'e2e-uses-supertest']),
      },
      scriptBlock: {
        files: ['c'],
        plugins,
        rules: on(['no-process-exit', 'cli-entry-helper']),
      },
      detoxBlock: { files: ['d'], plugins, rules: on(['detox-tap-by-id']) },
    };
  };
  const { testBlock, supportBlock, serverBlock, scriptBlock, detoxBlock } =
    expected('shuddhi', plugin);

  it('names the plugin shuddhi', () => {
    assert.deepEqual((plugin as { meta: unknown }).meta, { name: 'shuddhi' });
    assert.equal(DEFAULT_NAMESPACE, 'shuddhi');
  });

  it('builds the exact blocks for every option', () => {
    assert.deepEqual(
      testLintBlocks({
        tests: ['t'],
        support: ['s'],
        server: true,
        scripts: ['c'],
        detox: ['d'],
      }),
      [testBlock, supportBlock, serverBlock, scriptBlock, detoxBlock],
    );
    assert.deepEqual(testLintBlocks({ tests: ['t'], detox: ['d'] }), [
      testBlock,
      detoxBlock,
    ]);
    assert.deepEqual(testLintBlocks({ tests: ['t'] }), [testBlock]);
    assert.deepEqual(testLintBlocks({ tests: ['t'], server: true }), [
      testBlock,
      serverBlock,
    ]);
    assert.deepEqual(testLintBlocks({ tests: ['t'], support: ['s'] }), [
      testBlock,
      supportBlock,
    ]);
    assert.deepEqual(testLintBlocks({ tests: ['t'], scripts: ['c'] }), [
      testBlock,
      scriptBlock,
    ]);
  });

  it('builds the same blocks under another namespace', () => {
    const other = expected('product-test', pluginFor('product-test'));
    assert.deepEqual(
      testLintBlocks(
        {
          tests: ['t'],
          support: ['s'],
          server: true,
          scripts: ['c'],
          detox: ['d'],
        },
        'product-test',
      ),
      [
        other.testBlock,
        other.supportBlock,
        other.serverBlock,
        other.scriptBlock,
        other.detoxBlock,
      ],
    );
  });

  it('exports the rule maps the blocks use', () => {
    assert.deepEqual(TEST_FILE_RULES, testBlock.rules);
    assert.deepEqual(PROCESS_HYGIENE_RULES, {
      'shuddhi/spawn-timeout': 'error',
      'shuddhi/no-raw-group-kill': 'error',
    });
    assert.deepEqual(SERVER_TEST_RULES, serverBlock.rules);
    assert.deepEqual(SCRIPT_RULES, scriptBlock.rules);
    assert.deepEqual(DETOX_RULES, detoxBlock.rules);
    assert.deepEqual(C05_CANDIDATE_RULES, C05_CANDIDATES);
  });
});

describe('Process-hygiene wiring', () => {
  it('runs the process rules on test files, and the spawn rules on the fixtures they load', () => {
    const [tests, support] = blocksOf({
      tests: ['**/*.test.ts'],
      support: ['**/*.fixture.ts'],
    });
    assert.partialDeepStrictEqual(tests?.rules, {
      'shuddhi/git-spawn-env': 'error',
      'shuddhi/git-fixture-env': 'error',
      'shuddhi/no-partial-git-mask': 'error',
      'shuddhi/env-via-stub': 'error',
      'shuddhi/spawn-timeout': 'error',
      'shuddhi/no-raw-group-kill': 'error',
      'shuddhi/detached-teardown': 'error',
    });
    assert.deepEqual(support?.rules, {
      'shuddhi/no-void-async-iife': 'error',
      'shuddhi/spawn-timeout': 'error',
      'shuddhi/no-raw-group-kill': 'error',
    });
  });
});

describe('namespaces', () => {
  it('binds one plugin object per namespace, named after it', () => {
    assert.equal(pluginFor('shuddhi'), plugin);
    const bound = pluginFor('product-test');
    assert.equal(pluginFor('product-test'), bound);
    assert.notEqual(bound, plugin);
    assert.deepEqual(bound, { meta: { name: 'product-test' }, rules });
    const [first] = blocksOf({ tests: ['t'] }, 'product-test');
    const [second] = blocksOf({ tests: ['u'] }, 'product-test');
    assert.equal(first?.plugins['product-test'], second?.plugins['product-test']);
  });

  it('binds the plugin object it is given', () => {
    const own = { meta: { name: 'all' }, rules };
    const [block] = blocksOf({ tests: ['t'] }, 'all', {}, own);
    assert.deepEqual(Object.keys(block?.plugins ?? {}), ['all']);
    assert.equal(block?.plugins['all'], own);
    assert.ok(Object.keys(block?.rules ?? {}).every(id => id.startsWith('all/')));
  });

  it('re-keys a rule map to another namespace, in order', () => {
    assert.deepEqual(withNamespace(SCRIPT_RULES, 'product-test'), {
      'product-test/no-process-exit': 'error',
      'product-test/cli-entry-helper': 'error',
    });
    assert.deepEqual(
      Object.keys(withNamespace(TEST_FILE_RULES, 'x')),
      Object.keys(TEST_FILE_RULES).map(id => id.replace('shuddhi/', 'x/')),
    );
  });

  it('keeps keys outside the source namespace, and reads any source', () => {
    assert.deepEqual(
      withNamespace({ 'other/rule': 'warn', 'shuddhi/a': 'error' }, 'x'),
      { 'other/rule': 'warn', 'x/a': 'error' },
    );
    assert.deepEqual(withNamespace({ 'x/a': 'error', 'shuddhi/b': 1 }, 'y', 'x'), {
      'y/a': 'error',
      'shuddhi/b': 1,
    });
  });
});

describe('rule options', () => {
  const OPTIONS = {
    'hermetic-config': { helperModule: 'test/support/config' },
    'spawn-timeout': {},
  };

  it('hands each rule its options in every block that turns it on', () => {
    const blocks = blocksOf(
      { tests: ['t'], support: ['s'], server: true },
      'product-test',
      OPTIONS,
    );
    assert.deepEqual(blocks[0]?.rules['product-test/spawn-timeout'], [
      'error',
      {},
    ]);
    assert.deepEqual(blocks[1]?.rules['product-test/spawn-timeout'], [
      'error',
      {},
    ]);
    assert.deepEqual(blocks[2]?.rules['product-test/hermetic-config'], [
      'error',
      { helperModule: 'test/support/config' },
    ]);
    assert.equal(blocks[2]?.rules['product-test/e2e-uses-supertest'], 'error');
    assert.equal(blocks[0]?.rules['product-test/no-vacuous-assertion'], 'error');
  });

  it('refuses options for a rule it does not have', () => {
    assert.throws(
      () => testLintBlocks({ tests: ['t'] }, 'shuddhi', { 'no-such-rule': {} }),
      { name: 'TypeError', message: 'testLintBlocks: no test-lint rule named "no-such-rule"' },
    );
  });

  it('reaches the rule when ESLint runs the blocks', () => {
    const messages = new Linter({ configType: 'flat' })
      .verify(
        `integrity = new IntegrityService(new ConfigService({}));`,
        [
          { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
          ...(testLintBlocks(
            { tests: ['**/*.test.ts'], server: true },
            'product-test',
            OPTIONS,
          ) as Linter.Config[]),
        ],
        'probe.test.ts',
      )
      .map(message => [message.ruleId, message.message]);
    assert.deepEqual(messages, [
      [
        'product-test/hermetic-config',
        "`new ConfigService(values)` falls back to process.env for every key it lacks, so this test reads the developer's or CI's environment. Use `hermeticConfigService(values)` from test/support/config.",
      ],
    ]);
  });
});
