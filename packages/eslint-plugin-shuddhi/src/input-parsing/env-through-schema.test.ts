import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import rule, { DEFAULT_HINTS } from './env-through-schema.js';

/**
 * VAL-06 (+ EDGE-03's process.env clause) `env-through-schema`. The first
 * invalid case is the catalogue example (the code a reviewer reported,
 * reduced to the smallest shape that still reproduces it), followed by the
 * corrected code and near-misses that must stay valid.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

// ---------------------------------------------------------------------------
// VAL-06: a blank first variable masked the second behind `??`.

/** Every coercion the rule reports when applied to process.env directly. */
const ENV_COERCIONS = [
  'Number',
  'parseInt',
  'parseFloat',
  'Boolean',
  'Number.parseInt',
  'Number.parseFloat',
];

/** Value-preserving wrappers the rule climbs through to the coercion. */
const ENV_WRAPPED_READS = [
  'process.env?.PORT',
  'process.env.PORT!',
  'process.env.PORT satisfies string | undefined',
  // A type assertion keeps the runtime value.
  'process.env.PORT as string',
  '<string>process.env.PORT',
];

ruleTester.run('env-through-schema', rule as never, {
  valid: [
    // The fix: blank is unset, so ?? falls through to the second variable.
    {
      code: "const url = readEnv('HARNESS_DB_URL') ?? readEnv('DATABASE_URL');",
    },
    { code: 'const config = parseEnv(shape, process.env);' },
    // Near-miss: writes and deletes configure the environment.
    { code: "process.env.NODE_ENV = 'test'; delete process.env.CI;" },
    // Near-miss: handing the whole environment to a child process.
    { code: "spawn('git', args, { env: { ...process.env, GIT_DIR: dir } });" },
    // Near-miss: an untyped get is a string, which is what it returns.
    { code: "const name = this.configService.get('APP_NAME');" },
    { code: "const port = this.configService.get<string>('PORT');" },
    // Near-miss: an env-schema module may read literally (bundlers inline only
    // `process.env.X`), and `||` there already treats blank as unset.
    {
      code: "export const apiHost = () => process.env.APP_API_HOST || 'localhost';",
      options: [{ allowDirectRead: true }],
    },
    // Near-miss: an increment writes the environment.
    { code: 'process.env.COUNT++;' },
    // Near-miss: the whole environment bound to a name (only destructuring
    // reads variables out of it).
    { code: 'const env = process.env;' },
    // Near-miss: a typed `get` on something that is not a config receiver.
    { code: "const ttl = this.get<number>('TTL');" },
    // Near-miss: destructuring where direct reads are allowed.
    {
      code: 'const { CI, HOME } = process.env;',
      options: [{ allowDirectRead: true }],
    },
  ],
  invalid: [
    ...ENV_COERCIONS.map(coercion => ({
      code: `const n = ${coercion}(process.env.LIMIT);`,
      errors: [{ messageId: 'coerced' as const }],
    })),
    ...ENV_WRAPPED_READS.map(read => ({
      code: `const port = Number(${read});`,
      errors: [{ messageId: 'coerced' as const }],
    })),
    {
      code: 'if (process.env.CI === void 0) skip();',
      errors: [{ messageId: 'presence' }],
    },
    {
      code: 'if (process.env.CI == null) skip();',
      errors: [{ messageId: 'presence' }],
    },
    // A negative number is not a nullish or empty value; unary minus is not
    // the `+` coercion; `+ ''` is concatenation, not a comparison.
    {
      code: 'if (process.env.N === -1) go();',
      errors: [{ messageId: 'direct' }],
    },
    {
      code: 'const n = -process.env.LIMIT;',
      errors: [{ messageId: 'direct' }],
    },
    {
      code: "const s = process.env.N + '';",
      errors: [{ messageId: 'direct' }],
    },
    // The catalogue example: a blank first variable masks the second.
    {
      code: 'const databaseUrl = process.env.HARNESS_DB_URL ?? process.env.DATABASE_URL;',
      errors: [{ messageId: 'fallback' }, { messageId: 'direct' }],
    },
    // Still the fallback shape inside an env-schema module.
    {
      code: 'return process.env.APP_API_PORT ?? DEV_DEFAULT_PORT;',
      options: [{ allowDirectRead: true }],
      languageOptions: {
        parserOptions: { ecmaFeatures: { globalReturn: true } },
      },
      errors: [{ messageId: 'fallback' }],
    },
    {
      code: 'const port = Number(process.env.PORT);',
      errors: [{ messageId: 'coerced' }],
    },
    // An asserted read is still a coercion where direct reads are allowed.
    {
      code: 'const port = Number(process.env.PORT as string);',
      options: [{ allowDirectRead: true }],
      errors: [{ messageId: 'coerced' }],
    },
    {
      code: 'const workers = parseInt(process.env.WORKERS ?? "4", 10);',
      errors: [{ messageId: 'fallback' }],
    },
    {
      code: 'const n = +process.env.LIMIT;',
      errors: [{ messageId: 'coerced' }],
    },
    {
      code: 'const n = Number.parseFloat(process.env.RATIO!);',
      errors: [{ messageId: 'coerced' }],
    },
    {
      code: 'const on = process.env.FEATURE !== undefined;',
      errors: [{ messageId: 'presence' }],
    },
    {
      code: "if (process.env.CI === '') skip();",
      errors: [{ messageId: 'presence' }],
    },
    {
      code: 'if (null != process.env.CI) go();',
      errors: [{ messageId: 'presence' }],
    },
    { code: 'const ci = process.env.CI;', errors: [{ messageId: 'direct' }] },
    {
      code: "const ci = process.env['CI'];",
      errors: [{ messageId: 'direct' }],
    },
    {
      code: 'const { CI, HOME } = process.env;',
      errors: [{ messageId: 'direct' }],
    },
    {
      code: "const enabled = this.configService.get<boolean>('FEATURE_X');",
      errors: [
        {
          messageId: 'typedConfigGet',
          data: {
            method: 'get',
            type: 'boolean',
            hint: DEFAULT_HINTS.typedConfigGet,
          },
        },
      ],
    },
    {
      code: "const ttl = config.getOrThrow<number>('TTL');",
      errors: [
        {
          messageId: 'typedConfigGet',
          data: {
            method: 'getOrThrow',
            type: 'number',
            hint: DEFAULT_HINTS.typedConfigGet,
          },
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

/** The remedy each default hint names; the message ids are the complete set. */
const MESSAGES: Record<string, string> = {
  coerced: 'typed env schema',
  fallback: 'treats blank as unset',
  presence: 'treats blank as unset',
  direct: 'typed env schema',
  typedConfigGet: 'env schema',
};

/** The product-shaped hints: helper names and paths a caller passes. */
const CALLER_HINTS = {
  coerced:
    'Declare it with `env.integer({ min, max })` / `env.number(...)` and `parseEnv` (shared parsing/env; tooling: lib/env.ts).',
  fallback: 'Use `readEnv(...)`, which treats blank as unset.',
  presence: 'Use `readEnv(...)` or `env.flag()`.',
  direct:
    'Read environment variables through `readEnv` / `parseEnv` (shared parsing/env; tooling: lib/env.ts) so blank, padded and malformed values fail at startup.',
  typedConfigGet:
    'Validate with an env schema (`env.flag()`, `env.integer(...)`).',
};

const linter = new Linter({ configType: 'flat' });
const verify = (code: string, option?: Record<string, unknown>) =>
  linter.verify(code, {
    languageOptions: { parser: tseslint.parser },
    plugins: { parse: { rules: { 'env-through-schema': rule as never } } },
    rules: {
      'parse/env-through-schema': (option
        ? ['error', option]
        : 'error') as never,
    },
  });

describe('env-through-schema meta', () => {
  const { meta } = rule as RuleMeta;

  it('is a problem rule whose texts name the fix', () => {
    assert.equal(meta.type, 'problem');
    assert.ok(meta.docs.description.includes('typed env helpers'));
    assert.deepEqual(
      Object.keys(meta.messages).sort(),
      Object.keys(MESSAGES).sort(),
    );
    assert.deepEqual(
      Object.keys(DEFAULT_HINTS).sort(),
      Object.keys(MESSAGES).sort(),
    );
    for (const [id, remedy] of Object.entries(MESSAGES)) {
      assert.ok(meta.messages[id]?.endsWith('{{hint}}'), id);
      assert.ok(
        DEFAULT_HINTS[id as keyof typeof DEFAULT_HINTS].includes(remedy),
        id,
      );
    }
  });

  it('rejects an unknown option', () => {
    assert.deepEqual(verify('const x = 1;', { allowDirectRead: true }), []);
    assert.throws(
      () =>
        verify('const x = 1;', {
          allowDirectRead: true,
          allowEverything: true,
        }),
      /additional properties/,
    );
  });

  it('renders caller hints in place of the defaults', () => {
    const code = [
      'Number(process.env.A);',
      'process.env.B ?? c;',
      'process.env.D === undefined;',
      'process.env.E;',
      "config.get<number>('F');",
    ].join('\n');
    assert.deepEqual(
      verify(code, { hints: CALLER_HINTS }).map(message => message.message),
      [
        'Coercing `process.env` directly turns blank into 0, `abc` into NaN and `1e9` into a billion, and none of them fails until used. Declare it with `env.integer({ min, max })` / `env.number(...)` and `parseEnv` (shared parsing/env; tooling: lib/env.ts).',
        '`process.env.X ?? fallback` keeps a BLANK `X`, so it masks the fallback (a blank HARNESS_DB_URL once masked DATABASE_URL). Use `readEnv(...)`, which treats blank as unset.',
        'Comparing `process.env.X` with undefined/null/"" decides presence by spelling: `X=` and `X=false` both read as set. Use `readEnv(...)` or `env.flag()`.',
        'Read environment variables through `readEnv` / `parseEnv` (shared parsing/env; tooling: lib/env.ts) so blank, padded and malformed values fail at startup.',
        '`get<number>()` only ASSERTS the type: ConfigService returns the raw string, so "false" is truthy and "abc" is a number. Validate with an env schema (`env.flag()`, `env.integer(...)`).',
      ],
    );
  });

  it('keeps the default hints for messages a caller leaves out', () => {
    const [message] = verify('process.env.E;', {
      hints: { coerced: 'x' },
    });
    assert.equal(message?.message, DEFAULT_HINTS.direct);
  });
});
