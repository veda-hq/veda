/**
 * `sarathi worktree cleanup`: settings, the parsers and helpers, and which
 * worktrees are kept and why. The shared fake machine is in
 * cleanup.fixture.test.ts; the run and its steps are in cleanup.run.test.ts
 * and cleanup.steps.test.ts.
 */
import { describe } from 'node:test';
import { expect, it as test } from '../test/expect.test.ts';
import { main } from '../cli.ts';
import { projectName } from '../services/reaper.ts';
import { type SweepRequest } from '../services/prune.ts';
import { failure, type ChildOutcome } from '../services/run-child.ts';
import {
  COMMAND_TIMEOUT_MS,
  DAEMON_TIMEOUT_MS,
  IDLE_DAYS,
  SETTINGS_OFF,
  USAGE,
  archiveDir,
  cleanup,
  cleanupMain,
  cli,
  gitdirOf,
  inside,
  keepReason,
  parseCwds,
  parseWorktrees,
  REBUILT,
  reclaimed,
  shellWord,
  type Worktree,
} from './cleanup.ts';
import {
  COPY_DIR,
  COPY_SOURCE,
  COPY_NAME,
  SERVICES,
  SETTINGS,
  BARE,
  NOW,
  DAY,
  OLD,
  PRIMARY,
  WT,
  SELF,
  COMMON,
  AT,
  ok,
  exit,
  type Fixture,
  STRAY,
  BUILT_PATHS,
  harness,
  stepOf,
} from './cleanup.fixture.test.ts';

describe('archiveDir', () => {
  test('sits in the common git directory, named for the project', () => {
    expect(archiveDir('acme')).toBe('.git/acme/worktree-archive');
    expect(archiveDir('sarathi')).toBe('.git/sarathi/worktree-archive');
  });
});

describe('settings', () => {
  test('a pattern as JSON writes it compiles to the nested-copy pattern', () => {
    expect(COPY_SOURCE).toBe(String.raw`^\.wt\/copy(?:-\d{15}-\d{8})?$`);
    expect(SETTINGS.cleanup?.nestedCopies).toBe(COPY_SOURCE);
  });

  test('settings that cannot be read run no step and fail the run', async () => {
    const { env, calls, lines } = harness({
      trees: { 'agent-old': {} },
      settingsFail: new Error('.claude/sarathi.json is not JSON'),
    });
    expect(await cli([], env)).toBe(1);
    expect(lines).toEqual(['✗ settings', '    .claude/sarathi.json is not JSON']);
    expect(calls).toEqual([
      `git rev-parse --path-format=absolute --git-common-dir @${COMMAND_TIMEOUT_MS}`,
      `settings ${PRIMARY}`,
    ]);
  });

  test('an unreadable common git directory runs no step either', async () => {
    const { env, lines } = harness({
      trees: {},
      fail: (command, args) =>
        command === 'git' && args.includes('--git-common-dir')
          ? exit(128, 'fatal: not a git repository')
          : undefined,
    });
    const results = await cleanup(env, true);
    expect(results.map(result => result.step)).toEqual(['settings']);
    expect(lines[0]).toBe('✗ settings');
  });

  test('a project that sets nothing gets the steps every project has, and each machine step skipped', async () => {
    const { env, calls, lines } = harness({
      trees: { outer: {}, inner: { at: `outer/${COPY_DIR}` } },
      settings: BARE,
      ndks: [{ name: STRAY, made: OLD, bytes: 1 }],
      staged: 2e9,
      built: BUILT_PATHS,
    });
    const results = await cleanup(env, false);
    expect(results.every(result => result.ok)).toBe(true);
    // No pattern: the folder inside is a worktree of its own, which keeps its parent.
    expect(lines).toContain(`    kept ${WT}/outer: it holds ${WT}/outer/${COPY_DIR}`);
    expect(stepOf(results, 'docker staged update')?.skipped).toBe(SETTINGS_OFF);
    expect(stepOf(results, 'android NDKs')?.skipped).toBe(SETTINGS_OFF);
    expect(stepOf(results, 'caches')?.notes).toEqual([
      'pnpm store pruned',
      `skipped xcrun simctl delete unavailable: ${SETTINGS_OFF}`,
      `skipped brew cleanup: ${SETTINGS_OFF}`,
      `skipped primary build output: ${SETTINGS_OFF}`,
      `skipped Gradle caches: ${SETTINGS_OFF}`,
    ]);
    // No services file: no stack to look for, no sweep, and the build cache still goes.
    expect(stepOf(results, 'docker')?.notes).toEqual([
      'skipped the hourly sweep: .claude/sarathi.json names no services file (worktree.services)',
      'build cache: 640.5GB freed of 792.3GB',
    ]);
    expect(calls.some(call => call.startsWith('docker ps'))).toBe(false);
    expect(calls.some(call => call.startsWith('services '))).toBe(false);
    expect(calls.some(call => call.startsWith('sweep '))).toBe(false);
    expect(calls.filter(call => /^(?:drop|xcrun|brew)/.test(call))).toEqual([]);
    expect(lines).toContain(`– android NDKs (skipped: ${SETTINGS_OFF})`);
  });
});

