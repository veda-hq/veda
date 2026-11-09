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

describe('run coverage-by-type', () => {
  const files = {
    'app/services/ok.ts': '',
    'app/services/ok.test.ts': "import './ok';",
    'app/services/bare.ts': '',
    'scripts/lib/tool.ts': '',
  };
  const withStdin = (text: string) => {
    const c = capture();
    return { ...c, io: { ...c.io, stdin: () => text } };
  };

  it('checks every tracked file by default, and refuses a gap', () => {
    const c = capture();
    const root = repo(files);
    assert.equal(run(['coverage-by-type', '--root', root], c.io, '0'), 1);
    assert.deepEqual(c.err.slice(0, 3), ['pariksha coverage-by-type: service (needs: unit tests)', '  app/services/bare.ts: missing unit', 'pariksha coverage-by-type: utility (needs: unit tests)']);
  });

  it('reads a config relative to the root and a file list from a file or stdin', () => {
    const root = repo({ ...files, 'cov.json': JSON.stringify({ exclude: ['^scripts/'], hint: 'see the rules' }) });
    const list = join(root, 'list.txt');
    writeFileSync(list, 'app/services/ok.ts\napp/services/bare.ts\n');
    const c = capture();
    assert.equal(run(['coverage-by-type', '--root', root, '--config', 'cov.json', '--files-from', list], c.io, '0'), 1);
    assert.deepEqual(c.err, ['pariksha coverage-by-type: service (needs: unit tests)', '  app/services/bare.ts: missing unit', '', 'pariksha coverage-by-type: 1 file(s) missing required tests. A suite counts only when it imports its subject at runtime.', 'see the rules']);
    const s = withStdin('app/services/ok.ts\0scripts/lib/tool.ts\0');
    assert.equal(run(['coverage-by-type', '--root', root, '--config', 'cov.json', '--files-from', '-'], s.io, '0'), 0);
    assert.deepEqual(s.out, ['pariksha coverage-by-type: 1 of 2 listed file(s) judged, each has the tests its category needs']);
    const empty = withStdin('');
    assert.equal(run(['coverage-by-type', '--root', root, '--files-from', '-'], empty.io, '0'), 0);
    assert.deepEqual(empty.out, ['pariksha coverage-by-type: 0 of 0 listed file(s) judged, each has the tests its category needs']);
  });

  it('exits 2 when the whole tree has nothing in a category, or a listed file is missing', () => {
    const root = repo({ 'README.md': '', 'cov.json': JSON.stringify({ categories: { lib: '/nowhere/' }, required: { lib: ['unit'] } }) });
    const c = capture();
    assert.equal(run(['coverage-by-type', '--root', root, '--config', 'cov.json'], c.io, '0'), 2);
    assert.deepEqual(c.err, ['pariksha coverage-by-type: none of 2 tracked file(s) is in a category; nothing was checked, so this is not a pass']);
    const g = withStdin('ghost.ts\n');
    assert.equal(run(['coverage-by-type', '--root', root, '--files-from', '-'], g.io, '0'), 2);
    assert.deepEqual(g.err, ['pariksha coverage-by-type: listed file ghost.ts does not exist; nothing was checked, so this is not a pass']);
  });

  it('exits 2 outside a repository, without TypeScript, or on a bad config', () => {
    const outside = mkdtempSync(join(tmpdir(), 'pariksha-none-'));
    const a = capture();
    assert.equal(run(['coverage-by-type', '--root', outside], a.io, '0'), 2);
    assert.match(a.err[0] ?? '', /is not in a git repository$/);
    const root = repo({ ...files, 'bad.json': '{"maxHops": -1}' });
    const b = capture();
    assert.equal(run(['coverage-by-type', '--root', root], { ...b.io, typescript: () => 'needs the typescript package' }, '0'), 2);
    assert.deepEqual(b.err, ['pariksha coverage-by-type: needs the typescript package']);
    const d = capture();
    assert.equal(run(['coverage-by-type', '--root', root, '--config', 'bad.json'], d.io, '0'), 2);
    assert.deepEqual(d.err, ['pariksha coverage-by-type: "maxHops" must be a whole number, 0 or more; nothing was checked, so this is not a pass']);
    const e = capture();
    assert.equal(run(['coverage-by-type', '--root', root, '--files-from', join(root, 'absent.txt')], e.io, '0'), 2);
    assert.match(e.err[0] ?? '', /ENOENT.*nothing was checked, so this is not a pass$/);
  });
});

