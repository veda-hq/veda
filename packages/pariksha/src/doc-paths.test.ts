import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findPathProblems, pathRef } from './doc-paths.ts';
import { CONFIG, createTestRepo, testConfig, type TestRepo } from './doc-references.fixture.test.ts';
import type { Config } from './doc-references-config.ts';
import { createSnapshot } from './doc-references.ts';

const SKILL = '.agents/skills/resolve-health/SKILL.md';
const COLLECTOR = '.claude/scripts/collect-health-signals.ts';

const pathRepo = (doc: string, extra: Record<string, string> = {}): TestRepo =>
  createTestRepo({
    [COLLECTOR]: 'export function collect() {\n  return 1;\n}\n',
    'docs/guide.md': '# Guide\n\n## Set up\n\n<a id="custom"></a>\n',
    'apps/server/src/app.ts': 'line one\nexport function bootstrap() {}\n',
    'apps/server/package.json': '{ "name": "@acme/server" }\n',
    ...extra,
    [SKILL]: doc,
  });

const pathProblems = (r: TestRepo, files: string[] = [SKILL], config: Config = CONFIG) => findPathProblems(config, r.snapshot(), files);
const refs = (r: TestRepo, files: string[] = [SKILL]): string[] => pathProblems(r, files).map((p) => p.ref);

/** Whether a path names a layout rather than a file, from `doc`: the engine's reading of `paths.layouts`. */
const isLayout = (config: Config, doc: string, path: string): boolean => config.paths.layouts.some((l) => l.pattern.test(path) && !(l.except?.test(doc) ?? false));

describe('DOC-DRIFT-01: a skill telling agents to run a script from the wrong folder', () => {
  // A skill told agents to run the collector from `.Codex/` when it lived in
  // `.claude/scripts/`, so every later step failed.
  const EXAMPLE = ['```bash', 'npx tsx .Codex/scripts/collect-health-signals.ts .tmp/health-check/out.json', '```', ''].join('\n');

  it('fails the example for the intended reason', () => {
    const found = pathProblems(pathRepo(EXAMPLE));
    assert.equal(found.length, 1);
    const [first] = found;
    assert.equal(first?.check, 'DOC-DRIFT-01');
    assert.equal(first?.line, 2);
    assert.equal(first?.ref, '.Codex/scripts/collect-health-signals.ts');
    assert.match(String(first?.reason), /is not tracked/);
  });

  it('passes the corrected path', () => {
    assert.deepEqual(pathProblems(pathRepo(EXAMPLE.replace('.Codex/', '.claude/'))), []);
  });

  it('near-miss: an ignored output path (.tmp/…) is not a broken reference', () => {
    // Same command, same untracked `.tmp/` argument the example carries; only
    // the ignore rules decide it, and they cover `.tmp/`.
    const fixed = EXAMPLE.replace('.Codex/', '.claude/');
    assert.ok(fixed.includes('.tmp/health-check/out.json'));
    assert.deepEqual(pathProblems(pathRepo(fixed)), []);
  });

  it('removing the guard flips it: an unchecked file reports nothing', () => {
    const r = pathRepo(EXAMPLE);
    assert.deepEqual(findPathProblems(CONFIG, r.snapshot(), []), []);
    assert.equal(findPathProblems(CONFIG, r.snapshot(), [SKILL]).length, 1);
  });

  it('honours an explicit doc-ref-ok marker with a reason', () => {
    assert.deepEqual(pathProblems(pathRepo(EXAMPLE.replace('out.json', 'out.json # doc-ref-ok: quoted finding'))), []);
    // A bare marker with no reason is not an opt-out.
    assert.equal(pathProblems(pathRepo(EXAMPLE.replace('out.json', 'out.json # doc-ref-ok:'))).length, 1);
  });

  it('reads the marker word the config names', () => {
    const config = testConfig({ exemptMarker: 'path-ok' });
    assert.deepEqual(pathProblems(pathRepo(EXAMPLE.replace('out.json', 'out.json # path-ok: quoted finding')), [SKILL], config), []);
    assert.equal(pathProblems(pathRepo(EXAMPLE.replace('out.json', 'out.json # doc-ref-ok: quoted finding')), [SKILL], config).length, 1);
  });
});

