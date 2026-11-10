// The doc-references config: the fixture's config reads as written, each bad
// shape is refused with a message naming where, and a null opts a check out
// and is recorded as not checked.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from './doc-references-config.ts';
import { CONFIG_JSON, merged } from './doc-references.fixture.test.ts';

type Json = Record<string, unknown>;

/** The fixture's config with `over` merged in, as config text. */
const source = (over: Json): string => JSON.stringify(merged(CONFIG_JSON, over));

/** The fixture's config with the key at `path` set to `value` (removed when undefined), as config text. */
const replaced = (path: readonly string[], value: unknown): string => {
  const copy = JSON.parse(JSON.stringify(CONFIG_JSON)) as Json;
  let at: Json = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Json;
  const last = String(path.at(-1));
  if (value === undefined) delete at[last];
  else at[last] = value;
  return JSON.stringify(copy);
};

/** The fixture's config with the key at `path` removed. */
const without = (path: readonly string[]): string => replaced(path, undefined);

const refuses = (text: string, message: string | RegExp): void => {
  assert.throws(() => parseConfig(text), { message });
};

describe('parseConfig accepts the fixture config', () => {
  const config = parseConfig(JSON.stringify(CONFIG_JSON));

  it('reads every section as written', () => {
    assert.equal(config.baseline, 'scripts/docs/doc-references-baseline.json');
    assert.equal(config.exemptWord, 'doc-ref-ok');
    assert.equal(config.exemptMarker.test('x doc-ref-ok: why'), true);
    assert.equal(config.exemptMarker.test('x doc-ref-ok:'), false);
    assert.equal(config.files.markdown.length, 2);
    assert.equal(config.files.hashComments.test('a.sh'), true);
    assert.equal(config.placeholder.test('docs/<name>.md'), true);
    assert.equal(config.paths.extensions.has('ts'), true);
    assert.equal(config.paths.examples.flags, 'i');
    assert.equal(config.paths.examples.test('FOO.md'), true);
    assert.deepEqual(config.paths.untracked, ['.claude/worktrees/']);
    assert.equal(config.paths.workspaces.test('apps/web/package.json'), true);
    assert.equal(config.paths.layouts.length, 1);
    assert.equal(config.paths.layouts[0]?.except?.test('docs/work/x.md'), true);
    assert.equal(config.links?.include.test('a.md'), true);
    assert.deepEqual(config.scripts.manifests, CONFIG_JSON.scripts.manifests);
    assert.deepEqual([...config.scripts.mutating], [
      ['lint', 'lint:ci'],
      ['lint:fix', 'lint:ci'],
      ['format', 'format:check'],
    ]);
    assert.equal(config.scripts.verification.test('VERIFY'), true);
    assert.deepEqual(config.scripts.wrappers, ['dev:exec']);
    assert.equal(config.commands.typescriptRunner, 'pnpm exec tsx');
    assert.equal(config.commands.nested.includes('vitest'), true);
    assert.equal(config.identifiers.notIdentifiers.has('GitHub'), true);
    assert.equal(config.identifiers.searchExclude.length, 4);
    assert.deepEqual(config.identifiers.diffExclude, ['*.md', 'docs/**']);
    assert.equal(config.identifiers.prisma?.schemas.test('apps/server/prisma/schema.prisma'), true);
    assert.equal(config.identifiers.prisma?.migrations, 'apps/server/prisma/migrations');
    assert.deepEqual(config.identifiers.prisma?.roles, { schema: 'apps/server/prisma/schema.prisma', enum: 'UserRoleEnum' });
    assert.equal(config.identifiers.routes?.controllers.test('apps/server/src/a.controller.ts'), true);
    assert.equal(config.identifiers.routes?.prefixes.test('v1'), true);
    assert.equal(config.identifiers.jobs?.workflows.test('.github/workflows/ci.yml'), true);
    assert.equal(config.identifiers.packages?.lockfile, 'pnpm-lock.yaml');
    assert.deepEqual(config.identifiers.packages?.ownScopes, ['@acme/']);
    assert.deepEqual(config.skipped, []);
  });

  it('reads a layout without an exception, and empty optional lists', () => {
    const lean = parseConfig(
      source({
        files: { html: [], code: [], codeExclude: [], exclude: [] },
        paths: { untracked: [], layouts: [{ pattern: '^x/' }] },
        scripts: { wrappers: [] },
        commands: { nested: [] },
        identifiers: { notIdentifiers: [], searchExclude: [], diffExclude: [], packages: { ownScopes: [] } },
      }),
    );
    assert.equal(lean.paths.layouts[0]?.except, undefined);
    assert.deepEqual(lean.identifiers.packages?.ownScopes, []);
    assert.deepEqual(lean.files.exclude, []);
    // No script is mutating: an empty map.
    assert.equal(parseConfig(replaced(['scripts', 'mutating'], {})).scripts.mutating.size, 0);
  });

  it('reads an absent optional list as empty', () => {
    const config = parseConfig(without(['paths', 'layouts']));
    assert.deepEqual(config.paths.layouts, []);
  });

  it('reads a pattern object without flags as no flags', () => {
    assert.equal(parseConfig(source({ placeholder: { pattern: 'x' } })).placeholder.flags, '');
    assert.equal(parseConfig(source({ placeholder: { pattern: 'x', flags: 'imsu' } })).placeholder.flags, 'imsu');
  });
});

