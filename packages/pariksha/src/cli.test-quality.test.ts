// The duplicate-tests and flaky-tests subcommands, end to end through `run`:
// file selection, config, every exit code.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run, type Io } from './cli.ts';
import type { SpawnOutcome } from './flaky-tests.ts';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
const put = (root: string, files: Record<string, string>): void => {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
};

const made: string[] = [];
after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

/** A repository with `files` tracked, and `loose` written but not added. */
const repo = (files: Record<string, string>, loose: Record<string, string> = {}): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-test-quality-')));
  made.push(root);
  git(root, 'init', '-q', '-b', 'main');
  put(root, files);
  git(root, 'add', '-A');
  put(root, loose);
  return root;
};

const capture = (extra: Partial<Io> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), ...extra }, out, err };
};

const body = 'expect(a).toBe(1); expect(b).toEqual(2); expect(c).toMatch(/x/);';
const order = (name: string): string => `describe('Orders', () => { it('${name}', () => { ${body} }); });\n`;
const USAGE = /^usage: /;

describe('pariksha duplicate-tests', () => {
  it('checks every tracked test file on disk by default, and refuses a copied test', () => {
    const root = repo({ 'a/x.test.ts': order('builds an order'), 'b/y.spec.tsx': order('builds an order'), 'gone.test.ts': order('builds an order'), 'readme.md': '# x\n' }, { 'loose.test.ts': order('builds an order') });
    rmSync(join(root, 'gone.test.ts'));
    const c = capture();
    assert.equal(run(['duplicate-tests', '--root', join(root, 'a')], c.io), 1);
    assert.deepEqual(c.out.slice(0, 4), ['🔍 Searching for duplicate tests (Threshold: 0.85)...', '   Mode: all', '   Analyzing 2 files...', '   Extracted 2 test signatures.']);
    assert.deepEqual(c.out.slice(5), ['❌ Found potential duplicate tests:', '', '   100% Match:', '     A: a/x.test.ts:1 "builds an order"', '     B: b/y.spec.tsx:1 "builds an order"', '', 'Total potential duplicates: 1']);
    assert.deepEqual(c.err, []);
  });

  it('reads the listed files from --files-from (a file, or stdin), absolute or relative to the root, keeping test files only', () => {
    const root = repo({ 'a/x.test.ts': order('handles success'), 'b/y.test.ts': order('handles failure'), 'c/z.test.ts': order('handles success') });
    const list = join(root, 'list.txt');
    writeFileSync(list, `${join(root, 'a/x.test.ts')}\nb/y.test.ts\nnotes.md\n`);
    const fromFile = capture();
    assert.equal(run(['duplicate-tests', '--files-from', list, '--root', root], fromFile.io), 0);
    assert.deepEqual(fromFile.out, ['🔍 Searching for duplicate tests (Threshold: 0.85)...', '   Mode: files', '   Analyzing 2 files...', '   Extracted 2 test signatures.', '', '✅ No duplicates found.']);
    const fromStdin = capture({ stdin: () => 'a/x.test.ts\nc/z.test.ts\n' });
    assert.equal(run(['duplicate-tests', '--files-from', '-', '--root', root], fromStdin.io), 1);
  });

  it('warns of a listed file it cannot read, and passes when no listed file is a test file', () => {
    const root = repo({ 'a/x.test.ts': order('one') });
    const missing = capture({ stdin: () => 'a/missing.test.ts\n' });
    assert.equal(run(['duplicate-tests', '--files-from', '-', '--root', root], missing.io), 0);
    assert.match(missing.err[0] ?? '', new RegExp(`^⚠️  Failed to parse ${join(root, 'a/missing.test.ts')}: ENOENT`));
    const none = capture({ stdin: () => 'readme.md\n' });
    assert.equal(run(['duplicate-tests', '--files-from', '-', '--root', root], none.io), 0);
    assert.equal(none.out.at(-1), 'No files found to analyze.');
  });

  it("takes the product's opposite pairs and threshold from --config, read from the root", () => {
    // Two files: within one, the differing words alone excuse the pair.
    const root = repo({ 'a/m.test.ts': `describe('M', () => { it('migrates inward_v2', () => { ${body} }); });\n`, 'b/m.test.ts': `describe('M', () => { it('migrates inward_v3', () => { ${body} }); });\n` });
    assert.equal(run(['duplicate-tests', '--root', root], capture().io), 1);
    put(root, { 'pairs.json': JSON.stringify({ oppositePairs: [['inward_v2', 'inward_v3']], threshold: 0.9 }) });
    const c = capture();
    assert.equal(run(['duplicate-tests', '--config', 'pairs.json', '--root', root], c.io), 0);
    assert.equal(c.out[0], '🔍 Searching for duplicate tests (Threshold: 0.9)...');
  });

  it('exits 2 when nothing could be checked: no repository, no TypeScript, a bad config or list', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-test-quality-')));
    made.push(outside);
    const noRepo = capture();
    assert.equal(run(['duplicate-tests', '--root', outside], noRepo.io), 2);
    assert.deepEqual(noRepo.err, [`pariksha duplicate-tests: ${outside} is not in a git repository`]);
    const root = repo({ 'a.test.ts': order('x') });
    const noTs = capture({ typescript: () => 'needs the typescript package' });
    assert.equal(run(['duplicate-tests', '--root', root], noTs.io), 2);
    assert.deepEqual(noTs.err, ['pariksha duplicate-tests: needs the typescript package']);
    put(root, { 'bad.json': '{"pairs":[]}' });
    const bad = capture();
    assert.equal(run(['duplicate-tests', '--config', 'bad.json', '--root', root], bad.io), 2);
    assert.deepEqual(bad.err, ['pariksha duplicate-tests: the config has unknown field(s): pairs; nothing was checked, so this is not a pass']);
    const noList = capture();
    assert.equal(run(['duplicate-tests', '--files-from', join(root, 'none.txt'), '--root', root], noList.io), 2);
    assert.match(noList.err[0] ?? '', /ENOENT.*nothing was checked/);
    const usage = capture();
    assert.equal(run(['duplicate-tests', '--threshold', '0.5'], usage.io), 2);
    assert.match(usage.err[0] ?? '', USAGE);
  });
});

