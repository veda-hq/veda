// pr-title through the command line: the title from the environment, the
// commitlint config found from --root, the shape from `.pariksha.json`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { CONFIGURABLE, run } from './cli.ts';
import { NO_COMMITLINT } from './pr-title.ts';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const COMMITLINT = `export default {
  parserPreset: { parserOpts: { headerPattern: /^(?:.*? )?(\\w+)(?:\\((.*)\\))?: (.*)$/, headerCorrespondence: ['type', 'scope', 'subject'] } },
  rules: { 'type-enum': [2, 'always', ['feat', 'fix']], 'type-empty': [2, 'never'], 'subject-empty': [2, 'never'], 'header-max-length': [2, 'always', 100] },
};
`;
const SETTINGS = { shape: { gitmoji: ['✨', '🐛'], types: ['feat', 'fix'], summaryMax: 70 }, skipHeadPrefixes: ['mergify/merge-queue/'], guide: 'docs/COMMITS.md' };

/** A git repository holding `files`, outside any other, so its own `.pariksha.json` is the one read. */
const repo = (files: Record<string, string>): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pariksha-cli-pr-title-')));
  temps.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, timeout: 30_000, killSignal: 'SIGKILL' });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
};

const capture = (cwd: string, extra: object = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: () => cwd, ...extra }, out, err };
};

describe('run pr-title', () => {
  it('is configurable from .pariksha.json', () => {
    assert.ok(CONFIGURABLE.includes('pr-title'));
  });

  it("holds PR_TITLE to the root's commitlint and the entry's shape", async () => {
    const root = repo({ 'commitlint.config.mjs': COMMITLINT, '.pariksha.json': JSON.stringify({ checks: { 'pr-title': SETTINGS } }) });
    const ok = capture(root);
    assert.equal(await run(['pr-title', '--root', root], ok.io, '1.0.0', { PR_TITLE: '✨ feat(cli): hold the title', PR_NUMBER: '7' }), 0);
    assert.deepEqual(ok.out, ['pariksha pr-title: ok: ✨ feat(cli): hold the title']);
    assert.deepEqual(ok.err, []);
    // commitlint passes it; only the shape refuses the period.
    const refused = capture(root);
    assert.equal(await run(['pr-title', '--root', root], refused.io, '1.0.0', { PR_TITLE: 'feat(cli): hold the title.' }), 1);
    assert.deepEqual(refused.err.slice(1), ['  - expected "<gitmoji> <type>(scope): <summary>", e.g. "✨ feat(scope): keep the summary short"', 'Edit the title: the edit re-runs this check (re-running this run reuses the old title). See docs/COMMITS.md.']);
  });

  it('skips a head branch the entry names, and checks commitlint alone with no settings', async () => {
    const root = repo({ 'commitlint.config.mjs': COMMITLINT, '.pariksha.json': JSON.stringify({ checks: { 'pr-title': SETTINGS } }) });
    const skipped = capture(root);
    assert.equal(await run(['pr-title', '--root', root], skipped.io, '1.0.0', { PR_TITLE: 'Merge of #1', HEAD_REF: 'mergify/merge-queue/main/1' }), 0);
    const bare = repo({ 'commitlint.config.mjs': COMMITLINT });
    const c = capture(bare);
    assert.equal(await run(['pr-title', '--root', bare], c.io, '1.0.0', { PR_TITLE: 'fix: no gitmoji needed' }), 0);
    assert.equal(await run(['pr-title', '--root', bare], c.io, '1.0.0', { PR_TITLE: 'wibble: no' }), 1);
  });

  it('reads a settings file named with --config', async () => {
    const root = repo({ 'commitlint.config.mjs': COMMITLINT, 'title.json': JSON.stringify(SETTINGS) });
    const c = capture(root);
    assert.equal(await run(['pr-title', '--config', 'title.json', '--root', root], c.io, '1.0.0', { PR_TITLE: 'fix: no gitmoji' }), 1);
  });

  it('exits 2 on bad settings, no title, or no commitlint', async () => {
    const root = repo({ 'commitlint.config.mjs': COMMITLINT, '.pariksha.json': JSON.stringify({ checks: { 'pr-title': { shape: [] } } }) });
    const bad = capture(root);
    assert.equal(await run(['pr-title', '--root', root], bad.io, '1.0.0', { PR_TITLE: 'fix: x' }), 2);
    assert.deepEqual(bad.err, ['pariksha pr-title: "shape" must be an object of gitmoji, types and summaryMax; nothing was checked, so this is not a pass']);
    const bare = repo({ 'commitlint.config.mjs': COMMITLINT });
    const none = capture(bare);
    assert.equal(await run(['pr-title', '--root', bare], none.io, '1.0.0', {}), 2);
    const missing = capture(bare, { commitlint: async () => NO_COMMITLINT });
    assert.equal(await run(['pr-title', '--root', bare], missing.io, '1.0.0', { PR_TITLE: 'fix: x' }), 2);
    assert.deepEqual(missing.err, [`pariksha pr-title: ${NO_COMMITLINT}`]);
  });

  it('refuses a flag it does not take, such as a title in an argument', async () => {
    const c = capture(tmpdir());
    assert.equal(await run(['pr-title', '--title', 'fix: x'], c.io, '1.0.0', {}), 2);
  });
});
