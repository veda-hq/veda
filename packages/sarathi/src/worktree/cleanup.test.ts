import {
  lstatSync,
  rmSync,
  mkdtempSync,
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
import { main } from '../cli.ts';
import { projectName } from '../services/reaper.ts';
import { sweepOnce, type SweepOutcome, type SweepRequest } from '../services/prune.ts';
import { failure, type ChildOutcome } from '../services/run-child.ts';
import { parseSettings, readSettings, type WorktreeSettings } from './settings.ts';
import {
  COMMAND_TIMEOUT_MS,
  DAEMON_TIMEOUT_MS,
  IDLE_DAYS,
  SETTINGS_OFF,
  USAGE,
  androidHomeIn,
  archiveDir,
  cleanup,
  cleanupMain,
  cli,
  defaultEnv,
  gitdirOf,
  inside,
  keepReason,
  ndkPins,
  parseCwds,
  parseProcesses,
  Failed,
  duBytes,
  brewFreed,
  parseWorktrees,
  REBUILT,
  reclaimed,
  madeAt,
  sameBytes,
  shellWord,
  toDrop,
  folderFacts,
  ARCHIVE_CAP_BYTES,
  ARCHIVE_KEEP_DAYS,
  APP_IDLE_DAYS,
  type ArchivedFolder,
  type Env,
  type StepResult,
  type Worktree,
} from './cleanup.ts';

/** Where a project's tooling keeps a worktree's nested copy. */
const COPY_DIR = '.wt/copy';
/**
 * The nested copies the test project names: COPY_DIR or its numbered
 * successor, as JSON writes the pattern in `.claude/sarathi.json`.
 */
const COPIES_JSON = String.raw`"^\\.wt\\/copy(?:-\\d{15}-\\d{8})?$"`;
const COPY_SOURCE = JSON.parse(COPIES_JSON) as string;
const COPY_NAME = new RegExp(COPY_SOURCE);
/** The services file's Compose prefix and root label. */
const SERVICES = { project: 'acme', rootLabel: 'com.acme.root' };
const PRIMARY_BUILT = [
  '.turbo',
  'apps/mobile/android/build',
  'apps/mobile/android/app/build',
  'apps/mobile/android/.cxx',
  'apps/mobile/android/app/.cxx',
  'apps/mobile/android/.gradle',
];
/** The project's settings: every cleanup switch on, as a project that wants them all sets them. */
const SETTINGS: WorktreeSettings = parseSettings(
  {
    name: 'acme',
    services: 'services.json',
    cleanup: {
      primaryBuilt: PRIMARY_BUILT,
      nestedCopies: COPY_SOURCE,
      machine: {
        dockerDesktopUpdate: true,
        androidNdk: 'apps/mobile/android/build.gradle',
        gradleCaches: true,
        simulators: true,
        brew: true,
      },
    },
  },
  '.claude/sarathi.json',
  '/repo',
);
/** The settings of a project that sets no cleanup and no services file. */
const BARE: WorktreeSettings = parseSettings({ name: 'acme' }, '.claude/sarathi.json', '/repo');

const NOW = Date.parse('2026-11-04T00:00:00Z');
const DAY = 86_400_000;
const OLD = NOW - (IDLE_DAYS + 1) * DAY;
const PRIMARY = '/repo';
const WT = '/repo/.claude/worktrees';
const SELF = `${WT}/self`;
const COMMON = '/repo/.git/worktrees';
const GIT_AI_DIR = '/repo/.git/ai/worktrees';
const AT = { self: SELF, primary: PRIMARY, copies: COPY_NAME, project: SERVICES.project };
const HOME = '/Users/me';
const DOCKER_INSTALL = `${HOME}/Library/Application Support/com.docker.install`;

const ok = (stdout = '', stderrTail = ''): ChildOutcome => ({
  kind: 'ok',
  code: 0,
  stdout,
  stderrTail,
});
const exit = (code: number, stderrTail = '', stdout = ''): ChildOutcome => ({
  kind: 'exit',
  code,
  stdout,
  stderrTail,
});

interface Fixture {
  /** Linked worktrees: name → options. */
  trees: Record<
    string,
    {
      marker?: boolean;
      touched?: number;
      status?: string;
      remote?: string;
      locked?: boolean;
      /** The reason on its `locked` line; default `claude agent`. */
      lockReason?: string;
      prunable?: boolean;
      /** Its folder is gone, though git (locked) still lists it. */
      gone?: boolean;
      /** Where it sits under WT, or an absolute path; default its name. */
      at?: string;
      gitFile?: string | null;
      /** `ls-files --others --ignored --directory`, relative paths. */
      ignored?: string[];
      /** The same listing inside the ignored folders. */
      ignoredInside?: string[];
    }
  >;
  cwds?: string[];
  /** Compose projects with a running container. */
  services?: string[];
  /** Relative paths byte-identical to the primary checkout's. */
  shared?: string[];
  /** Every archive copy throws. */
  archiveFails?: boolean;
  /** Folders already in the worktree archive. */
  folders?: ArchivedFolder[];
  /** Folders under GIT_AI_DIR; undefined: git-ai keeps no folder there. */
  aiFolders?: ArchivedFolder[];
  /** Folders under WT git does not list (a worktree git forgot). */
  appFolders?: string[];
  docker?: boolean;
  /** KiB `du -sk` reports for each path; default 1,000,000. */
  kib?: number;
  /** /Applications/Docker.app is missing. */
  noDockerApp?: boolean;
  /** Bytes of Docker Desktop's staged update; absent when none is staged. */
  staged?: number;
  /** `ps -A -ww -o command=`, one process a line. */
  processes?: string[];
  fail?: (command: string, args: string[]) => ChildOutcome | undefined;
  platform?: NodeJS.Platform;
  /** NDK version folders under the SDK's `ndk`; absent, there is no such folder. */
  ndks?: ArchivedFolder[];
  /** `$ANDROID_HOME`; unset by default. */
  androidHome?: string;
  /**
   * Each checkout's `apps/mobile/android/build.gradle`, by checkout path:
   * null is there but unreadable; a checkout not named has none. Default:
   * the primary's pins PINNED.
   */
  gradle?: Record<string, string | null>;
  /** Which of BUILT_PATHS exist; default none. */
  built?: string[];
  /** Processes `lsof -d cwd -FcRn` lists. */
  lsof?: { pid: number; parent: number; command: string; cwd: string }[];
  /** The project's settings; default SETTINGS, every cleanup switch on. */
  settings?: WorktreeSettings;
  /** What reading the settings or the services file throws. */
  settingsFail?: Error;
  /** The sweep's outcome; default one with every step ok. */
  sweep?: (request: SweepRequest) => SweepOutcome;
}

const SDK = `${HOME}/Library/Android/sdk`;
const PINNED = '27.1.12297006';
const STRAY = '28.2.13676358';
const GRADLE = 'apps/mobile/android/build.gradle';
const pins = (version: string) =>
  `buildscript {\n    ext {\n        ndkVersion = "${version}"\n    }\n}\n`;
const NO_NDK_DIR = `– android NDKs (skipped: no Android NDK folder at ${SDK}/ndk)`;

/** The cleanup process itself. */
const PID = 4242;
const GRADLE_CACHES = `${HOME}/.gradle/caches`;
const PRIMARY_OUTPUT = [
  '.turbo',
  'apps/mobile/android/build',
  'apps/mobile/android/app/build',
  'apps/mobile/android/.cxx',
  'apps/mobile/android/app/.cxx',
  'apps/mobile/android/.gradle',
].map(path => `${PRIMARY}/${path}`);
/** What the caches step may delete; only these consult `built`. */
const BUILT_PATHS = [...PRIMARY_OUTPUT, GRADLE_CACHES];
/** `du -sk` gives each path 1,000,000 KiB: 1.0 GB. */
const KIB = 1_000_000;
const BREW_DRY =
  '==> This operation would free approximately 1.8GB of disk space.\n';
const BREW_REAL =
  '==> This operation has freed approximately 1.8GB of disk space.\n';
const DAEMON_LINE =
  '  77 /usr/bin/java -Xmx2048m -classpath /home/me/.gradle/wrapper/dists/gradle-8.14/lib/gradle-daemon-main-8.14.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.14';

/** Writes `text` to `dir/name`; resolves the path. */
function writeAt(dir: string, name: string, text: string) {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

function pathOf(name: string, fixture: Fixture) {
  const at = fixture.trees[name]?.at ?? name;
  return at.startsWith('/') ? at : `${WT}/${at}`;
}

function porcelain(fixture: Fixture) {
  const blocks = [`worktree ${PRIMARY}\nHEAD abc\nbranch refs/heads/main`];
  for (const [name, tree] of Object.entries(fixture.trees)) {
    const lines = [`worktree ${pathOf(name, fixture)}`, 'HEAD def', 'detached'];
    if (tree.locked)
      lines.push(`locked ${tree.lockReason ?? 'claude agent'}`.trimEnd());
    if (tree.prunable)
      lines.push('prunable gitdir file points to non-existent location');
    blocks.push(lines.join('\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}

function harness(fixture: Fixture) {
  const calls: string[] = [];
  const lines: string[] = [];
  const losslessCalls: string[] = [];
  const byPath = new Map(
    Object.keys(fixture.trees).map(name => [pathOf(name, fixture), name]),
  );
  let free = 100e9;
  const gradle = fixture.gradle ?? { [PRIMARY]: pins(PINNED) };
  const gradleOf = (path: string) =>
    path.endsWith(`/${GRADLE}`)
      ? path.slice(0, -`/${GRADLE}`.length)
      : undefined;
  const ndkDir = `${fixture.androidHome ?? SDK}/ndk`;
  const env: Env = {
    cwd: SELF,
    home: HOME,
    androidHome: fixture.androidHome,
    settings: primary => {
      calls.push(`settings ${primary}`);
      if (fixture.settingsFail !== undefined) throw fixture.settingsFail;
      return fixture.settings ?? SETTINGS;
    },
    services: (file, primary) => {
      calls.push(`services ${file} ${primary}`);
      return SERVICES;
    },
    sweep: async request => {
      calls.push(
        `sweep ${request.docker}${request.dryRun ? ' --dry-run' : ''}`,
      );
      return (
        fixture.sweep?.(request) ?? {
          kind: 'swept',
          results: [{ step: 'containers', ok: true }],
        }
      );
    },
    now: () => NOW,
    platform: fixture.platform ?? 'darwin',
    pid: PID,
    stdout: line => lines.push(line),
    freeBytes: () => {
      free += 25e9;
      return free - 25e9;
    },
    read: path => {
      const checkout = gradleOf(path);
      if (checkout !== undefined) return gradle[checkout] ?? undefined;
      const pointer = /^(.+)\/\.git$/.exec(path);
      if (pointer) {
        const name = byPath.get(`${pointer[1]}`);
        if (name === undefined) return undefined;
        const gitFile = fixture.trees[name]?.gitFile;
        if (gitFile === null) return undefined;
        return gitFile ?? `gitdir: ${COMMON}/${name}\n`;
      }
      const marker = /^\/repo\/\.git\/worktrees\/(.+)\/CLAUDE_BASE$/.exec(path);
      if (
        marker?.[1] !== undefined &&
        fixture.trees[marker[1]]?.marker !== false
      )
        return 'main\n';
      return undefined;
    },
    lossless: (a, b) => {
      losslessCalls.push(`${a} ${b}`);
      const path = b.slice(`${PRIMARY}/`.length);
      return a.endsWith(`/${path}`) && (fixture.shared ?? []).includes(path);
    },
    archive: (from, to) => {
      calls.push(`archive ${from} ${to}`);
      if (fixture.archiveFails === true)
        throw new Error(`${to} already holds other bytes`);
    },
    archived: dir => {
      calls.push(`list-archive ${dir}`);
      if (dir === GIT_AI_DIR) return fixture.aiFolders ?? [];
      if (dir === ndkDir) return fixture.ndks ?? [];
      if (dir === DOCKER_INSTALL)
        return fixture.staged === undefined
          ? [{ name: 'other', made: NOW, bytes: 1 }]
          : [
              { name: 'other', made: NOW, bytes: 1 },
              { name: 'in_progress', made: NOW, bytes: fixture.staged },
            ];
      return fixture.folders ?? [];
    },
    names: dir => {
      calls.push(`names ${dir}`);
      // Each tree's gitdir is named after it; WT holds the trees right in
      // it and any folder git forgot.
      if (dir === COMMON) return Object.keys(fixture.trees);
      if (dir === WT)
        return [
          ...Object.keys(fixture.trees)
            .map(name => pathOf(name, fixture))
            .filter(path => path.lastIndexOf('/') === WT.length)
            .map(path => path.slice(WT.length + 1)),
          ...(fixture.appFolders ?? []),
        ];
      return [];
    },
    drop: path => calls.push(`drop ${path}`),
    exists: path => {
      if (path === '/Applications/Docker.app') {
        calls.push(`exists ${path}`);
        return fixture.noDockerApp !== true;
      }
      if (path === GIT_AI_DIR) return fixture.aiFolders !== undefined;
      if (BUILT_PATHS.includes(path))
        return (fixture.built ?? []).includes(path);
      // The marker is there exactly when `read` returns it.
      const marker = /^\/repo\/\.git\/worktrees\/(.+)\/CLAUDE_BASE$/.exec(path);
      if (marker?.[1] !== undefined)
        return fixture.trees[marker[1]]?.marker !== false;
      if (/\/CLAUDE_BASE$/.test(path)) return false;
      const checkout = gradleOf(path);
      if (checkout !== undefined) return checkout in gradle;
      if (path === ndkDir) return fixture.ndks !== undefined;
      const name = byPath.get(path);
      return name === undefined || fixture.trees[name]?.gone !== true;
    },
    mtime: path => {
      const match = /^\/repo\/\.git\/worktrees\/(.+)\/(HEAD|index)$/.exec(path);
      if (match?.[1] === undefined) return undefined;
      const touched = fixture.trees[match[1]]?.touched ?? OLD;
      return match[2] === 'index' ? touched : Math.min(touched, OLD) - DAY;
    },
    run: async (command, args, timeoutMs) => {
      calls.push(`${command} ${args.join(' ')} @${timeoutMs}`);
      const failed = fixture.fail?.(command, args);
      if (failed) return failed;
      if (command === 'git' && args.includes('--git-common-dir'))
        return ok(`${PRIMARY}/.git\n`);
      if (command === 'git' && args[0] === 'rev-parse') return ok(`${SELF}\n`);
      if (command === '/usr/bin/which') return ok('/usr/local/bin/docker\n');
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'list')
        return ok(porcelain(fixture));
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'prune')
        return ok(
          '',
          'Removing worktrees/copy30: gitdir file points to non-existent location\n',
        );
      if (command === 'lsof' && args[2] === '-FcRn')
        return ok(
          (fixture.lsof ?? [])
            .map(
              ({ pid, parent, command: name, cwd }) =>
                `p${pid}\nR${parent}\nc${name}\nfcwd\nn${cwd}\n`,
            )
            .join(''),
        );
      if (command === 'brew')
        return ok(args[1] === '--dry-run' ? BREW_DRY : BREW_REAL);
      if (command === 'lsof')
        return ok(
          (fixture.cwds ?? []).map(cwd => `p1\nfcwd\nn${cwd}`).join('\n'),
        );
      if (command === 'git' && args[0] === '--no-optional-locks') {
        const name = byPath.get(args[2] ?? '') ?? '';
        const tree = fixture.trees[name];
        if (args[3] === 'status') return ok(tree?.status ?? '');
        if (args[3] === 'ls-files')
          return ok(
            (args.at(-1) === '--directory'
              ? (tree?.ignored ?? [])
              : (tree?.ignoredInside ?? [])
            )
              .map(path => `${path}\0`)
              .join(''),
          );
        return ok(tree?.remote ?? 'refs/remotes/origin/main\n');
      }
      if (command === 'du')
        return ok(
          args
            .slice(1)
            .map(path => `${fixture.kib ?? KIB}\t${path}`)
            .join('\n'),
        );
      if (command === 'docker' && args[0] === 'ps')
        return ok((fixture.services ?? []).join('\n'));
      if (command === 'docker' && args[0] === 'info')
        return fixture.docker === false
          ? exit(1, 'Cannot connect to the Docker daemon')
          : ok('29.8.2\n');
      if (command === 'docker' && args[0] === 'system')
        return ok(
          'Images 2.7GB\nContainers 36MB\nLocal Volumes 3GB\nBuild Cache 792.3GB\n',
        );
      if (command === 'docker' && args[0] === 'buildx')
        return ok('ID\tRECLAIMABLE\tSIZE\nabc\ttrue\t1GB\nTotal:\t640.5GB\n');
      if (command === 'ps')
        return ok(
          `${(fixture.processes ?? ['/sbin/launchd', 'ps -A -ww -o command=']).join('\n')}\n`,
        );
      return ok();
    },
  };
  return { env, calls, lines, losslessCalls };
}

/** The result of the step named `name`. */
function stepOf(results: StepResult[], name: string) {
  return results.find(result => result.step === name);
}

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
        `git --no-optional-locks -C ${WT}/x ls-files --others --ignored --exclude-standard -z -- .local/ .wt/ @${COMMAND_TIMEOUT_MS}`,
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
