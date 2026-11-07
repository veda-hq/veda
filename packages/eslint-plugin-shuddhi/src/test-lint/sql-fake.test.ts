import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { format } from 'node:util';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin, { rules } from './index.js';

/**
 * TEST-WEAK-10 (no-sql-fake): the cases for `sql-fake.js`, the module this suite owns.
 *
 * Each `invalid` case is a finding code review reported, reduced to the shape
 * that still reproduces it. Each `valid` case is the corrected code or a near
 * miss. The `guard removal` block deletes only the guard from a corrected
 * case and proves the rule fires again.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

/** Vitest's `it.each`: one `it` per row, its title printf-formatted. */
function each<const T>(rows: readonly T[]) {
  return (
    title: string,
    fn: (...args: T extends readonly unknown[] ? T : [T]) => void,
  ): void => {
    for (const row of rows) {
      const args = (Array.isArray(row) ? row : [row]) as T extends readonly unknown[]
        ? T
        : [T];
      it(format(title, ...args), () => {
        fn(...args);
      });
    }
  };
}

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

const TEST_FILE = 'probe.test.ts';

/** The `realDatabase` option's default, as the message names it. */
const DEFAULT_DATABASE = 'a real test database';

// ---------------------------------------------------------------------------
// TEST-WEAK-10
// ---------------------------------------------------------------------------