describe('docker step: the sweep', () => {
  test('it gets the project names, the docker on PATH and the primary checkout', async () => {
    const requests: SweepRequest[] = [];
    const { env } = harness({
      trees: {},
      sweep: request => {
        requests.push(request);
        return { kind: 'swept', results: [] };
      },
    });
    await cleanup(env, true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      docker: '/usr/local/bin/docker',
      settings: { name: 'acme', primary: PRIMARY, ...SERVICES },
      dryRun: true,
    });
    expect(requests[0]?.run).toBe(env.run);
    expect(requests[0]?.now).toBe(env.now);
  });

  test('a dry run lists what the sweep would run; a failed sweep step is noted, not failed', async () => {
    const { env } = harness({
      trees: {},
      sweep: request => {
        request.print('would run: docker volume rm acme-0123456789abcdef_db');
        return {
          kind: 'swept',
          results: [
            { step: 'containers', ok: true },
            { step: 'images', ok: false, error: 'docker image ls: exit 1' },
          ],
        };
      },
    });
    expect(stepOf(await cleanup(env, true), 'docker')).toEqual({
      step: 'docker',
      ok: true,
      notes: [
        'previewed the hourly sweep (sarathi services prune)',
        'sweep step images failed: docker image ls: exit 1',
        'would run: docker volume rm acme-0123456789abcdef_db',
        'would prune all unused build cache (792.3GB)',
      ],
    });
  });

  test('a sweep that finds no daemon is noted, and the build cache still goes', async () => {
    const { env, calls } = harness({
      trees: {},
      sweep: () => ({ kind: 'skipped', reason: 'docker: exit 1' }),
    });
    expect(stepOf(await cleanup(env, false), 'docker')?.notes).toEqual([
      'skipped the hourly sweep: docker: exit 1',
      'build cache: 640.5GB freed of 792.3GB',
    ]);
    expect(calls).toContain(`docker buildx prune --all --force @${COMMAND_TIMEOUT_MS}`);
  });

  test('no docker on PATH fails the step', async () => {
    const { env } = harness({
      trees: {},
      fail: command => (command === '/usr/bin/which' ? exit(1) : undefined),
    });
    expect(stepOf(await cleanup(env, false), 'docker')).toEqual({
      step: 'docker',
      ok: false,
      notes: ['/usr/bin/which docker: exit 1'],
    });
  });
});

describe('sarathi worktree cleanup', () => {
  test('the CLI dispatches it, and a bad flag exits 2 with the usage', async () => {
    const out: string[] = [];
    const code = await main({
      argv: ['worktree', 'cleanup', '--bogus'],
      env: {},
      cwd: '/nowhere',
      readStdin: async () => '',
      out: text => out.push(text),
      err: text => out.push(text),
    });
    expect(code).toBe(2);
    expect(out).toEqual([`${USAGE}\n`]);
  });

  test('cleanupMain runs the CLI on the default environment', async () => {
    const out: string[] = [];
    expect(await cleanupMain(['--nope'], { cwd: '/nowhere', env: {}, out: text => out.push(text) })).toBe(2);
    expect(out).toEqual([`${USAGE}\n`]);
  });
});

describe('COPY_NAME', () => {
  test('matches the nested copy and its numbered successors only', () => {
    expect(COPY_NAME.test(COPY_DIR)).toBe(true);
    expect(COPY_NAME.test(`${COPY_DIR}-123456789012345-12345678`)).toBe(true);
    expect(COPY_NAME.test(`${COPY_DIR}-1`)).toBe(false);
    expect(COPY_NAME.test('.wt/other')).toBe(false);
    expect(COPY_NAME.test(`x/${COPY_DIR}`)).toBe(false);
  });
});

