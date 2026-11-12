// The CLI of absolute-paths, non-synced-resources and aggregate-gate-needs:
// what each reads, what it prints, and its exit codes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run } from './cli.ts';

const temps: string[] = [];
/** A fresh temporary directory, removed when this file's tests end. */
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const capture = (stdin?: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), ...(stdin === undefined ? {} : { stdin: () => stdin }) };
  return { io, out, err };
};

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

/** A folder with these files written, a git repository when `tracked`; its real path. */
const tree = (files: Record<string, string>, tracked = true): string => {
  const root = realpathSync(temp('pariksha-cli-docs-'));
  if (tracked) git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  if (tracked) git(root, 'add', '-A');
  return root;
};

const run0 = (args: string[], stdin?: string) => {
  const c = capture(stdin);
  const code = run(args, c.io, '0');
  assert.equal(typeof code, 'number');
  return { code: code as number, out: c.out, err: c.err };
};

const DOC_CLEAN = 'Plain documentation.\n';
const DOC_VIOLATION = 'Read /Users/fixture/private.txt for details.\n';

describe('run absolute-paths', () => {
  const docs = () => tree({ 'src/staged.md': DOC_VIOLATION, 'src/clean.md': DOC_CLEAN, 'src/order history/violation.md': DOC_VIOLATION, '-violation.md': DOC_VIOLATION, '-clean.md': DOC_CLEAN, 'notes.txt': DOC_VIOLATION });

  it('fails on a selected violation and names the file', () => {
    const r = run0(['absolute-paths', '--root', docs(), '--files-from', '-'], 'src/staged.md\n');
    assert.equal(r.code, 1);
    assert.ok(r.out.includes('src/staged.md:1:Read /Users/fixture/private.txt for details.'));
    assert.ok(r.out.includes('❌ Error: Absolute paths or local file references found:'));
  });

  it('reads every listed path, spaces and leading dashes kept', () => {
    const r = run0(['absolute-paths', '--root', docs(), '--files-from', '-'], 'src/clean.md\nsrc/order history/violation.md\n-violation.md\n');
    assert.equal(r.code, 1);
    assert.ok(r.out.includes('   Checking 3 documentation file(s)...'));
    assert.deepEqual(
      r.out.filter((l) => l.includes(':1:')),
      ['src/order history/violation.md:1:Read /Users/fixture/private.txt for details.', '-violation.md:1:Read /Users/fixture/private.txt for details.'],
    );
  });

  it('checks only a selected clean file', () => {
    const r = run0(['absolute-paths', '--root', docs(), '--files-from', '-'], '-clean.md\n');
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, ['→ Checking for absolute paths in documentation...', '   Checking 1 documentation file(s)...', '✅ No absolute paths found in documentation']);
  });

  it('checks a listed file git ignores', () => {
    const root = docs();
    writeFileSync(join(root, '.gitignore'), '-ignored.md\n');
    writeFileSync(join(root, '-ignored.md'), DOC_VIOLATION);
    const r = run0(['absolute-paths', '--root', root, '--files-from', '-'], '-ignored.md\n-clean.md\n');
    assert.equal(r.code, 1);
    assert.ok(r.out.includes('   Checking 2 documentation file(s)...'));
    assert.ok(r.out.some((l) => l.startsWith('-ignored.md:1:')));
  });

  it('drops a listed path that is not a file, or not a document', () => {
    const r = run0(['absolute-paths', '--root', docs(), '--files-from', '-'], 'src/missing.md\nnotes.txt\n');
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, ['→ Checking for absolute paths in documentation...', '✅ No documentation files to check.']);
  });

  it('reads every tracked document with no list, and a list from a file', () => {
    const root = docs();
    const all = run0(['absolute-paths', '--root', root]);
    assert.equal(all.code, 1);
    assert.ok(all.out.includes('   Checking 5 documentation file(s)...'));
    writeFileSync(join(root, 'list.txt'), 'src/clean.md\n');
    assert.equal(run0(['absolute-paths', '--root', root, '--files-from', join(root, 'list.txt')]).code, 0);
  });

  it('prints the config’s guidance and reads its include', () => {
    const root = tree({ 'a.rst': DOC_VIOLATION, 'cfg.json': JSON.stringify({ include: '\\.rst$', guidance: ['See the guide.'] }) });
    const r = run0(['absolute-paths', '--root', root, '--config', 'cfg.json']);
    assert.equal(r.code, 1);
    assert.deepEqual(r.out.slice(-3), ['a.rst:1:Read /Users/fixture/private.txt for details.', '', 'See the guide.']);
  });

  it('exits 2 on a bad config, an unreadable list, or no repository to list', () => {
    const root = tree({ 'bad.json': '{"nope": 1}' });
    const bad = run0(['absolute-paths', '--root', root, '--config', 'bad.json']);
    assert.equal(bad.code, 2);
    assert.deepEqual(bad.err, ['pariksha absolute-paths: unknown key "nope"; nothing was checked, so this is not a pass']);
    const list = run0(['absolute-paths', '--root', root, '--files-from', join(root, 'absent.txt')]);
    assert.equal(list.code, 2);
    assert.match(list.err[0] ?? '', /ENOENT.*nothing was checked, so this is not a pass$/);
    const outside = run0(['absolute-paths', '--root', tree({}, false)]);
    assert.equal(outside.code, 2);
    assert.match(outside.err[0] ?? '', /git ls-files -z failed/);
  });

  it('needs no repository when given a list', () => {
    const root = tree({ 'a.md': DOC_VIOLATION }, false);
    assert.equal(run0(['absolute-paths', '--root', root, '--files-from', '-'], 'a.md\n').code, 1);
  });
});

