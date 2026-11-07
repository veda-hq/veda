/**
 * The test-lint plugin's candidate extensions: harness, assertion, oracle
 * and fixture rules that each close a defect reviewers kept reporting after
 * push. `c05-candidates.test.ts`, the suite that tests them, owns them. The
 * plugin entry passes in the shared helpers, so the import runs one way
 * only. The plugin, its rule names and its config blocks stay in the family
 * entry.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function c05CandidateRules({
  isFunction,
  WRAPPERS,
  unwrap,
  propertyName,
  calledMethod,
  registration,
  ownerOf,
  enclosingFunctions,
  enclosingTest,
  assertion,
  variableOf,
  constInit,
  textOf,
  inFinally,
  TEARDOWN_CALLS,
  SPAWNERS,
  SHELL_SPAWNERS,
  someNode,
  OWNED_ROOT_CALLS,
  SOURCE_EXTENSIONS,
}) {
  // ---------------------------------------------------------------------------
  // Candidate extensions. Each rule closes one shape of review finding; the
  // suite that owns this module holds each finding, reduced to the code that
  // still reproduces it.
  // ---------------------------------------------------------------------------

  /**
   * The AST nodes directly under `node`: every field but the back-link to
   * its parent (which would walk upward), arrays expanded. Array holes,
   * `range` numbers and `loc` objects are not nodes.
   */
  function childNodes(node) {
    return Object.values(node)
      .filter(value => value !== node.parent)
      .flat()
      .filter(child => typeof child?.type === 'string');
  }

  /**
   * Every node under `root` (nested functions included), in source order: a
   * walk follows field order, which is not source order (an `if` lists its
   * `alternate` before its `test`).
   */
  function nodesIn(root) {
    const found = [];
    const visit = node => {
      found.push(node);
      childNodes(node).forEach(visit);
    };
    if (root) visit(root);
    return found.sort((a, b) => a.range[0] - b.range[0]);
  }

  /**
   * `node`'s tokens joined, layout and comments dropped: for prefix checks
   * (`rows[`, `rows.`) on an expression's text. Equality between two
   * expressions uses `textOf`, whose token list keeps `typeof x` apart from
   * `typeofx`.
   */
  function joinedText(node, context) {
    return context.sourceCode
      .getTokens(node)
      .map(token => token.value)
      .join('');
  }

  /** The innermost function around `node`, or null at module scope. */
  function functionOf(node) {
    for (let current = node.parent; current; current = current.parent) {
      if (isFunction(current)) return current;
    }
    return null;
  }

  /** `callee(...)` → `'callee'`, `a.b(...)` → `'b'`. */
  function calleeName(call) {
    const callee = unwrap(call.callee);
    return callee.type === 'Identifier' ? callee.name : propertyName(callee);
  }

  /** A number fixed in the source: a literal, or a `const` holding one. */
  function staticNumber(node, context, depth = 0) {
    const value = unwrap(node);
    if (!value || depth > 3) return null;
    if (value.type === 'Literal' && typeof value.value === 'number')
      return value.value;
    if (value.type === 'Identifier') {
      const init = constInit(value, context);
      return init ? staticNumber(init, context, depth + 1) : null;
    }
    if (value.type === 'BinaryExpression' && value.operator === '*') {
      const left = staticNumber(value.left, context, depth + 1);
      const right = staticNumber(value.right, context, depth + 1);
      return left === null || right === null ? null : left * right;
    }
    return null;
  }

  // --- no-fixed-sleep

  const SLEEP_NAMES = new Set(['sleep', 'pause', 'delay', 'wait', 'waitMs']);
  const LOOPS = new Set([
    'ForStatement',
    'ForOfStatement',
    'ForInStatement',
    'WhileStatement',
    'DoWhileStatement',
  ]);

  /** The delay of `new Promise(r => setTimeout(r, N))` or `sleep(N)`, or null. */
  function sleepDelay(node, context) {
    const value = unwrap(node);
    if (value?.type === 'NewExpression') {
      if (value.callee.type !== 'Identifier' || value.callee.name !== 'Promise')
        return null;
      const executor = value.arguments[0];
      if (!isFunction(executor)) return null;
      const timer = nodesIn(executor.body).find(
        inner =>
          inner.type === 'CallExpression' &&
          unwrap(inner.callee).type === 'Identifier' &&
          unwrap(inner.callee).name === 'setTimeout',
      );
      return timer ? staticNumber(timer.arguments[1], context) : null;
    }
    if (value?.type !== 'CallExpression') return null;
    const callee = unwrap(value.callee);
    const name = callee.type === 'Identifier' ? callee.name : null;
    // `sleep()` has no delay: staticNumber(undefined) is null.
    if (SLEEP_NAMES.has(name)) return staticNumber(value.arguments[0], context);
    // `await setTimeout(ms)` from node:timers/promises takes the delay first.
    if (name === 'setTimeout' && value.arguments.length === 1) {
      return staticNumber(value.arguments[0], context);
    }
    return null;
  }

  /** Inside a loop, or a function that calls itself: a polling interval. */
  function isPolling(node) {
    const fn = functionOf(node);
    for (
      let current = node.parent;
      current && current !== fn;
      current = current.parent
    ) {
      if (LOOPS.has(current.type)) return true;
    }
    if (!fn) return false;
    const name =
      fn.id?.name ??
      (fn.parent?.type === 'VariableDeclarator' &&
      fn.parent.id.type === 'Identifier'
        ? fn.parent.id.name
        : null);
    return (
      Boolean(name) &&
      nodesIn(fn.body).some(
        inner =>
          inner.type === 'CallExpression' &&
          unwrap(inner.callee).type === 'Identifier' &&
          unwrap(inner.callee).name === name,
      )
    );
  }

  /** Polls may wait between checks; a wait of a second or more is a fixed sleep anyway. */
  const POLL_CEILING_MS = 1_000;

  const noFixedSleep = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Tests wait for state, not for a fixed time (harness family)',
      },
      schema: [],
      messages: {
        fixedSleep:
          'A fixed {{ms}} ms wait stands in for the event the test needs. On a loaded runner it is too short and the test flakes; on an idle one it is time wasted, and a timer left by an earlier test can still land in this one. Poll the state with a deadline (`vi.waitFor`, `waitFor`), or use fake timers and advance them.',
      },
    },
    create(context) {
      return {
        AwaitExpression(node) {
          const ms = sleepDelay(node.argument, context);
          if (ms === null || ms <= 0) return;
          if (ms < POLL_CEILING_MS && isPolling(node)) return;
          context.report({
            node,
            messageId: 'fixedSleep',
            data: { ms: String(ms) },
          });
        },
      };
    },
  };

  // --- specific-rejection

  const THROW_MATCHERS = new Set(['toThrow', 'toThrowError']);
  const ERRORISH =
    /(error|problem|issue|violation|finding|diagnostic|failure|reject)/i;

  /** The name an error collection goes by: `errors`, `errorsFor(...)`, `result.errors`. */
  function collectionName(node) {
    const value = unwrap(node);
    if (!value) return null;
    if (value.type === 'Identifier') return value.name;
    if (value.type === 'MemberExpression') return propertyName(value);
    if (value.type === 'CallExpression') return calleeName(value);
    if (value.type === 'AwaitExpression') return collectionName(value.argument);
    return null;
  }

  /** `x.length` → `x`; else null. */
  function lengthOf(node) {
    const value = unwrap(node);
    return value?.type === 'MemberExpression' &&
      propertyName(value) === 'length'
      ? value.object
      : null;
  }

  /** Is `node` a number literal in the 2xx range? */
  function isSuccessStatus(node) {
    const value = unwrap(node);
    return (
      value?.type === 'Literal' &&
      typeof value.value === 'number' &&
      value.value >= 200 &&
      value.value < 300
    );
  }

  const specificRejection = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'A rejection test names the rejection it expects (assertion family)',
      },
      schema: [],
      messages: {
        bareThrow:
          'A bare `{{matcher}}()` passes for any error: a TypeError from a broken fixture or a different exception class satisfies it as well as the rejection under test. Pass the class, message or a matcher for the error you expect.',
        notSuccess:
          '`not.{{matcher}}({{status}})` passes for every other status, a 500 from a crash included. Assert the exact status (and diagnostic) this rejection should produce.',
        anyError:
          'Any {{name}} satisfies a non-empty count, including one about a different field or an unrelated breakage, so the check you mean can disappear while this passes. Assert the expected entry: its property, constraint, code or message.',
      },
    },
    create(context) {
      return {
        CallExpression(node) {
          const found = assertion(node, context);
          if (!found) return;
          const { matcher, negated, subject, args } = found;
          if (THROW_MATCHERS.has(matcher) && !negated && args.length === 0) {
            context.report({ node, messageId: 'bareThrow', data: { matcher } });
            return;
          }
          if (
            negated &&
            ['toBe', 'toEqual', 'toStrictEqual'].includes(matcher) &&
            isSuccessStatus(args[0]) &&
            ['status', 'statusCode'].includes(collectionName(subject))
          ) {
            context.report({
              node,
              messageId: 'notSuccess',
              data: { matcher, status: String(unwrap(args[0]).value) },
            });
            return;
          }
          const counted = lengthOf(subject);
          const name = collectionName(counted ?? subject);
          if (!name || !ERRORISH.test(name)) return;
          const zero = staticNumber(args[0], context);
          const nonEmptyCount =
            counted !== null &&
            ((!negated && matcher === 'toBeGreaterThan' && zero === 0) ||
              (!negated &&
                matcher === 'toBeGreaterThanOrEqual' &&
                zero === 1) ||
              (negated && ['toBe', 'toEqual'].includes(matcher) && zero === 0));
          const nonEmptyList =
            counted === null &&
            negated &&
            ((matcher === 'toHaveLength' && zero === 0) ||
              (['toEqual', 'toStrictEqual'].includes(matcher) &&
                unwrap(args[0])?.type === 'ArrayExpression' &&
                unwrap(args[0]).elements.length === 0));
          if (!nonEmptyCount && !nonEmptyList) return;
          // The count is a precondition when the same function goes on to
          // assert an entry: `issues[0]`, `issues.some(...)`, `toContainEqual`.
          // Joined tokens, not textOf's token list: the checks below read
          // `<collection>[` and `<collection>.` as prefixes of the text.
          const collection = joinedText(counted ?? subject, context);
          const fn = functionOf(node);
          const pinned =
            fn !== null &&
            nodesIn(fn.body).some(inner => {
              if (inner === node || inner.type !== 'CallExpression')
                return false;
              const other = assertion(inner, context);
              if (!other?.subject) return false;
              const otherText = joinedText(other.subject, context);
              if (otherText === `${collection}.length`) return false;
              return (
                otherText.startsWith(`${collection}[`) ||
                otherText.startsWith(`${collection}.`) ||
                (otherText === collection && other.matcher !== 'toHaveLength')
              );
            });
          if (!pinned)
            context.report({ node, messageId: 'anyError', data: { name } });
        },
      };
    },
  };

  // --- call-specific-matcher

  const CLEARS = new Set(['mockClear', 'mockReset', 'mockRestore']);
  const GLOBAL_CLEARS = new Set([
    'clearAllMocks',
    'resetAllMocks',
    'restoreAllMocks',
  ]);

  const callSpecificMatcher = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'A repeated call assertion pins the call it means (assertion family)',
      },
      schema: [],
      messages: {
        anyCall:
          'This repeats an earlier `toHaveBeenCalledWith` on the same mock with the same arguments, and the matcher accepts ANY call, so the first call already satisfies it and the second call is never checked. Use `toHaveBeenNthCalledWith(n, ...)` or `toHaveBeenLastCalledWith(...)`, or clear the mock between the calls.',
      },
    },
    create(context) {
      /** test callback → mock text → argument texts already asserted. */
      const byTest = new Map();
      const seenFor = node => {
        const test = enclosingTest(node, context);
        if (!test) return null;
        if (!byTest.has(test)) byTest.set(test, new Map());
        return byTest.get(test);
      };
      return {
        // Calls arrive in source order, so a clear between two assertions is
        // seen between them. Only the three relevant shapes pay for the
        // enclosing-test lookup.
        CallExpression(node) {
          const method = calleeName(node);
          if (CLEARS.has(method)) {
            const object = unwrap(node.callee).object;
            if (object) seenFor(node)?.delete(textOf(object, context));
            return;
          }
          if (GLOBAL_CLEARS.has(method)) {
            seenFor(node)?.clear();
            return;
          }
          if (method !== 'toHaveBeenCalledWith') return;
          const found = assertion(node, context);
          if (!found || found.negated || !found.subject) return;
          const seen = seenFor(node);
          if (!seen) return;
          const mock = textOf(found.subject, context);
          const call = JSON.stringify(
            found.args.map(arg => textOf(arg, context)),
          );
          const previous = seen.get(mock) ?? new Set();
          if (previous.has(call)) {
            context.report({ node, messageId: 'anyCall' });
          }
          previous.add(call);
          seen.set(mock, previous);
        },
      };
    },
  };

  // --- independent-expectation

  const EQUALITY_MATCHERS = new Set([
    'toEqual',
    'toStrictEqual',
    'toBe',
    'toMatchObject',
    'toHaveLength',
  ]);

  const COLLECTION_METHODS = new Set([
    'map',
    'filter',
    'flatMap',
    'slice',
    'toSorted',
    'toReversed',
    'concat',
    'reduce',
  ]);

  const independentExpectation = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'An expected value is not derived from the value under test (oracle family)',
      },
      schema: [],
      messages: {
        selfDerived:
          'The expected value is built from `{{subject}}`, the value under test, so it agrees with whatever was observed: an empty sample set equals an empty `.map()` of itself. Write the expected value independently (a literal, a count you fixed in the test).',
      },
    },
    create(context) {
      return {
        CallExpression(node) {
          const found = assertion(node, context);
          if (!found || !found.subject || !EQUALITY_MATCHERS.has(found.matcher))
            return;
          const subject = found.subject;
          if (subject.type === 'Literal') return;
          const text = textOf(subject, context);
          const expected = found.args[0];
          if (!expected) return;
          // `expect(xs).toEqual(xs.map(f))`: an empty `xs` satisfies it. A
          // scalar invariance check (`expect(id).toBe(id.trim())`) is not
          // vacuous and is left alone.
          const derived = nodesIn(expected).some(
            inner =>
              inner.type === 'CallExpression' &&
              unwrap(inner.callee).type === 'MemberExpression' &&
              COLLECTION_METHODS.has(propertyName(unwrap(inner.callee))) &&
              textOf(unwrap(inner.callee).object, context) === text,
          );
          if (derived) {
            context.report({
              node,
              messageId: 'selfDerived',
              data: { subject: context.sourceCode.getText(subject) },
            });
          }
        },
      };
    },
  };

  // --- owned-db-schema

  const CREATE_SCHEMA_ADOPT = /\bcreate\s+schema\s+if\s+not\s+exists\b/i;
  const CREATE_SCHEMA_FIXED = /\bcreate\s+schema\s+(?!if\s)"?([^\s";(]+)/i;
  const DROP_SCHEMA = /\bdrop\s+schema\b/i;

  /** A literal's SQL text, with each `${...}` kept as a placeholder. */
  function sqlText(node) {
    if (node.type === 'Literal' && typeof node.value === 'string')
      return node.value;
    if (node.type === 'TemplateLiteral') {
      return node.quasis.map(quasi => quasi.value.cooked).join('${}');
    }
    return null;
  }

  const ownedDbSchema = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Database fixtures create schemas they own (fixture family)',
      },
      schema: [],
      messages: {
        adopted:
          "`CREATE SCHEMA IF NOT EXISTS` adopts a schema this run did not create, and this file drops schemas: the teardown can then delete another run's (or a developer's) objects. Create a uniquely named schema and drop only what this run created.",
        fixedName:
          'A fixed schema name collides with an interrupted earlier run (the CREATE fails) and with a concurrent one (both share it). Derive a unique name per run and drop it in teardown.',
      },
    },
    create(context) {
      const creates = [];
      let drops = false;
      const visit = node => {
        const text = sqlText(node);
        if (text === null) return;
        if (DROP_SCHEMA.test(text)) drops = true;
        if (CREATE_SCHEMA_ADOPT.test(text)) {
          creates.push({ node, kind: 'adopted' });
          return;
        }
        const name = CREATE_SCHEMA_FIXED.exec(text)?.[1];
        if (name && !name.includes('${'))
          creates.push({ node, kind: 'fixedName' });
      };
      return {
        Literal: visit,
        TemplateLiteral: visit,
        'Program:exit'() {
          for (const { node, kind } of creates) {
            if (kind === 'adopted' && !drops) continue;
            context.report({ node, messageId: kind });
          }
        },
      };
    },
  };

  // --- teardown-in-finally

  const CLEANUP_FUNCTIONS = new Set([
    'release',
    'cleanup',
    'teardown',
    'dispose',
    'stop',
    'kill',
    'close',
    'disconnect',
    'destroy',
    'terminate',
    'abort',
  ]);
  const CLEANUP_METHODS = new Set([
    'kill',
    'stop',
    'close',
    'disconnect',
    'destroy',
    'terminate',
    'release',
    'dispose',
    'quit',
    'abort',
  ]);

  /** Was `identifier` declared by a `const`/`let` in `fn` itself? */
  function declaredIn(identifier, fn, context) {
    const variable = variableOf(identifier, context);
    const def = variable?.defs[0];
    return def?.type === 'Variable' && functionOf(def.name) === fn;
  }

  /** `release()` / `child.kill()` on a resource the function owns → that call. */
  function ownedCleanup(statement, fn, context) {
    let expression =
      statement.type === 'ExpressionStatement' ? statement.expression : null;
    if (expression?.type === 'AwaitExpression')
      expression = expression.argument;
    const call = unwrap(expression);
    if (call?.type !== 'CallExpression') return null;
    const callee = unwrap(call.callee);
    if (callee.type === 'Identifier') {
      return CLEANUP_FUNCTIONS.has(callee.name) &&
        declaredIn(callee, fn, context)
        ? call
        : null;
    }
    const object = unwrap(callee.object);
    return CLEANUP_METHODS.has(propertyName(callee)) &&
      object?.type === 'Identifier' &&
      declaredIn(object, fn, context)
      ? call
      : null;
  }

  /** A statement that can fail: it awaits, asserts or calls (nested functions aside). */
  function canFail(statement, context) {
    if (statement.type === 'FunctionDeclaration') return false;
    // An await rejects, an assertion fails, a throw throws. Plain synchronous
    // calls (`join`, `vi.fn`) are left out: flagging every call before a
    // cleanup would bury the waits and assertions that actually skip it.
    return someNode(
      statement,
      inner =>
        inner.type === 'AwaitExpression' ||
        inner.type === 'ThrowStatement' ||
        Boolean(assertion(inner, context)),
    );
  }

  /** Identifiers read anywhere under `node`. */
  function namesIn(node) {
    return new Set(
      nodesIn(node)
        .filter(inner => inner.type === 'Identifier')
        .map(inner => inner.name),
    );
  }

  const teardownInFinally = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Cleanup of what a test started runs even when the test fails (fixture family)',
      },
      schema: [],
      messages: {
        afterFailure:
          'This cleanup runs only if everything before it passed: a failed assertion or a rejected wait above skips it and leaves the process, lock or connection behind for the rest of the run. Register it right after the resource exists (`try { ... } finally { ... }`, `onTestFinished`).',
        workBeforeTry:
          '`{{name}}` is cleaned up in the `finally` below, but this statement runs first and can throw, skipping the `finally` entirely. Open the `try` immediately after `{{name}}` exists.',
        stateFromTry:
          "The `finally` reads `{{name}}`, which is only assigned inside the `try`: when the try fails before that assignment, the cleanup has nothing to work from. Derive what the cleanup needs before the `try`, or independently of the test's progress.",
      },
    },
    create(context) {
      const blocks = node => {
        const fn = functionOf(node);
        const statements = node.body;
        statements.forEach((statement, index) => {
          if (fn && node.parent?.type !== 'TryStatement') {
            const cleanup = ownedCleanup(statement, fn, context);
            if (
              cleanup &&
              statements.slice(0, index).some(s => canFail(s, context))
            ) {
              context.report({ node: cleanup, messageId: 'afterFailure' });
            }
          }
          // Only a `try` has a `finalizer`; one without a `finally` is skipped.
          if (!statement.finalizer) return;
          const used = namesIn(statement.finalizer);
          const reported = new Set();
          for (const [d, declaration] of statements.slice(0, index).entries()) {
            if (declaration.type !== 'VariableDeclaration') continue;
            for (const declarator of declaration.declarations) {
              if (
                declarator.id.type !== 'Identifier' ||
                !used.has(declarator.id.name)
              )
                continue;
              const name = declarator.id.name;
              if (declarator.init) {
                // A resource comes from a call (`spawn`, `createServer`,
                // `startHook`); `const rows = []` is not one.
                const acquires = someNode(
                  declarator.init,
                  inner =>
                    inner.type === 'CallExpression' ||
                    inner.type === 'NewExpression',
                );
                const between = acquires
                  ? statements
                      .slice(d + 1, index)
                      .find(s => canFail(s, context))
                  : undefined;
                if (between && !reported.has(between)) {
                  reported.add(between);
                  context.report({
                    node: between,
                    messageId: 'workBeforeTry',
                    data: { name },
                  });
                }
              } else if (
                declaration.kind === 'let' &&
                nodesIn(statement.block).some(
                  inner =>
                    inner.type === 'AssignmentExpression' &&
                    inner.left.type === 'Identifier' &&
                    inner.left.name === name,
                )
              ) {
                context.report({
                  node: declarator,
                  messageId: 'stateFromTry',
                  data: { name },
                });
              }
            }
          }
        });
      };
      return { BlockStatement: blocks };
    },
  };

  // --- cleanup-loop-settles

  /** Calls that run as cleanup steps in `body`, outside any try that catches. */
  function cleanupSteps(body) {
    let steps = 0;
    const visit = (node, caught) => {
      if (!node || typeof node.type !== 'string') return;
      if (isFunction(node)) return;
      if (node.type === 'TryStatement') {
        visit(node.block, caught || Boolean(node.handler));
        visit(node.handler, caught);
        visit(node.finalizer, caught);
        return;
      }
      if (node.type === 'ExpressionStatement' && !caught) {
        const expression = unwrap(
          node.expression.type === 'AwaitExpression'
            ? node.expression.argument
            : node.expression,
        );
        if (expression?.type === 'CallExpression') steps += 1;
      }
      childNodes(node).forEach(child => visit(child, caught));
    };
    // A body that is not a block is one statement (`for (...) step();`) or
    // an expression (`xs.forEach(x => step(x))`), visited as it stands.
    visit(body, false);
    return steps;
  }

  /** Is `node` inside teardown: a `finally`, an after-hook or `onTestFinished`? */
  function inTeardown(node, context) {
    if (inFinally(node)) return true;
    return enclosingFunctions(node, context).some(
      ({ fn, owner }) =>
        (owner?.kind === 'hook' &&
          ['afterEach', 'afterAll'].includes(owner.name)) ||
        (fn.parent?.type === 'CallExpression' &&
          unwrap(fn.parent.callee).type === 'Identifier' &&
          TEARDOWN_CALLS.has(unwrap(fn.parent.callee).name)),
    );
  }

  const cleanupLoopSettles = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'A teardown loop finishes every resource even when one step fails (fixture family)',
      },
      schema: [],
      messages: {
        aborts:
          "The first failing step in this teardown loop throws out of it: the rest of this resource's cleanup and every later resource are skipped and leak. Settle each step (`Promise.allSettled`, or `try/catch` per step) and report the failures together.",
      },
    },
    create(context) {
      const check = (node, body) => {
        if (!inTeardown(node, context)) return;
        if (cleanupSteps(body) >= 2)
          context.report({ node, messageId: 'aborts' });
      };
      return {
        'ForStatement, ForOfStatement, ForInStatement, WhileStatement, DoWhileStatement'(
          node,
        ) {
          check(node, node.body);
        },
        CallExpression(node) {
          const method = calledMethod(node);
          if (method !== 'forEach' && method !== 'map') return;
          const fn = node.arguments[0];
          if (!isFunction(fn)) return;
          if (method === 'map') {
            // Only under Promise.all: allSettled is the fix.
            const outer = node.parent;
            const callee =
              outer?.type === 'CallExpression' ? unwrap(outer.callee) : null;
            if (
              callee?.type !== 'MemberExpression' ||
              unwrap(callee.object)?.type !== 'Identifier' ||
              unwrap(callee.object).name !== 'Promise' ||
              propertyName(callee) !== 'all'
            ) {
              return;
            }
          }
          check(node, fn.body);
        },
      };
    },
  };

  // --- parse-structured-config

  const STRUCTURED_FILE = /\.(ya?ml|json|toml)$/i;
  const PARSERS = new Set([
    'load',
    'loadAll',
    'safeLoad',
    'parse',
    'parseYaml',
    'parseDocument',
    'parseAllDocuments',
  ]);
  const TEXT_MATCHERS = new Set([
    'split',
    'includes',
    'match',
    'matchAll',
    'indexOf',
    'search',
    'startsWith',
    'endsWith',
    'replace',
    'replaceAll',
  ]);

  /** Does the path argument name a YAML/JSON file, literally or by a filtered list? */
  function namesStructuredFile(node, context) {
    for (const inner of nodesIn(node)) {
      if (
        inner.type === 'Literal' &&
        typeof inner.value === 'string' &&
        STRUCTURED_FILE.test(inner.value)
      ) {
        return true;
      }
      if (inner.type !== 'Identifier') continue;
      // `files.filter(f => /\.ya?ml$/.test(f)).filter(file => ...readFileSync(file))`
      const variable = variableOf(inner, context);
      const def = variable?.defs[0];
      if (def?.type !== 'Parameter') continue;
      const fn = def.node;
      const call = fn.parent;
      if (call?.type !== 'CallExpression' || calledMethod(call) === null)
        continue;
      for (
        let receiver = unwrap(call.callee).object;
        receiver?.type === 'CallExpression';
        receiver = unwrap(receiver.callee).object
      ) {
        if (
          !receiver.callee ||
          unwrap(receiver.callee).type !== 'MemberExpression'
        )
          break;
        const filtered = receiver.arguments.some(
          arg =>
            isFunction(arg) &&
            nodesIn(arg.body).some(
              // `\.ya?ml$`, `\.yml$`, `\.json$` as written in a filter regex.
              part =>
                part.type === 'Literal' &&
                part.regex &&
                /y(a\??)?ml|json|toml/.test(part.regex.pattern),
            ),
        );
        if (filtered) return true;
      }
    }
    return false;
  }

  /**
   * How a read text is used: `'parsed'`, `'matched'` as text, or null for
   * neither. `node` is a call or a reference, so it always has a parent.
   */
  function textUse(node, context) {
    const parent = node.parent;
    if (parent.type === 'CallExpression' && parent.arguments.includes(node)) {
      const name = calleeName(parent);
      if (PARSERS.has(name)) return 'parsed';
      if (name === 'test' || name === 'exec') return 'matched';
      if (name === 'expect') {
        const matcher = propertyName(parent.parent);
        return ['toContain', 'toMatch'].includes(matcher) ? 'matched' : null;
      }
      return null;
    }
    // `text.split(...)`. Under a computed `x[text]` the text is the property,
    // and a computed property that is not a string literal names no method.
    if (parent.type === 'MemberExpression') {
      return TEXT_MATCHERS.has(propertyName(parent)) ? 'matched' : null;
    }
    if (WRAPPERS.has(parent.type)) return textUse(parent, context);
    return null;
  }

  const parseStructuredConfig = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Tests read YAML and JSON by parsing them, not by matching text (assertion family)',
      },
      schema: [],
      messages: {
        textMatched:
          'This reads a structured file and matches its text: a quoting or indentation variant slips past the pattern, and a match anywhere in the file accepts the key in the wrong object. Parse it (`load` from js-yaml, `JSON.parse`) and assert on the value where it must be.',
      },
    },
    create(context) {
      return {
        CallExpression(node) {
          if (calleeName(node) !== 'readFileSync') return;
          if (!namesStructuredFile(node.arguments[0], context)) return;
          let uses = [textUse(node, context)];
          const parent = node.parent;
          if (
            parent?.type === 'VariableDeclarator' &&
            parent.id.type === 'Identifier'
          ) {
            const variable = variableOf(parent.id, context);
            uses = (variable?.references ?? [])
              .filter(reference => reference.identifier !== parent.id)
              .map(reference => textUse(reference.identifier, context));
          }
          if (uses.includes('matched') && !uses.includes('parsed')) {
            context.report({ node, messageId: 'textMatched' });
          }
        },
      };
    },
  };

  // --- mock-state-reset

  const PERSISTENT_SETTERS = new Set([
    'mockImplementation',
    'mockReturnValue',
    'mockResolvedValue',
    'mockRejectedValue',
  ]);

  const RESET_ALL = new Set(['resetAllMocks', 'restoreAllMocks']);

  /** The hooks that run around the test registered by `call`: its suites' and the file's. */
  function hooksAround(call, context) {
    const hooks = [];
    for (let current = call.parent; current; current = current.parent) {
      let body = null;
      if (current.type === 'Program') body = current.body;
      // Only a registration's function callback has an owner.
      else if (
        ownerOf(current, context)?.kind === 'suite' &&
        current.body.type === 'BlockStatement'
      ) {
        body = current.body.body;
      }
      if (!body) continue;
      for (const statement of body) {
        if (statement.type !== 'ExpressionStatement') continue;
        const owner = registration(statement.expression, context);
        if (owner?.kind === 'hook' && owner.callback) hooks.push(owner);
      }
    }
    return hooks;
  }

  /** The mock a setter acts on: `vi.mocked(fn)` → `fn`. */
  function mockTarget(object) {
    const value = unwrap(object);
    if (value?.type === 'CallExpression' && calleeName(value) === 'mocked') {
      return unwrap(value.arguments[0]) ?? null;
    }
    return value ?? null;
  }

  /**
   * The nodes of `body`, plus those of same-file helpers it calls (two levels):
   * `beforeEach(() => storeSnapshot(...))` re-sets what `storeSnapshot` sets.
   */
  function withLocalHelpers(body, context, depth = 0) {
    const found = nodesIn(body);
    if (depth >= 2) return found;
    const extra = [];
    for (const inner of found) {
      if (inner.type !== 'CallExpression') continue;
      const callee = unwrap(inner.callee);
      if (callee.type !== 'Identifier') continue;
      const def = variableOf(callee, context)?.defs[0];
      let helper = null;
      if (def?.type === 'FunctionName') helper = def.node;
      else if (def?.type === 'Variable' && isFunction(unwrap(def.node.init)))
        helper = unwrap(def.node.init);
      if (helper && helper.body !== body) {
        extra.push(...withLocalHelpers(helper.body, context, depth + 1));
      }
    }
    return [...found, ...extra];
  }

  /** What the named hooks undo: every mock (`resetAll`), or the mocks they re-set or restore. */
  function hookEffects(hooks, names, context) {
    const effects = { resetAll: false, mocks: new Set(), restores: false };
    for (const hook of hooks) {
      if (!names.has(hook.name)) continue;
      for (const inner of withLocalHelpers(hook.callback.body, context)) {
        if (inner.type !== 'CallExpression') continue;
        const name = calleeName(inner);
        if (RESET_ALL.has(name)) effects.resetAll = true;
        if (name === 'restoreAllMocks' || name === 'mockRestore')
          effects.restores = true;
        if (
          PERSISTENT_SETTERS.has(name) ||
          name === 'mockReset' ||
          name === 'mockRestore'
        ) {
          const object = mockTarget(unwrap(inner.callee).object);
          if (object) effects.mocks.add(textOf(object, context));
        }
      }
    }
    return effects;
  }

  /**
   * Is the mock's root rebuilt before every test? `let prisma; beforeEach(() =>
   * { prisma = { user: { findMany: vi.fn() } } })` hands each test fresh mocks,
   * so what one test sets cannot reach the next.
   */
  function rebuiltPerTest(root, context) {
    const variable = variableOf(root, context);
    return (variable?.references ?? []).some(reference => {
      if (!reference.isWrite()) return false;
      return enclosingFunctions(reference.identifier, context).some(
        ({ owner }) => owner?.kind === 'hook' && owner.name === 'beforeEach',
      );
    });
  }

  const BEFORE_EACH = new Set(['beforeEach']);
  const AFTER_EACH = new Set(['afterEach']);

  /** Is `inner` inside this test's own teardown: a `finally` or `onTestFinished`? */
  function inOwnTeardown(inner, context) {
    return (
      inFinally(inner) ||
      enclosingFunctions(inner, context).some(
        ({ fn }) =>
          fn.parent?.type === 'CallExpression' &&
          unwrap(fn.parent.callee).type === 'Identifier' &&
          TEARDOWN_CALLS.has(unwrap(fn.parent.callee).name),
      )
    );
  }

  const mockStateReset = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Mock state a test sets does not outlive it (fixture family)',
      },
      schema: [],
      messages: {
        implementationLeaks:
          'This `{{setter}}` on `{{mock}}` outlives the test: `vi.clearAllMocks()` clears calls, not implementations. A `beforeEach` in this file gives `{{mock}}` a default, but not every test gets that hook, and those tests then pass or fail by run order. Use `{{setter}}Once`, re-set the mock in a `beforeEach` that covers every test, or reset with `vi.resetAllMocks()`.',
        spyLeaks:
          'This spy replaces `{{target}}` for every later test in the file: no `afterEach` around this test restores it, and the test does not either. Restore in `afterEach` (`vi.restoreAllMocks()`), `onTestFinished`, or a `finally`.',
      },
    },
    create(context) {
      let tests = null;
      /** Every test registration in the file with the mocks its `beforeEach` hooks re-set. */
      const testsOf = node => {
        if (!tests) {
          let program = node;
          while (program.parent) program = program.parent;
          tests = nodesIn(program)
            .filter(
              inner =>
                inner.type === 'CallExpression' &&
                registration(inner, context)?.kind === 'test',
            )
            .map(call =>
              hookEffects(hooksAround(call, context), BEFORE_EACH, context),
            );
        }
        return tests;
      };
      return {
        CallExpression(node) {
          const test = enclosingTest(node, context);
          if (!test) return;
          const testCall = test.parent;
          const name = calleeName(node);
          if (PERSISTENT_SETTERS.has(name)) {
            // `vi.mocked(fn).mockReturnValue(...)` sets `fn`; `vi.spyOn(...).mock*`
            // is the spy's own setup, which spyLeaks covers: its root is a
            // call, not a binding, and a bare `mockReturnValue()` has none.
            const mock = mockTarget(unwrap(node.callee).object);
            let root = unwrap(mock);
            while (root?.type === 'MemberExpression')
              root = unwrap(root.object);
            if (root?.type !== 'Identifier' || declaredIn(root, test, context))
              return;
            if (rebuiltPerTest(root, context)) return;
            const key = textOf(mock, context);
            const after = hookEffects(
              hooksAround(testCall, context),
              AFTER_EACH,
              context,
            );
            if (after.resetAll || after.mocks.has(key)) return;
            // Undone by the test's own teardown (`finally`, `onTestFinished`).
            const undone = nodesIn(test.body).some(
              inner =>
                inner.type === 'CallExpression' &&
                ['mockReset', 'mockRestore'].includes(calleeName(inner)) &&
                mockTarget(unwrap(inner.callee).object) !== null &&
                textOf(mockTarget(unwrap(inner.callee).object), context) ===
                  key &&
                inOwnTeardown(inner, context),
            );
            if (undone) return;
            // Only a mock the file gives a default (some `beforeEach` re-sets it)
            // is relied on in its default state; the leak reaches the tests
            // that default does not cover.
            const before = testsOf(node);
            if (!before.some(effects => effects.mocks.has(key))) return;
            const covered = before.every(
              effects => effects.resetAll || effects.mocks.has(key),
            );
            if (covered) return;
            context.report({
              node,
              messageId: 'implementationLeaks',
              data: { setter: name, mock: context.sourceCode.getText(mock) },
            });
            return;
          }
          const callee = unwrap(node.callee);
          if (
            name !== 'spyOn' ||
            callee.type !== 'MemberExpression' ||
            unwrap(callee.object).type !== 'Identifier' ||
            !['vi', 'jest'].includes(unwrap(callee.object).name)
          ) {
            return;
          }
          if (
            hookEffects(hooksAround(testCall, context), AFTER_EACH, context)
              .restores
          )
            return;
          // Restored by the test itself. A restore at the end (not in a
          // `finally`) still leaks on failure; this rule targets the spy that
          // nothing restores, the defect a sibling describe's restore hid.
          const restored = nodesIn(test.body).some(
            inner =>
              inner.type === 'CallExpression' &&
              ['mockRestore', 'restoreAllMocks'].includes(calleeName(inner)),
          );
          if (restored) return;
          const [object, method] = node.arguments;
          context.report({
            node,
            messageId: 'spyLeaks',
            data: {
              target: `${object ? context.sourceCode.getText(object) : '?'}.${
                method?.type === 'Literal' ? String(method.value) : '?'
              }`,
            },
          });
        },
      };
    },
  };

  // --- mock-export-parity

  /** Raw module text, re-read when its mtime moves. */
  const rawTexts = new Map();
  function diskRead(path) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      // fail-open: a module that cannot be read has no exports to compare.
      return null;
    }
    if (!stat.isFile()) return null;
    const cached = rawTexts.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
    const text = readFileSync(path, 'utf8');
    rawTexts.set(path, { mtimeMs: stat.mtimeMs, text });
    return text;
  }

  /**
   * How rules read other source files: `settings.shuddhi.readSource` when a
   * caller supplies one (a replay reads the tree at a finding's commit), the
   * disk otherwise.
   */
  function sourceReader(context) {
    const custom = context.settings?.shuddhi?.readSource;
    return typeof custom === 'function' ? custom : diskRead;
  }

  /** `./x` from `fromFile` → `{ path, text }` of the non-test module, or null. */
  function readRelativeModule(fromFile, specifier, read) {
    if (!specifier.startsWith('.')) return null;
    const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ''));
    for (const candidate of [
      ...SOURCE_EXTENSIONS.map(ext => `${base}${ext}`),
      join(base, 'index.ts'),
      join(base, 'index.tsx'),
    ]) {
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(candidate)) continue;
      const text = read(candidate);
      if (text !== null) return { path: candidate, text };
    }
    return null;
  }

  /** Runtime export names of a module's source, or null when `export *` hides them. */
  function runtimeExports(text) {
    if (/^\s*export\s+\*/m.test(text)) return null;
    const names = new Set();
    const classes = new Set();
    for (const match of text.matchAll(
      /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|class|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm,
    )) {
      names.add(match[2]);
      if (match[1] === 'class') classes.add(match[2]);
    }
    for (const match of text.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
      for (const part of match[1].split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim();
        if (name && !name.startsWith('type ')) names.add(name);
      }
    }
    if (/^\s*export\s+default\b/m.test(text)) names.add('default');
    return { names, classes };
  }

  /** The object a `vi.mock` factory returns, when it is a literal without spreads. */
  function factoryObject(factory) {
    if (!isFunction(factory) || factory.params.length > 0) return null;
    let value = factory.body;
    if (value.type === 'BlockStatement') {
      const last = value.body.at(-1);
      value = last?.type === 'ReturnStatement' ? last.argument : null;
    }
    value = unwrap(value);
    if (value?.type !== 'ObjectExpression') return null;
    if (value.properties.some(property => property.type === 'SpreadElement'))
      return null;
    return value;
  }

  const mockExportParity = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'A whole-module mock matches the module it replaces (fixture family)',
      },
      schema: [],
      messages: {
        invented:
          '`{{name}}` is not exported by `{{module}}`: the mock invents API the code under test cannot be calling, while the export it does call is missing. Mock with `importOriginal` and override, or type the factory with `typeof import(...)`.',
        classDropped:
          'This whole-module mock drops the runtime class `{{name}}` that `{{module}}` exports: code under test that throws or checks `instanceof {{name}}` now gets `undefined` and fails with a TypeError, so the failure path is never tested. Spread `await importOriginal()` and override only what the test controls.',
      },
    },
    create(context) {
      const read = sourceReader(context);
      return {
        CallExpression(node) {
          const callee = unwrap(node.callee);
          if (
            callee.type !== 'MemberExpression' ||
            unwrap(callee.object).type !== 'Identifier' ||
            unwrap(callee.object).name !== 'vi' ||
            propertyName(callee) !== 'mock'
          ) {
            return;
          }
          const [specifier, factory] = node.arguments;
          if (
            specifier?.type !== 'Literal' ||
            typeof specifier.value !== 'string'
          )
            return;
          const object = factoryObject(factory);
          if (!object) return;
          const module = readRelativeModule(
            context.filename,
            specifier.value,
            read,
          );
          if (!module) return;
          const exported = runtimeExports(module.text);
          if (!exported) return;
          const keys = new Set();
          for (const property of object.properties) {
            const key = property.computed
              ? null
              : (property.key.name ?? property.key.value);
            if (typeof key !== 'string') continue;
            keys.add(key);
            if (key === '__esModule' || exported.names.has(key)) continue;
            context.report({
              node: property,
              messageId: 'invented',
              data: { name: key, module: specifier.value },
            });
          }
          for (const name of exported.classes) {
            if (keys.has(name)) continue;
            context.report({
              node,
              messageId: 'classDropped',
              data: { name, module: specifier.value },
            });
          }
        },
      };
    },
  };

  // --- spawn-result-checked

  const spawnResultChecked = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'A negative control proves its probe ran (harness family)',
      },
      schema: [],
      messages: {
        discarded:
          '`spawnSync` does not throw when the child fails to start or exits non-zero, and this result is discarded: an absence assertion after it passes even if the probe never ran. Keep the result and assert its `error` and `status` first.',
      },
    },
    create(context) {
      return {
        ExpressionStatement(node) {
          const call = unwrap(node.expression);
          if (
            call?.type === 'CallExpression' &&
            calleeName(call) === 'spawnSync'
          ) {
            context.report({ node, messageId: 'discarded' });
          }
        },
      };
    },
  };

  // --- local-tool-spawn

  const localToolSpawn = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Tests run the pinned local tool, not npx (harness family)',
      },
      schema: [],
      messages: {
        npx: '`npx` falls back to downloading whatever version the registry serves, and a failed download exits non-zero just like the rejection under test. Run the pinned binary (`pnpm exec <tool>` or `node_modules/.bin/<tool>`) and assert the diagnostic, not only the exit code.',
      },
    },
    create(context) {
      return {
        CallExpression(node) {
          const name = calleeName(node);
          const [command] = node.arguments;
          if (SPAWNERS.has(name)) {
            if (command?.type === 'Literal' && command.value === 'npx')
              context.report({ node, messageId: 'npx' });
            return;
          }
          if (!SHELL_SPAWNERS.has(name)) return;
          const text =
            command?.type === 'Literal'
              ? command.value
              : command?.type === 'TemplateLiteral'
                ? command.quasis[0].value.cooked
                : null;
          if (typeof text === 'string' && /^npx\s/.test(text))
            context.report({ node, messageId: 'npx' });
        },
      };
    },
  };

  // --- fixture-root-tracked

  const SETUP_HOOK_NAMES = new Set(['beforeEach', 'beforeAll']);

  const fixtureRootTracked = {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Every fixture root a helper makes is tracked for cleanup (fixture family)',
      },
      schema: [
        {
          type: 'object',
          properties: {
            // Further calls whose result is a directory the test owns.
            ownedRootCalls: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
      ],
      defaultOptions: [{ ownedRootCalls: [] }],
      messages: {
        overwritten:
          'Each call stores its new directory in the single `{{name}}` slot the cleanup reads, so every earlier one from the same test leaks. Push each root to a list the cleanup drains, or make one root per test in `beforeEach`.',
      },
    },
    create(context) {
      const { ownedRootCalls } = { ownedRootCalls: [], ...context.options[0] };
      const owned = new Set([...OWNED_ROOT_CALLS, ...ownedRootCalls]);
      return {
        AssignmentExpression(node) {
          if (node.operator !== '=' || node.left.type !== 'Identifier') return;
          let value = unwrap(node.right);
          if (value?.type === 'AwaitExpression') value = unwrap(value.argument);
          if (value?.type !== 'CallExpression') return;
          if (!owned.has(calleeName(value))) return;
          const fn = functionOf(node);
          if (!fn) return;
          const owner = ownerOf(fn, context);
          if (owner?.kind === 'hook' && SETUP_HOOK_NAMES.has(owner.name))
            return;
          if (declaredIn(node.left, fn, context)) return;
          context.report({
            node,
            messageId: 'overwritten',
            data: { name: node.left.name },
          });
        },
      };
    },
  };

  return {
    noFixedSleep,
    specificRejection,
    callSpecificMatcher,
    independentExpectation,
    ownedDbSchema,
    teardownInFinally,
    cleanupLoopSettles,
    parseStructuredConfig,
    mockStateReset,
    mockExportParity,
    spawnResultChecked,
    localToolSpawn,
    fixtureRootTracked,
  };
}
