// A monorepo's agnipariksha.json (test/fixture), held to the lanes its gate
// compiled in before the facts moved out of the code: the same tables.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { lanesOf, parseConfig } from './config.ts';

const config = parseConfig(readFileSync(new URL('../test/fixture/agnipariksha.json', import.meta.url), 'utf8'));
if (typeof config === 'string') throw new Error(config);
const LANES = lanesOf(config);
const WORKSPACES = ['apps/server', 'apps/web', 'apps/mobile', 'packages/shared', 'packages/claude-mods'];

/** The workspace lane that mutates this path, or null. */
const workspaceOf = (path: string): string | null => LANES.find((lane) => WORKSPACES.includes(lane.name) && lane.selects(path))?.name ?? null;
/** The tooling lane that mutates this path, or null. */
const toolingLaneOf = (path: string): string | null => LANES.find((lane) => lane.name.startsWith('tooling ') && lane.selects(path))?.name ?? null;
const isIgnored = (path: string): boolean => config.ignore.some((source) => new RegExp(source).test(path));

test('workspace sources: .ts/.tsx under a workspace src/, nothing else', () => {
  assert.equal(workspaceOf('apps/server/src/a.ts'), 'apps/server');
  assert.equal(workspaceOf('apps/web/src/Page.tsx'), 'apps/web');
  assert.equal(workspaceOf('packages/claude-mods/src/x.ts'), 'packages/claude-mods');
  for (const path of [
    'packages/test-utils/src/builders.ts',
    'apps/server/src/a.test.ts',
    'apps/web/src/__tests__/a.ts',
    'apps/server/src/types.d.ts',
    'apps/server/src/a.js',
    'apps/server/src/generated/client.ts',
    'apps/server/src/.prisma/x.ts',
    'apps/server/src/@prisma/x.ts',
    'apps/web/src/vite.config.ts',
    'apps/server/scripts/ops/run.ts',
    'packages/claude-mods/hooks/x.ts',
  ]) {
    assert.equal(workspaceOf(path), null, path);
  }
});

test('test-file shapes', () => {
  for (const path of ['a/__mocks__/x.ts', 'apps/server/test/h.ts', 'apps/web/e2e/x.ts', 'a/b.spec.ts', 'a/b.test.tsx']) {
    assert.equal(isIgnored(path), true, path);
  }
  assert.equal(isIgnored('a/latest.ts'), false);
});

test('tooling lanes: scripts/ and the moved product scripts run under vitest, .claude/scripts under node:test', () => {
  assert.equal(toolingLaneOf('scripts/mutation/runner.ts'), 'tooling vitest');
  assert.equal(toolingLaneOf('scripts/eslint/rule.cjs'), 'tooling vitest');
  assert.equal(toolingLaneOf('apps/mobile/scripts/ios/x.ts'), 'tooling vitest');
  assert.equal(toolingLaneOf('apps/server/scripts/ops/run.ts'), 'tooling vitest');
  assert.equal(toolingLaneOf('infra/cloudflare/worker.ts'), 'tooling vitest');
  assert.equal(toolingLaneOf('.claude/scripts/hook.ts'), 'tooling node:test');
  for (const path of [
    'docs/a.ts',
    'scripts/a.test.ts',
    'scripts/a.d.ts',
    'scripts/a.json',
    'scripts/mutation/fixtures/x.ts',
    'scripts/__fixtures__/x.ts',
    'scripts/a.fixture.ts',
  ]) {
    assert.equal(toolingLaneOf(path), null, path);
  }
});

test('seven lanes: five workspaces with reuse; vitest tooling uses the related filter and falls back to own suites; node:test names its suites', () => {
  assert.deepEqual(
    LANES.map((lane) => [lane.name, lane.cwd, lane.reuse]),
    [
      ['apps/server', 'apps/server', true],
      ['apps/web', 'apps/web', true],
      ['apps/mobile', 'apps/mobile', true],
      ['packages/shared', 'packages/shared', true],
      ['packages/claude-mods', 'packages/claude-mods', true],
      ['tooling vitest', '', false],
      ['tooling node:test', '', false],
    ],
  );
  const [server, , , , , vitest, nodeTest] = LANES;
  assert.equal(server?.selects('apps/server/src/a.ts'), true);
  assert.equal(server?.selects('apps/web/src/a.ts'), false);
  assert.deepEqual(server?.env(['x']), {});
  assert.equal(vitest?.selects('scripts/a.ts'), true);
  assert.deepEqual(vitest?.env(['a.test.ts', 'b.test.ts']), { REPO_TOOLING_RELATED_FILTER: '1' });
  assert.deepEqual(vitest?.fallback?.(['a.test.ts', 'b.test.ts']), { REPO_TOOLING_RELATED_FILTER: '0', REPO_TOOLING_MUTATION_SUITES: 'a.test.ts,b.test.ts' });
  assert.equal(server?.fallback, undefined);
  assert.equal(nodeTest?.fallback, undefined);
  assert.equal(nodeTest?.selects('.claude/scripts/a.ts'), true);
  assert.deepEqual(nodeTest?.env(['c.test.ts']), { REPO_TOOLING_MUTATION_SUITES: 'c.test.ts' });
});

test('every lane keeps the config file it ran before', () => {
  assert.deepEqual(
    LANES.map((lane) => lane.config),
    [
      ...WORKSPACES.map(() => 'stryker.config.mjs'),
      'scripts/mutation/config/tooling-vitest.stryker.mjs',
      'scripts/mutation/config/tooling-node-test.stryker.mjs',
    ],
  );
  assert.equal(config.upstream, 'origin/main');
});