describe('DOC-DRIFT-01 backticked paths: where they are read', () => {
  it('checks a link label through its link, not as a path', () => {
    assert.deepEqual(refs(pathRepo('[`apps/gone/label.ts`](https://example.com) and `apps/gone/bare.ts`\n')), ['apps/gone/bare.ts']);
  });

  it('skips a code comment carrying a marker with a reason', () => {
    const r = pathRepo('', { 'apps/server/src/marked.ts': ['// `apps/gone/marked.ts` doc-ref-ok: quoted on purpose', '// `apps/gone/plain.ts`', ''].join('\n') });
    assert.deepEqual(refs(r, ['apps/server/src/marked.ts']), ['apps/gone/plain.ts']);
  });

  it('leaves a published HTML page to the link check', () => {
    const r = pathRepo('', { 'docs/page.html': '<script>\n  // `apps/gone/page.ts`\n</script>\n', 'apps/server/src/code.ts': '  // `apps/gone/code.ts`\n' });
    assert.deepEqual(refs(r, ['docs/page.html', 'apps/server/src/code.ts']), ['apps/gone/code.ts']);
  });

  it('reads `#` comments in the files the config names, never a shebang, and skips files no rule takes', () => {
    const r = pathRepo('', {
      '.husky/pre-commit': ['#!/bin/sh `apps/gone/shebang.ts`', '# see `apps/gone/hook.ts`', 'echo `apps/gone/command.ts`', ''].join('\n'),
      'notes.txt': '`apps/gone/notes.ts`\n',
      'apps/server/src/a.test.ts': '// `apps/gone/test.ts`\n',
    });
    assert.deepEqual(
      pathProblems(r, ['.husky/pre-commit', 'notes.txt', 'apps/server/src/a.test.ts']).map((p) => [p.file, p.line, p.ref]),
      [['.husky/pre-commit', 2, 'apps/gone/hook.ts']],
    );
  });

  it('reads JSDoc bodies and block-comment openers', () => {
    const r = pathRepo('', { 'apps/server/src/doc.ts': ['/* `apps/gone/open.ts`', ' * `apps/gone/body.ts`', ' */', ''].join('\n') });
    assert.deepEqual(refs(r, ['apps/server/src/doc.ts']), ['apps/gone/open.ts', 'apps/gone/body.ts']);
  });
});

