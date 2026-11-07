/**
 * TEST-STRUCT-02, the test-structure pack: nesting, fake timers, mock
 * hoisting, `each` titles, collection-time state and I/O, guarded slices,
 * shared `let` resets, hermetic Nest config, supertest for e2e, async IIFEs
 * and pinned path:line literals.
 * `test-structure.test.ts` owns it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import {
  assertion,
  calledMethod,
  COMPARISONS,
  constInit,
  enclosingFunctions,
  INDEX_METHODS,
  inFinally,
  isFunction,
  isNumber,
  isTeardownCallback,
  isTrueMatcher,
  ownerOf,
  propertyName,
  registeringBlock,
  registration,
  textOf,
  unwrap,
  variableOf,
  within,
} from './helpers.js';

/** How many spreads deep `skipProcessEnvSetting` reads options. */
const HERMETIC_OPTIONS_DEPTH = 3;

// ---------------------------------------------------------------------------
// TEST-STRUCT-02 — the test-structure pack
// ---------------------------------------------------------------------------

/** The field that holds a name, not a read, when the node is not computed. */
const NAME_ONLY_FIELD = { MemberExpression: 'property', Property: 'key' };

/**
 * The identifiers an expression reads, skipping nested functions.
 * `visitorKeys` is the parser's own child-field table
 * (`context.sourceCode.visitorKeys`): it names only fields that hold child
 * nodes, never the back-link to the parent, so the walk only descends.
 */
function identifiersIn(node, visitorKeys, found = []) {
  // Every caller passes a node: a non-null condition, or a child filtered below.
  const value = unwrap(node);
  if (isFunction(value)) return found;
  if (value.type === 'Identifier') {
    found.push(value);
    return found;
  }
  // A static member name or property key is a name, not a read.
  const nameOnly = value.computed ? null : value[NAME_ONLY_FIELD[value.type]];
  // An absent optional child is undefined; an array hole is null.
  visitorKeys[value.type]
    .flatMap(key => value[key])
    .filter(Boolean)
    .filter(child => child !== nameOnly)
    .forEach(child => identifiersIn(child, visitorKeys, found));
  return found;
}

/** `vi.x(...)` / `jest.x(...)`. */
function timerCall(node, method) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    ['vi', 'jest'].includes(node.callee.object.name) &&
    propertyName(node.callee) === method
  );
}

/** Timer APIs whose fake handle only the matching fake cancel can clear. */
const TIMER_PAIRS = [
  ['setTimeout', 'clearTimeout'],
  ['setInterval', 'clearInterval'],
  ['setImmediate', 'clearImmediate'],
];

/** `{ toFake: ['setTimeout'] }` → `['clearTimeout']`: cancels left real. */
function unpairedTimers(options) {
  const value = unwrap(options);
  if (value?.type !== 'ObjectExpression') return [];
  const toFake = value.properties.find(
    property =>
      property.type === 'Property' &&
      !property.computed &&
      (property.key.name ?? property.key.value) === 'toFake',
  );
  const list = unwrap(toFake?.value);
  if (list?.type !== 'ArrayExpression') return [];
  const faked = new Set(
    list.elements
      .filter(item => item?.type === 'Literal')
      .map(item => item.value),
  );
  return TIMER_PAIRS.filter(
    ([set, clear]) => faked.has(set) && !faked.has(clear),
  ).map(([, clear]) => clear);
}

