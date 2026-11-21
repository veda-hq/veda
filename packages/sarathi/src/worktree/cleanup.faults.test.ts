/**
 * Fault injection over `cli` (cleanup.ts), which removes leftover worktrees,
 * prunes stale registrations, trims an idle app worktree, runs the Docker
 * sweep and clears build cache, the pnpm store, simulators, brew's cleanup,
 * the primary checkout's build output and Gradle's caches.
 *
 * The world is a fake machine: the linked worktrees present, one stale
 * registration, one locked registration whose folder is gone (never
 * pruned), an expired archived folder, git-ai folders (one stale, one
 * stale once its worktree goes), the build cache, Docker Desktop's staged
 * update, a stray Android NDK beside the pinned one, two caches, brew, the
 * primary checkout's .turbo and ~/.gradle/caches. A failed call changes
 * nothing. The CLI resolves its exit status; a rejection is an unhandled
 * error, which Node turns into 1.
 *
 * Every call the clean run makes to `Env` is failed in turn: thrown, and for
 * a call that returns a promise, rejected too.
 * - Whatever call fails, the run never exits 0. The steps are independent
 *   removals, so a failed step leaves the others' work done, by design
 *   (nothing removed can be put back); what matters is the next property.
 * - Interrupted at any call and run again, the machine ends as one clean
 *   run leaves it.
 */
import { describe } from 'node:test';

import { expect, it } from '../test/expect.test.ts';
import type { ChildOutcome } from '../services/run-child.ts';
import { parseSettings } from './settings.ts';
import { cli, inside, type Env } from './cleanup.ts';

const WT = '/repo/.claude/worktrees';
const SELF = `${WT}/self`;
/** The desktop app's worktree, idle since OLD: its node_modules is trimmed. */
const APP = `${WT}/app`;
const GONE = `${WT}/gone`;
/** A locked registration whose folder is gone: reported, never pruned. */
const LOCKED_GONE = '/private/tmp/locked-gone';
const OLD = Date.parse('2026-10-01T00:00:00Z');
/**
 * Faulted runs over one clean run's calls (a throw for each, and a rejection
 * too for each async one): the settings (the common git directory, the
 * settings and the services file), rev-parse, the listing, per worktree its
 * reads, times, git checks and ignored files (its nested copy's too),
 * running services and lsof, the archive of each one's own ignored file, a
 * second listing and look, two removals, the locked gone registration's
 * existence check, the archive sweep, prune, git-ai, the idle app
 * worktree's trim, Docker (the daemon, `which`, the sweep, its report and
 * the build cache), Docker Desktop's staged update, the NDKs, caches,
 * report.
 */
const EXPLORED = 248;
const NOW = Date.parse('2026-11-04T00:00:00Z');

interface World {
  trees: string[];
  stale: boolean;
  cache: string;
  /** The hourly sweep has run. */
  swept: boolean;
  store: boolean;
  simulators: boolean;
  /** Archive paths holding a copied file; a copy repeats harmlessly. */
  archived: string[];
  /** An archived folder past the keep age is still there. */
  ancient: boolean;
  /** Rebuildable folders deleted from the idle app worktree. */
  trimmed: string[];
  /** git-ai's folders: one per worktree here, and one nothing names. */
  ai: string[];
  /** Docker Desktop's staged update is still there. */
  staged: boolean;
  /** NDK version folders installed; the primary's build.gradle pins PINNED. */
  ndks: string[];
  /** `brew cleanup` has run. */
  brewed: boolean;
  /** The primary checkout's build output and the Gradle caches still there. */
  built: string[];
}

const HOME = '/Users/me';
const PRIMARY_BUILT = ['.turbo', 'apps/mobile/android/build', 'apps/mobile/android/.cxx'];
const SETTINGS = parseSettings(
  {
    name: 'acme',
    services: 'services.json',
    cleanup: {
      primaryBuilt: PRIMARY_BUILT,
      nestedCopies: String.raw`^\.wt\/copy$`,
      machine: { dockerDesktopUpdate: true, androidNdk: 'apps/mobile/android/build.gradle', gradleCaches: true, simulators: true, brew: true },
    },
  },
  '.claude/sarathi.json',
  '/repo',
);
/** The caches step's folders: the primary's .turbo, then Gradle's caches. */
const BUILT = ['/repo/.turbo', `${HOME}/.gradle/caches`];
/** The primary's Android build output: never built here. */
const ANDROID = PRIMARY_BUILT.filter(path => path !== '.turbo').map(path => `/repo/${path}`);

const ARCHIVE_DIR = '/repo/.git/acme/worktree-archive';
const AI_DIR = '/repo/.git/ai/worktrees';
const DOCKER_INSTALL = `${HOME}/Library/Application Support/com.docker.install`;
const NDK_DIR = `${HOME}/Library/Android/sdk/ndk`;
const PINNED = '27.1.12297006';
const GRADLE = '/repo/apps/mobile/android/build.gradle';

