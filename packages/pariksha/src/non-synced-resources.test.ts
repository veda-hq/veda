import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { parseDocConfig } from './doc-files.ts';
import { basenameOf, checkDoc, checkNonSyncedResources, DEFAULT_GUIDANCE, dirnameOf, linkPath, linkTargets, nameOnDisk } from './non-synced-resources.ts';

/** A folder with these files written, its real path returned (as git's top folder is). */
const tree = (files: Record<string, string>): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-nsr-')));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

const config = parseDocConfig(undefined, DEFAULT_GUIDANCE);

describe('linkTargets', () => {
  it('reads each link and image on each line, code blocks included', () => {
    assert.deepEqual(linkTargets('[a](x.md) ![i](y.png)\n```\n[b](z.md)\n```\n[c](<w v.md> "t")'), ['x.md', 'y.png', 'z.md', '<w v.md> "t"']);
  });

  it('drops web, mail and anchor links, and reads no link across lines', () => {
    assert.deepEqual(linkTargets('[w](https://a.b) [h](http://a) [m](mailto:a@b) [#](#top) [t](ftp://x)\n[a\n](b.md) [c](\nd.md)'), ['ftp://x']);
  });

  it('reads a bracket inside the text, adjacent links, and needs a destination', () => {
    assert.deepEqual(linkTargets('[a [b](c.md)[d](e.md) [](f.md) [g]()'), ['c.md', 'e.md', 'f.md']);
  });
});

describe('linkPath', () => {
  it('drops the fragment, then the query, then a title', () => {
    assert.equal(linkPath('a.md#x'), 'a.md');
    assert.equal(linkPath('a.md?x=1#y'), 'a.md');
    assert.equal(linkPath('a.md "title"'), 'a.md');
    assert.equal(linkPath('a b#c'), 'a');
  });

  it('reads an angle-bracket destination up to its first >', () => {
    assert.equal(linkPath('<a b.md> "t"'), 'a b.md');
    assert.equal(linkPath('<a>b>'), 'a');
    assert.equal(linkPath('<a b.md'), '<a');
    assert.equal(linkPath('<a#b>'), '<a');
  });

  it('can leave nothing', () => {
    assert.equal(linkPath('#x'), '');
    assert.equal(linkPath(' x'), '');
  });
});

describe('dirnameOf and basenameOf', () => {
  it('split as POSIX dirname and basename do', () => {
    const cases: Array<[string, string, string]> = [
      ['a.md', '.', 'a.md'],
      ['d/a.md', 'd', 'a.md'],
      ['/r/d/./', '/r/d', '.'],
      ['/r/d/../', '/r/d', '..'],
      ['d//a.md', 'd', 'a.md'],
      ['/a', '/', 'a'],
      ['/', '/', '/'],
      ['//', '/', '/'],
      ['', '.', ''],
    ];
    for (const [path, dir, base] of cases) {
      assert.equal(dirnameOf(path), dir, `dirname ${path}`);
      assert.equal(basenameOf(path), base, `basename ${path}`);
    }
  });
});

describe('nameOnDisk', () => {
  it('compares names exactly, . and .. always there', () => {
    const root = tree({ 'Lower.md': '' });
    assert.equal(nameOnDisk(root, 'Lower.md'), true);
    assert.equal(nameOnDisk(root, 'lower.md'), false);
    assert.equal(nameOnDisk(root, '.'), true);
    assert.equal(nameOnDisk(root, '..'), true);
    assert.equal(nameOnDisk(join(root, 'nowhere'), 'x'), false);
  });
});

