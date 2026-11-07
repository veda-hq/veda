/**
 * CONTRACT-03 `no-capability-literal`: web names capabilities
 * through the shared vocabulary, never as strings.
 * Registered by ./index.js; ./configs.js mounts it under a plugin namespace.
 *
 * A heuristic over the AST (plus the type checker where one is configured).
 * It states below what it deliberately does NOT claim, because
 * a codebase that bans `eslint-disable` gives a rule that fires on correct
 * code no escape hatch except a suppression count.
 */

import { readFileSync } from 'node:fs';

import { CONTRACTS_PACKAGE_SCHEMA, contractsLabel } from './helpers.js';

/** Identifier shape of the vocabulary object and the route map options. */
const IDENTIFIER_PATH =
  '^[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*$';

/** Capability tokens declared in the shared vocabulary module. */
export function readCapabilityVocabulary(file) {
  const text = readFileSync(file, 'utf8');
  const tokens = [
    ...text.matchAll(/^\s+([A-Z][A-Z0-9_]*): '([A-Z][A-Z0-9_]*)',$/gm),
  ].map(match => match[2]);
  if (tokens.length === 0) {
    throw new Error(`no capability tokens found in ${file}`);
  }
  return tokens;
}

const noCapabilityLiteral = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Capability tokens come from the shared vocabulary, not string literals',
    },
    schema: [
      {
        type: 'object',
        properties: {
          capabilities: { type: 'array', items: { type: 'string' } },
          // The rest only shape the remedy the message names: the object the
          // vocabulary is read through (`Capability.X`, the default), a
          // route-to-capability map when the app keeps one, and the package
          // both come from.
          vocabulary: { type: 'string', pattern: IDENTIFIER_PATH },
          routeMap: { type: 'string', pattern: IDENTIFIER_PATH },
          contractsPackage: CONTRACTS_PACKAGE_SCHEMA,
        },
        required: ['capabilities'],
        additionalProperties: false,
      },
    ],
    messages: {
      capabilityLiteral:
        "'{{value}}' is a capability written as a string, so renaming or removing it on the server leaves this gate silently wrong (CONTRACT-03). Use `{{vocabulary}}.{{value}}`{{routeMap}} from {{contracts}}.",
    },
  },
  create(context) {
    const options = context.options[0];
    const tokens = new Set(options?.capabilities ?? []);
    const remedy = {
      vocabulary: options?.vocabulary ?? 'Capability',
      routeMap: options?.routeMap
        ? ` or the route's \`${options.routeMap}\` entry`
        : '',
      contracts: contractsLabel(options),
    };
    function check(node, value) {
      if (typeof value !== 'string' || !tokens.has(value)) return;
      context.report({
        node,
        messageId: 'capabilityLiteral',
        data: { value, ...remedy },
      });
    }
    return {
      Literal(node) {
        if (node.parent?.type === 'ImportDeclaration') return;
        check(node, node.value);
      },
      TemplateLiteral(node) {
        if (node.expressions.length > 0) return;
        check(node, node.quasis[0]?.value.cooked);
      },
    };
  },
};

export default noCapabilityLiteral;