describe('DOC-DRIFT-01 backticked path forms', () => {
  it('reads a bare code-span name as a path only when a line pins it', () => {
    assert.deepEqual(refs(pathRepo('See `nowhere.md` and `nowhere.md:3`.\n')), ['nowhere.md:3']);
  });

  it('checks file:line bounds and the symbol cited beside it', () => {
    const r = pathRepo(['`bootstrap` in `apps/server/src/app.ts:2` starts it.', '`shutdown` in `apps/server/src/app.ts:2` stops it.', 'Line `apps/server/src/app.ts:40` is past the end.', 'Basename `app.ts:1` resolves when unique.', ''].join('\n'));
    const found = pathProblems(r);
    assert.deepEqual(
      found.map((p) => p.line),
      [2, 3],
    );
    assert.match(String(found[0]?.reason), /citation drifted/);
    assert.match(String(found[1]?.reason), /has 2 lines/);
  });

  it('bounds a cited range and finds its symbol within three lines of it', () => {
    const long = Array.from({ length: 12 }, (_, i) => `l${String(i + 1)}`);
    long[0] = 'beta';
    long[1] = 'alpha';
    long[5] = 'const $store = 1;';
    long[9] = 'omega';
    long[10] = 'zeta';
    const at = (line: string): string => `apps/server/src/long.ts:${line}`;
    const r = pathRepo(
      [
        `\`alpha\` in \`${at('5')}\``,
        `\`beta\` in \`${at('5')}\``,
        `\`omega\` in \`${at('7')}\``,
        `\`zeta\` in \`${at('7')}\``,
        `\`$store\` in \`${at('6')}\``,
        `\`${at('0')}\` \`${at('3-2')}\` \`${at('12-13')}\``,
        `\`a.b.alpha()\` in \`${at('2-4')}\``,
        `\`zeta\` in \`${at('6-7')}\``,
        '`apps/server/src/bare.ts:3` (`two`)',
        '`apps/server/src/bare.ts:2` (`one`)',
        `\`${at('5')}\` (\`zeta\`) \`${at('0-12')}\``,
        '',
      ].join('\n'),
      { 'apps/server/src/long.ts': `${long.join('\n')}\n`, 'apps/server/src/bare.ts': 'one\ntwo' },
    );
    assert.deepEqual(
      pathProblems(r).map((p) => [p.line, p.reason]),
      [
        [2, '`beta` is not at `apps/server/src/long.ts:5` — the citation drifted'],
        [4, '`zeta` is not at `apps/server/src/long.ts:7` — the citation drifted'],
        [6, '`apps/server/src/long.ts` has 12 lines; line 0 does not exist'],
        [6, '`apps/server/src/long.ts` has 12 lines; line 3 does not exist'],
        [6, '`apps/server/src/long.ts` has 12 lines; line 13 does not exist'],
        [8, '`zeta` is not at `apps/server/src/long.ts:6-7` — the citation drifted'],
        [9, '`apps/server/src/bare.ts` has 2 lines; line 3 does not exist'],
        [11, '`zeta` is not at `apps/server/src/long.ts:5` — the citation drifted'],
        [11, '`apps/server/src/long.ts` has 12 lines; line 0 does not exist'],
      ],
    );
  });

  it('reads a symbol before the citation after any of its separators, and ignores a span that is no identifier', () => {
    const r = pathRepo(['`shutdown` at `apps/server/src/app.ts:2`', '`shutdown` — `apps/server/src/app.ts:2`', '`shutdown`: [`apps/server/src/app.ts:2`]', '`two words` in `apps/server/src/app.ts:2`', '`shutdown` because `apps/server/src/app.ts:2`', ''].join('\n'));
    assert.deepEqual(
      pathProblems(r).map((p) => p.line),
      [1, 2, 3],
    );
  });

  it('a line cited in a tracked directory named like a file has no lines to count', () => {
    assert.deepEqual(pathProblems(pathRepo('`docs/v1.md:3`\n', { 'docs/v1.md/inner.md': '# inner\n' })), []);
  });

  it('checks globs, directories and a file named as a directory', () => {
    const r = pathRepo(['`apps/server/src/**/*.ts` and `apps/server/src/` exist.', '`apps/server/**/*.py` matches nothing.', '`apps/server/src/app.ts/` is a file.', '`codex/` and `refs/heads/*` are git refs, not paths.', ''].join('\n'));
    const found = pathProblems(r);
    assert.deepEqual(
      found.map((p) => p.line),
      [2, 3],
    );
    assert.match(String(found[1]?.reason), /is a file, not a directory/);
  });

  it('judges a glob named twice the same both times', () => {
    assert.deepEqual(
      pathProblems(pathRepo('`apps/server/**/*.py` `apps/server/**/*.py` `apps/server/**/*.ts` `apps/server/**/*.ts`\n')).map((p) => p.ref),
      ['apps/server/**/*.py', 'apps/server/**/*.py'],
    );
  });

  it('anchors a ./ or ../ directory at the repository root with no workspaces', () => {
    // No workspace and no ancestor below the root: only the explicit `.`
    // and `..` segments anchor these, so each is checked, not skipped.
    const r = createTestRepo({ 'NOTES.md': '`./absent/` and `../absent/` and `./absent/*.ts`\n' });
    assert.deepEqual(
      findPathProblems(CONFIG, r.snapshot(), ['NOTES.md']).map((p) => p.ref),
      ['./absent/', '../absent/', './absent/*.ts'],
    );
  });

  it('reads a slice record named without its work folder as a pattern', () => {
    const r = pathRepo('ok\n', { 'scripts/records.ts': ['// A cell names A-01, whose records are `handoffs/A-01.md` and', '// `evidence/A-01*`; RFCs are `docs/rfcs/0NNN-*.md`.', ''].join('\n') });
    assert.deepEqual(pathProblems(r, ['scripts/records.ts']), []);
  });

  it('judges a slice record from a doc the layout excepts', () => {
    const r = pathRepo('ok\n', { 'docs/work/0001-x/notes.md': '`handoffs/A-01.md`\n' });
    assert.deepEqual(
      pathProblems(r, ['docs/work/0001-x/notes.md']).map((p) => p.ref),
      ['handoffs/A-01.md'],
    );
  });

  it('a layout with no `except` holds from every doc', () => {
    const config = testConfig({ paths: { layouts: [{ pattern: '^handoffs/' }] } });
    const r = pathRepo('ok\n', { 'docs/work/0001-x/notes.md': '`handoffs/A-01.md`\n' });
    assert.deepEqual(pathProblems(r, ['docs/work/0001-x/notes.md'], config), []);
  });

  for (const [path, expected] of [
    ['handoffs/A-01.md', true],
    ['evidence/A-01*', true],
    ['handoffs/ABC-123.md', true],
    ['handoffs/a-01.md', false],
    ['handoffs/ABCD-01.md', false],
    ['handoffs/A-1.md', false],
    ['handoffs/A-0123.md', false],
    ['handoffs/A-01b.md', false],
    ['handoffs/A-01-x.md', false],
    ['x/handoffs/A-01.md', false],
    ['notes/A-01.md', false],
  ] as const) {
    it(`the slice-record layout takes ${path} outside docs/work: ${String(expected)}`, () => {
      assert.equal(isLayout(CONFIG, 'scripts/x.ts', path), expected);
      assert.equal(isLayout(CONFIG, 'docs/work/0001-x/notes.md', path), false);
    });
  }

  it('reads code comments in source files, not string literals', () => {
    const found = pathProblems(pathRepo('ok\n', { 'scripts/tool.ts': ['// See `docs/absent.md` for details.', "const s = 'docs/absent.md';", ''].join('\n') }), ['scripts/tool.ts']);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.line, 1);
  });

  it('skips a file inside any dependency a tracked manifest lists', () => {
    const r = pathRepo(['`pg-pool/index.js` `left-pad/lib.js` `mocha-x/run.js` `peer-y/peer.js`', '`opt-z/opt.js` `nulled/null.js` `absent-dep/dep.js`', ''].join('\n'), {
      'package.json': JSON.stringify({ dependencies: { 'pg-pool': '1' } }),
      'packages/kit/package.json': JSON.stringify({
        devDependencies: { 'left-pad': '1', 'mocha-x': '1' },
        peerDependencies: { 'peer-y': '1' },
        optionalDependencies: { 'opt-z': '1' },
        dependencies: null,
      }),
      'tools/kit/package.json': JSON.stringify({ dependencies: { 'absent-dep': '1' } }),
      'apps/web/package.json': '{ not json',
    });
    assert.deepEqual(refs(r), ['nulled/null.js', 'absent-dep/dep.js']);
  });

  it('reads a dependency list written as an array as naming no dependency', () => {
    const r = pathRepo('`listed/list.js` `kept/keep.js`\n', { 'packages/list/package.json': JSON.stringify({ dependencies: ['listed'], devDependencies: { kept: '1' } }) });
    assert.deepEqual(refs(r), ['listed/list.js']);
  });

  it('resolves a path from a workspace root and its src, nowhere else', () => {
    const r = pathRepo('`src/app.ts` `lib/util.ts` `src/tool.ts` `lib/rooted.ts`\n', {
      'apps/server/src/lib/util.ts': '',
      'tools/kit/package.json': '{}',
      'tools/kit/src/tool.ts': '',
      'package.json': '{}',
      'src/lib/rooted.ts': '',
    });
    assert.deepEqual(refs(r), ['src/tool.ts', 'lib/rooted.ts']);
  });

  it('reads a shell fence up to its comment, and no other fence', () => {
    const r = pathRepo(['```sh', '$ cat docs/absent-1.md # then docs/absent-2.md', '# docs/absent-3.md', 'cat docs/a#b/absent-4.md', '```', '```ts', "import x from 'docs/absent-5.md';", '```', ''].join('\n'));
    assert.deepEqual(
      pathProblems(r).map((p) => [p.line, p.ref]),
      [[2, 'docs/absent-1.md']],
    );
  });

  it('reads frontmatter values, listed or keyed', () => {
    const r = pathRepo(['---', 'paths: docs/absent-1.md, docs/guide.md', '  - docs/absent-2.md', 'note docs/absent-3.md', '---', ''].join('\n'));
    assert.deepEqual(
      pathProblems(r).map((p) => [p.line, p.ref]),
      [
        [2, 'docs/absent-1.md'],
        [3, 'docs/absent-2.md'],
      ],
    );
  });

  it('reports a missing path, a glob that matches nothing, and a dangling directory', () => {
    const r = pathRepo(
      ['`docs/absent.md` `docs/*.py` `docs/absent/` `nowhere/sub/` `nowhere/*.ts`', '`./absent/` `only.ts:5` `dup.ts:9` `none.ts:1`', '`../absent/` `docs/build/` `apps/serv*` `docs/missing/README.md` `docs/`', ''].join('\n'),
      { '.gitignore': 'build/\n', 'docs/deep/only.ts': 'x\n', 'docs/one/dup.ts': '', 'docs/two/dup.ts': '' },
    );
    assert.deepEqual(
      pathProblems(r).map((p) => [p.line, p.reason]),
      [
        [1, '`docs/absent.md` is not tracked (looked beside the doc, above it and at the root)'],
        [1, '`docs/*.py` matches no tracked file'],
        [1, '`docs/absent/` is not tracked (looked beside the doc, above it and at the root)'],
        [2, '`./absent/` is not tracked (looked beside the doc, above it and at the root)'],
        [2, '`docs/deep/only.ts` has 1 lines; line 5 does not exist'],
        [2, '`none.ts` is not tracked (looked beside the doc, above it and at the root)'],
        [3, '`../absent/` is not tracked (looked beside the doc, above it and at the root)'],
        [3, '`docs/missing/README.md` is not tracked (looked beside the doc, above it and at the root)'],
      ],
    );
  });

  it('reads only the files the snapshot has', () => {
    assert.deepEqual(pathProblems(pathRepo('`docs/absent.md`\n'), ['docs/nowhere.md']), []);
  });

  it('resolves against the snapshot, not the disk: an unstaged file is absent', () => {
    const r = pathRepo('`docs/later.md` is new.\n');
    r.commit();
    r.write('docs/later.md', '# later\n');
    // Built directly: the fixture's snapshot() stages everything first.
    assert.equal(findPathProblems(CONFIG, createSnapshot(r.root, { kind: 'index' }), [SKILL]).length, 1);
    r.git('add', 'docs/later.md');
    assert.deepEqual(findPathProblems(CONFIG, createSnapshot(r.root, { kind: 'index' }), [SKILL]), []);
  });
});

