import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { format } from 'node:util';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin from './index.js';

/**
 * The shared helpers in `helpers.js`, the module this suite owns, read
 * through the rules that call them: each case names the helper decision it
 * pins.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

/** Vitest's `it.each`: one `it` per row, its title printf-formatted. */
function each<const T>(rows: readonly T[]) {
  return (
    title: string,
    fn: (...args: T extends readonly unknown[] ? T : [T]) => void,
  ): void => {
    for (const row of rows) {
      const args = (Array.isArray(row) ? row : [row]) as T extends readonly unknown[]
        ? T
        : [T];
      it(format(title, ...args), () => {
        fn(...args);
      });
    }
  };
}

const TEST_FILE = 'probe.test.ts';

// ---------------------------------------------------------------------------
// Deleting the guard from a corrected case brings the rule back
// ---------------------------------------------------------------------------

function messageIds(
  rule: string,
  code: string,
  filename = TEST_FILE,
  options: unknown[] = [],
): string[] {
  const linter = new Linter({ configType: 'flat' });
  return linter
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          plugins: { 'shuddhi': plugin },
          rules: { [`shuddhi/${rule}`]: ['error', ...options] },
        },
      ],
      filename,
    )
    .map(message => message.messageId ?? message.message);
}

// ---------------------------------------------------------------------------
// Decision pins A: shared helpers, TEST-WEAK-03, TEST-STRUCT-02
// ---------------------------------------------------------------------------

/**
 * One fixture per rule decision a mutation run found unpinned: each
 * names the rule, the code, and the exact messageIds it must yield.
 */
interface CaseA {
  rule: string;
  code: string;
  ids: string[];
  filename?: string;
}

const nva = (code: string, ids: string[] = []): CaseA => ({
  rule: 'no-vacuous-assertion',
  code,
  ids,
});

const nested = (code: string, ids: string[] = []): CaseA => ({
  rule: 'no-nested-test-blocks',
  code,
  ids,
});

