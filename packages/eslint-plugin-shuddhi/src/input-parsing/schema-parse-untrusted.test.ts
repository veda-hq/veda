import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';

import rule from './schema-parse-untrusted.js';

/**
 * VAL-09 `schema-parse-untrusted`. The first invalid case is
 * the catalogue example (the code a reviewer reported, reduced to the smallest shape
 * that still reproduces it), followed by the corrected code and near-misses
 * that must stay valid.
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

// ---------------------------------------------------------------------------
// VAL-09: a parsed ledger line read field by field, without a schema.

/** Every schema method that counts as validation. */
const SCHEMA_METHOD_NAMES = [
  'parse',
  'safeParse',
  'parseAsync',
  'safeParseAsync',
];
/**
 * Receivers whose `.parse` is a parser, not a schema. `JSON` is the
 * `JSON.parse(JSON.parse(text))` case below (both calls are sources).
 */
const NOT_SCHEMA_RECEIVERS = ['YAML', 'yaml', 'jsyaml', 'jsYaml'];

ruleTester.run('schema-parse-untrusted', rule as never, {
  valid: [
    ...SCHEMA_METHOD_NAMES.map(method => ({
      code: `const value = await Schema.${method}(JSON.parse(text));`,
    })),
    // Near-miss: a js-yaml export that does not read YAML.
    { code: "import { dump } from 'js-yaml'; const text = dump(doc);" },
    // Near-miss: a zero-argument call that is not `.json()`.
    { code: 'const x = make();' },
    // The fix: the schema is the only reader of the parsed value.
    { code: 'const record = HistoryRecordSchema.parse(JSON.parse(line));' },
    {
      code: `
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { return null; }
        const result = HistoryRecordSchema.safeParse(parsed);`,
      languageOptions: {
        parserOptions: { ecmaFeatures: { globalReturn: true } },
      },
    },
    { code: 'const body = Schema.parse(await response.json());' },
    {
      code: 'const raw = await res.json(); const body = Schema.safeParse(raw);',
    },
    {
      code: "import { load } from 'js-yaml'; const doc = FrontmatterSchema.parse(load(text));",
    },
    // Schemas the rule can identify without types: built from `z`, named as
    // a schema, or a local binding initialised from either.
    { code: 'const v = z.object({ a: z.string() }).parse(JSON.parse(t));' },
    { code: 'const v = schemas.lease.safeParse(JSON.parse(t));' },
    {
      code: 'const lease = z.object({}); const v = lease.parse(JSON.parse(t));',
    },
    {
      code: 'const strict = leaseSchema.strict(); const v = strict.parse(JSON.parse(t));',
    },
    {
      code: 'const base = z.object({}); const wide = base.extend({}); const v = wide.parse(JSON.parse(t));',
    },
    { code: 'const value = Schema.parse(JSON.parse(text) as unknown);' },
    // Near-miss: a deep clone of a value this process already holds.
    { code: 'const copy = JSON.parse(JSON.stringify(state));' },
    // Near-miss: a syntax check that keeps nothing.
    { code: 'try { JSON.parse(body); } catch (error) { report(error); }' },
    // Near-miss: Fastify/Express `reply.json(body)` SENDS json.
    { code: 'reply.json({ ok: true });' },
    // Near-miss: a YAML-module-free `parse` is not a YAML read.
    { code: 'const url = parse(text);' },
  ],
  invalid: [
    // The catalogue example: hand-rolled typeof checks, then a producer cast.
    {
      code: `
        export function parseHistoryLine(line: string): HistoryRecord | null {
          let parsed: unknown;
          try { parsed = JSON.parse(line); } catch { return null; }
          if (!isRecordShape(parsed)) return null;
          if (typeof parsed.ts !== 'string' || typeof parsed.mode !== 'string') return null;
          return parsed as unknown as HistoryRecord;
        }`,
      errors: [{ messageId: 'unvalidated' }],
    },
    {
      code: 'const config = JSON.parse(text) as Config;',
      errors: [{ messageId: 'producerCast' }],
    },
    {
      code: 'const config: Config = JSON.parse(text);',
      errors: [{ messageId: 'producerCast' }],
    },
    {
      code: 'const config = JSON.parse(text) as unknown as Config;',
      errors: [{ messageId: 'producerCast' }],
    },
    {
      code: 'return JSON.parse(text);',
      errors: [{ messageId: 'unvalidated' }],
      languageOptions: {
        parserOptions: { ecmaFeatures: { globalReturn: true } },
      },
    },
    {
      code: 'const { a, b } = JSON.parse(text);',
      errors: [{ messageId: 'unvalidated' }],
    },
    {
      code: 'const body = await res.json(); use(body.items);',
      errors: [{ messageId: 'unvalidated' }],
    },
    {
      code: "import yaml from 'js-yaml'; const doc = yaml.load(text); doc.title;",
      errors: [{ messageId: 'unvalidated' }],
    },
    {
      code: "import * as YAML from 'yaml'; const doc = YAML.parse(text);",
      errors: [{ messageId: 'unvalidated' }],
    },
    {
      code: "import { load as loadYaml } from 'js-yaml'; use(loadYaml(text));",
      errors: [{ messageId: 'unvalidated' }],
    },
    // A value read by the schema AND by hand is still read by hand.
    {
      code: 'const raw = JSON.parse(text); Schema.parse(raw); raw.items;',
      errors: [{ messageId: 'unvalidated' }],
    },
    {
      code: 'const parsed = JSON.parse(text);',
      errors: [{ messageId: 'unvalidated' }],
    },
    {
      code: 'const n = JSON.parse(JSON.parse(text));',
      errors: [{ messageId: 'unvalidated' }, { messageId: 'unvalidated' }],
    },
    ...NOT_SCHEMA_RECEIVERS.map(receiver => ({
      code: `const value = ${receiver}.parse(JSON.parse(text));`,
      errors: [
        { messageId: 'unvalidated' as const, data: { source: 'JSON.parse' } },
      ],
    })),
    // A `.parse` the rule cannot tie to a zod schema — an
    // identity parser, an unknown or imported name, a parameter, `this`, a
    // call's result, an uninitialised or cyclic binding.
    ...[
      'const parser = { parse: v => v }; const value = parser.parse(JSON.parse(text));',
      'const value = parser.parse(JSON.parse(text));',
      "import { Frontmatter } from './fm'; const v = Frontmatter.parse(JSON.parse(t));",
      'function f(p) { return p.parse(JSON.parse(t)); }',
      'class A { f(t) { return this.parse(JSON.parse(t)); } }',
      'const v = make().parse(JSON.parse(t));',
      'let lease; const v = lease.parse(JSON.parse(t));',
      'const a = b.x; const b = a.y; const v = a.parse(JSON.parse(t));',
    ].map(code => ({
      code,
      errors: [{ messageId: 'unvalidated' as const }],
    })),
    // Calls that are not schema methods: a private method, any other method.
    {
      code: 'class A { #parse(v) { return v; } f(t) { return this.#parse(JSON.parse(t)); } }',
      errors: [{ messageId: 'unvalidated' }],
    },
    {
      code: 'store.save(JSON.parse(text));',
      errors: [{ messageId: 'unvalidated' }],
    },
    // Every YAML reader, through a namespace or a named import.
    {
      code: "import yaml from 'js-yaml'; const docs = yaml.loadAll(text);",
      errors: [{ messageId: 'unvalidated', data: { source: 'YAML' } }],
    },
    {
      code: "import { parse } from 'yaml'; const doc = parse(text);",
      errors: [{ messageId: 'unvalidated', data: { source: 'YAML' } }],
    },
    {
      code: "import { loadAll } from 'js-yaml'; const docs = loadAll(text);",
      errors: [{ messageId: 'unvalidated', data: { source: 'YAML' } }],
    },
    // `void` discards nothing the statement form would.
    {
      code: 'void JSON.parse(text);',
      errors: [{ messageId: 'unvalidated' }],
    },
    {
      code: 'const config = <Config>JSON.parse(text);',
      errors: [{ messageId: 'producerCast' }],
    },
    // Neither a declaration nor an assignment binds the value.
    {
      code: 'for (JSON.parse(text); ; ) break;',
      errors: [{ messageId: 'unvalidated' }],
    },
    {
      code: 'function f(x = JSON.parse(text)) { return Schema.parse(x); }',
      errors: [{ messageId: 'unvalidated' }],
    },
  ],
});

