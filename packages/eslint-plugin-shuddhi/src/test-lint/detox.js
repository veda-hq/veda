/**
 * TEST-WEAK-01: Detox taps and text entry select by testID
 * (`detox-tap-by-id`).
 * `detox.test.ts` owns it.
 */
import { calledMethod, constInit, propertyName, unwrap } from './helpers.js';

// ---------------------------------------------------------------------------
// TEST-WEAK-01: Detox taps and text entry select by testID
// ---------------------------------------------------------------------------

/** Detox actions that touch or type into one element. */
const DETOX_ACTIONS = new Set([
  'tap',
  'longPress',
  'multiTap',
  'typeText',
  'replaceText',
  'clearText',
  'tapReturnKey',
  'tapBackspaceKey',
]);

/** Matcher combinators whose receiver is still the element selected. */
const SCOPING_MATCHERS = new Set(['withAncestor', 'withDescendant']);

/** How deep a matcher or element is followed through `const` bindings. */
const DETOX_BINDING_DEPTH = 3;

/**
 * The `by.*` matcher a Detox element is found with, when that is known and is
 * not `by.id` (alone, scoped, or either side of `.and`); null when it selects
 * by id or cannot be told here (a parameter, a helper's result), since an
 * unknown matcher is not reported.
 */
function nonIdMatcher(node, context, depth = 0) {
  const matcher = unwrap(node);
  if (matcher?.type === 'Identifier') {
    return depth < DETOX_BINDING_DEPTH
      ? nonIdMatcher(constInit(matcher, context), context, depth + 1)
      : null;
  }
  if (matcher?.type !== 'CallExpression') return null;
  const callee = unwrap(matcher.callee);
  const name = propertyName(callee);
  if (name === null) return null;
  const receiver = unwrap(callee.object);
  if (receiver.type === 'Identifier' && receiver.name === 'by') {
    return name === 'id' ? null : `by.${name}`;
  }
  if (name === 'and') {
    // Either side may be the id: the pair names a non-id matcher only when
    // the right side is a known one too (an unknown or id left is null).
    const left = nonIdMatcher(receiver, context, depth);
    return nonIdMatcher(matcher.arguments[0], context, depth) === null
      ? null
      : left;
  }
  return SCOPING_MATCHERS.has(name)
    ? nonIdMatcher(receiver, context, depth)
    : null;
}

/**
 * The `element(matcher)` an action is called on, through `.atIndex(n)` and
 * `const` bindings: `{ matcher, indexed }`, or null when it is not one.
 */
function detoxElement(node, context, depth = 0) {
  const target = unwrap(node);
  if (target?.type === 'Identifier') {
    return depth < DETOX_BINDING_DEPTH
      ? detoxElement(constInit(target, context), context, depth + 1)
      : null;
  }
  if (target?.type !== 'CallExpression') return null;
  const callee = unwrap(target.callee);
  if (callee.type === 'Identifier' && callee.name === 'element') {
    return { matcher: target.arguments[0], indexed: false };
  }
  if (propertyName(callee) !== 'atIndex') return null;
  const inner = detoxElement(callee.object, context, depth);
  return inner && { matcher: inner.matcher, indexed: true };
}

const detoxTapById = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Detox taps and text entry select their element by testID (TEST-WEAK-01)',
    },
    schema: [],
    messages: {
      notById:
        'This `{{action}}()` finds its element with `{{matcher}}(...)`, so a copy change, a translation or a second element with the same text breaks the flow or taps the wrong thing. Give the element a testID and select it with `by.id(...)`.',
      atIndex:
        'This `{{action}}()` picks its element by position (`atIndex`), so a reordered or added match taps a different element and the flow carries on. Give the element its own testID and select it with `by.id(...)`.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const action = calledMethod(node);
        if (!DETOX_ACTIONS.has(action)) return;
        const found = detoxElement(unwrap(node.callee).object, context);
        if (!found) return;
        if (found.indexed) {
          context.report({ node, messageId: 'atIndex', data: { action } });
          return;
        }
        const kind = nonIdMatcher(found.matcher, context);
        if (kind !== null) {
          context.report({
            node,
            messageId: 'notById',
            data: { action, matcher: kind },
          });
        }
      },
    };
  },
};

export { detoxTapById };
