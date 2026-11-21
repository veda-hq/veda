/**
 * The fake machine the `sarathi worktree cleanup` tests share: settings,
 * fixed paths and times, and `harness`, an Env over a Fixture that records
 * every call. Named *.test.ts so it stays out of the build and coverage.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SweepOutcome, SweepRequest } from '../services/prune.ts';
import type { ChildOutcome } from '../services/run-child.ts';
import { parseSettings, type WorktreeSettings } from './settings.ts';
import { IDLE_DAYS, type ArchivedFolder, type Env, type StepResult } from './cleanup.ts';

/** Where a project's tooling keeps a worktree's nested copy. */
export const COPY_DIR = '.wt/copy';
/**
 * The nested copies the test project names: COPY_DIR or its numbered
 * successor, as JSON writes the pattern in `.claude/sarathi.json`.
 */
export const COPIES_JSON = String.raw`"^\\.wt\\/copy(?:-\\d{15}-\\d{8})?$"`;
export const COPY_SOURCE = JSON.parse(COPIES_JSON) as string;
export const COPY_NAME = new RegExp(COPY_SOURCE);
/** The services file's Compose prefix and root label. */
export const SERVICES = { project: 'acme', rootLabel: 'com.acme.root' };
export const PRIMARY_BUILT = [
  '.turbo',
  'apps/mobile/android/build',
  'apps/mobile/android/app/build',
  'apps/mobile/android/.cxx',
  'apps/mobile/android/app/.cxx',
  'apps/mobile/android/.gradle',
];
/** The project's settings: every cleanup switch on, as a project that wants them all sets them. */
export const SETTINGS: WorktreeSettings = parseSettings(
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
export const BARE: WorktreeSettings = parseSettings({ name: 'acme' }, '.claude/sarathi.json', '/repo');

export const NOW = Date.parse('2026-11-04T00:00:00Z');
export const DAY = 86_400_000;
export const OLD = NOW - (IDLE_DAYS + 1) * DAY;
export const PRIMARY = '/repo';
export const WT = '/repo/.claude/worktrees';
export const SELF = `${WT}/self`;
export const COMMON = '/repo/.git/worktrees';
export const GIT_AI_DIR = '/repo/.git/ai/worktrees';
export const AT = { self: SELF, primary: PRIMARY, copies: COPY_NAME, project: SERVICES.project };
export const HOME = '/Users/me';
export const DOCKER_INSTALL = `${HOME}/Library/Application Support/com.docker.install`;

export const ok = (stdout = '', stderrTail = ''): ChildOutcome => ({
  kind: 'ok',
  code: 0,
  stdout,
  stderrTail,
});
export const exit = (code: number, stderrTail = '', stdout = ''): ChildOutcome => ({
  kind: 'exit',
  code,
  stdout,
  stderrTail,
});

export interface Fixture {
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

export const SDK = `${HOME}/Library/Android/sdk`;
export const PINNED = '27.1.12297006';
export const STRAY = '28.2.13676358';
export const GRADLE = 'apps/mobile/android/build.gradle';
export const pins = (version: string) =>
  `buildscript {\n    ext {\n        ndkVersion = "${version}"\n    }\n}\n`;
export const NO_NDK_DIR = `– android NDKs (skipped: no Android NDK folder at ${SDK}/ndk)`;

/** The cleanup process itself. */
export const PID = 4242;
export const GRADLE_CACHES = `${HOME}/.gradle/caches`;
export const PRIMARY_OUTPUT = [
  '.turbo',
  'apps/mobile/android/build',
  'apps/mobile/android/app/build',
  'apps/mobile/android/.cxx',
  'apps/mobile/android/app/.cxx',
  'apps/mobile/android/.gradle',
].map(path => `${PRIMARY}/${path}`);
/** What the caches step may delete; only these consult `built`. */
export const BUILT_PATHS = [...PRIMARY_OUTPUT, GRADLE_CACHES];
/** `du -sk` gives each path 1,000,000 KiB: 1.0 GB. */
export const KIB = 1_000_000;
export const BREW_DRY =
  '==> This operation would free approximately 1.8GB of disk space.\n';
export const BREW_REAL =
  '==> This operation has freed approximately 1.8GB of disk space.\n';
export const DAEMON_LINE =
  '  77 /usr/bin/java -Xmx2048m -classpath /home/me/.gradle/wrapper/dists/gradle-8.14/lib/gradle-daemon-main-8.14.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.14';

/** Writes `text` to `dir/name`; resolves the path. */
export function writeAt(dir: string, name: string, text: string) {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

export function pathOf(name: string, fixture: Fixture) {
  const at = fixture.trees[name]?.at ?? name;
  return at.startsWith('/') ? at : `${WT}/${at}`;
}

export function porcelain(fixture: Fixture) {
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

export function harness(fixture: Fixture) {
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
export function stepOf(results: StepResult[], name: string) {
  return results.find(result => result.step === name);
}
