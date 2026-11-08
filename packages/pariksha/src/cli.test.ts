import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { hash } from './boundary.ts';
import { DENY_FILE, ownVersion, run, trackedFiles } from './cli.ts';

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
};

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

/** A git repository with these files tracked. */
const repo = (files: Record<string, string | Uint8Array>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-'));
  git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  git(root, 'add', '-A');
  return root;
};

const DENY = `${hash('acme')}\n`;

describe('trackedFiles', () => {
  it('lists tracked text files, skipping binary and deleted ones', () => {
    const root = repo({ 'a.txt': 'hello', 'b.bin': new Uint8Array([1, 0, 2]), 'c.txt': 'gone' });
    rmSync(join(root, 'c.txt'));
    writeFileSync(join(root, 'untracked.txt'), 'acme');
    assert.deepEqual(trackedFiles(root), [{ path: 'a.txt', text: 'hello' }]);
  });
});

describe('run boundary', () => {
  it('passes a clean repository', () => {
    const c = capture();
    const root = repo({ [DENY_FILE]: DENY, 'README.md': 'clean\n' });
    assert.equal(run(['boundary', '--root', root], c.io, '0.1.0'), 0);
    assert.deepEqual(c.out, ['pariksha boundary: 2 files, none names a denied word (1 on the list)']);
  });

  it('refuses a file or path naming a denied word', () => {
    const c = capture();
    const root = repo({ [DENY_FILE]: DENY, 'docs/acme.md': 'clean\nfor Acme\n' });
    assert.equal(run(['boundary', '--root', root], c.io, '0.1.0'), 1);
    assert.deepEqual(c.err, [
      'pariksha boundary: docs/acme.md (its path): "acme" is on the deny list',
      'pariksha boundary: docs/acme.md:2: "acme" is on the deny list',
    ]);
  });

  it('reads a deny list named by --deny, relative to the root', () => {
    const c = capture();
    const root = repo({ 'lists/deny.txt': DENY, 'a.md': 'acme' });
    assert.equal(run(['boundary', '--root', root, '--deny', 'lists/deny.txt'], c.io, '0.1.0'), 1);
  });

  it('checks the current directory without --root', () => {
    const c = capture();
    const before = process.cwd();
    process.chdir(repo({ [DENY_FILE]: DENY }));
    try {
      assert.equal(run(['boundary'], c.io, '0.1.0'), 0);
    } finally {
      process.chdir(before);
    }
  });

  it('stops on a missing or broken deny list', () => {
    const missing = capture();
    assert.equal(run(['boundary', '--root', repo({ 'a.md': 'x' })], missing.io, '0.1.0'), 2);
    assert.match(missing.err[0] ?? '', /no deny list at/);
    const broken = capture();
    assert.equal(run(['boundary', '--root', repo({ [DENY_FILE]: 'acme\n' })], broken.io, '0.1.0'), 2);
    assert.match(broken.err[0] ?? '', /not a SHA-256 hash/);
  });

  it('refuses bad flags with the usage', () => {
    for (const args of [['--root'], ['--root', ''], ['--dir', 'x'], ['--root', 'a', '--root', 'b']]) {
      const c = capture();
      assert.equal(run(['boundary', ...args], c.io, '0.1.0'), 2);
      assert.match(c.err[0] ?? '', /^usage: pariksha authority-citations/);
    }
  });
});

describe('run, other commands', () => {
  it('prints the version and a hash', () => {
    const v = capture();
    assert.equal(run(['--version'], v.io, '1.2.3'), 0);
    assert.deepEqual(v.out, ['1.2.3']);
    const h = capture();
    assert.equal(run(['hash', 'Acme'], h.io, '1.2.3'), 0);
    assert.deepEqual(h.out, [hash('acme')]);
  });

  it('refuses anything else with the usage', () => {
    for (const args of [[], ['lint'], ['hash'], ['hash', ''], ['hash', 'a', 'b'], ['--version', 'x'], ['constructor'], ['toString']]) {
      const c = capture();
      assert.equal(run(args, c.io, '1.2.3'), 2);
      assert.match(c.err[0] ?? '', /^usage: pariksha authority-citations/);
    }
  });
});

describe('ownVersion and the command', () => {
  it('reads package.json and runs as a script', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
    assert.equal(ownVersion(), pkg.version);
    const cli = join(import.meta.dirname, 'cli.ts');
    assert.equal(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim(), pkg.version);
    assert.throws(() => execFileSync(process.execPath, [cli, 'nope'], { stdio: 'pipe' }), { status: 2 });
  });
});

