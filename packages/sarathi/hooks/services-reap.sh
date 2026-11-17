#!/bin/bash
# SessionStart handler: removes the Docker services of deleted worktrees.
#
# Archiving a conversation deletes its worktree but leaves the Compose project
# `sarathi services` started there running, with its volume. No repository
# hook sees a desktop-app archive, so each session start sweeps the projects
# whose worktree directory is gone (`sarathi services reap`, source:
# src/services/reaper.ts). Live worktrees are untouched: the rule is
# "directory gone".
#
# Detached, so session start never waits on Docker; its output is discarded
# (the sweep keeps its own log in the git common dir). Only where `docker` is
# on PATH. Always exits 0.
command -v docker >/dev/null 2>&1 || exit 0
nohup node "${BASH_SOURCE[0]%/*}/../dist/bin.js" services reap </dev/null >/dev/null 2>&1 &
exit 0
