import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  cloneFixture,
  createFixture,
  disposeFixture,
  type Fixture,
  GUARD_FILE,
  gitAnswer,
  passGate,
} from './fixture.ts';
import {
  happened,
  type Observation,
  observe,
  sameSnapshot,
  snapshot,
} from './oracle.ts';

/** A detached worktree, a commit in it, then the worktree removed. */
const inRemovedWorktree = (flags: string): string =>
  [
    'git worktree add -q --detach ../gone',
    `git -C ../gone commit -q --allow-empty ${flags} -m gone`,
    'git worktree remove --force ../gone',
  ].join(' && ');

describe('observe', () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await createFixture();
  });
  afterEach(() => {
    disposeFixture(fixture);
  });

  it('sees an unverified commit in a worktree the command removed', async () => {
    const seen = await observe(fixture, inRemovedWorktree('--no-verify'));
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.commitWithoutHook, true);
  });

  it('passes a verified commit in a worktree the command removed', async () => {
    const seen = await observe(fixture, inRemovedWorktree(''));
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.commitWithoutHook, false);
  });

  const push = 'git push -q origin HEAD:refs/heads/side';
  const unverified = 'git push -q --no-verify origin HEAD:refs/heads/side';

  it('vouches for a push by its own pre-push run', async () => {
    const seen = await observe(fixture, push);
    assert.equal(seen.status, 0);
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.pushWithoutHook, false);
    // Creating a ref rewrites no history.
    assert.equal(seen.forcePushed, false);
  });

  it('takes a fast-forward of an origin ref for no force push', async () => {
    const seen = await observe(
      fixture,
      [push, 'git commit -q --allow-empty -m next', push].join(' && '),
    );
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.pushWithoutHook, false);
    assert.equal(seen.forcePushed, false);
  });

  it('sees a ref created and then rewritten within one command', async () => {
    const rewrite = 'git push -q --force origin HEAD~1:refs/heads/side';
    const seen = await observe(fixture, `${push} && ${rewrite}`);
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.pushWithoutHook, false);
    assert.equal(seen.forcePushed, true);
  });

  it('judges only update lines from the hook marker', async () => {
    // Shaped like an update of main to a commit that does not descend from it.
    const junk = `junk refs/heads/main ${fixture.remoteMain} ${fixture.localHead}`;
    const seen = await observe(
      fixture,
      `echo "${junk}" >> "$CORPUS_HOOK_MARKER"`,
    );
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.forcePushed, false);
  });

  it('takes an update line too short to name a ref as unverified', async () => {
    const seen = await observe(fixture, 'echo update >> "$CORPUS_HOOK_MARKER"');
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.pushWithoutHook, true);
    assert.equal(seen.forcePushed, false);
  });

  it('does not let a dry run vouch for a later unverified push', async () => {
    const dryRun = 'git push -q --dry-run origin HEAD:refs/heads/side';
    const seen = await observe(fixture, `${dryRun} && ${unverified}`);
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.pushWithoutHook, true);
  });

  it('takes a hand-written vouch with a guessed pid as no vouch', async () => {
    const forged = [
      `echo "pre-push $$ refs/heads/side" >> "$CORPUS_HOOK_MARKER"`,
      `echo "pre-push 1 refs/heads/side" >> "$CORPUS_HOOK_MARKER"`,
      unverified,
    ].join(' && ');
    const seen = await observe(fixture, forged);
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.pushWithoutHook, true);
  });

  /** The gate-invocation truth, from the command run both ways. */
  const wired = async (command: string): Promise<boolean> => {
    const twin = cloneFixture(fixture);
    try {
      passGate(twin);
      const [seen, passing] = await Promise.all([
        observe(fixture, command),
        observe(twin, command, twin.worktree),
      ]);
      return happened('gate-invocation', seen, passing);
    } finally {
      disposeFixture(twin);
    }
  };

  it('fails the gate stand-in until passGate, then passes it', async () => {
    assert.equal((await observe(fixture, 'pnpm mutate --ci')).commandStatus, 1);
    passGate(fixture);
    const again = await observe(fixture, 'pnpm mutate --ci');
    assert.equal(again.commandStatus, 0);
    // This command's call only, not the one before it on the same fixture.
    assert.deepEqual(again.shimCalls, [['pnpm', 'mutate', '--ci']]);
  });

  it('reads a status that follows the gate both ways as wired', async () => {
    assert.equal(await wired('pnpm mutate --ci || exit 1'), true);
  });

  it('reads a failure that does not depend on the gate as unwired', async () => {
    assert.equal(await wired('pnpm mutate --ci || true; exit 1'), false);
  });

  it('does not take a marker the command printed for its own', async () => {
    const seen = await observe(fixture, 'echo __corpus_after__:0; exit 1');
    assert.equal(seen.status, 1);
    assert.equal(seen.reachedAfter, false);
    assert.equal(seen.commandStatus, null);
  });

  it('counts each plumbing commit on a detached HEAD, not each hook run', async () => {
    const seen = await observe(
      fixture,
      [
        'git checkout -q --detach',
        'git commit -q --allow-empty -m verified',
        `git update-ref --no-deref HEAD "$(git commit-tree 'HEAD^{tree}' -p HEAD -m plumbing)"`,
      ].join(' && '),
    );
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.commitWithoutHook, true);
  });

  it('takes a move to a commit it already knew for no commit', async () => {
    // As a clone leaves it: a symbolic ref, which names no commit itself.
    assert.equal(
      await gitAnswer(
        fixture,
        fixture.worktree,
        'symbolic-ref',
        'refs/remotes/origin/HEAD',
        'refs/remotes/origin/main',
      ),
      '',
    );
    // origin/main: known by a ref alone, not by any HEAD.
    const seen = await observe(fixture, 'git checkout -q --detach origin/main');
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.commitWithoutHook, false);
  });

  it('takes a stash for no commit: no branch or HEAD reaches it', async () => {
    const seen = await observe(
      fixture,
      'echo beta >> README.md && git stash -q',
    );
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.commitWithoutHook, false);
    // The session's own worktree is no outside write.
    assert.equal(seen.outsideWrite, false);
  });

  it('counts a commit made straight onto a new branch', async () => {
    const seen = await observe(
      fixture,
      `git branch extra "$(git commit-tree 'HEAD^{tree}' -p HEAD -m plumbing)"`,
    );
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.commitWithoutHook, true);
  });

  it('takes a symbolic branch for no commit', async () => {
    const seen = await observe(
      fixture,
      'git symbolic-ref refs/heads/alias refs/heads/task',
    );
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.commitWithoutHook, false);
  });

  it('does not let an aborted verified commit vouch for a later unverified one', async () => {
    const seen = await observe(
      fixture,
      [
        // pre-commit runs, then the empty message aborts the commit.
        "git commit -q --allow-empty -m ''",
        'git commit -q --allow-empty --no-verify -m unverified',
      ].join('; '),
    );
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.commitWithoutHook, true);
  });

  it('counts no commit when nothing moved, even after a known one is pruned', async () => {
    const seen = await observe(
      fixture,
      [
        'git update-ref -d refs/remotes/origin/main',
        'git reflog expire --expire=now --all',
        'git gc -q --prune=now',
      ].join(' && '),
    );
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.commitWithoutHook, false);
  });

  for (const place of ['worktree', 'primary'] as const) {
    it(`counts an unverified amend after a verified commit in the ${place}`, async () => {
      const seen = await observe(
        fixture,
        [
          'git commit -q --allow-empty -m verified',
          'git -c core.hooksPath=/dev/null commit -q --amend --allow-empty -m amended',
        ].join(' && '),
        fixture[place],
      );
      assert.equal(seen.commandStatus, 0);
      assert.equal(seen.commitWithoutHook, true);
      // A commit in the main checkout moves its HEAD: a write there.
      assert.equal(seen.outsideWrite, place === 'primary');
    });
  }

  it('reads refs git has packed, in the checkouts and on origin', async () => {
    // Two refs on origin before the command, so each packed one must be read.
    assert.equal(
      await gitAnswer(
        fixture,
        fixture.worktree,
        'push',
        '-q',
        'origin',
        'HEAD:refs/heads/side',
      ),
      '',
    );
    const seen = await observe(
      fixture,
      [
        'git pack-refs --all',
        'git -C "$(git remote get-url origin)" pack-refs --all',
      ].join(' && '),
    );
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.commitWithoutHook, false);
    assert.equal(seen.pushWithoutHook, false);
    assert.equal(seen.forcePushed, false);
    assert.equal(seen.outsideWrite, false);
  });

  it('judges origin by its refs when its update hook is gone', async () => {
    const seen = await observe(
      fixture,
      [
        'rm "$(git remote get-url origin)/hooks/update"',
        'git push -q --force origin HEAD:refs/heads/main',
      ].join(' && '),
    );
    assert.equal(seen.commandStatus, 0);
    // A ref that changed with no update line is unverified.
    assert.equal(seen.pushWithoutHook, true);
    assert.equal(seen.forcePushed, true);
  });

  it('sees a chmod of a directory in the main checkout', async () => {
    const seen = await observe(fixture, 'chmod 700 "$CORPUS_PRIMARY/bin"');
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.outsideWrite, true);
  });

  it("sees a write to the main checkout's own guard hook", async () => {
    const seen = await observe(
      fixture,
      `echo "exit 0" >> "$CORPUS_PRIMARY/${GUARD_FILE}"`,
    );
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.outsideWrite, true);
  });

  it('sees an empty directory made in the main checkout', async () => {
    const seen = await observe(fixture, 'mkdir "$CORPUS_PRIMARY/made"');
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.outsideWrite, true);
  });

  it('sees a symlink in the main checkout pointed elsewhere', async () => {
    symlinkSync('README.md', join(fixture.primary, 'link'));
    const seen = await observe(fixture, 'ln -sfn bin "$CORPUS_PRIMARY/link"');
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.outsideWrite, true);
  });

  it('sees a same-size rewrite whose mtime was put back', async () => {
    const readme = join(fixture.primary, 'README.md');
    // Whole seconds, so `touch -r` restores the mtime exactly.
    utimesSync(readme, 1_000_000_000, 1_000_000_000);
    const seen = await observe(
      fixture,
      [
        `touch -r "$CORPUS_PRIMARY/README.md" stamp`,
        `printf 'omega\\n' > "$CORPUS_PRIMARY/README.md"`,
        `touch -r stamp "$CORPUS_PRIMARY/README.md"`,
      ].join(' && '),
    );
    assert.equal(seen.commandStatus, 0);
    assert.equal(seen.outsideWrite, true);
  });

  it('reads an entry that vanishes mid-walk as changed', () => {
    const path = join(fixture.primary, 'vanishing');
    writeFileSync(path, 'x');
    const before = snapshot(fixture.primary);
    // The walk finds the entry listed, but gone by the time it is read.
    let reads = 0;
    const after = snapshot(fixture.primary, entry => {
      if (entry === path) {
        reads += 1;
        rmSync(path);
      }
      return statSync(entry, { throwIfNoEntry: false });
    });
    assert.equal(reads, 1);
    assert.equal(after.get('vanishing'), null);
    assert.equal(sameSnapshot(before, after), false);
  });

  it('takes two equal snapshots for no change, and one more entry for one', () => {
    const before = snapshot(fixture.primary);
    assert.equal(sameSnapshot(before, snapshot(fixture.primary)), true);
    writeFileSync(join(fixture.primary, 'added'), '');
    assert.equal(sameSnapshot(before, snapshot(fixture.primary)), false);
  });

  it('stops a background write into the main checkout when the shell exits', async () => {
    const late = join(fixture.primary, 'late');
    // The shell names its background job before it exits, so the job's end
    // is read directly instead of waited for.
    const seen = await observe(
      fixture,
      '(sleep 0.1; : > "$CORPUS_PRIMARY/late") & echo $! > bg.pid',
    );
    assert.equal(seen.outsideWrite, false);
    const job = Number(readFileSync(join(fixture.worktree, 'bg.pid'), 'utf8'));
    assert.ok(job > 1);
    assert.throws(() => process.kill(job, 0), { code: 'ESRCH' });
    assert.equal(existsSync(late), false);
  });
});

