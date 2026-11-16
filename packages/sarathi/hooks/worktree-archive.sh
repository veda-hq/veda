#!/bin/bash
# PreToolUse (ExitWorktree, set_thread_archived) handler: denies removing or
# archiving a worktree whose work is not safe on the remote. The handler is
# `sarathi worktree hook` (source: src/worktree/hook.ts); list it with
# "failClosed": true, since a removal cannot be undone.
exec node "${BASH_SOURCE[0]%/*}/../dist/bin.js" worktree hook
