import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';

import rule from './prisma-json-through-schema.js';

/**
 * VAL-09 (Prisma Json columns; typed only)
 * `prisma-json-through-schema`. The first invalid case is the catalogue example
 * (the code a reviewer reported, reduced to the smallest shape that still reproduces
 * it), followed by the corrected code and near-misses that must stay valid.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

/** This suite's directory, which holds fixtures/. */
const ROOT = dirname(fileURLToPath(import.meta.url));

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

/**
 * Type-aware: the shape a typed workspace lints with,
 * strict as such workspaces are (fixtures/tsconfig.json). A non-null
 * assertion only changes a type under strictNullChecks.
 */
const typedTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: {
        allowDefaultProject: ['*.ts'],
        defaultProject: 'fixtures/tsconfig.json',
      },
      tsconfigRootDir: ROOT,
    },
  },
});

// VAL-09, Prisma half: a Json column is JsonValue, not any, so
// no-unsafe-member-access never sees a field read on it.
const PRISMA_JSON = `
  type JsonObject = { [Key in string]?: JsonValue };
  interface JsonArray extends Array<JsonValue> {}
  type JsonValue = string | number | boolean | JsonObject | JsonArray | null;
  declare const row: { id: string; payload: JsonValue };
  declare const Schema: { parse(value: unknown): { kind: string } };
`;

typedTester.run('prisma-json-through-schema (typed)', rule as never, {
  valid: [
    // The fix: the column goes whole to a schema.
    { code: `${PRISMA_JSON} const event = Schema.parse(row.payload);` },
    // Near-miss: passed along whole, or widened honestly.
    {
      code: `${PRISMA_JSON} const text = JSON.stringify(row.payload); const id = row.id;`,
    },
    { code: `${PRISMA_JSON} const raw = row.payload as unknown;` },
    {
      code: `${PRISMA_JSON} const copy: JsonValue = row.payload; save(copy as JsonValue);`,
    },
    { code: `${PRISMA_JSON} const value = row.payload as Prisma.JsonValue;` },
    // Near-miss: an aliased type that is not a Json type.
    {
      code: 'type Shipment = { kind: string }; declare const s: Shipment; const k = s.kind;',
    },
    // Near-miss: `super` is not a value read, even of a Json-named base.
    {
      code: "class JsonObject { kind = ''; } class A extends JsonObject { f() { return super.toString(); } }",
    },
    // Near-miss: only the OUTERMOST cast of a chain is judged.
    {
      code: `${PRISMA_JSON} const value = row.payload as { kind: string } as unknown;`,
    },
    {
      code: `${PRISMA_JSON} const value = <unknown>(row.payload as { kind: string });`,
    },
  ],
  invalid: [
    // A project-local type named JsonValue is held to the same rule.
    {
      code: 'type JsonValue = { kind: string }; declare const v: JsonValue; const k = v.kind;',
      errors: [{ messageId: 'jsonRead', data: { type: 'JsonValue' } }],
    },
    // An unnamed union that contains a Json type.
    {
      code: `${PRISMA_JSON} declare const x: JsonObject | JsonArray; const n = x.length;`,
      errors: [{ messageId: 'jsonRead', data: { type: 'Json' } }],
    },
    {
      code: `${PRISMA_JSON} declare const list: JsonArray; const [first] = list;`,
      errors: [{ messageId: 'jsonRead', data: { type: 'JsonArray' } }],
    },
    {
      code: `${PRISMA_JSON} const event = <{ kind: string }><unknown>row.payload;`,
      errors: [
        {
          messageId: 'jsonCast',
          data: { type: 'JsonValue', target: '{ kind: string }' },
        },
      ],
    },
    // A hand-rolled guard, then a field read: the ledger-line shape on a
    // database column.
    {
      code: `${PRISMA_JSON}
          const p = row.payload;
          if (p && typeof p === 'object' && !Array.isArray(p)) { const kind = p.kind; }`,
      errors: [{ messageId: 'jsonRead' }],
    },
    {
      code: `${PRISMA_JSON} const kind = (row.payload as { kind: string }).kind;`,
      errors: [{ messageId: 'jsonCast' }],
    },
    {
      code: `${PRISMA_JSON} const event = row.payload as unknown as { kind: string };`,
      errors: [{ messageId: 'jsonCast' }],
    },
    // A named target is honest only when its name says Json.
    {
      code: `${PRISMA_JSON} type Shipment = { kind: string }; const s = row.payload as Shipment;`,
      errors: [{ messageId: 'jsonCast' }],
    },
    {
      code: `${PRISMA_JSON} declare const list: JsonArray; const first = list[0];`,
      errors: [{ messageId: 'jsonRead' }],
    },
    {
      code: `${PRISMA_JSON} declare const o: JsonObject; const { kind } = o;`,
      errors: [{ messageId: 'jsonRead' }],
    },
  ],
});

// Strict null checks: `p!` drops `null` and with it the Json alias, so only
// climbing the assertion still sees the Json value beneath.
typedTester.run('prisma-json-through-schema (non-null assertion)', rule as never, {
  valid: [],
  invalid: [
    {
      code: `
          type JsonValue = { kind: string } | null;
          declare const p: JsonValue;
          export const v = p! as { kind: number };`,
      errors: [{ messageId: 'jsonCast' }],
    },
  ],
});

ruleTester.run('prisma-json-through-schema (no types: does nothing)', rule as never, {
  valid: [{ code: 'const kind = (row.payload as Event).kind;' }],
  invalid: [],
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
  jsonRead: 'Schema.parse(...)',
  jsonCast: 'Schema.parse(...)',
};

describe('prisma-json-through-schema meta', () => {
  const { meta } = rule as RuleMeta;

  it('is a problem rule whose texts name the fix', () => {
    assert.equal(meta.type, 'problem');
    assert.ok(meta.docs.description.includes('through a schema'));
    assert.deepEqual(
      Object.keys(meta.messages).sort(),
      Object.keys(MESSAGES).sort(),
    );
    for (const [id, remedy] of Object.entries(MESSAGES)) {
      assert.ok(meta.messages[id]?.includes(remedy), id);
    }
  });
});
