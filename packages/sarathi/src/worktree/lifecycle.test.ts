// Real git repositories; only GitHub's answer is stood in.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ancestor,
  archiveCheck,
  begin,
  Blocked,
  cloudArchiveStep,
  cloudSessionWith,
  context,
  exclusive,
  inspect,
  launchBranch,
  lifecycleMain,
  nodeHost,
  pullRequest,
  readReceipt,
  restRead,
  retire,
  runProgram,
  within,
  writeReceipt,
  type Context,
  type Host,
} from './lifecycle.ts';
import { main } from '../cli.ts';
import { hookMain } from './hook.ts';
import type { WorktreeSettings } from './settings.ts';

const SETTINGS: WorktreeSettings = { name: 'acme', owner: 'Alok' };

interface Pr {
  merged: boolean;
  merge_commit_sha: string;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
}

/** A scratch main checkout (its own origin) and a Codex-managed worktree on codex/task. */
class Fixture {
  readonly home: string;
  readonly main: string;
  readonly worktree: string;
  readonly gitdir: string;
  readonly env: Record<string, string | undefined>;
  head = '';
  merged = '';
  pr: Pr | undefined;
  requests: string[][] = [];
  ghCalls: string[][] = [];

  constructor() {
    this.home = realpathSync(mkdtempSync(join(tmpdir(), 'sarathi-lifecycle-')));
    // Isolated before the first git call: runtime configuration can override
    // a repository's own. Without CLAUDE_CODE_REMOTE every case takes the
    // laptop's gh route, even when the suite runs in a cloud session.
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== 'GIT_CONFIG' && key !== 'CLAUDE_CODE_REMOTE' && !key.startsWith('GIT_CONFIG_') && !key.startsWith('GIT_')),
    );
    this.env = {
      ...clean,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      CODEX_HOME: join(this.home, 'codex'),
      CODEX_MANAGED_WORKTREE_ROOT: join(this.home, 'codex', 'worktrees'),
    };
    this.main = join(this.home, 'main');
    mkdirSync(this.main);
    this.git(this.main, 'init', '-q', '-b', 'main');
    this.git(this.main, 'config', 'commit.gpgsign', 'false');
    this.git(this.main, 'config', 'user.name', 'Test');
    this.git(this.main, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(this.main, '.gitignore'), '.tmp/\n.env\nnode_modules/\n.claude/worktrees/\n__pycache__/\n');
    // The settings the CLI reads, tracked as a project's are: the receipt is named after the project.
    mkdirSync(join(this.main, '.claude'));
    writeFileSync(join(this.main, '.claude', 'sarathi.json'), JSON.stringify({ hooks: {}, worktree: { name: 'acme', owner: 'Alok' } }));
    writeFileSync(join(this.main, 'tracked'), 'base\n');
    this.git(this.main, 'add', '.');
    this.git(this.main, 'commit', '-qm', 'base');
    this.git(this.main, 'remote', 'add', 'origin', this.main);
    this.git(this.main, 'fetch', 'origin', 'main');
    this.worktree = join(this.home, 'codex', 'worktrees', 'task', 'repo');
    this.git(this.main, 'worktree', 'add', '-qb', 'codex/task', this.worktree);
    this.gitdir = this.git(this.worktree, 'rev-parse', '--absolute-git-dir');
  }

  git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: this.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }

  write(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  commitWork(): string {
    this.write(join(this.worktree, 'feature'), 'feature\n');
    this.git(this.worktree, 'add', 'feature');
    this.git(this.worktree, 'commit', '-qm', 'feature');
    return this.git(this.worktree, 'rev-parse', 'HEAD');
  }

  commitLater(): void {
    this.write(join(this.worktree, 'later'), 'later');
    this.git(this.worktree, 'add', 'later');
    this.git(this.worktree, 'commit', '-qm', 'later');
  }

  merge(squash = false): void {
    this.head = this.commitWork();
    if (squash) {
      this.git(this.main, 'merge', '--squash', 'codex/task');
      this.git(this.main, 'commit', '-qm', 'squashed');
    } else {
      this.git(this.main, 'merge', '--ff-only', 'codex/task');
    }
    this.merged = this.git(this.main, 'rev-parse', 'HEAD');
    this.pr = {
      merged: true,
      merge_commit_sha: this.merged,
      head: { ref: 'codex/task', sha: this.head, repo: { full_name: 'acme/test' } },
      base: { ref: 'main', repo: { full_name: 'acme/test' } },
    };
  }

  /** The real host, with origin's URL and GitHub's answer stood in; `cloud` takes the REST route. */
  host(options: { cloud?: boolean; answer?: string | Error; after?: (args: readonly string[]) => void } = {}): Host {
    const real = nodeHost(SETTINGS, this.env);
    return {
      env: this.env,
      cloudSession: () => options.cloud === true,
      run: (cwd, file, args) => {
        if (file === 'git' && args.join(' ') === 'remote get-url origin') return 'https://github.com/acme/test.git\n';
        if (file === 'gh') {
          assert.notEqual(options.cloud, true, 'a cloud session must not run gh');
          this.ghCalls.push([...args]);
          return JSON.stringify(this.pr);
        }
        if (file === 'curl') {
          this.requests.push([...args]);
          if (options.answer instanceof Error) throw options.answer;
          return options.answer ?? JSON.stringify(this.pr);
        }
        const output = real.run(cwd, file, args);
        options.after?.(args);
        return output;
      },
    };
  }

  context(host: Host = this.host()): Context {
    return context(this.worktree, host, SETTINGS);
  }

  status(cloud = false) {
    return inspect(this.context(this.host({ cloud })));
  }

  retire(options: Parameters<Fixture['host']>[0] = {}) {
    return retire(this.context(this.host(options)), 7);
  }

  /** The CLI as a session runs it, in `cwd`, with the project's settings file there. */
  cli(cwd: string, ...args: string[]): { code: number; stdout: string } {
    let stdout = '';
    const code = lifecycleMain(args, {
      cwd,
      env: this.env,
      out: text => (stdout += text),
      err: text => (stdout += text),
      host: () => this.host(),
    });
    return { code, stdout };
  }

  branch(): string {
    return this.git(this.worktree, 'rev-parse', '--abbrev-ref', 'HEAD');
  }

  remove(): void {
    rmSync(this.home, { recursive: true, force: true });
  }
}

