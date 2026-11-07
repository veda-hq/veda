import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin, { rules } from './index.js';

/**
 * TEST-STRUCT-02, the test-structure pack: the cases for `test-structure.js`,
 * the module this suite owns.
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

/** A fixture repository holding `scripts/run-validation.sh`. */
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/path-line-repo',
);

/** The file that marks REPO_ROOT, for the `rootMarker` option. */
const ROOT_MARKER = '.repo-root';

/** Every inherited `GIT_*` variable but the identity and remote ones. */
const KEPT_GIT_VARIABLES = new Set([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_SSH_COMMAND',
  'GIT_TERMINAL_PROMPT',
]);

/** Settings that keep git off the user's and the system's configuration. */
const HERMETIC_GIT_VARIABLES = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

/**
 * An environment for a fixture's git: no inherited `GIT_DIR`,
 * `GIT_INDEX_FILE` or config (a test run from inside a git hook would
 * otherwise act on the hook's repository), a fixed identity, no user config.
 */
function hermeticGitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('GIT_') || KEPT_GIT_VARIABLES.has(name),
    ),
  );
  return {
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    ...env,
    ...HERMETIC_GIT_VARIABLES,
  };
}

/**
 * Apply hermeticGitEnv's masks to this process, for the git the rule itself
 * spawns, and return a function that puts every `GIT_*` variable back.
 */
function maskProcessGitEnv(): () => void {
  const saved = Object.entries(process.env).filter(([name]) =>
    name.startsWith('GIT_'),
  );
  const masked = hermeticGitEnv();
  for (const [name] of saved) {
    if (!(name in masked)) delete process.env[name];
  }
  Object.assign(process.env, HERMETIC_GIT_VARIABLES);
  return () => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('GIT_')) delete process.env[name];
    }
    Object.assign(process.env, Object.fromEntries(saved));
  };
}

/** Remove a fixture root this suite made under the temp directory. */
function removeFixtureRoot(root: string): void {
  if (!root.startsWith(tmpdir())) {
    throw new Error(`not a fixture root of this suite: ${root}`);
  }
  rmSync(root, { recursive: true, force: true });
}

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

const TEST_FILE = 'probe.test.ts';

// Assembled at run time so this file does not itself pin a path:line.
const PINNED_PATH_LINE = ['scripts/run-validation.sh', 136].join(':');

// ---------------------------------------------------------------------------
// TEST-STRUCT-02
// ---------------------------------------------------------------------------

ruleTester.run('no-nested-test-blocks', rules['no-nested-test-blocks'], {
  valid: [
    // Corrected: the describe is a sibling of the test.
    {
      filename: TEST_FILE,
      code: `describe('api service', () => {
        it('syncMovements transforms payload', async () => { await syncMovements(m); expect(post).toHaveBeenCalled(); });
        describe('syncOrders', () => { it('sends orders', async () => { expect(await syncOrders()).toBe(1); }); });
      });`,
    },
    // A local helper that shares the name is not the test API.
    {
      filename: TEST_FILE,
      code: `import { describe as label } from './describe';
      const describe = (s: string) => s;
      it('names the endpoint', () => { expect(describe('silent')).toBe('silent'); });`,
    },
  ],
  invalid: [
    // The catalogue example.
    {
      filename: TEST_FILE,
      code: `describe('api service', () => {
        it('syncMovements transforms payload to server contract', async () => {
          await syncMovements(m);
          expect(post).toHaveBeenCalled();
          describe('syncOrders', () => {
            it('sends orders to /orders/sync', async () => { expect(await syncOrders()).toBe(1); });
          });
        });
      });`,
      errors: [{ messageId: 'nested' }, { messageId: 'nested' }],
    },
  ],
});

ruleTester.run('fake-timers-restored', rules['fake-timers-restored'], {
  valid: [
    {
      filename: TEST_FILE,
      code: `beforeEach(() => { vi.useFakeTimers(); });
      afterEach(() => { vi.useRealTimers(); });
      it('a', () => { expect(run()).toBe(409); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { vi.useFakeTimers(); try { expect(run()).toBe(409); } finally { vi.useRealTimers(); } });`,
    },
    // Module scope: the whole file is on fake timers by design.
    {
      filename: TEST_FILE,
      code: `vi.useFakeTimers(); it('a', () => { expect(run()).toBe(1); });`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `it('answers 409 while the period is being locked', async () => {
        vi.useFakeTimers();
        expect(await decide()).toBe(409);
        vi.useRealTimers();
      });`,
      errors: [{ messageId: 'leak' }],
    },
  ],
});

ruleTester.run('mock-factory-hoisted', rules['mock-factory-hoisted'], {
  valid: [
    {
      filename: TEST_FILE,
      code: `const migrationState = vi.hoisted(() => ({ done: false }));
      vi.mock('./post-upgrade-migration', () => ({ state: migrationState }));`,
    },
    // Read lazily: by the time the returned function runs, the const exists.
    {
      filename: TEST_FILE,
      code: `const migrationState = { done: false };
      vi.mock('./post-upgrade-migration', () => ({ readState: () => migrationState }));`,
    },
    {
      filename: TEST_FILE,
      code: `import { vi } from 'vitest';
      vi.mock('./api', async importOriginal => ({ ...(await importOriginal()), get: vi.fn() }));`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `const migrationState = { done: false };
      vi.mock('./post-upgrade-migration', () => ({ state: migrationState }));`,
      errors: [{ messageId: 'notHoisted' }],
    },
    // An imported value read eagerly.
    {
      filename: TEST_FILE,
      code: `import { invoiceFixture } from './fixtures';
      vi.mock('./invoice-api', () => ({ invoice: invoiceFixture }));`,
      errors: [{ messageId: 'notHoisted' }],
    },
  ],
});

ruleTester.run('each-title-unique', rules['each-title-unique'], {
  valid: [
    {
      filename: TEST_FILE,
      code: `it.each([{ cliExit: 0, gateFailure: false }, { cliExit: 0, gateFailure: true }])(
        'joins review: $cliExit/$gateFailure', row => { expect(run(row)).toBe(0); });`,
    },
    {
      filename: TEST_FILE,
      code: `it.each([null, ''])('answers nothing for owner %p', o => { expect(read(o)).toEqual([]); });`,
    },
    {
      filename: TEST_FILE,
      code: `it.each([10, '10'])('refuses %j', v => { expect(parse(v)).toBeNull(); });`,
    },
    {
      filename: TEST_FILE,
      code: `it.each([['docs/work only', true]])('%s', (name, expected) => { expect(scope(name)).toBe(expected); });`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `it.each([
        { cliExit: 0, issues: false, change: false, gateFailure: false },
        { cliExit: 0, issues: false, change: false, gateFailure: true },
      ])('joins overlapped review without changing enforcement: $cliExit/$issues/$change', row => { expect(run(row)).toBe(0); });`,
      errors: [{ messageId: 'duplicateTitle' }],
    },
    {
      filename: TEST_FILE,
      code: `it.each([['docs/work only', (dir: string) => { touch(dir); }, true]])('%s → %s', (name, change) => { expect(scope(name, change)).toBe(true); });`,
      errors: [{ messageId: 'functionInTitle' }],
    },
    {
      filename: TEST_FILE,
      code: `it.each([1, 2, 3])('parses the value', v => { expect(parse(v)).toBe(v); });`,
      errors: [{ messageId: 'sameTitle' }],
    },
  ],
});

ruleTester.run(
  'no-collection-time-skip-state',
  rules['no-collection-time-skip-state'],
  {
    valid: [
      {
        filename: TEST_FILE,
        code: `const tablesExist = process.env.DB_READY === '1';
      it.skipIf(!tablesExist)('reads products', () => { expect(read()).toHaveLength(1); });`,
      },
      // A let set at module scope (collection time) is visible to skipIf.
      {
        filename: TEST_FILE,
        code: `let enabled = false; enabled = process.env.X === '1';
      it.runIf(enabled)('a', () => { expect(read()).toBe(1); });`,
      },
    ],
    invalid: [
      {
        filename: TEST_FILE,
        code: `let tablesExist = false;
      beforeAll(async () => { tablesExist = await probeTables(); });
      it.skipIf(!tablesExist)('reads products', () => { expect(read()).toHaveLength(1); });`,
        errors: [{ messageId: 'hookState' }],
      },
    ],
  },
);

