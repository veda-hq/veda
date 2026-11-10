#!/bin/bash
# Sourced by sarathi's shell handlers: which checkout is the session's.
#
# The Claude desktop app launches worktree sessions with
# `--project-config-root <main checkout>`. Every hook then runs with its cwd
# and $CLAUDE_PROJECT_DIR set to the MAIN checkout, so neither of those names
# the checkout the session works in. The hook input's `cwd` still does.

# session_root <hook-input-json> <fallback-dir>
#   The git toplevel of the input's `cwd`; <fallback-dir> when the input has
#   no usable `cwd` (absent, not a directory, not inside a work tree).
session_root() {
  local cwd root
  cwd=$(jq -r 'if (.cwd | type) == "string" then .cwd else "" end' <<<"$1" 2>/dev/null) || cwd=""
  if [ -n "$cwd" ] && [ -d "$cwd" ]; then
    root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || root=""
    if [ -n "$root" ]; then
      printf '%s\n' "$root"
      return 0
    fi
  fi
  printf '%s\n' "$2"
}

# rel_to_root <path> <root>
#   <path> relative to <root> when it lies inside it, else <path> unchanged.
#   Compared physically: git prints a resolved toplevel (/private/tmp on
#   macOS), the tools a logical path. Path filters must use this, because the
#   desktop app's worktrees live under <main>/.claude/worktrees/ and an
#   absolute path there always matches `*/.claude/*`.
rel_to_root() {
  local dir real_root base
  dir=$(cd "$(dirname "$1")" 2>/dev/null && pwd -P) || { printf '%s\n' "$1"; return 0; }
  real_root=$(cd "$2" 2>/dev/null && pwd -P) || { printf '%s\n' "$1"; return 0; }
  base=$(basename "$1")
  case "$dir" in
    "$real_root") printf '%s\n' "$base" ;;
    "$real_root"/*) printf '%s\n' "${dir#"$real_root"/}/$base" ;;
    *) printf '%s\n' "$1" ;;
  esac
}
