import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin, { rules } from './nest-prisma-rules.js';

/**
 * Each case below is code a reviewer actually reported, reduced to the
 * smallest shape that still reproduces the defect — so a regression here is a
 * regression against a real PR, not against an invented rule.
 *
 * The `valid` half matters as much as the `invalid` half: a rule that fires on
 * the fixed version of the same code is worse than no rule, because it trains
 * people to reach for eslint-disable.
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

type RuleName = keyof typeof rules;

/** Helpers that open a transaction themselves, as a consumer names them. */
const WRAPPERS = { transactionWrappers: ['withPeriodClaim', 'resetFixtures'] };

/** A loopback harness and the module a consumer imports it from. */
const LOOPBACK = {
  loopbackHelper: 'listenOnLoopback',
  loopbackHelperModule: 'test/utils/listen-on-loopback',
};

/** The messages `rule` reports on `code`, linted as ESLint lints a .ts file. */
function messagesOf(
  rule: RuleName,
  code: string,
  options: readonly unknown[] = [],
): string[] {
  const linter = new Linter({ configType: 'flat' });
  return linter
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
          },
          plugins: { shuddhi: { rules } as never },
          rules: { [`shuddhi/${rule}`]: ['error', ...options] as never },
        },
      ],
      { filename: 'plugin.test.ts' },
    )
    .map(message => message.message);
}

describe('what each rule tells the author', () => {
  const names: RuleName[] = [
    'no-raw-sql-interpolation',
    'nest-http-exception',
    'prisma-transaction-multiwrite',
    'nest-param-pipe',
    'no-unbound-test-app',
  ];

  it('exports exactly these rules, by default and by name', () => {
    assert.deepEqual(Object.keys(rules).sort(), [...names].sort());
    assert.equal(plugin.rules, rules);
  });

  for (const name of names) {
    it(`${name} documents itself as a problem rule`, () => {
      // ESLint hands meta to formatters (rulesMeta) and `--fix-type`; an empty
      // description or type leaves every consumer with nothing to show.
      assert.equal(rules[name].meta.type, 'problem');
      assert.match(rules[name].meta.docs.description, /\w{4}/);
    });
  }

  const cases: [RuleName, string, string, string, readonly unknown[]][] = [
    [
      'nest-http-exception',
      'a bare Error',
      "import { Injectable } from '@nestjs/common';\nthrow new Error('x');",
      'leaves Nest with nothing to map',
      [],
    ],
    [
      'prisma-transaction-multiwrite',
      'three writes',
      'async function f() {\n  await prisma.a.create({});\n  await prisma.b.create({});\n  await prisma.c.create({});\n}',
      'This function performs 3 Prisma writes outside a transaction',
      [],
    ],
    [
      'no-raw-sql-interpolation',
      'an interpolated Unsafe call',
      'prisma.$executeRawUnsafe(`DELETE ${id}`);',
      '`$executeRawUnsafe` with a computed string is SQL injection',
      [],
    ],
    [
      'no-unbound-test-app',
      'a bare init',
      "import request from 'supertest';\nconst app = moduleRef.createNestApplication();\nawait app.init();",
      'only calls `.init()`, so supertest binds it',
      [],
    ],
    [
      'no-unbound-test-app',
      'a hostless listen',
      'const app = moduleRef.createNestApplication();\nawait app.listen(0);',
      '`listen()` on a Nest test app with no host binds `::`',
      [],
    ],
    [
      'nest-param-pipe',
      'a number param',
      'class C {\n  list(@Query("page") page: number) { return page; }\n}',
      '`page` is declared `number` but arrives from the request unvalidated. Without a pipe (or a validated DTO) it reaches the query layer as-is — the NaN pagination and malformed-date defects code review kept finding. Add `ParseIntPipe`/`ParseDatePipe`, or take a validated DTO.',
      [],
    ],
    [
      'nest-param-pipe',
      'a Date param',
      'class C {\n  since(@Query("since") since: Date) { return since; }\n}',
      '`since` is declared `Date` but',
      [],
    ],
    [
      'nest-param-pipe',
      'a string id param',
      'class C {\n  get(@Param("brandId") brandId: string) { return brandId; }\n}',
      '`brandId` is declared `string id` but arrives from the request unvalidated. Without a pipe (or a validated DTO) it reaches the query layer as-is — the NaN pagination and malformed-date defects code review kept finding. Add `ParseUUIDPipe`, or take a validated DTO.',
      [],
    ],
  ];
  for (const [rule, description, code, text, options] of cases) {
    it(`${rule} explains ${description}`, () => {
      const messages = messagesOf(rule, code, options);
      assert.equal(messages.length, 1);
      assert.ok(messages[0]?.includes(text), messages[0]);
    });
  }

  it('names the loopback helper and its module when configured', () => {
    assert.deepEqual(
      messagesOf(
        'no-unbound-test-app',
        "import request from 'supertest';\nconst app = moduleRef.createNestApplication();\nawait app.init();\nawait app.listen(0);",
        [LOOPBACK],
      ),
      [
        'This suite drives a Nest app over supertest but only calls `.init()`, so supertest binds it with a hostless `listen(0)` (`::`). That can silently share a port another process holds on 127.0.0.1, and the foreign process answers the request. Use `listenOnLoopback(...)` from test/utils/listen-on-loopback.',
        "`listen()` on a Nest test app with no host binds `::`, which does not collide with a 127.0.0.1 socket another process already holds — the request can then be answered by that process. Pass the host (`listenOnLoopback(...)`, or `listen(0, '127.0.0.1')`).",
      ],
    );
  });

  it('names only the helper when no module is configured', () => {
    const [message] = messagesOf(
      'no-unbound-test-app',
      "import request from 'supertest';\nconst app = moduleRef.createNestApplication();\nawait app.init();",
      [{ loopbackHelper: 'bindLoopback' }],
    );
    assert.ok(message?.endsWith('Use `bindLoopback(...)`.'), message);
  });

  for (const [rule, option] of [
    ['prisma-transaction-multiwrite', { wrappers: ['x'] }],
    ['no-unbound-test-app', { helper: 'x' }],
  ] as const) {
    it(`${rule} refuses an option it does not define`, () => {
      // A misspelt option would otherwise fall back to the default silently.
      assert.throws(() => messagesOf(rule, 'x;', [option]), /additional properties/);
    });
  }
});

