// The doc-references engine's shared part: the snapshot a reference resolves
// against, tracked .gitignore rules, which files carry references, the
// Markdown reader, the per-file baseline, the path helpers and the merge a
// staged run may be in the middle of.
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { CONFIG, CONFIG_JSON, createTestRepo, testConfig, type TestRepo } from './doc-references.fixture.test.ts';
import {
  ancestorDirs,
  applyBaseline,
  backtickRuns,
  baselineGrowth,
  catFileBatch,
  CHECK_IDS,
  codeSpans,
  commentText,
  countProblems,
  createSnapshot,
  docKind,
  emptyBaseline,
  git,
  gitOrUndefined,
  globToRegExp,
  isShellFence,
  mergeHeads,
  normalizeRepoPath,
  parseBaseline,
  proseOnly,
  referenceFiles,
  scanMarkdown,
  serializeBaseline,
  takenFromMerge,
  type Baseline,
  type ReferenceProblem,
} from './doc-references.ts';

const problem = (file: string, line: number): ReferenceProblem => ({ check: 'DOC-DRIFT-01', file, line, ref: 'x', reason: 'r' });

/** A baseline's files as plain objects, for a deep comparison (parseBaseline builds a prototype-free map). */
const plainFiles = (baseline: Baseline): Record<string, Partial<Record<string, number>>> => Object.fromEntries(Object.entries(baseline.files).map(([file, counts]) => [file, { ...counts }]));

const scan = (content: string) => scanMarkdown(content, CONFIG.exemptMarker);

