import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULT_INCLUDE, isFileAt, linesOf, parseDocConfig, readDoc, selectDocs } from './doc-files.ts';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A folder with these files written, removed when this file's tests end. */
const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'pariksha-docs-'));
  temps.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

describe('parseDocConfig', () => {
  it('takes the defaults with no config, or for absent keys', () => {
    for (const config of [parseDocConfig(undefined, ['fix it']), parseDocConfig('{}', ['fix it'])]) {
      assert.equal(config.include.source, DEFAULT_INCLUDE);
      assert.deepEqual(config.guidance, ['fix it']);
    }
  });

  it('reads both keys', () => {
    const config = parseDocConfig(JSON.stringify({ include: '\\.rst$', guidance: ['a', ''] }), []);
    assert.ok(config.include.test('x.rst'));
    assert.deepEqual(config.guidance, ['a', '']);
  });

  it('refuses anything else', () => {
    const cases: Array<[string, RegExp]> = [
      ['nope', /not JSON/],
      ['"x"', /must be a JSON object/],
      ['{"exclude": []}', /unknown key "exclude"/],
      ['{"include": ""}', /"include" must be a non-empty regex string/],
      ['{"include": 1}', /"include" must be a non-empty regex string/],
      ['{"include": null}', /"include" must be a non-empty regex string/],
      ['{"guidance": null}', /"guidance" must be a list of lines/],
      ['{"include": "("}', /"include" is not a regex/],
      ['{"guidance": "x"}', /"guidance" must be a list of lines/],
      ['{"guidance": [1]}', /"guidance" must be a list of lines/],
    ];
    for (const [text, message] of cases) assert.throws(() => parseDocConfig(text, []), message, text);
  });
});

describe('selectDocs', () => {
  const md = new RegExp(DEFAULT_INCLUDE);

  it('keeps listed regular files that match, in order, as listed', () => {
    const root = tree({ 'b.md': '', 'a.mdx': '', 'c.txt': '', 'order history/v.md': '', '-dash.md': '', 'dir.md/x': '' });
    symlinkSync('b.md', join(root, 'link.md'));
    const listed = 'b.md\nc.txt\nmissing.md\norder history/v.md\n-dash.md\ndir.md\nlink.md\na.mdx\n';
    assert.deepEqual(selectDocs(root, listed, md), ['b.md', 'order history/v.md', '-dash.md', 'link.md', 'a.mdx']);
    assert.deepEqual(selectDocs(root, `${join(root, 'b.md')}\0`, md), [join(root, 'b.md')]);
  });

  it('reads every tracked file with no list', () => {
    const root = tree({ 'a.md': '', 'docs/b.md': '', 'c.ts': '', 'untracked.md': '' });
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', 'a.md', 'docs/b.md', 'c.ts'], { cwd: root });
    assert.deepEqual(selectDocs(root, undefined, md), ['a.md', 'docs/b.md']);
  });

  it('throws outside a repository with no list', () => {
    assert.throws(() => selectDocs(tree({}), undefined, md), /git ls-files -z failed/);
  });
});

describe('isFileAt, readDoc and linesOf', () => {
  it('reads a file under the base', () => {
    const root = tree({ 'a.md': 'x\ny' });
    assert.equal(isFileAt(root, 'a.md'), true);
    assert.equal(isFileAt(root, 'b.md'), false);
    assert.equal(readDoc(root, 'a.md'), 'x\ny');
  });

  it('splits lines as a shell read loop does', () => {
    assert.deepEqual(linesOf(''), []);
    assert.deepEqual(linesOf('\n'), ['']);
    assert.deepEqual(linesOf('a\nb'), ['a', 'b']);
    assert.deepEqual(linesOf('a\n\nb\n'), ['a', '', 'b']);
  });
});