ruleTester.run('no-raw-sql-interpolation', rules['no-raw-sql-interpolation'] as never, {
  valid: [
    // The tagged-template form Prisma parameterises.
    {
      code: 'const rows = await prisma.$queryRaw`SELECT * FROM p WHERE id = ${id}`;',
    },
    // A constant statement carries no injected value.
    { code: "await prisma.$executeRawUnsafe('TRUNCATE TABLE products');" },
    { code: 'await prisma.$executeRawUnsafe(`TRUNCATE TABLE products`);' },
    // The documented-safe form: SQL built by a helper, values bound
    // separately. The rule used to flag this — the guard meant to allow it
    // tested `first.type === 'Literal'`, which an earlier line had already
    // returned on, so it was unreachable. With eslint-disable banned, that
    // made the pattern its own message recommends impossible to write.
    {
      code: 'const rows = await prisma.$queryRawUnsafe(buildQuery(table), userId);',
    },
    // An identifier cannot be judged from the AST; following it to its source
    // is a taint tool's job, not this rule's.
    { code: 'const rows = await prisma.$queryRawUnsafe(sql);' },
  ],
  invalid: [
    {
      code: "await prisma.$queryRawUnsafe(`SELECT * FROM p WHERE code = '${code}'`);",
      errors: [{ messageId: 'unsafe' }],
    },
    {
      code: "await prisma.$executeRawUnsafe('DELETE FROM p WHERE id = ' + id);",
      errors: [{ messageId: 'unsafe' }],
    },
  ],
});

ruleTester.run('nest-http-exception', rules['nest-http-exception'] as never, {
  valid: [
    {
      code: [
        "import { BadRequestException } from '@nestjs/common';",
        "function f() { throw new BadRequestException('bad'); }",
      ].join('\n'),
    },
    {
      // Not a Nest module — a bare Error is fine in a plain script.
      code: "function f() { throw new Error('boom'); }",
    },
  ],
  invalid: [
    {
      // A service where a plain Error surfaced as 500 for what was a client
      // validation failure.
      code: [
        "import { Injectable } from '@nestjs/common';",
        "function f() { throw new Error('invalid input'); }",
      ].join('\n'),
      errors: [{ messageId: 'bareError' }],
    },
  ],
});

