/**
 * `sarathi worktree cleanup`: the git-ai folders, worktree archive, Android
 * NDKs and Docker staged update steps, the CLI, and the default Env on a real
 * folder, over the fake machine in cleanup.fixture.test.ts.
 */
import {
  lstatSync,
  mkdirSync,
  rmSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statfsSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe } from 'node:test';
import { expect, it as test } from '../test/expect.test.ts';
import { sweepOnce } from '../services/prune.ts';
import type { ChildOutcome } from '../services/run-child.ts';
import { readSettings } from './settings.ts';
import {
  COMMAND_TIMEOUT_MS,
  USAGE,
  androidHomeIn,
  cleanup,
  cli,
  defaultEnv,
  ndkPins,
  madeAt,
  sameBytes,
  toDrop,
  folderFacts,
  ARCHIVE_CAP_BYTES,
  ARCHIVE_KEEP_DAYS,
  type ArchivedFolder,
  type StepResult,
} from './cleanup.ts';
import {
  NOW,
  DAY,
  OLD,
  PRIMARY,
  WT,
  COMMON,
  GIT_AI_DIR,
  DOCKER_INSTALL,
  exit,
  type Fixture,
  SDK,
  PINNED,
  STRAY,
  GRADLE,
  pins,
  NO_NDK_DIR,
  writeAt,
  harness,
} from './cleanup.fixture.test.ts';

describe('git-ai folders step', () => {
  const ai = (name: string, bytes = 1e6): ArchivedFolder => ({
    name,
    made: OLD,
    bytes,
  });
  // A listed worktree, one whose gitdir name differs from its basename, a
  // folder git forgot (agent-af1305710e69ad33b, seen on a real machine),
  // the primary, and two folders nothing names.
  const fixture: Fixture = {
    trees: {
      self: {},
      'agent-old': {},
      gitdir2: { at: 'nested/by-basename' },
    },
    appFolders: ['agent-af1305710e69ad33b'],
    aiFolders: [
      ai('agent-old'),
      ai('gitdir2'),
      ai('by-basename'),
      ai('agent-af1305710e69ad33b'),
      ai('repo'),
      ai('stale-a', 0.5e9),
      ai('stale-b', 2e9),
    ],
  };
  const step = (results: StepResult[]) =>
    results.find(result => result.step === 'git-ai folders');

  test('a dry run counts the stale folders and their bytes, and deletes none', async () => {
    const { env, calls } = harness(fixture);
    expect(step(await cleanup(env, true))).toEqual({
      step: 'git-ai folders',
      ok: true,
      notes: [
        'would delete 2 git-ai folders, 2.5 GB',
        `5 kept: named after a listed worktree (repo included), its gitdir, or a folder in ${WT}`,
      ],
    });
    expect(calls.filter(call => call.startsWith('drop '))).toEqual([]);
  });

  test('a real run deletes only the folders nothing names', async () => {
    const { env, calls } = harness(fixture);
    expect(step(await cleanup(env, false))?.notes[0]).toBe(
      'deleted 2 git-ai folders, 2.5 GB',
    );
    expect(calls.filter(call => call.startsWith('drop '))).toEqual([
      `drop ${GIT_AI_DIR}/stale-a`,
      `drop ${GIT_AI_DIR}/stale-b`,
    ]);
  });

  test('the folders are listed before what keeps them, so a worktree made meanwhile keeps its own', async () => {
    const { env, calls } = harness(fixture);
    await cleanup(env, false);
    const listed = calls.indexOf(`list-archive ${GIT_AI_DIR}`);
    const after = calls.slice(listed);
    expect(listed).toBeGreaterThan(0);
    expect(after.some(call => call.startsWith('git worktree list'))).toBe(true);
    expect(after).toContain(`names ${COMMON}`);
    expect(after).toContain(`names ${WT}`);
  });

  test('none stale says so', async () => {
    const { env, calls } = harness({
      ...fixture,
      aiFolders: [ai('agent-old')],
    });
    expect(step(await cleanup(env, false))?.notes).toEqual([
      `no stale git-ai folders in ${GIT_AI_DIR}; 1 kept`,
    ]);
    expect(calls.filter(call => call.startsWith('drop '))).toEqual([]);
  });

  test('without git-ai data the step is skipped', async () => {
    const { env, lines } = harness({ trees: {} });
    const results = await cleanup(env, true);
    expect(step(results)).toEqual({
      step: 'git-ai folders',
      ok: true,
      skipped: `no git-ai folder at ${GIT_AI_DIR}`,
      notes: [],
    });
    expect(lines).toContain(
      `– git-ai folders (skipped: no git-ai folder at ${GIT_AI_DIR})`,
    );
  });

  test('a listing that fails deletes nothing', async () => {
    const { env, calls } = harness({
      ...fixture,
      fail: (command, args) =>
        command === 'git' && args[1] === 'list'
          ? exit(128, 'fatal: bad object')
          : undefined,
    });
    const result = step(await cleanup(env, false));
    expect(result?.ok).toBe(false);
    expect(calls.filter(call => call.startsWith('drop '))).toEqual([]);
  });

  test('an unreadable keep folder fails the step and deletes nothing', async () => {
    const { env, calls } = harness(fixture);
    env.names = dir => {
      throw new Error(`EACCES: permission denied, scandir '${dir}'`);
    };
    const result = step(await cleanup(env, false));
    expect(result).toEqual({
      step: 'git-ai folders',
      ok: false,
      notes: [`EACCES: permission denied, scandir '${COMMON}'`],
    });
    expect(calls.filter(call => call.startsWith('drop '))).toEqual([]);
  });
});

