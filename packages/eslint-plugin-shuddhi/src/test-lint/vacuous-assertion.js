/**
 * TEST-WEAK-03: an assertion whose outcome is fixed when the file is written
 * (`no-vacuous-assertion`), with the typing and proof helpers only
 * it reads. `vacuous-assertion.test.ts`
 * owns it. The family's `index.js` header holds the rule's type-awareness reasoning and
 * its accepted limit.
 */
import {
  assertion,
  calledMethod,
  COMPARISONS,
  constInit,
  enclosingTest,
  INDEX_METHODS,
  isFunction,
  isNumber,
  isTrueMatcher,
  propertyName,
  registration,
  textOf,
  unwrap,
} from './helpers.js';

/** A value fixed when the file was written: literals and compositions of them. */
function isStatic(node, context, depth = 0) {
  const value = unwrap(node);
  if (!value || depth > 4) return false;
  switch (value.type) {
    case 'Literal':
      return true;
    case 'TemplateLiteral':
      return value.expressions.every(part =>
        isStatic(part, context, depth + 1),
      );
    case 'Identifier': {
      if (value.name === 'undefined') return true;
      const init = constInit(value, context);
      // Only a primitive const: an array or object const can be mutated by the
      // code under test, so asserting on it afterwards is a real check.
      return Boolean(init) && isStaticPrimitive(init, context, depth + 1);
    }
    case 'UnaryExpression':
      return (
        value.operator !== 'delete' &&
        isStatic(value.argument, context, depth + 1)
      );
    case 'BinaryExpression':
    case 'LogicalExpression':
      return (
        isStatic(value.left, context, depth + 1) &&
        isStatic(value.right, context, depth + 1)
      );
    case 'ArrayExpression':
      // A spread element is not static: isStatic falls to its default.
      return value.elements.every(
        element => element !== null && isStatic(element, context, depth + 1),
      );
    case 'ObjectExpression':
      return value.properties.every(
        property =>
          property.type === 'Property' &&
          !property.computed &&
          isStatic(property.value, context, depth + 1),
      );
    default:
      return false;
  }
}

/** `value` is a const's initialiser, already unwrapped (see constInit). */
function isStaticPrimitive(value, context, depth) {
  if (value.type === 'Literal') return !value.regex;
  if (value.type === 'TemplateLiteral' || value.type === 'UnaryExpression') {
    return isStatic(value, context, depth);
  }
  if (value.type === 'Identifier') return isStatic(value, context, depth);
  return false;
}

const BOOLEAN_METHODS = new Set([
  'some',
  'every',
  'includes',
  'startsWith',
  'endsWith',
  'isArray',
  'isInteger',
  'isFinite',
  'isNaN',
  'isSafeInteger',
]);
const STRING_METHODS = new Set([
  'join',
  'trim',
  'trimStart',
  'trimEnd',
  'toUpperCase',
  'toLowerCase',
  'padStart',
  'padEnd',
  'repeat',
  'replace',
  'replaceAll',
  'toFixed',
  'toISOString',
]);
const NUMBER_METHODS = new Set([
  'indexOf',
  'lastIndexOf',
  'findIndex',
  'findLastIndex',
  'search',
  'charCodeAt',
  'getTime',
  'valueOf',
]);

/** How far `builtFrom` follows a chain before it stops looking. */
const BUILT_FROM_DEPTH = 8;

/** Operand types a unary `+` or `-` turns into a number without throwing. */
const NUMBER_SAFE_OPERANDS = new Set([
  'number',
  'string',
  'boolean',
  'undefined',
]);

/** Boolean methods typed only on these built-in receivers. */
const RECEIVER_TYPED = new Map([
  ['has', new Set(['Set', 'Map', 'WeakSet', 'WeakMap'])],
  ['test', new Set(['RegExp'])],
]);