const fakeTimersRestored = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Fake timers are restored even when a test fails (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      leak: '`useFakeTimers()` has no guaranteed restore: a failing assertion skips a `useRealTimers()` at the end of the test, and fake timers leak into every later test in the file. Restore in `afterEach`, `onTestFinished`, or a `finally` block.',
      unpaired:
        '`toFake` fakes a timer but not its cancel ({{missing}}): the real cancel cannot clear a fake handle, so a cancelled timer still fires and a debounce or timeout test passes for the wrong reason. Fake each set/clear pair together.',
    },
  },
  create(context) {
    const fakes = [];
    const finallyRestores = [];
    // Each teardown restore covers the block that registers it, not the
    // file; an `afterAll` runs once after the block, so it covers a fake made
    // outside any test (`beforeAll`, `beforeEach`), never one a test made.
    const hookRestores = [];
    return {
      CallExpression(node) {
        if (timerCall(node, 'useFakeTimers')) {
          const missing = unpairedTimers(node.arguments[0]);
          if (missing.length > 0) {
            context.report({
              node,
              messageId: 'unpaired',
              data: { missing: missing.join(', ') },
            });
          }
        }
        // At module scope the whole file runs on fake timers by design, and
        // each test file gets its own worker, so there is no later test to
        // leak into. A `vi.hoisted` callback runs at module load: the same.
        const outermost = enclosingFunctions(node, context).at(-1);
        if (
          timerCall(node, 'useFakeTimers') &&
          outermost &&
          !isHoisted(outermost.fn.parent)
        ) {
          fakes.push(node);
        }
        if (!timerCall(node, 'useRealTimers')) return;
        const chain = enclosingFunctions(node, context);
        const teardown = chain.find(isTeardownCallback);
        if (teardown) {
          hookRestores.push({
            block: registeringBlock(teardown.fn),
            perTest: teardown.owner?.name !== 'afterAll',
          });
        }
        if (inFinally(node)) finallyRestores.push(chain[0]?.fn ?? null);
      },
      'Program:exit'() {
        for (const fake of fakes) {
          const chain = enclosingFunctions(fake, context);
          const fn = chain[0].fn;
          // A module-level helper runs wherever it is called, which this
          // file does not show: any teardown restore counts for it.
          const helper = chain.every(({ owner }) => owner === null);
          // A fake inside a test outlives it unless restored per test. Made
          // in a hook, it is re-made before each test of the block, so the
          // block's `afterAll` is restore enough.
          const inTest = chain.some(({ owner }) => owner?.kind === 'test');
          const hooked = hookRestores.some(
            restore =>
              helper ||
              (within(fake, restore.block) && (restore.perTest || !inTest)),
          );
          if (!hooked && !finallyRestores.includes(fn)) {
            context.report({ node: fake, messageId: 'leak' });
          }
        }
      },
    };
  },
};

/** `vi.hoisted(...)`, possibly awaited. */
function isHoisted(init) {
  const value = unwrap(init?.type === 'AwaitExpression' ? init.argument : init);
  return (
    value?.type === 'CallExpression' &&
    value.callee.type === 'MemberExpression' &&
    value.callee.object.type === 'Identifier' &&
    value.callee.object.name === 'vi' &&
    propertyName(value.callee) === 'hoisted'
  );
}

const mockFactoryHoisted = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'vi.mock factories read only vi.hoisted values (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      notHoisted:
        '`vi.mock` is hoisted above every statement, so its factory runs before `{{name}}` is initialised. Create it with `vi.hoisted(() => ...)`, or read it lazily inside a returned function.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== 'MemberExpression' ||
          callee.object.type !== 'Identifier' ||
          callee.object.name !== 'vi' ||
          propertyName(callee) !== 'mock'
        ) {
          return;
        }
        const factory = node.arguments[1];
        if (!isFunction(factory)) return;
        const reported = new Set();
        // Only references evaluated when the factory runs: the factory's own
        // scope and its block scopes, which share its variableScope. A nested
        // function has its own and reads its variables later, after
        // initialisation.
        const visit = scope => {
          for (const reference of scope.references) {
            const variable = reference.resolved;
            if (
              !variable ||
              reference.isTypeReference ||
              reported.has(variable)
            )
              continue;
            if (!['module', 'global'].includes(variable.scope.type)) continue;
            const def = variable.defs[0];
            if (!def) continue;
            const eager =
              (def.type === 'ImportBinding' &&
                def.parent.source.value !== 'vitest') ||
              def.type === 'ClassName' ||
              (def.type === 'Variable' && !isHoisted(def.node.init));
            if (!eager) continue;
            reported.add(variable);
            context.report({
              node: reference.identifier,
              messageId: 'notHoisted',
              data: { name: variable.name },
            });
          }
          for (const child of scope.childScopes) {
            if (child.variableScope === scope.variableScope) visit(child);
          }
        };
        visit(context.sourceCode.getScope(factory));
      },
    };
  },
};

