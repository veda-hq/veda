import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COLOCATED_SUITE_SUFFIXES, notTheOwner, ownerOf, siblingSuites, suiteCandidatesFor } from './suite-owner.ts';

test('suffixes are the two colocated shapes', () => {
  assert.deepEqual(COLOCATED_SUITE_SUFFIXES, ['.test.ts', '.test.tsx']);
});

test('a .ts source prefers .test.ts, a .tsx source .test.tsx', () => {
  assert.deepEqual(suiteCandidatesFor('a/foo.ts'), ['a/foo.test.ts', 'a/foo.test.tsx']);
  assert.deepEqual(suiteCandidatesFor('a/Foo.tsx'), ['a/Foo.test.tsx', 'a/Foo.test.ts']);
});

test('a JavaScript source drops its own extension and prefers .test.ts', () => {
  assert.deepEqual(suiteCandidatesFor('scripts/preset.mjs'), ['scripts/preset.test.ts', 'scripts/preset.test.tsx']);
});

test('a path with no extension keeps its whole name as the stem', () => {
  assert.deepEqual(suiteCandidatesFor('bin/tool'), ['bin/tool.test.ts', 'bin/tool.test.tsx']);
});

test('ownerOf finds the first existing candidate, or null; a qualified suite never owns', () => {
  const on = (...paths: string[]) => (path: string) => paths.includes(path);
  assert.equal(ownerOf('a/foo.ts', on('a/foo.test.tsx')), 'a/foo.test.tsx');
  assert.equal(ownerOf('a/foo.ts', on('a/foo.test.ts', 'a/foo.test.tsx')), 'a/foo.test.ts');
  assert.equal(ownerOf('a/foo.ts', on('a/foo.integration.test.ts')), null);
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

test('notTheOwner names the siblings, the owner and the source by file name, with what to do', () => {
  assert.equal(
    notTheOwner('a/foo.ts', 'a/foo.test.ts', ['a/foo-cases.test.ts']),
    'foo-cases.test.ts is not the owner; only foo.test.ts kills mutants of foo.ts: put the tests that should kill them there',
  );
  assert.equal(
    notTheOwner('foo.ts', 'foo.test.ts', ['foo-a.test.ts', 'foo-b.test.ts', 'foo.int.test.ts']),
    'foo-a.test.ts, foo-b.test.ts and foo.int.test.ts are not the owner; only foo.test.ts kills mutants of foo.ts: put the tests that should kill them there',
  );
});
