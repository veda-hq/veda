import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  FIXTURE_GIT_IDENTITY,
  HERMETIC_GIT_VARIABLES,
  hermeticGitEnv,
  isFixturePath,
  removeFixtureRoot,
} from './isolation.ts';

describe('hermeticGitEnv', () => {
  it('drops every inherited GIT_* but the kept ones, and masks the config', () => {
    const env = hermeticGitEnv({
      PATH: '/bin',
      GIT_DIR: '/elsewhere/.git',
      GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/dev/null'",
      GIT_CONFIG_COUNT: '1',
      GIT_AUTHOR_NAME: 'Someone',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    });
    assert.deepEqual(env, {
      ...FIXTURE_GIT_IDENTITY,
      PATH: '/bin',
      GIT_AUTHOR_NAME: 'Someone',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      ...HERMETIC_GIT_VARIABLES,
    });
  });

  it('starts from the process environment by default, without changing it', () => {
    // Names only: a failing comparison must not print the environment.
    const before = Object.keys(process.env).sort().join(' ');
    const global = process.env.GIT_CONFIG_GLOBAL;
    const env = hermeticGitEnv();
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(env.PATH === process.env.PATH, true);
    assert.equal(Object.keys(process.env).sort().join(' ') === before, true);
    assert.equal(process.env.GIT_CONFIG_GLOBAL === global, true);
  });
});

describe('removeFixtureRoot', () => {
  it('removes a root below the temporary directory', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kavach-iso-')));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'c'), 'x');
    assert.equal(isFixturePath(root), true);
    removeFixtureRoot(root);
    assert.equal(existsSync(root), false);
  });

  it('takes a missing path below the temporary directory for its own', () => {
    assert.equal(isFixturePath(join(tmpdir(), 'kavach-gone', 'deeper')), true);
  });

  it('refuses the temporary directory itself and anything outside it', () => {
    for (const path of [tmpdir(), '/', join(tmpdir(), '..'), process.cwd()]) {
      assert.equal(isFixturePath(path), false, path);
      assert.throws(() => {
        removeFixtureRoot(path);
      }, /refusing to remove/);
    }
  });
});
