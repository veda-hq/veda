/**
 * Stryker sandbox exclusions: the trees a mutation sandbox never needs.
 *
 * A consumer's `stryker.config.mjs` starts its `ignorePatterns` from
 * `MUTATION_IGNORE_PATTERNS` and adds its own:
 *
 *     import { MUTATION_IGNORE_PATTERNS } from '@veda-hq/agnipariksha/sandbox-ignore';
 *     export default { ignorePatterns: [...MUTATION_IGNORE_PATTERNS, 'my-cache'] };
 *
 * WHY IT MATTERS. Stryker copies the working tree into a sandbox before it
 * runs a single mutant, and that copy is where a run's time and disk go first.
 * The tracked tree is usually small; the working tree is not. Build output,
 * installed dependencies and the native trees of a mobile app (`ios`,
 * `android`) can be gigabytes, and none of it is a source Stryker mutates or a
 * test it runs. Leaving one of these out of the list turns a small copy into
 * a multi-gigabyte one.
 *
 * ONE COPY PER RUN, NOT PER WORKER. Stryker 10.1.1 provides the sandbox once
 * (`core/dist/src/process/2-mutant-instrumenter-executor.js`) and builds every
 * test runner on its `sandbox.workingDirectory`
 * (`core/dist/src/test-runner/index.js`). Raising `concurrency` adds runner
 * processes and their memory, not copies of the tree.
 *
 * The list holds exclusions only. How a run is judged is agnipariksha's gate,
 * not a setting a consumer imports from here.
 *
 * Each list is frozen: a consumer spreads it into its own array and cannot
 * change the shared one in place.
 */

/**
 * Build output, coverage, installed dependencies and native mobile trees.
 * @type {readonly string[]}
 */
export const RECOVERED_IGNORE_PATTERNS = Object.freeze([
  'dist',
  'build',
  'coverage',
  'node_modules',
  '.next',
  'ios',
  'android',
]);

/**
 * Stryker's own temp folder, generated reports, and scratch files.
 * @type {readonly string[]}
 */
export const SANDBOX_IGNORE_PATTERNS = Object.freeze([
  '.stryker-tmp',
  'reports',
  '.tmp',
]);

/**
 * The full list a consumer's `ignorePatterns` starts from: both lists, in order.
 * @type {readonly string[]}
 */
export const MUTATION_IGNORE_PATTERNS = Object.freeze([
  ...RECOVERED_IGNORE_PATTERNS,
  ...SANDBOX_IGNORE_PATTERNS,
]);
