// The plugins veda's marketplace lists. Claude Code takes an installed
// plugin's version from its manifest first, then from its marketplace entry,
// and keeps a user on the cached copy until that string changes. With
// neither set, a relative-path plugin in a Git-hosted marketplace gets the
// commit SHA as its version, so users track main's commits
// (https://code.claude.com/docs/en/plugins/loading.md#how-claude-code-computes-the-version,
// https://code.claude.com/docs/en/plugins/host-marketplace.md#release-a-new-version).
// Neither sets one, so no plugin waits on a version bump (veda#279, veda#283).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const marketplace = read('.claude-plugin/marketplace.json');

describe('.claude-plugin/marketplace.json', () => {
  test('lists the plugins, each by a relative path', () => {
    assert.ok(marketplace.plugins.length > 0, 'the marketplace lists a plugin');
    for (const entry of marketplace.plugins) {
      assert.equal(typeof entry.source, 'string', `${entry.name}'s source is a path`);
      assert.match(entry.source, /^\.\//, `${entry.name}'s source is relative`);
    }
  });

  for (const entry of marketplace.plugins) {
    describe(entry.name, () => {
      test('its marketplace entry sets no version', () => {
        assert.ok(!('version' in entry), `remove "version" from ${entry.name}'s entry in .claude-plugin/marketplace.json: it would pin plugin users to one cached copy`);
      });

      test('its manifest is the plugin of that name and sets no version', () => {
        const path = join(entry.source, '.claude-plugin', 'plugin.json');
        const manifest = read(path);
        assert.equal(manifest.name, entry.name, `${path} names the plugin`);
        assert.ok(!('version' in manifest), `remove "version" from ${path}: it pins plugin users to one cached copy until it changes, so they miss every change merged after it`);
      });
    });
  }
});
