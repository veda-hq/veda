import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { format } from 'node:util';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin, { rules } from './index.js';

/**
 * TEST-WEAK-01 (detox-tap-by-id): the cases for `detox.js`, the module this suite owns.
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
// TEST-WEAK-01 (Detox)
// ---------------------------------------------------------------------------

const E2E_FILE = 'e2e/cart.e2e.test.ts';

ruleTester.run('detox-tap-by-id', rules['detox-tap-by-id'], {
  valid: [
    // Corrected: the cart icon tapped by its testID.
    {
      filename: E2E_FILE,
      code: `await element(by.id('tab-cart')).tap();`,
    },
    // Text is fine for what a test reads, only not for what it touches.
    {
      filename: E2E_FILE,
      code: `await waitFor(element(by.text('PAID'))).toBeVisible().withTimeout(5000);
      await detoxExpect(element(by.text('Auto-Applied'))).toBeVisible();`,
    },
    // An id on either side of .and, or under a scoping combinator.
    {
      filename: E2E_FILE,
      code: `await element(by.text('Pay').and(by.id('pay-button'))).tap();
      await element(by.id('row-1').withAncestor(by.text('Rings'))).typeText('x');`,
    },
    // A const binding to an id matcher or element is followed.
    {
      filename: E2E_FILE,
      code: `const cart = by.id('tab-cart');
      const input = element(by.id('search-input'));
      await element(cart).tap();
      await input.replaceText('ring');`,
    },
    // A matcher the rule cannot see (a helper's parameter) is not reported,
    // nor is one side of .and that it cannot see.
    {
      filename: E2E_FILE,
      code: `async function tapWhenHittable(matcher: Detox.NativeMatcher) { await element(matcher).tap(); }
      async function tapIn(scope: Detox.NativeMatcher) { await element(scope.and(by.text('Pay'))).tap(); }`,
    },
    // Not a Detox element: other receivers and non-actions.
    {
      filename: E2E_FILE,
      code: `await page.locator('text=Pay').tap();
      await element(by.text('Swipe')).swipe('left');
      await screen.getByText('Pay').click();
      await this.cart.tap();
      await list().atIndex(0).tap();
      await other(by.text('Pay')).tap();
      await element(by.text('Pay')).within().tap();
      let button = element(by.text('Pay'));
      await button.tap();`,
    },
    // Matchers it cannot read: no argument, a helper's result, a computed
    // or foreign matcher, an unknown combinator, an unknown side of .and.
    {
      filename: E2E_FILE,
      code: `await element().tap();
      await element(matcherFor('Pay')).tap();
      await element(by[kind]('Pay')).tap();
      await element(screen.text('Pay')).tap();
      await element(by.text('a').near(by.id('b'))).tap();
      await element(by.text('a').and()).tap();
      async function tapPay(scope: Detox.NativeMatcher) { await element(by.text('Pay').and(scope)).tap(); }`,
    },
    // An id on the left of .and.
    {
      filename: E2E_FILE,
      code: `await element(by.id('pay-button').and(by.text('Pay'))).tap();`,
    },
    // Bindings are followed three deep, no further.
    {
      filename: E2E_FILE,
      code: `const m1 = by.text('x'); const m2 = m1; const m3 = m2; const m4 = m3;
      await element(m4).tap();
      const e1 = element(by.text('x')); const e2 = e1; const e3 = e2; const e4 = e3;
      await e4.tap();`,
    },
  ],
  invalid: [
    // Restated in Detox: the cart tapped by its emoji text.
    {
      filename: E2E_FILE,
      code: `await element(by.text('🛒')).tap();`,
      errors: [
        { messageId: 'notById', data: { action: 'tap', matcher: 'by.text' } },
      ],
    },
    // Restated: a button tapped by its label text.
    {
      filename: E2E_FILE,
      code: `await element(by.text('Create Return')).longPress();`,
      errors: [{ messageId: 'notById' }],
    },
    // Restated: the target picked by position.
    {
      filename: E2E_FILE,
      code: `const input = element(by.type('RCTUITextField')).atIndex(0);
      await input.clearText();
      await input.typeText('ring');`,
      errors: [
        { messageId: 'atIndex', data: { action: 'clearText' } },
        { messageId: 'atIndex', data: { action: 'typeText' } },
      ],
    },
    // Even an id picked by position; text by position is reported once.
    {
      filename: E2E_FILE,
      code: `await element(by.id('add-to-cart-btn')).atIndex(1).tap();
      await element(by.text('Ring')).atIndex(0).tap();`,
      errors: [
        { messageId: 'atIndex', data: { action: 'tap' } },
        { messageId: 'atIndex', data: { action: 'tap' } },
      ],
    },
    // Three bindings deep is still followed.
    {
      filename: E2E_FILE,
      code: `const m1 = by.text('x'); const m2 = m1; const m3 = m2;
      await element(m3).tap();
      const e1 = element(by.text('x')); const e2 = e1; const e3 = e2;
      await e3.tap();`,
      errors: [{ messageId: 'notById' }, { messageId: 'notById' }],
    },
    {
      filename: E2E_FILE,
      code: `await element(by.text('Size 8').withDescendant(by.id('chip'))).tap();`,
      errors: [
        { messageId: 'notById', data: { action: 'tap', matcher: 'by.text' } },
      ],
    },
    // Other non-id matchers, bound through a const, scoped, or both sides
    // of .and known and neither an id.
    {
      filename: E2E_FILE,
      code: `const label = by.label('Search');
      await element(label).multiTap(2);
      await element(by.text('Size 8').withAncestor(by.id('sheet'))).tap();
      await element(by.text('A').and(by.label('B'))).replaceText('x');`,
      errors: [
        {
          messageId: 'notById',
          data: { action: 'multiTap', matcher: 'by.label' },
        },
        { messageId: 'notById', data: { action: 'tap', matcher: 'by.text' } },
        {
          messageId: 'notById',
          data: { action: 'replaceText', matcher: 'by.text' },
        },
      ],
    },
    {
      filename: E2E_FILE,
      code: `await (element(by.text('Go')) as Detox.IndexableNativeElement).tapReturnKey();
      await element(by.traits(['button'])).tapBackspaceKey();`,
      errors: [
        {
          messageId: 'notById',
          data: { action: 'tapReturnKey', matcher: 'by.text' },
        },
        {
          messageId: 'notById',
          data: { action: 'tapBackspaceKey', matcher: 'by.traits' },
        },
      ],
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
    rule: 'detox-tap-by-id',
    messageId: 'notById',
    corrected: `await element(by.id('tab-cart')).tap();`,
    guard: `by.id('tab-cart')`,
    replacement: `by.text('🛒')`,
    filename: 'e2e/cart.e2e.test.ts',
  },
  {
    rule: 'detox-tap-by-id',
    messageId: 'atIndex',
    corrected: `await element(by.id('search-input')).typeText('ring');`,
    guard: `)).typeText`,
    replacement: `)).atIndex(0).typeText`,
    filename: 'e2e/cart.e2e.test.ts',
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

// (end of kills A)

// ---------------------------------------------------------------------------
// Decision pins B: SHELL-09, TEST-WEAK-10, plugin and config blocks
// ---------------------------------------------------------------------------
const ruleMeta = (name: string): unknown =>
  (rules as Record<string, { meta: unknown } | undefined>)[name]?.meta;

describe('TEST-WEAK-01 rule metadata', () => {
  it('states the rule, its catalogue id and its messages verbatim', () => {
    assert.deepEqual(ruleMeta('detox-tap-by-id'), {
      type: 'problem',
      docs: {
        description:
          'Detox taps and text entry select their element by testID (TEST-WEAK-01)',
      },
      schema: [],
      messages: {
        notById:
          'This `{{action}}()` finds its element with `{{matcher}}(...)`, so a copy change, a translation or a second element with the same text breaks the flow or taps the wrong thing. Give the element a testID and select it with `by.id(...)`.',
        atIndex:
          'This `{{action}}()` picks its element by position (`atIndex`), so a reordered or added match taps a different element and the flow carries on. Give the element its own testID and select it with `by.id(...)`.',
      },
    });
  });
});
