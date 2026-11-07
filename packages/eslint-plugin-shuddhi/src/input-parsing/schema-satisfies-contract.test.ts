import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';

import rule from './schema-satisfies-contract.js';

/**
 * VAL-09 (`satisfies z.ZodType<Producer>`)
 * `schema-satisfies-contract`. The first invalid case is the catalogue example
 * (the code a reviewer reported, reduced to the smallest shape that still reproduces
 * it), followed by the corrected code and near-misses that must stay valid.
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

// VAL-09, schema half: the schema must be tied to the producer's type, or the
// parse above checks a shape the producer no longer writes.

/** Zod type names that tie a schema to its contract type. */
const ZOD_TYPE_NAME_LIST = ['ZodType', 'ZodSchema', 'Schema', 'ZodTypeAny'];
/** Zod helpers that derive a type FROM a schema. */
const ZOD_DERIVATION_LIST = ['infer', 'input', 'output', 'TypeOf'];
const LEASE = `
  import { z } from 'zod';
  export type Lease = { id: string };`;

ruleTester.run('schema-satisfies-contract', rule as never, {
  valid: [
    ...ZOD_TYPE_NAME_LIST.map(name => ({
      code: `${LEASE} export const leaseSchema = z.object({ id: z.string() }) satisfies z.${name}<Lease>;`,
    })),
    ...ZOD_DERIVATION_LIST.map(derivation => ({
      code: `
        import { z } from 'zod';
        export const auditSchema = z.strictObject({ id: z.string() });
        export type Audit = z.${derivation}<typeof auditSchema>;`,
    })),
    // An unqualified derivation (`import { TypeOf } from 'zod'`).
    {
      code: `
        import { z, TypeOf } from 'zod';
        export const workSchema = z.strictObject({ id: z.string() });
        export type Work = TypeOf<typeof workSchema>;`,
    },
    // Near-miss: an ambient declaration (no value) and a mutable binding.
    { code: `${LEASE} export declare const leaseSchema: Foo;` },
    {
      code: `${LEASE} export let leaseSchema = z.object({ id: z.string() });`,
    },
    // The fix.
    {
      code: `
        import { z } from 'zod';
        export interface HistoryRecord { ts: string; mode: 'full' | 'diff' }
        export const historyRecordSchema = z
          .object({ ts: z.string(), mode: z.enum(['full', 'diff']) })
          .strict() satisfies z.ZodType<HistoryRecord>;`,
    },
    // An annotation also makes the compiler check it (recursive z.lazy).
    {
      code: `
        import { z } from 'zod';
        import type { ConditionGroup } from './types';
        export const conditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(() => z.object({}));`,
    },
    // Near-miss: the type is derived FROM the schema (one source of truth).
    {
      code: `
        import { z } from 'zod';
        export const workSchema = z.strictObject({ id: z.string() });
        export type Work = z.infer<typeof workSchema>;`,
    },
    // Near-miss: no contract type of that name; a module-private schema;
    // not a zod value.
    {
      code: `
        import { z } from 'zod';
        export const pageQuerySchema = z.object({ page: z.number() });`,
    },
    {
      code: `
        import { z } from 'zod';
        interface Lease { id: string }
        const leaseSchema = z.object({ id: z.string() });`,
    },
    {
      code: `
        interface Lease { id: string }
        export const leaseSchema = makeSchema();`,
    },
    // Near-miss: a namespace import names a module, not a contract type.
    {
      code: `
        import { z } from 'zod';
        import type * as Lease from './lease';
        export const leaseSchema = z.object({ id: z.string() });`,
    },
    // Near-miss: a default export with no name exports no declared schema.
    {
      code: `${LEASE} const leaseSchema = z.object({ id: z.string() }); export default leaseSchema.strict();`,
    },
  ],
  invalid: [
    // The ledger-line shape: the producer type and the parser's schema are
    // declared side by side with nothing tying them together.
    {
      code: `
        import { z } from 'zod';
        export interface HistoryRecord { ts: string; mode: 'full' | 'diff'; runs: number }
        export const historyRecordSchema = z.object({ ts: z.string(), mode: z.enum(['full', 'diff']) });`,
      errors: [
        {
          messageId: 'missingSatisfies',
          data: { schema: 'historyRecordSchema', type: 'HistoryRecord' },
        },
      ],
    },
    // The contract type imported from the producer's module.
    {
      code: `
        import * as z from 'zod';
        import type { GuardrailCondition } from '../types';
        export const GuardrailConditionSchema = z.object({ field: z.string() }).strict();`,
      errors: [{ messageId: 'missingSatisfies' }],
    },
    // The contract type as a default import, and the schema
    // as the default export.
    {
      code: `
        import { z } from 'zod';
        import type Lease from './lease';
        export const leaseSchema = z.object({ id: z.string() });`,
      errors: [{ messageId: 'missingSatisfies' }],
    },
    {
      code: `
        import { z } from 'zod';
        type Lease = { id: string };
        const leaseSchema = z.object({ id: z.string() });
        export default leaseSchema;`,
      errors: [{ messageId: 'missingSatisfies' }],
    },
    // Exported later; `satisfies` against something that is not a zod type.
    {
      code: `
        import { z } from 'zod';
        type Lease = { id: string };
        const leaseSchema = z.object({ id: z.string() }) satisfies object;
        export { leaseSchema };`,
      errors: [{ messageId: 'missingSatisfies' }],
    },
    // A zod type that names no type, or another type,
    // ties the schema to nothing.
    {
      code: `
        import { z } from 'zod';
        export type Lease = { id: string };
        export const leaseSchema = z.object({ id: z.string() }) satisfies z.ZodTypeAny;`,
      errors: [{ messageId: 'missingSatisfies' }],
    },
    {
      code: `
        import { z } from 'zod';
        export type Lease = { id: string };
        type Other = { id: number };
        export const leaseSchema: z.ZodType<Other> = z.object({ id: z.number() });`,
      errors: [{ messageId: 'missingSatisfies' }],
    },
    // Another module's type of the same name.
    {
      code: `${LEASE} import type * as other from './other'; export const leaseSchema = z.object({ id: z.string() }) satisfies z.ZodType<other.Lease>;`,
      errors: [{ messageId: 'missingSatisfies' }],
    },
    // A generic that is not a zod type ties nothing.
    {
      code: `${LEASE} export const leaseSchema = z.object({ id: z.string() }) satisfies Readonly<Lease>;`,
      errors: [{ messageId: 'missingSatisfies' }],
    },
    // A contract type that is a generic, or a derivation of something else.
    {
      code: `
        import { z } from 'zod';
        export type Lease = Readonly<{ id: string }>;
        export const leaseSchema = z.object({ id: z.string() });`,
      errors: [{ messageId: 'missingSatisfies' }],
    },
    {
      code: `
        import { z } from 'zod';
        export type Lease = z.infer<Other>;
        export const leaseSchema = z.object({ id: z.string() });`,
      errors: [{ messageId: 'missingSatisfies' }],
    },
    // Zod reached through optional chaining, a cast, a namespace import,
    // or the conventional `z` with no import in view.
    {
      code: `${LEASE} export const leaseSchema = z?.object({ id: z.string() });`,
      errors: [{ messageId: 'missingSatisfies' }],
    },
    {
      code: `${LEASE} export const leaseSchema = z.object({ id: z.string() }) as unknown as Foo;`,
      errors: [{ messageId: 'missingSatisfies' }],
    },
    {
      code: `
        import * as zod from 'zod';
        export type Lease = { id: string };
        export const leaseSchema = zod.object({ id: zod.string() });`,
      errors: [{ messageId: 'missingSatisfies' }],
    },
    {
      code: `
        export type Lease = { id: string };
        export const leaseSchema = z.object({ id: z.string() });`,
      errors: [{ messageId: 'missingSatisfies' }],
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

/** The remedy each message names; the message ids are the complete set. */
const MESSAGES: Record<string, string> = {
  missingSatisfies: 'z.infer<typeof {{schema}}>',
};

describe('schema-satisfies-contract meta', () => {
  const { meta } = rule as RuleMeta;

  it('is a problem rule whose texts name the fix', () => {
    assert.equal(meta.type, 'problem');
    assert.ok(meta.docs.description.includes('satisfies z.ZodType<Type>'));
    assert.deepEqual(
      Object.keys(meta.messages).sort(),
      Object.keys(MESSAGES).sort(),
    );
    for (const [id, remedy] of Object.entries(MESSAGES)) {
      assert.ok(meta.messages[id]?.includes(remedy), id);
    }
  });
});