describe('baseline', () => {
  const baseline: Baseline = { version: 1, files: { 'a.md': { 'DOC-DRIFT-01': 2 } } };

  it('round-trips, sorted, dropping zero counts', () => {
    const text = serializeBaseline({
      version: 1,
      files: { 'b.md': { 'DOC-DRIFT-04': 1 }, 'a.md': { 'DOC-DRIFT-01': 2 }, 'c.md': { 'DOC-DRIFT-02': 0 } },
    });
    assert.deepEqual(Object.keys(parseBaseline(text, CONFIG.baseline).files), ['a.md', 'b.md']);
  });

  for (const [text, message] of [
    ['{"version":2,"files":{}}', /expected/],
    ['3', /expected/],
    ['null', /expected/],
    ['{"files":{}}', /expected/],
    ['{"version":1}', /expected/],
    ['{"version":1,"files":null}', /expected/],
    ['{"version":1,"files":3}', /expected/],
    ['{"version":1,"files":{},"extra":1}', /expected/],
    ['{"version":1,"files":{"a.md":3}}', /must map/],
    ['{"version":1,"files":{"a.md":null}}', /must map/],
    ['{"version":1,"files":{"a.md":{"DOC-DRIFT-09":1}}}', /unknown check/],
    ['{"version":1,"files":{"a.md":{"DOC-DRIFT-01":0}}}', /positive integer/],
    ['{"version":1,"files":{"a.md":{"DOC-DRIFT-01":1.5}}}', /positive integer/],
    ['{"version":1,"files":{"a.md":{"DOC-DRIFT-01":"1"}}}', /positive integer/],
    ['{"version":1,', /not JSON/],
  ] as const) {
    it(`refuses a malformed baseline: ${text}`, () => {
      assert.throws(
        () => parseBaseline(text, 'where.json'),
        (e: unknown) => e instanceof Error && e.message.startsWith('where.json: ') && message.test(e.message),
      );
    });
  }

  it('names the baseline file in a refusal, and accepts every check id', () => {
    assert.throws(() => parseBaseline('3', CONFIG.baseline), { message: 'scripts/docs/doc-references-baseline.json: expected { "version": 1, "files": {} }' });
    assert.equal(CONFIG.baseline, 'scripts/docs/doc-references-baseline.json');
    assert.deepEqual(CHECK_IDS, ['DOC-DRIFT-01', 'DOC-DRIFT-02', 'DOC-DRIFT-04']);
    assert.deepEqual(plainFiles(parseBaseline('{"version":1,"files":{"a.md":{"DOC-DRIFT-01":1,"DOC-DRIFT-02":2,"DOC-DRIFT-04":3}}}', CONFIG.baseline)), {
      'a.md': { 'DOC-DRIFT-01': 1, 'DOC-DRIFT-02': 2, 'DOC-DRIFT-04': 3 },
    });
  });

  it('keys a file named like an Object member as an entry, not the prototype', () => {
    const parsed = parseBaseline('{"version":1,"files":{"constructor":{"DOC-DRIFT-01":1}}}', 'b.json');
    assert.deepEqual(Object.keys(parsed.files), ['constructor']);
    assert.equal(Object.getPrototypeOf(emptyBaseline().files), null);
  });

  it('fails only the over-count file and check, never a neighbour', () => {
    const problems = [problem('a.md', 1), problem('a.md', 2), problem('a.md', 3), { ...problem('a.md', 4), check: 'DOC-DRIFT-04' as const }, problem('b.md', 1)];
    assert.deepEqual(applyBaseline(problems, baseline, ['a.md'], ['DOC-DRIFT-01']).failures, problems.slice(0, 3));
  });

  it('fails a file over its count with every problem it has', () => {
    const problems = [problem('a.md', 1), problem('a.md', 2), problem('a.md', 3)];
    const result = applyBaseline(problems, baseline, ['a.md'], ['DOC-DRIFT-01']);
    assert.equal(result.failures.length, 3);
    assert.deepEqual(result.slack, []);
  });

  it('passes a file at its count and reports slack under it', () => {
    assert.deepEqual(applyBaseline([problem('a.md', 1), problem('a.md', 2)], baseline, ['a.md'], ['DOC-DRIFT-01']), { failures: [], slack: [] });
    assert.deepEqual(applyBaseline([problem('a.md', 1)], baseline, ['a.md'], ['DOC-DRIFT-01']).slack, [{ file: 'a.md', check: 'DOC-DRIFT-01', baseline: 2, actual: 1 }]);
  });

  it('fails any problem in a file without an entry', () => {
    assert.equal(applyBaseline([problem('b.md', 1)], baseline, ['b.md'], ['DOC-DRIFT-01']).failures.length, 1);
  });

  it('reports growth: a new entry or a raised count', () => {
    const next: Baseline = { version: 1, files: { 'a.md': { 'DOC-DRIFT-01': 3 }, 'b.md': { 'DOC-DRIFT-04': 1 } } };
    const growth = baselineGrowth(baseline, next);
    assert.equal(growth.length, 2);
    assert.ok(growth[0]?.includes('a.md DOC-DRIFT-01: 2 → 3'), growth[0]);
    assert.ok(growth[1]?.includes('b.md DOC-DRIFT-04: 0 → 1'), growth[1]);
    assert.deepEqual(baselineGrowth(next, baseline), []);
  });

  it('counts problems per file and check', () => {
    const counts = countProblems([problem('a.md', 1), problem('a.md', 2), { ...problem('a.md', 3), check: 'DOC-DRIFT-02' }, problem('b.md', 1)]);
    assert.deepEqual(
      [...counts].map(([file, byCheck]) => [file, [...byCheck]]),
      [
        ['a.md', [['DOC-DRIFT-01', 2], ['DOC-DRIFT-02', 1]]],
        ['b.md', [['DOC-DRIFT-01', 1]]],
      ],
    );
  });

  it('writes a file whose entry holds no count as absent', () => {
    const files = emptyBaseline().files;
    files['a.md'] = {};
    assert.equal(serializeBaseline({ version: 1, files }), '{\n  "version": 1,\n  "files": {}\n}\n');
  });
});

