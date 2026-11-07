/** Decorator and property-key readers shared by the server-boundary rules. */

/** The bare name of a decorator: `@IsString()` and `@cv.IsString()` → `IsString`. */
export function decoratorName(decorator) {
  let expression = decorator.expression;
  if (expression.type === 'CallExpression') expression = expression.callee;
  if (expression.type === 'Identifier') return expression.name;
  if (
    expression.type === 'MemberExpression' &&
    expression.property.type === 'Identifier'
  ) {
    return expression.property.name;
  }
  return null;
}

/** Names of every decorator on a node, as a Set. */
export function decoratorNames(node) {
  const names = new Set();
  for (const decorator of node.decorators ?? []) {
    const name = decoratorName(decorator);
    if (name !== null) names.add(name);
  }
  return names;
}

/** A property key as a string, or null when it is computed. */
export function keyName(key) {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

/**
 * The `contractsPackage` option: the module specifier of the package that
 * holds the request/response contracts every app shares (`@acme/shared`).
 */
export const CONTRACTS_PACKAGE_SCHEMA = { type: 'string', minLength: 1 };

/** How a message names the contracts package when no option names it. */
export const DEFAULT_CONTRACTS_LABEL = 'the shared contracts package';

/** The contracts package as a message names it: the option, or a description. */
export function contractsLabel(options) {
  return options?.contractsPackage ?? DEFAULT_CONTRACTS_LABEL;
}

/** A module specifier and any of its subpath exports, as a RegExp. */
export function packagePattern(specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:/|$)`);
}
