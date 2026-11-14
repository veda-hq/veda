/**
 * TEST-WEAK-03, one more vacuous shape: a Prisma null sentinel inside a
 * partial matcher (`jsonnull-in-matcher`). `jsonnull-in-matcher.test.ts`
 * owns it.
 *
 * WHY. `Prisma.JsonNull`, `Prisma.DbNull` and `Prisma.AnyNull` are class
 * instances with no own enumerable keys. A partial matcher compares an
 * expected object by its keys, so the sentinel has nothing to compare:
 * inside `toMatchObject` it matches any stored value (5, null, an object,
 * the other sentinel), and inside `expect.objectContaining` any value that
 * is an object with no keys (`Prisma.DbNull`, `Prisma.JsonNull`, `{}`), so it
 * cannot tell JSON null from database NULL. Measured on Vitest 4.1 with the
 * Prisma runtime's own sentinel instances. `toBe` and `toStrictEqual`
 * compare the instance itself.
 *
 * SCOPE. The sentinel is reported where it is the matcher's argument or is
 * reached from it through object property values, array elements, spreads,
 * type-only wrappers and `const` bindings (three deep). A nested call (an
 * inner `expect.objectContaining`) is a matcher of its own and is checked
 * when that call is visited.
 */
import {
  calledMethod,
  constInit,
  propertyName,
  unwrap,
  variableOf,
} from './helpers.js';

/** The sentinels with no enumerable keys. */
const PRISMA_NULLS = new Set(['JsonNull', 'DbNull', 'AnyNull']);

/** How deep a `const` binding is followed from a matcher argument. */
const BINDING_DEPTH = 3;

/**
 * The sentinel's name when `node` is one: `Prisma.JsonNull`, a named import
 * of it from `@prisma/client` (or a subpath), or a `const { JsonNull } =
 * Prisma` binding; otherwise null.
 */
function prismaNullName(node, context) {
  if (node.type === 'MemberExpression') {
    const name = propertyName(node);
    const object = unwrap(node.object);
    return object.type === 'Identifier' &&
      object.name === 'Prisma' &&
      PRISMA_NULLS.has(name)
      ? name
      : null;
  }
  if (node.type !== 'Identifier') return null;
  const variable = variableOf(node, context);
  if (!variable || variable.defs.length !== 1) return null;
  const [def] = variable.defs;
  if (def.type === 'ImportBinding') {
    const imported =
      def.node.type === 'ImportSpecifier' ? def.node.imported : null;
    const name = imported?.name ?? imported?.value;
    return /^@prisma\/client(\/|$)/.test(def.parent.source.value) &&
      PRISMA_NULLS.has(name)
      ? name
      : null;
  }
  // `const { JsonNull } = Prisma`, or renamed: `const { DbNull: dbNull } = Prisma`.
  const init = def.type === 'Variable' ? unwrap(def.node.init) : null;
  if (
    init?.type !== 'Identifier' ||
    init.name !== 'Prisma' ||
    def.node.id.type !== 'ObjectPattern'
  ) {
    return null;
  }
  const property = def.node.id.properties.find(
    entry => entry.type === 'Property' && unwrap(entry.value) === def.name,
  );
  const key = property && !property.computed ? property.key.name : null;
  return PRISMA_NULLS.has(key) ? key : null;
}

/** The partial matcher a call is, or null: `toMatchObject` or `objectContaining`. */
function partialMatcher(call) {
  const method = calledMethod(call);
  if (method === 'toMatchObject' || method === 'objectContaining') return method;
  return null;
}

const jsonnullInMatcher = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A Prisma null sentinel inside toMatchObject or objectContaining, where it has no keys to compare (TEST-WEAK-03)',
    },
    schema: [],
    messages: {
      toMatchObject:
        'Prisma.{{name}} matches any value inside toMatchObject (it has no enumerable keys). Assert the field on its own: expect(data.col).toBe(Prisma.{{name}}) for a value given to Prisma, expect(row.col).toBeNull() for a row read back.',
      objectContaining:
        'Prisma.{{name}} matches any object without keys inside objectContaining (it has no enumerable keys), so Prisma.DbNull, Prisma.JsonNull and {} all pass. Assert the field on its own: expect(data.col).toBe(Prisma.{{name}}) for a value given to Prisma, expect(row.col).toBeNull() for a row read back.',
    },
  },
  create(context) {
    const reported = new Set();

    /** Report every sentinel reached from `node`, the argument of `matcher`. */
    function visit(node, matcher, depth) {
      const value = unwrap(node);
      if (!value) return;
      switch (value.type) {
        case 'ObjectExpression':
          for (const property of value.properties) {
            visit(
              property.type === 'Property' ? property.value : property.argument,
              matcher,
              depth,
            );
          }
          return;
        case 'ArrayExpression':
          for (const element of value.elements) visit(element, matcher, depth);
          return;
        case 'SpreadElement':
          visit(value.argument, matcher, depth);
          return;
        default:
          break;
      }
      const name = prismaNullName(value, context);
      if (name !== null) {
        if (reported.has(value)) return;
        reported.add(value);
        context.report({ node: value, messageId: matcher, data: { name } });
        return;
      }
      if (value.type === 'Identifier' && depth < BINDING_DEPTH) {
        visit(constInit(value, context), matcher, depth + 1);
      }
    }

    return {
      CallExpression(node) {
        const matcher = partialMatcher(node);
        if (matcher === null) return;
        for (const argument of node.arguments) visit(argument, matcher, 0);
      },
    };
  },
};

export { jsonnullInMatcher };