ruleTester.run('no-collection-time-io', rules['no-collection-time-io'], {
  valid: [
    {
      filename: TEST_FILE,
      code: `import { execFileSync } from 'node:child_process';
      let tracked: string[] = [];
      beforeAll(() => { tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\\n'); });
      it('a', () => { expect(tracked.length).toBeGreaterThan(0); });`,
    },
    // existsSync cannot throw.
    {
      filename: TEST_FILE,
      code: `import { existsSync } from 'node:fs';
      describe.skipIf(!existsSync('/opt/tool'))('tool', () => { it('a', () => { expect(1 + run()).toBe(2); }); });`,
    },
    // A helper's own fs call runs only when a test calls the helper.
    {
      filename: TEST_FILE,
      code: `import { readFileSync } from 'node:fs';
      const read = () => readFileSync('x', 'utf8');
      it('a', () => { expect(read()).toBe('x'); });`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `import { execFileSync } from 'node:child_process';
      const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
      it('a', () => { expect(tracked).toContain('package.json'); });`,
      errors: [{ messageId: 'collectionIo' }],
    },
    // A describe body.
    {
      filename: TEST_FILE,
      code: `import * as fs from 'node:fs';
      describe('pre-commit', () => {
        const hook = fs.readFileSync('.husky/pre-commit', 'utf8');
        it('a', () => { expect(hook).toContain('workflow'); });
      });`,
      errors: [{ messageId: 'collectionIo' }],
    },
  ],
});

ruleTester.run('guarded-marker-slice', rules['guarded-marker-slice'], {
  valid: [
    {
      filename: TEST_FILE,
      code: `it('a', () => {
        expect(hook).toContain('# BEGIN prefetch');
        const body = hook.slice(hook.indexOf('# BEGIN prefetch'));
        expect(body).toContain('wait');
      });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => {
        const start = hook.indexOf('# BEGIN prefetch');
        expect(start).toBeGreaterThan(-1);
        expect(hook.slice(start)).toContain('wait');
      });`,
    },
    // A one-character delimiter is parsing, not marker extraction.
    {
      filename: TEST_FILE,
      code: `it('a', () => { const i = line.indexOf('='); expect(line.slice(0, i)).toBe('KEY'); });`,
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { expect(source).toContain('# >>> evidence gate'); expect(source.split('# >>> evidence gate')[1]).toContain('run'); });`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `it('a', () => {
        const body = hook.slice(hook.indexOf('# BEGIN prefetch'), hook.indexOf('# END prefetch'));
        expect(body).toContain('wait');
      });`,
      errors: [{ messageId: 'inlineIndex' }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { const start = hook.indexOf('# BEGIN prefetch'); expect(hook.slice(start)).toContain('wait'); });`,
      errors: [{ messageId: 'unguardedIndex' }],
    },
    {
      filename: TEST_FILE,
      code: `it('a', () => { const gate = source.split('# >>> evidence gate')[1]; expect(gate).toContain('run'); });`,
      errors: [{ messageId: 'splitIndex' }],
    },
  ],
});

ruleTester.run('reset-shared-let', rules['reset-shared-let'], {
  valid: [
    {
      filename: TEST_FILE,
      code: `let campaignsResponse: unknown;
      beforeEach(() => { campaignsResponse = undefined; });
      it('a', async () => { campaignsResponse = { data: [] }; expect(await sync(campaignsResponse)).toBe(0); });`,
    },
    // Assigned only in a hook: the hook owns the state.
    {
      filename: TEST_FILE,
      code: `let app: unknown; beforeAll(() => { app = boot(); }); it('a', () => { expect(app).toBe(1); });`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `let campaignsResponse: unknown;
      it('a', async () => { campaignsResponse = { data: [] }; expect(await sync()).toBe(0); });
      it('b', async () => { expect(await sync()).toBe(0); });`,
      errors: [{ messageId: 'notReset' }],
    },
  ],
});

ruleTester.run('hermetic-config', rules['hermetic-config'], {
  valid: [
    {
      filename: TEST_FILE,
      code: `integrity = new AttendanceIntegrityService(hermeticConfigService({}));`,
    },
    {
      filename: TEST_FILE,
      code: `ConfigModule.forRoot({ skipProcessEnv: true, ignoreEnvFile: true, load: [() => ({})] });`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      code: `integrity = new AttendanceIntegrityService(new ConfigService({}));`,
      errors: [{ messageId: 'configService' }],
    },
    {
      filename: TEST_FILE,
      code: `ConfigModule.forRoot({ load: [() => ({})] });`,
      errors: [{ messageId: 'configModule' }],
    },
  ],
});

ruleTester.run('e2e-uses-supertest', rules['e2e-uses-supertest'], {
  valid: [
    {
      filename: 'test/product-master-listing-status.e2e.test.ts',
      code: `import request from 'supertest'; it('a', async () => { await request(server).get('/x').expect(200); });`,
    },
    // The same direct-service suite, honestly named.
    {
      filename: 'test/product-master-listing-status.integration.test.ts',
      code: `import { ProductService } from '../src/product/product.service'; it('a', async () => { expect(await new ProductService(db).list()).toHaveLength(1); });`,
    },
    // Near miss: a test of a test utility, in the e2e suite for its real
    // database (test/utils/fixture-reset.e2e.test.ts). It imports
    // no app source and no Nest, so it claims nothing about HTTP.
    {
      filename: 'test/utils/fixture-reset.e2e.test.ts',
      code: `import { PrismaClient } from '@prisma/client'; import { resetFixtures } from './fixture-reset'; it('a', async () => { await resetFixtures(new PrismaClient(), [], []); expect(1).toBe(1); });`,
    },
  ],
  invalid: [
    // It
    // built ProductService from ../src directly and issued no HTTP request.
    {
      filename: 'test/product-master-listing-status.e2e.test.ts',
      code: `import { ProductService } from '../src/product/product.service'; it('a', async () => { expect(await new ProductService(db).list()).toHaveLength(1); });`,
      errors: [{ messageId: 'noHttp' }],
    },
    // Boots a Nest testing module but never goes through HTTP.
    {
      filename: 'test/governance-backfill.e2e.test.ts',
      code: `import { Test } from '@nestjs/testing'; it('a', async () => { const m = await Test.createTestingModule({}).compile(); expect(m).toBeDefined(); });`,
      errors: [{ messageId: 'noHttp' }],
    },
  ],
});

ruleTester.run('no-void-async-iife', rules['no-void-async-iife'], {
  valid: [
    {
      filename: 'test/utils/s3-mock.ts',
      code: `server.on('request', (req, res) => {
        (async () => { await options.onRequest(req); res.end(); })().catch(() => { res.statusCode = 500; res.end(); });
      });`,
    },
    { filename: 'test/utils/s3-mock.ts', code: `void pending;` },
  ],
  invalid: [
    {
      filename: 'test/utils/s3-mock.ts',
      code: `server.on('request', (req, res) => {
        void (async () => { await options.onRequest(req); res.end(); })();
      });`,
      errors: [{ messageId: 'voidIife' }],
    },
  ],
});

ruleTester.run('no-path-line-literal', rules['no-path-line-literal'], {
  valid: [
    // A path the test created in its own fixture root does not exist here.
    {
      filename: TEST_FILE,
      options: [{ root: REPO_ROOT }],
      code: `it('a', () => { expect(out).toContain('scripts/no-such-fixture.sh:3'); });`,
    },
    {
      filename: TEST_FILE,
      options: [{ root: REPO_ROOT }],
      code: `it('a', () => { expect(out).toContain('scripts/run-validation.sh'); });`,
    },
  ],
  invalid: [
    {
      filename: TEST_FILE,
      options: [{ root: REPO_ROOT }],
      code: `it('a', () => { expect(out).toContain('${PINNED_PATH_LINE}'); });`,
      errors: [{ messageId: 'pinned' }],
    },
  ],
});

/** A fixture repository holding a tracked, an ignored and an untracked file. */
function trackedFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'test-lint-tracked-'));
  mkdirSync(join(root, 'scripts'));
  for (const name of ['tracked', 'ignored', 'untracked']) {
    writeFileSync(join(root, `scripts/${name}.sh`), 'echo\n');
  }
  writeFileSync(join(root, '.gitignore'), 'scripts/ignored.sh\n');
  const env = hermeticGitEnv();
  execFileSync('git', ['init', '-q'], { cwd: root, env, timeout: 10_000 });
  execFileSync('git', ['add', '.gitignore', 'scripts/tracked.sh'], {
    cwd: root,
    env,
    timeout: 10_000,
  });
  return root;
}

/** A file on disk under a `.git` that git refuses, wherever the temp dir is. */
function gitlessFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'test-lint-gitless-'));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/on-disk.sh'), 'echo\n');
  writeFileSync(join(root, '.git'), 'not a repository\n');
  return root;
}

