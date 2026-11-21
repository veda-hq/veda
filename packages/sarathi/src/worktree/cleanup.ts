// `sarathi worktree cleanup`: frees the disk a project's agent tooling leaves
// behind, one step at a time; a failed step is reported and the next one
// still runs. What it may touch beyond its own steps comes from the
// `worktree.cleanup` object of the primary checkout's `.claude/sarathi.json`
// (settings.ts), read once before the first step; a machine step it leaves
// off is skipped, with the reason SETTINGS_OFF, never failed.
//
//   1. Leftover worktrees. Only those Claude Code made itself (subagents,
//      EnterWorktree, scheduled runs), which it marks with a `CLAUDE_BASE`
//      file in the worktree's gitdir, and only when every one of these holds:
//      not the checkout running this, not locked, no git activity for
//      IDLE_DAYS, no process or running dev service working in it, no
//      uncommitted or untracked file, HEAD on a remote branch, no checkout
//      nested in it. Its nested copies (`cleanup.nestedCopies`), held to the
//      same, go with it. Ignored files no other checkout holds (all but
//      REBUILT output, links and copies of the primary checkout's) are first
//      copied to the archive (archiveDir), in a folder named for the worktree.
//      The desktop app's session worktrees (APP_WORKTREES) carry no marker
//      and are never removed: a session whose folder vanished outside the app
//      does not resume (it asks for workspace trust), while the app's own
//      Settings › Storage › "Clean up inactive sessions" checks the branch
//      out again on resume (step 5 only trims them). A markerless worktree
//      elsewhere (another agent's) is kept and named. A locked registration
//      whose folder is gone is reported with the unlock command; cleanup
//      never unlocks it. The primary checkout is never removed; only the
//      caches step touches it, and only its rebuildable build output
//      (`cleanup.primaryBuilt`), never anything else.
//   2. The worktree archive (toDrop): a folder ARCHIVE_KEEP_DAYS past its
//      last copy goes, then the oldest while the archive holds over
//      ARCHIVE_CAP_BYTES.
//   3. `git worktree prune`: registrations whose folder is already gone.
//   4. git-ai's folders (GIT_AI) for worktrees nothing names any more: none
//      listed by git, no gitdir, no folder under APP_WORKTREES.
//   5. Idle app worktrees: in each desktop-app worktree with no git activity
//      for APP_IDLE_DAYS, no process and no running dev services in it, only
//      its REBUILT folders are deleted and its idle nested copies removed
//      (judged as in step 1). Its folder, branch, tracked and untracked files
//      stay.
//   6. Docker: the hourly sweep of `sarathi services prune` (prune.ts:
//      archived worktree stacks, stopped containers, unused images and
//      volumes), run in-process when the project names a services file, then
//      every build-cache record no build is using. Only the next build pays:
//      it starts cold. With no daemon it is skipped (a Skip), not failed.
//   7. Docker Desktop's staged update (DOCKER_INSTALL/in_progress), when
//      `machine.dockerDesktopUpdate` is on, only when DOCKER_APP is installed
//      and no Docker Desktop process (app, backend or installer) runs;
//      otherwise skipped, with the reason. A process listing that fails or
//      lists nothing fails the step and keeps the folder.
//   8. Android NDKs (pruneNdks), when `machine.androidNdk` names the
//      build.gradle that pins one: every version folder under
//      `$ANDROID_HOME/ndk` that no listed worktree's build.gradle pins. No
//      pin found: failed, nothing deleted. No NDK folder: skipped.
//   9. Caches that rebuild themselves: the pnpm store's unreferenced
//      packages, simulators Xcode no longer supports (`machine.simulators`),
//      `brew cleanup` (`machine.brew`, when brew is installed), the primary
//      checkout's `cleanup.primaryBuilt` (when no process works in it and no
//      Gradle daemon or build runs; one cold build), and GRADLE_CACHES
//      (`machine.gradleCaches`, when no Gradle daemon or build runs; the next
//      build downloads again, `~/.gradle/wrapper` stays). Each part gives its
//      size or why it is skipped; a skipped part leaves the step ✓, a failed
//      one fails it, and the other parts still run.
//
// `--dry-run` prints what each step would remove and removes nothing.
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  statfsSync,
  utimesSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadServicesFile, servicesPath } from '../services/file.ts';
import { detail as errorDetail, sweepOnce, type SweepOutcome, type SweepRequest } from '../services/prune.ts';
import { projectName, type ReapSettings } from '../services/reaper.ts';
import { failure, runChild, type ChildOutcome } from '../services/run-child.ts';
import { cleanupOf, readSettings, type CleanupSettings, type WorktreeSettings } from './settings.ts';

/** A worktree git touched more recently than this may be in use. */
export const IDLE_DAYS = 3;
/**
 * A desktop-app worktree idle this long loses its rebuildable output: the
 * app may hand it to a new session, which reinstalls anyway.
 */
export const APP_IDLE_DAYS = 14;
const DAY_MS = 86_400_000;
/** A worktree removal deletes its node_modules; that can take minutes. */
export const COMMAND_TIMEOUT_MS = 1_200_000;
/** `docker info` answers in seconds, or the daemon is not up. */
export const DAEMON_TIMEOUT_MS = 60_000;
/** The marker Claude Code writes into the gitdir of a worktree it creates. */
const CLAUDE_MARKER = 'CLAUDE_BASE';
/**
 * Where the desktop app makes its session worktrees, under the primary
 * checkout. A markerless worktree elsewhere (another agent's, such as
 * `~/.codex/worktrees/*`) is no app session: it is listed by path, never
 * counted.
 */
export const APP_WORKTREES = '.claude/worktrees';
const APP_WORKTREE = 'a desktop-app session worktree';
const NOT_CLAUDE = 'not made by Claude Code';
const GONE = 'its folder is gone';
/** Why a step, or a part of one, the settings leave off did nothing. */
export const SETTINGS_OFF = 'off in .claude/sarathi.json';
/**
 * Ignored paths the next install, build, test, lint or mutation run makes
 * again: disposable caches, plus build output (web, Android
 * `build`/`.cxx`/`.gradle`, iOS `build`, SwiftPM `.build`: measured at 43 of
 * the 48 GB an archive would otherwise copy), and CocoaPods' `ios/Pods`,
 * which `pod install` makes again (about 7 GB per worktree, measured).
 */
export const REBUILT =
  /(?:^|\/)ios\/Pods(?:\/|$)|(?:^|\/)(?:node_modules|\.turbo|\.cache|__pycache__|dist|build|\.build|\.cxx|\.gradle|node-compile-cache|coverage|reports|\.stryker-tmp|\.eslintcache)(?:\/|$)|\.tsbuildinfo$|(?:^|\/)(?:stryker\.log|\.DS_Store)$|^\.husky\/_\//;
/**
 * Where a removed worktree's ignored files go, under the primary checkout
 * (its .git is the common git directory, which outlives every worktree),
 * named for the project's `worktree.name`.
 */
export function archiveDir(name: string): string {
  return `.git/${name}/worktree-archive`;
}
/** An archived worktree's folder this old is deleted. */
export const ARCHIVE_KEEP_DAYS = 30;
/** Past this, the oldest archived folders go first, whatever their age. */
export const ARCHIVE_CAP_BYTES = 10e9;
/**
 * git-ai's per-worktree folders (logs, working logs), under the common git
 * directory, each named after a worktree.
 */
export const GIT_AI = '.git/ai/worktrees';
/** Docker Desktop, installed. */
const DOCKER_APP = '/Applications/Docker.app';
/** Where Docker Desktop stages a downloaded update, under the home folder. */
const DOCKER_INSTALL = 'Library/Application Support/com.docker.install';
/** The staged update's folder there (2.2 GiB for Docker Desktop 4.95). */
const STAGED = 'in_progress';
/**
 * A Docker Desktop process on a `ps -o command=` line: anything run from the
 * app or from com.docker.install (the installer), or the app, its backend or
 * the installer by bare name. The root helpers in /Library/PrivilegedHelperTools
 * (vmnetd, socket) and the docker CLI do not count.
 */
const DOCKER_DESKTOP =
  /\/Applications\/Docker\.app\/|\/com\.docker\.install\/|\/com\.docker\.(?:backend|install)(?: |$)|^(?:Docker Desktop|com\.docker\.backend|com\.docker\.install)(?: |$)/;