ruleTester.run(
  'prisma-transaction-multiwrite',
  rules['prisma-transaction-multiwrite'] as never,
  {
    valid: [
      {
        // The fix on an invoice service: both writes inside $transaction.
        code: [
          'async function f() {',
          '  await prisma.$transaction(async tx => {',
          '    await tx.invoice.update({ where: { id }, data: {} });',
          '    await tx.auditLog.create({ data: {} });',
          '  });',
          '}',
        ].join('\n'),
      },
      {
        // A computed `$transaction` key is the same boundary as the dotted one.
        code: [
          'async function f() {',
          "  await prisma['$transaction'](async tx => {",
          "    await tx['invoice'].update({ where: { id }, data: {} });",
          '    await tx.auditLog.create({ data: {} });',
          '  });',
          '}',
        ].join('\n'),
      },
      {
        // A single write needs no transaction.
        code: 'async function f() { await prisma.invoice.update({ where: { id }, data: {} }); }',
      },
      {
        // `withPeriodClaim` OPENS the transaction and hands its client to the
        // body. Read as untransacted, the rule would push the author towards
        // a nested `$transaction` inside a transaction — the opposite of what
        // it is asking for.
        code: [
          'async function f() {',
          '  await withPeriodClaim(prisma, days, async tx => {',
          '    await tx.leaveRecord.updateMany({ where: { id }, data: {} });',
          '    await tx.auditLog.create({ data: {} });',
          '  });',
          '}',
        ].join('\n'),
        options: [WRAPPERS],
      },
      {
        // `resetFixtures` runs its seed array as ONE `$transaction`, after the
        // TRUNCATE.
        code: [
          'async function f() {',
          '  await resetFixtures(prisma, TABLES, [',
          '    prisma.brand.create({ data: {} }),',
          '    prisma.store.create({ data: {} }),',
          '  ]);',
          '}',
        ].join('\n'),
        options: [WRAPPERS],
      },
      {
        // Two writes in DIFFERENT functions are not a partial-state risk.
        code: [
          'async function a() { await prisma.invoice.create({ data: {} }); }',
          'async function b() { await prisma.auditLog.create({ data: {} }); }',
        ].join('\n'),
      },
      {
        // NOT Prisma. `create`/`delete`/`update` are ordinary English verbs, and
        // the rule only ever filtered on the method name — so two cache or
        // service calls in one function were reported as needing a database
        // transaction. The root has to be the client for this rule to mean
        // anything.
        code: [
          'async function f() {',
          '  await this.cache.entry.create({ data: {} });',
          '  await this.mailer.message.delete({ where: { id } });',
          '}',
        ].join('\n'),
      },
      {
        // A root that merely LOOKS like a store is still not the client.
        code: [
          'async function f() {',
          '  await this.registry.entry.create({ data: {} });',
          '  await this.registry.entry.delete({ where: { id } });',
          '}',
        ].join('\n'),
      },
      {
        // A factory call is NOT assumed to be Prisma. Treating every call root
        // as the client reported ordinary repository pairs as untransacted
        // Prisma multi-writes.
        code: [
          'async function f() {',
          '  await repository().entry.create({ data: {} });',
          '  await repository().entry.delete({ where: { id } });',
          '}',
        ].join('\n'),
      },
      {
        // Nor is a member-call factory.
        code: [
          'async function f() {',
          '  await this.factory.build().entry.create({ data: {} });',
          '  await this.factory.build().entry.delete({ where: { id } });',
          '}',
        ].join('\n'),
      },
    ],
    invalid: [
      {
        // A status update committed without its audit row when the second
        // insert failed.
        code: [
          'async function f() {',
          '  await prisma.invoice.update({ where: { id }, data: {} });',
          '  await prisma.auditLog.create({ data: {} });',
          '}',
        ].join('\n'),
        errors: [{ messageId: 'untransacted' }],
      },
      {
        // Delete-then-recreate lost every match on a failure between the two.
        code: [
          'async function f() {',
          '  await prisma.invoiceMatch.deleteMany({ where: { sessionId } });',
          '  await prisma.invoiceMatch.create({ data: {} });',
          '}',
        ].join('\n'),
        errors: [{ messageId: 'untransacted' }],
      },
      {
        // `this.prisma.x` is how services actually write it, so narrowing
        // the root must not lose the real case.
        code: [
          'async function f() {',
          '  await this.prisma.invoice.update({ where: { id }, data: {} });',
          '  await this.prisma.auditLog.create({ data: {} });',
          '}',
        ].join('\n'),
        errors: [{ messageId: 'untransacted' }],
      },
      {
        // A client injected under a DIFFERENT name must not fall out of the
        // guard: an allowlist that fails open is a silent gap.
        code: [
          'async function f() {',
          '  await this.prismaService.invoice.update({ where: { id }, data: {} });',
          '  await this.prismaService.auditLog.create({ data: {} });',
          '}',
        ].join('\n'),
        errors: [{ messageId: 'untransacted' }],
      },
      {
        // A client obtained from a factory NAMED for Prisma is still the
        // client.
        code: [
          'async function f() {',
          '  await getPrismaClient().invoice.update({ where: { id }, data: {} });',
          '  await getPrismaClient().auditLog.create({ data: {} });',
          '}',
        ].join('\n'),
        errors: [{ messageId: 'untransacted' }],
      },
      {
        // With no wrapper configured, a helper's callback is not transacted:
        // the rule cannot know what an unnamed helper does.
        code: [
          'async function f() {',
          '  await withPeriodClaim(prisma, days, async tx => {',
          '    await tx.leaveRecord.updateMany({ where: { id }, data: {} });',
          '    await tx.auditLog.create({ data: {} });',
          '  });',
          '}',
        ].join('\n'),
        errors: [{ messageId: 'untransacted' }],
      },
    ],
  },
);

