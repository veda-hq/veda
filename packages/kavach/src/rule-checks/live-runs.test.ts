/**
 * The push marker and the preflight record, judged live or ended; the probe
 * that judges them; and the CLI a pre-push hook calls to write and clear the
 * marker.
 */
import assert from 'node:assert/strict';
import { type ExecFileSyncOptions, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { scratchDirs } from './fixture.test.ts';
import {
  clearMarker,
  defaultProbe,
  type Effects,
  gitDir,
  isGone,
  listDir,
  liveEffects,
  livePreflight,
  livePush,
  liveRun,
  main,
  markerName,
  parseRun,
  PREFLIGHT_RECORD,
  type Probe,
  processProbe,
  PUSH_MARKER_PREFIX,
  type Read,
  readText,
  START_IDENTITY_FORMAT,
  sweepMarkers,
  writeMarker,
} from './live-runs.ts';

const { scratch, cleanup } = scratchDirs('live-runs-');
afterEach(cleanup);

const ID = `${START_IDENTITY_FORMAT} Mon Oct  5 16:29:20 2026`;

/** A probe that knows `alive` pids, each started at `ID` unless named. */
function probe(alive: readonly number[], starts: Record<number, string> = {}): Probe {
  return {
    isAlive: (pid) => alive.includes(pid),
    startIdentityOf: (pid) => (alive.includes(pid) ? (starts[pid] ?? ID) : null),
  };
}

const files =
  (map: Record<string, string>): Read =>
  (path) => {
    const text = map[path];
    if (text === undefined) throw new Error(`ENOENT ${path}`);
    return text;
  };

const record = (pid: unknown, startIdentity: unknown = ID): string => JSON.stringify({ pid, startIdentity, startedAt: 'x' });

/** Warnings, collected. */
function warnings(): { warn: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { warn: (line) => lines.push(line), lines };
}

describe('parseRun', () => {
  it('reads a pid and start identity', () => {
    assert.deepEqual(parseRun(record(42)), { pid: 42, startIdentity: ID });
  });

  for (const [name, raw] of [
    ['not JSON', '{'],
    ['null', 'null'],
    ['a number', '5'],
    ['a string', '"x"'],
    ['no pid', JSON.stringify({ startIdentity: ID })],
    ['a text pid', record('42')],
    ['a fractional pid', record(4.5)],
    ['pid 1', record(1)],
    ['pid 0', record(0)],
    ['a negative pid', record(-5)],
    ['no start identity', JSON.stringify({ pid: 42 })],
    ['a numeric start identity', record(42, 7)],
  ] as const) {
    it(`refuses ${name}`, () => {
      assert.equal(parseRun(raw), null);
    });
  }

  it('accepts pid 2', () => {
    assert.equal(parseRun(record(2))?.pid, 2);
  });

  it('reads a null start identity, as a run writes when it could not read its own', () => {
    assert.deepEqual(parseRun(record(42, null)), {
      pid: 42,
      startIdentity: null,
    });
  });
});

describe('isGone', () => {
  it('lets liveness alone decide for an identity in another format', () => {
    const foreign = { pid: 42, startIdentity: 'lstart-local Mon Oct  5 18:29:20 2026' };
    assert.equal(isGone(foreign, probe([42])), false);
    assert.equal(isGone(foreign, probe([])), true);
  });

  it('keeps a run whose current start reads in another format', () => {
    assert.equal(isGone({ pid: 42, startIdentity: ID }, probe([42], { 42: 'other Tue' })), false);
  });
});

describe('liveRun', () => {
  const read = files({ '/m': record(42) });

  it('is the run when its pid lives with the same start', () => {
    assert.deepEqual(liveRun('/m', read, probe([42])), {
      pid: 42,
      startIdentity: ID,
    });
  });

  it('is no run when the pid is dead', () => {
    assert.equal(liveRun('/m', read, probe([])), null);
  });

  it('is no run when the pid was reused by a later process', () => {
    const later = `${START_IDENTITY_FORMAT} Tue Oct  6 01:00:00 2026`;
    assert.equal(liveRun('/m', read, probe([42], { 42: later })), null);
  });

  it('is no run when a reused pid exits between the liveness and start reads', () => {
    // A short-lived process can hold a dead push's pid at kill(0) and be gone
    // by the `ps lstart` read; the unknown start must not keep it "live".
    let probes = 0;
    const vanishing: Probe = {
      isAlive: () => probes++ === 0,
      startIdentityOf: () => null,
    };
    assert.equal(liveRun('/m', read, vanishing), null);
    assert.equal(probes, 2);
  });

  it('is the run when its pid still lives but its start cannot be read', () => {
    const blind: Probe = { ...probe([42]), startIdentityOf: () => null };
    assert.equal(liveRun('/m', read, blind)?.pid, 42);
  });

  it('is the run while its pid lives when no start identity was recorded', () => {
    const unknown = files({ '/m': record(42, null) });
    assert.deepEqual(liveRun('/m', unknown, probe([42])), {
      pid: 42,
      startIdentity: null,
    });
    assert.equal(liveRun('/m', unknown, probe([])), null);
  });

  it('is no run without a record, or with a broken one', () => {
    assert.equal(liveRun('/none', read, probe([42])), null);
    assert.equal(liveRun('/m', files({ '/m': '{' }), probe([42])), null);
  });
});

describe('processProbe', () => {
  type Call = { file: string; args: string[]; options: ExecFileSyncOptions };
  function calls(
    kill: (pid: number) => void,
    exec: (call: Call) => unknown,
  ): { probe: Probe; seen: Call[] } {
    const seen: Call[] = [];
    return {
      seen,
      probe: processProbe({
        kill,
        exec: (file, args, options) => {
          const call = { file, args, options };
          seen.push(call);
          return exec(call);
        },
      }),
    };
  }
  const coded = (code: string): (() => never) => () => {
    throw Object.assign(new Error(code), { code });
  };

  it('reads no such process as dead, without asking ps', () => {
    const { probe: p, seen } = calls(coded('ESRCH'), () => 'S');
    assert.equal(p.isAlive(42), false);
    assert.deepEqual(seen, []);
  });

  it('lets ps decide when the signal is refused or reaches the process', () => {
    for (const kill of [coded('EPERM'), () => undefined, () => { throw 'odd'; }]) {
      const { probe: p, seen } = calls(kill, () => Buffer.from('Ss\n'));
      assert.equal(p.isAlive(42), true);
      assert.deepEqual(seen[0]?.args, ['-o', 'stat=', '-p', '42']);
      assert.equal(seen[0]?.file, 'ps');
      assert.equal((seen[0]?.options.env ?? {})['LC_ALL'], 'C');
    }
  });

  it('reads a zombie as dead, and a ps that fails as alive', () => {
    assert.equal(calls(() => undefined, () => 'Z+').probe.isAlive(42), false);
    assert.equal(calls(() => undefined, coded('ENOENT')).probe.isAlive(42), true);
  });

  it('reads the start pinned to UTC and the C locale, in the current format', () => {
    const { probe: p, seen } = calls(() => undefined, () => 'Mon Oct  5 16:29:20 2026\n');
    assert.equal(p.startIdentityOf(42), ID);
    assert.deepEqual(seen[0]?.args, ['-o', 'lstart=', '-p', '42']);
    assert.equal((seen[0]?.options.env ?? {})['TZ'], 'UTC');
    assert.equal((seen[0]?.options.env ?? {})['LC_ALL'], 'C');
  });

  it('reads no start for an empty or failing ps', () => {
    assert.equal(calls(() => undefined, () => '  \n').probe.startIdentityOf(42), null);
    assert.equal(calls(() => undefined, coded('ENOENT')).probe.startIdentityOf(42), null);
  });

  it('sees this process with the real calls, and no process past the largest pid', () => {
    assert.equal(defaultProbe.isAlive(process.pid), true);
    assert.match(defaultProbe.startIdentityOf(process.pid) ?? '', /^lstart-utc-c\/1 \w{3} \w{3} /);
    assert.equal(defaultProbe.isAlive(2 ** 22 + 1), false);
  });
});

describe('gitDir', () => {
  it('is .git itself in a primary checkout', () => {
    const root = scratch();
    mkdirSync(join(root, '.git'));
    assert.equal(gitDir(root, readText), join(root, '.git'));
  });

  it('follows a linked worktree to its own git folder', () => {
    const read = files({ '/wt/.git': 'gitdir: /main/.git/worktrees/wt\n' });
    assert.equal(gitDir('/wt', read), '/main/.git/worktrees/wt');
  });

  it('resolves a relative gitdir from the checkout', () => {
    const read = files({ '/a/wt/.git': 'gitdir: ../main/.git/worktrees/wt' });
    assert.equal(gitDir('/a/wt', read), '/a/main/.git/worktrees/wt');
  });

  it('is .git when the file names no gitdir', () => {
    assert.equal(gitDir('/wt', files({ '/wt/.git': 'nothing\n' })), '/wt/.git');
    assert.equal(gitDir('/wt', files({ '/wt/.git': 'xgitdir: /y\n' })), '/wt/.git');
  });

  it('is .git when there is none to read', () => {
    assert.equal(gitDir('/wt', files({})), '/wt/.git');
  });
});

describe('markerName', () => {
  it('names one marker per push pid', () => {
    assert.equal(PUSH_MARKER_PREFIX, 'kavach-push-in-progress.');
    assert.equal(markerName(42), 'kavach-push-in-progress.42.json');
  });
});

describe('livePush and livePreflight', () => {
  const GIT = '/main/.git/worktrees/wt';
  const read = files({
    '/wt/.git': `gitdir: ${GIT}\n`,
    [`${GIT}/${markerName(41)}`]: record(41),
    [`${GIT}/${markerName(42)}`]: record(42),
    [`${GIT}/kavach-push-in-progress.44.json.tmp`]: record(44),
    [`${GIT}/kavach-push-in-progress.x.json`]: record(45),
    [`${GIT}/xkavach-push-in-progress.46.json`]: record(46),
    [`${GIT}/kavach-push-in-progress.47.jsonx`]: record(47),
    [`/wt/${PREFLIGHT_RECORD}`]: record(43),
    ['/wt/other/run.json']: record(48),
  });
  const list = (dir: string): string[] =>
    dir === GIT
      ? [
          'HEAD',
          markerName(41),
          markerName(42),
          'kavach-push-in-progress.44.json.tmp',
          'kavach-push-in-progress.x.json',
          'xkavach-push-in-progress.46.json',
          'kavach-push-in-progress.47.jsonx',
        ]
      : [];

  it("reads the push markers in the worktree's git folder", () => {
    assert.equal(livePush('/wt', read, list, probe([42]))?.pid, 42);
    assert.equal(livePush('/wt', read, list, probe([41, 42]))?.pid, 41);
    assert.equal(livePush('/wt', read, list, probe([43])), null);
    assert.equal(livePush('/other', read, list, probe([42])), null);
  });

  it('reads only files named as markers', () => {
    assert.equal(livePush('/wt', read, list, probe([44, 45, 46, 47])), null);
  });

  it('is no push when the git folder cannot be listed', () => {
    const fails = (): never => {
      throw new Error('ENOENT');
    };
    assert.equal(livePush('/wt', read, fails, probe([42])), null);
  });

  it("reads the preflight's run record in the worktree, or the record named", () => {
    assert.equal(livePreflight('/wt', read, probe([43]))?.pid, 43);
    assert.equal(livePreflight('/wt', read, probe([42])), null);
    assert.equal(livePreflight('/wt', read, probe([48]), 'other/run.json')?.pid, 48);
    assert.equal(PREFLIGHT_RECORD, join('.tmp', 'preflight-bg', 'current.json'));
  });

  it('lists a real folder', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'a'), '');
    assert.deepEqual(listDir(dir), ['a']);
  });
});

