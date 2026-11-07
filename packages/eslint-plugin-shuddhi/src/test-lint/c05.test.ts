import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { c05Rules } from './c05.js';
import { TEST_FILE_RULES } from './configs.js';
import * as helpers from './helpers.js';
import { rules as pluginRules } from './index.js';

/**
 * The assertion-hygiene rules for silent early returns, owned fixture
 * removal and copied SQL oracles. Each `invalid` case is a historical
 * finding reduced to the shape that still reproduces it; each `valid` case is
 * the corrected code or a near miss. The guard-removal table deletes only the
 * guard from a corrected case and proves the rule fires again.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

type AnyRule = Parameters<RuleTester['run']>[1];

const c05 = c05Rules(helpers);
const rules = {
  'no-silent-early-return': c05.noSilentEarlyReturn,
  'owned-fixture-removal': c05.ownedFixtureRemoval,
  'no-copied-production-sql': c05.noCopiedProductionSql,
} as unknown as Record<string, AnyRule>;

const plugin = { meta: { name: 'shuddhi' }, rules } as unknown as NonNullable<
  Linter.Config['plugins']
>[string];

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

/** Removes a directory this suite made with `mkdtempSync`. */
const removeRoot = (root: string) => {
  rmSync(root, { recursive: true, force: true });
};

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_FILE = 'probe.test.ts';
/** Next to `fixtures/copied-sql/product-sql.mjs`, which it imports. */
const COPIED_SQL_TEST = join(HERE, 'fixtures', 'copied-sql', 'probe.test.ts');

/** The fixture module's FTS statement, whitespace collapsed (a faithful copy). */
const COPIED_FTS =
  'WITH matched AS ( SELECT rowid FROM product_fts WHERE product_fts MATCH ? ) SELECT p.skuId FROM matched m JOIN Product p ON p.rowid = m.rowid WHERE p.deleted_at IS NULL';

/**
 * A repository's own fixture helpers: two calls that create the directory
 * they return, and the guarded removal helper with its module.
 */
const REPO_REMOVAL = {
  ownedRootCalls: ['createFixtureRoot', 'makeOwnedFixtureDir'],
  removeHelperModule: 'scripts/utils/fixture-cleanup.ts',
};

/** An `unowned` finding for `method`, under the default options. */
const unowned = (method: string) => ({
  messageId: 'unowned' as const,
  data: { method, removeHelper: 'removeFixtureRoot', from: '' },
});

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

// ---------------------------------------------------------------------------
// no-silent-early-return (oracle family; a parity suite that compared nothing)
// ---------------------------------------------------------------------------