ruleTester.run('nest-param-pipe', rules['nest-param-pipe'] as never, {
  valid: [
    {
      // The fix being asked for.
      code: 'class C {\n  get(@Param("id", ParseUUIDPipe) id: string) { return id; }\n}',
    },
    {
      code: 'class C {\n  list(@Query("page", ParseIntPipe) page: number) { return page; }\n}',
    },
    {
      // Free text is not an identifier — validating `q` as a UUID would be
      // wrong, so an id-shaped NAME is what selects the string case.
      code: 'class C {\n  search(@Query("q") q: string) { return q; }\n}',
    },
    {
      // An undecorated parameter is none of this rule's business.
      code: 'class C {\n  helper(id: string) { return id; }\n}',
    },
  ],
  invalid: [
    {
      // The UUID case the message always promised. `@Param("id") id: string`
      // is the ordinary spelling of a route id and produced zero messages.
      code: 'class C {\n  get(@Param("id") id: string) { return id; }\n}',
      errors: [{ messageId: 'unparsed' }],
    },
    {
      // An inventory controller — one of 25 real hits on the tree.
      code: 'class C {\n  get(@Query("storeId") storeId: string) { return storeId; }\n}',
      errors: [{ messageId: 'unparsed' }],
    },
    {
      // The NaN-pagination defect the rule was built from.
      code: 'class C {\n  list(@Query("page") page: number) { return page; }\n}',
      errors: [{ messageId: 'unparsed' }],
    },
    {
      // The malformed-date defect.
      code: 'class C {\n  since(@Query("since") since: Date) { return since; }\n}',
      errors: [{ messageId: 'unparsed' }],
    },
  ],
});

describe('nest-http-exception — type-only imports', () => {
  ruleTester.run('nest-http-exception', rules['nest-http-exception'] as never, {
    valid: [
      {
        // A type-only import is erased at compile time and gives the file no
        // request path. A test helper importing INestApplication as a TYPE and
        // throwing on a failed precondition was being told to throw a
        // BadRequestException, which has nothing to map it to a response.
        name: 'a type-only @nestjs import does not make the file Nest code',
        code: `
          import type { INestApplication } from '@nestjs/common';
          export function check(app: INestApplication) {
            if (!app) throw new Error('no app');
          }
        `,
      },
    ],
    invalid: [
      {
        // A VALUE import still marks the file, so the rule keeps its teeth.
        name: 'a value @nestjs import still reports a bare Error',
        code: `
          import { Injectable } from '@nestjs/common';
          export function check(x: unknown) {
            if (!x) throw new Error('nope');
          }
        `,
        errors: [{ messageId: 'bareError' }],
      },
    ],
  });
});

