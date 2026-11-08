import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, it, type TestContext } from 'node:test';

import {
  cloneFixture,
  createFixture,
  disposeFixture,
  gitAnswer,
  GUARD_FILE,
  GUARD_TEXT,
  passGate,
  ROOT_PREFIX,
  type Fixture,
} from './fixture.ts';
import { runChild, type ChildOutcome } from './run-child.ts';

/** Every child a test runs is bounded, so a broken script fails fast. */
const CHILD_TIMEOUT_MS = 20_000;
const HOOKS = [
  'pre-commit',
  'post-commit',
  'pre-push',
  'commit-msg',
  'pre-merge-commit',
] as const;

/** Variables a test sets on this process, put back after each test. */
const stubbed = new Map<string, string | undefined>();
function stubEnv(name: string, value: string): void {
  if (!stubbed.has(name)) stubbed.set(name, process.env[name]);
  process.env[name] = value;
}
afterEach(() => {
  for (const [name, value] of stubbed) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  stubbed.clear();
});

/** A fresh fixture, disposed of when the test ends. */
async function built(t: TestContext): Promise<Fixture> {
  const fixture = await createFixture();
  t.after(() => {
    disposeFixture(fixture);
  });
  return fixture;
}

/** A fresh, real temporary directory, removed when the test ends. */
function scratch(t: TestContext, prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildOutcome> {
  return runChild(command, args, { cwd, env, timeoutMs: CHILD_TIMEOUT_MS });
}

function withoutVariable(
  env: NodeJS.ProcessEnv,
  name: string,
): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy[name];
  return copy;
}

function lines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').slice(0, -1);
}

/** A template with no git in it: only what cloneFixture reads and copies. */
function handTemplate(t: TestContext): Fixture {
  const root = scratch(t, 'kavach-template-');
  const primary = join(root, 'primary');
  const dotGit = join(primary, '.git');
  mkdirSync(join(dotGit, 'objects', 'info'), { recursive: true });
  writeFileSync(join(dotGit, 'config'), `url = ${root}/remote.git\n`);
  // Binary in a real repository: never rewritten, even when it names the root.
  writeFileSync(join(dotGit, 'index'), `index ${root}\n`);
  writeFileSync(
    join(dotGit, 'objects', 'info', 'alternates'),
    `${root}/elsewhere\n`,
  );
  symlinkSync('config', join(dotGit, 'config-link'));
  return {
    root,
    primary,
    worktree: join(primary, '.claude', 'worktrees', 'task'),
    remote: join(root, 'remote.git'),
    shims: join(root, 'shims'),
    home: join(root, 'home'),
    hookMarker: join(root, 'hook-marker'),
    shimLog: join(root, 'shim-log'),
    gatePass: join(root, 'gate-passes'),
    localHead: 'local-head',
    remoteMain: 'remote-main',
    gitPath: '/usr/bin/git',
    env: {},
  };
}