typedTester.run('schema-parse-untrusted (typed)', rule as never, {
  valid: [
    // A receiver whose type carries zod's own properties, whatever its name.
    ...['_zod', '_def', "'~standard'"].map(property => ({
      code: `declare const p: { ${property}: unknown; parse(v: unknown): unknown }; declare const t: string; const v = p.parse(JSON.parse(t));`,
    })),
    // A receiver with no usable type falls back to the syntactic check.
    {
      code: 'declare const leaseSchema: unknown; declare const t: string; const v = leaseSchema.parse(JSON.parse(t));',
    },
  ],
  invalid: [
    // Typed: a schema-like NAME on a type with no zod properties is no schema.
    {
      code: 'declare const leaseSchema: { parse(v: unknown): unknown }; declare const t: string; const v = leaseSchema.parse(JSON.parse(t));',
      errors: [{ messageId: 'unvalidated' }],
    },
    {
      code: 'declare const p: unknown; declare const t: string; const v = p.parse(JSON.parse(t));',
      errors: [{ messageId: 'unvalidated' }],
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
  unvalidated: 'Schema.parse(...)',
  producerCast: 'Schema.parse(...)',
};

describe('schema-parse-untrusted meta', () => {
  const { meta } = rule as RuleMeta;

  it('is a problem rule whose texts name the fix', () => {
    assert.equal(meta.type, 'problem');
    assert.ok(meta.docs.description.includes('zod schema'));
    assert.deepEqual(
      Object.keys(meta.messages).sort(),
      Object.keys(MESSAGES).sort(),
    );
    for (const [id, remedy] of Object.entries(MESSAGES)) {
      assert.ok(meta.messages[id]?.includes(remedy), id);
    }
  });
});