describe('no-unbound-test-app', () => {
  ruleTester.run('no-unbound-test-app', rules['no-unbound-test-app'] as never, {
    valid: [
      {
        // The harness binds 127.0.0.1 before supertest sees the server.
        name: 'app routed through listenOnLoopback',
        code: `
          import request from 'supertest';
          import { listenOnLoopback } from '../../test/utils/listen-on-loopback';
          const app = moduleRef.createNestApplication();
          await app.init();
          await listenOnLoopback(app);
          await request(app.getHttpServer()).get('/x');
        `,
        options: [LOOPBACK],
      },
      {
        // A configured helper name is the harness; the default is not.
        name: 'app routed through a helper the config names',
        code: `
          import request from 'supertest';
          const app = moduleRef.createNestApplication();
          await app.init();
          await bindLoopback(app);
          await request(app.getHttpServer()).get('/x');
        `,
        options: [{ loopbackHelper: 'bindLoopback' }],
      },
      {
        // A Nest app that never serves HTTP does not need a bound port, and
        // demanding one would push every service-level suite through a socket.
        name: 'init without supertest',
        code: `
          const app = moduleRef.createNestApplication();
          await app.init();
        `,
      },
      {
        // The rule keys on createNestApplication precisely so that a test which
        // stands up a raw server to DEMONSTRATE the wildcard bind is allowed;
        // with eslint-disable banned there is no other way to write it.
        name: 'raw http server binding the wildcard on purpose',
        code: `
          import request from 'supertest';
          const server = createServer(handler);
          server.listen(0);
          await request(server).get('/');
        `,
      },
      {
        name: 'nest app listening on a named host',
        code: `
          import request from 'supertest';
          const app = moduleRef.createNestApplication();
          await app.listen(0, '127.0.0.1');
        `,
      },
      {
        // Regression: `bareInit` used to fire on suites that DID bind loopback,
        // just without the helper — reporting the six suites that already
        // listened as if they were unbound. A hostful listen harnesses the app.
        name: 'init followed by a hostful listen, without the helper',
        code: `
          import request from 'supertest';
          let app;
          app = moduleRef.createNestApplication();
          await app.init();
          await app.listen(0, '127.0.0.1');
          await request(app.getHttpServer()).get('/x');
        `,
      },
    ],
    invalid: [
      {
        // The shipped defect: 31 suites looked exactly like this.
        name: 'supertest against an app that was only init()ed',
        code: `
          import request from 'supertest';
          const app = moduleRef.createNestApplication();
          await app.init();
          await request(app.getHttpServer()).get('/x');
        `,
        errors: [{ messageId: 'bareInit' }],
      },
      {
        // Binding once was the right instinct; the missing host is the bug.
        name: 'nest app bound with a hostless listen',
        code: `
          import request from 'supertest';
          const app = moduleRef.createNestApplication();
          await app.init();
          await app.listen(0);
        `,
        errors: [{ messageId: 'bareInit' }, { messageId: 'hostlessListen' }],
      },
      {
        name: 'app assigned to an outer variable, as the suites do',
        code: `
          import request from 'supertest';
          let app;
          app = moduleFixture.createNestApplication();
          await app.init();
          await request(app.getHttpServer()).get('/x');
        `,
        errors: [{ messageId: 'bareInit' }],
      },
      {
        // Regression: a file-level "harness is imported" flag used to silence
        // bareInit for EVERY app in the file, so a second unbound app here
        // went unreported.
        name: 'a second, unharnessed app in the same file is still reported',
        code: `
          import request from 'supertest';
          import { listenOnLoopback } from '../../test/utils/listen-on-loopback';
          let a, b;
          a = moduleRef.createNestApplication();
          await a.init();
          await listenOnLoopback(a);
          b = moduleRef.createNestApplication();
          await b.init();
          await request(b.getHttpServer()).get('/x');
        `,
        options: [LOOPBACK],
        errors: [{ messageId: 'bareInit' }],
      },
      {
        // Regression: ANY string literal used to count as "names a host", so a
        // bind that publishes the app on every interface was accepted.
        name: 'listening on 0.0.0.0 is reported, not accepted as a named host',
        code: `
          import request from 'supertest';
          let app;
          app = moduleRef.createNestApplication();
          await app.listen(0, '0.0.0.0');
        `,
        errors: [{ messageId: 'hostlessListen' }],
      },
      {
        // Once a different helper is configured, the default name is just
        // another call.
        name: 'the default helper name harnesses nothing once another is configured',
        code: `
          import request from 'supertest';
          const app = moduleRef.createNestApplication();
          await app.init();
          await listenOnLoopback(app);
          await request(app.getHttpServer()).get('/x');
        `,
        options: [{ loopbackHelper: 'bindLoopback' }],
        errors: [{ messageId: 'bareInit' }],
      },
    ],
  });
});

