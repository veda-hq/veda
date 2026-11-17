import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONFIG_FILE, DEFAULT_UPSTREAM, lanesOf, loadConfig, parseConfig, type Config } from './config.ts';

const reuseKey = { always: ['pnpm-lock.yaml'], pluginDir: 'tools/stryker/', helperPackages: [], sharedWorkspace: 'lib' };
const lane = { name: 'lib', cwd: 'lib', config: 'stryker.config.mjs', reuse: true, include: ['^lib/src/'] };
const valid = (over: Record<string, unknown> = {}): string => JSON.stringify({ lanes: [lane], reuseKey, ...over });
const parsed = (source: string): Config => {
  const config = parseConfig(source);
  if (typeof config === 'string') throw new Error(config);
  return config;
};

test('a minimal config takes the defaults', () => {
  assert.deepEqual(parsed(valid()), {
    upstream: DEFAULT_UPSTREAM,
    ignore: [],
    unsetEnv: [],
    lanes: [{ ...lane, exclude: [], extensions: [], env: {} }],
    reuseKey,
  });
  assert.equal(parsed(valid({ upstream: 'origin/trunk' })).upstream, 'origin/trunk');
  assert.deepEqual(parsed(valid({ unsetEnv: ['VITEST_MAX_WORKERS', 'GITHUB_ACTIONS'] })).unsetEnv, ['VITEST_MAX_WORKERS', 'GITHUB_ACTIONS']);
});

test('a bad file is refused with the field that is wrong', () => {
  const refusals: [string, RegExp][] = [
    ['{', /^agnipariksha\.json is not JSON: /],
    ['[]', /^agnipariksha\.json must be an object$/],
    [JSON.stringify({ lanes: [lane] }), /^agnipariksha\.json\.reuseKey is missing$/],
    [valid({ workspaces: [] }), /^agnipariksha\.json\.workspaces is not a known field$/],
    [valid({ lanes: [] }), /^agnipariksha\.json\.lanes must be a non-empty array$/],
    [valid({ lanes: {} }), /lanes must be a non-empty array/],
    [valid({ lanes: [lane, lane] }), /^agnipariksha\.json\.lanes names "lib" twice$/],
    [valid({ lanes: [{ ...lane, name: '' }] }), /^agnipariksha\.json\.lanes\[0\]\.name must be a non-empty string$/],
    [valid({ lanes: [{ ...lane, name: 'a,b' }] }), /lanes\[0\]\.name must not contain a comma or start with --$/],
    [valid({ lanes: [{ ...lane, name: '--all' }] }), /lanes\[0\]\.name must not contain a comma or start with --$/],
    [valid({ lanes: [{ ...lane, cwd: 3 }] }), /lanes\[0\]\.cwd must be a string$/],
    [valid({ lanes: [{ ...lane, reuse: 'yes' }] }), /lanes\[0\]\.reuse must be true or false$/],
    [valid({ lanes: [{ ...lane, include: [] }] }), /lanes\[0\]\.include must name at least one pattern$/],
    [valid({ lanes: [{ ...lane, include: '^lib/' }] }), /lanes\[0\]\.include must be an array of strings$/],
    [valid({ lanes: [{ ...lane, include: ['('] }] }), /lanes\[0\]\.include\[0\] is not a regular expression: /],
    [valid({ lanes: [{ ...lane, exclude: [1] }] }), /lanes\[0\]\.exclude\[0\] must be a non-empty string$/],
    [valid({ lanes: [{ ...lane, extensions: [''] }] }), /lanes\[0\]\.extensions\[0\] must be a non-empty string$/],
    [valid({ lanes: [{ ...lane, env: [] }] }), /lanes\[0\]\.env must be an object of strings$/],
    [valid({ lanes: [{ ...lane, env: { A: 1 } }] }), /lanes\[0\]\.env\.A must be a string$/],
    [valid({ lanes: [{ ...lane, fallbackEnv: null }] }), /lanes\[0\]\.fallbackEnv must be an object of strings$/],
    [valid({ lanes: [{ ...lane, mutate: [] }] }), /lanes\[0\]\.mutate is not a known field$/],
    [valid({ ignore: ['['] }), /^agnipariksha\.json\.ignore\[0\] is not a regular expression: /],
    [valid({ upstream: '' }), /^agnipariksha\.json\.upstream must be a non-empty string$/],
    [valid({ unsetEnv: 'GITHUB_ACTIONS' }), /^agnipariksha\.json\.unsetEnv must be an array of strings$/],
    [valid({ unsetEnv: ['GITHUB_ACTIONS', 1] }), /^agnipariksha\.json\.unsetEnv\[1\] must be a non-empty string$/],
    [valid({ unsetEnv: ['A=1'] }), /^agnipariksha\.json\.unsetEnv\[0\] is not a variable name: it holds "="$/],
    [valid({ reuseKey: { ...reuseKey, pluginDir: '' } }), /^agnipariksha\.json\.reuseKey\.pluginDir must be a non-empty string$/],
    [valid({ reuseKey: { ...reuseKey, always: 'x' } }), /reuseKey\.always must be an array of strings$/],
  ];
  for (const [source, reason] of refusals) {
    const result = parseConfig(source);
    assert.equal(typeof result, 'string', source);
    assert.match(result as string, reason, source);
  }
});

