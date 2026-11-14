/**
 * Arid-node suppression — the ONLY sanctioned way a mutant goes unreported.
 *
 * The gate is meant for a repository that bans `// Stryker disable` in its
 * mutated source trees (with a lint rule, say) and refuses an environment that
 * weakens the gate. A developer facing a surviving mutant then has exactly one
 * move: write a test that kills it.
 *
 * That rule is only honest if every mutant it reports is actually killable.
 * Some are not. Deciding mutant equivalence is provably UNDECIDABLE, and
 * published studies put equivalent mutants at 4–39% of all mutants, so a gate
 * that admits no exception at all eventually blocks a push that no test can
 * unblock.
 *
 * This module is where that exception lives — modelled on Google's "arid
 * nodes" (Petrović & Ivanković, *Practical Mutation Testing at Scale*, TSE
 * 2021), where nodes known to yield unproductive mutants are labelled BEFORE
 * mutants are generated, so the mutant is never created, never run and never
 * reported. Their arid categories are things like `Runtime.KeepAlive`, debug
 * logging, and "operators on time-and-count expressions that are positive and
 * nonsensical if negated".
 *
 * WHY A PLUGIN AND NOT A COMMENT. A `// Stryker disable` is per-instance,
 * written in the source by whoever is blocked, at the moment they want to move
 * on. This list is central, reviewed, and tested. The exception is a policy
 * artifact — like the mutator set — not a decision a developer makes alone
 * under deadline.
 *
 * THE RISK THIS CARRIES, STATED PLAINLY. An over-broad pattern silently stops
 * mutants being generated, and unlike a comment there is nothing at the call
 * site to notice. Google could afford broad heuristics because thousands of
 * engineers across a thousand projects observed the consequences; a single
 * repository has no such feedback loop. So every pattern here MUST ship with a
 * NEGATIVE CONTROL in its tests: a test proving it ignores the arid case AND
 * still mutates a near-identical case that is genuinely killable. A pattern
 * without one is the exact failure this gate exists to prevent.
 *
 * CONSIDERED AND REJECTED: a `useState` initialiser pattern.
 *
 * The obvious next candidate was "a boolean literal that is the sole argument
 * of `useState`" — the initial value of a state an effect overwrites on mount
 * is unobservable, and one such mutant once blocked a push.
 *
 * It was rejected because it is not narrow enough to be safe. The predicate
 * available at a single NodePath cannot tell "an initial value an effect
 * immediately overwrites" from "an initial value that IS the behaviour" — a
 * modal that starts open, a feature flag defaulting on, a form that starts
 * dirty. The rule would have ignored every `useState(true|false)` in the
 * repository to save one line, which is precisely the over-broad suppression
 * this module's negative-control rule exists to prevent.
 *
 * The case was fixed in the SOURCE instead: the component was split so a
 * `key` resets state when its input changes, which made the initial value the
 * sole owner of the loading state and the mutant killable by an ordinary test.
 * That is the preferred resolution order — remove the redundancy, then
 * consider ignoring — and it is why this list stays short: the effect-cleanup
 * flag and the two presentation-literal shapes. A repository with arid nodes
 * of its own lists its own ignorer beside this one; Stryker skips a node when
 * any configured ignorer says to.
 *
 * Ignoring a node ignores its ENTIRE SUBTREE (see `IgnorerBookkeeper`), so
 * every predicate targets the narrowest node that expresses the pattern — the
 * literal itself, never the statement or the function containing it.
 *
 * WHY .mjs AND NOT .ts. Stryker loads ignore-plugins in its OWN process, which
 * may have no TypeScript loader, so this ships as plain JavaScript.
 */

/** Reasons are reported by Stryker on the ignored mutant, so they are read. */
export const EFFECT_CLEANUP_FLAG_REASON =
  'Arid node: a boolean flag assigned in an effect-cleanup closure. Mutating it ' +
  'changes no observable behaviour — the guard only prevents a state update on an ' +
  'already-unmounted component, which React makes a silent no-op — so no test can ' +
  'distinguish the mutant from the original.';

/** Assignment operators that can express a flag being set. */
const ASSIGNMENT = '=';

/** The hooks whose returned function React calls as a cleanup. */
const EFFECT_HOOKS = Object.freeze(['useEffect', 'useLayoutEffect']);

/** The only object whose `.useEffect` is React's. */
const REACT_NAMESPACE = 'React';

/** The module a genuine React namespace import comes from. */
const REACT_MODULE = 'react';

/** Declaration kinds a cancellation flag can have. A param is not one. */
const FLAG_BINDING_KINDS = Object.freeze(['let', 'var']);