/**
 * Gradle's downloaded dependencies and transforms, under the home folder.
 * Its distributions, `.gradle/wrapper`, stay.
 */
export const GRADLE_CACHES = '.gradle/caches';
/** A Gradle daemon (GradleDaemon) or build (GradleMain, GradleWrapperMain). */
const GRADLE_PROCESS = /\borg\.gradle\.(?:launcher|wrapper)\.[\w.]+/;
/** The Compose project label `docker ps` prints for each running container. */
const COMPOSE_PROJECT = '{{.Label "com.docker.compose.project"}}';

export type Run = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<ChildOutcome>;

/** One archived worktree's folder under ARCHIVE. */
export interface ArchivedFolder {
  name: string;
  /**
   * When the folder last took a file, in ms: the newest madeAt of it or
   * anything in it, so a folder archived into again starts its days again.
   */
  made: number;
  /** The bytes of every file in it. */
  bytes: number;
}

/** A services file's names: its Compose prefix and its root label. */
export type ServiceNames = Pick<ReapSettings, 'project' | 'rootLabel'>;

/** What cleanup touches outside its own logic; tests pass their own. */
export interface Env {
  run: Run;
  /** The checkout cleanup runs in. */
  cwd: string;
  /** The user's home folder. */
  home: string;
  /** The worktree settings in the primary checkout's `.claude/sarathi.json`; throws when unusable. */
  settings: (primary: string) => WorktreeSettings;
  /** The names in the services file `file` (`worktree.services`); throws when unreadable. */
  services: (file: string, primary: string) => ServiceNames;
  /** One Docker sweep, as `sarathi services prune run` makes it. */
  sweep: (request: SweepRequest) => Promise<SweepOutcome>;
  /** Modification time in ms; undefined when the file cannot be read. */
  mtime: (path: string) => number | undefined;
  /** File contents; undefined when the file cannot be read. */
  read: (path: string) => string | undefined;
  /**
   * Whether removing `path` loses nothing: it is a symbolic link (removal
   * takes the link, never its target), or it and `copy` read the same bytes.
   */
  lossless: (path: string, copy: string) => boolean;
  /**
   * Copies file `from` to `to`, making its folders. A `to` that already
   * holds the same bytes is done (a rerun after an interruption); one that
   * holds other bytes throws, so nothing is overwritten.
   */
  archive: (from: string, to: string) => void;
  /** The folders directly in `dir`, none when it is missing; throws when unreadable. */
  archived: (dir: string) => ArchivedFolder[];
  /**
   * The name of every entry directly in `dir`, of any kind, none when it is
   * missing; throws when unreadable. Reads no folder's contents.
   */
  names: (dir: string) => string[];
  /** Deletes folder `path` and everything in it. */
  drop: (path: string) => void;
  /**
   * Whether anything is at `path` (a link counts by its target); throws when
   * that cannot be told, so an unreachable path never reads as gone.
   */
  exists: (path: string) => boolean;
  /** Free bytes on the volume holding `path`. */
  freeBytes: (path: string) => number;
  now: () => number;
  platform: NodeJS.Platform;
  /** `$ANDROID_HOME`, the Android SDK, when set. */
  androidHome: string | undefined;
  /**
   * This process's id: it, its ancestors and its children (lsof) run
   * cleanup, so they are no process working in the primary checkout.
   */
  pid: number;
  stdout: (line: string) => void;
}

export interface Worktree {
  path: string;
  locked: boolean;
  /** The text on its `locked` line; absent when it gives none. */
  lockReason?: string;
  /**
   * Its folder is gone; `git worktree prune` drops the registration. Never
   * set on a locked one: git neither marks nor prunes it.
   */
  prunable: boolean;
}

/** Parses `git worktree list --porcelain`; the primary checkout comes first. */
export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain.split('\n\n').flatMap(block => {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (path === undefined) return [];
    const lockReason = /^locked (.+)$/m.exec(block)?.[1];
    return [
      {
        path,
        locked: /^locked( |$)/m.test(block),
        ...(lockReason === undefined ? {} : { lockReason }),
        prunable: /^prunable( |$)/m.test(block),
      },
    ];
  });
}

/**
 * `text` as one shell word, so a printed command can be pasted as is: bare
 * when it holds only characters no shell treats specially, else single-quoted.
 */
export function shellWord(text: string) {
  return /^[\w@%+=:,./-]+$/.test(text)
    ? text
    : `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Why a locked registration whose folder is gone stays, with the commands
 * that let the next run prune it. Cleanup never unlocks it: the lock is
 * another tool's.
 */
function goneButLocked(tree: Worktree) {
  const by =
    tree.lockReason === undefined
      ? 'with no reason given'
      : `by ${tree.lockReason}`;
  return `registered but gone, locked ${by}: \`git worktree unlock ${shellWord(tree.path)}\` then \`sarathi worktree cleanup\` prunes it`;
}

/** The working directory of every running process, from `lsof -d cwd -Fn`. */
export function parseCwds(lsof: string): string[] {
  return lsof
    .split('\n')
    .filter(line => line.startsWith('n/'))
    .map(line => line.slice(1));
}

/** A running process and where it works, from `lsof -d cwd -FcRn`. */
export interface Process {
  pid: number;
  /** Its parent's pid; 0 when lsof gives none. */
  parent: number;
  command: string;
  cwd: string;
}

/** A whole count from a listing; 0 when it is none. */
function count(text: string) {
  const value = /^\+?\d+$/.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(value) ? value : 0;
}

/** Parses `lsof -d cwd -FcRn`: per process a `p`, `R` and `c` line, then `n`. */
export function parseProcesses(lsof: string): Process[] {
  const found: Process[] = [];
  const none = { pid: 0, parent: 0, command: '' };
  let at: Omit<Process, 'cwd'> = { ...none };
  for (const line of lsof.split('\n')) {
    const value = line.slice(1);
    if (line.startsWith('p')) at = { ...none, pid: count(value) };
    else if (line.startsWith('R')) at.parent = count(value);
    else if (line.startsWith('c')) at.command = value;
    else if (line.startsWith('n/')) found.push({ ...at, cwd: value });
  }
  return found;
}

/** The bytes `du -sk` lists: each line's KiB, before its tab, as bytes. */
export function duBytes(du: string) {
  return du
    .split('\n')
    .reduce(
      (sum, line) => sum + count(line.slice(0, line.indexOf('\t'))) * 1024,
      0,
    );
}

/** What `brew cleanup` says it freed, or would free; undefined for nothing. */
export function brewFreed(text: string) {
  return /(?:would free|has freed) approximately (\S+) of disk space/.exec(
    text,
  )?.[1];
}

/** Whether `path` is `parent` or lies under it. */
export function inside(path: string, parent: string) {
  return path === parent || path.startsWith(`${parent}/`);
}

/** A command's trimmed stdout; any other ending throws, naming how it ended. */
async function output(env: Env, command: string, args: string[]) {
  const outcome = await env.run(command, args, COMMAND_TIMEOUT_MS);
  if (outcome.kind !== 'ok')
    throw new Error(`${command} ${args.join(' ')}: ${failure(outcome)}`);
  return outcome.stdout.trim();
}

/** The gitdir a linked worktree's `.git` file points at. */
export function gitdirOf(env: Env, path: string) {
  const pointer = env.read(join(path, '.git'))?.match(/^gitdir: (.+)$/m)?.[1];
  return pointer === undefined ? undefined : resolve(path, pointer.trim());
}

/**
 * The working directory of every running process, listed now. Only a clean
 * exit is a whole listing: lsof exits 1 when some processes could not be
 * read, and one of those may work in a worktree. Any other ending throws, so
 * no worktree is judged unused on a partial or failed listing.
 */
async function processCwds(env: Env) {
  const lsof = await env.run('lsof', ['-d', 'cwd', '-Fn'], COMMAND_TIMEOUT_MS);
  if (lsof.kind === 'ok') return parseCwds(lsof.stdout);
  throw new Error(`lsof -d cwd -Fn: ${failure(lsof)}`);
}

/**
 * Compose projects with a running container (`sarathi services` names a
 * worktree's projectName(prefix, root)). None when Docker is absent or its
 * daemon is down: nothing runs there.
 */
