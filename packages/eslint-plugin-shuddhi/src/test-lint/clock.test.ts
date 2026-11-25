import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin, { rules } from './index.js';

/**
 * The cases for `clock.js`: `poll-under-fake-timers` and
 * `expect-on-wall-clock`. Each `invalid` case is the lesson's shape, reduced
 * (veda docs/lessons/testing.md, "Clocks and wall-clock budgets"); each
 * `valid` case is the corrected code or a near miss.
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
const poll = (name: string) => ({ messageId: 'poll', data: { name } });

ruleTester.run('poll-under-fake-timers', rules['poll-under-fake-timers']!, {
  valid: [
    // Corrected: real timers for the poll.
    {
      filename: TEST_FILE,
      code: `it('waits', async () => {
        vi.useFakeTimers();
        arm();
        vi.useRealTimers();
        await expect.poll(() => state()).toBe('done');
      });`,
    },
    // No fake timers at all; a poll before the fake clock starts.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { await vi.waitFor(() => ready()); });
      it('b', async () => { await expect.poll(() => n()).toBe(1); vi.useFakeTimers(); });`,
    },
    // Fake timers in another test, or in a hook of another describe.
    {
      filename: TEST_FILE,
      code: `it('fakes', () => { vi.useFakeTimers(); });
      it('polls', async () => { await vi.waitFor(() => ready()); });
      describe('one', () => { beforeEach(() => { vi.useFakeTimers(); }); });
      describe('two', () => { it('polls', async () => { await expect.poll(f).toBe(1); }); });`,
    },
    // An afterEach that fakes them runs after the test; a helper is not read.
    {
      filename: TEST_FILE,
      code: `afterEach(() => { vi.useFakeTimers(); });
      function arm() { vi.useFakeTimers(); }
      it('polls', async () => { arm(); await vi.waitFor(() => ready()); });`,
    },
    // A hook fakes them; the test turns them off before polling.
    {
      filename: TEST_FILE,
      code: `beforeEach(() => { vi.useFakeTimers(); });
      it('polls', async () => { vi.useRealTimers(); await vi.waitFor(() => ready()); });`,
    },
    // Other members of expect and vi; a poll on another object.
    {
      filename: TEST_FILE,
      code: `vi.useFakeTimers();
      expect.soft(a).toBe(1); vi.advanceTimersByTime(10); other.poll(f); waiter.waitFor(f); poll(f);
      (fn)();`,
    },
    // A hook calls the poll itself after faking: still covered, below.
    // Here the real timers come back first in the same hook.
    {
      filename: TEST_FILE,
      code: `beforeAll(async () => { vi.useFakeTimers(); vi.useRealTimers(); await vi.waitFor(f); });`,
    },
  ],
  invalid: [
    // The lesson: polling under fake timers in the same test.
    {
      filename: TEST_FILE,
      code: `it('holds the deadline', async () => {
        vi.useFakeTimers();
        start();
        await expect.poll(() => state()).toBe('waiting');
        await vi.waitFor(() => ready());
      });`,
      errors: [poll('expect.poll'), poll('vi.waitFor')],
    },
    // A beforeEach of an enclosing describe; written after the test.
    {
      filename: TEST_FILE,
      code: `describe('suite', () => {
        it('polls', async () => { await vi.waitFor(() => ready()); });
        beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: false }); });
      });`,
      errors: [poll('vi.waitFor')],
    },
    // The top of the file, and a describe body, both run at collection.
    {
      filename: TEST_FILE,
      code: `vi.useFakeTimers();
      describe('a', () => { vi.useFakeTimers(); it('b', async () => { await expect.poll(f).toBe(1); }); });`,
      errors: [poll('expect.poll')],
    },
    // A real-timer call in another test does not restore this one; a
    // nested callback inside the test still counts.
    {
      filename: TEST_FILE,
      code: `beforeAll(() => { vi.useFakeTimers(); });
      it('other', () => { vi.useRealTimers(); });
      it('polls', async () => { await run(async () => { await vi.waitFor(f); }); });`,
      errors: [poll('vi.waitFor')],
    },
    // Fakes in a nested callback of the test, then a poll after it.
    {
      filename: TEST_FILE,
      code: `it('polls', async () => { setup(() => vi.useFakeTimers()); await vi.waitFor(f); });`,
      errors: [poll('vi.waitFor')],
    },
  ],
});

const wall = { messageId: 'wallClock' };

ruleTester.run('expect-on-wall-clock', rules['expect-on-wall-clock']!, {
  valid: [
    // Corrected: the clock frozen, the value exact.
    {
      filename: TEST_FILE,
      code: `vi.useFakeTimers({ shouldAdvanceTime: false });
      it('budget', () => { expect(remaining()).toBe(deadline - Date.now()); });`,
    },
    // setSystemTime alone also freezes what Date.now() reads.
    {
      filename: TEST_FILE,
      code: `vi.setSystemTime(new Date('2026-01-01'));
      expect(stamp()).toBe(Date.now());`,
    },
    // The clock in the subject (a timing budget), outside any expect, or in a
    // function the matcher calls later.
    {
      filename: TEST_FILE,
      code: `const t0 = Date.now();
      expect(Date.now() - t0).toBeLessThan(500);
      expect(value).toSatisfy(v => v <= Date.now());
      expect(at).toEqual(new Date('2026-01-01'));
      notExpect(Date.now());`,
    },
    // A binding is not followed: a value handed to the code under test and
    // asserted back compares one value with itself.
    {
      filename: TEST_FILE,
      code: `const now = new Date();
      save({ at: now });
      expect(load().at).toEqual(now);
      const t0 = Date.now();
      expect(stamp()).toBe(t0);
      expect(next()).toBe(t0 + 1);`,
    },
  ],
  invalid: [
    // The lesson: an exact value computed off the wall clock.
    {
      filename: TEST_FILE,
      code: `it('budget', () => { expect(remaining()).toBe(deadline - Date.now()); });`,
      errors: [wall],
    },
    // Widened to a range; inside an object; new Date(); behind a cast.
    {
      filename: TEST_FILE,
      code: `expect(at).toBeGreaterThanOrEqual(Date.now() - 50);
      expect(row).toMatchObject({ at: new Date() });
      expect(left()).toBe((Date!.now() as number) + 1);`,
      errors: [wall, wall, wall],
    },
    // Each read in one assertion is reported.
    {
      filename: TEST_FILE,
      code: `expect(span()).toEqual([Date.now() - 10, Date.now()]);`,
      errors: [wall, wall],
    },
  ],
});

// ---------------------------------------------------------------------------
// Deleting the guard from a corrected case brings the rule back
// ---------------------------------------------------------------------------

function messageIds(code: string, rule: string): string[] {
  return new Linter({ configType: 'flat' })
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          plugins: { shuddhi: plugin },
          rules: { [`shuddhi/${rule}`]: 'error' },
        },
      ],
      TEST_FILE,
    )
    .map(message => message.messageId ?? message.message);
}

describe('guard removal flips each corrected case', () => {
  it('poll-under-fake-timers', () => {
    const corrected = `it('w', async () => { vi.useFakeTimers(); vi.useRealTimers(); await vi.waitFor(f); });`;
    assert.deepEqual(messageIds(corrected, 'poll-under-fake-timers'), []);
    const broken = corrected.replace(' vi.useRealTimers();', '');
    assert.notEqual(broken, corrected);
    assert.deepEqual(messageIds(broken, 'poll-under-fake-timers'), ['poll']);
  });

  it('expect-on-wall-clock', () => {
    const corrected = `vi.useFakeTimers();\nexpect(left()).toBe(end - Date.now());`;
    assert.deepEqual(messageIds(corrected, 'expect-on-wall-clock'), []);
    const broken = corrected.replace('vi.useFakeTimers();\n', '');
    assert.notEqual(broken, corrected);
    assert.deepEqual(messageIds(broken, 'expect-on-wall-clock'), ['wallClock']);
  });
});

describe('clock rule metadata', () => {
  it('poll-under-fake-timers states its message verbatim', () => {
    assert.deepEqual(rules['poll-under-fake-timers']?.meta.messages, {
      poll: '`{{name}}` under fake timers calls `vi.advanceTimersByTime(interval)` on every retry, so the poll itself fires the fake deadline this test holds back. Wait with a recursive helper on `setTimeout` from `node:timers/promises`, or call `vi.useRealTimers()` first, and advance the fake clock yourself from an observed event.',
    });
    assert.equal(rules['poll-under-fake-timers']?.meta.type, 'problem');
  });

  it('expect-on-wall-clock is a suggestion with its message verbatim', () => {
    assert.deepEqual(rules['expect-on-wall-clock']?.meta.messages, {
      wallClock:
        'This expected value reads the wall clock, which has moved on since the code under test read it, so the assertion flakes on a loaded runner, and widening it to a range proves nothing. Freeze the clock, `vi.useFakeTimers({ shouldAdvanceTime: false })` with `vi.setSystemTime(...)`, and assert the exact value.',
    });
    assert.equal(rules['expect-on-wall-clock']?.meta.type, 'suggestion');
  });

  it('each clock rule describes itself in its docs', () => {
    assert.deepEqual(rules['poll-under-fake-timers']?.meta.docs, {
      description: 'expect.poll and vi.waitFor advance fake timers on every retry',
    });
    assert.deepEqual(rules['expect-on-wall-clock']?.meta.docs, {
      description:
        'An expected value read off the wall clock, in a file that never freezes it',
    });
  });
});

// ---------------------------------------------------------------------------
// The edges each rule decides on: in each case one fake decides the outcome
// ---------------------------------------------------------------------------

ruleTester.run('poll-under-fake-timers at its edges', rules['poll-under-fake-timers']!, {
  valid: [
    // Fakes at the top of the file written after the poll.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { await vi.waitFor(f); });
      vi.useFakeTimers();`,
    },
    // A top-level poll after the real timers come back.
    {
      filename: TEST_FILE,
      code: `vi.useFakeTimers(); vi.useRealTimers(); await vi.waitFor(f);`,
    },
    // A helper inside a describe body is not read.
    {
      filename: TEST_FILE,
      code: `describe('a', () => {
        function arm() { vi.useFakeTimers(); }
        it('b', async () => { await vi.waitFor(f); });
      });`,
    },
  ],
  invalid: [
    // Real timers before the fake ones restore nothing.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { vi.useRealTimers(); vi.useFakeTimers(); await vi.waitFor(f); });`,
      errors: [poll('vi.waitFor')],
    },
    // A beforeAll written after a top-level poll still runs first, and real
    // timers before the poll come before that hook too.
    {
      filename: TEST_FILE,
      code: `vi.useRealTimers(); await vi.waitFor(f);
      beforeAll(() => { vi.useFakeTimers(); });`,
      errors: [poll('vi.waitFor')],
    },
    // Each poll is held back on its own; an earlier poll restores nothing.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { vi.useFakeTimers(); await vi.waitFor(f); await expect.poll(g).toBe(1); });`,
      errors: [poll('vi.waitFor'), poll('expect.poll')],
    },
    // Real timers after the poll come too late.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { vi.useFakeTimers(); await vi.waitFor(f); vi.useRealTimers(); });`,
      errors: [poll('vi.waitFor')],
    },
    // Real timers in another test restore nothing in this one.
    {
      filename: TEST_FILE,
      code: `vi.useFakeTimers();
      it('other', () => { vi.useRealTimers(); });
      it('polls', async () => { await vi.waitFor(f); });`,
      errors: [poll('vi.waitFor')],
    },
    // A describe body alone fakes them.
    {
      filename: TEST_FILE,
      code: `describe('a', () => { vi.useFakeTimers(); it('b', async () => { await vi.waitFor(f); }); });`,
      errors: [poll('vi.waitFor')],
    },
    // One fake of two covers the poll.
    {
      filename: TEST_FILE,
      code: `it('a', () => { vi.useFakeTimers(); });
      it('b', async () => { vi.useFakeTimers(); await vi.waitFor(f); });`,
      errors: [poll('vi.waitFor')],
    },
  ],
});

ruleTester.run('expect-on-wall-clock at its edges', rules['expect-on-wall-clock']!, {
  valid: [
    // Another constructor, another Date method, another object's now().
    {
      filename: TEST_FILE,
      code: `expect(a).toEqual(new Foo());
      expect(b).toBe(Date.parse(s));
      expect(c).toBe(clock.now());
      expect(d).toBe(now());`,
    },
    // A type is not read.
    {
      filename: TEST_FILE,
      code: `expect(a).toBe(b as { [Date.now()]: number });`,
    },
  ],
  invalid: [
    // A hole in an array is walked past.
    {
      filename: TEST_FILE,
      code: `expect(span()).toEqual([, Date.now()]);`,
      errors: [wall],
    },
  ],
});
