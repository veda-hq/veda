import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { RuleTester } from '@typescript-eslint/rule-tester';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { packageTypeLookup } from './import-meta-cjs.js';
import plugin, { rules } from './index.js';

/**
 * SHELL-09 (no-import-meta-dirname-cjs): the cases for `import-meta-cjs.js`,
 * the module this suite owns.
 *
 * The package layouts are built in a temporary directory, since a fixture
 * under this package would sit inside its own `"type": "module"` package.
 * Each `invalid` case is the lesson's shape, reduced: `import.meta.dirname`
 * in a script tsx runs as CommonJS. Each `valid` case is the corrected code
 * or a near miss.
 */

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

/** The package layouts: each directory, and its package.json if it has one. */
const root = mkdtempSync(join(tmpdir(), 'shuddhi-import-meta-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});
const LAYOUT: Record<string, string | null> = {
  esm: '{ "name": "esm", "type": "module" }',
  'esm/inner-cjs': '{ "name": "inner", "type": "commonjs" }',
  cjs: '{ "name": "cjs" }',
  'cjs/inner-esm': '{ "type": "module" }',
  'cjs/scripts/deep': null,
  broken: '{ "type": "module",',
};
for (const [dir, manifest] of Object.entries(LAYOUT)) {
  mkdirSync(join(root, dir), { recursive: true });
  if (manifest !== null) writeFileSync(join(root, dir, 'package.json'), manifest);
}
// A package.json that exists but cannot be read as a file.
mkdirSync(join(root, 'unreadable/package.json'), { recursive: true });

const file = (path: string) => join(root, path);
const DIRNAME = `import { resolve } from 'node:path';
const schema = resolve(import.meta.dirname, '../schema.prisma');`;
const CORRECTED = `import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const schema = resolve(dirname(fileURLToPath(import.meta.url)), '../schema.prisma');`;

const cjsPackage = (property: string, replacement: string) => ({
  messageId: 'cjsPackage',
  data: { property, replacement },
});
const cjsFile = (property: string, extension: string, replacement: string) => ({
  messageId: 'cjsFile',
  data: { property, extension, replacement },
});

ruleTester.run(
  'no-import-meta-dirname-cjs',
  rules['no-import-meta-dirname-cjs']!,
  {
    valid: [
      // An ESM package: import.meta.dirname exists.
      { filename: file('esm/scripts/build.ts'), code: DIRNAME },
      // Corrected: import.meta.url, which tsx defines under CJS.
      { filename: file('cjs/scripts/build.ts'), code: CORRECTED },
      // .mts and .mjs always run as ESM, whatever the package says.
      { filename: file('cjs/scripts/build.mts'), code: DIRNAME },
      { filename: file('cjs/scripts/build.mjs'), code: DIRNAME },
      // Test files: Vitest runs them as ESM.
      { filename: file('cjs/scripts/build.test.ts'), code: DIRNAME },
      { filename: file('cjs/scripts/build.spec.cts'), code: DIRNAME },
      // Nearest wins: an ESM package nested in a CJS one.
      { filename: file('cjs/inner-esm/run.ts'), code: DIRNAME },
      // A package.json that cannot be parsed, or read: the format is unknown.
      { filename: file('broken/run.ts'), code: DIRNAME },
      { filename: file('unreadable/run.ts'), code: DIRNAME },
      // Other files are not JavaScript the rule knows the format of.
      { filename: file('cjs/scripts/build.jsx'), code: DIRNAME },
      // Other import.meta properties, other meta properties, and shapes
      // that read no property.
      {
        filename: file('cjs/scripts/build.ts'),
        code: `const env = import.meta.env;
        const at = import.meta[key];
        const name = import.meta['url'];
        function F() { return new.target; }
        const { url, [key]: other, 'env': quoted, ...rest } = import.meta;
        let meta; meta = import.meta;
        log(import.meta);
        const [first] = import.meta;`,
      },
    ],
    invalid: [
      // The lesson: a script in a package with no "type": "module".
      {
        filename: file('cjs/scripts/build.ts'),
        code: DIRNAME,
        errors: [
          cjsPackage('dirname', 'dirname(fileURLToPath(import.meta.url))'),
        ],
      },
      // import.meta.filename, a .tsx and a .js file, a computed string key,
      // a type-only wrapper, a destructuring.
      {
        filename: file('cjs/scripts/deep/run.tsx'),
        code: `const self = import.meta.filename;
        const here = (import.meta as { dirname: string })['dirname'];
        const { dirname, filename: me } = import.meta;
        const { 'dirname': quoted } = import.meta;`,
        errors: [
          cjsPackage('filename', 'fileURLToPath(import.meta.url)'),
          cjsPackage('dirname', 'dirname(fileURLToPath(import.meta.url))'),
          cjsPackage('dirname', 'dirname(fileURLToPath(import.meta.url))'),
          cjsPackage('filename', 'fileURLToPath(import.meta.url)'),
          cjsPackage('dirname', 'dirname(fileURLToPath(import.meta.url))'),
        ],
      },
      {
        filename: file('cjs/scripts/build.js'),
        code: DIRNAME,
        errors: [{ messageId: 'cjsPackage' }],
      },
      // Nearest wins: a CJS package nested in an ESM one.
      {
        filename: file('esm/inner-cjs/run.ts'),
        code: DIRNAME,
        errors: [{ messageId: 'cjsPackage' }],
      },
      // .cts and .cjs always run as CJS, even in an ESM package; tsx defines
      // not even import.meta.url there.
      {
        filename: file('esm/scripts/build.cts'),
        code: `${DIRNAME}
        const self = import.meta.filename;`,
        errors: [
          cjsFile('dirname', '.cts', '__dirname'),
          cjsFile('filename', '.cts', '__filename'),
        ],
      },
      {
        filename: file('esm/scripts/build.cjs'),
        code: DIRNAME,
        errors: [cjsFile('dirname', '.cjs', '__dirname')],
      },
    ],
  },
);

// ---------------------------------------------------------------------------
// The package.json lookup
// ---------------------------------------------------------------------------

/** A lookup over in-memory files, counting the reads it makes. */
function memoryLookup(files: Record<string, string | undefined>) {
  const reads: string[] = [];
  const typeOf = packageTypeLookup((path: string) => {
    reads.push(path);
    return Object.hasOwn(files, path) ? files[path] : null;
  });
  return { typeOf, reads };
}

describe('packageTypeLookup', () => {
  it('reads a missing package.json as CommonJS, Node default', () => {
    const { typeOf, reads } = memoryLookup({});
    assert.equal(typeOf('/nowhere/scripts'), 'commonjs');
    assert.deepEqual(reads, [
      '/nowhere/scripts/package.json',
      '/nowhere/package.json',
      '/package.json',
    ]);
  });

  it('takes the nearest package.json, and only its type', () => {
    const { typeOf } = memoryLookup({
      '/repo/package.json': '{ "type": "module" }',
      '/repo/tools/package.json': '{ "name": "tools" }',
      '/repo/tools/esm/package.json': '{ "type": "module" }',
      '/repo/null/package.json': 'null',
    });
    assert.equal(typeOf('/repo/src'), 'module');
    assert.equal(typeOf('/repo/tools/bin'), 'commonjs');
    assert.equal(typeOf('/repo/tools/esm'), 'module');
    assert.equal(typeOf('/repo/null'), 'commonjs');
  });

  it('leaves the format unknown when the nearest one cannot be read or parsed', () => {
    const { typeOf } = memoryLookup({
      '/a/package.json': undefined,
      '/b/package.json': '{',
    });
    assert.equal(typeOf('/a/x'), 'unknown');
    assert.equal(typeOf('/b'), 'unknown');
  });

  it('looks each directory up once', () => {
    const { typeOf, reads } = memoryLookup({
      '/repo/package.json': '{ "type": "module" }',
    });
    assert.equal(typeOf('/repo/a/b'), 'module');
    const first = reads.length;
    assert.equal(typeOf('/repo/a/b'), 'module');
    assert.equal(typeOf('/repo/a'), 'module');
    assert.equal(typeOf('/repo'), 'module');
    assert.equal(reads.length, first);
    assert.equal(typeOf('/repo/a/c'), 'module');
    assert.deepEqual(reads.slice(first), ['/repo/a/c/package.json']);
  });
});

// ---------------------------------------------------------------------------
// ESLint's own filenames, and guard removal
// ---------------------------------------------------------------------------

/** The rule's messages under ESLint run from `root`, the layouts' parent. */
function messageIds(code: string, filename?: string): string[] {
  return new Linter({ configType: 'flat', cwd: root })
    .verify(
      code,
      [
        {
          files: ['**/*.ts', '**/*'],
          languageOptions: { parser: tseslint.parser },
          plugins: { shuddhi: plugin },
          rules: { 'shuddhi/no-import-meta-dirname-cjs': 'error' },
        },
      ],
      filename,
    )
    .map(message => message.messageId ?? message.message);
}

describe('no-import-meta-dirname-cjs on ESLint filenames', () => {
  it('skips a file with no path on disk', () => {
    assert.deepEqual(messageIds(DIRNAME), []);
  });

  it('resolves a relative filename against the working directory', () => {
    assert.deepEqual(messageIds(DIRNAME, 'cjs/scripts/build.ts'), [
      'cjsPackage',
    ]);
  });

  it('flips when the guard is removed from the corrected case', () => {
    const filename = file('cjs/scripts/build.ts');
    assert.deepEqual(messageIds(CORRECTED, filename), []);
    const broken = CORRECTED.replace(
      'dirname(fileURLToPath(import.meta.url))',
      'import.meta.dirname',
    );
    assert.notEqual(broken, CORRECTED);
    assert.deepEqual(messageIds(broken, filename), ['cjsPackage']);
  });
});

describe('no-import-meta-dirname-cjs rule metadata', () => {
  it('states the rule, its catalogue id and its messages verbatim', () => {
    assert.deepEqual(rules['no-import-meta-dirname-cjs']?.meta, {
      type: 'problem',
      docs: {
        description:
          'import.meta.dirname and import.meta.filename in a file that tsx runs as CommonJS, where they are undefined (SHELL-09)',
      },
      schema: [],
      messages: {
        cjsPackage:
          'import.meta.{{property}} is undefined when this file runs as CommonJS (its nearest package.json, if any, has no "type": "module"; tsx runs it as CJS and defines only import.meta.url there). Use {{replacement}}.',
        cjsFile:
          'import.meta.{{property}} is undefined in a {{extension}} file, which always runs as CommonJS (tsx defines not even import.meta.url there). Use {{replacement}}.',
      },
    });
  });
});