/**
 * Is `node` syntactically one of the `names` built-ins: `new Set(...)`,
 * `new RegExp(...)` or `RegExp(...)`, a regex literal for RegExp, or a const
 * bound to one (followed three deep)?
 */
function builtInReceiver(node, names, context, depth = 0) {
  const value = unwrap(node);
  if (!value || depth > 3) return false;
  if (value.type === 'Literal')
    return Boolean(value.regex) && names.has('RegExp');
  if (value.type === 'Identifier') {
    return builtInReceiver(
      constInit(value, context),
      names,
      context,
      depth + 1,
    );
  }
  // A member callee (`ns.Set`) has no `name`, so it is never a built-in.
  return (
    (value.type === 'NewExpression' || value.type === 'CallExpression') &&
    names.has(value.callee.name)
  );
}

/** `fixedTypeOf` of a `new` result: an object or a function, so truthy. */
const CONSTRUCTED = 'constructed value';

/**
 * The `typeof` JavaScript fixes for this expression, or null when the value
 * could be anything. Deliberately syntax-only (see the header).
 */
function fixedTypeOf(node, context, depth = 0) {
  const value = unwrap(node);
  if (!value || depth > 3) return null;
  switch (value.type) {
    case 'Literal':
      // A regex literal's value is a RegExp, or null where the runtime cannot
      // build it: 'object' either way.
      if (value.value === null) return 'object';
      return typeof value.value;
    case 'TemplateLiteral':
      return 'string';
    case 'ArrayExpression':
    case 'ObjectExpression':
      return 'object';
    case 'NewExpression':
      // A constructor may return any object, a function included
      // (`new Object(() => {})`): never null, but not one `typeof`.
      return value.callee.type === 'Identifier' &&
        value.callee.name === 'Function'
        ? 'function'
        : CONSTRUCTED;
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return 'function';
    case 'UnaryExpression':
      if (value.operator === '!') return 'boolean';
      if (value.operator === 'typeof') return 'string';
      if (value.operator === 'void') return 'undefined';
      if (value.operator === '-' || value.operator === '+') {
        // Typed only from a known operand: an unknown one may be a bigint
        // (`-` keeps it, `+` throws), a Symbol or an object whose valueOf
        // throws, so the expression can fail by more than its type.
        const operand = fixedTypeOf(value.argument, context, depth + 1);
        if (operand === 'bigint') {
          return value.operator === '-' ? 'bigint' : null;
        }
        return NUMBER_SAFE_OPERANDS.has(operand) ? 'number' : null;
      }
      return null;
    case 'BinaryExpression':
      // Arithmetic is number or bigint, which syntax cannot tell apart.
      return COMPARISONS.has(value.operator) ? 'boolean' : null;
    case 'CallExpression': {
      const callee = unwrap(value.callee);
      if (callee.type === 'Identifier') {
        if (callee.name === 'Boolean') return 'boolean';
        if (callee.name === 'String') return 'string';
        if (['Number', 'parseInt', 'parseFloat'].includes(callee.name))
          return 'number';
        return null;
      }
      const method = propertyName(callee);
      // `has` and `test` are common application method names: boolean only
      // on a receiver syntax shows is a built-in collection or a RegExp.
      // (`toString` is not typed at all: an override may return anything.)
      const builtIn = RECEIVER_TYPED.get(method);
      if (builtIn) {
        return builtInReceiver(callee.object, builtIn, context)
          ? 'boolean'
          : null;
      }
      if (method && BOOLEAN_METHODS.has(method)) return 'boolean';
      if (method && STRING_METHODS.has(method)) return 'string';
      if (method && NUMBER_METHODS.has(method)) return 'number';
      if (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'Math'
      ) {
        return 'number';
      }
      return null;
    }
    // No `.length` case: `x.length` is only a number when x is a string or
    // array, which syntax cannot tell, and `body.length` on an object is the
    // undefined a presence check exists to catch.
    case 'Identifier': {
      const init = constInit(value, context);
      return init ? fixedTypeOf(init, context, depth + 1) : null;
    }
    default:
      return null;
  }
}

