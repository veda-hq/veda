import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { format } from 'node:util';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin, { rules } from './index.js';

/**
 * TEST-WEAK-03 (no-vacuous-assertion): the cases for `vacuous-assertion.js`, the module this suite owns.
 *
 * Each `invalid` case is a finding code review reported, reduced to the shape
 * that still reproduces it. Each `valid` case is the corrected code or a near
 * miss. The `guard removal` block deletes only the guard from a corrected
 * case and proves the rule fires again.
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

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

const TEST_FILE = 'probe.test.ts';

// ---------------------------------------------------------------------------
// TEST-WEAK-03
// ---------------------------------------------------------------------------

ruleTester.run('no-vacuous-assertion', rules['no-vacuous-assertion'], {
  valid: [
    // Corrected: assert on what the endpoint returned.
    {
      filename: TEST_FILE,
      code: `it('should require admin role', async () => {
        const response = await request(server).post('/admin/inwards/upload').expect(403);
        expect(response.body.code).toBe('FORBIDDEN');
      });`,
    },
    // Reversed argument order is a real comparison, not a vacuous one.
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(5).toBe(compute()); });`,
    },
    // Corrected, and a non-count `>= 0` near miss.
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(errors).toHaveLength(0); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(errors.length).toBeGreaterThan(0); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(delta).toBeGreaterThanOrEqual(0); });`,
    },
    // "Discount" ends in "count" but is money, which can go negative.
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(tier.summary.totalDiscount).toBeGreaterThanOrEqual(0); });`,
    },
    // Non-empty proved through a const derived from the receiver.
    {
      filename: TEST_FILE,
      code: `it('a', () => {
        const codes = survivors.map(c => c.code).sort();
        expect(codes).toEqual(['CRED60', 'GPAY60']);
        expect(survivors.every(c => c.appliesOnce)).toBe(true);
      });`,
    },
    // Near miss: the type of a parsed value is not fixed.
    {
      filename: TEST_FILE,
      code: `it('a', () => { const value = parse(input); expect(typeof value).toBe('string'); });`,
    },
    // Corrected.
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(Number.isNaN(new Date(result.serverTimestamp).getTime())).toBe(false); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { const d = parse(raw); expect(d).toBeInstanceOf(Date); expect(d.getTime()).toBe(0); });`,
    },
    // `??` is not `||`.
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(a ?? b).toBe(1); });`,
    },
    // Corrected: non-empty first.
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(hits.length).toBeGreaterThan(0); expect(hits.every(h => h.tenant === 'B')).toBe(true); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(rows.map(r => r.id)).toEqual(saved); expect(rows.every(r => r.pending)).toBe(true); });`,
    },
    // Corrected: presence first.
    {
      filename: TEST_FILE,
      code: `it('a', () => {
        expect(report).toContain('§5.1 Roadmap');
        expect(report.indexOf('§5.1 Roadmap')).toBeLessThan(report.indexOf('§9 Later'));
      });`,
    },
    // Corrected: the filtered list is asserted non-empty.
    {
      filename: TEST_FILE,
      code: `const accepted = fixtures.filter(f => f.valid);
      it('has accepted fixtures', () => { expect(accepted.length).toBeGreaterThan(0); });
      it.each(accepted)('round-trips %s', f => { expect(roundTrip(f)).toEqual(f); });`,
    },
    // A repeat after an action is a second observation, not a duplicate.
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(cache.size).toBe(1); warm(); expect(cache.size).toBe(1); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(() => init()).not.toThrow(); expect(() => init()).not.toThrow(); });`,
    },
    // Two inputs that differ only in a literal's spaces are two checks.
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(hit('grep -m 1 x')).toEqual([]); expect(hit('grep -m1 x')).toEqual([]); });`,
    },
    {
      filename: TEST_FILE,
      code: "it('a', () => { expect(hit(`grep -m 1 ${f}`)).toEqual([]); expect(hit(`grep -m1 ${f}`)).toEqual([]); });",
    },
  ],
  invalid: [
    // The catalogue example.
    {
      filename: TEST_FILE,
      code: `it('should require admin role', async () => {
        await request(server).post('/admin/inwards/upload').expect(403);
        expect(true).toBe(true); // Supertest handles assertion
      });`,
      errors: [{ messageId: 'staticSubject' }],
    },
    // Asserting the test's own input.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { const concurrency = 10; await run(concurrency); expect(concurrency).toBe(10); });`,
      errors: [{ messageId: 'staticSubject' }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(errors.length).toBeGreaterThanOrEqual(0); });`,
      errors: [{ messageId: 'nonNegative' }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(stats.flagRate.total).toBeGreaterThanOrEqual(0); });`,
      errors: [{ messageId: 'nonNegative' }],
    },
    // `typeof` of `.some()`.
    {
      filename: TEST_FILE,
      code: `it('a', () => {
        const testBuildAllowsDeleteLimit = options.some(o => o.includes('LIMIT'));
        expect(typeof testBuildAllowsDeleteLimit).toBe('boolean');
      });`,
      errors: [{ messageId: 'typeFixed' }],
    },
    // A constructor result is never undefined.
    {
      filename: TEST_FILE,
      code: `it('should be defined', () => { expect(new JwtAuthGuard(redis)).toBeDefined(); });`,
      errors: [{ messageId: 'typeFixed' }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(new Date(result.serverTimestamp)).toBeInstanceOf(Date); });`,
      errors: [{ messageId: 'construction' }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { const d = parse(raw); expect(d).toBeInstanceOf(Date); });`,
      errors: [{ messageId: 'soleInstanceOf' }],
    },
    // A tautological disjunct.
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(seen[0].endsWith('suffix:off') || !seen[0].includes('marker')).toBe(true); });`,
      errors: [{ messageId: 'orInSubject' }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(hits.every(h => h.tenant === 'B')).toBe(true); });`,
      errors: [{ messageId: 'vacuousEvery' }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(report.indexOf('§5.1 Roadmap')).toBeLessThan(report.indexOf('§9 Later')); });`,
      errors: [{ messageId: 'unguardedOrder' }],
    },
    {
      filename: TEST_FILE,
      code: `it.each(fixtures.filter(f => f.valid))('round-trips %s', f => { expect(roundTrip(f)).toEqual(f); });`,
      errors: [{ messageId: 'eachFilter' }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => {
        expect(isAncestor(branchPoint, head)).toBe(true);
        expect(isAncestor(otherBranchTip, head)).toBe(true);
        expect(isAncestor(otherBranchTip, head)).toBe(true);
      });`,
      errors: [{ messageId: 'duplicate' }],
    },
    // Layout and a trailing comment do not make a repeat a new check.
    {
      filename: TEST_FILE,
      code: `it('a', () => {
        expect(isAncestor(tip, head)).toBe(true);
        expect(isAncestor( tip,
          head )).toBe(true); // again
      });`,
      errors: [{ messageId: 'duplicate' }],
    },
  ],
});

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

interface Flip {
  rule: string;
  messageId: string;
  corrected: string;
  guard: string;
  replacement?: string;
  filename?: string;
  options?: unknown[];
}

const FLIPS: Flip[] = [
  {
    rule: 'no-vacuous-assertion',
    messageId: 'staticSubject',
    corrected: `it('a', () => { expect(response.body.code).toBe('FORBIDDEN'); });`,
    guard: 'response.body.code',
    replacement: `'FORBIDDEN'`,
  },
  {
    rule: 'no-vacuous-assertion',
    messageId: 'vacuousEvery',
    corrected: `it('a', () => { expect(hits.length).toBeGreaterThan(0); expect(hits.every(h => h.ok)).toBe(true); });`,
    guard: 'expect(hits.length).toBeGreaterThan(0);',
  },
  {
    rule: 'no-vacuous-assertion',
    messageId: 'unguardedOrder',
    corrected: `it('a', () => { expect(report).toContain('A'); expect(report.indexOf('A')).toBeLessThan(report.indexOf('B')); });`,
    guard: `expect(report).toContain('A');`,
  },
  {
    rule: 'no-vacuous-assertion',
    messageId: 'eachFilter',
    corrected: `const ok = all.filter(f => f.ok); it('has cases', () => { expect(ok.length).toBeGreaterThan(0); }); it.each(ok)('%s', f => { expect(f).toBeTruthy(); });`,
    guard: `expect(ok.length).toBeGreaterThan(0);`,
  },
];

describe('guard removal flips each corrected case', () => {
  each(FLIPS.map(flip => [`${flip.rule}/${flip.messageId}`, flip] as const))(
    '%s',
    (_name, flip) => {
      const filename = flip.filename ?? TEST_FILE;
      assert.deepEqual(messageIds(flip.rule, flip.corrected, filename, flip.options), []);
      assert.ok((flip.corrected).includes(flip.guard));
      const broken = flip.corrected.replace(flip.guard, flip.replacement ?? '');
      assert.ok((messageIds(flip.rule, broken, filename, flip.options)).includes(flip.messageId));
    },
  );
});

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

const HELPER_CASES_A: CaseA[] = [
  // isStatic: each composition, and the depth limit at exactly 4.
  nva(`it('a', () => { expect([[[[[1]]]]]).toEqual([]); });`),
  nva(`it('a', () => { expect([[[[1]]]]).toEqual([]); });`, ['staticSubject']),
  nva("it('a', () => { expect([[[[`${1}`]]]]).toEqual([]); });"),
  nva("it('a', () => { expect(`a${1}`).toBe('a1'); });", ['staticSubject']),
  nva(`it('a', () => { const k = -1; expect([[[[k]]]]).toEqual([]); });`),
  nva(`it('a', () => { expect(undefined).toBe(undefined); });`, [
    'staticSubject',
  ]),
  nva(`it('a', () => { expect(-1).toBe(-1); });`, ['staticSubject']),
  nva(`it('a', () => { expect(delete 1).toBe(true); });`),
  nva(`it('a', () => { expect([[[[-1]]]]).toEqual([]); });`),
  nva(`it('a', () => { expect(1 + 1).toBe(2); });`, ['staticSubject']),
  nva(`it('a', () => { expect(1 ?? 2).toBe(1); });`, ['staticSubject']),
  nva(`it('a', () => { expect(1 + x).toBe(2); });`),
  nva(`it('a', () => { expect([[[-1 + 1]]]).toEqual([]); });`),
  nva(`it('a', () => { expect([[[1 + -1]]]).toEqual([]); });`),
  nva(`it('a', () => { expect([x]).toEqual([1]); });`),
  nva(`it('a', () => { expect([...xs]).toEqual([]); });`),
  nva(`it('a', () => { expect([, 1]).toEqual([]); });`),
  nva(`it('a', () => { expect({ a: 1 }).toEqual({ a: 1 }); });`, [
    'staticSubject',
  ]),
  nva(`it('a', () => { expect({ a: x }).toEqual({ a: 1 }); });`),
  nva(`it('a', () => { expect({ ...x }).toEqual({}); });`),
  nva(`it('a', () => { expect({ [k]: 1 }).toEqual({}); });`),
  nva(`it('a', () => { expect([[[[{ a: 1 }]]]]).toEqual([]); });`),
  // isStaticPrimitive: a regex or array const can change; a primitive cannot.
  nva(`it('a', () => { const re = /a/; expect(re).toBe(re); });`),
  nva(`it('a', () => { const xs = [1]; expect(xs).toEqual([1]); });`),
  nva(`it('a', () => { const n = 1 + 1; expect(n).toBe(2); });`),
  nva(`it('a', () => { const n = -1; expect(n).toBe(-1); });`, [
    'staticSubject',
  ]),
  nva("it('a', () => { const s = `a${1}`; expect(s).toBe('a1'); });", [
    'staticSubject',
  ]),
  nva(`it('a', () => { const a = 1; const b = a; expect(b).toBe(1); });`, [
    'staticSubject',
  ]),
  // fixedTypeOf: the depth limit at exactly 3 const hops.
  nva(
    `it('a', () => { const a = xs.some(f); const b = a; const c = b; expect(typeof c).toBe('boolean'); });`,
    ['typeFixed'],
  ),
  nva(
    `it('a', () => { const a = xs.some(f); const b = a; const c = b; const d = c; expect(typeof d).toBe('boolean'); });`,
  ),
  // A second, non-static argument keeps the subject out of staticSubject so
  // the literal branches of fixedTypeOf decide.
  nva(`it('a', () => { expect(typeof 1).toBe('number', note); });`, [
    'typeFixed',
  ]),
  nva(`it('a', () => { expect(typeof null).toBe('object', note); });`, [
    'typeFixed',
  ]),
  nva(`it('a', () => { expect(typeof /a/).toBe('object', note); });`, [
    'typeFixed',
  ]),
  nva("it('a', () => { expect(typeof `a`).toBe('string', note); });", [
    'typeFixed',
  ]),
  nva(`it('a', () => { expect(typeof []).toBe('object', note); });`, [
    'typeFixed',
  ]),
  nva(`it('a', () => { expect(typeof {}).toBe('object', note); });`, [
    'typeFixed',
  ]),
];

/** Methods and operators whose result type JavaScript fixes. */
const FIXED_RESULT_TYPES: [string, string][] = [
  ['x.every(f)', 'boolean'],
  ['x.includes(y)', 'boolean'],
  ['x.startsWith(y)', 'boolean'],
  ['x.endsWith(y)', 'boolean'],
  // `has` and `test` only on a receiver syntax shows is built in.
  ['new Set(xs).has(y)', 'boolean'],
  ['new Map(xs).has(y)', 'boolean'],
  ['new WeakSet().has(y)', 'boolean'],
  ['new WeakMap().has(y)', 'boolean'],
  ['/a/.test(y)', 'boolean'],
  ['new RegExp(p).test(y)', 'boolean'],
  ['RegExp(p).test(y)', 'boolean'],
  ['Array.isArray(y)', 'boolean'],
  ['Number.isInteger(y)', 'boolean'],
  ['Number.isFinite(y)', 'boolean'],
  ['Number.isNaN(y)', 'boolean'],
  ['Number.isSafeInteger(y)', 'boolean'],
  ['x.join(y)', 'string'],
  ['x.trim()', 'string'],
  ['x.trimStart()', 'string'],
  ['x.trimEnd()', 'string'],
  ['x.toUpperCase()', 'string'],
  ['x.toLowerCase()', 'string'],
  ['x.padStart(y)', 'string'],
  ['x.padEnd(y)', 'string'],
  ['x.repeat(y)', 'string'],
  ['x.replace(y, z)', 'string'],
  ['x.replaceAll(y, z)', 'string'],
  ['x.toFixed(y)', 'string'],
  ['x.toISOString()', 'string'],
  ['x.indexOf(y)', 'number'],
  ['x.lastIndexOf(y)', 'number'],
  ['x.findIndex(f)', 'number'],
  ['x.findLastIndex(f)', 'number'],
  ['x.search(y)', 'number'],
  ['x.charCodeAt(y)', 'number'],
  ['x.getTime()', 'number'],
  ['x.valueOf()', 'number'],
  ['(x === y)', 'boolean'],
  ['(x !== y)', 'boolean'],
  ['(x == y)', 'boolean'],
  ['(x != y)', 'boolean'],
  ['(x < y)', 'boolean'],
  ['(x > y)', 'boolean'],
  ['(x <= y)', 'boolean'],
  ['(x >= y)', 'boolean'],
  ['(x instanceof Y)', 'boolean'],
  ['(k in x)', 'boolean'],
  ['Boolean(y)', 'boolean'],
  ['String(y)', 'string'],
  ['Number(y)', 'number'],
  ['parseInt(y)', 'number'],
  ['parseFloat(y)', 'number'],
  ['Math.max(y)', 'number'],
];

