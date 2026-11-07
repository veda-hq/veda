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
      assert.match(c.err[0] ?? '', /^usage: pariksha boundary/);
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
    for (const args of [[], ['lint'], ['hash'], ['hash', ''], ['hash', 'a', 'b'], ['--version', 'x']]) {
      const c = capture();
      assert.equal(run(args, c.io, '1.2.3'), 2);
      assert.match(c.err[0] ?? '', /^usage: pariksha boundary/);
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