/** A file on disk in a repository that tracks nothing yet. */
function emptyRepoFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'test-lint-empty-'));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/on-disk.sh'), 'echo\n');
  execFileSync('git', ['init', '-q'], {
    cwd: root,
    env: hermeticGitEnv(),
    timeout: 10_000,
  });
  return root;
}

/** An assertion pinning line 3 of `path`. */
const pinAt = (path: string) =>
  `it('a', () => { expect(out).toContain('${path}:3'); });`;

// Filled in before(); the cases hold these objects, read when they run.
const trackedRoot = { root: '' };

const gitlessRoot = { root: '' };

const emptyRepoRoot = { root: '' };

describe('no-path-line-literal: a real file is one git tracks', () => {
  let restoreGitEnv = (): void => {};
  before(() => {
    restoreGitEnv = maskProcessGitEnv();
    trackedRoot.root = trackedFixture();
    gitlessRoot.root = gitlessFixture();
    emptyRepoRoot.root = emptyRepoFixture();
  });
  after(() => {
    removeFixtureRoot(trackedRoot.root);
    removeFixtureRoot(gitlessRoot.root);
    removeFixtureRoot(emptyRepoRoot.root);
    restoreGitEnv();
  });

  ruleTester.run('no-path-line-literal', rules['no-path-line-literal'], {
    valid: [
      // A worktree's env link: on disk, ignored by git, absent on CI.
      {
        filename: TEST_FILE,
        options: [trackedRoot],
        code: pinAt('scripts/ignored.sh'),
      },
      {
        filename: TEST_FILE,
        options: [trackedRoot],
        code: pinAt('scripts/untracked.sh'),
      },
    ],
    invalid: [
      {
        filename: TEST_FILE,
        options: [trackedRoot],
        code: pinAt('scripts/tracked.sh'),
        errors: [{ messageId: 'pinned' }],
      },
      // A non-canonical spelling of the tracked file is the same file.
      {
        filename: TEST_FILE,
        options: [trackedRoot],
        code: pinAt('scripts/../scripts/./tracked.sh'),
        errors: [{ messageId: 'pinned' }],
      },
      // Git cannot list the root: the file on disk decides, as before.
      {
        filename: TEST_FILE,
        options: [gitlessRoot],
        code: pinAt('scripts/on-disk.sh'),
        errors: [{ messageId: 'pinned' }],
      },
      // Git lists nothing (Stryker's ignored sandbox copy): the disk decides.
      {
        filename: TEST_FILE,
        options: [emptyRepoRoot],
        code: pinAt('scripts/on-disk.sh'),
        errors: [{ messageId: 'pinned' }],
      },
    ],
  });
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
    rule: 'fake-timers-restored',
    messageId: 'leak',
    corrected: `afterEach(() => { vi.useRealTimers(); }); it('a', () => { vi.useFakeTimers(); expect(run()).toBe(1); });`,
    guard: `afterEach(() => { vi.useRealTimers(); });`,
  },
  {
    rule: 'mock-factory-hoisted',
    messageId: 'notHoisted',
    corrected: `const state = vi.hoisted(() => ({ done: false })); vi.mock('./m', () => ({ state }));`,
    guard: 'vi.hoisted(() => ({ done: false }))',
    replacement: '({ done: false })',
  },
  {
    rule: 'no-collection-time-io',
    messageId: 'collectionIo',
    corrected: `import { readFileSync } from 'node:fs'; let hook = ''; beforeAll(() => { hook = readFileSync('h', 'utf8'); }); it('a', () => { expect(hook).toBe('x'); });`,
    guard: `beforeAll(() => { hook = readFileSync('h', 'utf8'); });`,
    replacement: `hook = readFileSync('h', 'utf8');`,
  },
  {
    rule: 'guarded-marker-slice',
    messageId: 'inlineIndex',
    corrected: `it('a', () => { expect(hook).toContain('# BEGIN'); expect(hook.slice(hook.indexOf('# BEGIN'))).toContain('x'); });`,
    guard: `expect(hook).toContain('# BEGIN');`,
  },
  {
    rule: 'reset-shared-let',
    messageId: 'notReset',
    corrected: `let state = 0; beforeEach(() => { state = 0; }); it('a', () => { state = 1; expect(read(state)).toBe(1); });`,
    guard: `beforeEach(() => { state = 0; });`,
  },
  {
    rule: 'no-collection-time-skip-state',
    messageId: 'hookState',
    corrected: `let ready = false; it.skipIf(!ready)('a', () => { expect(read()).toBe(1); });`,
    guard: `let ready = false;`,
    replacement: `let ready = false; beforeAll(async () => { ready = await probe(); });`,
  },
  {
    rule: 'hermetic-config',
    messageId: 'configModule',
    corrected: `ConfigModule.forRoot({ skipProcessEnv: true, load: [] });`,
    guard: 'skipProcessEnv: true, ',
  },
  {
    rule: 'e2e-uses-supertest',
    messageId: 'noHttp',
    corrected: `import { AppModule } from '../src/app.module'; import request from 'supertest'; it('a', async () => { await request(boot(AppModule)).get('/').expect(200); });`,
    guard: `import request from 'supertest';`,
    filename: 'test/x.e2e.test.ts',
  },
  {
    rule: 'no-void-async-iife',
    messageId: 'voidIife',
    corrected: `(async () => { await work(); })().catch(fail);`,
    guard: `(async () => { await work(); })().catch(fail)`,
    replacement: `void (async () => { await work(); })()`,
  },
  {
    rule: 'no-path-line-literal',
    messageId: 'pinned',
    corrected: `expect(out).toContain('scripts/run-validation.sh');`,
    guard: `'scripts/run-validation.sh'`,
    replacement: `'${PINNED_PATH_LINE}'`,
    options: [{ root: REPO_ROOT }],
  },
  {
    rule: 'each-title-unique',
    messageId: 'sameTitle',
    corrected: `it.each([1, 2])('parses %i', v => { expect(parse(v)).toBe(v); });`,
    guard: ' %i',
    replacement: '',
  },
  {
    rule: 'no-nested-test-blocks',
    messageId: 'nested',
    corrected: `describe('a', () => { it('b', () => { expect(run()).toBe(1); }); });`,
    guard: `describe('a'`,
    replacement: `it('a'`,
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

// ---------------------------------------------------------------------------
// Decision pins A: shared helpers, TEST-WEAK-03, TEST-STRUCT-02
// ---------------------------------------------------------------------------

/**
 * One fixture per rule decision a mutation run found unpinned: each
 * names the rule, the code, and the exact messageIds it must yield.
 */
interface CaseA {
  rule: string;
  code: string;
  ids: string[];
  filename?: string;
}

const inTest = (body: string): string => `it('a', () => { ${body} });`;

const HOOK_STATE = ['hookState'];

/** A hook-set `ready`, then a runIf that reads `condition`. */
const skipState = (condition: string, ids: string[] = []): CaseA => ({
  rule: 'no-collection-time-skip-state',
  code: `let ready = false; beforeAll(() => { ready = true; }); it.runIf(${condition})('t', () => { expect(run()).toBe(1); });`,
  ids,
});

const skipCase = (code: string, ids: string[] = []): CaseA => ({
  rule: 'no-collection-time-skip-state',
  code,
  ids,
});

const timers = (code: string, ids: string[] = []): CaseA => ({
  rule: 'fake-timers-restored',
  code,
  ids,
});

/** A module-level useFakeTimers with these options: no leak, only pairing. */
const toFake = (options: string, ids: string[] = []): CaseA =>
  timers(`vi.useFakeTimers(${options});`, ids);

const hoisted = (code: string, ids: string[] = []): CaseA => ({
  rule: 'mock-factory-hoisted',
  code,
  ids,
});

const titles = (table: string, title: string, ids: string[] = []): CaseA => ({
  rule: 'each-title-unique',
  code: `it.each(${table})(${title}, v => { expect(run(v)).toBe(1); });`,
  ids,
});

const io = (code: string, ids: string[] = []): CaseA => ({
  rule: 'no-collection-time-io',
  code,
  ids,
});

const DUPLICATE = ['duplicateTitle'];

const COLLECTION_IO = ['collectionIo'];

const STRUCT_CASES_A: CaseA[] = [
  // identifiersIn: what a condition reads, and what it does not.
  skipState(`() => ready`),
  skipState(`!ready`, HOOK_STATE),
  skipState(`state[ready]`, HOOK_STATE),
  skipState(`check({ ready: 1 })`),
  skipState(`check({ a: ready })`, HOOK_STATE),
  skipState(`check({ [ready]: 1 })`, HOOK_STATE),
  skipState(`[, ready].length > 1`, HOOK_STATE),
  skipState(`[ready].length > 0`, HOOK_STATE),
  skipState(`ready === null`, HOOK_STATE),
  skipState(`!globalFlag`),
  skipCase(
    `const state = { ready: true }; let ready = false; beforeAll(() => { ready = true; }); it.runIf(state.ready)('t', () => { expect(run()).toBe(1); });`,
  ),
  // Which writes count: a setup hook's, not a const's, an import's, a
  // teardown's, a test's or a plain function's; and reads never.
  skipCase(
    `let ready = false; beforeEach(() => { ready = true; }); it.runIf(ready)('t', () => { expect(run()).toBe(1); });`,
    HOOK_STATE,
  ),
  skipCase(
    `const ready = false; beforeAll(() => { ready = true; }); it.runIf(ready)('t', () => { expect(run()).toBe(1); });`,
  ),
  skipCase(
    `import { ready } from './state'; beforeAll(() => { ready = true; }); it.runIf(ready)('t', () => { expect(run()).toBe(1); });`,
  ),
  skipCase(
    `let ready = false; afterAll(() => { ready = true; }); it.runIf(ready)('t', () => { expect(run()).toBe(1); });`,
  ),
  skipCase(
    `let ready = false; it('w', () => { ready = true; }); it.runIf(ready)('t', () => { expect(run()).toBe(1); });`,
  ),
  skipCase(
    `let ready = false; function arm() { ready = true; } it.runIf(ready)('t', () => { expect(run()).toBe(1); });`,
  ),
  skipCase(
    `let ready = false; beforeAll(() => { use(ready); }); it.runIf(ready)('t', () => { expect(run()).toBe(1); });`,
  ),
  // fake-timers-restored: jest, try vs finally, and where a restore counts.
  timers(`it('a', () => { jest.useFakeTimers(); expect(run()).toBe(1); });`, [
    'leak',
  ]),
  timers(
    `it('a', () => { vi.useFakeTimers(); try { vi.useRealTimers(); } catch { fail(); } });`,
    ['leak'],
  ),
  timers(
    `vi.useRealTimers(); it('a', () => { vi.useFakeTimers(); expect(run()).toBe(1); });`,
    ['leak'],
  ),
  timers(
    `it('a', () => { vi.useFakeTimers(); try { expect(run()).toBe(1); } finally { vi.useRealTimers(); } });`,
  ),
  timers(
    `it('a', () => { vi.useFakeTimers(); expect(run()).toBe(1); vi.useRealTimers(); });`,
    ['leak'],
  ),
  timers(
    `it('a', () => { vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers(); }); expect(run()).toBe(1); });`,
  ),
  timers(
    `it('a', () => { vi.useFakeTimers(); onTestFailed(() => { vi.useRealTimers(); }); expect(run()).toBe(1); });`,
  ),
  timers(
    `it('a', () => { vi.useFakeTimers(); ns.onTestFinished(() => { vi.useRealTimers(); }); expect(run()).toBe(1); });`,
    ['leak'],
  ),
  timers(
    `const restore = () => { vi.useRealTimers(); }; it('a', () => { vi.useFakeTimers(); restore(); });`,
    ['leak'],
  ),
  timers(
    `beforeEach(() => { vi.useRealTimers(); }); it('a', () => { vi.useFakeTimers(); expect(run()).toBe(1); });`,
    ['leak'],
  ),
  timers(
    `it('a', () => { vi.useFakeTimers(); }); it('b', () => { try { run(); } finally { vi.useRealTimers(); } });`,
    ['leak'],
  ),
  // unpairedTimers: each set/clear pair, and how toFake is found.
  toFake(`{ toFake: ['setTimeout'] }`, ['unpaired']),
  toFake(`{ toFake: ['setTimeout', 'clearTimeout'] }`),
  toFake(`{ toFake: ['setInterval'] }`, ['unpaired']),
  toFake(`{ toFake: ['setInterval', 'clearInterval'] }`),
  toFake(`{ toFake: ['setImmediate'] }`, ['unpaired']),
  toFake(`{ toFake: ['setImmediate', 'clearImmediate'] }`),
  toFake(`{ toFake: ['clearTimeout'] }`),
  toFake(`{ toFake: ['Date'] }`),
  toFake(`{ now: 0, toFake: ['setTimeout'] }`, ['unpaired']),
  toFake(`{ ...opts, toFake: ['setTimeout'] }`, ['unpaired']),
  toFake(`{ ['toFake']: ['setTimeout'] }`),
  toFake(`{ 'toFake': ['setTimeout'] }`, ['unpaired']),
  toFake(`{ toFake: ['setTimeout', x] }`, ['unpaired']),
  toFake(`{ toFake: [...list] }`),
  toFake(`{ toFake: list }`),
  toFake(`opts`),
  timers(`jest.useFakeTimers({ toFake: ['setTimeout'] });`, ['unpaired']),
  // mock-factory-hoisted: what is hoisted, what is vi.mock, what is eager.
  hoisted(
    `const s = await vi.hoisted(() => ({})); vi.mock('./a', () => ({ s }));`,
  ),
  hoisted(
    `const s = other.hoisted(() => ({})); vi.mock('./a', () => ({ s }));`,
    ['notHoisted'],
  ),
  hoisted(`const s = vi.other(() => ({})); vi.mock('./a', () => ({ s }));`, [
    'notHoisted',
  ]),
  hoisted(
    `const s = ns.vi.hoisted(() => ({})); vi.mock('./a', () => ({ s }));`,
    ['notHoisted'],
  ),
  hoisted(`const s = {}; other.mock('./a', () => ({ s }));`),
  hoisted(`const s = {}; vi.other('./a', () => ({ s }));`),
  hoisted(`const s = {}; ns.vi.mock('./a', () => ({ s }));`),
  hoisted(`const s = {}; vi.mock('./a', s);`),
  hoisted(`vi.mock('./a', () => ({ a: foo }));`),
  hoisted(`const s = {}; vi.mock('./a', () => ({ a: s, b: s }));`, [
    'notHoisted',
  ]),
  hoisted(`class Repo {} vi.mock('./a', () => ({ Repo }));`, ['notHoisted']),
  hoisted(`function make() {} vi.mock('./a', () => ({ make }));`),
  hoisted(`let s; vi.mock('./a', () => ({ s }));`, ['notHoisted']),
  hoisted(
    `const s = {}; vi.mock('./a', () => { if (on) { return { s }; } return {}; });`,
    ['notHoisted'],
  ),
  hoisted(`vi.mock('./a', () => { const s = 1; return { s }; });`),
  hoisted(`type T = {}; vi.mock('./a', () => ({ s: {} as T }));`),
  hoisted(`import { s } from './s'; vi.mock('./a', () => ({ s }));`, [
    'notHoisted',
  ]),
  hoisted(
    `import { vi, expect } from 'vitest'; vi.mock('./a', () => ({ e: expect }));`,
  ),
  // each-title-unique: which cells are literals and how each token renders.
  titles(`[[a], [b]]`, `'case %s'`),
  titles(`[[/a/], [/a/]]`, `'case %s'`),
  titles('[[`x`], [`x`]]', `'case %s'`, DUPLICATE),
  titles('[[`x${a}`], [`x${a}`]]', `'case %s'`),
  titles(`[[undefined], [undefined]]`, `'case %s'`, DUPLICATE),
  titles(`[['1'], ['01']]`, `'case %d'`, DUPLICATE),
  titles(`[['1'], ['01']]`, `'case %i'`, DUPLICATE),
  titles(`[['1'], ['01']]`, `'case %f'`, DUPLICATE),
  titles(`[['a'], ['b']]`, `'case %d'`),
  titles(`[['1'], [1]]`, `'case %s'`, DUPLICATE),
  titles(`[['1'], [1]]`, `'case %c'`, DUPLICATE),
  titles(`[['1'], [1]]`, `'case %j'`),
  titles(`[[1], [1]]`, `'case %s'`, DUPLICATE),
  titles(`[[1], [1]]`, `5`),
  titles(`[[1], [1]]`, `title`),
  titles(`[1, 2]`, '`same`', ['sameTitle']),
  titles(`[1, 2]`, '`t ${x}`'),
  titles(`[, 1]`, `'n'`),
  titles(`[...rows, 1]`, `'n'`),
  titles(`[1, 2]`, `'100%% done'`, ['sameTitle']),
  titles(`[[1], [1]]`, `'100%% %s'`, DUPLICATE),
  titles(`[['%a', ''], ['', 'a%']]`, `'%s%%%s'`, DUPLICATE),
  titles(`[['a', () => 1], ['b', () => 2]]`, `'case %s %#'`),
  titles(`[['a', () => 1], ['b', () => 2]]`, `'case %s %$'`),
  titles(`[1, 2]`, `'case %#'`),
  titles(`[1, 2]`, `'case %$'`),
  titles(`[[1, 2], [1, 2]]`, `'case %s %#'`),
  titles(`[[1, 2], [1, 2]]`, `'case %s %$'`),
  titles(`[{ b: 2, a: 1 }, { b: 3, a: 1 }]`, `'case $a'`, DUPLICATE),
  titles(`[{ a: 1, b: 2 }, { a: 1, b: 3 }]`, `'case $b'`),
  titles(`[{ a: x }, { a: y }]`, `'case $a'`),
  titles(`[{ a: 1 }, { b: 1 }]`, `'case $a'`),
  titles(`[{ ['a']: 1 }, { ['a']: 1 }]`, `'case $a'`),
  titles(`[{ 'a': 1 }, { 'a': 1 }]`, `'case $a'`, DUPLICATE),
  titles(`[{ a: '%%' }, { a: '%' }]`, `'case $a'`),
  titles(`[{ a: '%s' }, { a: '%s' }]`, `'case $a'`, DUPLICATE),
  titles(`[[1], [1]]`, `'case $a'`),
  // no-collection-time-io: every IO module, and the imports that are not IO.
  io(
    `import { readFileSync } from 'fs'; const t = readFileSync('x');`,
    COLLECTION_IO,
  ),
  io(
    `import { readFile } from 'fs/promises'; const t = readFile('x');`,
    COLLECTION_IO,
  ),
  io(
    `import { readFile } from 'node:fs/promises'; const t = readFile('x');`,
    COLLECTION_IO,
  ),
  io(
    `import { execFileSync } from 'child_process'; const t = execFileSync('git');`,
    COLLECTION_IO,
  ),
  io(`import { readFileSync } from './helpers'; const t = readFileSync('x');`),
  io(
    `import type { readFileSync } from 'node:fs'; const t = readFileSync('x');`,
  ),
  io(
    `import { type readFileSync } from 'node:fs'; const t = readFileSync('x');`,
  ),
  io(
    `import * as fs from 'node:fs'; const t = fs.readFileSync('x');`,
    COLLECTION_IO,
  ),
  io(
    `import * as fs from 'node:fs'; const t = fs.promises.readFile('x');`,
    COLLECTION_IO,
  ),
  io(
    `import fs from 'node:fs'; const t = fs.readFileSync('x');`,
    COLLECTION_IO,
  ),
  io(`import * as fs from 'node:fs'; const t = other.readFileSync('x');`),
  io(`import { existsSync } from 'node:fs'; const t = existsSync('x');`),
  io(`import { readFileSync } from 'node:fs'; const t = make()();`),
  io(`import { readFileSync } from 'node:fs'; const t = other('x');`),
];

const sliceCase = (body: string, ids: string[] = []): CaseA => ({
  rule: 'guarded-marker-slice',
  code: inTest(body),
  ids,
});

const INLINE = ['inlineIndex'];

const UNGUARDED_INDEX = ['unguardedIndex'];

const SPLIT = ['splitIndex'];

/** `proof`, then an inline-index slice that needs '###' proved present. */
const sliceAfter = (proof: string, ids: string[] = []): CaseA =>
  sliceCase(
    `${proof} expect(hook.slice(hook.indexOf('###'))).toContain('w');`,
    ids,
  );

/** `use` reads `start`, then a slice at `start` that needs it guarded. */
const guardedBy = (use: string, ids: string[] = []): CaseA =>
  sliceCase(
    `const start = hook.indexOf('###'); ${use} expect(hook.slice(start)).toContain('w');`,
    ids,
  );

const resetCase = (code: string, ids: string[] = []): CaseA => ({
  rule: 'reset-shared-let',
  code,
  ids,
});

const configCase = (code: string, ids: string[] = []): CaseA => ({
  rule: 'hermetic-config',
  code,
  ids,
});

const SLICE_CASES_A: CaseA[] = [
  // arithmeticLeaves: + and - are walked, other operators are leaves.
  sliceCase(
    `expect(hook.slice(hook.indexOf('###') + 1)).toContain('w');`,
    INLINE,
  ),
  sliceCase(
    `expect(hook.slice(hook.indexOf('###') - 1)).toContain('w');`,
    INLINE,
  ),
  sliceCase(`expect(hook.slice(hook.indexOf('###') * 1)).toContain('w');`),
  // SLICE_METHODS: substring and substr slice too; other methods do not.
  sliceCase(
    `expect(hook.substring(hook.indexOf('###'))).toContain('w');`,
    INLINE,
  ),
  sliceCase(`expect(hook.substr(hook.indexOf('###'))).toContain('w');`, INLINE),
  sliceCase(`expect(hook.padEnd(hook.indexOf('###'))).toContain('w');`),
  sliceCase(`expect(hook.slice(new hook.indexOf('###'))).toContain('w');`),
  sliceCase(
    `const start = hook.indexOf('###'); expect(hook.slice(start + 1)).toContain('w');`,
    UNGUARDED_INDEX,
  ),
  // isGuardUse: comparisons, expect() and Math.* guard; nothing else does.
  guardedBy(`if (start < 0) throw new Error('x');`),
  guardedBy(`const end = start + 1;`, UNGUARDED_INDEX),
  guardedBy(`check(start);`, UNGUARDED_INDEX),
  guardedBy(`expect(x, start);`, UNGUARDED_INDEX),
  guardedBy(`const end = Math.max(start, 0);`),
  guardedBy(`const end = other.max(start, 0);`, UNGUARDED_INDEX),
  // isMarker: length at least 3, or a name or template.
  sliceCase(`expect(hook.slice(hook.indexOf())).toContain('w');`),
  sliceCase(`expect(hook.slice(hook.indexOf('##'))).toContain('w');`),
  sliceCase(`expect(hook.slice(hook.indexOf(123))).toContain('w');`),
  sliceCase("expect(hook.slice(hook.indexOf(`###`))).toContain('w');", INLINE),
  sliceCase(`expect(hook.slice(hook.indexOf(marker))).toContain('w');`, INLINE),
  sliceCase(
    `expect(hook.slice(hook.indexOf(m.begin))).toContain('w');`,
    INLINE,
  ),
  sliceCase(`expect(hook.slice(hook.indexOf(make()))).toContain('w');`),
  // provesMarker: what proves the marker is present.
  sliceAfter(`expect(hook).toContain('###');`),
  sliceAfter(`expect(hook).toMatch('###');`),
  sliceAfter(`expect(hook).not.toContain('###');`, INLINE),
  sliceAfter(`expect().toBe(1);`, INLINE),
  sliceAfter(`expect(hook).toContain();`, INLINE),
  sliceAfter(`expect(hook).toEqual('###');`, INLINE),
  sliceAfter(`expect(other).toContain('###');`, INLINE),
  sliceAfter(`expect(hook.includes('###')).toBe(true);`),
  sliceAfter(`expect(hook.includes('###')).toBe(false);`, INLINE),
  sliceAfter(`expect(done).toBe(true);`, INLINE),
  sliceAfter(`expect(run()).toBe(true);`, INLINE),
  sliceAfter(`expect(hook.has('###')).toBe(true);`, INLINE),
  sliceAfter(`expect(other.includes('###')).toBe(true);`, INLINE),
  sliceAfter(`expect(hook.includes()).toBe(true);`, INLINE),
  sliceAfter(`expect(hook.includes('xyz')).toBe(true);`, INLINE),
  // .at(n) on a split, and the slice-variable checks.
  sliceCase(`expect(hook.split('###').at(1)).toBe('w');`, SPLIT),
  sliceCase(`expect(hook.split('###').at(-1)).toBe('w');`, SPLIT),
  sliceCase(`expect(hook.split('###').at(0)).toBe('w');`),
  sliceCase(`expect(hook.split('###').at()).toBe('w');`),
  sliceCase(`expect(rows.map(f).at(1)).toBe('w');`),
  sliceCase(`expect(x.at(1)).toBe('w');`),
  sliceCase(`const i = hook.foo('###'); expect(hook.slice(i)).toContain('w');`),
  sliceCase(
    `let i = hook.indexOf('###'); expect(hook.slice(i)).toContain('w');`,
  ),
  sliceCase(
    `const i = hook.indexOf('##'); expect(hook.slice(i)).toContain('w');`,
  ),
  // split(m)[n]: only a literal number from 1, only on a split.
  sliceCase(`expect(hook.split('###')[1]).toBe('w');`, SPLIT),
  sliceCase(`expect(hook.split('###')[0]).toBe('w');`),
  sliceCase(`expect(hook.split('###')['1']).toBe('w');`),
  sliceCase(`expect(hook.split('###')[i]).toBe('w');`),
  sliceCase(`expect(rows.map(f)[1]).toBe('w');`),
  // reset-shared-let: which lets are shared, which writes reset them.
  resetCase(
    `let n = 0; afterEach(() => { n = 0; }); it('a', () => { n = 1; expect(n).toBe(1); });`,
  ),
  resetCase(
    `let n = 0; beforeAll(() => { n = 0; }); it('a', () => { n = 1; expect(n).toBe(1); });`,
    ['notReset'],
  ),
  resetCase(
    `let n = 0; function reset() { n = 0; } it('a', () => { n = 1; expect(n).toBe(1); });`,
    ['notReset'],
  ),
  resetCase(
    `describe('s', () => { let n = 0; it('a', () => { n = 1; expect(n).toBe(1); }); });`,
    ['notReset'],
  ),
  resetCase(
    `function f() { let n = 0; it('a', () => { n = 1; expect(n).toBe(1); }); }`,
  ),
  resetCase(`{ let n = 0; it('a', () => { n = 1; expect(n).toBe(1); }); }`),
  // hermetic-config: which call is forRoot, which options isolate it.
  configCase(`ConfigModule.other({});`),
  configCase(`Other.forRoot({});`),
  configCase(`ConfigModule.forRoot({ skipProcessEnv: true });`),
  // `ignoreEnvVars` only skips validating predefined variables
  // (@nestjs/config); ConfigService#get still reads process.env.
  configCase(`ConfigModule.forRoot({ ignoreEnvVars: true });`, [
    'configModule',
  ]),
  configCase(`ConfigModule.forRoot({ other: true });`, ['configModule']),
  configCase(`ConfigModule.forRoot({ skipProcessEnv: false });`, [
    'configModule',
  ]),
  configCase(`ConfigModule.forRoot({ skipProcessEnv: flag });`, [
    'configModule',
  ]),
  configCase(`ConfigModule.forRoot({ ...rest });`, ['configModule']),
  configCase(`ConfigModule.forRoot();`, ['configModule']),
  // Options read through const bindings and spreads, last write wins;
  // an unreadable spread might set anything, so it is not proof.
  configCase(`const o = { skipProcessEnv: true }; ConfigModule.forRoot(o);`),
  configCase(`let o = { skipProcessEnv: true }; ConfigModule.forRoot(o);`, [
    'configModule',
  ]),
  configCase(`const o = { load: [] }; ConfigModule.forRoot(o);`, [
    'configModule',
  ]),
  configCase(
    `const base = { skipProcessEnv: true }; ConfigModule.forRoot({ ...base, load: [] });`,
  ),
  configCase(
    `const base = { load: [] }; ConfigModule.forRoot({ skipProcessEnv: true, ...base });`,
  ),
  configCase(
    `const base = { skipProcessEnv: true }; ConfigModule.forRoot({ ...base, skipProcessEnv: false });`,
    ['configModule'],
  ),
  configCase(
    `const base = { skipProcessEnv: false }; ConfigModule.forRoot({ skipProcessEnv: true, ...base });`,
    ['configModule'],
  ),
  configCase(`ConfigModule.forRoot({ skipProcessEnv: true, ...rest });`, [
    'configModule',
  ]),
  configCase(`ConfigModule.forRoot({ ...rest, skipProcessEnv: true });`),
  configCase(
    `const skip = true; ConfigModule.forRoot({ skipProcessEnv: skip });`,
  ),
  configCase(
    `const skip = false; ConfigModule.forRoot({ skipProcessEnv: skip });`,
    ['configModule'],
  ),
  configCase(
    `const skipProcessEnv = true; ConfigModule.forRoot({ skipProcessEnv });`,
  ),
  configCase(`ConfigModule.forRoot({ 'skipProcessEnv': true });`),
  configCase(`ConfigModule.forRoot({ [skipProcessEnv]: true });`, [
    'configModule',
  ]),
  configCase(
    `const a = { skipProcessEnv: true }; const b = { ...a }; const c = { ...b }; ConfigModule.forRoot({ ...c });`,
  ),
  configCase(
    `const a = { skipProcessEnv: true }; const b = { ...a }; const c = { ...b }; const d = { ...c }; ConfigModule.forRoot({ ...d });`,
    ['configModule'],
  ),
  // e2e-uses-supertest: only a relative src import touches the app.
  {
    rule: 'e2e-uses-supertest',
    code: `import { x } from 'pkg/src/x'; it('a', () => { expect(x).toBe(1); });`,
    ids: [],
    filename: 'app.e2e.test.ts',
  },
  {
    rule: 'e2e-uses-supertest',
    code: `import { x } from '../src/x'; it('a', () => { expect(x).toBe(1); });`,
    ids: ['noHttp'],
    filename: 'app.e2e.test.ts',
  },
  // no-void-async-iife: only an async function.
  { rule: 'no-void-async-iife', code: `void (() => { run(); })();`, ids: [] },
  {
    rule: 'no-void-async-iife',
    code: `void (async () => { await run(); })();`,
    ids: ['voidIife'],
  },
];

/** The meta of every rule in this share, verbatim. */
const META_A: Record<string, unknown> = {
  'fake-timers-restored': {
    type: 'problem',
    docs: {
      description:
        'Fake timers are restored even when a test fails (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      leak: '`useFakeTimers()` has no guaranteed restore: a failing assertion skips a `useRealTimers()` at the end of the test, and fake timers leak into every later test in the file. Restore in `afterEach`, `onTestFinished`, or a `finally` block.',
      unpaired:
        '`toFake` fakes a timer but not its cancel ({{missing}}): the real cancel cannot clear a fake handle, so a cancelled timer still fires and a debounce or timeout test passes for the wrong reason. Fake each set/clear pair together.',
    },
  },
  'mock-factory-hoisted': {
    type: 'problem',
    docs: {
      description:
        'vi.mock factories read only vi.hoisted values (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      notHoisted:
        '`vi.mock` is hoisted above every statement, so its factory runs before `{{name}}` is initialised. Create it with `vi.hoisted(() => ...)`, or read it lazily inside a returned function.',
    },
  },
  'no-nested-test-blocks': {
    type: 'problem',
    docs: {
      description:
        'describe/it/hooks are never registered inside a test (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      nested:
        '`{{name}}` is registered inside a running test, where the runner no longer collects it: it never runs, or runs outside the suite it appears to belong to. Close the enclosing test first.',
    },
  },
  'each-title-unique': {
    type: 'problem',
    docs: {
      description:
        'it.each titles render uniquely and never print a function (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      sameTitle:
        'Every row of this `.each` table renders the same title, so a failure cannot say which case broke. Interpolate a distinguishing field (`%s`, `$name`).',
      duplicateTitle:
        'This row renders the same title as an earlier one, so their results are indistinguishable. Interpolate the field that differs.',
      functionInTitle:
        'This placeholder fills from a function, so the test name prints its source code. Drop the placeholder or point it at a plain field.',
    },
  },
  'no-collection-time-skip-state': {
    type: 'problem',
    docs: {
      description: 'skipIf/runIf never read state a hook sets (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      hookState:
        '`{{name}}` is set in a `beforeAll`/`beforeEach`, but `skipIf`/`runIf` reads it while tests are being collected, before any hook runs, so it always sees the initial value. Decide the condition at module scope (an env var, a setup file), or check inside the test.',
    },
  },
  'no-collection-time-io': {
    type: 'problem',
    docs: {
      description:
        'No fs/child_process calls while tests are collected (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      collectionIo:
        '`{{name}}` runs while the file is being collected (module or describe scope). If it throws — a moved file, a git-less checkout — the whole file fails with an error that names none of its tests. Move it into `beforeAll` or the test that needs it.',
    },
  },
  'guarded-marker-slice': {
    type: 'problem',
    docs: {
      description:
        'Marker-based slicing checks the marker was found (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      inlineIndex:
        'Slicing at `indexOf(marker)` with no check that the marker is there: a missing marker gives -1, which slices from the end and the test runs on the wrong text. Assert `expect(text).toContain(marker)` first, or store the index and check it.',
      unguardedIndex:
        '`{{name}}` is never checked against -1 before it is used to slice, so a missing marker silently selects the wrong text. Assert it was found first.',
      splitIndex:
        '`.split(marker)[n]` is undefined when the marker is missing, and the test then checks nothing. Assert `expect(text).toContain(marker)` before indexing.',
    },
  },
  'reset-shared-let': {
    type: 'problem',
    docs: {
      description:
        'Shared `let` state written by tests is reset per test (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      notReset:
        "`{{name}}` is shared by every test in this file and written inside a test, but no `beforeEach`/`afterEach` that covers that test resets it. A test that reads it without writing first sees the previous test's value instead of failing. Reset it in `beforeEach`.",
    },
  },
  'hermetic-config': {
    type: 'problem',
    docs: {
      description:
        'Test ConfigService instances never read process.env (TEST-STRUCT-02)',
    },
    schema: [
      {
        type: 'object',
        properties: { helperModule: { type: 'string' } },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      { helperModule: 'a test helper with no process.env fallback' },
    ],
    messages: {
      configService:
        "`new ConfigService(values)` falls back to process.env for every key it lacks, so this test reads the developer's or CI's environment. Use `hermeticConfigService(values)` from {{helperModule}}.",
      configModule:
        "`ConfigModule.forRoot` without `skipProcessEnv: true` lets process.env override the test's configuration. Set `skipProcessEnv: true` (and `ignoreEnvFile: true`).",
    },
  },
  'e2e-uses-supertest': {
    type: 'problem',
    docs: {
      description: 'An *.e2e.test.ts drives the app over HTTP (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      noHttp:
        'This file is named `*.e2e.test.ts` but never imports supertest, so it does not exercise the HTTP contract its name claims. Drive the app with supertest, or rename it to an integration test.',
    },
  },
  'no-void-async-iife': {
    type: 'problem',
    docs: {
      description:
        'No `void (async () => ...)()` in tests and test helpers (TEST-STRUCT-02)',
    },
    schema: [],
    messages: {
      voidIife:
        "`void` discards this async IIFE's promise, so a rejection inside it is swallowed and the request or test it serves hangs until a timeout that hides the cause. Await it, or catch and report the error.",
    },
  },
  'no-path-line-literal': {
    type: 'problem',
    docs: {
      description:
        'Tests never pin line numbers in other repository files (TEST-STRUCT-02)',
    },
    schema: [
      {
        type: 'object',
        properties: {
          root: { type: 'string' },
          rootMarker: { type: 'string', minLength: 1 },
          topDirs: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            minItems: 1,
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        topDirs: [
          'src',
          'lib',
          'test',
          'tests',
          'scripts',
          'apps',
          'packages',
          'docs',
          '.github',
        ],
      },
    ],
    messages: {
      pinned:
        '`{{ref}}` pins a line number inside a real repository file, so any unrelated edit to that file breaks this test. Assert on the content (a pattern, a symbol) instead of its position.',
    },
  },
};

/** An assertion on a pinned path:line, assembled so this file pins none. */
const PINNED_CODE = `it('a', () => { expect(out).toContain('${PINNED_PATH_LINE}'); });`;

/** A probe file inside the repository, so the root is found by walking up. */
const IN_REPO_FILE = resolve(REPO_ROOT, 'scripts/probe.test.ts');

/** A file at the filesystem root, above any workspace. */
const OUTSIDE_REPO_FILE = '/probe.test.ts';

/** The walk the product-style config asks for: up to the root marker. */
const WALK = [{ rootMarker: ROOT_MARKER }];

/**
 * no-path-line-literal over `code` as the absolute `filename`. The config is
 * rooted at `/` (unless `cwd` says otherwise) so any absolute path matches
 * it, wherever the run's cwd is.
 */
function pathLint(
  code: string,
  filename: string,
  options: unknown[] = [],
  cwd = '/',
): { id: string; text: string }[] {
  return new Linter({ configType: 'flat', cwd })
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser },
          plugins: { 'shuddhi': plugin },
          rules: { 'shuddhi/no-path-line-literal': ['error', ...options] },
        },
      ],
      filename,
    )
    .map(message => ({
      id: message.messageId ?? message.message,
      text: message.message,
    }));
}

