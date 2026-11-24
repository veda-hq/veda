import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findDenied, hash, isText, once, parseDenyList } from './boundary.ts';

// Test words only: the real deny list is the repository's own.
const ACME = hash('acme');

describe('hash', () => {
  it('is the SHA-256 of the lowercase word', () => {
    assert.equal(hash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(hash('ABC'), hash('abc'));
  });
});

describe('parseDenyList', () => {
  it('reads one hash a line, skipping blanks and comments', () => {
    const list = parseDenyList(`# names this repo must never hold\n\n${ACME.toUpperCase()}  # a client\n`);
    assert.deepEqual([...list], [ACME]);
  });
  it('refuses a line that is not a hash', () => {
    assert.throws(() => parseDenyList('acme\n'), /not a SHA-256 hash: "acme"/);
  });
  it('refuses a hash with anything before or after it', () => {
    const acme = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    assert.throws(() => parseDenyList(`z${acme}\n`), { message: `not a SHA-256 hash: "z${acme}"` });
    assert.throws(() => parseDenyList(`${acme}0\n`), { message: `not a SHA-256 hash: "${acme}0"` });
    assert.deepEqual([...parseDenyList(`${acme}\n`)], [acme]);
  });
});

describe('isText', () => {
  it('is false for bytes with a NUL', () => {
    assert.equal(isText(new Uint8Array([104, 105])), true);
    assert.equal(isText(new Uint8Array([104, 0, 105])), false);
  });
});

describe('once', () => {
  it('asks f once per distinct word, and gives every repeat its first answer', () => {
    const asked: string[] = [];
    const lengthOf = once((word) => {
      asked.push(word);
      return word.length;
    });
    assert.deepEqual(['ab', 'c', 'ab', 'ab', 'c', 'def'].map(lengthOf), [2, 1, 2, 2, 1, 3]);
    assert.deepEqual(asked, ['ab', 'c', 'def']);
  });

  it('keeps an answer that is falsy', () => {
    let calls = 0;
    const no = once(() => {
      calls += 1;
      return false;
    });
    assert.deepEqual([no('a'), no('a')], [false, false]);
    assert.equal(calls, 1);
  });
});

describe('findDenied', () => {
  const deny = new Set([ACME]);

  it('finds a denied word in any case, inside other words split by punctuation', () => {
    const hits = findDenied(
      [
        { path: 'README.md', text: 'Built for\nthe @Acme-hq/rules package\nand acme_mono, twice: ACME.' },
        { path: 'clean.ts', text: 'export const acmeish = 1;\n' },
      ],
      deny,
    );
    assert.deepEqual(hits, [
      { file: 'README.md', line: 2, word: 'acme' },
      { file: 'README.md', line: 3, word: 'acme' },
      { file: 'README.md', line: 3, word: 'acme' },
    ]);
  });

  it('finds a denied word in a path, as line 0', () => {
    assert.deepEqual(findDenied([{ path: 'docs/acme.md', text: 'clean\n' }], deny), [
      { file: 'docs/acme.md', line: 0, word: 'acme' },
    ]);
  });

  it('reads past a line with no word', () => {
    assert.deepEqual(findDenied([{ path: 'a.md', text: '---\n\nACME' }], deny), [{ file: 'a.md', line: 3, word: 'acme' }]);
  });

  it('finds nothing in clean files or with an empty list', () => {
    assert.deepEqual(findDenied([{ path: 'a.ts', text: 'all clean' }], deny), []);
    assert.deepEqual(findDenied([{ path: 'acme.ts', text: 'acme' }], new Set()), []);
  });
});
