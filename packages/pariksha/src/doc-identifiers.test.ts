import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boundedWord, findIdentifierProblems, identifierRef, isCode, manifestObject, wordsInCode } from './doc-identifiers.ts';
import { CONFIG, createTestRepo, testConfig, type TestRepo } from './doc-references.fixture.test.ts';
import type { Config } from './doc-references-config.ts';

const DOC = 'docs/guides/DEPLOYMENT_CHECKLIST.md';

const SCHEMA = ['model Store {', '  id        String @id', '  brandId   String', '  code      String', '  @@unique([brandId, code])', '}', '', 'enum UserRoleEnum {', '  ADMIN', '  STORE_MANAGER', '}', ''].join('\n');

const CONTROLLER = ["@Controller('admin/stores')", 'export class StoresController {', "  @Get(':id')", '  findOne() {}', '  @Post()', '  create() {}', '}', ''].join('\n');

const WORKFLOW = ['on: push', 'jobs:', '  validation:', '    name: Validate', '    runs-on: ubuntu-latest', '    steps: []', ''].join('\n');

const repo = (doc: string, extra: Record<string, string> = {}): TestRepo =>
  createTestRepo({
    'apps/server/src/redis/redis.module.ts': 'const url = process.env.REDIS_URL;\nexport function connectRedis() { return url; }\n',
    'apps/server/prisma/schema.prisma': SCHEMA,
    'apps/server/prisma/migrations/20250101000000_init/migration.sql': '--\n',
    'apps/server/src/stores/stores.controller.ts': CONTROLLER,
    'apps/server/package.json': '{ "name": "@acme/server" }\n',
    '.github/workflows/ci.yml': WORKFLOW,
    'pnpm-lock.yaml': 'packages:\n\n  zod@3.24.1:\n    resolution: {}\n',
    ...extra,
    [DOC]: doc,
  });

const problems = (r: TestRepo, files: string[] = [DOC], config: Config = CONFIG) => findIdentifierProblems(config, r.snapshot(), files);
const refs = (r: TestRepo, files: string[] = [DOC], config: Config = CONFIG): string[] => problems(r, files, config).map((p) => p.ref);

describe('DOC-DRIFT-04: a checklist naming env vars the code does not read', () => {
  // The deployment checklist listed REDIS_HOST/PORT/PASSWORD; the code reads
  // REDIS_URL, so a deploy that followed the doc broke.
  const EXAMPLE = ['- [ ] `REDIS_HOST` set', '- [ ] `REDIS_PORT` set', '- [ ] `REDIS_PASSWORD` set', ''].join('\n');

  it('fails the example for the intended reason', () => {
    const found = problems(repo(EXAMPLE));
    assert.deepEqual(
      found.map((p) => p.ref),
      ['REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD'],
    );
    const [first] = found;
    assert.equal(first?.check, 'DOC-DRIFT-04');
    assert.equal(first?.line, 1);
    assert.match(String(first?.reason), /occurs nowhere in the code/);
  });

  it('passes the corrected checklist', () => {
    assert.deepEqual(problems(repo('- [ ] `REDIS_URL` set\n')), []);
  });

  it('near-miss: a name defined only in .env.example still counts as code', () => {
    assert.deepEqual(problems(repo('- [ ] `SENTRY_DSN` set\n', { '.env.example': 'SENTRY_DSN=\n' })), []);
  });

  it('removing the guard flips it: an unchecked doc reports nothing', () => {
    assert.deepEqual(findIdentifierProblems(CONFIG, repo(EXAMPLE).snapshot(), []), []);
  });

  it('a doc mention does not define a name: docs are not code', () => {
    assert.equal(problems(repo('`REDIS_HOST`\n', { 'docs/other.md': 'REDIS_HOST is legacy.\n' })).length, 1);
  });
});

