import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { findLinkProblems, lycheeInputLine, lycheeRunner, parseLycheeReport, treeFor, type LinkRunner } from './doc-links.ts';
import { CONFIG, createTestRepo, fakeLinks, noLinks, testConfig } from './doc-references.fixture.test.ts';
import { createSnapshot, type RepoSnapshot } from './doc-references.ts';

interface Miss {
  readonly file: string;
  readonly line?: number;
  /** Repo path of the target; '' for the doc itself. */
  readonly target: string;
  readonly hash?: string;
  readonly text?: string;
}

/** lychee's `--format json` report of a run in `dir`, as 0.24 writes it. */
const lycheeReport = (dir: string, misses: readonly Miss[]): string => {
  const root = realpathSync(dir);
  const errorMap: Record<string, unknown[]> = {};
  for (const miss of misses) {
    const url = pathToFileURL(join(root, miss.target || miss.file));
    url.hash = miss.hash ?? '';
    (errorMap[miss.file] ??= []).push({
      url: url.href,
      status: { text: miss.text ?? (miss.hash === undefined ? 'File not found. Check if file exists and path is correct' : 'Cannot find fragment') },
      ...(miss.line === undefined ? {} : { span: { line: miss.line, column: 1 } }),
    });
  }
  return JSON.stringify({ total: misses.length, error_map: errorMap });
};

// ── a stand-in lychee executable ────────────────────────────────────────────