const ok = (stdout = '', stderrTail = ''): ChildOutcome => ({
  kind: 'ok',
  code: 0,
  stdout,
  stderrTail,
});

function answer(w: World, command: string, args: string[]): ChildOutcome {
  const [first, second, third] = args;
  if (command === 'git' && args.includes('--git-common-dir')) return ok('/repo/.git\n');
  if (command === 'git' && first === 'rev-parse') return ok(SELF);
  if (command === '/usr/bin/which') return ok('/usr/local/bin/docker\n');
  if (command === 'git' && second === 'list') {
    const blocks = ['worktree /repo', ...w.trees.map(t => `worktree ${t}`), `worktree ${LOCKED_GONE}\nlocked codex`];
    if (w.stale) blocks.push(`worktree ${GONE}\nprunable gitdir gone`);
    return ok(blocks.join('\n\n'));
  }
  if (command === 'git' && second === 'remove') {
    const path = args.at(-1);
    w.trees = w.trees.filter(tree => tree !== path);
    return ok();
  }
  if (command === 'git' && second === 'prune') {
    const was = w.stale;
    w.stale = false;
    return ok('', was ? 'Removing worktrees/gone: gitdir file points to non-existent location' : '');
  }
  if (command === 'git' && third === `${WT}/dirty`) return ok(' M a.ts');
  if (command === 'git' && args[3] === 'status') return ok('');
  if (command === 'git' && args[3] === 'ls-files')
    return ok(third === APP && w.trimmed.includes(`${APP}/node_modules`) ? 'apps/server/.env\0.tmp/plan.md\0' : 'node_modules/\0apps/server/.env\0.tmp/plan.md\0');
  if (command === 'git') return ok('refs/remotes/origin/main');
  if (command === 'docker' && first === 'buildx') {
    const freed = w.cache;
    w.cache = '0B';
    return ok(`Total:\t${freed}`);
  }
  if (command === 'docker' && first === 'system') return ok(`Build Cache ${w.cache}`);
  if (command === 'ps') return ok('/sbin/launchd\n');
  if (command === 'du')
    return ok(
      args
        .slice(1)
        .map(path => `1000\t${path}`)
        .join('\n'),
    );
  if (command === 'brew') w.brewed = true;
  if (command === 'pnpm') w.store = true;
  if (command === 'xcrun') w.simulators = true;
  return ok();
}

function ports(w: World): Env {
  return {
    cwd: SELF,
    home: HOME,
    platform: 'darwin',
    pid: 4242,
    run: async (command, args) => answer(w, command, args),
    settings: () => SETTINGS,
    services: () => ({ project: 'acme', rootLabel: 'com.acme.root' }),
    sweep: async () => {
      w.swept = true;
      return { kind: 'swept', results: [{ step: 'containers', ok: true }] };
    },
    androidHome: undefined,
    read: path => {
      if (path === GRADLE) return `ext {\n  ndkVersion = "${PINNED}"\n}\n`;
      const pointer = /^(.+)\/\.git$/.exec(path)?.[1];
      if (pointer !== undefined) return w.trees.includes(pointer) ? `gitdir: /repo/.git/worktrees/${pointer.slice(WT.length + 1)}` : undefined;
      return /\/worktrees\/app\/CLAUDE_BASE$/.test(path) ? undefined : 'main';
    },
    mtime: () => OLD,
    // The .env is the primary's copy; the plan is only the worktree's.
    lossless: file => /\.env$/.test(file),
    archive: (_from, to) => {
      if (!w.archived.includes(to)) w.archived.push(to);
    },
    // The archive holds the ancient folder and, once copied, agent-old's;
    // git-ai holds its folders; Docker Desktop's install folder holds its
    // staged update; the SDK its NDKs.
    archived: dir => {
      if (dir === AI_DIR) return w.ai.map(name => ({ name, made: OLD, bytes: 1e6 }));
      if (dir === DOCKER_INSTALL) return w.staged ? [{ name: 'in_progress', made: NOW, bytes: 2.2e9 }] : [];
      if (dir === NDK_DIR) return w.ndks.map(name => ({ name, made: OLD, bytes: 2.8e9 }));
      return archive(w);
    },
    // Gitdirs are named for their path under WT; WT holds its own trees.
    names: dir =>
      dir === '/repo/.git/worktrees'
        ? w.trees.map(tree => tree.slice(WT.length + 1))
        : w.trees.map(tree => tree.slice(WT.length + 1)).filter(name => !name.includes('/')),
    drop: path => {
      if (path === `${ARCHIVE_DIR}/ancient`) w.ancient = false;
      if (inside(path, APP) && !w.trimmed.includes(path)) w.trimmed.push(path);
      w.ai = w.ai.filter(name => `${AI_DIR}/${name}` !== path);
      if (path === `${DOCKER_INSTALL}/in_progress`) w.staged = false;
      w.ndks = w.ndks.filter(name => path !== `${NDK_DIR}/${name}`);
      w.built = w.built.filter(each => each !== path);
    },
    // Only the primary checkout holds a build.gradle; of the caches step's
    // folders only .turbo and the Gradle caches are ever built here; the
    // app's worktree has no marker, as `read` says.
    exists: path => {
      if (ANDROID.includes(path)) return false;
      if (BUILT.includes(path)) return w.built.includes(path);
      return (
        path !== LOCKED_GONE &&
        !/\/worktrees\/app\/CLAUDE_BASE$/.test(path) &&
        ![...w.trees, LOCKED_GONE, GONE].some(tree => path === `${tree}/apps/mobile/android/build.gradle`)
      );
    },
    freeBytes: () => 100e9,
    now: () => NOW,
    stdout: () => undefined,
  };
}

