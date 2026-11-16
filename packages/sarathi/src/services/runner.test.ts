// The runner against stub `docker` and `pnpm` executables on the PATH the
// runner is given: every spawn is real, only the programs are stood in.
import { execFileSync } from 'node:child_process';
import { fstatSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { expect, vi } from '../test/expect.test.ts';
import type { ServicesFile } from './file.ts';
import { projectName, type SweepResult } from './reaper.ts';
import {
  apiPortCandidate,
  applicationPort,
  composeFor,
  composeVariables,
  dockerFailure,
  environmentFor,
  LOCK_ATTEMPTS,
  LOCK_PAUSE_MS,
  loopbackPortFree,
  PREPARED_CONTEXT,
  preparedEnvironment,
  reapSettings,
  serviceConfig,
  services,
  STARTUP_SECONDS,
  validConfig,
  withLock,
  type ServiceConfig,
  type ServicesIo,
} from './runner.ts';
import { LABEL, PREFIX, sample, sampleRaw } from './sample.test.ts';
import { parseServicesFile } from './file.ts';

const PASSWORD = 'a'.repeat(48);
const BAND: readonly [number, number] = [20000, 29999];

/**
 * Stub `docker` and `pnpm` that log their argv, cwd and the compose
 * variables, and answer as the case's environment says.
 */
const STUB = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const bin = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({
  bin, args, cwd: process.cwd(),
  project: process.env.SARATHI_SERVICES_PROJECT,
  composeProject: process.env.COMPOSE_PROJECT_NAME,
  password: process.env.SARATHI_SERVICES_PASSWORD,
  root: process.env.SARATHI_WORKTREE_ROOT,
  database: process.env.DATABASE_URL,
  api: process.env.API_URL,
  context: process.env.SARATHI_SERVICES_CONTEXT,
  out: fs.fstatSync(1).ino,
  locked: process.env.SARATHI_WORKTREE_ROOT
    ? fs.existsSync(path.join(process.env.SARATHI_WORKTREE_ROOT, '.tmp', 'services', 'lock'))
    : undefined,
}) + '\\n');
if (bin === 'pnpm') process.exit(process.env.STUB_FAIL && process.env.STUB_FAIL === args[0] ? 4: Number(process.env.STUB_EXIT || 0));
// docker compose -f <file> <verb>
switch (args[3]) {
  case 'up':
    if (!process.env.STUB_FAIL_UP) break;
    process.stderr.write('pulling\\nfirst line\\napplication not healthy after 4m0s\\n');
    process.exit(3);
  case 'port':
    process.stdout.write(args[4] === 'postgres' ? (process.env.STUB_PG || '127.0.0.1:41001') : '127.0.0.1:41002');
    break;
  case 'ps':
    process.stdout.write('NAME STATUS\\n');
    break;
}
`;

interface Call {
  bin: string;
  args: string[];
  cwd: string;
  project?: string;
  composeProject?: string;
  password?: string;
  root?: string;
  database?: string;
  api?: string;
  context?: string;
  /** The inode of the stub's stdout: this process's when it inherits it. */
  out?: number;
  /** Whether the setup lock existed while the stub ran (docker calls only). */
  locked?: boolean;
}

/**
 * Longest a suite here may take, so a waiting mutant fails instead of
 * hanging. node:test bounds a describe block as a whole, not each case.
 */
const BOUND_MS = 300_000;

let root: string;
let log: string;
let output: string;
let errors: string;
let env: Record<string, string | undefined>;
let file: ServicesFile;
let io: ServicesIo & { sweep?: () => Promise<SweepResult> };

const NO_SWEEP: SweepResult = { reaped: [], skipped: [], failed: [], warnings: [] };

async function calls(): Promise<Call[]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Call);
}

async function writeConfig(value: unknown): Promise<void> {
  await mkdir(join(root, '.tmp', 'services'), { recursive: true });
  await writeFile(join(root, '.tmp', 'services', 'config.json'), JSON.stringify(value));
}

const config = (serverPort = 23456): ServiceConfig => ({ project: projectName(PREFIX, root), password: PASSWORD, serverPort, webPort: file.webPort });
const project = (): { file: ServicesFile; name: string } => ({ file, name: 'acme' });
const run = (action: string, command: string[] = []): Promise<number> => services(root, action, command, project(), io);

async function listen(port = 0): Promise<Server> {
  const server = createServer();
  await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
  return server;
}
const portOf = (server: Server): number => {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
};
const close = (server: Server): Promise<unknown> => new Promise(done => server.close(done));

async function freePort(): Promise<number> {
  return applicationPort(() => apiPortCandidate(BAND));
}

/** A port outside the API band that is free now, for the web port. */
async function freeWebPort(): Promise<number> {
  for (;;) {
    const server = await listen();
    const port = portOf(server);
    await close(server);
    if (port < BAND[0] || port > BAND[1]) return port;
  }
}

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'sarathi-services-unit-')));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await Promise.all(
    ['docker', 'pnpm'].map(async name => {
      await writeFile(join(bin, name), STUB);
      await chmod(join(bin, name), 0o755);
    }),
  );
  log = join(root, 'calls.jsonl');
  env = { ...process.env, STUB_LOG: log, PATH: `${bin}:${process.env.PATH ?? ''}`, [PREPARED_CONTEXT]: '' };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
  file = sample(await freeWebPort());
  output = '';
  errors = '';
  io = {
    env,
    out: text => {
      output += text;
    },
    err: text => {
      errors += text;
    },
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('identity and errors', () => {
  test('a failed docker command ends with the last two lines Docker printed', () => {
    expect(dockerFailure(['compose', 'up'], 'exit 1', 'a\n\n b \nc\n').message).toBe('Command failed: docker compose up (exit 1): b / c');
    expect(dockerFailure(['ps'], 'SIGTERM', '  \n').message).toBe('Command failed: docker ps (SIGTERM)');
  });

  test('the reaper gets the file’s names and worktree.name', () => {
    expect(reapSettings(project())).toEqual({ project: PREFIX, rootLabel: LABEL, name: 'acme' });
  });
});

describe('server port', { timeout: BOUND_MS }, () => {
  test('candidates span the band', () => {
    expect(apiPortCandidate(BAND, () => 0)).toBe(BAND[0]);
    expect(apiPortCandidate(BAND, size => size - 1)).toBe(BAND[1]);
    const drawn = apiPortCandidate(BAND);
    expect(drawn).toBeGreaterThanOrEqual(BAND[0]);
    expect(drawn).toBeLessThanOrEqual(BAND[1]);
  });

  test('the first free candidate wins, and twenty taken ones give up', async () => {
    const tried: number[] = [];
    let next = 20000;
    const candidate = (): number => next++;
    expect(
      await applicationPort(candidate, async port => {
        tried.push(port);
        return port === 20002;
      }),
    ).toBe(20002);
    expect(tried).toEqual([20000, 20001, 20002]);
    const isFree = vi.fn(async () => false);
    await expect(applicationPort(candidate, isFree)).rejects.toThrow('Could not allocate a free server port');
    expect(isFree).toHaveBeenCalledTimes(20);
  });

  test('a port is free only when neither loopback family holds it', async () => {
    const failing =
      (code: string, host?: string) =>
      async (_: number, at: string): Promise<void> => {
        if (host === undefined || host === at) throw Object.assign(new Error(code), { code });
      };
    expect(await loopbackPortFree(1, async () => undefined)).toBe(true);
    expect(await loopbackPortFree(1, failing('EADDRINUSE', '127.0.0.1'))).toBe(false);
    expect(await loopbackPortFree(1, failing('EADDRINUSE', '::1'))).toBe(false);
    expect(await loopbackPortFree(1, failing('EAFNOSUPPORT', '::1'))).toBe(true);
    expect(await loopbackPortFree(1, failing('EADDRNOTAVAIL', '::1'))).toBe(true);
    await expect(loopbackPortFree(1, failing('EACCES'))).rejects.toThrow('EACCES');
  });

  test('the real probe sees a listener on IPv4 loopback', async () => {
    const server = await listen();
    const port = portOf(server);
    try {
      expect(await loopbackPortFree(port)).toBe(false);
    } finally {
      await close(server);
    }
    expect(await loopbackPortFree(port)).toBe(true);
  });
});

describe('configuration', { timeout: BOUND_MS }, () => {
  test('a config is this root’s only with its project, a 48-hex password and two distinct ports', () => {
    const web = file.webPort;
    expect(validConfig(config(), root, PREFIX)).toBe(true);
    // Both unallocated, from before ports were allocated at creation.
    expect(validConfig({ ...config(0), webPort: 0 }, root, PREFIX)).toBe(true);
    // One unallocated and one not was never written.
    expect(validConfig(config(0), root, PREFIX)).toBe(false);
    expect(validConfig({ ...config(), webPort: 0 }, root, PREFIX)).toBe(false);
    expect(validConfig({ ...config(), project: projectName(PREFIX, '/x') }, root, PREFIX)).toBe(false);
    // Another project's prefix never owns this root's config.
    expect(validConfig(config(), root, 'other-wt')).toBe(false);
    expect(validConfig({ ...config(), password: 'short' }, root, PREFIX)).toBe(false);
    expect(validConfig({ ...config(), password: 7 }, root, PREFIX)).toBe(false);
    // The server and the web never share a port.
    expect(validConfig(config(web), root, PREFIX)).toBe(false);
    expect(validConfig({ ...config(web), webPort: 32102 }, root, PREFIX)).toBe(true);
    expect(validConfig({ ...config(1), webPort: 65535 }, root, PREFIX)).toBe(true);
    for (const serverPort of [-1, 65536, 1.5, '23456']) expect(validConfig({ ...config(), serverPort }, root, PREFIX)).toBe(false);
    expect(validConfig({ ...config(), webPort: 41000 }, root, PREFIX)).toBe(true);
    for (const webPort of [undefined, -1, 65536, 1.5, '5173']) expect(validConfig({ ...config(), webPort }, root, PREFIX)).toBe(false);
    expect(validConfig(null, root, PREFIX)).toBe(false);
    expect(validConfig('config', root, PREFIX)).toBe(false);
  });

  test('the first start writes a private config that later starts reuse', async () => {
    const created = await serviceConfig(root, file, async () => 21000);
    expect(created).toEqual({ project: projectName(PREFIX, root), password: expect.stringMatching(/^[a-f0-9]{48}$/), serverPort: 21000, webPort: file.webPort });
    const path = join(root, '.tmp', 'services', 'config.json');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const written = (await stat(path)).ino;
    const allocate = vi.fn(async () => 22000);
    expect(await serviceConfig(root, file, allocate)).toEqual(created);
    expect(allocate).not.toHaveBeenCalled();
    expect((await stat(path)).ino).toBe(written);
  });

  test('without an allocator, the first start draws its port from the band', async () => {
    const created = await serviceConfig(root, file);
    expect(created.serverPort).toBeGreaterThanOrEqual(BAND[0]);
    expect(created.serverPort).toBeLessThanOrEqual(BAND[1]);
  });

  test('two first starts agree on one config', async () => {
    const [a, b] = await Promise.all([serviceConfig(root, file, async () => 21000), serviceConfig(root, file, async () => 21001)]);
    expect(a).toEqual(b);
  });

  test('a config from before allocation-at-creation gets its server port, once', async () => {
    await writeConfig({ ...config(0), webPort: 0 });
    expect(await serviceConfig(root, file, async () => 24000)).toEqual(config(24000));
    expect(JSON.parse(await readFile(join(root, '.tmp', 'services', 'config.json'), 'utf8'))).toEqual(config(24000));
    // A web port other than the file's moves to the file's.
    await writeConfig({ ...config(25000), webPort: 41000 });
    expect(await serviceConfig(root, file, async () => 1)).toEqual(config(25000));
  });

  test('two starts upgrading one old config agree on its server port', async () => {
    await writeConfig({ ...config(0), webPort: 0 });
    const [a, b] = await Promise.all([serviceConfig(root, file, async () => 24000), serviceConfig(root, file, async () => 24001)]);
    expect(a).toEqual(b);
    expect(JSON.parse(await readFile(join(root, '.tmp', 'services', 'config.json'), 'utf8'))).toEqual(a);
    await expect(stat(join(root, '.tmp', 'services', 'config-lock'))).rejects.toThrow(/ENOENT/);
  });

  test('a copied or corrupt config is refused and kept', async () => {
    await writeConfig({ ...config(), project: projectName(PREFIX, '/elsewhere') });
    await expect(serviceConfig(root, file)).rejects.toThrow(/Invalid or copied service configuration at .*config\.json/);
    await writeFile(join(root, '.tmp', 'services', 'config.json'), '{');
    await expect(serviceConfig(root, file)).rejects.toThrow(SyntaxError);
  });

  test('a config that cannot be read for another reason than absence is an error', async () => {
    await mkdir(join(root, '.tmp', 'services', 'config.json'), { recursive: true });
    await expect(serviceConfig(root, file)).rejects.toThrow(/EISDIR/);
  });

  test('a config that cannot be created is an error', async () => {
    await mkdir(join(root, '.tmp'), { recursive: true });
    await writeFile(join(root, '.tmp', 'services'), '');
    await expect(serviceConfig(root, file, async () => 21000)).rejects.toThrow(/EEXIST|ENOTDIR/);
  });

  test('child commands get the file’s environment, filled with the published endpoints', () => {
    expect(environmentFor(file, { ...config(23456), password: 'p@ss' }, { postgres: 41001, redis: 41002 })).toEqual({
      DATABASE_URL: 'postgresql://acme_user:p%40ss@127.0.0.1:41001/acme_dev?schema=public',
      REDIS_URL: 'redis://:p%40ss@127.0.0.1:41002',
      PORT: '23456',
      API_URL: 'http://localhost:23456',
      ALLOWED_ORIGINS: `http://localhost:${file.webPort},http://127.0.0.1:${file.webPort}`,
    });
  });
});

