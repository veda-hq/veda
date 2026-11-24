import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  FIXTURE_GIT_IDENTITY,
  HERMETIC_GIT_VARIABLES,
  hermeticGitEnv,
  maskProcessGitEnv,
} from './hermetic-git.js';

/**
 * The cases for `hermetic-git.js`, the env helper the git rules ask tests to
 * use: the env it builds, the counted mask and restore, and one real `git`
 * run showing a hostile base env is shut out.
 */

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const HERMETIC = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TRACE2: '0',
  GIT_TRACE2_EVENT: '0',
  GIT_TRACE2_PERF: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto',
  GIT_CONFIG_VALUE_1: '0',
};

/** The variables a git hook, a shell or a config injection leaves behind. */
const HOSTILE = {
  GIT_DIR: '/hook/repo/.git',
  GIT_INDEX_FILE: '/hook/repo/.git/index',
  GIT_WORK_TREE: '/hook/repo',
  GIT_CONFIG_PARAMETERS: "'commit.gpgsign'='true'",
  GIT_CONFIG: '/home/me/.gitconfig',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'user.useConfigOnly',
  GIT_CONFIG_VALUE_0: 'true',
  GIT_TRACE2_EVENT: '/tmp/trace.sock',
};

describe('the exported constants', () => {
  it('names the fixture identity and the hermetic variables, frozen', () => {
    assert.deepEqual(FIXTURE_GIT_IDENTITY, IDENTITY);
    assert.deepEqual(HERMETIC_GIT_VARIABLES, HERMETIC);
    assert.ok(Object.isFrozen(FIXTURE_GIT_IDENTITY));
    assert.ok(Object.isFrozen(HERMETIC_GIT_VARIABLES));
  });

  it('is the module the package exports as ./hermetic-git', async () => {
    const shipped = await import('@veda-hq/eslint-plugin-shuddhi/hermetic-git');
    assert.equal(shipped.hermeticGitEnv, hermeticGitEnv);
    assert.equal(shipped.maskProcessGitEnv, maskProcessGitEnv);
  });
});

describe('hermeticGitEnv', () => {
  it('drops every inherited GIT_* but identity and transport, and adds the masks', () => {
    const base = {
      PATH: '/usr/bin',
      HOME: '/home/me',
      ...HOSTILE,
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    };
    assert.deepEqual(hermeticGitEnv(base), {
      ...IDENTITY,
      PATH: '/usr/bin',
      HOME: '/home/me',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      ...HERMETIC,
    });
  });

  it("keeps a caller's identity over the fixture's", () => {
    const env = hermeticGitEnv({
      GIT_AUTHOR_NAME: 'Ann',
      GIT_AUTHOR_EMAIL: 'ann@example.invalid',
      GIT_COMMITTER_NAME: 'Bob',
      GIT_COMMITTER_EMAIL: 'bob@example.invalid',
    });
    assert.equal(env.GIT_AUTHOR_NAME, 'Ann');
    assert.equal(env.GIT_AUTHOR_EMAIL, 'ann@example.invalid');
    assert.equal(env.GIT_COMMITTER_NAME, 'Bob');
    assert.equal(env.GIT_COMMITTER_EMAIL, 'bob@example.invalid');
  });

  it('copies its base, never changes it', () => {
    const base = { PATH: '/usr/bin', ...HOSTILE };
    const before = { ...base };
    const env = hermeticGitEnv(base);
    env['PATH'] = '/changed';
    assert.deepEqual(base, before);
  });

  it('reads process.env by default', () => {
    assert.deepEqual(hermeticGitEnv(), hermeticGitEnv({ ...process.env }));
  });
});

