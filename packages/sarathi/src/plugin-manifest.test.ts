/**
 * veda's marketplace lists its plugins, sarathi among them. Claude Code takes
 * an installed plugin's version from its manifest first, then from its
 * marketplace entry, and keeps a user on the cached copy until that string
 * changes. With neither set, a relative-path plugin in a Git-hosted
 * marketplace gets the commit SHA as its version, so users track main's
 * commits (https://code.claude.com/docs/en/plugins/loading.md#how-claude-code-computes-the-version,
 * https://code.claude.com/docs/en/plugins/host-marketplace.md#release-a-new-version).
 * Neither sets one, so no plugin waits on a version bump (veda#279, veda#283).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/** Reads a JSON file by its path from the repository root. */
const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')) as Record<string, unknown>;

interface Entry {
  name: string;
  source: unknown;
  version?: unknown;
}

const marketplace = read('.claude-plugin/marketplace.json') as { plugins: Entry[] };

describe('.claude-plugin/marketplace.json', () => {
  it('lists sarathi, and each plugin by a relative path', () => {
    assert.ok(marketplace.plugins.some((entry) => entry.name === 'sarathi'), 'the marketplace lists sarathi');
    for (const entry of marketplace.plugins) {
      assert.equal(typeof entry.source, 'string', `${entry.name}'s source is a path`);
      assert.match(String(entry.source), /^\.\//, `${entry.name}'s source is relative`);
    }
  });

  for (const entry of marketplace.plugins) {
    describe(entry.name, () => {
      it('its marketplace entry sets no version', () => {
        assert.ok(!('version' in entry), `remove "version" from ${entry.name}'s entry in .claude-plugin/marketplace.json: it would pin plugin users to one cached copy`);
      });

      it('its manifest is the plugin of that name and sets no version', () => {
        const path = `${String(entry.source).slice(2)}/.claude-plugin/plugin.json`;
        const manifest = read(path);
        assert.equal(manifest.name, entry.name, `${path} names the plugin`);
        assert.ok(!('version' in manifest), `remove "version" from ${path}: it pins plugin users to one cached copy until it changes, so they miss every change merged after it`);
      });
    });
  }
});