describe('markdown structure', () => {
  it('separates frontmatter, fences, comments, strikethrough and markers', () => {
    const lines = scan(
      ['---', 'paths: docs/a.md', '---', 'text <!-- hidden --> shown ~~old~~', '<!-- open', 'still hidden -->after', '````bash', '```', 'pnpm x', '````', 'tail <!-- doc-ref-ok: why -->'].join('\n'),
    );
    assert.deepEqual(
      lines.map((l) => [l.number, l.text, l.fence, l.frontmatter]),
      [
        [2, 'paths: docs/a.md', null, true],
        [4, 'text  shown ', null, false],
        [5, '', null, false],
        [6, 'after', null, false],
        [8, '```', 'bash', false],
        [9, 'pnpm x', 'bash', false],
        [11, 'tail ', null, false],
      ],
    );
    assert.equal(lines.at(-1)?.exempt, true);
    assert.equal(lines[0]?.exempt, false);
  });

  it('reads the exempt marker the config names, and only with a reason', () => {
    const marked = scanMarkdown('a skip-it: why\nb skip-it:\nc doc-ref-ok: why', testConfig({ exemptMarker: 'skip-it' }).exemptMarker);
    assert.deepEqual(
      marked.map((l) => l.exempt),
      [true, false, false],
    );
  });

  // Back-to-back fences with one info string are told apart by their block.
  it('numbers each fence a fenced line is in', () => {
    assert.deepEqual(
      scan(['---', 'a: 1', '---', 'prose', '```bash', 'x', 'y', '```', '```bash', 'z', '```', '~~~', 'w'].join('\n')).map((l) => [l.number, l.block]),
      [
        [2, null],
        [4, null],
        [6, 1],
        [7, 1],
        [10, 2],
        [13, 3],
      ],
    );
  });

  it('finds code spans and blanks them out of prose', () => {
    const text = 'a `b` c ``d ` e`` f';
    const spans = codeSpans(text);
    assert.deepEqual(
      spans.map((s) => s.content),
      ['b', 'd ` e'],
    );
    assert.equal(proseOnly(text, spans).length, text.length);
    assert.ok(!proseOnly(text, spans).includes('b'));
  });

  it('blanks the whole delimiter run, so a double-backtick span leaves no backtick', () => {
    const text = 'a ``d ` e`` f';
    assert.equal(proseOnly(text, codeSpans(text)), `a ${' '.repeat(9)} f`);
  });

  it('a <!-- quoted in a code span opens no comment', () => {
    assert.deepEqual(
      scan(['Write `<!--` to open one.', 'see docs/a.md', 'x <!-- c --> y'].join('\n')).map((line) => line.text),
      ['Write `<!--` to open one.', 'see docs/a.md', 'x  y'],
    );
    // Right after a span, and in a span holding only it, as written.
    assert.deepEqual(
      scan('x `a`<!-- c --> y\n`<!--` z').map((line) => line.text),
      ['x `a` y', '`<!--` z'],
    );
  });

  it('closes and reopens comments on one line, carrying the open one on', () => {
    assert.deepEqual(
      scan(['a <!-- b --> c <!-- d', 'e --> f <!----> g', 'h'].join('\n')).map((line) => line.text),
      ['a  c ', ' f  g', 'h'],
    );
  });

  for (const [label, text, runs] of [
    ['plain spans', 'a `b` c', [{ open: 2, length: 1, close: 4 }]],
    [
      'a run that never closes, then a span',
      '``a `b`',
      [
        { open: 0, length: 2, close: -1 },
        { open: 4, length: 1, close: 6 },
      ],
    ],
    ['an escaped backtick', '\\`a`', [{ open: 3, length: 1, close: -1 }]],
    ['a longer run inside a span', '`a ``` b`', [{ open: 0, length: 1, close: 8 }]],
  ] as const) {
    it(`backtick runs: ${label}`, () => {
      assert.deepEqual(backtickRuns(text), runs);
    });
  }

  for (const [label, text, roles] of [
    // Shapes a differential run found misread.
    ['an indented --- inside frontmatter', '---\ntitle: |\n  a\n  ---\n---\nb', ['frontmatter', 'frontmatter', 'frontmatter', 'prose']],
    ['a backtick in a backtick info string', '```a`b\nc', ['prose', 'prose']],
    ['a closer followed by a backtick', '```\n``` `\nc\n```', ['sh', 'sh']],
    ['a fence inside a comment', '<!--\n```\n-->\nc', ['prose', 'prose', 'prose', 'prose']],
    ['a tilde info word with a backtick', '~~~A`b\nc\n~~~', ['a`b']],
  ] as const) {
    it(`reads ${label} as CommonMark and YAML do`, () => {
      assert.deepEqual(
        scan(text).map((line) => (line.frontmatter ? 'frontmatter' : line.fence === null ? 'prose' : line.fence === '' ? 'sh' : line.fence)),
        roles,
      );
    });
  }

  for (const [label, text, contents] of [
    ['an escaped backtick', 'a \\`b` c', []],
    ['a run opened mid-way', 'a ``b` c', []],
    ['an escaped backslash before a backtick', 'a \\\\`b` c', ['b']],
  ] as const) {
    it(`code spans: ${label}`, () => {
      assert.deepEqual(
        codeSpans(text).map((span) => span.content),
        contents,
      );
    });
  }

  it('reads comments by language, never string contents', () => {
    const hash = CONFIG.files.hashComments;
    assert.equal(commentText(hash, 'a.ts', '  // see x'), ' see x');
    assert.equal(commentText(hash, 'a.ts', ' * see x'), ' see x');
    assert.equal(commentText(hash, 'a.ts', '/* see x'), ' see x');
    assert.equal(commentText(hash, 'a.ts', ' */'), null);
    assert.equal(commentText(hash, 'a.ts', "const u = 'http://x'"), null);
    assert.equal(commentText(hash, 'a.sh', '# see x'), ' see x');
    assert.equal(commentText(hash, '.husky/pre-push', '#!/bin/sh'), null);
    assert.equal(commentText(hash, 'a.py', 'x = 1'), null);
  });

  // The source repository's own exclusions, as config: its native folders, its
  // frozen history folders and the gate's own sources.
  const sourceExcludes = testConfig({
    files: {
      exclude: [
        '(^|/)node_modules/',
        '(^|/)__fixtures__/',
        '(^|/)fixtures?/',
        '(^|/)__snapshots__/',
        '^apps/mobile/(ios|android)/',
        '^patches/',
        '(^|/)CHANGELOG\\.md$',
        '\\.min\\.js$',
        '(^|/)generated/',
        '^docs/handoffs/(?!(?:README\\.md|_TEMPLATE\\.handoff\\.md)$)',
        '^docs/work/(?!README\\.md$)',
        '^scripts/validations/documentation/(check-doc-links|check-doc-identifiers|check-referenced-scripts|check-doc-commands|doc-commands|command-targets|flag-spec|doc-references|doc-reference-gate)\\.ts$',
      ],
    },
  });
  for (const [path, kind] of [
    ['docs/a.md', 'markdown'],
    ['.agent/skills/s.xml', 'markdown'],
    ['docs/p.html', 'html'],
    ['docs/p.template.html', null],
    ['apps/web/index.html', null],
    ['scripts/a.ts', 'code'],
    ['.husky/pre-commit', 'code'],
    ['scripts/a.test.ts', null],
    ['tools/test_x.py', null],
    ['node_modules/x/README.md', null],
    ['apps/mobile/ios/README.md', null],
    ['CHANGELOG.md', null],
    ['docs/work/0001-x/evidence/C-01.md', null],
    ['docs/work/0002-x/replay/a.ts', null],
    ['docs/handoffs/2026-09-24-x.md', null],
    ['docs/handoffs/sub/README.md', null],
    ['docs/handoffs/README.md', 'markdown'],
    ['docs/handoffs/_TEMPLATE.handoff.md', 'markdown'],
    ['docs/work/README.md', 'markdown'],
    ['docs/workflow.md', 'markdown'],
    ['scripts/validations/documentation/check-doc-links.ts', null],
    ['package.json', null],
  ] as const) {
    it(`${path} is ${String(kind)}`, () => {
      assert.equal(docKind(sourceExcludes, path), kind);
    });
  }

  it('reads the fixture config’s own exclusions', () => {
    assert.equal(docKind(CONFIG, 'docs/history/x.md'), null);
    assert.equal(docKind(CONFIG, 'docs/history/README.md'), 'markdown');
    assert.equal(docKind(CONFIG, 'apps/mobile/ios/README.md'), 'markdown');
    assert.equal(docKind(testConfig({ files: { html: [], code: [] } }), 'docs/p.html'), null);
    assert.equal(docKind(testConfig({ files: { code: [] } }), 'scripts/a.ts'), null);
  });
});