describe('maskProcessGitEnv', () => {
  /** A process-like env: two plain variables and the hostile GIT_* set. */
  const fresh = (): NodeJS.ProcessEnv => ({ PATH: '/usr/bin', HOME: '/home/me', ...HOSTILE });

  it('applies the isolation in place and restores what it replaced', () => {
    const env = fresh();
    const before = { ...env };
    const restore = maskProcessGitEnv(env);
    assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/me', ...IDENTITY, ...HERMETIC });
    restore();
    assert.deepEqual(env, before);
  });

  it('restores only GIT_* names: a variable set meanwhile stays, a GIT_* one goes', () => {
    const env = fresh();
    const restore = maskProcessGitEnv(env);
    env['NODE_ENV'] = 'test';
    env['GIT_NAMESPACE'] = 'leak';
    env['GIT_DIR'] = '/elsewhere';
    restore();
    assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/me', ...HOSTILE, NODE_ENV: 'test' });
  });

  it('writes only GIT_* names into the environment it masks', () => {
    const written: string[] = [];
    const env = new Proxy(fresh(), {
      set(target, name, value) {
        written.push(String(name));
        return Reflect.set(target, name, value);
      },
    });
    maskProcessGitEnv(env);
    assert.deepEqual(written.sort(), [
      'GIT_AUTHOR_EMAIL',
      'GIT_AUTHOR_NAME',
      'GIT_COMMITTER_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_KEY_1',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_VALUE_1',
      'GIT_TRACE2',
      'GIT_TRACE2_EVENT',
      'GIT_TRACE2_PERF',
    ]);
  });

  it('runs a restore once', () => {
    const env = fresh();
    const restore = maskProcessGitEnv(env);
    restore();
    env['GIT_DIR'] = '/set/after';
    restore();
    assert.equal(env['GIT_DIR'], '/set/after');
  });

  for (const order of ['first', 'last'] as const) {
    it(`counts masks: only the last restore puts it back (the ${order} mask restored first)`, () => {
      const env = fresh();
      const before = { ...env };
      const first = maskProcessGitEnv(env);
      const second = maskProcessGitEnv(env);
      const masked = { ...env };
      assert.deepEqual(masked, { PATH: '/usr/bin', HOME: '/home/me', ...IDENTITY, ...HERMETIC });
      const [early, late] = order === 'first' ? [first, second] : [second, first];
      early();
      assert.deepEqual(env, masked);
      early();
      assert.deepEqual(env, masked);
      late();
      assert.deepEqual(env, before);
    });
  }

  it('keeps separate counts for separate environments', () => {
    const a = fresh();
    const b = fresh();
    const restoreA = maskProcessGitEnv(a);
    const restoreB = maskProcessGitEnv(b);
    restoreA();
    assert.deepEqual(a, fresh());
    assert.equal(b['GIT_DIR'], undefined);
    restoreB();
    assert.deepEqual(b, fresh());
  });

  it('snapshots again for a mask after the last restore', () => {
    const env = fresh();
    maskProcessGitEnv(env)();
    env['GIT_DIR'] = '/second/hook';
    const restore = maskProcessGitEnv(env);
    assert.equal(env['GIT_DIR'], undefined);
    restore();
    assert.equal(env['GIT_DIR'], '/second/hook');
  });

  it('masks process.env by default', () => {
    const before = { ...process.env };
    const restore = maskProcessGitEnv();
    try {
      assert.equal(process.env['GIT_CONFIG_GLOBAL'], '/dev/null');
      assert.equal(process.env['GIT_CONFIG_COUNT'], '2');
    } finally {
      restore();
    }
    assert.deepEqual({ ...process.env }, before);
  });
});

describe('a real git run under hermeticGitEnv', () => {
  it('turns off maintenance and gc, sheds the injected config and GIT_DIR, and commits as the fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermetic-git-'));
    try {
      const env = hermeticGitEnv({
        PATH: process.env['PATH'],
        HOME: dir,
        GIT_DIR: join(dir, 'hook-repo.git'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.useConfigOnly',
        GIT_CONFIG_VALUE_0: 'true',
      });
      const git = (...args: string[]) =>
        spawnSync('git', args, {
          cwd: dir,
          env,
          encoding: 'utf8',
          timeout: 30_000,
          killSignal: 'SIGKILL',
        });
      const run = (...args: string[]): string => {
        const result = git(...args);
        assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
        return result.stdout;
      };

      run('init', '-q');
      assert.equal(run('rev-parse', '--git-dir'), '.git\n');
      assert.equal(run('config', '--get', 'maintenance.auto'), 'false\n');
      assert.equal(run('config', '--get', 'gc.auto'), '0\n');
      const injected = git('config', '--get', 'user.useConfigOnly');
      assert.equal(injected.status, 1);
      assert.equal(injected.stdout, '');
      run('commit', '--allow-empty', '-q', '-m', 'fixture');
      assert.equal(
        run('log', '-1', '--format=%an <%ae>|%cn <%ce>'),
        'Fixture <fixture@example.invalid>|Fixture <fixture@example.invalid>\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
