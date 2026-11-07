/**
 * VAL-09 (Prisma Json columns; typed only) `prisma-json-through-schema`.
 * Replaces the banned construct with: a zod schema.
 * Registered by ./index.js.
 */

import { typeServices, typeNameTail } from './helpers.js';

//
// A Prisma `Json` column reads as `JsonValue` (a union of JsonObject,
// JsonArray and scalars), not `any`, so no-unsafe-member-access misses it.
// The value may be passed along whole — to a schema's `.parse`/`.safeParse`,
// to `JSON.stringify`, back into Prisma — but not read field by field: member
// access and indexing (including after a hand-rolled `typeof` narrowing to
// JsonObject/JsonArray), destructuring, and casts to anything but `unknown`
// or another Json type all fail. Types are matched by name (JsonValue,
// JsonObject, JsonArray), so a project-local JSON type of the same name is
// held to the same rule. Without type information the rule does nothing.

const JSON_TYPE_NAMES = new Set(['JsonValue', 'JsonObject', 'JsonArray']);

function isJsonType(type) {
  const alias = type.aliasSymbol?.getName();
  if (alias && JSON_TYPE_NAMES.has(alias)) return true;
  const symbol = type.getSymbol()?.getName();
  if (symbol && JSON_TYPE_NAMES.has(symbol)) return true;
  if (type.isUnion() || type.isIntersection()) {
    return type.types.some(isJsonType);
  }
  return false;
}

/** A cast target that keeps the value honest: `unknown` or a Json type. */
function isHonestTarget(annotation) {
  if (annotation.type === 'TSUnknownKeyword') return true;
  if (annotation.type !== 'TSTypeReference') return false;
  const last = typeNameTail(annotation.typeName);
  return last !== null && /Json/.test(last);
}

const CAST_TYPES = new Set([
  'TSAsExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
]);

const prismaJsonThroughSchema = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Read Prisma Json columns only through a schema, never field by field',
    },
    schema: [],
    messages: {
      jsonRead:
        'This reads a Prisma `Json` value ({{type}}) field by field. Nothing checked its shape: rows written by older code or by hand carry whatever was stored. Pass it whole to `Schema.parse(...)` / `safeParse(...)` (schema `satisfies z.ZodType<Type>`) and read the result.',
      jsonCast:
        'Casting a Prisma `Json` value ({{type}}) to `{{target}}` asserts a shape nobody checked. Validate with `Schema.parse(...)` instead.',
    },
  },
  create(context) {
    const types = typeServices(context);
    if (!types) return {};
    const nameOf = type =>
      type.aliasSymbol?.getName() ?? type.getSymbol()?.getName() ?? 'Json';

    /**
     * The innermost value under casts and non-null assertions. `satisfies`
     * is not climbed: it leaves its expression's type unchanged.
     */
    const uncast = node => {
      let current = node;
      while (CAST_TYPES.has(current.type)) current = current.expression;
      return current;
    };

    return {
      MemberExpression(node) {
        const object = node.object;
        if (object.type === 'Super') return;
        const type = types.typeOf(object);
        if (!isJsonType(type)) return;
        context.report({
          node,
          messageId: 'jsonRead',
          data: { type: nameOf(type) },
        });
      },
      VariableDeclarator(node) {
        if (
          !node.init ||
          (node.id.type !== 'ObjectPattern' && node.id.type !== 'ArrayPattern')
        ) {
          return;
        }
        const type = types.typeOf(node.init);
        if (!isJsonType(type)) return;
        context.report({
          node: node.id,
          messageId: 'jsonRead',
          data: { type: nameOf(type) },
        });
      },
      'TSAsExpression, TSTypeAssertion'(node) {
        // Judge the outermost cast of a chain once: `x as unknown as T`.
        if (
          node.parent.type === 'TSAsExpression' ||
          node.parent.type === 'TSTypeAssertion'
        ) {
          return;
        }
        if (isHonestTarget(node.typeAnnotation)) return;
        const inner = uncast(node.expression);
        const type = types.typeOf(inner);
        if (!isJsonType(type)) return;
        context.report({
          node,
          messageId: 'jsonCast',
          data: {
            type: nameOf(type),
            target: context.sourceCode.getText(node.typeAnnotation),
          },
        });
      },
    };
  },
};

export default prismaJsonThroughSchema;
