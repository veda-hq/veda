/**
 * VAL-06 (+ EDGE-03's process.env clause) `env-through-schema`. Replaces the
 * banned construct with a typed env schema; the `hints` option names the
 * caller's own env helpers.
 * Registered by ./index.js.
 */

import {
  climb,
  hintFor,
  hintsSchema,
  isMember,
  isProcessMember,
  isNullishOrEmpty,
} from './helpers.js';

const COERCIONS = new Set(['Number', 'parseInt', 'parseFloat', 'Boolean']);

function isCoercionCallee(callee) {
  if (callee.type === 'Identifier') return COERCIONS.has(callee.name);
  return (
    isMember(callee, 'Number', 'parseInt') ||
    isMember(callee, 'Number', 'parseFloat')
  );
}

function isConfigReceiver(node) {
  if (node.type === 'Identifier') return /config/i.test(node.name);
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    /config/i.test(node.property.name)
  );
}

/** The fix sentence each message ends with, unless the `hints` option sets one. */
export const DEFAULT_HINTS = {
  coerced:
    'Declare it in a typed env schema that rejects blank, malformed and out-of-range values at startup.',
  fallback:
    'Read it through a helper that treats blank as unset, then apply the fallback.',
  presence:
    'Read it through a helper that treats blank as unset, or declare it as a boolean flag in a typed env schema.',
  direct:
    'Read environment variables through one typed env schema so blank, padded and malformed values fail at startup.',
  typedConfigGet: 'Validate with an env schema.',
};

const envThroughSchema = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Read environment variables through typed env helpers, not process.env',
    },
    defaultOptions: [{ allowDirectRead: false, hints: DEFAULT_HINTS }],
    schema: [
      {
        type: 'object',
        properties: {
          allowDirectRead: { type: 'boolean' },
          hints: hintsSchema(Object.keys(DEFAULT_HINTS)),
        },
        additionalProperties: false,
      },
    ],
    messages: {
      coerced:
        'Coercing `process.env` directly turns blank into 0, `abc` into NaN and `1e9` into a billion, and none of them fails until used. {{hint}}',
      fallback:
        '`process.env.X ?? fallback` keeps a BLANK `X`, so it masks the fallback (a blank HARNESS_DB_URL once masked DATABASE_URL). {{hint}}',
      presence:
        'Comparing `process.env.X` with undefined/null/"" decides presence by spelling: `X=` and `X=false` both read as set. {{hint}}',
      direct: '{{hint}}',
      typedConfigGet:
        '`{{method}}<{{type}}>()` only ASSERTS the type: ConfigService returns the raw string, so "false" is truthy and "abc" is a number. {{hint}}',
    },
  },
  create(context) {
    const allowDirectRead = context.options[0].allowDirectRead === true;
    const report = (node, messageId, data = {}) =>
      context.report({
        node,
        messageId,
        data: { ...data, hint: hintFor(context, messageId) },
      });

    const judge = (node, outer) => {
      const parent = outer.parent;
      if (
        parent.type === 'CallExpression' &&
        parent.arguments[0] === outer &&
        isCoercionCallee(parent.callee)
      ) {
        report(node, 'coerced');
        return;
      }
      if (
        parent.type === 'UnaryExpression' &&
        parent.operator === '+' &&
        parent.argument === outer
      ) {
        report(node, 'coerced');
        return;
      }
      if (
        parent.type === 'LogicalExpression' &&
        parent.operator === '??' &&
        parent.left === outer
      ) {
        report(node, 'fallback');
        return;
      }
      if (
        parent.type === 'BinaryExpression' &&
        ['===', '!==', '==', '!='].includes(parent.operator)
      ) {
        const other = parent.left === outer ? parent.right : parent.left;
        if (isNullishOrEmpty(other)) {
          report(node, 'presence');
          return;
        }
      }
      if (!allowDirectRead) report(node, 'direct');
    };

    return {
      MemberExpression(node) {
        if (!isProcessMember(node.object, 'env')) return;
        const parent = node.parent;
        // Writes and deletes configure the environment; they do not read it.
        if (parent.type === 'AssignmentExpression' && parent.left === node) {
          return;
        }
        if (parent.type === 'UnaryExpression' && parent.operator === 'delete') {
          return;
        }
        if (parent.type === 'UpdateExpression') return;
        judge(node, climb(node));
      },
      VariableDeclarator(node) {
        if (allowDirectRead) return;
        if (node.id.type !== 'ObjectPattern' || !node.init) return;
        if (isProcessMember(node.init, 'env')) report(node.id, 'direct');
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== 'MemberExpression' ||
          callee.computed ||
          callee.property.type !== 'Identifier' ||
          !['get', 'getOrThrow'].includes(callee.property.name) ||
          !isConfigReceiver(callee.object)
        ) {
          return;
        }
        const typeArgument = node.typeArguments?.params?.[0];
        if (
          typeArgument?.type === 'TSNumberKeyword' ||
          typeArgument?.type === 'TSBooleanKeyword'
        ) {
          report(node, 'typedConfigGet', {
            method: callee.property.name,
            type: typeArgument.type === 'TSNumberKeyword' ? 'number' : 'boolean',
          });
        }
      },
    };
  },
};

export default envThroughSchema;
