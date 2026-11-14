import assert from 'node:assert/strict';
import { test } from 'node:test';

import { changedFiles, commentOnly } from './changed-files.ts';

function fakeGit(outputs: Record<string, string>) {
  const calls: string[][] = [];
  const git = (args: string[]): string => {
    calls.push(args);
    return outputs[args[0] as string] ?? '';
  };
  return { git, calls };
}

test('changed files: merge-base to working tree, deletions out, untracked in, deduplicated', () => {
  const { git, calls } = fakeGit({ 'merge-base': 'abc123\n', diff: 'a.ts\0b.ts\0', 'ls-files': 'b.ts\0new.ts\0' });
  const changes = changedFiles(git, 'origin/main');
  assert.equal(changes.base, 'abc123');
  assert.deepEqual(changes.files, ['a.ts', 'b.ts', 'new.ts']);
  assert.deepEqual([...changes.alwaysJudged], ['b.ts', 'new.ts']);
  assert.deepEqual(calls, [
    ['merge-base', 'origin/main', 'HEAD'],
    ['diff', '--name-only', '-z', '--diff-filter=d', 'abc123'],
    ['ls-files', '-z', '--others', '--exclude-standard'],
  ]);
});

test('tracked only: untracked files are not listed, nor asked for', () => {
  const { git, calls } = fakeGit({ 'merge-base': 'abc123\n', diff: 'a.ts\0', 'ls-files': 'new.ts\0' });
  const changes = changedFiles(git, 'origin/main', undefined, true);
  assert.deepEqual(changes.files, ['a.ts']);
  assert.deepEqual([...changes.alwaysJudged], []);
  assert.equal(calls.some((args) => args[0] === 'ls-files'), false);
});

test('a --base override is resolved to its merge-base with HEAD', () => {
  const { git, calls } = fakeGit({ 'merge-base': 'feed\n' });
  const changes = changedFiles(git, 'origin/main', 'some-ref');
  assert.equal(changes.base, 'feed');
  assert.deepEqual(changes.files, []);
  assert.deepEqual(calls[0], ['merge-base', 'some-ref', 'HEAD']);
});

const diff = (...body: string[]): string => ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', ...body, ''].join('\n');

test('comment-only: line comments, block comments and blank lines', () => {
  assert.equal(commentOnly(diff('@@ -1 +1 @@', '-// old', '+// new', '+', '+  /* a', '+   * b', '+   */')), true);
  assert.equal(commentOnly(diff('@@ -3,0 +4 @@', '+   ', '\\ No newline at end of file')), true);
});

test('any code line judges the file', () => {
  assert.equal(commentOnly(diff('@@ -1 +1 @@', '-// old', '+const a = 1; // new')), false);
  assert.equal(commentOnly(diff('@@ -1 +1 @@', '-return x;')), false);
});

test('a removed line that reads like a header is still a line', () => {
  assert.equal(commentOnly(diff('@@ -1 +0,0 @@', '--- x')), false);
});

test('an empty diff is not comment-only', () => {
  assert.equal(commentOnly(''), false);
  assert.equal(commentOnly('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n'), false);
});
