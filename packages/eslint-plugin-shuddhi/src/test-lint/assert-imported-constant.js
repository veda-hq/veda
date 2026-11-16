/**
 * An expected value imported from the module under test
 * (`assert-imported-constant`). `assert-imported-constant.test.ts` owns it.
 *
 * WHY. A mutation tester changes the constant where it is defined. A test
 * that asserts against the same imported constant compares the mutated value
 * with itself, passes, and kills nothing; the literal typed in the test
 * would have failed. A warning: some constants are opaque on purpose (a
 * generated id, a symbol), and asserting them by name is right there.
 *
 * SCOPE. The module under test is the relative import whose file name, less
 * its extension (or the folder of an `index`), is the test file's name less
 * `.test`/`.spec` and its extension; `widget.integration.test.ts` also
 * matches `widget`. An imported constant, a binding named in CONSTANT_CASE,
 * is reported as a matcher's argument or inside one: object values, array
 * elements, spreads and the arguments of an asymmetric matcher
 * (`expect.stringContaining(PREFIX)`). Matchers that take a class or an error
 * (`toBeInstanceOf`, `toThrow`) are not read.
 *
 * NOT READ, measured on a product monorepo (726 hits before, most of them these): a
 * function or object passed as a value (`run: spawnRunner`, an injected
 * fake, compared by identity), a member of an import (`Status.PAID`, an enum
 * the mutator leaves alone), and a constant inside a template literal (a
 * path named in an expected message), where the literal is the prose around
 * it.
 */
import { assertion, propertyName, unwrap, variableOf } from './helpers.js';

/** Matchers whose argument names a type or an error, not a value. */
const TYPE_MATCHERS = new Set([
  'toBeInstanceOf',
  'toThrow',
  'toThrowError',
  'toThrowErrorMatchingSnapshot',
  'toThrowErrorMatchingInlineSnapshot',
]);

const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/;

/** The names the module under test may have, from the test file's path. */
function subjectNames(filename) {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const match = /^(.*)\.(test|spec)\.[cm]?[jt]sx?$/.exec(base);
  if (!match) return new Set();
  const stem = match[1];
  const names = new Set([stem]);
  const dot = stem.lastIndexOf('.');
  if (dot > 0) names.add(stem.slice(0, dot));
  return names;
}

/** The file name an import source names, less its extension; null when not relative. */
function sourceName(source) {
  if (!source.startsWith('.')) return null;
  const parts = source.split('/').filter(part => part !== '');
  let last = (parts.pop() ?? '').replace(SCRIPT_EXTENSION, '');
  if (last === 'index') last = parts.pop() ?? '';
  return last === '.' || last === '..' ? null : last;
}

/** A constant's name: `MAX_RETRIES`, `PREFIX`, `V2`. */
const CONSTANT_CASE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

/** The value import an identifier named in CONSTANT_CASE resolves to, or null. */
function importOf(node, context) {
  if (!CONSTANT_CASE.test(node.name)) return null;
  const def = variableOf(node, context)?.defs[0];
  if (def?.type !== 'ImportBinding') return null;
  if (def.parent.importKind === 'type' || def.node.importKind === 'type') {
    return null;
  }
  return def;
}

/** `expect.<anything>(...)`: an asymmetric matcher whose arguments are expected values too. */
function isAsymmetric(node) {
  const callee = unwrap(node.callee);
  if (callee.type !== 'MemberExpression') return false;
  let object = unwrap(callee.object);
  if (object.type === 'MemberExpression' && propertyName(object) === 'not') {
    object = unwrap(object.object);
  }
  return object.type === 'Identifier' && object.name === 'expect';
}

const assertImportedConstant = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'An expected value is typed in the test, not imported from the module under test',
    },
    schema: [],
    messages: {
      imported:
        '`{{name}}` comes from the module under test, so this assertion moves with any change to it: a mutant of the constant passes, and kills nothing. Assert the literal value, typed in the test.',
    },
  },
  create(context) {
    const subjects = subjectNames(context.filename ?? context.getFilename());
    if (subjects.size === 0) return {};

    function visit(node) {
      const value = unwrap(node);
      if (!value) return;
      switch (value.type) {
        case 'ObjectExpression':
          for (const property of value.properties) {
            visit(property.type === 'Property' ? property.value : property.argument);
          }
          return;
        case 'ArrayExpression':
          for (const element of value.elements) visit(element);
          return;
        case 'SpreadElement':
          visit(value.argument);
          return;
        case 'CallExpression':
          if (isAsymmetric(value)) for (const argument of value.arguments) visit(argument);
          return;
        case 'Identifier': {
          const def = importOf(value, context);
          if (def && subjects.has(sourceName(def.parent.source.value))) {
            context.report({
              node: value,
              messageId: 'imported',
              data: { name: value.name },
            });
          }
          return;
        }
        default:
          return;
      }
    }

    return {
      CallExpression(node) {
        const found = assertion(node, context);
        if (!found || TYPE_MATCHERS.has(found.matcher)) return;
        for (const argument of node.arguments) visit(argument);
      },
    };
  },
};

export { assertImportedConstant, sourceName, subjectNames };
