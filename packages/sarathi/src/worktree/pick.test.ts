import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { main } from '../cli.ts';
import { chosen, parsePorcelain, pickMain, SHELL_FUNCTION, SHELL_HELP, type PickIo } from './pick.ts';

const scratchDirs: string[] = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });

/** A repository with one linked worktree whose path has a space in it. */
function repository(): { root: string; linked: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sarathi-pick-')));
  scratchDirs.push(base);
  const root = join(base, 'main');
  execFileSync('mkdir', ['-p', root]);
  git(root, 'init', '-q', '-b', 'main');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'start');
  const linked = join(base, 'with space');
  git(root, 'worktree', 'add', '-q', '-b', 'side', linked);
  return { root, linked };
}

interface Seen {
  out: string;
  err: string;
  prompts: string[];
}

function io(cwd: string, answer: string): { io: PickIo; seen: Seen } {
  const seen: Seen = { out: '', err: '', prompts: [] };
  return {
    seen,
    io: {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      out: text => {
        seen.out += text;
      },
      err: text => {
        seen.err += text;
      },
      ask: prompt => {
        seen.prompts.push(prompt);
        return Promise.resolve(answer);
      },
    },
  };
}

/** `--porcelain -z` output: each field ends in NUL, each record in one more. */
const z = (...records: string[][]): string => records.map(fields => `${fields.join('\0')}\0\0`).join('');

describe('parsePorcelain', () => {
  it('keeps each path whole, with its short head and branch, a detached one named so', () => {
    const listed = parsePorcelain(
      z(['worktree /a/main', 'HEAD 0123456789abcdef', 'branch refs/heads/main'], ['worktree /a/with space', 'HEAD fedcba9876543210', 'detached'], ['worktree /a/new\nline', 'HEAD 0000000000', 'detached'], ['worktree /a/bare', 'bare']),
    );
    assert.deepEqual(listed, [
      { path: '/a/main', row: '/a/main  0123456 [main]' },
      { path: '/a/with space', row: '/a/with space  fedcba9 [detached]' },
      { path: '/a/new\nline', row: '/a/new\nline  0000000 [detached]' },
      { path: '/a/bare', row: '/a/bare   []' },
    ]);
  });

  it('leaves out a worktree whose folder is gone', () => {
    const listed = parsePorcelain(
      z(['worktree /a/main', 'HEAD abc', 'branch refs/heads/main'], ['worktree /a/gone', 'HEAD def', 'detached', 'prunable gitdir file points to non-existent location'], ['worktree /a/also-gone', 'HEAD def', 'detached', 'prunable']),
    );
    assert.deepEqual(listed, [{ path: '/a/main', row: '/a/main  abc [main]' }]);
  });

  it('reads the last record without its closing NUL, and nothing from empty output', () => {
    assert.deepEqual(parsePorcelain('worktree /x\0HEAD abc\0branch refs/heads/b'), [{ path: '/x', row: '/x  abc [b]' }]);
    assert.deepEqual(parsePorcelain(''), []);
  });
});

describe('chosen', () => {
  const listed = parsePorcelain(z(['worktree /one'], ['worktree /two']));

  it('takes a 1-based number, in base 10 even with a leading zero', () => {
    assert.equal(chosen(listed, '2')?.path, '/two');
    assert.equal(chosen(listed, ' 01 \n')?.path, '/one');
  });

  it('refuses words, signs, zero and numbers past the end', () => {
    for (const answer of ['', 'two', '-1', '1.5', '0', '3', '08x']) assert.equal(chosen(listed, answer), undefined, answer);
  });
});

describe('sarathi worktree pick', () => {
  it('lists the worktrees on stderr and prints only the chosen path', async () => {
    const { root, linked } = repository();
    const { io: pickIo, seen } = io(root, '2');
    assert.equal(await pickMain([], pickIo), 0);
    assert.equal(seen.out, `${linked}\n`);
    assert.match(seen.err, /^Worktrees:\n {2}1\) .*\/main {2}[0-9a-f]{7} \[main\]\n {2}2\) .*\/with space {2}[0-9a-f]{7} \[side\]\n$/);
    assert.deepEqual(seen.prompts, ['Pick a number: ']);
  });

  it('does not offer a worktree whose folder was deleted', async () => {
    const { root, linked } = repository();
    rmSync(linked, { recursive: true, force: true });
    const { io: pickIo, seen } = io(root, '2');
    assert.equal(await pickMain([], pickIo), 1);
    assert.equal(seen.out, '');
    assert.match(seen.err, /^Worktrees:\n {2}1\) .*\/main {2}[0-9a-f]{7} \[main\]\nInvalid selection\.\n$/);
  });

  it('exits 1 on an invalid choice, printing no path', async () => {
    const { root } = repository();
    const { io: pickIo, seen } = io(root, '9');
    assert.equal(await pickMain([], pickIo), 1);
    assert.equal(seen.out, '');
    assert.match(seen.err, /Invalid selection\.\n$/);
  });

  it('exits 1 outside a repository, asking nothing', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sarathi-pick-none-')));
    scratchDirs.push(outside);
    const { io: pickIo, seen } = io(outside, '1');
    assert.equal(await pickMain([], pickIo), 1);
    assert.match(seen.err, /^No worktrees found/);
    assert.deepEqual(seen.prompts, []);
  });

  it('prints the shell function with --shell, and the usage for anything else', async () => {
    const shell = io(tmpdir(), '');
    assert.equal(await pickMain(['--shell'], shell.io), 0);
    assert.equal(shell.seen.out, SHELL_HELP);
    assert.ok(SHELL_HELP.includes(SHELL_FUNCTION));
    const bad = io(tmpdir(), '');
    assert.equal(await pickMain(['--nope'], bad.io), 1);
    assert.equal(bad.seen.err, 'usage: sarathi worktree pick [--shell]\n');
  });

  it('runs from the CLI, answered by the first line of stdin when no prompt is wired', async () => {
    const { root, linked } = repository();
    let out = '';
    let err = '';
    const code = await main({
      argv: ['worktree', 'pick'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      cwd: root,
      readStdin: () => Promise.resolve('2\nignored\n'),
      out: text => {
        out += text;
      },
      err: text => {
        err += text;
      },
    });
    assert.equal(code, 0);
    assert.equal(out, `${linked}\n`);
    assert.ok(err.endsWith('Pick a number: '));
  });

  it('uses the prompt the CLI is given', async () => {
    const { root } = repository();
    let out = '';
    const code = await main({
      argv: ['worktree', 'pick'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      cwd: root,
      readStdin: () => Promise.reject(new Error('stdin is not read when a prompt is wired')),
      ask: () => Promise.resolve('1'),
      out: text => {
        out += text;
      },
      err: () => undefined,
    });
    assert.equal(code, 0);
    assert.equal(out, `${root}\n`);
  });
});
