/**
 * VAL-01 `nest-body-dto`: @Body must be a validated DTO class.
 * Registered by ./index.js; ./configs.js mounts it under a plugin namespace.
 *
 * A heuristic over the AST (plus the type checker where one is configured).
 * It states below what it deliberately does NOT claim, because
 * a codebase that bans `eslint-disable` gives a rule that fires on correct
 * code no escape hatch except a suppression count.
 */

import { decoratorName, decoratorNames, keyName } from './helpers.js';

/**
 * Generic and utility types whose runtime metatype is `Object` (or a
 * collection), so the global ValidationPipe validates nothing behind them.
 */
const OPAQUE_GENERICS = new Set([
  'Array',
  'ReadonlyArray',
  'Record',
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'NonNullable',
  'Extract',
  'Exclude',
  'Map',
  'Set',
  'Promise',
]);

/**
 * Decorators that describe or reshape a property but validate nothing. A class
 * whose only decorators are these is still an unvalidated body.
 */
const NON_VALIDATING_DECORATORS = new Set([
  'ApiProperty',
  'ApiPropertyOptional',
  'ApiHideProperty',
  'Expose',
  'Exclude',
  'Type',
  'Transform',
]);

// TypeScript SymbolFlags. Numeric because this module must not import its own
// `typescript`: the checker it is handed belongs to the parser's copy, and two
// copies can disagree on SyntaxKind numbering. These flag values have not
// changed since TypeScript 2.
const SYMBOL_CLASS = 32;
const SYMBOL_INTERFACE = 64;
const SYMBOL_METHOD = 8192;
const SYMBOL_TYPE_ALIAS = 524288;
const SYMBOL_ALIAS = 2097152;

/** The decorator name of a TypeScript (not ESTree) decorator node. */
function tsDecoratorName(decorator) {
  let expression = decorator.expression;
  if (expression && expression.arguments !== undefined) {
    expression = expression.expression;
  }
  if (expression && expression.name !== undefined) expression = expression.name;
  // `text` is the name as written; `escapedText` differs only for `__` names.
  return expression?.text ?? null;
}

/**
 * Does a TypeScript declaration carry at least one validating decorator?
 * Decorators sit in `modifiers` since TS 5; a decorator is the modifier that
 * has an `expression`.
 */
function tsDeclarationValidated(declaration) {
  return (declaration.modifiers ?? []).some(modifier => {
    if (modifier.expression === undefined) return false;
    const name = tsDecoratorName(modifier);
    return name !== null && !NON_VALIDATING_DECORATORS.has(name);
  });
}

/**
 * ESTree: does a class, or a base class declared in the same file, declare a
 * property with a validating decorator? `classes` maps this file's class
 * names to their declarations.
 */
function classValidatedLocally(classNode, classes, seen = new Set()) {
  seen.add(classNode);
  const properties = classNode.body.body.filter(
    member => member.type === 'PropertyDefinition',
  );
  const validated = properties.some(property =>
    [...decoratorNames(property)].some(
      name => !NON_VALIDATING_DECORATORS.has(name),
    ),
  );
  if (validated) return true;
  const base = classNode.superClass;
  // A class with no properties plus `forbidNonWhitelisted` rejects any field:
  // an empty body DTO is validated, by construction.
  if (base === null) return properties.length === 0;
  // A base declared in this file is judged the same way.
  const local = base.type === 'Identifier' ? classes.get(base.name) : undefined;
  if (local?.type === 'ClassDeclaration') {
    return !seen.has(local) && classValidatedLocally(local, classes, seen);
  }
  // Accepted limit: an imported base or a mapped type (`PartialType(CreateDto)`)
  // may carry the decorators, and without types the rule cannot see them. The
  // server config is typed, and its typed verdict reads inherited properties.
  return true;
}