const noNestedTestBlocks = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'describe/it/hooks are never registered inside a test (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      nested:
        '`{{name}}` is registered inside a running test, where the runner no longer collects it: it never runs, or runs outside the suite it appears to belong to. Close the enclosing test first.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const owner = registration(node, context);
        if (!owner) return;
        if (
          enclosingFunctions(node, context).some(
            entry => entry.owner?.kind === 'test',
          )
        ) {
          context.report({
            node,
            messageId: 'nested',
            data: { name: owner.name },
          });
        }
      },
    };
  },
};

/**
 * How Vitest renders a literal cell for `token` (`%s`, `%j`..., or null for a
 * `$name`), or null when the cell is not a literal. Only the distinctions that decide
 * whether two rows collide matter: `%s` prints '10' and 10 alike, `%j`/`%p`
 * and `$name` quote the string.
 */
function renderCell(node, token) {
  const value = unwrap(node);
  if (!value) return null;
  let raw;
  if (value.type === 'Literal' && !value.regex) raw = value.value;
  else if (value.type === 'TemplateLiteral' && value.expressions.length === 0) {
    raw = value.quasis[0].value.cooked;
  } else if (value.type === 'Identifier' && value.name === 'undefined')
    raw = undefined;
  else return null;
  if (typeof raw !== 'string') return String(raw);
  if (['%d', '%i', '%f'].includes(token)) {
    // Text that is not a finite number renders NaN or Infinity, which says
    // nothing reliable about the title; treat the cell as not a literal.
    const number = Number(raw);
    return Number.isFinite(number) ? String(number) : null;
  }
  return ['%s', '%c'].includes(token) ? raw : JSON.stringify(raw);
}

function staticTitle(node) {
  const value = unwrap(node);
  if (value?.type === 'Literal' && typeof value.value === 'string')
    return value.value;
  if (value?.type === 'TemplateLiteral' && value.expressions.length === 0) {
    return value.quasis[0].value.cooked;
  }
  return null;
}

const PRINTF = /%[sdifjoOcp#$%]/g;
const DOLLAR = /\$([A-Za-z_][\w]*)/g;

const eachTitleUnique = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'it.each titles render uniquely and never print a function (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      sameTitle:
        'Every row of this `.each` table renders the same title, so a failure cannot say which case broke. Interpolate a distinguishing field (`%s`, `$name`).',
      duplicateTitle:
        'This row renders the same title as an earlier one, so their results are indistinguishable. Interpolate the field that differs.',
      functionInTitle:
        'This placeholder fills from a function, so the test name prints its source code. Drop the placeholder or point it at a plain field.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const owner = registration(node, context);
        if (!owner?.table || owner.table.type !== 'ArrayExpression') return;
        const title = staticTitle(owner.title);
        if (title === null) return;
        const rows = owner.table.elements;
        if (rows.some(row => !row || row.type === 'SpreadElement')) return;
        const placeholders = title.match(PRINTF) ?? [];
        const positional = placeholders.filter(
          p => !['%%', '%#', '%$'].includes(p),
        );
        const dollars = [...title.matchAll(DOLLAR)].map(match => match[1]);
        if (
          rows.length >= 2 &&
          positional.length === 0 &&
          dollars.length === 0 &&
          !placeholders.some(p => p === '%#' || p === '%$')
        ) {
          context.report({ node: owner.title, messageId: 'sameTitle' });
          return;
        }
        const cellsOf = row =>
          unwrap(row).type === 'ArrayExpression' ? unwrap(row).elements : [row];
        for (const row of rows) {
          const cells = cellsOf(row);
          positional.forEach((_, index) => {
            const cell = cells[index];
            if (cell && isFunction(unwrap(cell))) {
              context.report({ node: cell, messageId: 'functionInTitle' });
            }
          });
        }
        if (placeholders.some(p => p === '%#' || p === '%$')) return;
        const seen = new Set();
        for (const row of rows) {
          const value = unwrap(row);
          let rendered = title;
          let known = true;
          if (dollars.length > 0) {
            if (value.type !== 'ObjectExpression') continue;
            rendered = title.replace(DOLLAR, (_, key) => {
              const property = value.properties.find(
                p =>
                  p.type === 'Property' &&
                  !p.computed &&
                  (p.key.name ?? p.key.value) === key,
              );
              // A `$name` cell has no printf token and quotes strings like %j.
              const cell = property ? renderCell(property.value, null) : null;
              if (cell === null) known = false;
              // An unknown cell skips the row, so its text never matters.
              return String(cell);
            });
          }
          if (positional.length > 0) {
            const cells = cellsOf(row);
            let index = 0;
            rendered = rendered.replace(PRINTF, token => {
              if (token === '%%') return '%';
              const cell = renderCell(cells[index], token);
              index += 1;
              if (cell === null) known = false;
              return String(cell);
            });
          }
          if (!known) continue;
          if (seen.has(rendered)) {
            context.report({ node: row, messageId: 'duplicateTitle' });
          }
          seen.add(rendered);
        }
      },
    };
  },
};

