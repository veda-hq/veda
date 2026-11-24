import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatBlocking, judge, readMutants, type Mutant } from './verdict.ts';

const stryker = (status: string, line = 3) => ({
  id: String(line),
  mutatorName: 'StringLiteral',
  replacement: '""',
  status,
  location: { start: { line, column: 5 }, end: { line, column: 9 } },
});

const mutant =(status: string, over: Partial<Mutant> = {}): Mutant => ({
  file: 'apps/web/src/a.ts',
  status,
  mutator: 'StringLiteral',
  replacement: '""',
  line: 3,
  column: 5,
  endLine: 3,
  endColumn: 9,
  ...over,
});

test('readMutants maps a report to repo-relative mutants', () => {
  const raw = { files: { 'src/a.ts': { mutants: [stryker('Survived')] }, 'apps/web/src/b.ts': { mutants: [] } } };
  assert.deepEqual(readMutants(raw, 'apps/web'), [mutant('Survived')]);
  assert.equal((readMutants({ files: { 'scripts/x.ts': { mutants: [stryker('Killed')] } } }, '') as Mutant[])[0]?.file, 'scripts/x.ts');
});

test('readMutants tolerates a mutant without fields, as NaN locations and "undefined" status', () => {
  const [m] = readMutants({ files: { 'a.ts': { mutants: [null, { location: { start: 1 } }] } } }, '') as Mutant[];
  assert.equal(m?.status, 'undefined');
  assert.ok(Number.isNaN(m?.line));
});

test('readMutants says what a report without files lacks', () => {
  assert.equal(readMutants({}, ''), 'the report has no `files`');
});

test('readMutants prefixes a workspace path only where the report left it out', () => {
  const at = (path: string): string | undefined =>
    (readMutants({ files: { [path]: { mutants: [{ status: 'Killed' }] } } }, 'apps/web') as Mutant[])[0]?.file;
  assert.equal(at('apps/web/src/b.ts'), 'apps/web/src/b.ts');
  assert.equal(at('src/apps/web/'), 'apps/web/src/apps/web/');
});

test('readMutants refuses a report without files or mutant lists', () => {
  assert.equal(typeof readMutants(null, ''), 'string');
  assert.equal(typeof readMutants({ files: null }, ''), 'string');
  assert.match(readMutants({ files: { 'a.ts': { mutants: 1 } } }, '') as string, /a\.ts/);
  assert.match(readMutants({ files: { 'a.ts': 3 } }, '') as string, /a\.ts/);
});

test('Survived and NoCoverage block; Killed, RuntimeError, CompileError and a twice-timed-out mutant are caught; Ignored is not counted', () => {
  const j = judge(['Survived', 'NoCoverage', 'Killed', 'RuntimeError', 'CompileError', 'Timeout', 'Ignored', 'Killed'].map((s) => mutant(s)));
  assert.deepEqual(j.blocking.map((m) => m.status), ['Survived', 'NoCoverage']);
  assert.equal(j.counted, 7);
  assert.equal(j.caught, 5);
  assert.deepEqual(j.byStatus, { Survived: 1, NoCoverage: 1, Killed: 2, RuntimeError: 1, CompileError: 1, Timeout: 1 });
  assert.deepEqual(j.unknown, []);
});

test('an unknown status is named, never guessed', () => {
  const j = judge([mutant('Pending')]);
  assert.deepEqual(j.unknown, ['Pending apps/web/src/a.ts:3']);
  assert.equal(j.counted, 0);
});

test('a blocking line reads <status> <path>:<line> (<mutator>)', () => {
  assert.equal(formatBlocking(mutant('Survived')), 'Survived apps/web/src/a.ts:3 (StringLiteral)');
});
