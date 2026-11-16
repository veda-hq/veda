// The live-service tests' fixture (live.test.ts): real Docker, real Compose
// projects. No tests of its own: a `.test.ts` name keeps it out of the build
// and the coverage figures.
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseServicesFile } from './file.ts';
import { createFixtureRoot } from './fixture-root.ts';
import { dockerCli, projectName, reapProject } from './reaper.ts';
import { composeVariables, services, type Project, type ServicesIo } from './runner.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** The variable that opts in: the live cases start real containers, so nothing runs them by default. */
export const LIVE_VARIABLE = 'SARATHI_LIVE_SERVICES';

/** The live project: its own prefix and label, never a real project's. */
export const LIVE_PROJECT: Project = {
  name: 'sarathi',
  file: parseServicesFile(
    {
      compose: 'compose.yaml',
      project: 'sarathi-live-wt',
      rootLabel: 'sarathi.live.worktree-services.root',
      apiPorts: [20000, 29999],
      webPort: 5173,
      published: { cache: ['cache', 6379], store: ['store', 6379] },
      environment: { CACHE_URL: 'redis://:{password}@127.0.0.1:{cache}', STORE_URL: 'redis://:{password}@127.0.0.1:{store}', PORT: '{serverPort}' },
    },
    'live services',
  ),
};

const COMPOSE = fileURLToPath(new URL('../../test/fixture/services/compose.yaml', import.meta.url));

/**
 * The line of `docker info`'s stderr that names why the daemon is unusable.
 *
 * Neither end of that stderr holds it on both platforms. Under Docker Desktop
 * on macOS the connect error is the last line; under the Linux CLI a generic
 * `errors pretty printing info` follows it, and a `Server:` heading precedes
 * it. So the failing line is matched by what it says, with the last line kept
 * as the fallback for a message neither pattern anticipates.
 */
export function daemonProblemFromStderr(stderr: string, fallback: string): string {
  const lines = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  // In order, because docker prefixes unrelated warnings that would otherwise
  // win the search, such as `WARNING: Error loading config file: … permission
  // denied`. The connection message names the endpoint, so it is looked for
  // first; a permission failure on the socket itself is the runner-up.
  const named = lines.find(line => /cannot connect|failed to connect|dial /i.test(line)) ?? lines.find(line => /permission denied/i.test(line));
  return named ?? lines.at(-1) ?? fallback;
}

/**
 * Why the Docker daemon cannot serve these tests, or undefined when it
 * answers. `docker info` asks the daemon, so it fails when the container
 * runtime is stopped; `command -v docker` would not.
 */
export function dockerDaemonProblem(env: Env = process.env): string | undefined {
  try {
    execFileSync('docker', ['info'], { env: { ...env }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
    return undefined;
  } catch (error) {
    // fail-open: the problem is the answer; a spawn failure has no stderr, a daemon failure explains itself there.
    const fallback = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: unknown }).stderr;
    return daemonProblemFromStderr(stderr === undefined || stderr === null ? '' : String(stderr), fallback);
  }
}

/** Whether the live cases run: only when asked, since they start containers and sweep this machine. */
export const liveServicesRun = (env: Env): boolean => env[LIVE_VARIABLE] === 'required';

/** Fail at once, with the cause, rather than as nested startup errors. */
export function assertDockerDaemon(problem: string | undefined): void {
  if (problem !== undefined) throw new Error(`The Docker daemon is unreachable (${problem}); ${LIVE_VARIABLE}=required needs it running.`);
}

/** A fixture root holding the live Compose file, as a worktree holds its project's. */
export function serviceFixtureRoot(): string {
  const root = createFixtureRoot(LIVE_PROJECT.name);
  copyFileSync(COMPOSE, join(root, 'compose.yaml'));
  return root;
}

/** Output kept for a failing case's message, never printed. */
export function quietIo(): ServicesIo & { log: () => string } {
  let text = '';
  return { env: process.env, out: chunk => (text += chunk), err: chunk => (text += chunk), log: () => text };
}

export const live = (root: string, action: string, command: string[] = []): Promise<number> => services(root, action, command, LIVE_PROJECT, quietIo());

/** `docker` itself, outside any checkout. */
export const docker = dockerCli();

