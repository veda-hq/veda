import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findDenied, hash, isText, parseDenyList } from './boundary.ts';

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
});

describe('isText', () => {
  it('is false for bytes with a NUL', () => {
    assert.equal(isText(new Uint8Array([104, 105])), true);
    assert.equal(isText(new Uint8Array([104, 0, 105])), false);
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

  it('finds nothing in clean files or with an empty list', () => {
    assert.deepEqual(findDenied([{ path: 'a.ts', text: 'all clean' }], deny), []);
    assert.deepEqual(findDenied([{ path: 'acme.ts', text: 'acme' }], new Set()), []);
  });
});