function effects(alive: readonly number[]): Effects {
  return {
    probe: probe(alive),
    read: readText,
    list: listDir,
    write: (path, text) => writeFileSync(path, text),
    rename: (from, to) => {
      writeFileSync(to, readFileSync(from));
      rmSync(from);
    },
    remove: (path) => rmSync(path),
    now: () => new Date('2026-10-05T16:00:00.000Z'),
  };
}

describe('writeMarker and clearMarker', () => {
  it('writes the pid, its start identity and the time, then clears it', () => {
    const dir = scratch();
    writeMarker(dir, 42, effects([42]));
    const path = join(dir, markerName(42));
    assert.equal(
      readFileSync(path, 'utf8'),
      `${JSON.stringify({ pid: 42, startIdentity: ID, startedAt: '2026-10-05T16:00:00.000Z' })}\n`,
    );
    assert.deepEqual(readdirSync(dir), [markerName(42)]);
    clearMarker(dir, 42, effects([42]));
    assert.deepEqual(readdirSync(dir), []);
  });

  it('refuses to write for a process it cannot see', () => {
    const dir = scratch();
    assert.throws(() => writeMarker(dir, 42, effects([])), { message: 'no process 42' });
    assert.deepEqual(readdirSync(dir), []);
  });

  it("keeps two pushes' markers apart: each clears only its own", () => {
    const dir = scratch();
    writeMarker(dir, 42, effects([42, 43]));
    writeMarker(dir, 43, effects([42, 43]));
    clearMarker(dir, 43, effects([42, 43]));
    assert.deepEqual(readdirSync(dir), [markerName(42)]);
    assert.equal(
      livePush(dir, (path) => (path.endsWith('.git') ? `gitdir: ${dir}` : readText(path)), listDir, probe([42]))?.pid,
      42,
    );
  });

  it('writes an identity the real probe reads back as this live process', () => {
    const dir = scratch();
    const real: Effects = { ...effects([]), probe: defaultProbe };
    writeMarker(dir, process.pid, real);
    const run = liveRun(join(dir, markerName(process.pid)), readText, defaultProbe);
    assert.equal(run?.pid, process.pid);
    assert.equal(run?.startIdentity, defaultProbe.startIdentityOf(process.pid));
  });
});

