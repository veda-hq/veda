import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  checkBuild,
  checkPackage,
  checkVitest,
  failureOf,
  formatViolations,
  loaderFailure,
  loaderScriptBeside,
  loadVitestExclude,
  missingConfigs,
  ownedBy,
  parseConfig,
  readExclude,
  type Config,
  type Load,
} from './coverage-exemptions.ts';
import { loadTypescript, type Ts } from './typescript.ts';

const loaded = loadTypescript();
if (typeof loaded === 'string') throw new Error(loaded);
const ts: Ts = loaded;

const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-exempt-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

const CONFIG: Config = parseConfig(
  JSON.stringify({
    vitest: { configs: ['app/vitest.config.mjs'], requiredExcludes: ['**/*.test.ts', '**/__mocks__/**'] },
    build: { configs: ['app/tsconfig.build.json'], forbiddenIncludes: ['__mocks__', '.test.'] },
  }),
);

describe('parseConfig', () => {
  it('reads both sections and an optional loader', () => {
    const c = parseConfig(JSON.stringify({ vitest: { configs: ['a/v.ts'], requiredExcludes: ['x'] }, loader: 'tsx' }));
    assert.deepEqual(c, { vitest: { configs: ['a/v.ts'], requiredExcludes: ['x'] }, build: { configs: [], forbiddenIncludes: [] }, loader: 'tsx' });
  });

  it('refuses what would check nothing or the wrong thing', () => {
    const bad: Array<[string, RegExp]> = [
      ['nope', /not JSON/],
      ['[]', /must be a JSON object/],
      ['{"extra": 1}', /unknown key "extra"/],
      ['{}', /nothing would be checked/],
      ['{"vitest": []}', /"vitest" must be an object/],
      ['{"vitest": {"configs": ["a"], "requiredExcludes": ["x"], "more": 1}}', /vitest: unknown key "more"/],
      ['{"vitest": {"configs": "a"}}', /vitest\.configs must be a list/],
      ['{"vitest": {"configs": [""], "requiredExcludes": ["x"]}}', /vitest\.configs must be a list of non-empty paths/],
      ['{"build": {"configs": ["a"], "forbiddenIncludes": [1]}}', /build\.forbiddenIncludes must be a list/],
      ['{"vitest": {"configs": ["../a"], "requiredExcludes": ["x"]}}', /"\.\.\/a" is not a normalized/],
      ['{"vitest": {"configs": ["/a"], "requiredExcludes": ["x"]}}', /"\/a" is not a normalized/],
      ['{"vitest": {"configs": ["a/./b"], "requiredExcludes": ["x"]}}', /is not a normalized/],
      ['{"vitest": {"configs": ["a"]}}', /vitest\.requiredExcludes is empty/],
      ['{"build": {"configs": ["a"], "forbiddenIncludes": []}}', /build\.forbiddenIncludes is empty/],
      ['{"vitest": {"configs": ["a"], "requiredExcludes": ["x"]}, "loader": ""}', /"loader" must be a module name/],
    ];
    for (const [text, message] of bad) assert.throws(() => parseConfig(text), message, text);
  });
});

describe('checkPackage and ownedBy', () => {
  const root = tree({ 'apps/server/x': '', 'file.txt': '' });

  it('accepts a folder under the root and refuses anything that would match nothing', () => {
    assert.equal(checkPackage(root, 'apps/server'), undefined);
    for (const dir of ['', '.', '..', '../x', '/tmp', 'apps/server/', 'apps//server', 'apps/nowhere', 'file.txt', 'APPS/Server']) {
      assert.match(checkPackage(root, dir) ?? '', /is not/, dir);
    }
  });

  it('keeps the configs under the folder, or all', () => {
    const configs = ['apps/server/v.ts', 'apps/serverless/v.ts', 'apps/mobile/v.ts'];
    assert.deepEqual(ownedBy(configs, 'apps/server'), ['apps/server/v.ts']);
    assert.deepEqual(ownedBy(configs, undefined), configs);
  });

  it('lists the configs that are not files', () => {
    assert.deepEqual(missingConfigs(root, ['file.txt', 'apps/server', 'absent.json']), ['apps/server', 'absent.json']);
  });
});