describe('REBUILT', () => {
  test.each([
    'node_modules/',
    'apps/web/node_modules/',
    '.turbo/',
    'a/.cache/x',
    'scripts/lib/__pycache__/',
    'apps/server/dist/',
    'dist',
    'apps/mobile/android/app/build/',
    'apps/mobile/ios/build/Build/x.o',
    'packages/work-continuity/native/.build/',
    'apps/mobile/android/app/.cxx/',
    'apps/mobile/android/.gradle/',
    '.tmp/node-compile-cache/',
    'coverage/',
    'apps/web/reports/',
    '.stryker-tmp/',
    '.eslintcache',
    'apps/mobile/.eslintcache',
    'apps/server/tsconfig.build.tsbuildinfo',
    'stryker.log',
    'apps/mobile/stryker.log',
    '.DS_Store',
    '.claude/.DS_Store',
    '.husky/_/',
    '.husky/_/pre-push',
    // `pod install` makes them again (about 7 GB per worktree, measured).
    'apps/mobile/ios/Pods/',
    'apps/mobile/ios/Pods/Headers/Public/x.h',
    'ios/Pods',
  ])('%s is rebuilt', path => {
    expect(REBUILT.test(path)).toBe(true);
  });

  test.each([
    '.tmp/',
    '.tmp/plan.md',
    '.local/claude.env',
    'xdist/',
    'dist2',
    'rebuild/',
    'buildx/',
    'a.build',
    '.gradle-old/',
    '.tmp/node-compile-cache-x/',
    'mydist/a',
    'a.tsbuildinfo.bak',
    'stryker.log.old',
    'mystryker.log',
    'x.DS_Store',
    'a/.husky/_/pre-push',
    '.husky/_x',
    '.husky/x',
    'reportsX/',
    'Pods/',
    'apps/mobile/ios/PodsX/',
    'apps/mobile/ios/Podfile.lock',
    'apps/mobile/myios/Pods/',
  ])('%s is not', path => {
    expect(REBUILT.test(path)).toBe(false);
  });
});

describe('parseWorktrees', () => {
  test('reads paths, locks and prunable folders, primary first', () => {
    expect(
      parseWorktrees(
        'worktree /repo\nHEAD a\nbranch refs/heads/main\n\nworktree /repo/w1\nHEAD b\ndetached\nlocked\n\nworktree /repo/w2\nHEAD c\nlocked reason\nprunable gitdir file points to non-existent location\n\nworktree /repo/w3\nHEAD d\nbranch refs/heads/lockedish\n',
      ),
    ).toEqual([
      { path: '/repo', locked: false, prunable: false },
      { path: '/repo/w1', locked: true, prunable: false },
      {
        path: '/repo/w2',
        locked: true,
        lockReason: 'reason',
        prunable: true,
      },
      { path: '/repo/w3', locked: false, prunable: false },
    ]);
  });

  test('a lock reason is read whole; a bare lock has none', () => {
    const [locked, bare] = parseWorktrees(
      'worktree /a\nlocked initializing: codex agent 42\n\nworktree /b\nlocked\n',
    );
    expect(locked?.lockReason).toBe('initializing: codex agent 42');
    expect(bare).toEqual({ path: '/b', locked: true, prunable: false });
  });

  test('ignores blocks that name no worktree', () => {
    expect(parseWorktrees('\n\nHEAD a\n\n')).toEqual([]);
  });
});

describe('shellWord', () => {
  test.each([
    [
      '/private/tmp/acme-codex-agent-integration',
      '/private/tmp/acme-codex-agent-integration',
    ],
    ['/a/b_c.d/e@f%g+h=i:j,k', '/a/b_c.d/e@f%g+h=i:j,k'],
    ['/a b', "'/a b'"],
    ["/it's", "'/it'\\''s'"],
    ['/a;rm -rf ~', "'/a;rm -rf ~'"],
    ['/$(x)`y`', "'/$(x)`y`'"],
    ['', "''"],
  ])('%s reads %s', (text, word) => {
    expect(shellWord(text)).toBe(word);
  });
});

describe('parseCwds', () => {
  test('keeps only absolute name lines', () => {
    expect(
      parseCwds('p12\nfcwd\nn/Users/a\np13\nfcwd\nn /x\nnrelative\nn/b c\n'),
    ).toEqual(['/Users/a', '/b c']);
  });
});

describe('inside', () => {
  test('the folder itself and paths under it, never a sibling prefix', () => {
    expect(inside('/a/b', '/a/b')).toBe(true);
    expect(inside('/a/b/c', '/a/b')).toBe(true);
    expect(inside('/a/bc', '/a/b')).toBe(false);
    expect(inside('/a', '/a/b')).toBe(false);
  });
});

