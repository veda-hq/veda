import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { expect, it, vi } from '../test/expect.test.ts';
import {
  COMMAND_TIMEOUT_MS,
  DAEMON_TIMEOUT_MS,
  LAUNCHCTL_TIMEOUT_MS,
  LOG_LIMIT_BYTES,
  RUNTIME_FILES,
  USAGE,
  agentLabel,
  appendLog,
  cacheRecordsToDelete,
  cli,
  copyRuntime,
  defaultEnv,
  detail,
  dryRun,
  hoursAgo,
  orphanedServiceVolumes,
  overCeiling,
  plist,
  readSnapshot,
  reclaimed,
  recordsOverCeiling,
  runtimeDirectory,
  sizeBytes,
  staleImageTags,
  sweep,
  sweepOnce,
  type CacheRecord,
  type Env,
  type ImageRecord,
  type PruneSettings,
  type SweepDependencies,
} from './prune.ts';
import { projectName, type Docker, type WorktreeState } from './reaper.ts';
import type { ChildOutcome } from './run-child.ts';
import { LABEL, PREFIX, sampleRaw } from './sample.test.ts';

const SERVICES = dirname(fileURLToPath(import.meta.url));
/** The tree the runtime copy comes from: `src/` here, `dist/` once built. */
const SOURCE = dirname(SERVICES);
/** RUNTIME_FILES as this tree names them. */
const RUNNING = RUNTIME_FILES.map(file => file.replace(/\.js$/, '.ts'));
const NOW = Date.parse('2026-10-03T12:00:00Z');
const OLD = '2026-09-01T00:00:00Z';
const LIVE = '/worktrees/live';
const GONE = '/worktrees/archived';
const AGENT = 'gui/501/com.acme.docker-prune';
const NAMES = { project: PREFIX, rootLabel: LABEL };
const states: Record<string, WorktreeState> = {
  [LIVE]: 'present',
  [GONE]: 'gone',
  '/worktrees/unreadable': 'unknown',
};
const inspect = (path: string): WorktreeState => states[path] ?? 'gone';
const project = (root: string): string => projectName(PREFIX, root);

const temporary: string[] = [];
/** A fresh directory under the real temporary root, symlinks resolved. */
function scratch(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'docker-prune-')));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function image(id: string, tags: string[] | null, created = OLD, tagged?: string): ImageRecord {
  return { Id: id, RepoTags: tags, Created: created, Metadata: { LastTagTime: tagged } };
}

const ok = (stdout = ''): ChildOutcome => ({ kind: 'ok', code: 0, stdout, stderrTail: '' });
const exit = (code: number, stderrTail = ''): ChildOutcome => ({ kind: 'exit', code, stdout: '', stderrTail });

/** A settings snapshot, as `install` writes it, in `directory`. */
function snapshot(directory: string, primary = '/repo'): string {
  const path = join(directory, 'settings.json');
  const settings: PruneSettings = { name: 'acme', primary, ...NAMES };
  writeFileSync(path, JSON.stringify(settings));
  return path;
}

/** A primary checkout whose `.claude/sarathi.json` names `acme` and, unless `services` is false, a services file. */
function checkout(base: string, services = true): string {
  const primary = join(base, 'repo');
  mkdirSync(join(primary, '.claude'), { recursive: true });
  writeFileSync(join(primary, '.claude', 'sarathi.json'), JSON.stringify({ hooks: {}, worktree: services ? { name: 'acme', services: 'services.json' } : { name: 'acme' } }));
  writeFileSync(join(primary, 'services.json'), JSON.stringify(sampleRaw()));
  return primary;
}

