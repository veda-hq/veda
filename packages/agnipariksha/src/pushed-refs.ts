/**
 * `--pushed-refs`: whether a push's refs are what the gate judges. Stryker
 * mutates the files on disk, so the gate judges the checked-out `HEAD` and
 * its working tree. A pre-push hook gets the refs git pushes on its stdin,
 * one `<local ref> <local sha> <remote ref> <remote sha>` line each; when a
 * pushed ref is not `HEAD`, or a tracked file differs from `HEAD`, the
 * verdict would be about something the push does not carry.
 */
import type { Git } from './changed-files.ts';

export type PushCheck =
  /** Every pushed ref is `HEAD` and the tracked tree is clean: judge as usual. */
  | { verdict: 'judge' }
  /** The push carries no commit (an up-to-date push, or deletions only). */
  | { verdict: 'nothing'; line: string }
  | { verdict: 'refuse'; reason: string };

/** A local sha of all zeros: the line deletes a remote ref and carries no commit. */
const DELETION = /^0+$/;
/** git's pre-push line, every field present: a ref, a sha, a ref, a sha (of any hash's length). */
const LINE = /^(\S+) ([0-9a-f]+) \S+ [0-9a-f]+$/;

export const NOTHING_PUSHED = 'agnipariksha: the push carries no commit (up to date, or deletions only) - nothing to judge';

/**
 * Read git's pre-push ref lines and check them against `HEAD` and the
 * tracked tree. git runs the hook with no lines for an up-to-date push, so
 * no lines, like deletions only, is nothing to judge. A line not in git's
 * shape refuses: the gate cannot say what the push carries.
 */
export function checkPushedRefs(text: string, git: Git): PushCheck {
  const pushed: { ref: string; sha: string }[] = [];
  for (const line of text.split('\n').filter((entry) => entry !== '')) {
    const match = LINE.exec(line);
    if (match === null) {
      return { verdict: 'refuse', reason: `--pushed-refs cannot read the ref line "${line}": git's pre-push lines are "<local ref> <local sha> <remote ref> <remote sha>"` };
    }
    const [, ref, sha] = match as unknown as [string, string, string];
    if (!DELETION.test(sha)) pushed.push({ ref, sha });
  }
  if (pushed.length === 0) return { verdict: 'nothing', line: NOTHING_PUSHED };

  // One call: HEAD's commit, then each pushed sha's (an annotated tag peels to its commit).
  const [head, ...commits] = git(['rev-parse', 'HEAD^{commit}', ...pushed.map(({ sha }) => `${sha}^{commit}`)]).split('\n') as [string, ...string[]];
  const other = pushed.findIndex((_, i) => commits[i] !== head);
  if (other !== -1) {
    const { ref, sha } = pushed[other] as { ref: string; sha: string };
    return {
      verdict: 'refuse',
      reason: `the push carries ${ref} at ${sha.slice(0, 12)}, not the checked-out HEAD (${head.slice(0, 12)}): the gate judges HEAD and the files on disk, so its verdict would not be about ${ref}. Check out ${ref} and push again`,
    };
  }

  // Staged and unstaged changes to tracked files alike: the push carries neither.
  const dirty = git(['diff', '--name-only', '-z', 'HEAD', '--']).split('\0').filter((entry) => entry !== '');
  if (dirty.length > 0) {
    return {
      verdict: 'refuse',
      reason: `tracked files differ from HEAD: ${dirty.join(', ')}. The gate judges the files on disk and the push carries HEAD's, so its verdict would not be about the push. Commit or stash the change, then push again`,
    };
  }
  return { verdict: 'judge' };
}
