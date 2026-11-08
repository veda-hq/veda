import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isCliEntry } from './cli-entry.ts';

const SELF_URL = import.meta.url;
const SELF_PATH = fileURLToPath(SELF_URL);

describe('isCliEntry', () => {
  it('is true for the exact path of the calling module', () => {
    assert.equal(isCliEntry(SELF_PATH, SELF_URL), true);
  });

  it('is true for a relative path that resolves to the calling module', () => {
    // Must be genuinely relative: `resolve(cwd, absolutePath)` returns the
    // absolute path untouched, which would silently duplicate the case above.
    const rel = relative(process.cwd(), SELF_PATH);
    assert.equal(rel.startsWith('/'), false);
    assert.equal(isCliEntry(rel, SELF_URL), true);
  });

  it('is false when the module is imported rather than run', () => {
    // `node -e` and worker hosts leave argv[1] undefined.
    assert.equal(isCliEntry(undefined, SELF_URL), false);
  });

  it('is false for a different real file', () => {
    assert.equal(isCliEntry(join(import.meta.dirname, 'cli-entry.ts'), SELF_URL), false);
  });

  it('is false for an entry path that does not exist', () => {
    // The dangerous direction is returning TRUE here: the module would run
    // its CLI body during import from a host with an exotic argv[1].
    assert.equal(isCliEntry(join(tmpdir(), 'no-such-entry-xyz.ts'), SELF_URL), false);
  });
});

/**
 * The regression this helper exists for. A path-equality guard returns false
 * through a symlink (node resolves `import.meta.url` but not `argv[1]`), so
 * the gate skips itself and exits 0 with no output.
 */
describe('isCliEntry through a symlink', () => {
  let dir = '';
  let link = '';

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-entry-'));
    link = join(dir, 'linked-entry.ts');
    symlinkSync(SELF_PATH, link);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is true when the entry is a symlink to the calling module', () => {
    assert.equal(isCliEntry(link, SELF_URL), true);
  });

  it('is what a bare path comparison gets wrong', () => {
    // Pins the bug rather than just the fix: if this ever stops differing,
    // the symlink case has stopped being exercised and the test above is
    // passing for the wrong reason.
    assert.notEqual(resolve(link), SELF_PATH);
  });
});

/**
 * End to end: a module using this helper must actually run its CLI body when
 * invoked through a symlink, and stay inert when imported. The unit cases
 * above cannot catch a wiring mistake in the `if (isCliEntry(...))` call site.
 */
describe('isCliEntry as a module entry guard', () => {
  let dir = '';
  let script = '';
  let importer = '';

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-entry-e2e-'));
    script = join(dir, 'guarded.ts');
    const helper = pathToFileURL(resolve(import.meta.dirname, 'cli-entry.ts')).href;
    writeFileSync(
      script,
      `import { isCliEntry } from ${JSON.stringify(helper)};\n` +
        `export const marker = 'imported';\n` +
        `if (isCliEntry(process.argv[1], import.meta.url)) {\n` +
        `  console.log('CLI BODY RAN');\n` +
        `}\n`,
    );
    importer = join(dir, 'importer.ts');
    writeFileSync(
      importer,
      `import { marker } from ${JSON.stringify(pathToFileURL(script).href)};\n` + `console.log('marker:' + marker);\n`,
    );
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const node = (path: string): string =>
    execFileSync(process.execPath, [path], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });

  it('runs the CLI body when invoked directly', () => {
    assert.ok(node(script).includes('CLI BODY RAN'));
  });

  it('runs the CLI body when invoked through a symlink', () => {
    const linked = join(dir, 'guarded-link.ts');
    symlinkSync(script, linked);
    assert.ok(node(linked).includes('CLI BODY RAN'));
  });

  it('stays inert when imported', () => {
    const out = node(importer);
    assert.ok(out.includes('marker:imported'));
    assert.ok(!out.includes('CLI BODY RAN'));
  });
});