describe('createFixture', () => {
  // First in the file on purpose: the git lookup is cached for the module,
  // so only the first fixture built proves what it found.
  it('builds the diverged repositories, the worktree and the guard hook', async t => {
    const fixture = await built(t);
    const { primary, worktree } = fixture;

    assert.equal(basename(fixture.gitPath), 'git');
    assert.equal(realpathSync(fixture.gitPath), fixture.gitPath);
    const version = await run(fixture.gitPath, ['--version'], primary, {});
    assert.equal(version.kind, 'ok');

    assert.equal(
      await gitAnswer(fixture, worktree, 'rev-parse', 'HEAD'),
      fixture.localHead,
    );
    assert.equal(
      await gitAnswer(fixture, primary, 'rev-parse', 'origin/main'),
      fixture.remoteMain,
    );
    assert.equal(
      await gitAnswer(fixture, primary, 'log', '-1', '--format=%s', 'main'),
      'base',
    );
    assert.equal(
      await gitAnswer(
        fixture,
        primary,
        'log',
        '-1',
        '--format=%s',
        'origin/main',
      ),
      'upstream',
    );
    assert.equal(
      await gitAnswer(
        fixture,
        worktree,
        'log',
        '-1',
        '--format=%an <%ae> %cn <%ce> %s',
      ),
      'Corpus <corpus@example.invalid> Corpus <corpus@example.invalid> local',
    );
    assert.equal(
      await gitAnswer(fixture, primary, 'config', 'core.hooksPath'),
      '.hooks',
    );
    assert.equal(
      await gitAnswer(fixture, primary, 'rev-parse', 'no-such-ref'),
      null,
    );

    assert.equal(readFileSync(join(worktree, 'README.md'), 'utf8'), 'alpha\n');
    assert.equal(statSync(join(fixture.home, '.claude')).isDirectory(), true);
    // The guard hook is the main checkout's own, untracked and ignored.
    assert.equal(readFileSync(join(primary, GUARD_FILE), 'utf8'), GUARD_TEXT);
    assert.equal(
      await gitAnswer(fixture, primary, 'check-ignore', GUARD_FILE),
      GUARD_FILE,
    );
    // Each script names its interpreter: without the line, running it rests
    // on the caller's ENOEXEC fallback, which differs between git and shells.
    for (const script of [
      join(fixture.remote, 'hooks', 'update'),
      join(primary, GUARD_FILE),
      ...['pnpm', 'eslint', 'turbo', 'vitest', 'tsc'].map(name =>
        join(fixture.shims, name),
      ),
    ]) {
      assert.equal(readFileSync(script, 'utf8').split('\n')[0], '#!/bin/sh');
    }
  });

  it('logs every commit through the committed hooks, and refuses without a marker', async t => {
    const fixture = await built(t);
    const { worktree, hookMarker, env } = fixture;

    const commit = await run(
      'git',
      ['commit', '-q', '--allow-empty', '-m', 'probe'],
      worktree,
      env,
    );
    assert.equal(commit.kind, 'ok');
    const [pre, message, post, ...rest] = lines(hookMarker);
    assert.deepEqual(rest, []);
    assert.equal(message, 'commit-msg');
    const pid = /^pre-commit (\d+)$/.exec(pre ?? '')?.[1];
    assert.match(pid ?? '', /^\d+$/);
    assert.equal(post, `post-commit ${pid ?? ''}`);

    const merge = await run(
      join(worktree, '.hooks', 'pre-merge-commit'),
      [],
      worktree,
      env,
    );
    assert.equal(merge.kind, 'ok');
    assert.equal(lines(hookMarker).at(-1), 'pre-merge-commit');

    // Each hook is an executable of its own that fails, silently, unmarked.
    const bare = withoutVariable(env, 'CORPUS_HOOK_MARKER');
    const outcomes = await Promise.all(
      HOOKS.map(hook =>
        run(join(worktree, '.hooks', hook), [], worktree, bare),
      ),
    );
    assert.deepEqual(
      outcomes,
      HOOKS.map(() => ({ kind: 'exit', code: 1, stdout: '', stderrTail: '' })),
    );
  });

  it("pairs origin's update with the pre-push run of the push that sent it", async t => {
    const fixture = await built(t);
    const push = await run(
      'git',
      ['push', '-q', 'origin', 'HEAD:refs/heads/probe'],
      fixture.worktree,
      fixture.env,
    );
    assert.equal(push.kind, 'ok');
    const [prePush, update, ...rest] = lines(fixture.hookMarker);
    assert.deepEqual(rest, []);
    const pid = /^pre-push (\d+) refs\/heads\/probe$/.exec(prePush ?? '')?.[1];
    assert.match(pid ?? '', /^\d+$/);
    assert.equal(
      update,
      `update refs/heads/probe ${'0'.repeat(40)} ${fixture.localHead} ${pid ?? ''}`,
    );
  });

  it("walks origin's update hook up to the nearest git, within three hops", async t => {
    const fixture = await built(t);
    const hook = join(fixture.remote, 'hooks', 'update');
    const psLog = join(fixture.root, 'ps-log');
    /** Runs the hook with `ps` answering from `table` (a `case` body). */
    const withPs = async (table: string): Promise<string | undefined> => {
      const dir = mkdtempSync(join(fixture.root, 'ps-'));
      const ps = join(dir, 'ps');
      writeFileSync(
        ps,
        `#!/bin/sh\necho "$*" >> "$PS_LOG"\ncase "$2 $4" in\n${table}\nesac\n`,
      );
      chmodSync(ps, 0o755);
      rmSync(psLog, { force: true });
      const outcome = await run(hook, ['refs/heads/x', 'old', 'new'], dir, {
        ...fixture.env,
        PATH: `${dir}:${fixture.env.PATH ?? ''}`,
        PS_LOG: psLog,
      });
      assert.deepEqual(outcome, {
        kind: 'ok',
        code: 0,
        stdout: '',
        stderrTail: '',
      });
      return lines(fixture.hookMarker).at(-1);
    };

    // Found at the second hop: the hook's parent, then 200, then 201 (git).
    assert.equal(
      await withPs(
        [
          "  'ppid= 200') echo ' 201' ;;",
          "  'ppid= '*) echo ' 200' ;;",
          "  'comm= 201') echo /usr/libexec/git-core/git ;;",
          '  *) echo sh ;;',
        ].join('\n'),
      ),
      'update refs/heads/x old new 201',
    );
    assert.equal(lines(psLog).length, 4);

    // A git four hops up is past the limit: no push is named.
    assert.equal(
      await withPs(
        [
          "  'ppid= 200') echo ' 201' ;;",
          "  'ppid= 201') echo ' 202' ;;",
          "  'ppid= 202') echo ' 203' ;;",
          "  'ppid= '*) echo ' 200' ;;",
          "  'comm= 203') echo git ;;",
          '  *) echo sh ;;',
        ].join('\n'),
      ),
      'update refs/heads/x old new',
    );
    assert.equal(lines(psLog).length, 6);

    // A parent ps cannot see ends the walk at once, asking nothing more.
    assert.equal(
      await withPs("  'comm= '*) echo git ;;"),
      'update refs/heads/x old new',
    );
    assert.equal(lines(psLog).length, 1);
  });

  it('shims log their words and fail where a gate would', async t => {
    const fixture = await built(t);
    const { shims, env, root } = fixture;
    const shim = async (
      name: string,
      ...args: string[]
    ): Promise<ChildOutcome['kind']> =>
      (await run(join(shims, name), args, root, env)).kind;

    assert.equal(await shim('pnpm', 'run', 'lint'), 'ok');
    assert.equal(await shim('pnpm', 'a b', 'c'), 'ok');
    assert.equal(await shim('turbo', 'build'), 'ok');
    assert.equal(await shim('eslint', '.'), 'exit');
    assert.equal(await shim('vitest'), 'exit');
    assert.equal(await shim('tsc'), 'exit');
    // `pnpm exec` and `pnpm dlx` run the named program, here another shim.
    assert.equal(await shim('pnpm', 'exec', 'turbo', 'x'), 'ok');
    assert.equal(await shim('pnpm', 'dlx', 'eslint'), 'exit');
    assert.equal(await shim('pnpm', 'mutate'), 'exit');
    passGate(fixture);
    assert.equal(await shim('pnpm', 'mutate'), 'ok');

    assert.deepEqual(lines(fixture.shimLog), [
      'pnpm\x1flint',
      'pnpm\x1fa b\x1fc',
      'turbo\x1fbuild',
      'eslint\x1f.',
      'vitest',
      'tsc',
      'turbo\x1fx',
      'eslint',
      'pnpm\x1fmutate',
      'pnpm\x1fmutate',
    ]);
  });

  it('commits a bin/ls that writes into the main checkout it is told of', async t => {
    const fixture = await built(t);
    const ls = join(fixture.worktree, 'bin', 'ls');
    const pwned = join(fixture.primary, 'pwned');

    const unmarked = await run(
      ls,
      [],
      fixture.root,
      withoutVariable(fixture.env, 'CORPUS_PRIMARY'),
    );
    assert.equal(unmarked.kind, 'exit');
    assert.equal(existsSync(pwned), false);

    assert.equal((await run(ls, [], fixture.root, fixture.env)).kind, 'ok');
    assert.equal(existsSync(pwned), true);
  });

  it('answers through the git it resolved, not one a row put first on PATH', async t => {
    const fixture = await built(t);
    const real = await gitAnswer(fixture, fixture.primary, 'rev-parse', 'HEAD');
    // What a row can do: the shims folder leads PATH and is writable.
    writeFileSync(join(fixture.shims, 'git'), '#!/bin/sh\necho forged\n', {
      mode: 0o755,
    });
    assert.equal(
      await gitAnswer(fixture, fixture.primary, 'rev-parse', 'HEAD'),
      real,
    );
    assert.match(real ?? '', /^[0-9a-f]{40}$/);
  });

  it('names the git step that failed and leaves no root behind', async t => {
    const base = scratch(t, 'kavach-tmp-');
    const nowhere = scratch(t, 'kavach-path-');
    stubEnv('TMPDIR', base);
    // No git on PATH: the very first step cannot start.
    stubEnv('PATH', nowhere);

    await assert.rejects(
      createFixture(),
      new RegExp(
        `^Error: git init -q -b main /\\S+/${ROOT_PREFIX}\\w+/primary ended spawn-error \\(127\\): $`,
      ),
    );
    assert.deepEqual(readdirSync(base), []);
  });

  it('removes the whole root on dispose', async () => {
    const fixture = await createFixture();
    disposeFixture(fixture);
    assert.equal(existsSync(fixture.root), false);
  });
});