ruleTester.run('no-sql-fake', rules['no-sql-fake'], {
  valid: [
    // Corrected: an adapter onto a real engine executes the SQL.
    {
      filename: TEST_FILE,
      code: `const db = { execute: async (sql: string, params?: unknown[]) => engine.prepare(sql).all(params) };`,
    },
    // Near misses: a search API's `query`, a generic `run(text)`.
    {
      filename: TEST_FILE,
      code: `const api = { query: (params: SearchParams) => results(params) };`,
    },
    {
      filename: TEST_FILE,
      code: `const shell = { run: (text: string) => { lines.push(text); return 0; } };`,
    },
  ],
  invalid: [
    // The catalogue
    // example: the fake ignores the SQL and answers every query alike.
    {
      filename: TEST_FILE,
      code: `const calls: { sql: string; values: readonly unknown[] }[] = [];
      const db = { query: (sql: string, values?: unknown[]) => { calls.push({ sql, values: values ?? [] }); return Promise.resolve({ rows }); } };`,
      errors: [{ messageId: 'sqlFake' }],
    },
    // A fake that routes on SQL text.
    {
      filename: TEST_FILE,
      code: `const db = { executeAsync: vi.fn(async (sql: string) => (sql.includes('FROM Product') ? { rows: products } : { rows: [] })) };`,
      errors: [{ messageId: 'sqlFake' }],
    },
    {
      filename: TEST_FILE,
      code: `prisma.$queryRaw.mockImplementation((query: unknown) => Promise.resolve([{ total: 3 }]));`,
      errors: [{ messageId: 'sqlFake' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// Deleting the guard from a corrected case brings the rule back
// ---------------------------------------------------------------------------

function messageIds(
  rule: string,
  code: string,
  filename = TEST_FILE,
  options: unknown[] = [],
): string[] {
  const linter = new Linter({ configType: 'flat' });
  return linter
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          plugins: { 'shuddhi': plugin },
          rules: { [`shuddhi/${rule}`]: ['error', ...options] },
        },
      ],
      filename,
    )
    .map(message => message.messageId ?? message.message);
}

interface Flip {
  rule: string;
  messageId: string;
  corrected: string;
  guard: string;
  replacement?: string;
  filename?: string;
  options?: unknown[];
}

const FLIPS: Flip[] = [
  {
    rule: 'no-sql-fake',
    messageId: 'sqlFake',
    corrected: `const db = { query: (sql: string) => engine.prepare(sql).all() };`,
    guard: 'engine.prepare(sql).all()',
    replacement: '({ rows: [] })',
  },
];

describe('guard removal flips each corrected case', () => {
  each(FLIPS.map(flip => [`${flip.rule}/${flip.messageId}`, flip] as const))(
    '%s',
    (_name, flip) => {
      const filename = flip.filename ?? TEST_FILE;
      assert.deepEqual(messageIds(flip.rule, flip.corrected, filename, flip.options), []);
      assert.ok((flip.corrected).includes(flip.guard));
      const broken = flip.corrected.replace(flip.guard, flip.replacement ?? '');
      assert.ok((messageIds(flip.rule, broken, filename, flip.options)).includes(flip.messageId));
    },
  );
});

// (end of kills A)

// ---------------------------------------------------------------------------
// Decision pins B: SHELL-09, TEST-WEAK-10, plugin and config blocks
// ---------------------------------------------------------------------------
const ruleMeta = (name: string): unknown =>
  (rules as Record<string, { meta: unknown } | undefined>)[name]?.meta;

describe('TEST-WEAK-10 rule metadata', () => {
  it('states each rule, its catalogue id and its message verbatim', () => {
    assert.deepEqual(ruleMeta('no-sql-fake'), {
      type: 'problem',
      docs: {
        description:
          'SQL-issuing code is tested on a real migrated database (TEST-WEAK-10)',
      },
      schema: [
        {
          type: 'object',
          properties: { realDatabase: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      ],
      defaultOptions: [{ realDatabase: DEFAULT_DATABASE }],
      messages: {
        sqlFake:
          'This hand-written `{{method}}(sql)` fake answers without executing the SQL, so a dropped predicate, a wrong join or a missing ON CONFLICT still passes. Run the code against {{realDatabase}} with the checked-in migrations applied.',
      },
    });
  });

  it('names the workspace database the realDatabase option gives', () => {
    const realDatabase =
      'the test Postgres (server: an *.integration.test.ts) or SQLite (mobile)';
    assert.deepEqual(
      new Linter({ configType: 'flat' })
        .verify(
          `const db = { query: (sql: string) => rows };`,
          [
            {
              files: ['**/*.ts'],
              languageOptions: { parser: tseslint.parser },
              plugins: { shuddhi: plugin },
              rules: { 'shuddhi/no-sql-fake': ['error', { realDatabase }] },
            },
          ],
          TEST_FILE,
        )
        .map(message => message.message),
      [
        `This hand-written \`query(sql)\` fake answers without executing the SQL, so a dropped predicate, a wrong join or a missing ON CONFLICT still passes. Run the code against ${realDatabase} with the checked-in migrations applied.`,
      ],
    );
  });
});

ruleTester.run('no-sql-fake: fake shapes', rules['no-sql-fake'], {
  valid: [
    // Only vi.fn / jest.fn wrap an implementation.
    {
      filename: TEST_FILE,
      code: `const db = { query: helpers.fn((sql: string) => rows) };`,
    },
    {
      filename: TEST_FILE,
      code: `const api = { query: ({ text }: Params) => search(text) };`,
    },
    { filename: TEST_FILE, code: `const db = { query: () => rows };` },
    // A computed key that is not a literal names no method.
    {
      filename: TEST_FILE,
      code: `const db = { [query]: (sql: string) => rows };`,
    },
    // Only spyOn's second argument names the spied method.
    {
      filename: TEST_FILE,
      code: `makeMock(db, 'query').mockImplementation((sql: string) => rows);`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `const db = { query: jest.fn((sql: string) => rows) };`,
      errors: [{ messageId: 'sqlFake', data: { method: 'query', realDatabase: DEFAULT_DATABASE } }],
    },
    {
      filename: TEST_FILE,
      code: `const db = { query: (sql = '') => rows };`,
      errors: [{ messageId: 'sqlFake', data: { method: 'query', realDatabase: DEFAULT_DATABASE } }],
    },
    {
      filename: TEST_FILE,
      code: `const db = { ['query']: (sql: string) => rows };`,
      errors: [{ messageId: 'sqlFake', data: { method: 'query', realDatabase: DEFAULT_DATABASE } }],
    },
    // Forwarding another parameter does not execute the SQL.
    {
      filename: TEST_FILE,
      code: `const db = { query: (sql: string, params: unknown[]) => fetchRows(params) };`,
      errors: [{ messageId: 'sqlFake', data: { method: 'query', realDatabase: DEFAULT_DATABASE } }],
    },
    // A fake class: each overload signature and the body.
    {
      filename: TEST_FILE,
      code: `class FakeDb {
        query(sql: string): Rows;
        query(sql: string, params: unknown[]): Rows;
        query(sql: string) { return rows; }
      }`,
      errors: [
        { messageId: 'sqlFake', data: { method: 'query', realDatabase: DEFAULT_DATABASE } },
        { messageId: 'sqlFake', data: { method: 'query', realDatabase: DEFAULT_DATABASE } },
        { messageId: 'sqlFake', data: { method: 'query', realDatabase: DEFAULT_DATABASE } },
      ],
    },
    {
      filename: TEST_FILE,
      code: `db.query.mockImplementationOnce((sql: string) => rows);`,
      errors: [{ messageId: 'sqlFake', data: { method: 'query', realDatabase: DEFAULT_DATABASE } }],
    },
    {
      filename: TEST_FILE,
      code: `vi.spyOn(db, 'query').mockImplementation((sql: string) => rows);`,
      errors: [{ messageId: 'sqlFake', data: { method: 'query', realDatabase: DEFAULT_DATABASE } }],
    },
  ],
});

describe('no-sql-fake method and recording tables', () => {
  each([
    'query',
    'execute',
    'executeAsync',
    'executeSync',
    'executeRaw',
    'executeRawAsync',
    '$queryRaw',
    '$queryRawUnsafe',
    '$executeRaw',
    '$executeRawUnsafe',
    'unsafe',
  ])('reports a %s(query) fake', method => {
    assert.deepEqual(messageIds(
        'no-sql-fake',
        `const db = { ${method}: (query: string) => rows };`,
      ), ['sqlFake']);
  });

  each(['run', 'all', 'get', 'exec', 'prepare'])(
    'reports a generic %s(sql) fake',
    method => {
      assert.deepEqual(messageIds(
          'no-sql-fake',
          `const db = { ${method}: (sql: string) => rows };`,
        ), ['sqlFake']);
    },
  );

  each([
    'push',
    'unshift',
    'add',
    'set',
    'log',
    'includes',
    'startsWith',
    'endsWith',
    'match',
    'matchAll',
    'test',
    'exec',
    'search',
    'indexOf',
    'trim',
    'toLowerCase',
    'toUpperCase',
    'replace',
    'replaceAll',
    'split',
  ])('treats recorder.%s(sql) as recording, not executing', call => {
    assert.deepEqual(messageIds(
        'no-sql-fake',
        `const db = { query: (sql: string) => { recorder.${call}(sql); return rows; } };`,
      ), ['sqlFake']);
  });

  it('treats String(sql) as inspection, not execution', () => {
    assert.deepEqual(messageIds(
        'no-sql-fake',
        `const db = { query: (sql: string) => { seen.add(String(sql)); return rows; } };`,
      ), ['sqlFake']);
  });
});
