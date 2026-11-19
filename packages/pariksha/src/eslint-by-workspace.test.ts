import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run } from './cli.ts';
import { DEFAULT_CONFIG, eslintFor, groupFiles, inheritEslint, lintByWorkspace, owner, parseConfig, type EslintRunner } from './eslint-by-workspace.ts';

const temps: string[] = [];
/** A fresh temporary directory, by its real path, removed when this file's tests end. */
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-ebw-')));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const bin = (root: string, ws: string, script = '#!/bin/sh\nexit 0\n'): string => {
  const path = join(root, ws, 'node_modules/.bin/eslint');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
};
const ROUTES = { ...DEFAULT_CONFIG, routes: { 'apps/m/scripts/': '.', 'apps/m/scripts/keep.ts': 'apps/m', 'tools/x.ts': 'apps/w' } };

describe('parseConfig', () => {
  it('fills what is absent from the defaults', () => {
    assert.deepEqual(parseConfig('{}'), DEFAULT_CONFIG);
    assert.deepEqual(parseConfig('{"workspaces": ["libs"], "routes": {"a/": "."}}'), { workspaces: ['libs'], routes: { 'a/': '.' } });
  });
  it('refuses what it cannot read', () => {
    assert.throws(() => parseConfig('{'), /not JSON/);
    assert.throws(() => parseConfig('3'), /must be a JSON object/);
    assert.throws(() => parseConfig('{"route": {}}'), /unknown key "route"/);
    assert.throws(() => parseConfig('{"workspaces": ["a/b"]}'), /"workspaces" must be a list of folder names/);
    assert.throws(() => parseConfig('{"workspaces": "apps"}'), /"workspaces" must be a list/);
    assert.throws(() => parseConfig('{"routes": {"a": ""}}'), /"routes" must map paths/);
    assert.throws(() => parseConfig('{"routes": []}'), /"routes" must map paths/);
  });
});

describe('owner and groupFiles', () => {
  it('is the workspace folder holding a file, else the root', () => {
    assert.equal(owner(DEFAULT_CONFIG, 'apps/web/src/a.ts'), 'apps/web');
    assert.equal(owner(DEFAULT_CONFIG, 'packages/shared/x.ts'), 'packages/shared');
    assert.equal(owner(DEFAULT_CONFIG, 'apps/web'), '.');
    assert.equal(owner(DEFAULT_CONFIG, 'scripts/a.ts'), '.');
    assert.equal(owner(DEFAULT_CONFIG, 'libs/x/a.ts'), '.');
  });
  it('follows a route, the longest first; an exact route matches only that path', () => {
    assert.equal(owner(ROUTES, 'apps/m/scripts/a.ts'), '.');
    assert.equal(owner(ROUTES, 'apps/m/scripts/keep.ts'), 'apps/m');
    assert.equal(owner(ROUTES, 'apps/m/src/a.ts'), 'apps/m');
    assert.equal(owner(ROUTES, 'tools/x.ts'), 'apps/w');
    assert.equal(owner(ROUTES, 'tools/x.tsx'), '.');
  });
  it('groups in first-seen order, dropping ./ and repeats', () => {
    assert.deepEqual([...groupFiles(DEFAULT_CONFIG, ['./apps/a/x.ts', 'b.ts', 'apps/a/x.ts', '', 'apps/a/y.ts', '././c.ts'])], [
      ['apps/a', ['apps/a/x.ts', 'apps/a/y.ts']],
      ['.', ['b.ts', 'c.ts']],
    ]);
  });
});

describe('eslintFor', () => {
  it('is the workspace’s own ESLint, else the root’s, else none', () => {
    const root = temp();
    assert.equal(eslintFor(root, 'apps/a'), undefined);
    const rootBin = bin(root, '.');
    assert.equal(eslintFor(root, 'apps/a'), rootBin);
    const own = bin(root, 'apps/a');
    assert.equal(eslintFor(root, 'apps/a'), own);
    // A file that is not executable is no binary.
    writeFileSync(join(root, 'apps/a/node_modules/.bin/eslint'), '');
    chmodSync(join(root, 'apps/a/node_modules/.bin/eslint'), 0o644);
    assert.equal(eslintFor(root, 'apps/a'), rootBin);
  });
});

const recorder = (status: (cwd: string) => number | null = () => 0) => {
  const calls: { bin: string; args: readonly string[]; cwd: string }[] = [];
  const runner: EslintRunner = (b, args, cwd) => {
    calls.push({ bin: b, args, cwd });
    const s = status(cwd);
    return s === null ? { status: null, error: new Error('spawn failed') } : { status: s };
  };
  return { calls, runner };
};

const sink = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

