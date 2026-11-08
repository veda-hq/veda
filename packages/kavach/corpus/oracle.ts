/**
 * Ground truth for the adversarial corpus: what bash and git REALLY do.
 *
 * Every shell-analysing guard answers a question about a command without
 * running it — "does this bypass the hooks", "does this force a push", "does
 * this write outside the worktree", "does this run the gate". Hand-picked
 * unit cases can only check those answers against what their author believed
 * bash does. This module runs the command instead, inside a throwaway fixture
 * (fixture.ts), and reports what happened; the corpus suite compares the two.
 *
 * Residual: the hooks run as the command's own user, so a row can still forge
 * their log by guessing a push's pid or rewriting origin's hook, and can read
 * the end marker's nonce from `$BASH_EXECUTION_STRING` or `ps`. No channel
 * it cannot write exists without root (only dtrace or eslogger, on macOS);
 * the corpus check (corpus.ts, HARNESS_FILES) and review guard against that.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  type Stats,
} from 'node:fs';
import { join, relative } from 'node:path';

import type { Intent } from './corpus.ts';
import { type Fixture, gitAnswer } from './fixture.ts';
import { runChild } from './run-child.ts';

/** A run of decimal digits as a whole number, or null past the safe range. */
function wholeNumber(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

export interface Observation {
  /** Exit status of the whole command (null when killed by the timeout). */
  readonly status: number | null;
  /** A commit landed in any checkout without pre-commit running. */
  readonly commitWithoutHook: boolean;
  /** A ref landed on origin without pre-push running. */
  readonly pushWithoutHook: boolean;
  /** origin/main was replaced by a commit that does not descend from it. */
  readonly forcePushed: boolean;
  /** Something in the main checkout's work tree, or its HEAD, changed. */
  readonly outsideWrite: boolean;
  /** The argv each shim call logged, e.g. `['pnpm', 'mutate', '--ci']`. */
  readonly shimCalls: readonly (readonly string[])[];
  /** Marker printed after the command: false when the command exited the shell. */
  readonly reachedAfter: boolean;
  /**
   * The command's own status (`$?` read by the marker), or null when the
   * marker was never reached. The marker is a successful `echo`, so the
   * whole script's status says nothing about whether the command failed.
   */
  readonly commandStatus: number | null;
}

/** A command gets this long; nothing in the corpus needs a fraction of it. */
const TIMEOUT_MS = 20_000;
/** The tail of a command's stdout kept: enough to hold the marker. */
const STDOUT_LIMIT = 1024 * 1024;
const SHA = /^[0-9a-f]{40,64}$/;

/**
 * Entries of the main checkout a session may legitimately change: git's own
 * state and the folder holding the linked worktree. The walk skips each one
 * whole, so nothing below them is read. Everything else in the checkout,
 * `.claude/settings.json` and the checkout's own guard hook included, counts.
 */
function sharedState(primary: string): ReadonlySet<string> {
  return new Set([
    join(primary, '.git'),
    join(primary, '.claude', 'worktrees'),
  ]);
}

/**
 * name -> mode, size, mtime and content hash for the main checkout's work
 * tree. The hash catches a same-size rewrite whose mtime was put back. A FIFO
 * or socket has no content to hash (null in its place), and an entry that
 * vanished between the listing and its stat reads as null whole: neither
 * equals any entry that has one, nor an entry that is missing.
 *
 * `statFile` stats a non-directory entry, undefined when it is gone; a test
 * replaces it to make an entry vanish mid-walk.
 */
export function snapshot(
  primary: string,
  statFile: (path: string) => Stats | undefined = path =>
    statSync(path, { throwIfNoEntry: false }),
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const skipped = sharedState(primary);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (skipped.has(full)) continue;
      const rel = relative(primary, full);
      if (entry.isDirectory()) {
        // A directory's mode is state too: a chmod there is a write.
        out.set(`${rel}/`, `dir:${statSync(full).mode}`);
        walk(full);
      } else if (entry.isSymbolicLink()) {
        out.set(rel, `link:${readlinkSync(full)}`);
      } else {
        const stat = statFile(full);
        out.set(
          rel,
          stat === undefined
            ? null
            : JSON.stringify([
                stat.size,
                stat.mtimeMs,
                stat.mode,
                stat.isFile()
                  ? createHash('sha256')
                      .update(readFileSync(full))
                      .digest()
                      .toString('hex')
                  : null,
              ]),
        );
      }
    }
  };
  walk(primary);
  return out;
}