async function runningProjects(env: Env) {
  const ps = await env.run(
    'docker',
    ['ps', '--format', COMPOSE_PROJECT],
    DAEMON_TIMEOUT_MS,
  );
  if (ps.kind === 'ok') return ps.stdout.split('\n');
  if (dockerAbsent(ps)) return [];
  throw new Error(`docker ps: ${failure(ps)}`);
}

/**
 * How the docker CLI says its daemon is not up: "Cannot connect to the Docker
 * daemon" (Linux, older CLIs), or, from CLI 29.x (29.9.2 on macOS), "failed
 * to connect to the docker API at <endpoint>".
 */
const DAEMON_DOWN =
  /Cannot connect to the Docker daemon|failed to connect to the docker API at /;

/**
 * Docker is not installed (no executable) or its daemon is not up. Any other
 * failure (permission, timeout) is an error, never a quiet skip.
 */
function dockerAbsent(outcome: ChildOutcome) {
  return (
    (outcome.kind === 'spawn-error' && outcome.errno === 'ENOENT') ||
    DAEMON_DOWN.test(outcome.stderrTail)
  );
}

/**
 * The checkout running cleanup, the primary one worktrees copy from, and
 * the project's names for what lives in a worktree.
 */
export interface Checkouts {
  self: string;
  primary: string;
  /** A worktree's nested copies, paths from it (`cleanup.nestedCopies`); none match without it. */
  copies?: RegExp | undefined;
  /** The services file's Compose prefix; without one no worktree runs services. */
  project?: string | undefined;
}

/** Whether `path`, relative to a worktree, names one of its nested copies. */
function isCopy(at: Checkouts, path: string) {
  return at.copies?.test(path) === true;
}

/** The project's settings, read once before any step. */
export interface Project {
  /** The primary checkout: the parent of the common git directory. */
  primary: string;
  /** `worktree.name`, which names the archive. */
  name: string;
  cleanup: CleanupSettings;
  /** `cleanup.nestedCopies`, compiled. */
  copies: RegExp | undefined;
  /** The services file's names; undefined when the project names none. */
  services: ServiceNames | undefined;
}

