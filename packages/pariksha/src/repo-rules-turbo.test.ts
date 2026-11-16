// turbo-inputs-cover-reads, first on its lesson's own incident.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memoryRepo } from './repo-rules-memory.ts';
import { DEFAULT_TASKS, globToRegExp, inputMatcher, namedFiles, tasksWithInputs, turboInputsCoverReads } from './repo-rules-turbo.ts';

describe('globToRegExp and inputMatcher', () => {
  it('reads Turborepo globs', () => {
    const cases: Array<[string, string, boolean]> = [
      ['src/**/*.ts', 'src/a.ts', true],
      ['src/**/*.ts', 'src/x/y/a.ts', true],
      ['src/**/*.ts', 'src/a.md', false],
      ['src/*.ts', 'src/x/a.ts', false],
      ['**', 'a/b/c', true],
      ['a?.md', 'ab.md', true],
      ['*.{ts,md}', 'a.md', true],
      ['*.{ts,md}', 'a.js', false],
      ['[ab].ts', 'b.ts', true],
      ['[!ab].ts', 'b.ts', false],
      ['a{b', 'a{b', true],
      ['a[b', 'a[b', true],
      ['a+b.ts', 'a+b.ts', true],
    ];
    for (const [glob, path, hit] of cases) assert.equal(globToRegExp(glob).test(path), hit, `${glob} ${path}`);
  });

  it("reads inputs from the package's folder, $TURBO_ROOT$ from the root, and negations in order", () => {
    const hashed = inputMatcher(['src/**', './docs/*.md', '!src/gen/**', '$TURBO_ROOT$/tsconfig.base.json'], 'packages/a');
    assert.equal(hashed('packages/a/src/x.ts'), true);
    assert.equal(hashed('packages/a/src/gen/x.ts'), false);
    assert.equal(hashed('packages/a/docs/a.md'), true);
    assert.equal(hashed('tsconfig.base.json'), true);
    assert.equal(hashed('packages/a/README.md'), false);
    assert.equal(inputMatcher(['scripts/**'], '')('scripts/a.ts'), true);
  });
});

describe('tasksWithInputs', () => {
  it("takes the package's own turbo.json first, then pkg#task, then the task, and the root's //#task", () => {
    const root = { tasks: { test: { inputs: ['src/**'] }, 'a#lint': { inputs: ['x'] }, '//#test:tooling': { inputs: ['scripts/**'] }, build: {}, wide: { inputs: ['$TURBO_DEFAULT$', 'x'] }, odd: { inputs: [3] } } };
    assert.deepEqual(tasksWithInputs(root, undefined, 'packages/a', 'a', ['test', 'lint', 'build', 'wide', 'odd', 'none']), [
      { name: 'test', inputs: ['src/**'] },
      { name: 'lint', inputs: ['x'] },
    ]);
    assert.deepEqual(tasksWithInputs(root, { tasks: { test: { inputs: ['lib/**'] } } }, 'packages/a', undefined, ['test']), [{ name: 'test', inputs: ['lib/**'] }]);
    assert.deepEqual(tasksWithInputs(root, undefined, '', 'root', ['test:tooling', 'test']), [{ name: '//#test:tooling', inputs: ['scripts/**'] }]);
    assert.deepEqual(tasksWithInputs({ pipeline: { test: { inputs: ['a'] } } }, 'x', 'p', undefined, ['test']), [{ name: 'test', inputs: ['a'] }]);
    assert.deepEqual(tasksWithInputs(null, undefined, 'p', undefined, ['test']), []);
  });
});

describe('namedFiles', () => {
  it('reads path literals that name a tracked file, from the file, its package or the root', () => {
    const tracked = new Set(['packages/a/README.md', 'packages/a/src/fixture.json', 'docs/guide.md', 'packages/a/package.json']);
    const code = "join(dir, '../README.md'); './fixture.json'; 'docs/guide.md'; 'README.md'; '../../../../x.md'; `${a}.md`; 'nope.md'";
    assert.deepEqual(
      namedFiles(code, 'packages/a/src/docs.test.ts', 'packages/a', tracked).map((n) => n.path),
      ['packages/a/README.md', 'packages/a/src/fixture.json', 'docs/guide.md', 'packages/a/README.md'],
    );
  });
});