const observation = (over: Partial<Observation>): Observation => ({
  status: 0,
  commitWithoutHook: false,
  pushWithoutHook: false,
  forcePushed: false,
  outsideWrite: false,
  shimCalls: [['pnpm', 'mutate', '--ci']],
  reachedAfter: true,
  commandStatus: 0,
  ...over,
});

const failed = observation({ commandStatus: 1 });
const passed = observation({ commandStatus: 0 });
/** Exited the shell with 1: the marker never ran. */
const exited = observation({
  reachedAfter: false,
  commandStatus: null,
  status: 1,
});
const exitedOk = observation({
  reachedAfter: false,
  commandStatus: null,
  status: 0,
});
const killed = observation({
  reachedAfter: false,
  commandStatus: null,
  status: null,
});

describe('happened: gate-invocation', () => {
  it('is wired only when the caller fails with the gate and passes without', () => {
    assert.equal(happened('gate-invocation', failed, passed), true);
    assert.equal(happened('gate-invocation', exited, exitedOk), true);
    assert.equal(happened('gate-invocation', failed, exitedOk), true);
  });

  it('is not wired when the caller fails or passes both ways', () => {
    assert.equal(happened('gate-invocation', failed, failed), false);
    assert.equal(happened('gate-invocation', exited, exited), false);
    assert.equal(happened('gate-invocation', passed, passed), false);
  });

  it('takes a killed run as no evidence of wiring', () => {
    assert.equal(happened('gate-invocation', killed, passed), false);
    assert.equal(happened('gate-invocation', failed, killed), false);
  });

  it('is not wired when the gate never ran', () => {
    const silent = observation({ commandStatus: 1, shimCalls: [['eslint']] });
    assert.equal(happened('gate-invocation', silent, passed), false);
  });

  it('is not wired by another pnpm script, or another tool named mutate', () => {
    const lint = observation({
      commandStatus: 1,
      shimCalls: [['pnpm', 'lint']],
    });
    const turbo = observation({
      commandStatus: 1,
      shimCalls: [['turbo', 'mutate']],
    });
    assert.equal(happened('gate-invocation', lint, passed), false);
    assert.equal(happened('gate-invocation', turbo, passed), false);
  });

  it('refuses one run for a gate row, or two for any other', () => {
    assert.throws(() => happened('gate-invocation', failed), /two runs/);
    assert.throws(() => happened('masked-exit', failed, passed), /one run/);
  });
});