/** The worktree archive's folders. */
function archive(w: World) {
  return [
    ...(w.ancient ? [{ name: 'ancient', made: NOW - 40 * 86_400_000, bytes: 5 }] : []),
    ...(w.archived.length > 0 ? [{ name: 'agent-old', made: NOW, bytes: w.archived.length }] : []),
  ];
}

function setup(): World {
  return {
    trees: [SELF, `${WT}/agent-old`, `${WT}/agent-old/.wt/copy`, APP, `${WT}/dirty`],
    stale: true,
    cache: '640GB',
    swept: false,
    store: false,
    simulators: false,
    archived: [],
    ancient: true,
    trimmed: [],
    // agent-old's goes once its worktree is removed; long-gone's at once.
    ai: ['self', 'agent-old', 'app', 'dirty', 'long-gone'],
    staged: true,
    ndks: [PINNED, '28.2.13676358'],
    brewed: false,
    built: [...BUILT],
  };
}

/** One call to fail: by its place among the run's `Env` calls, thrown or rejected. */
interface Fault {
  index: number;
  mode: 'throw' | 'reject';
}

/** The calls a run made: whether each returned a promise. */
type Calls = boolean[];

/**
 * `env` with every function wrapped: each call is counted, and the one
 * `fault` names fails instead of running.
 */
function inject(env: Env, fault: Fault | undefined, calls: Calls): Env {
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    wrapped[key] =
      typeof value !== 'function'
        ? value
        : (...args: unknown[]): unknown => {
            const index = calls.length;
            if (fault?.index === index) {
              calls.push(fault.mode === 'reject');
              const error = new Error(`injected ${fault.mode} at call ${index} (${key})`);
              if (fault.mode === 'reject') return Promise.reject(error);
              throw error;
            }
            calls.push(false);
            const result: unknown = Reflect.apply(value, env, args);
            calls[index] = result instanceof Promise;
            return result;
          };
  }
  return wrapped as unknown as Env;
}

/** Runs the CLI on `w`; resolves its exit code, 1 for a rejection, as Node exits. */
async function run(w: World, fault?: Fault, calls: Calls = []): Promise<number> {
  try {
    return await cli([], inject(ports(w), fault, calls));
  } catch {
    // fail-open: an escaped error is the outcome under test; Node exits 1 on it.
    return 1;
  }
}

/** Every fault over the clean run's calls: a throw each, and a rejection for each async one. */
async function faults(): Promise<Fault[]> {
  const calls: Calls = [];
  await run(setup(), undefined, calls);
  return calls.flatMap((async, index): Fault[] => [{ index, mode: 'throw' }, ...(async ? [{ index, mode: 'reject' as const }] : [])]);
}

describe('cleanup under fault injection', () => {
  it('one clean run trims the idle app worktree and sweeps Docker, which the world then shows', async () => {
    const world = setup();
    expect(await run(world)).toBe(0);
    expect(world.trimmed).toEqual([`${APP}/node_modules`]);
    expect(world.swept).toBe(true);
  });

  it('a failed call never exits 0', async () => {
    const all = await faults();
    expect(all.length).toBe(EXPLORED);
    const passed: string[] = [];
    for (const fault of all) {
      if ((await run(setup(), fault)) === 0) passed.push(`${fault.mode} at ${fault.index}`);
    }
    expect(passed).toEqual([]);
  });

  it('interrupted anywhere and rerun, the machine ends as one clean run leaves it', async () => {
    const once = setup();
    await run(once);
    const twice = structuredClone(once);
    expect(await run(twice)).toBe(0);
    expect(twice).toEqual(once);
    const diverged: string[] = [];
    const failedRerun: string[] = [];
    for (const fault of await faults()) {
      const world = setup();
      await run(world, fault);
      // The rerun has no fault, so it must succeed, not only leave the same state.
      if ((await run(world)) !== 0) failedRerun.push(`${fault.mode} at ${fault.index}`);
      if (JSON.stringify(world) !== JSON.stringify(once)) diverged.push(`${fault.mode} at ${fault.index}`);
    }
    expect(diverged).toEqual([]);
    expect(failedRerun).toEqual([]);
  });
});