describe('cli', () => {
  test('0 when every step succeeds; --dry-run reaches the steps', async () => {
    const { env, calls } = harness({ trees: {} });
    expect(await cli(['--dry-run'], env)).toBe(0);
    expect(calls).toContain(
      `git worktree prune --verbose --dry-run @${COMMAND_TIMEOUT_MS}`,
    );
  });

  test('0 when a step is skipped: a skip is not a failure', async () => {
    const { env, lines } = harness({ trees: {}, docker: false });
    expect(await cli([], env)).toBe(0);
    expect(lines).toContain('– docker (skipped: no Docker daemon)');
  });

  test('1 when a step fails', async () => {
    const { env } = harness({
      trees: {},
      fail: command => (command === 'pnpm' ? exit(1) : undefined),
    });
    expect(await cli([], env)).toBe(1);
  });

  test('2 and the usage for an unknown flag, running nothing', async () => {
    const { env, calls, lines } = harness({ trees: {} });
    expect(await cli(['--force'], env)).toBe(2);
    expect(lines).toEqual(['usage: sarathi worktree cleanup [--dry-run]']);
    expect(USAGE).toBe(lines[0]);
    expect(calls).toEqual([]);
  });
});

describe('toDrop', () => {
  const folder = (name: string, days: number, gb = 0.1): ArchivedFolder => ({
    name,
    made: NOW - days * DAY,
    bytes: gb * 1e9,
  });

  test('the spec: 30 days and over go, the rest stay under 10 GB', () => {
    expect(ARCHIVE_KEEP_DAYS).toBe(30);
    expect(ARCHIVE_CAP_BYTES).toBe(10e9);
  });

  test('a folder goes at exactly the keep age, not a millisecond before', () => {
    const at = folder('at', ARCHIVE_KEEP_DAYS);
    const before = {
      ...folder('before', ARCHIVE_KEEP_DAYS),
      made: at.made + 1,
    };
    expect(toDrop([before, at], NOW)).toEqual([at]);
  });

  test('over the cap, the oldest young folders go until it is not', () => {
    const old = folder('old', 40, 1);
    const a = folder('a', 9, 6);
    const b = folder('b', 5, 3);
    const c = folder('c', 1, 4);
    // Young: 13 GB; dropping a (6) leaves 7 GB, under the cap.
    expect(toDrop([c, b, old, a], NOW)).toEqual([old, a]);
  });

  test('exactly at the cap is not over it', () => {
    const a = folder('a', 2, 6);
    const b = folder('b', 1, 4);
    expect(toDrop([a, b], NOW)).toEqual([]);
  });

  test('one folder over the cap alone goes, whatever its age', () => {
    const huge = folder('huge', 0, 12);
    expect(toDrop([huge], NOW)).toEqual([huge]);
  });

  test('equal times go by name', () => {
    const b = folder('b', 2, 6);
    const a = folder('a', 2, 6);
    expect(toDrop([b, a], NOW)).toEqual([a]);
  });

  test('none to drop under the cap and the age', () => {
    expect(toDrop([folder('a', 29), folder('b', 0)], NOW)).toEqual([]);
    expect(toDrop([], NOW)).toEqual([]);
  });
});

describe('worktree archive step', () => {
  const ARCHIVE_DIR = `${PRIMARY}/.git/acme/worktree-archive`;
  const folders: ArchivedFolder[] = [
    { name: 'ancient', made: NOW - 45 * DAY, bytes: 2.5e9 },
    { name: 'recent', made: NOW - 2 * DAY, bytes: 300e6 },
  ];

  test('a dry run lists what would go, with age and size, and deletes nothing', async () => {
    const { env, calls } = harness({ trees: {}, folders });
    const results = await cleanup(env, true);
    expect(results[1]).toEqual({
      step: 'worktree archive',
      ok: true,
      notes: [
        'would delete ancient: 45 days old, 2.5 GB',
        `1 archived worktrees kept in ${ARCHIVE_DIR}, 300.0 MB`,
      ],
    });
    expect(calls).toContain(`list-archive ${ARCHIVE_DIR}`);
    expect(calls.filter(call => call.startsWith('drop'))).toEqual([]);
  });

  test('a real run deletes them from the primary checkout’s archive', async () => {
    const { env, calls } = harness({ trees: {}, folders });
    const results = await cleanup(env, false);
    expect(results[1]?.notes).toEqual([
      'deleted ancient: 45 days old, 2.5 GB',
      `1 archived worktrees kept in ${ARCHIVE_DIR}, 300.0 MB`,
    ]);
    expect(calls.filter(call => call.startsWith('drop'))).toEqual([
      `drop ${ARCHIVE_DIR}/ancient`,
    ]);
  });

  test('sizes read in GB from one GB up, in MB below', async () => {
    const { env } = harness({
      trees: {},
      folders: [
        { name: 'one-gb', made: NOW - 31 * DAY, bytes: 1e9 },
        { name: 'just-under', made: NOW, bytes: 1e9 - 1e5 },
      ],
    });
    const results = await cleanup(env, true);
    expect(results[1]?.notes).toEqual([
      'would delete one-gb: 31 days old, 1.0 GB',
      `1 archived worktrees kept in ${ARCHIVE_DIR}, 999.9 MB`,
    ]);
  });

  test('a failed deletion fails the step; the next steps still run', async () => {
    const { env } = harness({ trees: {}, folders });
    env.drop = () => {
      throw new Error('EACCES: permission denied');
    };
    const results = await cleanup(env, false);
    expect(results[1]).toEqual({
      step: 'worktree archive',
      ok: false,
      notes: ['EACCES: permission denied'],
    });
    expect(results[2]?.step).toBe('stale worktree registrations');
  });
});

