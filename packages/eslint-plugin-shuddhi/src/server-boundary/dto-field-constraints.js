/**
 * VAL-03 `dto-field-constraints`: DTO / zod fields carry the
 * constraint their name implies.
 * Registered by ./index.js; ./configs.js mounts it under a plugin namespace.
 *
 * A heuristic over the AST (plus the type checker where one is configured).
 * It states below what it deliberately does NOT claim, because
 * a codebase that bans `eslint-disable` gives a rule that fires on correct
 * code no escape hatch except a suppression count.
 */

import { decoratorName, decoratorNames, keyName } from './helpers.js';

/** Does any of `names` appear in the set? */
const hasAny = (set, names) => names.some(name => set.has(name));

/** Identifier-shaped field names: an empty string is never a valid one. */
const ID_FIELD =
  /^(?:id|code|sku|sha)$|(?:_id|Id|ID|_code|Code|_sku|Sku|_sha|Sha)$/;
/** Id-array field names: duplicates double-count or fail a composite key. */
const ID_ARRAY_FIELD = /(?:^ids|_ids|Ids|IDs)$/;
const PHONE_FIELD = /phone/i;
/** Pagination sizes: unbounded, one request scans the table. */
const PAGE_FIELD =
  /^(?:page|limit|take|page_?size|pageSize|per_?page|perPage)$/;
/** Instants by naming convention. Calendar dates (`date`, `from`) are not. */
const INSTANT_FIELD = /(?:_at|[a-z]At)$/;

/** class-validator decorators that already rule out the empty string. */
const NON_BLANK = [
  'IsNotEmpty',
  'MinLength',
  'Length',
  'IsUUID',
  'Matches',
  'IsIn',
  'IsEnum',
  'IsEmail',
  'IsUrl',
  'IsNumberString',
  'IsAlphanumeric',
  'IsHexadecimal',
  'IsMongoId',
  'IsInstant',
  'IsDateString',
  'IsISO8601',
  'IsJWT',
  'IsHash',
  'IsSemVer',
];
const NUMERIC = ['IsInt', 'IsNumber'];
const DATE_VALIDATORS = ['IsDateString', 'IsISO8601', 'IsDate', 'IsRFC3339'];

/** zod methods that rule out the empty string. */
const ZOD_NON_BLANK = new Set([
  'min',
  'length',
  'nonempty',
  'uuid',
  'regex',
  'email',
  'url',
  'cuid',
  'cuid2',
  'ulid',
  'datetime',
  'startsWith',
  'endsWith',
  'refine',
  'superRefine',
  'transform',
]);

/**
 * Walk a zod chain (`z.string().min(1).optional()`) back to its root.
 * Returns `{ base, methods }`, or null when the chain does not start at the
 * zod namespace (a named schema constant is judged where it is defined).
 */
export function zodChain(node, zodNames) {
  const methods = new Set();
  let current = node;
  while (current && current.type === 'CallExpression') {
    const callee = current.callee;
    if (
      callee.type !== 'MemberExpression' ||
      callee.property.type !== 'Identifier'
    ) {
      return null;
    }
    const name = callee.property.name;
    if (
      callee.object.type === 'Identifier' &&
      zodNames.has(callee.object.name)
    ) {
      return { base: name, methods, root: current };
    }
    methods.add(name);
    current = callee.object;
  }
  return null;
}

/** Does a function body throw, or call BigInt, outside a try that catches? */
function unguardedThrow(fn) {
  let found = null;
  const visit = (node, guarded) => {
    if (!node || typeof node.type !== 'string' || found) return;
    if (node.type === 'TryStatement') {
      // try/finally without a catch lets the exception out.
      visit(node.block, guarded || node.handler !== null);
      visit(node.handler, guarded);
      visit(node.finalizer, guarded);
      return;
    }
    if (!guarded && node.type === 'ThrowStatement') {
      found = node;
      return;
    }
    if (
      !guarded &&
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'BigInt'
    ) {
      found = node;
      return;
    }
    // Every field but the back-link to the parent, which would walk upward.
    for (const child of Object.values(node).filter(
      value => value !== node.parent,
    )) {
      if (Array.isArray(child)) child.forEach(item => visit(item, guarded));
      else if (child && typeof child.type === 'string') visit(child, guarded);
    }
  };
  visit(fn.body, false);
  return found;
}