/**
 * A whole word, not a suffix: `totalDiscount` ends in "count" and is money,
 * which can go negative. A bare `total` is a count; a camel `…Total`
 * (`finalTotal`) is usually an amount, so it is not.
 */
const COUNT_NAME =
  /^(count|length|size|total)$|[a-z0-9](Count|Length|Size)$|_(count|length|size)$/;

/** `.length`, `.size`, `fooCount`, `x.count()`: a value that is never negative. */
function isCount(node) {
  const value = unwrap(node);
  // A null name tests as the string 'null', which is no count.
  if (value.type === 'MemberExpression') {
    return COUNT_NAME.test(propertyName(value));
  }
  if (value.type === 'Identifier') return COUNT_NAME.test(value.name);
  if (value.type === 'CallExpression') {
    return /^count$/i.test(calledMethod(value));
  }
  return false;
}

/** `r.indexOf(a)` (directly or through a const) → { receiver, arg, call }. */
function indexCall(node, context) {
  let value = unwrap(node);
  if (value?.type === 'Identifier') value = constInit(value, context);
  if (!value || value.type !== 'CallExpression') return null;
  const method = calledMethod(value);
  if (!method || !INDEX_METHODS.has(method)) return null;
  return {
    receiver: unwrap(value.callee).object,
    arg: value.arguments[0] ?? null,
    call: value,
  };
}

/** `r.every(...)` (directly or through a const) → the receiver. */
function everyReceiver(node, context) {
  let value = unwrap(node);
  if (value?.type === 'Identifier') value = constInit(value, context);
  if (!value || value.type !== 'CallExpression') return null;
  return calledMethod(value) === 'every' ? unwrap(value.callee).object : null;
}

/** Built-ins whose result is empty exactly when their first argument is. */
const EMPTINESS_PRESERVING = new Set([
  'Set',
  'Map',
  'Array.from',
  'Object.keys',
  'Object.values',
  'Object.entries',
  'Object.fromEntries',
]);

/**
 * `new Set(rows)`, `Array.from(rows)`: a call whose result is empty when its
 * argument is. Any other call may ignore the argument and return data of its
 * own (`summarize(rows)` → `{ total: 0 }`).
 */
function preservesEmptiness(call) {
  const callee = unwrap(call.callee);
  // `a.b.from` reads `undefined.from`: only a plain `Array.from` matches.
  const name =
    callee.type === 'MemberExpression'
      ? `${callee.object.name}.${propertyName(callee)}`
      : callee.name;
  return EMPTINESS_PRESERVING.has(name);
}

/**
 * Is this value built from the receiver: the receiver itself, a member or
 * call chain starting at it (`rows.map(f).sort()`), or a built-in or array
 * that keeps its emptiness (`new Set(rows)`, `[...rows]`)?
 * A callback body is never followed: `other.map(() => f(rows))` is built from
 * `other`, and holds whatever `rows` is.
 */
function builtFrom(node, receiverText, context, depth = 0) {
  const value = unwrap(node);
  if (!value || depth > BUILT_FROM_DEPTH) return false;
  if (textOf(value, context) === receiverText) return true;
  const from = child => builtFrom(child, receiverText, context, depth + 1);
  switch (value.type) {
    case 'MemberExpression':
      return from(value.object);
    case 'CallExpression':
    case 'NewExpression':
      return (
        from(value.callee) ||
        (preservesEmptiness(value) && from(value.arguments[0]))
      );
    case 'SpreadElement':
      return from(value.argument);
    case 'ArrayExpression':
      return value.elements.some(from);
    default:
      return false;
  }
}