describe('ndkPins', () => {
  test('reads the version the app’s build.gradle pins', () => {
    // apps/mobile/android/build.gradle's lines that name an NDK, as written
    // there (the file itself is outside the mutation sandbox).
    const text = [
      'buildscript {',
      '    ext {',
      `        ndkVersion = "${PINNED}"`,
      '    }',
      '}',
      'subprojects { sub ->',
      '        sub.android.ndkVersion = rootProject.ext.ndkVersion',
      '}',
    ].join('\n');
    expect(ndkPins(text)).toEqual([PINNED]);
  });

  test('reads every literal pin, single- or double-quoted, and never a reference', () => {
    expect(
      ndkPins(
        'ndkVersion = "26.3.11579264"\nndkVersion \'25.1.8937393\'\nsub.android.ndkVersion = rootProject.ext.ndkVersion\n',
      ),
    ).toEqual(['26.3.11579264', '25.1.8937393']);
    expect(ndkPins('android { compileSdk 36 }')).toEqual([]);
  });
});

describe('android NDKs step', () => {
  const NDK = `${SDK}/ndk`;
  const ndks: ArchivedFolder[] = [
    { name: PINNED, made: NOW - 40 * DAY, bytes: 3.1e9 },
    { name: STRAY, made: NOW - 20 * DAY, bytes: 2.8e9 },
  ];
  const ndkStep = (results: StepResult[]) =>
    results.find(result => result.step === 'android NDKs');

  test('a dry run keeps the pinned NDK, lists the stray one with its size, and deletes nothing', async () => {
    const { env, calls } = harness({ trees: {}, ndks });
    const results = await cleanup(env, true);
    expect(ndkStep(results)).toEqual({
      step: 'android NDKs',
      ok: true,
      notes: [
        `keeping ${PINNED} (pinned)`,
        `would delete ndk/${STRAY}, 2.8 GB`,
      ],
    });
    expect(calls).toContain(`list-archive ${NDK}`);
    expect(calls.filter(call => call.startsWith('drop'))).toEqual([]);
  });

  test('a real run deletes the stray NDK folder', async () => {
    const { env, calls, lines } = harness({ trees: {}, ndks });
    const results = await cleanup(env, false);
    expect(ndkStep(results)?.notes).toEqual([
      `keeping ${PINNED} (pinned)`,
      `deleted ndk/${STRAY}, 2.8 GB`,
    ]);
    expect(calls.filter(call => call.startsWith('drop'))).toEqual([
      `drop ${NDK}/${STRAY}`,
    ]);
    // After docker's staged update, before caches.
    const at = lines.indexOf('✓ android NDKs');
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe(
      '– docker staged update (skipped: no staged update)',
    );
    expect(lines[at + 3]).toBe('✓ caches');
  });

  test('a version any listed worktree pins is kept, a nested copy’s too', async () => {
    const { env, calls } = harness({
      trees: {
        'before-1030': {},
        'agent-copy': { at: 'agent/.wt/copy' },
        agent: {},
      },
      gradle: {
        [PRIMARY]: pins(PINNED),
        [`${WT}/before-1030`]: pins(STRAY),
        [`${WT}/agent/.wt/copy`]: pins('26.3.11579264'),
      },
      ndks: [
        ...ndks,
        { name: '26.3.11579264', made: NOW, bytes: 2e9 },
        { name: '25.1.8937393', made: NOW, bytes: 900e6 },
      ],
    });
    const results = await cleanup(env, false);
    // Kept ones first, then deletions, each in version-name order.
    expect(ndkStep(results)?.notes).toEqual([
      'keeping 26.3.11579264 (pinned)',
      `keeping ${PINNED} (pinned)`,
      `keeping ${STRAY} (pinned)`,
      'deleted ndk/25.1.8937393, 900.0 MB',
    ]);
    expect(calls.filter(call => call.startsWith('drop'))).toEqual([
      `drop ${NDK}/25.1.8937393`,
    ]);
  });

  test('a build.gradle that pins no NDK is named; the others’ pins still decide', async () => {
    const { env } = harness({
      trees: { unpinned: {} },
      gradle: { [PRIMARY]: pins(PINNED), [`${WT}/unpinned`]: 'android {}\n' },
      ndks,
    });
    const results = await cleanup(env, true);
    expect(ndkStep(results)?.notes).toEqual([
      `${WT}/unpinned/${GRADLE} pins no ndkVersion`,
      `keeping ${PINNED} (pinned)`,
      `would delete ndk/${STRAY}, 2.8 GB`,
    ]);
  });

  test('with no pinned version anywhere the step fails and deletes nothing', async () => {
    const { env, calls } = harness({
      trees: { other: {} },
      gradle: { [PRIMARY]: 'android {}\n' },
      ndks,
    });
    const results = await cleanup(env, false);
    expect(ndkStep(results)).toEqual({
      step: 'android NDKs',
      ok: false,
      notes: [
        `no listed worktree's ${GRADLE} pins an ndkVersion: no NDK is deleted`,
      ],
    });
    expect(calls.filter(call => call.startsWith('drop'))).toEqual([]);
    expect(results.at(-1)?.step).toBe('caches');
  });

  test('an unreadable build.gradle fails the step: its pin is unknown', async () => {
    const { env, calls } = harness({
      trees: { locked: {} },
      gradle: { [PRIMARY]: pins(PINNED), [`${WT}/locked`]: null },
      ndks,
    });
    const results = await cleanup(env, false);
    expect(ndkStep(results)).toEqual({
      step: 'android NDKs',
      ok: false,
      notes: [`${WT}/locked/${GRADLE} cannot be read: no NDK is deleted`],
    });
    expect(calls.filter(call => call.startsWith('drop'))).toEqual([]);
  });

  test('without an NDK folder (Linux, or no SDK) the step is skipped, with the reason', async () => {
    const { env, calls, lines } = harness({ trees: {} });
    const results = await cleanup(env, false);
    expect(ndkStep(results)).toEqual({
      step: 'android NDKs',
      ok: true,
      skipped: `no Android NDK folder at ${NDK}`,
      notes: [],
    });
    expect(lines).toContain(NO_NDK_DIR);
    expect(calls).not.toContain(`list-archive ${NDK}`);
  });

  test('$ANDROID_HOME, when set, is the SDK', async () => {
    const set = harness({ trees: {}, ndks, androidHome: '/opt/android' });
    const results = await cleanup(set.env, true);
    expect(set.calls).toContain('list-archive /opt/android/ndk');
    expect(ndkStep(results)?.notes).toContain(
      `would delete ndk/${STRAY}, 2.8 GB`,
    );
  });

  test('a blank $ANDROID_HOME reads as unset', () => {
    expect(androidHomeIn({ ANDROID_HOME: '/opt/android' })).toBe(
      '/opt/android',
    );
    expect(androidHomeIn({ ANDROID_HOME: '' })).toBeUndefined();
    expect(androidHomeIn({ ANDROID_HOME: '  ' })).toBeUndefined();
    expect(androidHomeIn({})).toBeUndefined();
  });

  test('nothing stray: only the keeping line', async () => {
    const { env } = harness({ trees: {}, ndks: ndks.slice(0, 1) });
    const results = await cleanup(env, false);
    expect(ndkStep(results)?.notes).toEqual([`keeping ${PINNED} (pinned)`]);
  });

  test('a failed deletion fails the step; caches still run', async () => {
    const { env, calls } = harness({ trees: {}, ndks });
    env.drop = () => {
      throw new Error('EACCES: permission denied');
    };
    const results = await cleanup(env, false);
    expect(ndkStep(results)).toEqual({
      step: 'android NDKs',
      ok: false,
      notes: ['EACCES: permission denied'],
    });
    expect(calls).toContain(`pnpm store prune @${COMMAND_TIMEOUT_MS}`);
  });
});

