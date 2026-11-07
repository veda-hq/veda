/**
 * The test-lint family's shared AST helpers: the ones two or
 * more rule families read. A helper one family alone reads lives in that
 * family's module. `helpers.test.ts` owns this module.
 */

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

const isFunction = node => Boolean(node) && FUNCTION_TYPES.has(node.type);

const WRAPPERS = new Set([
  'TSAsExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSSatisfiesExpression',
  'ChainExpression',
]);

/** Strip type-only wrappers and optional chaining: `x as T`, `x!`, `a?.b`. */
function unwrap(node) {
  let current = node;
  while (current && WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

/** `a.b` / `a['b']` → `'b'`; anything else → null. */
function propertyName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  const { property } = member;
  if (!member.computed) {
    return property.type === 'Identifier' ? property.name : null;
  }
  return property.type === 'Literal' && typeof property.value === 'string'
    ? property.value
    : null;
}

/** `x.method(...)` → `'method'`; anything that is not a call → null. */
function calledMethod(call) {
  if (call.type !== 'CallExpression') return null;
  return propertyName(unwrap(call.callee));
}

const TEST_ROOTS = new Set(['it', 'test']);
const SUITE_ROOTS = new Set(['describe', 'suite']);
const HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const CHAIN_FACTORIES = new Set(['each', 'for', 'skipIf', 'runIf']);

/**
 * A Vitest registration call, or null. Handles the chained forms
 * (`it.skip`, `it.each(table)(title, fn)`, `describe.skipIf(c)(...)`) and
 * returns what each rule needs: its kind, the each-table, the skip condition
 * and the callback. The factory half of `it.each(table)` is not itself a
 * registration and returns null.
 */
function registration(call, context) {
  if (call.type !== 'CallExpression') return null;
  const direct = call.callee;
  if (
    direct.type === 'MemberExpression' &&
    CHAIN_FACTORIES.has(propertyName(direct))
  ) {
    return null;
  }
  let callee = direct;
  let table = null;
  let condition = null;
  let tableCall = null;
  for (;;) {
    if (callee.type === 'CallExpression') {
      const name = propertyName(callee.callee);
      if (name === 'each' || name === 'for') {
        table = callee.arguments[0] ?? null;
        tableCall = callee;
      }
      if (name === 'skipIf' || name === 'runIf') {
        condition = callee.arguments[0] ?? null;
      }
      callee = callee.callee;
      continue;
    }
    if (callee.type === 'MemberExpression') {
      callee = callee.object;
      continue;
    }
    break;
  }
  if (callee.type !== 'Identifier' || !isTestApi(callee, context)) return null;
  let kind;
  if (TEST_ROOTS.has(callee.name)) kind = 'test';
  else if (SUITE_ROOTS.has(callee.name)) kind = 'suite';
  else if (HOOKS.has(callee.name) && direct.type === 'Identifier')
    kind = 'hook';
  else return null;
  const callback = [...call.arguments].reverse().find(isFunction) ?? null;
  return {
    kind,
    name: callee.name,
    table,
    tableCall,
    condition,
    callback,
    title: call.arguments[0] ?? null,
  };
}

const TEST_API_SOURCES = new Set(['vitest', '@jest/globals', 'node:test']);

/**
 * Is `identifier` the test API, rather than a local that shares its name? A
 * helper called `describe(...)` or a harness bound to `const test = ...` is
 * ordinary code. Globals (no binding) and imports from the runner count.
 */
function isTestApi(identifier, context) {
  const variable = variableOf(identifier, context);
  if (!variable || variable.defs.length === 0) return true;
  const def = variable.defs[0];
  return (
    def.type === 'ImportBinding' &&
    TEST_API_SOURCES.has(def.parent.source.value)
  );
}

/** The registration whose callback `fn` is, or null. */
function ownerOf(fn, context) {
  const parent = fn.parent;
  if (!parent || parent.type !== 'CallExpression') return null;
  if (!parent.arguments.includes(fn)) return null;
  const owner = registration(parent, context);
  return owner && owner.callback === fn ? owner : null;
}

/** Every function enclosing `node`, innermost first, with its owner. */
function enclosingFunctions(node, context) {
  const chain = [];
  for (let current = node.parent; current; current = current.parent) {
    if (isFunction(current)) {
      chain.push({ fn: current, owner: ownerOf(current, context) });
    }
  }
  return chain;
}

/** The nearest enclosing test (`it`/`test`) callback, or null. */
function enclosingTest(node, context) {
  return (
    enclosingFunctions(node, context).find(
      entry => entry.owner?.kind === 'test',
    )?.fn ?? null
  );
}

const MODIFIERS = new Set(['not', 'resolves', 'rejects']);

/**
 * `expect(subject)[.not|.resolves|.rejects]*.matcher(args)` → its parts, or
 * null. `expect.soft(...)` counts. A local binding named `expect` (a helper,
 * a custom harness) is ordinary code, not the runner's (isTestApi).
 */
function assertion(call, context) {
  if (!call || call.type !== 'CallExpression') return null;
  const callee = call.callee;
  if (callee.type !== 'MemberExpression') return null;
  const matcher = propertyName(callee);
  if (!matcher || MODIFIERS.has(matcher)) return null;
  let object = callee.object;
  let negated = false;
  while (
    object.type === 'MemberExpression' &&
    MODIFIERS.has(propertyName(object))
  ) {
    if (propertyName(object) === 'not') negated = !negated;
    object = object.object;
  }
  if (object.type !== 'CallExpression') return null;
  const fn = object.callee;
  const expectId =
    fn.type === 'MemberExpression' && propertyName(fn) === 'soft'
      ? fn.object
      : fn;
  if (
    expectId.type !== 'Identifier' ||
    expectId.name !== 'expect' ||
    !isTestApi(expectId, context)
  ) {
    return null;
  }
  return {
    node: call,
    matcher,
    negated,
    subject: object.arguments[0] ? unwrap(object.arguments[0]) : null,
    args: call.arguments.map(unwrap),
  };
}

/** The variable an identifier resolves to, walking out from its scope. */
function variableOf(identifier, context) {
  let scope = context.sourceCode.getScope(identifier);
  for (; scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable;
  }
  return null;
}

/** `const x = <init>` → `<init>`; any other binding → null. */
function constInit(identifier, context) {
  const variable = variableOf(identifier, context);
  if (!variable || variable.defs.length !== 1) return null;
  const def = variable.defs[0];
  if (
    def.type !== 'Variable' ||
    def.parent?.kind !== 'const' ||
    def.node.id.type !== 'Identifier' ||
    !def.node.init
  ) {
    return null;
  }
  return unwrap(def.node.init);
}

/**
 * A key for comparing two expressions by shape: the token list, so layout and
 * comments drop out but a literal keeps its spaces (`grep -m 1` and
 * `grep -m1` are two inputs, not one written twice). Encoded whole, not
 * joined: joined tokens read `typeof x` and `typeofx` as one expression.
 */
function textOf(node, context) {
  return JSON.stringify(
    context.sourceCode.getTokens(node).map(token => token.value),
  );
}
const COMPARISONS = new Set([
  '===',
  '!==',
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  'instanceof',
  'in',
]);

const isNumber = (node, n) =>
  node?.type === 'Literal' && node.value === n
    ? true
    : node?.type === 'UnaryExpression' &&
      node.operator === '-' &&
      node.argument.type === 'Literal' &&
      -node.argument.value === n;

const INDEX_METHODS = new Set([
  'indexOf',
  'lastIndexOf',
  'findIndex',
  'search',
]);

const isTrueMatcher = found =>
  !found.negated &&
  (found.matcher === 'toBeTruthy' ||
    (['toBe', 'toEqual', 'toStrictEqual'].includes(found.matcher) &&
      found.args[0]?.type === 'Literal' &&
      found.args[0].value === true));

/** Is `node` inside the `finally` block of a try statement? */
function inFinally(node) {
  let current = node;
  while (current.parent && !isFunction(current.parent)) {
    if (
      current.parent.type === 'TryStatement' &&
      current.parent.finalizer === current
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

const TEARDOWN_CALLS = new Set(['onTestFinished', 'onTestFailed']);

/** Is `fn` a teardown callback: `afterEach`/`afterAll` or `onTestFinished`? */
function isTeardownCallback({ fn, owner }) {
  return (
    (owner?.kind === 'hook' &&
      (owner.name === 'afterEach' || owner.name === 'afterAll')) ||
    (fn.parent?.type === 'CallExpression' &&
      fn.parent.callee.type === 'Identifier' &&
      TEARDOWN_CALLS.has(fn.parent.callee.name))
  );
}

/**
 * The block a hook callback `fn` is registered in: the function around its
 * `afterEach(...)` call, or the Program for a top-level hook.
 */
function registeringBlock(fn) {
  let up = fn.parent.parent;
  while (up.parent && !FUNCTION_TYPES.has(up.type)) up = up.parent;
  return up;
}

/** `node` is `block` or lies inside it; never when `block` is absent. */
function within(node, block) {
  for (let up = node; up; up = up.parent) if (up === block) return true;
  return false;
}

export {
  assertion,
  calledMethod,
  COMPARISONS,
  constInit,
  enclosingFunctions,
  enclosingTest,
  FUNCTION_TYPES,
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
  TEARDOWN_CALLS,
  textOf,
  unwrap,
  variableOf,
  within,
  WRAPPERS,
};
