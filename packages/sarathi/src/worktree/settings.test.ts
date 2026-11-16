import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_SETTINGS, parseSettings, readSettings } from './settings.ts';

describe('worktree settings', () => {
  it('default every field', () => {
    assert.deepEqual(parseSettings(undefined, 'f', '/r'), DEFAULT_SETTINGS);
    assert.deepEqual(parseSettings({}, 'f', '/r'), DEFAULT_SETTINGS);
  });

  it('resolve the cloud check from the project root', () => {
    assert.deepEqual(parseSettings({ name: 'athya', owner: 'Alok', cloudCheck: 'scripts/check.sh' }, 'f', '/r'), {
      name: 'athya',
      owner: 'Alok',
      cloudCheck: '/r/scripts/check.sh',
    });
    assert.equal(parseSettings({ cloudCheck: '/abs.sh' }, 'f', '/r').cloudCheck, '/abs.sh');
  });

  it('refuse what they cannot use', () => {
    for (const [value, message] of [
      [[], /must be an object/],
      [{ extra: 1 }, /unknown key "extra"/],
      [{ name: 'Athya' }, /"name" must be/],
      [{ name: 'a/b' }, /"name" must be/],
      [{ owner: ' ' }, /"owner" must be a name/],
      [{ cloudCheck: '' }, /"cloudCheck" must be a path/],
    ] as const) {
      assert.throws(() => parseSettings(value, 'f', '/r'), message);
    }
  });

  it('come from .claude/sarathi.json, or default without it', () => {
    const root = mkdtempSync(join(tmpdir(), 'sarathi-settings-'));
    try {
      assert.deepEqual(readSettings(root), DEFAULT_SETTINGS);
      mkdirSync(join(root, '.claude'));
      writeFileSync(join(root, '.claude', 'sarathi.json'), JSON.stringify({ hooks: {}, worktree: { name: 'athya' } }));
      assert.equal(readSettings(root).name, 'athya');
      writeFileSync(join(root, '.claude', 'sarathi.json'), '[]');
      assert.deepEqual(readSettings(root), DEFAULT_SETTINGS);
      writeFileSync(join(root, '.claude', 'sarathi.json'), '{');
      assert.throws(() => readSettings(root), /is not JSON/);
      rmSync(join(root, '.claude', 'sarathi.json'));
      mkdirSync(join(root, '.claude', 'sarathi.json'));
      assert.throws(() => readSettings(root), /cannot read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
