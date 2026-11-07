/**
 * CONTRACT-03 `dto-implements-contract`: server DTOs implement
 * their shared contract type.
 * Registered by ./index.js; ./configs.js mounts it under a plugin namespace.
 *
 * A heuristic over the AST (plus the type checker where one is configured).
 * It states below what it deliberately does NOT claim, because
 * a codebase that bans `eslint-disable` gives a rule that fires on correct
 * code no escape hatch except a suppression count.
 */

import { CONTRACTS_PACKAGE_SCHEMA, packagePattern } from './helpers.js';

/** Server DTO classes: the wire shape the server validates or returns. */
const DTO_CLASS = /(?:Dto|DTO)$/;

/** Root identifier of an `implements` entry (`A`, `A<T>`, `ns.A`). */
function implementedRoot(heritage) {
  let expression = heritage.expression;
  while (expression?.type === 'MemberExpression')
    expression = expression.object;
  return expression?.type === 'Identifier' ? expression.name : null;
}

const dtoImplementsContract = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Server DTO classes implement their request/response contract from the shared contracts package',
    },
    // `contractsPackage` is required: without it no import can be the shared
    // contract, and every DTO would be reported.
    schema: [
      {
        type: 'object',
        properties: { contractsPackage: CONTRACTS_PACKAGE_SCHEMA },
        required: ['contractsPackage'],
        additionalProperties: false,
      },
    ],
    messages: {
      missingContract:
        '`{{name}}` implements no contract type from {{contracts}}, so the server can change this wire shape without the web or mobile client noticing (CONTRACT-03). Declare the shape in {{contracts}} and write `implements` with it.',
    },
  },
  create(context) {
    const contracts = context.options[0].contractsPackage;
    /** The contracts package and any of its subpath exports. */
    const sharedPackage = packagePattern(contracts);
    // Imports hoist, so classes are judged once the whole module is read.
    const shared = new Set();
    const classes = [];
    return {
      ImportDeclaration(node) {
        if (!sharedPackage.test(String(node.source.value))) return;
        for (const specifier of node.specifiers) {
          shared.add(specifier.local.name);
        }
      },
      ClassDeclaration(node) {
        if (node.id && DTO_CLASS.test(node.id.name)) classes.push(node);
      },
      'Program:exit'() {
        for (const node of classes) {
          const implemented = (node.implements ?? []).map(implementedRoot);
          if (implemented.some(root => root !== null && shared.has(root))) {
            continue;
          }
          context.report({
            node: node.id,
            messageId: 'missingContract',
            data: { name: node.id.name, contracts },
          });
        }
      },
    };
  },
};

export default dtoImplementsContract;