describe('no-raw-sql-interpolation — every spelling of the Unsafe call', () => {
  ruleTester.run(
    'no-raw-sql-interpolation',
    rules['no-raw-sql-interpolation'] as never,
    {
      valid: [
        // Not an Unsafe method at all, however the SQL is built.
        { code: 'console.log(`SELECT ${id}`);' },
        { code: 'helpers.format.call(null, `SELECT ${id}`);' },
        { code: 'format.call(null, `SELECT ${id}`);' },
        { code: 'const { format } = helpers;\nformat(`SELECT ${id}`);' },
        { code: "prisma['$queryRaw']`SELECT ${id}`;" },
        // A computed destructuring key names its value's property.
        {
          code: "const key = 'format';\nconst { [key]: run } = helpers;\nrun(`SELECT ${id}`);",
        },
        {
          code: 'const { ...client } = prisma;\nclient.query(`SELECT ${id}`);',
        },
        // An alias is per binding.
        {
          code: 'function a() { const { $queryRawUnsafe: q } = prisma; return q; }\nfunction b(q: (s: string) => void) { q(`SELECT ${id}`); }',
        },
        // Judged after the whole file is read, an alias declared later is
        // still per binding: a parameter shadows it, a reassignment voids it.
        {
          code: 'function b(q: (s: string) => void) { q(`SELECT ${id}`); }\nconst { $queryRawUnsafe: q } = prisma;',
        },
        {
          code: 'function b() { q(`SELECT ${id}`); }\nlet { $queryRawUnsafe: q } = prisma;\nq = format;',
        },
        // Nothing passed, a hole, or a list built elsewhere: no visible SQL.
        { code: 'prisma.$queryRawUnsafe();' },
        { code: 'prisma.$queryRawUnsafe.apply(prisma, [, id]);' },
        { code: 'prisma.$queryRawUnsafe.apply(prisma, args);' },
        { code: 'prisma.$queryRawUnsafe.bind(prisma, `SELECT ${id}`);' },
        // Only `+` builds a string; other operators and unary `+` do not.
        { code: 'prisma.$queryRawUnsafe(offset - 1);' },
        { code: 'prisma.$queryRawUnsafe(+offset);' },
        // `.concat()` with nothing to append is the constant it was.
        { code: "prisma.$queryRawUnsafe('SELECT 1'.concat());" },
      ],
      invalid: [
        ...[
          "prisma['$queryRawUnsafe'](`SELECT ${id}`);",
          'prisma[`$queryRawUnsafe`](`SELECT ${id}`);',
          'prisma.$queryRawUnsafe(`SELECT ${id}` as string);',
          'prisma.$queryRawUnsafe(`SELECT ${id}` satisfies string);',
          'prisma.$executeRawUnsafe(`DELETE ${id}`!);',
          'prisma.$executeRawUnsafe(<string>`DELETE ${id}`);',
          'const { $queryRawUnsafe } = prisma;\n$queryRawUnsafe(`SELECT ${id}`);',
          "const { ['$queryRawUnsafe']: q } = prisma;\nq(`SELECT ${id}`);",
          'prisma.$queryRawUnsafe.call(prisma, `SELECT ${id}`);',
          'const { $queryRawUnsafe: q } = prisma;\nq.call(prisma, `SELECT ${id}`);',
          'prisma.$executeRawUnsafe.apply(prisma, [`DELETE ${id}`]);',
          "prisma.$queryRawUnsafe('SELECT '.concat(id));",
          'prisma.$queryRawUnsafe(prefix?.concat(id));',
          // A function declared before the alias still runs after it.
          'function run() { q(`SELECT ${id}`); }\nconst { $queryRawUnsafe: q } = prisma;\nrun();',
          'function run() { q.call(prisma, `SELECT ${id}`); }\nconst { $queryRawUnsafe: q } = prisma;\nrun();',
        ].map(code => ({ code, errors: [{ messageId: 'unsafe' as const }] })),
      ],
    },
  );
});