const SETUP_HOOKS = new Set(['beforeAll', 'beforeEach']);

const noCollectionTimeSkipState = {
  meta: {
    type: 'problem',
    docs: {
      description: 'skipIf/runIf never read state a hook sets (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      hookState:
        '`{{name}}` is set in a `beforeAll`/`beforeEach`, but `skipIf`/`runIf` reads it while tests are being collected, before any hook runs, so it always sees the initial value. Decide the condition at module scope (an env var, a setup file), or check inside the test.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const owner = registration(node, context);
        if (!owner?.condition) return;
        for (const identifier of identifiersIn(
          owner.condition,
          context.sourceCode.visitorKeys,
        )) {
          const variable = variableOf(identifier, context);
          const def = variable?.defs[0];
          if (!def || def.type !== 'Variable' || def.parent?.kind === 'const')
            continue;
          const setInHook = variable.references.some(
            reference =>
              reference.isWrite() &&
              reference.identifier !== def.node.id &&
              enclosingFunctions(reference.identifier, context).some(
                entry =>
                  entry.owner?.kind === 'hook' &&
                  SETUP_HOOKS.has(entry.owner.name),
              ),
          );
          if (setInHook) {
            context.report({
              node: identifier,
              messageId: 'hookState',
              data: { name: identifier.name },
            });
          }
        }
      },
    };
  },
};

const IO_MODULES = new Set([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'child_process',
  'node:child_process',
]);

/** Probes that cannot throw: reading them at collection time is harmless. */
const NON_THROWING_IO = new Set(['existsSync']);

/** The root identifier of `a.b.c`. */
function rootIdentifier(node) {
  let value = unwrap(node);
  while (value?.type === 'MemberExpression') value = unwrap(value.object);
  return value?.type === 'Identifier' ? value : null;
}

const noCollectionTimeIo = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'No fs/child_process calls while tests are collected (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      collectionIo:
        '`{{name}}` runs while the file is being collected (module or describe scope). If it throws — a moved file, a git-less checkout — the whole file fails with an error that names none of its tests. Move it into `beforeAll` or the test that needs it.',
    },
  },
  create(context) {
    const named = new Map();
    const namespaces = new Set();
    return {
      ImportDeclaration(node) {
        if (!IO_MODULES.has(node.source.value) || node.importKind === 'type')
          return;
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier') {
            if (specifier.importKind === 'type') continue;
            const imported =
              specifier.imported.name ?? specifier.imported.value;
            named.set(specifier.local.name, imported);
          } else {
            namespaces.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        const callee = unwrap(node.callee);
        let name = null;
        if (callee.type === 'Identifier') {
          name = named.get(callee.name);
        } else if (callee.type === 'MemberExpression') {
          const root = rootIdentifier(callee);
          if (root && namespaces.has(root.name)) name = propertyName(callee);
        }
        if (!name || NON_THROWING_IO.has(name)) return;
        const chain = enclosingFunctions(node, context);
        if (chain.every(entry => entry.owner?.kind === 'suite')) {
          context.report({ node, messageId: 'collectionIo', data: { name } });
        }
      },
    };
  },
};

const SLICE_METHODS = new Set(['slice', 'substring', 'substr']);

/** The leaves of `a + b - c`. */
function arithmeticLeaves(node, leaves = []) {
  const value = unwrap(node);
  if (
    value?.type === 'BinaryExpression' &&
    ['+', '-'].includes(value.operator)
  ) {
    arithmeticLeaves(value.left, leaves);
    arithmeticLeaves(value.right, leaves);
  } else if (value) {
    leaves.push(value);
  }
  return leaves;
}

