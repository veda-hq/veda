// own-provenance through the command line: the settings from
// `.pariksha.json` or --config, the lockfile under --root, the registry's
// answer faked with a real attestation (kavach 0.6.0, veda's release).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { CONFIGURABLE, run } from './cli.ts';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const SETTINGS = { scope: '@veda-hq/', repository: 'https://github.com/veda-hq/veda', workflow: '.github/workflows/release.yml' };
const LOCK = ['packages:', '', "  '@veda-hq/kavach@0.6.0':", '    resolution: {integrity: sha512-Oc8MEAjnvKsmIYahAQ561gv4jTvktVLeMBo8otnDwqF0ywsK63H6cpVdkfrBGROqeuKO7v0slO5bl6tcWAFMdQ==}', ''].join('\n');
const KAVACH: unknown = JSON.parse(readFileSync(new URL('fixtures/own-provenance/attestations-kavach-0.6.0.json', import.meta.url), 'utf8'));

/** A git repository holding `files`, outside any other, so its own `.pariksha.json` is the one read. */
const repo = (files: Record<string, string>): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-cli-provenance-')));
  temps.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, timeout: 30_000, killSignal: 'SIGKILL' });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

/** The registry's answers by URL; any other URL is a 404. */
const registry = (answers: Record<string, unknown>) => async (url: string): Promise<unknown> => {
  if (!Object.hasOwn(answers, url)) throw new Error('HTTP 404');
  return answers[url];
};
const KAVACH_URL = 'https://registry.npmjs.org/-/npm/v1/attestations/@veda-hq%2fkavach@0.6.0';

const capture = (cwd: string, fetchJson = registry({ [KAVACH_URL]: KAVACH })) => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: () => cwd, provenance: { fetchJson } }, out, err };
};

describe('run own-provenance', () => {
  it('is configurable from .pariksha.json', () => {
    assert.ok(CONFIGURABLE.includes('own-provenance'));
  });

  it("passes veda's own signed release, verified against the trusted root pariksha ships", async () => {
    const root = repo({ 'pnpm-lock.yaml': LOCK, '.pariksha.json': JSON.stringify({ checks: { 'own-provenance': SETTINGS } }) });
    const c = capture(root);
    assert.equal(await run(['own-provenance', '--root', root], c.io, '1.0.0', {}), 0);
    assert.deepEqual(c.out, ['✅ own-provenance: @veda-hq/kavach@0.6.0 built and signed by https://github.com/veda-hq/veda .github/workflows/release.yml']);
    assert.deepEqual(c.err, []);
  });

  it('refuses the same release named under another repository, with the original prefix and trailer', async () => {
    const root = repo({ 'pnpm-lock.yaml': LOCK, 'provenance.json': JSON.stringify({ ...SETTINGS, repository: 'https://github.com/acme/fork' }) });
    const c = capture(root);
    assert.equal(await run(['own-provenance', '--config', 'provenance.json', '--root', root], c.io, '1.0.0', {}), 1);
    assert.match(c.err[0] as string, /^own-provenance: @veda-hq\/kavach@0\.6\.0: its provenance is not signed by acme\/fork's release of v0\.6\.0 \(.+\)$/);
    assert.equal(c.err.at(-1), "own-provenance: @veda-hq/* skips the release age only when acme/fork's release built and signed it.");
    assert.deepEqual(c.out, []);
  });

  it('exits 1 when the registry cannot be reached, never 0', async () => {
    const root = repo({ 'pnpm-lock.yaml': LOCK, '.pariksha.json': JSON.stringify({ checks: { 'own-provenance': SETTINGS } }) });
    const c = capture(root, registry({}));
    assert.equal(await run(['own-provenance', '--root', root], c.io, '1.0.0', {}), 1);
    assert.equal(c.err[0], 'own-provenance: @veda-hq/kavach@0.6.0: its attestations could not be read (HTTP 404)');
  });

  it('exits 2 with no settings, settings it cannot read, or bad ones', async () => {
    const bare = repo({ 'pnpm-lock.yaml': LOCK });
    const none = capture(bare);
    assert.equal(await run(['own-provenance', '--root', bare], none.io, '1.0.0', {}), 2);
    assert.deepEqual(none.err, ['own-provenance: no settings: name a settings file with --config or set checks.own-provenance in .pariksha.json; nothing was checked, so this is not a pass']);
    const missing = capture(bare);
    assert.equal(await run(['own-provenance', '--config', 'nowhere.json', '--root', bare], missing.io, '1.0.0', {}), 2);
    assert.match(missing.err[0] as string, /^own-provenance: ENOENT.*nowhere\.json.*; nothing was checked, so this is not a pass$/);
    const badRoot = repo({ '.pariksha.json': JSON.stringify({ checks: { 'own-provenance': { scope: 'veda' } } }) });
    const bad = capture(badRoot);
    assert.equal(await run(['own-provenance', '--root', badRoot], bad.io, '1.0.0', {}), 2);
    assert.match(bad.err[0] as string, /^own-provenance: "scope" must be/);
  });
});