ruleTester.run('no-silent-early-return', rules['no-silent-early-return']!, {
  valid: [
    // Corrected: the return path asserts why there is nothing to compare.
    {
      filename: TEST_FILE,
      code: `it.each(QUERIES)('parity %j', query => {
        const indexed = viaIndex(query);
        if (indexed === null) { expect(usesIndex(query)).toBe(false); return; }
        expect(indexed).toEqual(viaScan(query));
      });`,
    },
    // Near miss: an assertion before the branch means the path checked something.
    {
      filename: TEST_FILE,
      code: `it('a', async () => {
        const res = await get('/x');
        expect(res.status).toBe(200);
        if (!res.body) return;
        expect(res.body.id).toBe(1);
      });`,
    },
    // Near miss: a skip is a visible outcome, not a silent pass.
    {
      filename: TEST_FILE,
      code: `it('a', ctx => { if (!ready) return ctx.skip(); expect(run()).toBe(1); });`,
    },
    // Near miss: hasAssertions makes the silent path fail.
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect.hasAssertions(); if (!row) return; expect(row.id).toBe(1); });`,
    },
    // Near miss: an if/else asserts on both paths.
    {
      filename: TEST_FILE,
      code: `it('a', () => { if (!row) return; else expect(row.id).toBe(1); });`,
    },
    // Near miss: nothing follows, so nothing is skipped (expect-expect's job).
    {
      filename: TEST_FILE,
      code: `it('a', () => { if (!row) return; run(row); });`,
    },
    // Near miss: a helper function is not a test.
    {
      filename: TEST_FILE,
      code: `function check(row) { if (!row) return; expect(row.id).toBe(1); }`,
    },
    // Near miss: hasAssertions fails the logged path too, so it is no
    // hand-rolled skip (the count is checked before the console path).
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect.hasAssertions(); if (!row) { console.log('no row'); return; } expect(row.id).toBe(1); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect.assertions(1); if (!row) { console.log('no row'); return; } expect(row.id).toBe(1); });`,
    },
    // Corrected: `expect.fail` on the return path is an assertion; it is not a
    // matcher chain, so only the `expect.<member>()` form recognises it.
    {
      filename: TEST_FILE,
      code: `it('a', () => { const r = viaIndex(q); if (r === null) { expect.fail('the index refused'); return; } expect(r).toEqual(viaScan(q)); });`,
    },
    // Near miss: returning a value is not a bare return, nor is a non-void unary.
    {
      filename: TEST_FILE,
      code: `it('a', () => { if (!row) return row; expect(row.id).toBe(1); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { if (!row) return !row; expect(row.id).toBe(1); });`,
    },
    // Near miss: an array hole (a null in the AST) is walked past, not read.
    {
      filename: TEST_FILE,
      code: `it('a', () => { const [, second] = pair; expect(second).toBe(2); if (!more) return; expect(more).toBe(3); });`,
    },
  ],
  invalid: [
    // A parity suite: a row the index cannot serve passed having compared
    // nothing.
    {
      filename: TEST_FILE,
      code: `it.each(QUERIES)('returns identical results for %j', query => {
        const indexed = viaIndex(query);
        if (indexed === null) return;
        expect(indexed).toEqual(viaScan(query));
      });`,
      errors: [{ messageId: 'silentReturn' }],
    },
    {
      filename: TEST_FILE,
      code: `test('a', async () => { const row = await load(); if (!row) { log('none'); return; } expect(row.id).toBe(1); });`,
      errors: [{ messageId: 'silentReturn' }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { if (skip) return undefined; expect(run()).toBe(1); });`,
      errors: [{ messageId: 'silentReturn' }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { if (skip) return void log('none'); expect(run()).toBe(1); });`,
      errors: [{ messageId: 'silentReturn', line: 1, column: 27 }],
    },
    // A branch that logs and returns is a hand-rolled skip, with or without
    // an assertion before it.
    {
      filename: TEST_FILE,
      code: `it('a', () => { const row = load(); if (!row) { console.log('no row'); return; } expect(row.id).toBe(1); });`,
      errors: [{ messageId: 'loggedSkip', line: 1, column: 72 }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(load).toBeTypeOf('function'); if (!row) { console.warn('skipping'); return; } expect(row.id).toBe(1); });`,
      errors: [{ messageId: 'loggedSkip' }],
    },
    // A member call on the return path is neither an assertion nor a log.
    {
      filename: TEST_FILE,
      code: `it('a', () => { if (!row) { logger.info('no row'); return; } expect(row.id).toBe(1); });`,
      errors: [{ messageId: 'silentReturn' }],
    },
    // A call whose callee is itself a call has no object to read.
    {
      filename: TEST_FILE,
      code: `it('a', () => { if (!row) { make()(row); return; } expect(row.id).toBe(1); });`,
      errors: [{ messageId: 'silentReturn' }],
    },
    // Only a name that starts with `expect`/`assert` is an assertion helper.
    {
      filename: TEST_FILE,
      code: `it('a', () => { if (!row) { unexpected(row); return; } expect(row.id).toBe(1); });`,
      errors: [{ messageId: 'silentReturn' }],
    },
    // An `assert*` helper is the assertion the return skips.
    {
      filename: TEST_FILE,
      code: `it('a', () => { if (!row) return; assertRow(row); });`,
      errors: [{ messageId: 'silentReturn' }],
    },
    // The skipped assertion sits two levels under its statement.
    {
      filename: TEST_FILE,
      code: `it('a', async () => { if (!row) return; await expect(load(row)).resolves.toEqual({ id: 1 }); });`,
      errors: [{ messageId: 'silentReturn' }],
    },
    // hasAssertions inside a nested function guards nothing in this test.
    {
      filename: TEST_FILE,
      code: `it('a', () => { const later = () => expect.hasAssertions(); if (!row) return; expect(row.id).toBe(1); later(); });`,
      errors: [{ messageId: 'silentReturn' }],
    },
    // A same-named method on another object is not the assertion count.
    {
      filename: TEST_FILE,
      code: `it('a', () => { recorder.hasAssertions(); if (!row) return; expect(row.id).toBe(1); });`,
      errors: [{ messageId: 'silentReturn' }],
    },
    // The assertion after the guard is not the test's last statement.
    {
      filename: TEST_FILE,
      code: `it('a', () => { if (!row) return; expect(row.id).toBe(1); cleanup(); });`,
      errors: [{ messageId: 'silentReturn' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// owned-fixture-removal (fixture family; a cleanup that deleted a real
// generated client)
// ---------------------------------------------------------------------------

ruleTester.run('owned-fixture-removal', rules['owned-fixture-removal']!, {
  valid: [
    // Corrected: the helper refuses anything outside the OS temp directory.
    {
      filename: TEST_FILE,
      code: `import { removeFixtureRoot } from '../utils/fixture-cleanup';
        const fixtures: string[] = [];
        afterAll(() => { for (const dir of fixtures) removeFixtureRoot(dir); });`,
    },
    // Near miss: the const holds the mkdtemp result itself.
    {
      filename: TEST_FILE,
      code: `import { mkdtempSync, rmSync } from 'node:fs';
        const root = mkdtempSync(join(tmpdir(), 'x-'));
        afterAll(() => rmSync(root, { recursive: true, force: true }));`,
    },
    // Near miss: a literal child of a resolved mkdtemp root stays inside it.
    {
      filename: TEST_FILE,
      code: `import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'x-')));
        it('a', () => { rmSync(join(root, 'cache'), { recursive: true }); expect(1).toBe(1); });`,
    },
    // Near miss: removing one file is not a recursive delete.
    {
      filename: TEST_FILE,
      code: `import { rmSync } from 'node:fs';
        it('a', () => { rmSync(join(root, SCHEMA)); expect(run()).toBe(1); });`,
    },
    // Near miss: creating directories recursively removes nothing.
    {
      filename: TEST_FILE,
      code: `import { mkdirSync } from 'node:fs';
        mkdirSync(join(dir, 'a'), { recursive: true });`,
    },
    // Near miss: a local helper that merely shares the name.
    {
      filename: TEST_FILE,
      code: `const rmSync = (p: string, o: object) => calls.push([p, o]);
        rmSync(target, { recursive: true });`,
    },
    // Near miss: an fs method that removes nothing, called on the namespace.
    {
      filename: TEST_FILE,
      code: `import * as fs from 'node:fs';
        fs.mkdirSync(join(dir, 'a'), { recursive: true });`,
    },
    // Near miss: only `fs.promises` is fs's own namespace; another member
    // under the binding is not fs.
    {
      filename: TEST_FILE,
      code: `import * as fs from 'node:fs';
        fs.stub.rm(dir, { recursive: true });`,
    },
    // Near miss: options that are not a literal `recursive: true`.
    {
      filename: TEST_FILE,
      code: `import { rmSync } from 'node:fs';
        rmSync(file, { force: true });`,
    },
    {
      filename: TEST_FILE,
      code: `import { rmSync } from 'node:fs';
        rmSync(dir, { ...options });`,
    },
    // Near miss: an awaited mkdtemp, and its realpath, are owned roots.
    {
      filename: TEST_FILE,
      code: `import { mkdtemp, rm } from 'node:fs/promises';
        const root = await mkdtemp(join(tmpdir(), 'x-'));
        afterAll(() => rm(root, { recursive: true }));`,
    },
    {
      filename: TEST_FILE,
      code: `import { mkdtemp, realpath, rm } from 'node:fs/promises';
        const root = await realpath(await mkdtemp(join(tmpdir(), 'x-')));
        afterAll(() => rm(root, { recursive: true }));`,
    },
    // Near miss: the repository's fixture helpers create the directory they
    // return (named through the option).
    {
      filename: TEST_FILE,
      options: [REPO_REMOVAL],
      code: `import { rmSync } from 'node:fs';
        const root = createFixtureRoot('x');
        afterAll(() => rmSync(root, { recursive: true }));`,
    },
    {
      filename: TEST_FILE,
      options: [REPO_REMOVAL],
      code: `import { rmSync } from 'node:fs';
        const root = makeOwnedFixtureDir(HERE, 'x-');
        afterAll(() => rmSync(root, { recursive: true }));`,
    },
    // Near miss: three `const` hops back to mkdtemp is inside the bound.
    {
      filename: TEST_FILE,
      code: `import { mkdtempSync, rmSync } from 'node:fs';
        const a = mkdtempSync('x-'); const b = a; const c = b;
        afterAll(() => rmSync(c, { recursive: true }));`,
    },
  ],
  invalid: [
    // A dependency check's first test removed the real generated client.
    {
      filename: TEST_FILE,
      code: `import { rmSync } from 'node:fs';
        const CLIENT_DIR = join(REPO_ROOT, 'node_modules', '.prisma', 'client');
        it('regrows the client', () => { rmSync(CLIENT_DIR, { recursive: true, force: true }); expect(run()).toBe(0); });`,
      errors: [{ messageId: 'unowned' }],
    },
    // The same suite after the fix: owned roots, but nothing proves it.
    {
      filename: TEST_FILE,
      code: `import { rmSync } from 'node:fs';
        afterAll(() => { for (const dir of fixtures) rmSync(dir, { recursive: true, force: true }); });`,
      errors: [{ messageId: 'unowned' }],
    },
    {
      filename: TEST_FILE,
      code: `import fs from 'node:fs/promises';
        let root = '';
        afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });`,
      errors: [{ messageId: 'unowned' }],
    },
    {
      filename: TEST_FILE,
      code: `import * as fs from 'node:fs';
        afterEach(() => fs.promises.rm(dir, { recursive: true }));`,
      errors: [{ messageId: 'unowned' }],
    },
    // `..` leaves the owned root.
    {
      filename: TEST_FILE,
      code: `import { mkdtempSync, rmSync } from 'node:fs';
        const root = mkdtempSync('x-');
        afterAll(() => rmSync(join(root, '..'), { recursive: true }));`,
      errors: [{ messageId: 'unowned' }],
    },
    // Every fs module and remover, by named import (no `fs` name to fall back on).
    {
      filename: TEST_FILE,
      code: `import { rmSync } from 'fs'; rmSync(dir, { recursive: true });`,
      errors: [unowned('rmSync')],
    },
    {
      filename: TEST_FILE,
      code: `import { rm } from 'fs/promises'; await rm(dir, { recursive: true });`,
      errors: [unowned('rm')],
    },
    {
      filename: TEST_FILE,
      code: `import { rm } from 'node:fs/promises'; await rm(dir, { recursive: true });`,
      errors: [unowned('rm')],
    },
    {
      filename: TEST_FILE,
      code: `import { rmdirSync } from 'node:fs'; rmdirSync(dir, { recursive: true });`,
      errors: [unowned('rmdirSync')],
    },
    {
      filename: TEST_FILE,
      code: `import { rmdir } from 'node:fs/promises'; await rmdir(dir, { recursive: true });`,
      errors: [unowned('rmdir')],
    },
    // A namespace bound under another name is still fs.
    {
      filename: TEST_FILE,
      code: `import * as nodeFs from 'node:fs'; nodeFs.rmSync(dir, { recursive: true });`,
      errors: [unowned('rmSync')],
    },
    // Unbound `fs` / `fsp` (a global or a require) are taken at their name.
    {
      filename: TEST_FILE,
      code: `fs.rmSync(dir, { recursive: true });`,
      errors: [unowned('rmSync')],
    },
    {
      filename: TEST_FILE,
      code: `fsp.rm(dir, { recursive: true });`,
      errors: [unowned('rm')],
    },
    // The ownership walk is bounded: four hops back to mkdtemp is past it,
    // through `const`s, realpath calls or join calls alike.
    {
      filename: TEST_FILE,
      code: `import { mkdtempSync, rmSync } from 'node:fs';
        const a = mkdtempSync('x-'); const b = a; const c = b; const d = c;
        afterAll(() => rmSync(d, { recursive: true }));`,
      errors: [{ messageId: 'unowned', line: 3 }],
    },
    {
      filename: TEST_FILE,
      code: `import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
        rmSync(realpathSync(realpathSync(realpathSync(realpathSync(mkdtempSync('x-'))))), { recursive: true });`,
      errors: [{ messageId: 'unowned' }],
    },
    {
      filename: TEST_FILE,
      code: `import { mkdtempSync, rmSync } from 'node:fs';
        rmSync(join(join(join(join(mkdtempSync('x-'), 'a'), 'b'), 'c'), 'd'), { recursive: true });`,
      errors: [{ messageId: 'unowned' }],
    },
    // A literal or template path, or a call other than join, proves nothing.
    {
      filename: TEST_FILE,
      code: `import { rmSync } from 'node:fs'; rmSync('/tmp/app-cache', { recursive: true });`,
      errors: [{ messageId: 'unowned' }],
    },
    {
      filename: TEST_FILE,
      code: `import { mkdtempSync, rmSync } from 'node:fs';
        const root = mkdtempSync('x-');
        rmSync(\`\${root}/cache\`, { recursive: true });`,
      errors: [{ messageId: 'unowned' }],
    },
    {
      filename: TEST_FILE,
      code: `import { mkdtempSync, rmSync } from 'node:fs';
        const root = mkdtempSync('x-');
        rmSync(resolve(root, 'cache'), { recursive: true });`,
      errors: [{ messageId: 'unowned' }],
    },
    // A non-string segment is not a plain child name.
    {
      filename: TEST_FILE,
      code: `import { mkdtempSync, rmSync } from 'node:fs';
        const root = mkdtempSync('x-');
        rmSync(join(root, 0), { recursive: true });`,
      errors: [{ messageId: 'unowned' }],
    },
    // Without the option a repository helper's result proves nothing.
    {
      filename: TEST_FILE,
      code: `import { rmSync } from 'node:fs';
        const root = createFixtureRoot('x');
        afterAll(() => rmSync(root, { recursive: true }));`,
      errors: [unowned('rmSync')],
    },
    // The message names the configured helper and its module.
    {
      filename: TEST_FILE,
      options: [{ removeHelper: 'dropFixture', removeHelperModule: 'test/fixtures.ts' }],
      code: `import { rmSync } from 'node:fs'; rmSync(dir, { recursive: true });`,
      errors: [
        {
          messageId: 'unowned',
          data: {
            method: 'rmSync',
            removeHelper: 'dropFixture',
            from: ' from test/fixtures.ts',
          },
        },
      ],
    },
  ],
});

