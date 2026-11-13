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
#
# SessionStart installs what package.json pins when node_modules is behind
# it: sarathi, or any other @veda-hq pin at another version. That is a pin
# bump the main checkout has pulled but not installed (the desktop), or a
# cloud session's fresh clone. It runs `pnpm install --frozen-lockfile` in
# $root, one session at a time: a session that finds another's install under
# way waits for it (up to 90 s). An install that fails is said, with its log.
event="${1:?usage: sarathi.sh <Event>}"
root="${CLAUDE_PROJECT_DIR:-$PWD}"
pkg="$root/node_modules/@veda-hq/sarathi"
version_of() { sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "$1" 2>/dev/null | head -n 1; }
pin="$(sed -nE 's/^[[:space:]]*"@veda-hq\/sarathi":[[:space:]]*"([^"]+)".*/\1/p' "$root/package.json" 2>/dev/null | head -n 1)"
inspect() {
  found="$(version_of "$pkg/package.json")"
  real="$(cd "$pkg" 2>/dev/null && pwd -P)"
  case "$real" in "$(cd "$root" && pwd -P)"/packages/*) found="the workspace's own packages/sarathi" ;; esac
  [ -n "$pin" ] && [ "$found" = "$pin" ] && [ -f "$pkg/dist/bin.js" ]
}
# Every exact @veda-hq pin is installed at its version.
pins_current() {
  local name version
  while read -r name version; do
    [ "$(version_of "$root/node_modules/@veda-hq/$name/package.json")" = "$version" ] || return 1
  done < <(sed -nE 's/^[[:space:]]*"@veda-hq\/([a-z0-9-]+)":[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1 \2/p' "$root/package.json" 2>/dev/null)
}
install_pins() {
  local common lock log waited=0
  common="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common="$root"
  lock="$common/sarathi-install.lock"
  log="$common/sarathi-install.log"
  # A lock older than 10 minutes is an install that died: take it over.
  find "$lock" -maxdepth 0 -mmin +10 -exec rmdir {} \; 2>/dev/null
  until mkdir "$lock" 2>/dev/null; do
    [ "$waited" -ge 90 ] && { echo "sarathi.sh: another session's install in $root is still running after 90 s ($lock)." >&2; return 1; }
    sleep 1
    waited=$((waited + 1))
  done
  # Another session may have installed while this one waited.
  if ! { inspect && pins_current; }; then
    if ! (cd "$root" && pnpm install --frozen-lockfile) </dev/null >"$log" 2>&1; then
      echo "sarathi.sh: pnpm install --frozen-lockfile failed in $root; its output is in $log: $(tail -n 1 "$log")" >&2
    fi
  fi
  rmdir "$lock"
}
inspect
current=$?
if [ "$event" = SessionStart ] && [ -n "$pin" ] && ! { [ "$current" -eq 0 ] && pins_current; }; then
  install_pins
  inspect
fi
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
