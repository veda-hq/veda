/**
 * AST and Prisma helpers shared by the `nest-prisma` rules, and exported for
 * rules a consumer writes on top of them (tenant-scope rules over its own
 * schema, say).
 *
 * Every helper reads the ESTree AST only (no type information).
 */

/** Prisma write methods. A pair of these in one function wants a transaction. */
export const PRISMA_WRITES = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

/**
 * Methods that can match MORE THAN ONE ROW, and so can cross a tenant
 * boundary.
 *
 * `findUnique`, `update`, `delete` and friends are deliberately absent: Prisma
 * requires a unique `where` for those, so they already address exactly one row
 * and a tenant key adds nothing. Including them made a tenant-scope rule fire
 * on ~100 sites that were all `where: { id }` — noise that would have buried
 * the real cross-tenant reads it exists to find.
 */
export const PRISMA_MULTI_ROW = new Set([
  'findFirst',
  'findMany',
  'updateMany',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * The expression under TypeScript's type-only wrappers.
 *
 * `x as T`, `x satisfies T`, `x!` and `<T>x` evaluate to `x`, and `a?.b` to
 * `a.b`. A rule that matched the bare node read `sql as string` or
 * `this.prisma!` as something else entirely and passed it (found by an
 * adversarial lint corpus of equivalent spellings).
 */
export function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ChainExpression')
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * The name a member expression reads: `a.b` and `a['b']` alike.
 *
 * A computed member with a literal key is the same property as the dotted
 * form, so `prisma['$queryRawUnsafe']` is `$queryRawUnsafe`. A computed key
 * the AST cannot read (`a[name]`) has no name here.
 */
export function memberName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  const key = member.property;
  if (!member.computed) return key.type === 'Identifier' ? key.name : null;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0) {
    return key.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** `undefined` and `void …`: a filter value Prisma treats as absent. */
export function isUndefined(node) {
  const value = unwrap(node);
  return (
    (value?.type === 'Identifier' && value.name === 'undefined') ||
    (value?.type === 'UnaryExpression' && value.operator === 'void')
  );
}

/** Walks up to the nearest enclosing function node, or null. */
export function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * True when the node sits inside a `$transaction(...)` call or a wrapper.
 * `prisma['$transaction'](...)` is the same boundary: writes are recognised
 * through computed keys too, so the boundary has to be.
 *
 * `wrappers` names the helpers that open a transaction and hand its client to
 * a callback (or take the writes as an array and run them as one
 * `$transaction`). A write inside one of these is transacted exactly as a
 * write inside a bare `$transaction` is. Without the list a rule reads the
 * callback as untransacted and pushes the author towards a NESTED
 * `$transaction`, which is the opposite of what it wants.
 */
export function insideTransaction(node, wrappers = new Set()) {
  let current = node.parent;
  while (current) {
    if (current.type === 'CallExpression') {
      const { callee } = current;
      if (memberName(unwrap(callee)) === '$transaction') {
        return true;
      }
      if (callee.type === 'Identifier' && wrappers.has(callee.name)) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

/**
 * Roots that actually denote a Prisma client.
 *
 * Without this, `prismaCall` accepted ANY `a.b.method()` — so a function with
 * two `this.cache.create()` or `this.mailer.delete()` calls was reported as
 * needing `prisma.$transaction`. The rule only ever filtered on the METHOD
 * name, and those are ordinary English verbs.
 */
const PRISMA_ROOTS = new Set(['db', 'tx', 'trx', 'transaction']);

/**
 * Any name containing "prisma" counts — `prisma`, `prismaService`,
 * `prismaClient`, `_prisma`. This is what makes PRISMA_ROOTS above a list of
 * the names that DON'T say prisma (`db`, `tx`), rather than the whole
 * allowlist. A bare allowlist fails OPEN: a service injecting its client under
 * an unlisted name would drop out of a multi-tenant leak guard silently, with
 * no warning, which is the one failure mode these rules exist to prevent.
 */
const PRISMA_NAMED = /prisma/i;

/**
 * Is `node` a reference to the Prisma client?
 *
 * Three accepted shapes, each narrowed for a reason recorded below the
 * corresponding branch: a bare identifier (`prisma`, `tx`), a `this.` member
 * (`this.prismaService`), and a call whose callee is itself one of those
 * (`getPrismaClient()`). Anything else is not treated as the client.
 */
export function isPrismaRoot(input) {
  // Always a node: callers pass a member's object or a call's callee.
  const node = unwrap(input);
  const named = name => PRISMA_ROOTS.has(name) || PRISMA_NAMED.test(name);
  if (node.type === 'Identifier') return named(node.name);
  // `this.prisma` / `this.prismaService` — the injected-client shape. Restricted
  // to a `this.` receiver on purpose: accepting ANY `x.prisma` chain meant an
  // unrelated object that merely holds a `.prisma` field pulled its writes into
  // the transaction rule and reported them.
  if (
    node.type === 'MemberExpression' &&
    node.object.type === 'ThisExpression' &&
    memberName(node) !== null
  ) {
    return named(memberName(node));
  }
  // A call-expression root counts only when the CALLEE is named for Prisma:
  // `getPrismaClient().order.create()` qualifies, `repository().create()` does
  // not. Both extremes were wrong. Assuming every call root was Prisma reported
  // ordinary factory pairs as untransacted multi-writes; assuming none was
  // exempted a DI/factory-obtained client from tenant-scope rules entirely.
  // Keying on the name draws the line where the evidence actually is.
  if (node.type === 'CallExpression') return isPrismaRoot(node.callee);

  return false;
}

/**
 * `x = prisma.someModel` → 'someModel', else null: a delegate held in a local.
 *
 * `const products = this.prisma.product; products.findMany()` is the same
 * query as the inline form, and reading only the inline form let the alias
 * through (found by an adversarial lint corpus).
 */
export function prismaDelegate(init) {
  const target = unwrap(init);
  // memberName is null for anything but a member (or no node at all), so a
  // non-null name also proves `target.object` exists.
  const delegate = memberName(target);
  if (delegate === null || delegate.startsWith('$')) return null;
  return isPrismaRoot(target.object) ? delegate : null;
}

/**
 * Values held by local variables, keyed by the variable's lexical binding
 * rather than its name: an alias declared in one function says nothing about
 * a same-named variable in another, and two functions' aliases cannot
 * overwrite each other.
 */
export function bindings(context) {
  const values = new Map();
  const sourceCode = context.sourceCode;
  // Only an Identifier names a variable: a pattern (`const [a] = x`,
  // `const { a } = x`) has no `name`, finds no variable and binds nothing.
  const variableOf = identifier => {
    let scope = sourceCode.getScope(identifier);
    while (scope) {
      const variable = scope.set.get(identifier.name);
      if (variable) return variable;
      scope = scope.upper;
    }
    return null;
  };
  return {
    bind(identifier, value) {
      const variable = variableOf(identifier);
      // A variable assigned again after its declaration may hold anything
      // at a later call (`let p = prisma.product; p = cached;`), and a
      // flow-insensitive rule cannot tell which value reaches it, so only a
      // binding its declaration alone writes is an alias.
      const reassigned = variable?.references.some(
        reference => reference.isWrite() && !reference.init,
      );
      if (variable && !reassigned) values.set(variable, value);
    },
    lookup(node) {
      if (node?.type !== 'Identifier') return undefined;
      const variable = variableOf(node);
      return variable ? values.get(variable) : undefined;
    },
  };
}

/** A bindings stand-in that holds nothing. */
export const NO_BINDINGS = { lookup: () => undefined };

/**
 * `prisma.someModel.someMethod(...)` → { delegate, method } or null.
 *
 * `aliases` (bindings) holds the delegate each local was bound to (prismaDelegate).
 * Computed members with literal keys and TypeScript wrappers read as the
 * plain form: `this.prisma['product']['findMany']` and
 * `(this.prisma as PrismaClient).product.findMany` are the same call.
 */
export function prismaCall(node, aliases = NO_BINDINGS) {
  if (node.type !== 'CallExpression') return null;
  const callee = unwrap(node.callee);
  const method = memberName(callee);
  if (method === null) return null;
  const target = unwrap(callee.object);
  const aliased = aliases.lookup(target);
  if (aliased !== undefined) return { delegate: aliased, method };
  // The delegate's OWN object has to be the client. `this.prisma.order.create`
  // qualifies; `this.cache.order.create` does not.
  const delegate = prismaDelegate(target);
  return delegate === null ? null : { delegate, method };
}

/**
 * Collects `const x = prisma.model` aliases into `aliases` as they are
 * declared. A declarator without an init has no delegate, and one whose id is
 * a pattern binds nothing (bindings).
 */
export function trackDelegateAlias(aliases, node) {
  const delegate = prismaDelegate(node.init);
  if (delegate !== null) aliases.bind(node.id, delegate);
}

/**
 * The name a property (or destructuring entry) really has, or null when it is
 * computed from a value: `{ [key]: v }` names whatever `key` holds, not "key".
 */
export function propertyName(p) {
  if (p.computed) return p.key.type === 'Literal' ? p.key.value : null;
  return p.key.type === 'Identifier' ? p.key.name : p.key.value;
}

/** Finds a top-level property by name in an object expression. */
export function property(objectExpression, name) {
  return (
    objectExpression.properties.find(
      p => p.type === 'Property' && propertyName(p) === name,
    ) ?? null
  );
}

/**
 * What a spread in a `where` holds, when the rule can read it: an object
 * literal written in place, or a `const` in this file initialised with one.
 * Anything else (a parameter, a call, a reassigned `let`) is null.
 *
 * A spread the rule cannot read must not pass a scope check: it used to pass
 * on the grounds that it might carry the key, which let `where: { ...filters }`
 * through on every scoped model.
 */
export function spreadObject(spread, resolve) {
  const value = unwrap(resolve(unwrap(spread.argument)));
  return value?.type === 'ObjectExpression' ? value : null;
}

/**
 * The value a local `const` was declared with, followed through further
 * `const`s, or the node itself. `values` holds the declarations (bindings).
 */
export function valueResolver(values) {
  return function resolve(node, seen = new Set()) {
    const value = unwrap(node);
    if (value?.type !== 'Identifier' || seen.has(value)) return value;
    const bound = values.lookup(value);
    if (bound === undefined) return value;
    seen.add(value);
    return resolve(bound, seen);
  };
}

/**
 * Collects `const x = <expression>` declarations into `values`, for
 * {@link valueResolver}. A `let` reassigned later binds nothing (bindings).
 */
export function trackValue(values, node) {
  // A pattern binds nothing (bindings), and `let x;` binds null, which
  // reads as no value wherever it is used.
  values.bind(node.id, node.init);
}
