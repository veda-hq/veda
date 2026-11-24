import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseConfig } from './config.ts';
import { incrementalKey, keyInputPaths } from './reuse-key.ts';

const config = parseConfig(readFileSync(new URL('../test/fixture/agnipariksha.json', import.meta.url), 'utf8'));
if (typeof config === 'string') throw new Error(config);
const KEY_POLICY = config.reuseKey;

const tracked = [
  'apps/server/src/a.ts',
  'apps/server/src/a.test.ts',
  'apps/server/test/helpers.ts',
  'apps/server/test/x.e2e.test.ts',
  'apps/server/vitest.config.ts',
  'apps/server/tsconfig.build.json',
  'apps/server/src/test-setup.ts',
  'apps/web/src/b.ts',
  'packages/shared/src/money.ts',
  'packages/shared/src/money.test.ts',
  'packages/test-utils/src/builders.ts',
  'packages/test-utils/src/builders.test.ts',
  'scripts/mutation/arid-nodes.mjs',
  'scripts/mutation/thing.test.mjs',
  'scripts/mutation/runner.ts',
];

test('the server key reads its config, helpers, test-utils, shared and the plugins', () => {
  assert.deepEqual(keyInputPaths('apps/server', 'stryker.config.mjs', tracked, KEY_POLICY), [
    'apps/server/src/test-setup.ts',
    'apps/server/stryker.config.mjs',
    'apps/server/test/helpers.ts',
    'apps/server/tsconfig.build.json',
    'apps/server/vitest.config.ts',
    'node_modules/@stryker-mutator/core/package.json',
    'packages/shared/src/money.ts',
    'packages/test-utils/src/builders.ts',
    'pnpm-lock.yaml',
    'scripts/mutation/arid-nodes.mjs',
    'scripts/mutation/thing.test.mjs',
  ]);
});

test("shared's own key leaves its sources out", () => {
  const paths = keyInputPaths('packages/shared', 'stryker.config.mjs', tracked, KEY_POLICY);
  assert.equal(paths.includes('packages/shared/src/money.ts'), false);
  assert.equal(paths.includes('packages/shared/stryker.config.mjs'), true);
});

test('a workspace key tells test files, configs and helpers from look-alikes', () => {
  const policy = { always: [], pluginDir: 'tools/stryker/', helperPackages: ['libs/a/', 'libs/b/'], sharedWorkspace: 'shared' };
  const paths = [
    'w/test/x.test.ts.bak',
    'w/test/x.test.mts',
    'w/vite.config.mts',
    'w/vite.config.ts.bak',
    'w/src/vite.config.ts',
    'w/tsconfig.json.bak',
    'w/src/tsconfig.json',
    'libs/b/src/x.ts',
    'web/test/x.ts',
    'w/src/fixture/a.ts',
    'w/src/fixtures/a.ts',
    'w/src/__mocks__/a.ts',
    'w/contest/a.ts',
    'w/src/latest/a.ts',
  ];
  assert.deepEqual(keyInputPaths('w', 'stryker.config.mjs', paths, policy), [
    'libs/b/src/x.ts',
    'w/src/__mocks__/a.ts',
    'w/src/fixture/a.ts',
    'w/src/fixtures/a.ts',
    'w/stryker.config.mjs',
    'w/test/x.test.ts.bak',
    'w/vite.config.mts',
  ]);
});

test('the key hashes each path with its content hash, in order', () => {
  const files: Record<string, string> = { a: '1', b: '2' };
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
  const expected = createHash('sha256').update(`a\0${sha('1')}\n`).update(`b\0${sha('2')}\n`).digest('hex').slice(0, 16);
  assert.equal(incrementalKey(['a', 'b'], (path) => files[path]), expected);
});

test('the key is stable, moves with content, and is null when an input is unreadable', () => {
  const files: Record<string, string> = { a: '1', b: '2' };
  const read = (path: string) => files[path];
  const first = incrementalKey(['a', 'b'], read);
  assert.match(first ?? '', /^[0-9a-f]{16}$/);
  assert.equal(incrementalKey(['a', 'b'], read), first);
  files.b = '3';
  assert.notEqual(incrementalKey(['a', 'b'], read), first);
  assert.equal(incrementalKey(['a', 'missing'], read), null);
});
