/**
 * Config blocks for the test-lint rules (`index.js`).
 *
 * NAMESPACES. The rule maps below are exported for the default namespace,
 * `shuddhi` (`shuddhi/no-vacuous-assertion`). A workspace that binds the
 * rules under another namespace (to keep the rule ids its suppressions file
 * already holds) passes that namespace to `testLintBlocks`, or re-keys a map
 * with `withNamespace(TEST_FILE_RULES, namespace)`. The maps stay plain
 * objects, not functions of the namespace, so `{ ...TEST_FILE_RULES }` and
 * `Object.keys(TEST_FILE_RULES)` work as they read.
 *
 * OPTIONS. A rule that names something the workspace owns (a helper module,
 * its real database, its repository layout) takes it as a rule option.
 * `testLintBlocks`'s `ruleOptions` hands those options to every block that
 * turns the rule on: `{ 'hermetic-config': { helperModule: '...' } }` makes
 * that rule's entry `['error', { helperModule: '...' }]`.
 */

import plugin, { C05_CANDIDATE_RULES, rules } from './index.js';

/** The namespace the exported rule maps use. */
export const DEFAULT_NAMESPACE = 'shuddhi';

const id = name => `${DEFAULT_NAMESPACE}/${name}`;

/**
 * Process-hygiene rules for test files and the fixtures they load: a
 * fixture's spawn runs inside the test that loads it, sometimes at
 * collection time.
 */
export const PROCESS_HYGIENE_RULES = {
  [id('spawn-timeout')]: 'error',
  [id('no-raw-group-kill')]: 'error',
};

/** Rules for every test file (TEST-WEAK-03, TEST-STRUCT-02/11, SHELL-09, TEST-WEAK-10). */
export const TEST_FILE_RULES = {
  [id('no-vacuous-assertion')]: 'error',
  [id('fake-timers-restored')]: 'error',
  [id('mock-factory-hoisted')]: 'error',
  [id('no-nested-test-blocks')]: 'error',
  [id('each-title-unique')]: 'error',
  [id('no-collection-time-skip-state')]: 'error',
  [id('no-collection-time-io')]: 'error',
  [id('guarded-marker-slice')]: 'error',
  [id('reset-shared-let')]: 'error',
  [id('no-void-async-iife')]: 'error',
  [id('no-path-line-literal')]: 'error',
  [id('git-spawn-env')]: 'error',
  [id('git-fixture-env')]: 'error',
  [id('no-global-patch')]: 'error',
  [id('no-sql-fake')]: 'error',
  // The c05 rules.
  [id('no-silent-early-return')]: 'error',
  [id('owned-fixture-removal')]: 'error',
  [id('no-copied-production-sql')]: 'error',
  ...Object.fromEntries(C05_CANDIDATE_RULES.map(name => [id(name), 'error'])),
  ...PROCESS_HYGIENE_RULES,
  [id('no-partial-git-mask')]: 'error',
  [id('env-via-stub')]: 'error',
  [id('detached-teardown')]: 'error',
  [id('jsonnull-in-matcher')]: 'error',
};

/** Rules for Nest server tests only. */
export const SERVER_TEST_RULES = {
  [id('hermetic-config')]: 'error',
  [id('e2e-uses-supertest')]: 'error',
};

/**
 * Rules for tooling scripts (SHELL-09): the non-test sources `testLintBlocks`
 * binds to its `scripts` globs.
 */
export const SCRIPT_RULES = {
  [id('no-process-exit')]: 'error',
  [id('cli-entry-helper')]: 'error',
  [id('no-import-meta-dirname-cjs')]: 'error',
};

/** Rules for Detox end-to-end suites (TEST-WEAK-01). */
export const DETOX_RULES = {
  [id('detox-tap-by-id')]: 'error',
};

/**
 * `ruleMap` with each `<from>/<rule>` key re-keyed to `<namespace>/<rule>`,
 * in the same order; any other key is kept as it is.
 *
 * @param {Record<string, unknown>} ruleMap
 * @param {string} namespace
 * @param {string} [from]
 */
export function withNamespace(ruleMap, namespace, from = DEFAULT_NAMESPACE) {
  const prefix = `${from}/`;
  return Object.fromEntries(
    Object.entries(ruleMap).map(([key, value]) => [
      key.startsWith(prefix)
        ? `${namespace}/${key.slice(prefix.length)}`
        : key,
      value,
    ]),
  );
}

const plugins = new Map([[DEFAULT_NAMESPACE, plugin]]);

/**
 * The plugin object bound under `namespace`: one object per namespace for
 * the process, so blocks built by separate calls never redefine it. Its
 * `meta.name` is the namespace.
 *
 * @param {string} namespace
 */
export function pluginFor(namespace) {
  if (!plugins.has(namespace)) {
    plugins.set(namespace, { meta: { name: namespace }, rules });
  }
  return plugins.get(namespace);
}

/**
 * Config blocks binding the test-lint plugin. Globs are relative to the
 * workspace config that calls this. Legacy hits belong in that workspace's
 * `eslint-suppressions.json` (ESLint bulk suppressions): counts only fall.
 *
 * @param {{ tests: string[], support?: string[], server?: boolean, scripts?: string[], detox?: string[] }} scope
 * @param {string} [namespace] the plugin namespace of every rule id (default `shuddhi`)
 * @param {Record<string, Record<string, unknown>>} [ruleOptions] options per
 *   rule name (no namespace), applied wherever that rule is turned on
 * @param {object} [boundPlugin] the plugin object to register under
 *   `namespace` (default: `pluginFor(namespace)`); pass the object a config
 *   already registers under that namespace
 */
export function testLintBlocks(
  { tests, support = [], server = false, scripts = [], detox = [] },
  namespace = DEFAULT_NAMESPACE,
  ruleOptions = {},
  boundPlugin = pluginFor(namespace),
) {
  for (const name of Object.keys(ruleOptions)) {
    if (!Object.hasOwn(rules, name)) {
      throw new TypeError(`testLintBlocks: no test-lint rule named "${name}"`);
    }
  }
  const prefix = `${DEFAULT_NAMESPACE}/`;
  /** One rule map, re-keyed to `namespace`, with its options applied. */
  const bind = ruleMap =>
    Object.fromEntries(
      Object.entries(ruleMap).map(([key, severity]) => {
        const name = key.slice(prefix.length);
        return [
          `${namespace}/${name}`,
          Object.hasOwn(ruleOptions, name)
            ? [severity, ruleOptions[name]]
            : severity,
        ];
      }),
    );
  const plugins = { [namespace]: boundPlugin };
  const blocks = [{ files: tests, plugins, rules: bind(TEST_FILE_RULES) }];
  if (support.length > 0) {
    blocks.push({
      files: support,
      plugins,
      rules: bind({
        [id('no-void-async-iife')]: 'error',
        ...PROCESS_HYGIENE_RULES,
      }),
    });
  }
  if (server) {
    blocks.push({ files: tests, plugins, rules: bind(SERVER_TEST_RULES) });
  }
  if (scripts.length > 0) {
    blocks.push({ files: scripts, plugins, rules: bind(SCRIPT_RULES) });
  }
  if (detox.length > 0) {
    blocks.push({ files: detox, plugins, rules: bind(DETOX_RULES) });
  }
  return blocks;
}