describe('prepared environment', () => {
  const prepared = (context: unknown): Record<string, string | undefined> => ({
    ...environmentFor(file, config(), { postgres: 41001, redis: 41002 }),
    [PREPARED_CONTEXT]: JSON.stringify(context),
  });

  test('a live parent for this root passes its environment down', () => {
    expect(preparedEnvironment(root, file, prepared({ root, owner: 42 }), pid => pid === 42)).toEqual(environmentFor(file, config(), { postgres: 41001, redis: 41002 }));
  });

  test('another root, a dead or invalid owner, a missing value or no context is not trusted', () => {
    const alive = (): boolean => true;
    expect(preparedEnvironment(root, file, prepared({ root: '/other', owner: 42 }), alive)).toBeUndefined();
    expect(preparedEnvironment(root, file, prepared({ root, owner: 42 }), () => false)).toBeUndefined();
    for (const owner of [0, -1, '42']) expect(preparedEnvironment(root, file, prepared({ root, owner }), alive)).toBeUndefined();
    expect(preparedEnvironment(root, file, { ...prepared({ root, owner: 42 }), REDIS_URL: '' }, alive)).toBeUndefined();
    expect(preparedEnvironment(root, file, { ...prepared({ root, owner: 42 }), REDIS_URL: undefined }, alive)).toBeUndefined();
    expect(preparedEnvironment(root, file, {}, alive)).toBeUndefined();
    expect(preparedEnvironment(root, file, { [PREPARED_CONTEXT]: '{' }, alive)).toBeUndefined();
  });

  test('this process counts as a live owner, an unused pid does not', () => {
    expect(preparedEnvironment(root, file, prepared({ root, owner: process.pid }))).toBeDefined();
    if (process.getuid?.() !== 0) expect(preparedEnvironment(root, file, prepared({ root, owner: 1 }))).toBeDefined();
    expect(preparedEnvironment(root, file, prepared({ root, owner: 2 ** 22 + 7 }))).toBeUndefined();
  });
});

