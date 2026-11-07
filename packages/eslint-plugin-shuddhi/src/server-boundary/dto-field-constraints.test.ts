import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import rule from './dto-field-constraints.js';

/**
 * VAL-03 `dto-field-constraints`. The
 * catalogue example, reduced to the smallest shape that still reproduces it,
 * fails for its own messageId; the corrected code and at least one near-miss
 * pass; and deleting only the guard from the corrected code fails again ("guard
 * removal flips").
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

/** Remove exactly one occurrence of `guard`, failing loudly if absent. */
function withoutGuard(code: string, guard: string): string {
  if (!code.includes(guard)) throw new Error(`guard not in code: ${guard}`);
  return code.replace(guard, '');
}

// ---------------------------------------------------------------------------
// VAL-03 — dto-field-constraints

/** A return-request DTO as reviewers found it, verbatim. */
const VAL03_EXAMPLE = `
import { IsString, IsNotEmpty, IsArray, ValidateNested, IsInt, Min, IsUUID, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateReturnItemDto {
    @IsString()
    @IsNotEmpty()
    sku_id!: string;

    @IsInt()
    @Min(1)
    requested_qty!: number;

    @IsOptional()
    @IsString()
    reason?: string;
}

export class CreateReturnRequestDto {
    @IsUUID()
    client_request_id!: string;

    @IsUUID()
    brand_id!: string;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CreateReturnItemDto)
    items!: CreateReturnItemDto[];
}`;

/**
 * The fix review asked for (@ArrayNotEmpty), plus what the same rule asks of
 * the rest of this DTO: an upper bound and @Type on the numeric field.
 */
const VAL03_CORRECTED = VAL03_EXAMPLE.replace(
  '@IsArray()',
  '@IsArray()\n    @ArrayNotEmpty()\n    @ArrayMaxSize(100)',
).replace('@IsInt()', '@Type(() => Number)\n    @IsInt()');

const zod = (shape: string): string =>
  `import { z } from 'zod';\nexport const schema = z.object({ ${shape} });`;

tester.run('dto-field-constraints', rule, {
  valid: [
    { code: VAL03_CORRECTED },
    // Near-miss: an explicit decision that empty is meaningful.
    {
      code: 'class D { @IsArray() @ArrayMinSize(0) @ArrayMaxSize(10) tags!: string[] }',
    },
    // Near-miss: free text is not an identifier.
    { code: 'class D { @IsString() description!: string }' },
    // Near-miss: a calendar date is not an instant.
    { code: 'class D { @IsDateString() business_date!: string }' },
    { code: 'class D { @IsInstant() occurred_at!: string }' },
    { code: 'class D { @IsUUID() @IsString() store_id!: string }' },
    {
      code: 'class D { @IsString() @Matches(/^\\+?\\d{10,15}$/) customerPhone!: string }',
    },
    {
      code: 'class D { @Type(() => Number) @IsInt() @Max(100) limit!: number }',
    },
    {
      code: 'class D { @IsArray() @ArrayNotEmpty() @ArrayMaxSize(50) @ArrayUnique() @IsUUID("4", { each: true }) brandIds!: string[] }',
    },
    // A Transform that cannot throw.
    {
      code: `class D {
        @Transform(({ value }) => { try { return BigInt(value); } catch { return value; } })
        @Matches(/^\\d+$/) version!: string }`,
    },
    // Undecorated properties are not DTO fields.
    { code: 'class S { sku_id = ""; }' },
    // zod: the corrected event-descriptor shape and near-misses.
    { code: zod('sku_id: z.string().trim().min(1)') },
    { code: zod('sku_id: z.string().uuid().optional()') },
    { code: zod('items: z.array(z.string()).min(1).max(50)') },
    { code: zod('occurred_at: z.string().datetime({ offset: true })') },
    { code: zod('occurred_at: instant') },
    { code: zod('limit: z.number().int().max(100)') },
    // Not zod: another library's `object` is none of this rule's business.
    {
      code: "import * as y from 'yup';\nconst s = y.object({ sku_id: y.string() });",
    },
    {
      code: 'const z = { object: (x: unknown) => x, string: () => 1 };\nz.object({ sku_id: z.string() });',
    },
  ],
  invalid: [
    {
      code: VAL03_EXAMPLE,
      errors: [
        { messageId: 'numericType' },
        { messageId: 'arrayMin' },
        { messageId: 'arrayMax' },
      ],
    },
    // Guard removal: drop the @ArrayNotEmpty the fix added.
    {
      code: withoutGuard(VAL03_CORRECTED, '@ArrayNotEmpty()'),
      errors: [{ messageId: 'arrayMin' }],
    },
    // An inventory DTO accepting a blank SKU id.
    {
      code: 'class D { @IsString() sku_id!: string }',
      errors: [{ messageId: 'blankId' }],
    },
    // An order DTO validating a phone as any string.
    {
      code: 'class D { @IsOptional() @IsString() @IsNotEmpty() customerPhone?: string }',
      errors: [{ messageId: 'phone' }],
    },
    // A create-store DTO accepting duplicate brand ids.
    {
      code: 'class D { @IsArray() @ArrayNotEmpty() @ArrayMaxSize(50) @IsUUID("4", { each: true }) brandIds!: string[] }',
      errors: [{ messageId: 'arrayUnique' }],
    },
    // An unbounded history limit.
    {
      code: 'class D { @Type(() => Number) @IsInt() @Min(1) limit!: number }',
      errors: [{ messageId: 'pageMax' }],
    },
    // Numeric with no @Type.
    {
      code: 'class D { @IsInt() @Min(1) qty!: number }',
      errors: [{ messageId: 'numericType' }],
    },
    // @IsNotEmpty on a number rejects nothing useful.
    {
      code: 'class D { @Type(() => Number) @IsNumber() @IsNotEmpty() count!: number }',
      errors: [{ messageId: 'numericNotEmpty' }],
    },
    // BigInt in @Transform, unguarded.
    {
      code: 'class D { @Transform(({ value }) => BigInt(value)) @IsString() productMasterVersion!: string }',
      errors: [{ messageId: 'transformThrows' }],
    },
    // Throwing BadRequestException from @Transform.
    {
      code: `class D { @Transform(({ value }) => {
        if (!/^\\d+$/.test(value)) throw new BadRequestException('bad');
        return BigInt(value);
      }) @IsString() version!: string }`,
      errors: [{ messageId: 'transformThrows' }],
    },
    // try/finally without a catch lets BigInt's throw out.
    {
      code: `class D { @Transform(({ value }) => {
        try { return BigInt(value); } finally { audit(value); }
      }) @IsString() version!: string }`,
      errors: [{ messageId: 'transformThrows' }],
    },
    // An instant without a zone.
    {
      code: 'class D { @IsISO8601() occurred_at!: string }',
      errors: [{ messageId: 'instant' }],
    },
    {
      code: 'class D { @IsDateString() startsAt!: string }',
      errors: [{ messageId: 'instant' }],
    },
    // An event-descriptor zod schema accepting sku_id ''.
    { code: zod('sku_id: z.string()'), errors: [{ messageId: 'blankId' }] },
    {
      code: withoutGuard(zod('sku_id: z.string().trim().min(1)'), '.min(1)'),
      errors: [{ messageId: 'blankId' }],
    },
    {
      code: zod('items: z.array(z.string())'),
      errors: [{ messageId: 'arrayMin' }, { messageId: 'arrayMax' }],
    },
    {
      code: zod('occurred_at: z.string()'),
      errors: [{ messageId: 'instant' }],
    },
    {
      code: zod('limit: z.number().int()'),
      errors: [{ messageId: 'pageMax' }],
    },
  ],
});