const inTest = (body: string): string => `it('a', () => { ${body} });`;

const VACUOUS = ['vacuousEvery'];

const UNGUARDED = ['unguardedOrder'];

/** `proof` first, then an `every()` check that needs rows proved non-empty. */
const everyAfter = (proof: string, ids: string[] = []): CaseA =>
  nva(inTest(`${proof} expect(rows.every(f)).toBe(true);`), ids);

/** `proof` first, then an order check that needs 'A' proved present. */
const orderAfter = (proof: string, ids: string[] = []): CaseA =>
  nva(
    inTest(`${proof} expect(r.indexOf('A')).toBeLessThan(r.indexOf('B'));`),
    ids,
  );

const VACUOUS_CASES_A: CaseA[] = [
  // fixedTypeOf: constructors, functions and unary operators.
  nva(inTest(`expect(typeof new Function(src)).toBe('function');`), [
    'typeFixed',
  ]),
  // A constructor may return a function
  // (`new Object(() => {})`), so only `new Function` fixes `typeof`.
  nva(inTest(`expect(typeof new Foo()).toBe('object');`)),
  nva(inTest(`expect(typeof new Object(() => {})).toBe('object');`)),
  nva(inTest(`expect(typeof new ns.Function(src)).toBe('function');`)),
  nva(inTest(`expect(typeof (() => 1)).toBe('function');`), ['typeFixed']),
  nva(inTest(`expect(typeof function () {}).toBe('function');`), ['typeFixed']),
  nva(inTest(`expect(typeof !x).toBe('boolean');`), ['typeFixed']),
  nva(inTest(`expect(typeof typeof x).toBe('string');`), ['typeFixed']),
  nva(inTest(`expect(typeof void x).toBe('undefined');`), ['typeFixed']),
  // An unknown operand may be a bigint, a Symbol or a throwing object.
  nva(inTest(`expect(typeof -x).toBe('number');`)),
  nva(inTest(`expect(typeof +x).toBe('number');`)),
  nva(inTest(`expect(typeof +1n).toBe('number', note);`)),
  nva(inTest(`expect(typeof +[]).toBe('number', note);`)),
  nva(inTest(`expect(typeof +'1').toBe('number', note);`), ['typeFixed']),
  nva(inTest(`expect(typeof -true).toBe('number', note);`), ['typeFixed']),
  nva(inTest(`expect(typeof +void x).toBe('number', note);`), ['typeFixed']),
  nva(inTest(`expect(typeof +1).toBe('number', note);`), ['typeFixed']),
  nva(inTest(`expect(typeof ~x).toBe('number');`)),
  nva(inTest(`expect(typeof -1n).toBe('bigint', note);`), ['typeFixed']),
  nva(inTest(`expect(typeof -1n).toBe('number', note);`)),
  nva(inTest(`expect(typeof -1).toBe('number', note);`), ['typeFixed']),
  nva(
    inTest(
      `const b = -1n; const c = b; const d = c; expect(typeof d).toBe('bigint', note);`,
    ),
  ),
  nva(
    inTest(
      `const b = 1n; const c = b; expect(typeof -c).toBe('bigint', note);`,
    ),
    ['typeFixed'],
  ),
  nva(inTest(`expect(typeof (a + b)).toBe('number');`)),
  nva(inTest(`expect(typeof make(y)).toBe('number');`)),
  nva(inTest(`expect(typeof x.foo()).toBe('boolean');`)),
  nva(inTest(`expect(typeof x.foo()).toBe('string');`)),
  nva(inTest(`expect(typeof x.foo()).toBe('number');`)),
  nva(inTest(`expect(typeof make()()).toBe('number');`)),
  nva(inTest(`expect(typeof other.max(a)).toBe('number');`)),
  nva(inTest(`expect(typeof ns.Math.max(a)).toBe('number');`)),
  nva(inTest(`expect(typeof x[k]()).toBe('number');`)),
  // isCount and isNumber: what counts as a count, and -1 vs other numbers.
  nva(inTest(`expect(total).toBeGreaterThanOrEqual(0);`), ['nonNegative']),
  nva(inTest(`expect(q.count()).toBeGreaterThanOrEqual(0);`), ['nonNegative']),
  nva(inTest(`expect(q.Count()).toBeGreaterThanOrEqual(0);`), ['nonNegative']),
  nva(inTest(`expect(q.counts()).toBeGreaterThanOrEqual(0);`)),
  nva(inTest(`expect(count()).toBeGreaterThanOrEqual(0);`)),
  nva(inTest(`expect(x.foo()).toBeGreaterThanOrEqual(0);`)),
  nva(inTest(`expect(a + b).toBeGreaterThanOrEqual(0);`)),
  nva(inTest(`expect(x.foo).toBeGreaterThanOrEqual(0);`)),
  nva(inTest(`expect(x[k]).toBeGreaterThanOrEqual(0);`)),
  nva(inTest(`expect(x.itemCount).toBeGreaterThanOrEqual(0);`), [
    'nonNegative',
  ]),
  nva(inTest(`expect(x.item_count).toBeGreaterThanOrEqual(0);`), [
    'nonNegative',
  ]),
  nva(inTest(`expect(x.totalDiscount).toBeGreaterThanOrEqual(0);`)),
  nva(inTest(`expect(finalTotal).toBeGreaterThanOrEqual(0);`)),
  nva(inTest(`expect(errors.length).toBeGreaterThan(-1);`), ['nonNegative']),
  nva(inTest(`expect(errors.length).toBeGreaterThan(0);`)),
  nva(inTest(`expect(errors.length).toBeGreaterThan(-2);`)),
  nva(inTest(`expect(errors.length).toBeGreaterThan(-x);`)),
  nva(inTest(`expect(errors.length).toBeGreaterThan(+1);`)),
  nva(inTest(`expect(errors.length).toBeGreaterThanOrEqual(1);`)),
  nva(inTest(`expect(errors.length).not.toBeGreaterThanOrEqual(0);`)),
  nva(inTest(`expect(errors.length).toBeLessThan(-1);`)),
  // INDEX_METHODS and indexCall.
  nva(
    inTest(`expect(r.lastIndexOf('A')).toBeLessThan(r.lastIndexOf('B'));`),
    UNGUARDED,
  ),
  nva(
    inTest(`expect(r.findIndex(f)).toBeLessThan(r.findIndex(g));`),
    UNGUARDED,
  ),
  nva(inTest(`expect(r.search('A')).toBeLessThan(r.search('B'));`), UNGUARDED),
  nva(inTest(`expect(r.findLastIndex(f)).toBeLessThan(r.findLastIndex(g));`)),
  nva(
    inTest(`const i = r.indexOf('A'); expect(i).toBeLessThan(r.indexOf('B'));`),
    UNGUARDED,
  ),
  nva(
    inTest(`let i = r.indexOf('A'); expect(i).toBeLessThan(r.indexOf('B'));`),
  ),
  nva(inTest(`const i = load(); expect(i).toBeLessThan(r.indexOf('B'));`)),
  nva(inTest(`expect(r.foo('A')).toBeLessThan(r.indexOf('B'));`)),
  nva(inTest(`expect(indexOf('A')).toBeLessThan(r.indexOf('B'));`)),
  // everyReceiver.
  nva(inTest(`const ok = rows.every(f); expect(ok).toBe(true);`), VACUOUS),
  nva(inTest(`let ok = rows.every(f); expect(ok).toBe(true);`)),
  nva(inTest(`const ok = load(); expect(ok).toBe(true);`)),
  nva(inTest(`expect(rows.some(f)).toBe(true);`)),
  nva(inTest(`expect(every(f)).toBe(true);`)),
  nva(inTest(`expect([1, 2].every(f)).toBe(true);`)),
  // isTrueMatcher.
  nva(inTest(`expect(rows.every(f)).toBe(false);`)),
  nva(inTest(`expect(rows.every(f)).toBeTruthy();`), VACUOUS),
  nva(inTest(`expect(rows.every(f)).toBeFalsy();`)),
  // A derived `toEqual(true)` proves its own receiver, so the comparison
  // check is where the toEqual/toStrictEqual branches show.
  nva(inTest(`expect(rows.every(f)).toEqual(true);`)),
  nva(inTest(`expect(errors.length >= 0).toEqual(true);`), ['nonNegative']),
  nva(inTest(`expect(errors.length >= 0).toStrictEqual(true);`), [
    'nonNegative',
  ]),
  nva(inTest(`expect(errors.length >= 0).toContain(true);`)),
  nva(inTest(`expect(errors.length >= 0).not.toBe(true);`)),
  nva(inTest(`expect(errors.length >= 0).toBe(1);`)),
  nva(inTest(`expect(errors.length >= 0).toBe();`)),
  nva(inTest(`expect(rows.every(f)).toContain(true);`)),
  nva(inTest(`expect(rows.every(f)).not.toBe(true);`)),
  nva(inTest(`expect(rows.every(f)).toBe(1);`)),
  nva(inTest(`expect(rows.every(f)).toBe();`)),
  nva(inTest(`expect(rows.every(f)).toBe(x);`)),
  // provesNonEmpty: what does and does not prove the receiver non-empty.
  everyAfter(`expect().toBe(1);`, VACUOUS),
  everyAfter(`expect(rows).toHaveLength(2);`),
  everyAfter(`expect(rows).toHaveLength(0);`, VACUOUS),
  everyAfter(`expect(rows).not.toHaveLength(0);`),
  everyAfter(`expect(rows).not.toHaveLength(2);`, VACUOUS),
  everyAfter(`expect(rows).toEqual([1]);`),
  everyAfter(`expect(rows).toStrictEqual([1]);`),
  everyAfter(`expect(rows).toEqual(other);`),
  everyAfter(`expect(rows).toEqual([]);`, VACUOUS),
  everyAfter(`expect(rows).toEqual({});`, VACUOUS),
  everyAfter(`expect(rows).toEqual(0);`, VACUOUS),
  everyAfter(`expect(rows).toEqual();`, VACUOUS),
  everyAfter(`expect(rows).not.toEqual([]);`),
  everyAfter(`expect(rows).not.toEqual([1]);`, VACUOUS),
  everyAfter(`expect(rows).not.toEqual({});`, VACUOUS),
  everyAfter(`expect(rows).toBe(other);`, VACUOUS),
  everyAfter(`expect(rows).toContain(x);`),
  everyAfter(`expect(rows).toContainEqual(x);`),
  everyAfter(`expect(rows).not.toContain(x);`, VACUOUS),
  everyAfter(`expect(rows.map(f)).toEqual([1]);`),
  everyAfter(`expect(rows.map(f)).toStrictEqual([1]);`),
  everyAfter(`expect(rows.map(f)).toMatchObject([{ id: 1 }]);`),
  everyAfter(`expect(rows.map(f)).toContain(1);`),
  everyAfter(`expect(rows.map(f)).toContainEqual(1);`),
  everyAfter(`expect(rows.map(f)).toHaveLength(2);`),
  everyAfter(`expect(rows.map(f)).toEqual([]);`, VACUOUS),
  everyAfter(`expect(rows.map(f)).toMatchObject({});`, VACUOUS),
  everyAfter(`expect(rows.map(f)).toHaveLength(0);`, VACUOUS),
  everyAfter(`expect(rows.map(f)).toEqual();`, VACUOUS),
  everyAfter(`expect(rows.map(f)).toBe(x);`, VACUOUS),
  everyAfter(`expect(rows.map(f)).not.toEqual([1]);`, VACUOUS),
  everyAfter(`expect(new Set(rows)).toEqual(new Set([1]));`),
  // Only a built-in that keeps its argument's emptiness
  // carries the proof; any other call may return data of its own.
  everyAfter(`expect(new Map(rows)).toEqual(new Map([[1, 2]]));`),
  everyAfter(`expect(Array.from(rows)).toEqual([1]);`),
  everyAfter(`expect(Object.keys(rows)).toEqual(['0']);`),
  everyAfter(`expect(Object.values(rows)).toEqual([1]);`),
  everyAfter(`expect(Object.entries(rows)).toEqual([['0', 1]]);`),
  everyAfter(`expect(Object.fromEntries(rows)).toEqual({ a: 1 });`),
  everyAfter(`expect(summarize(rows)).toEqual({ total: 0 });`, VACUOUS),
  everyAfter(`expect(new Foo(rows)).toEqual({ a: 1 });`, VACUOUS),
  everyAfter(`expect(x.Array.from(rows)).toEqual([1]);`, VACUOUS),
  everyAfter(`expect(Array.from(other, () => rows)).toEqual([1]);`, VACUOUS),
  everyAfter(`expect(pick(rows.a)).toEqual([1]);`, VACUOUS),
  everyAfter(`const codes = rows.map(f).sort(); expect(codes).toEqual([1]);`),
  everyAfter(`let codes = rows.map(f); expect(codes).toEqual([1]);`, VACUOUS),
  everyAfter(
    `const codes = other.map(f); expect(codes).toEqual([1]);`,
    VACUOUS,
  ),
  everyAfter(`expect(other.map(f)).toEqual([1]);`, VACUOUS),
  everyAfter(`expect(rowsX.map(f)).toEqual([1]);`, VACUOUS),
  // Built from the receiver by structure, never by substring; a
  // callback that mentions the receiver does not make the value its own.
  everyAfter(`expect(other.map(() => f(rows))).toEqual([1]);`, VACUOUS),
  everyAfter(`expect(otherRows.map(f)).toEqual([1]);`, VACUOUS),
  everyAfter(`expect(f(other, rows)).toEqual([1]);`, VACUOUS),
  everyAfter(`expect([...rows]).toEqual([1]);`),
  everyAfter(`expect([, ...rows]).toEqual([1]);`),
  everyAfter(`expect([...other]).toEqual([1]);`, VACUOUS),
  everyAfter(`expect(rows.a.b.c.d.e.f.g.h).toEqual([1]);`),
  everyAfter(`expect(rows.a.b.c.d.e.f.g.h.i).toEqual([1]);`, VACUOUS),
  everyAfter(`expect(other).toEqual([1]);`, VACUOUS),
  everyAfter(`expect(rows.foo).toBe(1);`, VACUOUS),
  everyAfter(`expect(rows[k]).toBe(2);`, VACUOUS),
  everyAfter(`expect(rows['length']).toBe(2);`),
  everyAfter(`expect(rows.size).toBe(2);`),
  everyAfter(`expect(other.length).toBe(2);`, VACUOUS),
  everyAfter(`expect(rows.length).not.toBe(0);`),
  everyAfter(`expect(rows.length).not.toEqual(0);`),
  everyAfter(`expect(rows.length).not.toBe(5);`, VACUOUS),
  everyAfter(`expect(rows.length).not.toStrictEqual(0);`, VACUOUS),
  everyAfter(`expect(rows.length).toBeGreaterThan(0);`),
  everyAfter(`expect(rows.length).toBeGreaterThan(2);`),
  everyAfter(`expect(rows.length).toBeGreaterThan('a');`, VACUOUS),
  everyAfter(`expect(rows.length).toBeGreaterThan(x);`, VACUOUS),
  everyAfter(`expect(rows.length).toBeGreaterThanOrEqual(1);`),
  everyAfter(`expect(rows.length).toBeGreaterThanOrEqual(0);`, [
    'nonNegative',
    'vacuousEvery',
  ]),
  everyAfter(`expect(rows.length).toBeGreaterThanOrEqual('a');`, VACUOUS),
  everyAfter(`expect(rows.length).toBeGreaterThanOrEqual(x);`, VACUOUS),
  everyAfter(`expect(rows.length).toBe(2);`),
  everyAfter(`expect(rows.length).toEqual(2);`),
  everyAfter(`expect(rows.length).toStrictEqual(2);`),
  everyAfter(`expect(rows.length).toBe(x);`),
  // An empty-literal argument skips the derived-value proof, so these reach
  // the length branch's own toEqual/toStrictEqual reading.
  everyAfter(`expect(rows.length).toEqual([]);`),
  everyAfter(`expect(rows.length).toStrictEqual();`),
  everyAfter(`expect(rows.length).toMatchObject([]);`, VACUOUS),
  everyAfter(`expect(rows.length).toBe(0);`, VACUOUS),
  everyAfter(`expect(rows.length).toEqual(0);`, VACUOUS),
  everyAfter(`expect(rows.length).toBeTruthy();`),
  everyAfter(`expect(rows.length).toBeFalsy();`, VACUOUS),
  everyAfter(`expect(rows.length).toBeDefined();`, VACUOUS),
  everyAfter(`expect(rows.some(f)).toBe(true);`),
  everyAfter(`expect(rows.some(f)).toBeTruthy();`),
  everyAfter(`expect(rows.some(f)).toEqual(true);`),
  everyAfter(`expect(rows.some(f)).toBe(false);`, VACUOUS),
  everyAfter(`expect(rows.some(f)).toBe(1);`, VACUOUS),
  everyAfter(`expect(rows.some(f)).not.toBe(true);`, VACUOUS),
  everyAfter(`expect(other.some(f)).toBe(true);`, VACUOUS),
  everyAfter(`expect(rows.find(f)).toBe(true);`, VACUOUS),
  everyAfter(`expect(some(f)).toBe(true);`, VACUOUS),
  // provesFound: what does and does not prove the marker present.
  orderAfter(`expect().toBe(1);`, UNGUARDED),
  orderAfter(`expect(r).toContain('A');`),
  orderAfter(`expect(r).toMatch('A');`),
  orderAfter(`expect(r).toEqual('A');`, UNGUARDED),
  orderAfter(`expect(other).toContain('A');`, UNGUARDED),
  orderAfter(`expect(r).not.toContain('A');`, UNGUARDED),
  orderAfter(`expect(r).toContain('Z');`, UNGUARDED),
  orderAfter(`expect(r).toContain();`, UNGUARDED),
  orderAfter(`expect(r.indexOf('A')).toBeGreaterThan(-1);`),
  orderAfter(`expect(r.indexOf('A')).toBeGreaterThan(0);`),
  orderAfter(`expect(r.indexOf('A')).toBeGreaterThan(-2);`, UNGUARDED),
  orderAfter(`expect(r.indexOf('A')).toBeGreaterThan('a');`, UNGUARDED),
  orderAfter(`expect(r.indexOf('A')).toBeGreaterThanOrEqual(0);`),
  orderAfter(`expect(r.indexOf('A')).toBeGreaterThanOrEqual(-1);`, UNGUARDED),
  orderAfter(`expect(r.indexOf('A')).toBeGreaterThanOrEqual('a');`, UNGUARDED),
  orderAfter(`expect(r.indexOf('A')).not.toBe(-1);`),
  orderAfter(`expect(r.indexOf('A')).not.toEqual(-1);`),
  orderAfter(`expect(r.indexOf('A')).not.toBe(5);`, UNGUARDED),
  orderAfter(`expect(r.indexOf('A')).not.toStrictEqual(-1);`, UNGUARDED),
  orderAfter(`expect(r.indexOf('A')).toBe(0);`, UNGUARDED),
  orderAfter(`expect(r.indexOf('B')).toBeGreaterThan(-1);`, UNGUARDED),
  orderAfter(`expect(r.includes('A')).toBe(true);`),
  orderAfter(`expect(r.includes('A')).toBeTruthy();`),
  orderAfter(`expect(r.includes('A')).toBe(false);`, UNGUARDED),
  orderAfter(`expect(r.includes('A')).toBe(1);`, UNGUARDED),
  orderAfter(`expect(r.includes('A')).not.toBe(true);`, UNGUARDED),
  orderAfter(`expect(other.includes('A')).toBe(true);`, UNGUARDED),
  orderAfter(`expect(r.has('A')).toBe(true);`, UNGUARDED),
  orderAfter(`expect(r.includes('Z')).toBe(true);`, UNGUARDED),
  orderAfter(`expect(r.includes()).toBe(true);`, UNGUARDED),
  orderAfter(`expect(includes('A')).toBe(true);`, UNGUARDED),
  nva(
    inTest(
      `const i = r.indexOf('A'); expect(i).toBeGreaterThan(-1); expect(i).toBeLessThan(r.indexOf('B'));`,
    ),
  ),
  nva(
    inTest(
      `expect(r).toContain('A'); expect(r.indexOf()).toBeLessThan(r.indexOf('B'));`,
    ),
    UNGUARDED,
  ),
  nva(
    inTest(
      `expect(r.includes()).toBe(true); expect(r.indexOf()).toBeLessThan(r.indexOf('B'));`,
    ),
    UNGUARDED,
  ),
  // ORDER_MATCHERS: which side must be the guarded index.
  nva(
    inTest(`expect(r.indexOf('A')).toBeLessThanOrEqual(r.indexOf('B'));`),
    UNGUARDED,
  ),
  nva(
    inTest(`expect(r.indexOf('B')).toBeGreaterThan(r.indexOf('A'));`),
    UNGUARDED,
  ),
  nva(
    inTest(`expect(r.indexOf('B')).toBeGreaterThanOrEqual(r.indexOf('A'));`),
    UNGUARDED,
  ),
  nva(
    inTest(
      `expect(r).toContain('A'); expect(r.indexOf('B')).toBeGreaterThan(r.indexOf('A'));`,
    ),
  ),
  nva(inTest(`expect(r.indexOf('A')).toBe(r.indexOf('B'));`)),
  nva(inTest(`expect(r.indexOf('A')).not.toBeLessThan(r.indexOf('B'));`)),
  nva(inTest(`expect(r.indexOf('A')).toBeLessThan();`)),
  nva(inTest(`expect(r.indexOf('B')).toBeGreaterThan(5);`)),
  nva(inTest(`expect(r.indexOf('A')).toBeLessThan(5);`), UNGUARDED),
  nva(inTest(`expect(5).toBeLessThan(r.indexOf('A'));`)),
  nva(inTest(`expect(x).toBeGreaterThan(r.indexOf('A'));`), UNGUARDED),
  // chainHasFilter and the named-table each check.
  nva(
    `it.each(rows.filter(f).map(g))('x %s', v => { expect(run(v)).toBe(1); });`,
    ['eachFilter'],
  ),
  nva(`it.each(load())('x %s', v => { expect(run(v)).toBe(1); });`),
  nva(`it.each(rows.map(g))('x %s', v => { expect(run(v)).toBe(1); });`),
  nva(`it.each(make()())('x %s', v => { expect(run(v)).toBe(1); });`),
  nva(`it.each(filter(rows))('x %s', v => { expect(run(v)).toBe(1); });`),
  nva(
    `const cases = rows.filter(f); it.each(cases)('x %s', v => { expect(run(v)).toBe(1); });`,
    ['eachFilter'],
  ),
  nva(
    `const cases = rows.filter(f); it('n', () => { expect(cases).toHaveLength(2); }); it.each(cases)('x %s', v => { expect(run(v)).toBe(1); });`,
  ),
  nva(
    `let cases = rows.filter(f); it.each(cases)('x %s', v => { expect(run(v)).toBe(1); });`,
  ),
  nva(
    `const cases = load(); it.each(cases)('x %s', v => { expect(run(v)).toBe(1); });`,
  ),
  // checkBlock: what repeats, and what resets the run.
  nva(inTest(`expect(a).toBe(1); expect(a).toBe(1);`), ['duplicate']),
  nva(inTest(`expect(a ).toBe( 1); expect(a).toBe(1);`), ['duplicate']),
  // Two expressions whose tokens would join to the same text.
  nva(inTest(`expect(typeof x).toBe(y); expect(typeofx).toBe(y);`)),
  nva(
    `it('a', async () => { await expect(a).toBe(1); await expect(a).toBe(1); });`,
    ['duplicate'],
  ),
  nva(inTest(`expect(run).toThrow(); expect(run).toThrow();`)),
  nva(inTest(`expect(run).toThrowError(); expect(run).toThrowError();`)),
  nva(
    inTest(
      `expect(() => run()).not.toThrow(); expect(() => run()).not.toThrow();`,
    ),
  ),
  nva(
    `it('a', async () => { await expect(p).resolves.toBe(1); await expect(p).resolves.toBe(1); });`,
  ),
  nva(
    `it('a', async () => { await expect(p).rejects.toBe(1); await expect(p).rejects.toBe(1); });`,
  ),
  nva(inTest(`expect(a).toBe(1); x = 2; expect(a).toBe(1);`)),
  nva(inTest(`expect(a).toBe(1); const y = 2; expect(a).toBe(1);`)),
  nva(inTest(`expect(a).toBe(1); expect(b).toBe(1); expect(a).toBe(1);`), [
    'duplicate',
  ]),
  nva(`function f() { expect(a).toBe(1); expect(a).toBe(1); }`),
  // nonNegative on a comparison.
  nva(inTest(`expect(errors.length >= 0).toBe(true);`), ['nonNegative']),
  nva(inTest(`expect(errors.length >= (0)).toBeTruthy();`), ['nonNegative']),
  nva(inTest(`expect(delta >= 0).toBe(true);`)),
  nva(inTest(`expect(errors.length > 0).toBe(true);`)),
  nva(inTest(`expect(errors.length >= 1).toBe(true);`)),
  nva(inTest(`expect(errors.length >= 0).toBe(false);`)),
  nva(inTest(`expect(0 <= errors.length).toBe(true);`)),
  nva(inTest(`expect(a + b).toBe(3);`)),
  // The typeof check: matchers, negation, and the literal it compares to.
  nva(inTest(`expect(!(a < b)).toBe('boolean');`)),
  nva(inTest(`expect(typeof xs.some(f)).not.toBe('boolean');`)),
  nva(inTest(`expect(typeof xs.some(f)).toEqual('boolean');`), ['typeFixed']),
  nva(inTest(`expect(typeof xs.some(f)).toStrictEqual('boolean');`), [
    'typeFixed',
  ]),
  nva(inTest(`expect(typeof xs.some(f)).toContain('boolean');`)),
  nva(inTest(`expect(typeof xs.some(f)).toBe('string');`)),
  nva(inTest(`expect(typeof xs.some(f)).toBe(kind);`)),
  nva(inTest(`expect(typeof value).toBe('boolean');`)),
  // presence: which matchers, and which fixed types make them vacuous.
  nva(inTest(`expect(new Foo()).not.toBeNull();`), ['typeFixed']),
  nva(inTest(`expect(new Foo()).toBeNull();`)),
  nva(inTest(`expect(new Foo()).toBeUndefined();`)),
  nva(inTest(`expect(new Foo()).toBeTruthy();`), ['typeFixed']),
  nva(inTest(`expect(new Foo()).not.toBeTruthy();`)),
  nva(inTest(`expect(new Foo()).toBeDefined();`), ['typeFixed']),
  nva(inTest(`expect(new Foo()).not.toBeDefined();`)),
  nva(inTest(`expect(new Foo()).toBeFalsy();`)),
  nva(inTest(`expect(String(x)).toBeTruthy();`)),
  nva(inTest(`expect(String(x)).toBeDefined();`), ['typeFixed']),
  nva(inTest(`expect(() => 1).toBeTruthy();`), ['typeFixed']),
  nva(inTest(`expect([x]).toBeTruthy();`), ['typeFixed']),
  nva(inTest(`expect(result).toBeDefined();`)),
  nva(inTest(`expect(void x).toBeDefined();`)),
  // construction and the sole Date check.
  nva(inTest(`expect(new Foo()).toBeInstanceOf(Foo);`), ['construction']),
  nva(inTest(`expect(new Foo()).toBeInstanceOf(Bar);`)),
  nva(inTest(`expect(new Foo()).not.toBeInstanceOf(Foo);`)),
  nva(inTest(`expect(new Foo()).toBeInstanceOf();`)),
  nva(inTest(`expect(new Foo()).toBe(Foo);`)),
  nva(inTest(`expect(make()).toBeInstanceOf(make);`)),
  nva(inTest(`const d = parse(raw); expect(d).toBeInstanceOf(Date);`), [
    'soleInstanceOf',
  ]),
  nva(inTest(`const d = parse(raw); expect(d).not.toBeInstanceOf(Date);`)),
  nva(inTest(`const d = parse(raw); expect(d).toBe(Date);`)),
  nva(inTest(`const d = parse(raw); expect(d).toBeInstanceOf(ns.Date);`)),
  nva(inTest(`const d = parse(raw); expect(d).toBeInstanceOf(Dates);`)),
  nva(
    inTest(
      `const d = parse(raw); expect(d).toBeInstanceOf(Date); expect(d.getTime()).toBe(1);`,
    ),
  ),
  nva(`const d = parse(raw); expect(d).toBeInstanceOf(Date);`),
  // orInSubject through ! and Boolean().
  nva(inTest(`expect(!(a || b)).toBe(true);`), ['orInSubject']),
  nva(inTest(`expect(!!(a || b)).toBe(true);`), ['orInSubject']),
  nva(inTest(`expect(Boolean(a || b)).toBe(true);`), ['orInSubject']),
  nva(inTest(`expect(-(a || b)).toBe(1);`)),
  nva(inTest(`expect(f(a || b)).toBe(true);`)),
  nva(inTest(`expect(ns.Boolean(a || b)).toBe(true);`)),
  nva(inTest(`expect(Boolean()).toBe(true);`)),
  nva(inTest(`expect(!(a && b)).toBe(true);`)),
  nva(inTest(`expect(a ?? b).toBe(true);`)),
];

