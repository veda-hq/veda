"""kavach: guards that keep a coding agent inside its bounds.

Entry points (each reads one Claude Code PreToolUse event on stdin; exit 0
allows, exit 2 refuses with the reason on stderr, any other end refuses):

- worktree_guard.py: no write outside the agent's own worktree.
- command_guard.py: no git-hook bypass, no history-destroying push, and the
  consumer's own command rules (config.py).
"""
