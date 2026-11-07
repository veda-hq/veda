/**
 * Flat-config blocks for the error-handling rules (catalogue ERR-01, ERR-02
 * with OBS-03, ERR-03, ERR-08).
 *
 * The rule ids need the plugin bound under a namespace, so a workspace takes
 * them through {@link errorHandlingBlocks} rather than a bare spread. The
 * namespace defaults to `shuddhi`; a project that already has these rules
 * under another namespace (and suppressions recorded against those ids)
 * passes its own.
 */

import { rules } from './index.js';

/**
 * The plugin object bound when the caller passes none. One module-level
 * object, so calling the helpers twice binds the same plugin: flat config
 * refuses two different objects under one namespace.
 */
const familyPlugin = { rules };

/**
 * @typedef {object} ErrorHandlingOptions
 * @property {string} [namespace] Plugin namespace the rule ids use. Default `shuddhi`.
 * @property {string} [helperModule] Module named in the safe-log and
 *   no-raw-error-string messages as the home of `safeLog`, `safeInvoke` and
 *   `errorDetail`.
 * @property {string} [helperSourcePattern] Regular expression over import
 *   specifiers: an import of `safeLog`/`safeInvoke` from a matching module is
 *   the real wrapper (safe-log).
 * @property {string} [runChildPath] The one file allowed to use the async
 *   child_process APIs (the runner itself), as a path from `root`; also named
 *   in the no-direct-child-process message.
 * @property {string} [root] Directory `runChildPath` is relative to. Defaults
 *   to ESLint's working directory.
 */

/** `'error'`, or `['error', options]` when any option was given. */
function entry(options) {
  const given = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  );
  return Object.keys(given).length > 0 ? ['error', given] : 'error';
}

/**
 * The error-handling rules as a rules object.
 *
 * @param {ErrorHandlingOptions} [options]
 */
export function errorHandling({
  namespace = 'shuddhi',
  helperModule,
  helperSourcePattern,
  runChildPath,
  root,
} = {}) {
  return {
    // ERR-01. A catch that neither rethrows nor rejects needs
    // `// fail-open: <reason>`; `no-empty` only ever saw empty blocks.
    [`${namespace}/no-swallowed-catch`]: 'error',
    // ERR-02 and OBS-03, one rule: injected loggers, and console on a catch
    // path, go through safeLog/safeInvoke.
    [`${namespace}/safe-log`]: entry({ helperModule, helperSourcePattern }),
    // ERR-03. A caught value becomes text only through errorDetail().
    [`${namespace}/no-raw-error-string`]: entry({ helperModule }),
    // ERR-08. Async child processes only through the runner.
    [`${namespace}/no-direct-child-process`]: entry({
      allow: runChildPath === undefined ? undefined : [runChildPath],
      runner: runChildPath,
      root,
    }),
  };
}

/**
 * Where the error-handling rules do not apply: tests, fixtures and mocks.
 * A test's catch that captures an error to assert on it is the point of the
 * test, and a test harness's direct spawn is not shipped tooling. Globs are
 * relative to whichever workspace config uses them.
 */
const CODE_FILES = '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}';

export const ERROR_HANDLING_EXEMPT = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.perf-test.*',
  '**/*.fixture.*',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/fixtures/**',
  '**/test/**',
  '**/e2e/**',
];

/**
 * Config blocks that turn the error-handling rules on for `files` and off for
 * {@link ERROR_HANDLING_EXEMPT}. Legacy hits are best held in the workspace's
 * `eslint-suppressions.json` (ESLint bulk suppressions): counts only fall.
 *
 * @param {import('eslint').Linter.Config['files']} files
 * @param {ErrorHandlingOptions & { plugin?: import('eslint').ESLint.Plugin }} [options]
 *   `plugin` is the object bound under `namespace`; pass the one your config
 *   already binds there, if any. Defaults to a plugin of this family's rules.
 */
export function errorHandlingBlocks(files, options = {}) {
  const { plugin = familyPlugin, namespace = 'shuddhi', ...rest } = options;
  const ruleSet = errorHandling({ namespace, ...rest });
  return [
    { files, plugins: { [namespace]: plugin }, rules: ruleSet },
    {
      // Each exemption is ANDed with a code extension (a nested array is an
      // intersection in flat config). A bare `**/test/**` or `**/*.test.*`
      // here would make ESLint lint every .sh and .json under those paths,
      // since any `files` match marks a file as lintable.
      files: ERROR_HANDLING_EXEMPT.map(glob => [glob, CODE_FILES]),
      plugins: { [namespace]: plugin },
      rules: Object.fromEntries(
        Object.keys(ruleSet).map(rule => [rule, 'off']),
      ),
    },
  ];
}
