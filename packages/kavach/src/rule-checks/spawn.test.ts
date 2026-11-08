/**
 * The processes the checks start: a program's status and output, and git in
 * a named checkout with its complaint carried in the error.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { hermeticGitEnv, maskProcessGitEnv, scratchDirs } from './fixture.test.ts';
import { git, run } from './spawn.ts';

// `git` passes on this process's environment, so the suite makes that
// environment hermetic: an inherited trace2 target can let a daemon write
// into a scratch repo while teardown removes it.
let unmask: () => void = () => undefined;
let path: string | undefined;
beforeEach(() => {
  unmask = maskProcessGitEnv();
  path = process.env['PATH'];
});
const { scratch, cleanup } = scratchDirs('rule-spawn-');
afterEach(() => {
  if (path === undefined) delete process.env['PATH'];
  else process.env['PATH'] = path;
  unmask();
  cleanup();
});

describe('run', () => {
  it('returns the status and stdout followed by stderr', () => {
    assert.deepEqual(
      run(process.execPath, ['-e', 'process.stdout.write("out;");process.stderr.write("err");process.exit(3)']),
      { status: 3, output: 'out;err' },
    );
  });

  it('reports a program that cannot start with no status and no output', () => {
    assert.deepEqual(run(join(scratch(), 'missing'), []), {
      status: null,
      output: '',
    });
  });
});

describe('git', () => {
  it('runs in the named checkout and trims its output', () => {
    const repo = scratch();
    execFileSync('git', ['init', '-q', '-b', 'trunk', repo], {
      env: hermeticGitEnv(),
    });
    assert.equal(git(repo, ['symbolic-ref', '--short', 'HEAD']), 'trunk');
    assert.equal(git(join(repo, '.git'), ['rev-parse', '--git-dir']), '.');
  });

  it("carries git's complaint in its error", () => {
    assert.throws(
      () => git(scratch(), ['rev-parse', '--show-toplevel']),
      /^Error: git rev-parse --show-toplevel: fatal: not a git repository\b.*\.git$/,
    );
  });

  it('carries the reason git could not start', () => {
    process.env['PATH'] = scratch();
    assert.throws(() => git(scratch(), ['status']), { message: 'git status: spawnSync git ENOENT' });
  });
});