describe('nest-http-exception — what makes a file Nest and an Error bare', () => {
  ruleTester.run('nest-http-exception', rules['nest-http-exception'] as never, {
    valid: [
      // Importing something other than Nest does not make the file Nest code.
      { code: "import { z } from 'zod';\nthrow new Error('boom');" },
      // Rethrowing a caught value is not constructing a bare Error.
      {
        code: "import { Injectable } from '@nestjs/common';\ntry { run(); } catch (err) { throw err; }",
      },
      {
        code: "import { Injectable } from '@nestjs/common';\nthrow new errors.Error('x');",
      },
    ],
    invalid: [
      {
        // `Error('x')` without `new` builds the same bare Error.
        code: "import { Injectable } from '@nestjs/common';\nthrow Error('invalid input');",
        errors: [{ messageId: 'bareError' }],
      },
    ],
  });
});

describe('prisma-transaction-multiwrite — every write, root and function', () => {
  const twoWrites = (body: string) => `async function f() {\n${body}\n}`;
  ruleTester.run(
    'prisma-transaction-multiwrite',
    rules['prisma-transaction-multiwrite'] as never,
    {
      valid: [
        // An unrelated object that merely holds a `.prisma` field.
        {
          code: twoWrites(
            '  await holder.prisma.invoice.update({ where: { id }, data: {} });\n  await holder.prisma.auditLog.create({ data: {} });',
          ),
        },
        // A `$` member is the client's own API (`$metrics`, `$extends`),
        // never a model delegate, so calls through it are not model writes.
        {
          code: twoWrites(
            '  await prisma.$metrics.create({});\n  await prisma.$metrics.delete({});',
          ),
        },
        // Two top-level writes have no function to share.
        {
          code: 'await prisma.invoice.create({ data: {} });\nawait prisma.auditLog.create({ data: {} });',
        },
        // Reads are not writes.
        {
          code: twoWrites(
            '  await prisma.invoice.findMany({});\n  await prisma.invoice.count({});',
          ),
        },
      ],
      invalid: [
        ...[
          'await db.invoice.createMany({ data: [] });\n  await db.auditLog.upsert({ where: { id }, create: {}, update: {} });',
          'await tx.invoice.updateMany({ where: {}, data: {} });\n  await tx.auditLog.delete({ where: { id } });',
          'await trx.invoice.create({ data: {} });\n  await trx.auditLog.update({ where: { id }, data: {} });',
          'await transaction.invoice.deleteMany({ where: {} });\n  await transaction.auditLog.createMany({ data: [] });',
          // A callback handed to anything but a transaction helper is not
          // transacted by it.
          'await retry(async () => {\n    await prisma.invoice.create({ data: {} });\n    await prisma.auditLog.create({ data: {} });\n  });',
        ].map(body => ({
          code: twoWrites(`  ${body}`),
          options: [WRAPPERS],
          errors: [{ messageId: 'untransacted' as const }],
        })),
        {
          code: 'const f = async function () {\n  await prisma.invoice.create({ data: {} });\n  await prisma.auditLog.create({ data: {} });\n};',
          errors: [{ messageId: 'untransacted' }],
        },
        {
          code: 'const f = async () => {\n  await prisma.invoice.create({ data: {} });\n  await prisma.auditLog.create({ data: {} });\n};',
          errors: [{ messageId: 'untransacted' }],
        },
        {
          code: 'class S {\n  async save() {\n    await this.prisma.invoice.create({ data: {} });\n    await this.prisma.auditLog.create({ data: {} });\n  }\n}',
          errors: [{ messageId: 'untransacted' }],
        },
      ],
    },
  );
});