describe('sweepMarkers', () => {
  it('removes the markers of ended pushes when a push writes its own', () => {
    const dir = scratch();
    const later = `${START_IDENTITY_FORMAT} Tue Oct  6 01:00:00 2026`;
    const sweeping: Effects = {
      ...effects([]),
      probe: probe([42, 43, 44], { 43: later }),
    };
    writeFileSync(join(dir, markerName(41)), record(41));
    writeFileSync(join(dir, markerName(43)), record(43));
    writeFileSync(join(dir, markerName(44)), record(44));
    writeFileSync(join(dir, markerName(45)), '{');
    writeFileSync(join(dir, `${markerName(46)}.tmp`), record(46));
    writeFileSync(join(dir, 'HEAD'), 'ref: x\n');

    writeMarker(dir, 42, sweeping);

    // 41 is dead and 43's pid was reused; 44 lives, 45 parses as no push.
    assert.deepEqual(
      readdirSync(dir).sort(),
      ['HEAD', markerName(42), markerName(44), markerName(45), `${markerName(46)}.tmp`].sort(),
    );
  });

  it('skips a marker that vanished before it was read', () => {
    const dir = scratch();
    writeFileSync(join(dir, markerName(47)), record(47));
    const racing: Effects = {
      ...effects([]),
      list: () => [markerName(41), markerName(47)],
    };
    sweepMarkers(dir, racing);
    assert.deepEqual(readdirSync(dir), []);
  });

  it('sweeps nothing from a folder it cannot list', () => {
    const blind: Effects = {
      ...effects([]),
      list: () => {
        throw new Error('ENOENT');
      },
    };
    assert.doesNotThrow(() => sweepMarkers('/none', blind));
  });
});