/** Reads the project's settings from the primary checkout; throws when they are unusable. */
async function loadProject(env: Env): Promise<Project> {
  const common = await output(env, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const primary = dirname(common);
  const settings = env.settings(primary);
  const cleanup = cleanupOf(settings);
  return {
    primary,
    name: settings.name,
    cleanup,
    copies: cleanup.nestedCopies === undefined ? undefined : new RegExp(cleanup.nestedCopies),
    services: settings.services === undefined ? undefined : env.services(settings.services, primary),
  };
}

/** The checkouts for a step: `self`, the listed primary, and the project's names. */
function checkoutsOf(self: string, primary: string, project: Project): Checkouts {
  return { self, primary, copies: project.copies, project: project.services?.project };
}

/**
 * Why a worktree must stay, or undefined when removing it loses nothing.
 * The caller removes it right after: the in-use checks, which a session can
 * start to fail at any moment, come last, on fresh listings, and
 * `git worktree remove` itself still refuses modified or untracked files.
 */
export async function keepReason(
  env: Env,
  tree: Worktree,
  at: Checkouts,
  copies: Worktree[] = [],
): Promise<string | undefined> {
  if (inside(at.self, tree.path)) return 'this checkout';
  if (tree.locked)
    return env.exists(tree.path) ? 'locked' : goneButLocked(tree);
  if (tree.prunable) return GONE;
  const gitdir = gitdirOf(env, tree.path);
  if (gitdir === undefined) return 'its .git file names no gitdir';
  if (env.read(join(gitdir, CLAUDE_MARKER)) === undefined)
    return inside(tree.path, join(at.primary, APP_WORKTREES))
      ? APP_WORKTREE
      : NOT_CLAUDE;
  const busy = recentActivity(env, gitdir);
  if (busy !== undefined) return busy;
  const unsaved =
    (await unsavedWork(env, tree.path, 'all')) ??
    (await nestedCheckout(env, tree.path, at));
  if (unsaved !== undefined) return unsaved;
  // Its nested copies go with it, so each must be as idle and as saved;
  // untracked files there do not keep it here, but git refuses to remove a
  // copy that has any.
  const copyNotes = await inSequence(copies, async copy => {
    const reason = await copyKeepReason(env, copy, at);
    return reason === undefined ? undefined : `${copy.path}: ${reason}`;
  });
  const copyWork = copyNotes.find(note => note !== undefined);
  if (copyWork !== undefined) return copyWork;
  // Removing the folder lets the hourly sweep reap its stack, volume and all.
  return inUse(env, tree.path, at);
}

/**
 * Why running dev services or a process keep `path`, on listings taken now,
 * or undefined. One listing covers the nested copies too: they sit inside.
 * Without a services file no worktree runs services, so only processes count.
 */
async function inUse(env: Env, path: string, at: Checkouts) {
  if (at.project !== undefined) {
    const running = await runningProjects(env);
    if (running.includes(projectName(at.project, path)))
      return 'its dev services are running';
  }
  const cwds = await processCwds(env);
  return cwds.some(cwd => inside(cwd, path))
    ? 'a process works in it'
    : undefined;
}

/**
 * Why git activity keeps a worktree, or undefined when it has been idle for
 * IDLE_DAYS. A checkout, commit or staged change writes HEAD or the index.
 * Not the reflog: reflog expiry empties logs/HEAD of a worktree nobody
 * touches.
 */
function recentActivity(
  env: Env,
  gitdir: string,
  days = IDLE_DAYS,
): string | undefined {
  const times = ['HEAD', 'index'].map(file => env.mtime(join(gitdir, file)));
  // Unreadable is not old: without both times, inactivity is unproven.
  if (times.some(time => time === undefined))
    return 'when git last touched it cannot be read';
  if (env.now() - Math.max(...times.map(Number)) < days * DAY_MS)
    return `git activity in the last ${days} days`;
  return undefined;
}

/** Why a nested copy keeps its worktree; its untracked files don't count. */
async function copyKeepReason(
  env: Env,
  copy: Worktree,
  at: Checkouts,
): Promise<string | undefined> {
  if (copy.locked) return 'locked';
  const gitdir = gitdirOf(env, copy.path);
  if (gitdir === undefined) return 'its .git file names no gitdir';
  return (
    recentActivity(env, gitdir) ??
    (await unsavedWork(env, copy.path, 'no')) ??
    (await nestedCheckout(env, copy.path, at))
  );
}

/** Why an ignored checkout nested in `root` keeps it, or undefined. */
async function nestedCheckout(env: Env, root: string, at: Checkouts) {
  const { checkouts } = await ignoredLoss(env, root, at);
  return checkouts[0] === undefined
    ? undefined
    : `it holds a checkout git does not list: ${checkouts[0]}`;
}

/**
 * What removing `root` would lose among its ignored paths: files, which
 * cleanup archives first, and nested checkouts, which keep it. Not lost:
 * REBUILT output, a symbolic link (one pointing at the primary checkout's
 * folder), a byte-identical copy of the primary checkout's file (the .env
 * files a worktree is set up with), and a nested copy, which is judged on
 * its own. Paths are relative to `root`.
 */
async function ignoredLoss(env: Env, root: string, at: Checkouts) {
  const { primary } = at;
  const ignored = async (args: string[]) =>
    (
      await output(env, 'git', [
        '--no-optional-locks',
        '-C',
        root,
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '-z',
        ...args,
      ])
    )
      .split('\0')
      .filter(path => path !== '' && !REBUILT.test(path));
  // --directory names a wholly ignored folder once, never node_modules'
  // files; only the folders that are not REBUILT get listed file by file.
  const top = await ignored(['--directory']);
  const folders = top.filter(path => path.endsWith('/'));
  const inner = folders.length === 0 ? [] : await ignored(['--', ...folders]);
  const paths = [...top.filter(path => !path.endsWith('/')), ...inner];
  return {
    files: paths.filter(
      path =>
        !path.endsWith('/') &&
        !env.lossless(join(root, path), join(primary, path)),
    ),
    checkouts: paths.filter(
      path => path.endsWith('/') && !isCopy(at, path.slice(0, -1)),
    ),
  };
}

/**
 * Work in a checkout that removing it would lose, or undefined: changes, or
 * a HEAD no remote branch contains. `untracked: 'no'` ignores untracked
 * files, for a nested copy, whose untracked files are its own build
 * output (cloned Pods, codegen, linked packages).
 * --no-optional-locks: status must not refresh the index, or the check
 * itself would read as activity on the next run.
 */
async function unsavedWork(
  env: Env,
  path: string,
  untracked: 'all' | 'no',
): Promise<string | undefined> {
  const git = (args: string[]) =>
    output(env, 'git', ['--no-optional-locks', '-C', path, ...args]);
  const status = await git([
    'status',
    '--porcelain',
    `--untracked-files=${untracked}`,
  ]);
  if (status !== '')
    return untracked === 'all'
      ? 'uncommitted or untracked files'
      : 'uncommitted changes';
  const remote = await git([
    'for-each-ref',
    '--count=1',
    '--contains',
    'HEAD',
    '--format=%(refname)',
    'refs/remotes',
  ]);
  return remote === '' ? 'HEAD is on no remote branch' : undefined;
}

export interface StepResult {
  step: string;
  ok: boolean;
  /** Why the step did nothing; set only on a skip, which is still ok. */
  skipped?: string;
  notes: string[];
}

/**
 * A step's answer when it does not apply here (no Docker daemon): reported
 * as `– <step> (skipped: <reason>)`, never ✓, and never a failure.
 */
export class Skip {
  readonly reason: string;
  readonly notes: string[];
  constructor(reason: string, notes: string[] = []) {
    this.reason = reason;
    this.notes = notes;
  }
}

/**
 * A step that failed after doing some of its work: reported ✗ with every
 * part's note, not only the error's.
 */
export class Failed extends Error {
  readonly notes: string[];
  constructor(notes: string[]) {
    super(notes.join('; '));
    this.notes = notes;
  }
}

/** Runs `run` over items one at a time: removals never overlap. */
async function inSequence<T, R>(
  items: T[],
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  return items.reduce<Promise<R[]>>(
    async (done, item) => [...(await done), await run(item)],
    Promise.resolve([]),
  );
}

async function step(
  name: string,
  action: () => Promise<string[] | Skip>,
): Promise<StepResult> {
  try {
    const done = await action();
    return done instanceof Skip
      ? { step: name, ok: true, skipped: done.reason, notes: done.notes }
      : { step: name, ok: true, notes: done };
  } catch (error) {
    // fail-open: the step is reported failed; the remaining steps still run.
    return {
      step: name,
      ok: false,
      notes: error instanceof Failed ? error.notes : [errorDetail(error)],
    };
  }
}

/** The listed worktrees that are nested copies (`at.copies`) in `tree`. */
function copiesIn(tree: Worktree, linked: Worktree[], at: Checkouts) {
  return linked.filter(other => isCopy(at, relative(tree.path, other.path)));
}

/** Ignored files of `tree` and its copies no other checkout holds, relative to `tree`. */
async function lostFiles(
  env: Env,
  tree: Worktree,
  linked: Worktree[],
  at: Checkouts,
) {
  const roots = [tree, ...copiesIn(tree, linked, at)];
  const lost = await inSequence(roots, async root =>
    (await ignoredLoss(env, root.path, at)).files.map(file =>
      relative(tree.path, join(root.path, file)),
    ),
  );
  return lost.flat();
}

/**
 * keepReason, then whether `tree` holds another listed worktree: its copies
 * go with it, while any other worktree inside it is judged on its own and
 * keeps it.
 */
async function judge(
  env: Env,
  tree: Worktree,
  at: Checkouts,
  linked: Worktree[],
): Promise<string | undefined> {
  const reason = await keepReason(env, tree, at, copiesIn(tree, linked, at));
  if (reason !== undefined) return reason;
  const copies = new Set(linked.flatMap(other => copiesIn(other, linked, at)));
  const held = linked.find(
    other =>
      other !== tree && !copies.has(other) && inside(other.path, tree.path),
  );
  return held === undefined ? undefined : `it holds ${held.path}`;
}

async function linkedWorktrees(env: Env) {
  const [primary, ...linked] = parseWorktrees(
    await output(env, 'git', ['worktree', 'list', '--porcelain']),
  );
  if (primary === undefined)
    throw new Error('git worktree list --porcelain named no checkout');
  return { primary, linked };
}

async function removeWorktrees(env: Env, dryRun: boolean, project: Project) {
  const self = await output(env, 'git', ['rev-parse', '--show-toplevel']);
  const { primary, linked } = await linkedWorktrees(env);
  const at = checkoutsOf(self, primary.path, project);
  const copies = new Set(linked.flatMap(tree => copiesIn(tree, linked, at)));
  let app = 0;
  const notes = await inSequence(
    linked.filter(tree => !copies.has(tree)),
    async (tree): Promise<string[]> => {
      const reason = await judge(env, tree, at, linked);
      if (reason === APP_WORKTREE) {
        app += 1;
        return [];
      }
      if (reason === GONE) return []; // the next step prunes it
      if (reason !== undefined) return [`kept ${tree.path}: ${reason}`];
      // Ignored files no other checkout holds move to the archive first,
      // paths kept relative to the worktree.
      const archive = join(
        primary.path,
        archiveDir(project.name),
        basename(tree.path),
      );
      const store = (files: string[]) => {
        for (const file of files)
          env.archive(join(tree.path, file), join(archive, file));
      };
      const files = await lostFiles(env, tree, linked, at);
      const archived = (count: number) =>
        count === 0 ? '' : `, ${count} ignored files to ${archive}`;
      if (dryRun) return [`would remove ${tree.path}${archived(files.length)}`];
      store(files);
      // Archiving takes time, in which a session can start here: judge it
      // again on a fresh listing, and remove what that listing names.
      const now = (await linkedWorktrees(env)).linked;
      const again = now.find(other => other.path === tree.path);
      if (again === undefined)
        return [
          `kept ${tree.path}: it left git worktree list, on a second look`,
        ];
      const late = await judge(env, again, at, now);
      if (late !== undefined)
        return [`kept ${tree.path}: ${late}, on a second look`];
      // So did the second look: archive once more what is lost now. A file
      // written since is copied; one rewritten since throws, and the
      // worktree stays.
      const last = await lostFiles(env, again, now, at);
      store(last);
      // Never --force: git itself refuses a copy, or the worktree, that has
      // changed or untracked files by the time it is removed.
      // Copies first, then the worktree; the first refusal stops the rest
      // and keeps this worktree, and the next worktrees are still judged.
      const refused: string[] = [];
      await inSequence([...copiesIn(tree, now, at), tree], async ({ path }) => {
        if (refused.length > 0) return;
        const gone = await env.run(
          'git',
          ['worktree', 'remove', path],
          COMMAND_TIMEOUT_MS,
        );
        if (gone.kind !== 'ok') refused.push(`${path}: ${failure(gone)}`);
      });
      const [first] = refused;
      if (first !== undefined)
        return [`kept ${tree.path}: git refused ${first}`];
      return [
        `removed ${tree.path}${archived(new Set([...files, ...last]).size)}`,
      ];
    },
  );
  return [
    ...notes.flat(),
    `${app} desktop-app session worktrees left to the app (Settings › Storage › Clean up inactive sessions); primary ${primary.path} untouched here (the caches step clears only its rebuildable build output)`,
  ];
}

/**
 * The archived folders to delete: every one
 * ARCHIVE_KEEP_DAYS old or older, then, while the rest still hold more than
 * ARCHIVE_CAP_BYTES, the oldest left. Oldest first; nothing is exempt.
 */
export function toDrop(folders: ArchivedFolder[], now: number) {
  const oldest = [...folders].sort(
    (a, b) => a.made - b.made || a.name.localeCompare(b.name),
  );
  const expired = (folder: ArchivedFolder) =>
    now - folder.made >= ARCHIVE_KEEP_DAYS * DAY_MS;
  const rest = oldest.filter(folder => !expired(folder));
  let held = rest.reduce((sum, folder) => sum + folder.bytes, 0);
  const over: ArchivedFolder[] = [];
  for (const folder of rest) {
    if (held <= ARCHIVE_CAP_BYTES) break;
    over.push(folder);
    held -= folder.bytes;
  }
  return [...oldest.filter(expired), ...over];
}

/** Bytes as GB, or MB below one GB. */
function size(bytes: number) {
  return bytes >= 1e9 ? gigabytes(bytes) : `${(bytes / 1e6).toFixed(1)} MB`;
}

async function sweepArchive(env: Env, dryRun: boolean, project: Project) {
  const { primary } = await linkedWorktrees(env);
  const dir = join(primary.path, archiveDir(project.name));
  const folders = env.archived(dir);
  if (folders.length === 0) return [`nothing archived in ${dir}`];
  const drop = toDrop(folders, env.now());
  const notes = drop.map(folder => {
    if (!dryRun) env.drop(join(dir, folder.name));
    const days = Math.floor((env.now() - folder.made) / DAY_MS);
    return `${dryRun ? 'would delete' : 'deleted'} ${folder.name}: ${days} days old, ${size(folder.bytes)}`;
  });
  const kept = folders.filter(folder => !drop.includes(folder));
  const held = kept.reduce((sum, folder) => sum + folder.bytes, 0);
  return [
    ...notes,
    `${kept.length} archived worktrees kept in ${dir}, ${size(held)}`,
  ];
}

async function pruneRegistrations(env: Env, dryRun: boolean) {
  const args = ['worktree', 'prune', '--verbose'];
  const outcome = await env.run(
    'git',
    [...args, ...(dryRun ? ['--dry-run'] : [])],
    COMMAND_TIMEOUT_MS,
  );
  if (outcome.kind !== 'ok')
    throw new Error(`git ${args.join(' ')}: ${failure(outcome)}`);
  // git reports each pruned registration on stderr.
  const pruned = outcome.stderrTail.trim();
  return pruned === '' ? ['nothing to prune'] : pruned.split('\n');
}

/** A desktop-app worktree, with the gitdir its `.git` file names. */
interface AppWorktree {
  tree: Worktree;
  gitdir: string;
}

/**
 * The desktop app's session worktrees: markerless, under APP_WORKTREES,
 * neither a nested copy nor gone. Step 1 names every other one. The
 * marker is judged by existence, not by reading it: one there but
 * unreadable still marks the worktree as Claude Code's.
 */
function appWorktrees(env: Env, linked: Worktree[], at: Checkouts) {
  const copies = new Set(linked.flatMap(tree => copiesIn(tree, linked, at)));
  return linked.flatMap((tree): AppWorktree[] => {
    if (
      copies.has(tree) ||
      tree.prunable ||
      !inside(tree.path, join(at.primary, APP_WORKTREES)) ||
      !env.exists(tree.path)
    )
      return [];
    const gitdir = gitdirOf(env, tree.path);
    return gitdir === undefined || env.exists(join(gitdir, CLAUDE_MARKER))
      ? []
      : [{ tree, gitdir }];
  });
}

/**
 * Why a nested copy stays rather than go with `git worktree remove`: as
 * step 1 judges a copy, and also when it holds ignored files no other
 * checkout holds, which the removal would delete unarchived.
 */
async function copyStays(env: Env, copy: Worktree, at: Checkouts) {
  const reason = await copyKeepReason(env, copy, at);
  if (reason !== undefined) return reason;
  const { files } = await ignoredLoss(env, copy.path, at);
  return files.length === 0
    ? undefined
    : `${files.length} ignored files no other checkout holds`;
}

/**
 * The REBUILT folders git lists as wholly ignored in `root`, relative to it.
 * A REBUILT name that is no folder (a link, a file) is left, and so is
 * anything inside an ignored folder that is not REBUILT (.tmp, .wt).
 */
async function rebuiltFolders(env: Env, root: string) {
  const listed = await output(env, 'git', [
    '--no-optional-locks',
    '-C',
    root,
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
    '--directory',
  ]);
  return listed
    .split('\0')
    .filter(path => path.endsWith('/') && REBUILT.test(path))
    .map(path => path.slice(0, -1));
}

/** What trimming an idle app worktree deletes, and the copies it keeps. */
interface Trim {
  /** REBUILT folders, relative to the worktree. */
  folders: string[];
  /** Nested copies that go with `git worktree remove`. */
  copies: Worktree[];
  /** `kept <copy>: <reason>` for each copy that stays. */
  kept: string[];
}

/**
 * What to trim from an app worktree, or why it stays: git activity within
 * APP_IDLE_DAYS, then, after its folders are listed and its copies judged
 * (as step 1 judges them), running dev services or a process, on listings
 * taken now. Any failed or partial listing throws.
 */
async function trimOf(
  env: Env,
  { tree, gitdir }: AppWorktree,
  linked: Worktree[],
  at: Checkouts,
): Promise<Trim | string> {
  if (inside(at.self, tree.path)) return 'this checkout';
  const busy = recentActivity(env, gitdir, APP_IDLE_DAYS);
  if (busy !== undefined) return busy;
  const folders = await rebuiltFolders(env, tree.path);
  const judged = await inSequence(
    copiesIn(tree, linked, at).filter(copy => !copy.prunable),
    async copy => ({
      copy,
      reason: await copyStays(env, copy, at),
    }),
  );
  const used = await inUse(env, tree.path, at);
  if (used !== undefined) return used;
  return {
    folders,
    copies: judged
      .filter(({ reason }) => reason === undefined)
      .map(j => j.copy),
    kept: judged.flatMap(({ copy, reason }) =>
      reason === undefined ? [] : [`kept ${copy.path}: ${reason}`],
    ),
  };
}

/** What kinds of output `folders` hold, as the report names them. */
function kinds(folders: string[]) {
  const modules = (folder: string) => basename(folder) === 'node_modules';
  const pods = (folder: string) => /(?:^|\/)ios\/Pods$/.test(folder);
  return [
    ...(folders.some(modules) ? ['node_modules'] : []),
    ...(folders.some(pods) ? ['ios/Pods'] : []),
    ...(folders.some(folder => !modules(folder) && !pods(folder))
      ? ['build output']
      : []),
  ];
}

/**
 * Bytes `paths` hold on disk, from `du -sk`: a hard-linked file (pnpm's
 * node_modules) counts once across them, as macOS frees it.
 */
async function diskBytes(env: Env, paths: string[]) {
  const du = await output(env, 'du', ['-sk', ...paths]);
  // A line that names no size (none on a normal run) adds nothing; the
  // pattern admits digits only.
  const kib = du.split('\n').reduce((sum, line) => {
    const kib = /^(\d+)\t/.exec(line)?.[1];
    return sum + count(kib ?? '');
  }, 0);
  return kib * 1024;
}

/**
 * Step 5: in each desktop-app worktree idle APP_IDLE_DAYS, deletes only
 * REBUILT folders and removes its idle nested copies, unforced. Its folder,
 * branch, tracked and untracked files stay; the session resumes after its
 * install (`pnpm install`, `pod install`). Judged again on fresh listings
 * just before deleting.
 */
async function trimAppWorktrees(env: Env, dryRun: boolean, project: Project) {
  const self = await output(env, 'git', ['rev-parse', '--show-toplevel']);
  const { primary, linked } = await linkedWorktrees(env);
  const at = checkoutsOf(self, primary.path, project);
  const apps = appWorktrees(env, linked, at);
  if (apps.length === 0)
    return [
      `no desktop-app session worktrees in ${join(at.primary, APP_WORKTREES)}`,
    ];
  const notes = await inSequence(apps, async (app): Promise<string[]> => {
    const { path } = app.tree;
    const first = await trimOf(env, app, linked, at);
    if (typeof first === 'string') return [`kept ${path}: ${first}`];
    if (first.folders.length === 0 && first.copies.length === 0)
      return [`nothing to trim in ${path}`, ...first.kept];
    const bytes = await diskBytes(env, [
      ...first.folders.map(folder => join(path, folder)),
      ...first.copies.map(copy => copy.path),
    ]);
    const what = (trim: Trim, copies: number) =>
      `${[...kinds(trim.folders), `${copies} nested copies`].join(', ')}, ${size(bytes)}; folder and branch stay`;
    if (dryRun)
      return [
        `would trim ${path}: ${what(first, first.copies.length)}`,
        ...first.kept,
      ];
    // A session can start here at any moment: judge it again on a fresh
    // listing, from its gitdir and marker as they are now, and delete what
    // that look names.
    const now = (await linkedWorktrees(env)).linked;
    const again = appWorktrees(env, now, at).find(
      other => other.tree.path === path,
    );
    if (again === undefined)
      return [
        `kept ${path}: no longer an unmarked app worktree in git worktree list, on a second look`,
      ];
    const last = await trimOf(env, again, now, at);
    if (typeof last === 'string')
      return [`kept ${path}: ${last}, on a second look`];
    for (const folder of last.folders) env.drop(join(path, folder));
    // Never --force: git refuses a copy that has changed or untracked files.
    const refused: string[] = [];
    await inSequence(last.copies, async copy => {
      const gone = await env.run(
        'git',
        ['worktree', 'remove', copy.path],
        COMMAND_TIMEOUT_MS,
      );
      if (gone.kind !== 'ok')
        refused.push(`kept ${copy.path}: git refused: ${failure(gone)}`);
    });
    return [
      `trimmed ${path}: ${what(last, last.copies.length - refused.length)}`,
      ...last.kept,
      ...refused,
    ];
  });
  return notes.flat();
}

/**
 * git-ai's folders for worktrees long gone. One goes when its name is none
 * of: a listed worktree's basename (the primary checkout's included, which
 * another agent may share), a gitdir under `.git/worktrees`, or a folder
 * under APP_WORKTREES (one git no longer lists may still hold unpushed
 * work, and its logs). Only folders are judged; a file beside them
 * (`.DS_Store`) stays.
 */
async function pruneGitAi(env: Env, dryRun: boolean) {
  const dir = join((await linkedWorktrees(env)).primary.path, GIT_AI);
  if (!env.exists(dir)) return new Skip(`no git-ai folder at ${dir}`);
  // Listed before what keeps them: a worktree made after this listing has
  // no folder in it, and one made before is in the listings below.
  const folders = env.archived(dir);
  const { primary, linked } = await linkedWorktrees(env);
  const keep = new Set([
    ...[primary, ...linked].map(tree => basename(tree.path)),
    ...env.names(join(primary.path, '.git', 'worktrees')),
    ...env.names(join(primary.path, APP_WORKTREES)),
  ]);
  const stale = folders.filter(folder => !keep.has(folder.name));
  const kept = folders.length - stale.length;
  if (stale.length === 0)
    return [`no stale git-ai folders in ${dir}; ${kept} kept`];
  if (!dryRun) for (const folder of stale) env.drop(join(dir, folder.name));
  const bytes = stale.reduce((sum, folder) => sum + folder.bytes, 0);
  return [
    `${dryRun ? 'would delete' : 'deleted'} ${stale.length} git-ai folders, ${size(bytes)}`,
    `${kept} kept: named after a listed worktree (${basename(primary.path)} included), its gitdir, or a folder in ${join(primary.path, APP_WORKTREES)}`,
  ];
}

/** The amount on the `Total:` line `docker buildx prune` ends with. */
export function reclaimed(text: string) {
  return /^Total:\s*(\S+)/m.exec(text)?.[1] ?? '0B';
}

/**
 * The hourly sweep (`sarathi services prune`), in-process, through the
 * `docker` on PATH; resolves its notes. A failed sweep step is noted and
 * leaves the step ✓, as the sweep's own run reports it and goes on. Without
 * a services file the sweep has no names to judge volumes by: skipped.
 */
async function sweepNotes(env: Env, dryRun: boolean, project: Project) {
  if (project.services === undefined)
    return [
      `skipped the hourly sweep: .claude/sarathi.json names no services file (worktree.services)`,
    ];
  const docker = await output(env, '/usr/bin/which', ['docker']);
  const planned: string[] = [];
  const outcome = await env.sweep({
    docker,
    settings: { name: project.name, primary: project.primary, ...project.services },
    dryRun,
    print: line => planned.push(line),
    run: env.run,
    now: env.now,
  });
  if (outcome.kind === 'skipped')
    return [`skipped the hourly sweep: ${outcome.reason}`];
  return [
    `${dryRun ? 'previewed' : 'ran'} the hourly sweep (sarathi services prune)`,
    ...outcome.results.flatMap(result =>
      result.ok ? [] : [`sweep step ${result.step} failed: ${result.error}`],
    ),
    ...planned,
  ];
}

async function pruneDocker(env: Env, dryRun: boolean, project: Project) {
  const daemon = await env.run(
    'docker',
    ['info', '--format', '{{.ServerVersion}}'],
    DAEMON_TIMEOUT_MS,
  );
  if (daemon.kind !== 'ok') {
    if (dockerAbsent(daemon))
      return new Skip('no Docker daemon', [failure(daemon)]);
    throw new Error(`docker info: ${failure(daemon)}`);
  }
  const notes = await sweepNotes(env, dryRun, project);
  // For the report only. Other worktrees' test stacks come and go, and a
  // container removed mid-listing fails `docker system df`.
  const usage = await env.run(
    'docker',
    ['system', 'df', '--format', '{{.Type}} {{.Size}}'],
    COMMAND_TIMEOUT_MS,
  );
  const cache =
    usage.stdout
      .split('\n')
      .find(line => line.startsWith('Build Cache '))
      ?.slice('Build Cache '.length)
      .trim() ?? 'an unknown size';
  if (dryRun)
    return [...notes, `would prune all unused build cache (${cache})`];
  const freed = reclaimed(
    await output(env, 'docker', ['buildx', 'prune', '--all', '--force']),
  );
  return [...notes, `build cache: ${freed} freed of ${cache}`];
}

/** Runs a command, or in a dry run names it; resolves the note. */
async function command(
  env: Env,
  dryRun: boolean,
  [name, args, done]: [string, string[], string],
) {
  if (dryRun) return `would run: ${name} ${args.join(' ')}`;
  await output(env, name, args);
  return done;
}

/** `brew cleanup`, skipped when brew is not installed. */
async function brewCleanup(env: Env, dryRun: boolean) {
  const args = ['cleanup', ...(dryRun ? ['--dry-run'] : [])];
  const outcome = await env.run('brew', args, COMMAND_TIMEOUT_MS);
  if (outcome.kind === 'spawn-error' && outcome.errno === 'ENOENT')
    return 'skipped brew cleanup: brew is not installed';
  if (outcome.kind !== 'ok')
    throw new Error(`brew ${args.join(' ')}: ${failure(outcome)}`);
  const freed = brewFreed(outcome.stdout);
  if (freed === undefined) return 'brew cleanup: nothing to free';
  return dryRun
    ? `would run: brew cleanup (frees about ${freed})`
    : `brew cleanup freed about ${freed}`;
}

/**
 * Why a running Gradle daemon or build keeps its caches and build output,
 * or undefined. A failed listing throws: nothing is judged unused on it.
 */
async function gradleRuns(env: Env) {
  const lines = await processLines(env);
  const found = lines
    .map(line => GRADLE_PROCESS.exec(line)?.[0])
    .find(main => main !== undefined);
  return found === undefined
    ? undefined
    : `a Gradle daemon or build runs (${found})`;
}

/**
 * Why a process working in the primary checkout keeps its build output, or
 * undefined. As step 1 judges a worktree: only a clean lsof exit is a whole
 * listing. Not counted: cleanup's own process, its ancestors (the shell and
 * pnpm that started it) and its children (lsof itself), and processes in a
 * linked worktree, which sits inside the primary but builds its own output.
 */
async function primaryWorker(env: Env, primary: string, linked: Worktree[]) {
  const args = ['-d', 'cwd', '-FcRn'];
  const lsof = await env.run('lsof', args, COMMAND_TIMEOUT_MS);
  if (lsof.kind !== 'ok')
    throw new Error(`lsof ${args.join(' ')}: ${failure(lsof)}`);
  const processes = parseProcesses(lsof.stdout);
  const parents = new Map(processes.map(each => [each.pid, each.parent]));
  const own = new Set([env.pid]);
  let at = parents.get(env.pid);
  while (at !== undefined && !own.has(at)) {
    own.add(at);
    at = parents.get(at);
  }
  const worker = processes.find(
    each =>
      !own.has(each.pid) &&
      each.parent !== env.pid &&
      inside(each.cwd, primary) &&
      !linked.some(tree => inside(each.cwd, tree.path)),
  );
  return worker === undefined
    ? undefined
    : `a process works in the primary checkout: ${worker.command} (pid ${worker.pid}) in ${worker.cwd}`;
}

/**
 * Deletes the folders of `paths` that exist, once `busy` (judged last, after
 * sizing) gives no reason to keep them; resolves the note.
 */
async function clearFolders(
  env: Env,
  dryRun: boolean,
  part: {
    label: string;
    paths: string[];
    /** Where nothing was found, for the note. */
    where: string;
    busy: () => Promise<string | undefined>;
    /** The note's subject: the paths present and their size. */
    name: (paths: string[], bytes: string) => string;
  },
) {
  const present = part.paths.filter(path => env.exists(path));
  if (present.length === 0) return `${part.label}: nothing ${part.where}`;
  const bytes = duBytes(await output(env, 'du', ['-sk', ...present]));
  const busy = await part.busy();
  if (busy !== undefined) return `skipped ${part.label}: ${busy}`;
  const what = part.name(present, size(bytes));
  if (dryRun) return `would delete ${what}`;
  for (const path of present) env.drop(path);
  return `deleted ${what}`;
}

/** The primary checkout's `cleanup.primaryBuilt`, unless Gradle or a process uses it. */
async function clearPrimaryBuild(
  env: Env,
  dryRun: boolean,
  built: readonly string[],
) {
  const { primary, linked } = await linkedWorktrees(env);
  const root = primary.path;
  return clearFolders(env, dryRun, {
    label: 'primary build output',
    paths: built.map(path => join(root, path)),
    where: `in ${root}`,
    busy: async () =>
      (await gradleRuns(env)) ?? (await primaryWorker(env, root, linked)),
    name: (paths, bytes) =>
      `${paths.map(path => relative(root, path)).join(', ')} in ${root}, ${bytes}`,
  });
}

/** GRADLE_CACHES, unless a Gradle daemon or build runs. */
async function clearGradleCaches(env: Env, dryRun: boolean) {
  const path = join(env.home, GRADLE_CACHES);
  return clearFolders(env, dryRun, {
    label: 'Gradle caches',
    paths: [path],
    where: `at ${path}`,
    busy: () => gradleRuns(env),
    name: (_paths, bytes) =>
      `${path}, ${bytes} (${join(env.home, '.gradle/wrapper')} stays)`,
  });
}

/**
 * The process listing: every process's command line, of every user. Only a
 * clean exit with at least one process (ps lists itself) is whole; anything
 * else throws, so neither the staged update nor a Gradle cache is judged
 * unused on a partial or failed listing.
 */
async function processLines(env: Env) {
  const args = ['-A', '-ww', '-o', 'command='];
  const ps = await env.run('ps', args, COMMAND_TIMEOUT_MS);
  if (ps.kind !== 'ok') throw new Error(`ps ${args.join(' ')}: ${failure(ps)}`);
  const lines = ps.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
  if (lines.length === 0)
    throw new Error(`ps ${args.join(' ')}: listed no process`);
  return lines;
}

async function dropStagedUpdate(env: Env, dryRun: boolean, project: Project) {
  if (!project.cleanup.machine.dockerDesktopUpdate)
    return new Skip(SETTINGS_OFF);
  if (!env.exists(DOCKER_APP)) return new Skip('Docker Desktop not installed');
  const dir = join(env.home, DOCKER_INSTALL);
  const staged = env.archived(dir).find(folder => folder.name === STAGED);
  if (staged === undefined) return new Skip('no staged update');
  const running = (await processLines(env)).filter(line =>
    DOCKER_DESKTOP.test(line),
  );
  if (running.length > 0) return new Skip('Docker Desktop is running', running);
  const what = `${basename(dir)}/${STAGED}, ${gigabytes(staged.bytes)}`;
  if (dryRun) return [`would delete ${what}`];
  env.drop(join(dir, STAGED));
  return [`deleted ${what}`];
}

/**
 * Every NDK version a build.gradle names literally as `ndkVersion` (quoted,
 * with or without `=`); `sub.android.ndkVersion = rootProject.ext.ndkVersion`
 * names none.
 */
export function ndkPins(gradle: string): string[] {
  return [...gradle.matchAll(/\bndkVersion\s*=?\s*["']([^"']+)["']/g)].map(
    match => String(match[1]),
  );
}

/**
 * NDK version folders under `$ANDROID_HOME/ndk` (default
 * `~/Library/Android/sdk/ndk`) that no listed worktree's build.gradle
 * (`machine.androidNdk`) pins. A worktree branched before a version bump
 * can pin another version than the default branch, so every listed one
 * counts. No pin found, or a build.gradle that cannot be read: the step
 * fails and deletes nothing.
 */
async function pruneNdks(env: Env, dryRun: boolean, project: Project) {
  const gradleFile = project.cleanup.machine.androidNdk;
  if (gradleFile === undefined) return new Skip(SETTINGS_OFF);
  const sdk = env.androidHome ?? join(env.home, 'Library/Android/sdk');
  const dir = join(sdk, 'ndk');
  if (!env.exists(dir)) return new Skip(`no Android NDK folder at ${dir}`);
  const { primary, linked } = await linkedWorktrees(env);
  const notes: string[] = [];
  const pinned = new Set<string>();
  for (const tree of [primary, ...linked]) {
    const gradle = join(tree.path, gradleFile);
    if (!env.exists(gradle)) continue;
    const text = env.read(gradle);
    if (text === undefined)
      throw new Error(`${gradle} cannot be read: no NDK is deleted`);
    const versions = ndkPins(text);
    if (versions.length === 0) notes.push(`${gradle} pins no ndkVersion`);
    for (const version of versions) pinned.add(version);
  }
  if (pinned.size === 0)
    throw new Error(
      `no listed worktree's ${gradleFile} pins an ndkVersion: no NDK is deleted`,
    );
  const folders = env
    .archived(dir)
    .sort((a, b) => a.name.localeCompare(b.name));
  const stray = folders.filter(folder => !pinned.has(folder.name));
  for (const folder of folders)
    if (pinned.has(folder.name)) notes.push(`keeping ${folder.name} (pinned)`);
  for (const folder of stray) {
    if (!dryRun) env.drop(join(dir, folder.name));
    notes.push(
      `${dryRun ? 'would delete' : 'deleted'} ndk/${folder.name}, ${size(folder.bytes)}`,
    );
  }
  return notes;
}

/**
 * Each part in turn; a skipped part is a note and the step stays ✓, a failed
 * one fails the step (Failed) once the others have run. A part the settings
 * leave off is a skipped part.
 */
async function pruneCaches(env: Env, dryRun: boolean, project: Project) {
  const { machine, primaryBuilt } = project.cleanup;
  const off = (label: string) => async () => `skipped ${label}: ${SETTINGS_OFF}`;
  const parts: [string, () => Promise<string>][] = [
    [
      'pnpm store prune',
      () =>
        command(env, dryRun, ['pnpm', ['store', 'prune'], 'pnpm store pruned']),
    ],
  ];
  const simulators = 'xcrun simctl delete unavailable';
  if (!machine.simulators) parts.push([simulators, off(simulators)]);
  else if (env.platform === 'darwin')
    parts.push([
      simulators,
      () =>
        command(env, dryRun, [
          'xcrun',
          ['simctl', 'delete', 'unavailable'],
          'unavailable simulators deleted',
        ]),
    ]);
  const pick = (
    on: boolean,
    label: string,
    run: () => Promise<string>,
  ): [string, () => Promise<string>] => [label, on ? run : off(label)];
  parts.push(
    pick(machine.brew, 'brew cleanup', () => brewCleanup(env, dryRun)),
    pick(primaryBuilt.length > 0, 'primary build output', () =>
      clearPrimaryBuild(env, dryRun, primaryBuilt),
    ),
    pick(machine.gradleCaches, 'Gradle caches', () =>
      clearGradleCaches(env, dryRun),
    ),
  );
  let failed = false;
  const notes = await inSequence(parts, async ([label, part]) => {
    try {
      return await part();
    } catch (error) {
      // fail-open: this part is reported failed and the step fails (Failed
      // below); the remaining parts still run.
      failed = true;
      return `${label} failed: ${errorDetail(error)}`;
    }
  });
  if (failed) throw new Failed(notes);
  return notes;
}

function gigabytes(bytes: number) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** Prints each result, its notes indented under it. */
function report(env: Env, results: StepResult[]) {
  for (const result of results) {
    env.stdout(
      result.skipped !== undefined
        ? `– ${result.step} (skipped: ${result.skipped})`
        : `${result.ok ? '✓' : '✗'} ${result.step}`,
    );
    for (const note of result.notes) env.stdout(`    ${note}`);
  }
}

/**
 * Runs every step and prints a report; resolves each step's result. The
 * settings come first: when they cannot be read, no step runs, since none
 * may guess what the project left off.
 */
export async function cleanup(
  env: Env,
  dryRun: boolean,
): Promise<StepResult[]> {
  let project: Project | undefined;
  const settings = await step('settings', async () => {
    project = await loadProject(env);
    return [];
  });
  if (project === undefined) {
    report(env, [settings]);
    return [settings];
  }
  const at = project;
  const before = env.freeBytes(env.cwd);
  const results = [
    await step('leftover worktrees', () => removeWorktrees(env, dryRun, at)),
    await step('worktree archive', () => sweepArchive(env, dryRun, at)),
    await step('stale worktree registrations', () =>
      pruneRegistrations(env, dryRun),
    ),
    await step('git-ai folders', () => pruneGitAi(env, dryRun)),
    await step('idle app worktrees', () => trimAppWorktrees(env, dryRun, at)),
    await step('docker', () => pruneDocker(env, dryRun, at)),
    await step('docker staged update', () =>
      dropStagedUpdate(env, dryRun, at),
    ),
    await step('android NDKs', () => pruneNdks(env, dryRun, at)),
    await step('caches', () => pruneCaches(env, dryRun, at)),
  ];
  report(env, results);
  if (!dryRun)
    env.stdout(
      `free disk: ${gigabytes(before)} → ${gigabytes(env.freeBytes(env.cwd))} (Docker hands its space back to macOS over the next minutes)`,
    );
  return results;
}

/** Bytes read at a time when comparing files: a database never loads whole. */
const CHUNK = 1 << 20;

/**
 * Whether two files hold the same bytes, read a chunk at a time; throws when
 * either cannot be opened.
 */
export function sameBytes(a: string, b: string): boolean {
  const first = openSync(a, 'r');
  try {
    const second = openSync(b, 'r');
    try {
      const one = Buffer.alloc(CHUNK);
      const two = Buffer.alloc(CHUNK);
      let read: number;
      do {
        read = readSync(first, one, 0, CHUNK, null);
        const other = readSync(second, two, 0, CHUNK, null);
        if (!one.subarray(0, read).equals(two.subarray(0, other))) return false;
      } while (read > 0);
      return true;
    } finally {
      closeSync(second);
    }
  } finally {
    closeSync(first);
  }
}

/**
 * When a file or folder last took an archived copy: the later of its birth
 * and its mtime. A macOS copy keeps its source's birth (measured), so
 * `archive` sets each copy's mtime to the copy time.
 */
export function madeAt(stats: { birthtimeMs: number; mtimeMs: number }) {
  return Math.max(stats.birthtimeMs, stats.mtimeMs);
}

/**
 * Throws if any of `paths` is a symbolic link, which would aim a deletion
 * somewhere else; a missing path passes.
 */
function refuseLinks(paths: string[], outcome: string) {
  for (const path of paths)
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error(`${path} is a symbolic link: ${outcome}`);
}

type Times = { birthtimeMs: number; mtimeMs: number };

/**
 * An archived folder's age and bytes, from its own times and those of
 * everything in it: `made` is the newest, since a worktree whose name comes
 * back is archived into the same folder; `bytes` counts all but folders.
 */
export function folderFacts(
  self: Times,
  inside: (Times & { size: number; directory: boolean })[],
) {
  return inside.reduce(
    (facts, entry) => ({
      made: Math.max(facts.made, madeAt(entry)),
      bytes: facts.bytes + (entry.directory ? 0 : entry.size),
    }),
    { made: madeAt(self), bytes: 0 },
  );
}

/** Each entry under `dir`, links as themselves. */
function treeEntries(dir: string) {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).map(
    entry => {
      const { birthtimeMs, mtimeMs, size } = lstatSync(
        join(entry.parentPath, entry.name),
      );
      return { birthtimeMs, mtimeMs, size, directory: entry.isDirectory() };
    },
  );
}

