import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run } from './cli.ts';
import type { LinkRunner } from './doc-links.ts';
import { CONFIG_JSON, createTestRepo, fakeLinks, merged, type TestRepo } from './doc-references.fixture.test.ts';

const P = 'pariksha doc-references:';
const CFG = 'doc-references.json';
const BASELINE = CONFIG_JSON.baseline;
const NOT_A_PASS = '; nothing was checked, so this is not a pass';
const HINT = `${P} 1 unresolved reference(s) in 1 file(s). Fix each; one that names something absent on purpose (a quoted finding, a deleted or planned file) ends its line with <!-- doc-ref-ok: <why> --> (in code, a comment holding doc-ref-ok: <why>).`;
const LOWER = `lower it: pariksha doc-references --config ${CFG} --all --update-baseline`;

/** fakeLinks against the directory's real path, which is what the report is read against. */
const links: LinkRunner = (dir, files) => fakeLinks(realpathSync(dir), files);

/** Captured output; `links` null gives the CLI no runner, so it falls back to lychee on PATH. */
const capture = (links: LinkRunner | null) => {
  const out: string[] = [];
  const err: string[] = [];
  const write = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  return { io: links === null ? write : { ...write, links }, out, err };
};

/** `pariksha doc-references …args`: its exit code and what it printed. */
const docRefs = (args: readonly string[], runner: LinkRunner | null = links) => {
  const c = capture(runner);
  const code = run(['doc-references', ...args], c.io, '0.1.0');
  return { code, out: c.out, err: c.err };
};

/** A committed repo holding the config (with `over` merged in), a script, and a doc naming it. */
const repoWith = (over: Record<string, unknown> = {}, files: Record<string, string> = {}): TestRepo => {
  const repo = createTestRepo({
    [CFG]: JSON.stringify(merged(CONFIG_JSON, over)),
    'package.json': JSON.stringify({ name: 'root', scripts: { gate: 'echo' } }),
    'scripts/tool.ts': 'export function runTool() {\n  return 1;\n}\n',
    'docs/guide.md': 'Run `scripts/tool.ts`.\n',
    ...files,
  });
  repo.commit('base');
  return repo;
};

const baseline = (files: Record<string, Record<string, number>>): string => `${JSON.stringify({ version: 1, files }, null, 2)}\n`;

const clean = (n: number, scope: string): string => `${P} ${n} reference file(s) checked (${scope}), no new problem; the baseline does not grow`;

describe('pariksha doc-references: usage', () => {
  const refusals: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['no --config', ['--staged']],
    ['no mode', ['--config', CFG]],
    ['two modes', ['--config', CFG, '--staged', '--all']],
    ['a range and --all', ['--config', CFG, '--base', 'main', '--all']],
    ['both baseline switches', ['--config', CFG, '--all', '--update-baseline', '--write-baseline']],
    ['--write-baseline without --all', ['--config', CFG, '--staged', '--write-baseline']],
    ['--update-baseline without --all', ['--config', CFG, '--base', 'main', '--update-baseline']],
    ['--head without --base', ['--config', CFG, '--staged', '--head', 'HEAD']],
    ['a switch given twice', ['--config', CFG, '--all', '--all']],
    ['a flag given twice', ['--config', CFG, '--config', CFG, '--all']],
    ['an unknown option', ['--config', CFG, '--all', '--bogus']],
    ['a flag without its value', ['--config', CFG, '--base']],
    ['an empty value', ['--config', CFG, '--base', '']],
  ];
  for (const [label, args] of refusals) {
    it(`refuses ${label} with the usage text, exit 2`, () => {
      const result = docRefs(args);
      assert.equal(result.code, 2);
      assert.deepEqual(result.out, []);
      assert.equal(result.err.length, 1);
      assert.match(result.err[0] ?? '', /^usage: pariksha /);
      assert.match(result.err[0] ?? '', /pariksha doc-references --config <file> \(--staged \| --base <ref> \[--head <ref>\] \| --all \[--update-baseline \| --write-baseline\]\) \[--checks <ids>\] \[--root <dir>\]/);
    });
  }

  it('refuses an unknown --checks id, naming it and the ids there are', () => {
    assert.deepEqual(docRefs(['--config', CFG, '--all', '--checks', '01,03']), {
      code: 2,
      out: [],
      err: [`${P} --checks: DOC-DRIFT-03 is not one of DOC-DRIFT-01, DOC-DRIFT-02, DOC-DRIFT-04`],
    });
  });

  it('names every unknown --checks id', () => {
    const result = docRefs(['--config', CFG, '--all', '--checks', '03,05']);
    assert.equal(result.code, 2);
    assert.match(result.err.join('\n'), /DOC-DRIFT-03/);
    assert.match(result.err.join('\n'), /DOC-DRIFT-05/);
  });
});