describe('docker staged update step', () => {
  const STEP = 'docker staged update';
  const STAGED = `${DOCKER_INSTALL}/in_progress`;
  const PS = `ps -A -ww -o command= @${COMMAND_TIMEOUT_MS}`;
  const resultOf = (results: StepResult[]) =>
    results.find(result => result.step === STEP);
  const drops = (calls: string[]) =>
    calls.filter(call => call.startsWith('drop'));

  test('it runs after docker and before caches', async () => {
    const { env } = harness({ trees: {} });
    const steps = (await cleanup(env, true)).map(result => result.step);
    expect(steps).toContain('docker');
    expect(steps).toContain('caches');
    const at = steps.indexOf('docker');
    expect(steps[at + 1]).toBe(STEP);
    expect(steps.indexOf('caches')).toBeGreaterThan(at + 1);
  });

  test('a dry run names the staged update and its size, and deletes nothing', async () => {
    const { env, calls, lines } = harness({ trees: {}, staged: 2.2e9 });
    expect(resultOf(await cleanup(env, true))).toEqual({
      step: STEP,
      ok: true,
      notes: ['would delete com.docker.install/in_progress, 2.2 GB'],
    });
    expect(calls).toContain(`list-archive ${DOCKER_INSTALL}`);
    expect(calls).toContain(PS);
    expect(drops(calls)).toEqual([]);
    const at = lines.indexOf(`✓ ${STEP}`);
    expect(lines[at + 1]).toBe(
      '    would delete com.docker.install/in_progress, 2.2 GB',
    );
  });

  test('a real run deletes it, after listing the processes', async () => {
    const { env, calls } = harness({ trees: {}, staged: 2.2e9 });
    expect(resultOf(await cleanup(env, false))?.notes).toEqual([
      'deleted com.docker.install/in_progress, 2.2 GB',
    ]);
    expect(drops(calls)).toEqual([`drop ${STAGED}`]);
    expect(calls).toContain(PS);
    expect(calls.indexOf(PS)).toBeLessThan(calls.indexOf(`drop ${STAGED}`));
  });

  test('without Docker Desktop installed it is skipped and nothing is read', async () => {
    const { env, calls } = harness({
      trees: {},
      staged: 2.2e9,
      noDockerApp: true,
    });
    expect(resultOf(await cleanup(env, false))).toEqual({
      step: STEP,
      ok: true,
      skipped: 'Docker Desktop not installed',
      notes: [],
    });
    expect(calls).toContain('exists /Applications/Docker.app');
    expect(calls).not.toContain(`list-archive ${DOCKER_INSTALL}`);
    expect(calls).not.toContain(PS);
    expect(drops(calls)).toEqual([]);
  });

  test('with no staged update it is skipped and no process is listed', async () => {
    const { env, calls, lines } = harness({ trees: {} });
    expect(resultOf(await cleanup(env, false))).toEqual({
      step: STEP,
      ok: true,
      skipped: 'no staged update',
      notes: [],
    });
    expect(lines).toContain(`– ${STEP} (skipped: no staged update)`);
    expect(calls).not.toContain(PS);
    expect(drops(calls)).toEqual([]);
  });

  test.each([
    [
      'the app',
      '/Applications/Docker.app/Contents/MacOS/Docker Desktop.app/Contents/MacOS/Docker Desktop',
    ],
    [
      'the backend',
      '/Applications/Docker.app/Contents/MacOS/com.docker.backend services',
    ],
    ['the backend, by name', 'com.docker.backend'],
    ['the app, by name', 'Docker Desktop --unattended'],
    [
      'the installer',
      `${STAGED}/Docker.app/Contents/MacOS/install --accept-license`,
    ],
    ['the installer, by name', 'com.docker.install'],
  ])(
    'while %s runs it is skipped and the update kept',
    async (_who, process) => {
      const { env, calls, lines } = harness({
        trees: {},
        staged: 2.2e9,
        processes: ['/sbin/launchd', `  ${process}  `],
      });
      expect(resultOf(await cleanup(env, false))).toEqual({
        step: STEP,
        ok: true,
        skipped: 'Docker Desktop is running',
        notes: [process],
      });
      expect(lines).toContain(`– ${STEP} (skipped: Docker Desktop is running)`);
      expect(drops(calls)).toEqual([]);
    },
  );

  test('processes that only share a name or a helper do not keep it', async () => {
    const { env, calls } = harness({
      trees: {},
      staged: 2.2e9,
      processes: [
        '/Library/PrivilegedHelperTools/com.docker.vmnetd',
        '/Library/PrivilegedHelperTools/com.docker.socket',
        'docker ps',
        '/usr/local/bin/docker-credential-desktop list',
        '/Applications/Docker Desktop Notes.app/Contents/MacOS/Notes',
        '/Applications/Docker.application-helper',
        'my-com.docker.backend-mirror',
      ],
    });
    expect(resultOf(await cleanup(env, false))?.notes).toEqual([
      'deleted com.docker.install/in_progress, 2.2 GB',
    ]);
    expect(drops(calls)).toEqual([`drop ${STAGED}`]);
  });

  test.each<[string, ChildOutcome]>([
    ['fails', exit(1, 'ps: operation not permitted')],
    [
      'cannot start',
      {
        kind: 'spawn-error',
        errno: 'ENOENT',
        message: 'spawn ps ENOENT',
        code: 127,
        stdout: '',
        stderrTail: '',
      },
    ],
    [
      'times out',
      {
        kind: 'timeout',
        timeoutMs: COMMAND_TIMEOUT_MS,
        code: 124,
        stdout: '/sbin/launchd\n',
        stderrTail: '',
      },
    ],
    ['is cut short', exit(1, '', '/sbin/launchd\n')],
  ])(
    'a process listing that %s fails the step and keeps the update',
    async (_how, outcome) => {
      const { env, calls } = harness({
        trees: {},
        staged: 2.2e9,
        fail: command => (command === 'ps' ? outcome : undefined),
      });
      const results = await cleanup(env, false);
      expect(resultOf(results)).toEqual({
        step: STEP,
        ok: false,
        notes: [expect.stringMatching(/^ps -A -ww -o command=: /)],
      });
      expect(drops(calls)).toEqual([]);
      expect(results.at(-1)?.step).toBe('caches');
    },
  );

  test('an empty process listing is partial: the step fails and keeps the update', async () => {
    const { env, calls } = harness({
      trees: {},
      staged: 2.2e9,
      processes: ['', '  '],
    });
    expect(resultOf(await cleanup(env, false))).toEqual({
      step: STEP,
      ok: false,
      notes: ['ps -A -ww -o command=: listed no process'],
    });
    expect(drops(calls)).toEqual([]);
  });

  test('an unreadable install folder or a failed deletion fails the step', async () => {
    const unreadable = harness({ trees: {}, staged: 2.2e9 });
    unreadable.env.archived = () => {
      throw new Error('EACCES: permission denied');
    };
    expect(resultOf(await cleanup(unreadable.env, false))).toEqual({
      step: STEP,
      ok: false,
      notes: ['EACCES: permission denied'],
    });
    const stuck = harness({ trees: {}, staged: 2.2e9 });
    stuck.env.drop = () => {
      throw new Error('EPERM: operation not permitted');
    };
    expect(resultOf(await cleanup(stuck.env, false))).toEqual({
      step: STEP,
      ok: false,
      notes: ['EPERM: operation not permitted'],
    });
  });
});

