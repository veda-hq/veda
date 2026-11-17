#!/bin/bash
# PreToolUse handler: research before you ask. Refuses, once per turn, a
# question to the owner (AskUserQuestion, or a choice-shaped ask in the
# desktop app's wrap_up) when the session has done no research since the
# owner's last message. A hook cannot judge whether research settled the
# question, so it enforces the look, not the verdict, like
# session-dedupe-guard.sh.
#
# Research is a WebSearch, a WebFetch, a browser page read, or the launch of a
# research subagent, since the owner's last message: a user-role entry that
# holds the person's own text, not a tool result, a system reminder, a task
# notification or another session's report. A wrap_up with no ask, a
# go-ahead (yes/no buttons), or an app action first (commit, create_pr ...)
# is an approval, which only the owner can give, and passes.
#
# The escape: a second gated ask in the same turn passes, keyed on the turn
# (the owner's last message), not the question text, so a rephrased question
# does not loop. The key is kept in <dir>/<session id>, where <dir> is
# SARATHI_ASK_GATE_DIR, else $XDG_STATE_HOME/sarathi/ask-gate, else
# ~/.local/state/sarathi/ask-gate.
#
# A pass is a silent exit 0, never an "allow" answer (an allow on
# AskUserQuestion would need updatedInput). Anything it cannot read (input,
# transcript, state) passes. The input is read from stdin, so no size limit
# applies to it. HOOK_PYTHON is the launcher's interpreter; python3 without
# one.

PY_SRC=$(cat <<'PYEOF'
import json, os, re, sys

ASK = "AskUserQuestion"
WRAP_UP = "mcp__ccd_turn__wrap_up"
RESEARCH_TOOLS = {"WebSearch", "WebFetch"}
BROWSER_READ = re.compile(r"^mcp__.*(Claude_Browser|claude-in-chrome)__(get_page_text|read_page|navigate)$")
AGENT_TOOLS = {"Agent", "Task"}
RESEARCH_AGENTS = {"researcher", "sarathi:researcher", "Explore", "general-purpose", "claude-code-guide"}
# A user-role entry the harness marks as not the person's: a background
# task's report, another session's message, an app event that continues the
# turn.
NOT_PERSON_TURNS = {"task_notification", "peer", "auto_continuation"}
NOT_PERSON_KINDS = {"task-notification", "peer"}
# Text the app or the harness puts in a user-role entry, for entries that
# carry no such mark: not the person.
NOT_PERSON = re.compile(
    r"<(system-reminder|task-notification|side-sessions-event|ci-monitor-event|"
    r"local-command-stdout|local-command-stderr|local-command-caveat|"
    r"user-prompt-submit-hook|bash-stdout|bash-stderr)\b[^>]*>.*?</\1>"
    r"|\[Request interrupted by user[^\]]*\]",
    re.S,
)
YES_NO = re.compile(
    r"^\s*(yes|yep|yeah|no|nope|ok|okay|sure|go ahead|do it|proceed|"
    r"not now|not yet|later|skip|cancel|stop|hold|wait|leave it|done)\b",
    re.I,
)
# Words that name alternatives.
ALTERNATIVES = re.compile(r"\b(which|or|how should|either)\b", re.I)
# A bare "A/B" pair: not a path, a URL or owner/repo#N, whose slash sits next
# to another slash, a dot, a colon or #. A shallow path ("src/file") looks the
# same, so the pair counts only when the buttons are not a plain yes or no.
PAIR = re.compile(r"(?<![\w/.:#@~-])[A-Za-z]+/[A-Za-z]+(?![\w/.:#@-])")
# A URL names no alternatives, its query and fragment included: it is read
# out of the ask before either check.
# It ends at whitespace or a bracket or quote, so words glued to it stay.
# The quotes are hex escapes (\x22 \x27 \x60): bare, they would break the
# shell's reading of this $(...) block.
URL = re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s()<>\[\]{}\x22\x27\x60]+", re.I)
# Content a person attaches in place of words.
ATTACHMENTS = {"image", "document"}

def passes():
    sys.exit(0)

try:
    data = json.loads(sys.stdin.read() or "{}")
    tool = data.get("tool_name")
    tool_input = data.get("tool_input")
    path = data.get("transcript_path")
    if tool not in (ASK, WRAP_UP) or not path or not tool_input or not isinstance(tool_input, dict):
        passes()
    with open(path) as handle:
        lines = handle.readlines()
except Exception:
    passes()