describe('path helpers', () => {
  for (const [glob, path, expected] of [
    ['docs/**/*.md', 'docs/a/b/c.md', true],
    ['docs/**/*.md', 'docs/c.md', true],
    ['docs/*.md', 'docs/a/c.md', false],
    ['a/?.ts', 'a/b.ts', true],
    ['a/[ab].ts', 'a/c.ts', false],
    ['a/[!ab].ts', 'a/c.ts', true],
    ['a/{x,y}.ts', 'a/y.ts', true],
    ['a/{x,y}.ts', 'a/x.ts', true],
    ['a/{x,y}.ts', 'a/,.ts', false],
    ['{a.b,c}', 'a.b', true],
    ['{a.b,c}', 'axb', false],
    ['a/{x.ts', 'a/{x.ts', true],
    ['a.b', 'axb', false],
    ['docs/**', 'docs/a/b', true],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['a/**/b', 'a/xb', false],
    ['a[bc]d', 'abd', true],
    ['a[]b]', 'a]', true],
    ['a[\\b]', 'a\\', true],
    ['x]y[b', 'x]y[b', true],
  ] as const) {
    it(`${glob} matches ${path}: ${String(expected)}`, () => {
      assert.equal(globToRegExp(glob).test(path), expected);
    });
  }

  it('normalises repo paths and refuses escapes', () => {
    assert.equal(normalizeRepoPath('./a/../b/'), 'b');
    assert.equal(normalizeRepoPath('./a'), 'a');
    assert.equal(normalizeRepoPath('.'), '');
    assert.equal(normalizeRepoPath('/'), '');
    assert.equal(normalizeRepoPath('../x'), null);
    assert.deepEqual(ancestorDirs('a/b/c.md'), ['a/b', 'a', '']);
    assert.deepEqual(ancestorDirs('c.md'), ['']);
  });

  it('reads these fence info strings as shell, and no others', () => {
    for (const info of ['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal']) assert.equal(isShellFence(info), true, info);
    for (const info of ['ts', 'text', 'json', 'Bash', 'sh ', 'shellscript']) assert.equal(isShellFence(info), false, info);
  });
});

