import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAbsolutePaths, DEFAULT_GUIDANCE, EXAMPLE_LINE, findInDoc, inBackticks, LOCAL_PATH } from './absolute-paths.ts';
import { parseDocConfig } from './doc-files.ts';

const config = parseDocConfig(undefined, DEFAULT_GUIDANCE);
const doc = (file: string, text: string) => ({ file, text: () => text });

describe('LOCAL_PATH', () => {
  it('matches each local form', () => {
    for (const line of ['file:///x', 'see /Users/me', '/home/me/', 'C:\\x', '/tmp/x', '/var/log', '/private/var', '~/x', 'D:\\y']) {
      assert.ok(LOCAL_PATH.test(line), line);
    }
  });

  it('leaves alone what is not one', () => {
    for (const line of ['/home/me', '/tmp/', '/var/', 'c:\\x', 'C:/x', 'https://example.com/a', 'src/a.ts', '~x']) {
      assert.ok(!LOCAL_PATH.test(line), line);
    }
  });
});

describe('EXAMPLE_LINE', () => {
  it('reads each example word in any case', () => {
    for (const line of ['FORBIDDEN', 'an Example', 'not allowed', 'Should Not', 'must not']) assert.ok(EXAMPLE_LINE.test(line), line);
    assert.ok(!EXAMPLE_LINE.test('must'));
  });
});

describe('inBackticks', () => {
  it('is true for a path inside one inline code span', () => {
    assert.equal(inBackticks('run `cat /Users/me/x` now'), true);
    assert.equal(inBackticks('a `b` `/Users/me/x` c'), true);
  });

  it('is false outside a span, before one, or with no backtick after', () => {
    assert.equal(inBackticks('/Users/me/x'), false);
    assert.equal(inBackticks('/Users/me/x `code`'), false);
    assert.equal(inBackticks('`a` /Users/me/x `b`'), false);
    assert.equal(inBackticks('`/Users/me/x'), false);
    assert.equal(inBackticks('plain'), false);
  });

  // The shell check's quirk, kept: `/tmp/<x>` runs to the next `/`, so the
  // span's own closing backtick falls inside the path.
  it('reads a span ending a /tmp path as no span', () => {
    assert.equal(inBackticks('`/tmp/a`'), false);
    assert.equal(inBackticks('`/tmp/a/b`'), true);
  });

  it('tests only the first path on the line', () => {
    assert.equal(inBackticks('`/Users/me/x` and /home/me/y'), true);
  });
});

describe('findInDoc', () => {
  it('names each refused line as file:line:text', () => {
    assert.deepEqual(findInDoc('a.md', 'ok\nRead /Users/fixture/private.txt for details.\n'), ['a.md:2:Read /Users/fixture/private.txt for details.']);
  });

  it('skips fenced lines and the fences, toggled by a line starting with three backticks', () => {
    const text = ['```sh', 'cd /Users/me', '```', '/tmp/x after', '  ```', '/home/me/ indented fence is no fence'].join('\n');
    assert.deepEqual(findInDoc('a.md', text), ['a.md:4:/tmp/x after', 'a.md:6:/home/me/ indented fence is no fence']);
  });

  it('leaves an unclosed fence skipping to the end', () => {
    assert.deepEqual(findInDoc('a.md', '```\n/tmp/x\n/tmp/y'), []);
  });

  it('skips a code span and an example line', () => {
    assert.deepEqual(findInDoc('a.md', 'use `/Users/me/x`\nFor example /Users/me/x\nYou must not write ~/x\n'), []);
  });

  it('reads a last line with no newline, and nothing of an empty file', () => {
    assert.deepEqual(findInDoc('a.md', 'x\n~/y'), ['a.md:2:~/y']);
    assert.deepEqual(findInDoc('a.md', ''), []);
  });
});

describe('checkAbsolutePaths', () => {
  it('says so when there is nothing to check', () => {
    assert.deepEqual(checkAbsolutePaths([], config), { ok: true, out: ['→ Checking for absolute paths in documentation...', '✅ No documentation files to check.'] });
  });

  it('passes clean documents', () => {
    assert.deepEqual(checkAbsolutePaths([doc('a.md', 'Plain documentation.\n')], config), {
      ok: true,
      out: ['→ Checking for absolute paths in documentation...', '   Checking 1 documentation file(s)...', '✅ No absolute paths found in documentation'],
    });
  });

  it('refuses with every finding, in order, then the guidance', () => {
    const outcome = checkAbsolutePaths([doc('a.md', '/tmp/x\n'), doc('b.md', 'ok\n'), doc('c d.md', 'file://x\n')], { ...config, guidance: ['one', '', 'two'] });
    assert.deepEqual(outcome, {
      ok: false,
      out: [
        '→ Checking for absolute paths in documentation...',
        '   Checking 3 documentation file(s)...',
        '',
        '❌ Error: Absolute paths or local file references found:',
        '',
        'a.md:1:/tmp/x',
        'c d.md:1:file://x',
        '',
        'one',
        '',
        'two',
      ],
    });
  });

  it('prints the default guidance', () => {
    assert.deepEqual(checkAbsolutePaths([doc('a.md', '/tmp/x\n')], config).out.slice(-1), ['Please use relative paths only.']);
  });
});
