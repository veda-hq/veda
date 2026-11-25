import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { expect } from '../test/expect.test.ts';
import { FIXTURE_OWNER_FILE, fixturePrefix } from './fixture-root.ts';
import {
  dockerCli,
  nodeSweepHost,
  projectName,
  reapOrphanedServices,
  reapProject,
  serviceProjects,
  serviceRootState,
  sweep,
  worktreeState,
  type Docker,
  type ReapSettings,
  type SweepHost,
  type WorktreeState,
} from './reaper.ts';
import { LABEL, PREFIX } from './sample.test.ts';

const SETTINGS: ReapSettings = { project: PREFIX, rootLabel: LABEL, name: 'acme' };
const LIVE = '/worktrees/live';
const GONE = '/worktrees/archived';
const name = (root: string): string => projectName(PREFIX, root);

/**
 * An in-memory Docker CLI: containers, volumes and networks keyed by project.
 * `labels` gives the root label a project's volumes and networks carry.
 */
function fakeDocker(
  containers: Array<{ id: string; project: string; workingDir: string }>,
  options: { volumes?: Record<string, string[]>; networks?: Record<string, string[]>; labels?: Record<string, string>; failRemoving?: string } = {},
) {
  const calls: string[][] = [];
  const volumes: Record<string, string[]> = { ...options.volumes };
  const networks: Record<string, string[]> = { ...options.networks };
  for (const container of containers) networks[container.project] = [`${container.project}_default`];
  let state = [...containers];
  const projectOf = (args: string[]): string => args[args.indexOf('--filter') + 1]?.split('=').at(-1) ?? '';
  const docker: Docker = async args => {
    calls.push(args);
    if (args[0] === 'ps' && args.includes('--format')) return state.map(c => `${c.project}\t${c.workingDir}`).join('\n');
    if (args[1] === 'ls' && args.includes('--format')) {
      return Object.entries(args[0] === 'volume' ? volumes : networks)
        .flatMap(([project, names]) => {
          const root = options.labels?.[project];
          return root === undefined ? [] : names.map(() => `${project}\t${root}`);
        })
        .join('\n');
    }
    if (args[0] === 'ps') {
      return state
        .filter(c => c.project === projectOf(args))
        .map(c => c.id)
        .join('\n');
    }
    if (args[0] === 'rm') {
      const ids = args.slice(3);
      if (options.failRemoving !== undefined && state.some(c => ids.includes(c.id) && c.project === options.failRemoving)) throw new Error('daemon refused');
      state = state.filter(c => !ids.includes(c.id));
      return '';
    }
    if (args[0] === 'volume' && args[1] === 'ls') return (volumes[projectOf(args)] ?? []).join('\n');
    if (args[0] === 'volume' && args[1] === 'rm') {
      for (const project of Object.keys(volumes)) volumes[project] = (volumes[project] ?? []).filter(v => !args.includes(v));
      return '';
    }
    if (args[0] === 'network' && args[1] === 'ls') return (networks[projectOf(args)] ?? []).join('\n');
    if (args[0] === 'network' && args[1] === 'rm') {
      for (const project of Object.keys(networks)) networks[project] = (networks[project] ?? []).filter(n => !args.includes(n));
      return '';
    }
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };
  return { docker, calls, remaining: () => ({ containers: state, volumes, networks }) };
}

const inspect = (path: string): WorktreeState => (path === LIVE ? 'present' : 'gone');
const service = (id: string, root: string, project = name(root)) => ({ id, project, workingDir: `${root}/.tmp/services` });
const containerIds = (fake: ReturnType<typeof fakeDocker>): string[] =>
  fake
    .remaining()
    .containers.map(c => c.id)
    .sort();

describe('projectName', () => {
  test('each worktree root gets its own project, stably, as <prefix>-<16 hex of its SHA-256>', () => {
    expect(name('/a/acme')).not.toBe(name('/b/acme'));
    expect(name('/a/acme')).toBe(name('/a/acme'));
    expect(name('/a/acme')).toMatch(/^acme-wt-[0-9a-f]{16}$/);
    // The scheme every existing worktree's project was named by.
    expect(projectName('x-wt', '/w')).toBe(`x-wt-${createHash('sha256').update('/w').digest('hex').slice(0, 16)}`);
    expect(projectName('x-wt', '/w')).toBe('x-wt-d1bb8ca354673cd5');
  });
});