describe('setup lock', { timeout: BOUND_MS }, () => {
  /** A pause that fails past ten waits, so a waiter that never counts down stops. */
  const boundedPause = () => {
    const pause = vi.fn(async () => {
      if (pause.mock.calls.length > 10) throw new Error('waited past the limit');
    });
    return pause;
  };

  test('one setup runs at a time; the next waits, then runs', async () => {
    const lock = join(root, 'lock');
    const order: string[] = [];
    let release = (): void => undefined;
    const first = withLock(lock, async () => {
      order.push('first');
      await new Promise<void>(done => (release = done));
    });
    const pause = vi.fn(async () => {
      release();
      await first;
    });
    try {
      await vi.waitFor(() => expect(order).toEqual(['first']));
      await withLock(lock, async () => order.push('second'), { pause, attempts: 1 });
    } finally {
      release();
      await first;
    }
    expect(order).toEqual(['first', 'second']);
    expect(pause).toHaveBeenCalledTimes(1);
    await expect(stat(lock)).rejects.toThrow(/ENOENT/);
  });

  test('waiters poll for a whole startup plus a minute, by default', async () => {
    expect(LOCK_ATTEMPTS * LOCK_PAUSE_MS).toBe((STARTUP_SECONDS + 60) * 1000);
    const lock = join(root, 'lock');
    let release = (): void => undefined;
    const first = withLock(lock, () => new Promise<void>(done => (release = done)));
    await vi.waitFor(() => stat(join(lock, 'owner')));
    // The default pause: one real wait, then the holder lets go.
    const second = withLock(lock, async () => 'ran');
    release();
    await first;
    expect(await second).toBe('ran');
  });

  test('a lock whose holder died is taken over', async () => {
    const lock = join(root, 'lock');
    await mkdir(lock);
    await writeFile(join(lock, 'owner'), '999999');
    const alive = vi.fn(() => false);
    expect(await withLock(lock, async () => 'ran', { alive, attempts: 1 })).toBe('ran');
    expect(alive).toHaveBeenCalledWith(999999);
  });

  test('a lock whose holder is no process at all is taken over by default', async () => {
    const lock = join(root, 'lock');
    await mkdir(lock);
    await writeFile(join(lock, 'owner'), String(2 ** 22 + 7));
    expect(await withLock(lock, async () => 'ran', { attempts: 1 })).toBe('ran');
  });

  test('a dead holder’s lock a peer took over first is still acquired', async () => {
    const lock = join(root, 'lock');
    await mkdir(lock);
    await writeFile(join(lock, 'owner'), '999999');
    const alive = vi.fn(() => {
      unlinkSync(join(lock, 'owner'));
      rmdirSync(lock);
      return false;
    });
    expect(await withLock(lock, async () => 'ran', { alive, attempts: 1 })).toBe('ran');
  });

  test('a waiter that read a dead holder keeps the lock another waiter re-acquired since', async () => {
    const lock = join(root, 'lock');
    await mkdir(lock);
    await writeFile(join(lock, 'owner'), '999999');
    // Between this waiter's read and its takeover, a peer took the lock over.
    const alive = vi.fn((pid: number) => {
      if (pid === 999999) writeFileSync(join(lock, 'owner'), '4242');
      return pid === 4242;
    });
    const pause = boundedPause();
    await expect(withLock(lock, async () => 'ran', { alive, pause, attempts: 1 })).rejects.toThrow(`locked at ${lock} by process 4242;`);
    // The takeover spent the one attempt: there was nothing left to wait.
    expect(pause).not.toHaveBeenCalled();
    expect(await readFile(join(lock, 'owner'), 'utf8')).toBe('4242');
    await expect(stat(`${lock}.takeover`)).rejects.toThrow(/ENOENT/);
  });

  test('a dead holder’s lock another waiter is taking over is waited on', async () => {
    const lock = join(root, 'lock');
    await mkdir(lock);
    await writeFile(join(lock, 'owner'), '999999');
    await mkdir(`${lock}.takeover`);
    const pause = boundedPause();
    await expect(withLock(lock, async () => 'ran', { alive: () => false, pause, attempts: 1 })).rejects.toThrow(`locked at ${lock} by process 999999;`);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(await readFile(join(lock, 'owner'), 'utf8')).toBe('999999');
    await rmdir(`${lock}.takeover`);
  });

  test('a takeover that cannot be started is an error, not a wait', async () => {
    // A 250-byte name fits; with `.takeover` it passes the 255-byte limit.
    const lock = join(root, 'l'.repeat(250));
    await mkdir(lock);
    await writeFile(join(lock, 'owner'), '999999');
    await expect(withLock(lock, async () => 'ran', { alive: () => false, attempts: 1 })).rejects.toThrow(/ENAMETOOLONG/);
  });

  test('an owner that is not a pid is never taken over', async () => {
    const lock = join(root, 'lock');
    await mkdir(lock);
    for (const [index, content] of ['0', 'garbage'].entries()) {
      const each = `${lock}-${index}`;
      await mkdir(each);
      await writeFile(join(each, 'owner'), content);
      await expect(withLock(each, async () => 'ran', { alive: () => false, pause: boundedPause(), attempts: 1 })).rejects.toThrow(`by process ${content};`);
    }
  });

  test('a lock the body lost to a peer is released without error', async () => {
    const lock = join(root, 'lock');
    expect(
      await withLock(lock, async () => {
        await unlink(join(lock, 'owner'));
        await rmdir(lock);
        return 'ran';
      }),
    ).toBe('ran');
  });

  test('a live holder that never lets go is named, and the lock is left to it', async () => {
    const lock = join(root, 'lock');
    await mkdir(lock);
    await writeFile(join(lock, 'owner'), '4242');
    const pause = boundedPause();
    await expect(withLock(lock, async () => 'ran', { alive: () => true, pause, attempts: 3 })).rejects.toThrow(`Service setup is locked at ${lock} by process 4242`);
    expect(pause).toHaveBeenCalledTimes(3);
    expect(await readFile(join(lock, 'owner'), 'utf8')).toBe('4242');
  });

  test('a lock without an owner yet is waited on, and released after a failed body', async () => {
    const lock = join(root, 'lock');
    await mkdir(lock);
    await expect(withLock(lock, async () => 'ran', { pause: boundedPause(), attempts: 0 })).rejects.toThrow(`locked at ${lock} by process unknown;`);
    rmSync(lock, { recursive: true, force: true });
    await expect(
      withLock(lock, async () => {
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');
    await expect(stat(lock)).rejects.toThrow(/ENOENT/);
  });

  test('a lock that cannot be created is not waited on', async () => {
    await expect(withLock(join(root, 'missing', 'lock'), async () => 'ran')).rejects.toThrow(/ENOENT/);
  });
});

describe('compose', { timeout: BOUND_MS }, () => {
  test('runs against this root’s Compose file with the project variables, stdin closed', async () => {
    // An inherited project name would outrank the file's `name:`.
    env.COMPOSE_PROJECT_NAME = 'someone-elses-project';
    expect(await composeFor(root, file, PASSWORD, io)(['ps'])).toBe('NAME STATUS');
    expect(await calls()).toEqual([
      expect.objectContaining({
        bin: 'docker',
        args: ['compose', '-f', join(root, 'compose.yaml'), 'ps'],
        cwd: root,
        project: projectName(PREFIX, root),
        composeProject: projectName(PREFIX, root),
        password: PASSWORD,
        root,
      }),
    ]);
    expect(composeVariables(root, PREFIX, PASSWORD)).toEqual({
      COMPOSE_PROJECT_NAME: projectName(PREFIX, root),
      SARATHI_SERVICES_PROJECT: projectName(PREFIX, root),
      SARATHI_SERVICES_PASSWORD: PASSWORD,
      SARATHI_WORKTREE_ROOT: root,
    });
  });

  test('a failure ends with what Docker printed last, and its progress reaches stderr', async () => {
    env.STUB_FAIL_UP = '1';
    await expect(composeFor(root, file, PASSWORD, io)(['up'])).rejects.toThrow(
      `Command failed: docker compose -f ${join(root, 'compose.yaml')} up (exit 3): first line / application not healthy after 4m0s`,
    );
    expect(errors).toContain('pulling\n');
  });

  test('a missing docker CLI rejects', async () => {
    env.PATH = join(root, 'nowhere');
    await expect(composeFor(root, file, PASSWORD, io)(['ps'])).rejects.toThrow(/ENOENT/);
  });
});

describe('services', { timeout: BOUND_MS }, () => {
  test('up starts the project, reads its ports and records the environment', async () => {
    expect(await run('up')).toBe(0);
    // The default sweep ran first, against the same docker, and found nothing.
    const docker = (await calls()).filter(call => call.args[0] === 'compose');
    expect(docker.map(call => call.locked)).toEqual([true, false, false]);
    expect(docker.map(call => call.args.slice(3))).toEqual([
      ['up', '-d', '--wait', '--wait-timeout', String(STARTUP_SECONDS)],
      ['port', 'postgres', '5432'],
      ['port', 'redis', '6379'],
    ]);
    // Its three listings run side by side, so in any order.
    expect(
      (await calls())
        .filter(call => call.args[0] !== 'compose')
        .map(call => call.args.slice(0, 2).join(' '))
        .sort(),
    ).toEqual(['network ls', 'ps --all', 'volume ls']);
    const stored = JSON.parse(await readFile(join(root, '.tmp', 'services', 'config.json'), 'utf8')) as ServiceConfig;
    const environment = environmentFor(file, stored, { postgres: 41001, redis: 41002 });
    expect(JSON.parse(await readFile(join(root, '.tmp', 'services', 'environment.json'), 'utf8'))).toEqual(environment);
    expect(output).toContain(`${projectName(PREFIX, root)}: server http://localhost:${stored.serverPort}, web http://localhost:${file.webPort}\n`);
    await expect(stat(join(root, '.tmp', 'services', 'lock'))).rejects.toThrow(/ENOENT/);
  });

  test('without a web command, up names only the server', async () => {
    const raw = sampleRaw(file.webPort);
    delete raw.web;
    file = parseServicesFile(raw, 'services.json');
    io = { ...io, sweep: async () => NO_SWEEP };
    await run('up');
    const stored = JSON.parse(await readFile(join(root, '.tmp', 'services', 'config.json'), 'utf8')) as ServiceConfig;
    expect(output).toBe(`${projectName(PREFIX, root)}: server http://localhost:${stored.serverPort}\n`);
  });

  test('up reports reaped worktrees and never fails on the sweep', async () => {
    const scripted: Array<() => Promise<SweepResult>> = [
      async () => ({
        reaped: ['acme-wt-0000000000000001', 'acme-wt-0000000000000002'],
        skipped: [{ project: 'acme-wt-0000000000000003', reason: 'root unknown' }],
        failed: [{ project: 'acme-wt-0000000000000004', error: 'volume in use' }],
        warnings: ['Could not list volumes by worktree root'],
      }),
      async () => {
        throw new Error('no docker');
      },
      async () => {
        throw 'daemon gone';
      },
    ];
    io = { ...io, sweep: () => (scripted.shift() ?? (async () => NO_SWEEP))() };
    await run('up');
    expect(output).toContain('Removed services of deleted worktrees: acme-wt-0000000000000001, acme-wt-0000000000000002\n');
    expect(errors).toContain(
      'Deleted-worktree sweep: Could not list volumes by worktree root\n' +
        'Deleted-worktree sweep: kept acme-wt-0000000000000003: root unknown\n' +
        'Deleted-worktree sweep: could not remove acme-wt-0000000000000004: volume in use\n',
    );
    await run('up');
    expect(errors).toContain('Deleted-worktree sweep did not run: no docker\n');
    await run('up');
    expect(errors).toContain('Deleted-worktree sweep did not run: daemon gone\n');
  });

  test('an endpoint that is not on loopback is refused', async () => {
    env.STUB_PG = '0.0.0.0:41001';
    await expect(run('up')).rejects.toThrow('Unexpected published endpoint for postgres: 0.0.0.0:41001');
  });

  test('a failed start keeps the config and releases the lock', async () => {
    env.STUB_FAIL_UP = '1';
    await expect(run('up')).rejects.toThrow('exit 3');
    expect(validConfig(JSON.parse(await readFile(join(root, '.tmp', 'services', 'config.json'), 'utf8')), root, PREFIX)).toBe(true);
    await expect(stat(join(root, '.tmp', 'services', 'lock'))).rejects.toThrow(/ENOENT/);
  });

  test('down and status without a config touch nothing', async () => {
    expect(await run('down')).toBe(0);
    expect(await run('status')).toBe(0);
    expect(await calls()).toEqual([]);
    expect(output).toBe('No services configured for this worktree\nNo services configured for this worktree\n');
  });

  test('status lists the containers; down stops them and forgets the endpoints', async () => {
    await writeConfig(config());
    await writeFile(join(root, '.tmp', 'services', 'environment.json'), '{}');
    await run('status');
    expect(output).toBe('NAME STATUS\n');
    await run('down');
    expect((await calls()).map(call => call.args.slice(3))).toEqual([['ps'], ['down']]);
    // A down during a start's `up --wait` waits for it.
    expect((await calls()).map(call => call.locked)).toEqual([false, true]);
    await expect(stat(join(root, '.tmp', 'services', 'lock'))).rejects.toThrow(/ENOENT/);
    await expect(stat(join(root, '.tmp', 'services', 'environment.json'))).rejects.toThrow(/ENOENT/);
    await run('down');
  });

  test('server runs its steps, then the server command with the extra flags', async () => {
    await writeConfig(config(await freePort()));
    expect(await run('server', ['--debug'])).toBe(0);
    const pnpm = (await calls()).filter(call => call.bin === 'pnpm');
    expect(pnpm.map(call => call.args)).toEqual([
      ['init', 'database', `${projectName(PREFIX, root)}-postgres-1`],
      ['migrate', 'deploy'],
      ['serve', 'start', '--watch', '--debug'],
    ]);
    expect(pnpm.map(call => call.out)).toEqual([fstatSync(1).ino, fstatSync(1).ino, fstatSync(1).ino]);
    expect(pnpm[2]).toMatchObject({
      database: `postgresql://acme_user:${PASSWORD}@127.0.0.1:41001/acme_dev?schema=public`,
      context: JSON.stringify({ root, owner: process.pid }),
    });
  });

  test('a server port persisted on the web port is refused for launches, not for actions', async () => {
    await writeConfig({ ...config(file.webPort), webPort: 32102 });
    for (const action of ['server', 'web', 'run', 'up']) {
      await expect(run(action, ['pnpm'])).rejects.toThrow(`Persisted server port ${file.webPort} conflicts with the web port`);
    }
    expect(await run('database-init')).toBe(0);
    // Actions leave the stored endpoints as they were.
    expect(JSON.parse(await readFile(join(root, '.tmp', 'services', 'config.json'), 'utf8'))).toEqual({ ...config(file.webPort), webPort: 32102 });
  });

  test('a failed step keeps the server from starting', async () => {
    await writeConfig(config(await freePort()));
    env.STUB_FAIL = 'migrate';
    await expect(run('server')).rejects.toThrow("pnpm migrate deploy (exit 4) failed, so the server was not started. Fix the error above and retry; the services' data is kept.");
    expect((await calls()).some(call => call.args.includes('serve'))).toBe(false);
  });

  test('an occupied server port is refused before anything starts', async () => {
    const server = await listen();
    const port = portOf(server);
    try {
      await writeConfig(config(port));
      await expect(run('server')).rejects.toThrow(`Server port ${port} is already in use`);
      expect((await calls()).some(call => call.bin === 'pnpm')).toBe(false);
    } finally {
      await close(server);
    }
  });

  test('web starts on the web port with only the variables it names, and no containers', async () => {
    await writeConfig(config());
    env.DATABASE_URL = undefined;
    expect(await run('web', ['--open'])).toBe(0);
    const launched = await calls();
    expect(launched[0]?.database).toBeUndefined();
    expect(launched).toEqual([
      expect.objectContaining({ bin: 'pnpm', args: ['web', 'vite', '--port', String(file.webPort), '--strictPort', '--open'], api: 'http://localhost:23456' }),
    ]);
  });

  test('web refuses when another web server holds the web port', async () => {
    await writeConfig(config());
    const server = await listen(file.webPort);
    try {
      await expect(run('web')).rejects.toThrow(`Web port ${file.webPort} is already in use`);
    } finally {
      await close(server);
    }
  });

  test('web and server need their commands in the file', async () => {
    const raw = sampleRaw(file.webPort);
    delete raw.web;
    delete raw.server;
    file = parseServicesFile(raw, 'services.json');
    await writeConfig(config());
    await expect(run('web')).rejects.toThrow('services.json has no "web" command');
    await expect(run('server')).rejects.toThrow('services.json has no "server" command');
    expect(await calls()).toEqual([]);
  });

  test('run passes the environment down; a nested call reuses it without Docker', async () => {
    await writeConfig(config());
    await run('run', ['pnpm', 'exec', 'outer']);
    const outer = (await calls()).at(-1);
    expect(outer).toMatchObject({ args: ['exec', 'outer'] });
    env[PREPARED_CONTEXT] = String(outer?.context);
    Object.assign(env, environmentFor(file, config(), { postgres: 41001, redis: 41002 }));
    const before = (await calls()).length;
    await run('run', ['pnpm', 'exec', 'inner']);
    expect((await calls()).slice(before)).toEqual([expect.objectContaining({ bin: 'pnpm', args: ['exec', 'inner'] })]);
  });

  test('a launched command’s exit status becomes the result', async () => {
    await writeConfig(config());
    env.STUB_EXIT = '7';
    expect(await run('run', ['pnpm'])).toBe(7);
  });

  for (const [signal, code] of [
    ['SIGINT', 9],
    ['SIGTERM', 8],
  ] as const) {
    test(`a ${signal} reaches the launched command while it runs`, async () => {
      await writeConfig(config());
      const ready = join(root, 'ready');
      const before = process.listeners(signal);
      const started = run('run', [
        process.execPath,
        '-e',
        `process.on('${signal}', () => process.exit(${code})); require('node:fs').writeFileSync(process.argv[1], ''); setTimeout(() => process.exit(3), 20000)`,
        ready,
      ]);
      // The child has its handler once it writes the marker.
      await vi.waitFor(() => stat(ready), { timeout: 20_000 });
      // Only the runner's handler: the test runner's own must not see it.
      const added = process.listeners(signal).filter(listener => !before.includes(listener));
      expect(added).toHaveLength(1);
      for (const listener of added) listener(signal);
      expect(await started).toBe(code);
      expect(process.listeners(signal)).toEqual(before);
    });
  }

  test('a command killed by a signal it does not handle ends with 1', async () => {
    await writeConfig(config());
    expect(await run('run', [process.execPath, '-e', "process.kill(process.pid, 'SIGKILL')"])).toBe(1);
  });

  test('run needs a command', async () => {
    await writeConfig(config());
    await expect(run('run')).rejects.toThrow('A command is required after --');
  });

  test('an action runs its steps in order, the extra arguments on the last', async () => {
    await writeConfig(config());
    expect(await run('database-init', ['--verbose'])).toBe(0);
    expect((await calls()).filter(call => call.bin === 'pnpm').map(call => call.args)).toEqual([
      ['init', 'database', `${projectName(PREFIX, root)}-postgres-1`, '--force'],
      ['migrate', 'deploy', '--verbose'],
    ]);
  });

  test('a failed action step stops the steps after it', async () => {
    await writeConfig(config());
    env.STUB_FAIL = 'init';
    await expect(run('database-init')).rejects.toThrow(
      `database-init failed at pnpm init database ${projectName(PREFIX, root)}-postgres-1 --force (exit 4); the steps after it did not run.`,
    );
    expect((await calls()).filter(call => call.bin === 'pnpm')).toHaveLength(1);
  });

  test('a main-checkout-only action is refused in a linked worktree', async () => {
    git('init', '-q', root);
    const linked = join(root, 'linked');
    git('-C', root, 'commit', '-q', '--allow-empty', '-m', 'x');
    git('-C', root, 'worktree', 'add', '-q', linked);
    await expect(services(linked, 'database-snapshot', [], project(), io)).rejects.toThrow('database-snapshot runs only in the main checkout');
  });

  test('a main-checkout-only action runs in the main checkout, even with a server on the web port', async () => {
    git('init', '-q', root);
    await writeConfig({ ...config(file.webPort), webPort: 32102 });
    expect(await run('database-snapshot', ['--legacy'])).toBe(0);
    expect((await calls()).find(call => call.bin === 'pnpm')?.args).toEqual(['snapshot', 'database', `${projectName(PREFIX, root)}-postgres-1`, '--legacy']);
    expect(JSON.parse(await readFile(join(root, '.tmp', 'services', 'config.json'), 'utf8'))).toEqual({ ...config(file.webPort), webPort: 32102 });
  });
});

function git(...args: string[]): void {
  execFileSync('git', args, { env: { ...env }, timeout: 30_000, stdio: 'ignore' });
}
