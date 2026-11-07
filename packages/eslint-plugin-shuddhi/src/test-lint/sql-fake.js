/**
 * TEST-WEAK-10: a hand-written SQL fake (`no-sql-fake`).
 * `sql-fake.test.ts` owns it.
 */
import { calledMethod, isFunction, propertyName, unwrap } from './helpers.js';

// ---------------------------------------------------------------------------
// TEST-WEAK-10 — hand-written SQL fakes
// ---------------------------------------------------------------------------

const SQL_METHODS = new Set([
  'query',
  'execute',
  'executeAsync',
  'executeSync',
  'executeRaw',
  'executeRawAsync',
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
  'unsafe',
]);
/** Methods named too generically for a `query`/`text` parameter to mean SQL. */
const GENERIC_SQL_METHODS = new Set(['run', 'all', 'get', 'exec', 'prepare']);
const SQL_PARAM = /^(sql|sqlText|statement|stmt)$/i;
const QUERY_PARAM = /^(query|queryText|text|q)$/i;

/** `vi.fn(impl)` / `jest.fn(impl)` → impl; a function → itself. */
function implementationOf(node) {
  const value = unwrap(node);
  if (isFunction(value)) return value;
  if (
    value?.type === 'CallExpression' &&
    value.callee.type === 'MemberExpression' &&
    ['vi', 'jest'].includes(value.callee.object?.name) &&
    propertyName(value.callee) === 'fn' &&
    isFunction(unwrap(value.arguments[0]))
  ) {
    return unwrap(value.arguments[0]);
  }
  return null;
}

function firstParamName(fn) {
  const [param] = fn.params;
  if (param?.type === 'Identifier') return param.name;
  if (param?.type === 'AssignmentPattern' && param.left.type === 'Identifier')
    return param.left.name;
  return null;
}

/** Calls that only record or inspect the SQL text, never execute it. */
const SQL_TEXT_CALLS = new Set([
  'push',
  'unshift',
  'add',
  'set',
  'log',
  'includes',
  'startsWith',
  'endsWith',
  'match',
  'matchAll',
  'test',
  'exec',
  'search',
  'indexOf',
  'trim',
  'toLowerCase',
  'toUpperCase',
  'replace',
  'replaceAll',
  'split',
  'String',
]);

/**
 * Does `fn` hand its SQL to something that runs it? An adapter onto a real
 * engine (`execute: (sql, p) => engine.prepare(sql).all(p)`) is the corrected
 * shape, not a fake: the SQL is forwarded to a call that is neither recording
 * nor string inspection.
 */
function forwardsSql(fn, param, context) {
  // `param` is always declared (an overload signature's has no references).
  const [variable] = context.sourceCode
    .getDeclaredVariables(fn)
    .filter(v => v.name === param);
  return variable.references.some(reference => {
    const parent = reference.identifier.parent;
    if (
      parent.type !== 'CallExpression' ||
      !parent.arguments.includes(reference.identifier)
    ) {
      return false;
    }
    const callee = unwrap(parent.callee);
    const name =
      callee.type === 'Identifier' ? callee.name : propertyName(callee);
    return !SQL_TEXT_CALLS.has(name);
  });
}

function isSqlFake(method, fn, context) {
  if (!fn || !method) return false;
  const param = firstParamName(fn);
  if (!param) return false;
  const named = SQL_PARAM.test(param)
    ? SQL_METHODS.has(method) || GENERIC_SQL_METHODS.has(method)
    : QUERY_PARAM.test(param) && SQL_METHODS.has(method);
  return named && !forwardsSql(fn, param, context);
}

const noSqlFake = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'SQL-issuing code is tested on a real migrated database (TEST-WEAK-10)',
    },
    // `realDatabase`: the workspace's real engine(s), named in the message.
    schema: [
      {
        type: 'object',
        properties: { realDatabase: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ realDatabase: 'a real test database' }],
    messages: {
      sqlFake:
        'This hand-written `{{method}}(sql)` fake answers without executing the SQL, so a dropped predicate, a wrong join or a missing ON CONFLICT still passes. Run the code against {{realDatabase}} with the checked-in migrations applied.',
    },
  },
  create(context) {
    const [{ realDatabase }] = context.options;
    const report = (node, method) =>
      context.report({
        node,
        messageId: 'sqlFake',
        data: { method, realDatabase },
      });
    return {
      Property(node) {
        if (node.computed && node.key.type !== 'Literal') return;
        const method = node.key.name ?? node.key.value;
        const fn = implementationOf(node.value);
        if (isSqlFake(method, fn, context)) report(node, method);
      },
      MethodDefinition(node) {
        const method = node.key.name ?? node.key.value;
        if (isSqlFake(method, node.value, context)) report(node, method);
      },
      CallExpression(node) {
        const name = calledMethod(node);
        if (!['mockImplementation', 'mockImplementationOnce'].includes(name))
          return;
        const target = unwrap(unwrap(node.callee).object);
        let method = null;
        if (target?.type === 'MemberExpression') method = propertyName(target);
        if (
          target?.type === 'CallExpression' &&
          calledMethod(target) === 'spyOn' &&
          target.arguments[1]?.type === 'Literal'
        ) {
          method = target.arguments[1].value;
        }
        const fn = implementationOf(node.arguments[0]);
        if (isSqlFake(method, fn, context)) report(node, method);
      },
    };
  },
};

export { noSqlFake };
