/**
 * `sarathi worktree hook`: the PreToolUse handler for an agent's request to
 * remove or archive its worktree (Claude Code's `ExitWorktree`, Codex's
 * `set_thread_archived`). It runs the archive check on the session's worktree
 * and denies the call while work would be lost. It cannot see an archive done
 * in the app's own interface.
 *
 * Unreadable input, a check that cannot finish, and a request to archive
 * another session all deny: removal cannot be undone.
 */
import { archiveCheck, Blocked, context, git, nodeHost, real, type Host } from './lifecycle.ts';
import { readSettings, type WorktreeSettings } from './settings.ts';

const ADVICE =
  ' Explain the outstanding work. Preserve it, or obtain an explicit discard request before retrying; archive itself is not discard authorization.';

/** Why the call is denied, or undefined to let it through. */
export function judge(input: string, host: (settings: WorktreeSettings) => Host = settings => nodeHost(settings)): string | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('not an event');
    const payload = parsed as { tool_name?: unknown; tool_input?: unknown; session_id?: unknown; cwd?: unknown };
    const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
    const args = (typeof payload.tool_input === 'object' && payload.tool_input !== null ? payload.tool_input : {}) as Record<string, unknown>;
    if (tool.endsWith('set_thread_archived')) {
      if (args.archived === false) return undefined;
      const target = args.threadId;
      if (typeof target === 'string' && target !== '' && target !== payload.session_id) {
        return "Archive must be checked in the owning task; this hook cannot inspect another task's worktree.";
      }
    } else if (tool === 'ExitWorktree') {
      if (args.action === 'keep') return undefined;
    } else {
      return undefined;
    }
    if (typeof payload.cwd !== 'string') throw new TypeError('no cwd');
    const probe = nodeHost({ name: 'sarathi', owner: 'the owner' });
    const root = real(git({ host: probe }, payload.cwd, 'rev-parse', '--show-toplevel'));
    const settings = readSettings(root);
    const { report, code } = archiveCheck(context(payload.cwd, host(settings), settings));
    return code === 0 ? undefined : `Archive blocked: ${report.blockers.join('; ')}`;
  } catch (error) {
    // fail-open: every failure here denies the removal, which is the safe answer.
    if (error instanceof Blocked) return `Archive blocked: ${error.message}`;
    return 'Archive blocked: unable to verify the owning worktree.';
  }
}

/** Prints the deny decision, if any; always exits 0, as Claude Code reads the JSON. */
export function hookMain(input: string, out: (text: string) => void, host?: (settings: WorktreeSettings) => Host): number {
  const reason = judge(input, host);
  if (reason !== undefined) {
    out(
      `${JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason + ADVICE },
      })}\n`,
    );
  }
  return 0;
}
