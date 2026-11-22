import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, beforeEach, describe, test } from 'node:test';

import { entry, gitIn, lanesToJudge, main, outputs, readText } from './mutation-lanes.mjs';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// The tests are synchronous. One turn of the event loop before each lets the
// TAP line of a failed test reach stdout at once, so Stryker's tap runner
// bails on a mutant's first failure instead of running the whole file.
beforeEach(() => new Promise(resolve => setImmediate(resolve)));

// A hook exports GIT_DIR and its family, which would point git at veda's own
// repository: every fixture git runs without them, and without the user's config.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const lane = (name, dir) => ({ name, cwd: dir, config: 'stryker.config.mjs', reuse: false, include: [`^${dir}/src/`], extensions: ['.ts'] });

const CONFIG = {
  upstream: 'origin/main',
  ignore: ['\\.test\\.ts$'],
  lanes: [lane('alpha', 'alpha'), lane('beta', 'beta'), lane('gamma', 'gamma'), lane('delta', 'delta'), lane('two words', 'two')],
  reuseKey: { always: [], pluginDir: 'stryker/', helperPackages: [], sharedWorkspace: 'alpha' },
};

/** Write `files` (path → text) under `root`. */
function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A repository with `main` committed and HEAD on a branch from it. */
function fixture({ config = CONFIG } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mutation-lanes-'));
  roots.push(root);
  const git = gitIn(root, env);
  git(['init', '-q', '-b', 'main']);
  if (config) write(root, { 'agnipariksha.json': JSON.stringify(config) });
  write(root, {
    'alpha/src/a.ts': 'export const a = 1;\n',
    'alpha/src/a.test.ts': "import './a.ts';\n",
    'beta/src/b.ts': 'export const b = 1;\n',
    'gamma/src/g.ts': '// g\nexport const g = 1;\n',
    'gamma/src/g.test.ts': "import './g.ts';\n",
    'delta/src/d.ts': 'export const d = 1;\n',
    'delta/src/d.test.ts': "import './d.ts';\n",
    'two/src/t.ts': 'export const t = 1;\n',
    'two/src/t.test.ts': "import './t.ts';\n",
  });
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'main']);
  git(['switch', '-q', '-c', 'feature']);
  return { root, git };
}

describe('lanesToJudge', () => {
  test("names the lanes agnipariksha would judge a file in, in the config's order", () => {
    const { root, git } = fixture();
    write(root, {
      // A code change beside its suite: judged.
      'alpha/src/a.ts': 'export const a = 2;\n',
      'two/src/t.ts': 'export const t = 2;\n',
      // No colocated suite: not judged.
      'beta/src/b.ts': 'export const b = 2;\n',
      // Only a comment changed: not judged.
      'gamma/src/g.ts': '// g, changed\nexport const g = 1;\n',
      // Only the suite changed, which the config ignores.
      'delta/src/d.test.ts': "import './d.ts';\n// more\n",
    });
    git(['commit', '-q', '-am', 'feature']);
    // Untracked files are left out, as --tracked-only leaves them out.
    write(root, { 'gamma/src/n.ts': 'export const n = 1;\n', 'gamma/src/n.test.ts': "import './n.ts';\n" });
    assert.deepEqual(lanesToJudge(root, 'main', git), ['alpha', 'two words']);
  });

  test('leaves out a deleted file', () => {
    const { root, git } = fixture();
    unlinkSync(join(root, 'delta/src/d.ts'));
    git(['commit', '-q', '-am', 'delete d.ts']);
    assert.deepEqual(lanesToJudge(root, 'main', git), []);
  });

  test("diffs from the base's merge-base with HEAD, so main moving on brings nothing in", () => {
    const { root, git } = fixture();
    git(['switch', '-q', 'main']);
    write(root, { 'alpha/src/a.ts': 'export const a = 3;\n' });
    git(['commit', '-q', '-am', 'main moves']);
    git(['switch', '-q', 'feature']);
    assert.deepEqual(lanesToJudge(root, 'main', git), []);
  });

  test("plans veda's own scripts lane: a script beside its suite, but neither a suite alone nor released-pins.mjs", () => {
    const veda = JSON.parse(readFileSync(new URL('../agnipariksha.json', import.meta.url), 'utf8'));
    const { root, git } = fixture({ config: veda });
    write(root, { 'scripts/x.mjs': 'export const x = 1;\n', 'scripts/x.test.mjs': "import './x.mjs';\n" });
    write(root, { 'scripts/released-pins.mjs': 'export const r = 1;\n', 'scripts/released-pins.test.mjs': "import './released-pins.mjs';\n" });
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'scripts']);
    git(['switch', '-q', '-c', 'scripts']);
    write(root, { 'scripts/x.test.mjs': "import './x.mjs';\n// more\n", 'scripts/released-pins.mjs': 'export const r = 2;\n' });
    git(['commit', '-q', '-am', 'a suite and released-pins.mjs']);
    assert.deepEqual(lanesToJudge(root, 'feature', git), []);
    write(root, { 'scripts/x.mjs': 'export const x = 2;\n' });
    git(['commit', '-q', '-am', 'the script']);
    assert.deepEqual(lanesToJudge(root, 'feature', git), ['scripts']);
  });

  test('throws when there is no agnipariksha.json', () => {
    const { root, git } = fixture({ config: null });
    assert.throws(() => lanesToJudge(root, 'main', git), { message: `no agnipariksha.json at ${root}: it names the lanes to judge (see the package README)` });
  });
});

