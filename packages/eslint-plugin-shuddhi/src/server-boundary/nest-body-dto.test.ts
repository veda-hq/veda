import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';

import rule from './nest-body-dto.js';

/**
 * VAL-01 `nest-body-dto`. The catalogue
 * example, reduced to the smallest shape that still reproduces it, fails for
 * its own messageId; the corrected code and at least one near-miss pass; and
 * deleting only the guard from the corrected code fails again ("guard removal
 * flips").
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const FIXTURES = join(import.meta.dirname, 'fixtures');

const tester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

const typedTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      // fixtures/tsconfig.json owns file.ts and body-dtos.ts.
      projectService: true,
      tsconfigRootDir: FIXTURES,
    },
  },
});

/** Remove exactly one occurrence of `guard`, failing loudly if absent. */
function withoutGuard(code: string, guard: string): string {
  if (!code.includes(guard)) throw new Error(`guard not in code: ${guard}`);
  return code.replace(guard, '');
}

// ---------------------------------------------------------------------------
// VAL-01 — nest-body-dto

/** A commission controller as reviewers found it: an inline @Body type. */
const VAL01_EXAMPLE = `
@Controller('admin/commission-agreements')
export class CommissionController {
  @Post()
  async create(
    @Body()
    body: {
      brandId: string;
      productLine: ProductLine;
    },
  ): Promise<unknown> {
    return this.commissionService.create(body);
  }
}`;

/** The fix: a DTO class whose fields carry class-validator decorators. */
const VAL01_CORRECTED = `
class CreateAgreementDto {
  @IsUUID()
  brandId!: string;

  @IsEnum(ProductLine)
  productLine!: ProductLine;
}

@Controller('admin/commission-agreements')
export class CommissionController {
  @Post()
  async create(@Body() body: CreateAgreementDto): Promise<unknown> {
    return this.commissionService.create(body);
  }
}`;

