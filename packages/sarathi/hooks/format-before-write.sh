#!/bin/bash
# PreToolUse handler (Edit|Write): hands the tool prettier-formatted input.
# The handler itself is dist/hooks/format-before-write.js (source:
# src/hooks/format-before-write.ts); this names it beside the others, so a
# hook list runs every handler as `bash "$SARATHI_HOOKS"/<name>.sh`.
exec node "${BASH_SOURCE[0]%/*}/../dist/hooks/format-before-write.js"