let f: Fixture;

describe('the worktree lifecycle against real git repositories', () => {
  beforeEach(() => {
    f = new Fixture();
  });
  afterEach(() => f.remove());

  it('reads the pull request over REST, never gh, in a cloud session', () => {
    f.merge();
    const result = f.retire({ cloud: true });
    assert.deepEqual(f.requests, [
      [
        '--silent', '--show-error', '--fail', '--proto', '=https', '--max-time', '60',
        '--header', 'Accept: application/vnd.github+json', '--header', 'X-GitHub-Api-Version: 2022-11-28',
        'https://api.github.com/repos/acme/test/pulls/7',
      ],
    ]);
    assert.equal(result.phase, 'retired');
    assert.equal(f.git(f.worktree, 'rev-parse', 'HEAD'), f.head);
  });

  it('judges cloud merge evidence as on the laptop', () => {
    f.merge();
    for (const change of ['open', 'foreign', 'branch'] as const) {
      const saved = structuredClone(f.pr);
      if (f.pr === undefined) throw new Error('no pr');
      if (change === 'open') f.pr.merged = false;
      else if (change === 'foreign') f.pr.head.repo.full_name = 'someone/test';
      else f.pr.head.ref = 'other';
      assert.throws(() => f.retire({ cloud: true }), /not a merged same-repository PR/);
      assert.equal(f.branch(), 'codex/task');
      f.pr = saved;
    }
  });

  it('never retires on an unreadable cloud answer', () => {
    f.merge();
    // curl --fail exits 22 on an HTTP error, 56 on a refused tunnel; run()
    // turns either into Blocked, as for gh.
    for (const code of [22, 56]) {
      const refusal = new Blocked(`curl --silent failed (exit ${code}); nothing may be discarded`);
      assert.throws(() => f.retire({ cloud: true, answer: refusal }), new RegExp(`exit ${code}\\); nothing may be discarded`));
      assert.equal(f.branch(), 'codex/task');
    }
    assert.throws(() => f.retire({ cloud: true, answer: '<html>not json</html>' }), /not a merged same-repository PR/);
    assert.equal(f.branch(), 'codex/task');
  });

  it('blocks on a failing curl through the real runner', () => {
    assert.throws(
      () => runProgram(f.worktree, 'curl', ['--silent', '--fail', '--proto', '=https', '--max-time', '5', 'file:///etc/hostname'], f.env),
      /curl --silent failed \(exit \d+\); nothing may be discarded/,
    );
  });

  it('reads cloud merge evidence from github.com only', () => {
    assert.throws(() => restRead(f.context(), 'ghe.example.com', 'repos/acme/test/pulls/7'), /github\.com only/);
  });

  it('needs the remote flag, and the project cloud check when it names one', () => {
    const passing = join(f.home, 'pass.sh');
    const failing = join(f.home, 'fail.sh');
    writeFileSync(passing, 'exit 0\n');
    writeFileSync(failing, 'test "$1" = never\n');
    assert.equal(cloudSessionWith({ ...SETTINGS, cloudCheck: passing }, f.env)(f.worktree), false);
    const remote = { ...f.env, CLAUDE_CODE_REMOTE: 'true' };
    assert.equal(cloudSessionWith({ ...SETTINGS, cloudCheck: passing }, remote)(f.worktree), true);
    assert.equal(cloudSessionWith({ ...SETTINGS, cloudCheck: failing }, remote)(f.worktree), false);
    assert.equal(cloudSessionWith(SETTINGS, remote)(f.worktree), true);
  });

  it('takes the gh route on a laptop', () => {
    f.merge();
    assert.equal(pullRequest(f.context(), 'github.com', 'acme/test', 7), JSON.stringify(f.pr));
    assert.deepEqual(f.ghCalls, [['api', '--hostname', 'github.com', 'repos/acme/test/pulls/7']]);
  });

  it('refuses the primary checkout and a foreign worktree', () => {
    assert.equal(f.cli(f.main, 'status').code, 2);
    const foreign = join(f.home, 'foreign');
    f.git(f.main, 'worktree', 'add', '-qb', 'other', foreign);
    assert.equal(f.cli(foreign, 'status').code, 2);
    assert.equal(f.cli(f.worktree, 'status').code, 0);
  });

  it("recognizes Claude Code's managed root", () => {
    const claude = join(f.main, '.claude', 'worktrees', 'task');
    f.git(f.main, 'worktree', 'add', '-qb', 'claude/task', claude);
    const result = f.cli(claude, 'status');
    assert.equal(result.code, 0, result.stdout);
    assert.equal((JSON.parse(result.stdout) as { provider: string }).provider, 'claude');
  });

  it('reads only, and reports all outstanding work', () => {
    f.commitWork();
    f.write(join(f.worktree, 'tracked'), 'unstaged\n');
    f.write(join(f.worktree, 'new'), 'untracked\n');
    f.write(join(f.worktree, '.env'), 'local credential\n');
    f.write(join(f.worktree, 'staged'), 'staged\n');
    f.git(f.worktree, 'add', 'staged');
    const before = f.git(f.worktree, 'status', '--porcelain');
    const refs = f.git(f.worktree, 'show-ref');
    const result = f.cli(f.worktree, 'archive-check');
    const report = JSON.parse(result.stdout) as { ignoredArtifacts: string[]; archiveReady: boolean };
    assert.equal(result.code, 2);
    assert.ok(report.ignoredArtifacts.includes('.env'));
    assert.equal(report.archiveReady, false);
    assert.equal(f.git(f.worktree, 'status', '--porcelain'), before);
    assert.equal(f.git(f.worktree, 'show-ref'), refs);
    assert.equal(existsSync(join(f.gitdir, 'acme-lifecycle.mutex')), false);
  });

  it('blocks on unknown ignored files even when the code is merged', () => {
    f.write(join(f.worktree, '.tmp', 'plan.json'), '{}');
    assert.equal(f.status().archiveReady, false);
    assert.ok(f.status().ignoredArtifacts.includes('.tmp/'));
  });

  it('lets shared links and reproducible dependencies go, keeping their targets', () => {
    writeFileSync(join(f.home, 'secret'), 'shared');
    symlinkSync(join(f.home, 'secret'), join(f.worktree, '.env'));
    f.write(join(f.worktree, 'node_modules', 'cache'), 'rebuildable');
    assert.equal(f.status().archiveReady, true);
    assert.equal(readFileSync(join(f.home, 'secret'), 'utf8'), 'shared');
  });

  it("lets husky's shims go, but not what sits beside them", () => {
    // The repository tracks hooks beside the shims; without one, git reports
    // the whole ignored `.husky/` instead, which still blocks.
    const shims = join(f.worktree, '.husky', '_');
    mkdirSync(shims, { recursive: true });
    f.write(join(f.worktree, '.husky', 'pre-commit'), '#!/usr/bin/env sh\n');
    f.git(f.worktree, 'add', '.husky/pre-commit');
    f.git(f.worktree, 'commit', '-qm', 'tracked hook');
    f.git(f.main, 'merge', '--ff-only', 'codex/task');
    f.git(f.main, 'fetch', 'origin', 'main');
    writeFileSync(join(shims, '.gitignore'), '*');
    writeFileSync(join(shims, 'pre-commit'), '#!/usr/bin/env sh\n');
    assert.deepEqual(f.status().ignoredArtifacts, []);
    assert.equal(f.status().archiveReady, true);
    // husky's `*` hides anything else placed in its dir; that must not vanish.
    writeFileSync(join(shims, 'notes'), 'real work\n');
    assert.deepEqual([...f.status().ignoredArtifacts].sort(), ['.husky/_/', '.husky/_/notes']);
    assert.equal(f.status().archiveReady, false);
    unlinkSync(join(shims, 'notes'));
    f.write(resolve(f.worktree, f.git(f.worktree, 'rev-parse', '--git-path', 'info/exclude')), '/.husky/_notes\n/_/\n');
    f.write(join(f.worktree, '.husky', '_notes'), 'real work\n');
    f.write(join(f.worktree, '_', 'draft'), 'real work\n');
    assert.deepEqual([...f.status().ignoredArtifacts].sort(), ['.husky/_notes', '_/']);
    assert.equal(f.status().archiveReady, false);
  });

  const ARCHIVE = 'Archive this session in the app; its container takes this worktree.';

  it('says, in a cloud session, to archive the session', () => {
    assert.equal(f.status(true).archiveReady, true);
    assert.equal(f.status(true).next, ARCHIVE);
    f.write(join(f.worktree, '.tmp', 'plan.json'), '{}');
    const report = f.status(true);
    assert.equal(report.archiveReady, false);
    assert.equal(report.next, `First get Alok's explicit OK to discard: .tmp/. Then a${ARCHIVE.slice(1)}`);
  });

  it('names no cloud step while work is outstanding', () => {
    f.write(join(f.worktree, '.tmp', 'plan.json'), '{}');
    f.write(join(f.worktree, 'new'), 'untracked\n');
    assert.equal(f.status(true).next, undefined);
    unlinkSync(join(f.worktree, 'new'));
    f.commitWork();
    assert.equal(f.status(true).next, undefined);
  });

  it('names no next step on a laptop', () => {
    assert.equal(f.status().archiveReady, true);
    assert.equal('next' in f.status(), false);
  });

  it('names the owner the project gives, or none', () => {
    assert.match(cloudArchiveStep('the owner', ['ignored artifacts need preservation or explicit discard'], ['x']) ?? '', /^First get the owner's explicit OK/);
  });

  it('blocks, never a false clean result, without origin/main', () => {
    f.git(f.main, 'update-ref', '-d', 'refs/remotes/origin/main');
    assert.equal(f.cli(f.worktree, 'archive-check').code, 2);
  });

  it('retires after a merge, keeping the worktree, its files and a recovery ref', () => {
    f.merge();
    const result = f.retire();
    assert.equal(result.deletedLocalBranch, 'codex/task');
    assert.equal(f.branch(), 'HEAD');
    assert.equal(f.git(f.worktree, 'rev-parse', String(result.recoveryRef)), f.head);
    assert.match(String(result.recoveryRef), /^refs\/acme\/lifecycle\/[0-9a-f]{32}$/);
    assert.ok(existsSync(join(f.worktree, 'feature')));
    assert.ok(!f.git(f.worktree, 'show-ref').includes('refs/heads/codex/task'));
    assert.equal(f.status().archiveReady, true);
    assert.equal(f.retire().alreadyRetired, true);
  });

  const snapshot = () => [
    f.git(f.worktree, 'rev-parse', 'HEAD'),
    f.git(f.worktree, 'show-ref'),
    readFileSync(join(f.gitdir, 'acme-lifecycle.json'), 'utf8'),
    f.git(f.worktree, 'status', '--porcelain'),
    readdirSync(f.worktree)
      .filter(name => statSync(join(f.worktree, name)).isFile())
      .map(name => `${name}:${readFileSync(join(f.worktree, name), 'utf8')}`),
  ];

  const assertRepeatBlocked = () => {
    const before = snapshot();
    assert.throws(() => f.retire(), /retirement requires a task branch/);
    assert.deepEqual(snapshot(), before);
  };

  it('refuses a repeat retirement after the detached HEAD moved, changing nothing', () => {
    f.merge();
    f.retire();
    f.write(join(f.worktree, 'later'), 'preserve later bytes');
    f.git(f.worktree, 'add', 'later');
    f.git(f.worktree, 'commit', '-qm', 'later');
    assertRepeatBlocked();
  });

  it('needs a complete, matching receipt for a repeat retirement', () => {
    f.merge();
    f.retire();
    const receipt = readReceipt(f.context());
    for (const state of ['missing', 'null', 'wrong-pr', 'wrong-phase']) {
      const changed = { ...receipt };
      if (state === 'missing') delete changed.retiredHead;
      else if (state === 'null') changed.retiredHead = null;
      else if (state === 'wrong-pr') changed.pr = 8;
      else changed.phase = 'continued';
      writeReceipt(f.context(), changed);
      assertRepeatBlocked();
    }
  });

  it('proves a squash merge by its exact receipt', () => {
    f.merge(true);
    assert.notEqual(f.head, f.merged);
    f.retire();
    assert.equal(f.status().archiveReady, true);
    f.commitLater();
    assert.equal(f.status().archiveReady, false);
  });

  it("fetches a merge queue's head from the PR ref when it is missing here", () => {
    f.merge();
    const remote = join(f.home, 'remote.git');
    f.git(f.main, 'clone', '--bare', f.main, remote);
    f.git(remote, 'config', 'user.name', 'Queue');
    f.git(remote, 'config', 'user.email', 'queue@example.invalid');
    f.git(remote, 'config', 'commit.gpgsign', 'false');
    const tree = f.git(remote, 'rev-parse', `${f.head}^{tree}`);
    const queueHead = f.git(remote, 'commit-tree', tree, '-p', f.head, '-m', 'queue');
    f.git(remote, 'update-ref', 'refs/pull/7/head', queueHead);
    f.git(f.main, 'remote', 'set-url', 'origin', remote);
    assert.notEqual(spawnSync('git', ['cat-file', '-e', queueHead], { cwd: f.worktree, env: f.env }).status, 0);
    if (f.pr === undefined) throw new Error('no pr');
    f.pr.head.sha = queueHead;
    const result = f.retire();
    assert.equal(result.phase, 'retired');
    assert.equal(f.git(f.worktree, 'rev-parse', 'HEAD'), f.head);
    assert.equal(ancestor(f.worktree, f.head, queueHead, f.env), true);
  });

  it('keeps dirty and untracked work through retirement', () => {
    f.merge();
    f.write(join(f.worktree, 'tracked'), 'dirty\n');
    f.write(join(f.worktree, 'untracked'), 'keep me\n');
    f.retire();
    assert.equal(readFileSync(join(f.worktree, 'tracked'), 'utf8'), 'dirty\n');
    assert.equal(readFileSync(join(f.worktree, 'untracked'), 'utf8'), 'keep me\n');
    assert.equal(f.status().archiveReady, false);
  });

  it('moves commits made after the merge to a successor before deleting the old branch', () => {
    f.merge(true);
    f.commitLater();
    const tip = f.git(f.worktree, 'rev-parse', 'HEAD');
    const result = f.retire();
    assert.match(String(result.successor), /^codex\/continue-[0-9a-f]{12}$/);
    assert.equal(f.git(f.worktree, 'rev-parse', 'HEAD'), tip);
    assert.equal(f.git(f.worktree, 'rev-parse', String(result.successor)), tip);
    assert.equal(f.status().archiveReady, false);
  });

  it('never retires on invalid merge evidence', () => {
    f.merge();
    for (const change of ['open', 'foreign', 'branch', 'base', 'sha', 'merge-sha']) {
      const saved = structuredClone(f.pr);
      if (f.pr === undefined) throw new Error('no pr');
      if (change === 'open') f.pr.merged = false;
      else if (change === 'foreign') f.pr.head.repo.full_name = 'someone/test';
      else if (change === 'branch') f.pr.head.ref = 'other';
      else if (change === 'base') f.pr.base.ref = 'prod';
      else if (change === 'sha') f.pr.head.sha = 'not-a-sha';
      else f.pr.merge_commit_sha = 'not-a-sha';
      assert.throws(() => f.retire(), Blocked);
      assert.equal(f.branch(), 'codex/task');
      f.pr = saved;
    }
  });

  it('refuses an origin that names no GitHub repository', () => {
    const host = f.host();
    const odd: Host = { ...host, run: (cwd, file, args) => (file === 'git' && args[0] === 'remote' ? 'file:///somewhere\n' : host.run(cwd, file, args)) };
    f.merge();
    assert.throws(() => retire(f.context(odd), 7), /not an identifiable GitHub repository/);
  });

  it('begins a clean worktree again from fresh main', () => {
    f.merge(true);
    f.retire();
    f.write(join(f.main, 'upstream'), 'new main');
    f.git(f.main, 'add', 'upstream');
    f.git(f.main, 'commit', '-qm', 'advance main');
    const expected = f.git(f.main, 'rev-parse', 'HEAD');
    const result = f.cli(f.worktree, 'begin', '--branch', 'codex/next');
    assert.equal(result.code, 0, result.stdout);
    assert.equal(f.git(f.worktree, 'rev-parse', 'HEAD'), expected);
    assert.equal(f.branch(), 'codex/next');
  });

  it('keeps the launch branch in the receipt across begin and retire', () => {
    // A desktop-app cloud start clones the branch the conversation started
    // on, even after begin switched away from it.
    assert.equal(f.cli(f.worktree, 'begin', '--branch', 'codex/next').code, 0);
    assert.equal(readReceipt(f.context()).launchBranch, 'codex/task');
    assert.equal(f.cli(f.worktree, 'begin', '--branch', 'codex/third').code, 0);
    assert.equal(readReceipt(f.context()).launchBranch, 'codex/task');
  });

  it('records the launch branch at retire when begin never ran', () => {
    f.merge();
    f.retire();
    assert.equal(readReceipt(f.context()).launchBranch, 'codex/task');
    assert.equal(f.cli(f.worktree, 'begin', '--branch', 'codex/next').code, 0);
    assert.equal(readReceipt(f.context()).launchBranch, 'codex/task');
  });

  it("does not take a previous conversation's receipt for the launch branch", () => {
    // A new conversation reusing a retired worktree starts on a branch the
    // app made; that branch is what its cloud start clones.
    f.merge();
    f.retire();
    f.git(f.worktree, 'switch', '-qc', 'codex/app-made');
    assert.equal(f.cli(f.worktree, 'begin', '--branch', 'codex/next').code, 0);
    assert.equal(readReceipt(f.context()).launchBranch, 'codex/app-made');
  });

  it('records a successor branch at retire', () => {
    f.merge();
    f.commitLater();
    const result = f.retire();
    const state = readReceipt(f.context());
    assert.equal(state.phase, 'continued');
    assert.equal(state.branch, result.successor);
    assert.equal(state.launchBranch, 'codex/task');
  });

  it('refuses to begin over an existing branch, dirty work or an unproven merge', () => {
    assert.equal(f.cli(f.worktree, 'begin', '--branch', 'codex/task').code, 2);
    assert.equal(f.cli(f.worktree, 'begin', '--branch', 'main').code, 2);
    f.commitWork();
    assert.equal(f.cli(f.worktree, 'begin', '--branch', 'codex/next').code, 2);
    f.write(join(f.worktree, 'tracked'), 'dirty');
    assert.equal(f.cli(f.worktree, 'begin', '--branch', 'codex/next').code, 2);
    assert.equal(readFileSync(join(f.worktree, 'tracked'), 'utf8'), 'dirty');
  });

  it('blocks during a git operation and beside another lifecycle operation', () => {
    f.merge();
    writeFileSync(join(f.gitdir, 'MERGE_HEAD'), f.head);
    assert.throws(() => f.retire(), Blocked);
    assert.equal(f.status().archiveReady, false);
    unlinkSync(join(f.gitdir, 'MERGE_HEAD'));
    exclusive(f.gitdir, 'acme', () => {
      const result = f.cli(f.worktree, 'begin', '--branch', 'codex/next');
      assert.equal(result.code, 2);
      assert.match(result.stdout, /another lifecycle/);
    });
  });

  it("takes over the lock a dead process left, and not a live one's", () => {
    const lock = join(f.gitdir, 'acme-lifecycle.mutex');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), '2147483646');
    assert.equal(exclusive(f.gitdir, 'acme', () => 'ran', () => false), 'ran');
    assert.equal(existsSync(lock), false);
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), String(process.pid));
    assert.throws(() => exclusive(f.gitdir, 'acme', () => 'ran'), /another lifecycle operation/);
    rmSync(lock, { recursive: true });
    mkdirSync(lock);
    assert.throws(() => exclusive(f.gitdir, 'acme', () => 'ran'), /another lifecycle operation/);
  });

  it('refuses archive against a stale or unreachable origin/main', () => {
    f.write(join(f.main, 'new-main'), 'upstream');
    f.git(f.main, 'add', 'new-main');
    f.git(f.main, 'commit', '-qm', 'advance main');
    const result = f.cli(f.worktree, 'archive-check');
    assert.equal(result.code, 2);
    assert.match(result.stdout, /stale/);
    f.git(f.worktree, 'fetch', 'origin', 'main');
    assert.equal(f.cli(f.worktree, 'archive-check').code, 0);
    f.git(f.worktree, 'remote', 'set-url', 'origin', join(f.home, 'absent'));
    assert.equal(f.cli(f.worktree, 'archive-check').code, 2);
    assert.ok(existsSync(f.worktree));
  });

  it('never overwrites ignored files with ones from new main', () => {
    f.write(join(f.worktree, '.env'), 'keep local bytes');
    f.write(join(f.main, '.env'), 'upstream bytes');
    f.git(f.main, 'add', '-f', '.env');
    f.git(f.main, 'commit', '-qm', 'track config');
    assert.equal(f.cli(f.worktree, 'begin', '--branch', 'codex/next').code, 2);
    assert.equal(readFileSync(join(f.worktree, '.env'), 'utf8'), 'keep local bytes');
    assert.equal(f.branch(), 'codex/task');
  });

  it('keeps a commit made while retiring, by compare-and-delete', () => {
    f.merge();
    const advanced: string[] = [];
    const host = f.host({
      after: args => {
        if (args[0] === 'update-ref' && String(args[1]).startsWith('refs/acme/lifecycle/')) {
          f.write(join(f.worktree, 'concurrent'), 'keep this commit');
          f.git(f.worktree, 'add', 'concurrent');
          f.git(f.worktree, 'commit', '-qm', 'concurrent edit');
          advanced.push(f.git(f.worktree, 'rev-parse', 'HEAD'));
        }
      },
    });
    assert.throws(() => retire(f.context(host), 7), Blocked);
    assert.equal(f.git(f.worktree, 'rev-parse', 'codex/task'), advanced[0]);
    assert.equal(f.git(f.worktree, 'show', 'codex/task:concurrent'), 'keep this commit');
    assert.notEqual(f.git(f.worktree, 'for-each-ref', 'refs/acme/lifecycle/'), '');
  });

  it('blocks on a corrupt receipt and on a merge commit missing here', () => {
    writeFileSync(join(f.gitdir, 'acme-lifecycle.json'), '[]');
    assert.equal(f.cli(f.worktree, 'archive-check').code, 2);
    unlinkSync(join(f.gitdir, 'acme-lifecycle.json'));
    f.merge();
    if (f.pr === undefined) throw new Error('no pr');
    f.pr.merge_commit_sha = 'a'.repeat(40);
    assert.throws(() => f.retire(), Blocked);
    assert.equal(f.branch(), 'codex/task');
  });

  it('refuses retire on main, detached without a receipt, and with no positive --pr', () => {
    assert.equal(f.cli(f.worktree, 'retire').code, 2);
    assert.match(f.cli(f.worktree, 'retire', '--pr', '0').stdout, /positive --pr/);
    assert.match(f.cli(f.worktree, 'begin').stdout, /begin requires --branch/);
    f.git(f.worktree, 'switch', '-q', '--detach');
    assert.throws(() => f.retire(), /requires a task branch/);
  });

  it('refuses a successor name without the provider prefix', () => {
    f.merge();
    f.commitLater();
    assert.throws(() => retire(f.context(), 7, 'claude/other'), /codex\/ prefix/);
  });

  it('parses its arguments strictly', () => {
    const io = { cwd: f.worktree, env: f.env, out: () => undefined };
    const errors: string[] = [];
    const err = (text: string) => errors.push(text);
    assert.equal(lifecycleMain([], { ...io, err }), 1);
    assert.equal(lifecycleMain(['begin', '--branch'], { ...io, err }), 1);
    assert.equal(lifecycleMain(['retire', '--pr', 'x'], { ...io, err }), 1);
    assert.equal(lifecycleMain(['status', '--color', 'on'], { ...io, err }), 1);
    assert.match(errors.join(''), /needs a value[\s\S]*needs a number[\s\S]*unknown option --color/);
  });

  it('blocks on unreadable settings', () => {
    writeFileSync(join(f.worktree, '.claude', 'sarathi.json'), '{');
    const result = f.cli(f.worktree, 'status');
    assert.equal(result.code, 2);
    assert.match(result.stdout, /is not JSON/);
  });
});