const pathIds = (
  code: string,
  filename: string,
  options: unknown[] = [],
  cwd = '/',
) => pathLint(code, filename, options, cwd).map(message => message.id);

describe('decision pins A: slices, resets, config, paths', () => {
  each(SLICE_CASES_A.map(c => [`${c.rule}: ${c.code}`, c] as const))(
    '%s',
    (_name, c) => {
      assert.deepEqual(messageIds(c.rule, c.code, c.filename ?? TEST_FILE), c.ids);
    },
  );

  each(Object.keys(META_A))('pins the meta of %s', name => {
    assert.deepEqual(rules[name].meta, META_A[name]);
  });

  it('finds the repository root by walking up from the file', () => {
    assert.deepEqual(pathIds(PINNED_CODE, IN_REPO_FILE, WALK), ['pinned']);
  });

  it('reports nothing where no workspace sits above the file', () => {
    assert.deepEqual(pathIds(PINNED_CODE, OUTSIDE_REPO_FILE, WALK), []);
  });

  it('takes an explicit root over the walk', () => {
    assert.deepEqual(
      pathIds(PINNED_CODE, OUTSIDE_REPO_FILE, [
        { root: REPO_ROOT, rootMarker: ROOT_MARKER },
      ]),
      ['pinned'],
    );
  });

  it("takes ESLint's cwd as the root when no option names one", () => {
    assert.deepEqual(pathIds(PINNED_CODE, IN_REPO_FILE, [], REPO_ROOT), [
      'pinned',
    ]);
    assert.deepEqual(pathIds(PINNED_CODE, OUTSIDE_REPO_FILE), []);
  });

  it('looks up only paths under the configured top-level directories', () => {
    const at = (topDirs: string[]) =>
      pathIds(PINNED_CODE, OUTSIDE_REPO_FILE, [{ root: REPO_ROOT, topDirs }]);
    assert.deepEqual(at(['scripts']), ['pinned']);
    assert.deepEqual(at(['tools', 'scripts']), ['pinned']);
    assert.deepEqual(at(['tools']), []);
    // A directory name is literal text, not a pattern.
    assert.deepEqual(at(['scr.pts']), []);
    assert.deepEqual(at(['.*']), []);
  });

  it('names the pinned reference in the message', () => {
    assert.deepEqual(
      pathLint(PINNED_CODE, IN_REPO_FILE, WALK).map(message => message.text),
      [
        `\`${PINNED_PATH_LINE}\` pins a line number inside a real repository file, so any unrelated edit to that file breaks this test. Assert on the content (a pattern, a symbol) instead of its position.`,
      ],
    );
  });

  it('reads a template by its cooked text', () => {
    const escaped = `\\x73${PINNED_PATH_LINE.slice(1)}`;
    assert.deepEqual(
      pathIds(
        `it('a', () => { expect(out).toContain(\`${escaped}\`); });`,
        IN_REPO_FILE,
        WALK,
      ),
      ['pinned'],
    );
  });
});