describe('turbo-inputs-cover-reads', () => {
  const files = {
    'turbo.json': '{ "tasks": { "test": { "inputs": ["src/**/*.ts"] }, "lint": { "inputs": ["src/**"] } } }',
    'package.json': '{ "name": "root", "scripts": { "test": "turbo run test" } }',
    'packages/docs/package.json': '{ "name": "docs", "scripts": { "test": "node --test", "lint": "eslint ." } }',
    'packages/docs/README.md': '# Docs\n',
    'packages/docs/src/links.test.ts': "// reads '../README.md' in a comment, not the call below\nconst text = readFileSync(join(import.meta.dirname, '../README.md'), 'utf8');\nconst pkg = readFileSync('package.json');\nconst self = './links.test.ts';\n",
    'packages/other/package.json': '{ "name": "other" }',
    'packages/other/src/a.ts': "'../README.md'",
  };

  it('refuses the incident: a docs test inside a task whose inputs were src/**/*.ts, which cache-hit on a README change', () => {
    const detail = "task test runs this file, which names README.md; the task's inputs do not hash it";
    assert.deepEqual(turboInputsCoverReads.run(memoryRepo(files, { selected: ['packages/docs/README.md'] }), {}), [{ file: 'packages/docs/src/links.test.ts', line: 2, detail }]);
    assert.deepEqual(
      turboInputsCoverReads.run(memoryRepo(files, { selected: ['turbo.json'] }), {}).map((f) => f.file),
      ['packages/docs/src/links.test.ts'],
    );
    assert.deepEqual(turboInputsCoverReads.run(memoryRepo(files, { selected: ['packages/other/src/a.ts'] }), {}), []);
  });

  it('judges the tasks the setting names, the test tasks by default', () => {
    assert.deepEqual(DEFAULT_TASKS, ['test']);
    assert.equal(turboInputsCoverReads.run(memoryRepo(files), { tasks: ['^build$'] }).length, 0);
    assert.deepEqual(
      turboInputsCoverReads.run(memoryRepo(files), { tasks: ['^lint$'] }).map((f) => f.detail),
      ["task lint runs this file, which names README.md; the task's inputs do not hash it"],
    );
    const check = turboInputsCoverReads.settings?.['tasks'];
    assert.equal(check?.(['^test']), undefined);
    assert.match(check?.([]) ?? '', /non-empty list/);
    assert.match(check?.(['(']) ?? '', /holds "\(", which is not a regular expression/);
  });

  it('passes a repository with no turbo.json, and inputs that hash what the sources name', () => {
    const { 'turbo.json': _, ...noTurbo } = files;
    assert.deepEqual(turboInputsCoverReads.run(memoryRepo(noTurbo), {}), []);
    const wide = { ...files, 'turbo.json': '{ "tasks": { "test": { "inputs": ["src/**/*.ts", "README.md"] } } }' };
    assert.deepEqual(turboInputsCoverReads.run(memoryRepo(wide), {}), []);
    const gone = memoryRepo({ ...files, 'packages/docs/src/gone.ts': '' }, { selected: ['packages/docs/src/links.test.ts'] });
    const read = gone.read;
    assert.equal(turboInputsCoverReads.run({ ...gone, read: (p) => (p.endsWith('gone.ts') ? undefined : read(p)) }, {}).length, 1);
  });

  it('names a file outside the package by its path from the package', () => {
    const outside = { ...files, 'docs/guide.md': '# g', 'packages/docs/src/links.test.ts': "readFileSync('../../../docs/guide.md')" };
    assert.deepEqual(
      turboInputsCoverReads.run(memoryRepo(outside), {}).map((f) => f.detail),
      ["task test runs this file, which names ../../docs/guide.md; the task's inputs do not hash it"],
    );
    const rootTask = { 'turbo.json': '{ "tasks": { "//#test": { "inputs": ["scripts/**"] } } }', 'package.json': '{ "scripts": { "test": "node --test" } }', 'scripts/a.test.ts': "readFileSync('docs/a.md')", 'docs/a.md': 'x' };
    assert.deepEqual(
      turboInputsCoverReads.run(memoryRepo(rootTask), {}).map((f) => f.detail),
      ["task //#test runs this file, which names docs/a.md; the task's inputs do not hash it"],
    );
  });
});