describe('the launch branch', () => {
  it('is unknown after an older receipt', () => {
    assert.equal(launchBranch({ phase: 'active', branch: 'codex/next' }, 'codex/next'), null);
    assert.equal(launchBranch({}, 'HEAD'), null);
    assert.equal(launchBranch({ launchBranch: null }, 'codex/next'), null);
    assert.equal(launchBranch({}, 'codex/task'), 'codex/task');
  });

  it('ignores a receipt written for another checkout', () => {
    const retired = { phase: 'retired', launchBranch: 'codex/old' };
    assert.equal(launchBranch(retired, 'HEAD'), 'codex/old');
    assert.equal(launchBranch(retired, 'codex/new'), 'codex/new');
    const active = { phase: 'active', branch: 'codex/next', launchBranch: 'codex/old' };
    assert.equal(launchBranch(active, 'codex/next'), 'codex/old');
    assert.equal(launchBranch(active, 'codex/new'), 'codex/new');
    assert.equal(launchBranch(active, 'HEAD'), null);
    const continued: Record<string, unknown> = { phase: 'continued', launchBranch: 'codex/old' };
    assert.equal(launchBranch(continued, 'codex/new'), 'codex/new');
    continued.branch = 'codex/new';
    assert.equal(launchBranch(continued, 'codex/new'), 'codex/old');
  });
});