describe('the project names', () => {
  test('are the names the earlier project-specific agent used, from worktree.name', () => {
    expect(agentLabel('acme')).toBe('com.acme.docker-prune');
    expect(runtimeDirectory('/Users/u', 'acme')).toBe('/Users/u/Library/Application Support/Acme/DockerPrune');
    const folder = '/Users/u/Library/Application Support/Acme/DockerPrune';
    // The plist the earlier, project-specific agent wrote, for the same program.
    expect(
      plist(
        agentLabel('acme'),
        ['/usr/local/bin/node', `${folder}/docker-prune-service.ts`, 'run', '--docker', '/usr/local/bin/docker', '--primary', '/repo'],
        '/usr/local/bin:/usr/bin:/bin',
        `${folder}/launchd.log`,
      ),
    ).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>com.acme.docker-prune</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/usr/local/bin/node</string>
\t\t<string>${folder}/docker-prune-service.ts</string>
\t\t<string>run</string>
\t\t<string>--docker</string>
\t\t<string>/usr/local/bin/docker</string>
\t\t<string>--primary</string>
\t\t<string>/repo</string>
\t</array>
\t<key>StartInterval</key>
\t<integer>3600</integer>
\t<key>RunAtLoad</key>
\t<false/>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>LowPriorityIO</key>
\t<true/>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/usr/local/bin:/usr/bin:/bin</string>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${folder}/launchd.log</string>
\t<key>StandardErrorPath</key>
\t<string>${folder}/launchd.log</string>
</dict>
</plist>
`);
  });

  test('capitalize the name for the folder, sarathi’s own default included', () => {
    expect(runtimeDirectory('/h', 'sarathi')).toBe('/h/Library/Application Support/Sarathi/DockerPrune');
    expect(agentLabel('my-tool')).toBe('com.my-tool.docker-prune');
  });
});

describe('orphanedServiceVolumes', () => {
  const live = `${project(LIVE)}_postgres18_data`;
  const gone = `${project(GONE)}_postgres18_data`;
  const unreadable = '/worktrees/unreadable';

  test('removes a labelled volume only when its root is gone', () => {
    const volumes = [
      { name: live, root: LIVE },
      { name: gone, root: GONE },
      { name: `${project(unreadable)}_data`, root: unreadable },
    ];
    expect(orphanedServiceVolumes(volumes, inspect, PREFIX)).toEqual([gone]);
  });

  test('keeps a volume whose label names a root it was not made for', () => {
    expect(orphanedServiceVolumes([{ name: `${project('/elsewhere')}_data`, root: GONE }], inspect, PREFIX)).toEqual([]);
  });

  test('keeps every unlabelled volume: another clone may own it', () => {
    const volumes = [
      { name: gone, root: undefined },
      // Nor an empty label, even on one named for the empty root, which
      // `inspect` calls gone.
      { name: `${project('')}_data`, root: '' },
    ];
    expect(inspect('')).toBe('gone');
    expect(orphanedServiceVolumes(volumes, inspect, PREFIX)).toEqual([]);
  });

  test('never touches volumes outside worktree services, another prefix’s included', () => {
    expect(orphanedServiceVolumes([{ name: 'server_postgres_data', root: GONE }], inspect, PREFIX)).toEqual([]);
    expect(orphanedServiceVolumes([{ name: gone, root: GONE }], inspect, 'other-wt')).toEqual([]);
  });

  test('reads a prefix with pattern characters as text', () => {
    const dotted = `${projectName('a.b', GONE)}_data`;
    expect(orphanedServiceVolumes([{ name: dotted, root: GONE }], inspect, 'a.b')).toEqual([dotted]);
    expect(orphanedServiceVolumes([{ name: dotted.replace('a.b', 'axb'), root: GONE }], inspect, 'a.b')).toEqual([]);
  });
});

describe('staleImageTags', () => {
  const recent = new Date(NOW - 60_000).toISOString();

  test('returns the tags of old images no container uses', () => {
    const images = [
      image('a', ['old:1', 'old:2']),
      image('b', ['used:1']),
      image('c', ['fresh:1'], recent),
      image('d', ['retagged:1'], OLD, recent),
      image('f', null),
      image('h', ['never-tagged:1'], OLD, '0001-01-01T00:00:00Z'),
    ];
    expect(staleImageTags(images, new Set(['b']), NOW)).toEqual(['old:1', 'old:2', 'never-tagged:1']);
  });

  test('keeps an image whose build or tag time does not read as a time', () => {
    const images = [
      image('a', ['unbuilt:1'], 'not a date'),
      image('b', ['untimed:1'], OLD, 'not a date'),
      { Id: 'c', RepoTags: ['no-created:1'] } as unknown as ImageRecord,
    ];
    expect(staleImageTags(images, new Set(), NOW)).toEqual([]);
  });

  test('treats a missing tag time as old, and an hour as old', () => {
    const hourAgo = new Date(NOW - 3_600_000).toISOString();
    const images = [
      { Id: 'a', RepoTags: ['x:1'], Created: OLD },
      { Id: 'b', RepoTags: ['y:1'], Created: hourAgo },
    ];
    expect(staleImageTags(images, new Set(), NOW)).toEqual(['x:1', 'y:1']);
  });
});

describe('detail', () => {
  test('reads an Error, a value, and survives one that cannot be printed', () => {
    expect(detail(new Error('boom'))).toBe('boom');
    expect(detail(7)).toBe('7');
    const hostile = {
      toString() {
        throw new Error('no');
      },
    };
    expect(detail(hostile)).toBe('an error that cannot be printed');
  });
});

describe('reclaimed', () => {
  test('reads the space a prune printed', () => {
    expect(reclaimed('Deleted: x\nTotal reclaimed space: 1.2GB \n')).toBe('1.2GB');
    expect(reclaimed('ID\tSIZE\nx\t4GB\nTotal:\t4GB')).toBe('4GB');
    expect(reclaimed('nothing')).toBeUndefined();
  });
});

describe('RUNTIME_FILES', () => {
  test('lists every local module the runtime copy imports, and those import only Node built-ins', () => {
    const needed = new Set<string>();
    const outside = new Set<string>();
    const visit = (file: string): void => {
      if (needed.has(file)) return;
      needed.add(file);
      const source = readFileSync(join(SOURCE, file), 'utf8');
      for (const [, specifier = ''] of source.matchAll(/(?:from|import) '([^']+)'/g)) {
        if (specifier.startsWith('.')) visit(relative(SOURCE, join(SOURCE, dirname(file), specifier)));
        else outside.add(specifier);
      }
    };
    visit('services/prune.ts');
    expect([...needed].map(file => file.replace(/\.ts$/, '.js')).sort()).toEqual([...RUNTIME_FILES].sort());
    expect(RUNTIME_FILES[0]).toBe('services/prune.js');
    expect([...outside].filter(specifier => !specifier.startsWith('node:'))).toEqual([]);
    expect(outside.size).toBeGreaterThan(0);
  });

  test('copyRuntime copies them, keeping their layout, as ES modules', () => {
    const target = join(scratch(), 'copy');
    copyRuntime(SOURCE, target);
    expect(readFileSync(join(target, 'package.json'), 'utf8')).toBe('{ "type": "module" }\n');
    for (const file of RUNNING) expect(readFileSync(join(target, file), 'utf8')).toBe(readFileSync(join(SOURCE, file), 'utf8'));
  });
});

describe('dryRun', () => {
  test('runs only reads and prints everything else', async () => {
    const printed: string[] = [];
    const calls: string[] = [];
    const docker = dryRun(
      async args => {
        calls.push(args.join(' '));
        return 'read';
      },
      line => printed.push(line),
    );
    const reads = [['ps', '-a'], ['info'], ['image', 'ls'], ['container', 'inspect'], ['buildx', 'du']];
    expect(await Promise.all(reads.map(args => docker(args)))).toEqual(reads.map(() => 'read'));
    const writes = [
      ['rm', '--force', 'c'],
      ['volume', 'rm', 'v'],
      ['image', 'prune', '-f'],
      ['compose', 'down', '--volumes'],
    ];
    expect(await Promise.all(writes.map(args => docker(args)))).toEqual(writes.map(() => ''));
    expect(calls).toEqual(reads.map(args => args.join(' ')));
    expect(printed).toEqual(writes.map(args => `would run: docker ${args.join(' ')}`));
  });
});

describe('plist', () => {
  test('escapes every XML special character', () => {
    const text = plist('com.a&b', ['/a & b/run.ts'], '/x<y>z', '/log');
    expect(text).toContain('<string>com.a&amp;b</string>');
    expect(text).toContain('<string>/a &amp; b/run.ts</string>');
    expect(text).toContain('<string>/x&lt;y&gt;z</string>');
  });
});

describe('readSnapshot', () => {
  test('reads the snapshot install wrote', () => {
    expect(readSnapshot(snapshot(scratch()))).toEqual({ name: 'acme', primary: '/repo', ...NAMES });
  });

  it.each([
    ['not JSON', 'nope', 'Unexpected token'],
    ['not an object', '[1]', 'not an object'],
    ['a missing field', JSON.stringify({ name: 'acme', project: PREFIX, rootLabel: LABEL }), '"primary" must be text'],
    ['an empty field', JSON.stringify({ name: 'acme', project: '', rootLabel: LABEL, primary: '/r' }), '"project" must be text'],
    ['a bad name', JSON.stringify({ name: 'Acme', project: PREFIX, rootLabel: LABEL, primary: '/r' }), '"name" must be lowercase'],
    ['a relative primary', JSON.stringify({ name: 'acme', project: PREFIX, rootLabel: LABEL, primary: 'r' }), '"primary" must be an absolute path'],
  ])('refuses %s', (_name, text, why) => {
    const path = join(scratch(), 'settings.json');
    writeFileSync(path, text);
    expect(() => readSnapshot(path)).toThrow(why);
    expect(() => readSnapshot(path)).toThrow('run `sarathi services prune install` again');
  });

  test('refuses a file it cannot read', () => {
    expect(() => readSnapshot('/nonexistent/settings.json')).toThrow('ENOENT');
  });
});

describe('hoursAgo', () => {
  it.each([
    ['Less than a second ago', 0],
    ['1 second ago', 0],
    ['About a minute ago', 0],
    ['59 minutes ago', 0],
    ['About an hour ago', 1],
    ['47 hours ago', 47],
    ['3 days ago', 72],
    ['2 weeks ago', 336],
    ['1 month ago', 720],
    ['2 years ago', 17520],
  ])('reads %s', (text, hours) => {
    expect(hoursAgo(text, NOW)).toBe(hours);
  });

  it.each([
    ['2026-10-03T09:00:00Z', 3],
    ['2026-10-03T11:30:00.123456789Z', 0.5 - 0.123 / 3600],
    ['2026-10-03T14:30:00+05:30', 3],
    ['2026-10-02 12:00:00.5 +0000 UTC', 24 - 0.5 / 3600],
  ])('reads the timestamp %s against the sweep clock', (text, hours) => {
    expect(hoursAgo(text, NOW)).toBeCloseTo(hours, 9);
  });

  test('cannot read an empty or unknown age', () => {
    expect(hoursAgo('', NOW)).toBeUndefined();
    expect(hoursAgo('whenever', NOW)).toBeUndefined();
    expect(hoursAgo('3 fortnights ago', NOW)).toBeUndefined();
  });

  test('cannot read a count of hours past the safe-integer range', () => {
    expect(hoursAgo('9007199254740993 hours ago', NOW)).toBeUndefined();
    expect(hoursAgo('9007199254740991 hours ago', NOW)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

const cache: CacheRecord[] = [
  { ID: 'parent', Description: 'RUN build', LastUsedAt: '2 hours ago', UsageCount: 1 },
  { ID: 'newer', Description: 'RUN build', LastUsedAt: 'About an hour ago', UsageCount: 1 },
  { ID: 'child', Description: 'COPY', LastUsedAt: '2 hours ago', Parents: ['parent'] },
  { ID: 'latest-copy', Description: 'COPY', LastUsedAt: '5 minutes ago' },
  { ID: 'hour-old', Description: 'COPY', LastUsedAt: 'About an hour ago' },
  { ID: 'deps', Description: 'pnpm install', LastUsedAt: '2 days ago', UsageCount: 9 },
  { ID: 'old-deps', Description: 'pnpm i', LastUsedAt: '3 days ago', UsageCount: 9 },
  { ID: 'busy', Description: 'COPY', LastUsedAt: '9 hours ago' },
  { ID: 'zero', Description: 'COPY', LastUsedAt: '9 hours ago' },
  { ID: 'silent', Description: 'COPY', LastUsedAt: '9 hours ago' },
  { ID: 'held', Description: 'COPY', LastUsedAt: '9 hours ago', Reclaimable: false },
  { ID: 'unreadable', Description: 'COPY', LastUsedAt: 'whenever' },
  // Four days old by the sweep clock: stale even as the newest of its step.
  { ID: 'stamped', Description: 'RUN stamp', LastUsedAt: '2026-09-29T12:00:00Z' },
];

describe('sizeBytes', () => {
  it.each([
    ['0B', 0],
    ['512B', 512],
    ['1.5kB', 1500],
    ['3.1MB', 3_100_000],
    ['30GB', 30e9],
    ['2TB', 2e12],
    ['1PB', 1e15],
    ['12.25GB', 12.25e9],
    ['829889526', 829_889_526],
    ['0', 0],
    ['3G', undefined],
    ['3.1 GB', undefined],
    ['GB', undefined],
    ['1.GB', undefined],
    ['1KB', undefined],
    ['x3GB', undefined],
    ['3GBs', undefined],
    ['', undefined],
    [undefined, undefined],
    [`${'9'.repeat(300)}PB`, undefined],
    ['9'.repeat(400), undefined],
  ] as Array<[string | undefined, number | undefined]>)('%s → %s', (size, bytes) => {
    expect(sizeBytes(size)).toBe(bytes);
  });
});

describe('recordsOverCeiling', () => {
  const record = (ID: string, LastUsedAt: string, Size: string, extra: Partial<CacheRecord> = {}): CacheRecord => ({ ID, LastUsedAt, Size, ...extra });

  test('nothing while the listed total is at or under the cap', () => {
    const records = [record('a', '2 days ago', '20GB'), record('b', '2 days ago', '20GB')];
    expect(recordsOverCeiling(records, new Set(), NOW, 40e9)).toEqual([]);
    expect(recordsOverCeiling([], new Set(), NOW, 0)).toEqual([]);
  });

  test('least recently used leaves first, stopping once under the cap', () => {
    const records = [record('day', '1 day ago', '20GB'), record('week', '1 week ago', '20GB'), record('hours', '5 hours ago', '20GB')];
    expect(recordsOverCeiling(records, new Set(), NOW, 30e9)).toEqual(['week', 'day']);
    expect(recordsOverCeiling(records, new Set(), NOW, 40e9)).toEqual(['week']);
  });

  test('never a parent, an id already tried, one in use, one an image holds, or one used within the hour', () => {
    const records = [
      record('parent', '1 year ago', '50GB'),
      record('child', '1 hour ago', '1GB', { Parents: ['parent'] }),
      record('tried', '1 year ago', '50GB'),
      record('in-use', '1 year ago', '50GB', { InUse: true }),
      record('held', '1 year ago', '50GB', { Reclaimable: false }),
      record('recent', '59 minutes ago', '50GB'),
      record('unreadable', 'sometime', '50GB'),
      record('eligible', '2 hours ago', '1GB', { Reclaimable: true, InUse: false }),
    ];
    expect(recordsOverCeiling(records, new Set(['tried']), NOW, 0)).toEqual(['eligible', 'child']);
  });

  test('overCeiling notes only a listed total above the cap', () => {
    expect(overCeiling([record('a', 'x', '40GB')], 40e9)).toBeUndefined();
    expect(overCeiling([], 0)).toBeUndefined();
    expect(overCeiling([record('a', 'x', '40GB'), record('b', 'x', '1kB')], 40e9)).toBe(
      'still 40.0 GB listed, over the 40 GB cap: the rest is in use, recent, held by an image or would not delete',
    );
    expect(() => overCeiling([record('c', 'x', 'big')], 40e9)).toThrow('cannot measure build cache record c: size "big"');
  });

  test('a size it cannot read throws: the total would be unknown', () => {
    const records = [record('a', '2 days ago', '20GB'), record('odd', '2 days ago', '20 gigs')];
    expect(() => recordsOverCeiling(records, new Set(), NOW, 40e9)).toThrow('cannot measure build cache record odd: size "20 gigs"');
    expect(() => recordsOverCeiling([{ ID: 'none', LastUsedAt: '2 days ago' }], new Set(), NOW, 40e9)).toThrow('cannot measure build cache record none: size undefined');
  });
});

describe('cacheRecordsToDelete', () => {
  test('drops old one-off leaves and stale reused layers, keeps the rest', () => {
    expect(cacheRecordsToDelete(cache, new Set(), NOW)).toEqual(['child', 'hour-old', 'old-deps', 'busy', 'zero', 'silent', 'stamped']);
  });

  test('ages timestamped records by the clock it is given', () => {
    const records = [
      { ID: 'fresh', Description: 'X', LastUsedAt: '2026-10-03T11:59:00Z' },
      { ID: 'stale', Description: 'X', LastUsedAt: '2026-10-03T10:00:00Z' },
    ];
    expect(cacheRecordsToDelete(records, new Set(), NOW)).toEqual(['stale']);
    // Ninety minutes earlier, `stale` was half an hour old.
    expect(cacheRecordsToDelete(records, new Set(), NOW - 5_400_000)).toEqual([]);
  });

  test('keeps the newest copy of a step until it is stale', () => {
    const records = [
      { ID: 'only', Description: 'RUN x', LastUsedAt: '2 days ago' },
      { ID: 'gone', Description: 'RUN y', LastUsedAt: '3 days ago' },
      { ID: 'undescribed', LastUsedAt: '5 hours ago' },
    ];
    expect(cacheRecordsToDelete(records, new Set(), NOW)).toEqual(['gone']);
  });

  test('keeps an older copy that more than one build reused', () => {
    const records = [
      { ID: 'newest', Description: 'RUN x', LastUsedAt: '1 minute ago' },
      { ID: 'reused', Description: 'RUN x', LastUsedAt: '5 hours ago', UsageCount: 2 },
      { ID: 'once', Description: 'RUN x', LastUsedAt: '5 hours ago', UsageCount: 1 },
    ];
    expect(cacheRecordsToDelete(records, new Set(), NOW)).toEqual(['once']);
  });

  test('of two equally recent copies, keeps the first', () => {
    const records = [
      { ID: 'first', Description: 'X', LastUsedAt: '5 hours ago' },
      { ID: 'second', Description: 'X', LastUsedAt: '5 hours ago' },
    ];
    expect(cacheRecordsToDelete(records, new Set(), NOW)).toEqual(['second']);
  });

  test('skips records tried, in use, or still held by an image', () => {
    const records = [
      { ID: 'a', Description: 'X', LastUsedAt: '1 minute ago' },
      { ID: 'b', Description: 'X', LastUsedAt: '5 hours ago' },
      { ID: 'c', Description: 'X', LastUsedAt: '5 hours ago', InUse: true },
      { ID: 'd', Description: 'X', LastUsedAt: '5 hours ago', Reclaimable: false },
    ];
    expect(cacheRecordsToDelete(records, new Set(['b']), NOW)).toEqual([]);
  });
});

type Answer = string | Error | ((command: string) => string);

/** A scripted Docker CLI: the first matching prefix answers; an Error throws. */
function fakeDocker(answers: Array<[string, Answer]>): { docker: Docker; calls: string[] } {
  const calls: string[] = [];
  const docker: Docker = async args => {
    const command = args.join(' ');
    calls.push(command);
    const answer = answers.find(([prefix]) => command.startsWith(prefix))?.[1] ?? '';
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(command) : answer;
  };
  return { docker, calls };
}

/**
 * BuildKit's cache as `buildx du` and `buildx prune --filter id=` see it: a
 * record with children cannot go; `fails` throw, `zero` free nothing and
 * `silent` print no total.
 */
function fakeCache(initial: CacheRecord[], quirks: { fails?: string[]; zero?: string[]; silent?: string[] } = {}): { answers: Array<[string, Answer]>; ids: () => string[] } {
  let records = [...initial];
  // buildx lists a size for every record; a fixture without one is empty.
  const du = (): string => records.map(record => JSON.stringify({ Size: '0B', ...record })).join('\n');
  const pruneId = (command: string): string => {
    const id = command.split('id=')[1] ?? '';
    if (quirks.fails?.includes(id)) throw new Error('in use');
    if (quirks.zero?.includes(id)) return 'Total:\t0B';
    if (quirks.silent?.includes(id)) return '';
    if (records.some(record => record.Parents?.includes(id))) return 'Total:\t0B';
    records = records.filter(record => record.ID !== id);
    return 'ID\tRECLAIMABLE\tSIZE\nx\ttrue\t1GB\nTotal:\t1GB';
  };
  return {
    answers: [
      ['buildx du', du],
      ['buildx prune -f --filter id=', pruneId],
    ],
    ids: () => records.map(record => record.ID),
  };
}

function dependencies(docker: Docker, overrides: Partial<SweepDependencies> = {}): SweepDependencies {
  return {
    docker,
    settings: NAMES,
    referenced: async () => false,
    inspect,
    now: () => NOW,
    reapArchived: async () => ({ reaped: [], skipped: [], failed: [], warnings: [] }),
    ...overrides,
  };
}

describe('sweep', () => {
  const liveVolume = `${project(LIVE)}_postgres18_data`;
  const goneVolume = `${project(GONE)}_postgres18_data`;
  // Unlabelled, so nothing proves its worktree gone.
  const bareVolume = `${project('/worktrees/bare')}_data`;
  // Its label names a root that cannot be read.
  const heldVolume = `${project('/worktrees/unreadable')}_data`;
  const recent = new Date(NOW - 60_000).toISOString();
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();
  const anonymous = (Name: string, CreatedAt: string): object => ({ Name, CreatedAt, Labels: { 'com.docker.volume.anonymous': '' } });
  const images = [image('sha:used', ['used:1']), image('sha:old', ['old:1', 'repo:1']), image('sha:busy', ['busy:1']), image('sha:fresh', ['fresh:1'], recent), image('sha:none', null)];

  test('runs every step and removes only what is provably unused', async () => {
    const buildCache = fakeCache(cache, { fails: ['busy'], zero: ['zero'], silent: ['silent'] });
    const { docker, calls } = fakeDocker([
      ...buildCache.answers,
      ['container prune', 'Total reclaimed space: 1MB'],
      ['ps -a -q', 'c1\n'],
      ['container inspect', 'sha:used\n'],
      ['image ls', 'sha:used\nsha:old\nsha:busy\nsha:old\nsha:fresh\nsha:none\n'],
      ['image inspect', JSON.stringify(images)],
      ['image rm busy:1', new Error('conflict: image is being used')],
      ['image prune', 'Total reclaimed space: 2GB'],
      ['volume ls -q --filter dangling=true --filter label=com.docker.volume.anonymous', 'anon-old\nanon-hour\nanon-new\nanon-undated\nanon-busy\n'],
      [
        'volume inspect anon-',
        JSON.stringify([
          anonymous('anon-old', ago(7_200_000)),
          anonymous('anon-hour', ago(3_600_000)),
          anonymous('anon-new', ago(3_599_000)),
          anonymous('anon-undated', ''),
          anonymous('anon-busy', ago(10_800_000)),
        ]),
      ],
      ['volume rm anon-busy', new Error('volume is in use')],
      ['volume ls', `${liveVolume}\n${goneVolume}\n${bareVolume}\n${heldVolume}\nserver_postgres_data\n`],
      [
        'volume inspect',
        JSON.stringify([
          { Name: liveVolume, Labels: {} },
          { Name: goneVolume, Labels: { [LABEL]: GONE } },
          { Name: bareVolume, Labels: null },
          { Name: heldVolume, Labels: { [LABEL]: '/worktrees/unreadable' } },
        ]),
      ],
      ['network prune', ''],
    ]);
    const results = await sweep(
      dependencies(docker, {
        referenced: async tag => tag === 'repo:1',
        reapArchived: async () => ({
          reaped: ['acme-wt-archived'],
          skipped: [{ project: 'acme-wt-odd', reason: 'cannot inspect /r' }],
          failed: [{ project: 'acme-wt-busy', error: 'conflict' }],
          warnings: ['listed containers only'],
        }),
      }),
    );
    expect(results).toEqual([
      {
        step: 'archived worktree stacks',
        ok: true,
        removed: ['acme-wt-archived'],
        notes: ['kept acme-wt-odd: cannot inspect /r', 'failed acme-wt-busy: conflict', 'listed containers only'],
      },
      { step: 'containers', ok: true, reclaimed: '1MB' },
      { step: 'images', ok: true, removed: ['old:1'], reclaimed: '2GB' },
      { step: 'anonymous volumes', ok: true, removedCount: 2 },
      { step: 'worktree volumes', ok: true, removed: [goneVolume] },
      { step: 'build cache', ok: true, removedCount: 5, remainingCount: 8 },
      { step: 'build cache ceiling', ok: true, removedCount: 0, remainingCount: 8 },
      { step: 'networks', ok: true, reclaimed: undefined },
    ]);
    expect(calls).toEqual([
      'container prune -f --filter until=1h',
      'ps -a -q --no-trunc',
      'container inspect --format {{.Image}} c1',
      'image ls -a -q --no-trunc',
      'image inspect sha:used sha:old sha:busy sha:fresh sha:none',
      'image rm old:1',
      'image rm busy:1',
      'image prune -f --filter until=1h',
      'volume ls -q --filter dangling=true --filter label=com.docker.volume.anonymous',
      'volume inspect anon-old anon-hour anon-new anon-undated anon-busy',
      'volume rm anon-old',
      'volume rm anon-hour',
      'volume rm anon-busy',
      'volume ls -q --filter dangling=true',
      `volume inspect ${liveVolume} ${goneVolume} ${bareVolume} ${heldVolume}`,
      `volume rm ${goneVolume}`,
      // Round one: the leaves past their window.
      'buildx du --format json',
      'buildx prune -f --filter id=child',
      'buildx prune -f --filter id=hour-old',
      'buildx prune -f --filter id=old-deps',
      'buildx prune -f --filter id=busy',
      'buildx prune -f --filter id=zero',
      'buildx prune -f --filter id=silent',
      'buildx prune -f --filter id=stamped',
      // Round two: the child's removal exposed its parent.
      'buildx du --format json',
      'buildx prune -f --filter id=parent',
      // Round three finds nothing, so no later round runs.
      'buildx du --format json',
      // The ceiling lists once (the cache is under 40 GB), then again to
      // confirm the cap holds.
      'buildx du --format json',
      'buildx du --format json',
      'network prune -f --filter until=1h',
    ]);
    expect(buildCache.ids()).toEqual(['newer', 'latest-copy', 'deps', 'busy', 'zero', 'silent', 'held', 'unreadable']);
  });

  test('stops deleting cache after five rounds', async () => {
    // A chain l1 → l6, each the parent of the one before: one leaf per round.
    const chain: CacheRecord[] = [1, 2, 3, 4, 5, 6].map(level => ({
      ID: `l${level}`,
      Description: 'X',
      LastUsedAt: '5 hours ago',
      Parents: level < 6 ? [`l${level + 1}`] : null,
    }));
    const buildCache = fakeCache([...chain, { ID: 'newest', Description: 'X', LastUsedAt: '1 minute ago' }]);
    const { docker } = fakeDocker(buildCache.answers);
    const results = await sweep(dependencies(docker));
    expect(results[5]).toEqual({ step: 'build cache', ok: true, removedCount: 5, remainingCount: 2 });
    expect(buildCache.ids()).toEqual(['l6', 'newest']);
  });

  test('reports a failed step, still runs the rest, and asks nothing of empty lists', async () => {
    const { docker, calls } = fakeDocker([['container prune', new Error('daemon gone\nmore')]]);
    const results = await sweep(dependencies(docker));
    expect(results).toEqual([
      { step: 'archived worktree stacks', ok: true, removed: [] },
      { step: 'containers', ok: false, error: 'daemon gone' },
      { step: 'images', ok: true, removed: [], reclaimed: undefined },
      { step: 'anonymous volumes', ok: true, removedCount: 0 },
      { step: 'worktree volumes', ok: true, removed: [] },
      { step: 'build cache', ok: true, removedCount: 0, remainingCount: 0 },
      { step: 'build cache ceiling', ok: true, removedCount: 0, remainingCount: 0 },
      { step: 'networks', ok: true, reclaimed: undefined },
    ]);
    expect(calls).toEqual([
      'container prune -f --filter until=1h',
      'ps -a -q --no-trunc',
      'image ls -a -q --no-trunc',
      'image prune -f --filter until=1h',
      'volume ls -q --filter dangling=true --filter label=com.docker.volume.anonymous',
      'volume ls -q --filter dangling=true',
      'buildx du --format json',
      'buildx du --format json',
      'buildx du --format json',
      'network prune -f --filter until=1h',
    ]);
  });

  // Every record is reused (UsageCount 2), so the age rules keep it for three
  // days and only the ceiling can free space; each lists 30 GB.
  const reused = (ID: string, LastUsedAt: string, Parents: string[] | null = null): CacheRecord => ({ ID, Description: ID, LastUsedAt, UsageCount: 2, Size: '30GB', Parents });

  test('evicts least recently used leaves until the listed cache fits the ceiling', async () => {
    const buildCache = fakeCache([reused('middle', '1 day ago'), reused('newest', '3 hours ago'), reused('oldest', '2 days ago')]);
    const { docker, calls } = fakeDocker(buildCache.answers);
    const results = await sweep(dependencies(docker));
    expect(results[6]).toEqual({ step: 'build cache ceiling', ok: true, removedCount: 2, remainingCount: 1 });
    expect(buildCache.ids()).toEqual(['newest']);
    expect(calls.filter(call => call.startsWith('buildx prune'))).toEqual(['buildx prune -f --filter id=oldest', 'buildx prune -f --filter id=middle']);
  });

  test('a later ceiling round reaches the parent a deleted leaf exposed', async () => {
    // base → top; `fresh` was used within the hour, so no sweep touches it.
    const buildCache = fakeCache([reused('base', '2 days ago'), reused('top', '2 days ago', ['base']), reused('fresh', '30 minutes ago')]);
    const { docker } = fakeDocker(buildCache.answers);
    const results = await sweep(dependencies(docker));
    expect(results[6]).toEqual({ step: 'build cache ceiling', ok: true, removedCount: 2, remainingCount: 1 });
    expect(buildCache.ids()).toEqual(['fresh']);
  });

  test('a cap it cannot meet is noted, not reported as met', async () => {
    // Both were used within the hour, so neither may go.
    const buildCache = fakeCache([reused('a', '10 minutes ago'), reused('b', '20 minutes ago')]);
    const { docker } = fakeDocker(buildCache.answers);
    const results = await sweep(dependencies(docker));
    expect(results[6]).toEqual({
      step: 'build cache ceiling',
      ok: true,
      removedCount: 0,
      remainingCount: 2,
      notes: ['still 60.0 GB listed, over the 40 GB cap: the rest is in use, recent, held by an image or would not delete'],
    });
  });

  test('reports a non-Error failure by its text', async () => {
    const docker: Docker = async () => {
      throw 'plain failure';
    };
    const results = await sweep(
      dependencies(docker, {
        reapArchived: async () => {
          throw 'plain failure';
        },
      }),
    );
    expect(results.every(result => result.error === 'plain failure')).toBe(true);
  });
});

describe('appendLog', () => {
  test('appends JSON lines and moves a log past the limit aside', () => {
    const directory = join(scratch(), 'DockerPrune');
    const log = join(directory, 'prune.log');
    appendLog(directory, { n: 1 });
    expect(readFileSync(log, 'utf8')).toBe('{"n":1}\n');
    writeFileSync(log, 'x'.repeat(LOG_LIMIT_BYTES));
    appendLog(directory, { n: 2 });
    expect(existsSync(`${log}.1`)).toBe(false);
    appendLog(directory, { n: 3 });
    expect(readFileSync(`${log}.1`, 'utf8')).toBe(`${'x'.repeat(LOG_LIMIT_BYTES)}{"n":2}\n`);
    expect(readFileSync(log, 'utf8')).toBe('{"n":3}\n');
  });
});

/**
 * An Env whose children are scripted by `answer` and recorded as
 * "command args (timeout)"; its clock starts at NOW and moves 1.3 s per read.
 */
function fakeEnv(home: string, answer: (command: string, args: string[]) => ChildOutcome = () => ok(), overrides: Partial<Env> = {}): { env: Env; calls: string[]; out: string[]; err: string[] } {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let clock = NOW;
  const env: Env = {
    run: async (command, args, timeoutMs) => {
      calls.push(`${[command, ...args].join(' ')} (${timeoutMs})`);
      return answer(command, args);
    },
    home,
    source: SOURCE,
    execPath: process.execPath,
    uid: 501,
    variables: {},
    stdout: line => out.push(line),
    stderr: line => err.push(line),
    now: () => {
      const time = clock;
      clock += 1300;
      return time;
    },
    ...overrides,
  };
  return { env, calls, out, err };
}

const long = (command: string): string => `${command} (${COMMAND_TIMEOUT_MS})`;
const brief = (command: string): string => `${command} (${LAUNCHCTL_TIMEOUT_MS})`;
const AT = new Date(NOW).toISOString();

/** The one git call the CLI makes to find the checkout, matched exactly. */
const COMMON_DIR = 'git rev-parse --path-format=absolute --git-common-dir';
const asksCommonDir = (command: string, args: string[]): boolean => [command, ...args].join(' ') === COMMON_DIR;
const logOf = (home: string): string => join(runtimeDirectory(home, 'acme'), 'prune.log');

describe('cli run', () => {
  const unlabelled = `${project('/worktrees/elsewhere')}_data`;
  // A root that does not exist on this machine, so worktreeState calls it gone.
  const goneRoot = '/nonexistent/acme-docker-prune-test-root';
  const orphan = `${project(goneRoot)}_data`;
  /** The archived worktree's stack: one container of the project of `goneRoot`. */
  const stack = project(goneRoot);

  /**
   * Docker with one stale image a:1/b:1/c:1, an unlabelled volume, one
   * labelled for a gone root, and the gone root's stack.
   */
  function dockerAnswer(command: string, args: string[]): ChildOutcome {
    const line = [command, ...args].join(' ');
    if (line.endsWith(' info --format {{.ServerVersion}}')) return ok('29.4.0\n');
    if (line.endsWith(' image ls -a -q --no-trunc')) return ok('sha:a\n');
    if (line.endsWith(' image inspect sha:a')) return ok(JSON.stringify([image('sha:a', ['a:1', 'b:1', 'c:1'])]));
    if (line.endsWith(' volume ls -q --filter dangling=true')) return ok(`${unlabelled}\n${orphan}\n`);
    if (line.endsWith(` volume inspect ${unlabelled} ${orphan}`)) {
      return ok(
        JSON.stringify([
          { Name: unlabelled, Labels: {}, CreatedAt: OLD },
          { Name: orphan, Labels: { [LABEL]: goneRoot }, CreatedAt: OLD },
        ]),
      );
    }
    if (line.includes(' ps --all --filter label=com.docker.compose.project --format')) return ok(`${stack}\t${goneRoot}\n`);
    if (line.includes(` ps --all --quiet --filter label=com.docker.compose.project=${stack}`)) return ok('c9\n');
    if (line.includes(' grep ') && line.includes(' a:1 ')) return exit(1);
    if (line.includes(' grep ') && line.includes(' c:1 ')) return exit(2);
    return ok();
  }

  test('sweeps with the given docker and settings, the reap included, logs and prints the entry', async () => {
    const home = scratch();
    const settings = snapshot(home);
    const { env, calls, out, err } = fakeEnv(home, dockerAnswer);
    expect(await cli(['run', '--docker', '/bin/docker', '--settings', settings], env)).toBe(0);
    expect(err).toEqual([]);
    expect(calls[0]).toBe(`/bin/docker info --format {{.ServerVersion}} (${DAEMON_TIMEOUT_MS})`);
    expect(calls).toContain(long('/bin/docker container prune -f --filter until=1h'));
    expect(calls).toContain(long('git -C /repo grep -q -F -e a:1 -- . :!docs'));
    expect(calls).toContain(long('git -C /repo grep -q -F -e b:1 -- . :!docs'));
    expect(calls).toContain(long('/bin/docker image rm a:1'));
    expect(calls).not.toContain(long('/bin/docker image rm b:1'));
    expect(calls).not.toContain(long('/bin/docker image rm c:1'));
    expect(calls.filter(call => call.includes('volume rm') || call.includes('worktree list'))).toEqual([long(`/bin/docker volume rm ${orphan}`)]);
    // The reap ran in-process, through the same docker, on the services file's label.
    expect(calls).toContain(long(`/bin/docker volume ls --filter label=${LABEL} --format {{.Label "com.docker.compose.project"}}\t{{.Label "${LABEL}"}}`));
    expect(calls).toContain(long('/bin/docker rm --force --volumes c9'));
    expect(calls.some(call => call.startsWith('/usr/bin/which'))).toBe(false);
    expect(calls.some(call => call.includes('rev-parse'))).toBe(false);
    const entry = JSON.parse(readFileSync(logOf(home), 'utf8')) as { at: string; seconds: number; results: unknown[] };
    expect(Object.keys(entry)).toEqual(['at', 'seconds', 'results']);
    expect(entry.at).toBe(AT);
    // Five reads after the start, 1.3 s apart (images, anonymous volumes,
    // cache, ceiling, the end): 6.5 s, rounded.
    expect(entry.seconds).toBe(7);
    expect(entry.results).toHaveLength(8);
    expect(entry.results[0]).toEqual({ step: 'archived worktree stacks', ok: true, removed: [stack] });
    expect(out).toEqual([JSON.stringify(entry, null, 2)]);
  });

  test('a reap that cannot remove a stack notes it, and a reap that cannot list fails its step alone', async () => {
    const home = scratch();
    const settings = snapshot(home);
    const refusing = fakeEnv(home, (command, args) => (args[0] === 'rm' ? exit(1, 'Error: conflict\n') : dockerAnswer(command, args)));
    expect(await cli(['run', '--docker', '/bin/docker', '--settings', settings], refusing.env)).toBe(0);
    const first = JSON.parse(readFileSync(logOf(home), 'utf8')) as { results: unknown[] };
    expect(first.results[0]).toEqual({
      step: 'archived worktree stacks',
      ok: true,
      removed: [],
      notes: [`failed ${stack}: /bin/docker rm --force: exit 1: Error: conflict`],
    });
    rmSync(logOf(home));
    const blind = fakeEnv(home, (command, args) => (args[0] === 'ps' && args[1] === '--all' ? exit(3, 'boom\n') : dockerAnswer(command, args)));
    expect(await cli(['run', '--docker', '/bin/docker', '--settings', settings], blind.env)).toBe(0);
    const second = JSON.parse(readFileSync(logOf(home), 'utf8')) as { results: unknown[] };
    expect(second.results[0]).toEqual({ step: 'archived worktree stacks', ok: false, error: '/bin/docker ps --all: exit 3: boom' });
  });

  test('finds docker and the checkout itself, and a dry run changes nothing, the reap included', async () => {
    const base = scratch();
    const home = join(base, 'home');
    const primary = checkout(base);
    const { env, calls, out } = fakeEnv(home, (command, args) => {
      if (command === '/usr/bin/which') return ok('/usr/local/bin/docker\n');
      if (asksCommonDir(command, args)) return ok(`${primary}/.git\n`);
      return dockerAnswer(command, args);
    });
    expect(await cli(['run', '--dry-run'], env)).toBe(0);
    expect(calls.slice(0, 3)).toEqual([long('/usr/bin/which docker'), long(COMMON_DIR), `/usr/local/bin/docker info --format {{.ServerVersion}} (${DAEMON_TIMEOUT_MS})`]);
    expect(calls).toContain(long(`git -C ${primary} grep -q -F -e a:1 -- . :!docs`));
    expect(calls.some(call => / (prune|rm) /.test(call))).toBe(false);
    expect(out).toContain('would run: docker container prune -f --filter until=1h');
    expect(out).toContain(`would run: docker volume rm ${orphan}`);
    // The reaper read through the dry-run docker: its removal is printed, never run.
    expect(calls).toContain(long(`/usr/local/bin/docker ps --all --quiet --filter label=com.docker.compose.project=${stack}`));
    expect(out).toContain('would run: docker rm --force --volumes c9');
    // The results are reported as a plan, never as removals.
    const plan = JSON.parse(out.at(-1) ?? '') as Record<string, unknown>;
    expect(Object.keys(plan)).toEqual(['at', 'seconds', 'planned']);
    expect(plan['planned']).toContainEqual({ step: 'worktree volumes', ok: true, removed: [orphan] });
    expect(plan['planned']).toContainEqual({ step: 'archived worktree stacks', ok: true, removed: [stack] });
    expect(existsSync(logOf(home))).toBe(false);
  });

  test('a checkout without a services file cannot be swept', async () => {
    const base = scratch();
    const primary = checkout(base, false);
    const { env, err } = fakeEnv(join(base, 'home'), (command, args) => (asksCommonDir(command, args) ? ok(`${primary}/.git\n`) : ok()));
    expect(await cli(['run', '--docker', '/bin/docker'], env)).toBe(1);
    expect(err).toEqual([`${primary}/.claude/sarathi.json names no services file; set "worktree.services"`]);
  });

  test('a package path in the settings resolves with the environment it is given', async () => {
    const base = scratch();
    const primary = checkout(base);
    writeFileSync(join(primary, '.claude', 'sarathi.json'), JSON.stringify({ hooks: {}, worktree: { name: 'acme', services: '@acme/rules/services.json' } }));
    const packages = join(base, 'packages');
    mkdirSync(join(packages, '@acme', 'rules'), { recursive: true });
    writeFileSync(join(packages, '@acme', 'rules', 'services.json'), JSON.stringify(sampleRaw()));
    const answer = (command: string, args: string[]): ChildOutcome => (asksCommonDir(command, args) ? ok(`${primary}/.git\n`) : exit(1, 'Cannot connect\n'));
    const { env } = fakeEnv(join(base, 'home'), answer, { variables: { SARATHI_PACKAGES: packages } });
    expect(await cli(['run', '--docker', '/bin/docker'], env)).toBe(0);
    expect(readFileSync(logOf(join(base, 'home')), 'utf8')).toContain('"skipped"');
  });

  test('logs a skip when the daemon is down', async () => {
    const home = scratch();
    const settings = snapshot(home);
    const { env, calls, out } = fakeEnv(home, () => exit(1, 'Cannot connect\n'));
    expect(await cli(['run', '--docker', '/bin/docker', '--settings', settings], env)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(out).toEqual([]);
    expect(readFileSync(logOf(home), 'utf8')).toBe(`${JSON.stringify({ at: AT, skipped: 'docker: exit 1: Cannot connect' })}\n`);
  });

  test('prints the skip instead on a dry run', async () => {
    const home = scratch();
    const settings = snapshot(home);
    const { env, out } = fakeEnv(home, () => exit(1, 'Cannot connect\n'));
    expect(await cli(['run', '--docker', '/bin/docker', '--dry-run', '--settings', settings], env)).toBe(0);
    expect(out).toEqual(['docker: exit 1: Cannot connect']);
    expect(existsSync(logOf(home))).toBe(false);
  });
});

describe('sweepOnce', () => {
  const settings: PruneSettings = { name: 'acme', primary: '/repo', ...NAMES };

  test('runs the real child and clock unless given others: a missing docker is a skip', async () => {
    expect(await sweepOnce({ docker: '/nonexistent/docker', settings, dryRun: false, print: () => undefined })).toEqual({
      kind: 'skipped',
      reason: 'docker: spawn /nonexistent/docker ENOENT',
    });
  });

  test('sweeps on the real clock with a given child', async () => {
    // Built two hours before the real now: stale on the real clock, never on
    // one stuck at the epoch (or any time before it was built).
    const built = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const calls: string[][] = [];
    const run = async (command: string, args: string[]): Promise<ChildOutcome> => {
      calls.push([command, ...args]);
      if (command === 'git') return { kind: 'exit', code: 1, stdout: '', stderrTail: '' };
      if (args[0] === 'image' && args[1] === 'ls') return ok('sha256:a\n');
      if (args[0] === 'image' && args[1] === 'inspect') return ok(JSON.stringify([image('sha256:a', ['built:1'], built, built)]));
      return ok();
    };
    const outcome = await sweepOnce({ docker: '/bin/docker', settings, dryRun: false, print: () => undefined, run });
    expect(outcome.kind).toBe('swept');
    expect(outcome.kind === 'swept' ? outcome.results.map(result => result.ok) : []).toEqual(Array.from({ length: 8 }, () => true));
    expect(calls).toContainEqual(['/bin/docker', 'image', 'rm', 'built:1']);
  });
});

describe('cli install', () => {
  /** A source tree, a real docker behind a symlink, a node binary and a checkout. */
  function layout(): { base: string; home: string; source: string; primary: string } {
    const base = scratch();
    const home = join(base, 'home');
    const source = join(base, 'dist');
    for (const file of RUNNING) {
      mkdirSync(dirname(join(source, file)), { recursive: true });
      writeFileSync(join(source, file), `// ${file}\n`);
    }
    mkdirSync(join(base, 'real'));
    mkdirSync(join(base, 'link'));
    writeFileSync(join(base, 'real/docker'), '');
    writeFileSync(join(base, 'real/node'), '');
    symlinkSync(join(base, 'real/docker'), join(base, 'link/docker'));
    return { base, home, source, primary: checkout(base) };
  }

  test('replaces a symlink at any path it writes, never its target', async () => {
    const { base, home, source, primary } = layout();
    const { env } = fakeEnv(
      home,
      (command, args) => {
        if (command === '/usr/bin/which') return ok(`${base}/link/docker\n`);
        if (asksCommonDir(command, args)) return ok(`${primary}/.git\n`);
        return args[0] === 'print' ? exit(113) : ok();
      },
      { source, execPath: join(base, 'real/node') },
    );
    const runtime = runtimeDirectory(home, 'acme');
    const written = [
      join(home, 'Library/LaunchAgents/com.acme.docker-prune.plist'),
      join(runtime, 'package.json'),
      join(runtime, 'settings.json'),
      join(runtime, 'services/run-child.ts'),
    ];
    const decoy = join(base, 'decoy');
    writeFileSync(decoy, 'untouched');
    for (const path of written) {
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(decoy, path);
    }
    expect(await cli(['install'], env)).toBe(0);
    expect(readFileSync(decoy, 'utf8')).toBe('untouched');
    for (const path of written) {
      const stat = lstatSync(path);
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o644);
    }
  });

  test('copies the runtime out with a settings snapshot, writes the agent and bootstraps it', async () => {
    const { base, home, source, primary } = layout();
    let loadedNow = false;
    const { env, calls, out } = fakeEnv(
      home,
      (command, args) => {
        if (command === '/usr/bin/which') return ok(`${base}/link/docker\n`);
        if (asksCommonDir(command, args)) return ok(`${primary}/.git\n`);
        if (args[0] === 'print') return loadedNow ? ok() : exit(113, 'Could not find service');
        return ok();
      },
      { source, execPath: join(base, 'real/node') },
    );
    const runtime = runtimeDirectory(home, 'acme');
    const agent = join(home, 'Library/LaunchAgents/com.acme.docker-prune.plist');
    expect(await cli(['install'], env)).toBe(0);
    expect(calls).toEqual([long('/usr/bin/which docker'), long(COMMON_DIR), brief(`/bin/launchctl print ${AGENT}`), brief(`/bin/launchctl bootstrap gui/501 ${agent}`)]);
    expect(readFileSync(join(runtime, 'package.json'), 'utf8')).toBe('{ "type": "module" }\n');
    for (const file of RUNNING) expect(readFileSync(join(runtime, file), 'utf8')).toBe(`// ${file}\n`);
    expect(readSnapshot(join(runtime, 'settings.json'))).toEqual({ name: 'acme', primary, ...NAMES });
    expect(readFileSync(agent, 'utf8')).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>com.acme.docker-prune</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${base}/real/node</string>
\t\t<string>${runtime}/services/prune.ts</string>
\t\t<string>run</string>
\t\t<string>--docker</string>
\t\t<string>${base}/link/docker</string>
\t\t<string>--settings</string>
\t\t<string>${runtime}/settings.json</string>
\t</array>
\t<key>StartInterval</key>
\t<integer>3600</integer>
\t<key>RunAtLoad</key>
\t<false/>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>LowPriorityIO</key>
\t<true/>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${base}/real:${base}/link:${home}/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${runtime}/launchd.log</string>
\t<key>StandardErrorPath</key>
\t<string>${runtime}/launchd.log</string>
</dict>
</plist>
`);
    expect(out).toEqual([`installed ${AGENT}: every 3600s, docker ${base}/link/docker, repo ${primary}`]);

    // Installing over a loaded agent stops it first.
    loadedNow = true;
    calls.length = 0;
    expect(await cli(['install'], env)).toBe(0);
    expect(calls.slice(2)).toEqual([brief(`/bin/launchctl print ${AGENT}`), brief(`/bin/launchctl bootout ${AGENT}`), brief(`/bin/launchctl bootstrap gui/501 ${agent}`)]);
  });
});

describe('cli uninstall, run-now and status', () => {
  const agentFile = (home: string): string => join(home, 'Library/LaunchAgents/com.acme.docker-prune.plist');

  test('uninstall stops a loaded agent and removes its plist, named by the checkout alone', async () => {
    const base = scratch();
    const home = join(base, 'home');
    // No services file: uninstall needs the name only.
    const primary = checkout(base, false);
    mkdirSync(dirname(agentFile(home)), { recursive: true });
    writeFileSync(agentFile(home), 'plist');
    const { env, calls, out } = fakeEnv(home, (command, args) => (asksCommonDir(command, args) ? ok(`${primary}/.git\n`) : ok()));
    expect(await cli(['uninstall'], env)).toBe(0);
    expect(calls).toEqual([long(COMMON_DIR), brief(`/bin/launchctl print ${AGENT}`), brief(`/bin/launchctl bootout ${AGENT}`)]);
    expect(existsSync(agentFile(home))).toBe(false);
    expect(out).toEqual([`removed ${AGENT}; logs kept in ${home}/Library/Application Support/Acme/DockerPrune`]);
  });

  test('uninstall of an agent that is not there does nothing harmful', async () => {
    const home = scratch();
    const { env, calls } = fakeEnv(home, () => exit(113));
    expect(await cli(['uninstall', '--settings', snapshot(home)], env)).toBe(0);
    expect(calls).toEqual([brief(`/bin/launchctl print ${AGENT}`)]);
  });

  test('run-now kickstarts the agent', async () => {
    const home = scratch();
    const { env, calls, out } = fakeEnv(home);
    expect(await cli(['run-now', '--settings', snapshot(home)], env)).toBe(0);
    expect(calls).toEqual([brief(`/bin/launchctl kickstart ${AGENT}`)]);
    expect(out).toEqual([`started ${AGENT}; log: ${home}/Library/Application Support/Acme/DockerPrune/prune.log`]);
  });

  test('a failing launchctl is reported with how it ended', async () => {
    const home = scratch();
    const { env, err } = fakeEnv(home, () => exit(3, 'boom\n'));
    expect(await cli(['run-now', '--settings', snapshot(home)], env)).toBe(1);
    expect(err).toEqual([`/bin/launchctl kickstart ${AGENT}: exit 3: boom`]);
  });

  test('outside a checkout, without settings, it says so', async () => {
    const home = scratch();
    const { env, err } = fakeEnv(home, () => exit(128, 'fatal: not a git repository\n'));
    expect(await cli(['status'], env)).toBe(1);
    expect(err).toEqual(['git rev-parse --path-format=absolute: exit 128: fatal: not a git repository']);
  });

  test('status says whether the agent is loaded and shows the last sweep', async () => {
    const home = scratch();
    const settings = snapshot(home);
    const notLoaded = fakeEnv(home, () => exit(113));
    expect(await cli(['status', '--settings', settings], notLoaded.env)).toBe(0);
    expect(notLoaded.out).toEqual(['not loaded']);

    mkdirSync(dirname(logOf(home)), { recursive: true });
    writeFileSync(logOf(home), '');
    const empty = fakeEnv(home);
    expect(await cli(['status', '--settings', settings], empty.env)).toBe(0);
    expect(empty.out).toEqual(['loaded', '']);

    writeFileSync(logOf(home), 'first\nlast\n');
    const loaded = fakeEnv(home);
    expect(await cli(['status', '--settings', settings], loaded.env)).toBe(0);
    expect(loaded.out).toEqual(['loaded', 'last']);
  });
});

describe('cli arguments', () => {
  it.each([[[]], [['bogus']], [['run', 'extra']]])('refuses %j with the usage line', async argv => {
    const { env, err, calls } = fakeEnv(scratch());
    expect(await cli(argv, env)).toBe(1);
    expect(err).toEqual([USAGE]);
    expect(USAGE).toBe('usage: sarathi services prune install|run|run-now|status|uninstall [--dry-run] [--docker <path>] [--settings <file>]');
    expect(calls).toEqual([]);
  });

  test('refuses an unknown option', async () => {
    const { env, err } = fakeEnv(scratch());
    expect(await cli(['status', '--nope'], env)).toBe(1);
    expect(err[0]).toContain("Unknown option '--nope'");
  });
});

describe('defaultEnv', () => {
  test('is this process, this machine and this tree', () => {
    const env = defaultEnv();
    expect(env.home).toBe(homedir());
    expect(env.source).toBe(SOURCE);
    expect(env.execPath).toBe(process.execPath);
    expect(env.uid).toBe(userInfo().uid);
    expect(env.variables).toBe(process.env);
    const before = Date.now();
    expect(env.now()).toBeGreaterThanOrEqual(before);
  });

  test('writes to the console', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      defaultEnv().stdout('out');
      defaultEnv().stderr('err');
      expect(log).toHaveBeenCalledWith('out');
      expect(error).toHaveBeenCalledWith('err');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  test('runs children with the timeout it is given', async () => {
    const { run } = defaultEnv();
    expect(await run(process.execPath, ['-e', 'process.stdout.write("hi")'], 30_000)).toMatchObject({ kind: 'ok', stdout: 'hi' });
    expect(await run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], 200)).toMatchObject({ kind: 'timeout', timeoutMs: 200 });
  });
});

describe('as launchd runs it', () => {
  test('runs under plain node, from a copy, and exits with the action status', () => {
    const home = scratch();
    const copy = join(home, 'copy');
    copyRuntime(SOURCE, copy);
    const spawn = (args: string[]) =>
      spawnSync(process.execPath, [join(copy, 'services/prune.ts'), ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    const refused = spawn(['bogus']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(USAGE);
    // No daemon at that path: the sweep is skipped, and the skip is logged.
    const skipped = spawn(['run', '--docker', '/nonexistent/docker', '--settings', snapshot(home)]);
    expect(skipped.status).toBe(0);
    expect(readFileSync(logOf(home), 'utf8')).toContain('"skipped":"docker: spawn /nonexistent/docker ENOENT"');
  });
});