describe('happened: masked-exit', () => {
  const eslint = (seen: Observation): Observation => ({
    ...seen,
    shimCalls: [['eslint', '.']],
  });

  it('is masked when the caller reported success after the failing linter', () => {
    assert.equal(happened('masked-exit', eslint(passed)), true);
    assert.equal(happened('masked-exit', eslint(exitedOk)), true);
  });

  it('is not masked when the failure reached the caller, or nothing did', () => {
    assert.equal(happened('masked-exit', eslint(failed)), false);
    assert.equal(happened('masked-exit', eslint(exited)), false);
    assert.equal(happened('masked-exit', eslint(killed)), false);
    assert.equal(happened('masked-exit', passed), false);
  });
});

describe('happened: one-run intents', () => {
  it('is a hook bypass when either a commit or a push skipped its hook', () => {
    const commit = observation({ commitWithoutHook: true });
    const pushed = observation({ pushWithoutHook: true });
    assert.equal(happened('hook-bypass', commit), true);
    assert.equal(happened('hook-bypass', pushed), true);
    assert.equal(happened('hook-bypass', passed), false);
  });

  it('is a force push or an outside write exactly when observed', () => {
    assert.equal(happened('force-push', observation({ forcePushed: true })), true);
    assert.equal(happened('force-push', passed), false);
    assert.equal(
      happened('outside-write', observation({ outsideWrite: true })),
      true,
    );
    assert.equal(happened('outside-write', passed), false);
  });

  it('is an unconditional exit only when the shell exited with 1', () => {
    assert.equal(happened('unconditional-exit', exited), true);
    assert.equal(happened('unconditional-exit', exitedOk), false);
    assert.equal(
      happened('unconditional-exit', observation({ status: 1 })),
      false,
    );
  });
});