describe('failure', () => {
  const base = { stdout: '', stderrTail: '' };
  test.each<[Exclude<ChildOutcome, { kind: 'ok' }>, string]>([
    [
      { ...base, kind: 'exit', code: 3, stderrTail: 'first\nlast line\n' },
      'exit 3: last line',
    ],
    [
      { ...base, kind: 'signal', signal: 'SIGTERM', code: 143 },
      'signal SIGTERM',
    ],
    [
      { ...base, kind: 'timeout', timeoutMs: 5, code: 124 },
      'timed out after 5 ms',
    ],
    [
      {
        ...base,
        kind: 'spawn-error',
        errno: 'ENOENT',
        message: 'spawn x ENOENT',
        code: 127,
      },
      'spawn x ENOENT',
    ],
  ])('%j', (outcome, expected) => {
    expect(failure(outcome)).toBe(expected);
  });
});

describe('reclaimed', () => {
  test('the Total line, or 0B without one', () => {
    expect(reclaimed('ID\tSIZE\nx\t1GB\nTotal:\t640.5GB\n')).toBe('640.5GB');
    expect(reclaimed('ID\tSIZE\n')).toBe('0B');
    expect(reclaimed('Grand Total: 5GB')).toBe('0B');
  });
});

describe('gitdirOf', () => {
  test('resolves a relative pointer against the worktree', () => {
    const { env } = harness({
      trees: { a: { gitFile: 'gitdir: ../../../.git/worktrees/a\n' } },
    });
    expect(gitdirOf(env, `${WT}/a`)).toBe(`${COMMON}/a`);
  });

  test('undefined for a missing or pointerless .git file', () => {
    const { env } = harness({
      trees: { a: { gitFile: null }, b: { gitFile: 'not a pointer' } },
    });
    expect(gitdirOf(env, `${WT}/a`)).toBeUndefined();
    expect(gitdirOf(env, `${WT}/b`)).toBeUndefined();
  });
});