describe('pathRef', () => {
  for (const token of ['scripts/<name>.ts', 'docs/work/NNNN-slug/', 'src/foo.ts', 'path/to/file.md', 'https://example.com/a.md', 'abc1234:docs/x.md', 'origin/main:docs/x.md', '.claude/worktrees/x/a.md', 'github.com/org/repo.md', 'plain-word', '0.1/2.5']) {
    it(`is not a path: ${token}`, () => {
      assert.equal(pathRef(CONFIG, token, false), null);
    });
  }

  it('parses line suffixes, globs and directories', () => {
    assert.deepEqual(pathRef(CONFIG, 'src/main.ts:3-5'), { path: 'src/main.ts', glob: false, dir: false, lines: [3, 5] });
    assert.deepEqual(pathRef(CONFIG, 'src/main.md#L7')?.lines, [7, 7]);
    assert.equal(pathRef(CONFIG, 'docs/**/*.md')?.glob, true);
    assert.equal(pathRef(CONFIG, 'docs/work/')?.dir, true);
    assert.equal(pathRef(CONFIG, '--root=docs/guide.md')?.path, 'docs/guide.md');
    assert.equal(pathRef(CONFIG, ':docs/guide.md')?.path, 'docs/guide.md');
    assert.equal(pathRef(CONFIG, 'main.ts'), null);
    assert.deepEqual(pathRef(CONFIG, 'main.ts:4')?.lines, [4, 4]);
  });

  it('reads a line range written as #L7-L9, and drops a column', () => {
    assert.deepEqual(pathRef(CONFIG, 'src/main.md#L7-L9')?.lines, [7, 9]);
    assert.deepEqual(pathRef(CONFIG, 'src/main.ts:3:7')?.lines, [3, 3]);
  });

  it('keeps the path but no line when the line is past a safe integer', () => {
    const huge = '99999999999999999999';
    assert.deepEqual(pathRef(CONFIG, `src/main.ts:${huge}`), { path: 'src/main.ts', glob: false, dir: false, lines: undefined });
    assert.equal(pathRef(CONFIG, `src/main.ts:3-${huge}`)?.lines, undefined);
    assert.equal(pathRef(CONFIG, `src/main.ts:${huge}-3`)?.lines, undefined);
  });

  it('takes a file with each known extension as a path', () => {
    const known = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'json5', 'md', 'mdx', 'sh', 'bash', 'zsh', 'py', 'yml', 'yaml', 'toml', 'prisma', 'sql', 'html', 'css', 'scss', 'xml', 'txt', 'csv', 'tsv', 'plist', 'gradle', 'kt', 'kts', 'java', 'swift', 'png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'example', 'sample', 'ini', 'cfg', 'conf', 'lock', 'mermaid', 'patch', 'rb', 'podspec', 'snap'];
    assert.deepEqual(CONFIG.paths.extensions, new Set(known));
    const onlyMarkdown = testConfig({ paths: { extensions: ['md'] } });
    for (const extension of known) {
      assert.equal(pathRef(CONFIG, `docs/notes.${extension}`)?.path, `docs/notes.${extension}`);
      assert.equal(pathRef(onlyMarkdown, `docs/notes.${extension}`, true)?.path, extension === 'md' ? 'docs/notes.md' : undefined);
    }
  });

  it('reads an extension case-insensitively', () => {
    assert.equal(pathRef(CONFIG, 'docs/notes.MD')?.path, 'docs/notes.MD');
  });

  for (const token of ['(docs/guide.md)', '("docs/guide.md",', "'docs/guide.md';", '[docs/guide.md]!', 'docs/guide.md.', 'docs/guide.md:', 'docs/guide.md?']) {
    it(`trims the punctuation around ${token}`, () => {
      assert.equal(pathRef(CONFIG, token)?.path, 'docs/guide.md');
    });
  }

  for (const token of ['@acme/shared/guide.ts', '-x/guide.md', 'docs/notes.xyz', 'docs/README', 'docs/example/', '.claude/worktrees/agent-1/docs/guide.md', '.claude/worktrees', 'a//b.md', '/abs/b.md', '']) {
    it(`is not a repo path either: ${JSON.stringify(token)}`, () => {
      assert.equal(pathRef(CONFIG, token, false), null);
    });
  }

  it('needs a directory before a glob, and reads a TLD-like basename as a file', () => {
    assert.equal(pathRef(CONFIG, '*.xyz', false), null);
    assert.deepEqual(pathRef(CONFIG, 'docs/*'), { path: 'docs/*', glob: true, dir: false, lines: undefined });
    assert.equal(pathRef(CONFIG, 'install.sh:3')?.path, 'install.sh');
    assert.equal(pathRef(CONFIG, '.claude/worktreesX/guide.md')?.path, '.claude/worktreesX/guide.md');
  });

  it('reads examples and untracked folders from the config', () => {
    const config = testConfig({ paths: { examples: '^demo/', untracked: ['out/'] } });
    assert.equal(pathRef(config, 'demo/a.md'), null);
    assert.equal(pathRef(config, 'out/a.md'), null);
    assert.equal(pathRef(config, 'src/foo.ts')?.path, 'src/foo.ts');
    assert.equal(pathRef(config, '.claude/worktrees/x/a.md')?.path, '.claude/worktrees/x/a.md');
  });
});

describe('exemptions the link check shares', () => {
  it('reads a pattern as a placeholder, a real name as none', () => {
    for (const pattern of ['<id>.md', 'docs/rfcs/0NNN-x.md', '${DIR}/a.md', 'a/.../b.md']) assert.equal(CONFIG.placeholder.test(pattern), true);
    assert.equal(CONFIG.placeholder.test('docs/guide.md'), false);
  });
});
