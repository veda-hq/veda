/**
 * VAL-08 (TS part) `no-hand-rolled-argv`. Replaces the banned construct with
 * a declared argument parser; the `hints` option names the caller's own
 * (default: `parseArgs` from node:util).
 * Registered by ./index.js.
 */

import {
  climb,
  hintFor,
  hintsSchema,
  isProcessMember,
  readsOf,
} from './helpers.js';

/** Array methods that scan or index argv: the hand-rolled parser shape. */
const ARGV_SCANS = new Set([
  'at',
  'entries',
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'forEach',
  'includes',
  'indexOf',
  'join',
  'lastIndexOf',
  'map',
  'pop',
  'reduce',
  'shift',
  'some',
  'splice',
]);

/**
 * Ad-hoc helper names reviewers found hand-rolling flag lookup: `argValue`,
 * `flagValue`, `getArg`, `getFlag`, `hasFlag`, `readOption`, `optValue`...
 * `parseArgs` (plural) is deliberately NOT here: it is node:util's name and the
 * shape a real parser exports.
 */
const ARGV_HELPER =
  /^(?:(?:get|read|has|take|parse)(?:Cli)?(?:Arg|Flag|Option|Opt)(?:Value)?|(?:arg|flag|option|opt)Value)$/;

/** Bindings that hold a raw argument vector by convention. */
const ARGV_BINDING = /^(?:argv|rawArgv|cliArgv)$/;

/** The fix sentence each message ends with, unless the `hints` option sets one. */
export const DEFAULT_HINTS = {
  index:
    'Declare the options and pass `process.argv.slice(2)` to a real parser (`parseArgs` from node:util).',
  scan: 'Declare the options and pass `process.argv.slice(2)` to a real parser (`parseArgs` from node:util).',
  helper:
    'Declare the options once and use a real parser (`parseArgs` from node:util).',
};

const noHandRolledArgv = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Parse command-line arguments with a declared parser, not by indexing or scanning argv',
    },
    defaultOptions: [{ hints: DEFAULT_HINTS }],
    schema: [
      {
        type: 'object',
        properties: { hints: hintsSchema(Object.keys(DEFAULT_HINTS)) },
        additionalProperties: false,
      },
    ],
    messages: {
      index:
        'Indexing argv reads whatever token sits there: an omitted value yields the NEXT FLAG (`--out --force` writes to "--force") and a typo is silently ignored. {{hint}}',
      scan: 'Scanning argv (`indexOf`, `includes`, `find`, a loop...) is a hand-rolled parser: unknown, duplicate, empty and flag-shaped values all pass. {{hint}}',
      helper:
        '`{{name}}` is an ad-hoc argv helper — the `argValue` shape that takes the next flag as a value. {{hint}}',
    },
  },
  create(context) {
    const reported = new Set();
    const report = (node, messageId, data) => {
      if (reported.has(node)) return;
      reported.add(node);
      context.report({
        node,
        messageId,
        data: { ...data, hint: hintFor(context, messageId) },
      });
    };

    /**
     * Judge one use of an argv-valued expression. Returns the `.slice()` call
     * when the use is a slice (the caller then judges the slice's own use).
     */
    const judgeUse = (expression, { allowEntryIndex }) => {
      const outer = climb(expression);
      const parent = outer.parent;
      if (parent.type === 'MemberExpression' && parent.object === outer) {
        if (parent.computed) {
          const index = parent.property;
          const entryIndex =
            allowEntryIndex &&
            index.type === 'Literal' &&
            (index.value === 0 || index.value === 1);
          if (!entryIndex) report(parent, 'index');
          return null;
        }
        const name = parent.property.name;
        if (
          name === 'slice' &&
          parent.parent.type === 'CallExpression' &&
          parent.parent.callee === parent
        ) {
          return parent.parent;
        }
        if (name === 'length' || ARGV_SCANS.has(name)) report(parent, 'scan');
        return null;
      }
      if (
        parent.type === 'VariableDeclarator' &&
        parent.init === outer &&
        parent.id.type === 'ArrayPattern'
      ) {
        report(parent.id, 'index');
        return null;
      }
      if (
        (parent.type === 'ForOfStatement' ||
          parent.type === 'ForInStatement') &&
        parent.right === outer
      ) {
        report(outer, 'scan');
      }
      return null;
    };

    /** Follow a binding holding argv tokens to every place it is read. */
    const judgeBinding = variable => {
      for (const reference of readsOf(variable)) {
        const slice = judgeUse(reference.identifier, {
          allowEntryIndex: false,
        });
        if (slice) judgeSlice(slice);
      }
    };

    const judgeSlice = sliceCall => {
      const outer = climb(sliceCall);
      const parent = outer.parent;
      if (
        parent.type === 'VariableDeclarator' &&
        parent.init === outer &&
        parent.id.type === 'Identifier'
      ) {
        const [variable] = context.sourceCode.getDeclaredVariables(parent);
        if (variable) judgeBinding(variable);
        return;
      }
      const nested = judgeUse(sliceCall, { allowEntryIndex: false });
      if (nested) judgeSlice(nested);
    };

    const helperName = node => {
      if (node.type === 'FunctionDeclaration' && node.id) return node.id;
      if (
        node.type === 'VariableDeclarator' &&
        node.id.type === 'Identifier' &&
        node.init &&
        (node.init.type === 'ArrowFunctionExpression' ||
          node.init.type === 'FunctionExpression')
      ) {
        return node.id;
      }
      return null;
    };

    return {
      MemberExpression(node) {
        if (!isProcessMember(node, 'argv')) return;
        const slice = judgeUse(node, { allowEntryIndex: true });
        if (slice) judgeSlice(slice);
      },
      'FunctionDeclaration, VariableDeclarator'(node) {
        const id = helperName(node);
        if (id && ARGV_HELPER.test(id.name)) {
          report(id, 'helper', { name: id.name });
        }
      },
      'Program:exit'(program) {
        const visit = scope => {
          for (const variable of scope.variables) {
            if (ARGV_BINDING.test(variable.name) && variable.defs.length > 0) {
              judgeBinding(variable);
            }
          }
          scope.childScopes.forEach(visit);
        };
        visit(context.sourceCode.getScope(program));
      },
    };
  },
};

export default noHandRolledArgv;