describe('lintByWorkspace', () => {
  it('runs each group with its own ESLint from its folder, paths relative to it', () => {
    const root = temp();
    const rootBin = bin(root, '.');
    const webBin = bin(root, 'apps/w');
    const { calls, runner } = recorder();
    const s = sink();
    assert.equal(lintByWorkspace(root, ROUTES, ['apps/w/src/a.ts', 'top.ts', 'apps/m/scripts/a.ts', 'tools/x.ts'], ['--max-warnings=0', '--cache'], runner, s.io), 0);
    assert.deepEqual(calls, [
      { bin: webBin, args: ['--no-warn-ignored', '--max-warnings=0', '--cache', 'src/a.ts', '../../tools/x.ts'], cwd: join(root, 'apps/w') },
      { bin: rootBin, args: ['--no-warn-ignored', '--max-warnings=0', '--cache', 'top.ts', 'apps/m/scripts/a.ts'], cwd: root },
    ]);
    assert.deepEqual(s.out, ['✅ ESLint passed (4 file(s), routed per workspace)']);
  });

  it('passes nothing to check', () => {
    const s = sink();
    assert.equal(lintByWorkspace(temp(), DEFAULT_CONFIG, ['', './'], [], recorder().runner, s.io), 0);
    assert.deepEqual(s.out, ['✅ ESLint: no files to check']);
  });

  it('fails when any group fails, has no ESLint, or cannot start, and still runs the rest', () => {
    const root = temp();
    bin(root, 'apps/a');
    bin(root, 'apps/b');
    const { calls, runner } = recorder((cwd) => (cwd.endsWith('apps/a') ? 1 : cwd.endsWith('apps/b') ? null : 0));
    const s = sink();
    assert.equal(lintByWorkspace(root, DEFAULT_CONFIG, ['apps/a/x.ts', 'apps/b/x.ts', 'x.ts'], [], runner, s.io), 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(s.err, ['❌ ESLint failed in apps/a', '❌ ESLint could not run in apps/b: spawn failed', '❌ ESLint: no eslint binary for .']);
    assert.deepEqual(s.out, []);
  });

  it('runs a real binary on this process’s streams', () => {
    const root = temp();
    bin(root, '.', '#!/bin/sh\n[ "$1" = --no-warn-ignored ] && [ "$2" = a.ts ] && exit 0\nexit 3\n');
    assert.equal(lintByWorkspace(root, DEFAULT_CONFIG, ['a.ts'], [], inheritEslint, sink().io), 0);
    bin(root, '.', '#!/bin/sh\nexit 3\n');
    assert.equal(lintByWorkspace(root, DEFAULT_CONFIG, ['a.ts'], [], inheritEslint, sink().io), 1);
  });
});

describe('pariksha eslint-by-workspace', () => {
  const capture = (cwd: string, runner: EslintRunner, stdin = '') => {
    const s = sink();
    return { ...s, io: { ...s.io, cwd: () => cwd, eslintRunner: runner, stdin: () => stdin } };
  };

  it('takes files as words and from --files-from, and passes what follows -- to ESLint', () => {
    const root = temp();
    bin(root, '.');
    const { calls, runner } = recorder();
    const c = capture(root, runner, 'b.ts\nc.ts\n');
    assert.equal(run(['eslint-by-workspace', '--root', root, 'a.ts', '--files-from', '-', '--', '--max-warnings=0', '--format=x'], c.io, '1.0.0', {}), 0);
    assert.deepEqual(calls[0]?.args, ['--no-warn-ignored', '--max-warnings=0', '--format=x', 'a.ts', 'b.ts', 'c.ts']);
  });

  it('reads paths from the checkout’s top level when run from a workspace folder', () => {
    const root = temp();
    execFileSync('git', ['init', '-q'], { cwd: root });
    bin(root, 'apps/w');
    mkdirSync(join(root, 'apps/w/src'), { recursive: true });
    const { calls, runner } = recorder();
    assert.equal(run(['eslint-by-workspace', 'apps/w/src/a.ts'], capture(join(root, 'apps/w/src'), runner).io, '1.0.0', {}), 0);
    assert.deepEqual(calls[0] && { cwd: calls[0].cwd, file: calls[0].args.at(-1) }, { cwd: join(root, 'apps/w'), file: 'src/a.ts' });
  });

  it('reads its routes from .pariksha.json', () => {
    const root = temp();
    bin(root, '.');
    writeFileSync(join(root, '.pariksha.json'), JSON.stringify({ checks: { 'eslint-by-workspace': { routes: { 'apps/m/scripts/': '.' } } } }));
    const { calls, runner } = recorder();
    assert.equal(run(['eslint-by-workspace', '--root', root, 'apps/m/scripts/a.ts'], capture(root, runner).io, '1.0.0', {}), 0);
    assert.equal(calls[0]?.cwd, root);
  });

  it('needs a file or a list, and refuses a bad flag, config or list', () => {
    const root = temp();
    for (const args of [[], ['--', 'x.ts'], ['--root'], ['--dir', 'x', 'a.ts']]) {
      const c = capture(root, recorder().runner);
      assert.equal(run(['eslint-by-workspace', ...args], c.io, '1.0.0', {}), 2);
      assert.match(c.err[0] ?? '', /^usage:/);
    }
    writeFileSync(join(root, 'bad.json'), '{"x": 1}');
    const bad = capture(root, recorder().runner);
    assert.equal(run(['eslint-by-workspace', '--root', root, '--config', 'bad.json', 'a.ts'], bad.io, '1.0.0', {}), 2);
    assert.match(bad.err[0] ?? '', /unknown key "x"; nothing was checked/);
    const list = capture(root, recorder().runner);
    assert.equal(run(['eslint-by-workspace', '--root', root, '--files-from', join(root, 'none.txt')], list.io, '1.0.0', {}), 2);
    assert.match(list.err[0] ?? '', /ENOENT/);
    writeFileSync(join(root, '.pariksha.json'), '{"checks": {"nope": {}}}');
    const cfg = capture(root, recorder().runner);
    assert.equal(run(['eslint-by-workspace', '--root', root, 'a.ts'], cfg.io, '1.0.0', {}), 2);
    assert.match(cfg.err[0] ?? '', /unknown check "nope"/);
  });
});