/** Does this assertion prove `receiverText` is non-empty? */
function provesNonEmpty(found, receiverText, context) {
  const subject = found.subject;
  if (!subject) return false;
  const subjectText = textOf(subject, context);
  const [arg] = found.args;
  const isEmptyLiteral = node =>
    isNumber(node, 0) ||
    (node?.type === 'ArrayExpression' && node.elements.length === 0) ||
    (node?.type === 'ObjectExpression' && node.properties.length === 0);
  if (subjectText === receiverText) {
    if (found.matcher === 'toHaveLength') {
      return found.negated ? isNumber(arg, 0) : !isNumber(arg, 0);
    }
    if (['toEqual', 'toStrictEqual'].includes(found.matcher)) {
      return found.negated
        ? arg?.type === 'ArrayExpression' && arg.elements.length === 0
        : Boolean(arg) && !isEmptyLiteral(arg);
    }
    return (
      ['toContain', 'toContainEqual'].includes(found.matcher) && !found.negated
    );
  }
  // A value derived from the receiver (`rows.map(f)`, `new Set(rows)`) held
  // equal to something non-empty proves the receiver was non-empty too —
  // directly or through a const (`const codes = rows.map(f).sort()`).
  const init =
    subject.type === 'Identifier' ? constInit(subject, context) : null;
  const derived =
    builtFrom(subject, receiverText, context) ||
    (init ? builtFrom(init, receiverText, context) : false);
  if (
    derived &&
    !found.negated &&
    [
      'toEqual',
      'toStrictEqual',
      'toMatchObject',
      'toContain',
      'toContainEqual',
      'toHaveLength',
    ].includes(found.matcher) &&
    Boolean(arg) &&
    !isEmptyLiteral(arg)
  ) {
    return true;
  }
  const lengthOf =
    subject.type === 'MemberExpression' &&
    ['length', 'size'].includes(propertyName(subject))
      ? textOf(subject.object, context)
      : null;
  if (lengthOf === receiverText) {
    if (found.negated)
      return ['toBe', 'toEqual'].includes(found.matcher) && isNumber(arg, 0);
    if (found.matcher === 'toBeGreaterThan')
      return arg?.type === 'Literal' && arg.value >= 0;
    if (found.matcher === 'toBeGreaterThanOrEqual')
      return arg?.type === 'Literal' && arg.value >= 1;
    if (['toBe', 'toEqual', 'toStrictEqual'].includes(found.matcher)) {
      return !(arg?.type === 'Literal' && arg.value === 0);
    }
    return found.matcher === 'toBeTruthy';
  }
  // `expect(r.some(...)).toBe(true)` also proves an element exists.
  if (
    subject.type === 'CallExpression' &&
    calledMethod(subject) === 'some' &&
    textOf(unwrap(subject.callee).object, context) === receiverText
  ) {
    return (
      !found.negated &&
      (found.matcher === 'toBeTruthy' ||
        (arg?.type === 'Literal' && arg.value === true))
    );
  }
  return false;
}

/** Does this assertion prove `index` (an indexOf call) is not -1? */
function provesFound(found, index, context) {
  const subject = found.subject;
  if (!subject) return false;
  const [arg] = found.args;
  const receiverText = textOf(index.receiver, context);
  const argText = index.arg ? textOf(index.arg, context) : null;
  if (
    textOf(subject, context) === receiverText &&
    !found.negated &&
    ['toContain', 'toMatch'].includes(found.matcher)
  ) {
    return (
      argText !== null && arg !== undefined && textOf(arg, context) === argText
    );
  }
  const other = indexCall(subject, context);
  if (other && textOf(other.call, context) === textOf(index.call, context)) {
    if (found.negated)
      return ['toBe', 'toEqual'].includes(found.matcher) && isNumber(arg, -1);
    if (found.matcher === 'toBeGreaterThan')
      return isNumber(arg, -1) || (arg?.type === 'Literal' && arg.value >= 0);
    if (found.matcher === 'toBeGreaterThanOrEqual')
      return arg?.type === 'Literal' && arg.value >= 0;
  }
  if (
    subject.type === 'CallExpression' &&
    calledMethod(subject) === 'includes' &&
    textOf(unwrap(subject.callee).object, context) === receiverText &&
    subject.arguments[0] &&
    argText !== null &&
    textOf(subject.arguments[0], context) === argText
  ) {
    return (
      !found.negated &&
      (found.matcher === 'toBeTruthy' ||
        (arg?.type === 'Literal' && arg.value === true))
    );
  }
  return false;
}

