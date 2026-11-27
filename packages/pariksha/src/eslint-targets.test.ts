import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run } from './cli.ts';
import { affectedTargets, configInputs, DEFAULT_CONFIG, lintPackagesMoved, lintTargets, parseConfig, rangeTargets } from './eslint-targets.ts';

/**
 * Git hermetic for the whole process, as in cli.test.ts: the code under test
 * spawns git with this process's environment, as the fixtures do. A global
 * trace2 event target (a daemon's socket) could otherwise write into a
 * fixture's .git while after() removes it, and fail it with ENOTEMPTY.
 */
const HERMETIC = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' };
const inherited = Object.entries(process.env).filter(([name]) => name.startsWith('GIT_'));
for (const [name] of inherited) delete process.env[name];
Object.assign(process.env, HERMETIC);

const temps: string[] = [];
/** A fresh temporary directory, by its real path, removed when this file's tests end. */
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-lint-')));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  for (const name of Object.keys(HERMETIC)) delete process.env[name];
  Object.assign(process.env, Object.fromEntries(inherited));
});
const put = (root: string, file: string, text = '') => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};
const LINTED = JSON.stringify({ scripts: { 'lint:ci': 'x' } });

describe('parseConfig', () => {
  it('fills what is absent from the defaults', () => {
    assert.deepEqual(parseConfig('{}'), DEFAULT_CONFIG);
    assert.deepEqual(parseConfig('{"workspaces": ["libs"], "script": "lint", "lintPackages": ["@x/rules"], "pinFiles": ["package.json"]}'), {
      workspaces: ['libs'],
      script: 'lint',
      lintPackages: ['@x/rules'],
      pinFiles: ['package.json'],
    });
  });
  it('refuses what it cannot read', () => {
    assert.throws(() => parseConfig('{'), /not JSON/);
    assert.throws(() => parseConfig('[]'), /must be a JSON object/);
    assert.throws(() => parseConfig('{"workspace": []}'), /unknown key "workspace"/);
    assert.throws(() => parseConfig('{"workspaces": [""]}'), /"workspaces" must be a list of non-empty strings/);
    assert.throws(() => parseConfig('{"script": ""}'), /"script" must be a non-empty string/);
  });
  it('refuses a config that is no object, a list that is no list of non-empty strings, and a script that is no string', () => {
    for (const text of ['null', '"ab"', '3']) assert.throws(() => parseConfig(text), { message: 'the config must be a JSON object' }, text);
    for (const value of ['"ab"', 'null', '{"a": "b"}', '[1]', '["a", ""]', '["", "a"]', '["a", 1]']) {
      assert.throws(() => parseConfig(`{"pinFiles": ${value}}`), { message: '"pinFiles" must be a list of non-empty strings' }, value);
    }
    assert.throws(() => parseConfig('{"script": 1}'), { message: '"script" must be a non-empty string' });
  });
});

