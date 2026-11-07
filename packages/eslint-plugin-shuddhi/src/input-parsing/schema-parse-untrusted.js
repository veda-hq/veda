/**
 * VAL-09 `schema-parse-untrusted`. Replaces the banned
 * construct with: zod schemas.
 * Registered by ./index.js.
 */

import ts from 'typescript';

import {
  TRANSPARENT,
  isIdentifier,
  isMember,
  variableOf,
  readsOf,
  typeServices,
  chainRoot,
} from './helpers.js';

const SCHEMA_METHODS = new Set([
  'parse',
  'safeParse',
  'parseAsync',
  'safeParseAsync',
]);
const YAML_MODULES = new Set(['js-yaml', 'yaml']);
/** A receiver NAMED as a schema: `Schema`, `leaseSchema.strict()`, `schemas.x`. */
const SCHEMA_NAME = /schema/i;
/** Properties every zod schema type carries (v4 `_zod`, v3 `_def`, Standard Schema). */
const ZOD_TYPE_PROPERTIES = ['~standard', '_zod', '_def'];

/**
 * Is `receiver` (the object of a `.parse` call) a zod schema? With types: its
 * type carries zod's own properties. Without: the chain is built from `z`
 * (`z.object({…})`), its name says schema (`LeaseSchema`), or it is a local
 * binding initialised from such a chain. Anything else (`parser.parse`,
 * `JSON.parse`) is no schema (an identity `parse` must not
 * pass for validation).
 */
function isSchemaReceiver(context, types, receiver, seen = new Set()) {
  if (types) {
    const type = types.typeOf(receiver);
    if ((type.flags & ts.TypeFlags.AnyOrUnknown) === 0) {
      return ZOD_TYPE_PROPERTIES.some(name => type.getProperty(name));
    }
  }
  const root = chainRoot(receiver);
  if (isIdentifier(root, 'z')) return true;
  if (SCHEMA_NAME.test(context.sourceCode.getText(receiver))) return true;
  if (root.type !== 'Identifier') return false;
  // Follow the root's local initialiser (`const lease = z.object(…)`,
  // `const strict = leaseSchema.strict()`); `seen` stops a cycle.
  const variable = variableOf(context, root);
  if (!variable || seen.has(variable)) return false;
  seen.add(variable);
  const [definition] = variable.defs;
  const init = definition?.type === 'Variable' ? definition.node.init : null;
  return init ? isSchemaReceiver(context, null, init, seen) : false;
}

const schemaParseUntrusted = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Validate parsed JSON/YAML and response bodies with a zod schema before use',
    },
    schema: [],
    messages: {
      unvalidated:
        'This {{source}} result is used without a schema. Hand-rolled `typeof` checks drift from the producer (a ledger line with only `ts` and `mode` once passed as a full record). Pass it straight to `Schema.parse(...)` / `safeParse(...)`, with the schema declared `satisfies z.ZodType<ProducerType>`.',
      producerCast:
        'Casting a {{source}} result to the producer type asserts what nobody checked. Validate with `Schema.parse(...)` (declared `satisfies z.ZodType<ProducerType>`) instead of `as`/an annotation.',
    },
  },
  create(context) {
    const yamlNamespaces = new Set();
    const yamlFunctions = new Set();
    const types = typeServices(context);

    /** `schema.parse(…)` / `safeParse` / async forms on a zod schema. */
    const isSchemaCall = node => {
      if (node.type !== 'CallExpression') return false;
      const callee = node.callee;
      return (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        SCHEMA_METHODS.has(callee.property.name) &&
        isSchemaReceiver(context, types, callee.object)
      );
    };

    const sourceOf = node => {
      const callee = node.callee;
      if (isMember(callee, 'JSON', 'parse')) {
        const [argument] = node.arguments;
        // `JSON.parse(JSON.stringify(x))` is a deep clone of a trusted value.
        if (
          argument?.type === 'CallExpression' &&
          isMember(argument.callee, 'JSON', 'stringify')
        ) {
          return null;
        }
        return 'JSON.parse';
      }
      if (callee.type === 'Identifier' && yamlFunctions.has(callee.name)) {
        return 'YAML';
      }
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        yamlNamespaces.has(callee.object.name) &&
        callee.property.type === 'Identifier' &&
        ['load', 'parse', 'loadAll'].includes(callee.property.name)
      ) {
        return 'YAML';
      }
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'json' &&
        node.arguments.length === 0
      ) {
        return 'response .json()';
      }
      return null;
    };

    const climbValue = node => {
      let current = node;
      while (
        current.parent &&
        (TRANSPARENT.has(current.parent.type) ||
          (current.parent.type === 'AwaitExpression' &&
            current.parent.argument === current))
      ) {
        current = current.parent;
      }
      return current;
    };

    const isUnknownType = annotation => annotation?.type === 'TSUnknownKeyword';

    const judge = (node, source) => {
      let outer = climbValue(node);
      let parent = outer.parent;
      // `JSON.parse(text);` as a statement checks syntax and keeps nothing.
      if (parent.type === 'ExpressionStatement') return;
      // `as unknown` keeps the value honest; `as T` asserts the producer type.
      while (
        parent.type === 'TSAsExpression' ||
        parent.type === 'TSTypeAssertion'
      ) {
        if (!isUnknownType(parent.typeAnnotation)) {
          context.report({ node, messageId: 'producerCast', data: { source } });
          return;
        }
        outer = climbValue(parent);
        parent = outer.parent;
      }
      if (isSchemaCall(parent) && parent.arguments.includes(outer)) return;

      let variable = null;
      if (parent.type === 'VariableDeclarator' && parent.init === outer) {
        if (parent.id.type !== 'Identifier') {
          context.report({ node, messageId: 'unvalidated', data: { source } });
          return;
        }
        const annotation = parent.id.typeAnnotation?.typeAnnotation;
        if (annotation && !isUnknownType(annotation)) {
          context.report({ node, messageId: 'producerCast', data: { source } });
          return;
        }
        [variable] = context.sourceCode.getDeclaredVariables(parent);
      } else if (
        // Any operator: `x += parse(t)` also reads `x` there, a read no
        // schema call takes, so a compound assignment is never validated.
        parent.type === 'AssignmentExpression' &&
        parent.right === outer &&
        parent.left.type === 'Identifier'
      ) {
        variable = variableOf(context, parent.left);
      }
      if (variable) {
        const reads = readsOf(variable);
        const validated =
          reads.length > 0 &&
          reads.every(reference => {
            const use = climbValue(reference.identifier);
            return (
              isSchemaCall(use.parent) && use.parent.arguments.includes(use)
            );
          });
        if (validated) return;
      }
      context.report({ node, messageId: 'unvalidated', data: { source } });
    };

    return {
      ImportDeclaration(node) {
        if (!YAML_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ImportDefaultSpecifier' ||
            specifier.type === 'ImportNamespaceSpecifier'
          ) {
            yamlNamespaces.add(specifier.local.name);
          } else if (
            specifier.imported.type === 'Identifier' &&
            ['load', 'parse', 'loadAll'].includes(specifier.imported.name)
          ) {
            yamlFunctions.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        const source = sourceOf(node);
        if (source) judge(node, source);
      },
    };
  },
};

export default schemaParseUntrusted;
