/**
 * Config blocks for the server-boundary rules (./index.js): the rules a
 * workspace turns on for its source, and off again for tests, fixtures, mocks
 * and seeds.
 */

import { rules } from './index.js';

/** The namespace the rules are mounted under when the caller names none. */
export const DEFAULT_NAMESPACE = 'shuddhi';

/**
 * One plugin object for every block: ESLint refuses two different objects
 * registered under the same namespace.
 */
const plugin = { rules };

/**
 * Where the boundary rules do not apply: tests, fixtures, mocks and seeds. A
 * test builds malformed DTOs and racy sequences on purpose.
 */
export const BOUNDARY_EXEMPT = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.perf-test.*',
  '**/*.fixture.*',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/fixtures/**',
  '**/test/**',
  '**/e2e/**',
  '**/prisma/seed*',
  '**/prisma/seeds/**',
];

const CODE_FILES = '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}';

/**
 * Config blocks that turn `ruleConfig` on for `files` and off for
 * {@link BOUNDARY_EXEMPT}. `ruleConfig` maps short rule ids
 * (`'compare-and-set'`) to an ESLint rule entry, options included. The rules
 * are registered under `namespace`, so a codebase keeps the rule ids its
 * `eslint-suppressions.json` already counts: legacy hits held there only fall.
 */
export function boundaryBlocks(files, ruleConfig, namespace = DEFAULT_NAMESPACE) {
  const on = Object.fromEntries(
    Object.entries(ruleConfig).map(([id, entry]) => [
      `${namespace}/${id}`,
      entry,
    ]),
  );
  return [
    { files, plugins: { [namespace]: plugin }, rules: on },
    {
      // Each exemption is ANDed with a code extension: a bare `**/test/**`
      // would make ESLint treat every .json and .sh under it as lintable.
      files: BOUNDARY_EXEMPT.map(glob => [glob, CODE_FILES]),
      plugins: { [namespace]: plugin },
      rules: Object.fromEntries(Object.keys(on).map(rule => [rule, 'off'])),
    },
  ];
}
