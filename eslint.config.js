// veda lints its own code with the released shuddhi the root pins, never
// packages/eslint-plugin-shuddhi, the copy a change edits (T-9).
import { errorHandlingBlocks } from '@veda-hq/eslint-plugin-shuddhi/error-handling/configs';
import tseslint from 'typescript-eslint';

const CODE = ['packages/*/src/**/*.{ts,js,mjs}', 'packages/*/hooks/**/*.{ts,js,mjs}', 'scripts/*.mjs'];

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'packages/*/corpus/**', 'packages/*/test/fixture/**', '.claude/worktrees/**'] },
  { files: ['**/*.{ts,tsx,mts,cts}'], languageOptions: { parser: tseslint.parser } },
  ...errorHandlingBlocks(CODE),
  // Off until veda has the helpers these rules point at: errorDetail
  // (no-raw-error-string), safeLog and safeInvoke (safe-log), and runChild
  // (no-direct-child-process). Without them, new code has no compliant form.
  {
    files: CODE,
    rules: {
      'shuddhi/no-raw-error-string': 'off',
      'shuddhi/safe-log': 'off',
      'shuddhi/no-direct-child-process': 'off',
    },
  },
  // agnipariksha doesn't count Ignored mutants, so a `// Stryker disable`
  // comment would take its file's mutants out of the gate (#326). The rule
  // refuses the comment. noInlineConfig refuses every way a comment could
  // turn the rule off again (`eslint-disable…`, `/* eslint rule: off */`):
  // an exception goes here or in eslint-suppressions.json, both code-owner
  // paths.
  {
    files: CODE,
    linterOptions: { noInlineConfig: true },
    rules: {
      'no-warning-comments': ['error', { terms: ['stryker disable'], location: 'start' }],
    },
  },
];
