#!/bin/bash
# PreToolUse (Bash|Edit|Write|Agent|Task|start_session) and PostToolUseFailure handler: shows a lesson
# whose `<!-- when: ... -->` line matches the call, once per session. The
# handler itself is dist/hooks/lessons.js (source: src/hooks/lessons.ts); its
# arguments are lesson folders read beside the package's own lessons/.
exec node "${BASH_SOURCE[0]%/*}/../dist/hooks/lessons.js" "$@"
