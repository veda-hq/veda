import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { LinkRunner } from './doc-links.ts';
import type { Config } from './doc-references-config.ts';
import { formatReport, hunkLines, introducedFailures, parseNameStatus, referrers, removedFlags, removedIdentifiers, runChecks, runGate, type GateMode, type GateReport } from './doc-references-gate.ts';
import { CHECK_IDS, type CheckId, type ReferenceProblem } from './doc-references.ts';
import { CONFIG, CONFIG_JSON, createTestRepo, fakeLinks, noLinks, testConfig, type TestRepo } from './doc-references.fixture.test.ts';

const STAGED: CheckId[] = ['DOC-DRIFT-01', 'DOC-DRIFT-02'];
const ALL: CheckId[] = [...CHECK_IDS];
const BASELINE = CONFIG.baseline;
const P = 'pariksha doc-references:';

const base = (): TestRepo => {
  const repo = createTestRepo({
    'package.json': JSON.stringify({ name: 'root', scripts: { gate: 'echo' } }),
    'scripts/tool.ts': 'export function runTool() {\n  return 1;\n}\n',
    'docs/guide.md': 'Run `scripts/tool.ts`.\n',
  });
  repo.commit('base');
  return repo;
};

/**
 * fakeLinks, with the directory resolved as lychee (run there) sees it: a temp
 * directory can be a symlink (macOS's /var), and the report is read against
 * the real path.
 */
const links: LinkRunner = (dir, files) => fakeLinks(realpathSync(dir), files);

const gate = (repo: TestRepo, mode: GateMode, checks: readonly CheckId[], baseline: 'update' | 'write' | undefined = undefined, config: Config = CONFIG, runner: LinkRunner = links): GateReport =>
  runGate({ root: repo.root, config, mode, checks, baseline, links: runner });

const staged = (repo: TestRepo, config: Config = CONFIG): GateReport => gate(repo, { kind: 'staged' }, STAGED, undefined, config);
const pushed = (repo: TestRepo, from: string): GateReport => gate(repo, { kind: 'range', base: from, head: 'HEAD' }, ALL);
const all = (repo: TestRepo, baseline: 'update' | 'write' | undefined = undefined): GateReport => gate(repo, { kind: 'all' }, ALL, baseline);

