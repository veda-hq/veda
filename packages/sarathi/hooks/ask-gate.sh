#!/bin/bash
# PreToolUse and Stop handler: research before you ask. Holds, once per turn,
# a question to the owner when the session has done no research since the
# owner's last message: an AskUserQuestion or a choice-shaped ask in the
# desktop app's wrap_up (PreToolUse, refused), or a choice-shaped question in
# the closing message (Stop, the turn goes on with the rule as feedback). A
# hook cannot judge whether research settled the question, so it enforces the
# look, not the verdict, like session-dedupe-guard.sh.
#
# Research is a WebSearch, a WebFetch, a browser page read, or the launch of a
# research subagent, since the owner's last message: a user-role entry that
# holds the person's own text, not a tool result, a system reminder, a task
# notification or another session's report. For an ask that names repository
# or session state (a path, a pull request or issue, a branch, a commit, CI),
# a look at that state counts too: Read, Grep, Glob, the desktop app's PR
# status, a read-only git or gh command, or a test run. A wrap_up with no ask,
# a go-ahead (yes/no buttons), or an app action first (commit, create_pr ...)
# is an approval, which only the owner can give, and passes; so does a closing
# question that names no alternatives.
#
# On Stop the question is read from last_assistant_message, not from the
# transcript, which may not hold the final message yet. Stop answers with
# hookSpecificOutput.additionalContext: guidance from a hook working as
# designed, under the same loop protections as a block (stop_hook_active and
# Claude Code's consecutive-continuation cap), without a hook error.
#
# The escape: a second held ask in the same turn passes, keyed on the turn
# (the owner's last message), not the question text, so a rephrased question
# does not loop; the PreToolUse and Stop paths share the key. A Stop with
# stop_hook_active set passes. The key is kept in <dir>/<session id>, where
# <dir> is SARATHI_ASK_GATE_DIR, else $XDG_STATE_HOME/sarathi/ask-gate, else
# ~/.local/state/sarathi/ask-gate.
#
# Every gated ask is a line in the ask log (README, "The ask log"), and so is
# the owner's answer to an AskUserQuestion, read on PostToolUse from
# tool_response.answers.
#
# A pass is a silent exit 0, never an "allow" answer (an allow on
# AskUserQuestion would need updatedInput). Anything it cannot read (input,
# transcript, state) passes. The input is read from stdin, so no size limit
# applies to it. HOOK_PYTHON is the launcher's interpreter; python3 without
# one.

