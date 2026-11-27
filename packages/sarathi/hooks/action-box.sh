#!/bin/bash
# PreToolUse handler (mcp__*__publish_version|publish_files|edit_version):
# refuses a direct claude.ai publish whose page has no whole action box.
# The handler itself is dist/hooks/action-box.js (source:
# src/hooks/action-box.ts); this names it beside the others, so a hook list
# runs every handler as `bash "$SARATHI_HOOKS"/<name>.sh`. Run it with
# "failClosed": true: a node that cannot start exits non-zero, not 2.
exec node "${BASH_SOURCE[0]%/*}/../dist/hooks/action-box.js"