describe('paths', () => {
  it('are within a folder only below it', () => {
    assert.equal(within('/a/b', '/a'), true);
    assert.equal(within('/a', '/a'), true);
    assert.equal(within('/ab', '/a'), false);
    assert.equal(within('/a/../c', '/a'), false);
    assert.equal(within('/a/..b', '/a'), true);
  });
});

// One case per hostile environment: runtime git configuration must not reach
// the fixture's repositories.
const HOSTILE: Record<string, (poison: string) => Record<string, string>> = {
  count_zero: () => ({ GIT_CONFIG_COUNT: '0' }),
  count_empty: () => ({ GIT_CONFIG_COUNT: '' }),
  count_injects_key: () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'fixture.poison', GIT_CONFIG_VALUE_0: 'injected' }),
  count_broken: () => ({ GIT_CONFIG_COUNT: 'broken' }),
  count_missing_value: () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'fixture.poison' }),
  config_file: poison => ({ GIT_CONFIG: poison }),
  global_and_system_files: poison => ({ GIT_CONFIG_GLOBAL: poison, GIT_CONFIG_SYSTEM: poison }),
};

describe('the fixture under a hostile environment', () => {
  for (const [name, environment] of Object.entries(HOSTILE)) {
    it(`is isolated before setup: ${name}`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'sarathi-poison-'));
      const poison = join(directory, 'gitconfig');
      writeFileSync(poison, '[fixture]\npoison = from-file\n[commit]\ngpgsign = true\n');
      const saved = { ...process.env };
      Object.assign(process.env, environment(poison));
      let fixture: Fixture | undefined;
      try {
        fixture = new Fixture();
        assert.ok(!fixture.git(fixture.worktree, 'config', '--list').includes('fixture.poison='));
        fixture.merge();
        assert.equal(retire(fixture.context(), 7).phase, 'retired');
      } finally {
        fixture?.remove();
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

describe('the archive hook', () => {
  beforeEach(() => {
    f = new Fixture();
  });
  afterEach(() => f.remove());

  const decide = (payload: Record<string, unknown>): string => {
    let out = '';
    assert.equal(hookMain(JSON.stringify(payload), text => (out += text), () => f.host()), 0);
    return out;
  };

  it('refuses to archive another task, and unreadable input', () => {
    const output = decide({ cwd: f.worktree, session_id: 'this-task', tool_name: 'mcp__codex_app__set_thread_archived', tool_input: { archived: true, threadId: 'another-task' } });
    assert.match(output, /owning task/);
    let out = '';
    hookMain('[]', text => (out += text));
    assert.match(out, /"deny"/);
    assert.match(out, /unable to verify the owning worktree/);
    assert.match(decide({ tool_name: 'ExitWorktree', tool_input: { action: 'remove' } }), /unable to verify/);
  });

  it('denies a dirty task, and lets unarchive, keep and a clean removal through', () => {
    f.write(join(f.worktree, 'new'), 'untracked');
    const payload: Record<string, unknown> = { cwd: f.worktree, session_id: 'task', tool_name: 'mcp__codex_app__set_thread_archived', tool_input: { archived: true } };
    const denied = JSON.parse(decide(payload)) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /^Archive blocked: staged, unstaged or untracked files remain Explain/);
    payload.tool_input = { archived: false };
    assert.equal(decide(payload), '');
    payload.tool_name = 'ExitWorktree';
    payload.tool_input = { action: 'keep' };
    assert.equal(decide(payload), '');
    payload.tool_input = { action: 'remove' };
    assert.match(decide(payload), /"deny"/);
    unlinkSync(join(f.worktree, 'new'));
    assert.equal(decide(payload), '');
    payload.tool_name = 'Bash';
    assert.equal(decide(payload), '');
  });

  it('denies with the reason a blocked check gives', () => {
    assert.match(decide({ cwd: f.main, tool_name: 'ExitWorktree', tool_input: {} }), /Archive blocked: primary checkout/);
  });

  it('runs from the command line through sarathi', async () => {
    f.write(join(f.worktree, 'new'), 'untracked');
    let out = '';
    const code = await main({
      argv: ['worktree', 'hook'],
      env: f.env,
      cwd: f.worktree,
      readStdin: async () => JSON.stringify({ cwd: f.worktree, tool_name: 'ExitWorktree', tool_input: { action: 'remove' } }),
      out: text => (out += text),
      err: () => undefined,
    });
    assert.equal(code, 0);
    assert.match(out, /"deny"/);
  });
});

describe('begin', () => {
  it('is reachable without the CLI', () => {
    const fixture = new Fixture();
    try {
      fixture.merge();
      retire(fixture.context(), 7);
      assert.equal(begin(fixture.context(), 'codex/again').phase, 'active');
      assert.equal(archiveCheck(fixture.context()).code, 0);
    } finally {
      fixture.remove();
    }
  });
});