const stubDirs: string[] = [];
after(() => {
  for (const dir of stubDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A shell script standing where lychee would: it records its arguments (one
 * per line), its stdin and its physical working directory beside itself,
 * prints the report it was given, writes `stderr` to stderr and exits with
 * `status`.
 */
const SCRIPT = [
  '#!/bin/sh',
  'here=$(dirname "$0")',
  'pwd -P > "$here/cwd"',
  ': > "$here/args"',
  'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$here/args"; done',
  'cat > "$here/stdin"',
  'cat "$here/report"',
  'cat "$here/stderr" >&2',
  'exit "$(cat "$here/status")"',
  '',
].join('\n');

interface Stub {
  readonly command: string;
  report(text: string): void;
  ran(): boolean;
  args(): string[];
  stdin(): string;
  cwd(): string;
}

const stub = ({ report = '{"error_map":{}}', status = 0, stderr = '', mode = 0o755 }: { report?: string; status?: number; stderr?: string; mode?: number } = {}): Stub => {
  const dir = mkdtempSync(join(tmpdir(), 'lychee-stub-'));
  stubDirs.push(dir);
  const command = join(dir, 'lychee');
  writeFileSync(command, SCRIPT);
  chmodSync(command, mode);
  const put = (name: string, text: string): void => writeFileSync(join(dir, name), text);
  put('report', report);
  put('status', String(status));
  put('stderr', stderr);
  const get = (name: string): string => readFileSync(join(dir, name), 'utf8');
  return {
    command,
    report: (text) => put('report', text),
    ran: () => existsSync(join(dir, 'args')),
    args: () => get('args').split('\n').slice(0, -1),
    stdin: () => get('stdin'),
    cwd: () => get('cwd').trim(),
  };
};

/** The arguments the runner must hand lychee for a run in `realDir` (a physical path). */
const expectedArgs = (realDir: string): string[] => ['--offline', '--include-fragments', '--format', 'json', '--no-progress', '--config', '/dev/null', '--root-dir', realDir, '--files-from', '-'];

describe('parseLycheeReport', () => {
  const dir = tmpdir();

  it('names each target from its doc, as the link was written', () => {
    const report = lycheeReport(dir, [
      { file: 'docs/c.md', line: 7, target: 'docs/d.md', hash: '#there' },
      { file: 'docs/a.md', line: 3, target: 'docs/b.md' },
      { file: 'docs/a.md', line: 2, target: '', hash: '#nope' },
      { file: 'docs/a.md', line: 9, target: 'apps/x.ts', hash: '#L4' },
    ]);
    assert.deepEqual(parseLycheeReport(report, dir), [
      { file: 'docs/a.md', line: 2, ref: '#nope', reason: 'Cannot find heading for `#nope`' },
      { file: 'docs/a.md', line: 3, ref: 'b.md', reason: 'Cannot find file `b.md`' },
      { file: 'docs/a.md', line: 9, ref: '../apps/x.ts#L4', reason: 'Cannot find heading for `#L4` in `../apps/x.ts`' },
      { file: 'docs/c.md', line: 7, ref: 'd.md#there', reason: 'Cannot find heading for `#there` in `d.md`' },
    ]);
  });

  it('decodes an escaped path and keeps an unknown status as written', () => {
    const report = lycheeReport(dir, [{ file: 'a.md', line: 1, target: 'my notes.md', text: 'Odd failure' }]);
    assert.deepEqual(parseLycheeReport(report, dir), [{ file: 'a.md', line: 1, ref: 'my notes.md', reason: 'Odd failure: `my notes.md`' }]);
  });

  it('skips a URL and an entry without one; a missing span is line 1', () => {
    const report = JSON.stringify({
      error_map: {
        'a.md': [{ url: 'https://example.com/', status: { text: 'Blocked' } }, { status: { text: 'no url' } }, { url: pathToFileURL(join(realpathSync(dir), 'gone.md')).href }],
      },
    });
    assert.deepEqual(parseLycheeReport(report, dir), [{ file: 'a.md', line: 1, ref: 'gone.md', reason: 'lychee could not check it: `gone.md`' }]);
  });

  it('refuses a report that is not the shape lychee writes', () => {
    const where = 'error_map["a.md"][0]';
    assert.throws(() => parseLycheeReport('{"error_map":{"a.md":[{"url":3}]}}', dir), { message: `lychee's report: ${where}.url is not a string` });
    assert.throws(() => parseLycheeReport('not json', dir), SyntaxError);
    // A span line is a 1-based line number, never a fraction or zero.
    for (const line of ['2.5', '0', '"3"']) {
      const report = `{"error_map":{"a.md":[{"url":"file:///x.md","span":{"line":${line}}}]}}`;
      assert.throws(() => parseLycheeReport(report, dir), { message: `lychee's report: ${where}.span.line is not a positive integer` });
    }
  });

  it('names the part of the report that is out of shape', () => {
    const where = 'error_map["a.md"][0]';
    for (const [report, message] of [
      ['[]', "lychee's report is not a JSON object"],
      ['{"error_map":[]}', "lychee's report: error_map is not an object"],
      ['{"error_map":{"a.md":{}}}', 'lychee\'s report: error_map["a.md"] is not a list'],
      ['{"error_map":{"a.md":[3]}}', `lychee's report: ${where} is not an object`],
      ['{"error_map":{"a.md":[{"status":"x"}]}}', `lychee's report: ${where}.status is not an object`],
      ['{"error_map":{"a.md":[{"span":"x"}]}}', `lychee's report: ${where}.span is not an object`],
      ['{"error_map":{"a.md":[{"status":{"text":3}}]}}', `lychee's report: ${where}.status.text is not a string`],
    ] as const) {
      assert.throws(() => parseLycheeReport(report, dir), { message }, report);
    }
  });

  it('reads a clean report as nothing', () => {
    assert.deepEqual(parseLycheeReport('{"total":3,"error_map":{}}', dir), []);
    assert.deepEqual(parseLycheeReport('{"total":0}', dir), []);
  });

  it('reads an entry with no status as one lychee could not check', () => {
    const report = JSON.stringify({ error_map: { 'a.md': [{ url: pathToFileURL(join(realpathSync(dir), 'gone.md')).href, span: { line: 4 } }] } });
    assert.deepEqual(parseLycheeReport(report, dir), [{ file: 'a.md', line: 4, ref: 'gone.md', reason: 'lychee could not check it: `gone.md`' }]);
  });
});

describe('findLinkProblems with a recorded report', () => {
  const files = {
    'docs/a.md': ['# A', '[ok](c.md)', '[gone](b.md)', '[quoted](gone.md) <!-- doc-ref-ok: quoted finding -->', '[pattern](<NNN>.md)', '[scratch](../.tmp/out.md)', ''].join('\n'),
    'docs/c.md': '# C\n',
  };

  it('keeps only real misses in the files asked about', () => {
    const repo = createTestRepo(files);
    const asked: string[][] = [];
    const found = findLinkProblems(CONFIG, repo.snapshot(), ['docs/a.md', 'scripts/x.ts'], (dir, docs) => {
      assert.equal(dir, repo.root);
      asked.push([...docs]);
      return lycheeReport(dir, [
        { file: 'docs/a.md', line: 3, target: 'docs/b.md' },
        { file: 'docs/a.md', line: 4, target: 'docs/gone.md' },
        { file: 'docs/a.md', line: 5, target: 'docs/<NNN>.md' },
        { file: 'docs/a.md', line: 6, target: '.tmp/out.md' },
        { file: 'docs/c.md', line: 1, target: '', hash: '#x' },
      ]);
    });
    assert.deepEqual(asked, [['docs/a.md']]);
    // c.md was not asked about; the marker, the placeholder and the ignored
    // scratch path stay out.
    assert.deepEqual(found, [{ check: 'DOC-DRIFT-01', file: 'docs/a.md', line: 3, ref: 'b.md', reason: 'Cannot find file `b.md`' }]);
  });

  it('a bare marker is no opt-out, and an in-doc anchor has no target to ignore', () => {
    const repo = createTestRepo({ 'docs/a.md': '# A\n[x](#y) doc-ref-ok:\n' });
    const found = findLinkProblems(CONFIG, repo.snapshot(), ['docs/a.md'], (dir) => lycheeReport(dir, [{ file: 'docs/a.md', line: 2, target: '', hash: '#y' }]));
    assert.deepEqual(
      found.map((p) => p.ref),
      ['#y'],
    );
  });

  it('drops an ignored target, a directory one or behind an anchor; keeps an in-doc anchor', () => {
    const repo = createTestRepo({ '.gitignore': 'node_modules/\n.tmp/\nout/\n*.log\n', 'docs/a.md': '[d](../out)\n[l](x.log#top)\n' });
    repo.write('out/a.md', '[x](#y)\n');
    repo.git('add', '-f', 'out/a.md');
    const found = findLinkProblems(CONFIG, repo.snapshot(), ['docs/a.md', 'out/a.md'], (dir) =>
      lycheeReport(dir, [
        { file: 'docs/a.md', line: 1, target: 'out' },
        { file: 'docs/a.md', line: 2, target: 'docs/x.log', hash: '#top' },
        { file: 'out/a.md', line: 1, target: '', hash: '#y' },
      ]),
    );
    assert.deepEqual(
      found.map((p) => [p.file, p.ref]),
      [['out/a.md', '#y']],
    );
  });

  it('runs nothing when no Markdown file is asked about', () => {
    const repo = createTestRepo({ 'docs/page.html': '<a href="x.md">x</a>\n' });
    const run: LinkRunner = () => {
      throw new Error('must not run');
    };
    assert.deepEqual(findLinkProblems(CONFIG, repo.snapshot(), [], run), []);
    assert.deepEqual(findLinkProblems(CONFIG, repo.snapshot(), ['docs/page.html'], run), []);
  });

  it('runs nothing when the config leaves links unchecked', () => {
    const repo = createTestRepo({ 'docs/a.md': '[gone](b.md)\n' });
    const run: LinkRunner = () => {
      throw new Error('must not run');
    };
    const config = testConfig({ links: null });
    assert.equal(config.links, undefined);
    assert.deepEqual(findLinkProblems(config, repo.snapshot(), ['docs/a.md'], run), []);
    assert.equal(findLinkProblems(CONFIG, repo.snapshot(), ['docs/a.md'], fakeLinks).length, 1);
  });

  it('hands the runner only the docs `links.include` takes', () => {
    const repo = createTestRepo({ 'docs/a.md': '[gone](b.md)\n', 'docs/b.mdx': '[gone](c.md)\n' });
    const config = testConfig({ links: { include: '\\.mdx$' } });
    const asked: string[][] = [];
    const found = findLinkProblems(config, repo.snapshot(), ['docs/a.md', 'docs/b.mdx'], (dir, docs) => {
      asked.push([...docs]);
      return lycheeReport(dir, [{ file: 'docs/b.mdx', line: 1, target: 'docs/c.md' }]);
    });
    assert.deepEqual(asked, [['docs/b.mdx']]);
    assert.deepEqual(
      found.map((p) => [p.file, p.ref]),
      [['docs/b.mdx', 'c.md']],
    );
  });

  it('keeps a finding on a line past the end of its doc, or in a doc the snapshot lacks', () => {
    const repo = createTestRepo({ 'docs/a.md': '[gone](b.md)\n' });
    const found = findLinkProblems(CONFIG, repo.snapshot(), ['docs/a.md', 'docs/absent.md'], (dir) =>
      lycheeReport(dir, [
        { file: 'docs/a.md', line: 40, target: 'docs/b.md' },
        { file: 'docs/absent.md', line: 1, target: 'docs/c.md' },
      ]),
    );
    assert.deepEqual(
      found.map((p) => [p.file, p.line, p.ref]),
      [
        ['docs/a.md', 40, 'b.md'],
        ['docs/absent.md', 1, 'c.md'],
      ],
    );
  });

  it('reads the marker word and the placeholder the config names', () => {
    const repo = createTestRepo({ 'docs/a.md': '[a](a.md) link-ok: quoted\n[b](TODO.md)\n[c](c.md) doc-ref-ok: quoted\n' });
    const config = testConfig({ exemptMarker: 'link-ok', placeholder: 'TODO' });
    const found = findLinkProblems(config, repo.snapshot(), ['docs/a.md'], (dir) =>
      lycheeReport(dir, [
        { file: 'docs/a.md', line: 1, target: 'docs/a2.md' },
        { file: 'docs/a.md', line: 2, target: 'docs/TODO.md' },
        { file: 'docs/a.md', line: 3, target: 'docs/c.md' },
      ]),
    );
    assert.deepEqual(
      found.map((p) => p.line),
      [3],
    );
  });

  it('reports nothing for a clean run', () => {
    const repo = createTestRepo({ 'docs/a.md': '# A\n' });
    assert.deepEqual(findLinkProblems(CONFIG, repo.snapshot(), ['docs/a.md'], noLinks), []);
  });
});

describe('treeFor', () => {
  it('reads a worktree or index snapshot where it stands', () => {
    const repo = createTestRepo({ 'docs/a.md': '# A\n' });
    const tree = treeFor(repo.snapshot('index'));
    assert.equal(tree.dir, repo.root);
    tree.release();
    assert.equal(existsSync(join(repo.root, 'docs/a.md')), true);
  });

  it('extracts a ref to a directory of its own, and removes it after', () => {
    const repo = createTestRepo({ 'docs/a.md': 'first\n' });
    const sha = repo.commit('first');
    repo.write('docs/a.md', 'second\n');
    repo.commit('second');
    const tree = treeFor(createSnapshot(repo.root, { kind: 'ref', ref: sha }));
    assert.notEqual(tree.dir, repo.root);
    assert.equal(readFileSync(join(tree.dir, 'docs/a.md'), 'utf8'), 'first\n');
    assert.equal(existsSync(join(tree.dir, '.tree.tar')), false);
    assert.match(basename(tree.dir), /^doc-links-/);
    tree.release();
    assert.equal(existsSync(tree.dir), false);
    // Released twice (a failed run, then cleanup): the second is a no-op.
    assert.doesNotThrow(() => tree.release());
  });

  it('releases the extracted tree even when the run fails', () => {
    const repo = createTestRepo({ 'docs/a.md': '# A\n' });
    const sha = repo.commit();
    let seen = '';
    assert.throws(
      () =>
        findLinkProblems(CONFIG, createSnapshot(repo.root, { kind: 'ref', ref: sha }), ['docs/a.md'], (dir) => {
          seen = dir;
          throw new Error('lychee failed');
        }),
      { message: 'lychee failed' },
    );
    assert.notEqual(seen, '');
    assert.equal(existsSync(seen), false);
  });

  it('fails when the ref cannot be extracted', () => {
    const repo = createTestRepo({ 'docs/a.md': '# A\n' });
    repo.commit();
    const bad: RepoSnapshot = { ...repo.snapshot(), source: { kind: 'ref', ref: 'no-such-ref' } };
    assert.throws(() => treeFor(bad));
  });

  it('reads a pushed ref, not the worktree', () => {
    const repo = createTestRepo({ 'docs/a.md': '[x](b.md)\n', 'docs/b.md': '# B\n' });
    const sha = repo.commit();
    repo.remove('docs/b.md');
    const ref = createSnapshot(repo.root, { kind: 'ref', ref: sha });
    assert.deepEqual(findLinkProblems(CONFIG, ref, ['docs/a.md'], fakeLinks), []);
    assert.equal(findLinkProblems(CONFIG, repo.snapshot(), ['docs/a.md'], fakeLinks).length, 1);
    // The runner itself is started in the extracted tree, not the worktree.
    const lychee = stub();
    findLinkProblems(CONFIG, ref, ['docs/a.md'], lycheeRunner(lychee.command));
    assert.notEqual(lychee.cwd(), realpathSync(repo.root));
    assert.match(basename(lychee.cwd()), /^doc-links-/);
    // Its `--root-dir` is that tree too, which is released after the run.
    assert.deepEqual(lychee.args(), expectedArgs(lychee.cwd()));
    assert.equal(existsSync(lychee.cwd()), false);
  });
});

describe('lycheeInputLine', () => {
  it('names a doc as a relative path, a URL-like or glob-like name as that doc alone', () => {
    assert.equal(lycheeInputLine('docs/a.md'), './docs/a.md');
    assert.equal(lycheeInputLine('docs/https:x.md'), './docs/https:x.md');
    assert.equal(lycheeInputLine('docs/c[1].md'), './docs/c[[]1].md');
    assert.equal(lycheeInputLine('docs/d*?.md'), './docs/d[*][?].md');
  });

  it('refuses a doc path holding a newline rather than leave it unchecked', () => {
    assert.throws(() => lycheeInputLine('docs/a\nb.md'), /cannot check "docs\/a\\nb\.md": rename it/);
    assert.throws(() => lycheeInputLine('docs/a\rb.md'), /cannot check "docs\/a\\rb\.md"/);
  });
});

describe('lycheeRunner, on a stand-in executable', () => {
  it('finds a missing file, a missing heading and a missing heading in another file', () => {
    const repo = createTestRepo({
      'docs/a.md': ['# A', '', '[here](#a) [there](b.md#set-up) [gone](missing.md)', '[nope](#tear-down) [far](b.md#tear-down)', '', '[def]: also-missing.md', '', 'See [def] and ![pic](pic.png) and [root](/docs/b.md).', '', '```md', '[in code](not-checked.md)', '```', ''].join('\n'),
      'docs/b.md': '# B\n\n## Set up\n',
    });
    // What lychee reports for this doc: a reference link where it is used, not defined.
    const lychee = stub({ status: 2 });
    lychee.report(
      lycheeReport(repo.root, [
        { file: 'docs/a.md', line: 3, target: 'docs/missing.md' },
        { file: 'docs/a.md', line: 4, target: '', hash: '#tear-down' },
        { file: 'docs/a.md', line: 4, target: 'docs/b.md', hash: '#tear-down' },
        { file: 'docs/a.md', line: 8, target: 'docs/also-missing.md' },
        { file: 'docs/a.md', line: 8, target: 'docs/pic.png' },
      ]),
    );
    const found = findLinkProblems(CONFIG, repo.snapshot(), ['docs/a.md'], lycheeRunner(lychee.command));
    assert.deepEqual(
      found.map((p) => [p.line, p.ref]).sort(),
      [
        [3, 'missing.md'],
        [4, '#tear-down'],
        [4, 'b.md#tear-down'],
        [8, 'also-missing.md'],
        [8, 'pic.png'],
      ].sort(),
    );
    assert.equal(lychee.stdin(), './docs/a.md\n');
    assert.equal(lychee.cwd(), realpathSync(repo.root));
  });

  it('hands lychee every doc asked about, one per line, and reads its report as text', () => {
    const repo = createTestRepo({ 'docs/a.md': '[gone](a-missing.md)\n', 'docs/b.md': '# B\n\n[gone](b-missing.md)\n', 'docs/c d.md': '[gone](c-missing.md)\n' });
    const lychee = stub({ status: 2 });
    lychee.report(
      lycheeReport(repo.root, [
        { file: 'docs/a.md', line: 1, target: 'docs/a-missing.md' },
        { file: 'docs/b.md', line: 3, target: 'docs/b-missing.md' },
        { file: 'docs/c d.md', line: 1, target: 'docs/c-missing.md' },
      ]),
    );
    const report = lycheeRunner(lychee.command)(repo.root, ['docs/a.md', 'docs/b.md', 'docs/c d.md']);
    assert.equal(typeof report, 'string');
    assert.equal(lychee.stdin(), './docs/a.md\n./docs/b.md\n./docs/c d.md\n');
    assert.deepEqual(
      parseLycheeReport(report, repo.root).map((f) => [f.file, f.line, f.ref]),
      [
        ['docs/a.md', 1, 'a-missing.md'],
        ['docs/b.md', 3, 'b-missing.md'],
        ['docs/c d.md', 1, 'c-missing.md'],
      ],
    );
  });

  it('checks a doc whose name reads as a URL or a glob as that doc alone', () => {
    const repo = createTestRepo({ 'docs/https:x.md': '[gone](x-missing.md)\n', 'docs/c[1].md': '[gone](c-missing.md)\n', 'docs/c1.md': '[gone](c1-missing.md)\n', 'docs/d*?.md': '[gone](d-missing.md)\n' });
    const lychee = stub({ status: 2 });
    lychee.report(
      lycheeReport(repo.root, [
        { file: 'docs/https:x.md', line: 1, target: 'docs/x-missing.md' },
        { file: 'docs/c[1].md', line: 1, target: 'docs/c-missing.md' },
        { file: 'docs/d*?.md', line: 1, target: 'docs/d-missing.md' },
      ]),
    );
    const report = lycheeRunner(lychee.command)(repo.root, ['docs/https:x.md', 'docs/c[1].md', 'docs/d*?.md']);
    // `c1.md` would match an unbracketed `c[1].md`; the bracketed line names the one doc.
    assert.equal(lychee.stdin(), './docs/https:x.md\n./docs/c[[]1].md\n./docs/d[*][?].md\n');
    assert.deepEqual(
      parseLycheeReport(report, repo.root).map((f) => [f.file, f.ref]),
      [
        ['docs/c[1].md', 'c-missing.md'],
        ['docs/d*?.md', 'd-missing.md'],
        ['docs/https:x.md', 'x-missing.md'],
      ],
    );
  });

  it('refuses a doc path holding a newline before lychee runs', () => {
    const repo = createTestRepo({ 'docs/a.md': '# A\n' });
    const lychee = stub();
    assert.throws(() => lycheeRunner(lychee.command)(repo.root, ['docs/a\nb.md']), /cannot check "docs\/a\\nb\.md": rename it/);
    assert.throws(() => lycheeRunner(lychee.command)(repo.root, ['docs/a\rb.md']), /cannot check "docs\/a\\rb\.md"/);
    assert.equal(lychee.ran(), false);
  });

  it("reads no lychee config of the tree's, and reports nothing for a clean doc", () => {
    const repo = createTestRepo({ 'lychee.toml': 'exclude_path = ["docs"]\n', 'docs/ok.md': '# OK\n\n[self](#ok)\n' });
    const lychee = stub({ status: 0, report: '{"total":1,"error_map":{}}' });
    const report = lycheeRunner(lychee.command)(repo.root, ['docs/ok.md']);
    assert.deepEqual(lychee.args(), expectedArgs(realpathSync(repo.root)));
    assert.ok(lychee.args().includes('/dev/null'));
    assert.deepEqual(parseLycheeReport(report, repo.root), []);
  });

  it('fails loudly when lychee cannot run', () => {
    const repo = createTestRepo({});
    const lychee = stub({ status: 1, report: '', stderr: 'Error: Cannot read input docs/absent.md\n' });
    assert.throws(() => lycheeRunner(lychee.command)(repo.root, ['docs/absent.md']), { message: 'lychee exited 1: Error: Cannot read input docs/absent.md\n' });
  });

  it('fails loudly when lychee is not installed', () => {
    const repo = createTestRepo({ 'docs/a.md': '# A\n' });
    const absent = join(repo.root, 'no-such-bin', 'lychee');
    assert.throws(() => lycheeRunner(absent)(repo.root, ['docs/a.md']), { message: `${absent} is not installed; the link check needs lychee (https://lychee.cli.rs)` });
  });

  it('looks for `lychee` on PATH by default', () => {
    const repo = createTestRepo({ 'docs/a.md': '# A\n' });
    const empty = join(repo.root, 'empty-bin');
    mkdirSync(empty);
    const saved = process.env['PATH'];
    process.env['PATH'] = empty;
    try {
      assert.throws(() => lycheeRunner()(repo.root, ['docs/a.md']), { message: 'lychee is not installed; the link check needs lychee (https://lychee.cli.rs)' });
    } finally {
      process.env['PATH'] = saved;
    }
  });

  it('passes on any other failure to start it', () => {
    const repo = createTestRepo({ 'docs/a.md': '# A\n' });
    const lychee = stub({ mode: 0o644 });
    assert.throws(() => lycheeRunner(lychee.command)(repo.root, ['docs/a.md']), { code: 'EACCES' });
    assert.equal(lychee.ran(), false);
  });
});
