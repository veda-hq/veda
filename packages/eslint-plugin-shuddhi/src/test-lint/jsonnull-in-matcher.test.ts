import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin, { rules } from './index.js';

/**
 * TEST-WEAK-03 (jsonnull-in-matcher): the cases for `jsonnull-in-matcher.js`,
 * the module this suite owns.
 *
 * Each `invalid` case is the lesson's shape, reduced: a Prisma null sentinel
 * inside a partial matcher. Each `valid` case is the corrected code or a near
 * miss. The `guard removal` block deletes only the guard from a corrected
 * case and proves the rule fires again.
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

const TEST_FILE = 'probe.test.ts';
const PRISMA = `import { Prisma } from '@prisma/client';\n`;

const at = (name: string, messageId = 'toMatchObject') => ({
  messageId,
  data: { name },
});

ruleTester.run('jsonnull-in-matcher', rules['jsonnull-in-matcher']!, {
  valid: [
    // Corrected: the field asserted directly, by identity.
    {
      filename: TEST_FILE,
      code: `${PRISMA}expect(row.meta).toBe(Prisma.JsonNull);
      expect(row).toMatchObject({ id: 'r1' });`,
    },
    // toStrictEqual compares the instance's class.
    {
      filename: TEST_FILE,
      code: `${PRISMA}expect(row).toStrictEqual({ meta: Prisma.DbNull });`,
    },
    // A sentinel outside any partial matcher, or under another matcher.
    {
      filename: TEST_FILE,
      code: `${PRISMA}await prisma.row.update({ data: { meta: Prisma.JsonNull } });
      expect(rows).toContain(Prisma.AnyNull);
      expect(row).toHaveProperty('meta', Prisma.JsonNull);
      expect(list).toEqual(expect.arrayContaining([Prisma.DbNull]));`,
    },
    // A nested call is not descended into: it is checked as its own matcher.
    {
      filename: TEST_FILE,
      code: `${PRISMA}expect(row).toMatchObject({ meta: wrap(Prisma.JsonNull) });`,
    },
    // Other properties of Prisma, or JsonNull on another object.
    {
      filename: TEST_FILE,
      code: `${PRISMA}expect(row).toMatchObject({ a: Prisma.Decimal, b: other.JsonNull, c: Prisma[key], d: Prisma.Prisma });`,
    },
    // A bare identifier that is not the sentinel: a parameter, a local, an
    // import from another module, a default import, a destructuring of
    // something else, a computed or non-sentinel key, a renamed other key.
    {
      filename: TEST_FILE,
      code: `import JsonNull from '@prisma/client';
      import { DbNull } from './nulls';
      import * as AnyNull from '@prisma/client';
      import { Decimal } from '@prisma/client';
      const { JsonNull: other } = Runtime;
      const { [key]: dynamic } = Prisma;
      const { Decimal: money } = Prisma;
      const [first] = Prisma;
      function check(nil: unknown) { expect(row).toMatchObject({ meta: nil }); }
      expect(row).toMatchObject({ a: JsonNull, b: DbNull, c: AnyNull, d: other, e: dynamic, f: money, g: first, h: Decimal, i: undeclared });`,
    },
    // A binding that is not a single const is not followed.
    {
      filename: TEST_FILE,
      code: `${PRISMA}let expected = { meta: Prisma.JsonNull };
      expect(row).toMatchObject(expected);`,
    },
    // Bindings are followed three deep, no further.
    {
      filename: TEST_FILE,
      code: `${PRISMA}const e1 = { meta: Prisma.JsonNull }; const e2 = e1; const e3 = e2; const e4 = e3;
      expect(row).toMatchObject(e4);`,
    },
    // A call with no arguments, holes in an array.
    {
      filename: TEST_FILE,
      code: `expect(row).toMatchObject();
      expect(rows).toMatchObject([, { id: 1 }]);`,
    },
  ],
  invalid: [
    // The lesson: toMatchObject passes for any stored value.
    {
      filename: TEST_FILE,
      code: `${PRISMA}expect(row).toMatchObject({ id: 'r1', meta: Prisma.JsonNull });`,
      errors: [at('JsonNull')],
    },
    // DbNull and AnyNull, nested in objects and arrays, behind casts.
    {
      filename: TEST_FILE,
      code: `${PRISMA}expect(result).toMatchObject({
        rows: [{ meta: Prisma.DbNull }, ...[Prisma.AnyNull]],
        nested: { deep: { meta: (Prisma.JsonNull as unknown) } },
        ...{ spread: Prisma.DbNull },
      });`,
      errors: [at('DbNull'), at('AnyNull'), at('JsonNull'), at('DbNull')],
    },
    // objectContaining, alone, under toEqual and under toHaveBeenCalledWith,
    // negated, and inside toMatchObject (reported once, by the inner call).
    {
      filename: TEST_FILE,
      code: `${PRISMA}expect(row).toEqual(expect.objectContaining({ meta: Prisma.JsonNull }));
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { meta: Prisma.DbNull } }));
      expect(row).toEqual(expect.not.objectContaining({ meta: Prisma.AnyNull }));
      expect(row).toMatchObject({ a: expect.objectContaining({ meta: Prisma.JsonNull }) });`,
      errors: [
        at('JsonNull', 'objectContaining'),
        at('DbNull', 'objectContaining'),
        at('AnyNull', 'objectContaining'),
        at('JsonNull', 'objectContaining'),
      ],
    },
    // .resolves and .not reach the same matcher; the sentinel as the whole argument.
    {
      filename: TEST_FILE,
      code: `${PRISMA}await expect(load()).resolves.toMatchObject({ meta: Prisma.JsonNull });
      expect(row).not.toMatchObject({ meta: Prisma.DbNull });
      expect(row.meta).toMatchObject(Prisma.JsonNull);`,
      errors: [at('JsonNull'), at('DbNull'), at('JsonNull')],
    },
    // Through const bindings; one sentinel two matchers reach is reported once.
    {
      filename: TEST_FILE,
      code: `${PRISMA}const nil = Prisma.JsonNull;
      const expected = { meta: nil };
      const alias = expected;
      expect(a).toMatchObject(alias);
      expect(b).toMatchObject(expected);`,
      errors: [at('JsonNull')],
    },
    // Bare sentinels: named imports from @prisma/client (renamed, or from a
    // subpath) and destructurings of Prisma.
    {
      filename: TEST_FILE,
      code: `import { JsonNull, DbNull as dbNull } from '@prisma/client';
      import { AnyNull } from '@prisma/client/runtime/library';
      import { Prisma } from '@prisma/client';
      const { JsonNull: jsonNull, DbNull } = Prisma;
      expect(row).toMatchObject({ a: JsonNull, b: dbNull, c: AnyNull, d: jsonNull, e: DbNull });`,
      errors: [
        at('JsonNull'),
        at('DbNull'),
        at('AnyNull'),
        at('JsonNull'),
        at('DbNull'),
      ],
    },
    // A string-named import specifier.
    {
      filename: TEST_FILE,
      code: `import { "JsonNull" as nil } from '@prisma/client';
      expect(row).toMatchObject({ meta: nil });`,
      errors: [at('JsonNull')],
    },
    // Prisma behind a non-null assertion, a computed string key.
    {
      filename: TEST_FILE,
      code: `${PRISMA}expect(row).toMatchObject({ meta: Prisma!['DbNull'] });`,
      errors: [at('DbNull')],
    },
  ],
});

// ---------------------------------------------------------------------------
// Deleting the guard from a corrected case brings the rule back
// ---------------------------------------------------------------------------

function messageIds(code: string): string[] {
  return new Linter({ configType: 'flat' })
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          plugins: { shuddhi: plugin },
          rules: { 'shuddhi/jsonnull-in-matcher': 'error' },
        },
      ],
      TEST_FILE,
    )
    .map(message => message.messageId ?? message.message);
}

describe('guard removal flips each corrected case', () => {
  it('jsonnull-in-matcher/toMatchObject', () => {
    const corrected = `${PRISMA}expect(row.meta).toBe(Prisma.JsonNull);`;
    assert.deepEqual(messageIds(corrected), []);
    const broken = corrected.replace(
      'expect(row.meta).toBe(Prisma.JsonNull)',
      'expect(row).toMatchObject({ meta: Prisma.JsonNull })',
    );
    assert.notEqual(broken, corrected);
    assert.deepEqual(messageIds(broken), ['toMatchObject']);
  });
});

describe('jsonnull-in-matcher rule metadata', () => {
  it('states the rule, its catalogue id and its messages verbatim', () => {
    assert.deepEqual(rules['jsonnull-in-matcher']?.meta, {
      type: 'problem',
      docs: {
        description:
          'A Prisma null sentinel inside toMatchObject or objectContaining, where it has no keys to compare (TEST-WEAK-03)',
      },
      schema: [],
      messages: {
        toMatchObject:
          'Prisma.{{name}} matches any value inside toMatchObject (it has no enumerable keys). Assert the field on its own: expect(data.col).toBe(Prisma.{{name}}) for a value given to Prisma, expect(row.col).toBeNull() for a row read back.',
        objectContaining:
          'Prisma.{{name}} matches any object without keys inside objectContaining (it has no enumerable keys), so Prisma.DbNull, Prisma.JsonNull and {} all pass. Assert the field on its own: expect(data.col).toBe(Prisma.{{name}}) for a value given to Prisma, expect(row.col).toBeNull() for a row read back.',
      },
    });
  });
});
