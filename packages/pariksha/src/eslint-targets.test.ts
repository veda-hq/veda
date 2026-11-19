import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run } from './cli.ts';
import { affectedTargets, configInputs, DEFAULT_CONFIG, lintPackagesMoved, lintTargets, parseConfig } from './eslint-targets.ts';

const temps: string[] = [];
/** A fresh temporary directory, by its real path, removed when this file's tests end. */
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-lint-')));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
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