const nestBodyDto = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A Nest @Body() parameter must be a DTO class carrying class-validator decorators',
    },
    schema: [],
    messages: {
      untyped:
        '`@Body()` in {{method}}() has no type, so nothing validates the payload. Declare a DTO class with class-validator decorators (VAL-01).',
      notClass:
        '`@Body()` in {{method}}() is typed as {{kind}}. Types are erased at runtime: the global ValidationPipe sees `Object` and validates nothing, so a malformed payload reaches the handler (VAL-01). Declare a DTO class with class-validator decorators, or pass a parsing pipe.',
      undecorated:
        '`{{name}}` is the @Body() of {{method}}(), but none of its properties carries a class-validator decorator, so the ValidationPipe checks nothing (VAL-01). Decorate its fields.',
      typeOnly:
        '`{{name}}` is imported with `import type`, so decorator metadata cannot reference the class and the ValidationPipe sees `Object` for {{method}}() (VAL-01). Import it as a value.',
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    const program = services?.program ?? null;
    const checker = program ? program.getTypeChecker() : null;

    const typeOnlyImports = new Set();
    const localDeclarations = new Map();
    const bodies = [];

    /** `{ messageId, data }` for one @Body parameter, or null when it passes. */
    function verdict({ target, body, method }) {
      const args =
        body.expression.type === 'CallExpression'
          ? body.expression.arguments
          : [];
      // A pipe handed to the decorator (`@Body(new ParseArrayPipe(...))`,
      // `@Body('ids', ParseUUIDPipe)`) is the validation this rule asks for.
      const piped = args.some(
        arg =>
          !(arg.type === 'Literal' && typeof arg.value === 'string') &&
          /Pipe\b/.test(context.sourceCode.getText(arg)),
      );
      if (piped) return null;

      const annotation = target.typeAnnotation?.typeAnnotation;
      if (!annotation) return { messageId: 'untyped', data: { method } };

      const text = context.sourceCode.getText(annotation);
      if (annotation.type === 'TSTypeLiteral') {
        return {
          messageId: 'notClass',
          data: { method, kind: 'an inline type literal' },
        };
      }
      if (
        annotation.type === 'TSArrayType' ||
        annotation.type === 'TSTupleType'
      ) {
        return {
          messageId: 'notClass',
          data: { method, kind: `the array type \`${text}\`` },
        };
      }
      if (annotation.type !== 'TSTypeReference') {
        return { messageId: 'notClass', data: { method, kind: `\`${text}\`` } };
      }

      const typeName = annotation.typeName;
      const name =
        typeName.type === 'Identifier' ? typeName.name : typeName.right.name;
      // A generic DTO class (`PageDto<ItemDto>`) reaches the pipe as its
      // class, so only the utility and collection generics are refused here;
      // the class check below judges the rest.
      if (OPAQUE_GENERICS.has(name)) {
        return { messageId: 'notClass', data: { method, kind: `\`${text}\`` } };
      }
      const root =
        typeName.type === 'Identifier'
          ? typeName.name
          : context.sourceCode.getText(typeName).split('.')[0];
      if (typeOnlyImports.has(root)) {
        return { messageId: 'typeOnly', data: { method, name } };
      }

      if (checker) return typedVerdict(annotation, name, method);
      return localVerdict(name, method);
    }

    function typedVerdict(annotation, name, method) {
      const tsNode = services.esTreeNodeToTSNodeMap.get(annotation);
      let symbol = checker.getSymbolAtLocation(tsNode.typeName);
      if (!symbol) return null; // unresolved: cannot judge
      if (symbol.flags & SYMBOL_ALIAS)
        symbol = checker.getAliasedSymbol(symbol);
      if (!(symbol.flags & SYMBOL_CLASS)) {
        const kind =
          symbol.flags & SYMBOL_INTERFACE
            ? `the interface \`${name}\``
            : symbol.flags & SYMBOL_TYPE_ALIAS
              ? `the type alias \`${name}\``
              : `the non-class type \`${name}\``;
        return { messageId: 'notClass', data: { method, kind } };
      }
      const instance = checker.getDeclaredTypeOfSymbol(symbol);
      const properties = checker
        .getPropertiesOfType(instance)
        .filter(property => !(property.flags & SYMBOL_METHOD));
      if (properties.length === 0) return null;
      const validated = properties.some(property =>
        (property.declarations ?? []).some(tsDeclarationValidated),
      );
      return validated
        ? null
        : { messageId: 'undecorated', data: { method, name } };
    }

    function localVerdict(name, method) {
      const declaration = localDeclarations.get(name);
      if (!declaration) return null; // imported or global: cannot judge untyped
      if (declaration.type === 'ClassDeclaration') {
        return classValidatedLocally(declaration, localDeclarations)
          ? null
          : { messageId: 'undecorated', data: { method, name } };
      }
      const kind =
        declaration.type === 'TSInterfaceDeclaration'
          ? `the interface \`${name}\``
          : `the type alias \`${name}\``;
      return { messageId: 'notClass', data: { method, kind } };
    }

    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (node.importKind === 'type' || specifier.importKind === 'type') {
            typeOnlyImports.add(specifier.local.name);
          }
        }
      },
      'ClassDeclaration, TSInterfaceDeclaration, TSTypeAliasDeclaration'(node) {
        if (node.id) localDeclarations.set(node.id.name, node);
      },
      MethodDefinition(method) {
        const owner = method.parent.parent;
        if (!decoratorNames(owner).has('Controller')) return;
        const methodName = keyName(method.key) ?? 'handler';
        for (const param of method.value.params) {
          const body = (param.decorators ?? []).find(
            decorator => decoratorName(decorator) === 'Body',
          );
          if (!body) continue;
          const target =
            param.type === 'TSParameterProperty' ? param.parameter : param;
          bodies.push({ param, target, body, method: methodName });
        }
      },
      'Program:exit'() {
        for (const entry of bodies) {
          const result = verdict(entry);
          if (result) context.report({ node: entry.param, ...result });
        }
      },
    };
  },
};

export default nestBodyDto;
