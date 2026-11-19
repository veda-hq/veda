import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run } from './cli.ts';
import { gitAt } from './git.ts';
import { changedPaths, selectedList, selectionOf, settingsInputs } from './selection.ts';

// No detached auto-maintenance after a commit: it could write into a fixture as it is removed.
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();

const temps: string[] = [];
/** A fresh temporary directory, by its real path, removed when this file's tests end. */
const temp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const write = (root: string, files: Record<string, string>) => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
};

/** A repository whose main holds `files`, committed. */
const repo = (files: Record<string, string>): string => {
  const root = temp('pariksha-sel-');
  git(root, 'init', '-q', '-b', 'main');
  write(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base', '--allow-empty');
  return root;
};

const listed = (root: string, list: string): string[] => list.split('\0').filter(Boolean).map((p) => p.slice(root.length + 1)).sort();

describe('selectionOf', () => {
  const of = (entries: [string, string][]) => selectionOf(new Map(entries));
  it('reads one mode, a range defaulting to HEAD', () => {
    assert.equal(of([]), undefined);
    assert.deepEqual(of([['--staged', '']]), { kind: 'staged' });
    assert.deepEqual(of([['--all', '']]), { kind: 'all' });
    assert.deepEqual(of([['--base', 'main']]), { kind: 'range', base: 'main', head: 'HEAD' });
    assert.deepEqual(of([['--base', 'main'], ['--head', 'topic']]), { kind: 'range', base: 'main', head: 'topic' });
  });
  it('refuses two modes, and --head alone', () => {
    assert.deepEqual(of([['--staged', ''], ['--files-from', '-']]), { error: 'choose one of --staged, --base, --all, --files-from (got --staged, --files-from)' });
    assert.deepEqual(of([['--head', 'x']]), { error: '--head needs --base' });
  });
});

describe('changedPaths and selectedList', () => {
  it('lists staged additions, changes and renames by new path; never a deletion', () => {
    const root = repo({ 'keep.md': 'a', 'gone.md': 'b', 'old name.md': 'c' });
    write(root, { 'keep.md': 'changed', 'new file.md': 'n' });
    git(root, 'rm', '-q', 'gone.md');
    git(root, 'mv', 'old name.md', 'new name.md');
    git(root, 'add', '-A');
    assert.deepEqual(changedPaths(gitAt(root), { kind: 'staged' }).sort(), ['keep.md', 'new file.md', 'new name.md']);
  });

  it('lists a range from the merge base, so main’s later commits are not the branch’s', () => {
    const root = repo({ 'a.md': 'a' });
    git(root, 'checkout', '-q', '-b', 'topic');
    write(root, { 'topic.md': 't' });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'topic');
    git(root, 'checkout', '-q', 'main');
    write(root, { 'main-only.md': 'm' });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'main moves on');
    git(root, 'checkout', '-q', 'topic');
    assert.deepEqual(changedPaths(gitAt(root), { kind: 'range', base: 'main', head: 'HEAD' }), ['topic.md']);
  });

  it('refuses a ref that is an option or names no commit', () => {
    const root = repo({ 'a.md': 'a' });
    assert.throws(() => changedPaths(gitAt(root), { kind: 'range', base: '--output=x', head: 'HEAD' }), /--output=x is not a ref: it starts with a dash/);
    assert.throws(() => changedPaths(gitAt(root), { kind: 'range', base: 'no-such', head: 'HEAD' }), /no-such names no commit here/);
  });

  it('lists every tracked file for all, skipping a deleted file, a symlink and a submodule', () => {
    const root = repo({ 'a.md': 'a', 'b.md': 'b' });
    symlinkSync('a.md', join(root, 'link.md'));
    git(root, 'add', '-A');
    rmSync(join(root, 'b.md'));
    const sub = repo({ 'x.md': 'x' });
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub');
    assert.deepEqual(listed(root, selectedList(gitAt(root), root, { kind: 'all' }, [])), ['.gitmodules', 'a.md']);
  });

  it('lists every file when the selection changes the check’s own settings', () => {
    const root = repo({ 'a.md': 'a', 'b.md': 'b', 'cfg.json': '{}' });
    write(root, { 'cfg.json': '{"include": "x"}' });
    git(root, 'add', '-A');
    assert.deepEqual(listed(root, selectedList(gitAt(root), root, { kind: 'staged' }, [join(root, 'other.json')])), ['cfg.json']);
    assert.deepEqual(listed(root, selectedList(gitAt(root), root, { kind: 'staged' }, [join(root, 'cfg.json')])), ['a.md', 'b.md', 'cfg.json']);
  });

  it('has package.json stand in for settings git does not track', () => {
    const root = repo({ '.gitignore': 'node_modules/\n', 'cfg.json': '{}', 'package.json': '{}' });
    write(root, { 'node_modules/rules/cfg.json': '{}', 'untracked.json': '{}' });
    const outside = temp('pariksha-cfg-');
    const inputs = (settings: string) => settingsInputs(gitAt(root), root, settings);
    assert.deepEqual(inputs(join(root, 'cfg.json')), [join(root, 'cfg.json')]);
    assert.deepEqual(inputs(join(root, 'node_modules/rules/cfg.json')), [join(root, 'node_modules/rules/cfg.json'), join(root, 'package.json')]);
    assert.deepEqual(inputs(join(root, 'untracked.json')), [join(root, 'untracked.json'), join(root, 'package.json')]);
    assert.deepEqual(inputs(join(outside, 'cfg.json')), [join(outside, 'cfg.json'), join(root, 'package.json')]);
    // The top level itself, and the folder above it, are no tracked file either.
    assert.deepEqual(inputs(root), [root, join(root, 'package.json')]);
    assert.deepEqual(inputs(dirname(root)), [dirname(root), join(root, 'package.json')]);  });

  it('fails, never lists nothing, when git fails', () => {
    const outside = temp('pariksha-nogit-');
    assert.throws(() => changedPaths(gitAt(outside), { kind: 'staged' }), /git diff --cached .* failed/);
  });
});