describe('run doc-budgets', () => {
  const RULE = '# r\n\n## Budgets\n\n| Doc | Budget |\n| --- | --: |\n| `a.md` | 5 |\n| `rule.md` | 500 |\n';

  it('passes and refuses by size, relative to the root', () => {
    const ok = capture();
    const root = repo({ 'rule.md': RULE, 'a.md': 'abc' });
    assert.equal(run(['doc-budgets', '--root', root, '--table', 'rule.md'], ok.io, '0'), 0);
    assert.deepEqual(ok.out, ['pariksha doc-budgets: a.md 3 / 5 bytes', `pariksha doc-budgets: rule.md ${RULE.length} / 500 bytes`]);
    const over = capture();
    writeFileSync(join(root, 'a.md'), 'abcdef');
    assert.equal(run(['doc-budgets', '--root', root, '--table', 'rule.md'], over.io, '0'), 1);
    assert.deepEqual(over.err, ['pariksha doc-budgets: a.md is 6 bytes, over its budget of 5; cut it']);
  });

  it('names the table by its path under the root when it misses its own row', () => {
    const root = repo({ 'docs/rule.md': RULE, 'a.md': 'abc' });
    const c = capture();
    assert.equal(run(['doc-budgets', '--root', root, '--table', 'docs/rule.md'], c.io, '0'), 1);
    assert.match(c.err[0] ?? '', /^pariksha doc-budgets: docs\/rule.md sets budgets but has no row for itself/);
  });

  it('reads another section by --section, and a directory is not a file', () => {
    const root = repo({ 'rule.md': RULE.replace('Budgets', 'Sizes'), 'a.md/x': '' });
    const c = capture();
    assert.equal(run(['doc-budgets', '--root', root, '--table', 'rule.md', '--section', 'Sizes'], c.io, '0'), 1);
    assert.deepEqual(c.err, ['pariksha doc-budgets: a.md has a budget but does not exist']);
  });

  it('needs --table naming a file', () => {
    const c = capture();
    assert.equal(run(['doc-budgets'], c.io, '0'), 2);
    assert.match(c.err[0] ?? '', /^usage:/);
    const missing = capture();
    assert.equal(run(['doc-budgets', '--table', 'nope.md', '--root', repo({})], missing.io, '0'), 2);
    assert.match(missing.err[0] ?? '', /no budget table at/);
  });
});

describe('run export-deletions', () => {
  const commit = (root: string, ...args: string[]) =>
    git(root, '-c', 'user.email=a@example.com', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-q', ...args);

  const work = (): string => {
    const root = repo({ 'a.ts': 'export const gone = 1;\n' });
    commit(root, '-m', 'base');
    git(root, 'branch', '-M', 'main');
    git(root, 'checkout', '-q', '-b', 'work');
    writeFileSync(join(root, 'a.ts'), 'export const kept = 1;\n');
    commit(root, '-am', 'drop');
    return root;
  };

  it('refuses an undeclared removal against the found base', () => {
    const c = capture();
    assert.equal(run(['export-deletions', '--root', work()], c.io, '0'), 1);
    assert.ok(c.err.includes('  gone   (removed from a.ts)'));
  });

  it('compares with --base, and stops when it names no commit', () => {
    const root = work();
    const same = capture();
    assert.equal(run(['export-deletions', '--root', root, '--base', 'work'], same.io, '0'), 0);
    const bad = capture();
    assert.equal(run(['export-deletions', '--root', root, '--base', 'nope'], bad.io, '0'), 2);
    assert.deepEqual(bad.err, ['pariksha export-deletions: --base nope names no commit']);
  });

  it('checks the whole repository from a subdirectory', () => {
    const root = work();
    mkdirSync(join(root, 'sub'));
    const c = capture();
    assert.equal(run(['export-deletions', '--root', join(root, 'sub')], c.io, '0'), 1);
    assert.ok(c.err.includes('  gone   (removed from a.ts)'));
  });

  it('stops outside a repository, and when git cannot read the branch', () => {
    const outside = capture();
    const dir = mkdtempSync(join(tmpdir(), 'pariksha-norepo-'));
    assert.equal(run(['export-deletions', '--root', dir], outside.io, '0'), 2);
    assert.match(outside.err[0] ?? '', /is not in a git repository$/);
    const root = work();
    git(root, 'checkout', '-q', '--orphan', 'unrelated');
    commit(root, '-m', 'no shared history');
    git(root, 'checkout', '-q', 'work');
    const failed = capture();
    assert.equal(run(['export-deletions', '--root', root, '--base', 'unrelated'], failed.io, '0'), 2);
    assert.match(failed.err[0] ?? '', /failed; nothing was checked, so this is not a pass$/);
  });

  it('stops with nothing to compare with, since that reads nothing', () => {
    const c = capture();
    const root = repo({ 'a.ts': '' });
    commit(root, '-m', 'only');
    git(root, 'branch', '-M', 'trunk');
    assert.equal(run(['export-deletions', '--root', root], c.io, '0'), 2);
    assert.deepEqual(c.err, ['pariksha export-deletions: none of origin/main, origin/develop, origin/master, main names a commit; fetch one or pass --base']);
  });
});