/** Reaps `root`'s project by name, then removes the root; reaping is idempotent. */
export async function release(root: string): Promise<void> {
  try {
    await reapProject(docker, LIVE_PROJECT.file.project, projectName(LIVE_PROJECT.file.project, root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Runs `body`, then cleans every root, keeping the body's failure primary.
 *
 * `onFinished` registers a teardown for the moment the test ends. A test cut
 * off by its timeout is failed while `body` is still running, so waiting for
 * it alone left that test's services running. The teardown cleans each root
 * not yet cleaned; a root is never cleaned twice.
 *
 * A body still running at that teardown can go on to create resources, such
 * as an `up` that was in flight at the timeout. Once the body settles,
 * `straggler` runs for every root the teardown cleaned early; it must not
 * need the root, which is gone by then. If the process exits before the body
 * settles, `straggler` never runs; the reaper is the backstop, since those
 * resources name a root that no longer exists (or, when the teardown failed,
 * a fixture root whose owner is dead).
 */
export async function withCleanup(
  roots: string[],
  body: () => Promise<void>,
  cleanup: (root: string) => void | Promise<void>,
  onFinished?: (teardown: () => Promise<void>) => void,
  straggler?: (root: string) => void | Promise<void>,
): Promise<void> {
  const early: string[] = [];
  const released = new Map<string, Promise<void>>();
  const releaseRoot = (root: string): Promise<void> => {
    const known = released.get(root);
    if (known !== undefined) return known;
    const releasing = (async () => {
      await cleanup(root);
      // Retain failed cleanup configuration for diagnosis and manual retry.
      rmSync(root, { recursive: true, force: true });
    })();
    released.set(root, releasing);
    return releasing;
  };
  const retained = (results: PromiseSettledResult<void>[]): string => roots.filter((_, index) => results[index]?.status === 'rejected').join(', ');
  onFinished?.(async () => {
    early.push(...roots.filter(root => !released.has(root)));
    // `releaseRoot` hands back a cleanup the body already started, so this
    // also waits one out and reports its failure, which a body that never
    // settles cannot.
    const results = await Promise.allSettled(roots.map(releaseRoot));
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason as unknown] : []));
    if (errors.length > 0) throw new AggregateError(errors, `Service fixture cleanup at test end failed; retained roots: ${retained(results)}`);
  });
  let primary: unknown;
  let failed = false;
  try {
    await body();
  } catch (error) {
    // fail-open: rethrown below, after every root is cleaned, as the primary failure.
    primary = error;
    failed = true;
  }
  const results = await Promise.allSettled(roots.map(releaseRoot));
  const stragglers = await Promise.allSettled(early.map(async root => straggler?.(root)));
  const cleanupErrors = [...results, ...stragglers].flatMap(result => (result.status === 'rejected' ? [result.reason as unknown] : []));
  if (cleanupErrors.length > 0) {
    throw new AggregateError([...(failed ? [primary] : []), ...cleanupErrors], `Service fixture cleanup failed; retained roots: ${retained(results)}`, failed ? { cause: primary } : undefined);
  }
  if (failed) throw primary;
}

/** `docker compose` for `root`'s live project, synchronously. */
export function compose(root: string, ...args: string[]): string {
  const { password } = JSON.parse(readFileSync(join(root, '.tmp/services/config.json'), 'utf8')) as { password: string };
  return execFileSync('docker', ['compose', '-f', join(root, 'compose.yaml'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...composeVariables(root, LIVE_PROJECT.file.project, password) },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Two live projects, started side by side, cleaned whatever the body does. */
export async function withLiveServices(
  onFinished: (teardown: () => Promise<void>) => void,
  body: (roots: string[], environments: Record<string, string>[]) => Promise<void>,
): Promise<void> {
  assertDockerDaemon(dockerDaemonProblem());
  const roots = [0, 1].map(() => serviceFixtureRoot());
  await withCleanup(
    roots,
    async () => {
      const started = await Promise.allSettled(roots.map(root => live(root, 'up')));
      const startupErrors = started.flatMap(result => (result.status === 'rejected' ? [result.reason as unknown] : []));
      if (startupErrors.length > 0) throw new AggregateError(startupErrors, 'Service fixture startup failed');
      const environments = roots.map(root => JSON.parse(readFileSync(join(root, '.tmp/services/environment.json'), 'utf8')) as Record<string, string>);
      await body(roots, environments);
    },
    root => {
      compose(root, 'down', '--volumes');
    },
    onFinished,
    // By project name: the root and its Compose file are gone by now.
    root => reapProject(docker, LIVE_PROJECT.file.project, projectName(LIVE_PROJECT.file.project, root)),
  );
}