describe('parseConfig records a null as not checked', () => {
  for (const [over, skipped] of [
    [{ links: null }, ['links']],
    [{ commands: { typescriptRunner: null } }, ['commands.typescriptRunner']],
    [{ identifiers: { prisma: null } }, ['identifiers.prisma']],
    [{ identifiers: { prisma: { migrations: null } } }, ['identifiers.prisma.migrations']],
    [{ identifiers: { prisma: { roles: null } } }, ['identifiers.prisma.roles']],
    [{ identifiers: { routes: null } }, ['identifiers.routes']],
    [{ identifiers: { jobs: null } }, ['identifiers.jobs']],
    [{ identifiers: { packages: null } }, ['identifiers.packages']],
    [{ identifiers: { packages: { lockfile: null } } }, ['identifiers.packages.lockfile']],
  ] as const) {
    it(`${skipped.join(', ')}`, () => {
      const config = parseConfig(source(over));
      assert.deepEqual(config.skipped, skipped);
    });
  }

  it('leaves the opted-out parts undefined', () => {
    const config = parseConfig(
      source({
        links: null,
        commands: { typescriptRunner: null },
        identifiers: { prisma: { migrations: null, roles: null }, routes: null, jobs: null, packages: { lockfile: null } },
      }),
    );
    assert.equal(config.links, undefined);
    assert.equal(config.commands.typescriptRunner, undefined);
    assert.equal(config.identifiers.prisma?.migrations, undefined);
    assert.equal(config.identifiers.prisma?.roles, undefined);
    assert.equal(config.identifiers.routes, undefined);
    assert.equal(config.identifiers.jobs, undefined);
    assert.equal(config.identifiers.packages?.lockfile, undefined);
    assert.deepEqual(config.skipped, ['links', 'commands.typescriptRunner', 'identifiers.prisma.migrations', 'identifiers.prisma.roles', 'identifiers.routes', 'identifiers.jobs', 'identifiers.packages.lockfile']);
    assert.equal(parseConfig(source({ identifiers: { prisma: null, packages: null } })).identifiers.prisma, undefined);
  });
});