tester.run('nest-body-dto', rule, {
  valid: [
    { code: VAL01_CORRECTED },
    // Near-miss: an array body is fine when a parsing pipe validates items.
    {
      code: `@Controller() class C {
        @Post() bulk(@Body(new ParseArrayPipe({ items: ItemDto })) items: ItemDto[]) {}
      }`,
    },
    // Near-miss: a named field with its own pipe.
    {
      code: `@Controller() class C {
        @Post() one(@Body('id', ParseUUIDPipe) id: string) {}
      }`,
    },
    // Not a controller: a plain service method's parameter is not a body.
    { code: 'class S { run(@Body() body: { a: string }) {} }' },
    // @Query is out of scope for this rule.
    {
      code: '@Controller() class C { @Get() list(@Query() q: { a: string }) {} }',
    },
    // Imported class without type information: the rule cannot judge it.
    {
      code: `import { CreateDto } from './dto';
        @Controller() class C { @Post() create(@Body() dto: CreateDto) {} }`,
    },
    // An empty DTO plus forbidNonWhitelisted rejects every field: validated.
    {
      code: '@Controller() class C { @Post() ping(@Body() b: Empty) {} } class Empty {}',
    },
    // A mapped-type base carries the decorators.
    {
      code: `class UpdateDto extends PartialType(CreateDto) { note!: string }
        @Controller() class C { @Patch() update(@Body() dto: UpdateDto) {} }`,
    },
    // A generic DTO class declared in this file reaches the pipe as its class.
    {
      code: `class PageDto<T> { @IsString() cursor!: string; items!: T[] }
        @Controller() class C { @Post() list(@Body() page: PageDto<ItemDto>) {} }`,
    },
    // A base declared in this file carries the decorators.
    {
      code: `class BaseDto { @IsString() name!: string }
        class CreateDto extends BaseDto { note!: string }
        @Controller() class C { @Post() create(@Body() dto: CreateDto) {} }`,
    },
  ],
  invalid: [
    { code: VAL01_EXAMPLE, errors: [{ messageId: 'notClass' }] },
    // Guard removal: the corrected DTO without its decorators.
    {
      code: withoutGuard(
        withoutGuard(VAL01_CORRECTED, '@IsUUID()'),
        '@IsEnum(ProductLine)',
      ),
      errors: [{ messageId: 'undecorated' }],
    },
    // A hardware controller taking an interface body.
    {
      code: `interface HardwareAnalyticsEvent { event: string }
        @Controller('hardware') export class HardwareController {
          @Post('analytics') track(@Body() event: HardwareAnalyticsEvent) {}
        }`,
      errors: [{ messageId: 'notClass' }],
    },
    // A type alias named like a DTO.
    {
      code: `type CreateCampaignDto = { name: string };
        @Controller() class C { @Post() create(@Body() dto: CreateCampaignDto) {} }`,
      errors: [{ messageId: 'notClass' }],
    },
    {
      code: '@Controller() class C { @Post() create(@Body() body) {} }',
      errors: [{ messageId: 'untyped' }],
    },
    {
      code: "@Controller() class C { @Post() s(@Body('status') status: string) {} }",
      errors: [{ messageId: 'notClass' }],
    },
    {
      code: '@Controller() class C { @Post() m(@Body() b: Record<string, unknown>) {} }',
      errors: [{ messageId: 'notClass' }],
    },
    {
      code: '@Controller() class C { @Post() m(@Body() b: Partial<CreateDto>) {} }',
      errors: [{ messageId: 'notClass' }],
    },
    {
      code: '@Controller() class C { @Post() m(@Body() b: CreateDto[]) {} }',
      errors: [{ messageId: 'notClass' }],
    },
    {
      code: '@Controller() class C { @Post() m(@Body() b: unknown) {} }',
      errors: [{ messageId: 'notClass' }],
    },
    {
      code: `import type { CreateDto } from './dto';
        @Controller() class C { @Post() m(@Body() b: CreateDto) {} }`,
      errors: [{ messageId: 'typeOnly' }],
    },
    {
      code: `import { type CreateDto } from './dto';
        @Controller() class C { @Post() m(@Body() b: CreateDto) {} }`,
      errors: [{ messageId: 'typeOnly' }],
    },
    // A Swagger-only decorator validates nothing.
    {
      code: `class Dto { @ApiProperty() name!: string }
        @Controller() class C { @Post() m(@Body() b: Dto) {} }`,
      errors: [{ messageId: 'undecorated' }],
    },
    // A generic interface in this file is erased whatever its argument.
    {
      code: `interface Envelope<T> { data: T }
        @Controller() class C { @Post() m(@Body() b: Envelope<ItemDto>) {} }`,
      errors: [{ messageId: 'notClass' }],
    },
    // Guard removal: the generic DTO class above without its decorator.
    {
      code: withoutGuard(
        `class PageDto<T> { @IsString() cursor!: string; items!: T[] }
        @Controller() class C { @Post() list(@Body() page: PageDto<ItemDto>) {} }`,
        '@IsString()',
      ),
      errors: [{ messageId: 'undecorated' }],
    },
    // A subclass of an undecorated base in this file validates nothing either.
    {
      code: `class BaseDto { name!: string }
        class CreateDto extends BaseDto {}
        @Controller() class C { @Post() create(@Body() dto: CreateDto) {} }`,
      errors: [{ messageId: 'undecorated' }],
    },
    // Guard removal: the validated base above without its decorator.
    {
      code: withoutGuard(
        `class BaseDto { @IsString() name!: string }
        class CreateDto extends BaseDto { note!: string }
        @Controller() class C { @Post() create(@Body() dto: CreateDto) {} }`,
        '@IsString()',
      ),
      errors: [{ messageId: 'undecorated' }],
    },
    // A base cycle ends at the first repeat.
    {
      code: `class ADto extends BDto { a!: string }
        class BDto extends ADto { b!: string }
        @Controller() class C { @Post() create(@Body() dto: ADto) {} }`,
      errors: [{ messageId: 'undecorated' }],
    },
  ],
});

