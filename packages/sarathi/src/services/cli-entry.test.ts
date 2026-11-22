import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { expect } from '../test/expect.test.ts';
import { isCliEntry } from './cli-entry.ts';

const SELF_URL = import.meta.url;
const SELF_PATH = fileURLToPath(SELF_URL);

describe('isCliEntry', () => {
  test('is true for the exact path of the calling module', () => {
    expect(isCliEntry(SELF_PATH, SELF_URL)).toBe(true);
  });

  test('is true for a relative path that resolves to the calling module', () => {
    // Genuinely relative: `resolve(cwd, absolutePath)` would repeat the case above.
    const rel = relative(process.cwd(), SELF_PATH);
    expect(rel.startsWith('/')).toBe(false);
    expect(isCliEntry(rel, SELF_URL)).toBe(true);
  });

  test('is false when the module is imported rather than run', () => {
    // `node -e` and worker hosts leave argv[1] undefined.
    expect(isCliEntry(undefined, SELF_URL)).toBe(false);
  });

  test('is false for a different real file', () => {
    expect(isCliEntry(join(process.cwd(), 'package.json'), SELF_URL)).toBe(false);
  });

  test('is false for an entry path that does not exist', () => {
    expect(isCliEntry(join(tmpdir(), 'no-such-entry-xyz.ts'), SELF_URL)).toBe(false);
  });

  test('is true through a symlink, which a bare path comparison gets wrong', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-entry-'));
    try {
      const link = join(dir, 'linked-entry.ts');
      symlinkSync(SELF_PATH, link);
      expect(resolve(link)).not.toBe(SELF_PATH);
      expect(isCliEntry(link, SELF_URL)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