/**
 * Is `node`'s value thrown away: a statement of its own, under `void`, or
 * any but the last of a sequence (the last takes the sequence's fate)?
 */
function isDiscarded(node) {
  const { parent } = node;
  if (parent.type === 'ExpressionStatement') return true;
  if (parent.type === 'UnaryExpression') return parent.operator === 'void';
  if (parent.type !== 'SequenceExpression') return false;
  return parent.expressions.at(-1) !== node || isDiscarded(parent);
}

/**
 * A use of an index variable that checks it against "not found". A comparison
 * whose result is thrown away (`start !== -1;`, `void (start !== -1)`)
 * guards nothing.
 */
function isGuardUse(identifier) {
  const parent = identifier.parent;
  if (parent.type === 'BinaryExpression' && COMPARISONS.has(parent.operator))
    return !isDiscarded(parent);
  if (
    parent.type === 'CallExpression' &&
    parent.arguments[0] === identifier &&
    ((parent.callee.type === 'Identifier' && parent.callee.name === 'expect') ||
      (parent.callee.type === 'MemberExpression' &&
        rootIdentifier(parent.callee)?.name === 'Math'))
  ) {
    return true;
  }
  return false;
}

/** A split separator long enough to be a marker, not a delimiter like `,`. */
function isMarker(node) {
  const value = unwrap(node);
  if (!value) return false;
  if (value.type === 'Literal')
    return typeof value.value === 'string' && value.value.length >= 3;
  return ['TemplateLiteral', 'Identifier', 'MemberExpression'].includes(
    value.type,
  );
}

const guardedMarkerSlice = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Marker-based slicing checks the marker was found (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      inlineIndex:
        'Slicing at `indexOf(marker)` with no check that the marker is there: a missing marker gives -1, which slices from the end and the test runs on the wrong text. Assert `expect(text).toContain(marker)` first, or store the index and check it.',
      unguardedIndex:
        '`{{name}}` is never checked against -1 before it is used to slice, so a missing marker silently selects the wrong text. Assert it was found first.',
      splitIndex:
        '`.split(marker)[n]` is undefined when the marker is missing, and the test then checks nothing. Assert `expect(text).toContain(marker)` before indexing.',
    },
  },
  create(context) {
    /** Assertions, by nearest enclosing function (null: module scope). */
    const assertionsIn = new Map();
    /** Inline marker uses waiting for a presence assertion. */
    const pending = [];

    /** `R.indexOf(M)` / `R.split(M)` → a pending check on (R, M). */
    const markerUse = (node, call, messageId) => {
      const callee = unwrap(call.callee);
      const [marker] = call.arguments;
      if (!isMarker(marker)) return;
      pending.push({
        node,
        messageId,
        scope: enclosingFunctions(node, context)[0]?.fn ?? null,
        receiver: textOf(callee.object, context),
        marker: textOf(marker, context),
      });
    };

    /** `expect(R).toContain(M)` or `expect(R.includes(M)).toBe(true)`. */
    const provesMarker = (found, receiver, marker) => {
      if (!found.subject || found.negated || !found.args[0]) {
        return false;
      }
      if (
        textOf(found.subject, context) === receiver &&
        ['toContain', 'toMatch'].includes(found.matcher)
      ) {
        return textOf(found.args[0], context) === marker;
      }
      const subject = found.subject;
      return (
        subject.type === 'CallExpression' &&
        calledMethod(subject) === 'includes' &&
        textOf(unwrap(subject.callee).object, context) === receiver &&
        subject.arguments[0] !== undefined &&
        textOf(subject.arguments[0], context) === marker &&
        isTrueMatcher(found)
      );
    };

    return {
      CallExpression(node) {
        const found = assertion(node, context);
        if (found) {
          const scope = enclosingFunctions(node, context)[0]?.fn ?? null;
          if (!assertionsIn.has(scope)) assertionsIn.set(scope, []);
          assertionsIn.get(scope).push(found);
        }
        const method = calledMethod(node);
        if (method === 'at') {
          const object = unwrap(unwrap(node.callee).object);
          const [index] = node.arguments;
          if (
            object?.type === 'CallExpression' &&
            calledMethod(object) === 'split' &&
            index &&
            !isNumber(unwrap(index), 0)
          ) {
            markerUse(node, object, 'splitIndex');
          }
          return;
        }
        if (!SLICE_METHODS.has(method)) return;
        for (const argument of node.arguments) {
          for (const leaf of arithmeticLeaves(argument)) {
            // calledMethod is null for a leaf that is not a call.
            if (INDEX_METHODS.has(calledMethod(leaf))) {
              markerUse(node, leaf, 'inlineIndex');
              return;
            }
            if (leaf.type !== 'Identifier') continue;
            const init = constInit(leaf, context);
            if (
              !init ||
              init.type !== 'CallExpression' ||
              !INDEX_METHODS.has(calledMethod(init)) ||
              !isMarker(init.arguments[0])
            ) {
              continue;
            }
            const variable = variableOf(leaf, context);
            const guarded = variable.references.some(
              reference =>
                reference.identifier !== leaf &&
                isGuardUse(reference.identifier),
            );
            if (!guarded) {
              context.report({
                node,
                messageId: 'unguardedIndex',
                data: { name: leaf.name },
              });
              return;
            }
          }
        }
      },
      MemberExpression(node) {
        // Only a Literal property has a numeric value, checked next.
        if (!node.computed) return;
        if (
          typeof node.property.value !== 'number' ||
          node.property.value < 1
        ) {
          return;
        }
        const object = unwrap(node.object);
        if (
          object?.type === 'CallExpression' &&
          calledMethod(object) === 'split'
        ) {
          markerUse(node, object, 'splitIndex');
        }
      },
      'Program:exit'() {
        for (const use of pending) {
          const found = assertionsIn.get(use.scope) ?? [];
          if (
            !found.some(entry => provesMarker(entry, use.receiver, use.marker))
          ) {
            context.report({ node: use.node, messageId: use.messageId });
          }
        }
      },
    };
  },
};

