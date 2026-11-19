#!/bin/bash
# PreToolUse and SubagentStop handler: the researcher agent's report keeps
# its shape. A report from the researcher (agent type researcher or
# sarathi:researcher) must carry a Verdict line (Settled, Conflicting or Not
# settled), and each line under Claims must name its source (a URL, or a
# repository path) and the date it was read. A Settled or Conflicting verdict
# needs at least one claim. A report that falls short goes back to the agent
# with what is missing.
#
# Claude Code 2.1.271 and later deliver a subagent's report through the
# SubagentHandback tool: PreToolUse on SubagentHandback reads it from
# tool_input.message and refuses the call with exit 2. On older versions the
# report is the subagent's last message: SubagentStop reads
# last_assistant_message and answers decision "block", whose reason the
# subagent gets as its next instruction. A SubagentStop whose subagent used
# SubagentHandback passes, since its last message is not the report then.
#
# The escape: at most two refusals per subagent (agent_id), kept in
# <dir>/<agent id>, where <dir> is SARATHI_REPORT_CHECK_DIR, else
# $XDG_STATE_HOME/sarathi/researcher-report, else
# ~/.local/state/sarathi/researcher-report; a SubagentStop with
# stop_hook_active set passes too. Anything it cannot read passes, silently.
# HOOK_PYTHON is the launcher's interpreter; python3 without one.

PY_SRC=$(cat <<'PYEOF'
import json, os, re, sys

HANDBACK = "SubagentHandback"
RESEARCHERS = {"researcher", "sarathi:researcher"}
MAX_REFUSALS = 2
# Markdown bold and code marks around the labels and the verdict. The
# backtick and the list marker's closing parenthesis are hex escapes (\x60
# \x29): bare, they would break the shell's reading of this $(...) block.
MARKS = re.compile(r"\*\*|__|\x60")
BULLET = r"([-+*]|\d+[.\x29])"
VERDICT = re.compile(r"^\s*" + BULLET + r"?\s*verdict\s*:\s*(settled|conflicting|not settled)\b", re.I | re.M)
CLAIMS = re.compile(r"^\s*" + BULLET + r"?\s*claims\s*:(.*)$", re.I | re.M)
NEXT = re.compile(r"^\s*" + BULLET + r"?\s*next\s*:", re.I | re.M)
ITEM = re.compile(r"^\s*" + BULLET + r"\s+(.*\S)")
NONE = re.compile(r"^\s*(none|n/a|-)\s*\.?\s*$", re.I)
SOURCE = re.compile(
    r"https?://\S+"
    r"|(?<![\w/])[\w.-]+(/[\w.-]+)*\.[A-Za-z][A-Za-z0-9]{0,5}(:\d+(-\d+)?)?(?![\w/])"
)
DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")

def passes():
    sys.exit(0)

def problems(report):
    """What the report lacks, as short phrases; empty when it keeps its shape."""
    text = MARKS.sub("", report)
    verdict = VERDICT.search(text)
    missing = []
    if not verdict:
        missing.append("no Verdict line (Verdict: Settled, Conflicting or Not settled)")
    claims = []
    found = CLAIMS.search(text)
    if found:
        inline = found.group(2).strip()
        if inline and not NONE.match(inline):
            claims.append(inline)
        rest = text[found.end():]
        stop = NEXT.search(rest)
        for line in (rest[: stop.start()] if stop else rest).splitlines():
            item = ITEM.match(line)
            if item and not NONE.match(item.group(2)):
                claims.append(item.group(2))
    needs_claims = verdict and verdict.group(2).lower() != "not settled"
    if needs_claims and not claims:
        missing.append("no claims under Claims for a %s verdict" % verdict.group(2))
    for claim in claims:
        lacks = [what for what, pattern in (("a URL or repository path", SOURCE), ("a read date (YYYY-MM-DD)", DATE)) if not pattern.search(claim)]
        if lacks:
            short = claim if len(claim) <= 80 else claim[:77] + "..."
            missing.append("the claim \x22%s\x22 lacks %s" % (short, " and ".join(lacks)))
    return missing

try:
    data = json.loads(sys.stdin.read() or "{}")
    event = data.get("hook_event_name")
    if data.get("agent_type") not in RESEARCHERS:
        passes()
    if event == "PreToolUse" and data.get("tool_name") == HANDBACK:
        given = data.get("tool_input")
        report = given.get("message") if isinstance(given, dict) else None
    elif event == "SubagentStop":
        if data.get("stop_hook_active") is True:
            passes()
        report = data.get("last_assistant_message")
        transcript = data.get("agent_transcript_path")
        if transcript and os.path.exists(transcript):
            with open(transcript) as handle:
                for line in handle:
                    if HANDBACK in line:
                        entry = json.loads(line)
                        content = (entry.get("message") or {}).get("content")
                        if isinstance(content, list) and any(
                            isinstance(i, dict) and i.get("type") == "tool_use" and i.get("name") == HANDBACK for i in content
                        ):
                            passes()
    else:
        passes()
    if not isinstance(report, str):
        passes()
    missing = problems(report)
except Exception:
    passes()

if not missing:
    passes()

agent = str(data.get("agent_id") or data.get("session_id") or "unknown")
state_dir = os.environ.get("SARATHI_REPORT_CHECK_DIR") or os.path.join(
    os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state"),
    "sarathi", "researcher-report",
)
state = os.path.join(state_dir, re.sub(r"[^A-Za-z0-9._-]", "_", agent))
try:
    refused = 0
    if os.path.exists(state):
        with open(state) as handle:
            refused = int(handle.read().strip() or "0")
    if refused >= MAX_REFUSALS:
        passes()
    os.makedirs(state_dir, exist_ok=True)
    with open(state, "w") as handle:
        handle.write("%d\n" % (refused + 1))
except Exception:
    passes()

reason = (
    "researcher report: " + "; ".join(missing) + ". Hand the report back in "
    "the researcher's shape: a Verdict line (Settled, Conflicting or Not "
    "settled) and the answer; under Claims, one line per claim with its URL "
    "(or the repository path), the version it holds for, and the date read; "
    "then Next. If a claim has no source, drop it or say the verdict is Not "
    "settled."
)
if data.get("hook_event_name") == "SubagentStop":
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)
print("BLOCKED: " + reason, file=sys.stderr)
sys.exit(2)
PYEOF
)
exec "${HOOK_PYTHON:-python3}" -c "$PY_SRC"
