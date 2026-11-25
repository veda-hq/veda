import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  MUTATION_IGNORE_PATTERNS,
  RECOVERED_IGNORE_PATTERNS,
  SANDBOX_IGNORE_PATTERNS,
} from './sandbox-ignore.mjs';

// The lists are asserted by content: a pattern dropped in a tidy-up edit
// shows up only as a slower, larger sandbox copy, never as a failing run.

const RECOVERED = ['dist', 'build', 'coverage', 'node_modules', '.next', 'ios', 'android'];
const SANDBOX = ['.stryker-tmp', 'reports', '.tmp'];

describe('sandbox-ignore', () => {
  test('RECOVERED_IGNORE_PATTERNS holds the seven build, dependency and native trees, in order', () => {
    assert.deepEqual([...RECOVERED_IGNORE_PATTERNS], RECOVERED);
  });

  test("SANDBOX_IGNORE_PATTERNS holds Stryker's temp folder, reports and scratch, in order", () => {
    assert.deepEqual([...SANDBOX_IGNORE_PATTERNS], SANDBOX);
  });

  test('MUTATION_IGNORE_PATTERNS is both lists, in order: ten patterns', () => {
    assert.deepEqual([...MUTATION_IGNORE_PATTERNS], [...RECOVERED, ...SANDBOX]);
    assert.equal(MUTATION_IGNORE_PATTERNS.length, 10);
  });

  test('keeps the native mobile trees out of the sandbox', () => {
    // The two largest trees in a mobile app's working copy, named so that an
    // edit dropping either has to argue with a test.
    assert.ok(MUTATION_IGNORE_PATTERNS.includes('ios'), 'ios is excluded');
    assert.ok(MUTATION_IGNORE_PATTERNS.includes('android'), 'android is excluded');
  });

  test('has no duplicate patterns', () => {
    assert.equal(new Set(MUTATION_IGNORE_PATTERNS).size, MUTATION_IGNORE_PATTERNS.length);
  });

  test('every list is frozen, so a consumer cannot change the shared one in place', () => {
    assert.ok(Object.isFrozen(RECOVERED_IGNORE_PATTERNS));
    assert.ok(Object.isFrozen(SANDBOX_IGNORE_PATTERNS));
    assert.ok(Object.isFrozen(MUTATION_IGNORE_PATTERNS));
    assert.throws(() => MUTATION_IGNORE_PATTERNS.push('src'), TypeError);
  });

  test('carries no mutation-score settings', () => {
    const source = readFileSync(new URL('./sandbox-ignore.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /thresholds/);
    assert.doesNotMatch(source, /break:\s*\d/);
    assert.doesNotMatch(source, /high:\s*\d/);
    assert.doesNotMatch(source, /low:\s*\d/);
  });
});