describe('pariksha flaky-tests', () => {
  const passing = (args: readonly string[]): SpawnOutcome => {
    const files = args.filter((a) => a.endsWith('.ts'));
    return {
      status: 0,
      stdout: JSON.stringify({
        numTotalTests: files.length,
        numPassedTests: files.length,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        success: true,
        testResults: files.map((name) => ({ name, status: 'passed', message: '', assertionResults: [{ title: 'ok', fullName: 'ok', status: 'passed', failureMessages: [] }] })),
      }),
      stderr: '',
    };
  };

  it('runs every tracked test file, five times by default, each package root from its own directory', () => {
    const root = repo({ 'apps/web/src/a.test.ts': '', 'scripts/b.test.ts': '', 'readme.md': '' });
    put(root, { 'flaky.json': JSON.stringify({ packageRoots: ['apps/web'], exclude: ['**/.tmp/**'] }) });
    const calls: Array<[readonly string[], string]> = [];
    const c = capture({
      vitest: (args, cwd) => {
        calls.push([args, cwd]);
        return passing(args);
      },
    });
    assert.equal(run(['flaky-tests', '--config', 'flaky.json', '--root', root], c.io), 0);
    assert.equal(calls.length, 10);
    assert.deepEqual(calls.slice(0, 2), [
      [['run', '--reporter=json', '--passWithNoTests', '--exclude', '**/.tmp/**', 'scripts/b.test.ts'], root],
      [['run', '--reporter=json', '--passWithNoTests', '--exclude', '**/.tmp/**', 'src/a.test.ts'], join(root, 'apps/web')],
    ]);
    assert.deepEqual(c.out.slice(0, 4), ['🔄 Detecting flaky tests (5 runs)...', '   Mode: all', '   Running on 2 files...', '   Run 1/5: ✅ Passed']);
    assert.equal(c.out.at(-1), '✅ No flaky tests found across 2 test cases.');
  });

  it('runs the listed files --runs times, and fails a file that fails every run', () => {
    const root = repo({ 'x.test.ts': '' });
    const c = capture({ stdin: () => `${join(root, 'x.test.ts')}\n`, vitest: () => ({ status: 1, stdout: '', stderr: 'boom' }) });
    assert.equal(run(['flaky-tests', '--files-from', '-', '--runs', '2', '--root', root], c.io), 1);
    assert.deepEqual(c.out.slice(0, 5), ['🔄 Detecting flaky tests (2 runs)...', '   Mode: files', '   Running on 1 files...', '   Run 1/2: ❌ Failed', '   Run 2/2: ❌ Failed']);
    assert.equal(c.out.at(-1), '[.] vitest exited with status 1\nboom\n');
  });

  it('passes, running nothing, when no listed file is a test file', () => {
    const root = repo({ 'x.test.ts': '' });
    const c = capture({
      stdin: () => 'readme.md\n',
      vitest: () => {
        throw new Error('not run');
      },
    });
    assert.equal(run(['flaky-tests', '--files-from', '-', '--root', root], c.io), 0);
    assert.deepEqual(c.out, ['🔄 Detecting flaky tests (5 runs)...', '   Mode: files', 'No files found to analyze.']);
  });

  it('exits 2 on a bad run count, outside a repository, or on a bad config', () => {
    for (const runs of ['abc', '0', '1001', '2.5']) {
      const c = capture();
      assert.equal(run(['flaky-tests', '--runs', runs], c.io), 2);
      assert.deepEqual(c.err, ['--runs must be an integer from 1 to 1000']);
    }
    const twice = capture();
    assert.equal(run(['flaky-tests', '--runs', '3', '--runs', '4'], twice.io), 2);
    assert.match(twice.err[0] ?? '', USAGE);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-test-quality-')));
    made.push(outside);
    const noRepo = capture();
    assert.equal(run(['flaky-tests', '--root', outside], noRepo.io), 2);
    assert.deepEqual(noRepo.err, [`pariksha flaky-tests: ${outside} is not in a git repository`]);
    const root = repo({ 'x.test.ts': '' });
    put(root, { 'bad.json': '{"roots":[]}' });
    const bad = capture();
    assert.equal(run(['flaky-tests', '--config', 'bad.json', '--root', root], bad.io), 2);
    assert.deepEqual(bad.err, ['pariksha flaky-tests: the config has unknown field(s): roots; nothing was checked, so this is not a pass']);
  });
});
