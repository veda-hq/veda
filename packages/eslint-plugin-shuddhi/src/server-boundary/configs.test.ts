import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Linter } from 'eslint';

import { BOUNDARY_EXEMPT, boundaryBlocks, DEFAULT_NAMESPACE } from './configs.js';
import { rules } from './index.js';

/**
 * The config blocks: the named rules on under the caller's namespace, off
 * again for every exemption, and the exemptions confined to code files.
 */

describe('boundaryBlocks', () => {
  it('turns the named rules on under the plugin and off for exemptions', () => {
    const [on, off] = boundaryBlocks(['src/**/*.ts'], {
      'compare-and-set': 'error',
    });
    assert.deepEqual(on.files, ['src/**/*.ts']);
    assert.deepEqual(on.rules, { 'shuddhi/compare-and-set': 'error' });
    assert.deepEqual(off.rules, { 'shuddhi/compare-and-set': 'off' });
    assert.equal(off.files.length, BOUNDARY_EXEMPT.length);
    assert.deepEqual(Object.keys(on.plugins), ['shuddhi']);
    assert.deepEqual(Object.keys(off.plugins), ['shuddhi']);
  });

  it('mounts the rules under the namespace the caller names', () => {
    const [on, off] = boundaryBlocks(
      ['src/**/*.ts'],
      { 'compare-and-set': ['error', { immutableFields: ['owner'] }] },
      'boundary',
    );
    assert.deepEqual(on.rules, {
      'boundary/compare-and-set': ['error', { immutableFields: ['owner'] }],
    });
    assert.deepEqual(off.rules, { 'boundary/compare-and-set': 'off' });
    assert.deepEqual(Object.keys(on.plugins), ['boundary']);
  });

  it('names the default namespace shuddhi', () => {
    assert.equal(DEFAULT_NAMESPACE, 'shuddhi');
  });

  it('registers one plugin object across blocks and calls', () => {
    const [a, b] = boundaryBlocks(['a/**'], { 'nest-body-dto': 'error' });
    const [c] = boundaryBlocks(['c/**'], { 'compare-and-set': 'error' });
    const plugin = a.plugins.shuddhi;
    assert.equal(plugin.rules, rules);
    assert.equal(b.plugins.shuddhi, plugin);
    assert.equal(c.plugins.shuddhi, plugin);
  });

  it('ANDs each exemption with a code extension', () => {
    const [, off] = boundaryBlocks(['**/*.ts'], {});
    assert.deepEqual(
      off.files,
      BOUNDARY_EXEMPT.map(glob => [
        glob,
        '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
      ]),
    );
  });
});

/** One sample path per exemption glob, matched by that glob alone. */
const EXEMPT_SAMPLES: Record<string, string> = {
  '**/*.test.*': 'src/orders.test.ts',
  '**/*.spec.*': 'src/orders.spec.ts',
  '**/*.perf-test.*': 'src/orders.perf-test.ts',
  '**/*.fixture.*': 'src/orders.fixture.ts',
  '**/__tests__/**': 'src/__tests__/orders.ts',
  '**/__mocks__/**': 'src/__mocks__/orders.ts',
  '**/fixtures/**': 'src/fixtures/orders.ts',
  '**/test/**': 'src/test/orders.ts',
  '**/e2e/**': 'src/e2e/orders.ts',
  '**/prisma/seed*': 'prisma/seed.ts',
  '**/prisma/seeds/**': 'prisma/seeds/orders.ts',
};

describe('boundaryBlocks applied by ESLint', () => {
  const linter = new Linter({ cwd: '/repo' });
  const config = boundaryBlocks(
    ['**/*.ts'],
    {
      'dto-implements-contract': [
        'error',
        { contractsPackage: '@acme/shared' },
      ],
    },
    'boundary',
  );
  const lint = (path: string): string[] =>
    linter
      .verify('export class OrdersDto {}', config, `/repo/${path}`)
      .map(message => String(message.ruleId));

  it('has a sample for every exemption', () => {
    assert.deepEqual(Object.keys(EXEMPT_SAMPLES), BOUNDARY_EXEMPT);
  });

  it('reports on a path no exemption matches', () => {
    assert.deepEqual(lint('src/orders.ts'), [
      'boundary/dto-implements-contract',
    ]);
  });

  for (const [glob, path] of Object.entries(EXEMPT_SAMPLES)) {
    it(`${glob} turns the rule off for ${path}`, () => {
      assert.deepEqual(lint(path), []);
    });
  }

  it('lets two workspaces mount the same namespace in one config', () => {
    const both = [
      ...boundaryBlocks(['a/**/*.ts'], { 'nest-body-dto': 'error' }),
      ...boundaryBlocks(['b/**/*.ts'], {
        'dto-implements-contract': [
          'error',
          { contractsPackage: '@acme/shared' },
        ],
      }),
    ];
    const ids = linter
      .verify('export class OrdersDto {}', both, '/repo/b/orders.ts')
      .map(message => String(message.ruleId));
    assert.deepEqual(ids, ['shuddhi/dto-implements-contract']);
  });
});