test('loadConfig reads the file at the root, and a missing one is refused', () => {
  const files = new Map([[`/repo/${CONFIG_FILE}`, valid()]]);
  const read = (path: string) => files.get(path);
  assert.equal(typeof loadConfig('/repo', read), 'object');
  assert.match(loadConfig('/elsewhere', read) as string, /^no agnipariksha\.json at \/elsewhere: /);
});

test('a lane mutates a file it includes, with its extension, that nothing excludes or ignores', () => {
  const config = parsed(
    valid({
      ignore: ['\\.test\\.'],
      lanes: [{ ...lane, include: ['^lib/src/', '^lib/bin/'], exclude: ['/generated/'], extensions: ['.ts'] }, { ...lane, name: 'any', include: ['^any/'] }],
    }),
  );
  const [lib, any] = lanesOf(config);
  assert.equal(lib?.selects('lib/src/a.ts'), true);
  assert.equal(lib?.selects('lib/bin/a.ts'), true);
  assert.equal(lib?.selects('lib/src/a.js'), false);
  assert.equal(lib?.selects('lib/src/a.test.ts'), false);
  assert.equal(lib?.selects('lib/src/generated/a.ts'), false);
  assert.equal(lib?.selects('other/lib/src/a.ts'), false);
  assert.equal(any?.selects('any/x.json'), true, 'no extensions means any');
  assert.equal(any?.selects('any/x.test.json'), false, 'ignore applies to every lane');
});

test('env and fallbackEnv fill in the owning suites', () => {
  const config = parsed(valid({ lanes: [{ ...lane, env: { MODE: 'related', LIST: '[{suites}]' }, fallbackEnv: { SUITES: '{suites}' } }] }));
  const [only] = lanesOf(config);
  assert.deepEqual(only?.env(['a.test.ts', 'b.test.ts']), { MODE: 'related', LIST: '[a.test.ts,b.test.ts]' });
  assert.deepEqual(only?.fallback?.(['a.test.ts']), { SUITES: 'a.test.ts' });
  assert.deepEqual(only?.env([]), { MODE: 'related', LIST: '[]' });
  assert.deepEqual(only?.fallback?.(['a$&.test.ts', 'b$$.test.ts']), { SUITES: 'a$&.test.ts,b$$.test.ts' }, 'suite paths are passed as written');
  const [plain] = lanesOf(parsed(valid()));
  assert.equal(plain?.fallback, undefined);
  assert.equal(Object.hasOwn(plain ?? {}, 'fallback'), false);
  // An env naming the suites narrows the lane's own run to them; a fallbackEnv alone does not.
  assert.equal(only?.ownSuites, true);
  assert.equal(Object.hasOwn(plain ?? {}, 'ownSuites'), false);
  const [fallbackOnly] = lanesOf(parsed(valid({ lanes: [{ ...lane, env: { MODE: 'related' }, fallbackEnv: { SUITES: '{suites}' } }] })));
  assert.equal(fallbackOnly?.ownSuites, undefined);
});