/** The meta of every rule in this share, verbatim. */
const META_A: Record<string, unknown> = {
  'no-vacuous-assertion': {
    type: 'problem',
    docs: {
      description:
        'Assertions whose outcome is fixed before the code under test runs (TEST-WEAK-03)',
    },
    schema: [],
    messages: {
      staticSubject:
        'This assertion compares values the test wrote itself, so it passes whatever the code does. Assert on a value the code under test produced.',
      nonNegative:
        'A length or count is never negative, so `>= 0` always passes. Assert the number you expect (`toBe(n)`, `toBeGreaterThan(0)`).',
      typeFixed:
        "JavaScript already fixes this outcome (`{{fixed}}`), so the assertion cannot fail. Assert the value's content instead.",
      construction:
        '`new X()` is always an instance of X, so this assertion cannot fail. Assert on what the constructed value holds (for a Date: `Number.isNaN(d.getTime())`).',
      soleInstanceOf:
        'The only assertion in this test is `toBeInstanceOf(Date)`, which an Invalid Date passes. Check the time value (`Number.isNaN(d.getTime())`) or the exact instant.',
      orInSubject:
        '`||` inside the asserted value makes the assertion pass when either side holds, so the side you meant can regress unnoticed. Assert each condition separately.',
      vacuousEvery:
        '`every()` is true on an empty array, so this passes when nothing was produced. Assert the array is non-empty in the same test first.',
      unguardedOrder:
        'An absent marker has index -1, which is less than any position, so this ordering check passes when the item is missing. Assert it is present (`toContain`) first.',
      eachFilter:
        '`.each()` over a `.filter()` result registers zero tests, and a green run, when the filter matches nothing. Name the filtered list and assert it is non-empty.',
      duplicate:
        'This assertion repeats the one above it with nothing in between, so it adds no coverage. Remove it, or make the intent (e.g. a memo check) explicit with a different assertion.',
    },
  },
};