describe('run coverage-exemptions', () => {
  const good = 'export default { test: { coverage: { exclude: ["**/*.test.ts", "dist/**"] } } };';
  const config = JSON.stringify({
    vitest: { configs: ['apps/a/vitest.config.mjs', 'apps/b/vitest.config.mjs'], requiredExcludes: ['**/*.test.ts'] },
    build: { configs: ['apps/a/tsconfig.build.json'], forbiddenIncludes: ['__mocks__'] },
  });
  const files = {
    'cov.json': config,
    'apps/a/vitest.config.mjs': good,
    'apps/b/vitest.config.mjs': good,
    'apps/a/tsconfig.build.json': '{ "include": ["src"] }',
    'packages/c/x.ts': '',
  };

  it('passes configs that hold the lists, and counts them', () => {
    const c = capture();
    assert.equal(run(['coverage-exemptions', '--root', repo(files), '--config', 'cov.json'], c.io, '0'), 0);
    assert.deepEqual(c.out, ['pariksha coverage-exemptions: 2 vitest and 1 build config(s) checked, none drifts']);
  });

  it('refuses drift, and judges only a package’s own configs with --package', () => {
    const root = repo({ ...files, 'apps/b/vitest.config.mjs': 'export default { test: { coverage: { exclude: ["dist/**"] } } };', 'apps/a/tsconfig.build.json': '{ "include": ["src", "src/__mocks__"] }' });
    const all = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'cov.json'], all.io, '0'), 1);
    assert.deepEqual(all.err.slice(0, 2), ['pariksha coverage-exemptions: apps/b/vitest.config.mjs: coverage.exclude lacks **/*.test.ts', 'pariksha coverage-exemptions: apps/a/tsconfig.build.json: include brings test files into the build: __mocks__']);
    const b = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'cov.json', '--package', 'apps/b'], b.io, '0'), 1);
    assert.deepEqual(b.err[0], 'pariksha coverage-exemptions: apps/b/vitest.config.mjs: coverage.exclude lacks **/*.test.ts');
    const c = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'cov.json', '--package', 'packages/c'], c.io, '0'), 0);
    assert.deepEqual(c.out, ['pariksha coverage-exemptions: 0 vitest and 0 build config(s) under packages/c checked, none drifts']);
  });

  it('exits 2 without a config, outside a repository, on a bad package, a missing config or no typescript', () => {
    const usage = capture();
    assert.equal(run(['coverage-exemptions'], usage.io, '0'), 2);
    assert.match(usage.err[0] ?? '', /^usage:/);
    const outside = capture();
    assert.equal(run(['coverage-exemptions', '--root', mkdtempSync(join(tmpdir(), 'pariksha-none-')), '--config', 'cov.json'], outside.io, '0'), 2);
    assert.match(outside.err[0] ?? '', /is not in a git repository$/);
    const root = repo(files);
    const pkg = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'cov.json', '--package', 'apps/a/'], pkg.io, '0'), 2);
    assert.deepEqual(pkg.err, ['pariksha coverage-exemptions: --package "apps/a/" is not a normalized root-relative folder']);
    const gone = repo(Object.fromEntries(Object.entries(files).filter(([p]) => p !== 'apps/a/tsconfig.build.json')));
    const missing = capture();
    assert.equal(run(['coverage-exemptions', '--root', gone, '--config', 'cov.json'], missing.io, '0'), 2);
    assert.deepEqual(missing.err, ['pariksha coverage-exemptions: apps/a/tsconfig.build.json named in cov.json but not a file; nothing was checked, so this is not a pass']);
    const nots = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'cov.json'], { ...nots.io, typescript: () => 'needs the typescript package' }, '0'), 2);
    assert.deepEqual(nots.err, ['pariksha coverage-exemptions: needs the typescript package']);
    const bad = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'absent.json'], bad.io, '0'), 2);
    assert.match(bad.err[0] ?? '', /ENOENT.*nothing was checked, so this is not a pass$/);
  });

  it('needs no typescript for vitest configs alone, and exits 2 on a loader that does not load', () => {
    const vitestOnly = JSON.stringify({ vitest: { configs: ['apps/a/vitest.config.mjs'], requiredExcludes: ['**/*.test.ts'] } });
    const root = repo({ ...files, 'v.json': vitestOnly, 'l.json': JSON.stringify({ ...JSON.parse(vitestOnly), loader: 'no-such-loader-pariksha' }) });
    const c = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'v.json'], { ...c.io, typescript: () => 'needs the typescript package' }, '0'), 0);
    assert.deepEqual(c.out, ['pariksha coverage-exemptions: 1 vitest and 0 build config(s) checked, none drifts']);
    const l = capture();
    assert.equal(run(['coverage-exemptions', '--root', root, '--config', 'l.json'], l.io, '0'), 2);
    assert.match(l.err[0] ?? '', /^pariksha coverage-exemptions: loader no-such-loader-pariksha does not load: .*nothing was checked, so this is not a pass$/);
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
