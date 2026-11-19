/**
 * The plugin's manifest. Claude Code takes an installed plugin's version from
 * `.claude-plugin/plugin.json` first, and keeps a user on the cached copy until
 * that string changes, however many commits land
 * (https://code.claude.com/docs/en/plugins/loading.md#how-claude-code-computes-the-version).
 * The veda marketplace lists sarathi by a relative path in a GitHub-hosted
 * repository, so the manifest's version is what moves plugin users to new
 * skills and agents: it follows the package's version, which every release sets.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('.claude-plugin/plugin.json', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json')) as { name: string; version: string };
  const pkg = JSON.parse(read('package.json')) as { version: string };

  it('names the plugin sarathi', () => {
    assert.equal(manifest.name, 'sarathi');
  });

  it("is at the package's version, so plugin installs update with each release", () => {
    assert.equal(
      manifest.version,
      pkg.version,
      `set "version" in packages/sarathi/.claude-plugin/plugin.json to ${pkg.version}, the version in packages/sarathi/package.json: a manifest left behind keeps plugin users on its cached skills and agents`,
    );
  });
});