/** Walk up `depth` parents, or null if the chain ends first. */
function ancestor(path, depth) {
  let current = path;
  for (let i = 0; i < depth; i += 1) {
    current = current?.parentPath ?? null;
    if (!current) return null;
  }
  return current;
}

/** Is this node a function of either syntactic form? */
function isFunctionNode(node) {
  return (
    node?.type === 'ArrowFunctionExpression' ||
    node?.type === 'FunctionExpression'
  );
}

/** Is `path` inside `container` (or the container itself)? */
function isWithin(path, container) {
  let cursor = path;
  while (cursor) {
    if (cursor.node === container.node) return true;
    cursor = cursor.parentPath ?? null;
  }
  return false;
}

/**
 * Is this callee an effect hook — `useEffect(...)` or `React.useEffect(...)`?
 *
 * A member call is accepted ONLY on the React namespace. Matching any object
 * with a `.useEffect` property would suppress cleanup assignments in unrelated
 * libraries that happen to share the name, whose semantics we know nothing
 * about, on the strength of a coincidence.
 */
function isEffectHookCallee(callee, path) {
  if (callee?.type === 'Identifier') {
    return EFFECT_HOOKS.includes(callee.name);
  }
  if (callee?.type === 'MemberExpression' && callee.computed !== true) {
    if (
      callee.object?.type !== 'Identifier' ||
      callee.object.name !== REACT_NAMESPACE ||
      callee.property?.type !== 'Identifier' ||
      !EFFECT_HOOKS.includes(callee.property.name)
    ) {
      return false;
    }
    // The NAME `React` is not enough. A local `const React = {...}` with a
    // `useEffect` method would otherwise have its cleanups suppressed on the
    // strength of a shared identifier. The binding must come from the `react`
    // module itself; a binding that cannot be resolved suppresses nothing.
    return isReactModuleBinding(callee.object.name, path);
  }
  return false;
}

/** Does `name` resolve to an import from the `react` module? */
function isReactModuleBinding(name, path) {
  const binding = path?.scope?.getBinding?.(name);
  if (!binding) return false;

  const declaration = binding.path?.parent;
  if (declaration?.type !== 'ImportDeclaration') return false;
  return declaration.source?.value === REACT_MODULE;
}

/**
 * Is `path` a boolean literal assigned to a bare identifier inside a function
 * that an effect hook's callback RETURNS — i.e. React's cleanup closure?
 *
 * The shape matched, and nothing wider:
 *
 *   useEffect(() => {
 *     let cancelled = false;      // NOT matched — ordinary initialisation
 *     doWork().then(() => { if (cancelled) return; });
 *     return () => {
 *       cancelled = true;         // matched: the cleanup flag
 *     };
 *   }, []);
 *
 * Every one of the following is deliberately NOT matched, and each has a
 * negative control in the test file:
 *   • the same assignment outside any effect;
 *   • a boolean argument in a cleanup closure (`setLoading(true)`) — that IS
 *     observable, so it must stay killable;
 *   • an initialiser inside the effect body rather than the cleanup;
 *   • a cleanup returned from a non-effect call.
 */
export function isEffectCleanupFlagLiteral(path) {
  if (path.isBooleanLiteral?.() !== true) return false;

  // The literal must be the right-hand side of `<identifier> = <literal>`.
  const assignment = path.parentPath;
  const assignmentNode = assignment?.node;
  if (
    assignmentNode?.type !== 'AssignmentExpression' ||
    assignmentNode.operator !== ASSIGNMENT ||
    assignmentNode.left?.type !== 'Identifier'
  ) {
    return false;
  }

  // Climb to the nearest enclosing function. That function must be RETURNED,
  // which is what makes it a cleanup rather than ordinary effect body code.
  let cursor = assignment ?? null;
  let enclosingFunction = null;
  while (cursor) {
    if (isFunctionNode(cursor.node)) {
      enclosingFunction = cursor;
      break;
    }
    cursor = cursor.parentPath ?? null;
  }
  if (!enclosingFunction) return false;
  if (enclosingFunction.parent?.type !== 'ReturnStatement') return false;

  // ...and the function containing that `return` must be an effect callback,
  // so a cleanup-shaped closure returned from anything else stays mutable.
  let outer = enclosingFunction.parentPath ?? null;
  while (outer) {
    if (isFunctionNode(outer.node)) break;
    outer = outer.parentPath ?? null;
  }
  if (!outer) return false;

  const call = outer.parentPath;
  const callNode = call?.node;
  if (callNode?.type !== 'CallExpression') return false;
  if (!isEffectHookCallee(callNode.callee, call)) return false;

  // Finally — and this is the difference between "a cancellation guard" and
  // "any boolean an effect happens to assign on the way out" — the flag must
  // be DECLARED INSIDE the effect callback.
  //
  // Locality is what makes the mutation unobservable. A `let cancelled` living
  // in the effect dies with it, and nothing outside can ever read either
  // value. A flag declared in the component body, a module-level variable, or
  // a captured parameter outlives the cleanup, so something CAN observe which
  // value was written, and such a mutant must stay killable. Without this
  // check the predicate suppressed all three.
  const binding = assignment.scope?.getBinding?.(assignmentNode.left.name);
  if (!binding) return false; // Unresolvable: never suppress on a guess.
  if (!FLAG_BINDING_KINDS.includes(binding.kind)) return false;
  if (!binding.path || !isWithin(binding.path, outer)) return false;

  return true;
}