describe('readExclude and loadVitestExclude', () => {
  const root = tree({
    'object.mjs': 'export default { test: { coverage: { exclude: ["a"] } } };',
    'top.mjs': 'export default { coverage: { exclude: ["top"] } };',
    'factory.mjs': 'export default () => ({ test: { coverage: { exclude: ["f"] } } });',
    'async.mjs': 'export default async () => ({ test: { coverage: { exclude: ["async"] } } });',
    'none.mjs': 'export default { test: {} };',
    'noisy.mjs': 'console.log("hello"); export default { test: { coverage: { exclude: ["n"] } } };',
    'forged.mjs': 'setTimeout(() => console.log(\'["**/*.test.ts"]\'), 0); export default { test: {} };',
    'timer.mjs': 'setInterval(() => {}, 1000); export default { test: { coverage: { exclude: ["t"] } } };',
    'fn.mjs': 'export default { test: { coverage: { exclude: () => [] } } };',
    'wrote-then-failed.mjs': 'import { writeSync } from "node:fs"; writeSync(3, \'["x"]\'); process.exit(1);',
    'garbage.mjs': 'import { writeSync } from "node:fs"; writeSync(3, "oops"); export default {};',
    'throws.mjs': 'throw new Error("config exploded");',
    'throws-text.mjs': 'throw "a string";',
    'hang.mjs': 'setInterval(() => {}, 1000); await new Promise(() => {});',
    'sub/reads.mjs': 'import { readFileSync } from "node:fs"; export default { test: { coverage: { exclude: JSON.parse(readFileSync("./excl.json", "utf8")) } } };',
    'sub/excl.json': '["from-its-folder"]',
    'sub/hooked.mjs': 'export default { test: { coverage: { exclude: [globalThis.hooked ? "hooked" : "plain"] } } };',
    'hook.mjs': 'globalThis.hooked = true;',
  });

  it('reads an object, a top-level coverage, a factory and an async factory', async () => {
    assert.deepEqual(await readExclude(join(root, 'object.mjs')), ['a']);
    assert.deepEqual(await readExclude(join(root, 'top.mjs')), ['top']);
    assert.deepEqual(await readExclude(join(root, 'factory.mjs')), ['f']);
    assert.deepEqual(await readExclude(join(root, 'async.mjs')), ['async']);
    assert.equal(await readExclude(join(root, 'none.mjs')), undefined);
  });

  it('loads each config in its own process; nothing it prints is the answer', () => {
    assert.deepEqual(loadVitestExclude(root, 'object.mjs', undefined), { ok: true, exclude: ['a'] });
    assert.deepEqual(loadVitestExclude(root, 'noisy.mjs', undefined), { ok: true, exclude: ['n'] });
    assert.deepEqual(loadVitestExclude(root, 'none.mjs', undefined), { ok: true, exclude: null });
    assert.deepEqual(loadVitestExclude(root, 'forged.mjs', undefined), { ok: true, exclude: null });
    assert.deepEqual(loadVitestExclude(root, 'fn.mjs', undefined), { ok: true, exclude: null });
  });

  it('answers without waiting on a config’s open timer', () => {
    const started = Date.now();
    assert.deepEqual(loadVitestExclude(root, 'timer.mjs', undefined), { ok: true, exclude: ['t'] });
    assert.ok(Date.now() - started < 30_000);
  });

  it('runs in the config’s own folder, with a relative loader taken from the root', () => {
    assert.deepEqual(loadVitestExclude(root, 'sub/reads.mjs', undefined), { ok: true, exclude: ['from-its-folder'] });
    assert.deepEqual(loadVitestExclude(root, 'sub/hooked.mjs', './hook.mjs'), { ok: true, exclude: ['hooked'] });
    assert.deepEqual(loadVitestExclude(root, 'sub/hooked.mjs', undefined), { ok: true, exclude: ['plain'] });
  });

  it('reports a failure with its reason, even after an answer was written', () => {
    assert.deepEqual(loadVitestExclude(root, 'throws.mjs', undefined), { ok: false, error: 'Error: config exploded' });
    assert.deepEqual(loadVitestExclude(root, 'throws-text.mjs', undefined), { ok: false, error: 'a string' });
    assert.deepEqual(loadVitestExclude(root, 'wrote-then-failed.mjs', undefined), { ok: false, error: 'exit 1' });
    const garbage = loadVitestExclude(root, 'garbage.mjs', undefined);
    assert.match(garbage.ok ? '' : garbage.error, /^the config's coverage\.exclude is not data: oops/);
    const hang = loadVitestExclude(root, 'hang.mjs', undefined, 1_000);
    assert.match(hang.ok ? '' : hang.error, /ETIMEDOUT/);
    const noLoader = loadVitestExclude(root, 'object.mjs', 'no-such-loader-pariksha');
    assert.match(noLoader.ok ? '' : noLoader.error, /no-such-loader-pariksha/);
  });

  it('names a loader that does not load, and accepts none or one that does', () => {
    assert.equal(loaderFailure(root, undefined), undefined);
    assert.equal(loaderFailure(root, './hook.mjs'), undefined);
    assert.match(loaderFailure(root, 'no-such-loader-pariksha') ?? '', /^loader no-such-loader-pariksha does not load: .*no-such-loader-pariksha/);
  });

  it('reads the reason a child failed', () => {
    assert.equal(failureOf('at x\nTypeError: bad\n', 1), 'TypeError: bad');
    assert.equal(failureOf('node:internal/x:1\n  throw v;\n  ^\n\nplain value\n', 1), 'plain value');
    assert.equal(failureOf('just this\n', 1), 'just this');
    assert.equal(failureOf('', 4), 'exit 4');
  });

  it('picks the .ts child under test and the .js child once built', () => {
    assert.match(loaderScriptBeside('file:///p/src/coverage-exemptions.ts'), /\/p\/src\/load-vitest-config\.ts$/);
    assert.match(loaderScriptBeside('file:///p/dist/coverage-exemptions.js'), /\/p\/dist\/load-vitest-config\.js$/);
  });
});

describe('checkVitest', () => {
  const load = (answers: Record<string, Load>) => (c: string) => answers[c] ?? { ok: false, error: 'unexpected' };

  it('passes a config holding every required pattern', () => {
    assert.deepEqual(checkVitest(CONFIG, ['v'], load({ v: { ok: true, exclude: ['**/*.test.ts', '**/__mocks__/**', 'dist/**'] } })), []);
  });

  it('names each missing pattern, an absent or empty list, and a load failure', () => {
    const answers: Record<string, Load> = {
      partial: { ok: true, exclude: ['**/*.test.ts'] },
      absent: { ok: true, exclude: null },
      empty: { ok: true, exclude: [] },
      broken: { ok: false, error: 'boom' },
    };
    assert.deepEqual(checkVitest(CONFIG, ['partial', 'absent', 'empty', 'broken'], load(answers)), [
      { file: 'partial', message: 'coverage.exclude lacks **/__mocks__/**' },
      { file: 'absent', message: 'has no coverage.exclude' },
      { file: 'empty', message: 'has no coverage.exclude' },
      { file: 'broken', message: 'cannot load the config: boom' },
    ]);
  });
});

describe('checkBuild', () => {
  const root = tree({
    'ok.json': '{\n  // comments are allowed\n  "include": ["src/**/*.ts"],\n}',
    'none.json': '{ "compilerOptions": {} }',
    'bad.json': '{ "include": ["src/**", "src/__mocks__/**", "**/*.test.ts"] }',
    'broken.json': '{ "include": [ }',
    'wrong.json': '{ "include": "src" }',
  });

  it('passes an include with no test pattern, or none at all, reading JSON with comments', () => {
    assert.deepEqual(checkBuild(ts, CONFIG, root, ['ok.json', 'none.json']), []);
  });

  it('names each forbidden pattern an include holds', () => {
    assert.deepEqual(checkBuild(ts, CONFIG, root, ['bad.json']), [
      { file: 'bad.json', message: 'include brings test files into the build: __mocks__' },
      { file: 'bad.json', message: 'include brings test files into the build: .test.' },
    ]);
  });

  it('throws on a config it cannot read, rather than skip it', () => {
    assert.throws(() => checkBuild(ts, CONFIG, root, ['wrong.json']), /wrong\.json: "include" is not a list of strings/);
    assert.throws(() => checkBuild(ts, CONFIG, root, ['missing.json']), /missing\.json: /);
    assert.throws(() => checkBuild(ts, CONFIG, root, ['broken.json']), /broken\.json: Expression or comma expected/);
  });
});

describe('formatViolations', () => {
  it('counts what it checked, scoped to a package', () => {
    assert.deepEqual(formatViolations([], 2, 1, undefined).out, ['pariksha coverage-exemptions: 2 vitest and 1 build config(s) checked, none drifts']);
    assert.deepEqual(formatViolations([], 0, 0, 'packages/shared').out, ['pariksha coverage-exemptions: 0 vitest and 0 build config(s) under packages/shared checked, none drifts']);
  });

  it('lists each problem and how to fix it', () => {
    const r = formatViolations([{ file: 'a', message: 'm' }], 1, 0, undefined);
    assert.equal(r.ok, false);
    assert.deepEqual(r.err, ['pariksha coverage-exemptions: a: m', 'pariksha coverage-exemptions: 1 problem(s). Exempt test files from coverage in every vitest config, and keep them out of every build.']);
  });
});
