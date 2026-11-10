#!/bin/bash
# PreToolUse handler: look before starting a session. Refuses create_session
# and start_session unless this conversation called list_sessions, and got a
# result that is not an error, in the last LOOK_WINDOW_MINUTES (two sessions
# fixing the same bug minutes apart is what it stops). A hook cannot call
# list_sessions itself, so it enforces the look, not the verdict.
# start_session is judged only where the transcript records list_sessions as
# available (a deferred-tools entry naming it, or a call to it), so a desktop
# session without the tool is never stuck. Anything it cannot read (input,
# transcript) is allowed.
#
# The input is read from stdin, so no size limit applies to it.
# HOOK_PYTHON is the launcher's interpreter; python3 without one.

PY_SRC=$(cat <<'PYEOF'
import datetime, json, sys

LOOK_WINDOW_MINUTES = 15
LIST = "mcp__claude-code-remote__list_sessions"
CREATE = "mcp__claude-code-remote__create_session"
START = "mcp__ccd_session__start_session"

try:
    data = json.loads(sys.stdin.read() or "{}")
    tool = data.get("tool_name")
    path = data.get("transcript_path")
    if tool not in (CREATE, START) or not path:
        sys.exit(0)
    with open(path) as handle:
        lines = handle.readlines()
except Exception:
    sys.exit(0)

calls, good, listed = {}, set(), False
for line in lines:
    try:
        entry = json.loads(line)
        record = entry.get("attachment") or {}
        content = (entry.get("message") or {}).get("content")
    except Exception:
        continue
    if isinstance(record, dict) and record.get("type") == "deferred_tools_record":
        for tool_entry in record.get("entries") or []:
            if isinstance(tool_entry, dict) and tool_entry.get("name") == LIST:
                listed = True
    if not isinstance(content, list):
        continue
    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "tool_use" and item.get("name") == LIST:
            calls[item.get("id")] = entry.get("timestamp")
        elif item.get("type") == "tool_result" and item.get("is_error") is not True:
            good.add(item.get("tool_use_id"))

# The tool is available when the transcript records it (a deferred-tools entry
# naming it, or a call to it), not when some text merely mentions its name.
if tool == START and not listed and not calls:
    sys.exit(0)

now = datetime.datetime.now(datetime.timezone.utc)
for use_id, stamp in calls.items():
    if use_id not in good or not isinstance(stamp, str):
        continue
    try:
        when = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        continue
    if now - when <= datetime.timedelta(minutes=LOOK_WINDOW_MINUTES):
        sys.exit(0)

print(
    "BLOCKED: before starting a session, look for one already doing this work: "
    "call " + LIST + " (mine: true), read its titles, and start only if none "
    "covers it; then retry. A look counts for " + str(LOOK_WINDOW_MINUTES)
    + " minutes. Why: two sessions doing the same work duplicate it.",
    file=sys.stderr,
)
sys.exit(2)
PYEOF
)
exec "${HOOK_PYTHON:-python3}" -c "$PY_SRC"
