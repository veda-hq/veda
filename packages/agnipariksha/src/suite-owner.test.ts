import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COLOCATED_SUITE_SUFFIXES, ownerOf, suiteCandidatesFor } from './suite-owner.ts';

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
