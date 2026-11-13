import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { main, problems } from './released-pins.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'released-pins.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'released-pins-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let count = 0;
/** A repository whose root pins `pins`, with a packages/ folder. @param {Record<string, string>} pins */
function repo(pins) {
  const dir = join(scratch, `repo-${count++}`);
  mkdirSync(join(dir, 'packages'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: pins }));
  return dir;
}

/** Install `name` at `version` into `dir`'s node_modules, as a folder. */
function install(dir, name, version) {
  const at = join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, 'package.json'), JSON.stringify({ name, version }));
}

describe('problems', () => {
  test('passes when every @veda-hq pin is installed at its version from outside packages/', () => {
    const dir = repo({ '@veda-hq/dvara': '0.5.16', '@veda-hq/pariksha': '0.5.20', typescript: '^5' });
    install(dir, '@veda-hq/dvara', '0.5.16');
    install(dir, '@veda-hq/pariksha', '0.5.20');
    assert.deepEqual(problems(dir), []);
  });

  test('refuses a pin that is not an exact version', () => {
    const dir = repo({ '@veda-hq/dvara': '^0.5.16' });
    assert.match(problems(dir)[0], /pinned as "\^0\.5\.16", not as an exact released version/);
  });

  test('refuses a pin that is not installed, naming the install', () => {
    const dir = repo({ '@veda-hq/dvara': '0.5.16' });
    assert.match(problems(dir)[0], /0\.5\.16 is not installed in .*; run pnpm install there/);
  });

  test('refuses a pin linked to the workspace source', () => {
    const dir = repo({ '@veda-hq/dvara': '0.5.16' });
    mkdirSync(join(dir, 'packages', 'dvara'));
    writeFileSync(join(dir, 'packages', 'dvara', 'package.json'), JSON.stringify({ version: '0.5.16' }));
    mkdirSync(join(dir, 'node_modules', '@veda-hq'), { recursive: true });
    symlinkSync(join(dir, 'packages', 'dvara'), join(dir, 'node_modules', '@veda-hq', 'dvara'));
    assert.match(problems(dir)[0], /resolves to packages\/dvara, the workspace's own source/);
  });

  test('refuses an install at another version', () => {
    const dir = repo({ '@veda-hq/dvara': '0.5.16' });
    install(dir, '@veda-hq/dvara', '0.5.15');
    assert.match(problems(dir)[0], /0\.5\.15 is installed, but package\.json pins 0\.5\.16/);
  });

  test('checks only the packages named, each of which must be pinned', () => {
    const dir = repo({ '@veda-hq/dvara': '0.5.16', '@veda-hq/pariksha': '0.5.20' });
    install(dir, '@veda-hq/dvara', '0.5.16');
    assert.deepEqual(problems(dir, ['@veda-hq/dvara']), []);
    assert.match(problems(dir, ['@veda-hq/kavach'])[0], /@veda-hq\/kavach is not a devDependency/);
  });

  test('a root with no devDependencies has nothing to check', () => {
    const dir = join(scratch, 'bare');
    mkdirSync(join(dir, 'packages'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}');
    assert.deepEqual(problems(dir), []);
  });
});

describe('main', () => {
  test('exits 0 when the pins are in place, 1 with each problem otherwise', () => {
    const good = repo({ '@veda-hq/dvara': '0.5.16' });
    install(good, '@veda-hq/dvara', '0.5.16');
    assert.equal(main(['--root', good]), 0);
    assert.equal(main(['--root', repo({ '@veda-hq/dvara': '0.5.16' })]), 1);
  });

  test('exits 2 when --root has no value', () => {
    assert.equal(main(['--root']), 2);
  });

  test('runs as a command from the current folder', () => {
    const dir = repo({ '@veda-hq/dvara': '0.5.16' });
    const result = spawnSync(process.execPath, [SCRIPT, '@veda-hq/dvara'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^released-pins: @veda-hq\/dvara 0\.5\.16 is not installed/);
  });
});