describe('pariksha doc-references: nothing checked is not a pass', () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a directory outside any git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    dirs.push(dir);
    assert.deepEqual(docRefs(['--config', CFG, '--all', '--root', dir]), { code: 2, out: [], err: [`${P} ${dir} is not in a git repository`] });
  });

  it('refuses a config it cannot read', () => {
    const repo = repoWith();
    const result = docRefs(['--config', 'missing.json', '--all', '--root', repo.root]);
    assert.equal(result.code, 2);
    assert.deepEqual(result.out, []);
    assert.match(result.err.join('\n'), /^pariksha doc-references: ENOENT.*missing\.json.*; nothing was checked, so this is not a pass$/);
  });

  it('refuses a config that does not parse or names no check', () => {
    const repo = repoWith();
    repo.write('bad.json', '{}');
    const result = docRefs(['--config', 'bad.json', '--all', '--root', repo.root]);
    assert.equal(result.code, 2);
    assert.equal(result.err.length, 1);
    assert.ok(result.err[0]?.startsWith(`${P} `));
    assert.ok(result.err[0]?.endsWith(NOT_A_PASS));
    repo.write('bad.json', '{ not json');
    assert.equal(docRefs(['--config', 'bad.json', '--all', '--root', repo.root]).code, 2);
  });

  it('refuses a malformed baseline', () => {
    const repo = repoWith();
    repo.write(BASELINE, '{ "version": 2, "files": {} }');
    assert.deepEqual(docRefs(['--config', CFG, '--all', '--root', repo.root]), { code: 2, out: [], err: [`${P} ${BASELINE}: expected { "version": 1, "files": {} }${NOT_A_PASS}`] });
  });

  it('refuses when node_modules/.bin is missing: every script would look absent', () => {
    const repo = repoWith();
    rmSync(join(repo.root, 'node_modules'), { recursive: true, force: true });
    const result = docRefs(['--config', CFG, '--staged', '--root', repo.root]);
    assert.equal(result.code, 2);
    assert.deepEqual(result.out, []);
    assert.match(result.err.join('\n'), /^pariksha doc-references: cannot read .*node_modules\/\.bin; install the dependencies before this check; nothing was checked, so this is not a pass$/);
  });

  it('refuses a base git cannot find', () => {
    const repo = repoWith();
    const result = docRefs(['--config', CFG, '--base', 'no-such-ref', '--root', repo.root]);
    assert.equal(result.code, 2);
    assert.deepEqual(result.out, []);
    assert.match(result.err.join('\n'), /^pariksha doc-references: .*merge-base no-such-ref HEAD[\s\S]*; nothing was checked, so this is not a pass$/);
  });
});