describe('keepReason', () => {
  const tree = (path: string, extra: Partial<Worktree> = {}): Worktree => ({
    path,
    locked: false,
    prunable: false,
    ...extra,
  });

  describe('ignored files', () => {
    test('rebuilt output and copies of the primary checkout lose nothing', async () => {
      const { env, calls, losslessCalls } = harness({
        trees: {
          x: {
            ignored: ['node_modules/', 'apps/server/.env', '.local/', '.wt/'],
            ignoredInside: ['.local/claude.env', '.wt/copy/'],
          },
        },
        shared: ['apps/server/.env', '.local/claude.env'],
      });
      expect(await keepReason(env, tree(`${WT}/x`), AT)).toBeUndefined();
      expect(calls).toContain(
        `git --no-optional-locks -C ${WT}/x ls-files --others --ignored --exclude-standard -z --directory @${COMMAND_TIMEOUT_MS}`,
      );
      expect(calls).toContain(
        `git --no-optional-locks -C ${WT}/x ls-files --others --ignored --exclude-standard -z -- :(literal).local/ :(literal).wt/ @${COMMAND_TIMEOUT_MS}`,
      );
      expect(losslessCalls).toEqual([
        `${WT}/x/apps/server/.env ${PRIMARY}/apps/server/.env`,
        `${WT}/x/.local/claude.env ${PRIMARY}/.local/claude.env`,
      ]);
    });

    test('with no ignored folder left, nothing is listed inside', async () => {
      const { env, calls } = harness({
        trees: { x: { ignored: ['node_modules/', '.eslintcache'] } },
      });
      expect(await keepReason(env, tree(`${WT}/x`), AT)).toBeUndefined();
      expect(calls.filter(call => call.includes(' -- '))).toEqual([]);
    });

    test('scratch files and changed credentials do not keep it', async () => {
      const { env } = harness({
        trees: {
          x: {
            ignored: ['.tmp/', 'apps/server/.env'],
            ignoredInside: ['.tmp/plan.md'],
          },
        },
      });
      expect(await keepReason(env, tree(`${WT}/x`), AT)).toBeUndefined();
    });

    test('a nested checkout that is no nested copy keeps the worktree', async () => {
      const { env } = harness({
        trees: { x: { ignored: ['.wt/'], ignoredInside: ['.wt/other/'] } },
      });
      expect(await keepReason(env, tree(`${WT}/x`), AT)).toBe(
        'it holds a checkout git does not list: .wt/other/',
      );
    });

    test('a checkout nested in a nested copy keeps its parent', async () => {
      const { env, lines } = harness({
        trees: {
          outer: {},
          'outer-copy': {
            at: 'outer/.wt/copy',
            ignored: ['vendor/'],
            ignoredInside: ['vendor/lib/'],
          },
        },
      });
      await cleanup(env, true);
      expect(lines[1]).toBe(
        `    kept ${WT}/outer: ${WT}/outer/.wt/copy: it holds a checkout git does not list: vendor/lib/`,
      );
    });
  });

  describe('archiving ignored files', () => {
    const ARCHIVED = `${PRIMARY}/.git/acme/worktree-archive/outer`;
    const fixture = (archiveFails = false): Fixture => ({
      trees: {
        outer: {
          ignored: ['.tmp/', 'apps/server/.env', 'apps/web/.env'],
          ignoredInside: ['.tmp/plan.md', '.tmp/a.sql'],
        },
        'outer-copy': {
          at: 'outer/.wt/copy',
          ignored: ['.tmp/'],
          ignoredInside: ['.tmp/log.txt'],
        },
      },
      shared: ['apps/web/.env'],
      archiveFails,
    });

    test('a dry run counts them and copies nothing', async () => {
      const { env, calls, lines } = harness(fixture());
      await cleanup(env, true);
      expect(lines[1]).toBe(
        `    would remove ${WT}/outer, 4 ignored files to ${ARCHIVED}`,
      );
      expect(calls.filter(call => call.startsWith('archive'))).toEqual([]);
    });

    const copied = [
      `archive ${WT}/outer/apps/server/.env ${ARCHIVED}/apps/server/.env`,
      `archive ${WT}/outer/.tmp/plan.md ${ARCHIVED}/.tmp/plan.md`,
      `archive ${WT}/outer/.tmp/a.sql ${ARCHIVED}/.tmp/a.sql`,
      `archive ${WT}/outer/.wt/copy/.tmp/log.txt ${ARCHIVED}/.wt/copy/.tmp/log.txt`,
    ];

    test('a real run copies each, the copy’s too, twice, before any removal', async () => {
      const { env, calls, lines } = harness(fixture());
      await cleanup(env, false);
      expect(
        calls.filter(call => /^(archive|git worktree remove)/.test(call)),
      ).toEqual([
        ...copied,
        ...copied,
        `git worktree remove ${WT}/outer/.wt/copy @${COMMAND_TIMEOUT_MS}`,
        `git worktree remove ${WT}/outer @${COMMAND_TIMEOUT_MS}`,
      ]);
      expect(lines[1]).toBe(
        `    removed ${WT}/outer, 4 ignored files to ${ARCHIVED}`,
      );
    });

    test('a failed copy fails the step and removes nothing', async () => {
      const { env, calls } = harness(fixture(true));
      const results = await cleanup(env, false);
      expect(results[0]).toEqual({
        step: 'leftover worktrees',
        ok: false,
        notes: [`${ARCHIVED}/apps/server/.env already holds other bytes`],
      });
      expect(
        calls.filter(call => call.startsWith('git worktree remove')),
      ).toEqual([]);
    });

    test('a session that starts while files are copied keeps it: a second look', async () => {
      let lists = 0;
      const { env, calls, lines } = harness({
        ...fixture(),
        fail: command => {
          if (command !== 'lsof') return undefined;
          lists += 1;
          return lists === 2 ? ok(`p1\nn${WT}/outer/apps\n`) : undefined;
        },
      });
      await cleanup(env, false);
      expect(lines[1]).toBe(
        `    kept ${WT}/outer: a process works in it, on a second look`,
      );
      expect(calls.filter(call => call.startsWith('archive'))).toHaveLength(4);
      expect(
        calls.filter(call => call.startsWith('git worktree remove')),
      ).toEqual([]);
      // The first listing, the second look's, then the archive sweep's; later
      // steps list on their own.
      const prune = calls.findIndex(call =>
        call.startsWith('git worktree prune'),
      );
      expect(
        calls
          .slice(0, prune)
          .filter(call => call.startsWith('git worktree list')),
      ).toHaveLength(3);
    });

    test('a worktree gone from the second listing is left alone', async () => {
      let lists = 0;
      const { env, calls, lines } = harness({
        ...fixture(),
        fail: (command, args) => {
          if (command !== 'git' || args[1] !== 'list') return undefined;
          lists += 1;
          return lists === 2 ? ok(`worktree ${PRIMARY}\nHEAD a\n`) : undefined;
        },
      });
      await cleanup(env, false);
      expect(lines[1]).toBe(
        `    kept ${WT}/outer: it left git worktree list, on a second look`,
      );
      expect(
        calls.filter(call => call.startsWith('git worktree remove')),
      ).toEqual([]);
    });

    /** Runs `change` on the fixture when the second listing is taken. */
    const onSecondLook = (change: (it: Fixture) => void) => {
      const it = fixture();
      let lists = 0;
      it.fail = (command, args) => {
        if (command === 'git' && args[1] === 'list' && ++lists === 2)
          change(it);
        return undefined;
      };
      return it;
    };

    test('a file written during the second look is archived and counted', async () => {
      const { env, calls, lines } = harness(
        onSecondLook(it => it.trees.outer?.ignored?.push('late.log')),
      );
      await cleanup(env, false);
      expect(calls.filter(call => call.startsWith('archive'))).toEqual([
        ...copied,
        copied[0],
        `archive ${WT}/outer/late.log ${ARCHIVED}/late.log`,
        ...copied.slice(1),
      ]);
      expect(lines[1]).toBe(
        `    removed ${WT}/outer, 5 ignored files to ${ARCHIVED}`,
      );
    });

    test('a file rewritten during the second look fails the step', async () => {
      const { env, calls } = harness(
        onSecondLook(it => {
          it.archiveFails = true;
        }),
      );
      const results = await cleanup(env, false);
      expect(results[0]?.ok).toBe(false);
      expect(calls.filter(call => call.startsWith('archive'))).toHaveLength(5);
      expect(
        calls.filter(call => call.startsWith('git worktree remove')),
      ).toEqual([]);
    });

    test('a copy git will not remove unforced keeps the worktree', async () => {
      const refusal =
        "fatal: '.wt/copy' contains modified or untracked files, use --force to delete it";
      const { env, calls, lines } = harness({
        ...fixture(),
        fail: (command, args) =>
          command === 'git' &&
          args[1] === 'remove' &&
          args[2] === `${WT}/outer/.wt/copy`
            ? exit(128, refusal)
            : undefined,
      });
      const results = await cleanup(env, false);
      expect(results[0]?.ok).toBe(true);
      expect(lines[1]).toBe(
        `    kept ${WT}/outer: git refused ${WT}/outer/.wt/copy: exit 128: ${refusal}`,
      );
      expect(
        calls.filter(call => call.startsWith('git worktree remove')),
      ).toEqual([
        `git worktree remove ${WT}/outer/.wt/copy @${COMMAND_TIMEOUT_MS}`,
      ]);
    });

    test('a worktree git will not remove is kept, and the next still goes', async () => {
      const { env, calls, lines } = harness({
        trees: { a: {}, b: {} },
        fail: (command, args) =>
          command === 'git' && args[1] === 'remove' && args[2] === `${WT}/a`
            ? exit(128, 'fatal: a is dirty')
            : undefined,
      });
      const results = await cleanup(env, false);
      expect(results[0]?.ok).toBe(true);
      expect(lines.slice(1, 3)).toEqual([
        `    kept ${WT}/a: git refused ${WT}/a: exit 128: fatal: a is dirty`,
        `    removed ${WT}/b`,
      ]);
      expect(
        calls.filter(call => call.startsWith('git worktree remove')),
      ).toEqual([
        `git worktree remove ${WT}/a @${COMMAND_TIMEOUT_MS}`,
        `git worktree remove ${WT}/b @${COMMAND_TIMEOUT_MS}`,
      ]);
    });

    test('nothing to archive says nothing about it', async () => {
      const { env, lines } = harness({ trees: { outer: {} } });
      await cleanup(env, false);
      expect(lines[1]).toBe(`    removed ${WT}/outer`);
    });
  });

  describe('running dev services', () => {
    test('its own running stack keeps it; another worktree’s does not', async () => {
      const mine = harness({
        trees: { x: {} },
        services: ['other', projectName(SERVICES.project, `${WT}/x`)],
      });
      expect(await keepReason(mine.env, tree(`${WT}/x`), AT)).toBe(
        'its dev services are running',
      );
      expect(mine.calls).not.toContain(
        `lsof -d cwd -Fn @${COMMAND_TIMEOUT_MS}`,
      );
      const theirs = harness({
        trees: { x: {} },
        services: [projectName(SERVICES.project, `${WT}/y`)],
      });
      expect(await keepReason(theirs.env, tree(`${WT}/x`), AT)).toBeUndefined();
    });

    test.each<[string, ChildOutcome]>([
      [
        'no docker binary',
        {
          kind: 'spawn-error',
          errno: 'ENOENT',
          message: 'spawn docker ENOENT',
          code: 127,
          stdout: '',
          stderrTail: '',
        },
      ],
      [
        'no daemon',
        exit(
          1,
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
        ),
      ],
    ])('%s: nothing runs', async (_name, outcome) => {
      const { env } = harness({
        trees: { x: {} },
        fail: (command, args) =>
          command === 'docker' && args[0] === 'ps' ? outcome : undefined,
      });
      expect(await keepReason(env, tree(`${WT}/x`), AT)).toBeUndefined();
    });

    test('any other docker ps failure throws: no worktree is judged unused', async () => {
      const { env } = harness({
        trees: { x: {} },
        fail: (command, args) =>
          command === 'docker' && args[0] === 'ps'
            ? exit(1, 'permission denied')
            : undefined,
      });
      await expect(keepReason(env, tree(`${WT}/x`), AT)).rejects.toThrow(
        'docker ps: exit 1: permission denied',
      );
    });
  });

  test.each<[string, Fixture['trees'][string], string[], string | undefined]>([
    ['removable when every check passes', {}, [], undefined],
    ['locked', { locked: true }, [], 'locked'],
    ['no gitdir', { gitFile: null }, [], 'its .git file names no gitdir'],
    [
      'the app made it',
      { marker: false },
      [],
      'a desktop-app session worktree',
    ],
    [
      'touched just now',
      { touched: NOW - 1 },
      [],
      `git activity in the last ${IDLE_DAYS} days`,
    ],
    [
      'touched exactly at the limit',
      { touched: NOW - IDLE_DAYS * DAY },
      [],
      undefined,
    ],
    [
      'touched just inside the limit',
      { touched: NOW - IDLE_DAYS * DAY + 1 },
      [],
      `git activity in the last ${IDLE_DAYS} days`,
    ],
    ['a process inside', {}, [`${WT}/x/apps/server`], 'a process works in it'],
    ['a process in a sibling with a longer name', {}, [`${WT}/xy`], undefined],
    ['dirty', { status: '?? new.ts' }, [], 'uncommitted or untracked files'],
    ['unpushed', { remote: '' }, [], 'HEAD is on no remote branch'],
  ])('%s', async (_name, options, cwds, expected) => {
    const { env } = harness({ trees: { x: options }, cwds });
    const locked = options.locked === true;
    expect(await keepReason(env, tree(`${WT}/x`, { locked }), AT)).toBe(
      expected,
    );
  });

  test('the running checkout, and any worktree containing it', async () => {
    const { env } = harness({ trees: { self: {} } });
    expect(await keepReason(env, tree(SELF), AT)).toBe('this checkout');
    expect(await keepReason(env, tree(WT), AT)).toBe('this checkout');
  });

  test('a prunable registration is left to git worktree prune', async () => {
    const { env } = harness({ trees: { x: {} } });
    expect(await keepReason(env, tree(`${WT}/x`, { prunable: true }), AT)).toBe(
      'its folder is gone',
    );
  });

  test('a locked registration whose folder is gone says how to prune it, never unlocking it', async () => {
    const path = '/private/tmp/acme-codex-agent-integration';
    const { env, calls } = harness({
      trees: { codex: { at: path, locked: true, gone: true } },
    });
    expect(
      await keepReason(
        env,
        tree(path, { locked: true, lockReason: 'codex agent' }),
        AT,
      ),
    ).toBe(
      `registered but gone, locked by codex agent: \`git worktree unlock ${path}\` then \`sarathi worktree cleanup\` prunes it`,
    );
    expect(await keepReason(env, tree(path, { locked: true }), AT)).toBe(
      `registered but gone, locked with no reason given: \`git worktree unlock ${path}\` then \`sarathi worktree cleanup\` prunes it`,
    );
    expect(calls).toEqual([]);
  });

  test('the unlock command quotes a path the shell would split or read as syntax', async () => {
    const path = "/Users/me/my trees/it's $HOME";
    const { env } = harness({
      trees: { odd: { at: path, locked: true, gone: true } },
    });
    expect(await keepReason(env, tree(path, { locked: true }), AT)).toBe(
      `registered but gone, locked with no reason given: \`git worktree unlock '/Users/me/my trees/it'\\''s $HOME'\` then \`sarathi worktree cleanup\` prunes it`,
    );
  });

  test('a locked worktree whose folder is there stays as locked', async () => {
    const { env } = harness({ trees: { x: { locked: true } } });
    expect(
      await keepReason(
        env,
        tree(`${WT}/x`, { locked: true, lockReason: 'claude agent' }),
        AT,
      ),
    ).toBe('locked');
  });

  test.each([
    '/Users/me/.codex/worktrees/ab12/acme_mono',
    '/repo/.claude/worktrees-old/x',
    '/repo/.claude/other/x',
  ])(
    'a markerless worktree outside .claude/worktrees is not the app’s: %s',
    async path => {
      const { env } = harness({ trees: { x: { at: path, marker: false } } });
      expect(await keepReason(env, tree(path), AT)).toBe(
        'not made by Claude Code',
      );
    },
  );

  test('reads activity from HEAD and the index, never the reflog', async () => {
    const { env } = harness({ trees: { x: {} } });
    const seen: string[] = [];
    const mtime = env.mtime;
    env.mtime = path => {
      seen.push(path.slice(`${COMMON}/x/`.length));
      return mtime(path);
    };
    await keepReason(env, tree(`${WT}/x`), AT);
    expect(seen).toEqual(['HEAD', 'index']);
  });

  test.each(['HEAD', 'index'])(
    'an unreadable %s time keeps the worktree: inactivity is unproven',
    async unreadable => {
      const { env, calls } = harness({ trees: { x: {} } });
      const mtime = env.mtime;
      env.mtime = path =>
        path === `${COMMON}/x/${unreadable}` ? undefined : mtime(path);
      expect(await keepReason(env, tree(`${WT}/x`), AT)).toBe(
        'when git last touched it cannot be read',
      );
      expect(calls).toEqual([]);
    },
  );

  test('git runs without optional locks, and the in-use listings come last', async () => {
    const { env, calls } = harness({ trees: { x: {} } });
    await keepReason(env, tree(`${WT}/x`), AT);
    expect(calls).toEqual([
      `git --no-optional-locks -C ${WT}/x status --porcelain --untracked-files=all @${COMMAND_TIMEOUT_MS}`,
      `git --no-optional-locks -C ${WT}/x for-each-ref --count=1 --contains HEAD --format=%(refname) refs/remotes @${COMMAND_TIMEOUT_MS}`,
      `git --no-optional-locks -C ${WT}/x ls-files --others --ignored --exclude-standard -z --directory @${COMMAND_TIMEOUT_MS}`,
      `docker ps --format {{.Label "com.docker.compose.project"}} @${DAEMON_TIMEOUT_MS}`,
      `lsof -d cwd -Fn @${COMMAND_TIMEOUT_MS}`,
    ]);
  });

  test('a git failure throws, naming the command', async () => {
    const { env } = harness({
      trees: { x: {} },
      fail: (command, args) =>
        args[3] === 'status'
          ? exit(128, 'fatal: not a git repository')
          : undefined,
    });
    await expect(keepReason(env, tree(`${WT}/x`), AT)).rejects.toThrow(
      `git --no-optional-locks -C ${WT}/x status --porcelain --untracked-files=all: exit 128: fatal: not a git repository`,
    );
  });

  test('a clean lsof listing counts', async () => {
    const { env } = harness({
      trees: { x: {} },
      fail: command => (command === 'lsof' ? ok(`p1\nn${WT}/x\n`) : undefined),
    });
    expect(await keepReason(env, tree(`${WT}/x`), AT)).toBe(
      'a process works in it',
    );
  });

  test.each<[string, ChildOutcome, string]>([
    [
      'exit 1, some processes unread',
      exit(1, 'lsof: WARNING: can not read', `p1\nn${WT}/y\n`),
      'exit 1: lsof: WARNING: can not read',
    ],
    ['exit 2', exit(2, 'lsof: bad option'), 'exit 2: lsof: bad option'],
    [
      'a timeout',
      { kind: 'timeout', timeoutMs: 7, code: 124, stdout: '', stderrTail: '' },
      'timed out after 7 ms',
    ],
    [
      'a missing binary',
      {
        kind: 'spawn-error',
        errno: 'ENOENT',
        message: 'spawn lsof ENOENT',
        code: 127,
        stdout: '',
        stderrTail: '',
      },
      'spawn lsof ENOENT',
    ],
  ])(
    'a failed lsof listing (%s) throws: no worktree is judged unused',
    async (_name, outcome, reason) => {
      const { env } = harness({
        trees: { x: {} },
        fail: command => (command === 'lsof' ? outcome : undefined),
      });
      await expect(keepReason(env, tree(`${WT}/x`), AT)).rejects.toThrow(
        `lsof -d cwd -Fn: ${reason}`,
      );
    },
  );
});
