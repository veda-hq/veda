import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COLOCATED_SUITE_SUFFIXES, notTheOwner, ownerOf, siblingSuites, suiteCandidatesFor } from './suite-owner.ts';

test('suffixes are the three colocated shapes, .test.mjs last', () => {
  assert.deepEqual(COLOCATED_SUITE_SUFFIXES, ['.test.ts', '.test.tsx', '.test.mjs']);
});

test('a .ts source prefers .test.ts, a .tsx source .test.tsx, and .test.mjs comes last', () => {
  assert.deepEqual(suiteCandidatesFor('a/foo.ts'), ['a/foo.test.ts', 'a/foo.test.tsx', 'a/foo.test.mjs']);
  assert.deepEqual(suiteCandidatesFor('a/Foo.tsx'), ['a/Foo.test.tsx', 'a/Foo.test.ts', 'a/Foo.test.mjs']);
});

test('a JavaScript source drops its own extension and prefers .test.ts', () => {
  assert.deepEqual(suiteCandidatesFor('scripts/preset.mjs'), [
    'scripts/preset.test.ts',
    'scripts/preset.test.tsx',
    'scripts/preset.test.mjs',
  ]);
});

test('a path with no extension keeps its whole name as the stem', () => {
  assert.deepEqual(suiteCandidatesFor('bin/tool'), ['bin/tool.test.ts', 'bin/tool.test.tsx', 'bin/tool.test.mjs']);
});

test('ownerOf finds the first existing candidate, or null; a qualified suite never owns', () => {
  const on = (...paths: string[]) => (path: string) => paths.includes(path);
  assert.equal(ownerOf('a/foo.ts', on('a/foo.test.tsx')), 'a/foo.test.tsx');
  assert.equal(ownerOf('a/foo.ts', on('a/foo.test.ts', 'a/foo.test.tsx')), 'a/foo.test.ts');
  assert.equal(ownerOf('a/foo.ts', on('a/foo.integration.test.ts')), null);
});

test('an .mjs source is owned by its .test.mjs', () => {
  const on = (...paths: string[]) => (path: string) => paths.includes(path);
  assert.equal(ownerOf('scripts/version-rule.mjs', on('scripts/version-rule.test.mjs')), 'scripts/version-rule.test.mjs');
  assert.equal(ownerOf('scripts/version-rule.mjs', on('scripts/version-rule.integration.test.mjs')), null);
});

test('a .js source with both a .test.ts and a .test.mjs keeps the .test.ts', () => {
  const on = (...paths: string[]) => (path: string) => paths.includes(path);
  assert.equal(ownerOf('src/hermetic-git.js', on('src/hermetic-git.test.mjs', 'src/hermetic-git.test.ts')), 'src/hermetic-git.test.ts');
  assert.equal(ownerOf('src/hermetic-git.js', on('src/hermetic-git.test.mjs')), 'src/hermetic-git.test.mjs');
});

test('no other ending owns: .test.js, .test.mts, .test.cjs and .test.mjsx do not', () => {
  const on = (...paths: string[]) => (path: string) => paths.includes(path);
  const near = ['a/foo.test.js', 'a/foo.test.mts', 'a/foo.test.cjs', 'a/foo.test.mjsx', 'a/foo.test.mj'];
  assert.equal(ownerOf('a/foo.mjs', on(...near)), null);
});

test('siblingSuites: dash and qualified suites beside the source, never one of its candidates or a suite with a source of its own', () => {
  const files = [
    'a/foo.ts',
    'a/foo.test.ts',
    'a/foo.test.tsx',
    'a/foo-cases.test.ts',
    'a/foo-c22.test.tsx',
    'a/foo.integration.test.ts',
    'a/foo-bar.ts',
    'a/foo-bar.test.ts',
    'a/foo-tool.mjs',
    'a/foo-tool.test.ts',
    'a/foo.e2e.ts',
    'a/foo.e2e.test.ts',
    'a/foobar.test.ts',
    'a/b/foo-deep.test.ts',
    'b/foo-cases.test.ts',
    'a/foo-cases.spec.ts',
  ];
  assert.deepEqual(siblingSuites('a/foo.ts', files), ['a/foo-cases.test.ts', 'a/foo-c22.test.tsx', 'a/foo.integration.test.ts']);
  // The stem is literal: a dot in it matches only a dot.
  assert.deepEqual(siblingSuites('a/v1.2.ts', ['a/v1.2-x.test.ts', 'a/v1x2-x.test.ts']), ['a/v1.2-x.test.ts']);
  assert.deepEqual(siblingSuites('a/foo.ts', ['a/foo.ts', 'a/foo.test.ts']), []);
});

test('siblingSuites with .mjs: .test.mjs siblings are named, their own sources and other endings are not', () => {
  const files = [
    'scripts/pins.mjs',
    'scripts/pins.test.mjs',
    'scripts/pins-cases.test.mjs',
    'scripts/pins.e2e.test.mjs',
    'scripts/pins-tool.mjs',
    'scripts/pins-tool.test.mjs',
    'scripts/pins-old.test.mjs.bak',
    'scripts/pins-x.test.js',
    'scripts/pins-y.test.mts',
    'scripts/pins-z.test.mjsx',
  ];
  assert.deepEqual(siblingSuites('scripts/pins.mjs', files), ['scripts/pins-cases.test.mjs', 'scripts/pins.e2e.test.mjs']);
  // A .ts source's .test.mjs sibling is named too; its own .test.mjs is a candidate, so it is not.
  assert.deepEqual(siblingSuites('a/foo.ts', ['a/foo.ts', 'a/foo.test.mjs', 'a/foo-more.test.mjs']), ['a/foo-more.test.mjs']);
});

test('notTheOwner names the siblings, the owner and the source by file name, with what to do', () => {
  assert.equal(
    notTheOwner('a/foo.ts', 'a/foo.test.ts', ['a/foo-cases.test.ts']),
    'foo-cases.test.ts is not the owner, so it did not run; only foo.test.ts kills mutants of foo.ts here: put the tests that should kill them there',
  );
  assert.equal(
    notTheOwner('foo.ts', 'foo.test.ts', ['foo-a.test.ts', 'foo-b.test.ts', 'foo.int.test.ts']),
    'foo-a.test.ts, foo-b.test.ts and foo.int.test.ts are not the owner, so they did not run; only foo.test.ts kills mutants of foo.ts here: put the tests that should kill them there',
  );
});