const RESET_HOOKS = new Set(['beforeEach', 'afterEach']);

const resetSharedLet = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Shared `let` state written by tests is reset per test (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      notReset:
        "`{{name}}` is shared by every test in this file and written inside a test, but no `beforeEach`/`afterEach` that covers that test resets it. A test that reads it without writing first sees the previous test's value instead of failing. Reset it in `beforeEach`.",
    },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (node.kind !== 'let') return;
        const parent = node.parent;
        const shared =
          parent.type === 'Program' ||
          // Only a function is a registration's callback, so ownerOf is null
          // for any other block parent.
          (parent.type === 'BlockStatement' &&
            ownerOf(parent.parent, context)?.kind === 'suite');
        if (!shared) return;
        for (const declarator of node.declarations) {
          if (declarator.id.type !== 'Identifier') continue;
          const [variable] =
            context.sourceCode.getDeclaredVariables(declarator);
          if (!variable) continue;
          const writes = variable.references.filter(
            reference =>
              reference.isWrite() && reference.identifier !== declarator.id,
          );
          const owners = writes.map(reference =>
            enclosingFunctions(reference.identifier, context),
          );
          // A reset hook covers the tests in the block that registers it: a
          // hook in one describe says nothing about a test in another.
          const resetBlocks = owners.flatMap(chain =>
            chain
              .filter(
                entry =>
                  entry.owner?.kind === 'hook' &&
                  RESET_HOOKS.has(entry.owner.name),
              )
              .map(entry => registeringBlock(entry.fn)),
          );
          const unreset = owners.some(chain =>
            chain.some(
              entry =>
                entry.owner?.kind === 'test' &&
                !resetBlocks.some(block => within(entry.fn, block)),
            ),
          );
          if (unreset) {
            context.report({
              node: declarator,
              messageId: 'notReset',
              data: { name: declarator.id.name },
            });
          }
        }
      },
    };
  },
};

/** A literal `true`, directly or through a `const`. */
function isTrueLiteral(node, context) {
  let value = unwrap(node);
  if (value?.type === 'Identifier') value = constInit(value, context);
  return value?.type === 'Literal' && value.value === true;
}

/**
 * What these `ConfigModule.forRoot` options set `skipProcessEnv` to: true
 * only for a literal `true`; null where they are readable and do not say;
 * false for any other value. Read through `const` bindings and spreads, the
 * last write winning as at runtime. Options this cannot read might set it to
 * anything, so they count as false.
 */