const ORDER_MATCHERS = new Set([
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
]);

/** `x.filter(...)` anywhere along a call chain: `x.filter(f).map(g)`. */
function chainHasFilter(node) {
  let value = unwrap(node);
  while (value && value.type === 'CallExpression') {
    if (calledMethod(value) === 'filter') return true;
    const callee = unwrap(value.callee);
    if (callee.type !== 'MemberExpression') return false;
    value = unwrap(callee.object);
  }
  return false;
}

// ---------------------------------------------------------------------------
// TEST-WEAK-03
// ---------------------------------------------------------------------------

const noVacuousAssertion = {
  meta: {
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
  create(context) {
    const all = [];
    const everyChecks = [];
    const orderChecks = [];
    const eachChecks = [];
    const instanceOfDate = [];

    function checkBlock(statements) {
      let seen = new Set();
      for (const statement of statements) {
        const expression =
          statement.type === 'ExpressionStatement'
            ? unwrap(
                statement.expression.type === 'AwaitExpression'
                  ? statement.expression.argument
                  : statement.expression,
              )
            : null;
        const found = expression ? assertion(expression, context) : null;
        // `expect(() => run()).not.toThrow()` and `.resolves` RUN code: a
        // second one is a second action, not a repeated check.
        const acts =
          found !== null &&
          (isFunction(found.subject) ||
            /^toThrow/.test(found.matcher) ||
            context.sourceCode.getText(expression).includes('.resolves') ||
            context.sourceCode.getText(expression).includes('.rejects'));
        if (found && !acts) {
          const key = textOf(expression, context);
          if (seen.has(key))
            context.report({ node: statement, messageId: 'duplicate' });
          seen.add(key);
        } else {
          seen = new Set();
        }
      }
    }

    return {
      BlockStatement(node) {
        if (enclosingTest(node, context) !== null) checkBlock(node.body);
      },
      CallExpression(node) {
        const owner = registration(node, context);
        if (owner?.table && chainHasFilter(owner.table)) {
          context.report({ node: owner.table, messageId: 'eachFilter' });
        } else if (owner?.table?.type === 'Identifier') {
          const init = constInit(owner.table, context);
          if (init && chainHasFilter(init)) eachChecks.push(owner.table);
        }

        const found = assertion(node, context);
        if (!found) return;
        const test = enclosingTest(node, context);
        all.push({ found, test });
        const { subject, matcher, args, negated } = found;
        if (!subject) return;

        if (
          isStatic(subject, context) &&
          args.every(arg => isStatic(arg, context))
        ) {
          context.report({ node, messageId: 'staticSubject' });
          return;
        }

        if (
          !negated &&
          ((matcher === 'toBeGreaterThanOrEqual' && isNumber(args[0], 0)) ||
            (matcher === 'toBeGreaterThan' && isNumber(args[0], -1))) &&
          isCount(subject)
        ) {
          context.report({ node, messageId: 'nonNegative' });
          return;
        }
        if (
          subject.type === 'BinaryExpression' &&
          subject.operator === '>=' &&
          isCount(subject.left) &&
          isNumber(unwrap(subject.right), 0) &&
          isTrueMatcher(found)
        ) {
          context.report({ node, messageId: 'nonNegative' });
          return;
        }

        if (
          subject.type === 'UnaryExpression' &&
          subject.operator === 'typeof' &&
          ['toBe', 'toEqual', 'toStrictEqual'].includes(matcher) &&
          !negated &&
          args[0]?.type === 'Literal'
        ) {
          const fixed = fixedTypeOf(subject.argument, context);
          if (fixed !== null && fixed === args[0].value) {
            context.report({
              node,
              messageId: 'typeFixed',
              data: { fixed: `typeof … === '${fixed}'` },
            });
            return;
          }
        }
        const presence =
          (matcher === 'toBeDefined' && !negated) ||
          (['toBeNull', 'toBeUndefined'].includes(matcher) && negated) ||
          (matcher === 'toBeTruthy' && !negated);
        if (presence) {
          const fixed = fixedTypeOf(subject, context);
          // A truthiness check is only fixed for objects and functions:
          // '', 0 and false are falsy. Presence is fixed for any known type.
          const holds =
            matcher === 'toBeTruthy'
              ? ['object', 'function', CONSTRUCTED].includes(fixed)
              : fixed !== null && fixed !== 'undefined';
          if (holds) {
            context.report({
              node,
              messageId: 'typeFixed',
              data: {
                fixed: `a ${fixed} is never ${matcher === 'toBeTruthy' ? 'falsy' : 'null or undefined'}`,
              },
            });
            return;
          }
        }

        if (
          matcher === 'toBeInstanceOf' &&
          !negated &&
          subject.type === 'NewExpression' &&
          args[0] &&
          textOf(subject.callee, context) === textOf(args[0], context)
        ) {
          context.report({ node, messageId: 'construction' });
          return;
        }
        if (
          matcher === 'toBeInstanceOf' &&
          !negated &&
          args[0]?.type === 'Identifier' &&
          args[0].name === 'Date'
        ) {
          instanceOfDate.push({ node, test });
        }

        let orSubject = subject;
        while (
          (orSubject.type === 'UnaryExpression' &&
            orSubject.operator === '!') ||
          (orSubject.type === 'CallExpression' &&
            orSubject.callee.type === 'Identifier' &&
            orSubject.callee.name === 'Boolean')
        ) {
          orSubject = unwrap(
            orSubject.type === 'UnaryExpression'
              ? orSubject.argument
              : orSubject.arguments[0],
          );
          if (!orSubject) return;
        }
        if (
          orSubject.type === 'LogicalExpression' &&
          orSubject.operator === '||'
        ) {
          context.report({ node, messageId: 'orInSubject' });
          return;
        }

        const everyOf = isTrueMatcher(found)
          ? everyReceiver(subject, context)
          : null;
        if (everyOf && everyOf.type !== 'ArrayExpression') {
          everyChecks.push({ node, test, receiver: textOf(everyOf, context) });
        }

        if (ORDER_MATCHERS.has(matcher) && !negated && args[0]) {
          const lower = matcher.startsWith('toBeLess') ? subject : args[0];
          const index = indexCall(lower, context);
          if (
            index &&
            (indexCall(subject, context) || indexCall(args[0], context))
          ) {
            orderChecks.push({ node, test, index });
          }
        }
      },
      'Program:exit'() {
        const scoped = test =>
          all.filter(entry => entry.test === test).map(entry => entry.found);
        for (const check of everyChecks) {
          if (
            !scoped(check.test).some(found =>
              provesNonEmpty(found, check.receiver, context),
            )
          ) {
            context.report({ node: check.node, messageId: 'vacuousEvery' });
          }
        }
        for (const check of orderChecks) {
          if (
            !scoped(check.test).some(found =>
              provesFound(found, check.index, context),
            )
          ) {
            context.report({ node: check.node, messageId: 'unguardedOrder' });
          }
        }
        for (const table of eachChecks) {
          const text = textOf(table, context);
          if (!all.some(({ found }) => provesNonEmpty(found, text, context))) {
            context.report({ node: table, messageId: 'eachFilter' });
          }
        }
        for (const entry of instanceOfDate) {
          if (entry.test && scoped(entry.test).length === 1) {
            context.report({ node: entry.node, messageId: 'soleInstanceOf' });
          }
        }
      },
    };
  },
};

export { noVacuousAssertion };
