#!/bin/bash
# The one hook per event: runs `sarathi hook <Event>`, which runs the handlers
# .claude/sarathi.json lists for that event, kavach's guards among them, and
# answers Claude Code once.
#
# sarathi loads only from $CLAUDE_PROJECT_DIR's node_modules, at the version
# package.json pins, installed from the registry. On the desktop
# $CLAUDE_PROJECT_DIR is the main checkout, which the worktree guard keeps a
# worktree session out of, so a session cannot swap the guards it runs under.
# Never packages/sarathi, linked in place of the pin: that is the source the
# session edits.
#
# sarathi missing, at another version, or linked from packages/: PreToolUse
# refuses and says to install; other events warn and go ahead. A PreToolUse
# sarathi that crashes refuses too: Claude Code lets a hook's exit 1 through.
event="${1:?usage: sarathi.sh <Event>}"
root="${CLAUDE_PROJECT_DIR:-$PWD}"
pkg="$root/node_modules/@veda-hq/sarathi"
version_of() { sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "$1" 2>/dev/null | head -n 1; }
pin="$(sed -nE 's/^[[:space:]]*"@veda-hq\/sarathi":[[:space:]]*"([^"]+)".*/\1/p' "$root/package.json" 2>/dev/null | head -n 1)"
found="$(version_of "$pkg/package.json")"
real="$(cd "$pkg" 2>/dev/null && pwd -P)"
case "$real" in "$(cd "$root" && pwd -P)"/packages/*) found="the workspace's own packages/sarathi" ;; esac
if [ -z "$pin" ] || [ "$found" != "$pin" ] || [ ! -f "$pkg/dist/bin.js" ]; then
  why="sarathi ${pin:-(no pin in package.json)} is not installed in $root (found ${found:-nothing}); run pnpm install there"
  if [ "$event" = PreToolUse ]; then
    echo "BLOCKED: $why. No guard ran." >&2
    exit 2
  fi
  echo "sarathi.sh: $why. No $event handler ran." >&2
  exit 1
fi
node "$pkg/dist/bin.js" hook "$event"
code=$?
if [ "$event" = PreToolUse ] && [ "$code" -ne 0 ] && [ "$code" -ne 2 ]; then
  echo "BLOCKED: sarathi ended with exit $code, so no guard judged this call." >&2
  exit 2
fi
exit "$code"
