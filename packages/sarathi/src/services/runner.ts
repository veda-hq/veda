/**
 * `sarathi services`: a worktree's local development services, the Compose
 * project in the services file's `compose`, named after the worktree root.
 * Docker allocates the published ports; the server port is drawn once per
 * worktree and kept in `.tmp/services/config.json`. No shared `.env` file is
 * read or modified.
 *
 * - `up`: start the project, read its published ports, write
 *   `.tmp/services/environment.json`.
 * - `down`, `status`: stop it, list it.
 * - `web`: the web command on the web port, with only the variables it names.
 * - `server`: the services, the `server.before` steps, then the server.
 * - `run -- <command>`: the command, with the services' environment.
 * - `<action>`: a configured action's commands, with the services running.
 *
 * A command these services start gets `SARATHI_SERVICES_CONTEXT`, so a
 * nested `sarathi services` call reuses its parent's environment.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { expand, type ServicesFile, type Values } from './file.ts';
import { dockerCli, projectName, reapOrphanedServices, type ReapSettings, type SweepResult } from './reaper.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** Set on every command these services start, so a nested call reuses them. */
export const PREPARED_CONTEXT = 'SARATHI_SERVICES_CONTEXT';
/** `up --wait`'s deadline. */
export const STARTUP_SECONDS = 240;

export interface ServiceConfig {
  project: string;
  password: string;
  serverPort: number;
  webPort: number;
}

/** What a service run reads and writes outside itself. */
export interface ServicesIo {
  readonly env: Env;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** The deleted-worktree sweep a start runs first; replaced in tests. */
  readonly sweep?: () => Promise<SweepResult>;
}

/** A project's services: its file, and `worktree.name` for the reaper. */
export interface Project {
  readonly file: ServicesFile;
  readonly name: string;
}

export const reapSettings = (project: Project): ReapSettings => ({ project: project.file.project, rootLabel: project.file.rootLabel, name: project.name });

/**
 * Docker publishes ports from the host's ephemeral range (32768–60999 on
 * Linux and in Docker Desktop's and OrbStack's VMs), which a kernel listen(0)
 * also draws from. The server port comes from the file's `apiPorts`, a band
 * below it, so a published port can never take a stopped server's port.
 */
export function apiPortCandidate(band: readonly [number, number], draw: (size: number) => number = randomInt): number {
  return band[0] + draw(band[1] - band[0] + 1);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function validPort(port: unknown): boolean {
  // Number.isInteger is false for every non-number.
  return Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536;
}

/**
 * A config written for this root, every field of `ServiceConfig` present:
 * two distinct ports, or both 0 in one from before ports were allocated.
 */
export function validConfig(value: unknown, root: string, prefix: string): value is ServiceConfig {
  if (typeof value !== 'object' || value === null) return false;
  const config = new Map(Object.entries(value));
  const password = config.get('password');
  const serverPort = config.get('serverPort');
  const webPort = config.get('webPort');
  return (
    config.get('project') === projectName(prefix, root) &&
    typeof password === 'string' &&
    /^[a-f0-9]{48}$/.test(password) &&
    ((serverPort === 0 && webPort === 0) || (validPort(serverPort) && validPort(webPort) && serverPort !== webPort))
  );
}

/**
 * Listen on `host:port`, then close; rejects with the bind error. The waits
 * are callbacks, not event names, so a changed one fails at once instead of
 * waiting forever on a server that stays open.
 */
async function bindAndRelease(port: number, host: string): Promise<void> {
  const listener = createServer();
  try {
    await new Promise<void>((done, fail) => {
      listener.once('error', fail);
      listener.listen(port, host, done);
    });
  } finally {
    // A bind that failed left nothing listening, and close would refuse it.
    if (listener.listening) await promisify(listener.close.bind(listener))();
  }
}

/**
 * Both loopback families: macOS may allow an IPv6 wildcard bind beside an
 * occupied IPv4 loopback socket. A host without IPv6 loopback cannot have it
 * occupied.
 */
export async function loopbackPortFree(port: number, bind: (port: number, host: string) => Promise<void> = bindAndRelease): Promise<boolean> {
  const free = (host: string): Promise<boolean> =>
    bind(port, host).then(
      () => true,
      (error: unknown) => {
        if (hasCode(error, 'EADDRINUSE')) return false;
        if (hasCode(error, 'EAFNOSUPPORT') || hasCode(error, 'EADDRNOTAVAIL')) return true;
        throw error;
      },
    );
  return (await free('127.0.0.1')) && free('::1');
}

/** The first free candidate of 20. */
export async function applicationPort(candidate: () => number, isFree: (port: number) => Promise<boolean> = loopbackPortFree): Promise<number> {
  // Twenty tries, counted by the array rather than a condition, so no changed bound can loop forever.
  for (const _ of Array(20).keys()) {
    const next = candidate();
    if (await isFree(next)) return next;
  }
  throw new Error('Could not allocate a free server port');
}

async function writeAtomically(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.new`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.new`, path);
}

