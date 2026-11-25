import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { expect, vi } from '../test/expect.test.ts';
import { createFixtureRoot, FIXTURE_MAX_AGE_MS, FIXTURE_OWNER_FILE, fixtureAbandoned, fixturePrefix, processAlive, processStatus, temporaryDirectory } from './fixture-root.ts';

const NAME = 'acme';
const NOW = 1_800_000_000_000;
const within = (root: string, run: (root: string) => void): void => {
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const fixture = (owner?: unknown): string => {
  const root = mkdtempSync(join(tmpdir(), fixturePrefix(NAME)));
  if (owner !== undefined) writeFileSync(join(root, FIXTURE_OWNER_FILE), typeof owner === 'string' ? owner : JSON.stringify(owner));
  return root;
};
const alive = (pid: number): boolean => pid === 7;

test('a created fixture root names this process as its owner', () => {
  within(createFixtureRoot(NAME), root => {
    expect(basename(root)).toMatch(/^acme-service-test-/);
    const owner = JSON.parse(readFileSync(join(root, FIXTURE_OWNER_FILE), 'utf8')) as { pid: number; createdAt: number };
    expect(owner.pid).toBe(process.pid);
    expect(Date.now() - owner.createdAt).toBeLessThan(60_000);
    expect(fixtureAbandoned(root, NAME)).toBe(false);
    // Another project's reaper never judges it.
    expect(fixtureAbandoned(root, 'other', NOW * 2, () => false)).toBe(false);
  });
});

test('a fixture root is abandoned once its owner is dead, or it outlived any test', () => {
  within(fixture({ pid: 7, createdAt: NOW - 1_000 }), root => {
    expect(fixtureAbandoned(root, NAME, NOW, alive)).toBe(false);
    // A reused PID passes for the owner only until the age cap.
    expect(fixtureAbandoned(root, NAME, NOW + FIXTURE_MAX_AGE_MS, alive)).toBe(true);
  });
  within(fixture({ pid: 8, createdAt: NOW - 1_000 }), root => expect(fixtureAbandoned(root, NAME, NOW, alive)).toBe(true));
});

test('a fixture root without a readable owner is judged by its own age', () => {
  for (const owner of [undefined, '{"pid":', { pid: 0, createdAt: NOW }, { pid: 7.5, createdAt: NOW }, { pid: 7, createdAt: 'yesterday' }, null]) {
    within(fixture(owner), root => {
      const changed = statSync(root).mtimeMs;
      expect(fixtureAbandoned(root, NAME, changed + 1_000, alive)).toBe(false);
      expect(fixtureAbandoned(root, NAME, changed + FIXTURE_MAX_AGE_MS + 1, alive)).toBe(true);
    });
  }
});

test('only a fixture-named root is ever judged abandoned', () => {
  within(mkdtempSync(join(tmpdir(), 'acme-reaper-state-')), root => {
    writeFileSync(join(root, FIXTURE_OWNER_FILE), JSON.stringify({ pid: 8, createdAt: 0 }));
    expect(fixtureAbandoned(root, NAME, NOW, alive)).toBe(false);
  });
  // Outside a system temporary directory: a fixture-looking worktree without
  // an owner record is never judged, however old; a fixture from a run with a
  // private TMPDIR is, by its owner record.
  within(mkdtempSync(join(tmpdir(), 'acme-reaper-parent-')), parent => {
    const root = join(parent, 'acme-service-test-AbC123');
    mkdirSync(root);
    expect(fixtureAbandoned(root, NAME, NOW + FIXTURE_MAX_AGE_MS * 1_000, alive)).toBe(false);
    writeFileSync(join(root, FIXTURE_OWNER_FILE), JSON.stringify({ pid: 8, createdAt: NOW }));
    expect(fixtureAbandoned(root, NAME, NOW, alive)).toBe(true);
  });
  // Not a mkdtemp name: a worktree that merely starts with the prefix.
  expect(fixtureAbandoned('/worktrees/acme-service-test-branch', NAME, NOW, alive)).toBe(false);
  // Vanished between listing and inspection: not this rule's call.
  expect(fixtureAbandoned(join(tmpdir(), 'acme-service-test-Zz9999'), NAME, NOW, alive)).toBe(false);
});

test('temporaryDirectory accepts only the system temporary directories', () => {
  for (const path of [
    tmpdir(),
    realpathSync(tmpdir()),
    '/tmp',
    '/private/tmp',
    '/var/folders/kk/0p2br98975g1tpwnn8381f580000gn/T',
    '/private/var/folders/kk/0p2br98975g1tpwnn8381f580000gn/T',
  ]) {
    expect(temporaryDirectory(path)).toBe(true);
  }
  for (const path of ['/tmp/worktrees', '/private/var/folders/kk/T', '/Users/someone/code/acme', '/private/var/folders/kk/0p2br98975g1tpwnn8381f580000gn/T/nested']) {
    expect(temporaryDirectory(path)).toBe(false);
  }
  // A TMPDIR that cannot be resolved still matches as spelled.
  vi.stubEnv('TMPDIR', '/acme-missing-tmpdir');
  try {
    expect(temporaryDirectory('/acme-missing-tmpdir')).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

test('processAlive tells this process from one that does not exist', () => {
  expect(processAlive(process.pid)).toBe(true);
  // Beyond any PID macOS or Linux hands out.
  expect(processAlive(2 ** 31 - 1)).toBe(false);
  // PID 1 belongs to another user: EPERM, so it is alive.
  expect(processAlive(1)).toBe(true);
  // Only a zombie state counts as dead; a silent `ps` keeps the owner.
  expect(processAlive(process.pid, () => 'Z+')).toBe(false);
  expect(processAlive(process.pid, () => undefined)).toBe(true);
  expect(processStatus(2 ** 31 - 1)).toBeUndefined();
});

test('processAlive treats a real zombie as dead', async () => {
  // The backgrounded child exits after a second, by when its parent has
  // exec'd into `sleep`, which never waits, so the child stays a zombie until
  // `sleep` ends. (`sleep 0` could exit first and be reaped by `sh`.)
  const parent = spawn('sh', ['-c', 'sleep 1 & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const zombie = Number(await new Promise<string>(resolve => parent.stdout.once('data', (chunk: Buffer) => resolve(String(chunk)))));
    await vi.waitFor(() => expect(processStatus(zombie)).toMatch(/^Z/), { timeout: 10_000 });
    expect(processAlive(zombie)).toBe(false);
    expect(processAlive(parent.pid ?? 0)).toBe(true);
  } finally {
    parent.kill('SIGKILL');
  }
});

test('processStatus asks ps for exactly one PID’s state, trimmed, and an empty answer is no state', () => {
  const asked: unknown[][] = [];
  const ps =
    (answer: string) =>
    (file: string, args: string[], options: object): string => {
      asked.push([file, args, options]);
      if (file !== 'ps' || args.join(' ') !== '-o stat= -p 4242') throw new Error(`unexpected ${file} ${args.join(' ')}`);
      return answer;
    };
  expect(processStatus(4242, ps('Z+\n'))).toBe('Z+');
  expect(processStatus(4242, ps(' \n'))).toBeUndefined();
  expect(processStatus(4242, ps(''))).toBeUndefined();
  expect(processStatus(4243, ps('S\n'))).toBeUndefined();
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 };
  expect(asked).toEqual([
    ['ps', ['-o', 'stat=', '-p', '4242'], options],
    ['ps', ['-o', 'stat=', '-p', '4242'], options],
    ['ps', ['-o', 'stat=', '-p', '4242'], options],
    ['ps', ['-o', 'stat=', '-p', '4243'], options],
  ]);
  // The real ps: this process has a state, with nothing around it.
  expect(processStatus(process.pid)).toMatch(/^[A-Z][A-Za-z+<>]*$/);
});

test('temporaryDirectory matches this process’s TMPDIR both as spelled and resolved', () => {
  const holder = mkdtempSync(join(tmpdir(), 'acme-tmpdir-'));
  try {
    const real = join(holder, 'real');
    const link = join(holder, 'link');
    mkdirSync(real);
    symlinkSync(real, link);
    vi.stubEnv('TMPDIR', link);
    try {
      expect(temporaryDirectory(link)).toBe(true);
      expect(temporaryDirectory(realpathSync(real))).toBe(true);
      expect(temporaryDirectory(join(holder, 'other'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
  // The system directories match only whole, from the filesystem root.
  for (const path of ['/acme/tmp', '/acme/private/tmp', '/acme/var/folders/kk/0p2br98975g1tpwnn8381f580000gn/T']) {
    expect(temporaryDirectory(path)).toBe(false);
  }
});

test('a fixture root is abandoned only once strictly older than an hour', () => {
  const holder = mkdtempSync(join(tmpdir(), 'acme-age-'));
  try {
    const root = join(holder, 'acme-service-test-AbC123');
    mkdirSync(root);
    writeFileSync(join(root, 'fixture-owner.json'), JSON.stringify({ pid: 7, createdAt: 1_800_000_000_000 }));
    expect(fixtureAbandoned(root, 'acme', 1_800_003_600_000, pid => pid === 7)).toBe(false);
    expect(fixtureAbandoned(root, 'acme', 1_800_003_600_001, pid => pid === 7)).toBe(true);
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
  // Without an owner, directly in the system temporary directory: by its last change.
  const bare = mkdtempSync(join(tmpdir(), 'acme-service-test-'));
  try {
    utimesSync(bare, 1_800_000_000, 1_800_000_000);
    expect(fixtureAbandoned(bare, 'acme', 1_800_003_600_000, () => true)).toBe(false);
    expect(fixtureAbandoned(bare, 'acme', 1_800_003_600_001, () => true)).toBe(true);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('a project name is matched literally in its fixture roots', () => {
  const holder = mkdtempSync(join(tmpdir(), 'acme-literal-'));
  try {
    for (const [directory, abandoned] of [
      ['a.b-service-test-AbC123', true],
      ['axb-service-test-AbC123', false],
    ] as const) {
      const root = join(holder, directory);
      mkdirSync(root);
      writeFileSync(join(root, 'fixture-owner.json'), JSON.stringify({ pid: 8, createdAt: 1_800_000_000_000 }));
      expect(fixtureAbandoned(root, 'a.b', 1_800_000_000_000, () => false)).toBe(abandoned);
    }
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
});
