/**
 * Flat-config blocks for the input-parsing rules.
 *
 * The plugin is bound under a caller-chosen namespace (default `shuddhi`), so
 * a project that already registered these rules under another name keeps its
 * rule ids and its eslint-suppressions.json unchanged.
 */

// ./index.js imports this module too; `plugin` is read only when a function
// below runs, by which time both modules have evaluated.
import plugin from './index.js';

/**
 * Test and fixture code is exempt: tests build argv arrays, set env vars and
 * parse their own JSON snapshots on purpose. Broad on purpose — workspaces
 * spell their test trees differently (`__tests__`, `test/`, `e2e/`).
 */
export const TEST_FILE_GLOBS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/test/**',
  '**/tests/**',
  '**/e2e/**',
  '**/fixtures/**',
  '**/*.fixture.*',
];

/** Refuse options for a rule this plugin does not have (a typo would be silent). */
function checkRuleOptions(ruleOptions) {
  for (const name of Object.keys(ruleOptions)) {
    if (!Object.hasOwn(plugin.rules, name)) {
      throw new Error(`input-parsing: no rule named "${name}"`);
    }
  }
}

/**
 * Rule severities: every rule blocks; legacy hits live in suppressions.
 *
 * @param {string} [namespace] the plugin name the rules are bound under
 * @param {Record<string, object>} [ruleOptions] options per rule name (for
 *   example `{ 'strict-scalar-parse': { pageReaders: [...], hints: {...} } }`);
 *   a rule without an entry runs on its defaults
 */
export function inputParsingRules(namespace = 'shuddhi', ruleOptions = {}) {
  checkRuleOptions(ruleOptions);
  return Object.fromEntries(
    Object.keys(plugin.rules).map(name => [
      `${namespace}/${name}`,
      Object.hasOwn(ruleOptions, name)
        ? ['error', ruleOptions[name]]
        : 'error',
    ]),
  );
}

/**
 * Flat-config blocks for one workspace.
 *
 * @param {object} options
 * @param {string[]} options.files       globs the rules apply to
 * @param {string[]} [options.envModules] env-schema modules that may read
 *   `process.env.X` directly (a bundler inlines only literal reads), still
 *   held to the coercion / `??` / presence checks
 * @param {string[]} [options.ignores]   extra non-test exemptions
 * @param {string[]} [options.typedFiles] files linted WITH type information;
 *   VAL-09 also turns on `@typescript-eslint/no-unsafe-member-access` there,
 *   so a raw parsed value cannot be read field by field
 * @param {string} [options.namespace]  the plugin name the rules are bound
 *   under (default `shuddhi`)
 * @param {Record<string, object>} [options.ruleOptions] options per rule
 *   name, applied in every block that turns the rule on
 */
export function inputParsingConfigs({
  files,
  envModules = [],
  ignores = [],
  typedFiles = [],
  namespace = 'shuddhi',
  ruleOptions = {},
}) {
  const exempt = [...TEST_FILE_GLOBS, ...ignores];
  const blocks = [
    {
      files,
      ignores: exempt,
      plugins: { [namespace]: plugin },
      rules: inputParsingRules(namespace, ruleOptions),
    },
  ];
  if (envModules.length > 0) {
    // Same exemptions and plugin binding: a test file inside an env-module
    // glob would otherwise reach a rule whose plugin is not bound for it.
    blocks.push({
      files: envModules,
      ignores: exempt,
      plugins: { [namespace]: plugin },
      rules: {
        [`${namespace}/env-through-schema`]: [
          'error',
          { ...ruleOptions['env-through-schema'], allowDirectRead: true },
        ],
      },
    });
  }
  if (typedFiles.length > 0) {
    blocks.push({
      files: typedFiles,
      ignores: exempt,
      rules: { '@typescript-eslint/no-unsafe-member-access': 'error' },
    });
  }
  return blocks;
}