const capture = (cwd: string) => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: () => cwd }, out, err };
};

const BAD = 'see /Users/someone/x\n';

describe('the selection, run by the checks that judge files', () => {
  it('absolute-paths --staged judges only the staged documents', () => {
    const root = repo({ 'old.md': BAD });
    write(root, { 'new.md': 'clean\n' });
    git(root, 'add', '-A');
    assert.equal(run(['absolute-paths', '--root', root, '--staged'], capture(root).io, '1.0.0', {}), 0);
    write(root, { 'new.md': BAD });
    git(root, 'add', '-A');
    assert.equal(run(['absolute-paths', '--root', root, '--staged'], capture(root).io, '1.0.0', {}), 1);
  });

  it('non-synced-resources --base judges what the branch changed', () => {
    const root = repo({ 'old.md': '[x](missing.md)\n' });
    git(root, 'checkout', '-q', '-b', 'topic');
    write(root, { 'new.md': '[y](old.md)\n' });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'topic');
    assert.equal(run(['non-synced-resources', '--root', root, '--base', 'main'], capture(root).io, '1.0.0', {}), 0);
    assert.equal(run(['non-synced-resources', '--root', root, '--all'], capture(root).io, '1.0.0', {}), 1);
  });

  it('a staged change to the check’s .pariksha.json entry judges every document', () => {
    const root = repo({ 'old.md': BAD, 'cfg/abs.json': '{"include": "^docs/"}', '.pariksha.json': '{"checks": {"absolute-paths": "cfg/abs.json"}}' });
    write(root, { 'cfg/abs.json': '{"include": "\\\\.md$"}' });
    git(root, 'add', '-A');
    const c = capture(root);
    assert.equal(run(['absolute-paths', '--root', root, '--staged'], c.io, '1.0.0', {}), 1);
  });

  /** Settings in an ignored dependency folder, as a shared package holds them. */
  const SHARED = { '.gitignore': 'node_modules/\n', 'old.md': BAD, 'package.json': '{"devDependencies": {"rules": "1.0.0"}}\n', '.pariksha.json': '{"checks": {"absolute-paths": "node_modules/rules/abs.json"}}' };
  const shared = (): string => {
    const root = repo(SHARED);
    write(root, { 'node_modules/rules/abs.json': '{"include": "\\\\.md$"}' });
    return root;
  };

  it('a pin bump stands for a change to settings git does not track, and judges every document', () => {
    const root = shared();
    write(root, { 'new.md': 'clean\n', 'package.json': '{"devDependencies": {"rules": "1.1.0"}}\n' });
    git(root, 'add', '-A');
    assert.equal(run(['absolute-paths', '--root', root, '--staged'], capture(root).io, '1.0.0', {}), 1);
  });

  it('untracked settings without a package.json change judge only the selection', () => {
    const root = shared();
    write(root, { 'new.md': 'clean\n' });
    git(root, 'add', '-A');
    assert.equal(run(['absolute-paths', '--root', root, '--staged'], capture(root).io, '1.0.0', {}), 0);
  });

  it('tracked settings are their own stand-in: a package.json change does not widen', () => {
    const root = repo({ 'old.md': BAD, 'package.json': '{}\n', 'cfg/abs.json': '{"include": "\\\\.md$"}', '.pariksha.json': '{"checks": {"absolute-paths": "cfg/abs.json"}}' });
    write(root, { 'new.md': 'clean\n', 'package.json': '{"private": true}\n' });
    git(root, 'add', '-A');
    assert.equal(run(['absolute-paths', '--root', root, '--staged'], capture(root).io, '1.0.0', {}), 0);
  });

  it('refuses two modes, and a selection outside a repository', () => {
    const root = repo({ 'a.md': 'a' });
    const two = capture(root);
    assert.equal(run(['absolute-paths', '--root', root, '--staged', '--all'], two.io, '1.0.0', {}), 2);
    assert.match(two.err[0] ?? '', /choose one of --staged, --base, --all, --files-from/);
    const outside = temp('pariksha-nogit-');
    const none = capture(outside);
    assert.equal(run(['absolute-paths', '--root', outside, '--staged'], none.io, '1.0.0', {}), 2);
    assert.match(none.err[0] ?? '', /is not in a git repository, so --staged, --base and --all have nothing to list/);
  });

  it('duplicate-tests and flaky-tests read the selection; --all is the whole tree', () => {
    const root = repo({ 'a.test.ts': "it('x', () => {});\n" });
    const dup = capture(root);
    assert.equal(run(['duplicate-tests', '--root', root, '--staged'], { ...dup.io, typescript: () => 'no typescript here' }, '1.0.0', {}), 2);
    assert.match(dup.err[0] ?? '', /no typescript here/);
    // Nothing is staged: flaky-tests has no file to run; --all names the tracked test.
    const staged = capture(root);
    assert.equal(run(['flaky-tests', '--root', root, '--staged', '--runs', '1'], staged.io, '1.0.0', {}), 0);
    assert.deepEqual(staged.out.slice(1), ['   Mode: files', 'No files found to analyze.']);
    const all = capture(root);
    const vitest = () => ({ status: 1, stdout: '', stderr: 'no vitest here', pid: 0, output: [], signal: null });
    run(['flaky-tests', '--root', root, '--all', '--runs', '1'], { ...all.io, vitest }, '1.0.0', {});
    assert.deepEqual(all.out.slice(1, 3), ['   Mode: all', '   Running on 1 files...']);
  });

  it('coverage-by-type --all over a tree with nothing in a category is no pass', () => {
    const root = repo({ 'a.txt': 'x' });
    const c = capture(root);
    assert.equal(run(['coverage-by-type', '--root', root, '--all'], c.io, '1.0.0', {}), 2);
    assert.match(c.err[0] ?? '', /is in a category; nothing was checked/);
    assert.equal(run(['coverage-by-type', '--root', root, '--staged'], capture(root).io, '1.0.0', {}), 0);
  });
});
