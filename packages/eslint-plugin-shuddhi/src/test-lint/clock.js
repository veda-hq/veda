/**
 * Tests and the clock: a poll under fake timers (`poll-under-fake-timers`)
 * and an expected value read off the wall clock (`expect-on-wall-clock`).
 * One module because both read where a file turns fake timers on;
 * `clock.test.ts` owns it.
 *
 * WHY `poll-under-fake-timers`. Under fake timers, Vitest's `expect.poll` and
 * `vi.waitFor` call `vi.advanceTimersByTime(interval)` on every retry, so
 * polling fires the fake deadline the test meant to hold back.
 *
 * WHY `expect-on-wall-clock`. An expected value computed from `Date.now()`
 * (`deadline - Date.now()`) differs from the one production computed a moment
 * earlier, so the test flakes on a loaded runner, and widening the matcher to
 * a range is vacuous when production clamps the value. Freezing the clock
 * keeps the assertion exact. A warning: a file may freeze the clock some way
 * this rule does not read.
 *
 * SCOPE. Fake timers are on at a poll when, before it in source order and with
 * no `vi.useRealTimers()` between, `vi.useFakeTimers()` runs in the same test,
 * at the top of the file, or in a `beforeEach`/`beforeAll` registered in a
 * block that holds the poll. A helper that turns them on is not read.
 */
import {
  assertion,
  enclosingFunctions,
  enclosingTest,
  propertyName,
  registeringBlock,
  unwrap,
  within,
} from './helpers.js';

/** `vi.<method>(...)`: the method's name, or null. */
function viMethod(call) {
  const callee = unwrap(call.callee);
  if (callee.type !== 'MemberExpression') return null;
  const object = unwrap(callee.object);
  return object.type === 'Identifier' && object.name === 'vi'
    ? propertyName(callee)
    : null;
}

/** `expect.poll(...)` or `vi.waitFor(...)`: its name, or null. */
function pollOf(call) {
  if (viMethod(call) === 'waitFor') return 'vi.waitFor';
  const callee = unwrap(call.callee);
  if (callee.type !== 'MemberExpression') return null;
  const object = unwrap(callee.object);
  return object.type === 'Identifier' &&
    object.name === 'expect' &&
    propertyName(callee) === 'poll'
    ? 'expect.poll'
    : null;
}

const pollUnderFakeTimers = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'expect.poll and vi.waitFor advance fake timers on every retry',
    },
    schema: [],
    messages: {
      poll: '`{{name}}` under fake timers calls `vi.advanceTimersByTime(interval)` on every retry, so the poll itself fires the fake deadline this test holds back. Wait with a recursive helper on `setTimeout` from `node:timers/promises`, or call `vi.useRealTimers()` first, and advance the fake clock yourself from an observed event.',
    },
  },
  create(context) {
    const fakes = [];
    const reals = [];
    const polls = [];

    /**
     * Did `fake` turn fake timers on for `poll`, with no `vi.useRealTimers()`
     * between them? A `beforeEach`/`beforeAll` runs before the test it
     * covers, wherever it is written; code outside any test or hook (the
     * file's top, a `describe` body) runs at collection, before every test.
     */
    function covers(fake, poll) {
      const at = poll.range[0];
      const test = enclosingTest(poll, context);
      const restoredAfter = start =>
        reals.some(
          real =>
            real.range[0] > start &&
            real.range[0] < at &&
            (!test || within(real, test)),
        );
      const chain = enclosingFunctions(fake, context);
      const ownTest = chain.find(entry => entry.owner?.kind === 'test');
      if (ownTest) {
        return (
          ownTest.fn === test && fake.range[0] < at && !restoredAfter(fake.range[0])
        );
      }
      const hook = chain.find(entry => entry.owner?.kind === 'hook');
      if (hook) {
        return (
          /^before(All|Each)$/.test(hook.owner.name) &&
          within(poll, registeringBlock(hook.fn)) &&
          !restoredAfter(test ? test.range[0] : fake.range[0])
        );
      }
      if (chain.some(entry => entry.owner?.kind !== 'suite')) return false;
      return fake.range[0] < at && !restoredAfter(fake.range[0]);
    }

    return {
      CallExpression(node) {
        const method = viMethod(node);
        if (method === 'useFakeTimers') fakes.push(node);
        if (method === 'useRealTimers') reals.push(node);
        const name = pollOf(node);
        if (name) polls.push({ node, name });
      },
      'Program:exit'() {
        for (const poll of polls) {
          if (fakes.some(fake => covers(fake, poll.node))) {
            context.report({
              node: poll.node,
              messageId: 'poll',
              data: { name: poll.name },
            });
          }
        }
      },
    };
  },
};

/** `Date.now()` or `new Date()` with no arguments. */
function readsWallClock(node) {
  if (node.type === 'NewExpression') {
    return (
      node.callee.type === 'Identifier' &&
      node.callee.name === 'Date' &&
      node.arguments.length === 0
    );
  }
  if (node.type !== 'CallExpression') return false;
  const callee = unwrap(node.callee);
  return (
    callee.type === 'MemberExpression' &&
    unwrap(callee.object).type === 'Identifier' &&
    unwrap(callee.object).name === 'Date' &&
    propertyName(callee) === 'now'
  );
}

/** Keys of a node that hold no expression this rule descends into. */
const SKIPPED_KEYS = new Set(['parent', 'range', 'loc', 'typeAnnotation']);


const expectOnWallClock = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        "An expected value read off the wall clock, in a file that never freezes it",
    },
    schema: [],
    messages: {
      wallClock:
        'This expected value reads the wall clock, which has moved on since the code under test read it, so the assertion flakes on a loaded runner, and widening it to a range proves nothing. Freeze the clock, `vi.useFakeTimers({ shouldAdvanceTime: false })` with `vi.setSystemTime(...)`, and assert the exact value.',
    },
  },
  create(context) {
    let frozen = false;
    const found = [];

    /**
     * Collect every wall-clock read written in `node`. A binding is not
     * followed: a `const now = new Date()` handed to a mock and asserted back
     * compares one value with itself (measured on a product monorepo, where following
     * bindings gave 96 hits, nearly all of that shape).
     */
    function visit(node, seen) {
      if (!node || typeof node.type !== 'string' || seen.has(node)) return;
      seen.add(node);
      if (readsWallClock(node)) {
        found.push(node);
        return;
      }
      // A function's body runs later, under whatever clock the test sets then.
      if (/Function/.test(node.type)) return;
      for (const [key, value] of Object.entries(node)) {
        if (SKIPPED_KEYS.has(key)) continue;
        if (Array.isArray(value)) {
          for (const child of value) visit(child, seen);
        } else if (value && typeof value === 'object') {
          visit(value, seen);
        }
      }
    }

    return {
      CallExpression(node) {
        const method = viMethod(node);
        if (method === 'useFakeTimers' || method === 'setSystemTime') {
          frozen = true;
        }
        if (!assertion(node, context)) return;
        for (const argument of node.arguments) visit(argument, new Set());
      },
      'Program:exit'() {
        if (frozen) return;
        for (const node of new Set(found)) {
          context.report({ node, messageId: 'wallClock' });
        }
      },
    };
  },
};

export { expectOnWallClock, pollUnderFakeTimers };
