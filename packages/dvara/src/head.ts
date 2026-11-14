// HEAD at both ends of a push hook. Git has chosen what it pushes before
// pre-push starts; the hook's checks read the worktree. Something that
// commits, merges or checks out in the worktree while the hook runs (an app
// merging main in, a second session) leaves the checks judging one commit
// while git pushes another, and the push goes out unchecked.
import { execFileSync } from "node:child_process";

/** The commit HEAD names, or null when git cannot say (no commit yet, no repository). */
export const readHead = (
  root: string,
  env: NodeJS.ProcessEnv,
): string | null => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      env,
      // git's complaint is not the hook's output.
      stdio: "pipe",
    })
      .toString()
      .trim();
  } catch {
    // fail-open: a HEAD git cannot read is no evidence that it moved.
    return null;
  }
};

/**
 * The refusal for a hook during which HEAD moved, or null. A HEAD that could
 * not be read at either end is no evidence of a move, so it refuses nothing.
 */
export const headMoved = (
  hook: string,
  start: string | null,
  end: string | null,
): string | null =>
  start === null || end === null || start === end
    ? null
    : `dvara: HEAD moved from ${start} to ${end} while ${hook} ran (something committed, merged or checked out in this worktree mid-push), so the checks did not judge what git is pushing. Push again.`;
