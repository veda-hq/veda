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
      ['a/**/b', 'a/b', true],
      ['a/**/b', 'a/x/y/b', true],
      ['a/**/b', 'a/xb', false],
      ['x{a,b}', 'xa', true],
      ['x{a,b}', 'xxa', false],
      ['[a!].ts', '!.ts', true],
      ['[a!].ts', '^.ts', false],
      ['a[b]', 'ab', true],
      ['a.ts', 'axts', false],
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

  it('keeps a ./ inside a glob that is no leading one', () => {
    assert.equal(inputMatcher(['x./y'], 'p')('p/x./y'), true);
    assert.equal(inputMatcher(['x./y'], 'p')('p/xy'), false);
  });

  it('reads a lone ./ at the root as the root path itself', () => {
    assert.equal(inputMatcher(['./'], '')(''), true);
    assert.equal(inputMatcher(['./'], '')('./'), false);
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

  it('looks up no name#task for a package with no name, and skips inputs with any entry that is no string', () => {
    const root = { tasks: { 'undefined#test': { inputs: ['u'] }, test: { inputs: ['t'] }, lint: { inputs: ['x', 3] } } };
    assert.deepEqual(tasksWithInputs(root, undefined, 'p', undefined, ['test', 'lint']), [{ name: 'test', inputs: ['t'] }]);
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

  it("reads a ./ path from the file's folder alone, and never a path that starts with ..", () => {
    const tracked = new Set(['packages/a/README.md', '..b.md']);
    assert.deepEqual(namedFiles("'./README.md'; 'a/../..b.md'", 'packages/a/src/t.ts', 'packages/a', tracked), []);
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
    assert.throws(() => check?.(['(']), /holds "\(", which is not a regular expression/);
  });

  it('refuses a tasks setting with any entry that is no string or is empty', () => {
    const check = turboInputsCoverReads.settings?.['tasks'];
    for (const value of [[], ['x', 3], [3], [''], 'test']) assert.equal(check?.(value), 'must be a non-empty list of regular expressions', JSON.stringify(value));
  });

  it('has its id and lesson', () => {
    assert.equal(turboInputsCoverReads.id, 'turbo-inputs-cover-reads');
    assert.equal(
      turboInputsCoverReads.lesson,
      "A Turborepo task with `inputs` hashes only those files. When a source it runs reads another file (a test that checks the README, a script that reads a config), a change to that file alone cache-hits and replays the old pass, so a dead link or a broken config ships green. Add the file to the task's `inputs`, or mark the task `cache: false`.",
    );
  });

  it('judges each task any setting names, and a root task by its name without //#', () => {
    const two = {
      'turbo.json': '{ "tasks": { "test": { "inputs": ["src/**/*.ts"] }, "lint": { "inputs": ["src/**"] } } }',
      'packages/docs/package.json': '{ "name": "docs", "scripts": { "test": "node --test", "lint": "eslint ." } }',
      'packages/docs/README.md': '# Docs\n',
      'packages/docs/src/links.test.ts': "readFileSync('../README.md')",
    };
    assert.deepEqual(
      turboInputsCoverReads.run(memoryRepo(two), { tasks: ['^test$', '^lint$'] }).map((f) => f.detail),
      ["task test runs this file, which names README.md; the task's inputs do not hash it", "task lint runs this file, which names README.md; the task's inputs do not hash it"],
    );
    const rootTask = { 'turbo.json': '{ "tasks": { "//#test": { "inputs": ["scripts/**"] } } }', 'package.json': '{ "scripts": { "test": "node --test" } }', 'scripts/a.test.ts': "readFileSync('docs/a.md')", 'docs/a.md': 'x' };
    assert.deepEqual(turboInputsCoverReads.run(memoryRepo(rootTask), { tasks: ['^test$'] }), [
      { file: 'scripts/a.test.ts', line: 1, detail: "task //#test runs this file, which names docs/a.md; the task's inputs do not hash it" },
    ]);
  });

  it('strips //# only from the start of a task name', () => {
    const odd = {
      'turbo.json': '{ "tasks": { "a//#test": { "inputs": ["src/**/*.ts"] } } }',
      'packages/docs/package.json': '{ "name": "docs", "scripts": { "a//#test": "node --test" } }',
      'packages/docs/README.md': '# Docs\n',
      'packages/docs/src/a.test.ts': "'../README.md'",
    };
    assert.deepEqual(turboInputsCoverReads.run(memoryRepo(odd), { tasks: ['^atest$'] }), []);
  });

  it("takes a package's name#task before the task, by its string name only", () => {
    const named = (name: string, turbo: string) => ({
      'turbo.json': turbo,
      'packages/docs/package.json': `{ "name": ${name}, "scripts": { "test": "node --test" } }`,
      'packages/docs/README.md': '# Docs\n',
      'packages/docs/src/a.test.ts': "'../README.md'",
    });
    const detail = "task test runs this file, which names README.md; the task's inputs do not hash it";
    const docs = named('"docs"', '{ "tasks": { "docs#test": { "inputs": ["src/**/*.ts"] }, "test": { "inputs": ["**"] } } }');
    assert.deepEqual(turboInputsCoverReads.run(memoryRepo(docs), {}), [{ file: 'packages/docs/src/a.test.ts', line: 1, detail }]);
    const five = named('5', '{ "tasks": { "5#test": { "inputs": ["src/**/*.ts"] }, "test": { "inputs": ["**"] } } }');
    assert.deepEqual(turboInputsCoverReads.run(memoryRepo(five), {}), []);
  });

  it("reads a package's own turbo.json, and never judges a name of a turbo.json, its own or the root's", () => {
    const repo = memoryRepo({
      'turbo.json': '{ "tasks": { "test": { "inputs": ["src/**/*.ts"] } } }',
      'packages/docs/package.json': '{ "name": "docs", "scripts": { "test": "node --test" } }',
      'packages/docs/turbo.json': '{ "tasks": { "test": { "inputs": ["src/**/*.ts", "README.md"] } } }',
      'packages/docs/README.md': '# Docs\n',
      'packages/docs/src/a.test.ts': "'../README.md'; 'turbo.json'",
      'packages/web/package.json': '{ "name": "web", "scripts": { "test": "node --test" } }',
      'packages/web/src/b.test.ts': "'turbo.json'",
    });
    assert.deepEqual(turboInputsCoverReads.run(repo, {}), []);
  });

  it('reads a package only from a package.json named so, outside node_modules', () => {
    const bak = { 'turbo.json': '{ "tasks": { "//#test": { "inputs": ["scripts/**"] } } }', 'package.json': '{ "scripts": { "test": "node --test" } }', 'scripts/a.test.ts': "readFileSync('docs/a.md')", 'scripts/package.json.bak': '{}', 'docs/a.md': 'x' };
    assert.deepEqual(turboInputsCoverReads.run(memoryRepo(bak), {}), [
      { file: 'scripts/a.test.ts', line: 1, detail: "task //#test runs this file, which names docs/a.md; the task's inputs do not hash it" },
    ]);
    const vendored = {
      'turbo.json': '{ "tasks": { "test": { "inputs": ["*.ts"] } } }',
      'node_modules/x/package.json': '{ "name": "x", "scripts": { "test": "node --test" } }',
      'node_modules/x/README.md': '# x\n',
      'node_modules/x/a.test.ts': "'README.md'",
    };
    assert.deepEqual(turboInputsCoverReads.run(memoryRepo(vendored), {}), []);
  });

  it('gives a file to the innermost package that holds it', () => {
    const repo = memoryRepo({
      'turbo.json': '{ "tasks": { "test": { "inputs": ["**/*.ts"] } } }',
      'packages/docs/package.json': '{ "name": "docs", "scripts": { "test": "node --test" } }',
      'packages/docs/README.md': '# Docs\n',
      'packages/docs/sub/package.json': '{ "name": "sub" }',
      'packages/docs/sub/a.test.ts': "'../README.md'",
      'packages/docs/sub/x/package.json': '{ "name": "x" }',
      'packages/docs/sub/x/b.test.ts': "'../../README.md'",
    });
    assert.deepEqual(turboInputsCoverReads.run(repo, {}), []);
  });

  it("judges only the package's own sources that its inputs hash", () => {
    const repo = memoryRepo({
      'turbo.json': '{ "tasks": { "test": { "inputs": ["src/**", "$TURBO_ROOT$/scripts/**"] } } }',
      'packages/docs/package.json': '{ "name": "docs", "scripts": { "test": "node --test" } }',
      'packages/docs/README.md': '# Docs\n',
      'packages/docs/lib/x.ts': "'../README.md'",
      'packages/docs/src/notes.md': "'../README.md'",
      'packages/docs/src/x.ts.snap': "'../README.md'",
      'scripts/x.ts': "'docs/a.md'",
      'docs/a.md': 'x',
    });
    assert.deepEqual(turboInputsCoverReads.run(repo, {}), []);
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