/** The stored config, or undefined when this worktree has none yet. */
async function storedConfig(path: string): Promise<unknown> {
  try {
    return JSON.parse(String(await readFile(path)));
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/**
 * This worktree's config, created on first use. Created exclusively, so two
 * first starts agree on one password: the loser reads the winner's file.
 */
export async function serviceConfig(
  root: string,
  file: ServicesFile,
  allocate: () => Promise<number> = () => applicationPort(() => apiPortCandidate(file.apiPorts)),
  { upgrade = true }: { upgrade?: boolean } = {},
): Promise<ServiceConfig> {
  const directory = join(root, '.tmp', 'services');
  const path = join(directory, 'config.json');
  if ((await storedConfig(path)) === undefined) {
    const fresh: ServiceConfig = { project: projectName(file.project, root), password: randomBytes(24).toString('hex'), serverPort: await allocate(), webPort: file.webPort };
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(path, JSON.stringify(fresh), { flag: 'wx', mode: 0o600 });
      return fresh;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  }
  const current = async (): Promise<ServiceConfig> => {
    const stored = await storedConfig(path);
    if (!validConfig(stored, root, file.project)) throw new Error(`Invalid or copied service configuration at ${path}; keep it for diagnosis, then move it aside to regenerate`);
    return stored;
  };
  // Actions never rewrite the stored endpoints.
  if (!upgrade) return current();
  // A config from before the server port was allocated at creation, or from
  // another web port. Read and upgraded under a lock, so two starts that find
  // it agree on one port. An unallocated config's web port is 0, which no
  // parsed file's is, so a matching web port means an allocated server port.
  return withLock(join(directory, 'config-lock'), async () => {
    const stored = await current();
    if (stored.webPort === file.webPort) return stored;
    const upgraded: ServiceConfig = { ...stored, serverPort: stored.serverPort === 0 ? await allocate() : stored.serverPort, webPort: file.webPort };
    await writeAtomically(path, upgraded);
    return upgraded;
  });
}

const valuesFor = (config: ServiceConfig, file: ServicesFile, published: Readonly<Record<string, number>>): Values => ({
  password: config.password,
  serverPort: config.serverPort,
  webPort: file.webPort,
  project: config.project,
  published,
});

/** The variables `names` of the services file's `environment`, filled with `values`; a parsed file's `web.environment` names only its own keys. */
const filledEnvironment = (file: ServicesFile, values: Values, names: readonly string[]): Record<string, string> =>
  Object.fromEntries(names.map(name => [name, expand(file.environment[name] as string, values, true)]));

/** The services file's `environment`, filled for this worktree and the ports Docker published. */
export function environmentFor(file: ServicesFile, config: ServiceConfig, published: Readonly<Record<string, number>>): Record<string, string> {
  return filledEnvironment(file, valuesFor(config, file, published), Object.keys(file.environment));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // fail-open: only ESRCH proves no such process; EPERM and the rest count as alive.
    return !hasCode(error, 'ESRCH');
  }
}

/**
 * The environment a parent `sarathi services` passed down for this root,
 * while that parent still runs; anything else is not authority to skip `up`.
 */
export function preparedEnvironment(root: string, file: ServicesFile, env: Env, alive: (pid: number) => boolean = pidAlive): Record<string, string> | undefined {
  try {
    const context = new Map<string, unknown>(Object.entries(JSON.parse(String(env[PREPARED_CONTEXT])) as object));
    const owner = context.get('owner');
    // Signal 0 to pid 0 or below would reach a whole process group.
    if (context.get('root') !== root || typeof owner !== 'number' || owner <= 0) return undefined;
    if (!alive(owner)) return undefined;
  } catch {
    // fail-open: a missing or unreadable context is no parent, so the services start.
    return undefined;
  }
  const environment: Record<string, string> = {};
  for (const name of Object.keys(file.environment)) {
    const value = env[name];
    if (value === undefined || value === '') return undefined;
    environment[name] = value;
  }
  return environment;
}

/** How long a waiter polls the setup lock before naming its holder. */
export const LOCK_PAUSE_MS = 250;
/** A whole `up --wait` of the holder, plus a minute. */
export const LOCK_ATTEMPTS = ((STARTUP_SECONDS + 60) * 1000) / LOCK_PAUSE_MS;

/**
 * Removes the lock a dead `holder` left, one waiter at a time. The waiter
 * that creates `<lock>.takeover` re-reads the owner first, so a lock another
 * waiter removed and re-acquired since is kept. False when another waiter
 * holds the takeover.
 */
async function removeDeadLock(lock: string, owner: string, holder: string): Promise<boolean> {
  const guard = `${lock}.takeover`;
  try {
    await mkdir(guard);
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return false;
    throw error;
  }
  try {
    const current = await readFile(owner).then(String, () => undefined);
    if (current === holder) await rm(lock, { recursive: true });
    return true;
  } finally {
    await rmdir(guard);
  }
}

/**
 * Serializes `up` per worktree: two first starts of one project would both
 * create its containers. A lock whose holder died is taken over.
 */
export async function withLock<T>(
  lock: string,
  body: () => Promise<T>,
  {
    alive = pidAlive,
    pause = (ms: number) => delay(ms),
    attempts = LOCK_ATTEMPTS,
  }: { alive?: (pid: number) => boolean; pause?: (ms: number) => Promise<unknown>; attempts?: number } = {},
): Promise<T> {
  const owner = join(lock, 'owner');
  const acquire = async (attempt: number): Promise<void> => {
    try {
      await mkdir(lock);
      await writeFile(owner, String(process.pid));
      return;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    const holder =
      String(
        await readFile(owner).catch(() => {
          // fail-open: missing or empty while its holder is between mkdir and writing its pid.
          return '';
        }),
      ) || 'unknown';
    const pid = Number(holder);
    if (attempt >= attempts) throw new Error(`Service setup is locked at ${lock} by process ${holder}; stop it, or remove the lock if it is stale`);
    // A takeover retries at once, but still spends an attempt.
    if (pid > 0 && !alive(pid) && (await removeDeadLock(lock, owner, holder))) return acquire(attempt + 1);
    await pause(LOCK_PAUSE_MS);
    return acquire(attempt + 1);
  };
  await acquire(0);
  try {
    return await body();
  } finally {
    // Gone already if someone removed it by hand.
    await rm(lock, { recursive: true, force: true });
  }
}

/**
 * The error for a failed docker command, ending with Docker's own last words:
 * hooks keep only the tail of a run, and `up --wait` puts the reason last.
 */
export function dockerFailure(argv: readonly string[], outcome: string, stderr: string): Error {
  const reason = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' / ');
  return new Error(`Command failed: docker ${argv.join(' ')} (${outcome})${reason === '' ? '' : `: ${reason}`}`);
}

export type Compose = (args: string[]) => Promise<string>;

/** The variables the Compose file interpolates, for this root's project. */
export function composeVariables(root: string, prefix: string, password: string): Record<string, string> {
  return {
    // Compose ranks an inherited COMPOSE_PROJECT_NAME above the file's
    // `name:`, so the project is set here too.
    COMPOSE_PROJECT_NAME: projectName(prefix, root),
    SARATHI_SERVICES_PROJECT: projectName(prefix, root),
    SARATHI_SERVICES_PASSWORD: password,
    SARATHI_WORKTREE_ROOT: root,
  };
}

/**
 * `docker compose` for this root's project. Stdin is closed: a volume whose
 * labels predate the Compose file makes `up` ask "Recreate (data will be
 * lost)?", and a closed stdin declines and keeps the data. Progress goes to
 * stderr.
 */
export function composeFor(root: string, file: ServicesFile, password: string, io: Pick<ServicesIo, 'env' | 'err'>): Compose {
  return args =>
    new Promise((done, fail) => {
      const argv = ['compose', '-f', join(root, file.compose), ...args];
      const child = spawn('docker', argv, { cwd: root, env: { ...io.env, ...composeVariables(root, file.project, password) }, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      let stderr = Buffer.alloc(0);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        io.err(String(chunk));
        stderr = Buffer.concat([stderr, chunk]).subarray(-4096);
      });
      child.once('error', fail);
      child.once('close', (code, signal) => {
        if (code === 0) done(String(Buffer.concat(stdout)).trim());
        else fail(dockerFailure(argv, signal ?? `exit ${code}`, String(stderr)));
      });
    });
}

/** Reports a sweep: what it removed on stdout, what it could not do on stderr. Never fails the start. */
async function reportSweep(io: ServicesIo, run: () => Promise<SweepResult>): Promise<void> {
  try {
    const { reaped, skipped, failed, warnings } = await run();
    if (reaped.length > 0) io.out(`Removed services of deleted worktrees: ${reaped.join(', ')}\n`);
    const notes = [...warnings, ...skipped.map(({ project, reason }) => `kept ${project}: ${reason}`), ...failed.map(({ project, error }) => `could not remove ${project}: ${error}`)];
    for (const note of notes) io.err(`Deleted-worktree sweep: ${note}\n`);
  } catch (error) {
    // fail-open: reclaiming other worktrees' services never blocks this one; what it could not do is said.
    io.err(`Deleted-worktree sweep did not run: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** Start the project, then read the ports Docker published. */
export async function startServices(root: string, project: Project, config: ServiceConfig, compose: Compose, io: ServicesIo): Promise<Record<string, string>> {
  const { file } = project;
  const directory = join(root, '.tmp', 'services');
  // An archived worktree's services outlive its directory.
  await reportSweep(io, io.sweep ?? (() => reapOrphanedServices(dockerCli(io.env), reapSettings(project))));
  await withLock(join(directory, 'lock'), () => compose(['up', '-d', '--wait', '--wait-timeout', String(STARTUP_SECONDS)]));
  const published: Record<string, number> = {};
  for (const [name, { service, port }] of Object.entries(file.published)) {
    const output = await compose(['port', service, String(port)]);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(output);
    if (match === null) throw new Error(`Unexpected published endpoint for ${service}: ${output}`);
    published[name] = Number(match[1]);
  }
  const environment = environmentFor(file, config, published);
  await writeAtomically(join(directory, 'environment.json'), environment);
  io.out(`${config.project}: server http://localhost:${config.serverPort}${file.web === undefined ? '' : `, web http://localhost:${file.webPort}`}\n`);
  return environment;
}

async function assertPortFree(port: number, file: ServicesFile): Promise<void> {
  if (await loopbackPortFree(port)) return;
  throw new Error(
    port === file.webPort
      ? `Web port ${port} is already in use; stop the other web server before starting this one. Only one can run at a time.`
      : `Server port ${port} is already in use; stop its owner before starting this worktree's server`,
  );
}

/** Runs `command` with the services' environment, forwarding Ctrl-C and TERM; resolves its exit code. */
async function runWith(root: string, command: readonly string[], environment: Readonly<Record<string, string>>, env: Env): Promise<number> {
  const [program, ...args] = command;
  if (program === undefined) throw new Error('A command is required after --');
  const child = spawn(program, args, { cwd: root, env: { ...env, ...environment, [PREPARED_CONTEXT]: JSON.stringify({ root, owner: process.pid }) }, stdio: 'inherit' });
  const interrupt = (): void => {
    child.kill('SIGINT');
  };
  const terminate = (): void => {
    child.kill('SIGTERM');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    // Node gives the exit code, or else the signal that ended the command:
    // never neither. A signal ends it with 1.
    const [code] = (await once(child, 'exit')) as [number | null];
    return code ?? 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

/** Runs `steps` in order; the first that fails throws, naming it, and the rest do not run. */
async function runSteps(root: string, steps: readonly (readonly string[])[], environment: Readonly<Record<string, string>>, env: Env, failure: (step: string) => string): Promise<void> {
  for (const step of steps) {
    const code = await runWith(root, step, environment, env);
    if (code !== 0) throw new Error(failure(`${step.join(' ')} (exit ${code})`));
  }
}

function assertMainCheckout(root: string, action: string, env: Env): void {
  const revParse = (option: string): string => execFileSync('git', ['rev-parse', '--path-format=absolute', option], { cwd: root, encoding: 'utf8', env: { ...env } });
  if (revParse('--git-dir').trim() !== revParse('--git-common-dir').trim()) throw new Error(`${action} runs only in the main checkout, where the data it acts on lives.`);
}

/** A command filled with `values`, as it is (no URL encoding), then `extra`. */
export const fill = (command: readonly string[], values: Values, extra: readonly string[] = []): string[] => [...command.map(part => expand(part, values, false)), ...extra];

/**
 * One action for the worktree at `rootPath`; resolves the exit code: a
 * launched command's own, else 0. Throws what keeps it from running.
 */
export async function services(rootPath: string, action: string, command: readonly string[], project: Project, io: ServicesIo): Promise<number> {
  const root = await realpath(rootPath);
  const { file } = project;
  const custom = file.actions[action];
  if (custom?.mainCheckoutOnly === true) assertMainCheckout(root, action, io.env);
  if (action === 'down' || action === 'status') {
    const stored: unknown = await readFile(join(root, '.tmp', 'services', 'config.json')).then(
      text => JSON.parse(String(text)) as unknown,
      () => {
        // fail-open: no readable config means no services were started here.
      },
    );
    if (!validConfig(stored, root, file.project)) {
      io.out('No services configured for this worktree\n');
      return 0;
    }
    const compose = composeFor(root, file, stored.password, io);
    if (action === 'status') {
      io.out(`${await compose(['ps'])}\n`);
      return 0;
    }
    // Under the start's lock: a `down` during `up --wait` waits for it.
    await withLock(join(root, '.tmp', 'services', 'lock'), async () => {
      await compose(['down']);
      await rm(join(root, '.tmp', 'services', 'environment.json'), { force: true });
    });
    return 0;
  }
  const prepared = preparedEnvironment(root, file, io.env);
  let config = await serviceConfig(root, file, undefined, { upgrade: false });
  if (custom === undefined) {
    // A server port persisted on the web port is not silently moved: its consumers know that address.
    if (config.serverPort === file.webPort) {
      throw new Error(
        `Persisted server port ${file.webPort} conflicts with the web port; stop this worktree's server and set serverPort in .tmp/services/config.json to an unused port other than ${file.webPort}, preserving all other settings`,
      );
    }
    config = await serviceConfig(root, file);
  }
  const values = valuesFor(config, file, {});
  if (action === 'web') {
    if (file.web === undefined) throw new Error(`${file.path} has no "web" command`);
    // The web command needs only what it names, not the containers.
    const environment = prepared ?? filledEnvironment(file, values, file.web.environment);
    await assertPortFree(file.webPort, file);
    return runWith(root, fill(file.web.command, values, command), environment, io.env);
  }
  let server: ServicesFile['server'];
  if (action === 'server') {
    if (file.server === undefined) throw new Error(`${file.path} has no "server" command`);
    server = file.server;
  }
  const environment = prepared ?? (await startServices(root, project, config, composeFor(root, file, config.password, io), io));
  if (action === 'up') return 0;
  if (custom !== undefined) {
    const steps = custom.run.map((step, index) => fill(step, values, index === custom.run.length - 1 ? command : []));
    await runSteps(root, steps, environment, io.env, step => `${action} failed at ${step}; the steps after it did not run.`);
    return 0;
  }
  if (server !== undefined) {
    await assertPortFree(config.serverPort, file);
    const before = server.before.map(step => fill(step, values));
    await runSteps(root, before, environment, io.env, step => `${step} failed, so the server was not started. Fix the error above and retry; the services' data is kept.`);
    return runWith(root, fill(server.command, values, command), environment, io.env);
  }
  return runWith(root, command, environment, io.env);
}
