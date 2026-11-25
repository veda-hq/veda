import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { cleanupOf, DEFAULT_CLEANUP, DEFAULT_SETTINGS, parseSettings, readSettings } from './settings.ts';

describe('worktree settings', () => {
  it('default every field', () => {
    assert.deepEqual(parseSettings(undefined, 'f', '/r'), DEFAULT_SETTINGS);
    assert.deepEqual(parseSettings({}, 'f', '/r'), DEFAULT_SETTINGS);
  });

  it('resolve the cloud check from the project root', () => {
    assert.deepEqual(parseSettings({ name: 'acme', owner: 'Alok', cloudCheck: 'scripts/check.sh' }, 'f', '/r'), {
      name: 'acme',
      owner: 'Alok',
      cloudCheck: '/r/scripts/check.sh',
    });
    assert.equal(parseSettings({ cloudCheck: '/abs.sh' }, 'f', '/r').cloudCheck, '/abs.sh');
  });

  it('keep the services file as written: a path or a package path', () => {
    assert.equal(parseSettings({ services: 'tools/services.json' }, 'f', '/r').services, 'tools/services.json');
    assert.equal(parseSettings({ services: '@acme/rules/sarathi/services.json' }, 'f', '/r').services, '@acme/rules/sarathi/services.json');
    assert.equal(parseSettings({}, 'f', '/r').services, undefined);
  });

  it('refuse what they cannot use', () => {
    for (const [value, message] of [
      [{ services: '' }, /"services" must be a path/],
      [{ services: 3 }, /"services" must be a path/],
      [{ services: '@acme/rules' }, /"services" must be a path/],
      [{ services: '@acme/rules/../other/services.json' }, /"services" must be a path/],
      [{ services: '@acme/rules/sarathi/..' }, /"services" must be a path/],
      [[], /must be an object/],
      [{ extra: 1 }, /unknown key "extra"/],
      [{ name: 'Acme' }, /"name" must be/],
      [{ name: 'a/b' }, /"name" must be/],
      [{ owner: ' ' }, /"owner" must be a name/],
      [{ cloudCheck: '' }, /"cloudCheck" must be a path/],
    ] as const) {
      assert.throws(() => parseSettings(value, 'f', '/r'), message);
    }
  });

  it('leave cleanup off until set, and default each of its fields', () => {
    assert.equal(parseSettings({}, 'f', '/r').cleanup, undefined);
    assert.deepEqual(cleanupOf(parseSettings({}, 'f', '/r')), DEFAULT_CLEANUP);
    assert.deepEqual(parseSettings({ cleanup: {} }, 'f', '/r').cleanup, DEFAULT_CLEANUP);
    assert.deepEqual(parseSettings({ cleanup: { machine: {} } }, 'f', '/r').cleanup, DEFAULT_CLEANUP);
  });

  it('read every cleanup field', () => {
    const cleanup = {
      primaryBuilt: ['.turbo', 'apps/mobile/android/build'],
      nestedCopies: '^\\.wt\\/preflight(?:-\\d{15}-\\d{8})?$',
      machine: { dockerDesktopUpdate: true, androidNdk: 'apps/mobile/android/build.gradle', gradleCaches: true, simulators: true, brew: true },
    };
    const parsed = parseSettings({ cleanup }, 'f', '/r');
    assert.deepEqual(parsed.cleanup, cleanup);
    assert.equal(cleanupOf(parsed), parsed.cleanup);
    assert.deepEqual(parseSettings({ cleanup: { machine: { brew: true } } }, 'f', '/r').cleanup?.machine, {
      dockerDesktopUpdate: false,
      gradleCaches: false,
      simulators: false,
      brew: true,
    });
  });

  it('refuse a cleanup setting they cannot use safely', () => {
    for (const [cleanup, message] of [
      [[], /"cleanup" must be an object/],
      [{ extra: 1 }, /cleanup: unknown key "extra"/],
      [{ primaryBuilt: '.turbo' }, /"primaryBuilt" must be a list/],
      [{ primaryBuilt: [3] }, /"primaryBuilt" must be a list/],
      [{ primaryBuilt: [''] }, /"primaryBuilt" must be a list/],
      [{ primaryBuilt: ['.'] }, /"primaryBuilt" must be a list/],
      [{ primaryBuilt: ['/abs'] }, /"primaryBuilt" must be a list/],
      [{ primaryBuilt: ['a/../..'] }, /"primaryBuilt" must be a list/],
      [{ primaryBuilt: ['build/'] }, /"primaryBuilt" must be a list/],
      [{ primaryBuilt: ['.git/objects'] }, /"primaryBuilt" must be a list/],
      [{ primaryBuilt: ['.GIT/objects'] }, /"primaryBuilt" must be a list/],
      [{ machine: { androidNdk: '.Git' } }, /"androidNdk" must be a path/],
      [{ nestedCopies: '' }, /"nestedCopies" must be a regular expression/],
      [{ nestedCopies: 1 }, /"nestedCopies" must be a regular expression/],
      [{ nestedCopies: '(' }, /"nestedCopies" must be a regular expression/],
      [{ machine: [] }, /"machine" must be an object/],
      [{ machine: { docker: true } }, /machine: unknown key "docker"/],
      [{ machine: { brew: 'yes' } }, /"brew" must be true or false/],
      [{ machine: { androidNdk: true } }, /"androidNdk" must be a path/],
      [{ machine: { androidNdk: '../build.gradle' } }, /"androidNdk" must be a path/],
    ] as const) {
      assert.throws(() => parseSettings({ cleanup }, 'f', '/r'), message);
    }
  });

  it('come from .claude/sarathi.json, or default without it', () => {
    const root = mkdtempSync(join(tmpdir(), 'sarathi-settings-'));
    try {
      assert.deepEqual(readSettings(root), DEFAULT_SETTINGS);
      mkdirSync(join(root, '.claude'));
      writeFileSync(join(root, '.claude', 'sarathi.json'), JSON.stringify({ hooks: {}, worktree: { name: 'acme' } }));
      assert.equal(readSettings(root).name, 'acme');
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

describe('worktree settings, rule by rule', () => {
  const refusal = (value: unknown): string => {
    try {
      parseSettings(value, 'f', '/r');
    } catch (error) {
      return String(error);
    }
    return 'accepted';
  };

  it('default to sarathi and the owner', () => {
    assert.deepEqual(parseSettings(undefined, 'f', '/r'), { name: 'sarathi', owner: 'the owner' });
  });

  it('refuse a worktree value that is not an object, as a SettingsError naming the file', () => {
    assert.equal(refusal(null), 'SettingsError: f: "worktree" must be an object');
    assert.equal(refusal('acme'), 'SettingsError: f: "worktree" must be an object');
    assert.equal(refusal(7), 'SettingsError: f: "worktree" must be an object');
  });

  it('name every unknown key, under the file and worktree', () => {
    assert.equal(refusal({ extra: 1, more: 2 }), 'SettingsError: f worktree: unknown key "extra", "more"');
  });

  it('take name, owner and cloud check only as strings', () => {
    assert.equal(refusal({ name: ['acme'] }), 'SettingsError: f worktree: "name" must be lowercase letters, digits and dashes, starting with a letter');
    assert.equal(refusal({ owner: 5 }), 'SettingsError: f worktree: "owner" must be a name');
    assert.equal(refusal({ owner: [' x'] }), 'SettingsError: f worktree: "owner" must be a name');
    assert.equal(refusal({ cloudCheck: 5 }), 'SettingsError: f worktree: "cloudCheck" must be a path');
  });

  it('take a package path only whole: one scope, one package, then a file with no space', () => {
    const message = 'SettingsError: f worktree: "services" must be a path from the project root, or @scope/package/file';
    assert.equal(refusal({ services: '@acme/rules/a b' }), message);
    assert.equal(refusal({ services: '@ /@acme/rules/a' }), message);
  });

  it('refuse a cleanup list with any entry outside the checkout', () => {
    assert.equal(
      refusal({ cleanup: { primaryBuilt: ['build', ''] } }),
      'SettingsError: f worktree cleanup: "primaryBuilt" must be a list of paths inside the primary checkout',
    );
    assert.deepEqual(parseSettings({ cleanup: { primaryBuilt: ['build', 'out/a'] } }, 'f', '/r').cleanup?.primaryBuilt, ['build', 'out/a']);
  });
});