describe('snapshot', () => {
  it('reads index, ref and worktree, and batches reads', () => {
    const repo = createTestRepo({ 'docs/a.md': 'one\n', 'docs/b.md': 'b\n' });
    const head = repo.commit();
    repo.write('docs/a.md', 'two\n');
    repo.git('add', 'docs/a.md');
    repo.write('docs/a.md', 'three\n');

    const index = createSnapshot(repo.root, { kind: 'index' });
    const ref = createSnapshot(repo.root, { kind: 'ref', ref: head });
    const tree = createSnapshot(repo.root, { kind: 'worktree' });
    assert.equal(index.read('docs/a.md'), 'two\n');
    assert.equal(ref.read('docs/a.md'), 'one\n');
    assert.equal(tree.read('docs/a.md'), 'three\n');
    assert.equal(index.read('docs/none.md'), undefined);
    assert.deepEqual(
      [...ref.readMany(['docs/a.md', 'docs/b.md', 'nope'])],
      [
        ['docs/a.md', 'one\n'],
        ['docs/b.md', 'b\n'],
      ],
    );
    assert.equal(index.dirs.has('docs'), true);
    assert.deepEqual(index.byBasename.get('a.md'), ['docs/a.md']);

    // A clean file comes from disk, a dirty or deleted one from git; the
    // result follows the request's order.
    repo.remove('docs/b.md');
    const later = createSnapshot(repo.root, { kind: 'ref', ref: head });
    assert.deepEqual(
      [...later.readMany(['docs/a.md', 'docs/b.md', '.gitignore'])],
      [
        ['docs/a.md', 'one\n'],
        ['docs/b.md', 'b\n'],
        ['.gitignore', 'node_modules/\n.tmp/\n'],
      ],
    );
    assert.equal(createSnapshot(repo.root, { kind: 'index' }).read('docs/b.md'), 'b\n');
  });

  it('lists the snapshot, not the index, for a ref; and every directory once', () => {
    const repo = createTestRepo({ 'docs/a/b.md': 'b\n', 'x.json': '{}\n' });
    const head = repo.commit();
    repo.write('docs/new.md', 'n\n');
    repo.git('add', 'docs/new.md');
    assert.deepEqual(createSnapshot(repo.root, { kind: 'ref', ref: head }).files, new Set(['.gitignore', 'docs/a/b.md', 'x.json']));
    const index = createSnapshot(repo.root, { kind: 'index' });
    assert.deepEqual([...index.dirs].sort(), ['', 'docs', 'docs/a']);
    assert.deepEqual(referenceFiles(CONFIG, index), ['docs/a/b.md', 'docs/new.md']);
  });

  it('groups tracked paths that share a basename', () => {
    const repo = createTestRepo({ 'a/x.md': '1\n', 'b/x.md': '2\n' });
    assert.deepEqual(repo.snapshot('index').byBasename.get('x.md'), ['a/x.md', 'b/x.md']);
  });

  it('reads a ref against the ref, even where the worktree matches the index', () => {
    const repo = createTestRepo({ 'docs/c.md': 'c1\n' });
    const head = repo.commit();
    repo.write('docs/c.md', 'c2\n');
    repo.git('add', 'docs/c.md');
    assert.equal(createSnapshot(repo.root, { kind: 'ref', ref: head }).read('docs/c.md'), 'c1\n');
  });

  it('reads a blob larger than a kibibyte whole through git', () => {
    // Dirty in the worktree, so the ref's copy comes from `cat-file --batch`.
    const big = `${'x'.repeat(2047)}\n`;
    const repo = createTestRepo({ 'docs/big.md': big });
    const head = repo.commit();
    repo.write('docs/big.md', 'changed\n');
    assert.equal(createSnapshot(repo.root, { kind: 'ref', ref: head }).read('docs/big.md'), big);
  });

  it('reads a worktree from disk only: dirty as it is, deleted as absent', () => {
    const repo = createTestRepo({ 'docs/a.md': 'one\n', 'docs/b.md': 'b\n' });
    repo.commit();
    repo.write('docs/a.md', 'two\n');
    repo.remove('docs/b.md');
    repo.write('docs/untracked.md', 'u\n');
    const tree = createSnapshot(repo.root, { kind: 'worktree' });
    assert.deepEqual([...tree.readMany(['docs/a.md', 'docs/b.md', 'docs/untracked.md'])], [['docs/a.md', 'two\n']]);
    assert.equal(tree.read('docs/b.md'), undefined);
  });

  it('reads a tracked symlink as its link text, never its target', () => {
    // The target lies outside the snapshot; git stores the link text.
    const outside = createTestRepo({ 'target.md': 'outside\n' });
    const target = join(outside.root, 'target.md');
    const repo = createTestRepo({ 'docs/a.md': 'a\n' });
    symlinkSync(target, join(repo.root, 'docs/link.md'));
    const head = repo.commit();
    assert.match(repo.git('ls-files', '-s', 'docs/link.md'), /^120000 /);

    const snapshots = [createSnapshot(repo.root, { kind: 'index' }), createSnapshot(repo.root, { kind: 'ref', ref: head }), createSnapshot(repo.root, { kind: 'worktree' })];
    for (const snapshot of snapshots) {
      assert.deepEqual(
        [...snapshot.readMany(['docs/link.md', 'docs/a.md'])],
        [
          ['docs/link.md', target],
          ['docs/a.md', 'a\n'],
        ],
      );
    }
  });

  it('reads large outputs and blobs through git without truncation', () => {
    const files: Record<string, string> = {};
    for (let n = 0; n < 40; n += 1) files[`docs/a-rather-long-directory-name/file-${String(n)}.md`] = 'x\n';
    const repo = createTestRepo(files);
    const head = repo.commit();
    const big = `${'y'.repeat(2000)}\n`;
    repo.write('docs/a-rather-long-directory-name/file-0.md', big);
    repo.git('add', '.');
    repo.write('docs/a-rather-long-directory-name/file-0.md', 'z\n');
    const index = createSnapshot(repo.root, { kind: 'index' });
    assert.equal(index.files.size, 41);
    assert.equal(index.read('docs/a-rather-long-directory-name/file-0.md'), big);
    assert.equal(createSnapshot(repo.root, { kind: 'ref', ref: head }).files.size, 41);
  });

  it('skips a gitlink, and refuses a batch header it cannot read', () => {
    const repo = createTestRepo({ 'docs/a.md': 'a\n' });
    repo.commit();
    repo.git('update-index', '--add', '--cacheinfo', `160000,${'2'.repeat(40)},sub`);
    const index = createSnapshot(repo.root, { kind: 'index' });
    assert.equal(index.files.has('sub'), true);
    assert.deepEqual([...index.readMany(['sub', 'docs/a.md'])], [['docs/a.md', 'a\n']]);
    repo.git('update-index', '--add', '--cacheinfo', `100644,${'1'.repeat(40)},docs/ghost.md`);
    assert.throws(() => createSnapshot(repo.root, { kind: 'index' }).read('docs/ghost.md'), { message: `git cat-file --batch: unexpected header "${'1'.repeat(40)} missing"` });
  });

  it('reads blobs in order through one batch', () => {
    const repo = createTestRepo({ 'a.md': 'first\n', 'b.md': '' });
    repo.commit();
    const oid = (path: string): string => repo.git('rev-parse', `HEAD:${path}`).trim();
    assert.deepEqual(catFileBatch(repo.root, [oid('b.md'), oid('a.md'), oid('b.md')]), ['', 'first\n', '']);
  });

  it('carries a failing git command’s stderr on the error', () => {
    const repo = createTestRepo();
    // Captured, never echoed to this process's own stderr.
    const echo = mock.method(process.stderr, 'write');
    let stderr: unknown;
    try {
      git(repo.root, ['no-such-command']);
    } catch (error) {
      stderr = (error as { stderr?: unknown }).stderr;
    }
    const echoed = echo.mock.callCount();
    echo.mock.restore();
    assert.equal(echoed, 0);
    assert.ok(String(stderr).includes("'no-such-command' is not a git command"), String(stderr));
  });

  it('reads git output, or undefined when git fails', () => {
    const repo = createTestRepo();
    assert.equal(gitOrUndefined(repo.root, ['rev-parse', '--is-inside-work-tree'])?.trim(), 'true');
    assert.equal(gitOrUndefined(repo.root, ['no-such-command']), undefined);
  });

  it('applies tracked .gitignore rules only', () => {
    const repo = createTestRepo({
      '.gitignore': ['.tmp/', '*.log  ', '!keep.log', '/build', 'out/', '', '# comment', '\\#hash'].join('\n'),
      'apps/web/.gitignore': 'dist\n/root-only\n',
      // `-` sorts before `.`: the nested file is listed first, applied last.
      'a/.gitignore': '*.tmp\n',
      'a/-b/.gitignore': '!keep.tmp\n',
      'docs/a.md': 'x\n',
    });
    const snapshot = repo.snapshot('index');
    const ignored = snapshot.ignored([
      '.tmp/x.json',
      'a/b.log',
      'keep.log',
      'build',
      'docs/build',
      'out',
      'out/',
      'apps/web/dist/x.js',
      'apps/dist/x.js',
      'apps/web/root-only',
      'apps/web/sub/root-only',
      'a/-b/keep.tmp',
      'a/-b/other.tmp',
      '#hash',
      'hash',
      'docs/a.md',
      'docs/x',
    ]);
    assert.deepEqual([...ignored].sort(), ['#hash', '.tmp/x.json', 'a/-b/other.tmp', 'a/b.log', 'apps/web/dist/x.js', 'apps/web/root-only', 'build', 'out/']);
    // The rules are read once and reused.
    assert.deepEqual([...snapshot.ignored(['a/b.log', 'docs/a.md'])], ['a/b.log']);
  });

  it('ignores nothing in a snapshot with no tracked .gitignore', () => {
    const repo = createTestRepo({ 'docs/a.md': 'x\n' });
    repo.remove('.gitignore');
    assert.deepEqual([...repo.snapshot('index').ignored(['node_modules/x', 'docs/a.md'])], []);
  });
});