describe('no-path-line-literal lists the tracked files once per root', () => {
  let root = '';
  let restoreGitEnv = (): void => {};
  before(() => {
    restoreGitEnv = maskProcessGitEnv();
    root = trackedFixture();
  });
  after(() => {
    removeFixtureRoot(root);
    restoreGitEnv();
  });

  it('keeps the first listing after the index changes', () => {
    const code = pinAt('scripts/tracked.sh');
    const first = pathIds(code, OUTSIDE_REPO_FILE, [{ root }]);
    execFileSync('git', ['rm', '-q', '--cached', 'scripts/tracked.sh'], {
      cwd: root,
      env: hermeticGitEnv(),
      timeout: 10_000,
    });
    assert.deepEqual([first, pathIds(code, OUTSIDE_REPO_FILE, [{ root }])], [
      ['pinned'],
      ['pinned'],
    ]);
  });
});

/** Every message of one rule run, as rendered text. */
function messagesA(
  rule: string,
  code: string,
  sourceType: 'module' | 'script' = 'module',
): string[] {
  return new Linter({ configType: 'flat' })
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser, sourceType },
          plugins: { 'shuddhi': plugin },
          rules: { [`shuddhi/${rule}`]: 'error' },
        },
      ],
      TEST_FILE,
    )
    .map(message => message.message);
}

