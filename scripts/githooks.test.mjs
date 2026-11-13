// .githooks/, run by git in a throwaway repository laid out as veda is: the
// hooks, released-pins.mjs, a root package.json pinning dvara, and that
// dvara installed (linked to this checkout's install, which `pnpm install`
// must have laid out, as in CI). `pnpm` on PATH is a stand-in that records
// its arguments, so the pre-push hook's `pnpm guards` stage is seen to run
// without installing the repository's guards in the throwaway copy.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PIN = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies['@veda-hq/dvara'];
const scratch = mkdtempSync(join(tmpdir(), 'githooks-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const bin = join(scratch, 'bin');
const pnpmCalls = join(scratch, 'pnpm-calls');
const niyamCalls = join(scratch, 'niyam-calls');
// HOME is the scratch folder, so the hook finds the stand-in niyam on PATH,
// never this machine's launcher.
const env = { ...process.env, HOME: scratch, PATH: `${bin}${delimiter}${process.env.PATH}`, PNPM_CALLS: pnpmCalls, NIYAM_CALLS: niyamCalls };
for (const name of Object.keys(env)) {
  if (name.startsWith('DVARA_') || name.startsWith('GIT_') || name === 'NIYAM_AGENT' || name === 'CLAUDECODE') delete env[name];
}
// No automatic maintenance: a commit's detached `git maintenance run --auto`
// outlives it and can write into the scratch folder while it is removed.
Object.assign(env, {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto',
  GIT_CONFIG_VALUE_1: '0',
});

/** @param {string} cwd @param {string[]} args */
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, stdout: result.stdout.trim() };
}

/** A commit of the index made without running any hook, as a commit from elsewhere arrives. @param {string} cwd */
function commitWithoutHooks(cwd, message) {
  const tree = git(cwd, 'write-tree').stdout;
  const commit = git(cwd, 'commit-tree', tree, '-p', 'HEAD', '-m', message).stdout;
  assert.equal(git(cwd, 'update-ref', 'refs/heads/main', commit).code, 0);
}

let repo = '';
let remote = '';
before(() => {
  mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\necho "$*" >> "$PNPM_CALLS"\n');
  chmodSync(join(bin, 'pnpm'), 0o755);
  writeFileSync(join(bin, 'niyam'), '#!/bin/sh\n{ echo "args: $*"; cat; } >> "$NIYAM_CALLS"\n');
  chmodSync(join(bin, 'niyam'), 0o755);

  remote = join(scratch, 'remote.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env }).status, 0);

  repo = join(scratch, 'repo');
  mkdirSync(join(repo, 'packages'), { recursive: true });
  mkdirSync(join(repo, 'scripts'));
  mkdirSync(join(repo, 'node_modules', '@veda-hq'), { recursive: true });
  cpSync(join(ROOT, '.githooks'), join(repo, '.githooks'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'released-pins.mjs'), join(repo, 'scripts', 'released-pins.mjs'));
  symlinkSync(realpathSync(join(ROOT, 'node_modules', '@veda-hq', 'dvara')), join(repo, 'node_modules', '@veda-hq', 'dvara'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ devDependencies: { '@veda-hq/dvara': PIN } }));
  // veda's own stage lists, so a hook that strays from them fails here.
  const { stages } = JSON.parse(readFileSync(join(ROOT, '.dvara.json'), 'utf8'));
  writeFileSync(join(repo, '.dvara.json'), JSON.stringify({ stages, records: {} }));
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.dvara/\n');
  git(repo, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'Hook Test'], ['user.email', 'hooks@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '.githooks']]) {
    git(repo, 'config', key, value);
  }
  git(repo, 'remote', 'add', 'origin', remote);
});

describe('pre-commit', () => {
  test('passes a clean commit, under dvara', () => {
    git(repo, 'add', '-A');
    const result = git(repo, 'commit', '-q', '-m', 'first');
    assert.equal(result.code, 0, result.out);
    assert.ok(existsSync(join(repo, '.dvara', 'history.jsonl')), 'dvara records the run');
  });

  test('refuses a staged machine path (dvara records)', () => {
    writeFileSync(join(repo, 'notes.md'), 'See /Users/someone/notes for the log.\n');
    git(repo, 'add', 'notes.md');
    const result = git(repo, 'commit', '-q', '-m', 'notes');
    assert.notEqual(result.code, 0);
    assert.match(result.out, /EVIDENCE-02/);
    git(repo, 'reset', '-q', 'notes.md');
    rmSync(join(repo, 'notes.md'));
  });

  test('refuses when the pinned dvara is not installed', () => {
    const link = join(repo, 'node_modules', '@veda-hq', 'dvara');
    const target = realpathSync(link);
    rmSync(link);
    try {
      writeFileSync(join(repo, 'ok.md'), 'fine\n');
      git(repo, 'add', 'ok.md');
      const result = git(repo, 'commit', '-q', '-m', 'ok');
      assert.notEqual(result.code, 0);
      assert.match(result.out, /@veda-hq\/dvara .* is not installed/);
    } finally {
      symlinkSync(target, link);
    }
  });
});

describe('pre-push', () => {
  test('passes a clean push, running the pinned guards; no niyam before onboarding', () => {
    const result = git(repo, 'push', '-q', 'origin', 'main');
    assert.equal(result.code, 0, result.out);
    assert.match(readFileSync(pnpmCalls, 'utf8'), /--silent guards/);
    assert.ok(!existsSync(niyamCalls), 'niyam runs only once .github/niyam.json is there');
  });

  test("once onboarded, an agent session's push goes through niyam pre-push with git's ref lines", () => {
    mkdirSync(join(repo, '.github'));
    writeFileSync(join(repo, '.github', 'niyam.json'), '{}\n');
    git(repo, 'add', '.github/niyam.json');
    assert.equal(git(repo, 'commit', '-q', '-m', 'onboard').code, 0);
    const head = git(repo, 'rev-parse', 'HEAD').stdout;
    const result = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo, env: { ...env, CLAUDECODE: '1' }, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const calls = readFileSync(niyamCalls, 'utf8');
    assert.match(calls, new RegExp(`^args: pre-push origin ${remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
    assert.match(calls, new RegExp(`^refs/heads/main ${head} refs/heads/main [0-9a-f]{40}$`, 'm'));
  });

  test('refuses a pushed machine path the commit hook never saw', () => {
    writeFileSync(join(repo, 'log.md'), 'Written in /private/tmp/session-1.\n');
    git(repo, 'add', 'log.md');
    commitWithoutHooks(repo, 'log');
    const result = git(repo, 'push', '-q', 'origin', 'main');
    assert.notEqual(result.code, 0);
    assert.match(result.out, /EVIDENCE-02/);
    assert.notEqual(git(remote, 'rev-parse', 'main').stdout, git(repo, 'rev-parse', 'main').stdout);
  });
});