describe('parseConfig refuses a bad shape', () => {
  it('refuses text that is not a JSON object', () => {
    refuses('{', /^not JSON: /);
    refuses('[]', 'the config must be a JSON object');
  });

  describe('an unknown key at each level', () => {
    for (const [over, message] of [
      [{ extra: 1 }, 'unknown key "extra"'],
      [{ files: { extra: [] } }, 'files: unknown key "extra"'],
      [{ files: { hashComments: { pattern: 'x', extra: 1 } } }, 'files: hashComments: unknown key "extra"'],
      [{ paths: { extra: 1 } }, 'paths: unknown key "extra"'],
      [{ paths: { layouts: [{ pattern: 'x', extra: 1 }] } }, 'paths: layouts[0]: unknown key "extra"'],
      [{ links: { extra: 1 } }, 'links: unknown key "extra"'],
      [{ scripts: { extra: 1 } }, 'scripts: unknown key "extra"'],
      [{ commands: { extra: 1 } }, 'commands: unknown key "extra"'],
      [{ identifiers: { extra: 1 } }, 'identifiers: unknown key "extra"'],
      [{ identifiers: { prisma: { extra: 1 } } }, 'identifiers.prisma: unknown key "extra"'],
      [{ identifiers: { prisma: { roles: { extra: 1 } } } }, 'identifiers.prisma: roles: unknown key "extra"'],
      [{ identifiers: { routes: { extra: 1 } } }, 'identifiers.routes: unknown key "extra"'],
      [{ identifiers: { jobs: { extra: 1 } } }, 'identifiers.jobs: unknown key "extra"'],
      [{ identifiers: { packages: { extra: 1 } } }, 'identifiers.packages: unknown key "extra"'],
    ] as const) {
      it(message, () => refuses(source(over), message));
    }
  });

  describe('a missing required key', () => {
    for (const [path, message] of [
      [['baseline'], '"baseline" must be a non-empty string'],
      [['exemptMarker'], '"exemptMarker" must be a non-empty string'],
      [['files'], '"files" must be an object'],
      [['files', 'hashComments'], 'files: "hashComments" must be a non-empty regular expression'],
      [['placeholder'], '"placeholder" must be a non-empty regular expression'],
      [['paths'], '"paths" must be an object'],
      [['paths', 'examples'], 'paths: "examples" must be a non-empty regular expression'],
      [['paths', 'workspaces'], 'paths: "workspaces" must be a non-empty regular expression'],
      [['links'], '"links" is required (null opts its check out)'],
      [['links', 'include'], 'links: "include" must be a non-empty regular expression'],
      [['scripts'], '"scripts" must be an object'],
      [['scripts', 'mutating'], 'scripts: "mutating" must be an object'],
      [['scripts', 'verification'], 'scripts: "verification" must be a non-empty regular expression'],
      [['commands'], '"commands" must be an object'],
      [['commands', 'typescriptRunner'], 'commands: "typescriptRunner" is required (null opts its check out)'],
      [['identifiers'], '"identifiers" must be an object'],
      [['identifiers', 'prisma'], 'identifiers: "prisma" is required (null opts its check out)'],
      [['identifiers', 'prisma', 'schemas'], 'identifiers.prisma: "schemas" must be a non-empty regular expression'],
      [['identifiers', 'prisma', 'migrations'], 'identifiers.prisma: "migrations" is required (null opts its check out)'],
      [['identifiers', 'prisma', 'roles'], 'identifiers.prisma: "roles" is required (null opts its check out)'],
      [['identifiers', 'prisma', 'roles', 'enum'], 'identifiers.prisma: roles: "enum" must be a non-empty string'],
      [['identifiers', 'prisma', 'roles', 'schema'], 'identifiers.prisma: roles: "schema" must be a non-empty string'],
      [['identifiers', 'routes'], 'identifiers: "routes" is required (null opts its check out)'],
      [['identifiers', 'routes', 'prefixes'], 'identifiers.routes: "prefixes" must be a non-empty regular expression'],
      [['identifiers', 'jobs'], 'identifiers: "jobs" is required (null opts its check out)'],
      [['identifiers', 'packages'], 'identifiers: "packages" is required (null opts its check out)'],
      [['identifiers', 'packages', 'manifests'], 'identifiers.packages: "manifests" must be a non-empty regular expression'],
      [['identifiers', 'packages', 'lockfile'], 'identifiers.packages: "lockfile" is required (null opts its check out)'],
    ] as const) {
      it(path.join('.'), () => refuses(without(path), message));
    }
  });

  describe('a bad regular expression or flags', () => {
    for (const [over, message] of [
      [{ files: { markdown: ['('] } }, /^files: markdown\[0\]: "\(" is not a regular expression: /],
      [{ files: { exclude: [''] } }, /^files: exclude\[0\] must be a non-empty regular expression$/],
      [{ placeholder: '[' }, /^"placeholder": "\[" is not a regular expression: /],
      [{ placeholder: 3 }, /^"placeholder" must be a non-empty regular expression$/],
      [{ paths: { examples: { pattern: '(' } } }, /^paths: examples\.pattern: "\(" is not a regular expression: /],
      [{ paths: { layouts: [{ pattern: '(' }] } }, /^paths: layouts\[0\]: "pattern": "\(" is not a regular expression: /],
      [{ paths: { layouts: [{ pattern: 'x', except: '(' }] } }, /^paths: layouts\[0\]: "except": "\(" is not a regular expression: /],
      [{ paths: { examples: { pattern: 'x', flags: 'g' } } }, /^paths: examples\.flags must be some of i, m, s, u$/],
      [{ scripts: { verification: { pattern: 'x', flags: 3 } } }, /^scripts: verification\.flags must be some of i, m, s, u$/],
      [{ identifiers: { searchExclude: ['('] } }, /^identifiers: searchExclude\[0\]: /],
    ] as const) {
      it(String(message), () => refuses(source(over), message));
    }
  });

  describe('a bad list or value', () => {
    for (const [over, message] of [
      [{ files: { markdown: [] } }, 'files: "markdown" is empty, so nothing would match'],
      [{ files: { markdown: 'x' } }, 'files: "markdown" must be a list'],
      [{ paths: { extensions: [] } }, 'paths: "extensions" is empty, so nothing would match'],
      [{ paths: { extensions: ['.ts'] } }, 'paths: extensions[0]: ".ts" must be lowercase letters and digits, no dot'],
      [{ paths: { extensions: ['TS'] } }, 'paths: extensions[0]: "TS" must be lowercase letters and digits, no dot'],
      [{ paths: { extensions: [''] } }, 'paths: extensions[0] must be a non-empty string'],
      [{ paths: { extensions: [3] } }, 'paths: extensions[0] must be a non-empty string'],
      [{ paths: { untracked: ['.tmp'] } }, 'paths: untracked[0]: ".tmp" must be a root-relative folder ending in /'],
      [{ paths: { untracked: ['/abs/'] } }, 'paths: untracked[0]: "/abs/" must be a root-relative folder ending in /'],
      [{ paths: { untracked: ['../out/'] } }, 'paths: untracked[0]: "../out/" must be a root-relative folder ending in /'],
      [{ paths: { layouts: ['x'] } }, 'paths: layouts[0] must be an object'],
      [{ scripts: { manifests: [] } }, 'scripts: "manifests" is empty, so nothing would match'],
      [{ scripts: { manifests: ['apps/web/manifest.json'] } }, 'scripts: manifests[0]: "apps/web/manifest.json" must be a root-relative package.json'],
      [{ scripts: { manifests: ['../package.json'] } }, 'scripts: manifests[0]: "../package.json" must be a root-relative package.json'],
      [{ scripts: { mutating: { lint: 3 } } }, 'scripts: mutating.lint must name the script to use instead'],
      [{ scripts: { mutating: { lint: '' } } }, 'scripts: mutating.lint must name the script to use instead'],
      [{ commands: { typescriptRunner: ' ' } }, 'commands: "typescriptRunner" must be a non-empty string'],
      [{ identifiers: { prisma: { roles: { enum: 'User-Role' } } } }, 'identifiers.prisma: roles.enum must be an enum name'],
      [{ identifiers: { prisma: { roles: { schema: '../schema.prisma' } } } }, 'identifiers.prisma: roles: "schema": "../schema.prisma" is not a normalized root-relative path'],
      [{ identifiers: { prisma: { migrations: '/abs' } } }, 'identifiers.prisma: "migrations": "/abs" is not a normalized root-relative path'],
      [{ identifiers: { packages: { lockfile: 'a/../pnpm-lock.yaml' } } }, 'identifiers.packages: "lockfile": "a/../pnpm-lock.yaml" is not a normalized root-relative path'],
      [{ identifiers: { packages: { ownScopes: ['@acme'] } } }, 'identifiers.packages: ownScopes[0]: "@acme" must be a scope ending in / (@acme/)'],
      [{ identifiers: { packages: { ownScopes: ['acme/'] } } }, 'identifiers.packages: ownScopes[0]: "acme/" must be a scope ending in / (@acme/)'],
      [{ identifiers: { packages: { ownScopes: ['@Acme/'] } } }, 'identifiers.packages: ownScopes[0]: "@Acme/" must be a scope ending in / (@acme/)'],
      [{ identifiers: { prisma: 3 } }, 'identifiers: "prisma" must be an object'],
      [{ baseline: 'docs/../b.json' }, '"baseline": "docs/../b.json" is not a normalized root-relative path'],
    ] as const) {
      it(message, () => refuses(source(over), message));
    }
  });

  describe('an exempt marker that is not one word', () => {
    for (const marker of ['doc ref', 'doc-ref:', 'a.b', 'a*']) {
      it(JSON.stringify(marker), () => refuses(source({ exemptMarker: marker }), '"exemptMarker" must be one word of letters, digits, _ and -'));
    }
    it('accepts letters, digits, _ and -', () => {
      assert.equal(parseConfig(source({ exemptMarker: 'ok_2-x' })).exemptWord, 'ok_2-x');
    });
  });
});
