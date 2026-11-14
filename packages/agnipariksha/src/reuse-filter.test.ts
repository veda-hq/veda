import assert from 'node:assert/strict';
import { test } from 'node:test';

import { forReuse, pruneToTargets, REUSED_STATUSES, reusable, STATIC_RERUN_STATUSES, stripRange } from './reuse-filter.ts';

test("today's lists", () => {
  assert.deepEqual(REUSED_STATUSES, ['Killed', 'Survived', 'NoCoverage', 'CompileError', 'Ignored']);
  assert.deepEqual(STATIC_RERUN_STATUSES, ['Survived', 'NoCoverage']);
});

test('reusable: decided results stay; timeouts, errors, statics that survived and unknowns run again', () => {
  for (const status of REUSED_STATUSES) assert.equal(reusable({ status }), true, status);
  for (const status of ['Timeout', 'RuntimeError', 'Pending', 'Novel']) assert.equal(reusable({ status }), false, status);
  assert.equal(reusable({}), false);
  assert.equal(reusable({ status: 'Survived', static: true }), false);
  assert.equal(reusable({ status: 'NoCoverage', static: true }), false);
  assert.equal(reusable({ status: 'Killed', static: true }), true);
});

test('forReuse keeps only reusable results and the rest of the file', () => {
  const text = JSON.stringify({
    schemaVersion: '2',
    files: { 'src/a.ts': { source: 'x', mutants: [{ id: '1', status: 'Killed' }, { id: '2', status: 'Timeout' }] } },
  });
  assert.deepEqual(JSON.parse(forReuse(text) ?? ''), {
    schemaVersion: '2',
    files: { 'src/a.ts': { source: 'x', mutants: [{ id: '1', status: 'Killed' }] } },
  });
});

test('forReuse refuses anything Stryker could not have written', () => {
  assert.equal(forReuse('{'), null);
  assert.equal(forReuse('[]'), null);
  assert.equal(forReuse('{"files":[]}'), null);
  assert.equal(forReuse('{"files":{"a":{"mutants":{}}}}'), null);
  assert.equal(forReuse('{"files":{"a":null}}'), null);
});

test('stripRange removes a mutation range only', () => {
  assert.equal(stripRange('src/a.ts:3:4-5:6'), 'src/a.ts');
  assert.equal(stripRange('src/a.ts:3-5'), 'src/a.ts');
  assert.equal(stripRange('src/a.ts'), 'src/a.ts');
});

test('pruneToTargets keeps only the targets, with or without the workspace prefix', () => {
  const raw = { files: { 'src/a.ts': {}, 'apps/web/src/b.ts': {}, 'src/old.ts': {} } };
  assert.deepEqual(pruneToTargets(raw, 'apps/web', ['src/a.ts', 'src/b.ts:1:0-2:3']), {
    files: { 'src/a.ts': {}, 'apps/web/src/b.ts': {} },
  });
  assert.deepEqual(pruneToTargets(raw, '', ['src/old.ts']), { files: { 'src/old.ts': {} } });
  assert.equal(pruneToTargets('x', '', []), 'x');
  assert.deepEqual(pruneToTargets({ files: 1 }, '', []), { files: 1 });
});