/**
 * PRESENTATION LITERALS.
 *
 * A StringLiteral mutant of a CSS value (`padding: '0.5rem'` → `padding: ''`)
 * changes how a screen looks and nothing it does. The only test that kills it
 * pins the exact padding or hex colour, which good tests avoid: they pin
 * behaviour a user sees, not markup. Stryker already skips a string
 * written straight into a JSX attribute (`className="p-4"`), so Tailwind pages
 * never meet this; a page styled with `style={{ ... }}` meets one mutant per
 * value.
 *
 * Two shapes, each its own predicate and reason. When they were introduced, a
 * page styled this way saw its survivors fall from 130 to 2 while its killed
 * count held, so nothing a test catches was hidden. A file that grows the
 * ignored count is worth a look.
 */
export const INLINE_STYLE_VALUE_REASON =
  'Arid node: a constant value inside a JSX `style={{ ... }}` object. Mutating ' +
  'it changes only how the element looks; the one test that could kill it ' +
  'pins a CSS value, which tests must not do.';

export const COLOUR_TABLE_REASON =
  'Arid node: a CSS colour literal under a colour-named key in an object ' +
  'literal (a badge or tone table). Mutating it changes only a colour; the one ' +
  'test that could kill it pins a hex value, which tests must not do.';

/** Wrappers that change a node's static type and nothing about its value. */
const TYPE_WRAPPERS = Object.freeze([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
  'ParenthesizedExpression',
]);

/** The one JSX attribute whose object is presentation by definition. */
const STYLE_ATTRIBUTE = 'style';

/**
 * Style values that are BEHAVIOUR, not looks: they decide whether an element
 * is on screen or can be clicked. Mutating `display: 'none'` to `''` shows a
 * hidden element, which a test can and should catch, so these stay mutable.
 * Other values under the same keys (`display: 'flex'`) only change layout.
 */
const HIDING_VALUES = Object.freeze({
  display: ['none'],
  visibility: ['hidden', 'collapse'],
  pointerEvents: ['none'],
});

/** Is this literal a value that hides an element or disables its input? */
function isHidingValue(keyName, value) {
  return Object.hasOwn(HIDING_VALUES, keyName)
    ? HIDING_VALUES[keyName].includes(value)
    : false;
}

/** The name of a non-computed property key, or null. */
function propertyKeyName(property) {
  const { key } = property.node;
  if (key?.type === 'Identifier') return key.name;
  if (key?.type === 'StringLiteral') return key.value;
  return null;
}

/** The constant text of a string literal or hole-free template. */
function constantStringValue(node) {
  return node.type === 'StringLiteral'
    ? node.value
    : node.quasis[0].value.cooked;
}

/**
 * Keys that name a colour in CSS, React Native and common map libraries.
 * Deliberately NOT `color` alone matched on any value: a product domain may
 * have colours too (a "Gold" variant), so the value must ALSO be colour-shaped.
 */
const COLOUR_KEYS = Object.freeze([
  'color',
  'bg',
  'background',
  'backgroundColor',
  'border',
  'borderColor',
  'fill',
  'fillColor',
  'stroke',
  'text',
  'textColor',
]);

/**
 * A CSS colour VALUE: #rgb, #rrggbb, #rrggbbaa, rgb()/rgba(), hsl()/hsla().
 * Four-digit `#rgba` is left out on purpose: `#1001` reads as an order number.
 */
const COLOUR_VALUE =
  /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i;

