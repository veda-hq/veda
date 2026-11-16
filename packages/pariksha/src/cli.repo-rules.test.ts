// The CLI of repo-rules: what it selects, the settings it reads, and its exit codes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { REPO_RULES, run } from './cli.ts';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Git with no user or system config, no maintenance and a fixed identity. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30_000,
    env: { PATH: process.env['PATH'] ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0' },
  });

const write = (root: string, files: Record<string, string | null>): void => {
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    if (body === null) rmSync(full);
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
  }
};

/** A repository with `files` committed on main; its real path. */
const repo = (files: Record<string, string>): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-cli-repo-rules-')));
  temps.push(root);
  git(root, 'init', '-q', '-b', 'main');
  write(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
};

const run0 = (args: string[], cwd?: string, stdin?: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, { out: (l) => out.push(l), err: (l) => err.push(l), ...(stdin === undefined ? {} : { stdin: () => stdin }), cwd: () => cwd ?? tmpdir() }, '0', {});
  assert.equal(typeof code, 'number');
  return { code: code as number, out, err };
};

const SLASH = 'on:\n  pull_request:\n    paths: ["/apps/**"]\njobs: {}\n';
const CLEAN = 'on:\n  pull_request:\n    paths: ["apps/**"]\njobs: {}\n';
const WF = '.github/workflows/ci.yml';

describe('run repo-rules', () => {
  it('judges every tracked file by default and with --all, printing the lesson once', () => {
    const root = repo({ [WF]: SLASH, 'README.md': 'x' });
    for (const args of [[], ['--all']]) {
      const r = run0(['repo-rules', '--root', root, ...args], root);
      assert.equal(r.code, 1, args.join(' '));
      assert.deepEqual(r.err.slice(0, 3), [`pariksha repo-rules: ${WF}:3: actions-path-leading-slash: on.pull_request.paths pattern "/apps/**" starts with "/"`, '', `actions-path-leading-slash: ${REPO_RULES[0]?.lesson}`]);
    }
    write(root, { [WF]: CLEAN });
    assert.deepEqual(run0(['repo-rules', '--root', root], root), { code: 0, out: [`pariksha repo-rules: 2 file(s), ${REPO_RULES.length} rule(s), nothing refused`], err: [] });
  });

  it('judges only the staged files with --staged, and sees a staged deletion a test still quotes', () => {
    const root = repo({ [WF]: SLASH, 'src/old.ts': 'export {};\n', 'src/wiring.test.ts': "assert.ok(existsSync('src/old.ts'));\n" });
    write(root, { 'src/new.ts': 'x\n' });
    git(root, 'add', 'src/new.ts');
    assert.equal(run0(['repo-rules', '--root', root, '--staged'], root).code, 0);
    git(root, 'rm', '-q', 'src/old.ts');
    const r = run0(['repo-rules', '--root', root, '--staged'], root);
    assert.equal(r.code, 1);
    assert.equal(r.err[0], 'pariksha repo-rules: src/wiring.test.ts:1: deleted-path-still-pinned: quotes src/old.ts, which this change deletes or renames');
  });

  it('judges a branch with --base, a rename counted as a removal', () => {
    const root = repo({ 'src/old.ts': 'export {};\n', 'src/wiring.test.ts': 'const p = "src/old.ts";\n' });
    git(root, 'checkout', '-q', '-b', 'work');
    git(root, 'mv', 'src/old.ts', 'src/moved.ts');
    git(root, 'commit', '-q', '-m', 'move');
    const r = run0(['repo-rules', '--root', root, '--base', 'main'], root);
    assert.equal(r.code, 1);
    assert.equal(r.err[0], 'pariksha repo-rules: src/wiring.test.ts:1: deleted-path-still-pinned: quotes src/old.ts, which this change deletes or renames');
    assert.equal(run0(['repo-rules', '--root', root, '--base', 'main', '--head', 'main'], root).code, 0);
    assert.equal(run0(['repo-rules', '--root', root, '--base', 'nope'], root).code, 2);
  });

  it('reads a --files-from list, relative to the root', () => {
    const root = repo({ [WF]: SLASH, 'a.md': 'x' });
    assert.equal(run0(['repo-rules', '--root', root, '--files-from', '-'], root, 'a.md\n').code, 0);
    assert.equal(run0(['repo-rules', '--root', root, '--files-from', '-'], root, `${WF}\n`).code, 1);
  });

  it('reads its settings from --config and from .pariksha.json, and refuses a stale allowance', () => {
    const root = repo({ [WF]: SLASH, 'off.json': JSON.stringify({ rules: { 'actions-path-leading-slash': { off: 'paths are checked elsewhere' } } }) });
    assert.equal(run0(['repo-rules', '--root', root, '--config', 'off.json'], root).code, 0);
    write(root, { '.pariksha.json': JSON.stringify({ checks: { 'repo-rules': { rules: { 'actions-path-leading-slash': { allow: { [WF]: 'a fixture of the mistake' } } } } } }) });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'settings');
    assert.equal(run0(['repo-rules', '--root', root], root).code, 0);
    write(root, { '.pariksha.json': JSON.stringify({ checks: { 'repo-rules': { rules: { 'actions-path-leading-slash': { allow: { 'gone.yml': 'x' } } } } } }) });
    assert.deepEqual(run0(['repo-rules', '--root', root], root), { code: 1, out: [], err: ['pariksha repo-rules: rules.actions-path-leading-slash.allow["gone.yml"] names a file git does not track; drop the stale allowance'] });
  });

  it('exits 2 when it cannot check: bad settings, no repository, two selections, an unknown flag', () => {
    const root = repo({ 'bad.json': '{ "rules": { "nope": {} } }' });
    const bad = run0(['repo-rules', '--root', root, '--config', 'bad.json'], root);
    assert.equal(bad.code, 2);
    assert.match(bad.err[0] ?? '', /^pariksha repo-rules: unknown rule "nope"; .*; nothing was checked, so this is not a pass$/);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-cli-no-git-')));
    temps.push(outside);
    assert.match(run0(['repo-rules', '--root', outside], outside).err[0] ?? '', /is not in a git repository; nothing was checked/);
    assert.equal(run0(['repo-rules', '--root', root, '--staged', '--all'], root).code, 2);
    const usage = run0(['repo-rules', '--nope', 'x'], root);
    assert.equal(usage.code, 2);
    assert.ok(usage.err[0]?.includes('pariksha repo-rules [--config <file>]'));
  });

  it('lists every rule id once', () => {
    const ids = REPO_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 16);
  });
});