const baseline = (files: Record<string, Partial<Record<CheckId, number>>>): string => `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
const refs = (report: GateReport): string[][] => report.failures.map((p) => [p.file, p.ref]);
const mergeFails = /Command failed: git merge --no-edit main/;

describe('pre-commit (staged)', () => {
  it('A: an added doc with a broken path fails; fixed, it passes', () => {
    const repo = base();
    repo.write('docs/new.md', 'See `scripts/gone.ts`.\n');
    repo.git('add', 'docs/new.md');
    const report = staged(repo);
    assert.equal(report.exitCode, 1);
    assert.deepEqual(refs(report), [['docs/new.md', 'scripts/gone.ts']]);
    repo.write('docs/new.md', 'See `scripts/tool.ts`.\n');
    repo.git('add', 'docs/new.md');
    assert.equal(staged(repo).exitCode, 0);
  });

  it('mid-merge: judges what this side resolved or edited, not what it took from main', () => {
    const repo = base();
    repo.git('checkout', '-q', '-b', 'side');
    repo.write('docs/clash.md', 'Ours.\n');
    repo.commit('side');
    repo.git('checkout', '-q', 'main');
    repo.write('docs/main.md', 'See `scripts/gone.ts`.\n');
    repo.write('docs/later.md', 'See `scripts/gone.ts`.\n');
    repo.write('docs/clash.md', 'Theirs.\n');
    // main deletes a path an unchanged doc names: main's to judge.
    repo.git('rm', '-q', 'scripts/tool.ts');
    repo.commit('main');
    repo.git('checkout', '-q', 'side');
    assert.throws(() => repo.git('merge', '--no-edit', 'main'), mergeFails);
    repo.write('docs/clash.md', 'Both, see `scripts/lost.ts`.\n');
    repo.write('docs/later.md', 'Edited after, see `scripts/gone.ts`.\n');
    repo.git('add', '-A');
    const report = staged(repo);
    assert.deepEqual(report.checked, ['docs/clash.md', 'docs/later.md']);
    assert.deepEqual(refs(report), [
      ['docs/clash.md', 'scripts/lost.ts'],
      ['docs/later.md', 'scripts/gone.ts'],
    ]);
  });

  it('mid-merge: a referrer the merge took from main is not judged', () => {
    const repo = base();
    repo.write('docs/side.md', 'Run `pnpm gate`.\n');
    repo.write('package.json', JSON.stringify({ name: 'root', scripts: { gate: 'echo', side: 'echo' } }));
    repo.git('checkout', '-q', '-b', 'side');
    repo.commit('side');
    repo.git('checkout', '-q', 'main');
    // main removes the script and adds a doc that still runs it.
    repo.write('package.json', JSON.stringify({ name: 'root', scripts: {} }));
    repo.write('docs/run.md', 'Run `pnpm gate`.\n');
    repo.commit('main');
    repo.git('checkout', '-q', 'side');
    assert.throws(() => repo.git('merge', '--no-edit', 'main'), mergeFails);
    // Resolved unlike main, so `gate` is this side's removal: a term.
    repo.write('package.json', JSON.stringify({ name: 'root', scripts: { side: 'echo' } }));
    repo.git('add', '-A');
    const report = staged(repo);
    assert.deepEqual(report.checked, ['docs/side.md']);
    assert.deepEqual(refs(report), [['docs/side.md', 'gate']]);
  });

  it('mid-merge: a .gitignore re-check skips what the merge took from main', () => {
    const repo = base();
    repo.git('checkout', '-q', '-b', 'side');
    repo.git('checkout', '-q', 'main');
    repo.write('docs/main.md', 'See `scripts/gone.ts`.\n');
    repo.commit('main');
    repo.git('checkout', '-q', 'side');
    repo.git('merge', '-q', '--no-commit', '--no-ff', 'main');
    repo.write('.gitignore', 'node_modules/\n');
    repo.git('add', '.gitignore');
    const report = staged(repo);
    assert.ok(report.checked.includes('docs/guide.md'));
    assert.ok(!report.checked.includes('docs/main.md'));
    assert.equal(report.exitCode, 0);
  });

  it('M: a modified doc is checked; an untouched broken doc is not', () => {
    const repo = base();
    repo.write('docs/old.md', 'See `scripts/gone.ts`.\n');
    repo.commit('legacy');
    repo.write('docs/guide.md', 'Run `scripts/tool.ts` today.\n');
    repo.git('add', 'docs/guide.md');
    const report = staged(repo);
    assert.deepEqual(report.checked, ['docs/guide.md']);
    assert.equal(report.exitCode, 0);
  });

  it('D: deleting a path fails the doc that names it', () => {
    const repo = base();
    repo.git('rm', '-q', 'scripts/tool.ts');
    const report = staged(repo);
    assert.equal(report.exitCode, 1);
    assert.equal(report.failures[0]?.file, 'docs/guide.md');
    assert.equal(report.failures[0]?.check, 'DOC-DRIFT-01');
  });

  it('R: renaming a path fails the doc that names the old one', () => {
    const repo = base();
    repo.git('mv', 'scripts/tool.ts', 'scripts/runner.ts');
    const report = staged(repo);
    assert.equal(report.exitCode, 1);
    assert.equal(report.failures[0]?.ref, 'scripts/tool.ts');
  });

  it('staged-invalid, worktree-valid: the index decides', () => {
    const repo = base();
    // The doc is staged broken and fixed only on disk.
    repo.write('docs/guide.md', 'Run `scripts/gone.ts`.\n');
    repo.git('add', 'docs/guide.md');
    repo.write('docs/guide.md', 'Run `scripts/tool.ts`.\n');
    assert.equal(staged(repo).exitCode, 1);
    // A target present on disk but not staged does not count either.
    repo.git('add', 'docs/guide.md');
    repo.write('docs/new.md', 'See `scripts/later.ts`.\n');
    repo.git('add', 'docs/new.md');
    repo.write('scripts/later.ts', 'export {};\n');
    assert.equal(staged(repo).exitCode, 1);
    repo.git('add', 'scripts/later.ts');
    assert.equal(staged(repo).exitCode, 0);
  });

  it('a .gitignore change re-checks every reference file', () => {
    const repo = base();
    repo.write('docs/old.md', 'See `scripts/gone.ts`.\n');
    repo.commit('legacy');
    repo.write('.gitignore', 'node_modules/\n');
    repo.git('add', '.gitignore');
    const report = staged(repo);
    assert.ok(report.checked.includes('docs/old.md'));
    assert.equal(report.exitCode, 1);
  });

  it('a removed package script re-checks every doc that runs it', () => {
    const repo = base();
    repo.write('docs/run.md', 'Run `pnpm gate`.\n');
    repo.commit('doc');
    repo.write('package.json', JSON.stringify({ name: 'root', scripts: {} }));
    repo.git('add', 'package.json');
    const report = staged(repo);
    assert.ok(report.checked.includes('docs/run.md'));
    assert.equal(report.failures[0]?.check, 'DOC-DRIFT-02');
    assert.equal(report.failures[0]?.ref, 'gate');
  });

  it('runs before the first commit, against an empty HEAD', () => {
    const repo = createTestRepo({ 'package.json': '{}', 'docs/new.md': 'See `scripts/gone.ts`.\n' });
    repo.git('add', '-A');
    const report = staged(repo);
    assert.deepEqual(report.checked, ['docs/new.md']);
    assert.deepEqual(refs(report), [['docs/new.md', 'scripts/gone.ts']]);
  });

  it('a manifest whose earlier text does not parse, or holds no script object, removed no script', () => {
    const repo = base();
    repo.write('tools/a/package.json', '{ not json');
    repo.write('tools/b/package.json', JSON.stringify({ scripts: ['gate'] }));
    repo.write('docs/run.md', 'Run `pnpm gate` with `--fast`.\n');
    repo.commit('odd manifests');
    repo.write('tools/a/package.json', JSON.stringify({ scripts: {} }));
    repo.write('tools/b/package.json', JSON.stringify({ scripts: {} }));
    repo.git('add', '-A');
    assert.deepEqual(staged(repo).checked, []);
  });
});

describe('the baseline', () => {
  const legacy = (): TestRepo => {
    const repo = base();
    repo.write('docs/old.md', 'See `scripts/gone.ts` and `scripts/lost.ts`.\n');
    repo.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 2 } }));
    repo.commit('seed');
    return repo;
  };

  it('the seed itself passes: no earlier baseline to grow from', () => {
    const repo = base();
    repo.write('docs/old.md', 'See `scripts/gone.ts`.\n');
    repo.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 1 } }));
    repo.git('add', '-A');
    assert.equal(staged(repo).exitCode, 0);
  });

  it('a file at its count passes when edited elsewhere', () => {
    const repo = legacy();
    repo.write('docs/old.md', 'See `scripts/gone.ts` and `scripts/lost.ts`. More.\n');
    repo.git('add', 'docs/old.md');
    assert.equal(staged(repo).exitCode, 0);
  });

  it('a file over its count fails', () => {
    const repo = legacy();
    repo.write('docs/old.md', 'See `scripts/gone.ts`, `scripts/lost.ts`, `scripts/new.ts`.\n');
    repo.git('add', 'docs/old.md');
    const report = staged(repo);
    assert.equal(report.exitCode, 1);
    assert.equal(report.failures.length, 3);
  });

  it('a fix that leaves slack must lower the count in the same change', () => {
    const repo = legacy();
    repo.write('docs/old.md', 'See `scripts/tool.ts` and `scripts/lost.ts`.\n');
    repo.git('add', 'docs/old.md');
    const report = staged(repo);
    assert.equal(report.exitCode, 1);
    assert.deepEqual(report.slack, [{ file: 'docs/old.md', check: 'DOC-DRIFT-01', baseline: 2, actual: 1 }]);
    assert.match(formatReport(report, { config: CONFIG, mode: { kind: 'staged' }, checks: STAGED }, 'cfg.json').err.join('\n'), /--update-baseline/);
    repo.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 1 } }));
    repo.git('add', BASELINE);
    assert.equal(staged(repo).exitCode, 0);
  });

  it('slack in a file the change did not touch does not block', () => {
    const repo = legacy();
    repo.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 2, 'DOC-DRIFT-02': 2 } }));
    repo.commit('an allowance the file no longer needs');
    // Lowering the entry re-checks the doc; the doc itself is unchanged, so what is left is not this change's to give up.
    repo.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 2, 'DOC-DRIFT-02': 1 } }));
    repo.git('add', BASELINE);
    const report = staged(repo);
    assert.deepEqual(report.checked, ['docs/old.md']);
    assert.deepEqual(report.changed, []);
    assert.deepEqual(report.slack, [{ file: 'docs/old.md', check: 'DOC-DRIFT-02', baseline: 1, actual: 0 }]);
    assert.deepEqual(report.growth, []);
    assert.equal(report.exitCode, 0);
    assert.deepEqual(formatReport(report, { config: CONFIG, mode: { kind: 'staged' }, checks: STAGED }, 'cfg.json').err, []);
  });

  it('raising a count or adding an entry fails as growth', () => {
    const repo = legacy();
    repo.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 3 }, 'docs/guide.md': { 'DOC-DRIFT-01': 1 } }));
    repo.git('add', BASELINE);
    const report = staged(repo);
    assert.equal(report.exitCode, 1);
    assert.equal(report.growth.length, 2);
  });

  it('an entry for a file that is gone fails', () => {
    const repo = legacy();
    repo.git('rm', '-q', 'docs/old.md');
    const report = staged(repo);
    assert.equal(report.growth.length, 1);
    assert.match(report.growth[0] ?? '', /docs\/old\.md: no such file/);
  });

  it('an entry whose file an earlier change removed is that change’s, not this one’s', () => {
    const repo = legacy();
    repo.git('rm', '-q', 'docs/old.md');
    repo.commit('main deletes a baselined doc');
    repo.write('docs/guide.md', 'See `scripts/tool.ts`.\n');
    repo.git('add', 'docs/guide.md');
    const now = staged(repo);
    assert.equal(now.exitCode, 0);
    assert.deepEqual(now.growth, []);
    repo.commit('an unrelated doc');
    const one = pushed(repo, 'HEAD~1');
    assert.equal(one.exitCode, 0);
    assert.deepEqual(one.growth, []);
    assert.deepEqual(pushed(repo, 'HEAD~2').growth, ['docs/old.md: no such file; remove its entry']);
    assert.deepEqual(all(repo).growth, ['docs/old.md: no such file; remove its entry']);
  });

  it('an edited entry for a gone file fails; a seed answers only for its own deletions', () => {
    const repo = legacy();
    repo.git('rm', '-q', 'docs/old.md');
    repo.commit('main deletes a baselined doc');
    repo.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 1 } }));
    repo.git('add', BASELINE);
    assert.deepEqual(staged(repo).growth, ['docs/old.md: no such file; remove its entry']);

    const seed = base();
    seed.write('docs/kept.md', 'See `scripts/gone.ts`.\n');
    seed.write('docs/dropped.md', 'See `scripts/lost.ts`.\n');
    seed.commit('before the seed');
    seed.git('rm', '-q', 'docs/dropped.md');
    seed.write(BASELINE, baseline({ 'docs/kept.md': { 'DOC-DRIFT-01': 1 }, 'docs/dropped.md': { 'DOC-DRIFT-01': 1 }, 'docs/never.md': { 'DOC-DRIFT-01': 1 } }));
    seed.git('add', BASELINE);
    assert.deepEqual(staged(seed).growth, ['docs/dropped.md: no such file; remove its entry']);
  });

  it('--all --update-baseline only ever lowers', () => {
    const repo = legacy();
    repo.write('docs/old.md', 'See `scripts/gone.ts`.\n');
    repo.write('docs/guide.md', 'See `scripts/absent.ts`.\n');
    const report = all(repo, 'update');
    assert.deepEqual(JSON.parse(readFileSync(join(repo.root, BASELINE), 'utf8')), { version: 1, files: { 'docs/old.md': { 'DOC-DRIFT-01': 1 } } });
    assert.equal(report.wrote, 1);
    assert.equal(report.exitCode, 0);
  });

  it('--all --write-baseline seeds every file at its count', () => {
    const repo = legacy();
    repo.write('docs/guide.md', 'See `scripts/absent.ts`.\n');
    const report = all(repo, 'write');
    assert.deepEqual(JSON.parse(readFileSync(join(repo.root, BASELINE), 'utf8')), { version: 1, files: { 'docs/guide.md': { 'DOC-DRIFT-01': 1 }, 'docs/old.md': { 'DOC-DRIFT-01': 2 } } });
    assert.equal(report.wrote, 2);
    assert.equal(report.problems.length, 3);
    assert.deepEqual(report.failures, []);
  });
});

describe('pre-push and CI (range)', () => {
  it('a removed identifier fails the doc that names it (DOC-DRIFT-04)', () => {
    const repo = base();
    repo.write('docs/api.md', 'Call `runTool` to start.\n');
    const from = repo.commit('doc');
    repo.write('scripts/tool.ts', 'export function startTool() {\n  return 1;\n}\n');
    repo.commit('rename');
    const report = pushed(repo, from);
    assert.ok(report.checked.includes('docs/api.md'));
    assert.deepEqual(
      report.failures.map((p) => [p.check, p.ref]),
      [['DOC-DRIFT-04', 'runTool']],
    );
  });

  it('a moved line fails the doc that cites it by name:line', () => {
    const repo = base();
    repo.write('docs/api.md', '`runTool` in `scripts/tool.ts:1`.\n');
    const from = repo.commit('doc');
    repo.write('scripts/tool.ts', '// header\n// header\n// header\n// header\n// header\nexport function runTool() {}\n');
    repo.commit('move');
    const report = pushed(repo, from);
    assert.ok(report.checked.includes('docs/api.md'));
    assert.match(report.failures[0]?.reason ?? '', /citation drifted/);
  });

  it('a removed flag re-checks the docs that pass it', () => {
    const repo = base();
    repo.write('scripts/cli.ts', "// usage: cli.ts [--fast]\nif (process.argv.includes('--fast')) {}\n");
    repo.write('docs/cli.md', '```bash\npnpm exec tsx scripts/cli.ts --fast\n```\n');
    const from = repo.commit('cli');
    repo.write('scripts/cli.ts', '// usage: cli.ts\n');
    repo.commit('drop flag');
    const report = pushed(repo, from);
    assert.ok(report.checked.includes('docs/cli.md'));
    assert.deepEqual(
      report.failures.map((p) => p.ref),
      ['--fast'],
    );
  });

  it('a finding the merge base already had is legacy; one the push adds fails', () => {
    const repo = base();
    repo.write('docs/legacy.md', 'See `scripts/gone.ts`.\n');
    const from = repo.commit('main merged drift');
    repo.write('docs/legacy.md', 'See `scripts/gone.ts`. Reflowed.\n');
    repo.commit('edit');
    const edited = pushed(repo, from);
    assert.ok(edited.checked.includes('docs/legacy.md'));
    assert.deepEqual(
      edited.problems.map((p) => p.ref),
      ['scripts/gone.ts'],
    );
    assert.deepEqual(edited.failures, []);
    assert.equal(edited.exitCode, 0);

    repo.write('docs/legacy.md', 'See `scripts/gone.ts`.\nAgain `scripts/gone.ts` and `scripts/new.ts`.\n');
    repo.commit('add');
    // One base finding excuses one: the second `gone.ts` is new.
    assert.deepEqual(
      pushed(repo, from).failures.map((p) => p.ref),
      ['scripts/gone.ts', 'scripts/new.ts'],
    );
  });

  it('a doc the push adds has no legacy: its broken path fails', () => {
    const repo = base();
    const from = repo.commit('base');
    repo.write('docs/new.md', 'See `scripts/absent.ts`.\n');
    repo.commit('add');
    assert.deepEqual(
      pushed(repo, from).failures.map((p) => p.ref),
      ['scripts/absent.ts'],
    );
  });

  it('a renamed doc keeps the legacy its old path had', () => {
    const repo = base();
    repo.write('docs/legacy.md', 'See `scripts/gone.ts`.\n\nLong text.\n');
    const from = repo.commit('drift');
    repo.git('mv', 'docs/legacy.md', 'docs/moved.md');
    repo.write('docs/moved.md', 'See `scripts/gone.ts`.\n\nLong text!\n');
    repo.commit('rename');
    const report = pushed(repo, from);
    assert.ok(report.checked.includes('docs/moved.md'));
    assert.equal(report.problems.length, 1);
    assert.equal(report.exitCode, 0);
  });

  it('a basename inside a longer name does not make a doc a referrer', () => {
    const repo = base();
    repo.write('scripts/check-tool.ts', 'export const a = 1;\n');
    repo.write('docs/other.md', 'See `scripts/check-tool.ts:9`.\n');
    repo.write('docs/api.md', '`runTool` in `tool.ts:1`.\n');
    const from = repo.commit('docs');
    repo.write('scripts/tool.ts', '// moved\nexport function runTool() {\n  return 1;\n}\n');
    repo.commit('move');
    const report = pushed(repo, from);
    assert.ok(report.checked.includes('docs/api.md'));
    assert.ok(!report.checked.includes('docs/other.md'));
  });

  it('a clean push of data that names nothing checks nothing and passes', () => {
    const repo = base();
    const from = repo.commit('noop');
    repo.write('config/other.json', '{}\n');
    repo.commit('add');
    const report = pushed(repo, from);
    assert.deepEqual(report.checked, []);
    assert.equal(report.exitCode, 0);
    assert.deepEqual(formatReport(report, { config: CONFIG, mode: { kind: 'range', base: from, head: 'HEAD' }, checks: ALL }, 'cfg.json').out, [
      `${P} 0 reference file(s) checked (pushed), no new problem; the baseline does not grow`,
    ]);
  });

  it('a broken link a push adds fails, through the link runner, at the head and the base', () => {
    const repo = base();
    repo.write('docs/links.md', 'See [the guide](guide.md) and [gone](gone.md).\n');
    const from = repo.commit('links');
    repo.write('docs/links.md', 'See [the guide](guide.md), [gone](gone.md) and [lost](lost.md).\n');
    repo.commit('another');
    const report = pushed(repo, from);
    assert.deepEqual(
      report.problems.map((p) => [p.check, p.file]),
      [
        ['DOC-DRIFT-01', 'docs/links.md'],
        ['DOC-DRIFT-01', 'docs/links.md'],
      ],
    );
    assert.deepEqual(
      report.failures.map((p) => [p.line, p.ref]),
      [[1, 'lost.md']],
    );
  });

  it('runs only the checks it is given', () => {
    const repo = base();
    repo.write('docs/api.md', 'Call `runTool` in `scripts/gone.ts`.\n');
    const from = repo.commit('doc');
    repo.write('scripts/tool.ts', 'export function startTool() {\n  return 1;\n}\n');
    repo.commit('rename');
    const only04 = gate(repo, { kind: 'range', base: from, head: 'HEAD' }, ['DOC-DRIFT-04']);
    assert.deepEqual(
      only04.failures.map((p) => p.check),
      ['DOC-DRIFT-04'],
    );
    // Without DOC-DRIFT-04 a removed identifier strands no doc: only the changed file is read.
    assert.deepEqual(gate(repo, { kind: 'range', base: from, head: 'HEAD' }, ['DOC-DRIFT-01']).checked, ['scripts/tool.ts']);
  });

  it('names the ref git cannot find', () => {
    const repo = base();
    assert.throws(() => pushed(repo, 'no-such-ref'), /merge-base no-such-ref HEAD/);
  });
});

describe('the built CLI, run as a hook runs it', () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 with the problem line, and lychee is the one on PATH', () => {
    const repo = base();
    repo.write('doc-references.json', JSON.stringify(CONFIG_JSON));
    repo.write('docs/new.md', 'See `scripts/gone.ts` and [a link](missing.md).\n');
    repo.git('add', '-A');
    const bin = mkdtempSync(join(tmpdir(), 'stub-lychee-'));
    dirs.push(bin);
    const marker = join(bin, 'ran');
    // A stand-in for lychee: it reads the file list, records that it ran, and reports one broken link.
    const report = JSON.stringify({ error_map: { 'docs/new.md': [{ url: `file://${realpathSync(repo.root)}/docs/missing.md`, status: { text: 'Cannot find file' }, span: { line: 1 } }] } });
    writeFileSync(join(bin, 'lychee'), `#!/bin/sh\ncat > '${marker}'\nprintf '%s\\n' '${report}'\nexit 2\n`);
    chmodSync(join(bin, 'lychee'), 0o755);
    // The entry as CI's boundary step runs it, under Node's type stripping; the
    // child's own coverage is not this run's, so its V8 coverage output is off.
    const cli = join(import.meta.dirname, 'cli.ts');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_V8_COVERAGE'));
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [cli, 'doc-references', '--config', 'doc-references.json', '--staged', '--root', repo.root], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...env, PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` },
      });
    } catch (error) {
      const failed = error as { status: number; stderr: string };
      status = failed.status;
      stderr = failed.stderr;
    }
    assert.equal(status, 1);
    assert.match(stderr, /^pariksha doc-references: docs\/new\.md:1: \[DOC-DRIFT-01\] scripts\/gone\.ts: /m);
    assert.match(stderr, /^pariksha doc-references: docs\/new\.md:1: \[DOC-DRIFT-01\] missing\.md: /m);
    assert.match(stderr, /doc-ref-ok: <why>/);
    assert.match(readFileSync(marker, 'utf8'), /docs\/new\.md/);
  });
});

describe('introducedFailures', () => {
  const p = (file: string, check: CheckId, ref: string): ReferenceProblem => ({ check, file, line: 1, ref, reason: 'x' });
  const same = (file: string): string => file;

  it('excuses a failure the base had, matching file, check and reference', () => {
    const failures = [p('a.md', 'DOC-DRIFT-01', 'x.ts'), p('a.md', 'DOC-DRIFT-04', 'x.ts'), p('b.md', 'DOC-DRIFT-01', 'x.ts'), p('a.md', 'DOC-DRIFT-01', 'y.ts'), p('b.md', 'DOC-DRIFT-01', 'x.ts')];
    const asked: string[][] = [];
    assert.deepEqual(
      introducedFailures(
        failures,
        (files) => {
          asked.push(files);
          return [p('a.md', 'DOC-DRIFT-01', 'x.ts')];
        },
        same,
      ),
      failures.slice(1),
    );
    // The base is read once, for each failing file once.
    assert.deepEqual(asked, [['a.md', 'b.md']]);
  });

  it('excuses each base finding once, and reads a rename at its old path', () => {
    const twice = [p('new.md', 'DOC-DRIFT-01', 'x.ts'), p('new.md', 'DOC-DRIFT-01', 'x.ts')];
    const atBase = (): ReferenceProblem[] => [p('old.md', 'DOC-DRIFT-01', 'x.ts')];
    const renamed = (file: string): string => (file === 'new.md' ? 'old.md' : file);
    assert.deepEqual(introducedFailures(twice, atBase, renamed), [twice[1]]);
    assert.deepEqual(introducedFailures(twice, atBase, same), twice);
  });

  it('never reads the base when nothing failed', () => {
    let reads = 0;
    assert.deepEqual(
      introducedFailures(
        [],
        () => {
          reads += 1;
          return [];
        },
        same,
      ),
      [],
    );
    assert.equal(reads, 0);
  });
});

describe('parseNameStatus', () => {
  it('reads add, modify, delete, rename and copy entries', () => {
    assert.deepEqual(parseNameStatus('A\0a.md\0M\0b.md\0D\0c.md\0R100\0d.md\0e.md\0C075\0f.md\0g.md\0T\0h.md\0'), [
      { status: 'A', path: 'a.md', from: 'a.md' },
      { status: 'M', path: 'b.md', from: 'b.md' },
      { status: 'D', path: 'c.md', from: 'c.md' },
      { status: 'R', from: 'd.md', path: 'e.md' },
      { status: 'C', from: 'f.md', path: 'g.md' },
      { status: 'T', path: 'h.md', from: 'h.md' },
    ]);
    assert.deepEqual(parseNameStatus(''), []);
  });
});

describe('diff reading', () => {
  const diff = [
    'diff --git a/x.sh b/x.sh',
    'index 1..2 100644',
    '--- a/x.sh',
    '+++ b/x.sh',
    '@@ -1,2 +1,2 @@',
    '---verbose \\',
    '-  run fooBar',
    '+++fooBar;',
    'diff --git a/y.ts b/y.ts',
    '--- /dev/null',
    '+++ b/y.ts',
    '@@ -0,0 +1 @@',
    '+export const keep = 1;',
  ].join('\n');

  it('reads hunk lines only, so content starting -- or ++ is not a header', () => {
    assert.deepEqual(hunkLines(diff), ['---verbose \\', '-  run fooBar', '+++fooBar;', '+export const keep = 1;']);
    assert.deepEqual(removedFlags(diff), ['--verbose']);
    assert.deepEqual([...removedIdentifiers(diff)], []);
  });

  it('skips anything before the first hunk', () => {
    assert.deepEqual(hunkLines('index 1..2\n@@ -1 +1 @@\n-a'), ['-a']);
  });

  it('weighs removed lines against added ones and ignores context', () => {
    const hunk = ['@@ -1,3 +1,2 @@', '-run --keep --drop fooBar bazQux', ' ctx --stay keepIt', '-old --stay keepIt', '+run --keep fooBar'].join('\n');
    assert.deepEqual(removedFlags(hunk), ['--drop', '--stay']);
    assert.deepEqual([...removedIdentifiers(hunk)], ['bazQux', 'keepIt']);
  });

  it('keeps only identifier-shaped words: SCREAMING_CASE, camelCase and PascalCase', () => {
    const hunk = ['@@ -1 +0,0 @@', '-MAX_SIZE fooBar FooBar plain Plain X_ ab'].join('\n');
    assert.deepEqual([...removedIdentifiers(hunk)], ['MAX_SIZE', 'fooBar', 'FooBar']);
  });
});

describe('referrers', () => {
  const snapshot = () => {
    const repo = createTestRepo({
      'docs/api.md': 'Call `runTool`.\n',
      'docs/cite.md': 'See `scripts/other.ts:3`.\n',
      'scripts/tool.ts': '// runTool lives here\nexport function runTool() {}\n',
    });
    repo.commit('referrers');
    return repo.snapshot();
  };

  it('finds a removed identifier in docs only, even with nothing else removed', () => {
    assert.deepEqual(referrers(CONFIG, snapshot(), [], [], new Set(['runTool'])), ['docs/api.md']);
  });

  it('finds a name:line citation of the changed file only', () => {
    const snap = snapshot();
    assert.deepEqual(referrers(CONFIG, snap, [], ['scripts/tool.ts'], new Set()), []);
    assert.deepEqual(referrers(CONFIG, snap, [], ['lib/other.ts'], new Set()), ['docs/cite.md']);
  });

  it('finds a removed path by its basename and a removed term anywhere, and nothing when nothing was removed', () => {
    const snap = snapshot();
    assert.deepEqual(referrers(CONFIG, snap, ['lib/other.ts'], [], new Set()), ['docs/cite.md']);
    assert.deepEqual(referrers(CONFIG, snap, [], [], new Set(), ['runTool']), ['docs/api.md', 'scripts/tool.ts']);
    assert.deepEqual(referrers(CONFIG, snap, [], [], new Set()), []);
  });
});

describe('what a change re-checks', () => {
  it('re-checks only the files whose baseline entry the change edited', () => {
    const repo = base();
    repo.write('docs/old.md', 'See `scripts/gone.ts`.\n');
    repo.write('docs/other.md', 'See `scripts/lost.ts`.\n');
    repo.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 1 }, 'docs/other.md': { 'DOC-DRIFT-01': 1 } }));
    repo.commit('seed');
    repo.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 1 } }));
    repo.git('add', BASELINE);
    const report = staged(repo);
    assert.deepEqual(report.checked, ['docs/other.md']);
    assert.equal(report.exitCode, 1);
  });

  // The fixture config freezes `docs/history/` (excluded from every check).
  it('re-checks no file the check no longer reads when its entry goes', () => {
    const repo = base();
    repo.write('docs/history/0001-x/notes.md', 'See `scripts/gone.ts`.\n');
    repo.write(BASELINE, baseline({ 'docs/history/0001-x/notes.md': { 'DOC-DRIFT-01': 1 } }));
    repo.commit('seed');
    repo.write(BASELINE, baseline({}));
    repo.git('add', BASELINE);
    const report = staged(repo);
    assert.deepEqual(report.checked, []);
    assert.equal(report.exitCode, 0);
  });

  it('still catches a live doc citing a deleted frozen file, and no frozen referrer', () => {
    const repo = base();
    repo.write('docs/history/0001-x/notes.md', 'See `docs/live-target.md`.\n');
    repo.write('docs/live-target.md', '# target\n');
    repo.write('docs/live.md', 'See `docs/history/0001-x/notes.md`.\n');
    repo.commit('seed');
    repo.git('rm', '-q', 'docs/history/0001-x/notes.md', 'docs/live-target.md');
    const report = staged(repo);
    assert.deepEqual(report.checked, ['docs/live.md']);
    assert.equal(report.exitCode, 1);
  });

  it('never counts a deleted doc as changed', () => {
    const repo = base();
    repo.git('rm', '-q', 'docs/guide.md');
    assert.deepEqual(staged(repo).changed, []);
  });

  it('reads removed scripts from package.json manifests only', () => {
    const repo = base();
    repo.write('config/tool.json', JSON.stringify({ scripts: { lintFast: 'x' } }));
    repo.write('docs/lint.md', 'Mentions lintFast here.\n');
    repo.commit('config');
    repo.write('config/tool.json', JSON.stringify({ scripts: {} }));
    repo.git('add', 'config/tool.json');
    assert.deepEqual(staged(repo).checked, []);
  });

  it('a push measures the baseline against the merge base', () => {
    const repo = base();
    repo.write('docs/old.md', 'See `scripts/gone.ts`.\n');
    repo.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 1 } }));
    const from = repo.commit('seed');
    repo.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 2 } }));
    repo.commit('raise');
    const report = pushed(repo, from);
    assert.equal(report.growth.length, 1);
    assert.equal(report.exitCode, 1);
  });

  it('a push judges the head commit, not the index', () => {
    const repo = base();
    const from = repo.commit('noop');
    repo.write('docs/new.md', 'See `scripts/extra.ts`.\n');
    repo.write('scripts/extra.ts', 'export {};\n');
    repo.commit('extra');
    repo.git('rm', '-q', '--cached', 'scripts/extra.ts');
    assert.equal(pushed(repo, from).exitCode, 0);
  });

  it('a commit reads the staged baseline, not the worktree copy', () => {
    const repo = base();
    repo.write(BASELINE, baseline({}));
    repo.commit('empty baseline');
    repo.write(BASELINE, baseline({ 'docs/ghost.md': { 'DOC-DRIFT-01': 1 } }));
    const report = staged(repo);
    assert.deepEqual(report.growth, []);
    assert.equal(report.exitCode, 0);
  });

  it('--all reads a baseline not yet tracked from disk', () => {
    const repo = base();
    repo.write('docs/old.md', 'See `scripts/gone.ts`.\n');
    repo.commit('legacy');
    repo.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 1 } }));
    const report = all(repo);
    assert.deepEqual(report.failures, []);
    assert.equal(report.exitCode, 0);
  });

  it('writes a baseline only with --all', () => {
    const repo = base();
    repo.write('docs/new.md', 'See `scripts/gone.ts`.\n');
    repo.git('add', 'docs/new.md');
    const report = gate(repo, { kind: 'staged' }, STAGED, 'write');
    assert.equal(report.exitCode, 1);
    assert.equal(report.wrote, undefined);
  });

  it('reports a reference repeated on one line once', () => {
    const repo = base();
    repo.write('docs/dup.md', 'See `scripts/gone.ts` and `scripts/gone.ts`.\n');
    repo.git('add', 'docs/dup.md');
    assert.equal(staged(repo).failures.length, 1);
  });

  it('reads a malformed baseline as a refusal, naming the side it came from', () => {
    const repo = base();
    repo.write(BASELINE, '{ not json');
    repo.commit('broken baseline');
    repo.write('docs/guide.md', 'Run `scripts/tool.ts` again.\n');
    repo.git('add', 'docs/guide.md');
    assert.throws(() => staged(repo), { message: new RegExp(`^${BASELINE.replace(/[.]/g, '\\.')} \\(before this change\\): not JSON`) });
  });
});

describe('runChecks', () => {
  it('runs the DOC-DRIFT-02 rules over markdown only, and links through the runner it is given', () => {
    const repo = createTestRepo({
      'package.json': JSON.stringify({ scripts: {} }),
      'docs/run.md': 'Run `pnpm nope`. See [x](absent.md).\n',
      'scripts/run.sh': '# Run `pnpm nope`.\n',
    });
    const snapshot = repo.snapshot();
    const files = ['docs/run.md', 'scripts/run.sh'];
    const found = runChecks(CONFIG, snapshot, files, ['DOC-DRIFT-02'], noLinks);
    assert.deepEqual(
      found.map((p) => [p.check, p.file, p.ref]),
      [['DOC-DRIFT-02', 'docs/run.md', 'nope']],
    );
    assert.deepEqual(runChecks(CONFIG, snapshot, files, ['DOC-DRIFT-01'], noLinks), []);
    assert.equal(runChecks(CONFIG, snapshot, files, ['DOC-DRIFT-01'], fakeLinks).length, 1);
    assert.deepEqual(runChecks(testConfig({ links: null }), snapshot, files, ['DOC-DRIFT-01'], fakeLinks), []);
  });
});

describe('formatReport', () => {
  const clean: GateReport = { checked: ['a.md', 'b.md'], changed: [], problems: [], failures: [], slack: [], growth: [], wrote: undefined, exitCode: 0 };
  const format = (report: GateReport, mode: GateMode, checks: readonly CheckId[] = ALL, config: Config = CONFIG) => formatReport(report, { config, mode, checks }, 'cfg.json');

  it('names the scope of a clean run, and the checks it did not run', () => {
    assert.deepEqual(format(clean, { kind: 'staged' }, STAGED), {
      ok: true,
      out: [`${P} 2 reference file(s) checked (staged; DOC-DRIFT-04 not run), no new problem; the baseline does not grow`],
      err: [],
    });
    assert.deepEqual(format(clean, { kind: 'range', base: 'b', head: 'h' }).out, [`${P} 2 reference file(s) checked (pushed), no new problem; the baseline does not grow`]);
    assert.deepEqual(format(clean, { kind: 'all' }).out, [`${P} 2 reference file(s) checked (all), no new problem; the baseline does not grow`]);
    assert.deepEqual(format(clean, { kind: 'all' }, ['DOC-DRIFT-02']).out, [`${P} 2 reference file(s) checked (all; DOC-DRIFT-01, DOC-DRIFT-04 not run), no new problem; the baseline does not grow`]);
  });

  it('names what a config leaves unchecked', () => {
    assert.deepEqual(format(clean, { kind: 'all' }, ALL, testConfig({ links: null, commands: { typescriptRunner: null } })).out, [
      `${P} 2 reference file(s) checked (all), no new problem; the baseline does not grow`,
      `${P} not checked: links, commands.typescriptRunner`,
    ]);
  });

  it('lists failures, slack and growth, line by line', () => {
    const lower = `lower it: pariksha doc-references --config cfg.json --all --update-baseline`;
    assert.deepEqual(
      format(
        {
          ...clean,
          changed: ['a.md'],
          failures: [
            { check: 'DOC-DRIFT-01', file: 'a.md', line: 3, ref: 'x.ts', reason: 'no such file' },
            { check: 'DOC-DRIFT-02', file: 'a.md', line: 5, ref: 'gate', reason: 'runs nothing' },
          ],
          slack: [
            { file: 'a.md', check: 'DOC-DRIFT-01', baseline: 2, actual: 1 },
            { file: 'b.md', check: 'DOC-DRIFT-04', baseline: 3, actual: 0 },
          ],
          growth: ['b.md: no such file; remove its entry'],
          exitCode: 1,
        },
        { kind: 'staged' },
        STAGED,
      ),
      {
        ok: false,
        out: [`${P} ${BASELINE}: b.md DOC-DRIFT-04: baseline 3, now 0; ${lower}`],
        err: [
          `${P} a.md:3: [DOC-DRIFT-01] x.ts: no such file`,
          `${P} a.md:5: [DOC-DRIFT-02] gate: runs nothing`,
          `${P} 2 unresolved reference(s) in 1 file(s). Fix each; one that names something absent on purpose (a quoted finding, a deleted or planned file) ends its line with <!-- doc-ref-ok: <why> --> (in code, a comment holding doc-ref-ok: <why>).`,
          `${P} ${BASELINE}: a.md DOC-DRIFT-01: baseline 2, now 1; ${lower}`,
          `${P} ${BASELINE}: b.md: no such file; remove its entry`,
        ],
      },
    );
  });

  it('reports a written baseline and nothing else', () => {
    assert.deepEqual(format({ ...clean, problems: [{ check: 'DOC-DRIFT-01', file: 'a.md', line: 1, ref: 'x', reason: 'y' }], wrote: 1 }, { kind: 'all' }), {
      ok: true,
      out: [`${P} wrote ${BASELINE}: 1 file(s) hold 1 problem(s) (2 reference file(s) checked)`],
      err: [],
    });
  });

  it('prints the verdict only when the run passes', () => {
    const slackOnly = format({ ...clean, slack: [{ file: 'b.md', check: 'DOC-DRIFT-01', baseline: 1, actual: 0 }] }, { kind: 'all' });
    assert.equal(slackOnly.ok, true);
    assert.equal(slackOnly.out.length, 2);
    const growing = format({ ...clean, growth: ['x'], exitCode: 1 }, { kind: 'all' });
    assert.deepEqual(growing, { ok: false, out: [], err: [`${P} ${BASELINE}: x`] });
  });
});