describe('defaultEnv', () => {
  const IO = { cwd: process.cwd(), env: process.env, out: () => undefined };
  const temporary: string[] = [];
  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  test('names the home folder and this process', () => {
    const env = defaultEnv(IO);
    expect(env.home).toBe(homedir());
    expect(env.pid).toBe(process.pid);
  });

  test('lists archived folders with their age and bytes, and drops one', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-')));
    temporary.push(dir);
    const env = defaultEnv(IO);
    expect(env.archived(join(dir, 'missing'))).toEqual([]);
    const tree = join(dir, 'wt');
    env.archive(writeAt(dir, 'src-a', 'abc'), join(tree, '.tmp', 'a'));
    env.archive(writeAt(dir, 'src-b', 'hello'), join(tree, 'b'));
    symlinkSync('/nowhere', join(tree, 'link'));
    writeFileSync(join(dir, 'stray-file'), 'x');
    // A linked folder inside is not listed, so never dropped through.
    symlinkSync(tree, join(dir, 'linked'));
    // Birth times carry fractions of a millisecond; Date.now() does not.
    const after = Date.now() + 1;
    const [listed, ...rest] = env.archived(dir);
    expect(rest).toEqual([]);
    expect(listed?.name).toBe('wt');
    expect(listed?.bytes).toBe(3 + 5 + '/nowhere'.length);
    expect(listed?.made).toBeLessThan(after);
    expect(listed?.made).toBeGreaterThan(after - 60_000);
    // A file archived into the folder later counts from its copy, even one
    // whose source is years old (a macOS copy keeps the source's birth).
    const source = writeAt(dir, 'src-c', 'later');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(source, old, old);
    const before = Date.now() - 1;
    env.archive(source, join(tree, '.tmp', 'c'));
    const copy = madeAt(lstatSync(join(tree, '.tmp', 'c')));
    expect(copy).toBeGreaterThan(before);
    const [again] = env.archived(dir);
    // Its folder's mtime moved too, a fraction of a millisecond later.
    expect(again?.made).toBeGreaterThanOrEqual(copy);
    expect(again?.made).toBeLessThan(Date.now() + 1);
    expect(again?.bytes).toBe(16 + 5);
    env.drop(tree);
    expect(env.archived(dir)).toEqual([]);
  });

  test('an entry’s age is the later of its birth and its mtime', () => {
    expect(madeAt({ birthtimeMs: 5, mtimeMs: 9 })).toBe(9);
    expect(madeAt({ birthtimeMs: 9, mtimeMs: 5 })).toBe(9);
    expect(madeAt({ birthtimeMs: 0, mtimeMs: 9 })).toBe(9);
  });

  test('a folder is as young as the newest thing in it, and counts file bytes', () => {
    const entry = (birthtimeMs: number, size: number, directory = false) => ({
      birthtimeMs,
      mtimeMs: 1,
      size,
      directory,
    });
    const self = { birthtimeMs: 10, mtimeMs: 1 };
    expect(folderFacts(self, [])).toEqual({ made: 10, bytes: 0 });
    expect(folderFacts(self, [entry(30, 4), entry(20, 6)])).toEqual({
      made: 30,
      bytes: 10,
    });
    // An older entry leaves the folder's own birth; a folder's size is not counted.
    expect(folderFacts(self, [entry(5, 4), entry(40, 96, true)])).toEqual({
      made: 40,
      bytes: 4,
    });
    expect(folderFacts(self, [entry(5, 4)]).made).toBe(10);
  });

  test('refuses an archive, or the folder above it, that is a link', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-')));
    temporary.push(dir);
    const env = defaultEnv(IO);
    const elsewhere = join(dir, 'elsewhere');
    env.archive(writeAt(dir, 'src', 'x'), join(elsewhere, 'keep', 'f'));
    const link = join(dir, 'link');
    symlinkSync(elsewhere, link);
    expect(() => env.archived(link)).toThrow(
      `${link} is a symbolic link: the archive is not swept`,
    );
    const acme = join(dir, 'acme');
    symlinkSync(dir, acme);
    expect(() => env.archived(join(acme, 'elsewhere'))).toThrow(
      `${acme} is a symbolic link: the archive is not swept`,
    );
    expect(readFileSync(join(elsewhere, 'keep', 'f'), 'utf8')).toBe('x');
  });

  test('drop refuses a folder reached through a link anywhere above it', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-')));
    temporary.push(dir);
    const env = defaultEnv(IO);
    // The primary's `apps` is a link to another tree: its build output is
    // three levels below the link, past the folders refuseLinks checks.
    const other = join(dir, 'other');
    const kept = join(other, 'mobile', 'android', 'build', 'out.so');
    env.archive(writeAt(dir, 'src', 'z'), kept);
    const primary = join(dir, 'primary');
    env.archive(writeAt(dir, 'src-2', 'w'), join(primary, 'README'));
    symlinkSync(other, join(primary, 'apps'));
    const build = join(primary, 'apps', 'mobile', 'android', 'build');
    expect(() => env.drop(build)).toThrow(
      `${dirname(build)} is reached through a symbolic link: ${build} is kept`,
    );
    expect(readFileSync(kept, 'utf8')).toBe('z');
  });

  test('drop refuses a link that replaced a folder after the listing', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-')));
    temporary.push(dir);
    const env = defaultEnv(IO);
    const elsewhere = join(dir, 'elsewhere');
    env.archive(
      writeAt(dir, 'src', 'x'),
      join(elsewhere, 'archive', 'wt', 'f'),
    );
    const acme = join(dir, 'acme');
    symlinkSync(elsewhere, acme);
    const at = (...parts: string[]) => join(acme, ...parts);
    // The folder above the archive, the archive, and the folder itself.
    expect(() => env.drop(at('archive', 'wt'))).toThrow(
      `${acme} is a symbolic link: ${at('archive', 'wt')} is kept`,
    );
    const real = join(dir, 'real');
    env.archive(writeAt(dir, 'src-2', 'y'), join(real, 'archive', 'wt', 'g'));
    symlinkSync(join(elsewhere, 'archive'), join(real, 'linked'));
    expect(() => env.drop(join(real, 'linked', 'wt'))).toThrow(
      `${join(real, 'linked')} is a symbolic link: ${join(real, 'linked', 'wt')} is kept`,
    );
    symlinkSync(
      join(elsewhere, 'archive', 'wt'),
      join(real, 'archive', 'moved'),
    );
    expect(() => env.drop(join(real, 'archive', 'moved'))).toThrow(
      `${join(real, 'archive', 'moved')} is a symbolic link: ${join(real, 'archive', 'moved')} is kept`,
    );
    expect(readFileSync(join(elsewhere, 'archive', 'wt', 'f'), 'utf8')).toBe(
      'x',
    );
    // A link inside the folder goes as itself: rmSync never enters it.
    const wt = join(real, 'archive', 'wt');
    symlinkSync(elsewhere, join(wt, 'inner'));
    symlinkSync(join(elsewhere, 'archive', 'wt', 'f'), join(wt, 'to-file'));
    env.drop(wt);
    expect(env.archived(join(real, 'archive')).map(f => f.name)).toEqual([]);
    expect(readFileSync(join(elsewhere, 'archive', 'wt', 'f'), 'utf8')).toBe(
      'x',
    );
  });

  test('sameBytes compares past the first chunk, and by length', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-')));
    temporary.push(dir);
    const big = Buffer.alloc((1 << 20) + 10, 7);
    const write = (name: string, bytes: Buffer) => {
      writeFileSync(join(dir, name), bytes);
      return join(dir, name);
    };
    const a = write('a', big);
    const same = write('same', Buffer.from(big));
    const tail = Buffer.from(big);
    tail[tail.length - 1] = 8;
    const late = write('late', tail);
    const longer = write('longer', Buffer.concat([big, Buffer.from([7])]));
    const empty = write('empty', Buffer.alloc(0));
    expect(sameBytes(a, same)).toBe(true);
    expect(sameBytes(a, late)).toBe(false);
    expect(sameBytes(a, longer)).toBe(false);
    expect(sameBytes(longer, a)).toBe(false);
    expect(sameBytes(empty, write('empty2', Buffer.alloc(0)))).toBe(true);
    expect(sameBytes(empty, a)).toBe(false);
    expect(() => sameBytes(a, join(dir, 'missing'))).toThrow('ENOENT');
    expect(() => sameBytes(join(dir, 'missing'), a)).toThrow('ENOENT');
  });

  test('reads files, their times and free space; missing files are undefined', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cleanup-')));
    temporary.push(dir);
    const file = join(dir, 'f');
    writeFileSync(file, 'text');
    utimesSync(file, 1000, 2000);
    const env = defaultEnv(IO);
    expect(env.read(file)).toBe('text');
    expect(env.read(join(dir, 'missing'))).toBeUndefined();
    expect(env.mtime(file)).toBe(2_000_000);
    expect(env.mtime(join(dir, 'missing'))).toBeUndefined();
    const copy = join(dir, 'copy');
    const other = join(dir, 'other');
    writeFileSync(copy, 'text');
    writeFileSync(other, 'texT');
    expect(env.lossless(file, copy)).toBe(true);
    expect(env.lossless(file, other)).toBe(false);
    expect(env.lossless(file, join(dir, 'missing'))).toBe(false);
    // A link loses nothing, wherever it points, a folder included.
    const link = join(dir, 'link');
    symlinkSync(dir, link);
    expect(env.lossless(link, other)).toBe(true);
    expect(env.lossless(join(dir, 'missing'), copy)).toBe(false);
    // Archive: makes folders, repeats harmlessly, never overwrites.
    const archived = join(dir, 'archive', 'deep', 'f');
    env.archive(file, archived);
    expect(readFileSync(archived, 'utf8')).toBe('text');
    // A repeat dates the existing copy now; a refusal leaves it as it was.
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(archived, old, old);
    const before = Date.now() - 1;
    env.archive(copy, archived);
    expect(lstatSync(archived).mtimeMs).toBeGreaterThan(before);
    utimesSync(archived, old, old);
    expect(() => env.archive(other, archived)).toThrow(
      `${archived} already holds other bytes`,
    );
    expect(readFileSync(archived, 'utf8')).toBe('text');
    expect(lstatSync(archived).mtimeMs).toBe(old.getTime());
    // A link at the destination is refused, and where it points is untouched.
    utimesSync(copy, old, old);
    const planted = join(dir, 'archive', 'deep', 'planted');
    symlinkSync(copy, planted);
    expect(() => env.archive(file, planted)).toThrow(
      `${planted} is a symbolic link: nothing is archived over it`,
    );
    expect(lstatSync(copy).mtimeMs).toBe(old.getTime());
    // A link in a folder above the destination is refused too, before any
    // folder is made where it points.
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    const linked = join(dir, 'archive', 'linked');
    symlinkSync(outside, linked);
    expect(() => env.archive(file, join(linked, 'sub', 'f'))).toThrow(
      `${linked} is reached through a symbolic link: nothing is archived into it`,
    );
    expect(readdirSync(outside)).toEqual([]);
    rmSync(linked);
    // A folder or file is there; a missing path is not.
    expect(env.exists(dir)).toBe(true);
    expect(env.exists(file)).toBe(true);
    expect(env.exists(join(dir, 'missing'))).toBe(false);
    // Only "no such entry" is missing: a path that cannot be checked (here a
    // link loop; an unreadable folder above it alike, which root here cannot
    // show) throws, so no step takes it for gone.
    expect(env.exists(join(file, 'below'))).toBe(false);
    const loop = join(dir, 'loop');
    symlinkSync(loop, loop);
    expect(() => env.exists(loop)).toThrow(/ELOOP/);
    // Names: every entry right in the folder, any kind; none when missing.
    expect(env.names(dir)).toEqual(expect.arrayContaining(['f', 'archive']));
    expect(env.names(join(dir, 'archive'))).toEqual(['deep']);
    expect(env.names(join(dir, 'missing'))).toEqual([]);
    expect(env.names(file)).toEqual([]);
    // A folder it cannot read (here the link loop) throws rather than read as
    // empty, so the git-ai step keeps every folder instead of deleting them.
    expect(() => env.names(loop)).toThrow(/ELOOP/);
    // Bytes, not blocks: available blocks times the block size.
    expect(env.freeBytes(dir)).toBeGreaterThan(statfsSync(dir).bavail);
    expect(env.cwd).toBe(process.cwd());
    expect(env.home).toBe(homedir());
    expect(env.platform).toBe(process.platform);
    expect(env.androidHome).toBe(androidHomeIn(process.env));
    expect(env.settings).toBe(readSettings);
    expect(env.sweep).toBe(sweepOnce);
    expect(Math.abs(env.now() - Date.now())).toBeLessThan(1000);
    // The services file resolves from the primary checkout and is read whole.
    writeFileSync(
      join(dir, 'services.json'),
      JSON.stringify({ compose: 'c.yaml', project: 'p', rootLabel: 'l', apiPorts: [1000, 1000], webPort: 999 }),
    );
    expect(env.services('services.json', dir)).toMatchObject({ project: 'p', rootLabel: 'l' });
    expect(() => env.services('missing.json', dir)).toThrow('cannot read the services file');
    // Each line goes out with its newline.
    const out: string[] = [];
    defaultEnv({ ...IO, out: text => out.push(text) }).stdout('a line');
    expect(out).toEqual(['a line\n']);
    const outcome = await env.run('git', ['--version'], 10_000);
    expect(outcome.kind).toBe('ok');
  });
});
