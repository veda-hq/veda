#!/bin/bash
# SessionStart handler: clears a WORKTREE-SCOPED core.hooksPath, so the
# shared value in the repository's config is what git runs in this checkout.
#
# Tools that create worktrees have been seen writing an ABSOLUTE hooks path
# into the worktree's private config.worktree: the Claude desktop app (for
# every worktree it creates, "Configured worktree hooks path to ... (from base
# repo config)") and Claude Code's EnterWorktree (anthropics/claude-code#66993,
# #72714) point it at the MAIN checkout's hooks; Codex points it at its own
# worktree folder. A scoped value outranks the shared one, so git then runs
# ANOTHER checkout's hooks against this tree: a branch check reads main's
# branch, and a push gate refuses a hooks folder outside the worktree.
#
# The checkout to heal is the session's, read from the hook input's `cwd`,
# not $CLAUDE_PROJECT_DIR: the desktop app launches worktree sessions with
# `--project-config-root <main checkout>`, and then that variable names the
# main checkout, where there is nothing to clear.
#
# Only the scoped value is removed; the shared one is the project's to set.
# Synchronous but cheap: a few `git config` calls. Always exits 0.
set -uo pipefail

TARGET="${CLAUDE_PROJECT_DIR:-$PWD}"
# The hook input is one JSON object on stdin. Never wait on a terminal.
if [ ! -t 0 ] && command -v node >/dev/null 2>&1; then
  SESSION_DIR=$(node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      try {
        const cwd = JSON.parse(s).cwd;
        if (typeof cwd === "string") process.stdout.write(cwd);
      } catch {}
    });' 2>/dev/null) || SESSION_DIR=""
  [ -n "$SESSION_DIR" ] && [ -d "$SESSION_DIR" ] && TARGET="$SESSION_DIR"
fi
[ -d "$TARGET" ] || exit 0
cd "$TARGET" 2>/dev/null || exit 0
git rev-parse --show-toplevel >/dev/null 2>&1 || exit 0

# With extensions.worktreeConfig off there is no scoped value. `--worktree`
# then errors in a repository with linked worktrees, but in one with a single
# checkout it falls back to the shared config, whose value is the project's:
# so nothing is read or unset unless the extension is on.
[ "$(git config --bool --get extensions.worktreeConfig 2>/dev/null)" = "true" ] || exit 0
scoped=$(git config --worktree --get core.hooksPath 2>/dev/null || true)
if [ -n "$scoped" ] && git config --worktree --unset-all core.hooksPath 2>/dev/null; then
  shared=$(git config --get core.hooksPath 2>/dev/null || true)
  if [ -n "$shared" ]; then
    printf 'Cleared worktree-scoped core.hooksPath (%s); the shared %s now applies\n' "$scoped" "$shared"
  else
    printf "Cleared worktree-scoped core.hooksPath (%s); git's default hooks folder now applies\n" "$scoped"
  fi
fi
exit 0