describe('the defaults, read through behaviour', () => {
  it('lints apps/* and packages/* workspaces that have lint:ci and a config of any of six names', () => {
    const root = temp();
    const names = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'];
    names.forEach((ext, i) => {
      put(root, `apps/w${String(i)}/package.json`, LINTED);
      put(root, `apps/w${String(i)}/eslint.config.${ext}`);
    });
    put(root, 'packages/p/package.json', LINTED);
    put(root, 'packages/p/eslint.config.js');
    put(root, 'packages/q/package.json', JSON.stringify({ scripts: { lint: 'x' } }));
    put(root, 'packages/q/eslint.config.js');
    put(root, 'packages/r/package.json', LINTED);
    put(root, 'packages/r/eslint.config.json');
    assert.deepEqual(lintTargets(root, parseConfig('{}')), ['.', 'apps/w0', 'apps/w1', 'apps/w2', 'apps/w3', 'apps/w4', 'apps/w5', 'packages/p']);
    const inputs = [...configInputs(root, '.')].sort();
    assert.deepEqual(inputs, ['eslint-suppressions.json', 'eslint.config.cjs', 'eslint.config.cts', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.mts', 'eslint.config.ts']);
  });

  it('reads no pinning file while the config names no lint package, and both default ones once it names one', () => {
    const root = temp();
    const calls: string[][] = [];
    const git = {
      run: (args: readonly string[]): string => {
        calls.push([...args]);
        return args[1] === '--name-only' ? 'eslint.config.mjs\0' : '';
      },
    };
    assert.deepEqual(rangeTargets(git, root, parseConfig('{}'), 'a..b'), ['.']);
    assert.deepEqual(calls, [['diff', '--name-only', '-z', '--no-renames', 'a..b', '--']]);
    calls.length = 0;
    assert.deepEqual(rangeTargets(git, root, parseConfig('{"lintPackages": ["@x/rules"]}'), 'a..b'), ['.']);
    assert.deepEqual(calls, [
      ['diff', '--no-color', '--no-ext-diff', 'a..b', '--', 'package.json', 'pnpm-lock.yaml'],
      ['diff', '--name-only', '-z', '--no-renames', 'a..b', '--'],
    ]);
  });

  it('sweeps every target when the pins move a named package, without reading the changed paths', () => {
    const root = temp();
    put(root, 'apps/a/package.json', LINTED);
    put(root, 'apps/a/eslint.config.mjs');
    const calls: string[][] = [];
    const git = {
      run: (args: readonly string[]): string => {
        calls.push([...args]);
        return '+ "@x/rules": "2"';
      },
    };
    assert.deepEqual(rangeTargets(git, root, parseConfig('{"lintPackages": ["@x/rules"]}'), 'a..b'), ['.', 'apps/a']);
    assert.equal(calls.length, 1);
  });
});

describe('configInputs on a fixture tree', () => {
  it('follows imports, requires and __dirname paths transitively and stops at node_modules', () => {
    const root = temp();
    put(root, 'apps/a/package.json', LINTED);
    put(root, 'apps/a/eslint.config.mjs', "import r from './rules/index.js';\nimport p from '../../shared/preset.mjs';\nimport x from '../../node_modules/dep/index.js';");
    put(root, 'apps/a/rules/index.js', "module.exports = require('./one');");
    // Bare, like a root aggregator's: only the __dirname form reaches it.
    put(root, 'apps/a/rules/one.js', "const s = require(path.resolve(__dirname, 'helpers/agg.js'));");
    put(root, 'apps/a/rules/helpers/agg.js', "require('../../../../agg2.js');");
    put(root, 'agg2.js');
    put(root, 'shared/preset.mjs', "export const schema = new URL('./data.json', import.meta.url);");
    put(root, 'shared/data.json', '{}');
    put(root, 'node_modules/dep/index.js');
    put(root, 'apps/a/tsconfig.json', '{}');
    put(root, 'apps/a/tsconfig.build.json', '{}');
    // A workspace without the lint script is not a target, nor a folder with no manifest.
    put(root, 'apps/b/package.json', JSON.stringify({ scripts: {} }));
    put(root, 'apps/b/eslint.config.mjs');
    mkdirSync(join(root, 'apps/c'));
    assert.deepEqual(lintTargets(root, DEFAULT_CONFIG), ['.', 'apps/a']);
    assert.deepEqual(lintTargets(root, { ...DEFAULT_CONFIG, script: 'lint' }), ['.']);
    const inputs = configInputs(root, 'apps/a');
    for (const file of [
      // Every config name counts, present or not: adding one changes the run.
      'apps/a/eslint.config.ts',
      'apps/a/eslint.config.mjs',
      'apps/a/eslint-suppressions.json',
      'apps/a/rules/index.js',
      'apps/a/rules/one.js',
      'apps/a/rules/helpers/agg.js',
      'agg2.js',
      'shared/preset.mjs',
      'shared/data.json',
      'apps/a/tsconfig.json',
      'apps/a/tsconfig.build.json',
    ])
      assert.ok(inputs.has(file), file);
    assert.ok(!inputs.has('node_modules/dep/index.js'));
    // Deletions still reach the target: a config still importing a deleted rule, a
    // deleted top-level tsconfig, but not a nested one.
    put(root, 'apps/a/eslint.config.mjs', "import r from './rules/index.js';\nimport gone from './rules/gone';");
    assert.deepEqual(affectedTargets(root, DEFAULT_CONFIG, ['apps/a/rules/gone.js']), ['apps/a']);
    assert.deepEqual(affectedTargets(root, DEFAULT_CONFIG, ['apps/a/tsconfig.old.json']), ['apps/a']);
    assert.deepEqual(affectedTargets(root, DEFAULT_CONFIG, ['apps/a/src/tsconfig.json']), []);
    // The root's tsconfig is no typed-rule input of the root lint, however many `./` it carries.
    assert.deepEqual(affectedTargets(root, DEFAULT_CONFIG, ['././tsconfig.json']), []);
    // A deleted suppressions file is still an input: the name is fixed.
    assert.deepEqual(affectedTargets(root, DEFAULT_CONFIG, ['apps/a/eslint-suppressions.json']), ['apps/a']);
    // The ./-prefixed form git tooling sometimes prints.
    assert.deepEqual(affectedTargets(root, DEFAULT_CONFIG, ['./apps/a/eslint.config.mjs']), ['apps/a']);
  });

  it('resolves a specifier through each suffix, and names every candidate of one that resolves to nothing', () => {
    const root = temp();
    put(root, 'eslint.config.mjs', ["'./a'", "'./b'", "'./c'", "'./d'", "'./e'", "'./f'", "'./g.json'", "'./gone'"].map((s) => `import x from ${s};`).join('\n'));
    for (const file of ['a.js', 'b.mjs', 'c.cjs', 'd.ts', 'e/index.js', 'f/index.mjs', 'g.json']) put(root, file);
    assert.deepEqual([...configInputs(root, '.')].sort(), [
      'a.js',
      'b.mjs',
      'c.cjs',
      'd.ts',
      'e/index.js',
      'eslint-suppressions.json',
      'eslint.config.cjs',
      'eslint.config.cts',
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.mts',
      'eslint.config.ts',
      'f/index.mjs',
      'g.json',
      'gone',
      'gone.cjs',
      'gone.js',
      'gone.mjs',
      'gone.ts',
      'gone/index.js',
      'gone/index.mjs',
    ]);
  });

  it('reads __dirname paths with or without spaces, reads specifiers in script files only, and keeps to the repository', () => {
    const root = temp();
    put(root, 'eslint.config.cjs', ["require(join( __dirname, 'one.js'));", "require(resolve(__dirname ,'two.js'));", "require(join(__dirname,'three.json'));", "import o from '../outside.js';"].join('\n'));
    put(root, 'one.js');
    put(root, 'two.js');
    // A JSON file is an input, but nothing in it is a specifier.
    put(root, 'three.json', '{"x": "./four.js"}');
    put(root, 'four.js');
    const inputs = configInputs(root, '.');
    for (const file of ['one.js', 'two.js', 'three.json']) assert.ok(inputs.has(file), file);
    assert.ok(!inputs.has('four.js'));
    assert.deepEqual(
      [...inputs].filter((file) => file.startsWith('..')),
      [],
    );
  });

  it('reads each file of a cycle once', () => {
    const root = temp();
    put(root, 'eslint.config.mjs', "import a from './a.js';");
    put(root, 'a.js', "import b from './b.js';");
    put(root, 'b.js', "import a from './a.js';\nimport c from './c.js';");
    put(root, 'c.js', "import a from './eslint.config.mjs';");
    assert.deepEqual(
      [...configInputs(root, '.')].filter((file) => !file.startsWith('eslint')),
      ['a.js', 'b.js', 'c.js'],
    );
  });

  it('takes a workspace tsconfig by its whole name, and not the root’s', () => {
    const root = temp();
    put(root, 'tsconfig.json', '{}');
    put(root, 'apps/a/package.json', LINTED);
    put(root, 'apps/a/eslint.config.mjs');
    put(root, 'apps/a/tsconfig.json', '{}');
    put(root, 'apps/a/tsconfig.json.bak', '{}');
    assert.ok(!configInputs(root, '.').has('tsconfig.json'));
    assert.ok(configInputs(root, 'apps/a').has('apps/a/tsconfig.json'));
    assert.ok(!configInputs(root, 'apps/a').has('apps/a/tsconfig.json.bak'));
    // A deleted tsconfig reaches its workspace among other changes, but a name beside the folder does not.
    assert.deepEqual(affectedTargets(root, DEFAULT_CONFIG, ['notes.txt', 'apps/a/tsconfig.old.json']), ['apps/a']);
    assert.deepEqual(affectedTargets(root, DEFAULT_CONFIG, ['apps/a/tsconfig.json.bak']), []);
    assert.deepEqual(affectedTargets(root, DEFAULT_CONFIG, ['apps/bxtsconfig.json']), []);
    // Only a leading ./ is dropped.
    assert.deepEqual(affectedTargets(root, DEFAULT_CONFIG, ['apps/./a/eslint.config.mjs']), []);
  });

  it('skips a manifest with no scripts, and lists workspaces sorted whatever the folder order', () => {
    const root = temp();
    put(root, 'packages/x/package.json', LINTED);
    put(root, 'packages/x/eslint.config.js');
    put(root, 'apps/y/package.json', LINTED);
    put(root, 'apps/y/eslint.config.js');
    put(root, 'apps/z/package.json', '{}');
    put(root, 'apps/z/eslint.config.js');
    assert.deepEqual(lintTargets(root, { ...DEFAULT_CONFIG, workspaces: ['packages', 'apps'] }), ['.', 'apps/y', 'packages/x']);
  });

  it('reads only the workspace folders the config names', () => {
    const root = temp();
    put(root, 'libs/x/package.json', LINTED);
    put(root, 'libs/x/eslint.config.js');
    assert.deepEqual(lintTargets(root, DEFAULT_CONFIG), ['.']);
    assert.deepEqual(lintTargets(root, { ...DEFAULT_CONFIG, workspaces: ['libs', 'missing'] }), ['.', 'libs/x']);
  });
});

describe('lintPackagesMoved', () => {
  const packages = ['@acme/rules', 'acme/acme-rules', '@veda-hq/eslint-plugin-shuddhi'];
  it('is true for an added or removed line naming any package', () => {
    assert.ok(lintPackagesMoved('-    "@veda-hq/eslint-plugin-shuddhi": "0.2.0",\n+    "@veda-hq/eslint-plugin-shuddhi": "0.2.1",', packages));
    assert.ok(lintPackagesMoved('+    "@acme/rules": "github:acme/acme-rules#v0.2.1"', packages));
    assert.ok(lintPackagesMoved('-    resolution: {commit: 616d184, repo: https://github.com/acme/acme-rules.git, type: git}', packages));
  });
  it('is false for context lines, file headers, other packages, and with no packages named', () => {
    const diff = ['--- a/package.json', '+++ b/package.json', '     "@acme/rules": "github:acme/acme-rules#v0.2.0"', '-    "zod": "4.6.6"', '+    "zod": "4.6.7"'].join('\n');
    assert.ok(!lintPackagesMoved(diff, packages));
    assert.ok(!lintPackagesMoved('', packages));
    assert.ok(!lintPackagesMoved('+ "@acme/rules"', []));
  });
});

describe('pariksha eslint-targets', () => {
  // No detached auto-maintenance after a commit: it could write into a fixture as it is removed.
  const git = (root: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
  const commit = (root: string, message: string) => {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', message);
  };
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
  };
  const targets = (root: string, config?: string) => {
    const c = capture();
    const code = run(['eslint-targets', '--root', root, '--range', 'HEAD~1..HEAD', ...(config === undefined ? [] : ['--config', config])], { ...c.io, cwd: () => root }, '1.0.0', {});
    return { code, out: c.out, err: c.err };
  };

  it('names the targets a range reaches, one per line', () => {
    const root = temp();
    git(root, 'init', '-q');
    put(root, 'package.json', '{ "devDependencies": {} }\n');
    put(root, 'pnpm-lock.yaml', 'lock: 1\n');
    put(root, 'eslint-suppressions.json', '{}\n');
    put(root, 'notes.txt', 'one\n');
    put(root, 'apps/a/package.json', LINTED);
    put(root, 'apps/a/eslint.config.mjs', 'export default [];\n');
    put(root, 'lint.json', '{"lintPackages": ["@acme/rules"]}');
    commit(root, 'one');
    put(root, 'notes.txt', 'two\n');
    commit(root, 'a file no lint reads');
    assert.deepEqual(targets(root), { code: 0, out: [], err: [] });
    put(root, 'apps/a/eslint.config.mjs', 'export default [{}];\n');
    commit(root, 'a workspace config');
    assert.deepEqual(targets(root).out, ['apps/a']);
    put(root, 'eslint-suppressions.json', '{ "x": {} }\n');
    commit(root, 'the root suppressions');
    assert.deepEqual(targets(root).out, ['.']);
    // A moved rules pin reaches every target, when the config names the package.
    put(root, 'package.json', '{ "devDependencies": { "@acme/rules": "github:acme/acme-rules#v1" } }\n');
    commit(root, 'the rules pin');
    assert.deepEqual(targets(root).out, []);
    assert.deepEqual(targets(root, 'lint.json').out, ['.', 'apps/a']);
  });

  it('reads its settings from .pariksha.json', () => {
    const root = temp();
    git(root, 'init', '-q');
    put(root, 'package.json', '{}\n');
    put(root, 'libs/x/package.json', JSON.stringify({ scripts: { lint: 'x' } }));
    put(root, 'libs/x/eslint.config.js', '');
    put(root, '.pariksha.json', JSON.stringify({ checks: { 'eslint-targets': { workspaces: ['libs'], script: 'lint' } } }));
    commit(root, 'one');
    put(root, 'libs/x/eslint.config.js', 'export default [];');
    commit(root, 'two');
    assert.deepEqual(targets(root).out, ['libs/x']);
  });

  it('refuses anything but one range, and a range git cannot read', () => {
    for (const args of [[], ['--range'], ['--range', ''], ['--range', '-x'], ['--from', 'HEAD~1..HEAD'], ['--range', 'a', 'extra']]) {
      const c = capture();
      assert.equal(run(['eslint-targets', ...args], c.io, '1.0.0', {}), 2);
      assert.match(c.err[0] ?? '', /^usage:/);
    }
    const root = temp();
    git(root, 'init', '-q');
    const bad = targets(root);
    assert.equal(bad.code, 2);
    assert.match(bad.err[0] ?? '', /git diff .* failed; nothing was checked/);
    const outside = temp();
    const none = capture();
    assert.equal(run(['eslint-targets', '--root', outside, '--range', 'HEAD~1..HEAD'], none.io, '1.0.0', {}), 2);
    assert.match(none.err[0] ?? '', /is not in a git repository/);
  });
});