/** Mirrors NON_BLANK. */
const NON_BLANK_NAMES = [
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

/** Mirrors DATE_VALIDATORS. */
const DATE_VALIDATOR_NAMES = [
  'IsDateString',
  'IsISO8601',
  'IsDate',
  'IsRFC3339',
];

/** Mirrors ZOD_NON_BLANK. */
const ZOD_NON_BLANK_METHODS = [
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
];

tester.run('dto-field-constraints (vocabulary)', rule, {
  valid: [
    ...NON_BLANK_NAMES.map(name => ({
      code: `class D { @IsString() @${name}() sku_id!: string }`,
    })),
    ...ZOD_NON_BLANK_METHODS.map(method => ({
      code: zod(`sku_id: z.string().${method}(rule)`),
    })),
  ],
  invalid: DATE_VALIDATOR_NAMES.map(name => ({
    code: `class D { @${name}() occurred_at!: string }`,
    errors: [
      {
        messageId: 'instant',
        data: { field: 'occurred_at', validator: `@${name}()`, from: '' },
      },
    ],
  })),
});

tester.run('dto-field-constraints (branches)', rule, {
  valid: [
    // A decorator whose callee is itself a call has no name.
    { code: 'class D { @(factory())() sku_id!: string }' },
    { code: "class D { @IsString() @IsPhoneNumber('IN') phone!: string }" },
    { code: 'class D { @IsString() @IsMobilePhone() phone!: string }' },
    {
      code: 'class D { @Transform(({ value }) => Number(value)) @IsInt() qty!: number }',
    },
    { code: 'class D { @IsISO8601() @IsInstant() occurred_at!: string }' },
    { code: 'class D { @IsISO8601() @Matches(/Z$/) occurred_at!: string }' },
    // A @Transform with no function argument has nothing to throw.
    { code: 'class D { @Transform() @IsString() name!: string }' },
    // zod: a property that is a plain call, or another namespace's chain.
    { code: zod('sku_id: makeId()') },
    { code: zod('sku_id: y.string()') },
    { code: zod('occurred_at: z.string().regex(/Z$/)') },
    { code: zod('occurred_at: z.string().refine(isInstant)') },
    { code: zod('occurred_at: z.string().superRefine(checkInstant)') },
    { code: zod('items: z.array(z.string()).nonempty().max(5)') },
    { code: zod('items: z.array(z.string()).length(3)') },
    // A page-named string is not a page size.
    { code: zod('limit: z.string()') },
    { code: zod('limit: z.number().int().lte(100)') },
    // Another library's object() with a zod field inside is not a zod shape.
    {
      code: "import { z } from 'zod';\nconst s = other.object({ sku_id: z.string() });",
    },
    { code: "import { z } from 'zod';\nmakeSchema();" },
    { code: "import { z } from 'zod';\nz.object();" },
  ],
  invalid: [
    {
      code: 'class D { @cv.IsString() sku_id!: string }',
      errors: [{ messageId: 'blankId', data: { field: 'sku_id' } }],
    },
    {
      code: "class D { @IsString() 'sku_id'!: string }",
      errors: [{ messageId: 'blankId', data: { field: 'sku_id' } }],
    },
    // Ids by decorator alone, and ids by name alone.
    {
      code: "class D { @IsArray() @ArrayNotEmpty() @ArrayMaxSize(5) @IsUUID('4', { each: true }) brands!: string[] }",
      errors: [{ messageId: 'arrayUnique' }],
    },
    {
      code: 'class D { @IsArray() @ArrayNotEmpty() @ArrayMaxSize(5) storeIds!: string[] }',
      errors: [{ messageId: 'arrayUnique' }],
    },
    // A bare throw, in an arrow and in a function expression.
    {
      code: "class D { @Transform(({ value }) => { if (!value) throw new Error('x'); return value; }) @IsString() name!: string }",
      errors: [{ messageId: 'transformThrows' }],
    },
    {
      code: "class D { @Transform(function ({ value }) { if (!value) throw new Error('x'); return value; }) @IsString() name!: string }",
      errors: [{ messageId: 'transformThrows' }],
    },
    {
      code: zod('updated_at: z.string()'),
      errors: [
        {
          messageId: 'instant',
          data: { field: 'updated_at', validator: '`z.string()`', from: '' },
        },
      ],
    },
    {
      code: "import { z } from 'zod';\nz.strictObject({ sku_id: z.string() });",
      errors: [{ messageId: 'blankId' }],
    },
    {
      code: "import { z } from 'zod';\nz.looseObject({ sku_id: z.string() });",
      errors: [{ messageId: 'blankId' }],
    },
  ],
});

interface RuleMeta {
  meta: {
    type: string;
    docs: { description: string };
    messages: Record<string, string>;
  };
}

/** Each message's remedy, which RuleTester's messageId checks never read. */
const MESSAGES: Record<string, string> = {
  blankId: '@IsNotEmpty()',
  phone: '@Matches(<phone pattern>)',
  arrayMin: '@ArrayNotEmpty()',
  arrayMax: '@ArrayMaxSize(n)',
  arrayUnique: '@ArrayUnique()',
  numericType: '@Type(() => Number)',
  numericNotEmpty: '@IsDefined()',
  pageMax: '@Max(n)',
  transformThrows: 'keep @Transform total',
  instant: '@IsInstant()',
};

describe('dto-field-constraints meta', () => {
  const { meta } = rule as RuleMeta;

  it('reports problems and names the remedy in each text', () => {
    assert.equal(meta.type, 'problem');
    assert.ok(meta.docs.description.includes('constraint their shape implies'));
    assert.deepEqual(
      Object.keys(meta.messages).sort(),
      Object.keys(MESSAGES).sort(),
    );
    for (const [messageId, remedy] of Object.entries(MESSAGES)) {
      assert.ok(meta.messages[messageId].includes(remedy));
    }
  });

  const linter = new Linter({ cwd: '/repo' });
  const lint = (code: string, entry: Linter.RuleEntry) =>
    linter.verify(
      code,
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { b: { rules: { 'dto-field-constraints': rule } } },
        rules: { 'b/dto-field-constraints': entry },
      },
      '/repo/x.dto.ts',
    );

  it('names the configured @IsInstant() module in the instant remedy', () => {
    const [message] = lint('class D { @IsISO8601() occurred_at!: string }', [
      'error',
      { instantDecoratorModule: 'common/validation' },
    ]);
    assert.equal(
      message?.message,
      '`occurred_at` is an instant, but @IsISO8601() accepts a timestamp without a zone, which `new Date` reads in server time. Use @IsInstant() from common/validation (zod: `.datetime({ offset: true })`) (VAL-03).',
    );
  });

  it('names no module when none is configured', () => {
    const [message] = lint(
      "import { z } from 'zod';\nz.object({ occurred_at: z.string() });",
      'error',
    );
    assert.equal(
      message?.message,
      '`occurred_at` is an instant, but `z.string()` accepts a timestamp without a zone, which `new Date` reads in server time. Use @IsInstant() (zod: `.datetime({ offset: true })`) (VAL-03).',
    );
  });

  it('refuses an unknown option', () => {
    assert.throws(
      () => lint('', ['error', { extra: true }]),
      /additional properties/,
    );
  });
});
