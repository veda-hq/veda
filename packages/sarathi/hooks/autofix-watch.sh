#!/bin/bash
# PostToolUse (Bash|mcp__ccd_pr__set_monitor|mcp__ccd_pr__get_status),
# PostToolUseFailure (mcp__ccd_pr__set_monitor) and Stop handler: the list of
# pull requests this session opened, and a turn-end warning for each open one
# that Auto-fix is not on for. Warn-only. The handler itself is
# dist/hooks/autofix.js (source: src/hooks/autofix.ts).
exec node "${BASH_SOURCE[0]%/*}/../dist/hooks/autofix.js" "$@"
