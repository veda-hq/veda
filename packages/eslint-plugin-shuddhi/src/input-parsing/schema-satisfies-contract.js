/**
 * VAL-09 (`satisfies z.ZodType<Producer>`) `schema-satisfies-contract`.
 * Replaces the banned construct with: the producer type the schema
 * checks.
 * Registered by ./index.js.
 */

import { isIdentifier, chainRoot, typeNameTail } from './helpers.js';

//
// MATCHING HEURISTIC. A module-level `const <name>Schema = z…` (or
// `<Name>Schema`) describes the contract type `<Name>` (first letter upper-
// cased) when a type alias or interface of that name is declared in the same
// module, or imported into it. Such a schema must be declared
// `satisfies z.ZodType<…>` (or annotated `: z.ZodType<…>`, which recursive
// `z.lazy` schemas need) so the compiler fails when the schema and the
// producer type drift. A type DERIVED from the schema (`z.infer` / `z.input`
// / `z.output` of it) is not a second source of truth and needs nothing.
// Exported schemas only: a module-private schema has no consumer that could
// trust it in place of the type. Not claimed: a contract type whose name does
// not follow the schema's (`consequenceSchema` for `GuardrailConsequence`).

const ZOD_TYPE_NAMES = new Set([
  'ZodType',
  'ZodSchema',
  'Schema',
  'ZodTypeAny',
]);
const ZOD_DERIVATIONS = new Set(['infer', 'input', 'output', 'TypeOf']);

/**
 * `z.ZodType<TypeName>` / `ZodType<TypeName>`: a zod schema type tied to the
 * contract type itself. `ZodTypeAny` or `ZodType<Other>` ties it to nothing,
 * so the schema and the type could still drift.
 */
function isZodTypeReference(annotation, typeName) {
  if (annotation?.type !== 'TSTypeReference') return false;
  if (!ZOD_TYPE_NAMES.has(typeNameTail(annotation.typeName))) return false;
  const [argument] = annotation.typeArguments?.params ?? [];
  // The bare name only: the contract is declared or imported here under that
  // name, so `other.Lease` is some other module's type.
  return (
    argument?.type === 'TSTypeReference' &&
    isIdentifier(argument.typeName, typeName)
  );
}

/** Is `annotation` `z.infer<typeof schemaName>` (or input/output/TypeOf)? */
function derivesFrom(annotation, schemaName) {
  if (annotation?.type !== 'TSTypeReference') return false;
  if (!ZOD_DERIVATIONS.has(typeNameTail(annotation.typeName))) return false;
  const [argument] = annotation.typeArguments?.params ?? [];
  return (
    argument?.type === 'TSTypeQuery' &&
    argument.exprName.type === 'Identifier' &&
    argument.exprName.name === schemaName
  );
}

const schemaSatisfiesContract = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Declare a zod schema that mirrors a contract type `satisfies z.ZodType<Type>`',
    },
    schema: [],
    messages: {
      missingSatisfies:
        '`{{schema}}` describes the contract type `{{type}}` but is not declared `satisfies z.ZodType<{{type}}>`, so the two can drift without a compile error (a parser once accepted records the producer never wrote). Add `satisfies z.ZodType<{{type}}>`, or derive the type with `z.infer<typeof {{schema}}>`.',
    },
  },
  create(context) {
    const zodNames = new Set();
    /** Contract type name -> its declaration annotation (null if imported). */
    const types = new Map();
    const exported = new Set();
    const candidates = [];

    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (node.source.value === 'zod') {
            zodNames.add(specifier.local.name);
          } else if (specifier.type !== 'ImportNamespaceSpecifier') {
            // Named and default imports (`import type Lease from`) bind a
            // type; a namespace binds a module.
            types.set(specifier.local.name, null);
          }
        }
      },
      TSTypeAliasDeclaration(node) {
        types.set(node.id.name, node.typeAnnotation);
      },
      TSInterfaceDeclaration(node) {
        types.set(node.id.name, null);
      },
      ExportSpecifier(node) {
        if (node.local.type === 'Identifier') exported.add(node.local.name);
      },
      // `export default leaseSchema`. Among declarations only an Identifier
      // carries a `name`; any other adds undefined, which names no schema.
      ExportDefaultDeclaration(node) {
        exported.add(node.declaration.name);
      },
      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier' || !node.init) return;
        const declaration = node.parent;
        if (
          declaration.type !== 'VariableDeclaration' ||
          declaration.kind !== 'const'
        ) {
          return;
        }
        const scopeOwner = declaration.parent;
        const isExported = scopeOwner.type === 'ExportNamedDeclaration';
        if (!isExported && scopeOwner.type !== 'Program') return;
        candidates.push({ node, isExported });
      },
      'Program:exit'() {
        for (const { node, isExported } of candidates) {
          const name = node.id.name;
          if (!isExported && !exported.has(name)) continue;
          const match = /^(\w+?)Schema$/.exec(name);
          if (!match) continue;
          const typeName = match[1][0].toUpperCase() + match[1].slice(1);
          if (!types.has(typeName)) continue;
          if (derivesFrom(types.get(typeName), name)) continue;
          let init = node.init;
          if (
            init.type === 'TSSatisfiesExpression' &&
            isZodTypeReference(init.typeAnnotation, typeName)
          ) {
            continue;
          }
          if (
            isZodTypeReference(node.id.typeAnnotation?.typeAnnotation, typeName)
          ) {
            continue;
          }
          while (
            init.type === 'TSAsExpression' ||
            init.type === 'TSSatisfiesExpression'
          ) {
            init = init.expression;
          }
          const root = chainRoot(init);
          const isZod =
            root.type === 'Identifier' &&
            (zodNames.has(root.name) || root.name === 'z');
          if (!isZod) continue;
          context.report({
            node: node.id,
            messageId: 'missingSatisfies',
            data: { schema: name, type: typeName },
          });
        }
      },
    };
  },
};

export default schemaSatisfiesContract;
