/**
 * VAL-05 = EDGE-03 `strict-scalar-parse`. Replaces the banned construct with
 * strict scalar parsers and one page-parameter reader; the `pageReaders`
 * option names the caller's page readers and the `hints` option the caller's
 * parser modules.
 * Registered by ./index.js.
 */

import ts from 'typescript';

import {
  climb,
  hintFor,
  hintsSchema,
  isIdentifier,
  isMember,
  isProcessMember,
  variableOf,
  readsOf,
  typeServices,
  isNullishOrEmpty,
} from './helpers.js';

/** Is `name` the global (not a local binding that shadows it)? */
function isGlobalReference(context, node) {
  const scope = context.sourceCode.getScope(node);
  let current = scope;
  while (current) {
    const variable = current.set.get(node.name);
    if (variable && variable.defs.length > 0) return false;
    current = current.upper;
  }
  return true;
}

const STRINGISH =
  ts.TypeFlags.String |
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.TemplateLiteral |
  ts.TypeFlags.StringMapping;

/** String-typed, or `any`/`unknown` (could be a string at runtime). */
function maybeString(type) {
  if (type.isUnion()) return type.types.some(maybeString);
  return (
    (type.flags & (STRINGISH | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
  );
}

/** Definitely a string (every union member). */
function definitelyString(type) {
  if (type.isUnion()) return type.types.every(definitelyString);
  return (type.flags & STRINGISH) !== 0;
}

function isStringLiteralish(node) {
  if (node.type === 'Literal') return typeof node.value === 'string';
  if (node.type === 'TemplateLiteral') return true;
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return isStringLiteralish(node.left) || isStringLiteralish(node.right);
  }
  return false;
}

function isNumericLiteral(node) {
  if (node.type === 'Literal') return typeof node.value === 'number';
  return (
    node.type === 'UnaryExpression' &&
    (node.operator === '-' || node.operator === '+') &&
    isNumericLiteral(node.argument)
  );
}

const GUARDS = new Set(['isFinite', 'isInteger', 'isSafeInteger']);

/** `Number.isFinite(...)` and kin, on the global `Number` only. */
function isGuardCall(context, node) {
  return (
    node?.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    isIdentifier(node.callee.object, 'Number') &&
    node.callee.property.type === 'Identifier' &&
    GUARDS.has(node.callee.property.name) &&
    isGlobalReference(context, node.callee.object)
  );
}

/**
 * Tokens a numeric pattern is built from: digits (`\d`, `[0-9]`, a literal
 * digit), a sign or point (`\.`, `\+`, `\-`, `[+-]`, a bare `-`), grouping,
 * alternation and quantifiers. Anything else (`.`, `\w`, `\S`) lets
 * non-numeric text through.
 */
const NUMERIC_TOKEN =
  /\\d|\\[.+-]|\[(?:\\d|[0-9+\-.])+\]|\{\d+(?:,\d*)?\}|\(\?:|[()|*+?\-0-9]/g;

/** Is a regex body (between `^` and `$`) built of numeric tokens only? */
function isNumericOnly(body) {
  return /\\d|[0-9]/.test(body) && body.replace(NUMERIC_TOKEN, '') === '';
}

/**
 * Every character a numeric-only body can match: its tokens, and the ranges
 * a class can span between them (`[+-9]`), lie within `+` .. `9`.
 */
const NUMERIC_ALPHABET = [...'+,-./0123456789'];
/** Texts up to this length are probed. */
const PROBE_LENGTH = 4;

/**
 * Does every text the regex accepts read as a finite number? Numeric tokens
 * still spell `^(?:\d+|[+-])$`, which accepts a lone `+` (NaN). Probed over
 * every text up to PROBE_LENGTH characters: a longer-only junk match
 * (`^(?:\d{4}-|\d+)$`) is not claimed.
 */
function matchesOnlyNumbers(regex) {
  let texts = [''];
  for (let length = 1; length <= PROBE_LENGTH; length += 1) {
    texts = texts.flatMap(text => NUMERIC_ALPHABET.map(next => text + next));
    if (texts.some(text => regex.test(text) && !Number.isFinite(Number(text))))
      return false;
  }
  return true;
}

/**
 * Do `^` and `$` hold the WHOLE numeric body? A `|` outside every group
 * (`^\d+|\d+\.\d+$`) anchors each side alone, so `42junk` matches. Called on
 * numeric-only bodies, whose tokens never escape a parenthesis or hold one in
 * a class, so counting parentheses is exact.
 */
function anchorsWholeBody(body) {
  let depth = 0;
  for (const character of body) {
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === '|' && depth === 0) return false;
  }
  return true;
}

/**
 * Is `expression` the argument of a guard whose verdict is used? A guard
 * call standing alone as a statement (`Number.isFinite(n); return n;`)
 * rejects nothing. Whether the verdict actually stops the bad value is
 * control flow the rule does not prove.
 */
function isGuardArgument(context, expression) {
  const outer = climb(expression);
  return (
    isGuardCall(context, outer.parent) &&
    // The guards judge their first argument and ignore the rest.
    outer.parent.arguments[0] === outer &&
    climb(outer.parent).parent.type !== 'ExpressionStatement'
  );
}

/** Statements control never falls through: `return`, `throw`, `continue`, `break`, `process.exit(…)`. */
function exits(statement) {
  if (statement.type === 'BlockStatement') {
    return statement.body.length > 0 && exits(statement.body.at(-1));
  }
  if (statement.type === 'ExpressionStatement') {
    const call = statement.expression;
    return (
      call.type === 'CallExpression' && isProcessMember(call.callee, 'exit')
    );
  }
  return [
    'ReturnStatement',
    'ThrowStatement',
    'ContinueStatement',
    'BreakStatement',
  ].includes(statement.type);
}

/**
 * The source ranges a guard call protects: code that runs only after the
 * guard said yes. `passes` tracks what the enclosing expression's truth says
 * about the guard — true: the expression is truthy only if the guard passed;
 * false: the guard failing makes the expression truthy. `!` flips it; `&&`
 * keeps the first and `||` the second (the right side of either runs only
 * once the guard passed). Then the `if` or `?:` it tests: its passing branch,
 * and, for `if (!guard) return;`, the rest of the enclosing block. A verdict
 * kept in a flag (`const usable = Number.isInteger(n) && n > 0`) protects
 * what each read of the flag protects; `seen` stops a flag read in its own
 * initialiser.
 */
function protectedRanges(context, start, startPasses = true, seen = new Set()) {
  const ranges = [];
  let node = climb(start);
  let passes = startPasses;
  for (;;) {
    const parent = node.parent;
    if (parent.type === 'UnaryExpression' && parent.operator === '!') {
      passes = !passes;
    } else if (
      parent.type === 'LogicalExpression' &&
      parent.operator === (passes ? '&&' : '||')
    ) {
      if (parent.left === node) ranges.push(parent.right.range);
    } else {
      break;
    }
    node = climb(parent);
  }
  const parent = node.parent;
  if (
    (parent.type === 'IfStatement' ||
      parent.type === 'ConditionalExpression') &&
    parent.test === node
  ) {
    const passed = passes ? parent.consequent : parent.alternate;
    if (passed) ranges.push(passed.range);
    if (!passes && parent.type === 'IfStatement' && exits(parent.consequent)) {
      ranges.push([parent.range[1], parent.parent.range[1]]);
    }
  } else if (
    parent.type === 'VariableDeclarator' &&
    parent.id.type === 'Identifier' &&
    !seen.has(parent)
  ) {
    seen.add(parent);
    const [flag] = context.sourceCode.getDeclaredVariables(parent);
    for (const reference of readsOf(flag)) {
      ranges.push(
        ...protectedRanges(context, reference.identifier, passes, seen),
      );
    }
  }
  return ranges;
}

/**
 * Search-parameter names that carry a page number or a page size: `page`,
 * `pageSize`, `perPage`, `limit`, `offset`, and prefixed pages (`ptPage`).
 */
const PAGE_PARAM =
  /^(?:page(?:Size|Number|Index)?|page_size|per_?[Pp]age|limit|offset)$|[a-z]Page$/;
/** Untyped fallback: receivers that read as URL search parameters. */
const SEARCH_RECEIVER = /params|query|search/i;

/** The page-ish property name `node` reads (`x.page`, `x['ptPage']`), or null. */
function pagePropertyName(node) {
  if (node?.type !== 'MemberExpression') return null;
  let name = null;
  if (!node.computed && node.property.type === 'Identifier') {
    name = node.property.name;
  } else if (node.property.type === 'Literal') {
    // Only a computed key is a Literal: a dotted one is an (Private)Identifier.
    name = String(node.property.value);
  }
  return name !== null && PAGE_PARAM.test(name) ? name : null;
}

/** Is `node` the argument of one of the configured page readers? */
function readByPageReader(node, pageReaders) {
  const outer = climb(node);
  const parent = outer.parent;
  return (
    parent?.type === 'CallExpression' &&
    parent.arguments[0] === outer &&
    parent.callee.type === 'Identifier' &&
    pageReaders.has(parent.callee.name)
  );
}

/** The fix sentence each message ends with, unless the `hints` option sets one. */
export const DEFAULT_HINTS = {
  pageParam:
    'Read it through one page reader (named in the `pageReaders` option) that floors, clamps to [1, max] and falls back to 1.',
  parseCall:
    'Use a strict parser that rejects junk and checks { integer, min, max }.',
  dateParse:
    'Use a strict ISO parser that rejects impossible dates and requires an offset.',
  dateString:
    'Use a strict ISO parser that rejects impossible dates and requires an offset.',
  unguardedNumber: 'Use a strict number parser, or guard the result.',
  stringCompare:
    'Parse first (to an instant or a finite number), or use `localeCompare` for text.',
};

const strictScalarParse = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Parse boundary numbers and dates through strict helpers',
    },
    defaultOptions: [{ pageReaders: [], hints: DEFAULT_HINTS }],
    schema: [
      {
        type: 'object',
        properties: {
          // The only readers of a page parameter (EDGE-03): calls to these
          // names may take a raw `params.get('page')` read.
          pageReaders: {
            type: 'array',
            items: { type: 'string' },
            uniqueItems: true,
          },
          hints: hintsSchema(Object.keys(DEFAULT_HINTS)),
        },
        additionalProperties: false,
      },
    ],
    messages: {
      pageParam:
        'The `{{name}}` search parameter is hand-editable (`?{{name}}=abc`, `=0`, `=-3`, `=1e9`). {{hint}}',
      parseCall:
        '`{{name}}` accepts trailing junk (`parseInt("12abc")` is 12) and returns NaN for junk, which compares false against everything: `--runs=abc` once silently skipped every run. {{hint}}',
      dateParse:
        '`Date.parse` repairs impossible dates (`2026-02-29` becomes 1 March) and reads offset-less text as local time. {{hint}}',
      dateString:
        '`new Date(text)` repairs impossible dates and reads offset-less text as local time. {{hint}}',
      unguardedNumber:
        'This `{{form}}` result is used without `Number.isFinite` / `isInteger` / `isSafeInteger`: blank text is 0 and junk is NaN (an `isNaN` or `|| default` guard misses Infinity and keeps 0). {{hint}}',
      stringCompare:
        '`{{operator}}` between two strings compares UTF-16 code units: ISO timestamps with different offsets or precision, and numeric text ("10" < "9"), order wrongly. {{hint}}',
    },
  },
  create(context) {
    const pageReaders = new Set(context.options[0].pageReaders);
    /** Every report carries its message's hint. */
    const report = ({ node, messageId, data }) =>
      context.report({
        node,
        messageId,
        data: { ...data, hint: hintFor(context, messageId) },
      });
    const types = typeServices(context);

    /**
     * `/^\d+$/.test(text)`: the very text being coerced, validated whole —
     * one line (no `m` flag, where `^`/`$` match at any line), every
     * alternative inside the anchors, never the empty text (which `Number`
     * reads as 0), and no text `Number` reads as NaN.
     */
    const validatesWhole = (test, argument) => {
      if (
        test.type !== 'CallExpression' ||
        test.callee.type !== 'MemberExpression'
      ) {
        return false;
      }
      const { object, property } = test.callee;
      if (property.type !== 'Identifier' || property.name !== 'test')
        return false;
      if (object.type !== 'Literal' || !object.regex) return false;
      const { pattern, flags } = object.regex;
      const body = pattern.slice(1, -1);
      return (
        pattern.startsWith('^') &&
        pattern.endsWith('$') &&
        !flags.includes('m') &&
        isNumericOnly(body) &&
        anchorsWholeBody(body) &&
        !new RegExp(pattern).test('') &&
        test.arguments.length === 1 &&
        context.sourceCode.getText(test.arguments[0]) ===
          context.sourceCode.getText(argument) &&
        matchesOnlyNumbers(new RegExp(pattern))
      );
    };

    /** `x !== undefined`, `null == x`: a presence check reads no number out of `x`. */
    const isPresenceCheck = identifier => {
      const outer = climb(identifier);
      const parent = outer.parent;
      return (
        parent.type === 'BinaryExpression' &&
        ['===', '!==', '==', '!='].includes(parent.operator) &&
        isNullishOrEmpty(parent.left === outer ? parent.right : parent.left)
      );
    };

    const guarded = (expression, argument) => {
      let outer = climb(expression);
      // Through `cond ? Number(x) : fallback`: the branch value is guarded if
      // the condition validated the whole text first, or if the conditional's
      // own result is guarded further out.
      while (
        outer.parent.type === 'ConditionalExpression' &&
        outer.parent.test !== outer
      ) {
        if (
          outer.parent.consequent === outer &&
          validatesWhole(outer.parent.test, argument)
        ) {
          return true;
        }
        outer = climb(outer.parent);
      }
      if (isGuardArgument(context, outer)) return true;
      const parent = outer.parent;
      let variable = null;
      if (
        parent.type === 'VariableDeclarator' &&
        parent.init === outer &&
        parent.id.type === 'Identifier'
      ) {
        [variable] = context.sourceCode.getDeclaredVariables(parent);
      } else if (
        parent.type === 'AssignmentExpression' &&
        parent.operator === '=' &&
        parent.right === outer &&
        parent.left.type === 'Identifier'
      ) {
        variable = variableOf(context, parent.left);
      }
      if (!variable) return false;
      // A guard protects only the reads it stands in front of (a reviewer
      // found `if (Number.isFinite(n)) {}` then `return n`): every
      // other read must sit where the guard has already passed.
      const reads = readsOf(variable);
      const guards = reads.filter(reference =>
        isGuardArgument(context, reference.identifier),
      );
      const ranges = guards.flatMap(reference =>
        protectedRanges(context, climb(reference.identifier).parent),
      );
      return (
        guards.length > 0 &&
        reads.every(
          reference =>
            guards.includes(reference) ||
            isPresenceCheck(reference.identifier) ||
            ranges.some(
              ([start, end]) =>
                reference.identifier.range[0] >= start &&
                reference.identifier.range[1] <= end,
            ),
        )
      );
    };

    const coercesText = argument => {
      if (isNumericLiteral(argument)) return false;
      if (types) return maybeString(types.typeOf(argument));
      return true;
    };

    /** `params.get('page')` on URL search parameters: the name, or null. */
    const searchParamRead = node => {
      const callee = node.callee;
      if (
        callee.type !== 'MemberExpression' ||
        callee.computed ||
        callee.property.type !== 'Identifier' ||
        callee.property.name !== 'get' ||
        node.arguments.length !== 1
      ) {
        return null;
      }
      const [argument] = node.arguments;
      // Among expressions only a string Literal carries a string `value`.
      if (typeof argument.value !== 'string') return null;
      if (!PAGE_PARAM.test(argument.value)) return null;
      const receiver = callee.object;
      if (types) {
        const symbol = types.typeOf(receiver).getSymbol();
        return symbol?.getName() === 'URLSearchParams' ? argument.value : null;
      }
      const searchLike =
        (receiver.type === 'Identifier' &&
          SEARCH_RECEIVER.test(receiver.name)) ||
        (receiver.type === 'MemberExpression' &&
          !receiver.computed &&
          receiver.property.type === 'Identifier' &&
          SEARCH_RECEIVER.test(receiver.property.name)) ||
        (receiver.type === 'NewExpression' &&
          isIdentifier(receiver.callee, 'URLSearchParams'));
      return searchLike ? argument.value : null;
    };

    /** A coercion of a page-ish field (`Number(filters.page)`): its name. */
    const coercedPageField = argument => {
      const name = pagePropertyName(argument);
      return name !== null && coercesText(argument) ? name : null;
    };

    return {
      CallExpression(node) {
        const callee = node.callee;
        const read = searchParamRead(node);
        if (read !== null) {
          if (!readByPageReader(node, pageReaders)) {
            report({
              node,
              messageId: 'pageParam',
              data: { name: read },
            });
          }
          return;
        }
        const coerced =
          (callee.type === 'Identifier' &&
            ['Number', 'parseInt', 'parseFloat'].includes(callee.name) &&
            isGlobalReference(context, callee)) ||
          isMember(callee, 'Number', 'parseInt') ||
          isMember(callee, 'Number', 'parseFloat');
        const pageField =
          coerced && node.arguments.length >= 1
            ? coercedPageField(node.arguments[0])
            : null;
        if (pageField !== null) {
          // Guarded or not: a page has one reader, so its clamp and fallback
          // cannot drift between list pages.
          report({
            node,
            messageId: 'pageParam',
            data: { name: pageField },
          });
          return;
        }
        if (
          callee.type === 'Identifier' &&
          (callee.name === 'parseInt' || callee.name === 'parseFloat') &&
          isGlobalReference(context, callee)
        ) {
          report({
            node,
            messageId: 'parseCall',
            data: { name: callee.name },
          });
          return;
        }
        if (
          isMember(callee, 'Number', 'parseInt') ||
          isMember(callee, 'Number', 'parseFloat')
        ) {
          report({
            node,
            messageId: 'parseCall',
            data: { name: `Number.${callee.property.name}` },
          });
          return;
        }
        if (isMember(callee, 'Date', 'parse')) {
          report({ node, messageId: 'dateParse' });
          return;
        }
        if (
          isIdentifier(callee, 'Number') &&
          node.arguments.length === 1 &&
          node.arguments[0].type !== 'SpreadElement' &&
          isGlobalReference(context, callee) &&
          coercesText(node.arguments[0]) &&
          !guarded(node, node.arguments[0])
        ) {
          report({
            node,
            messageId: 'unguardedNumber',
            data: { form: 'Number(...)' },
          });
        }
      },
      UnaryExpression(node) {
        // Typed workspaces only: without types `+x` is as often a Date or a
        // boolean as a string, and the syntactic fallback would be noise.
        if (!types || node.operator !== '+') return;
        const pageField = coercedPageField(node.argument);
        if (pageField !== null) {
          report({
            node,
            messageId: 'pageParam',
            data: { name: pageField },
          });
          return;
        }
        if (!coercesText(node.argument) || guarded(node, node.argument)) return;
        report({
          node,
          messageId: 'unguardedNumber',
          data: { form: 'unary +' },
        });
      },
      NewExpression(node) {
        if (!isIdentifier(node.callee, 'Date') || node.arguments.length !== 1)
          return;
        if (!isGlobalReference(context, node.callee)) return;
        const [argument] = node.arguments;
        if (argument.type === 'SpreadElement') return;
        // Without types only a visibly textual argument is judged: `new
        // Date(ms)` and `new Date(otherDate)` are correct and indistinguishable
        // from `new Date(text)` by syntax.
        const textual = types
          ? !isNumericLiteral(argument) && maybeString(types.typeOf(argument))
          : isStringLiteralish(argument);
        if (textual) report({ node, messageId: 'dateString' });
      },
      BinaryExpression(node) {
        if (!types || !['<', '>', '<=', '>='].includes(node.operator)) return;
        if (
          definitelyString(types.typeOf(node.left)) &&
          definitelyString(types.typeOf(node.right))
        ) {
          report({
            node,
            messageId: 'stringCompare',
            data: { operator: node.operator },
          });
        }
      },
    };
  },
};

export default strictScalarParse;