/** `ANDROID_HOME` in `vars`; blank reads as unset. */
export function androidHomeIn(vars: Readonly<Record<string, string | undefined>>) {
  const value = vars['ANDROID_HOME'];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** What the command line hands cleanup: the working folder, the environment and an output. */
export interface Io {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string) => void;
}

export function defaultEnv(io: Io): Env {
  return {
    run: (command, args, timeoutMs) => runChild(command, args, { timeoutMs }),
    cwd: io.cwd,
    home: homedir(),
    settings: readSettings,
    services: (file, primary) =>
      loadServicesFile(servicesPath(file, primary, io.env)),
    sweep: sweepOnce,
    mtime: path => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        // fail-open: undefined reports the time unreadable, and keepReason
        // keeps any worktree whose time it cannot read.
        return undefined;
      }
    },
    read: path => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        // fail-open: an unreadable file reads as missing, which keeps the
        // worktree (no gitdir, or no marker).
        return undefined;
      }
    },
    lossless: (path, copy) => {
      try {
        return lstatSync(path).isSymbolicLink() || sameBytes(path, copy);
      } catch {
        // fail-open: unreadable is not lossless, so the file counts as lost
        // and keeps its worktree.
        return false;
      }
    },
    archive: (from, to) => {
      // Either way the copy is dated now, so a folder archived into again,
      // even with unchanged files, keeps its full days. A link there is
      // refused first: comparing or dating it would reach where it points.
      refuseLinks([to], 'nothing is archived over it');
      if (existsSync(to)) {
        if (!sameBytes(from, to))
          throw new Error(`${to} already holds other bytes`);
      } else {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
      }
      const copied = new Date();
      utimesSync(to, copied, copied);
    },
    archived: dir => {
      // A link at the archive, or at the folder above, is refused. A linked
      // folder inside is never listed (isDirectory is false for a link).
      refuseLinks([dirname(dir), dir], 'the archive is not swept');
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
          const path = join(dir, entry.name);
          return {
            name: entry.name,
            ...folderFacts(statSync(path), treeEntries(path)),
          };
        });
    },
    drop: path => {
      // Checked again just before removal, in case a link replaced one of
      // them after the listing.
      const archive = dirname(path);
      refuseLinks([dirname(archive), archive, path], `${path} is kept`);
      // A link anywhere higher up (a linked `apps` above the primary's
      // Android output) would aim the removal elsewhere too.
      if (realpathSync(archive) !== archive)
        throw new Error(
          `${archive} is reached through a symbolic link: ${path} is kept`,
        );
      rmSync(path, { recursive: true });
    },
    // Not existsSync: it reads a path it cannot check (an unreadable folder
    // above it, a link loop) as missing, and a step would take it for gone.
    exists: path => statSync(path, { throwIfNoEntry: false }) !== undefined,
    names: dir => (existsSync(dir) ? readdirSync(dir) : []),
    freeBytes: path => {
      const stats = statfsSync(path);
      return stats.bavail * stats.bsize;
    },
    now: () => Date.now(),
    platform: process.platform,
    androidHome: androidHomeIn(io.env),
    pid: process.pid,
    stdout: line => io.out(`${line}\n`),
  };
}

export const USAGE = 'usage: sarathi worktree cleanup [--dry-run]';

/**
 * Resolves the exit code: 0 when every step succeeded, 1 when any failed,
 * 2 for a bad flag.
 */
export async function cli(argv: readonly string[], env: Env): Promise<number> {
  let dryRun: boolean;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { 'dry-run': { type: 'boolean' } },
    });
    dryRun = values['dry-run'] === true;
  } catch {
    // fail-open: a bad flag prints the usage; the exit code carries it.
    env.stdout(USAGE);
    return 2;
  }
  const results = await cleanup(env, dryRun);
  return results.every(result => result.ok) ? 0 : 1;
}

/** `sarathi worktree cleanup [--dry-run]`, from the command line's `io`. */
export function cleanupMain(argv: readonly string[], io: Io): Promise<number> {
  return cli(argv, defaultEnv(io));
}