describe('run non-synced-resources', () => {
  const docs = () =>
    tree({
      'docs/target.md': '# Target\n',
      'docs/links.md': '# Links\n\nSee [the target](./target.md "title") and [the site](https://example.com).\n',
      'docs/ghost.md.txt': '',
      'docs/broken.md': '# Links\n\nSee [a ghost](./ghost.md).\n',
      'docs/with space.md': '# Spaced\n',
      'docs/lower.md': '# Lower\n',
      'docs/forms.md': '# Forms\n\nSee [spaced](<./with space.md> "title").\n',
      'docs/cased.md': '# Forms\n\nSee [lower](./LOWER.md).\n',
      'docs/dirs.md': '# Dirs\n\nSee [here](./) and [up](../).\n',
    });

  it('selects exactly the listed document', () => {
    const r = run0(['non-synced-resources', '--root', docs(), '--files-from', '-'], 'docs/links.md\n');
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, ['→ Checking for non-synced resource references...', '   Checking 1 documentation file(s)...', '✅ All resource references are valid']);
  });

  it('follows ordinary links, and refuses a ghost', () => {
    const root = docs();
    const r = run0(['non-synced-resources', '--root', root, '--files-from', '-'], 'docs/broken.md\n');
    assert.equal(r.code, 1);
    assert.ok(r.out.some((l) => /ghost\.md/.test(l)));
    assert.deepEqual(r.out.slice(-2), ['', 'Please ensure all referenced files exist in the repository.']);
  });

  it('reads angle-bracket destinations, and refuses a wrongly cased link', () => {
    const root = docs();
    assert.equal(run0(['non-synced-resources', '--root', root, '--files-from', '-'], 'docs/forms.md\n').code, 0);
    const r = run0(['non-synced-resources', '--root', root, '--files-from', '-'], 'docs/cased.md\n');
    assert.equal(r.code, 1);
    assert.ok(r.out.some((l) => /LOWER\.md/.test(l)));
    assert.ok(r.out.some((l) => /case differs|non-existent file/.test(l)));
  });

  it('accepts links to ./ and ../', () => {
    assert.equal(run0(['non-synced-resources', '--root', docs(), '--files-from', '-'], 'docs/dirs.md\n').code, 0);
  });

  it('reads documents named by absolute path, and every tracked one with no list', () => {
    const root = docs();
    const abs = run0(['non-synced-resources', '--root', root, '--files-from', '-'], `${join(root, 'docs/broken.md')}\n`);
    assert.equal(abs.code, 1);
    assert.ok(abs.out.includes(`❌ Error: Reference to non-existent file in ${join(root, 'docs/broken.md')}:`));
    const all = run0(['non-synced-resources', '--root', root]);
    assert.equal(all.code, 1);
    assert.ok(all.out.includes('   Checking 8 documentation file(s)...'));
  });

  it('prints the config’s guidance', () => {
    const root = tree({ 'a.md': '[g](g.md)\n', 'cfg.json': JSON.stringify({ guidance: ['fix it', 'see the rules'] }) });
    assert.deepEqual(run0(['non-synced-resources', '--root', root, '--config', 'cfg.json']).out.slice(-2), ['fix it', 'see the rules']);
  });

  it('passes an empty list anywhere, and exits 2 outside a repository when there is a document', () => {
    const outside = tree({ 'a.md': '[g](g.md)\n' }, false);
    assert.equal(run0(['non-synced-resources', '--root', outside, '--files-from', '-'], '').code, 0);
    const r = run0(['non-synced-resources', '--root', outside, '--files-from', '-'], 'a.md\n');
    assert.equal(r.code, 2);
    assert.deepEqual(r.err, [`pariksha non-synced-resources: ${outside} is not in a git repository; nothing was checked, so this is not a pass`]);
  });
});