describe('checkDoc', () => {
  const root = tree({ 'docs/target.md': '', 'docs/with space.md': '', 'docs/lower.md': '', 'docs/sub/c.md': '', 'docs/small.png': 'x', 'docs/big.png': 'x'.repeat(1_048_577) });

  it('passes links that resolve: relative, titled, rooted, angle-bracketed, to folders', () => {
    const text = '[t](./target.md "title") [s](https://example.com) [r](/docs/target.md) [a](<./with space.md> "t") [h](./) [u](../) [d](sub) [n](./sub/../target.md)\n';
    assert.deepEqual(checkDoc(root, 'docs/links.md', text), { refused: false, out: [] });
  });

  it('refuses a file that is not there', () => {
    assert.deepEqual(checkDoc(root, 'docs/links.md', 'See [a ghost](./ghost.md).\n'), {
      refused: true,
      out: ['❌ Error: Reference to non-existent file in docs/links.md:', '   Link: ./ghost.md', '   Expected path: docs/ghost.md', ''],
    });
  });

  it('refuses a name whose case differs from the disk', () => {
    const { refused, out } = checkDoc(root, 'docs/forms.md', 'See [lower](./LOWER.md).\n');
    assert.equal(refused, true);
    assert.match(out[0] ?? '', /case differs|non-existent file/);
    assert.equal(out[1], '   Link: ./LOWER.md');
  });

  it('refuses a folder that is not there, and a link out of the repository', () => {
    assert.deepEqual(checkDoc(root, 'docs/a.md', '[g](./nodir/x.md) [o](../../out.md)\n'), {
      refused: true,
      out: [
        '❌ Error: Reference to file in non-existent directory in docs/a.md:',
        '   Link: ./nodir/x.md',
        '   Expected path: docs/./nodir/x.md',
        '   Parent directory does not exist',
        '',
        '❌ Error: Reference to file outside repository in docs/a.md:',
        '   Link: ../../out.md',
        `   Resolved path: ${dirname(root)}/out.md`,
        '   All references must be within the repository',
        '',
      ],
    });
  });

  it('reads a link in a document named by absolute path from that document', () => {
    assert.deepEqual(checkDoc(root, join(root, 'docs/a.md'), '[t](./target.md) [g](./ghost.md)\n').out.slice(0, 3), [
      `❌ Error: Reference to non-existent file in ${root}/docs/a.md:`,
      '   Link: ./ghost.md',
      '   Expected path: docs/ghost.md',
    ]);
  });

  it('refuses an absolute document outside the repository whose folder is gone, as outside', () => {
    const outside = '/nonexistent-pariksha-dir/doc.md';
    assert.deepEqual(checkDoc(root, outside, '[x](./y/z.md)\n').out.slice(0, 3), [
      `❌ Error: Reference to file outside repository in ${outside}:`,
      '   Link: ./y/z.md',
      '   Resolved path: /nonexistent-pariksha-dir/./y/z.md',
    ]);
  });

  it('warns about an image over 1 MiB without refusing it', () => {
    assert.deepEqual(checkDoc(root, 'docs/a.md', '![b](./big.png) ![s](./small.png)\n'), {
      refused: false,
      out: ['⚠️  Warning: Large image referenced in docs/a.md:', '   Image: docs/big.png', '   Size: ~1 MB (1024 KB)', '   Consider compressing images to keep repository size small.', ''],
    });
  });

  it('sizes a symlinked image as the link, as stat without -L does', () => {
    const r = tree({ 'big.png': 'x'.repeat(1_048_577) });
    symlinkSync('big.png', join(r, 'link.png'));
    assert.deepEqual(checkDoc(r, 'a.md', '![l](./link.png)\n'), { refused: false, out: [] });
    symlinkSync('nowhere.png', join(r, 'dangling.png'));
    assert.deepEqual(checkDoc(r, 'a.md', '![d](./dangling.png)\n'), {
      refused: true,
      out: ['❌ Error: Reference to non-existent file in a.md:', '   Link: ./dangling.png', '   Expected path: dangling.png', ''],
    });
  });

  it('skips a link left empty once its fragment goes', () => {
    assert.deepEqual(checkDoc(root, 'docs/a.md', '[x](?q)\n'), { refused: false, out: [] });
  });
});

describe('checkNonSyncedResources', () => {
  const doc = (file: string, text: string) => ({ file, text: () => text });

  it('says so when there is nothing to check, without asking for the top folder', () => {
    assert.deepEqual(
      checkNonSyncedResources(
        [],
        () => {
          throw new Error('not asked');
        },
        config,
      ),
      { ok: true, out: ['→ Checking for non-synced resource references...', '✅ No documentation files to check.'] },
    );
  });

  it('passes valid references', () => {
    const root = tree({ 'a.md': '', 'b.md': '' });
    assert.deepEqual(checkNonSyncedResources([doc('a.md', '[b](b.md)\n')], () => root, config), {
      ok: true,
      out: ['→ Checking for non-synced resource references...', '   Checking 1 documentation file(s)...', '✅ All resource references are valid'],
    });
  });

  it('refuses with each document’s findings, then the guidance', () => {
    const root = tree({ 'a.md': '' });
    const outcome = checkNonSyncedResources([doc('a.md', '[g](g.md)\n'), doc('b.md', '[a](a.md)\n')], () => root, { ...config, guidance: ['fix them', 'see the rules'] });
    assert.deepEqual(outcome, {
      ok: false,
      out: [
        '→ Checking for non-synced resource references...',
        '   Checking 2 documentation file(s)...',
        '❌ Error: Reference to non-existent file in a.md:',
        '   Link: g.md',
        '   Expected path: g.md',
        '',
        '',
        'fix them',
        'see the rules',
      ],
    });
    assert.deepEqual(checkNonSyncedResources([doc('a.md', '[g](g.md)\n')], () => root, config).out.slice(-1), ['Please ensure all referenced files exist in the repository.']);
  });
});