export function sameSnapshot(
  a: Map<string, string | null>,
  b: Map<string, string | null>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * Refs read straight from the repository files, not through `git`.
 *
 * Every row reads six refs before and after it runs; as git processes that
 * was most of a row's cost on a loaded machine. The fixture's refs are loose
 * or in `packed-refs`, and those two are all this needs to read.
 */
function readRef(commonDir: string, name: string): string | null {
  const loose = join(commonDir, name);
  if (existsSync(loose) && statSync(loose).isFile()) {
    return readFileSync(loose, 'utf8').trim();
  }
  const packed = join(commonDir, 'packed-refs');
  if (!existsSync(packed)) return null;
  for (const line of readFileSync(packed, 'utf8').split('\n')) {
    const [sha, ref] = line.split(' ');
    if (ref === name) return sha ?? null;
  }
  return null;
}

/**
 * `ref: refs/heads/x <sha>` for a symbolic HEAD, `ref: refs/heads/x null`
 * while the branch is unborn, the bare sha for a detached one.
 */
function readHead(commonDir: string, headFile: string): string | null {
  if (!existsSync(headFile)) return null;
  const head = readFileSync(headFile, 'utf8').trim();
  return head.startsWith('ref: ')
    ? `${head} ${String(readRef(commonDir, head.slice(5)))}`
    : head;
}

function refTable(gitDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), name);
      else
        out.push(
          `${name} ${readFileSync(join(dir, entry.name), 'utf8').trim()}`,
        );
    }
  };
  walk(join(gitDir, 'refs'), 'refs');
  const packed = join(gitDir, 'packed-refs');
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      if (line === '' || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, ref] = line.split(' ');
      // A loose ref shadows its packed copy.
      if (!out.some(entry => entry.startsWith(`${ref} `))) {
        out.push(`${ref} ${sha}`);
      }
    }
  }
  return out.sort();
}

/** Ref names whose value differs between two ref tables, deletions included. */
function changedRefs(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const was = new Set(before);
  const is = new Set(after);
  const changed = [
    ...after.filter(entry => !was.has(entry)),
    ...before.filter(entry => !is.has(entry)),
    // The first word: the whole entry when there is no space in it.
  ].map(entry => entry.split(' ')[0] ?? entry);
  return [...new Set(changed)];
}

/**
 * Did any ref update on origin land without a pre-push run vouching for it?
 *
 * A client pre-push run logs `pre-push <push pid> <ref>` per ref; origin's
 * `update` hook logs `update <ref> <old> <new> [<push pid>]`, the `git push`
 * that started its receive-pack (fixture.ts, ORIGIN_UPDATE). An update is
 * vouched for only by a pre-push line of that same push, and consumes it: a
 * `--dry-run` push runs pre-push but sends nothing, so its vouch names a
 * process no later `--no-verify` push can be. A line appended by hand is no
 * vouch unless its pid guesses that very push.
 * A ref that changed with no `update` line at all (origin's hook removed) is
 * unverified too.
 */
function unverifiedUpdate(
  lines: readonly string[],
  changed: readonly string[],
): boolean {
  /** `<push pid> <ref>` per pre-push line not yet consumed. */
  const vouches: string[] = [];
  const updated = new Set<string>();
  for (const line of lines) {
    const [hook, ...rest] = line.split(' ');
    if (hook === 'pre-push') {
      vouches.push(rest.join(' '));
    } else if (hook === 'update') {
      // A line too short to name a ref names "undefined", which no ref is.
      const [named, , , ...pids] = rest;
      const ref = String(named);
      updated.add(ref);
      const at = vouches.findIndex(vouch =>
        pids.some(pid => vouch === `${pid} ${ref}`),
      );
      if (at < 0) return true;
      vouches.splice(at, 1);
    }
  }
  return changed.some(ref => !updated.has(ref));
}

