import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { FAILED_TESTS_HEADER, failedTestReader, MAX_KEPT, MAX_NAMED, nameTests } from './failed-tests.ts';

/** Stock Stryker 10.1.1's stdout for a dry run with one failing test, coloured as it printed it. */
const REAL = readFileSync(new URL('../test/fixture/stryker-failed-initial-run.txt', import.meta.url), 'utf8');

const read = (text: string): string[] => {
  const reader = failedTestReader();
  text.split('\n').forEach(reader.read);
  return reader.names();
};

test("reads the failing test from Stryker's own output, colours and all", () => {
  assert.ok(REAL.includes(`\u001B[91m`), 'the fixture keeps the colour codes');
  assert.deepEqual(read(REAL), ['the clock is pinned']);
});

test('the header is Stryker 10.1.1 wording', () => {
  assert.equal(FAILED_TESTS_HEADER, 'One or more tests failed in the initial test run:');
  assert.equal(MAX_NAMED, 5);
  assert.equal(MAX_KEPT, 50);
});

test('each name once, in order; failure messages, blank names and lines outside the record are not names', () => {
  const text = [
    '\tnot a name: before the header',
    `09:00:00 (1) ERROR DryRunExecutor ${FAILED_TESTS_HEADER}\r`,
    '\tb fails\r',
    '\t\texpected 1 to be 2',
    'AssertionError: a message on its own line',
    '    at Object.<anonymous> (a.test.ts:3:1)',
    '\t   ',
    '\ta fails',
    '\tb fails',
    '09:00:00 (1) ERROR Stryker There were failed tests in the initial test run.',
    '\tnot a name: after the record',
  ].join('\n');
  assert.deepEqual(read(text), ['b fails', 'a fails']);
});

test('a coloured record ends the list, however many colour codes lead it', () => {
  const reader = failedTestReader();
  for (const line of [
    '\u001B[91m09:00:00 (4242) ERROR DryRunExecutor\u001B[39m One or more tests failed in the initial test run:',
    '\ta fails',
    '\u001B[1m\u001B[91m09:00:01 (4242) ERROR Stryker\u001B[39m There were failed tests in the initial test run.',
    '\tnot a name: after the record',
  ]) {
    reader.read(line);
  }
  assert.deepEqual(reader.names(), ['a fails']);
});

test('a record ends only at a line that starts with a log prefix, any pid long', () => {
  const reader = failedTestReader();
  for (const line of [
    'One or more tests failed in the initial test run:',
    '\tat 09:00:00 (1) ERROR, a name that mentions a log line',
    '09:00:00 (12345) INFO Stryker the record ends',
    '\tnot a name',
  ]) {
    reader.read(line);
  }
  assert.deepEqual(reader.names(), ['at 09:00:00 (1) ERROR, a name that mentions a log line']);
});

test('only a trailing carriage return is dropped, and a name is one line', () => {
  const reader = failedTestReader();
  for (const line of ['One or more tests failed in the initial test run:', '\ta\rb', '\tc d', '\te fails\r']) reader.read(line);
  assert.deepEqual(reader.names(), ['e fails']);
});

test('a header seen again reads on; at most MAX_KEPT names are kept', () => {
  const again = [FAILED_TESTS_HEADER, '\tfirst', `09:00:00 (1) ERROR DryRunExecutor ${FAILED_TESTS_HEADER}`, '\tsecond', '\tfirst'].join('\n');
  assert.deepEqual(read(again), ['first', 'second'], 'a second record adds its names; a name seen in both is kept once');
  const many = [FAILED_TESTS_HEADER, ...Array.from({ length: MAX_KEPT + 5 }, (_, i) => `\tt${i}`)].join('\n');
  const names = read(many);
  assert.equal(names.length, MAX_KEPT);
  assert.equal(names.at(-1), `t${MAX_KEPT - 1}`);
  const reader = failedTestReader();
  reader.read(FAILED_TESTS_HEADER);
  reader.names().push('outside');
  assert.deepEqual(reader.names(), [], 'names() hands out a copy');
});

test('nameTests quotes, joins, and counts what it leaves out', () => {
  assert.equal(nameTests([]), '');
  assert.equal(nameTests(['a']), '"a"');
  assert.equal(nameTests(['a', 'b']), '"a" and "b"');
  assert.equal(nameTests(['a', 'b', 'c']), '"a", "b" and "c"');
  assert.equal(nameTests(['1', '2', '3', '4', '5']), '"1", "2", "3", "4" and "5"');
  assert.equal(nameTests(['1', '2', '3', '4', '5', '6', '7']), '"1", "2", "3", "4", "5" and 2 more');
});