const HELPER_CASES_A: CaseA[] = [
  // FUNCTION_TYPES: a function expression callback, a function declaration.
  nested(`it('a', function () { describe('b', () => {}); });`, ['nested']),
  {
    rule: 'no-collection-time-io',
    code: `import { readFileSync } from 'node:fs'; function read() { return readFileSync('x', 'utf8'); } it('a', () => { expect(read()).toBe('x'); });`,
    ids: [],
  },
  // WRAPPERS: each type-only wrapper and optional chaining is seen through.
  nva(`it('a', () => { expect(true as boolean).toBe(true); });`, [
    'staticSubject',
  ]),
  nva(`it('a', () => { expect(1!).toBe(1); });`, ['staticSubject']),
  nva(`it('a', () => { expect(<number>1).toBe(1); });`, ['staticSubject']),
  nva(`it('a', () => { expect(1 satisfies number).toBe(1); });`, [
    'staticSubject',
  ]),
  nva(`it('a', () => { expect(rows?.every(r => r.ok)).toBe(true); });`, [
    'vacuousEvery',
  ]),
  // propertyName: a computed identifier is no name; a computed string is.
  {
    rule: 'hermetic-config',
    code: `ConfigModule[forRoot]({ load: [] });`,
    ids: [],
  },
  {
    rule: 'hermetic-config',
    code: `ConfigModule['forRoot']({ load: [] });`,
    ids: ['configModule'],
  },
  // A computed number is no matcher, so the Date check stays the only one.
  nva(
    `it('a', () => { const d = parse(raw); expect(d).toBeInstanceOf(Date); expect(d)[1](); });`,
    ['soleInstanceOf'],
  ),
  // registration: every root, factory and source the runner provides.
  nested(`test('a', () => { describe('b', () => {}); });`, ['nested']),
  {
    rule: 'no-collection-time-io',
    code: `import { readFileSync } from 'node:fs'; suite('s', () => { const t = readFileSync('x', 'utf8'); it('a', () => { expect(t).toBe('x'); }); });`,
    ids: ['collectionIo'],
  },
  // An afterAll restore runs after the block, so a test's
  // fake leaks into every later test in it.
  {
    rule: 'fake-timers-restored',
    code: `afterAll(() => { vi.useRealTimers(); }); it('a', () => { vi.useFakeTimers(); expect(run()).toBe(1); });`,
    ids: ['leak'],
  },
  nested(
    `it('a', () => { it.each([1, 2])('b %s', v => { expect(run(v)).toBe(v); }); });`,
    ['nested'],
  ),
  nested(
    `it('a', () => { it.for([1, 2])('b %s', v => { expect(run(v)).toBe(v); }); });`,
    ['nested'],
  ),
  nested(
    `it('a', () => { it.skipIf(off)('b', () => { expect(run()).toBe(1); }); });`,
    ['nested'],
  ),
  nested(
    `it('a', () => { it.runIf(on)('b', () => { expect(run()).toBe(1); }); });`,
    ['nested'],
  ),
  nested(
    `it('a', () => { it.concurrent('b', () => { expect(run()).toBe(1); }); });`,
    ['nested'],
  ),
  nva(
    `it.runIf(cases.filter(c => c.on))('t', () => { expect(run()).toBe(1); });`,
  ),
  nva(
    `it.for(rows.filter(r => r.ok))('t %s', r => { expect(run(r)).toBe(1); });`,
    ['eachFilter'],
  ),
  {
    rule: 'no-collection-time-skip-state',
    code: `let rows: number[] = []; beforeAll(() => { rows = load(); }); it.each(rows)('r %s', r => { expect(run(r)).toBe(1); });`,
    ids: [],
  },
  {
    rule: 'no-collection-time-skip-state',
    code: `let ready = false; beforeAll(() => { ready = true; }); it.runIf(ready)('t', () => { expect(run()).toBe(1); });`,
    ids: ['hookState'],
  },
  nested(
    `import { it, describe } from 'vitest'; it('a', () => { describe('b', () => {}); });`,
    ['nested'],
  ),
  nested(
    `import { it, describe } from '@jest/globals'; it('a', () => { describe('b', () => {}); });`,
    ['nested'],
  ),
  nested(
    `import { it, describe } from 'node:test'; it('a', () => { describe('b', () => {}); });`,
    ['nested'],
  ),
  // The owner is the registration whose callback this is, not any argument.
  nested(`it('a', () => { describe('b', () => {}); }, () => {});`),
  // assertion: modifiers, expect.soft, and calls that are not assertions.
  nva(`it('a', () => { expect(1).not.toBe(2); });`, ['staticSubject']),
  nva(`it('a', async () => { await expect(1).resolves.toBe(1); });`, [
    'staticSubject',
  ]),
  nva(`it('a', async () => { await expect(1).rejects.toBe(1); });`, [
    'staticSubject',
  ]),
  nva(`it('a', () => { expect(1).not(1); });`),
  nva(`it('a', () => { x = 1; expect(run()).toBe(1); });`),
  nva(`it('a', () => { expect(new Foo()).not.toBeUndefined(); });`, [
    'typeFixed',
  ]),
  nva(`it('a', () => { expect(1).foo.toBe(1); });`),
  nva(`it('a', () => { check(1).toBe(1); });`),
  nva(`it('a', () => { other.soft(1).toBe(1); });`),
  nva(`it('a', () => { expect.soft(1).toBe(1); });`, ['staticSubject']),
  nva(`it('a', () => { expect.other(1).toBe(1); });`),
  // constInit: only a const binding has a fixed initial value.
  nva(`it('a', () => { let n = 10; expect(n).toBe(10); });`),
];

describe('decision pins A: helpers', () => {
  each(HELPER_CASES_A.map(c => [`${c.rule}: ${c.code}`, c] as const))(
    '%s',
    (_name, c) => {
      assert.deepEqual(messageIds(c.rule, c.code, c.filename ?? TEST_FILE), c.ids);
    },
  );
  // A local named `expect` is not the runner's.
  each([
    `function expect(v: unknown) { return { toBe: (_: unknown) => v }; } it('a', () => { expect(true).toBe(true); });`,
    `const expect = makeHarness(); it('a', () => { expect(true).toBe(true); });`,
    `const expect = makeHarness(); it('a', () => { expect.soft(true).toBe(true); });`,
    `it('a', () => { harness.soft(true).toBe(true); });`,
    `it('a', () => { expect.extend(true).toBe(true); });`,
  ])('leaves a non-runner expect alone: %s', code => {
    assert.deepEqual(messageIds('no-vacuous-assertion', code), []);
  });
  each([
    `import { expect } from 'vitest'; it('a', () => { expect(true).toBe(true); });`,
    `import { expect } from '@jest/globals'; it('a', () => { expect.soft(true).toBe(true); });`,
    `it('a', () => { expect.soft(true).toBe(true); });`,
  ])('still reads the runner expect: %s', code => {
    assert.deepEqual(messageIds('no-vacuous-assertion', code), ['staticSubject']);
  });
});
