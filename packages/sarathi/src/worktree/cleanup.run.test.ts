/**
 * `sarathi worktree cleanup`: the whole run, the caches step and its
 * parsers, and the idle app worktrees step, over the fake machine in
 * cleanup.fixture.test.ts.
 */
import { describe } from 'node:test';
import { expect, it as test } from '../test/expect.test.ts';
import { projectName } from '../services/reaper.ts';
import {
  COMMAND_TIMEOUT_MS,
  DAEMON_TIMEOUT_MS,
  IDLE_DAYS,
  cleanup,
  parseProcesses,
  Failed,
  duBytes,
  brewFreed,
  APP_IDLE_DAYS,
} from './cleanup.ts';
import {
  SERVICES,
  PRIMARY_BUILT,
  NOW,
  DAY,
  OLD,
  PRIMARY,
  WT,
  SELF,
  COMMON,
  HOME,
  ok,
  exit,
  type Fixture,
  NO_NDK_DIR,
  PID,
  GRADLE_CACHES,
  PRIMARY_OUTPUT,
  BUILT_PATHS,
  BREW_DRY,
  BREW_REAL,
  DAEMON_LINE,
  harness,
  stepOf,
} from './cleanup.fixture.test.ts';

describe('cleanup', () => {
  const trees: Fixture['trees'] = {
    self: {},
    'agent-old': {},
    'agent-old-copy': { at: 'agent-old/.wt/copy' },
    'app-session': { marker: false },
    'agent-dirty': { status: ' M a.ts' },
    'gone-copy': { prunable: true },
  };

  test('a dry run lists what would go and removes nothing', async () => {
    const { env, calls, lines } = harness({
      trees,
      cwds: ['/elsewhere'],
      aiFolders: [
        { name: 'agent-old', made: OLD, bytes: 1e6 },
        { name: 'app-session', made: OLD, bytes: 1e6 },
        { name: 'long-gone', made: OLD, bytes: 1.5e9 },
      ],
    });
    expect(await cleanup(env, true)).toEqual([
      expect.objectContaining({ step: 'leftover worktrees', ok: true }),
      expect.objectContaining({ step: 'worktree archive', ok: true }),
      expect.objectContaining({
        step: 'stale worktree registrations',
        ok: true,
      }),
      expect.objectContaining({ step: 'git-ai folders', ok: true }),
      expect.objectContaining({ step: 'idle app worktrees', ok: true }),
      expect.objectContaining({ step: 'docker', ok: true }),
      expect.objectContaining({ step: 'docker staged update', ok: true }),
      expect.objectContaining({ step: 'android NDKs', ok: true }),
      expect.objectContaining({ step: 'caches', ok: true }),
    ]);
    expect(lines).toEqual([
      '✓ leftover worktrees',
      `    kept ${SELF}: this checkout`,
      `    would remove ${WT}/agent-old`,
      `    kept ${WT}/agent-dirty: uncommitted or untracked files`,
      '    1 desktop-app session worktrees left to the app (Settings › Storage › Clean up inactive sessions); primary /repo untouched here (the caches step clears only its rebuildable build output)',
      '✓ worktree archive',
      '    nothing archived in /repo/.git/acme/worktree-archive',
      '✓ stale worktree registrations',
      '    Removing worktrees/copy30: gitdir file points to non-existent location',
      '✓ git-ai folders',
      '    would delete 1 git-ai folders, 1.5 GB',
      `    2 kept: named after a listed worktree (repo included), its gitdir, or a folder in ${WT}`,
      '✓ idle app worktrees',
      `    kept ${WT}/app-session: git activity in the last ${APP_IDLE_DAYS} days`,
      '✓ docker',
      '    previewed the hourly sweep (sarathi services prune)',
      '    would prune all unused build cache (792.3GB)',
      '– docker staged update (skipped: no staged update)',
      NO_NDK_DIR,
      '✓ caches',
      '    would run: pnpm store prune',
      '    would run: xcrun simctl delete unavailable',
      '    would run: brew cleanup (frees about 1.8GB)',
      '    primary build output: nothing in /repo',
      `    Gradle caches: nothing at ${GRADLE_CACHES}`,
    ]);
    expect(
      calls.filter(call =>
        /remove|buildx|store prune|simctl|^drop /.test(call),
      ),
    ).toEqual([]);
    expect(calls).toContain(`brew cleanup --dry-run @${COMMAND_TIMEOUT_MS}`);
    expect(calls).toContain(
      `git worktree prune --verbose --dry-run @${COMMAND_TIMEOUT_MS}`,
    );
    expect(calls).toContain(
      `sweep /usr/local/bin/docker --dry-run`,
    );
    expect(calls).toContain(
      `docker info --format {{.ServerVersion}} @${DAEMON_TIMEOUT_MS}`,
    );
    expect(calls).toContain(`lsof -d cwd -Fn @${COMMAND_TIMEOUT_MS}`);
    expect(calls.slice(0, 5)).toEqual([
      `git rev-parse --path-format=absolute --git-common-dir @${COMMAND_TIMEOUT_MS}`,
      `settings ${PRIMARY}`,
      `services services.json ${PRIMARY}`,
      `git rev-parse --show-toplevel @${COMMAND_TIMEOUT_MS}`,
      `git worktree list --porcelain @${COMMAND_TIMEOUT_MS}`,
    ]);
    expect(calls).toContain(
      `docker system df --format {{.Type}} {{.Size}} @${COMMAND_TIMEOUT_MS}`,
    );
  });

  test('a real run removes nested copies first, then the worktree, and reports freed disk', async () => {
    const { env, calls, lines } = harness({ trees, platform: 'darwin' });
    await cleanup(env, false);
    const removals = calls.filter(call =>
      call.startsWith('git worktree remove'),
    );
    expect(removals).toEqual([
      `git worktree remove ${WT}/agent-old/.wt/copy @${COMMAND_TIMEOUT_MS}`,
      `git worktree remove ${WT}/agent-old @${COMMAND_TIMEOUT_MS}`,
    ]);
    expect(calls).toContain(
      `git worktree prune --verbose @${COMMAND_TIMEOUT_MS}`,
    );
    expect(calls).toContain(
      `sweep /usr/local/bin/docker`,
    );
    expect(calls).toContain(
      `docker buildx prune --all --force @${COMMAND_TIMEOUT_MS}`,
    );
    expect(calls).toContain(`pnpm store prune @${COMMAND_TIMEOUT_MS}`);
    expect(calls).toContain(
      `xcrun simctl delete unavailable @${COMMAND_TIMEOUT_MS}`,
    );
    expect(lines).toContain(`    removed ${WT}/agent-old`);
    expect(lines).toContain(
      '    ran the hourly sweep (sarathi services prune)',
    );
    expect(lines).toContain('    build cache: 640.5GB freed of 792.3GB');
    expect(lines).toContain('    pnpm store pruned');
    expect(lines).toContain('    unavailable simulators deleted');
    expect(lines.at(-1)).toBe(
      'free disk: 100.0 GB → 125.0 GB (Docker hands its space back to macOS over the next minutes)',
    );
  });

  test('off macOS there is no simulator step', async () => {
    const dry = harness({ trees: {}, platform: 'linux' });
    await cleanup(dry.env, true);
    expect(dry.lines.slice(-5, -3)).toEqual([
      '✓ caches',
      '    would run: pnpm store prune',
    ]);
    expect(dry.lines.at(-3)).toBe(
      '    would run: brew cleanup (frees about 1.8GB)',
    );
    const real = harness({ trees: {}, platform: 'linux' });
    await cleanup(real.env, false);
    expect(real.calls.some(call => call.startsWith('xcrun'))).toBe(false);
    expect(real.lines).toContain('    pnpm store pruned');
  });

  test('without a Docker daemon the step says skipped, not ✓, and is no failure', async () => {
    const { env, calls, lines } = harness({ trees: {}, docker: false });
    const results = await cleanup(env, false);
    expect(stepOf(results, 'docker')).toEqual({
      step: 'docker',
      ok: true,
      skipped: 'no Docker daemon',
      notes: ['exit 1: Cannot connect to the Docker daemon'],
    });
    expect(
      calls.some(
        call =>
          call.includes('buildx') || call.startsWith('sweep '),
      ),
    ).toBe(false);
    const at = lines.indexOf('– docker (skipped: no Docker daemon)');
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe(
      '    exit 1: Cannot connect to the Docker daemon',
    );
    expect(lines).not.toContain('✓ docker');
  });

  // Docker CLI 29.x (29.9.2 on macOS) words a stopped daemon this way;
  // verbatim from a real run.
  const docker29 =
    'failed to connect to the docker API at unix:///Users/me/.docker/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/me/.docker/run/docker.sock: connect: no such file or directory\n';

  test('a stopped daemon in Docker 29 wording skips the docker step and keeps the worktree step whole', async () => {
    const { env, calls, lines } = harness({
      trees: { 'agent-old': {} },
      fail: command => (command === 'docker' ? exit(1, docker29) : undefined),
    });
    const results = await cleanup(env, true);
    expect(results[0]).toEqual(
      expect.objectContaining({ step: 'leftover worktrees', ok: true }),
    );
    expect(lines).toContain(`    would remove ${WT}/agent-old`);
    expect(stepOf(results, 'docker')).toEqual({
      step: 'docker',
      ok: true,
      skipped: 'no Docker daemon',
      notes: [`exit 1: ${docker29.trim()}`],
    });
    expect(lines).toContain('– docker (skipped: no Docker daemon)');
    expect(calls.some(call => call.startsWith('sweep '))).toBe(
      false,
    );
  });

  test('a dry run reports four cases: Pods rebuilt, a gone locked registration, a checkout Claude Code did not make, the app count', async () => {
    const codex = '/Users/me/.codex/worktrees/ab12/acme_mono';
    const gone = '/private/tmp/acme-codex-agent-integration';
    const pods = 'apps/mobile/ios/Pods/';
    const { env, calls, lines } = harness({
      trees: {
        self: {},
        codex: { at: codex, marker: false },
        'codex-gone': {
          at: gone,
          locked: true,
          lockReason: 'initializing',
          gone: true,
        },
        'app-session': { marker: false },
        mobile: {
          ignored: [pods, '.tmp/plan.md'],
          ignoredInside: [`${pods}Manifest.lock`],
        },
        'mobile-copy': {
          at: 'mobile/.wt/copy',
          ignored: [pods],
          ignoredInside: [`${pods}Manifest.lock`],
        },
      },
    });
    await cleanup(env, true);
    expect(lines.slice(0, 6)).toEqual([
      '✓ leftover worktrees',
      `    kept ${SELF}: this checkout`,
      `    kept ${codex}: not made by Claude Code`,
      `    kept ${gone}: registered but gone, locked by initializing: \`git worktree unlock ${gone}\` then \`sarathi worktree cleanup\` prunes it`,
      `    would remove ${WT}/mobile, 1 ignored files to /repo/.git/acme/worktree-archive/mobile`,
      '    1 desktop-app session worktrees left to the app (Settings › Storage › Clean up inactive sessions); primary /repo untouched here (the caches step clears only its rebuildable build output)',
    ]);
    // Pods is never listed file by file, in the worktree or its copy.
    expect(calls.filter(call => call.includes(`-- ${pods}`))).toEqual([]);
    expect(calls.filter(call => /unlock|remove/.test(call))).toEqual([]);
  });

  test('without Docker installed the step is skipped', async () => {
    const { env } = harness({
      trees: {},
      fail: (command, args) =>
        command === 'docker' && args[0] === 'info'
          ? {
              kind: 'spawn-error',
              errno: 'ENOENT',
              message: 'spawn docker ENOENT',
              code: 127,
              stdout: '',
              stderrTail: '',
            }
          : undefined,
    });
    const results = await cleanup(env, false);
    expect(stepOf(results, 'docker')).toEqual({
      step: 'docker',
      ok: true,
      skipped: 'no Docker daemon',
      notes: ['spawn docker ENOENT'],
    });
  });

  test('a docker that cannot be started fails the step', async () => {
    const { env } = harness({
      trees: {},
      fail: (command, args) =>
        command === 'docker' && args[0] === 'info'
          ? {
              kind: 'spawn-error',
              errno: 'EACCES',
              message: 'spawn docker EACCES',
              code: 126,
              stdout: '',
              stderrTail: '',
            }
          : undefined,
    });
    const results = await cleanup(env, false);
    expect(stepOf(results, 'docker')).toEqual({
      step: 'docker',
      ok: false,
      notes: ['docker info: spawn docker EACCES'],
    });
  });

  test('a docker info that fails otherwise fails the step', async () => {
    const { env, calls } = harness({
      trees: {},
      fail: (command, args) =>
        command === 'docker' && args[0] === 'info'
          ? exit(1, 'permission denied while trying to connect')
          : undefined,
    });
    const results = await cleanup(env, false);
    expect(stepOf(results, 'docker')).toEqual({
      step: 'docker',
      ok: false,
      notes: ['docker info: exit 1: permission denied while trying to connect'],
    });
    expect(calls.some(call => call.startsWith('sweep '))).toBe(
      false,
    );
  });

  test('a failing docker system df only blurs the report', async () => {
    const { env, lines } = harness({
      trees: {},
      fail: (command, args) =>
        command === 'docker' && args[0] === 'system'
          ? exit(1, 'rw layer snapshot not found')
          : undefined,
    });
    const results = await cleanup(env, false);
    expect(stepOf(results, 'docker')?.ok).toBe(true);
    expect(lines).toContain(
      '    build cache: 640.5GB freed of an unknown size',
    );
  });

  test('an empty prune says so', async () => {
    const { env, lines } = harness({
      trees: {},
      fail: (command, args) =>
        args[1] === 'prune' && command === 'git' ? ok('', '\n') : undefined,
    });
    await cleanup(env, true);
    expect(lines).toContain('    nothing to prune');
  });

  test('a worktree inside another, not a nested copy, is judged alone and keeps its parent', async () => {
    const { env, calls, lines } = harness({
      trees: {
        outer: {},
        inner: { at: 'outer/inner', marker: false },
        'outer-copy': { at: 'outer/.wt/copy' },
      },
    });
    await cleanup(env, false);
    expect(lines.slice(0, 3)).toEqual([
      '✓ leftover worktrees',
      `    kept ${WT}/outer: it holds ${WT}/outer/inner`,
      '    1 desktop-app session worktrees left to the app (Settings › Storage › Clean up inactive sessions); primary /repo untouched here (the caches step clears only its rebuildable build output)',
    ]);
    expect(
      calls.filter(call => call.startsWith('git worktree remove')),
    ).toEqual([]);
  });

  test.each([
    [{ status: ' M a.ts' }, 'uncommitted changes'],
    [{ remote: '' }, 'HEAD is on no remote branch'],
    [{ locked: true }, 'locked'],
    [{ touched: NOW }, `git activity in the last ${IDLE_DAYS} days`],
    [{ gitFile: null }, 'its .git file names no gitdir'],
  ])(
    'a nested copy holding work (%o) keeps its parent',
    async (copy, reason) => {
      const { env, calls, lines } = harness({
        trees: {
          outer: {},
          'outer-copy': { at: 'outer/.wt/copy', ...copy },
        },
      });
      await cleanup(env, false);
      expect(lines[1]).toBe(
        `    kept ${WT}/outer: ${WT}/outer/.wt/copy: ${reason}`,
      );
      expect(
        calls.filter(call => call.startsWith('git worktree remove')),
      ).toEqual([]);
    },
  );

  test('a copy is checked for tracked changes only; its untracked build output is its own', async () => {
    const { env, calls, lines } = harness({
      trees: { outer: {}, 'outer-copy': { at: 'outer/.wt/copy' } },
    });
    await cleanup(env, true);
    expect(lines[1]).toBe(`    would remove ${WT}/outer`);
    expect(calls).toContain(
      `git --no-optional-locks -C ${WT}/outer/.wt/copy status --porcelain --untracked-files=no @${COMMAND_TIMEOUT_MS}`,
    );
    expect(calls).toContain(
      `git --no-optional-locks -C ${WT}/outer/.wt/copy for-each-ref --count=1 --contains HEAD --format=%(refname) refs/remotes @${COMMAND_TIMEOUT_MS}`,
    );
  });

  test('copies are checked before the process listing, and a numbered copy counts', async () => {
    const { env, calls } = harness({
      trees: {
        outer: {},
        'outer-copy': { at: 'outer/.wt/copy-000000000000001-00000002' },
      },
    });
    await cleanup(env, false);
    const copy = `${WT}/outer/.wt/copy-000000000000001-00000002`;
    const order = [
      `git --no-optional-locks -C ${copy} for-each-ref --count=1 --contains HEAD --format=%(refname) refs/remotes @${COMMAND_TIMEOUT_MS}`,
      `lsof -d cwd -Fn @${COMMAND_TIMEOUT_MS}`,
      `git worktree remove ${copy} @${COMMAND_TIMEOUT_MS}`,
      `git worktree remove ${WT}/outer @${COMMAND_TIMEOUT_MS}`,
    ].map(call => calls.indexOf(call));
    expect(order.every(index => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('another worktree under .wt is no copy: it keeps its parent', async () => {
    const { env, calls, lines } = harness({
      trees: { outer: {}, other: { at: 'outer/.wt/other' } },
    });
    await cleanup(env, false);
    expect(lines).toContain(
      `    kept ${WT}/outer: it holds ${WT}/outer/.wt/other`,
    );
    // Judged on its own, it goes alone, never as the parent's copy.
    expect(
      calls.filter(call => call.startsWith('git worktree remove')),
    ).toEqual([
      `git worktree remove ${WT}/outer/.wt/other @${COMMAND_TIMEOUT_MS}`,
    ]);
  });

  test('a copy under a .wt folder whose worktree is gone is judged alone', async () => {
    const { env, lines } = harness({
      trees: { orphan: { at: 'gone/.wt/copy', prunable: true } },
    });
    await cleanup(env, true);
    expect(lines[1]).toBe(
      '    0 desktop-app session worktrees left to the app (Settings › Storage › Clean up inactive sessions); primary /repo untouched here (the caches step clears only its rebuildable build output)',
    );
  });

  test('a failed step is reported and the next steps still run', async () => {
    const { env, calls, lines } = harness({
      trees: { 'agent-old': {} },
      fail: (command, args) =>
        command === 'git' && args[1] === '--show-toplevel'
          ? exit(128, 'fatal: not a git repository')
          : command === 'git' && args[1] === 'prune'
            ? {
                kind: 'timeout',
                timeoutMs: 9,
                code: 124,
                stdout: '',
                stderrTail: '',
              }
            : undefined,
    });
    const results = await cleanup(env, false);
    expect(results.map(result => result.ok)).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
      true,
      true,
      true,
    ]);
    expect(lines.slice(0, 6)).toEqual([
      '✗ leftover worktrees',
      '    git rev-parse --show-toplevel: exit 128: fatal: not a git repository',
      '✓ worktree archive',
      '    nothing archived in /repo/.git/acme/worktree-archive',
      '✗ stale worktree registrations',
      '    git worktree prune --verbose: timed out after 9 ms',
    ]);
    expect(calls).toContain(
      `docker buildx prune --all --force @${COMMAND_TIMEOUT_MS}`,
    );
  });

  test('a non-Error throw is reported as text', async () => {
    const { env, lines } = harness({ trees: {} });
    const run = env.run;
    env.run = async (command, args, timeoutMs) => {
      if (command === 'pnpm') throw 'pnpm vanished';
      return run(command, args, timeoutMs);
    };
    await cleanup(env, false);
    expect(lines).toContain('✗ caches');
    expect(lines).toContain('    pnpm store prune failed: pnpm vanished');
    // The failed part does not stop the others.
    expect(lines).toContain('    unavailable simulators deleted');
  });

  test('a listing that names no checkout fails the step and removes nothing', async () => {
    const { env } = harness({ trees: {} });
    env.run = async (command, args) =>
      command === 'git' && args[1] === 'list'
        ? ok('')
        : ok(command === 'git' ? SELF : '');
    const results = await cleanup(env, true);
    expect(results[0]).toEqual({
      step: 'leftover worktrees',
      ok: false,
      notes: ['git worktree list --porcelain named no checkout'],
    });
  });
});

describe('caches step', () => {
  /** The caches step's result and its printed lines. */
  async function caches(fixture: Partial<Fixture>, dryRun: boolean) {
    const { env, calls, lines } = harness({ trees: {}, ...fixture });
    const results = await cleanup(env, dryRun);
    const at = lines.findIndex(line => /^[✓✗–] caches/.test(line));
    return {
      result: results.at(-1),
      lines: lines.slice(at, dryRun ? undefined : -1),
      calls,
      drops: calls.filter(call => call.startsWith('drop ')),
    };
  }
  const everything = { built: BUILT_PATHS, platform: 'linux' as const };
  const primaryNote =
    '.turbo, apps/mobile/android/build, apps/mobile/android/app/build, apps/mobile/android/.cxx, apps/mobile/android/app/.cxx, apps/mobile/android/.gradle in /repo, 6.1 GB';
  const gradleNote = `${GRADLE_CACHES}, 1.0 GB (${HOME}/.gradle/wrapper stays)`;

  test('names only rebuildable output in the primary checkout', () => {
    expect(PRIMARY_BUILT.map(path => `${PRIMARY}/${path}`)).toEqual(
      PRIMARY_OUTPUT,
    );
  });

  test('a dry run gives each part its size and deletes nothing', async () => {
    const { result, lines, drops, calls } = await caches(everything, true);
    expect(result).toEqual(
      expect.objectContaining({ step: 'caches', ok: true }),
    );
    expect(result?.skipped).toBeUndefined();
    expect(lines).toEqual([
      '✓ caches',
      '    would run: pnpm store prune',
      '    would run: brew cleanup (frees about 1.8GB)',
      `    would delete ${primaryNote}`,
      `    would delete ${gradleNote}`,
    ]);
    expect(drops).toEqual([]);
    expect(calls).toContain(
      `du -sk ${PRIMARY_OUTPUT.join(' ')} @${COMMAND_TIMEOUT_MS}`,
    );
    expect(calls).toContain(`du -sk ${GRADLE_CACHES} @${COMMAND_TIMEOUT_MS}`);
  });

  test('a real run deletes each present path and runs brew cleanup', async () => {
    const { result, lines, drops, calls } = await caches(everything, false);
    expect(result?.ok).toBe(true);
    expect(lines).toEqual([
      '✓ caches',
      '    pnpm store pruned',
      '    brew cleanup freed about 1.8GB',
      `    deleted ${primaryNote}`,
      `    deleted ${gradleNote}`,
    ]);
    expect(drops).toEqual(BUILT_PATHS.map(path => `drop ${path}`));
    expect(calls).toContain(`brew cleanup @${COMMAND_TIMEOUT_MS}`);
    // The in-use checks come after sizing, right before the deletion.
    const order = calls.filter(call => /^(du|ps|lsof|drop) /.test(call));
    expect(order.map(call => call.split(' ')[0])).toEqual([
      'du',
      'ps',
      'lsof',
      ...PRIMARY_OUTPUT.map(() => 'drop'),
      'du',
      'ps',
      'drop',
    ]);
    expect(calls).toContain(`lsof -d cwd -FcRn @${COMMAND_TIMEOUT_MS}`);
    expect(calls).toContain(`ps -A -ww -o command= @${COMMAND_TIMEOUT_MS}`);
  });

  test('only the paths that exist are sized and deleted', async () => {
    const { lines, drops } = await caches(
      { built: [`${PRIMARY}/.turbo`], platform: 'linux' },
      false,
    );
    expect(lines).toContain('    deleted .turbo in /repo, 1.0 GB');
    expect(lines).toContain(`    Gradle caches: nothing at ${GRADLE_CACHES}`);
    expect(drops).toEqual([`drop ${PRIMARY}/.turbo`]);
  });

  test('with nothing there, no part sizes, lists processes or deletes', async () => {
    const { lines, calls } = await caches({ platform: 'linux' }, false);
    expect(lines.slice(-2)).toEqual([
      '    primary build output: nothing in /repo',
      `    Gradle caches: nothing at ${GRADLE_CACHES}`,
    ]);
    expect(calls.some(call => /^(du|ps|drop) /.test(call))).toBe(false);
    expect(calls.some(call => call.includes('-FcRn'))).toBe(false);
  });

  test('without brew that part is skipped and the others still run', async () => {
    const { result, lines, drops } = await caches(
      {
        ...everything,
        fail: command =>
          command === 'brew'
            ? {
                kind: 'spawn-error',
                errno: 'ENOENT',
                code: 127,
                message: 'spawn brew ENOENT',
                stdout: '',
                stderrTail: '',
              }
            : undefined,
      },
      false,
    );
    expect(result?.ok).toBe(true);
    expect(result?.skipped).toBeUndefined();
    expect(lines).toContain('    skipped brew cleanup: brew is not installed');
    expect(drops).toHaveLength(BUILT_PATHS.length);
  });

  test('brew that cannot start for another reason fails, naming the command', async () => {
    const { result, lines } = await caches(
      {
        platform: 'linux',
        fail: command =>
          command === 'brew'
            ? {
                kind: 'spawn-error',
                errno: 'EACCES',
                code: 126,
                message: 'spawn brew EACCES',
                stdout: '',
                stderrTail: '',
              }
            : undefined,
      },
      true,
    );
    expect(result?.ok).toBe(false);
    expect(lines).toContain(
      '    brew cleanup failed: brew cleanup --dry-run: spawn brew EACCES',
    );
  });

  test('a failed simulator cleanup is named and the rest still run', async () => {
    const { result, lines } = await caches(
      {
        platform: 'darwin',
        fail: command => (command === 'xcrun' ? exit(72) : undefined),
      },
      false,
    );
    expect(result?.ok).toBe(false);
    expect(lines).toContain(
      '    xcrun simctl delete unavailable failed: xcrun simctl delete unavailable: exit 72',
    );
    expect(lines).toContain('    brew cleanup freed about 1.8GB');
  });

  test('brew with nothing to free says so', async () => {
    const { lines } = await caches(
      {
        platform: 'linux',
        fail: command => (command === 'brew' ? ok('') : undefined),
      },
      true,
    );
    expect(lines).toContain('    brew cleanup: nothing to free');
  });

  test('a failed brew fails the step and the other parts still run', async () => {
    const { result, lines, drops } = await caches(
      {
        ...everything,
        fail: command =>
          command === 'brew' ? exit(1, 'Error: permission denied') : undefined,
      },
      false,
    );
    expect(result?.ok).toBe(false);
    expect(lines[0]).toBe('✗ caches');
    expect(lines).toContain(
      '    brew cleanup failed: brew cleanup: exit 1: Error: permission denied',
    );
    expect(lines).toContain('    pnpm store pruned');
    expect(drops).toHaveLength(BUILT_PATHS.length);
  });

  test('a running Gradle daemon keeps the primary output and the Gradle caches', async () => {
    const { result, lines, drops } = await caches(
      { ...everything, processes: ['  1 /sbin/launchd', DAEMON_LINE] },
      false,
    );
    expect(result?.ok).toBe(true);
    expect(lines.slice(-2)).toEqual([
      '    skipped primary build output: a Gradle daemon or build runs (org.gradle.launcher.daemon.bootstrap.GradleDaemon)',
      '    skipped Gradle caches: a Gradle daemon or build runs (org.gradle.launcher.daemon.bootstrap.GradleDaemon)',
    ]);
    expect(drops).toEqual([]);
    expect(lines).toContain('    brew cleanup freed about 1.8GB');
  });

  test('a Gradle build without a daemon keeps them too', async () => {
    const { drops, lines } = await caches(
      {
        ...everything,
        processes: [
          '  90 java -classpath gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain assembleRelease',
        ],
      },
      true,
    );
    expect(drops).toEqual([]);
    expect(lines.at(-1)).toBe(
      '    skipped Gradle caches: a Gradle daemon or build runs (org.gradle.wrapper.GradleWrapperMain)',
    );
  });

  test('a process working in the primary checkout keeps its output, not the Gradle caches', async () => {
    const { result, lines, drops } = await caches(
      {
        ...everything,
        lsof: [
          { pid: 1, parent: 0, command: 'launchd', cwd: '/' },
          { pid: 50, parent: 1, command: 'zsh', cwd: `${PRIMARY}/apps/web` },
        ],
      },
      false,
    );
    expect(result?.ok).toBe(true);
    expect(lines).toContain(
      '    skipped primary build output: a process works in the primary checkout: zsh (pid 50) in /repo/apps/web',
    );
    expect(drops).toEqual([`drop ${GRADLE_CACHES}`]);
  });

  test('cleanup’s own processes and processes in a linked worktree do not keep it', async () => {
    const { lines, drops } = await caches(
      {
        ...everything,
        trees: { self: {} },
        lsof: [
          // macOS lists kernel_task as its own parent: the walk up stops there.
          { pid: 0, parent: 0, command: 'kernel_task', cwd: '/' },
          { pid: 1, parent: 0, command: 'launchd', cwd: '/' },
          { pid: 3000, parent: 1, command: 'zsh', cwd: PRIMARY },
          { pid: 4000, parent: 3000, command: 'pnpm', cwd: PRIMARY },
          { pid: PID, parent: 4000, command: 'node', cwd: PRIMARY },
          { pid: 4300, parent: PID, command: 'lsof', cwd: PRIMARY },
          { pid: 60, parent: 1, command: 'vitest', cwd: `${SELF}/apps/web` },
        ],
      },
      false,
    );
    expect(lines).toContain(`    deleted ${primaryNote}`);
    expect(drops).toHaveLength(BUILT_PATHS.length);
  });

  test('a process outside the primary checkout does not keep it', async () => {
    const { drops } = await caches(
      {
        ...everything,
        lsof: [{ pid: 70, parent: 1, command: 'zsh', cwd: '/repository-two' }],
      },
      false,
    );
    expect(drops).toHaveLength(BUILT_PATHS.length);
  });

  test('a failed or partial lsof listing deletes none of the primary output', async () => {
    const { result, lines, drops } = await caches(
      {
        ...everything,
        fail: (command, args) =>
          command === 'lsof' && args[2] === '-FcRn'
            ? exit(1, 'lsof: WARNING: can’t stat() some file')
            : undefined,
      },
      false,
    );
    expect(result?.ok).toBe(false);
    expect(lines).toContain(
      '    primary build output failed: lsof -d cwd -FcRn: exit 1: lsof: WARNING: can’t stat() some file',
    );
    expect(drops).toEqual([`drop ${GRADLE_CACHES}`]);
  });

  test('a failed ps listing deletes neither', async () => {
    const { result, lines, drops } = await caches(
      {
        ...everything,
        fail: command =>
          command === 'ps' ? exit(1, 'ps: sysctl failed') : undefined,
      },
      false,
    );
    expect(result?.ok).toBe(false);
    expect(lines).toContain(
      '    Gradle caches failed: ps -A -ww -o command=: exit 1: ps: sysctl failed',
    );
    expect(drops).toEqual([]);
    expect(lines).toContain('    pnpm store pruned');
  });

  test('a failed size listing deletes nothing in that part', async () => {
    const { result, drops } = await caches(
      {
        ...everything,
        fail: (command, args) =>
          command === 'du' && args[1] === GRADLE_CACHES
            ? exit(1, 'du: caches: Permission denied')
            : undefined,
      },
      false,
    );
    expect(result?.ok).toBe(false);
    expect(drops).toHaveLength(PRIMARY_OUTPUT.length);
  });

  test('a failed worktree listing fails only the primary part', async () => {
    const { env, calls } = harness({ trees: {}, ...everything });
    const run = env.run;
    let listings = 0;
    env.run = async (command, args, timeoutMs) => {
      if (command === 'git' && args[1] === 'list' && ++listings > 2)
        return exit(128, 'fatal: not a git repository');
      return run(command, args, timeoutMs);
    };
    const results = await cleanup(env, false);
    expect(results.at(-1)?.notes).toContain(
      'primary build output failed: git worktree list --porcelain: exit 128: fatal: not a git repository',
    );
    expect(calls.filter(call => call.startsWith('drop '))).toEqual([
      `drop ${GRADLE_CACHES}`,
    ]);
  });
});

describe('parseProcesses', () => {
  test('reads pid, parent, command and working directory', () => {
    expect(
      parseProcesses(
        'p1\nR0\nclaunchd\nfcwd\nn/\np2\nR1\ncnode\nfcwd\nn/repo\np3\nR1\ncx\nn/proc/3/cwd (readlink: Permission denied)\np4\ncno-parent\nn/tmp\n',
      ),
    ).toEqual([
      { pid: 1, parent: 0, command: 'launchd', cwd: '/' },
      { pid: 2, parent: 1, command: 'node', cwd: '/repo' },
      {
        pid: 3,
        parent: 1,
        command: 'x',
        cwd: '/proc/3/cwd (readlink: Permission denied)',
      },
      { pid: 4, parent: 0, command: 'no-parent', cwd: '/tmp' },
    ]);
  });

  test('a field lsof leaves out reads as none, and a pid that is no whole number as 0', () => {
    expect(parseProcesses('n/early\np5\nn/x\np1.5\nR-2\ncodd\nn/y\n')).toEqual([
      { pid: 0, parent: 0, command: '', cwd: '/early' },
      { pid: 5, parent: 0, command: '', cwd: '/x' },
      { pid: 0, parent: 0, command: 'odd', cwd: '/y' },
    ]);
  });
});

describe('Failed', () => {
  test('carries every note, and says them all as its message', () => {
    const failed = new Failed(['a done', 'b failed: x']);
    expect(failed.notes).toEqual(['a done', 'b failed: x']);
    expect(failed.message).toBe('a done; b failed: x');
  });
});

describe('duBytes', () => {
  test('sums each line’s KiB as bytes', () => {
    expect(duBytes('4\t/a\n12\t/b with space\n')).toBe(16 * 1024);
    expect(duBytes('')).toBe(0);
    expect(duBytes('garbage\n')).toBe(0);
  });
});

describe('brewFreed', () => {
  test('reads what brew cleanup frees or would free', () => {
    expect(brewFreed(BREW_DRY)).toBe('1.8GB');
    expect(brewFreed(BREW_REAL)).toBe('1.8GB');
    expect(brewFreed('Removing: /x... (3 files)\n')).toBeUndefined();
  });
});

describe('idle app worktrees step', () => {
  const APP = `${WT}/app`;
  const COPY = `${APP}/.wt/copy`;
  const IDLE = NOW - (APP_IDLE_DAYS + 1) * DAY;
  /** What is trimmed from APP: node_modules, Pods and two build folders. */
  const TRIMMED = [
    'node_modules',
    'apps/mobile/ios/Pods',
    'apps/web/dist',
    'apps/mobile/android/app/build',
  ];
  const ignored = [
    ...TRIMMED.map(path => `${path}/`),
    // Kept: ignored but not REBUILT, a nested copy (judged as a
    // worktree), a REBUILT file, and a REBUILT name that is no folder (a link).
    '.tmp/',
    '.wt/',
    'apps/server/.env',
    'tsconfig.tsbuildinfo',
    'packages/shared/node_modules',
  ];
  const idleApp = (extra: Fixture['trees'][string] = {}) => ({
    app: { marker: false, touched: IDLE, ignored, ...extra },
  });
  const withCopy = (copy: Fixture['trees'][string] = {}): Fixture['trees'] => ({
    ...idleApp(),
    'app-copy': { at: 'app/.wt/copy', touched: IDLE, ...copy },
  });
  const report = (verb: string, copies: number, gb: string) =>
    `${verb} ${APP}: node_modules, ios/Pods, build output, ${copies} nested copies, ${gb} GB; folder and branch stay`;
  const deletions = (calls: string[]) =>
    calls.filter(call => /^drop |^git worktree remove/.test(call));

  async function run(fixture: Fixture, dryRun: boolean) {
    const h = harness(fixture);
    const results = await cleanup(h.env, dryRun);
    return { ...h, result: stepOf(results, 'idle app worktrees') };
  }

  test('runs after git-ai folders and before docker', async () => {
    const { env } = harness({ trees: {} });
    const steps = (await cleanup(env, true)).map(result => result.step);
    expect(steps.indexOf('idle app worktrees')).toBe(
      steps.indexOf('git-ai folders') + 1,
    );
    expect(steps.indexOf('docker')).toBe(
      steps.indexOf('idle app worktrees') + 1,
    );
  });

  test(`a dry run names what an app worktree idle ${APP_IDLE_DAYS} days would lose, and deletes nothing`, async () => {
    const { calls, result } = await run({ trees: withCopy() }, true);
    expect(result).toEqual({
      step: 'idle app worktrees',
      ok: true,
      notes: [report('would trim', 1, '5.1')],
    });
    expect(deletions(calls)).toEqual([]);
    expect(calls).toContain(
      `du -sk ${[...TRIMMED.map(path => `${APP}/${path}`), COPY].join(' ')} @${COMMAND_TIMEOUT_MS}`,
    );
    // Wholly ignored folders, named once each, with no index refresh.
    expect(calls).toContain(
      `git --no-optional-locks -C ${APP} ls-files --others --ignored --exclude-standard -z --directory @${COMMAND_TIMEOUT_MS}`,
    );
    // Step 1 and this step each ask which checkout runs cleanup.
    expect(
      calls.filter(
        call => call === `git rev-parse --show-toplevel @${COMMAND_TIMEOUT_MS}`,
      ),
    ).toHaveLength(2);
  });

  test('without build folders the report names no build output', async () => {
    const { result } = await run(
      {
        trees: idleApp({
          ignored: ['node_modules/', 'apps/mobile/ios/Pods/'],
        }),
      },
      true,
    );
    expect(result?.notes).toEqual([
      `would trim ${APP}: node_modules, ios/Pods, 0 nested copies, 2.0 GB; folder and branch stay`,
    ]);
  });

  test('a real run deletes only the REBUILT folders, then removes the idle copies, never --force', async () => {
    const { calls, result } = await run({ trees: withCopy() }, false);
    expect(result?.notes).toEqual([report('trimmed', 1, '5.1')]);
    expect(deletions(calls)).toEqual([
      ...TRIMMED.map(path => `drop ${APP}/${path}`),
      `git worktree remove ${COPY} @${COMMAND_TIMEOUT_MS}`,
    ]);
    expect(calls.some(call => /^git .*--force/.test(call))).toBe(false);
    // The in-use checks run twice: once to report, once just before deleting.
    expect(calls.filter(call => call.startsWith('lsof')).length).toBe(2);
    expect(calls.filter(call => call.startsWith('docker ps')).length).toBe(2);
  });

  test.each([
    [
      { touched: NOW - 5 * DAY },
      `git activity in the last ${APP_IDLE_DAYS} days`,
    ],
    [
      { gitFile: 'gitdir: /elsewhere/app\n' },
      'when git last touched it cannot be read',
    ],
  ])('kept on its git times (%o)', async (extra, reason) => {
    const { calls, result } = await run({ trees: idleApp(extra) }, false);
    expect(result?.notes).toEqual([`kept ${APP}: ${reason}`]);
    expect(deletions(calls)).toEqual([]);
  });

  test('kept while a process works in it', async () => {
    const { calls, result } = await run(
      { trees: idleApp(), cwds: [`${APP}/apps/web`] },
      false,
    );
    expect(result?.notes).toEqual([`kept ${APP}: a process works in it`]);
    expect(deletions(calls)).toEqual([]);
  });

  test('kept while its dev services run', async () => {
    const { calls, result } = await run(
      { trees: idleApp(), services: [projectName(SERVICES.project, APP)] },
      false,
    );
    expect(result?.notes).toEqual([
      `kept ${APP}: its dev services are running`,
    ]);
    expect(deletions(calls)).toEqual([]);
  });

  test('the checkout running cleanup is kept', async () => {
    const { result } = await run(
      { trees: { self: { marker: false, touched: IDLE, ignored } } },
      false,
    );
    expect(result?.notes).toEqual([`kept ${SELF}: this checkout`]);
  });

  test('a process that starts before the deletion keeps it, on a second look', async () => {
    let listings = 0;
    const { calls, result } = await run(
      {
        trees: withCopy(),
        fail: command => {
          if (command !== 'lsof') return undefined;
          listings += 1;
          return listings === 2 ? ok(`p1\nn${APP}\n`) : undefined;
        },
      },
      false,
    );
    expect(result?.notes).toEqual([
      `kept ${APP}: a process works in it, on a second look`,
    ]);
    expect(deletions(calls)).toEqual([]);
  });

  test('a worktree that left the listing before the deletion is kept', async () => {
    // This step sizes the trim, then lists again: that listing lacks APP.
    let sized = false;
    const { env, calls } = harness({ trees: idleApp() });
    const real = env.run;
    env.run = async (command, args, timeoutMs) => {
      if (command === 'du') sized = true;
      if (sized && command === 'git' && args[1] === 'list')
        return ok(`worktree ${PRIMARY}\n`);
      return real(command, args, timeoutMs);
    };
    const result = stepOf(await cleanup(env, false), 'idle app worktrees');
    expect(result?.notes).toEqual([
      `kept ${APP}: no longer an unmarked app worktree in git worktree list, on a second look`,
    ]);
    expect(deletions(calls)).toEqual([]);
  });

  test('a marker written before the deletion keeps it, on a second look', async () => {
    let sized = false;
    const { env, calls } = harness({ trees: idleApp() });
    const { run: real, exists } = env;
    env.run = async (command, args, timeoutMs) => {
      if (command === 'du') sized = true;
      return real(command, args, timeoutMs);
    };
    env.exists = path =>
      (sized && path === `${COMMON}/app/CLAUDE_BASE`) || exists(path);
    const result = stepOf(await cleanup(env, false), 'idle app worktrees');
    expect(result?.notes).toEqual([
      `kept ${APP}: no longer an unmarked app worktree in git worktree list, on a second look`,
    ]);
    expect(deletions(calls)).toEqual([]);
  });

  test('the second look reads the gitdir as it is now, not as it was', async () => {
    // After the first look, APP's .git file names another gitdir, one
    // touched IDLE_DAYS + 1 days ago: inside APP_IDLE_DAYS.
    let sized = false;
    const { env, calls } = harness({ trees: idleApp() });
    const { run: real, read } = env;
    env.run = async (command, args, timeoutMs) => {
      if (command === 'du') sized = true;
      return real(command, args, timeoutMs);
    };
    env.read = path =>
      sized && path === `${APP}/.git`
        ? `gitdir: ${COMMON}/fresh\n`
        : read(path);
    const exists = env.exists;
    env.exists = path => path !== `${COMMON}/fresh/CLAUDE_BASE` && exists(path);
    const result = stepOf(await cleanup(env, false), 'idle app worktrees');
    expect(result?.notes).toEqual([
      `kept ${APP}: git activity in the last ${APP_IDLE_DAYS} days, on a second look`,
    ]);
    expect(deletions(calls)).toEqual([]);
  });

  test('a marker that is there but unreadable is still a marker', async () => {
    const { env, calls } = harness({ trees: idleApp() });
    // `read` cannot see it; `exists` can.
    const exists = env.exists;
    env.exists = path => path === `${COMMON}/app/CLAUDE_BASE` || exists(path);
    const result = stepOf(await cleanup(env, false), 'idle app worktrees');
    expect(result?.notes).toEqual([
      'no desktop-app session worktrees in /repo/.claude/worktrees',
    ]);
    expect(deletions(calls)).toEqual([]);
  });

  test('a copy holding ignored files no other checkout holds stays; git would delete them unarchived', async () => {
    const { calls, result } = await run(
      {
        trees: withCopy({
          ignored: ['.tmp/', 'apps/server/.env'],
          ignoredInside: ['.tmp/plan.md'],
        }),
      },
      false,
    );
    expect(result?.notes).toEqual([
      report('trimmed', 0, '4.1'),
      `kept ${COPY}: 2 ignored files no other checkout holds`,
    ]);
    expect(deletions(calls)).toEqual(
      TRIMMED.map(path => `drop ${APP}/${path}`),
    );
  });

  test.each([
    [
      'a partial process listing',
      'lsof',
      exit(1, 'lsof: WARNING: can not read'),
    ],
    ['a failed docker ps', 'docker', exit(1, 'permission denied')],
    ['a failed ignored listing', 'ls-files', exit(128, 'fatal: index locked')],
    ['a failed size', 'du', exit(1, 'du: cannot read')],
  ])('%s fails the step and deletes nothing', async (_name, what, outcome) => {
    const { calls, result } = await run(
      {
        trees: withCopy(),
        fail: (command, args) =>
          command === what || args[3] === what ? outcome : undefined,
      },
      false,
    );
    expect(result?.ok).toBe(false);
    expect(deletions(calls)).toEqual([]);
  });

  test('a failure on the second look deletes nothing', async () => {
    let listings = 0;
    const { calls, result } = await run(
      {
        trees: withCopy(),
        fail: command => {
          if (command !== 'lsof') return undefined;
          listings += 1;
          return listings === 2 ? exit(1, 'lsof: WARNING') : undefined;
        },
      },
      false,
    );
    expect(result?.ok).toBe(false);
    expect(deletions(calls)).toEqual([]);
  });

  test.each([
    [{ status: ' M a.ts' }, 'uncommitted changes'],
    [{ remote: '' }, 'HEAD is on no remote branch'],
    [{ locked: true }, 'locked'],
    [{ touched: NOW }, `git activity in the last ${IDLE_DAYS} days`],
  ])(
    'a nested copy holding work (%o) stays; the rest is trimmed',
    async (copy, reason) => {
      const { calls, result } = await run({ trees: withCopy(copy) }, false);
      expect(result?.notes).toEqual([
        report('trimmed', 0, '4.1'),
        `kept ${COPY}: ${reason}`,
      ]);
      expect(deletions(calls)).toEqual(
        TRIMMED.map(path => `drop ${APP}/${path}`),
      );
    },
  );

  test('a copy git refuses to remove stays, and the report says so', async () => {
    const { result } = await run(
      {
        trees: withCopy(),
        fail: (command, args) =>
          command === 'git' && args[1] === 'remove'
            ? exit(128, 'fatal: contains untracked files')
            : undefined,
      },
      false,
    );
    expect(result?.notes).toEqual([
      report('trimmed', 0, '5.1'),
      `kept ${COPY}: git refused: exit 128: fatal: contains untracked files`,
    ]);
  });

  test('a gone copy is left to the prune step', async () => {
    const { calls, result } = await run(
      { trees: withCopy({ prunable: true }) },
      true,
    );
    expect(result?.notes).toEqual([report('would trim', 0, '4.1')]);
    expect(calls.some(call => call.includes(`-C ${COPY} `))).toBe(false);
  });

  test('an idle worktree with nothing rebuildable says so', async () => {
    const { calls, result } = await run(
      { trees: idleApp({ ignored: ['.tmp/'] }) },
      false,
    );
    expect(result?.notes).toEqual([`nothing to trim in ${APP}`]);
    expect(calls.some(call => call.startsWith('du '))).toBe(false);
  });

  test('sizes under a gigabyte read in MB, and the folder kinds present are named', async () => {
    const { result } = await run(
      { trees: idleApp({ ignored: ['apps/web/dist/'] }), kib: 2000 },
      true,
    );
    expect(result?.notes).toEqual([
      `would trim ${APP}: build output, 0 nested copies, 2.0 MB; folder and branch stay`,
    ]);
  });

  test('a du line that names no size adds nothing', async () => {
    const { result } = await run(
      {
        trees: idleApp({ ignored: ['apps/web/dist/'] }),
        fail: command =>
          command === 'du'
            ? ok(`du: warning\n3000\t${APP}/apps/web/dist\n`)
            : undefined,
      },
      true,
    );
    expect(result?.notes).toEqual([
      `would trim ${APP}: build output, 0 nested copies, 3.1 MB; folder and branch stay`,
    ]);
  });

  test('only markerless worktrees under .claude/worktrees are its own', async () => {
    const { calls, result } = await run(
      {
        trees: {
          agent: { touched: IDLE, ignored },
          codex: {
            at: '/Users/me/.codex/worktrees/ab/acme_mono',
            marker: false,
            touched: IDLE,
            ignored,
          },
          nogit: { marker: false, gitFile: null, ignored },
          gone: { marker: false, prunable: true },
          'gone-locked': { marker: false, locked: true, gone: true },
        },
      },
      true,
    );
    expect(result?.notes).toEqual([
      'no desktop-app session worktrees in /repo/.claude/worktrees',
    ]);
    expect(calls.some(call => call.startsWith('du '))).toBe(false);
  });
});