def choice_shaped(wrap):
    ask = wrap.get("ask")
    if not isinstance(ask, str) or not ask.strip():
        return False
    actions = wrap.get("actions")
    actions = [a for a in actions if isinstance(a, dict)] if isinstance(actions, list) else []
    if actions and actions[0].get("action"):
        return False
    replies = [a.get("label") for a in actions if not a.get("action") and isinstance(a.get("label"), str)]
    if len([r for r in replies if not YES_NO.match(r)]) >= 2:
        return True
    words = URL.sub(" ", ask)
    if ALTERNATIVES.search(words):
        return True
    go_ahead = bool(replies) and all(YES_NO.match(r) for r in replies)
    return not go_ahead and bool(PAIR.search(words))

try:
    if tool == WRAP_UP and not choice_shaped(tool_input):
        passes()
except Exception:
    passes()

def person_text(content):
    """The person's own words in a user-role message, or "" if none."""
    if isinstance(content, str):
        texts = [content]
    elif isinstance(content, list):
        texts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "tool_result":
                return ""
            if item.get("type") == "text" and isinstance(item.get("text"), str):
                texts.append(item["text"])
            elif item.get("type") in ATTACHMENTS:
                texts.append("[attachment]")
    else:
        return ""
    return NOT_PERSON.sub("", "\n".join(texts)).strip()

def is_owner_message(entry):
    if entry.get("type") != "user" or entry.get("isSidechain") is True:
        return False
    if entry.get("isMeta") is True or entry.get("isCompactSummary") is True:
        return False
    origin = entry.get("origin")
    kind = origin.get("kind") if isinstance(origin, dict) else None
    if entry.get("turnOrigin") in NOT_PERSON_TURNS or kind in NOT_PERSON_KINDS:
        return False
    if entry.get("toolUseResult") is not None or entry.get("sourceToolUseID"):
        return False
    message = entry.get("message") or {}
    if message.get("role") != "user":
        return False
    return person_text(message.get("content")) != ""

def is_research(item):
    if item.get("type") != "tool_use":
        return False
    name = item.get("name")
    if name in RESEARCH_TOOLS or (isinstance(name, str) and BROWSER_READ.match(name)):
        return True
    if name in AGENT_TOOLS:
        given = item.get("input")
        # No subagent_type launches general-purpose.
        return isinstance(given, dict) and (given.get("subagent_type") or "general-purpose") in RESEARCH_AGENTS
    return False

def window(lines):
    """The turn's key (the owner's last message) and whether research followed it."""
    turn, researched = "start", False
    for number, line in enumerate(lines):
        try:
            entry = json.loads(line)
            if not isinstance(entry, dict):
                continue
            if is_owner_message(entry):
                turn, researched = str(entry.get("uuid") or "line-%d" % number), False
                continue
            if entry.get("type") != "assistant" or entry.get("isSidechain") is True:
                continue
            content = (entry.get("message") or {}).get("content")
            if isinstance(content, list) and any(isinstance(i, dict) and is_research(i) for i in content):
                researched = True
        except Exception:
            continue
    return turn, researched

turn, researched = window(lines)
if researched:
    passes()

session = str(data.get("session_id") or os.path.basename(path))
state_dir = os.environ.get("SARATHI_ASK_GATE_DIR") or os.path.join(
    os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state"),
    "sarathi", "ask-gate",
)
state = os.path.join(state_dir, re.sub(r"[^A-Za-z0-9._-]", "_", session))
try:
    with open(state) as handle:
        if handle.read().strip() == turn:
            passes()
except FileNotFoundError:
    pass
except Exception:
    passes()
try:
    os.makedirs(state_dir, exist_ok=True)
    with open(state, "w") as handle:
        handle.write(turn + "\n")
except Exception:
    passes()

print(
    "BLOCKED: research before you ask. No WebSearch, WebFetch, browser page "
    "read or research subagent (researcher, Explore ...) since the owner's "
    "last message. Settle what a source can settle first: the repository, "
    "official docs at the version in use, the changelog, source at a pinned "
    "tag, the issue tracker; read state you can read; check which options "
    "actually work before offering them. If a source settles it, act and "
    "cite it (URL, version, date read) instead of asking. Only the owner can "
    "answer: a preference, an approval or decision of authority, a private "
    "fact, money or credentials, an irreversible step or a shared system, "
    "ambiguity left after research. Research and ask again with what you "
    "found and your recommendation first; if the question is one of those "
    "kinds, ask it again unchanged and it goes through.",
    file=sys.stderr,
)
sys.exit(2)
PYEOF
)
exec "${HOOK_PYTHON:-python3}" -c "$PY_SRC"