const dtoFieldConstraints = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Boundary DTO and zod fields must carry the constraint their shape implies',
    },
    schema: [
      {
        type: 'object',
        properties: {
          // Where the codebase's own `@IsInstant()` decorator lives, named in
          // the `instant` remedy (`common/validation`). The rule reads only
          // decorator names, so it does not need the module to judge.
          instantDecoratorModule: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      blankId:
        '`{{field}}` is an identifier but accepts the empty string. Add @IsNotEmpty()/@IsUUID()/@Matches() (zod: `.min(1)`/`.uuid()`) (VAL-03).',
      phone:
        '`{{field}}` is a phone number validated only as a string. Add @Matches(<phone pattern>) (VAL-03).',
      arrayMin:
        '`{{field}}` accepts an empty array. Decide: @ArrayNotEmpty(), or @ArrayMinSize(0) when empty is meaningful (zod: `.min(n)`/`.nonempty()`) (VAL-03).',
      arrayMax:
        '`{{field}}` has no upper bound, so one request can carry any number of items. Add @ArrayMaxSize(n) (zod: `.max(n)`) (VAL-03).',
      arrayUnique:
        '`{{field}}` is a list of ids with no uniqueness rule; a duplicate double-counts or fails a composite key. Add @ArrayUnique() (VAL-03).',
      numericType:
        '`{{field}}` is numeric without @Type(() => Number), so a query-string or CSV value arrives as a string and fails or mis-validates (VAL-03).',
      numericNotEmpty:
        '`{{field}}` is numeric; @IsNotEmpty() says nothing about a number and reads as "0 is invalid". Use @IsDefined() or drop it (VAL-03).',
      pageMax:
        '`{{field}}` sizes a page with no @Max(), so one request can read the whole table. Add @Max(n) (zod: `.max(n)`) (VAL-03).',
      transformThrows:
        'This @Transform can throw (a `throw`, or BigInt() outside try), which escapes the ValidationPipe as a 500 or a non-422. Validate the shape with a decorator; keep @Transform total (VAL-03).',
      instant:
        '`{{field}}` is an instant, but {{validator}} accepts a timestamp without a zone, which `new Date` reads in server time. Use @IsInstant(){{from}} (zod: `.datetime({ offset: true })`) (VAL-03).',
    },
  },
  create(context) {
    const zodNames = new Set();
    const instantModule = context.options[0]?.instantDecoratorModule;
    const from = instantModule ? ` from ${instantModule}` : '';

    function checkProperty(node) {
      const names = decoratorNames(node);
      if (names.size === 0) return;
      const field = keyName(node.key);
      if (field === null) return;
      const report = messageId =>
        context.report({ node: node.key, messageId, data: { field } });

      const stringy = names.has('IsString');
      if (stringy && ID_FIELD.test(field) && !hasAny(names, NON_BLANK)) {
        report('blankId');
      }
      if (
        stringy &&
        PHONE_FIELD.test(field) &&
        !hasAny(names, ['Matches', 'IsPhoneNumber', 'IsMobilePhone'])
      ) {
        report('phone');
      }
      if (names.has('IsArray')) {
        if (!hasAny(names, ['ArrayNotEmpty', 'ArrayMinSize']))
          report('arrayMin');
        if (!names.has('ArrayMaxSize')) report('arrayMax');
        if (
          (ID_ARRAY_FIELD.test(field) || names.has('IsUUID')) &&
          !names.has('ArrayUnique')
        ) {
          report('arrayUnique');
        }
      }
      if (hasAny(names, NUMERIC)) {
        if (!hasAny(names, ['Type', 'Transform'])) report('numericType');
        if (names.has('IsNotEmpty')) report('numericNotEmpty');
        if (PAGE_FIELD.test(field) && !names.has('Max')) report('pageMax');
      }
      const date = DATE_VALIDATORS.find(name => names.has(name));
      if (
        date &&
        INSTANT_FIELD.test(field) &&
        !hasAny(names, ['IsInstant', 'Matches'])
      ) {
        context.report({
          node: node.key,
          messageId: 'instant',
          data: { field, validator: `@${date}()`, from },
        });
      }
      for (const decorator of node.decorators ?? []) {
        if (decoratorName(decorator) !== 'Transform') continue;
        if (decorator.expression.type !== 'CallExpression') continue;
        const [fn] = decorator.expression.arguments;
        if (
          !fn ||
          (fn.type !== 'ArrowFunctionExpression' &&
            fn.type !== 'FunctionExpression')
        ) {
          continue;
        }
        if (unguardedThrow(fn)) {
          context.report({ node: decorator, messageId: 'transformThrows' });
        }
      }
    }

    function checkZodProperty(property) {
      const field = keyName(property.key);
      if (field === null) return;
      const chain = zodChain(property.value, zodNames);
      if (!chain) return;
      const { base, methods } = chain;
      const report = messageId =>
        context.report({ node: property.key, messageId, data: { field } });
      if (base === 'string') {
        const nonBlank = [...methods].some(method => ZOD_NON_BLANK.has(method));
        if (ID_FIELD.test(field) && !nonBlank) report('blankId');
        if (
          INSTANT_FIELD.test(field) &&
          !hasAny(methods, ['datetime', 'regex', 'refine', 'superRefine'])
        ) {
          context.report({
            node: property.key,
            messageId: 'instant',
            data: { field, validator: '`z.string()`', from },
          });
        }
      }
      if (base === 'array') {
        if (!hasAny(methods, ['min', 'nonempty', 'length'])) report('arrayMin');
        if (!hasAny(methods, ['max', 'length'])) report('arrayMax');
      }
      if (base === 'number' && PAGE_FIELD.test(field)) {
        if (!hasAny(methods, ['max', 'lte'])) report('pageMax');
      }
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'zod') return;
        for (const specifier of node.specifiers)
          zodNames.add(specifier.local.name);
      },
      PropertyDefinition: checkProperty,
      CallExpression(node) {
        if (zodNames.size === 0) return;
        const callee = node.callee;
        if (
          callee.type !== 'MemberExpression' ||
          callee.object.type !== 'Identifier' ||
          !zodNames.has(callee.object.name) ||
          callee.property.type !== 'Identifier' ||
          !['object', 'strictObject', 'looseObject'].includes(
            callee.property.name,
          )
        ) {
          return;
        }
        const [shape] = node.arguments;
        if (!shape || shape.type !== 'ObjectExpression') return;
        for (const property of shape.properties) {
          if (property.type === 'Property') checkZodProperty(property);
        }
      },
    };
  },
};

export default dtoFieldConstraints;
