import assert from 'node:assert/strict';
import { test } from 'node:test';

import { acquireLock, LOCK_POLL_MS, LOCK_WAIT_MS, pidAlive, type LockDeps } from './machine-lock.ts';

function fakeLock(alive: (pid: number) => boolean, initial?: string, onSleep?: (files: Map<string, string>) => void) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set('/lock', initial);
  const logs: string[] = [];
  let clock = 0;
  const deps: LockDeps = {
    create: (path, text) => {
      if (files.has(path)) return false;
      files.set(path, text);
      return true;
    },
    read: (path) => files.get(path),
    remove: (path) => {
      files.delete(path);
    },
    alive,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      onSleep?.(files);
    },
    log: (line) => logs.push(line),
  };
  return { deps, files, logs };
}

test('defaults: wait 30 minutes, poll every 5 seconds', () => {
  assert.equal(LOCK_WAIT_MS, 1_800_000);
  assert.equal(LOCK_POLL_MS, 5_000);
});

test('a free lock is taken with the pid and start time, and released', async () => {
  const { deps, files } = fakeLock(() => true);
  const release = await acquireLock('/lock', 42, deps);
  assert.match(files.get('/lock') ?? '', /^42 1970-01-01T00:00:00.000Z$/);
  release();
  assert.equal(files.has('/lock'), false);
});

test('release leaves a lock another run has since taken', async () => {
  const { deps, files } = fakeLock(() => true);
  const release = await acquireLock('/lock', 42, deps);
  files.set('/lock', '7 later');
  release();
  assert.equal(files.get('/lock'), '7 later');
});

test('a dead holder or an unreadable lock is stale and taken over', async () => {
  for (const initial of ['99 2026-01-01', 'garbage']) {
    const { deps, files, logs } = fakeLock((pid) => pid !== 99, initial);
    await acquireLock('/lock', 42, deps);
    assert.match(files.get('/lock') ?? '', /^42 /);
    assert.match(logs[0] ?? '', /stale lock/);
  }
});

test('a lock that vanishes between create and read is taken on the next pass', async () => {
  const { deps, files, logs } = fakeLock(() => true);
  let first = true;
  const create = deps.create;
  deps.create = (path, text) => {
    if (first) {
      first = false;
      return false;
    }
    return create(path, text);
  };
  await acquireLock('/lock', 42, deps);
  assert.match(files.get('/lock') ?? '', /^42 /);
  assert.deepEqual(logs, []);
});

test('an empty lock is being written: it gets one poll, then counts as stale', async () => {
  let polls = 0;
  const { deps, files, logs } = fakeLock(() => true, '', () => {
    polls += 1;
  });
  await acquireLock('/lock', 42, deps);
  assert.equal(polls, 1);
  assert.match(files.get('/lock') ?? '', /^42 /);
  assert.match(logs[0] ?? '', /stale lock \(empty\)/);
});

test('a stale lock replaced before removal is left alone', async () => {
  const { deps, files, logs } = fakeLock((pid) => pid !== 99, '99 old');
  const read = deps.read;
  let reads = 0;
  deps.read = (path) => {
    reads += 1;
    if (reads === 2) files.set('/lock', '7 fresh');
    return read(path);
  };
  let clock = 0;
  deps.now = () => (clock += 60 * 60_000);
  await assert.rejects(acquireLock('/lock', 42, deps), /pid 7 fresh/);
  assert.equal(files.get('/lock'), '7 fresh');
  assert.equal(logs.some((line) => line.includes('stale')), false);
});

test('a live holder is waited for, announced once, then the lock is taken', async () => {
  let polls = 0;
  const { deps, files, logs } = fakeLock(() => true, '7 2026-11-14', (held) => {
    polls += 1;
    if (polls === 3) held.delete('/lock');
  });
  await acquireLock('/lock', 42, deps);
  assert.equal(polls, 3);
  assert.deepEqual(logs, ['agnipariksha: waiting for pid 7 2026-11-14, which holds /lock']);
  assert.match(files.get('/lock') ?? '', /^42 /);
});

test('a live holder past the limit refuses', async () => {
  const { deps } = fakeLock(() => true, '7 2026-11-14');
  await assert.rejects(acquireLock('/lock', 42, deps, 12_000), /pid 7 2026-11-14\) held \/lock for over 0 min/);
});

test('pidAlive: signal 0 succeeds or EPERM is alive, anything else is dead', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(1, () => undefined), true);
  const fail = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(pidAlive(1, fail('EPERM')), true);
  assert.equal(pidAlive(1, fail('ESRCH')), false);
});