PY_SRC=$(cat <<'PYEOF'
import datetime, json, os, re, sys

ASK = "AskUserQuestion"
WRAP_UP = "mcp__ccd_turn__wrap_up"
STOP = "Stop"
RESEARCH_TOOLS = {"WebSearch", "WebFetch"}
BROWSER_READ = re.compile(r"^mcp__.*(Claude_Browser|claude-in-chrome)__(get_page_text|read_page|navigate)$")
AGENT_TOOLS = {"Agent", "Task"}
RESEARCH_AGENTS = {"researcher", "sarathi:researcher", "Explore", "general-purpose", "claude-code-guide"}
# A look at the repository or the session's state: it counts only for an ask
# that names such state.
LOOK_TOOLS = {"Read", "Grep", "Glob", "mcp__ccd_pr__get_status"}
GIT_READ = re.compile(
    r"^git(\s+(-C|-c)\s+\S+|\s+--no-pager)*\s+(status|log|diff|show|branch|blame|ls-files|ls-remote|ls-tree|"
    r"rev-parse|rev-list|grep|describe|shortlog|reflog|cat-file|merge-base|for-each-ref|name-rev)\b"
)
GH_READ = re.compile(
    r"^gh\s+((pr|issue|run|workflow|release|repo|label|cache)\s+(view|list|checks|status|diff|watch)\b|search\b)"
)
# Forms of those verbs that write: git branch with a mutating flag or a
# branch name to create; reflog expire and delete; an --output file.
GIT_BRANCH_WRITE = {
    "-d", "-D", "-m", "-M", "-c", "-C", "-f", "-u", "--delete", "--move", "--copy", "--force",
    "--set-upstream-to", "--unset-upstream", "--edit-description", "--track", "--no-track", "--create-reflog",
}
GIT_BRANCH_VALUE = {"--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--color", "--column"}
GIT_BRANCH_LIST = {"-l", "--list"}
GIT_REFLOG_WRITE = re.compile(r"^(expire|delete)\b")
# --output and the abbreviations git's option parser takes for it. A short
# -o is no output file: git diff has none, and in git grep and git ls-files
# it reads (--only-matching, --others).
GIT_OUTPUT = re.compile(r"(^|\s)--out(p(u(t)?)?)?(=|\s|$)")
GH_API = re.compile(r"^gh\s+api\b")
# A gh api method counts only when it is a plain GET; a variable ("$METHOD")
# could be anything.
GH_API_METHOD = re.compile(r"\s(-X|--method)(\s+|=)?(\S+)")
GH_API_FIELDS = re.compile(r"\s(-f|-F|--field|--raw-field|--input)\b")
# A package manager's script runs after its flags only: "pnpm --filter x run
# check" is a test run, "pnpm add -D vitest" is not.
TEST_RUN = re.compile(
    r"^((pnpm|npm|yarn|bun)(\s+-\S+(\s+[^-\s]\S*)?)*\s+((run|exec)\s+)?(test|check|vitest|jest)\b|"
    r"npx\s+(vitest|jest)\b|node\s+--test\b|"
    r"python3?\s+-m\s+pytest\b|pytest\b|go\s+test\b|cargo\s+test\b|make\s+(test|check)\b|vitest\b|jest\b)"
)
# Commands and the operators between them. A command after || may not run,
# and neither does one after && that follows a command that cannot succeed.
CHAIN = re.compile(r"(&&|\|\||[;|\n])")
FAILS = re.compile(r"^(false|exit|return)\b")
# What may lead a command: a subshell or group opener, a negation, variable
# assignments, env, time. The openers are hex escapes (\x28 \x7b): bare and
# unbalanced, they would break the shell's reading of this $(...) block.
LEAD = re.compile(r"^[\s\x28\x7b!]*((\w+=\S*|env|time|command)\s+)*")
# An ask that names repository or session state, read with its URLs taken
# out (a docs page is no repository path), save a GitHub pull request, issue,
# run or commit URL. A path needs an extension that starts with a letter
# (not 1.2/1.3); a bare file name, one that is not also a product name
# (Node.js).
STATE_URL = re.compile(r"github\.com/\S+/(pull|issues|actions|commit)/")
STATE = re.compile(
    r"(?<![\w&])#\d+\b|\bPRs?\b|(?i:\bpull requests?\b|\bbranch(es)?\b|\bcommits?\b|\bworkflows?\b)|\bCI\b"
    r"|[\w.-]+/[\w./-]*\.[A-Za-z][A-Za-z0-9]{0,5}\b"
    r"|\b[\w-]+\.(ts|tsx|mjs|cjs|json|md|sh|py|ya?ml|toml|lock|rs|rb|java|kt|swift|css|html|sql)\b"
)
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
# It ends at whitespace, a bracket, a quote, or , ; | so words glued to it
# stay; it keeps a bracketed IPv6 host and balanced parentheses in its path.
# The quotes are hex escapes (\x22 \x27 \x60): bare, they would break the
# shell's reading of this $(...) block.
URL = re.compile(
    r"\b[a-z][a-z0-9+.-]*://(?:\[[0-9a-f:.]+\])?"
    r"(?:[^\s()<>\[\]{}\x22\x27\x60,;|]|\([^\s()<>\[\]{}\x22\x27\x60,;|]*\))+",
    re.I,
)
# In a closing message: fenced code, inline code and quoted lines say no
# question of the session's own; "... or not?" is a yes/no question.
FENCE = re.compile(r"^[ \t]*(\x60{3,}|~{3,})[\s\S]*?(^[ \t]*\1[^\n]*$|\Z)", re.M)
INLINE_CODE = re.compile(r"\x60[^\x60\n]*\x60")
QUOTED = re.compile(r"^[ \t]*>[^\n]*$", re.M)
OR_NOT = re.compile(r"\bor\s+not\b", re.I)
PARAGRAPH = re.compile(r"\n[ \t]*\n")
# A sentence ends at . ! or ? followed by a space, or at a line's end; a dot
# inside a word (file.ts, e.g.) does not end one.
SENTENCE = re.compile(r"(?<=[.!?])\s+|\n")
# How far back from the end of the closing message a question is read.
CLOSING_PARAGRAPHS = 3
# Content a person attaches in place of words.
ATTACHMENTS = {"image", "document"}
# The ask log: one JSON line per gated ask, and one per answer to an
# AskUserQuestion. It moves aside to <log>.1 past LOG_LIMIT bytes.
LOG_OFF = {"0", "false", "off", "no"}
LOG_LIMIT = 5 * 1024 * 1024

def passes():
    sys.exit(0)

def state_dir():
    return os.environ.get("SARATHI_ASK_GATE_DIR") or os.path.join(
        os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state"),
        "sarathi", "ask-gate",
    )

def log(record):
    """Append a line to the ask log. SARATHI_ASK_LOG names the file, or turns
    the log off (0, false, off, no); unset, the log is ask-log.jsonl in the
    state folder. The file is the owner's alone (0600): it holds questions
    and typed answers. A log it cannot write changes nothing."""
    setting = os.environ.get("SARATHI_ASK_LOG", "").strip()
    if setting.lower() in LOG_OFF:
        return
    try:
        target = setting or os.path.join(state_dir(), "ask-log.jsonl")
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        if os.path.exists(target) and os.path.getsize(target) > LOG_LIMIT:
            os.replace(target, target + ".1")
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        line = json.dumps(dict({"time": stamp}, **record), ensure_ascii=False) + "\n"
        handle = os.open(target, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.fchmod(handle, 0o600)
            os.write(handle, line.encode("utf-8"))
        finally:
            os.close(handle)
    except Exception:
        pass

def asked(tool, given):
    """The questions an ask puts, each with its options."""
    if tool == ASK:
        found = []
        for question in given.get("questions") or []:
            if isinstance(question, dict):
                options = [o.get("label") for o in question.get("options") or [] if isinstance(o, dict)]
                found.append({"question": question.get("question"), "options": options})
        return found
    actions = given.get("actions")
    labels = [a.get("label") for a in actions if isinstance(a, dict) and not a.get("action")] if isinstance(actions, list) else []
    return [{"question": given.get("ask"), "options": labels}]

def names_alternatives(text, pairs):
    words = URL.sub(" ", text)
    if ALTERNATIVES.search(words):
        return True
    return pairs and bool(PAIR.search(words))

def names_state(text):
    return bool(STATE_URL.search(text) or STATE.search(URL.sub(" ", text)))

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
    go_ahead = bool(replies) and all(YES_NO.match(r) for r in replies)
    return names_alternatives(ask, not go_ahead)

def closing(message):
    """The choice-shaped questions in the last paragraphs of a closing
    message, fenced code and quoted lines left out, and the paragraphs that
    hold them, code and URLs kept: the words read for repository state."""
    paragraphs = [p for p in PARAGRAPH.split(QUOTED.sub("", FENCE.sub("", message))) if p.strip()]
    found, holding = [], []
    for paragraph in paragraphs[-CLOSING_PARAGRAPHS:]:
        here = []
        for sentence in SENTENCE.split(URL.sub(" ", INLINE_CODE.sub(" ", paragraph))):
            if "?" not in sentence:
                continue
            question = sentence[: sentence.rindex("?") + 1].strip()
            if names_alternatives(OR_NOT.sub(" ", question), False):
                here.append(question)
        if here:
            found += here
            holding.append(paragraph)
    return "\n\n".join(holding), found

def ask_words(tool, given):
    """The words of an ask: its question, header, options and buttons."""
    parts = []
    if tool == ASK:
        for question in given.get("questions") or []:
            if not isinstance(question, dict):
                continue
            parts += [question.get("question"), question.get("header")]
            for option in question.get("options") or []:
                if isinstance(option, dict):
                    parts += [option.get("label"), option.get("description")]
    else:
        parts.append(given.get("ask"))
        actions = given.get("actions")
        for action in actions if isinstance(actions, list) else []:
            if isinstance(action, dict):
                parts.append(action.get("label"))
    return "\n".join(p for p in parts if isinstance(p, str))

try:
    data = json.loads(sys.stdin.read() or "{}")
    path = data.get("transcript_path")
    if data.get("hook_event_name") == "PostToolUse":
        # The owner's answer: AskUserQuestion's result maps each question's
        # text to the chosen label, or labels, or typed text. The input may
        # carry the map too, when a hook answered for the owner.
        response = data.get("tool_response")
        answers = response.get("answers") if isinstance(response, dict) else None
        given = data.get("tool_input")
        if not isinstance(answers, dict) and isinstance(given, dict):
            answers = given.get("answers")
        if data.get("tool_name") == ASK and isinstance(answers, dict):
            log({
                "session": str(data.get("session_id") or os.path.basename(path or "")),
                "via": "answer",
                "tool_use_id": data.get("tool_use_id"),
                "answers": answers,
            })
        passes()
    if not path:
        passes()
    if data.get("hook_event_name") == STOP:
        stop = True
        message = data.get("last_assistant_message")
        if data.get("stop_hook_active") is True or not isinstance(message, str):
            passes()
        # The words read for state are the question's own paragraph: "PR #12
        # failed CI. Retry it or revert?" Wider, a closing summary that names
        # a file or a commit would pass most held questions.
        words, choices = closing(message)
        if not choices:
            passes()
    else:
        stop = False
        tool = data.get("tool_name")
        tool_input = data.get("tool_input")
        if tool not in (ASK, WRAP_UP) or not tool_input or not isinstance(tool_input, dict):
            passes()
        if tool == WRAP_UP and not choice_shaped(tool_input):
            passes()
        words = ask_words(tool, tool_input)
        questions = asked(tool, tool_input)
    if stop:
        questions = [{"question": choice, "options": []} for choice in choices]
    with open(path) as handle:
        lines = handle.readlines()
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
    name = item.get("name")
    if name in RESEARCH_TOOLS or (isinstance(name, str) and BROWSER_READ.match(name)):
        return True
    if name in AGENT_TOOLS:
        given = item.get("input")
        # No subagent_type launches general-purpose.
        return isinstance(given, dict) and (given.get("subagent_type") or "general-purpose") in RESEARCH_AGENTS
    return False

def git_reads(segment):
    found = GIT_READ.match(segment)
    if not found or GIT_OUTPUT.search(segment):
        return False
    verb, rest = found.group(3), segment[found.end():].split()
    if verb == "reflog":
        return not GIT_REFLOG_WRITE.match(" ".join(rest))
    if verb != "branch":
        return True
    listing, takes_value = False, False
    for word in rest:
        if takes_value:
            takes_value = False
        elif word in GIT_BRANCH_WRITE or word.split("=")[0] in GIT_BRANCH_WRITE:
            return False
        elif word in GIT_BRANCH_LIST or word == "--show-current":
            listing = True
        elif word in GIT_BRANCH_VALUE:
            takes_value = True
        elif not word.startswith("-") and not listing:
            return False
    return True

def gh_api_reads(segment):
    if not GH_API.match(segment):
        return False
    method = GH_API_METHOD.search(segment)
    if method:
        return method.group(3).strip("\x22\x27").upper() == "GET"
    return not GH_API_FIELDS.search(segment)

def reads_state(command):
    """Whether a shell command reads repository or session state, in a
    command that surely runs."""
    parts = CHAIN.split(command)
    dead = False
    for index in range(0, len(parts), 2):
        operator = parts[index - 1] if index else ";"
        segment = LEAD.sub("", parts[index]).strip()
        runs = operator != "||" and not (operator == "&&" and dead)
        dead = (dead and operator == "&&") or bool(FAILS.match(segment))
        if runs and (git_reads(segment) or GH_READ.match(segment) or TEST_RUN.match(segment) or gh_api_reads(segment)):
            return True
    return False

def is_look(item):
    name = item.get("name")
    if name in LOOK_TOOLS:
        return True
    given = item.get("input")
    return name == "Bash" and isinstance(given, dict) and isinstance(given.get("command"), str) and reads_state(given["command"])

def window(lines):
    """The turn's key (the owner's last message), and whether research and a
    look at the repository's state followed it."""
    turn, researched, looked = "start", False, False
    for number, line in enumerate(lines):
        try:
            entry = json.loads(line)
            if not isinstance(entry, dict):
                continue
            if is_owner_message(entry):
                turn, researched, looked = str(entry.get("uuid") or "line-%d" % number), False, False
                continue
            if entry.get("type") != "assistant" or entry.get("isSidechain") is True:
                continue
            content = (entry.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for item in content:
                if isinstance(item, dict) and item.get("type") == "tool_use":
                    researched = researched or is_research(item)
                    looked = looked or is_look(item)
        except Exception:
            continue
    return turn, researched, looked

turn, researched, looked = window(lines)
session = str(data.get("session_id") or os.path.basename(path))
state_names = bool(names_state(words))
record = {
    "session": session,
    "turn": turn,
    "via": STOP if stop else tool,
    "tool_use_id": None if stop else data.get("tool_use_id"),
    "questions": questions,
    "researched": researched,
    "looked": looked,
    "names_state": state_names,
    # The kind an ask declares; #224 fills it.
    "kind": None,
}
if researched or (looked and state_names):
    log(dict(record, outcome="passed: research" if researched else "passed: look"))
    passes()

folder = state_dir()
state = os.path.join(folder, re.sub(r"[^A-Za-z0-9._-]", "_", session))
try:
    with open(state) as handle:
        if handle.read().strip() == turn:
            log(dict(record, outcome="passed: second ask"))
            passes()
except FileNotFoundError:
    pass
except Exception:
    log(dict(record, outcome="passed: state unreadable"))
    passes()
try:
    os.makedirs(folder, exist_ok=True)
    with open(state, "w") as handle:
        handle.write(turn + "\n")
except Exception:
    log(dict(record, outcome="passed: state unwritable"))
    passes()
log(dict(record, outcome="held"))

LOOKED = (
    "Since the owner's last message there has been no WebSearch, WebFetch, "
    "browser page read or research subagent (researcher, Explore ...), and for "
    "a question about the repository or its state (a path, a pull request, a "
    "branch, a commit, CI) no Read, Grep, Glob, read-only git or gh, or test "
    "run either. "
)
RULE = (
    "Settle what a source can settle first: the repository, "
    "official docs at the version in use, the changelog, source at a pinned "
    "tag, the issue tracker; read state you can read; check which options "
    "actually work before offering them. If a source settles it, act and "
    "cite it (URL, version, date read) instead of asking. Only the owner can "
    "answer: a preference, an approval or decision of authority, a private "
    "fact, money or credentials, an irreversible step or a shared system, "
    "ambiguity left after research. "
)
if stop:
    reason = (
        "research before you ask. Your closing message asks the owner to "
        "choose (" + " / ".join(choices)[:300] + "). " + LOOKED + RULE +
        "Research and end the turn again with what you found and your "
        "recommendation first. If the question is one of those kinds, end "
        "the turn again and it goes through: the owner already sees the "
        "question, so do not repeat it."
    )
    print(json.dumps({"hookSpecificOutput": {"hookEventName": STOP, "additionalContext": reason}}))
    sys.exit(0)
print(
    "BLOCKED: research before you ask. " + LOOKED + RULE +
    "Research and ask again with what you "
    "found and your recommendation first; if the question is one of those "
    "kinds, ask it again unchanged and it goes through.",
    file=sys.stderr,
)
sys.exit(2)
PYEOF
)
exec "${HOOK_PYTHON:-python3}" -c "$PY_SRC"