describe('nest-param-pipe — which decorators and pipes count', () => {
  ruleTester.run('nest-param-pipe', rules['nest-param-pipe'] as never, {
    valid: [
      // Only @Param and @Query bring a value straight from the request.
      { code: 'class C {\n  create(@Body() body: number) { return body; }\n}' },
      { code: 'class C {\n  get(@Param("id") id) { return id; }\n}' },
      {
        code: 'class C {\n  get(@Param("id", ValidationPipe) id: string) { return id; }\n}',
      },
      { code: 'class C {\n  get(@Query("on") on: boolean) { return on; }\n}' },
    ],
    invalid: [
      {
        // A second, bare decorator brings no pipe with it.
        code: 'class C {\n  get(@Param("id") @Trim id: string) { return id; }\n}',
        errors: [{ messageId: 'unparsed' }],
      },
      {
        // A fallback is not a parse.
        code: 'class C {\n  list(@Query("page", new DefaultValuePipe(1)) page: number) { return page; }\n}',
        errors: [{ messageId: 'unparsed' }],
      },
      {
        code: 'class C {\n  list(@Query page: number) { return page; }\n}',
        errors: [{ messageId: 'unparsed' }],
      },
    ],
  });
});

describe('no-unbound-test-app — every host, holder and spelling', () => {
  const NEST = "import request from 'supertest';\n";
  ruleTester.run('no-unbound-test-app', rules['no-unbound-test-app'] as never, {
    valid: [
      ...["'::1'", "'localhost'"].map(host => ({
        code: `${NEST}const app = moduleRef.createNestApplication();\nawait app.init();\nawait app.listen(0, ${host});`,
      })),
      // A Nest import is not supertest: nothing dials the app over HTTP.
      {
        code: "import { Test } from '@nestjs/testing';\nconst app = moduleRef.createNestApplication();\nawait app.init();",
      },
      // A raw server assigned later is still not a Nest app.
      {
        code: `${NEST}let server;\nserver = createServer(handler);\nserver.listen(0);`,
      },
      {
        code: `${NEST}class S { async start() { this.app = moduleRef.createNestApplication(); await this.app.listen(0, '127.0.0.1'); } }`,
      },
      // A different field on `this` is a different holder.
      {
        code: `${NEST}class S { async start() { this.app = moduleRef.createNestApplication(); await this.server.listen(0); } }`,
      },
      // A holder the AST cannot name is not tracked.
      {
        code: `${NEST}this[key] = moduleRef.createNestApplication();\nawait this[key].listen(0);\nawait getApp().listen(0);\nawait listenOnLoopback(getApp());`,
        options: [LOOPBACK],
      },
      {
        code: `${NEST}class S { async start() { this.app = moduleRef.createNestApplication(); await this.app.init(); await listenOnLoopback(this.app); } }`,
        options: [LOOPBACK],
      },
    ],
    invalid: [
      {
        code: `${NEST}const app = await moduleRef.createNestApplication();\nawait app.listen(0);`,
        errors: [{ messageId: 'hostlessListen' }],
      },
      {
        code: `${NEST}class S { async start() { this.app = moduleRef.createNestApplication(); await this.app.listen(0); } }`,
        errors: [{ messageId: 'hostlessListen' }],
      },
      {
        code: `${NEST}const app = moduleRef.createNestApplication();\nawait app['listen'](0);`,
        errors: [{ messageId: 'hostlessListen' }],
      },
      {
        code: `${NEST}const app = moduleRef.createNestApplication() as App;\nawait app.listen(0);`,
        errors: [{ messageId: 'hostlessListen' }],
      },
      {
        // Only the loopback helper harnesses an app; any other helper may not.
        code: `${NEST}const app = moduleRef.createNestApplication();\nawait app.init();\nawait configure(app);\nawait request(app.getHttpServer()).get('/x');`,
        options: [LOOPBACK],
        errors: [{ messageId: 'bareInit' }],
      },
    ],
  });
});