describe('pariksha doc-references: a clean run', () => {
  it('prints the one clean line for a commit: DOC-DRIFT-01 and -02 by default', () => {
    const repo = repoWith();
    repo.write('docs/ok.md', 'Run `scripts/tool.ts`.\n');
    repo.git('add', '-A');
    assert.deepEqual(docRefs(['--config', CFG, '--staged', '--root', repo.root]), { code: 0, out: [clean(1, 'staged; DOC-DRIFT-04 not run')], err: [] });
  });

  it('prints the one clean line for a push: every check by default', () => {
    const repo = repoWith();
    repo.write('docs/ok.md', 'Run `scripts/tool.ts`.\n');
    const head = repo.commit('doc');
    assert.deepEqual(docRefs(['--config', CFG, '--base', 'HEAD~1', '--root', repo.root]), { code: 0, out: [clean(1, 'pushed')], err: [] });
    assert.deepEqual(docRefs(['--config', CFG, '--base', 'HEAD~1', '--head', head, '--root', repo.root]).out, [clean(1, 'pushed')]);
  });

  it('prints the one clean line for the whole tree, and for the checks asked for', () => {
    const repo = repoWith();
    // docs/guide.md and scripts/tool.ts (a code file's comments are references too).
    assert.deepEqual(docRefs(['--config', CFG, '--all', '--root', repo.root]), { code: 0, out: [clean(2, 'all')], err: [] });
    assert.deepEqual(docRefs(['--config', CFG, '--all', '--checks', '01,DOC-DRIFT-04', '--root', repo.root]).out, [clean(2, 'all; DOC-DRIFT-02 not run')]);
    assert.deepEqual(docRefs(['--config', CFG, '--staged', '--checks', '04', '--root', repo.root]).out, [clean(0, 'staged; DOC-DRIFT-01, DOC-DRIFT-02 not run')]);
  });

  it('names what the config leaves unchecked', () => {
    const repo = repoWith({ links: null, identifiers: { jobs: null } });
    assert.deepEqual(docRefs(['--config', CFG, '--all', '--root', repo.root]).out, [clean(2, 'all'), `${P} not checked: links, identifiers.jobs`]);
  });

  it('reads the current directory without --root', () => {
    const repo = repoWith();
    const was = process.cwd();
    process.chdir(join(repo.root, 'docs'));
    try {
      assert.deepEqual(docRefs(['--config', CFG, '--all']).out, [clean(2, 'all')]);
    } finally {
      process.chdir(was);
    }
  });

  it('runs lychee from PATH when no link runner is given', () => {
    const repo = repoWith();
    const bin = mkdtempSync(join(tmpdir(), 'stub-lychee-'));
    const marker = join(bin, 'ran');
    writeFileSync(join(bin, 'lychee'), `#!/bin/sh\ncat > '${marker}'\nprintf '%s\\n' '{"error_map":{}}'\n`);
    chmodSync(join(bin, 'lychee'), 0o755);
    const path = process.env['PATH'];
    process.env['PATH'] = `${bin}${delimiter}${path ?? ''}`;
    try {
      assert.deepEqual(docRefs(['--config', CFG, '--all', '--root', repo.root], null), { code: 0, out: [clean(2, 'all')], err: [] });
      assert.match(readFileSync(marker, 'utf8'), /docs\/guide\.md/);
    } finally {
      process.env['PATH'] = path;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('pariksha doc-references: problems', () => {
  it('prints each problem as file:line: [check] ref: reason, then what to do, on stderr; exit 1', () => {
    const repo = repoWith();
    repo.write('docs/new.md', 'See `scripts/gone.ts`.\n');
    repo.git('add', '-A');
    const result = docRefs(['--config', CFG, '--staged', '--root', repo.root]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.out, []);
    assert.equal(result.err.length, 2);
    assert.match(result.err[0] ?? '', /^pariksha doc-references: docs\/new\.md:1: \[DOC-DRIFT-01\] scripts\/gone\.ts: \S.*$/);
    assert.equal(result.err[1], HINT);
  });

  it('prints slack the change must give up on stderr (exit 1), and slack it need not on stdout (exit 0)', () => {
    const repo = repoWith({}, { 'docs/old.md': 'See `scripts/gone.ts` and `scripts/lost.ts`.\n', [BASELINE]: baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 2 } }) });
    repo.write('docs/old.md', 'See `scripts/tool.ts` and `scripts/lost.ts`.\n');
    repo.git('add', '-A');
    assert.deepEqual(docRefs(['--config', CFG, '--staged', '--root', repo.root]), { code: 1, out: [], err: [`${P} ${BASELINE}: docs/old.md DOC-DRIFT-01: baseline 2, now 1; ${LOWER}`] });

    const other = repoWith({}, { 'docs/old.md': 'See `scripts/gone.ts`.\n', [BASELINE]: baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 1, 'DOC-DRIFT-02': 2 } }) });
    other.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 1, 'DOC-DRIFT-02': 1 } }));
    other.git('add', '-A');
    assert.deepEqual(docRefs(['--config', CFG, '--staged', '--root', other.root]), {
      code: 0,
      out: [`${P} ${BASELINE}: docs/old.md DOC-DRIFT-02: baseline 1, now 0; ${LOWER}`, clean(1, 'staged; DOC-DRIFT-04 not run')],
      err: [],
    });
  });

  it('prints baseline growth on stderr; exit 1', () => {
    const repo = repoWith({}, { 'docs/old.md': 'See `scripts/gone.ts`.\n', [BASELINE]: baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 1 } }) });
    repo.write(BASELINE, baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 2 } }));
    repo.git('add', '-A');
    const result = docRefs(['--config', CFG, '--staged', '--root', repo.root]);
    assert.equal(result.code, 1);
    // The raised entry re-checks the doc, which the change did not touch: its slack is advice.
    assert.deepEqual(result.out, [`${P} ${BASELINE}: docs/old.md DOC-DRIFT-01: baseline 2, now 1; ${LOWER}`]);
    assert.deepEqual(result.err, [`${P} ${BASELINE}: docs/old.md DOC-DRIFT-01: 1 → 2 (a baseline only falls; fix the reference instead)`]);
  });
});

describe('pariksha doc-references: writing the baseline', () => {
  it('--all --write-baseline seeds the file and says what it holds', () => {
    const repo = repoWith({}, { 'docs/old.md': 'See `scripts/gone.ts` and `scripts/lost.ts`.\n' });
    // The baseline's directory exists; the run writes the file, not its folders.
    mkdirSync(join(repo.root, dirname(BASELINE)), { recursive: true });
    assert.deepEqual(docRefs(['--config', CFG, '--all', '--write-baseline', '--root', repo.root]), {
      code: 0,
      out: [`${P} wrote ${BASELINE}: 1 file(s) hold 2 problem(s) (3 reference file(s) checked)`],
      err: [],
    });
    assert.deepEqual(JSON.parse(readFileSync(join(repo.root, BASELINE), 'utf8')), { version: 1, files: { 'docs/old.md': { 'DOC-DRIFT-01': 2 } } });
  });

  it('--all --update-baseline lowers the file and says what it holds', () => {
    const repo = repoWith({}, { 'docs/old.md': 'See `scripts/gone.ts`.\n', 'docs/new.md': 'See `scripts/lost.ts`.\n', [BASELINE]: baseline({ 'docs/old.md': { 'DOC-DRIFT-01': 2 } }) });
    assert.deepEqual(docRefs(['--config', CFG, '--all', '--update-baseline', '--root', repo.root]), {
      code: 0,
      out: [`${P} wrote ${BASELINE}: 1 file(s) hold 2 problem(s) (4 reference file(s) checked)`],
      err: [],
    });
    assert.deepEqual(JSON.parse(readFileSync(join(repo.root, BASELINE), 'utf8')), { version: 1, files: { 'docs/old.md': { 'DOC-DRIFT-01': 1 } } });
  });
});