// ---------------------------------------------------------------------------
// no-copied-production-sql (oracle family; a parity test that rebuilt
// production's statement)
// ---------------------------------------------------------------------------

ruleTester.run('no-copied-production-sql', rules['no-copied-production-sql']!, {
  valid: [
    // Corrected: the test runs the statement production exports.
    {
      filename: COPIED_SQL_TEST,
      code: `import { SEARCH_FTS_SQL } from './product-sql.mjs';
        it('a', () => { expect(db.prepare(SEARCH_FTS_SQL).all('"rng"')).toEqual([{ skuId: 'RNG-1' }]); });`,
    },
    // Near miss: fixture DDL the production module does not contain.
    {
      filename: COPIED_SQL_TEST,
      code: `import { SEARCH_FTS_SQL } from './product-sql.mjs';
        db.exec('CREATE TABLE Product (skuId TEXT PRIMARY KEY, skuName TEXT NOT NULL, deleted_at TEXT)');`,
    },
    // Near miss: SQL shorter than one comparison window.
    {
      filename: COPIED_SQL_TEST,
      code: `import { SEARCH_FTS_SQL } from './product-sql.mjs';
        db.exec('SELECT rowid FROM product_fts');`,
    },
    // Limit, kept narrow: without an import there is no module to compare.
    {
      filename: COPIED_SQL_TEST,
      code: `db.prepare('${COPIED_FTS}');`,
    },
    // Limit: a bare specifier is a package, not a file beside the test.
    {
      filename: COPIED_SQL_TEST,
      code: `import { SEARCH_FTS_SQL } from 'product-sql.mjs';
        const FTS = '${COPIED_FTS}';`,
    },
  ],
  invalid: [
    // The parity test rebuilt production's statement.
    {
      filename: COPIED_SQL_TEST,
      code: `import { planProductSearch } from './product-sql.mjs';
        const FTS = '${COPIED_FTS}';
        it('a', () => { expect(db.prepare(FTS).all('"rng"')).toEqual(scan('rng')); });`,
      errors: [{ messageId: 'copied' }],
    },
    // A template copy, re-indented, is the same copy.
    {
      filename: COPIED_SQL_TEST,
      code: `import { planProductSearch } from './product-sql.mjs';
        const FTS = \`
          WITH matched AS (
              SELECT rowid FROM product_fts WHERE product_fts MATCH ?
          )
          SELECT p.skuId FROM matched m JOIN Product p ON p.rowid = m.rowid
          WHERE p.deleted_at IS NULL\`;`,
      errors: [{ messageId: 'copied' }],
    },
  ],
});