/** Is this node a string constant — a literal, or a template with no holes? */
function isConstantString(node) {
  return (
    node?.type === 'StringLiteral' ||
    (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
  );
}

/** The nearest ancestor that is not a type wrapper. */
function skipTypeWrappers(path) {
  let cursor = path?.parentPath ?? null;
  while (cursor && TYPE_WRAPPERS.includes(cursor.node?.type)) {
    cursor = cursor.parentPath ?? null;
  }
  return cursor;
}

/**
 * The ObjectProperty whose VALUE this literal is, climbing through type
 * wrappers and through the ARMS of a conditional (`busy ? '#9ca3af' : '#4f46e5'`)
 * but never its test — `status === 'DONE' ? ...` compares data, and that string
 * stays mutable. Null when the literal is anything else (a key, an argument, an
 * operand).
 */
function owningPropertyOfValue(path) {
  let child = path;
  let parent = skipTypeWrappers(child);
  while (parent?.node?.type === 'ConditionalExpression') {
    const { test } = parent.node;
    if (test === child.node || isWithin(child, { node: test })) return null;
    child = parent;
    parent = skipTypeWrappers(child);
  }
  if (parent?.node?.type !== 'ObjectProperty') return null;
  if (parent.node.computed === true) return null;
  // The literal must sit in the VALUE slot. Stryker never mutates a key, but
  // the ignorer is asked about every node, keys included.
  return isWithin(path, parent.get('value')) ? parent : null;
}

/**
 * A constant string that is a property value of the object literal written
 * directly as a JSX `style` attribute — `<div style={{ padding: '1rem' }}>`.
 *
 * NOT matched, each with a negative control:
 *   • the same object bound to a variable first (`const s = {...}`) — nothing
 *     at the literal says it is presentation;
 *   • any other attribute (`title`, `aria-label`, `placeholder`) — user text;
 *   • a template literal with a hole (`${pct}%`) — it carries data;
 *   • a value that hides an element or disables input (`display: 'none'`,
 *     `visibility: 'hidden'`, `pointerEvents: 'none'`) — that is behaviour;
 *   • a string in a conditional's TEST inside a style object;
 *   • the argument of a call inside a style value (`format('x')`).
 */
export function isInlineStyleValueLiteral(path) {
  if (!isConstantString(path?.node)) return false;
  const property = owningPropertyOfValue(path);
  if (!property) return false;
  if (
    isHidingValue(propertyKeyName(property), constantStringValue(path.node))
  ) {
    return false;
  }

  const object = property.parentPath;
  if (object?.node?.type !== 'ObjectExpression') return false;
  const container = skipTypeWrappers(object);
  if (container?.node?.type !== 'JSXExpressionContainer') return false;
  const attribute = container.parentPath?.node;
  return (
    attribute?.type === 'JSXAttribute' &&
    attribute.name?.type === 'JSXIdentifier' &&
    attribute.name.name === STYLE_ATTRIBUTE
  );
}

/**
 * A CSS colour VALUE under a colour-NAMED key of any object literal —
 * `{ label: 'Upload', color: '#b45309', bg: '#fef3c7' }`. Both halves are
 * required: a colour-shaped value under `label` stays mutable, and a
 * non-colour value under `color` (a product's 'Gold') stays mutable.
 */
export function isColourTableLiteral(path) {
  if (path?.node?.type !== 'StringLiteral') return false;
  if (!COLOUR_VALUE.test(path.node.value)) return false;
  const property = owningPropertyOfValue(path);
  if (!property) return false;
  const keyName = propertyKeyName(property);
  return keyName !== null && COLOUR_KEYS.includes(keyName);
}

/**
 * The ignorer Stryker loads. One method, one list — adding a pattern means
 * adding a predicate here AND its negative control in the test file.
 */
export class AridNodeIgnorer {
  shouldIgnore(path) {
    if (isEffectCleanupFlagLiteral(path)) return EFFECT_CLEANUP_FLAG_REASON;
    if (isInlineStyleValueLiteral(path)) return INLINE_STYLE_VALUE_REASON;
    if (isColourTableLiteral(path)) return COLOUR_TABLE_REASON;
    return undefined;
  }
}

/** The name used in each Stryker config's `ignorers` array. */
export const ARID_NODE_IGNORER_NAME = 'agnipariksha-arid-nodes';

/**
 * What `declareClassPlugin(PluginKind.Ignore, name, AridNodeIgnorer)` from
 * `@stryker-mutator/api/plugin` returns (10.1.1: `{ injectableClass, kind, name }`,
 * and `PluginKind.Ignore` is the string 'Ignore'), written out so the package
 * needs no `@stryker-mutator/api` dependency.
 */
export const strykerPlugins = [
  {
    injectableClass: AridNodeIgnorer,
    kind: 'Ignore',
    name: ARID_NODE_IGNORER_NAME,
  },
];

/** Exported so `ancestor` is covered by tests rather than dead. */
export const __testing = {
  ancestor,
  isFunctionNode,
};