function skipProcessEnvSetting(node, context, depth = 0) {
  let options = unwrap(node);
  if (options?.type === 'Identifier') options = constInit(options, context);
  if (options?.type !== 'ObjectExpression' || depth > HERMETIC_OPTIONS_DEPTH) {
    return false;
  }
  let setting = null;
  for (const property of options.properties) {
    if (property.type === 'SpreadElement') {
      const spread = skipProcessEnvSetting(
        property.argument,
        context,
        depth + 1,
      );
      if (spread !== null) setting = spread;
    } else if (
      !property.computed &&
      (property.key.name ?? property.key.value) === 'skipProcessEnv'
    ) {
      setting = isTrueLiteral(property.value, context);
    }
  }
  return setting;
}

const hermeticConfig = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Test ConfigService instances never read process.env (TEST-STRUCT-02)',
    },
    // `helperModule`: where the workspace's `hermeticConfigService` lives,
    // named in the message (a repository path such as `test/utils/...`).
    schema: [
      {
        type: 'object',
        properties: { helperModule: { type: 'string' } },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ helperModule: 'a test helper with no process.env fallback' }],
    messages: {
      configService:
        "`new ConfigService(values)` falls back to process.env for every key it lacks, so this test reads the developer's or CI's environment. Use `hermeticConfigService(values)` from {{helperModule}}.",
      configModule:
        "`ConfigModule.forRoot` without `skipProcessEnv: true` lets process.env override the test's configuration. Set `skipProcessEnv: true` (and `ignoreEnvFile: true`).",
    },
  },
  create(context) {
    const [{ helperModule }] = context.options;
    return {
      NewExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'ConfigService'
        ) {
          context.report({
            node,
            messageId: 'configService',
            data: { helperModule },
          });
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== 'MemberExpression' ||
          rootIdentifier(callee)?.name !== 'ConfigModule' ||
          propertyName(callee) !== 'forRoot'
        ) {
          return;
        }
        if (skipProcessEnvSetting(node.arguments[0], context) !== true) {
          context.report({ node, messageId: 'configModule' });
        }
      },
    };
  },
};

const e2eUsesSupertest = {
  meta: {
    type: 'problem',
    docs: {
      description: 'An *.e2e.test.ts drives the app over HTTP (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      noHttp:
        'This file is named `*.e2e.test.ts` but never imports supertest, so it does not exercise the HTTP contract its name claims. Drive the app with supertest, or rename it to an integration test.',
    },
  },
  create(context) {
    if (!/\.e2e\.test\.[cm]?[jt]sx?$/.test(context.filename)) return {};
    let usesSupertest = false;
    // The HTTP claim is about the app. A suite that imports neither the app's
    // source nor Nest (a test of a test utility that runs in the e2e suite for
    // its real database, such as a fixture-reset helper's e2e suite) makes no
    // claim about the HTTP contract, so it is not held to one.
    let touchesApp = false;
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== 'string') return;
        if (source === 'supertest') usesSupertest = true;
        if (
          source.startsWith('@nestjs/') ||
          (source.startsWith('.') && /(^|\/)src(\/|$)/.test(source))
        ) {
          touchesApp = true;
        }
      },
      'Program:exit'(node) {
        if (touchesApp && !usesSupertest) {
          context.report({
            node,
            loc: { line: 1, column: 0 },
            messageId: 'noHttp',
          });
        }
      },
    };
  },
};

const noVoidAsyncIife = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'No `void (async () => ...)()` in tests and test helpers (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      voidIife:
        "`void` discards this async IIFE's promise, so a rejection inside it is swallowed and the request or test it serves hangs until a timeout that hides the cause. Await it, or catch and report the error.",
    },
  },
  create(context) {
    return {
      UnaryExpression(node) {
        if (node.operator !== 'void') return;
        const call = unwrap(node.argument);
        if (call?.type !== 'CallExpression') return;
        const callee = unwrap(call.callee);
        if (isFunction(callee) && callee.async) {
          context.report({ node, messageId: 'voidIife' });
        }
      },
    };
  },
};

/**
 * The top-level directories a repository path starts with, unless the
 * `topDirs` option names the repository's own. A path:line reference is only
 * looked up when it starts with one of them.
 */
