#!/bin/bash
# PostToolUse handler: formats every edited or written file with the session
# checkout's prettier, so a commit-time format check finds nothing to fix.
# Never blocks: formatting problems surface at commit time anyway.
# format-before-write is the first line; this is the net for what it skips.

input=$(cat)
file_path=$(jq -r '.tool_input.file_path // ""' <<<"$input")

[ -z "$file_path" ] && exit 0
[ -f "$file_path" ] || exit 0

# Never format through a symlink. Only the leaf's PARENT is resolved below, so
# a link sitting inside the checkout could otherwise name a target outside it
# and be judged by where the link lives rather than what it rewrites.
[ -L "$file_path" ] && exit 0

# Skip local scratch and tmp artifacts: nothing there is ever committed.
case "$file_path" in
  */.local/* | .local/* | */.tmp/* | .tmp/*) exit 0 ;;
esac

# Skip anything outside this checkout. Agent memory is writable and is
# markdown, so it would otherwise be reflowed by this repository's prettier
# settings, which are not its own.
#
# Both sides are resolved PHYSICALLY (pwd -P) before comparing. A lexical
# compare breaks whenever the checkout is reached through a symlink (on macOS
# /tmp is /private/tmp), classifying a repository file as outside or a file
# merely *named* under the repository as inside.
#
# "This checkout" is the SESSION's (hook input `cwd`), not
# $CLAUDE_PROJECT_DIR: the desktop app sets that to the main checkout for a
# worktree session, and every desktop worktree lies under main
# (lib/session-root.sh).
lib="$(dirname "$0")/lib/session-root.sh"
# shellcheck source=lib/session-root.sh
[ -r "$lib" ] && . "$lib" || exit 0
repo_root=$(session_root "$input" "${CLAUDE_PROJECT_DIR:-$PWD}")
repo_root=$(cd "$repo_root" && pwd -P) || exit 0
file_dir=$(cd "$(dirname "$file_path")" 2>/dev/null && pwd -P) || exit 0
case "$file_dir" in
  "$repo_root" | "$repo_root"/*) ;;
  *) exit 0 ;;
esac

# The session checkout's prettier; a fresh worktree has no node_modules until
# its first install, so then the project checkout's. Either way it runs in the
# session checkout, so that checkout's config and .prettierignore decide.
prettier="$repo_root/node_modules/.bin/prettier"
[ -x "$prettier" ] || prettier="${CLAUDE_PROJECT_DIR:-$repo_root}/node_modules/.bin/prettier"

case "$file_path" in
  *.ts | *.tsx | *.js | *.jsx | *.json | *.md | *.yml | *.yaml | *.css)
    cd "$repo_root" && "$prettier" --write --ignore-unknown "$file_path" >/dev/null 2>&1 || true
    ;;
esac

exit 0
