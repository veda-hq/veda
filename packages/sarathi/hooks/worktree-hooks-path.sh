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
# Presence, not a non-empty value: `hooksPath =` reads back as an empty line
# with exit 0, and under it git runs no hooks at all (git 2.54), while the
# scoped value still outranks the shared one.
git config --worktree --get-all core.hooksPath >/dev/null 2>&1 || exit 0
scoped=$(git config --worktree --get core.hooksPath 2>/dev/null || true)
git config --worktree --unset-all core.hooksPath >/dev/null 2>&1 || true

# What applies once the scoped value is gone: $1 says whether another scope
# sets the key at all, $2 is its value. An empty shared value runs no hooks,
# as an empty scoped one does, so it is named as that, not as git's default.
shared_name() {
  if [ "$1" != "set" ]; then
    printf "git's default hooks folder"
  elif [ -z "$2" ]; then
    printf 'the shared empty core.hooksPath (no hooks run)'
  else
    printf 'the shared %s' "$2"
  fi
}

# Read the key again rather than trust the unset's exit status: a failed
# clear (a held config.worktree.lock, a read-only file) leaves the worktree
# on another checkout's hooks, and the session should say so.
if git config --worktree --get-all core.hooksPath >/dev/null 2>&1; then
  # The scoped value still wins a plain read, so take the last value from
  # any other scope (git 2.26+ for --show-scope).
  present="" shared=""
  while IFS=$'\t' read -r scope value; do
    [ "$scope" = "worktree" ] || { present=set; shared=$value; }
  done < <(git config --show-scope --get-all core.hooksPath 2>/dev/null || true)
  shared_name=$(shared_name "$present" "$shared")
  file=$(git rev-parse --path-format=absolute --git-path config.worktree 2>/dev/null || echo config.worktree)
  if [ -n "$scoped" ]; then
    printf 'Could not clear the worktree-scoped core.hooksPath (%s) in %s: git still uses it here, not %s. Remove its hooksPath line by hand.\n' "$scoped" "$file" "$shared_name"
  else
    printf 'Could not clear the empty worktree-scoped core.hooksPath in %s: git runs no hooks here, not %s. Remove its hooksPath line by hand.\n' "$file" "$shared_name"
  fi
else
  if shared=$(git config --get core.hooksPath 2>/dev/null); then present=set; else present="" shared=""; fi
  shared_name=$(shared_name "$present" "$shared")
  if [ -n "$scoped" ]; then
    printf 'Cleared worktree-scoped core.hooksPath (%s); %s now applies\n' "$scoped" "$shared_name"
  else
    printf 'Cleared an empty worktree-scoped core.hooksPath, under which git ran no hooks; %s now applies\n' "$shared_name"
  fi
fi
exit 0