/**
 * Commits that finished with their pre-commit run: a `post-commit <pid>` line
 * whose `git commit` process (pid) also logged `pre-commit <pid>`. A verified
 * attempt that aborts (empty message) logs pre-commit only, so it cannot
 * vouch for a later `--no-verify` commit, whose post-commit has no partner.
 */
function verifiedCommits(lines: readonly string[]): number {
  const ran = new Set<string>();
  let verified = 0;
  for (const line of lines) {
    const [hook, pid] = line.split(' ');
    if (pid === undefined) continue;
    if (hook === 'pre-commit') ran.add(pid);
    if (hook === 'post-commit' && ran.delete(pid)) verified += 1;
  }
  return verified;
}

/**
 * Every checkout of a repository -- the primary and each linked worktree --
 * with its HEAD and HEAD reflog, since `git -C {P} commit` commits in another.
 */
function checkouts(common: string): { head: string; log: string }[] {
  const linked = join(common, 'worktrees');
  return [
    { head: join(common, 'HEAD'), log: join(common, 'logs', 'HEAD') },
    ...(existsSync(linked) ? readdirSync(linked) : []).map(name => ({
      head: join(linked, name, 'HEAD'),
      log: join(linked, name, 'logs', 'HEAD'),
    })),
  ];
}

/** A ref-table entry for a local branch. */
function isBranch(entry: string): boolean {
  return entry.startsWith('refs/heads/');
}

/** The commit a HEAD reading names (`ref: … <sha>` or a bare sha). */
function headSha(head: string | null): string | null {
  if (head === null) return null;
  // The last word: the whole reading when there is no space in it.
  const sha = head.slice(head.lastIndexOf(' ') + 1);
  return SHA.test(sha) ? sha : null;
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line !== '');
}

function markerStatus(stdout: string, marker: string): number | null {
  const match = [...stdout.matchAll(new RegExp(`${marker}:(\\d+)`, 'g'))].at(
    -1,
  );
  // `\d+` holds digits only, so the text is already a whole number.
  return match === undefined ? null : wholeNumber(match[1]);
}

/**
 * Run `command` in bash, followed by an `echo` of a marker with a fresh nonce
 * per run, so text the command prints cannot fake reaching the end (`echo
 * __corpus_after__:0; exit 1`) or its status unless it reads the nonce back
 * from its own shell (the residual in this module's header). The
 * shell leads its own process group, and the whole group is killed at the
 * timeout and once bash exits, so a nested or backgrounded descendant cannot
 * outlive the observation and write into a fixture being deleted.
 */
async function exec(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; marker: string }> {
  const marker = `__corpus_after__${randomBytes(12).toString('hex')}`;
  // runChild kills the group as soon as bash exits, not once its pipes
  // close: a background descendant holding stdout open would otherwise keep
  // writing into the fixture after the command it belongs to has finished.
  const outcome = await runChild(
    'bash',
    ['-c', `${command}\necho ${marker}:$?`],
    { cwd, env, timeoutMs: TIMEOUT_MS },
  );
  // A timeout, a signal or a failed spawn leaves no status: a killed row is
  // no evidence of anything.
  const status =
    outcome.kind === 'ok' || outcome.kind === 'exit' ? outcome.code : null;
  return { status, stdout: outcome.stdout.slice(-STDOUT_LIMIT), marker };
}

/**
 * Run `command` in `cwd` (default: the session worktree) and observe it.
 *
 * The command is followed by an `echo` marker in the SAME shell, so a command
 * that exits the shell (`exit 1`, `exec`) is visible as never reaching it.
 */