describe('DOC-DRIFT-04 kinds', () => {
  it('checks "`x` in `path`" against that file only', () => {
    const found = problems(repo(['`connectRedis()` in `apps/server/src/redis/redis.module.ts`', '`REDIS_URL` in `apps/server/src/stores/stores.controller.ts`', ''].join('\n')));
    assert.equal(found.length, 1);
    assert.equal(found[0]?.line, 2);
    assert.match(String(found[0]?.reason), /the file the doc cites/);
  });

  it('checks Prisma fields and unique constraints', () => {
    const r = repo(['`Store.brandId` and `Store.storeCode`; `Unknown.field` is not ours.', '`@@unique([brandId, code])` and `@@unique([code, brandId])`', ''].join('\n'));
    assert.deepEqual(refs(r), ['Store.storeCode', '@@unique([code, brandId])']);
  });

  it('checks migrations, routes and roles', () => {
    const r = repo(
      [
        '`20250101000000_init` and `20250202000000_gone`',
        '`GET /api/v1/admin/stores/:storeId` and `DELETE /admin/stores/:id`',
        '`GET /health` belongs to no controller here, so it is not judged.',
        '`@Roles(UserRoleEnum.ADMIN, STORE_MANAGER)` and `@Roles(OWNER)`',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      problems(r).map((p) => [p.line, p.ref]),
      [
        [1, '20250202000000_gone'],
        [2, 'DELETE /admin/stores/:id'],
        [4, '@Roles(OWNER)'],
      ],
    );
  });

  it('checks CI jobs by id or name', () => {
    assert.deepEqual(refs(repo('The `validation` job, the `Validate` job and the `lintAll` job.\n')), ['lintAll']);
  });

  it('checks workspace names and locked versions', () => {
    assert.deepEqual(refs(repo('`@acme/server`, `@acme/ghost`, `zod@3.24.1`, `zod@9.9.9`, `@other/pkg`\n')), ['@acme/ghost', 'zod@9.9.9']);
  });

  it('skips frozen history docs, fences and marked lines', () => {
    // The config's `files.exclude` names the frozen tree (`docs/history/`).
    const r = repo(['`plannedHelper` <!-- doc-ref-ok: proposed name -->', '```ts', 'plannedHelper();', '```', ''].join('\n'), { 'docs/history/0001-x/spec.md': '`plannedHelper()` will exist.\n' });
    assert.deepEqual(problems(r, [DOC, 'docs/history/0001-x/spec.md']), []);
  });

  it('reads Markdown only: a code file, frontmatter and an absent doc name nothing', () => {
    const r = repo(['---', 'title: `ghostFrontmatter`', '---', 'body', ''].join('\n'), { 'apps/server/src/note.ts': '// `ghostInCode`\n' });
    assert.deepEqual(problems(r, [DOC, 'apps/server/src/note.ts', 'docs/absent.md']), []);
  });
});

describe('identifierRef', () => {
  const NONE = CONFIG.identifiers.notIdentifiers;
  for (const [span, kind] of [
    ['REDIS_URL', 'symbol'],
    ['findScriptProblems', 'symbol'],
    ['ProductService', 'symbol'],
    ['parseArgs()', 'symbol'],
    ['Store.code', 'prisma-field'],
    ['20250101000000_init', 'migration'],
    ['GET /admin/stores', 'route'],
    ['@Roles(ADMIN)', 'roles'],
    ['@@unique([a, b])', 'prisma-unique'],
    ['@acme/shared', 'package'],
    ['zod@3.24.1', 'package'],
  ] as const) {
    it(`${span} is a ${kind}`, () => {
      assert.equal(identifierRef(span, NONE)?.kind, kind);
    });
  }

  for (const span of ['store_id', 'GitHub', 'xit', 'go()', 'two words', 'lowercase', '', 'a.b', 'store.Code']) {
    it(`${JSON.stringify(span)} is not an identifier reference`, () => {
      assert.equal(identifierRef(span, NONE), null);
    });
  }

  it('treats prose, lockfiles and the baseline as non-code', () => {
    assert.equal(isCode(CONFIG, 'apps/server/src/a.ts'), true);
    assert.equal(isCode(CONFIG, '.env.example'), true);
    assert.equal(isCode(CONFIG, 'docs/a.ts'), false);
    assert.equal(isCode(CONFIG, 'README.md'), false);
    assert.equal(isCode(CONFIG, 'pnpm-lock.yaml'), false);
    assert.equal(isCode(CONFIG, 'assets/logo.png'), false);
    assert.equal(isCode(CONFIG, CONFIG.baseline), false);
  });

  it('a validator test does not define the wrong names it quotes', () => {
    // The config's `searchExclude` names the validators' tests and fixtures.
    assert.equal(isCode(CONFIG, 'scripts/docs/check-doc-identifiers.test.ts'), false);
    assert.equal(isCode(CONFIG, 'scripts/docs/x/__fixtures__/a.ts'), false);
    // Other tests stay: docs cite real test helpers.
    assert.equal(isCode(CONFIG, 'apps/server/test/helpers.e2e.test.ts'), true);
    assert.equal(isCode(CONFIG, 'scripts/docs/check.ts'), true);
  });

  it('near-miss: the same name in a validator test still fails the doc', () => {
    assert.equal(problems(repo('- [ ] `REDIS_HOST` set\n', { 'scripts/docs/x/check.test.ts': "const stale = 'REDIS_HOST';\n" })).length, 1);
  });

  // The names the source shipped built in; here they are the config's `notIdentifiers`.
  const PRODUCTS = [
    'GitHub',
    'GitLab',
    'TypeScript',
    'JavaScript',
    'PostgreSQL',
    'MySQL',
    'SQLite',
    'NestJS',
    'NodeJS',
    'MacBook',
    'iPhone',
    'iPad',
    'iOS',
    'macOS',
    'tvOS',
    'watchOS',
    'PowerShell',
    'YouTube',
    'WhatsApp',
    'OpenAI',
    'ChatGPT',
    'CocoaPods',
    'DevTools',
    'TestFlight',
    'CodePush',
    'ReactNative',
    'GraphQL',
    'OAuth',
    'eBay',
    'LaunchAgent',
    'LaunchAgents',
    'FleetView',
    'SonarQube',
    'SonarCloud',
    'CodeQL',
    'ShellCheck',
    'xit',
    'xtest',
    'xdescribe',
    'fdescribe',
  ];
  const products = new Set(PRODUCTS);
  for (const name of PRODUCTS) {
    it(`${name} names no code of this repo, called or not`, () => {
      assert.equal(identifierRef(name, products), null);
      assert.equal(identifierRef(`${name}()`, products), null);
    });
  }

  it('reads a product name as a symbol when the config does not list it', () => {
    assert.deepEqual(identifierRef('GitLab', new Set()), { kind: 'symbol', text: 'GitLab', word: 'GitLab' });
    assert.equal(identifierRef('GitLab', CONFIG.identifiers.notIdentifiers)?.kind, 'symbol');
  });

  it('looks a call up by its last name, three letters or more', () => {
    assert.deepEqual(identifierRef('abc()', NONE), { kind: 'symbol', text: 'abc()', word: 'abc' });
    assert.equal(identifierRef('a.b.runAll()', NONE)?.word, 'runAll');
    assert.equal(identifierRef('GET  /admin', NONE), null);
    assert.equal(isCode(CONFIG, 'scripts/docs/doc-references-baseline.json'), false);
  });

  it('trims a span before reading it', () => {
    assert.deepEqual(identifierRef('  REDIS_URL ', NONE), { kind: 'symbol', text: 'REDIS_URL', word: 'REDIS_URL' });
  });
});

describe('DOC-DRIFT-04 reasons and edges', () => {
  it('says what is missing, for every kind', () => {
    const r = repo(
      [
        '`REDIS_HOST`',
        '`REDIS_URL` in `apps/server/src/stores/stores.controller.ts:3`',
        '`Store.storeCode`',
        '`@@unique([code, brandId])`',
        '`20250202000000_gone`',
        '`DELETE /api/admin/stores/:id?x=1`',
        '`@Roles(OWNER)`',
        'The `lintAll` job.',
        '`@acme/ghost` and `zod@9.9.9`',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      problems(r).map((p) => [p.line, p.reason]),
      [
        [1, '`REDIS_HOST` occurs nowhere in the code — renamed, removed, or never written'],
        [2, '`REDIS_URL` does not occur in `apps/server/src/stores/stores.controller.ts`, the file the doc cites for it'],
        [3, 'Prisma model `Store` has no field `storeCode`'],
        [4, 'no Prisma model declares `@@unique([code, brandId])`'],
        [5, '`20250202000000_gone` is not a directory under apps/server/prisma/migrations/'],
        [6, 'no controller serves `DELETE /api/admin/stores/:id`'],
        [7, '`OWNER` is not a value of UserRoleEnum'],
        [8, 'no workflow has a job `lintAll`'],
        [9, 'no workspace is named `@acme/ghost`'],
        [9, 'the lockfile has no `zod@9.9.9`'],
      ],
    );
  });

  it('finds every name, calls by name, and a `$` name in its cited file', () => {
    const r = repo(['`REDIS_URL` and `connectRedis()`', '`$store()` in `apps/server/src/store.ts`', '`@acme/server` job', ''].join('\n'), { 'apps/server/src/store.ts': 'export const $store = 1;\n' });
    assert.deepEqual(problems(r), []);
  });

  it('reads a cited file beside the doc or from the root, after `in` or `from`; an untracked one cites nothing', () => {
    const r = repo(['`localName` from `local.ts`', '`localName` in [`local.ts`]', '`REDIS_URL` in `apps/server/src/gone.ts`', '`ghostName` in `apps/server/src/gone.ts`', ''].join('\n'), { 'docs/guides/local.ts': 'export const other = 1;\n', 'apps/server/src/elsewhere.ts': 'export const localName = 1;\n' });
    assert.deepEqual(
      problems(r).map((p) => [p.line, p.reason]),
      [
        [1, '`localName` does not occur in `docs/guides/local.ts`, the file the doc cites for it'],
        [2, '`localName` does not occur in `docs/guides/local.ts`, the file the doc cites for it'],
        [4, '`ghostName` occurs nowhere in the code — renamed, removed, or never written'],
      ],
    );
  });

  it('a documented parameter matches a parameter only, never a literal segment', () => {
    const r = repo(['`GET /counts/:id`', '`GET /counts/total` `GET /admin/stores/:storeId` `GET /admin/stores/42`', ''].join('\n'), { 'apps/server/src/counts/counts.controller.ts': "@Controller('counts')\n@Get('total')\n" });
    assert.deepEqual(
      problems(r).map((p) => [p.line, p.ref, p.reason]),
      [[1, 'GET /counts/:id', 'no controller serves `GET /counts/:id`']],
    );
  });

  it('matches controller parameters, prefixes, and paths without a prefix', () => {
    const r = repo(
      ['`GET /reports/weekly` `GET /reports/daily/summary` `POST /admin/stores`', '`GET /admin/stores/{id}` `GET /health` `GET /admin/{a,b}`', '`GET /reports/a/b/c`', '`POST /reports/x`', '`POST /health`', '`POST /v1/ping`', ''].join('\n'),
      {
        'apps/server/src/reports/reports.controller.ts': ["@Controller('reports')", "@Get(':kind')", "@Get('daily/summary')", ''].join('\n'),
        'apps/server/src/health/health.controller.ts': "@Get('health')\n",
        'apps/server/src/v1/v1.controller.ts': "@Controller('v1')\n@Get('ping')\n",
      },
    );
    assert.deepEqual(
      problems(r).map((p) => p.line),
      [3, 4, 5, 6],
    );
  });

  it('leaves a route that is all prefix, or whose anchor drops, unjudged', () => {
    const r = repo(['`GET /api/v1` `GET /api/v1#top` `GET /` `PUT /admin/stores/1#x`', ''].join('\n'));
    assert.deepEqual(
      problems(r).map((p) => p.ref),
      ['PUT /admin/stores/1#x'],
    );
    assert.equal(problems(r)[0]?.reason, 'no controller serves `PUT /admin/stores/1`');
  });

  it('fails a role when no role enum exists to judge it against', () => {
    const r = repo('`@Roles(ANYTHING, OTHER)`\n', { 'apps/server/prisma/schema.prisma': 'model Store {\n  id String\n}\n' });
    assert.deepEqual(
      problems(r).map((p) => [p.ref, p.reason]),
      [['@Roles(ANYTHING, OTHER)', 'no `UserRoleEnum` in the Prisma schema to check roles against']],
    );
  });

  it('fails a role when the role schema is not tracked at all', () => {
    const config = testConfig({ identifiers: { prisma: { roles: { schema: 'apps/server/prisma/roles.prisma' } } } });
    assert.deepEqual(
      problems(repo('`@Roles(ADMIN)`\n'), [DOC], config).map((p) => p.reason),
      ['no `UserRoleEnum` in the Prisma schema to check roles against'],
    );
  });

  it('names the configured role enum in both role reasons', () => {
    const config = testConfig({ identifiers: { prisma: { roles: { enum: 'StaffRole' } } } });
    const missing = repo('`@Roles(ADMIN)`\n');
    assert.deepEqual(
      problems(missing, [DOC], config).map((p) => p.reason),
      ['no `StaffRole` in the Prisma schema to check roles against'],
    );
    const present = repo('`@Roles(OWNER, GHOST)`\n', { 'apps/server/prisma/schema.prisma': `${SCHEMA}\nenum StaffRole {\n  OWNER\n}\n` });
    assert.deepEqual(
      problems(present, [DOC], config).map((p) => p.reason),
      ['`GHOST` is not a value of StaffRole'],
    );
  });

  it('reads job ids and string names from workflow files only', () => {
    const r = repo(['the `nullJob` job, the `stringJob` job, the `numberName` job', 'the `buildAll` job, the `namedJob` job, the `ghostJob` job', ''].join('\n'), {
      '.github/workflows/a.yml': '[]\n',
      '.github/workflows/b.yml': 'just text\n',
      '.github/workflows/c.yml': 'jobs: null\n',
      '.github/workflows/d.yml': 'jobs: 5\n',
      '.github/workflows/e.yml': ['jobs:', '  nullJob:', '  stringJob: x', '  numberName:', '    name: 5', '  namedJob:', '    name: buildAll', ''].join('\n'),
      '.github/workflows/f.yml': 'null\n',
      '.github/workflows/g.yml': 'a: [\n',
      '.github/other.yml': 'jobs:\n  ghostJob: {}\n',
    });
    assert.deepEqual(refs(r), ['ghostJob']);
  });

  it('takes workspace names from package.json files only', () => {
    assert.deepEqual(refs(repo('`@acme/fake`\n', { 'apps/x/tsconfig.json': '{ "name": "@acme/fake" }\n' })), ['@acme/fake']);
  });

  it('reads a manifest with no string name, or none that parses, as naming nothing', () => {
    const r = repo('`@acme/nameless` `@acme/broken`\n', { 'apps/a/package.json': '{ "name": 5 }\n', 'apps/b/package.json': '{ not json\n', 'apps/c/package.json': '[]\n' });
    assert.deepEqual(refs(r), ['@acme/nameless', '@acme/broken']);
  });

  it('reads Prisma ids, views and attribute arguments as the schema writes them', () => {
    const schema = ['model Line {', '  orderId String', '  sku     String', '  // a comment', '', '  @@id([orderId, sku(sort: Desc)])', '}', 'view Totals {', '  sum Int', '}', ''].join('\n');
    const r = repo('`@@unique([orderId, sku])` `Totals.sum` `Totals.avg` `Line.sku`\n', { 'apps/server/prisma/schema.prisma': schema });
    assert.deepEqual(refs(r), ['Totals.avg']);
  });
});

describe('DOC-DRIFT-04 with a config key set to null', () => {
  const ALL = [
    '`Store.storeCode`', // 1 prisma-field
    '`@@unique([code, brandId])`', // 2 prisma-unique
    '`20250202000000_gone`', // 3 migration
    '`@Roles(OWNER)`', // 4 roles
    '`DELETE /admin/stores/:id`', // 5 route
    'The `lintAll` job.', // 6 job
    '`@acme/ghost` `zod@9.9.9`', // 7 package
    '`REDIS_HOST`', // 8 symbol
    '',
  ].join('\n');
  const lines = (config: Config): number[] => problems(repo(ALL), [DOC], config).map((p) => p.line);

  it('judges every kind under the full config', () => {
    assert.deepEqual(lines(CONFIG), [1, 2, 3, 4, 5, 6, 7, 7, 8]);
  });

  it('prisma: null leaves fields, uniques, migrations and roles unjudged', () => {
    assert.deepEqual(lines(testConfig({ identifiers: { prisma: null } })), [5, 6, 7, 7, 8]);
  });

  it('prisma.migrations: null leaves migrations unjudged', () => {
    assert.deepEqual(lines(testConfig({ identifiers: { prisma: { migrations: null } } })), [1, 2, 4, 5, 6, 7, 7, 8]);
  });

  it('prisma.roles: null leaves roles unjudged', () => {
    assert.deepEqual(lines(testConfig({ identifiers: { prisma: { roles: null } } })), [1, 2, 3, 5, 6, 7, 7, 8]);
  });

  it('routes: null leaves routes unjudged', () => {
    assert.deepEqual(lines(testConfig({ identifiers: { routes: null } })), [1, 2, 3, 4, 6, 7, 7, 8]);
  });

  it('jobs: null leaves jobs unjudged', () => {
    assert.deepEqual(lines(testConfig({ identifiers: { jobs: null } })), [1, 2, 3, 4, 5, 7, 7, 8]);
  });

  it('packages: null leaves packages unjudged', () => {
    assert.deepEqual(lines(testConfig({ identifiers: { packages: null } })), [1, 2, 3, 4, 5, 6, 8]);
  });

  it('packages.lockfile: null leaves third-party versions unjudged; workspace names still are', () => {
    const config = testConfig({ identifiers: { packages: { lockfile: null } } });
    assert.deepEqual(
      problems(repo(ALL), [DOC], config)
        .filter((p) => p.line === 7)
        .map((p) => p.reason),
      ['no workspace is named `@acme/ghost`'],
    );
  });

  it('a configured lockfile that is not tracked locks nothing', () => {
    const config = testConfig({ identifiers: { packages: { lockfile: 'other-lock.yaml' } } });
    assert.deepEqual(
      problems(repo('`zod@3.24.1` `@acme/server@1.0.0`\n'), [DOC], config).map((p) => p.reason),
      ['the lockfile has no `@acme/server@1.0.0`'],
    );
  });

  it('packages.ownScopes decides which unknown names fail', () => {
    const config = testConfig({ identifiers: { packages: { ownScopes: ['@other/'] } } });
    assert.deepEqual(refs(repo('`@acme/ghost` `@other/pkg`\n'), [DOC], config), ['@other/pkg']);
  });

  it('the routes prefixes are the config’s', () => {
    const config = testConfig({ identifiers: { routes: { prefixes: '^gateway$' } } });
    const r = repo('`DELETE /gateway/admin/stores/:id` `DELETE /api/admin/stores/:id`\n');
    assert.deepEqual(refs(r, [DOC], config), ['DELETE /gateway/admin/stores/:id']);
  });
});

describe('wordsInCode, manifestObject, boundedWord', () => {
  it('asks nothing of the code for no words, and stops once every word is found', () => {
    const r = repo('', { 'apps/server/src/b.ts': 'alpha beta alpha\n' });
    const snapshot = r.snapshot();
    assert.deepEqual(wordsInCode(CONFIG, snapshot, []), new Set());
    assert.deepEqual(wordsInCode(CONFIG, snapshot, ['alpha', 'beta', 'gamma']), new Set(['alpha', 'beta']));
    assert.deepEqual(wordsInCode(CONFIG, snapshot, ['alpha']), new Set(['alpha']));
  });

  it('reads a manifest as an object or nothing', () => {
    assert.deepEqual(manifestObject('{"name":"x"}'), { name: 'x' });
    assert.equal(manifestObject('[1]'), undefined);
    assert.equal(manifestObject('null'), undefined);
    assert.equal(manifestObject('{ nope'), undefined);
  });

  it('bounds a word, `$` included, by non-identifier characters', () => {
    assert.equal(boundedWord('$store').test('const $store = 1'), true);
    assert.equal(boundedWord('$store').test('const a$store = 1'), false);
    assert.equal(boundedWord('run').test('runAll()'), false);
    assert.equal(boundedWord('run').test('x.run()'), true);
  });
});
