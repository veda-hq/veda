/** ESTree, scope and type readers shared by two or more input-parsing rules. */

/** Wrappers that do not change which value an expression denotes. */
export const TRANSPARENT = new Set([
  'ChainExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
]);

/**
 * Climb out of value-preserving wrappers to the outermost equivalent node:
 * TRANSPARENT ones and type assertions, which keep the runtime value too.
 * Assertions stay out of TRANSPARENT: schema-parse-untrusted judges them.
 */
export function climb(node) {
  let current = node;
  while (
    current.parent &&
    (TRANSPARENT.has(current.parent.type) ||
      current.parent.type === 'TSAsExpression' ||
      current.parent.type === 'TSTypeAssertion')
  ) {
    current = current.parent;
  }
  return current;
}

export function isIdentifier(node, name) {
  return node?.type === 'Identifier' && node.name === name;
}

/** `object.property` with a plain (non-computed) property name. */
export function isMember(node, objectName, propertyName) {
  return (
    node?.type === 'MemberExpression' &&
    !node.computed &&
    isIdentifier(node.object, objectName) &&
    node.property.type === 'Identifier' &&
    node.property.name === propertyName
  );
}

/** `process.<name>` or `globalThis.process.<name>`. */
export function isProcessMember(node, name) {
  if (node?.type !== 'MemberExpression' || node.computed) return false;
  if (node.property.type !== 'Identifier' || node.property.name !== name) {
    return false;
  }
  return (
    isIdentifier(node.object, 'process') ||
    isMember(node.object, 'globalThis', 'process')
  );
}

/** The scope variable an identifier refers to, or null. */
export function variableOf(context, identifier) {
  let scope = context.sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable;
    scope = scope.upper;
  }
  return null;
}

/** Read references of a variable, excluding the write that initialises it. */
export function readsOf(variable) {
  return variable.references.filter(reference => reference.isRead());
}

/** Type-checker access, or null when the workspace lints without types. */
export function typeServices(context) {
  const services = context.sourceCode.parserServices;
  if (!services?.program || !services.esTreeNodeToTSNodeMap) return null;
  const checker = services.program.getTypeChecker();
  return {
    typeOf: node =>
      checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node)),
  };
}

export function isNullishOrEmpty(node) {
  if (isIdentifier(node, 'undefined')) return true;
  if (node.type === 'Literal') return node.value === null || node.value === '';
  return (
    node.type === 'UnaryExpression' &&
    node.operator === 'void' &&
    node.argument.type === 'Literal'
  );
}

/** Root identifier of a call/member chain: `z` for `z.object({}).strict()`. */
export function chainRoot(node) {
  let current = node;
  for (;;) {
    if (current.type === 'CallExpression') current = current.callee;
    else if (current.type === 'MemberExpression') current = current.object;
    else if (current.type === 'ChainExpression') current = current.expression;
    else return current;
  }
}

/** The last identifier of a type name: `Foo` for `Foo` and `ns.Foo`. */
export function typeNameTail(name) {
  if (name.type === 'Identifier') return name.name;
  // A qualified name's right side is always an Identifier.
  return name.type === 'TSQualifiedName' ? name.right.name : null;
}

/**
 * The fix sentence a rule appends to one of its messages: the `hints` option
 * entry for that message. ESLint merges the rule's `meta.defaultOptions`
 * (its neutral hints) under what the caller passed, so every message id has
 * one; callers point a hint at their own helper modules.
 */
export function hintFor(context, messageId) {
  return context.options[0].hints[messageId];
}

/** JSON schema for a `hints` option over the given message ids. */
export function hintsSchema(messageIds) {
  return {
    type: 'object',
    properties: Object.fromEntries(
      messageIds.map(messageId => [messageId, { type: 'string' }]),
    ),
    additionalProperties: false,
  };
}