describe('decision pins A: test structure', () => {
  each(STRUCT_CASES_A.map(c => [`${c.rule}: ${c.code}`, c] as const))(
    '%s',
    (_name, c) => {
      assert.deepEqual(messageIds(c.rule, c.code, c.filename ?? TEST_FILE), c.ids);
    },
  );

  it('names the hermetic helper the helperModule option gives, or a neutral one', () => {
    const configServiceMessage = (options: unknown[]): string[] =>
      new Linter({ configType: 'flat' })
        .verify(
          `const config = new ConfigService({});`,
          [
            {
              files: ['**/*.ts'],
              languageOptions: { parser: tseslint.parser },
              plugins: { shuddhi: plugin },
              rules: { 'shuddhi/hermetic-config': ['error', ...options] },
            },
          ],
          TEST_FILE,
        )
        .map(message => message.message);
    const text = (from: string) =>
      `\`new ConfigService(values)\` falls back to process.env for every key it lacks, so this test reads the developer's or CI's environment. Use \`hermeticConfigService(values)\` from ${from}.`;
    assert.deepEqual(
      configServiceMessage([{ helperModule: 'test/support/hermetic-config' }]),
      [text('test/support/hermetic-config')],
    );
    assert.deepEqual(configServiceMessage([]), [
      text('a test helper with no process.env fallback'),
    ]);
  });

  it('lists every unpaired cancel, comma-separated', () => {
    assert.deepEqual(messagesA(
        'fake-timers-restored',
        `vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });`,
      ), [
      '`toFake` fakes a timer but not its cancel (clearTimeout, clearInterval): the real cancel cannot clear a fake handle, so a cancelled timer still fires and a debounce or timeout test passes for the wrong reason. Fake each set/clear pair together.',
    ]);
  });

  it('treats a script-scope binding like a module-scope one', () => {
    assert.deepEqual(messagesA(
        'mock-factory-hoisted',
        `const s = {}; vi.mock('./a', () => ({ s }));`,
        'script',
      ), [
      '`vi.mock` is hoisted above every statement, so its factory runs before `s` is initialised. Create it with `vi.hoisted(() => ...)`, or read it lazily inside a returned function.',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Review findings on rule logic that predates the module split.
// ---------------------------------------------------------------------------

ruleTester.run(
  'guarded-marker-slice (review findings)',
  rules['guarded-marker-slice'],
  {
    valid: [
      // Refuted: Vitest's toMatch with a string is `includes`.
      {
        filename: TEST_FILE,
        code: `it('a', () => { expect(hook).toMatch('a.b.c'); expect(hook.slice(hook.indexOf('a.b.c'))).toBe('x'); });`,
      },
      {
        filename: TEST_FILE,
        code: `it('a', () => { const start = hook.indexOf('marker'); if (start === -1) throw new Error('no marker'); expect(hook.slice(start)).toBe('x'); });`,
      },
      {
        filename: TEST_FILE,
        code: `it('a', () => { const start = hook.indexOf('marker'); const found = start !== -1; expect(found).toBe(true); expect(hook.slice(start)).toBe('x'); });`,
      },
      // The last of a sequence is its value; `!` keeps the result.
      {
        filename: TEST_FILE,
        code: `it('a', () => { const start = hook.indexOf('marker'); const found = (log(), start !== -1); expect(found).toBe(true); expect(hook.slice(start)).toBe('x'); });`,
      },
      {
        filename: TEST_FILE,
        code: `it('a', () => { const start = hook.indexOf('marker'); if (!(start !== -1)) throw new Error('no marker'); expect(hook.slice(start)).toBe('x'); });`,
      },
    ],
    invalid: [
      // A comparison whose result is dropped guards nothing.
      {
        filename: TEST_FILE,
        code: `it('a', () => { const start = hook.indexOf('marker'); start !== -1; expect(hook.slice(start)).toBe('x'); });`,
        errors: [{ messageId: 'unguardedIndex' }],
      },
      // Dropped under `void` or inside a sequence.
      {
        filename: TEST_FILE,
        code: `it('a', () => { const start = hook.indexOf('marker'); void (start !== -1); expect(hook.slice(start)).toBe('x'); });`,
        errors: [{ messageId: 'unguardedIndex' }],
      },
      {
        filename: TEST_FILE,
        code: `it('a', () => { const start = hook.indexOf('marker'); const found = (start !== -1, log()); expect(found).toBe(true); expect(hook.slice(start)).toBe('x'); });`,
        errors: [{ messageId: 'unguardedIndex' }],
      },
      {
        filename: TEST_FILE,
        code: `it('a', () => { const start = hook.indexOf('marker'); log(), start !== -1; expect(hook.slice(start)).toBe('x'); });`,
        errors: [{ messageId: 'unguardedIndex' }],
      },
    ],
  },
);

ruleTester.run(
  'reset-shared-let (review findings)',
  rules['reset-shared-let'],
  {
    valid: [
      {
        filename: TEST_FILE,
        code: `let value;
      beforeEach(() => { value = 0; });
      describe('a', () => { it('x', () => { value = 1; expect(value).toBe(1); }); });
      describe('b', () => { it('y', () => { value = 2; expect(value).toBe(2); }); });`,
      },
      {
        filename: TEST_FILE,
        code: `let value;
      describe('a', () => { beforeEach(() => { value = 0; }); it('x', () => { value = 1; expect(value).toBe(1); }); });`,
      },
    ],
    invalid: [
      // The reset in suite a does not run before suite b's tests.
      {
        filename: TEST_FILE,
        code: `let value;
      describe('a', () => { beforeEach(() => { value = 0; }); it('x', () => { value = 1; expect(value).toBe(1); }); });
      describe('b', () => { it('y', () => { value = 2; expect(value).toBe(2); }); });`,
        errors: [{ messageId: 'notReset' }],
      },
    ],
  },
);

ruleTester.run(
  'fake-timers-restored (review findings)',
  rules['fake-timers-restored'],
  {
    valid: [
      {
        filename: TEST_FILE,
        code: `describe('a', () => { beforeAll(() => { vi.useFakeTimers(); }); afterAll(() => { vi.useRealTimers(); }); it('x', () => { expect(run()).toBe(1); }); });`,
      },
      {
        filename: TEST_FILE,
        code: `it('a', () => { vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers(); }); expect(run()).toBe(1); });`,
      },
      {
        filename: TEST_FILE,
        code: `describe('a', () => { afterEach(() => { vi.useRealTimers(); }); describe('b', () => { it('x', () => { vi.useFakeTimers(); expect(run()).toBe(1); }); }); });`,
      },
      // vi.hoisted runs at module load: module scope.
      {
        filename: TEST_FILE,
        code: `vi.hoisted(() => { vi.useFakeTimers(); }); it('a', () => { expect(run()).toBe(1); });`,
      },
      // A module-level helper runs wherever it is called.
      {
        filename: TEST_FILE,
        code: `const fake = () => { vi.useFakeTimers(); };
      describe('a', () => { afterEach(() => { vi.useRealTimers(); }); it('x', () => { fake(); expect(run()).toBe(1); }); });`,
      },
      // Refuted: beforeEach re-makes the fake before each test
      // of the block, and afterAll restores before anything outside it.
      {
        filename: TEST_FILE,
        code: `describe('a', () => { beforeEach(() => { vi.useFakeTimers(); }); afterAll(() => { vi.useRealTimers(); }); it('x', () => { expect(run()).toBe(1); }); });`,
      },
    ],
    invalid: [
      // A test's own fake outlives it under a block-level afterAll.
      {
        filename: TEST_FILE,
        code: `describe('a', () => { afterAll(() => { vi.useRealTimers(); }); it('x', () => { vi.useFakeTimers(); expect(run()).toBe(1); }); });`,
        errors: [{ messageId: 'leak' }],
      },
      {
        filename: TEST_FILE,
        code: `describe('a', () => { afterEach(() => { vi.useRealTimers(); }); it('x', () => { vi.useFakeTimers(); expect(run()).toBe(1); }); });
      describe('b', () => { it('y', () => { vi.useFakeTimers(); expect(run()).toBe(1); vi.useRealTimers(); }); });`,
        errors: [{ messageId: 'leak', line: 2 }],
      },
      {
        filename: TEST_FILE,
        code: `describe('a', () => { afterEach(() => { vi.useRealTimers(); }); });
      it('b', () => { [1].forEach(() => { vi.useFakeTimers(); }); expect(run()).toBe(1); });`,
        errors: [{ messageId: 'leak' }],
      },
      {
        filename: TEST_FILE,
        code: `const fake = () => { vi.useFakeTimers(); }; it('x', () => { fake(); expect(run()).toBe(1); });`,
        errors: [{ messageId: 'leak' }],
      },
    ],
  },
);