describe('run aggregate-gate-needs', () => {
  const workflows = (files: Record<string, string>) => tree(Object.fromEntries(Object.entries(files).map(([name, body]) => [`.github/workflows/${name}`, body])), false);

  it('passes complete gates and refuses a gap, worded with the config’s id', () => {
    const root = workflows({ 'ci.yml': 'jobs:\n  setup: {}\n  lint: {}\n  ci-gate:\n    name: CI Gate\n    needs: [setup]\n' });
    writeFileSync(join(root, 'gate.json'), JSON.stringify({ id: 'CI-1' }));
    const r = run0(['aggregate-gate-needs', '--root', root, '--config', 'gate.json']);
    assert.equal(r.code, 1);
    assert.deepEqual(r.err.slice(0, 3), ['\n❌ CI-1: 1 aggregate gate(s) with an incomplete needs list\n', ' .github/workflows/ci.yml → job "ci-gate"', '   not depended on: lint\n']);
    const ok = workflows({ 'ci.yml': 'jobs:\n  setup: {}\n  ci-gate:\n    needs: [setup]\n' });
    const p = run0(['aggregate-gate-needs', '--root', ok]);
    assert.equal(p.code, 0);
    assert.deepEqual(p.out, ['✅ aggregate-gate-needs: every aggregate gate depends on all its jobs (1 workflow(s))']);
  });

  it('exits 1 with no workflows, as the original did, and 2 on a bad config', () => {
    const root = tree({ 'bad.json': '{"gateName": "("}' }, false);
    const none = run0(['aggregate-gate-needs', '--root', root]);
    assert.equal(none.code, 1);
    assert.deepEqual(none.err, ['❌ aggregate-gate-needs: no workflow files found — the lookup failed']);
    const bad = run0(['aggregate-gate-needs', '--root', root, '--config', 'bad.json']);
    assert.equal(bad.code, 2);
    assert.match(bad.err[0] ?? '', /^pariksha aggregate-gate-needs: "gateName" is not a regex: .*; nothing was checked, so this is not a pass$/);
  });

  it('refuses an unknown flag with the usage', () => {
    const r = run0(['aggregate-gate-needs', '--files-from', '-']);
    assert.equal(r.code, 2);
    assert.match(r.err[0] ?? '', /^usage: /);
    assert.ok(r.err[0]?.includes('pariksha aggregate-gate-needs [--config <file>] [--root <dir>]'));
  });
});