describe('takenFromMerge and mergeHeads', () => {
  /** Staged paths a staged gate judges: `paths` without those the merge took unchanged. */
  const stagedToJudge = (root: string, paths: readonly string[]): string[] => {
    const taken = takenFromMerge(root);
    return paths.filter((path) => !taken.has(path));
  };
  const mergeInProgress = (root: string): boolean => mergeHeads(root).length > 0;

  /** A repository holding `files`, committed on main. */
  const based = (files: Record<string, string>): TestRepo => {
    const repo = createTestRepo(files);
    repo.commit('base');
    return repo;
  };

  /**
   * main changes a.md, c.md and d.md, adds n.md and deletes gone.md; the
   * branch changes c.md and o.md; neither touches k.md. Merging main into the
   * branch stops on c.md's conflict.
   */
  const midMerge = (): TestRepo => {
    const r = based({ 'a.md': 'a\n', 'c.md': 'c\n', 'd.md': 'd\n', 'gone.md': 'g\n', 'k.md': 'k\n', 'o.md': 'o\n' });
    r.git('checkout', '-q', '-b', 'branch');
    r.write('c.md', 'ours\n');
    r.write('o.md', 'ours\n');
    r.git('commit', '-qam', 'branch');
    r.git('checkout', '-q', 'main');
    r.write('a.md', 'main\n');
    r.write('c.md', 'theirs\n');
    r.write('n.md', 'new\n');
    r.write('d.md', 'main d\n');
    r.git('rm', '-q', 'gone.md');
    r.git('add', '-A');
    r.git('commit', '-qm', 'main');
    r.git('checkout', '-q', 'branch');
    assert.throws(() => r.git('merge', '--no-edit', 'main'));
    return r;
  };

  it('is empty, and every path is judged, outside a merge', () => {
    const r = based({ 'a.md': 'a\n', 'b.md': 'b\n' });
    r.write('a.md', 'edited\n');
    r.write('b.md', 'edited\n');
    r.git('add', '-A');
    assert.equal(mergeInProgress(r.root), false);
    assert.deepEqual(mergeHeads(r.root), []);
    assert.deepEqual(takenFromMerge(r.root), new Set());
    assert.deepEqual(stagedToJudge(r.root, ['a.md', 'b.md']), ['a.md', 'b.md']);
  });

  it('skips what the merge took from MERGE_HEAD unchanged, and judges the rest', () => {
    const r = midMerge();
    assert.equal(mergeInProgress(r.root), true);
    assert.deepEqual(mergeHeads(r.root), [r.git('rev-parse', 'main').trim()]);
    // Resolved by hand: neither side's blob.
    r.write('c.md', 'resolved\n');
    // Taken from main, then edited after the merge.
    r.write('d.md', 'edited after\n');
    r.git('add', '-A');
    // Deleted after the merge: main still has it.
    r.git('rm', '-q', 'k.md');
    assert.deepEqual(takenFromMerge(r.root), new Set(['a.md', 'gone.md', 'n.md']));
    assert.deepEqual(stagedToJudge(r.root, ['o.md', 'a.md', 'c.md', 'd.md', 'n.md', 'gone.md', 'k.md']), ['o.md', 'c.md', 'd.md', 'k.md']);
  });

  it('skips a conflict resolved to main’s exact blob: the same rule, blob for blob', () => {
    const r = midMerge();
    r.write('c.md', 'theirs\n');
    r.write('d.md', 'main d\n');
    r.git('add', '-A');
    // c.md now equals MERGE_HEAD's blob: taken unchanged, so skipped too.
    assert.deepEqual(takenFromMerge(r.root), new Set(['a.md', 'c.md', 'd.md', 'gone.md', 'n.md']));
  });

  it('compares an octopus merge against every merged head, not only the first', () => {
    const r = based({ 'a.md': 'a\n', 'b.md': 'b\n', 'gone.md': 'g\n' });
    r.git('checkout', '-q', '-b', 'x');
    r.write('a.md', 'x\n');
    r.git('commit', '-qam', 'x');
    r.git('checkout', '-q', '-b', 'y', 'main');
    r.write('b.md', 'y\n');
    r.git('rm', '-q', 'gone.md');
    r.git('commit', '-qam', 'y');
    r.git('checkout', '-q', 'main');
    r.git('merge', '-q', '--no-commit', 'x', 'y');
    assert.deepEqual(mergeHeads(r.root), [r.git('rev-parse', 'x').trim(), r.git('rev-parse', 'y').trim()]);
    // a.md is x's blob, b.md and the deletion of gone.md are y's.
    assert.deepEqual(takenFromMerge(r.root), new Set(['a.md', 'b.md', 'gone.md']));
    // Edited after the merge: neither head's blob, so judged.
    r.write('b.md', 'edited after\n');
    r.git('add', 'b.md');
    assert.deepEqual(stagedToJudge(r.root, ['a.md', 'b.md', 'gone.md']), ['b.md']);
  });

  it('is empty once the merge is committed', () => {
    const r = midMerge();
    r.write('c.md', 'resolved\n');
    r.git('add', '-A');
    r.git('commit', '-qm', 'merge');
    r.write('a.md', 'next\n');
    r.git('add', '-A');
    assert.equal(mergeInProgress(r.root), false);
    assert.deepEqual(stagedToJudge(r.root, ['a.md']), ['a.md']);
  });
});

// The fixture's config is the one these suites run under: every check on.
it('runs under the fixture config, every check on', () => {
  assert.deepEqual(CONFIG.skipped, []);
  assert.equal(CONFIG_JSON.exemptMarker, CONFIG.exemptWord);
});
