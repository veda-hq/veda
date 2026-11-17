// The live-fixture's own rules, always; and, with SARATHI_LIVE_SERVICES=required
// and a Docker daemon, the runner and the reaper against real Compose projects.
// The live cases are opt-in: they pull an image, start containers and sweep
// this machine's projects of the live prefix, which no `pnpm test` may do
// unasked.
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { expect } from '../test/expect.test.ts';
import { FIXTURE_OWNER_FILE } from './fixture-root.ts';
import {
  assertDockerDaemon,
  compose,
  daemonProblemFromStderr,
  docker,
  dockerDaemonProblem,
  live,
  LIVE_PROJECT,
  LIVE_VARIABLE,
  liveServicesRun,
  release,
  serviceFixtureRoot,
  withCleanup,
  withLiveServices,
} from './live-fixture.test.ts';
import { projectName, reapOrphanedServices, reapProject, serviceProjects, serviceRootState, worktreeState, type Docker } from './reaper.ts';

const LIVE = liveServicesRun(process.env);
const skip = LIVE ? false : `set ${LIVE_VARIABLE}=required, with Docker running, to run the live-service cases`;
const PREFIX = LIVE_PROJECT.file.project;
const tempRoots = (count: number): string[] => Array.from({ length: count }, () => mkdtempSync(join(tmpdir(), 'sarathi-cleanup-test-')));
const exists = (path: string): boolean => {
  try {
    realpathSync(path);
    return true;
  } catch {
    // fail-open: a path that cannot be resolved is gone, which is what the caller asks.
    return false;
  }
};

