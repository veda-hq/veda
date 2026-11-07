/**
 * CONTRACT-03 `no-local-api-contract`: request/response shapes
 * come from one shared contracts package, not a local redeclaration.
 * Registered by ./index.js; ./configs.js mounts it under a plugin namespace.
 *
 * A heuristic over the AST (plus the type checker where one is configured).
 * It states below what it deliberately does NOT claim, because
 * a codebase that bans `eslint-disable` gives a rule that fires on correct
 * code no escape hatch except a suppression count.
 */

import { CONTRACTS_PACKAGE_SCHEMA, contractsLabel } from './helpers.js';

/** Names that declare an HTTP request or response shape. */
const CONTRACT_NAME = /(?:Payload|Response|Request|Dto|DTO)$/;
/** API-client modules: every object shape declared here is a wire contract. */
const API_CLIENT_FILE = /\/(?:api\/[^/]+|api|[A-Za-z]*Api)\.tsx?$/;
/** Modules whose declarations face the wire: api clients, services, controllers, DTOs. */
const BOUNDARY_FILE =
  /\/(?:api|services?)\/|(?:\.service|\.controller|\.dto|Service|Api|\/api)\.tsx?$/;

/** Is a type annotation an object shape (literal, or an intersection with one)? */
function objectShaped(node) {
  if (node.type === 'TSTypeLiteral') return true;
  if (node.type === 'TSIntersectionType') return node.types.some(objectShaped);
  return false;
}

const noLocalApiContract = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Request/response contracts come from the shared contracts package, not a local redeclaration',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' } },
          // Only named in the messages: the rule reads no import.
          contractsPackage: CONTRACTS_PACKAGE_SCHEMA,
        },
        additionalProperties: false,
      },
    ],
    messages: {
      clientContract:
        '`{{name}}` redeclares a wire shape inside an API client. A local copy drifts from the server (client_id vs id, camelCase vs snake_case: CONTRACT-03). Import the contract from {{contracts}}.',
      namedContract:
        '`{{name}}` is a locally declared request/response contract. Server, web and mobile drift when each keeps its own copy (CONTRACT-03). Declare it once in {{contracts}} and import it.',
    },
  },
  create(context) {
    const filename = context.filename.split('\\').join('/');
    const allow = context.options[0]?.allow ?? [];
    const contracts = contractsLabel(context.options[0]);
    if (allow.some(path => filename.endsWith(path))) return {};
    const apiClient = API_CLIENT_FILE.test(filename);
    const boundary = apiClient || BOUNDARY_FILE.test(filename);
    if (!boundary) return {};

    // An interface is always a shape; a type alias is one when objectShaped.
    function check(node, shape) {
      if (!shape) return;
      const name = node.id.name;
      if (apiClient) {
        context.report({
          node: node.id,
          messageId: 'clientContract',
          data: { name, contracts },
        });
        return;
      }
      if (CONTRACT_NAME.test(name)) {
        context.report({
          node: node.id,
          messageId: 'namedContract',
          data: { name, contracts },
        });
      }
    }

    return {
      TSInterfaceDeclaration(node) {
        check(node, true);
      },
      TSTypeAliasDeclaration(node) {
        check(node, objectShaped(node.typeAnnotation));
      },
    };
  },
};

export default noLocalApiContract;