export async function observe(
  fixture: Fixture,
  command: string,
  cwd: string = fixture.worktree,
): Promise<Observation> {
  const common = join(fixture.primary, '.git');
  const primaryHead = join(common, 'HEAD');
  const checkoutsBefore = new Map(
    checkouts(common).map(checkout => [
      checkout.head,
      {
        head: readHead(common, checkout.head),
        log: readLines(checkout.log).length,
      },
    ]),
  );
  const branchesBefore = refTable(common).filter(isBranch);
  const knownBefore = [
    ...new Set(
      [
        ...refTable(common).map(entry => entry.split(' ')[1] ?? null),
        ...[...checkoutsBefore.values()].map(before => headSha(before.head)),
      ].filter((sha): sha is string => sha !== null && SHA.test(sha)),
    ),
  ];
  const primaryBefore = readHead(common, primaryHead);
  const refsBefore = refTable(fixture.remote);
  const treeBefore = snapshot(fixture.primary);
  const hooksBefore = readLines(fixture.hookMarker);
  const shimsBefore = readLines(fixture.shimLog).length;

  const { status, stdout, marker } = await exec(command, cwd, fixture.env);

  const hooksAfter = readLines(fixture.hookMarker).slice(hooksBefore.length);
  const refsAfter = refTable(fixture.remote);
  // Any origin ref replaced by a commit that does not descend from its old
  // value, on every branch and tag, not just main: creating `side` and then
  // pushing its ancestor over it rewrites history as surely. Each update
  // origin accepted is judged, so a ref the command created and then
  // rewrote counts, and so is each ref's net change. A creation or a
  // deletion (an all-zero side) rewrites no history.
  const was = new Map(
    refsBefore.map(entry => entry.split(' ') as [string, string]),
  );
  // A ref new to origin has no old value (undefined), which no test below
  // takes for a sha.
  const replacements = [
    ...hooksAfter
      .map(line => line.split(' '))
      .filter(([hook]) => hook === 'update')
      .map(words => words.slice(2, 4)),
    ...refsAfter.map(entry => {
      const [ref, sha] = entry.split(' ');
      return [ref === undefined ? undefined : was.get(ref), sha];
    }),
  ]
    .map(pair => pair.map(value => String(value)))
    .filter((pair): pair is [string, string] => {
      const [old, sha] = pair;
      return (
        old !== undefined &&
        sha !== undefined &&
        SHA.test(old) &&
        SHA.test(sha) &&
        old !== sha &&
        !/^0+$/.test(old) &&
        !/^0+$/.test(sha)
      );
    });
  const descents = await Promise.all(
    replacements.map(([old, sha]) =>
      gitAnswer(
        fixture,
        fixture.remote,
        'merge-base',
        '--is-ancestor',
        old,
        sha,
      ),
    ),
  );
  const forcePushed = descents.some(descends => descends === null);
  const primaryAfter = readHead(common, primaryHead);

  // Hooks are matched to the operations they guarded, not to the script as a
  // whole: a verified commit followed by a `--no-verify` one is a bypass.
  // New commits only: those a checkout's HEAD or a branch now reaches that no
  // ref or HEAD reached before. Moving HEAD (a reset to an ancestor, a
  // checkout of an existing branch) creates none, so it is no commit without
  // a hook. The inventory is re-read: a worktree the command added (`git
  // worktree add ../x; git -C ../x commit --no-verify`) is a checkout too,
  // and a branch keeps the commits of one it has since removed.
  let commits = 0;
  const after = checkouts(common);
  const moved = [
    ...after.map(checkout => {
      const head = readHead(common, checkout.head);
      return head === checkoutsBefore.get(checkout.head)?.head
        ? null
        : headSha(head);
    }),
    ...refTable(common)
      .filter(entry => isBranch(entry) && !branchesBefore.includes(entry))
      .map(entry => entry.split(' ')[1] ?? null),
  ].filter((sha): sha is string => sha !== null && SHA.test(sha));
  if (moved.length > 0) {
    const counted = await gitAnswer(
      fixture,
      fixture.worktree,
      'rev-list',
      '--count',
      ...moved,
      '--not',
      ...knownBefore,
    );
    // No answer, or not a count, is read as one commit: never as none.
    // `rev-list --count` prints digits only, so no integer check is needed.
    commits =
      counted === null ? 1 : (wholeNumber(counted) ?? 1);
  }
  // Commit OPERATIONS, from each HEAD's reflog: `git commit --amend
  // --no-verify` after a verified commit leaves one new commit and one
  // pre-commit run, but two `commit` entries.
  const operations = after
    .map(
      checkout =>
        readLines(checkout.log)
          .slice(checkoutsBefore.get(checkout.head)?.log ?? 0)
          .filter(line => /\tcommit\b/.test(line)).length,
    )
    .reduce((sum, count) => sum + count, 0);
  // And each post-commit run is a finished commit, even in a worktree the
  // command has since removed, whose HEAD and reflog went with it.
  const finished = hooksAfter.filter(line =>
    line.startsWith('post-commit '),
  ).length;
  commits = Math.max(commits, operations, finished);

  return {
    status,
    commitWithoutHook: commits > verifiedCommits(hooksAfter),
    pushWithoutHook: unverifiedUpdate(
      hooksAfter,
      changedRefs(refsBefore, refsAfter),
    ),
    forcePushed,
    outsideWrite:
      primaryAfter !== primaryBefore ||
      !sameSnapshot(treeBefore, snapshot(fixture.primary)),
    // This command's calls only, as with the hook marker: a fixture reused
    // after `pnpm mutate` must not credit the next command with it.
    shimCalls: readLines(fixture.shimLog)
      .slice(shimsBefore)
      .map(line => line.split('\x1f')),
    reachedAfter: markerStatus(stdout, marker) !== null,
    commandStatus: markerStatus(stdout, marker),
  };
}