test('cleanup attempts every root and retains original failure plus failed-resource configuration', async () => {
  const roots = tempRoots(2);
  const attempts: string[] = [];
  const primary = new Error('original assertion');
  const cleanupFailure = new Error('first compose down failed');
  try {
    await expect(
      withCleanup(
        roots,
        async () => {
          throw primary;
        },
        root => {
          attempts.push(root);
          if (root === roots[0]) throw cleanupFailure;
        },
      ),
    ).rejects.toMatchObject({ cause: primary, errors: [primary, cleanupFailure] });
    expect(attempts).toEqual(roots);
    expect(exists(roots[0] ?? '')).toBe(true);
    expect(exists(roots[1] ?? '')).toBe(false);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('a cleanup failure after a passing body names the roots it retained', async () => {
  const roots = tempRoots(1);
  const failure = new Error('compose down failed');
  try {
    await expect(
      withCleanup(
        roots,
        async () => undefined,
        () => {
          throw failure;
        },
      ),
    ).rejects.toMatchObject({ errors: [failure], message: `Service fixture cleanup failed; retained roots: ${roots[0]}` });
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('a failing body with clean roots fails as itself', async () => {
  const roots = tempRoots(1);
  const primary = new Error('assertion');
  await expect(
    withCleanup(
      roots,
      async () => {
        throw primary;
      },
      () => undefined,
    ),
  ).rejects.toThrow('assertion');
  expect(exists(roots[0] ?? '')).toBe(false);
});

test('a test that ends before its body settles cleans every root once, at the end', async () => {
  const roots = tempRoots(2);
  const attempts: string[] = [];
  const late: string[] = [];
  let teardown: (() => Promise<void>) | undefined;
  let finishBody = (): void => undefined;
  try {
    // The body is still waiting when the test "times out" and its teardown runs.
    const run = withCleanup(
      roots,
      () => new Promise<void>(resolve => (finishBody = resolve)),
      root => {
        attempts.push(root);
      },
      registered => (teardown = registered),
      root => {
        late.push(root);
      },
    );
    expect(teardown).toBeDefined();
    await teardown?.();
    expect(attempts).toEqual(roots);
    for (const root of roots) expect(exists(root)).toBe(false);
    expect(late).toEqual([]);
    finishBody();
    await run;
    // The body settling later does not clean again, but removes what it may
    // have started after the teardown.
    expect(attempts).toEqual(roots);
    expect(late).toEqual(roots);
    await teardown?.();
    expect(attempts).toEqual(roots);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('a failed teardown at test end names the roots it retained', async () => {
  const roots = tempRoots(2);
  const failure = new Error('compose down failed');
  const lateFailure = new Error('late reap failed');
  let teardown: (() => Promise<void>) | undefined;
  let finishBody = (): void => undefined;
  try {
    const run = withCleanup(
      roots,
      () => new Promise<void>(resolve => (finishBody = resolve)),
      root => {
        if (root === roots[1]) throw failure;
      },
      registered => (teardown = registered),
      root => {
        if (root === roots[0]) throw lateFailure;
      },
    );
    await expect(teardown?.()).rejects.toMatchObject({ errors: [failure], message: `Service fixture cleanup at test end failed; retained roots: ${roots[1]}` });
    expect(exists(roots[1] ?? '')).toBe(true);
    finishBody();
    // The body's own cleanup reports the same retained root, and the late reap.
    await expect(run).rejects.toMatchObject({ errors: [failure, lateFailure] });
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('a teardown at test end waits for a cleanup the body already started', async () => {
  const roots = tempRoots(1);
  let teardown: (() => Promise<void>) | undefined;
  let finishCleanup = (): void => undefined;
  let cleanupStarted = (): void => undefined;
  const started = new Promise<void>(resolve => (cleanupStarted = resolve));
  try {
    const run = withCleanup(
      roots,
      async () => undefined,
      () => {
        cleanupStarted();
        return new Promise<void>(resolve => (finishCleanup = resolve));
      },
      registered => (teardown = registered),
    );
    await started;
    let tornDown = false;
    const ending = teardown?.().then(() => (tornDown = true));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(tornDown).toBe(false);
    finishCleanup();
    await ending;
    expect(tornDown).toBe(true);
    await run;
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('a teardown at test end reports a failed cleanup the body started', async () => {
  const roots = tempRoots(1);
  const failure = new Error('compose down failed');
  let teardown: (() => Promise<void>) | undefined;
  let failCleanup = (): void => undefined;
  let cleanupStarted = (): void => undefined;
  const started = new Promise<void>(resolve => (cleanupStarted = resolve));
  try {
    const run = withCleanup(
      roots,
      async () => undefined,
      () => {
        cleanupStarted();
        return new Promise<void>((_, reject) => (failCleanup = () => reject(failure)));
      },
      registered => (teardown = registered),
    );
    await started;
    const ending = teardown?.();
    failCleanup();
    await expect(ending).rejects.toMatchObject({ errors: [failure], message: `Service fixture cleanup at test end failed; retained roots: ${roots[0]}` });
    await expect(run).rejects.toMatchObject({ errors: [failure] });
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('a teardown after the body settled has nothing left to clean or reap', async () => {
  const roots = tempRoots(1);
  const attempts: string[] = [];
  const late: string[] = [];
  let teardown: (() => Promise<void>) | undefined;
  try {
    await withCleanup(
      roots,
      async () => undefined,
      root => {
        attempts.push(root);
      },
      registered => (teardown = registered),
      root => {
        late.push(root);
      },
    );
    await teardown?.();
    expect(attempts).toEqual(roots);
    expect(late).toEqual([]);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('a live fixture root holds the Compose file and names its owner, so a dead run is recognisable', () => {
  const root = serviceFixtureRoot();
  try {
    expect(basename(root)).toMatch(/^sarathi-service-test-/);
    expect(readFileSync(join(root, 'compose.yaml'), 'utf8')).toContain('sarathi.live.worktree-services.root');
    const owner = JSON.parse(readFileSync(join(root, FIXTURE_OWNER_FILE), 'utf8')) as { pid: number; createdAt: number };
    expect(owner.pid).toBe(process.pid);
    expect(Date.now() - owner.createdAt).toBeLessThan(60_000);
    expect(serviceRootState(root, LIVE_PROJECT.name)).toBe('present');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreachable daemon is reported with its cause', () => {
  // A stand-in CLI, so no case outside the opt-in talks to a real daemon.
  const bin = mkdtempSync(join(tmpdir(), 'sarathi-docker-info-'));
  try {
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "Server:" >&2\necho "ERROR: Cannot connect to the Docker daemon at $DOCKER_HOST." >&2\nexit 1\n');
    chmodSync(join(bin, 'docker'), 0o755);
    const problem = dockerDaemonProblem({ PATH: `${bin}:/usr/bin:/bin`, DOCKER_HOST: 'unix:///tmp/sarathi-no-daemon.sock' });
    expect(problem).toBe('ERROR: Cannot connect to the Docker daemon at unix:///tmp/sarathi-no-daemon.sock.');
    expect(() => assertDockerDaemon(problem)).toThrow(`The Docker daemon is unreachable (${problem}); SARATHI_LIVE_SERVICES=required needs it running.`);
    expect(() => assertDockerDaemon(undefined)).not.toThrow();
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
    expect(dockerDaemonProblem({ PATH: `${bin}:/usr/bin:/bin` })).toBeUndefined();
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('the failing line is picked out of either platform docker info stderr', () => {
  // Verbatim from a stopped daemon: macOS Docker Desktop, then a Linux CI
  // runner, where the connect error is neither first nor last.
  const macos =
    'failed to connect to the docker API at unix:///tmp/probe.sock; check if the path is correct and if the daemon is running: dial unix /tmp/probe.sock: connect: no such file or directory\n';
  const linux = 'Server:\nERROR: Cannot connect to the Docker daemon at unix:///tmp/probe.sock. Is the docker daemon running?\nerrors pretty printing info\n';
  expect(daemonProblemFromStderr(macos, 'fallback')).toContain('/tmp/probe.sock');
  expect(daemonProblemFromStderr(linux, 'fallback')).toBe('ERROR: Cannot connect to the Docker daemon at unix:///tmp/probe.sock. Is the docker daemon running?');
  // A config warning precedes the connection error: the endpoint still wins.
  const warned = `WARNING: Error loading config file: /home/runner/.docker/config.json: permission denied\n${linux}`;
  expect(daemonProblemFromStderr(warned, 'fallback')).toContain('Cannot connect to the Docker daemon');
  // A socket permission failure, with no connection line, is still reported.
  expect(daemonProblemFromStderr('Got permission denied while trying to connect to the Docker daemon socket\n', 'fallback')).toContain('permission denied');
  // Neither pattern matches: the last line beats an empty report.
  expect(daemonProblemFromStderr('odd trailer\nsomething else\n', 'fb')).toBe('something else');
  expect(daemonProblemFromStderr('', 'spawn ENOENT')).toBe('spawn ENOENT');
});

test('a missing docker CLI is reported rather than thrown', () => {
  expect(dockerDaemonProblem({ PATH: '' })).toContain('ENOENT');
});

test('the live cases run only when asked', () => {
  expect(liveServicesRun({})).toBe(false);
  expect(liveServicesRun({ CI: 'true' })).toBe(false);
  expect(liveServicesRun({ [LIVE_VARIABLE]: '' })).toBe(false);
  expect(liveServicesRun({ [LIVE_VARIABLE]: '1' })).toBe(false);
  expect(liveServicesRun({ [LIVE_VARIABLE]: 'required' })).toBe(true);
});

/** A test's teardown, run when it ends (its timeout included). */
const onFinished =
  (t: TestContext) =>
  (teardown: () => Promise<void>): void => {
    t.after(teardown);
  };

/** A root whose services are reaped by name when the test ends, on top of its own cleanup. */
function testFixtureRoot(t: TestContext): string {
  const root = serviceFixtureRoot();
  t.after(() => release(root));
  return root;
}

const ids = (project: string, ...kind: string[]): Promise<string[]> =>
  docker([...kind, '--quiet', '--filter', `label=com.docker.compose.project=${project}`]).then(listing => listing.split('\n').filter(Boolean));

test('services of a deleted worktree are reaped; a live worktree keeps its services', { skip, timeout: 300_000 }, async t => {
  assertDockerDaemon(dockerDaemonProblem());
  const [deleted = '', kept = ''] = [testFixtureRoot(t), testFixtureRoot(t)];
  await Promise.all([live(deleted, 'up'), live(kept, 'up')]);
  const project = projectName(PREFIX, deleted);
  // Two containers and the volume; the services share the default bridge.
  const resources = async (name: string): Promise<string[]> => [...(await ids(name, 'ps', '--all')), ...(await ids(name, 'volume', 'ls')), ...(await ids(name, 'network', 'ls'))];
  expect((await resources(project)).length).toBeGreaterThanOrEqual(3);
  // Every sweep of the live prefix on this machine reaps a project whose root
  // is gone. The root therefore stays on disk, where no other sweep will touch
  // it, and only this sweep is told it is gone: its own awaited report is then
  // the whole removal, and it is asserted before the effect.
  expect(await serviceProjects(docker, LIVE_PROJECT.file)).toContainEqual({ project, root: deleted });
  const result = await reapOrphanedServices(docker, { project: PREFIX, rootLabel: LIVE_PROJECT.file.rootLabel, name: LIVE_PROJECT.name }, path =>
    path === deleted ? 'gone' : worktreeState(path),
  );
  const own = <T extends { project: string }>(entries: T[]): T[] => entries.filter(entry => entry.project === project);
  expect({ failed: own(result.failed), skipped: own(result.skipped) }).toEqual({ failed: [], skipped: [] });
  expect(result.reaped).toContain(project);
  expect(result.reaped).not.toContain(projectName(PREFIX, kept));
  expect(await resources(project)).toEqual([]);
  // Nothing is left to race now, so delete the root for real.
  rmSync(deleted, { recursive: true, force: true });
  expect(worktreeState(deleted)).toBe('gone');
  expect(await ids(projectName(PREFIX, kept), 'ps')).toHaveLength(2);
});

test('a reap that stopped after removing the containers is finished by the next sweep', { skip, timeout: 300_000 }, async t => {
  assertDockerDaemon(dockerDaemonProblem());
  const root = testFixtureRoot(t);
  const project = projectName(PREFIX, root);
  const only = ['--filter', `label=com.docker.compose.project=${project}`];
  // Every listing is narrowed to this project, so these sweeps act on nothing
  // else, and the root stays on disk, so no other sweep acts on it.
  const scoped: Docker = args => docker([...args, ...(args[0] === 'ps' || args[1] === 'ls' ? only : [])]);
  await live(root, 'up');
  // The reaping process exits, or `volume rm` times out, once `docker rm` is done.
  await expect(
    reapProject(
      async args => {
        if (args[0] === 'volume' && args[1] === 'rm') throw new Error('reap stopped');
        return scoped(args);
      },
      PREFIX,
      project,
    ),
  ).rejects.toThrow('reap stopped');
  expect(await ids(project, 'ps', '--all')).toEqual([]);
  expect(await ids(project, 'volume', 'ls')).not.toEqual([]);
  const result = await reapOrphanedServices(scoped, { project: PREFIX, rootLabel: LIVE_PROJECT.file.rootLabel, name: LIVE_PROJECT.name }, path =>
    path === root ? 'gone' : worktreeState(path),
  );
  expect(result).toEqual({ reaped: [project], skipped: [], failed: [], warnings: [] });
  expect([...(await ids(project, 'ps', '--all')), ...(await ids(project, 'volume', 'ls')), ...(await ids(project, 'network', 'ls'))]).toEqual([]);
});

test('two live worktree service projects do not share state, and a restart keeps it', { skip, timeout: 300_000 }, async t => {
  await withLiveServices(onFinished(t), async (roots, environments) => {
    const [first = '', second = ''] = roots;
    const [one = {}, two = {}] = environments;
    expect(one.CACHE_URL).not.toBe(two.CACHE_URL);
    expect(new URL(one.STORE_URL ?? '').port).not.toBe(new URL(two.STORE_URL ?? '').port);
    // Below Docker's publishing range, so a re-`up` cannot hand a published
    // service this persisted server port.
    for (const environment of environments) expect(Number(environment.PORT)).toBeLessThan(32768);
    const redis = (root: string, service: string, ...args: string[]): string => compose(root, 'exec', '-T', service, 'redis-cli', ...args);
    redis(first, 'store', 'SET', 'isolation_probe', 'first');
    redis(first, 'store', 'SAVE');
    expect(redis(first, 'store', 'GET', 'isolation_probe')).toBe('first');
    expect(redis(second, 'store', 'EXISTS', 'isolation_probe')).toBe('0');
    const childFile = join(first, 'child-environment.json');
    const code = await live(first, 'run', [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({url:process.env.STORE_URL, port:process.env.PORT})); process.exitCode=7`,
      childFile,
    ]);
    expect(code).toBe(7);
    expect(JSON.parse(readFileSync(childFile, 'utf8'))).toEqual({ url: one.STORE_URL, port: one.PORT });
    const before = readFileSync(join(first, '.tmp/services/config.json'), 'utf8');
    await live(first, 'down');
    await live(first, 'up');
    expect(redis(first, 'store', 'GET', 'isolation_probe')).toBe('first');
    expect(readFileSync(join(first, '.tmp/services/config.json'), 'utf8')).toBe(before);
  });
});
