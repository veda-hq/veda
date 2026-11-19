#!/usr/bin/env bash
# veda's pinned guards: released-pins, pariksha's boundary and required
# settings, and sarathi's check of the hook settings. Every one is an
# installed release (released-pins checks that first), never packages/*/src.
#
# .githooks/pre-push runs this file itself, and `pnpm guards` runs it for
# `pnpm check` and CI. The hook reads nothing from package.json's scripts,
# so the guards line cannot be changed there to skip them. The hook runs the
# worktree's own copy, so kavach keeps this file, with the hooks, from agent
# sessions once .claude/kavach.json lists it in worktree.protectedPaths
# (veda#235).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
bin="$root/node_modules/.bin"
node scripts/released-pins.mjs
"$bin/pariksha" boundary
"$bin/pariksha" required-settings --require .veda/required-settings.json
"$bin/pariksha" required-settings --require node_modules/@veda-hq/pariksha/baselines/claude-settings.json
"$bin/sarathi" check --settings .claude/settings.json