describe('the live effects', () => {
  it('read text, write, rename and remove files, and tell the time', () => {
    const dir = scratch();
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    liveEffects.write(a, 'x\n');
    assert.equal(readText(a), 'x\n');
    liveEffects.rename(a, b);
    assert.equal(existsSync(a), false);
    liveEffects.remove(b);
    assert.equal(existsSync(b), false);
    assert.doesNotThrow(() => liveEffects.remove(b));
    assert.equal(liveEffects.probe, defaultProbe);
    assert.equal(liveEffects.read, readText);
    assert.equal(liveEffects.list, listDir);
    const before = Date.now();
    assert.ok(liveEffects.now().getTime() >= before);
  });
});

describe('main', () => {
  for (const args of [[], ['write'], ['write', '/d'], ['write', '/d', 'x'], ['write', '/d', '1'], ['read', '/d', '42'], ['write', '', '42']]) {
    it(`prints the usage for ${JSON.stringify(args)}`, () => {
      const w = warnings();
      assert.equal(main(args, effects([]), w.warn), 2);
      assert.deepEqual(w.lines, ['usage: push-marker write|clear <git-dir> <pid>']);
    });
  }

  it('writes and clears', () => {
    const dir = scratch();
    const w = warnings();
    assert.equal(main(['write', dir, '42'], effects([42]), w.warn), 0);
    assert.equal(existsSync(join(dir, markerName(42))), true);
    assert.equal(main(['clear', dir, '42'], effects([42]), w.warn), 0);
    assert.equal(existsSync(join(dir, markerName(42))), false);
    assert.deepEqual(w.lines, []);
  });

  it('warns and exits 1 when it cannot write', () => {
    const w = warnings();
    assert.equal(main(['write', '/d', '42'], effects([]), w.warn), 1);
    assert.deepEqual(w.lines, ['push marker: could not write (no process 42)']);
  });

  for (const [name, thrown, said] of [
    ['a thrown non-error', 'busy', 'busy'],
    ['an error with no message', new TypeError(''), 'TypeError'],
    ['an error with neither message nor name', Object.assign(new Error(''), { name: '' }), 'Error'],
    [
      'a value that cannot be described',
      { toString: (): string => { throw new Error('hostile'); } },
      '[unprintable error]',
    ],
  ] as const) {
    it(`names ${name}`, () => {
      const w = warnings();
      const failing: Effects = {
        ...effects([42]),
        remove: () => {
          throw thrown;
        },
      };
      assert.equal(main(['clear', '/d', '42'], failing, w.warn), 1);
      assert.deepEqual(w.lines, [`push marker: could not clear (${said})`]);
    });
  }

  it('runs as a CLI subcommand: writes for a live pid, then clears', () => {
    const dir = scratch();
    const cli = join(import.meta.dirname, 'cli.ts');
    const env = { ...process.env, NODE_NO_WARNINGS: '1' };
    const write = spawnSync(process.execPath, [cli, 'push-marker', 'write', dir, String(process.pid)], {
      encoding: 'utf8',
      env,
    });
    assert.equal(write.status, 0, write.stderr);
    const marker = join(dir, markerName(process.pid));
    assert.equal(parseRun(readFileSync(marker, 'utf8'))?.pid, process.pid);
    const clear = spawnSync(process.execPath, [cli, 'push-marker', 'clear', dir, String(process.pid)], {
      encoding: 'utf8',
      env,
    });
    assert.equal(clear.status, 0);
    assert.equal(existsSync(marker), false);
    const usage = spawnSync(process.execPath, [cli, 'push-marker'], { encoding: 'utf8', env });
    assert.equal(usage.status, 2);
    assert.equal(usage.stderr, 'usage: push-marker write|clear <git-dir> <pid>\n');
  });
});