// ---------------------------------------------------------------------------
// Deleting the guard from a corrected case brings the rule back
// ---------------------------------------------------------------------------

function lint(
  rule: string,
  code: string,
  filename: string,
  cwd?: string,
  options: unknown[] = [],
): Linter.LintMessage[] {
  const linter = new Linter({ configType: 'flat', ...(cwd ? { cwd } : {}) });
  return linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { shuddhi: plugin },
        rules: {
          [`shuddhi/${rule}`]: ['error', ...options] as Linter.RuleEntry,
        },
      },
    ],
    filename,
  );
}

function messageIds(
  rule: string,
  code: string,
  filename: string,
  cwd?: string,
): string[] {
  return lint(rule, code, filename, cwd).map(
    message => message.messageId ?? message.message,
  );
}

interface Flip {
  rule: string;
  messageId: string;
  corrected: string;
  guard: string;
  replacement?: string;
  filename?: string;
}

const FLIPS: Flip[] = [
  {
    rule: 'no-silent-early-return',
    messageId: 'silentReturn',
    corrected: `it('a', () => { const r = viaIndex(q); if (r === null) { expect(usesIndex(q)).toBe(false); return; } expect(r).toEqual(viaScan(q)); });`,
    guard: 'expect(usesIndex(q)).toBe(false); ',
  },
  {
    rule: 'no-silent-early-return',
    messageId: 'silentReturn',
    corrected: `it('a', () => { expect.hasAssertions(); if (!row) return; expect(row.id).toBe(1); });`,
    guard: 'expect.hasAssertions(); ',
  },
  {
    rule: 'owned-fixture-removal',
    messageId: 'unowned',
    corrected: `import { rmSync } from 'node:fs'; afterAll(() => { for (const dir of fixtures) removeFixtureRoot(dir); });`,
    guard: 'removeFixtureRoot(dir)',
    replacement: 'rmSync(dir, { recursive: true, force: true })',
  },
  {
    rule: 'owned-fixture-removal',
    messageId: 'unowned',
    corrected: `import { mkdtempSync, rmSync } from 'node:fs'; const root = mkdtempSync('x-'); afterAll(() => rmSync(root, { recursive: true }));`,
    guard: `mkdtempSync('x-')`,
    replacement: `join(REPO_ROOT, 'node_modules')`,
  },
  {
    rule: 'no-copied-production-sql',
    messageId: 'copied',
    corrected: `import { SEARCH_FTS_SQL } from './product-sql.mjs'; const FTS = SEARCH_FTS_SQL;`,
    guard: 'SEARCH_FTS_SQL;',
    replacement: `'${COPIED_FTS}';`,
    filename: COPIED_SQL_TEST,
  },
];

