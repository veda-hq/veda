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
  // Only an Identifier has a `name`.
  return unwrap(callee.object).name === 'vi' ? propertyName(callee) : null;
}

/** `expect.poll(...)` or `vi.waitFor(...)`: its name, or null. */
function pollOf(call) {
  if (viMethod(call) === 'waitFor') return 'vi.waitFor';
  const callee = unwrap(call.callee);
  if (callee.type !== 'MemberExpression') return null;
  // Only an Identifier has a `name`.
  return unwrap(callee.object).name === 'expect' &&
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
    function covers(fake, poll, calls) {
      const test = enclosingTest(poll, context);
      // The fake, real and poll calls written before the poll, in source order.
      const before = calls.slice(0, calls.indexOf(poll));
      // The ones between `fake` and the poll: none when the fake comes later,
      // since the slice then starts past its end.
      const since = () => calls.slice(calls.indexOf(fake) + 1, calls.indexOf(poll));
      // Does a `vi.useRealTimers()` in `list` run first, inside the poll's
      // test when it has one?
      const restores = list =>
        list.some(real => reals.includes(real) && (!test || within(real, test)));
      const chain = enclosingFunctions(fake, context);
      const ownTest = chain.find(entry => entry.owner?.kind === 'test');
      if (ownTest) {
        return ownTest.fn === test && before.includes(fake) && !restores(since());
      }
      const hook = chain.find(entry => entry.owner?.kind === 'hook');
      if (hook) {
        // A hook's name is one of beforeEach, beforeAll, afterEach and afterAll.
        // Inside a test, every real before the poll is in the test, so after
        // the hook has run.
        return (
          hook.owner.name.startsWith('before') &&
          within(poll, registeringBlock(hook.fn)) &&
          !restores(test ? before : since())
        );
      }
      if (chain.some(entry => entry.owner?.kind !== 'suite')) return false;
      return before.includes(fake) && !restores(since());
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
        const calls = [...fakes, ...reals, ...polls.map(poll => poll.node)].sort(
          (a, b) => a.range[0] - b.range[0],
        );
        for (const poll of polls) {
          if (fakes.some(fake => covers(fake, poll.node, calls))) {
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
  // Only an Identifier has a `name`.
  if (node.type === 'NewExpression') {
    return node.callee.name === 'Date' && node.arguments.length === 0;
  }
  // Past `new`, only a call has a callee. propertyName is null for anything
  // but a member expression (an absent callee too), so the callee has an
  // object once it names `now`.
  const callee = unwrap(node.callee);
  return (
    propertyName(callee) === 'now' && unwrap(callee.object).name === 'Date'
  );
}

/**
 * Keys of a node that hold no expression this rule descends into: the
 * back-link to its parent, and types. `range` and `loc` hold no node.
 */
const SKIPPED_KEYS = new Set(['parent', 'typeAnnotation']);


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
     * bindings gave 96 hits, nearly all of that shape). With `parent`
     * skipped the walk only goes down, so it ends; a read found twice (an
     * assertion inside another's argument) is reported once, at exit.
     */
    function visit(node) {
      if (readsWallClock(node)) {
        found.push(node);
        return;
      }
      // A function's body runs later, under whatever clock the test sets then.
      if (/Function/.test(node.type)) return;
      for (const [key, value] of Object.entries(node)) {
        if (SKIPPED_KEYS.has(key)) continue;
        // Only a node has a string `type`: array holes, `range` numbers and
        // `loc` objects are not walked.
        for (const child of [value].flat()) {
          if (typeof child?.type === 'string') visit(child);
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
        for (const argument of node.arguments) visit(argument);
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