describe('outputs', () => {
  test('a matrix of the lanes and whether there is any', () => {
    assert.equal(outputs(['alpha', 'two words']), 'matrix={"include":[{"lane":"alpha"},{"lane":"two words"}]}\nany=true\n');
  });

  test('an empty matrix, and any=false', () => {
    assert.equal(outputs([]), 'matrix={"include":[]}\nany=false\n');
  });
});

describe('readText', () => {
  test("a file's text", () => {
    const { root } = fixture();
    assert.equal(readText(join(root, 'alpha/src/a.ts')), 'export const a = 1;\n');
  });

  test('undefined for a missing file', () => {
    const { root } = fixture();
    assert.equal(readText(join(root, 'missing.json')), undefined);
  });

  test('throws any other error', () => {
    const { root } = fixture();
    assert.throws(() => readText(join(root, 'alpha')), { code: 'EISDIR' });
  });
});

/** A sink for what main prints. */
function sink() {
  const lines = [];
  return { lines, write: text => lines.push(text) };
}

describe('main', () => {
  test('prints the outputs, and the lanes on stderr', () => {
    const { root, git } = fixture();
    write(root, { 'alpha/src/a.ts': 'export const a = 2;\n' });
    git(['commit', '-q', '-am', 'feature']);
    const stdout = sink();
    const stderr = sink();
    assert.equal(main(['--base', 'main'], { root, git, stdout, stderr }), 0);
    assert.deepEqual(stdout.lines, ['matrix={"include":[{"lane":"alpha"}]}\nany=true\n']);
    assert.deepEqual(stderr.lines, ['mutation-lanes: lanes to judge: alpha\n']);
  });

  test('names every lane to judge on stderr, comma-separated', () => {
    const { root, git } = fixture();
    write(root, { 'alpha/src/a.ts': 'export const a = 2;\n', 'two/src/t.ts': 'export const t = 2;\n' });
    git(['commit', '-q', '-am', 'feature']);
    const stderr = sink();
    assert.equal(main(['--base', 'main'], { root, git, stdout: sink(), stderr }), 0);
    assert.deepEqual(stderr.lines, ['mutation-lanes: lanes to judge: alpha, two words\n']);
  });

  test('says when no lane has a file to judge', () => {
    const { root, git } = fixture();
    const stdout = sink();
    const stderr = sink();
    assert.equal(main(['--base', 'main'], { root, git, stdout, stderr }), 0);
    assert.deepEqual(stdout.lines, ['matrix={"include":[]}\nany=false\n']);
    assert.deepEqual(stderr.lines, ['mutation-lanes: no lane has a file to judge\n']);
  });

  test('refuses with 2, printing no outputs, when the plan cannot be made', () => {
    const { root, git } = fixture();
    const stdout = sink();
    const stderr = sink();
    assert.equal(main(['--base', 'no-such-ref'], { root, git, stdout, stderr }), 2);
    assert.deepEqual(stdout.lines, []);
    assert.match(stderr.lines.join(''), /^mutation-lanes: Command failed: git merge-base no-such-ref HEAD\nfatal: Not a valid object name no-such-ref\n/);
  });

  for (const argv of [[], ['--base'], ['--base', ''], ['--head', 'main'], ['--base', 'main', 'extra']]) {
    test(`refuses with 2 on ${JSON.stringify(argv)}`, () => {
      const stdout = sink();
      const stderr = sink();
      assert.equal(main(argv, { root: '/nonexistent', stdout, stderr }), 2);
      assert.deepEqual(stdout.lines, []);
      assert.deepEqual(stderr.lines, ['usage: mutation-lanes.mjs --base <ref>\n']);
    });
  }
});

describe('entry', () => {
  const script = '/repo/scripts/mutation-lanes.mjs';
  const url = pathToFileURL(script).href;

  test('runs main on the arguments after the script when node runs this module', () => {
    const { root, git } = fixture();
    write(root, { 'alpha/src/a.ts': 'export const a = 2;\n' });
    git(['commit', '-q', '-am', 'feature']);
    const stdout = sink();
    assert.equal(entry(['node', script, '--base', 'main'], url, { root, git, stdout, stderr: sink() }), 0);
    assert.deepEqual(stdout.lines, ['matrix={"include":[{"lane":"alpha"}]}\nany=true\n']);
  });

  test('runs nothing when node runs another file, or no file', () => {
    const stderr = sink();
    assert.equal(entry(['node', '/repo/scripts/other.mjs', '--base', 'main'], url, { stderr }), undefined);
    assert.equal(entry(['node'], url, { stderr }), undefined);
    assert.deepEqual(stderr.lines, []);
  });
});