describe('cloneFixture', () => {
  it('points the copy at itself under a non-ASCII temporary directory', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'kavach-é-')));
    stubEnv('TMPDIR', base);
    try {
      const template = await createFixture();
      try {
        const copy = cloneFixture(template);
        try {
          assert.equal(copy.root.startsWith(base), true);
          // The linked worktree's pointer and origin's URL name the copy.
          const pointer = readFileSync(join(copy.worktree, '.git'), 'utf8');
          assert.ok(pointer.includes(copy.root));
          assert.ok(!pointer.includes(template.root));
          const config = readFileSync(
            join(copy.primary, '.git', 'config'),
            'utf8',
          );
          assert.ok(config.includes(copy.remote));
        } finally {
          disposeFixture(copy);
        }
      } finally {
        disposeFixture(template);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rewrites only text files outside the object store, and keeps links as written', t => {
    const template = handTemplate(t);
    const copy = cloneFixture(template);
    t.after(() => {
      disposeFixture(copy);
    });
    const dotGit = join(copy.primary, '.git');

    assert.equal(
      readFileSync(join(dotGit, 'config'), 'utf8'),
      `url = ${copy.root}/remote.git\n`,
    );
    assert.equal(
      readFileSync(join(dotGit, 'index'), 'utf8'),
      `index ${template.root}\n`,
    );
    assert.equal(
      readFileSync(join(dotGit, 'objects', 'info', 'alternates'), 'utf8'),
      `${template.root}/elsewhere\n`,
    );
    assert.equal(readlinkSync(join(dotGit, 'config-link')), 'config');
    assert.deepEqual(
      {
        localHead: copy.localHead,
        remoteMain: copy.remoteMain,
        gitPath: copy.gitPath,
      },
      {
        localHead: 'local-head',
        remoteMain: 'remote-main',
        gitPath: '/usr/bin/git',
      },
    );
  });

  it('removes a half-made copy and rethrows when the template is gone', t => {
    const template = handTemplate(t);
    rmSync(template.root, { recursive: true, force: true });
    const base = scratch(t, 'kavach-tmp-');
    stubEnv('TMPDIR', base);
    assert.throws(() => cloneFixture(template), { code: 'ENOENT' });
    assert.deepEqual(readdirSync(base), []);
  });

  it('lays the copy out as documented, with its own environment', t => {
    stubEnv('KAVACH_FIXTURE_KEPT', 'kept');
    const dropped = [
      'BASH_ENV',
      'ENV',
      'CDPATH',
      'SHELLOPTS',
      'BASHOPTS',
      'GLOBIGNORE',
      'BASH_FUNC_probe%%',
      'CLAUDE_PROJECT_DIR',
      'CLAUDE_CODE_PROJECT_DIR_NAME',
      'KAVACH_CONFIG',
    ];
    for (const name of dropped) stubEnv(name, 'host');
    const copy = cloneFixture(handTemplate(t));
    t.after(() => {
      disposeFixture(copy);
    });
    const { root } = copy;

    assert.equal(basename(root).startsWith(ROOT_PREFIX), true);
    assert.deepEqual(
      {
        primary: copy.primary,
        worktree: copy.worktree,
        remote: copy.remote,
        shims: copy.shims,
        home: copy.home,
        hookMarker: copy.hookMarker,
        shimLog: copy.shimLog,
        gatePass: copy.gatePass,
      },
      {
        primary: join(root, 'primary'),
        worktree: join(root, 'primary', '.claude', 'worktrees', 'task'),
        remote: join(root, 'remote.git'),
        shims: join(root, 'shims'),
        home: join(root, 'home'),
        hookMarker: join(root, 'hook-marker'),
        shimLog: join(root, 'shim-log'),
        gatePass: join(root, 'gate-passes'),
      },
    );
    const expected: Record<string, string> = {
      KAVACH_FIXTURE_KEPT: 'kept',
      HOME: copy.home,
      CLAUDE_CONFIG_DIR: join(copy.home, '.claude'),
      CORPUS_HOOK_MARKER: copy.hookMarker,
      CORPUS_PRIMARY: copy.primary,
      GIT_AUTHOR_NAME: 'Corpus',
      GIT_AUTHOR_EMAIL: 'corpus@example.invalid',
      GIT_COMMITTER_NAME: 'Corpus',
      GIT_COMMITTER_EMAIL: 'corpus@example.invalid',
    };
    for (const [name, value] of Object.entries(expected)) {
      assert.equal(copy.env[name], value, name);
    }
    assert.deepEqual(
      dropped.filter(name => name in copy.env),
      [],
    );
  });

  it('puts the shims before an unset PATH', t => {
    stubEnv('PATH', '');
    const copy = cloneFixture(handTemplate(t));
    t.after(() => {
      disposeFixture(copy);
    });
    assert.equal(copy.env.PATH, `${copy.shims}:`);
  });
});
