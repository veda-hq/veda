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
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The pinned niyam's own reading of a repository's pre-push hook, which
// `niyam onboard` and a cloud session's start act on, and the hook onboard
// writes into .git/hooks.
const { PRE_PUSH_HOOK, prePushHook } = await import(pathToFileURL(join(ROOT, 'node_modules', '@veda-hq', 'niyam', 'dist', 'onboard.js')).href);
const PINS = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies;
const PIN = PINS['@veda-hq/dvara'];
const NIYAM_PIN = PINS['@veda-hq/niyam'];
const scratch = mkdtempSync(join(tmpdir(), 'githooks-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const bin = join(scratch, 'bin');
const pnpmCalls = join(scratch, 'pnpm-calls');
const niyamCalls = join(scratch, 'niyam-calls');
const strayCalls = join(scratch, 'stray-niyam-calls');
// HOME is the scratch folder. A stand-in for the pinned niyam sits in the test
// repo's node_modules; another on PATH, and one as the launcher in HOME, must
// never run.
const env = {
  ...process.env,
  HOME: scratch,
  PATH: `${bin}${delimiter}${process.env.PATH}`,
  PNPM_CALLS: pnpmCalls,
  NIYAM_CALLS: niyamCalls,
  STRAY_CALLS: strayCalls,
  COPY_RUNS: join(scratch, 'copy-runs'),
};
for (const name of Object.keys(env)) {
  if (name.startsWith('DVARA_') || name.startsWith('GIT_') || name === 'NIYAM_AGENT' || name === 'NIYAM_REFUSE' || name === 'CLAUDECODE') delete env[name];
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

/** A commit of `file`, through the hooks. @param {string} cwd @param {string} file */
function commitFile(cwd, file) {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, 'add', file);
  const result = git(cwd, 'commit', '-q', '-m', file);
  assert.equal(result.code, 0, result.out);
}

let repo = '';
let remote = '';
before(() => {
  mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\necho "$*" >> "$PNPM_CALLS"\n');
  chmodSync(join(bin, 'pnpm'), 0o755);
  const stray = '#!/bin/sh\necho "$0 $*" >> "$STRAY_CALLS"\n';
  writeFileSync(join(bin, 'niyam'), stray);
  chmodSync(join(bin, 'niyam'), 0o755);
  mkdirSync(join(scratch, '.config', 'niyam', 'bin'), { recursive: true });
  writeFileSync(join(scratch, '.config', 'niyam', 'bin', 'niyam'), stray);
  chmodSync(join(scratch, '.config', 'niyam', 'bin', 'niyam'), 0o755);

  remote = join(scratch, 'remote.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env }).status, 0);

  repo = join(scratch, 'repo');
  mkdirSync(join(repo, 'packages'), { recursive: true });
  mkdirSync(join(repo, 'scripts'));
  mkdirSync(join(repo, 'node_modules', '@veda-hq'), { recursive: true });
  cpSync(join(ROOT, '.githooks'), join(repo, '.githooks'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'released-pins.mjs'), join(repo, 'scripts', 'released-pins.mjs'));
  symlinkSync(realpathSync(join(ROOT, 'node_modules', '@veda-hq', 'dvara')), join(repo, 'node_modules', '@veda-hq', 'dvara'));
  // The pinned niyam, installed: its package.json for released-pins, and a
  // stand-in for the bin pnpm links.
  mkdirSync(join(repo, 'node_modules', '@veda-hq', 'niyam'));
  writeFileSync(join(repo, 'node_modules', '@veda-hq', 'niyam', 'package.json'), JSON.stringify({ name: '@veda-hq/niyam', version: NIYAM_PIN }));
  mkdirSync(join(repo, 'node_modules', '.bin'));
  // It records its arguments, the agent it was told of and git's ref lines,
  // and refuses when NIYAM_REFUSE is set, as niyam refuses a push.
  writeFileSync(join(repo, 'node_modules', '.bin', 'niyam'), '#!/bin/sh\n{ echo "args: $*"; echo "agent: ${NIYAM_AGENT:-}"; cat; } >> "$NIYAM_CALLS"\n[ -z "${NIYAM_REFUSE:-}" ]\n');
  chmodSync(join(repo, 'node_modules', '.bin', 'niyam'), 0o755);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ devDependencies: { '@veda-hq/dvara': PIN, '@veda-hq/niyam': NIYAM_PIN } }));
  // veda's own stage lists, so a hook that strays from them fails here.
  const { stages } = JSON.parse(readFileSync(join(ROOT, '.dvara.json'), 'utf8'));
  writeFileSync(join(repo, '.dvara.json'), JSON.stringify({ stages, records: {} }));
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.dvara/\n');
  git(repo, 'init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'Hook Test'], ['user.email', 'hooks@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '.githooks']]) {
    git(repo, 'config', key, value);
  }
  git(repo, 'remote', 'add', 'origin', remote);
  // The hooks onboard left in .git/hooks, as on a machine onboarded before
  // core.hooksPath was set: git must run neither once it is. onboard's
  // pre-push runs the launcher in ~/.config, a stray here.
  writeFileSync(join(repo, '.git', 'hooks', 'pre-push'), PRE_PUSH_HOOK, { mode: 0o755 });
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho "$0" >> "$STRAY_CALLS"\n`, { mode: 0o755 });
});

/** The repository's hooks as niyam sees them: the pinned niyam's prePushHook with a real git. @param {string} root */
function niyamReadsHook(root) {
  const sys = {
    exec: (command, args, { cwd }) => {
      const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    exists: existsSync,
    read: path => readFileSync(path, 'utf8'),
  };
  return prePushHook(sys, root);
}

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

  test("once onboarded, an agent session's push goes through the pinned niyam's pre-push with git's ref lines", () => {
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
    assert.ok(!existsSync(strayCalls), 'neither the niyam on PATH, the launcher in ~/.config, nor .git/hooks runs');
  });

  test("once onboarded, anyone else's push goes ahead without niyam, as onboard's hook lets it", () => {
    const before = readFileSync(niyamCalls, 'utf8');
    commitFile(repo, 'owner.md');
    const result = git(repo, 'push', '-q', 'origin', 'main');
    assert.equal(result.code, 0, result.out);
    assert.equal(readFileSync(niyamCalls, 'utf8'), before, 'niyam does not run');
  });

  test('NIYAM_AGENT alone marks an agent session, and reaches the pinned niyam', () => {
    commitFile(repo, 'agent.md');
    const result = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo, env: { ...env, NIYAM_AGENT: 'AgentBot' }, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const calls = readFileSync(niyamCalls, 'utf8').split('args: ');
    assert.match(calls.at(-1), /^pre-push origin .*\nagent: AgentBot\nrefs\/heads\/main /);
  });

  test('a push the pinned niyam refuses is refused, and nothing lands', () => {
    commitFile(repo, 'refused.md');
    const result = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo, env: { ...env, CLAUDECODE: '1', NIYAM_REFUSE: '1' }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.notEqual(git(remote, 'rev-parse', 'main').stdout, git(repo, 'rev-parse', 'main').stdout);
    assert.ok(!existsSync(strayCalls));
  });

  test("refuses an agent session's push when the pinned niyam's bin is missing", () => {
    const shim = join(repo, 'node_modules', '.bin', 'niyam');
    const text = readFileSync(shim, 'utf8');
    rmSync(shim);
    try {
      writeFileSync(join(repo, 'more.md'), 'more\n');
      git(repo, 'add', 'more.md');
      assert.equal(git(repo, 'commit', '-q', '-m', 'more').code, 0);
      const result = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo, env: { ...env, CLAUDECODE: '1' }, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /the pinned CLI is not installed/);
      assert.ok(!existsSync(strayCalls), 'no other niyam stands in for it');
    } finally {
      writeFileSync(shim, text);
      chmodSync(shim, 0o755);
    }
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

// core.hooksPath is .githooks, relative, in the main checkout's shared config
// (CLAUDE.md, "Git hooks"): git ignores .git/hooks, and each worktree runs
// the hooks its own branch has.
describe('core.hooksPath', () => {
  test('the pinned niyam reads .githooks/pre-push as its own, so onboard and a cloud session start leave it and .git/hooks alone', () => {
    const hook = niyamReadsHook(repo);
    assert.equal(realpathSync(hook.file), realpathSync(join(repo, '.githooks', 'pre-push')));
    assert.equal(hook.state, 'ours');
  });

  test("a linked worktree runs its own branch's hooks, which niyam reads as its own", () => {
    const tree = join(scratch, 'tree');
    const copyRuns = env.COPY_RUNS;
    assert.equal(git(repo, 'worktree', 'add', '-q', '-b', 'wt', tree, 'origin/main').code, 0);
    symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules'));
    // The worktree's branch changes its pre-commit, so a run of that copy is seen.
    const hookFile = join(tree, '.githooks', 'pre-commit');
    writeFileSync(hookFile, readFileSync(hookFile, 'utf8').replace('\n', '\necho copy >> "$COPY_RUNS"\n'));
    git(tree, 'add', '.githooks/pre-commit');
    const committed = git(tree, 'commit', '-q', '-m', 'the branch has its own pre-commit');
    assert.equal(committed.code, 0, committed.out);
    assert.ok(existsSync(copyRuns), "the worktree's commit runs its branch's pre-commit");
    const runs = readFileSync(copyRuns, 'utf8');
    commitFile(repo, 'main-only.md');
    assert.equal(readFileSync(copyRuns, 'utf8'), runs, "the main checkout's commit runs main's");

    const hook = niyamReadsHook(tree);
    assert.equal(realpathSync(hook.file), realpathSync(join(tree, '.githooks', 'pre-push')));
    assert.equal(hook.state, 'ours');

    const head = git(tree, 'rev-parse', 'HEAD').stdout;
    const pushed = spawnSync('git', ['push', '-q', 'origin', 'wt'], { cwd: tree, env: { ...env, CLAUDECODE: '1' }, encoding: 'utf8' });
    assert.equal(pushed.status, 0, `${pushed.stdout}${pushed.stderr}`);
    assert.match(readFileSync(niyamCalls, 'utf8'), new RegExp(`^refs/heads/wt ${head} refs/heads/wt 0{40}$`, 'm'));
    assert.ok(!existsSync(strayCalls), '.git/hooks never runs');
  });
});