const DEFAULT_TOP_DIRS = [
  'src',
  'lib',
  'test',
  'tests',
  'scripts',
  'apps',
  'packages',
  'docs',
  '.github',
];

const pathLinePatterns = new Map();

/** `dir/...:n` for any of `topDirs`, built once per list. */
function pathLinePattern(topDirs) {
  const key = JSON.stringify(topDirs);
  if (pathLinePatterns.has(key)) return pathLinePatterns.get(key);
  const top = `(?:${topDirs
    .map(dir => dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})`;
  const pattern = new RegExp(
    `(?:^|[^\\w./-])(${top}/[\\w./-]+):(\\d+)\\b`,
    'g',
  );
  pathLinePatterns.set(key, pattern);
  return pattern;
}

const repoRoots = new Map();

/**
 * The repository root above `filename`: the nearest directory holding
 * `marker` (the `rootMarker` option, e.g. a workspace manifest), or null.
 */
function repoRootOf(filename, marker) {
  const start = dirname(resolve(filename));
  const key = `${marker}\0${start}`;
  if (repoRoots.has(key)) return repoRoots.get(key);
  let root = null;
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, marker))) {
      root = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  repoRoots.set(key, root);
  return root;
}

const trackedFiles = new Map();

/**
 * The paths git tracks under `root`, relative to it: listed once per root and
 * cached for the lint process, so a run spawns git once. Untracked and ignored
 * files are not in it, so a worktree's `.env` link (a symlink CI never has)
 * is not a real repository file, and local lint agrees with CI.
 *
 * FALLBACK. Null when git cannot list them (no git binary, `root` not in a
 * work tree) or lists none (`root` is an ignored copy, such as Stryker's
 * sandbox, or a repository with nothing added); the rule then asks the disk,
 * as before 2026-10-23, which counts untracked and ignored files too.
 */
function trackedFilesOf(root) {
  if (trackedFiles.has(root)) return trackedFiles.get(root);
  const listing = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    // 64 MiB: the default 1 MiB would truncate a large index into the fallback.
    maxBuffer: 67_108_864,
  });
  const tracked =
    listing.status === 0 && listing.stdout !== ''
      ? new Set(listing.stdout.split('\0'))
      : null;
  trackedFiles.set(root, tracked);
  return tracked;
}

const noPathLineLiteral = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Tests never pin line numbers in other repository files (TEST-STRUCT-02)',
    },
    // The repository root is `root` when given; else the nearest directory
    // above the linted file holding `rootMarker` (no such directory: the rule
    // is off for the file); else ESLint's cwd. `topDirs`: the top-level
    // directories a repository path can start with.
    schema: [
      {
        type: 'object',
        properties: {
          root: { type: 'string' },
          rootMarker: { type: 'string', minLength: 1 },
          topDirs: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            minItems: 1,
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ topDirs: DEFAULT_TOP_DIRS }],
    messages: {
      pinned:
        '`{{ref}}` pins a line number inside a real repository file, so any unrelated edit to that file breaks this test. Assert on the content (a pattern, a symbol) instead of its position.',
    },
  },
  create(context) {
    const [{ root: given, rootMarker, topDirs }] = context.options;
    const root =
      given ??
      (rootMarker ? repoRootOf(context.filename, rootMarker) : context.cwd);
    if (!root) return {};
    const tracked = trackedFilesOf(root);
    // git lists canonical paths; `scripts/../src/x.ts` must find `src/x.ts`
    // as the disk lookup does.
    const isRepositoryFile = tracked
      ? path => tracked.has(posix.normalize(path))
      : path => existsSync(join(root, path));
    const pathLine = pathLinePattern(topDirs);
    const check = (node, text) => {
      for (const match of text.matchAll(pathLine)) {
        if (isRepositoryFile(match[1])) {
          context.report({
            node,
            messageId: 'pinned',
            data: { ref: `${match[1]}:${match[2]}` },
          });
          return;
        }
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

export {
  e2eUsesSupertest,
  eachTitleUnique,
  fakeTimersRestored,
  guardedMarkerSlice,
  hermeticConfig,
  mockFactoryHoisted,
  noCollectionTimeIo,
  noCollectionTimeSkipState,
  noNestedTestBlocks,
  noPathLineLiteral,
  noVoidAsyncIife,
  resetSharedLet,
};