describe('worktreeState', () => {
  test('distinguishes a present path, a missing one, and one under a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'sarathi-reaper-state-'));
    try {
      const file = join(root, 'file');
      writeFileSync(file, '');
      expect(worktreeState(root)).toBe('present');
      expect(worktreeState(join(root, 'missing'))).toBe('gone');
      // ENOTDIR: a path component is a file, so the worktree cannot exist.
      expect(worktreeState(join(file, 'child'))).toBe('gone');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports a path it cannot inspect as unknown, never gone', () => {
    // Neither error says the path is absent: ENAMETOOLONG, and the argument
    // error a NUL byte raises before any system call.
    expect(worktreeState(join(tmpdir(), 'x'.repeat(300)))).toBe('unknown');
    expect(worktreeState('\0')).toBe('unknown');
  });
});

describe('fixture roots', () => {
  const fixture = (owner: unknown): string => {
    const root = mkdtempSync(join(tmpdir(), fixturePrefix('acme')));
    writeFileSync(join(root, FIXTURE_OWNER_FILE), JSON.stringify(owner));
    return root;
  };

  test('serviceRootState reports an abandoned fixture as gone and a live one as present', () => {
    const live = fixture({ pid: process.pid, createdAt: Date.now() });
    const dead = fixture({ pid: process.pid, createdAt: 0 });
    try {
      expect(serviceRootState(live, 'acme')).toBe('present');
      expect(serviceRootState(dead, 'acme')).toBe('gone');
      // Another project's name: not its fixture, so present means present.
      expect(serviceRootState(dead, 'other')).toBe('present');
      expect(serviceRootState(join(tmpdir(), 'acme-missing-root'), 'acme')).toBe('gone');
    } finally {
      for (const root of [live, dead]) rmSync(root, { recursive: true, force: true });
    }
  });

  test('the default sweep reaps an abandoned fixture and keeps a live one', async () => {
    const dead = fixture({ pid: process.pid, createdAt: 0 });
    const live = fixture({ pid: process.pid, createdAt: Date.now() });
    try {
      const fake = fakeDocker([service('d1', dead), service('l1', live)]);
      const result = await reapOrphanedServices(fake.docker, SETTINGS);
      expect(result.reaped).toEqual([name(dead)]);
      expect(containerIds(fake)).toEqual(['l1']);
    } finally {
      for (const root of [dead, live]) rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('serviceProjects', () => {
  test('lists containers by working directory and volumes and networks by root label', async () => {
    const fake = fakeDocker([]);
    expect(await serviceProjects(fake.docker, SETTINGS)).toEqual([]);
    const projectAnd = (label: string): string => `{{.Label "com.docker.compose.project"}}\t{{.Label "${label}"}}`;
    expect(fake.calls).toEqual([
      ['ps', '--all', '--filter', 'label=com.docker.compose.project', '--format', projectAnd('com.docker.compose.project.working_dir')],
      ...['volume', 'network'].map(kind => [kind, 'ls', '--filter', `label=${LABEL}`, '--format', projectAnd(LABEL)]),
    ]);
  });

  test('rejects when the container listing fails', async () => {
    const failing: Docker = async args => {
      if (args[0] === 'ps') throw new Error('Cannot connect to the Docker daemon');
      return '';
    };
    await expect(serviceProjects(failing, SETTINGS)).rejects.toThrow('Cannot connect to the Docker daemon');
  });

  test('lists each worktree project once, with the root its label names', async () => {
    const { docker } = fakeDocker([service('b2', GONE), service('a1', LIVE), service('a2', LIVE), service('b1', GONE)]);
    expect(await serviceProjects(docker, SETTINGS)).toEqual(
      [
        { project: name(LIVE), root: LIVE },
        { project: name(GONE), root: GONE },
      ].sort((a, b) => a.project.localeCompare(b.project)),
    );
  });

  test('ignores projects this tooling did not create for that directory', async () => {
    const { docker } = fakeDocker([
      // A shared stack started from a since-deleted worktree.
      { id: 'l1', project: 'server', workingDir: `${GONE}/apps/server` },
      // Worktree-style name whose hash does not match the recorded directory.
      service('f1', GONE, name('/somewhere/else')),
      // Right name, but neither the root nor its services directory.
      { id: 'f2', project: name(GONE), workingDir: `${GONE}/elsewhere` },
      // Another project prefix's worktree.
      service('o1', GONE, projectName('other-wt', GONE)),
    ]);
    expect(await serviceProjects(docker, SETTINGS)).toEqual([]);
  });

  test('finds a project started from the root Compose file, whose working directory is the root', async () => {
    const { docker } = fakeDocker([
      { id: 'c1', project: name(GONE), workingDir: GONE },
      // A stack beside it, from a generated .tmp/services/compose.json.
      service('c2', LIVE),
    ]);
    expect(await serviceProjects(docker, SETTINGS)).toEqual(
      [
        { project: name(LIVE), root: LIVE },
        { project: name(GONE), root: GONE },
      ].sort((a, b) => a.project.localeCompare(b.project)),
    );
  });

  test('a root that itself ends in /.tmp/services is that root, not its grandparent', async () => {
    const nested = '/worktrees/live/.tmp/services';
    const { docker } = fakeDocker([{ id: 'c1', project: name(nested), workingDir: nested }]);
    expect(await serviceProjects(docker, SETTINGS)).toEqual([{ project: name(nested), root: nested }]);
  });

  test('finds a project whose containers are gone through the root label on its volume or network', async () => {
    const stopped = '/worktrees/stopped';
    const copied = name('/worktrees/copied');
    const { docker } = fakeDocker([service('a1', LIVE)], {
      volumes: { [name(LIVE)]: ['live_data'], [name(GONE)]: ['archived_data'], [copied]: ['copied_data'] },
      networks: { [name(stopped)]: ['stopped_default'] },
      labels: {
        [name(LIVE)]: LIVE,
        [name(GONE)]: GONE,
        [name(stopped)]: stopped,
        // A label whose root does not hash to the project proves nothing.
        [copied]: '/somewhere/else',
      },
    });
    expect(await serviceProjects(docker, SETTINGS)).toEqual(
      [LIVE, GONE, stopped].map(root => ({ project: name(root), root })).sort((a, b) => a.project.localeCompare(b.project)),
    );
  });

  test('an empty working directory or label is never a root, even under its own hash', async () => {
    const empty = projectName('acme-wt', '');
    const { docker } = fakeDocker([
      // Strips to the empty candidate.
      { id: 'e1', project: empty, workingDir: '/.tmp/services' },
      { id: 'e2', project: empty, workingDir: '' },
    ]);
    expect(await serviceProjects(docker, { project: 'acme-wt', rootLabel: 'acme.worktree-services.root' })).toEqual([]);
  });

  test('still lists container projects when a label listing fails', async () => {
    const fake = fakeDocker([service('b1', GONE)], { volumes: { [name(LIVE)]: ['live_data'] }, labels: { [name(LIVE)]: LIVE } });
    const flaky: Docker = async args => {
      if (args[0] !== 'ps' && args.includes('--format')) throw new Error('Cannot connect to the Docker daemon');
      return fake.docker(args);
    };
    const warnings: string[] = [];
    expect(await serviceProjects(flaky, SETTINGS, message => warnings.push(message))).toEqual([{ project: name(GONE), root: GONE }]);
    expect(warnings).toEqual(
      ['volume', 'network'].map(kind => `Could not list ${kind}s by worktree root, so projects without containers went unchecked: Cannot connect to the Docker daemon`),
    );
    // Without a listener, the narrowing is dropped silently.
    expect(await serviceProjects(flaky, SETTINGS)).toEqual([{ project: name(GONE), root: GONE }]);
  });
});

describe('reapProject', () => {
  test('removes containers with their anonymous volumes, then volumes and network', async () => {
    const project = name(GONE);
    const fake = fakeDocker([service('b1', GONE), service('b2', GONE)], { volumes: { [project]: [`${project}_postgres_data`] } });
    await reapProject(fake.docker, PREFIX, project);
    const filter = ['--filter', `label=com.docker.compose.project=${project}`];
    expect(fake.calls).toEqual([
      ['ps', '--all', '--quiet', ...filter],
      ['rm', '--force', '--volumes', 'b1', 'b2'],
      ['volume', 'ls', '--quiet', ...filter],
      ['volume', 'rm', '--force', `${project}_postgres_data`],
      ['network', 'ls', '--quiet', ...filter],
      ['network', 'rm', `${project}_default`],
    ]);
    expect(fake.remaining()).toEqual({ containers: [], volumes: { [project]: [] }, networks: { [project]: [] } });
  });

  test('removes a volume left without containers and skips empty removals', async () => {
    const project = name(GONE);
    const fake = fakeDocker([], { volumes: { [project]: [`${project}_postgres_data`] } });
    await reapProject(fake.docker, PREFIX, project);
    const filter = ['--filter', `label=com.docker.compose.project=${project}`];
    expect(fake.calls).toEqual([
      ['ps', '--all', '--quiet', ...filter],
      ['volume', 'ls', '--quiet', ...filter],
      ['volume', 'rm', '--force', `${project}_postgres_data`],
      ['network', 'ls', '--quiet', ...filter],
    ]);
  });

  test('skips the volume removal when the project has none', async () => {
    const project = projectName('acme-wt', '/worktrees/archived');
    const fake = fakeDocker([{ id: 'b1', project, workingDir: '/worktrees/archived/.tmp/services' }]);
    await reapProject(fake.docker, 'acme-wt', project);
    const filter = ['--filter', `label=com.docker.compose.project=${project}`];
    expect(fake.calls).toEqual([
      ['ps', '--all', '--quiet', ...filter],
      ['rm', '--force', '--volumes', 'b1'],
      ['volume', 'ls', '--quiet', ...filter],
      ['network', 'ls', '--quiet', ...filter],
      ['network', 'rm', `${project}_default`],
    ]);
  });

  test('a prefix with a regex metacharacter still names its own projects', async () => {
    const project = projectName('a.b', '/worktrees/archived');
    const fake = fakeDocker([]);
    await reapProject(fake.docker, 'a.b', project);
    expect(fake.calls).toEqual([
      ['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${project}`],
      ['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`],
      ['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`],
    ]);
  });

  test('refuses any project outside the worktree naming scheme', async () => {
    const fake = fakeDocker([]);
    for (const project of ['server', 'acme-wt-', 'acme-wt-XYZ', `${name(GONE)}x`, projectName('other-wt', GONE), projectName('acme.wt', GONE)]) {
      await expect(reapProject(fake.docker, PREFIX, project)).rejects.toThrow('Refusing');
    }
    // The prefix is matched literally: a dot in it is no wildcard.
    await expect(reapProject(fake.docker, 'a.b', projectName('axb', GONE))).rejects.toThrow('Refusing');
    expect(fake.calls).toEqual([]);
  });
});

describe('reapOrphanedServices', () => {
  test('reaps every orphan, reports failures, and leaves live projects running', async () => {
    const other = '/worktrees/also-archived';
    const fake = fakeDocker([service('a1', LIVE), service('b1', GONE), service('c1', other)], { failRemoving: name(other) });
    const result = await reapOrphanedServices(fake.docker, SETTINGS, inspect);
    expect(result.reaped).toEqual([name(GONE)]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([{ project: name(other), error: 'daemon refused' }]);
    expect(containerIds(fake)).toEqual(['a1', 'c1']);
  });

  test('a removal that rejects with something other than an Error is reported as text', async () => {
    const fake = fakeDocker([service('b1', GONE)]);
    const odd: Docker = async args => {
      if (args[0] === 'rm') throw 'socket closed';
      return fake.docker(args);
    };
    const result = await reapOrphanedServices(odd, SETTINGS, inspect);
    expect(result.failed).toEqual([{ project: name(GONE), error: 'socket closed' }]);
  });

  test('finishes a reap that stopped after the containers went, and keeps a stopped live worktree’s volume', async () => {
    const project = name(GONE);
    const live = name(LIVE);
    const fake = fakeDocker([service('b1', GONE)], {
      // The live worktree ran `down`: its volume has no container left.
      volumes: { [project]: ['archived_data'], [live]: ['live_data'] },
      labels: { [project]: GONE, [live]: LIVE },
    });
    // The reaping process exits, or `volume rm` times out, once `docker rm` is done.
    const stopping: Docker = async args => {
      if (args[0] === 'volume' && args[1] === 'rm') throw new Error('timed out');
      return fake.docker(args);
    };
    await expect(reapProject(stopping, PREFIX, project)).rejects.toThrow('timed out');
    expect(fake.remaining()).toEqual({
      containers: [],
      volumes: { [project]: ['archived_data'], [live]: ['live_data'] },
      networks: { [project]: [`${project}_default`] },
    });
    const result = await reapOrphanedServices(fake.docker, SETTINGS, inspect);
    expect(result).toEqual({ reaped: [project], skipped: [], failed: [], warnings: [] });
    expect(fake.remaining()).toEqual({ containers: [], volumes: { [project]: [], [live]: ['live_data'] }, networks: { [project]: [] } });
  });

  test('reports a narrowed discovery while still reaping what containers identify', async () => {
    const fake = fakeDocker([service('b1', GONE)]);
    const flaky: Docker = async args => {
      if (args[0] === 'network' && args.includes('--format')) throw new Error('network listing timed out');
      return fake.docker(args);
    };
    const result = await reapOrphanedServices(flaky, SETTINGS, inspect);
    expect(result.reaped).toEqual([name(GONE)]);
    expect(result.warnings).toEqual(['Could not list networks by worktree root, so projects without containers went unchecked: network listing timed out']);
  });

  test('keeps the services of a worktree it cannot inspect', async () => {
    const fake = fakeDocker([service('b1', GONE)]);
    const seen: string[] = [];
    const result = await reapOrphanedServices(fake.docker, SETTINGS, path => {
      seen.push(path);
      return 'unknown';
    });
    // Skipped on the listing's verdict: no second inspection is needed to keep it.
    expect(seen).toEqual([GONE]);
    expect(result).toEqual({ reaped: [], skipped: [{ project: name(GONE), reason: `cannot inspect ${GONE}` }], failed: [], warnings: [] });
    expect(containerIds(fake)).toEqual(['b1']);
  });

  test('re-inspects immediately before removal and keeps a worktree that came back', async () => {
    const fake = fakeDocker([service('b1', GONE)]);
    const answers: WorktreeState[] = ['gone', 'present'];
    const seen: string[] = [];
    const result = await reapOrphanedServices(fake.docker, SETTINGS, path => {
      seen.push(path);
      return answers.shift() ?? 'present';
    });
    expect(seen).toEqual([GONE, GONE]);
    expect(result.reaped).toEqual([]);
    expect(result.skipped).toEqual([{ project: name(GONE), reason: `${GONE} reappeared before removal` }]);
    expect(containerIds(fake)).toEqual(['b1']);
  });

  test('keeps a worktree that became uninspectable between listing and removal', async () => {
    const fake = fakeDocker([service('b1', GONE)]);
    const answers: WorktreeState[] = ['gone', 'unknown'];
    const result = await reapOrphanedServices(fake.docker, SETTINGS, () => answers.shift() ?? 'unknown');
    expect(result.skipped).toEqual([{ project: name(GONE), reason: `cannot inspect ${GONE}` }]);
    expect(containerIds(fake)).toEqual(['b1']);
  });
});

describe('sweep', () => {
  const COMMON = '/repo/.git';
  const ORBCTL = ['orbctl', ['status'], { timeout: 5000 }];
  const VERSION = ['version', '--format', '{{.Server.Version}}'];
  const GIT = ['git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: '/repo', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }];

  /**
   * A host whose `orbctl` and git answer as told, and whose engine answers
   * `docker version` (unless `version` says otherwise) and passes every other
   * command to `docker`.
   */
  function sweepHost(docker: Docker, options: { orbctl?: () => Promise<unknown>; version?: () => Promise<string>; gitCommonDir?: () => string } = {}) {
    const commands: unknown[][] = [];
    const engine: string[][] = [];
    const appended: string[][] = [];
    const output: string[] = [];
    const host: SweepHost = {
      docker: async args => {
        engine.push(args);
        if (args[0] !== 'version') return docker(args);
        return (options.version ?? (async () => '27.0.1'))();
      },
      execFile: async (file, args, execOptions) => {
        commands.push([file, args, execOptions]);
        return (options.orbctl ?? (async () => ({ stdout: 'Running\n' })))();
      },
      execFileSync: (file, args, execOptions) => {
        commands.push([file, args, execOptions]);
        return (options.gitCommonDir ?? (() => `${COMMON}\n`))();
      },
      appendFileSync: (path, data) => {
        appended.push([path, data]);
      },
      write: text => {
        output.push(text);
      },
    };
    return { host, commands, engine, appended, output };
  }
  const exitError = (code: unknown): Error => Object.assign(new Error('orbctl failed'), { code });
  const sweepLine = (output: string[], result: object): string => {
    expect(output).toHaveLength(1);
    const line = output[0] ?? '';
    expect(JSON.parse(line)).toEqual({ at: expect.any(String), event: 'sweep', ...result });
    return line;
  };

  test('leaves a stopped OrbStack asleep', async () => {
    const run = sweepHost(fakeDocker([service('b1', GONE)]).docker, {
      orbctl: async () => {
        throw exitError(1);
      },
    });
    expect(await sweep(run.host, SETTINGS, '/repo')).toBe(0);
    expect(run.commands).toEqual([ORBCTL]);
    expect(run.engine).toEqual([]);
    expect(run.output).toEqual(['Docker is not running; nothing to sweep\n']);
  });

  test('treats only a missing orbctl Error as "not OrbStack"', async () => {
    // A rejection that is not an Error proves nothing, whatever its code says.
    const run = sweepHost(fakeDocker([]).docker, { orbctl: () => Promise.reject(Object.freeze({ code: 'ENOENT' })) });
    expect(await sweep(run.host, SETTINGS, '/repo')).toBe(0);
    expect(run.engine).toEqual([]);
    expect(run.output).toEqual(['Docker is not running; nothing to sweep\n']);
  });

  test('without OrbStack, asks the engine and stops when it does not answer', async () => {
    const run = sweepHost(fakeDocker([]).docker, {
      orbctl: async () => {
        throw exitError('ENOENT');
      },
      version: async () => {
        throw new Error('Cannot connect to the Docker daemon');
      },
    });
    expect(await sweep(run.host, SETTINGS, '/repo')).toBe(0);
    expect(run.engine).toEqual([VERSION]);
    expect(run.output).toEqual(['Docker is not running; nothing to sweep\n']);
  });

  test('without OrbStack, sweeps a running engine and says when nothing was found', async () => {
    const fake = fakeDocker([]);
    const run = sweepHost(fake.docker, {
      orbctl: async () => {
        throw exitError('ENOENT');
      },
    });
    expect(await sweep(run.host, SETTINGS, '/repo')).toBe(0);
    expect(run.engine).toEqual([VERSION, ...fake.calls]);
    expect(fake.calls).toHaveLength(3);
    expect(run.commands).toEqual([ORBCTL]);
    expect(run.appended).toEqual([]);
    expect(run.output).toEqual(['No services of deleted worktrees found\n']);
  });

  test('records a sweep that reaped something on stdout and in the common git dir, under worktree.name', async () => {
    const fake = fakeDocker([service('b1', GONE)]);
    const run = sweepHost(fake.docker);
    expect(await sweep(run.host, SETTINGS, '/repo')).toBe(0);
    const line = sweepLine(run.output, { reaped: [name(GONE)], skipped: [], failed: [], warnings: [] });
    expect(line.endsWith('}\n')).toBe(true);
    expect(run.commands).toEqual([ORBCTL, GIT]);
    expect(run.appended).toEqual([[join(COMMON, 'acme-services-reaper.log'), line]]);
    expect(containerIds(fake)).toEqual([]);
  });

  test('exits 1 when a removal failed, after recording it', async () => {
    const fake = fakeDocker([service('b1', GONE)], { failRemoving: name(GONE) });
    const run = sweepHost(fake.docker);
    expect(await sweep(run.host, SETTINGS, '/repo')).toBe(1);
    sweepLine(run.output, { reaped: [], skipped: [], failed: [{ project: name(GONE), error: 'daemon refused' }], warnings: [] });
  });

  test('records a narrowed discovery, or a kept project, even when nothing was reaped', async () => {
    const fake = fakeDocker([]);
    const flaky: Docker = async args => {
      if (args[0] === 'volume' && args[1] === 'ls') throw new Error('volume listing timed out');
      return fake.docker(args);
    };
    const run = sweepHost(flaky);
    expect(await sweep(run.host, SETTINGS, '/repo')).toBe(0);
    sweepLine(run.output, {
      reaped: [],
      skipped: [],
      failed: [],
      warnings: ['Could not list volumes by worktree root, so projects without containers went unchecked: volume listing timed out'],
    });
    const uninspectable = '\0';
    const kept = sweepHost(fakeDocker([{ id: 'u1', project: name(uninspectable), workingDir: uninspectable }]).docker);
    expect(await sweep(kept.host, SETTINGS, '/repo')).toBe(0);
    sweepLine(kept.output, { reaped: [], skipped: [{ project: name(uninspectable), reason: `cannot inspect ${uninspectable}` }], failed: [], warnings: [] });
  });

  test('still prints the record when the common git dir cannot be found', async () => {
    const run = sweepHost(fakeDocker([service('b1', GONE)]).docker, {
      gitCommonDir: () => {
        throw new Error('not a git repository');
      },
    });
    expect(await sweep(run.host, SETTINGS, '/repo')).toBe(0);
    sweepLine(run.output, { reaped: [name(GONE)], skipped: [], failed: [], warnings: [] });
    expect(run.appended).toEqual([]);
  });
});

describe('the Docker CLI', () => {
  /** A `docker` stand-in first on PATH, for one test. */
  async function withFakeDockerBinary(script: string, run: (env: Record<string, string | undefined>) => Promise<void>): Promise<void> {
    const bin = mkdtempSync(join(tmpdir(), 'sarathi-reaper-bin-'));
    try {
      writeFileSync(join(bin, 'docker'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      writeFileSync(join(bin, 'orbctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      await run({ ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }

  test('keeps the event loop running while Docker answers, and trims its output', async () => {
    await withFakeDockerBinary('sleep 0.2; printf "  27.0.1 \\n"', async env => {
      // Not a tick count, which scheduling delay under load can starve: an
      // expired timer runs before the loop processes the child's exit, so a
      // non-blocking runner always lets this fire first. A blocking runner
      // returns before the loop turns at all, so it never has.
      let timerRan = false;
      const timer = setTimeout(() => {
        timerRan = true;
      }, 0);
      try {
        expect(await dockerCli(env)(['version'])).toBe('27.0.1');
        expect(timerRan).toBe(true);
      } finally {
        clearTimeout(timer);
      }
    });
  });

  test('rejects with Docker’s error output when the command fails', async () => {
    await withFakeDockerBinary('echo "Cannot connect to the Docker daemon" >&2; exit 1', async env => {
      await expect(dockerCli(env)(['ps'])).rejects.toThrow('Cannot connect to the Docker daemon');
    });
  });

  test('the node host runs orbctl, docker and git with the given environment', async () => {
    await withFakeDockerBinary('echo 27.0.1', async env => {
      const output: string[] = [];
      const host = nodeSweepHost(text => output.push(text), env);
      // The stand-in orbctl reports OrbStack stopped, so nothing reaches docker.
      expect(await sweep(host, SETTINGS, tmpdir())).toBe(0);
      expect(output).toEqual(['Docker is not running; nothing to sweep\n']);
      expect(host.execFileSync('git', ['--version'], { encoding: 'utf8' })).toMatch(/^git version/);
      expect(await host.docker(['version'])).toBe('27.0.1');
    });
    expect(nodeSweepHost(() => undefined).appendFileSync).toBeDefined();
  });

  test('the node host runs a synchronous command with its options and the given environment', () => {
    const host = nodeSweepHost(() => undefined, { ...process.env, ACME_MARK: 'marked' });
    expect(host.execFileSync('sh', ['-c', 'printf %s "$ACME_MARK"'], { encoding: 'utf8' })).toBe('marked');
  });
});