/** Every message of one rule run, as rendered text. */
function messagesA(
  rule: string,
  code: string,
  sourceType: 'module' | 'script' = 'module',
): string[] {
  return new Linter({ configType: 'flat' })
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser, sourceType },
          plugins: { 'shuddhi': plugin },
          rules: { [`shuddhi/${rule}`]: 'error' },
        },
      ],
      TEST_FILE,
    )
    .map(message => message.message);
}

describe('decision pins A: no-vacuous-assertion', () => {
  each(VACUOUS_CASES_A.map(c => [c.code, c] as const))('%s', (_name, c) => {
    assert.deepEqual(messageIds(c.rule, c.code, c.filename ?? TEST_FILE), c.ids);
  });

  each(Object.keys(META_A))('pins the meta of %s', name => {
    assert.deepEqual(rules[name].meta, META_A[name]);
  });

  it('names the fixed typeof outcome', () => {
    assert.deepEqual(messagesA(
        'no-vacuous-assertion',
        inTest(`expect(typeof xs.some(f)).toBe('boolean');`),
      ), [
      "JavaScript already fixes this outcome (`typeof … === 'boolean'`), so the assertion cannot fail. Assert the value's content instead.",
    ]);
  });

  it('names a truthiness check an object always passes', () => {
    assert.deepEqual(messagesA(
        'no-vacuous-assertion',
        inTest(`expect(new Foo()).toBeTruthy();`),
      ), [
      "JavaScript already fixes this outcome (`a constructed value is never falsy`), so the assertion cannot fail. Assert the value's content instead.",
    ]);
  });

  it('names a presence check an object always passes', () => {
    assert.deepEqual(messagesA(
        'no-vacuous-assertion',
        inTest(`expect(new Foo()).toBeDefined();`),
      ), [
      "JavaScript already fixes this outcome (`a constructed value is never null or undefined`), so the assertion cannot fail. Assert the value's content instead.",
    ]);
  });
});

