import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import plugin, { C05_CANDIDATE_RULES, rules } from './index.js';

/**
 * The test-lint rule map (`index.js`): every rule name, in order, bound to a
 * rule, and the c05 candidate list. The rules' behaviour is pinned in each
 * family's own suite; the config blocks in `configs.test.ts`.
 */

const RULE_NAMES = [
  'no-vacuous-assertion',
  'fake-timers-restored',
  'mock-factory-hoisted',
  'no-nested-test-blocks',
  'each-title-unique',
  'no-collection-time-skip-state',
  'no-collection-time-io',
  'guarded-marker-slice',
  'reset-shared-let',
  'hermetic-config',
  'e2e-uses-supertest',
  'no-void-async-iife',
  'no-path-line-literal',
  'no-process-exit',
  'cli-entry-helper',
  'git-spawn-env',
  'git-fixture-env',
  'no-global-patch',
  'no-sql-fake',
  'detox-tap-by-id',
  'no-silent-early-return',
  'owned-fixture-removal',
  'no-copied-production-sql',
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
  'no-partial-git-mask',
  'env-via-stub',
  'spawn-timeout',
  'no-raw-group-kill',
  'detached-teardown',
  'jsonnull-in-matcher',
  'no-import-meta-dirname-cjs',
  'poll-under-fake-timers',
  'expect-on-wall-clock',
  'spawn-timeout-sigkill',
  'no-stubenv-in-beforeall',
  'assert-imported-constant',
  'signal-handler-before-spawn',
];

/** The rules configured as warnings: each has a right use it cannot see. */
const SUGGESTIONS = new Set([
  'expect-on-wall-clock',
  'assert-imported-constant',
  'signal-handler-before-spawn',
]);

describe('the test-lint rule map', () => {
  it('names every rule, in order', () => {
    assert.deepEqual(Object.keys(rules), RULE_NAMES);
  });

  it('binds each name to a distinct rule with a create function and messages', () => {
    const modules = Object.entries(rules) as [
      string,
      {
        create: unknown;
        meta: { type: string; messages: Record<string, string> };
      },
    ][];
    assert.equal(new Set(modules.map(([, rule]) => rule)).size, RULE_NAMES.length);
    for (const [name, rule] of modules) {
      assert.equal(typeof rule.create, 'function', name);
      assert.equal(
        rule.meta.type,
        SUGGESTIONS.has(name) ? 'suggestion' : 'problem',
        name,
      );
      assert.ok(Object.keys(rule.meta.messages).length > 0, name);
    }
  });

  it('lists the c05 candidates, each one a rule', () => {
    assert.equal(C05_CANDIDATE_RULES.length, 13);
    for (const name of C05_CANDIDATE_RULES) {
      assert.ok(Object.hasOwn(rules, name), name);
    }
  });

  it('exports the family as a plugin named shuddhi', () => {
    assert.deepEqual(plugin, { meta: { name: 'shuddhi' }, rules });
    assert.equal(plugin.rules, rules);
  });
});