/** Typed: the DTO lives in another module, resolved by the checker. */
const typedCase = (type: string, imports: string = type): string => `
import { ${imports} } from './body-dtos';
declare function Controller(): ClassDecorator;
declare function Post(): MethodDecorator;
declare function Body(): ParameterDecorator;
@Controller()
export class TypedController {
  @Post()
  create(@Body() body: ${type}): unknown {
    return body;
  }
}`;

const FILE = join(FIXTURES, 'file.ts');

typedTester.run('nest-body-dto (typed, cross-file)', rule, {
  valid: [
    { code: typedCase('DecoratedDto'), filename: FILE },
    { code: typedCase('ChildDto'), filename: FILE },
    // A generic DTO class reaches the pipe as its class.
    {
      code: typedCase('PageDto<DecoratedDto>', 'PageDto, DecoratedDto'),
      filename: FILE,
    },
  ],
  invalid: [
    {
      code: typedCase('Envelope<DecoratedDto>', 'Envelope, DecoratedDto'),
      filename: FILE,
      errors: [
        {
          messageId: 'notClass',
          data: { method: 'create', kind: 'the interface `Envelope`' },
        },
      ],
    },
    {
      code: typedCase('UndecoratedDto'),
      filename: FILE,
      errors: [{ messageId: 'undecorated' }],
    },
    {
      code: typedCase('DocumentedOnlyDto'),
      filename: FILE,
      errors: [{ messageId: 'undecorated' }],
    },
    {
      code: typedCase('BodyShape'),
      filename: FILE,
      errors: [
        {
          messageId: 'notClass',
          data: { method: 'create', kind: 'the interface `BodyShape`' },
        },
      ],
    },
    {
      code: typedCase('AliasShape'),
      filename: FILE,
      errors: [
        {
          messageId: 'notClass',
          data: { method: 'create', kind: 'the type alias `AliasShape`' },
        },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// Branch and vocabulary coverage (cases that kill mutation survivors).
//
// Each case below targets one input on which the rule and a one-token change
// to it disagree: every entry of a vocabulary list, both sides of each
// AST predicate, and the meta texts RuleTester never reads.

/** A @Body() of type `type` on a controller method `m`. */
const bodyOf = (type: string, decls = ''): string =>
  `${decls}\n@Controller() class C { @Post() m(@Body() b: ${type}) {} }`;

/** Mirrors OPAQUE_GENERICS: a bare (argument-less) reference still erases. */
const OPAQUE_GENERIC_NAMES = [
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
];

/** Mirrors NON_VALIDATING_DECORATORS. */
const NON_VALIDATING_NAMES = [
  'ApiProperty',
  'ApiPropertyOptional',
  'ApiHideProperty',
  'Expose',
  'Exclude',
  'Type',
  'Transform',
];

tester.run('nest-body-dto (vocabulary)', rule, {
  valid: [],
  invalid: [
    ...OPAQUE_GENERIC_NAMES.map(name => ({
      code: bodyOf(name),
      errors: [
        { messageId: 'notClass', data: { method: 'm', kind: `\`${name}\`` } },
      ],
    })),
    ...NON_VALIDATING_NAMES.map(name => ({
      code: bodyOf('Dto', `class Dto { @${name}() a!: string }`),
      errors: [
        { messageId: 'undecorated', data: { method: 'm', name: 'Dto' } },
      ],
    })),
  ],
});

tester.run('nest-body-dto (branches)', rule, {
  valid: [
    // A regex argument is not a field name: its text names a pipe.
    { code: bodyOf('{ a: string }').replace('@Body()', '@Body(/Pipe/)') },
    // A parameter property carries the decorator; its parameter has the type.
    {
      code: `class Dto { @IsString() a!: string }
        @Controller() class C { constructor(@Body() private readonly b: Dto) {} }`,
    },
  ],
  invalid: [
    // A non-pipe, non-string argument validates nothing.
    {
      code: bodyOf('{ a: string }').replace('@Body()', '@Body(options)'),
      errors: [
        {
          messageId: 'notClass',
          data: { method: 'm', kind: 'an inline type literal' },
        },
      ],
    },
    // A string argument that merely contains "Pipe" is a field name.
    {
      code: bodyOf('string').replace('@Body()', "@Body('ParsePipe')"),
      errors: [
        { messageId: 'notClass', data: { method: 'm', kind: '`string`' } },
      ],
    },
    {
      code: bodyOf('CreateDto[]'),
      errors: [
        {
          messageId: 'notClass',
          data: { method: 'm', kind: 'the array type `CreateDto[]`' },
        },
      ],
    },
    {
      code: bodyOf('[CreateDto]'),
      errors: [
        {
          messageId: 'notClass',
          data: { method: 'm', kind: 'the array type `[CreateDto]`' },
        },
      ],
    },
    // A qualified name through a type-only namespace import.
    {
      code: bodyOf('ns.CreateDto', "import type * as ns from './dto';"),
      errors: [
        { messageId: 'typeOnly', data: { method: 'm', name: 'CreateDto' } },
      ],
    },
    // A unicode-escaped reference names the same type-only import.
    {
      code: bodyOf('\\u0041Dto', "import type { ADto } from './dto';"),
      errors: [{ messageId: 'typeOnly', data: { method: 'm', name: 'ADto' } }],
    },
    {
      code: bodyOf('Shape', 'interface Shape { a: string }'),
      errors: [
        {
          messageId: 'notClass',
          data: { method: 'm', kind: 'the interface `Shape`' },
        },
      ],
    },
    {
      code: bodyOf('Shape', 'type Shape = { a: string };'),
      errors: [
        {
          messageId: 'notClass',
          data: { method: 'm', kind: 'the type alias `Shape`' },
        },
      ],
    },
    // A method named by a numeric literal has no name to report.
    {
      code: '@Controller() class C { @Post() 0(@Body() body) {} }',
      errors: [{ messageId: 'untyped', data: { method: 'handler' } }],
    },
  ],
});

/** Typed: the body type is declared in the case's own module. */
const typedInline = (decls: string, type: string): string => `
declare function Controller(): ClassDecorator;
declare function Post(): MethodDecorator;
declare function Body(): ParameterDecorator;
${decls}
@Controller()
export class TypedController {
  @Post()
  create(@Body() body: ${type}): unknown {
    return body;
  }
}`;

typedTester.run('nest-body-dto (typed, branches)', rule, {
  valid: [
    // A bare (uncalled) decorator still validates.
    {
      code: typedInline(
        'declare const IsString: PropertyDecorator;\nclass BareDto { @IsString name!: string }',
        'BareDto',
      ),
      filename: FILE,
    },
  ],
  invalid: [
    // A keyword modifier is not a decorator.
    {
      code: typedInline(
        'class ModifiedDto { public readonly name!: string }',
        'ModifiedDto',
      ),
      filename: FILE,
      errors: [
        {
          messageId: 'undecorated',
          data: { method: 'create', name: 'ModifiedDto' },
        },
      ],
    },
    {
      code: typedInline('enum Color { Red }', 'Color'),
      filename: FILE,
      errors: [
        {
          messageId: 'notClass',
          data: { method: 'create', kind: 'the non-class type `Color`' },
        },
      ],
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
  untyped: 'Declare a DTO class',
  notClass: 'pass a parsing pipe',
  undecorated: 'Decorate its fields',
  typeOnly: 'Import it as a value',
};

describe('nest-body-dto meta', () => {
  const { meta } = rule as RuleMeta;

  it('reports problems and names the remedy in each text', () => {
    assert.equal(meta.type, 'problem');
    assert.ok(meta.docs.description.includes('class-validator decorators'));
    assert.deepEqual(
      Object.keys(meta.messages).sort(),
      Object.keys(MESSAGES).sort(),
    );
    for (const [messageId, remedy] of Object.entries(MESSAGES)) {
      assert.ok(meta.messages[messageId].includes(remedy));
    }
  });
});