describe('decision pins A: vacuous helpers', () => {
  each(HELPER_CASES_A.map(c => [`${c.rule}: ${c.code}`, c] as const))(
    '%s',
    (_name, c) => {
      assert.deepEqual(messageIds(c.rule, c.code, c.filename ?? TEST_FILE), c.ids);
    },
  );
  each(FIXED_RESULT_TYPES)('typeof %s is always %s', (value, type) => {
    assert.deepEqual(messageIds(
        'no-vacuous-assertion',
        `it('a', () => { expect(typeof ${value}).toBe('${type}'); });`,
      ), ['typeFixed']);
  });
  // An application `has`, `test` or `toString` can return anything.
  each([
    ['response.has(y)', 'boolean'],
    ['service.test(y)', 'boolean'],
    ['value.toString()', 'string'],
    ['new Foo().has(y)', 'boolean'],
    ['new Set(xs).test(y)', 'boolean'],
    ['/a/.has(y)', 'boolean'],
    ["'abc'.test(y)", 'boolean'],
    ['make(Set).has(y)', 'boolean'],
    ['this.seen.has(y)', 'boolean'],
    ['new ns.Set().has(y)', 'boolean'],
  ])('typeof %s is not fixed', (value, type) => {
    assert.deepEqual(messageIds(
        'no-vacuous-assertion',
        `it('a', () => { expect(typeof ${value}).toBe('${type}'); });`,
      ), []);
  });
  it('follows a const to the built-in receiver three deep, no further', () => {
    const at = (hops: string[], name: string): string[] =>
      messageIds(
        'no-vacuous-assertion',
        `${hops.join(' ')} it('a', () => { expect(typeof ${name}.test(y)).toBe('boolean'); });`,
      );
    assert.deepEqual(at(['const a = /x/;', 'const b = a;', 'const c = b;'], 'c'), ['typeFixed']);
    assert.deepEqual(at(
        ['const a = /x/;', 'const b = a;', 'const c = b;', 'const d = c;'],
        'd',
      ), []);
    assert.deepEqual(at(['let a = /x/;'], 'a'), []);
    assert.deepEqual(messageIds(
        'no-vacuous-assertion',
        `const seen = new Map(); it('a', () => { expect(seen.has(k)).toBeDefined(); });`,
      ), ['typeFixed']);
  });
});
