// veda lints its own code with the released shuddhi the root pins, never
// packages/eslint-plugin-shuddhi, the copy a change edits (T-9).
import { errorHandlingBlocks } from '@veda-hq/eslint-plugin-shuddhi/error-handling/configs';
import tseslint from 'typescript-eslint';

const CODE = ['packages/*/src/**/*.{ts,js,mjs}', 'packages/*/hooks/**/*.{ts,js,mjs}', 'scripts/*.mjs'];

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'packages/*/corpus/**', 'packages/*/test/fixture/**'] },
  { files: ['**/*.{ts,tsx,mts,cts}'], languageOptions: { parser: tseslint.parser } },
  ...errorHandlingBlocks(CODE),
];
