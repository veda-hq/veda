#!/bin/bash
# PostToolUse handler for Edit/Write on TypeScript files: refuses the escape
# hatches a strict TypeScript codebase forbids (@ts-ignore, @ts-nocheck,
# eslint-disable, `any`, skipped tests), so the agent fixes the cause at once.
# Exit 2 = the reason goes back to the agent as an error it must address.

set -euo pipefail

input=$(cat)
file_path=$(jq -r '.tool_input.file_path // ""' <<<"$input")

case "$file_path" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac

# Agent, skill and doc sources may legitimately mention the patterns. Judged
# relative to the session's checkout: a desktop worktree sits under
# <main>/.claude/worktrees/, so its absolute paths all match `*/.claude/*`.
# Checked before sourcing: bash exits on a missing `.` file before any `||`.
lib="$(dirname "$0")/lib/session-root.sh"
# shellcheck source=lib/session-root.sh
if [ ! -r "$lib" ] || ! . "$lib"; then
  echo 'code-quality-guard: cannot load lib/session-root.sh — blocking edit (guard could not run)' >&2
  exit 2
fi
root=$(session_root "$input" "${CLAUDE_PROJECT_DIR:-$PWD}")
case "$(rel_to_root "$file_path" "$root")" in
  */.claude/* | .claude/* | */.agent/* | .agent/* | */docs/* | docs/*) exit 0 ;;
esac

content=$(jq -r '.tool_input.new_string // .tool_input.content // ""' <<<"$input")
[ -z "$content" ] && exit 0

violations=()

grep -qE '@ts-ignore|@ts-nocheck' <<<"$content" && violations+=("@ts-ignore/@ts-nocheck forbidden (strict mode: fix the type error)")
grep -qE 'eslint-disable' <<<"$content" && violations+=("eslint-disable forbidden (fix the source, not the linter)")
grep -qE ':[[:space:]]*any\b|\bas[[:space:]]+any\b' <<<"$content" && violations+=("'any' type forbidden (use a precise type, unknown, or a generic)")
grep -qE '\b(describe|it|test)\.skip\(|\bxit\(|\bxtest\(|\bxdescribe\(' <<<"$content" && violations+=("skipped tests forbidden (every test runs: fix or delete it)")

if [ ${#violations[@]} -gt 0 ]; then
  {
    echo "CODE QUALITY VIOLATION in $file_path — fix before proceeding:"
    for v in "${violations[@]}"; do echo "  - $v"; done
  } >&2
  exit 2
fi

exit 0