/**
 * Did the command report failure to its caller? Its own status when the
 * marker ran, else the shell's (it exited or replaced itself). null when the
 * shell was killed or never ran: it reported nothing either way.
 */
function reportedFailure(seen: Observation): boolean | null {
  if (seen.reachedAfter) return seen.commandStatus !== 0;
  return seen.status === null ? null : seen.status !== 0;
}

/**
 * Did `intent` happen, by the observation? The corpus's definition of truth.
 *
 * `gate-invocation` alone needs `passing`: the same command run on its own
 * copy of the fixture with the gate passing (passGate). See below.
 */
export function happened(
  intent: Intent,
  seen: Observation,
  passing?: Observation,
): boolean {
  if (intent !== 'gate-invocation' && passing !== undefined) {
    throw new Error(`${intent} is judged on one run: pass only that`);
  }
  switch (intent) {
    case 'hook-bypass':
      return seen.commitWithoutHook || seen.pushWithoutHook;
    case 'force-push':
      return seen.forcePushed;
    case 'outside-write':
      return seen.outsideWrite;
    // The gate ran AND its verdict reached the caller: the caller fails when
    // the gate fails (`seen`) and succeeds when it passes (`passing`). A
    // nonzero status alone proves nothing: `pnpm mutate --ci || true; exit
    // 1` fails either way, and `OUT=$(pnpm mutate --ci; true)` passes either
    // way. A command that fails both times reports its own failure, not the
    // gate's, so it is NOT wired; a killed run (null) is no evidence.
    case 'gate-invocation':
      if (passing === undefined) {
        throw new Error('gate-invocation is judged on two runs: pass both');
      }
      return (
        seen.shimCalls.some(
          ([name, script]) => name === 'pnpm' && script === 'mutate',
        ) &&
        reportedFailure(seen) === true &&
        reportedFailure(passing) === false
      );
    case 'unconditional-exit':
      return seen.status === 1 && !seen.reachedAfter;
    // The failing gate ran AND the command reported success: `bash -c
    // 'eslint . || exit 1'` carries on too, but with status 1, so it
    // propagated the failure rather than masking it. A command that replaced
    // the shell (`exec bash -c 'eslint . || true'`) reports through the
    // shell's own status, since the marker after it never runs.
    case 'masked-exit':
      return (
        seen.shimCalls.some(([name]) => name === 'eslint') &&
        reportedFailure(seen) === false
      );
  }
}