describe('guard removal flips each corrected case', () => {
  each(FLIPS.map(flip => [`${flip.rule}: ${flip.guard}`, flip] as const))(
    '%s',
    (_name, flip) => {
      const filename = flip.filename ?? TEST_FILE;
      assert.deepEqual(messageIds(flip.rule, flip.corrected, filename), []);
      assert.ok(flip.corrected.includes(flip.guard));
      const broken = flip.corrected.replace(flip.guard, flip.replacement ?? '');
      assert.ok(
        messageIds(flip.rule, broken, filename).includes(flip.messageId),
      );
    },
  );
});

describe('these rules ride the test-file block', () => {
  const NAMES = [
    'no-silent-early-return',
    'owned-fixture-removal',
    'no-copied-production-sql',
  ];

  it('binds each at error on every test file', () => {
    for (const name of NAMES) {
      assert.equal(
        (TEST_FILE_RULES as Record<string, unknown>)[`shuddhi/${name}`],
        'error',
        name,
      );
      assert.ok(Object.keys(pluginRules).includes(name), name);
    }
  });

  it('re-reads a production module whose bytes changed (editor sessions)', () => {
    const code = `import { SEARCH_FTS_SQL } from './product-sql.mjs'; const FTS = '${COPIED_FTS}';`;
    const root = mkdtempSync(join(tmpdir(), 'copied-sql-cache-'));
    try {
      const module = join(root, 'product-sql.mjs');
      const probe = join(root, 'probe.test.ts');
      writeFileSync(module, `export const SEARCH_FTS_SQL = \`${COPIED_FTS}\`;`);
      utimesSync(module, 1, 1);
      assert.deepEqual(
        messageIds('no-copied-production-sql', code, probe, root),
        ['copied'],
      );
      // The statement leaves production: a stale cache would still flag it.
      writeFileSync(module, 'export const SEARCH_FTS_SQL = `SELECT 1`;');
      utimesSync(module, 2, 2);
      assert.deepEqual(
        messageIds('no-copied-production-sql', code, probe, root),
        [],
      );
    } finally {
      removeRoot(root);
    }
    assert.deepEqual(
      messageIds(
        'no-copied-production-sql',
        code,
        resolve(HERE, 'fixtures', 'missing', 'probe.test.ts'),
      ),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// no-copied-production-sql against modules written for the case
// ---------------------------------------------------------------------------

/** Lints `code` as `probe.test.ts` beside `files`, in a fresh temp directory. */
function lintBeside(
  files: Record<string, string>,
  code: string,
): Linter.LintMessage[] {
  const root = mkdtempSync(join(tmpdir(), 'copied-sql-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    return lint(
      'no-copied-production-sql',
      code,
      join(root, 'probe.test.ts'),
      root,
    );
  } finally {
    removeRoot(root);
  }
}

/** Lowercase single-spaced SQL of exactly `length` characters; no window repeats. */
function sqlOfLength(length: number): string {
  const terms = Array.from({ length }, (_, i) => String(i + 10)).join(',');
  return `select sku from product where id in (${terms}`.slice(0, length);
}

describe('no-copied-production-sql resolves the module a test imports', () => {
  each([
    ['./m', 'm.ts'],
    ['./m', 'm.tsx'],
    ['./m', 'm.mts'],
    ['./m', 'm.js'],
    ['./m', 'm.mjs'],
    // TypeScript's NodeNext spelling: `./m.js` names `m.ts`.
    ['./m.js', 'm.ts'],
    ['./m', 'm/index.ts'],
  ] as const)('%s → %s', (specifier, file) => {
    const messages = lintBeside(
      { [file]: `export const SQL = \`${COPIED_FTS}\`;\n` },
      `import { SQL } from '${specifier}'; const FTS = '${COPIED_FTS}';`,
    );
    assert.deepEqual(
      messages.map(m => m.messageId),
      ['copied'],
    );
    assert.ok(messages[0]?.message.includes(`copied from \`${specifier}\``));
  });

  it('never reads an import specifier as SQL', () => {
    // An SQL-shaped specifier, written in the module it names.
    const specifier = './select-every-product-row-from-the-catalogue-table';
    assert.ok(specifier.length >= 48);
    const files = {
      [`${specifier.slice(2)}.ts`]: `// imported as ${specifier}\nexport const X = 1;\n`,
    };
    const imports = `import { X } from '${specifier}';`;
    assert.deepEqual(lintBeside(files, imports), []);
    // Control: the same text as a string literal is a copy.
    const copied = lintBeside(files, `${imports} const S = '${specifier}';`);
    assert.deepEqual(
      copied.map(m => m.messageId),
      ['copied'],
    );
    assert.equal(typeof copied[0]?.message, 'string');
  });
});

describe('no-copied-production-sql compares whole text, then 48-character windows', () => {
  const S48 = sqlOfLength(48);
  const S72 = sqlOfLength(72);
  const S96 = sqlOfLength(96);
  const moduleOf = (...parts: string[]) =>
    parts.map((part, i) => `export const P${i} = \`${part}\`;\n`).join('');

  each([
    // The shortest statement compared at all, copied whole.
    ['48 characters, copied whole', S48, true, moduleOf(S48), ['copied']],
    // Up to 72 characters only the whole text counts: both windows apart do not.
    [
      '72 characters, windows apart',
      S72,
      false,
      moduleOf(S72.slice(0, 48), S72.slice(24)),
      [],
    ],
    // Longer, two windows suffice: the first and the last, not the middle.
    [
      '96 characters, first and last window',
      S96,
      false,
      moduleOf(S96.slice(0, 48), S96.slice(48)),
      ['copied'],
    ],
    ['96 characters, one window', S96, false, moduleOf(S96.slice(0, 48)), []],
  ] as [string, string, boolean, string, string[]][])(
    '%s',
    (_name, sql, whole, text, expected) => {
      assert.match(sql, /^select sku from product where id in \(10,11,/);
      assert.equal(text.includes(sql), whole);
      const code = `import { P0 } from './q'; const Q = '${sql}';`;
      const ids = lintBeside({ 'q.ts': text }, code).map(m => m.messageId);
      assert.deepEqual(ids, expected);
    },
  );
});

// ---------------------------------------------------------------------------
// What each rule reports: RuleTester checks ids, so the text is checked here
// ---------------------------------------------------------------------------

interface RuleMeta {
  type: string;
  docs: { description: string };
}

describe('these rules say what they found and how to fix it', () => {
  each([
    'no-silent-early-return',
    'owned-fixture-removal',
    'no-copied-production-sql',
  ])('%s is a problem rule documented under its family', name => {
    const meta = (rules[name] as unknown as { meta: RuleMeta }).meta;
    assert.equal(meta.type, 'problem');
    assert.match(meta.docs.description, / \((oracle|fixture) family\)$/);
  });

  each([
    [
      'no-silent-early-return',
      `it('a', () => { if (!row) return; expect(row.id).toBe(1); });`,
      TEST_FILE,
      'This test returns before any assertion',
    ],
    [
      'no-silent-early-return',
      `it('a', () => { if (!row) { console.log('x'); return; } expect(row.id).toBe(1); });`,
      TEST_FILE,
      'Skip visibly with the test context (`ctx.skip(reason)`)',
    ],
    [
      'owned-fixture-removal',
      `import { rmdirSync } from 'node:fs'; rmdirSync(dir, { recursive: true });`,
      TEST_FILE,
      'A recursive `rmdirSync` in a test deletes whatever this path resolves to',
    ],
    [
      'no-copied-production-sql',
      `import { X } from './product-sql.mjs'; const FTS = '${COPIED_FTS}';`,
      COPIED_SQL_TEST,
      'This SQL is copied from `./product-sql.mjs`, which this test imports',
    ],
  ] as const)('%s: %s', (rule, code, filename, text) => {
    const messages = lint(rule, code, filename).map(m => m.message);
    assert.equal(messages.length, 1);
    assert.ok(messages[0]?.includes(text), messages[0]);
  });

  it('names the repository removal helper it is given, word for word', () => {
    const messages = lint(
      'owned-fixture-removal',
      `import { rmSync } from 'node:fs'; rmSync(dir, { recursive: true });`,
      TEST_FILE,
      undefined,
      [REPO_REMOVAL],
    ).map(m => m.message);
    assert.deepEqual(messages, [
      'A recursive `rmSync` in a test deletes whatever this path resolves to; a cleanup like this once deleted the real generated Prisma client. Remove fixture roots with `removeFixtureRoot()` from scripts/utils/fixture-cleanup.ts, which refuses any path outside the OS temp directory, or remove the `const` that holds the `mkdtemp` result itself.',
    ]);
  });

  it('exports the owned-root calls and source extensions it shares', () => {
    assert.deepEqual([...c05.OWNED_ROOT_CALLS], ['mkdtempSync', 'mkdtemp']);
    assert.deepEqual(c05.SOURCE_EXTENSIONS, [
      '',
      '.ts',
      '.tsx',
      '.mts',
      '.js',
      '.mjs',
    ]);
  });
});
