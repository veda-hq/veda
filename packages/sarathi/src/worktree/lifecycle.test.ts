// Real git repositories; only GitHub's answer is stood in.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  ancestor,
  archiveCheck,
  begin,
  BEGIN_RECOVERY,
  Blocked,
  cloudArchiveStep,
  cloudSessionWith,
  compileCache,
  context,
  exclusive,
  git,
  huskyShim,
  ignoredArtifacts,
  inspect,
  launchBranch,
  lifecycleMain,
  nodeHost,
  parseArgs,
  pullRequest,
  readReceipt,
  real,
  restRead,
  retire,
  runProgram,
  sameHead,
  tmpChildren,
  UNMERGED,
  validBranch,
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
      else {
        // Another head ref over a head that is not this one.
        f.pr.head.ref = 'other';
        f.pr.head.sha = f.git(f.worktree, 'rev-parse', 'HEAD~1');
      }
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
    assert.ok(f.status().ignoredArtifacts.includes('.tmp/plan.json'));
  });

  const CACHE = (): string => join(f.worktree, '.tmp', 'node-compile-cache');
  const CACHE_FOLDER = (): string => join(CACHE(), 'v24.21.0-arm64-964aae3f-501');

  it("lets the hooks' compile cache go, listing the rest of .tmp entry by entry", () => {
    f.write(join(CACHE_FOLDER(), '5b0b2ce0'), 'rebuilt by every hook');
    assert.equal(f.status().archiveReady, true);
    f.write(join(f.worktree, '.tmp', 'plan.json'), '{}');
    mkdirSync(join(f.worktree, '.tmp', 'rule-checks'));
    assert.deepEqual(f.status().ignoredArtifacts, ['.tmp/plan.json', '.tmp/rule-checks/']);
  });

  it("holds the compile cache when it holds anything but Node's files", () => {
    f.write(join(CACHE_FOLDER(), '5b0b2ce0'), 'cache');
    writeFileSync(join(f.home, 'kept'), 'shared');
    const cases: [() => void, () => void][] = [
      [() => writeFileSync(join(CACHE_FOLDER(), 'notes.md'), 'mine'), () => unlinkSync(join(CACHE_FOLDER(), 'notes.md'))],
      [() => symlinkSync(join(f.home, 'kept'), join(CACHE_FOLDER(), 'abcdef01')), () => unlinkSync(join(CACHE_FOLDER(), 'abcdef01'))],
      [() => mkdirSync(join(CACHE_FOLDER(), 'abcdef01')), () => rmSync(join(CACHE_FOLDER(), 'abcdef01'), { recursive: true })],
      [() => writeFileSync(join(CACHE(), 'mine.txt'), 'mine'), () => unlinkSync(join(CACHE(), 'mine.txt'))],
      [() => mkdirSync(join(CACHE(), 'plans')), () => rmSync(join(CACHE(), 'plans'), { recursive: true })],
      [() => symlinkSync(f.home, join(CACHE(), 'v1.2.3-x')), () => unlinkSync(join(CACHE(), 'v1.2.3-x'))],
    ];
    for (const [make, undo] of cases) {
      make();
      assert.deepEqual(f.status().ignoredArtifacts, ['.tmp/node-compile-cache/']);
      undo();
    }
    assert.equal(f.status().archiveReady, true);
  });

  it('holds a missing or symlinked cache and lists a symlinked .tmp whole', () => {
    assert.equal(compileCache(f.worktree, ['.tmp', 'node-compile-cache']), false);
    assert.deepEqual(tmpChildren(f.worktree, '.tmp/'), ['.tmp/']);
    mkdirSync(join(f.worktree, '.tmp'));
    mkdirSync(join(f.worktree, 'elsewhere'));
    symlinkSync(join(f.worktree, 'elsewhere'), CACHE());
    assert.equal(compileCache(f.worktree, ['.tmp', 'node-compile-cache']), false);
    assert.equal(compileCache(f.worktree, ['.tmp', 'other']), false);
    assert.equal(compileCache(f.worktree, ['.tmp']), false);
    rmSync(join(f.worktree, '.tmp'), { recursive: true });
    mkdirSync(join(f.worktree, 'inside'));
    symlinkSync(join(f.worktree, 'inside'), join(f.worktree, '.tmp'));
    assert.deepEqual(tmpChildren(f.worktree, '.tmp/'), ['.tmp/']);
    assert.deepEqual(tmpChildren(f.worktree, 'dist/'), ['dist/']);
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
    assert.equal(report.next, `First get Alok's explicit OK to discard: .tmp/plan.json. Then a${ARCHIVE.slice(1)}`);
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
      else if (change === 'branch') {
        // Another head ref with a dirty tree; a clean one retires (below).
        f.pr.head.ref = 'other';
        f.write(join(f.worktree, 'tracked'), 'dirty');
      } else if (change === 'base') f.pr.base.ref = 'prod';
      else if (change === 'sha') f.pr.head.sha = 'not-a-sha';
      else f.pr.merge_commit_sha = 'not-a-sha';
      assert.throws(() => f.retire(), Blocked);
      assert.equal(f.branch(), 'codex/task');
      f.git(f.worktree, 'checkout', '--', 'tracked');
      f.pr = saved;
    }
  });

  it('retires a PR under another head ref when its head is this clean HEAD', () => {
    f.merge();
    if (f.pr === undefined) throw new Error('no pr');
    f.pr.head.ref = 'claude/pushed-to-a-codex-pr';
    const result = f.retire();
    assert.equal(result.phase, 'retired');
    assert.equal(result.deletedLocalBranch, 'codex/task');
  });

  it('never retires another head ref over an untracked file or another sha', () => {
    f.merge();
    if (f.pr === undefined) throw new Error('no pr');
    f.pr.head.ref = 'other';
    f.write(join(f.worktree, 'draft'), 'unsaved');
    assert.throws(() => f.retire(), /head sha is this clean HEAD/);
    unlinkSync(join(f.worktree, 'draft'));
    f.pr.head.sha = f.git(f.worktree, 'rev-parse', 'HEAD~1');
    assert.throws(() => f.retire(), Blocked);
    assert.equal(f.branch(), 'codex/task');
  });

  it('reads submodules whatever their ignore setting for another head ref', () => {
    const calls: string[][] = [];
    const host: Host = {
      env: f.env,
      cloudSession: () => false,
      run: (_cwd, _file, args) => {
        calls.push([...args]);
        return args[0] === 'rev-parse' ? 'abc' : '';
      },
    };
    assert.equal(sameHead({ ...f.context(), host }, { ref: 'x', sha: 'abc' }, 'y'), true);
    assert.ok(calls.some(args => args.join(' ') === 'status --porcelain=v1 --untracked-files=all --ignore-submodules=none'));
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

  it('names the way out of commits made before begin', () => {
    f.commitWork();
    const result = f.cli(f.worktree, 'begin', '--branch', 'codex/next');
    assert.equal(result.code, 2);
    const blocked = String((JSON.parse(result.stdout) as { blocked: string }).blocked);
    assert.ok(blocked.includes(UNMERGED));
    assert.ok(blocked.includes(BEGIN_RECOVERY));
    assert.ok(blocked.includes('git cherry-pick origin/main..<save-branch>'));
    assert.ok(blocked.includes('first commit any uncommitted work (git reset --hard discards it)'));
  });

  it('names no recovery for other refusals of begin', () => {
    f.write(join(f.worktree, 'tracked'), 'dirty');
    const result = f.cli(f.worktree, 'begin', '--branch', 'codex/next');
    assert.equal(result.code, 2);
    assert.equal(result.stdout.includes('cherry-pick'), false);
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

/** A host that answers only the calls it lists, exactly, and refuses any other. */
function strictHost(answers: Record<string, string>, env: Record<string, string | undefined> = {}, cloud = false): Host & { readonly calls: string[]; readonly clouds: string[] } {
  const calls: string[] = [];
  const clouds: string[] = [];
  return {
    calls,
    clouds,
    env,
    cloudSession: root => {
      clouds.push(root);
      return cloud;
    },
    run: (cwd, file, args) => {
      const call = [file, ...args].join(' ');
      calls.push(call);
      const answer = answers[call];
      if (answer === undefined) throw new Error(`unexpected call: ${call}`);
      return answer;
    },
  };
}

/** A scratch folder for one test, removed when it ends. */
function scratchDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe('the lifecycle, part by part', () => {
  it('names its refusals Blocked', () => {
    assert.equal(new Blocked('x').name, 'Blocked');
  });

  it('runs a program with git’s optional locks off, its output kept off this process’s stderr', () => {
    const dir = scratchDir('sarathi-run-');
    const write = mock.method(process.stderr, 'write', () => true);
    try {
      assert.equal(runProgram(dir, 'sh', ['-c', 'printf "%s:%s" "$GIT_OPTIONAL_LOCKS" "$FOO"'], { PATH: process.env.PATH, FOO: 'bar' }), '0:bar');
      assert.throws(() => runProgram(dir, 'sh', ['-c', 'echo secret >&2; exit 3']), (error: unknown) => error instanceof Blocked && error.message === 'sh -c failed (exit 3); nothing may be discarded');
      assert.throws(() => runProgram(dir, 'false', []), (error: unknown) => error instanceof Blocked && error.message === 'false  failed (exit 1); nothing may be discarded');
      assert.throws(() => runProgram(dir, join(dir, 'missing'), ['x']), (error: unknown) => error instanceof Blocked && error.message === `${join(dir, 'missing')} x failed (exit none); nothing may be discarded`);
      assert.equal(write.mock.callCount(), 0);
    } finally {
      write.mock.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops only the trailing newlines of git’s output', () => {
    const host = strictHost({ 'git log': 'a\nb\n\n' });
    assert.equal(git({ host }, '/x', 'log'), 'a\nb');
  });

  it('answers ancestry exactly: true, false, or Blocked, quietly, in the repository and environment given', () => {
    const dir = scratchDir('sarathi-ancestor-');
    const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const run = (...args: string[]): string => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
    const write = mock.method(process.stderr, 'write', () => true);
    try {
      run('init', '-q');
      run('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'one');
      const one = run('rev-parse', 'HEAD');
      run('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'two');
      const two = run('rev-parse', 'HEAD');
      assert.equal(ancestor(dir, one, two, env), true);
      assert.equal(ancestor(dir, two, one, env), false);
      assert.throws(() => ancestor(dir, 'nope', two, env), (error: unknown) => error instanceof Blocked && error.message === 'merge evidence is unavailable locally');
      // The environment given is the one git sees: a GIT_DIR elsewhere is that repository's question.
      assert.throws(() => ancestor(dir, one, two, { ...env, GIT_DIR: join(dir, 'missing') }), /merge evidence is unavailable locally/);
      assert.equal(write.mock.callCount(), 0);
    } finally {
      write.mock.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the cloud check in the root, with the environment given, and keeps its output quiet', () => {
    const dir = scratchDir('sarathi-cloud-');
    const check = join(dir, 'check.sh');
    writeFileSync(check, 'echo noise >&2\ntest "$(pwd -P)" = "$1" && test "$MARK" = yes\n');
    const write = mock.method(process.stderr, 'write', () => true);
    try {
      const env = { PATH: process.env.PATH, CLAUDE_CODE_REMOTE: 'true', MARK: 'yes' };
      assert.equal(cloudSessionWith({ ...SETTINGS, cloudCheck: check }, env)(dir), true);
      assert.equal(cloudSessionWith({ ...SETTINGS, cloudCheck: check }, { ...env, MARK: 'no' })(dir), false);
      assert.equal(write.mock.callCount(), 0);
    } finally {
      write.mock.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a path as inside a folder only when it is the folder or below it', () => {
    assert.equal(within('/a/b', '/a/b'), true);
    assert.equal(within('/a/b/c', '/a/b'), true);
    assert.equal(within('/a', '/a/b'), false);
    assert.equal(within('/a/bc', '/a/b'), false);
    assert.equal(within('/x', '/a/b'), false);
  });

  it('resolves a path that does not exist as written', () => {
    assert.equal(real('/nonexistent-sarathi/x/../y'), '/nonexistent-sarathi/y');
  });

  it('finds the provider from the managed roots the environment names', () => {
    const answers = (root: string, primary: string): Record<string, string> => ({
      'git rev-parse --show-toplevel': root,
      'git rev-parse --absolute-git-dir': `${primary}/.git/worktrees/t`,
      'git rev-parse --path-format=absolute --git-common-dir': `${primary}/.git`,
      'git worktree list --porcelain -z': `worktree ${primary}\0HEAD 1\0branch refs/heads/main\0\0worktree ${root}\0HEAD 2\0\0`,
    });
    const provider = (root: string, env: Record<string, string | undefined>, primary = '/nonexistent-p'): string => context('/x', strictHost(answers(root, primary), env), SETTINGS).provider;
    // CODEX_HOME, then HOME's .codex; CODEX_MANAGED_WORKTREE_ROOT over both.
    assert.equal(provider('/nonexistent-c/worktrees/t/repo', { CODEX_HOME: '/nonexistent-c', HOME: '/nonexistent-h' }), 'codex');
    assert.equal(provider('/nonexistent-h/.codex/worktrees/t/repo', { HOME: '/nonexistent-h' }), 'codex');
    assert.equal(provider(resolve('.codex/worktrees/t/repo'), {}), 'codex');
    assert.equal(provider('/nonexistent-m/t/repo', { CODEX_MANAGED_WORKTREE_ROOT: '/nonexistent-m', CODEX_HOME: '/nonexistent-c' }), 'codex');
    assert.equal(provider('/nonexistent-p/.claude/worktrees/t', { CODEX_HOME: '/nonexistent-c' }), 'claude');
    assert.throws(() => provider('/nonexistent-c/other/t', { CODEX_HOME: '/nonexistent-c' }), (error: unknown) => error instanceof Blocked && error.message === 'worktree is outside the Codex/Claude managed roots');
    assert.throws(() => provider('/nonexistent-p/.claude/other/t', { CODEX_HOME: '/nonexistent-c' }), /outside the Codex\/Claude managed roots/);
    assert.throws(() => provider('/nonexistent-p/worktrees/t', { CODEX_HOME: '/nonexistent-c' }), /outside the Codex\/Claude managed roots/);
  });

  it('reads the primary checkout from the first worktree line, and blocks when git lists none', () => {
    const base = {
      'git rev-parse --show-toplevel': '/nonexistent-p/.claude/worktrees/t',
      'git rev-parse --absolute-git-dir': '/nonexistent-p/.git/worktrees/t',
      'git rev-parse --path-format=absolute --git-common-dir': '/nonexistent-p/.git',
    };
    const host = strictHost({ ...base, 'git worktree list --porcelain -z': 'HEAD 1\0worktree /nonexistent-p\0\0' }, { CODEX_HOME: '/nonexistent-c' });
    const found = context('/x', host, SETTINGS);
    assert.deepEqual({ ...found, host: undefined }, { root: '/nonexistent-p/.claude/worktrees/t', gitdir: '/nonexistent-p/.git/worktrees/t', provider: 'claude', settings: SETTINGS, host: undefined });
    const none = strictHost({ ...base, 'git worktree list --porcelain -z': '' }, { CODEX_HOME: '/nonexistent-c' });
    assert.throws(() => context('/x', none, SETTINGS), (error: unknown) => error instanceof Blocked && error.message === 'git lists no worktrees');
  });

  it('refuses a receipt that is not a version 1 object, and reads one that is', () => {
    const gitdir = scratchDir('sarathi-receipt-');
    const at = { gitdir, settings: SETTINGS };
    try {
      for (const text of ['5', '"x"', 'null', '[]', '{}', '{"version":2}', '{"version":"1"}', '{']) {
        writeFileSync(join(gitdir, 'acme-lifecycle.json'), text);
        assert.throws(() => readReceipt(at), (error: unknown) => error instanceof Blocked && error.message === 'lifecycle receipt is unreadable; retain the worktree', text);
      }
      writeFileSync(join(gitdir, 'acme-lifecycle.json'), '{"version":1,"phase":"active","note":"é"}');
      assert.deepEqual(readReceipt(at), { version: 1, phase: 'active', note: 'é' });
      rmSync(join(gitdir, 'acme-lifecycle.json'));
      mkdirSync(join(gitdir, 'acme-lifecycle.json'));
      assert.throws(() => readReceipt(at), /lifecycle receipt is unreadable/);
    } finally {
      rmSync(gitdir, { recursive: true, force: true });
    }
  });

  it('writes the receipt through a temporary file it then renames, leaving only the receipt', () => {
    const gitdir = scratchDir('sarathi-receipt-');
    try {
      writeReceipt({ gitdir, settings: SETTINGS }, { phase: 'active' });
      assert.deepEqual(readdirSync(gitdir), ['acme-lifecycle.json']);
      assert.equal(readFileSync(join(gitdir, 'acme-lifecycle.json'), 'utf8'), '{\n  "phase": "active",\n  "version": 1\n}\n');
    } finally {
      rmSync(gitdir, { recursive: true, force: true });
    }
  });

  it('knows the launch branch only from a current receipt, or a branch with none', () => {
    assert.equal(launchBranch({}, 'codex/a'), 'codex/a');
    assert.equal(launchBranch({}, 'HEAD'), null);
    assert.equal(launchBranch({ phase: 'active', branch: 'codex/a', launchBranch: 'claude/x' }, 'codex/a'), 'claude/x');
    assert.equal(launchBranch({ phase: 'active', branch: 'codex/a', launchBranch: 'claude/x' }, 'codex/b'), 'codex/b');
    assert.equal(launchBranch({ phase: 'active', branch: 'codex/a' }, 'codex/a'), null);
  });

  it("knows every one of husky's own files, and nothing that only resembles them", () => {
    const root = scratchDir('sarathi-husky-');
    const shims = join(root, '.husky', '_');
    const names = ['.gitignore', 'h', 'husky.sh', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-rebase', 'post-rewrite', 'post-checkout', 'post-merge', 'pre-push', 'pre-auto-gc'];
    try {
      assert.equal(huskyShim(root, ['.husky', '_', 'h']), false);
      assert.equal(huskyShim(root, ['.husky', '_']), false);
      mkdirSync(shims, { recursive: true });
      for (const name of names) writeFileSync(join(shims, name), '');
      for (const name of names) assert.equal(huskyShim(root, ['.husky', '_', name]), true, name);
      assert.equal(huskyShim(root, ['.husky', '_']), true);
      assert.equal(huskyShim(root, ['.husky', '_', 'h', 'x']), false);
      assert.equal(huskyShim(root, ['.husky', '_', 'notes']), false);
      assert.equal(huskyShim(root, ['other', '_', 'h']), false);
      assert.equal(huskyShim(root, ['.husky', 'x', 'h']), false);
      // A shim that is a dangling link is no file.
      rmSync(join(shims, 'h'));
      symlinkSync(join(root, 'gone'), join(shims, 'h'));
      assert.equal(huskyShim(root, ['.husky', '_', 'h']), false);
      assert.equal(huskyShim(root, ['.husky', '_']), false);
      // The shim folder must be a real folder.
      rmSync(join(root, '.husky'), { recursive: true });
      mkdirSync(join(root, 'real', '_'), { recursive: true });
      writeFileSync(join(root, 'real', '_', 'h'), '');
      mkdirSync(join(root, '.husky'));
      symlinkSync(join(root, 'real', '_'), shims);
      assert.equal(huskyShim(root, ['.husky', '_', 'h']), false);
      rmSync(shims);
      writeFileSync(shims, '');
      assert.equal(huskyShim(root, ['.husky', '_']), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("knows Node's compile-cache layout exactly", () => {
    const root = scratchDir('sarathi-cache-');
    const cache = join(root, '.tmp', 'node-compile-cache');
    const judge = (folder: string, file: string): boolean => {
      rmSync(join(root, '.tmp'), { recursive: true, force: true });
      mkdirSync(join(cache, folder), { recursive: true });
      writeFileSync(join(cache, folder, file), '');
      return compileCache(root, ['.tmp', 'node-compile-cache']);
    };
    try {
      assert.equal(judge('v24.12.15-arm64', '0123abcd'), true);
      assert.equal(judge('xv24.1.0-arm64', '0123abcd'), false);
      assert.equal(judge('v24.1.0-a b', '0123abcd'), false);
      assert.equal(judge('v24.1.0-arm64', 'x0123abcd'), false);
      assert.equal(judge('v24.1.0-arm64', '0123abcdx'), false);
      judge('v24.1.0-arm64', '0123abcd');
      assert.equal(compileCache(root, ['.tmp', 'node-compile-cache', 'x']), false);
      assert.equal(compileCache(root, ['x', 'node-compile-cache']), false);
      assert.equal(compileCache(root, ['.tmp', 'other']), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists .tmp child by child in order, and any other item as it is', () => {
    const root = scratchDir('sarathi-tmp-');
    try {
      mkdirSync(join(root, '.tmp'));
      for (const name of ['a', 'B', 'c']) mkdirSync(join(root, '.tmp', name));
      for (const name of ['a-b', 'z', 'C-d']) writeFileSync(join(root, '.tmp', name), '');
      const sorted = ['.tmp/B/', '.tmp/C-d', '.tmp/a-b', '.tmp/a/', '.tmp/c/', '.tmp/z'];
      assert.deepEqual(tmpChildren(root, '.tmp/'), sorted);
      assert.deepEqual(tmpChildren(root, '.tmp//'), sorted);
      assert.deepEqual(tmpChildren(root, '.tmp'), sorted);
      assert.deepEqual(tmpChildren(root, 'other/'), ['other/']);
      assert.deepEqual(tmpChildren(root, '.t/mp'), ['.t/mp']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps every ignored item but caches, shims and links out of the worktree', () => {
    const root = scratchDir('sarathi-ignored-');
    const outside = scratchDir('sarathi-outside-');
    try {
      mkdirSync(join(root, 'sub'));
      symlinkSync(outside, join(root, 'link'));
      symlinkSync(outside, join(root, 'sub', 'link'));
      symlinkSync(join(root, 'sub'), join(root, 'inner'));
      writeFileSync(join(outside, 'file'), '');
      symlinkSync(join(root, 'gone'), join(root, 'dangling'));
      mkdirSync(join(root, '.tmp', 'node-compile-cache', 'v24.1.0-arm64'), { recursive: true });
      writeFileSync(join(root, '.tmp', 'node-compile-cache', 'v24.1.0-arm64', '0123abcd'), '');
      const items = ['node_modules/', '.turbo/', '.cache/', '__pycache__/', 'pkg/node_modules/', 'link/', 'link//', 'sub/link', 'inner', 'dangling', 'ghost', 'keep', 'link/file', '.tmp/node-compile-cache//'];
      const host = strictHost({ 'git ls-files --others --ignored --exclude-standard --directory -z': `${items.join('\0')}\0` });
      const found: Context = { root, gitdir: join(root, '.git'), provider: 'claude', settings: SETTINGS, host };
      assert.deepEqual(ignoredArtifacts(found), ['inner', 'dangling', 'ghost', 'keep', 'link/file']);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('says what the recovery and the archive need, word for word', () => {
    assert.equal(
      BEGIN_RECOVERY,
      "if this branch's PR merged, run retire --pr <N> first, then begin; to keep commits made before begin, first commit any uncommitted work (git reset --hard discards it), then: git branch <save-branch> HEAD, git reset --hard origin/main, begin again, then git cherry-pick origin/main..<save-branch> and re-point any citation to the new shas",
    );
    assert.equal(UNMERGED, 'HEAD contains work not proven merged into origin/main');
    const ignored = 'ignored artifacts need preservation or explicit discard';
    assert.equal(cloudArchiveStep('Ana', [], []), 'Archive this session in the app; its container takes this worktree.');
    assert.equal(cloudArchiveStep('Ana', [ignored], ['a', 'b']), "First get Ana's explicit OK to discard: a, b. Then archive this session in the app; its container takes this worktree.");
    assert.equal(cloudArchiveStep('Ana', [ignored, UNMERGED], ['a']), undefined);
    assert.equal(cloudArchiveStep('Ana', [UNMERGED], []), undefined);
  });
});

/** Runs `body` with a fixture of its own, removed after. */
function withFixture(body: (fx: Fixture) => void): void {
  const fx = new Fixture();
  try {
    body(fx);
  } finally {
    fx.remove();
  }
}

/** The fixture's host with origin's URL replaced. */
function remoteAt(fx: Fixture, url: string): Host {
  const host = fx.host();
  return { ...host, run: (cwd, file, args) => (file === 'git' && args.join(' ') === 'remote get-url origin' ? `${url}\n` : host.run(cwd, file, args)) };
}

const isBlocked = (message: string) => (error: unknown): boolean => error instanceof Blocked && error.message === message;
const NOT_PROVEN = 'PR is not a merged same-repository PR for this branch into main (a PR under another head ref counts only when its head sha is this clean HEAD)';

describe('the lifecycle against real git, case by case', () => {
  it('reports every field of a worktree in the middle of a git operation', () => {
    withFixture(fx => {
      const head = fx.git(fx.worktree, 'rev-parse', 'HEAD');
      writeFileSync(join(fx.gitdir, 'MERGE_HEAD'), `${head}\n`);
      writeFileSync(join(fx.gitdir, 'REVERT_HEAD'), `${head}\n`);
      assert.deepEqual(inspect(fx.context()), {
        worktree: fx.worktree,
        provider: 'codex',
        branch: 'codex/task',
        head,
        changes: '',
        ignoredArtifacts: [],
        blockers: ['Git operation in progress: MERGE_HEAD, REVERT_HEAD'],
        archiveReady: false,
        appLimitations: ['direct UI archive cannot be vetoed by repository hooks', 'Codex self-handoff and fresh worktree rebinding require host support'],
      });
    });
  });

  it('blocks archive on a protected branch', () => {
    withFixture(fx => {
      fx.git(fx.worktree, 'switch', '-qc', 'staging');
      assert.deepEqual(inspect(fx.context()).blockers, ['protected branch checked out']);
    });
  });

  it('asks the cloud check only when there is a step to name', () => {
    withFixture(fx => {
      const asked: string[] = [];
      const host: Host = { ...fx.host(), cloudSession: root => (asked.push(root), true) };
      fx.commitWork();
      assert.equal(inspect(fx.context(host)).next, undefined);
      assert.deepEqual(asked, []);
    });
  });

  it('takes squash-merge proof only from a receipt whose merge commit is a sha', () => {
    withFixture(fx => {
      fx.merge(true);
      fx.retire();
      const receipt = readReceipt(fx.context());
      assert.equal(inspect(fx.context()).archiveReady, true);
      writeReceipt(fx.context(), { ...receipt, mergeCommit: [receipt.mergeCommit] });
      assert.deepEqual(inspect(fx.context()).blockers, [UNMERGED]);
      writeReceipt(fx.context(), { ...receipt, mergeCommit: 'not-a-sha' });
      assert.deepEqual(inspect(fx.context()).blockers, [UNMERGED]);
    });
  });

  it('begins over ignored files, and records the phase, branch, base and launch branch', () => {
    withFixture(fx => {
      fx.write(join(fx.worktree, '.env'), 'local\n');
      assert.deepEqual(begin(fx.context(), 'codex/next'), { branch: 'codex/next', worktree: fx.worktree, phase: 'active' });
      assert.deepEqual(readReceipt(fx.context()), { phase: 'active', branch: 'codex/next', base: fx.git(fx.main, 'rev-parse', 'main'), launchBranch: 'codex/task', version: 1 });
    });
  });

  it('names every blocker of begin, then the recovery, in one message', () => {
    withFixture(fx => {
      fx.commitWork();
      fx.write(join(fx.worktree, 'new'), 'untracked\n');
      assert.throws(() => begin(fx.context(), 'codex/next'), isBlocked(`staged, unstaged or untracked files remain; ${UNMERGED}; ${BEGIN_RECOVERY}`));
    });
  });

  it('checks a new branch name before anything else, in this repository and environment', () => {
    withFixture(fx => {
      assert.throws(() => begin(fx.context(), 'claude/next'), isBlocked('new branch must use the codex/ prefix'));
      assert.equal(fx.branch(), 'codex/task');
      fx.git(fx.main, 'branch', 'codex/taken');
      assert.throws(() => begin(fx.context(), 'codex/taken'), isBlocked('successor branch already exists or cannot be checked'));
      // The host's environment decides which repository is asked.
      const other = join(fx.home, 'other');
      fx.git(fx.home, 'init', '-q', other);
      fx.git(other, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x');
      fx.git(other, 'branch', 'codex/elsewhere');
      const host = { ...fx.host(), env: { ...fx.env, GIT_DIR: join(other, '.git') } };
      assert.throws(() => begin(fx.context(host), 'codex/elsewhere'), isBlocked('successor branch already exists or cannot be checked'));
    });
  });

  it('reads only an origin that is wholly a GitHub repository', () => {
    withFixture(fx => {
      for (const url of ['xhttps://github.com/acme/test', 'https://github.com/acme/test/extra']) {
        assert.throws(() => retire(fx.context(remoteAt(fx, url)), 7), isBlocked('origin is not an identifiable GitHub repository'), url);
      }
    });
  });

  it('reads an origin with no .git suffix as the same repository', () => {
    withFixture(fx => {
      fx.merge();
      assert.equal(retire(fx.context(remoteAt(fx, 'https://github.com/acme/test')), 7).phase, 'retired');
    });
  });

  it('takes a branch as existing only by its exact ref', () => {
    withFixture(fx => {
      fx.git(fx.main, 'update-ref', 'refs/keep/refs/heads/codex/fresh', 'HEAD');
      validBranch(fx.context(), 'codex/fresh');
    });
  });

  it('keeps git’s complaint off this process’s stderr when it cannot check a branch', () => {
    const dir = scratchDir('sarathi-branch-');
    const host = strictHost({ 'git check-ref-format --branch codex/fresh': 'codex/fresh\n' }, { PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: dirname(dir) });
    const write = mock.method(process.stderr, 'write', () => true);
    try {
      const found: Context = { root: dir, gitdir: dir, provider: 'codex', settings: SETTINGS, host };
      assert.throws(() => validBranch(found, 'codex/fresh'), isBlocked('successor branch already exists or cannot be checked'));
      assert.equal(write.mock.callCount(), 0);
    } finally {
      write.mock.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('needs the PR to merge into main of this repository, with shas for its head and merge', () => {
    withFixture(fx => {
      fx.merge();
      const saved = structuredClone(fx.pr);
      const cases: Array<(pr: Pr) => void> = [
        pr => (pr.base.ref = 'dev'),
        pr => (pr.base.repo.full_name = 'someone/test'),
        pr => (pr.head.sha = [pr.head.sha] as unknown as string),
        pr => (pr.merge_commit_sha = [pr.merge_commit_sha] as unknown as string),
        pr => (pr.head.sha = `${pr.head.sha}x`),
        pr => (pr.head.sha = `x${pr.head.sha}`),
        pr => (pr.merge_commit_sha = `${pr.merge_commit_sha}x`),
        pr => (pr.merge_commit_sha = `x${pr.merge_commit_sha}`),
      ];
      for (const change of cases) {
        fx.pr = structuredClone(saved);
        if (fx.pr === undefined) throw new Error('no pr');
        change(fx.pr);
        assert.throws(() => fx.retire(), isBlocked(NOT_PROVEN), change.toString());
        assert.equal(fx.branch(), 'codex/task');
      }
    });
  });

  it('needs the merge commit in fetched main', () => {
    withFixture(fx => {
      fx.merge();
      fx.commitLater();
      if (fx.pr === undefined) throw new Error('no pr');
      fx.pr.merge_commit_sha = fx.git(fx.worktree, 'rev-parse', 'HEAD');
      assert.throws(() => fx.retire(), isBlocked('merged PR is not contained in fetched main'));
    });
  });

  it('answers a repeat retirement only on a detached HEAD', () => {
    withFixture(fx => {
      fx.merge();
      const head = fx.git(fx.worktree, 'rev-parse', 'HEAD');
      writeReceipt(fx.context(), { phase: 'retired', pr: 7, retiredHead: head });
      // On the task branch the receipt is another checkout's: the retirement runs.
      const first = fx.retire();
      assert.equal(first.phase, 'retired');
      assert.equal(first.alreadyRetired, undefined);
      assert.equal(fx.branch(), 'HEAD');
      assert.deepEqual(fx.retire(), { phase: 'retired', alreadyRetired: true, worktree: fx.worktree });
    });
  });

  it('refuses each protected branch and a git operation before asking anyone', () => {
    const gitdir = scratchDir('sarathi-retire-');
    try {
      for (const name of ['main', 'master', 'prod', 'staging']) {
        const host = strictHost({ 'git rev-parse --abbrev-ref HEAD': name });
        const found: Context = { root: gitdir, gitdir, provider: 'codex', settings: SETTINGS, host };
        assert.throws(() => retire(found, 7), isBlocked('retirement requires a task branch'), name);
      }
      writeFileSync(join(gitdir, 'MERGE_HEAD'), 'x');
      const host = strictHost({ 'git rev-parse --abbrev-ref HEAD': 'codex/task' });
      const found: Context = { root: gitdir, gitdir, provider: 'codex', settings: SETTINGS, host };
      assert.throws(() => retire(found, 7), isBlocked('finish the active Git operation before retiring the branch'));
      assert.deepEqual(host.calls, ['git rev-parse --abbrev-ref HEAD']);
    } finally {
      rmSync(gitdir, { recursive: true, force: true });
    }
  });

  it('retires a contained head detached, whatever successor was named, and says what it did', () => {
    withFixture(fx => {
      fx.merge();
      const result = retire(fx.context(), 7, 'claude/unused');
      assert.match(String(result.recoveryRef), /^refs\/acme\/lifecycle\/[0-9a-f]{32}$/);
      assert.deepEqual(result, {
        phase: 'retired',
        deletedLocalBranch: 'codex/task',
        worktree: fx.worktree,
        recoveryRef: result.recoveryRef,
        successor: null,
        next: 'retain worktree until explicit archive',
        remote: 'use GitHub automatic head-branch deletion; no remote mutation performed',
      });
      assert.equal(fx.branch(), 'HEAD');
    });
  });

  it('moves later work to a successor, and says so', () => {
    withFixture(fx => {
      fx.merge();
      fx.commitLater();
      const result = retire(fx.context(), 7, 'codex/after');
      assert.deepEqual(result, {
        phase: 'continued',
        deletedLocalBranch: 'codex/task',
        worktree: fx.worktree,
        recoveryRef: result.recoveryRef,
        successor: 'codex/after',
        next: 'preserved post-merge work; reconcile successor with latest main before further edits',
        remote: 'use GitHub automatic head-branch deletion; no remote mutation performed',
      });
      assert.equal(fx.branch(), 'codex/after');
    });
  });

  it('refuses a worktree that changed while it was being inspected', () => {
    const changes: Array<(fx: Fixture) => void> = [
      fx => writeFileSync(join(fx.gitdir, 'MERGE_HEAD'), 'x'),
      fx => fx.commitLater(),
      fx => fx.git(fx.worktree, 'switch', '-qc', 'codex/moved'),
    ];
    for (const change of changes) {
      withFixture(fx => {
        fx.merge();
        let done = false;
        const host = fx.host({
          after: args => {
            if (!done && args.join(' ') === 'rev-parse HEAD') {
              done = true;
              change(fx);
            }
          },
        });
        assert.throws(() => retire(fx.context(host), 7), isBlocked('worktree changed during inspection; retry when idle'), change.toString());
      });
    }
  });

  it('keeps the old branch when another worktree took it during the switch', () => {
    withFixture(fx => {
      fx.merge();
      const host = fx.host({
        after: args => {
          if (args[0] === 'switch') fx.git(fx.main, 'worktree', 'add', '-q', join(fx.home, 'taker'), 'codex/task');
        },
      });
      assert.throws(() => retire(fx.context(host), 7), isBlocked('another worktree owns the old branch; keep its ref'));
      assert.equal(fx.git(fx.main, 'rev-parse', 'codex/task'), fx.head);
    });
  });
});

describe('exclusive, case by case', () => {
  it('takes over the lock of a process that is gone, and holds one whose holder it cannot signal', () => {
    const gitdir = scratchDir('sarathi-lock-');
    const lock = join(gitdir, 'acme-lifecycle.mutex');
    try {
      const gone = spawnSync('true').pid;
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), String(gone));
      assert.equal(exclusive(gitdir, 'acme', () => 'ran'), 'ran');
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), '1');
      assert.throws(() => exclusive(gitdir, 'acme', () => 'ran'), isBlocked('another lifecycle operation is running'));
    } finally {
      rmSync(gitdir, { recursive: true, force: true });
    }
  });

  it('holds a lock whose pid is not a positive whole number', () => {
    const gitdir = scratchDir('sarathi-lock-');
    const lock = join(gitdir, 'acme-lifecycle.mutex');
    try {
      for (const pid of ['1.5', '0', '-3', 'abc', '']) {
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        writeFileSync(join(lock, 'pid'), pid);
        assert.throws(() => exclusive(gitdir, 'acme', () => 'ran', () => false), isBlocked('another lifecycle operation is running'), pid);
      }
    } finally {
      rmSync(gitdir, { recursive: true, force: true });
    }
  });

  it('writes its own pid into the lock, and survives a lock that vanished', () => {
    const gitdir = scratchDir('sarathi-lock-');
    const lock = join(gitdir, 'acme-lifecycle.mutex');
    try {
      assert.equal(exclusive(gitdir, 'acme', () => readFileSync(join(lock, 'pid'), 'utf8')), String(process.pid));
      assert.equal(existsSync(lock), false);
      // The body, or the dead holder's cleanup, may remove the lock first.
      assert.equal(exclusive(gitdir, 'acme', () => (rmSync(lock, { recursive: true }), 'ran')), 'ran');
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), '2147483646');
      const vanishing = (): boolean => (rmSync(lock, { recursive: true }), false);
      assert.equal(exclusive(gitdir, 'acme', () => 'ran', vanishing), 'ran');
      assert.equal(existsSync(lock), false);
    } finally {
      rmSync(gitdir, { recursive: true, force: true });
    }
  });

  it('passes on a failure to make the lock that is not another holder', () => {
    const dir = scratchDir('sarathi-lock-');
    try {
      assert.throws(
        () => exclusive(join(dir, 'missing'), 'acme', () => 'ran'),
        (error: unknown) => !(error instanceof Blocked) && (error as NodeJS.ErrnoException).code === 'ENOENT',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the lifecycle command line, case by case', () => {
  const USAGE_TEXT = 'usage: sarathi worktree status|archive-check|begin --branch <name>|retire --pr <n> [--branch <successor>]|hook\n';

  it('reads each action and its flags exactly, and names the usage word for word', () => {
    assert.deepEqual(parseArgs(['status']), { action: 'status' });
    assert.deepEqual(parseArgs(['retire', '--pr', '12']), { action: 'retire', pr: 12 });
    assert.deepEqual(parseArgs(['retire', '--pr', '-3']), { action: 'retire', pr: -3 });
    assert.deepEqual(parseArgs(['begin', '--branch', 'codex/x']), { action: 'begin', branch: 'codex/x' });
    assert.deepEqual(parseArgs(['retire', '--pr', '7', '--branch', 'codex/next']), { action: 'retire', pr: 7, branch: 'codex/next' });
    for (const value of ['12x', 'x12', '1.5', '']) assert.equal(parseArgs(['retire', '--pr', value]), `--pr needs a number\n${USAGE_TEXT}`, value);
    assert.equal(parseArgs(['other']), USAGE_TEXT);
    assert.equal(parseArgs(['status', '--odd', 'x']), `unknown option --odd\n${USAGE_TEXT}`);
    assert.equal(parseArgs(['status', '--pr']), `--pr needs a value\n${USAGE_TEXT}`);
  });

  it('refuses an empty --branch for begin, and any --pr below 1 for retire', () => {
    withFixture(fx => {
      const blocked = (...args: string[]): string => String((JSON.parse(fx.cli(fx.worktree, ...args).stdout) as { blocked?: string }).blocked);
      assert.equal(blocked('begin', '--branch', ''), 'begin requires --branch');
      assert.equal(blocked('retire'), 'retire requires a positive --pr');
      for (const pr of ['0', '-3']) assert.equal(blocked('retire', '--pr', pr), 'retire requires a positive --pr', pr);
      assert.notEqual(blocked('retire', '--pr', '1'), 'retire requires a positive --pr');
    });
  });

  it('runs retire through the host it is given', () => {
    withFixture(fx => {
      fx.merge();
      const result = fx.cli(fx.worktree, 'retire', '--pr', '7');
      assert.equal(result.code, 0, result.stdout);
      assert.equal((JSON.parse(result.stdout) as { phase: string }).phase, 'retired');
    });
  });

  it('builds the real host when none is given', () => {
    withFixture(fx => {
      let stdout = '';
      const code = lifecycleMain(['status'], { cwd: fx.worktree, env: fx.env, out: text => (stdout += text), err: text => (stdout += text) });
      assert.equal(code, 0, stdout);
      assert.equal((JSON.parse(stdout) as { provider: string }).provider, 'codex');
    });
  });

  it('answers a refusal as JSON, and lets any other failure through', () => {
    withFixture(fx => {
      const run = (failure: unknown): { code: number; stdout: string } => {
        let stdout = '';
        const code = lifecycleMain(['status'], {
          cwd: fx.worktree,
          env: fx.env,
          out: text => (stdout += text),
          err: text => (stdout += text),
          host: () => {
            throw failure;
          },
        });
        return { code, stdout };
      };
      assert.deepEqual(run(new Blocked('held')), { code: 2, stdout: '{\n  "blocked": "held"\n}\n' });
      assert.deepEqual(run(Object.assign(new Error('gone'), { code: 'ENOENT' })), { code: 2, stdout: '{\n  "blocked": "gone"\n}\n' });
      assert.throws(() => run(new Error('boom')), /^Error: boom$/);
    });
  });
});
