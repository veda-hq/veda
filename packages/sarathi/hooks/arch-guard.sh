#!/bin/bash
# PostToolUse handler for Edit/Write on TypeScript files: runs the session
# checkout's dependency-cruiser rules (.dependency-cruiser.js) on the edited
# file, so a forbidden import is refused at edit time.
# depcruise costs about 2 s, so it runs only when the edit touches imports.
# Exit 2 = the violation goes back to the agent to fix at once.
#
# Runs depcruise in the SESSION's checkout (hook input `cwd`), with that
# checkout's config and node_modules (lib/session-root.sh).

input=$(cat)
file_path=$(jq -r '.tool_input.file_path // ""' <<<"$input")

case "$file_path" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac
[ -f "$file_path" ] || exit 0

# Only pay the depcruise cost when the edit could change the dependency graph
content=$(jq -r '.tool_input.new_string // .tool_input.content // ""' <<<"$input")
if ! grep -qE '(^|\n)[[:space:]]*(import[[:space:]]|export[[:space:]]+.*[[:space:]]from[[:space:]]|.*require\()' <<<"$content"; then
  exit 0
fi

# Checked before sourcing: bash exits on a missing `.` file before any `||`.
lib="$(dirname "$0")/lib/session-root.sh"
# shellcheck source=lib/session-root.sh
if [ ! -r "$lib" ] || ! . "$lib"; then
  echo 'arch-guard: cannot load lib/session-root.sh — blocking edit (guard could not run)' >&2
  exit 2
fi
root=$(session_root "$input" "${CLAUDE_PROJECT_DIR:-$PWD}")
case "$(rel_to_root "$file_path" "$root")" in
  */.claude/* | .claude/* | */.agent/* | .agent/* | */docs/* | docs/* | */scripts/* | scripts/*) exit 0 ;;
esac

cd "$root" || { echo 'arch-guard: cannot cd to repo root — blocking edit (guard could not run)' >&2; exit 2; }
result=$(npx depcruise --config .dependency-cruiser.js "$file_path" 2>&1)
if [ $? -ne 0 ]; then
  {
    echo "ARCHITECTURE VIOLATION in $file_path (this repository's dependency rules, .dependency-cruiser.js):"
    echo "$result" | grep -v '^$' | head -15
    echo "Fix the import structure — do not suppress the rule."
  } >&2
  exit 2
fi

exit 0
