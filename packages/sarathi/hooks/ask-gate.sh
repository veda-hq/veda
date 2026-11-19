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
# notification or another session's report. For an ask about repository or
# session state, a look at that state counts too: Read, Grep, Glob, the
# desktop app's PR status, a read-only git or gh command, or a test run. It
# counts when every unit of the ask (each AskUserQuestion question, a wrap_up
# ask, a closing question's paragraph) names such state (a path, a pull
# request or issue, a branch, a commit, CI) and nothing outside the
# repository (an API, a price, credentials, an outside service by name, its
# documentation). A wrap_up with no ask,
# a go-ahead (yes/no buttons), or an app action first (commit, create_pr ...)
# is an approval, which only the owner can give, and passes; so does a closing
# question that names no alternatives.
#
# On Stop, first: a closing message that asks the owner (a line opening
# "Needs you:", or one that ends on a question) in a turn whose wrap_up
# carried no ask goes on once, told to make the ask, where the session has
# the desktop app's wrap_up (README, "An ask the app does not see").
#
# On Stop the question is read from last_assistant_message, not from the
# transcript, which may not hold the final message yet. Stop answers with
# hookSpecificOutput.additionalContext: guidance from a hook working as
# designed, under the same loop protections as a block (stop_hook_active and
# Claude Code's consecutive-continuation cap), without a hook error.
#
# The escape: a second held ask in the same turn passes, keyed on the turn
# (the owner's last message), not the question text, so a rephrased question
# does not loop; the PreToolUse and Stop paths share the key. The one
# exception is a relabel: an ask that puts a question held this turn with
# only its Kind: fields added or changed is held once more, and anything
# after that passes, so a turn holds at most twice. A Stop with
# stop_hook_active set passes. The key, and the questions held, are kept in
# <dir>/<session id>, where <dir> is SARATHI_ASK_GATE_DIR, else
# $XDG_STATE_HOME/sarathi/ask-gate, else ~/.local/state/sarathi/ask-gate.
#
# A declared owner-only kind passes the first time: a line Kind: <kind> in
# each AskUserQuestion question (its text or header), in the wrap_up ask, or
# in the closing paragraphs on Stop, naming approval, money or irreversible;
# or preference, private or ambiguity after research or a look in the turn
# (README, "Declaring the kind"). A declared researchable kind stays held,
# and so does a relabel.
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
# An ask that names something outside the repository: an API or SDK, a
# price, a bill or a quota, credentials, one of the outside tools and
# services listed by name, their documentation or releases, case ignored.
# No repository read settles such a question, so a look does not count for
# it, whatever state it also names. A path or file named like one
# (CHANGELOG.md, credentials.json, src/api/) is no such word. Words a
# trade-off uses for the repository's own work (cost, docs-only, login,
# endpoint) are left out: in local transcripts they named it more often
# than anything outside. A service not listed is not seen.
OUTSIDE = re.compile(
    r"\$\s?\d"
    r"|(?i:\b(apis?|sdks?|prices?|pricing|priced|billing|billed|credits|quotas?|subscriptions?|rate[ -]limits?"
    r"|per (million|1k|1m|token)|credentials?|keychain|oauth"
    r"|claude code|claude\.ai|anthropic|openai|marketplaces?|homebrew"
    r"|(latest|newest) (version|release)|release notes|changelogs?|documentation)\b(?![./]\w))"
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
# A declared kind: a field Kind: <kind> at the start of a line, after the end
# of a sentence, or after an opening parenthesis (\x28), its value running to
# the line end or a . ; or closing parenthesis (\x29). The whole value names
# the kind: a word, or the row of the research-first table it comes from.
DECLARED = re.compile(r"(?:^|(?<=[.?!])[ \t]+|\x28)[ \t>*_-]*kind:[ \t]*([^\n.;\x29]*)", re.I | re.M)
OWNER_KINDS = {
    "preference": "preference", "taste": "preference", "preference or taste": "preference",
    "approval": "approval", "authority": "approval", "decision": "approval",
    "authority or approval": "approval",
    "private": "private", "private fact": "private", "undocumented fact": "private",
    "private or undocumented fact": "private",
    "money": "money", "credentials": "money", "spending": "money", "money or credentials": "money",
    "irreversible": "irreversible", "irreversible step": "irreversible", "shared system": "irreversible",
    "irreversible steps or shared systems": "irreversible",
    "ambiguity": "ambiguity", "ambiguity left after research": "ambiguity",
}
# Kinds a source settles: declared, the ask stays held.
RESEARCHABLE_KINDS = {
    "api": "api", "api behaviour": "api", "api behavior": "api", "default": "default", "defaults": "default",
    "version": "version", "version facts": "version", "limit": "limit", "limits": "limit",
    "error": "error", "error meanings": "error", "convention": "convention", "conventions": "convention",
    "repository conventions": "convention", "state": "state",
}
# Kinds that pass only after research or a look in the turn: a preference
# among options nobody checked, a private fact the session could have read,
# and ambiguity, the kind left after research. An approval, money and an
# irreversible step are the owner's authority, and pass bare.
NEEDS_LOOK = {"ambiguity", "preference", "private"}

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
        import fcntl
        target = setting or os.path.join(state_dir(), "ask-log.jsonl")
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        payload = (json.dumps(dict({"time": stamp}, **record), ensure_ascii=False) + "\n").encode("utf-8")
        # One writer at a time: the size check, the move aside and the append
        # hold a lock, so two hooks at once neither race the move nor lose a
        # line.
        lock = os.open(target + ".lock", os.O_WRONLY | os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                if os.path.getsize(target) > LOG_LIMIT:
                    # The file moved aside stays the owner's alone too.
                    os.chmod(target, 0o600)
                    os.replace(target, target + ".1")
            except FileNotFoundError:
                pass
            handle = os.open(target, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                os.fchmod(handle, 0o600)
                written = 0
                while written < len(payload):
                    count = os.write(handle, payload[written:])
                    if count <= 0:
                        raise OSError("the ask log took no bytes")
                    written += count
            finally:
                os.close(handle)
        finally:
            os.close(lock)
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

def kinds(text):
    """The kinds a text declares, in order: the kind a known value names, or
    the value as written, lowercase."""
    found = []
    for match in DECLARED.finditer(text or ""):
        value = normalised(match)
        if value:
            found.append(OWNER_KINDS.get(value) or RESEARCHABLE_KINDS.get(value) or value[:40])
    return found

def normalised(match):
    value = re.sub(r"[\s-]+", " ", match.group(1).strip(" \t*_").lower()).strip()
    return re.sub(r"^an? ", "", value)

def known_declaration(match):
    """A declaration of a known kind reads as no words of the ask; any other
    stays in place, so its value is still read for alternatives."""
    value = normalised(match)
    return " " if value in OWNER_KINDS or value in RESEARCHABLE_KINDS else match.group(0)

def owner_only(declared, looked):
    """Whether a unit of an ask declares only owner-only kinds."""
    return bool(declared) and all(k in OWNER_KINDS.values() and (k not in NEEDS_LOOK or looked) for k in declared)

def names_alternatives(text, pairs):
    words = URL.sub(" ", DECLARED.sub(known_declaration, text))
    if ALTERNATIVES.search(words):
        return True
    return pairs and bool(PAIR.search(words))

def names_state(text):
    return bool(STATE_URL.search(text) or STATE.search(URL.sub(" ", text)))

def names_outside(text):
    return bool(OUTSIDE.search(URL.sub(" ", text)))

def unit_words(tool, given):
    """The words of each unit of an ask, read for state: each
    AskUserQuestion question with its header and options; a wrap_up, whole."""
    if tool != ASK:
        return [ask_words(tool, given)]
    units = []
    for question in given.get("questions") or []:
        if isinstance(question, dict):
            units.append(ask_words(ASK, {"questions": [question]}))
    return units or [""]

def plain(text):
    """A question as the relabel check compares it: its Kind: fields out,
    lowercase, words only."""
    text = DECLARED.sub(" ", text) if isinstance(text, str) else ""
    return " ".join(re.sub(r"[^\w]+", " ", text.lower()).split())

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

def closing_paragraphs(message):
    """The last paragraphs of a closing message, fenced code and quoted lines
    left out."""
    paragraphs = [p for p in PARAGRAPH.split(QUOTED.sub("", FENCE.sub("", message))) if p.strip()]
    return paragraphs[-CLOSING_PARAGRAPHS:]

def closing(message):
    """The choice-shaped questions in the last paragraphs of a closing
    message, the paragraphs that hold them, code and URLs kept (the words
    read for repository state, one paragraph each), and for each question
    the index of its paragraph."""
    found, holding, where = [], [], []
    for paragraph in closing_paragraphs(message):
        here = []
        for sentence in SENTENCE.split(URL.sub(" ", INLINE_CODE.sub(" ", paragraph))):
            if "?" not in sentence:
                continue
            question = sentence[: sentence.rindex("?") + 1].strip()
            if names_alternatives(OR_NOT.sub(" ", question), False):
                here.append(question)
        if here:
            found += here
            where += [len(holding)] * len(here)
            holding.append(paragraph)
    return holding, found, where

# A closing message that waits on the owner: a line that opens "Needs you:"
# (bold or not), or a line that ends asking. Text in double quotes is someone
# else's words, a title or a quoted prompt; a question answered on its own
# line ("**Can it close?** Yes, once ...") does not end that line.
NEEDS_YOU = re.compile(r"^[ \t>*_#-]*needs you[*_]*[ \t]*:", re.I | re.M)
QUOTES = re.compile(r"\x22[^\x22\n]*\x22|“[^”\n]*”")
ENDS_ASKING = re.compile(r"\?[\s*_\x29\]]*$")
# The desktop app lists its wrap_up here for the session's hooks.
APP_TOOLS = "CLAUDE_CODE_TERMINAL_MCP_TOOLS"

def url_out(match):
    """A URL taken out of a line, the question marks it ends in kept."""
    url = match.group(0)
    return " " + url[len(url.rstrip("?")):]

def owner_ask(message):
    """The line of a closing message that asks the owner something, from its
    last paragraphs, or None: one opening "Needs you:", else the first that
    ends on a question, with code, URLs and quoted text left out."""
    asking = None
    for paragraph in closing_paragraphs(message):
        for line in paragraph.split("\n"):
            if NEEDS_YOU.search(line):
                return line.strip()
            # A URL goes, but a question mark that ends it stays: the
            # sentence's own ("Should we open https://example.com?").
            text = QUOTES.sub(" ", URL.sub(url_out, INLINE_CODE.sub(" ", line)))
            if asking is None and ENDS_ASKING.search(text):
                asking = line.strip()
    return asking

def wrap_up_calls(entry):
    """The wrap_up calls in a main-loop assistant entry."""
    if not isinstance(entry, dict) or entry.get("type") != "assistant" or entry.get("isSidechain") is True:
        return []
    content = (entry.get("message") or {}).get("content")
    return [
        item for item in (content if isinstance(content, list) else [])
        if isinstance(item, dict) and item.get("type") == "tool_use" and item.get("name") == WRAP_UP
    ]

def has_wrap_up(lines):
    """Whether this session has the app's wrap_up: the desktop app names it
    for the hooks, or the session has called it. A line that only mentions
    the name (a file read, a settings file) is no call."""
    if WRAP_UP in re.split(r"[\s,]+", os.environ.get(APP_TOOLS, "")):
        return True
    for line in lines:
        if WRAP_UP not in line:
            continue
        try:
            if wrap_up_calls(json.loads(line)):
                return True
        except Exception:
            continue
    return False

def is_peer(entry):
    """Another session's message, by the origin the harness stamps on it."""
    origin = entry.get("origin")
    kind = origin.get("kind") if isinstance(origin, dict) else None
    return kind in ("peer", "peer-send-message") or entry.get("turnOrigin") == "peer"


def is_task_report(entry):
    """A background task's notification, by its origin or its leading tag."""
    origin = entry.get("origin")
    if (origin.get("kind") if isinstance(origin, dict) else None) == "task-notification":
        return True
    if entry.get("turnOrigin") == "task_notification":
        return True
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, list):
        content = "\n".join(item.get("text") for item in content if isinstance(item, dict) and isinstance(item.get("text"), str))
    # Reminders out first, then a look at what leads: one pass, no nested repeat to backtrack through.
    return isinstance(content, str) and REMINDER.sub("", content).lstrip().startswith("<task-notification")

def is_prompt(entry):
    """A user-role entry that starts a turn, whoever sent it: the owner,
    another session, an app event. Not a tool result, a Stop hook's feedback
    or other meta text. Another session's message may be written as meta;
    it carries its origin, which a Stop hook's feedback does not."""
    if entry.get("type") != "user" or entry.get("isSidechain") is True:
        return False
    if entry.get("isCompactSummary") is True:
        return False
    if entry.get("isMeta") is True and not is_peer(entry):
        return False
    if entry.get("toolUseResult") is not None or entry.get("sourceToolUseID"):
        return False
    # A background task's report is no new ask of the owner: a wrap_up ask
    # before it still stands, and repeating its question is no new ask.
    if is_task_report(entry):
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        texts = [content]
    elif isinstance(content, list):
        if any(isinstance(item, dict) and item.get("type") == "tool_result" for item in content):
            return False
        texts = [item.get("text") for item in content if isinstance(item, dict) and isinstance(item.get("text"), str)]
        if any(isinstance(item, dict) and item.get("type") in ATTACHMENTS for item in content):
            return True
    else:
        return False
    # A row of system reminders alone, which the harness adds mid-turn, starts nothing.
    return REMINDER.sub("", "\n".join(texts)).strip() != ""

REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)

def asked_this_turn(lines):
    """Whether a wrap_up since the turn's prompt carried an ask."""
    asked = False
    for line in lines:
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if not isinstance(entry, dict):
            continue
        if is_prompt(entry):
            asked = False
            continue
        for item in wrap_up_calls(entry):
            given = item.get("input")
            ask = given.get("ask") if isinstance(given, dict) else None
            asked = asked or (isinstance(ask, str) and bool(ask.strip()))
    return asked

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

def declared_units(tool, given):
    """The kinds each unit of an ask declares: each AskUserQuestion question,
    from its text and header; a wrap_up, from its ask."""
    if tool != ASK:
        return [kinds(given.get("ask") if isinstance(given.get("ask"), str) else "")]
    units = []
    for question in given.get("questions") or []:
        if isinstance(question, dict):
            text = "\n".join(p for p in (question.get("question"), question.get("header")) if isinstance(p, str))
            units.append(kinds(text))
    return units or [[]]

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
        # A closing message that asks the owner, in a turn whose wrap_up
        # carried no ask: the app shows nothing to say the session waits, so
        # the turn goes on once to make the ask. It comes before the research
        # hold, which then meets that wrap_up on PreToolUse.
        line = owner_ask(message)
        if line is not None:
            with open(path) as handle:
                lines = handle.readlines()
            if has_wrap_up(lines) and not asked_this_turn(lines):
                log({
                    "session": str(data.get("session_id") or os.path.basename(path)),
                    "via": STOP,
                    "questions": [{"question": line[:300], "options": []}],
                    "outcome": "nudged: no wrap_up ask",
                })
                print(json.dumps({"hookSpecificOutput": {"hookEventName": STOP, "additionalContext": (
                    "file the ask. Your closing message asks the owner something (" + line[:300] + "), "
                    "but no wrap_up this turn carried it as its ask, so the app shows nothing to say "
                    "this session waits on them. Call wrap_up now with the question as ask, reply "
                    "buttons as actions, and blocked: true if your work stops until they answer; then "
                    "end the turn without repeating your message. If the turn does not wait on the "
                    "owner, end it again as it is."
                )}}))
                sys.exit(0)
        # The words read for state are the question's own paragraph: "PR #12
        # failed CI. Retry it or revert?" Wider, a closing summary that names
        # a file or a commit would pass most held questions.
        # Each question's paragraph is read on its own, so state named in one
        # passes no question in another.
        texts, choices, where = closing(message)
        if not choices:
            passes()
        # A declaration is read from the closing paragraphs, inline code left
        # out: a Kind: line of its own after a blank line declares too, and
        # prose that quotes the field in code does not. It is one unit.
        units = [kinds("\n\n".join(INLINE_CODE.sub(" ", p) for p in closing_paragraphs(message)))]
    else:
        stop = False
        tool = data.get("tool_name")
        tool_input = data.get("tool_input")
        if tool not in (ASK, WRAP_UP) or not tool_input or not isinstance(tool_input, dict):
            passes()
        if tool == WRAP_UP and not choice_shaped(tool_input):
            passes()
        questions = asked(tool, tool_input)
        units = declared_units(tool, tool_input)
        texts = unit_words(tool, tool_input)
    if stop:
        questions = [{"question": choice, "options": []} for choice in choices]
    # Whether each text names repository state, and whether it names
    # something outside: a look counts when every text names state and
    # nothing outside. A text is an AskUserQuestion question, a wrap_up ask,
    # or a closing question's paragraph; a closing message's declaration is
    # one unit over all its paragraphs, outside when any of them is.
    states = [names_state(t) for t in texts]
    outsides = [names_outside(t) for t in texts]
    unit_outsides = [any(outsides)] if stop else outsides
    for number, question in enumerate(questions):
        at = number if len(units) == len(questions) else 0
        text = where[number] if stop else (number if len(texts) == len(questions) else 0)
        question["kind"] = ", ".join(units[at]) or None
        question["names_state"] = states[text]
        question["names_outside"] = outsides[text]
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
record = {
    "session": session,
    "turn": turn,
    "via": STOP if stop else tool,
    "tool_use_id": None if stop else data.get("tool_use_id"),
    "questions": questions,
    "researched": researched,
    "looked": looked,
    # Every unit names repository state; some unit names something outside.
    "names_state": all(states),
    "names_outside": any(outsides),
    # The kinds an ask declares, each once, in order.
    "kind": ", ".join(dict.fromkeys(k for unit in units for k in unit)) or None,
}
if researched:
    log(dict(record, outcome="passed: research"))
    passes()
# A look counts when every unit is about the repository's state: it names
# such state and nothing outside.
if looked and all(s and not o for s, o in zip(states, outsides)):
    log(dict(record, outcome="passed: look"))
    passes()

# The state: the turn of the last hold, then a JSON line with the questions
# it held (plain, with the kinds each declared) and whether a relabel was
# held. A state of the turn alone, as 0.7.8 wrote it, holds no questions.
folder = state_dir()
state = os.path.join(folder, re.sub(r"[^A-Za-z0-9._-]", "_", session))
kept, unreadable = None, False
try:
    with open(state) as handle:
        held_turn, _, rest = handle.read().partition("\n")
    if held_turn.strip() == turn:
        kept = {"held": [], "relabel_held": False}
        if rest.strip():
            loaded = json.loads(rest)
            # Anything but the shape this handler writes is unreadable.
            held_list = loaded.get("held") if isinstance(loaded, dict) else None
            if not isinstance(held_list, list) or not isinstance(loaded.get("relabel_held"), bool) or not all(
                isinstance(item, dict) and isinstance(item.get("question"), str)
                and isinstance(item.get("kind"), list) and all(isinstance(k, str) for k in item["kind"])
                for item in held_list
            ):
                raise ValueError("the held list is not the shape ask-gate writes")
            kept = {"held": held_list, "relabel_held": loaded["relabel_held"]}
except FileNotFoundError:
    pass
except Exception:
    # Unreadable, the state names no hold this turn; a hold this turn could
    # not be told, so the ask passes once nothing else holds it.
    kept, unreadable = None, True

def unit_questions(number):
    """The questions a unit puts, plain: one for an AskUserQuestion
    question or a wrap_up, every choice of a closing message."""
    if stop:
        return [plain(c) for c in choices]
    if tool == ASK:
        return [plain(questions[number]["question"])] if number < len(questions) else []
    return [plain(tool_input.get("ask"))]

def relabelled():
    """Whether, in the turn of a hold, the ask puts a question held then
    with only its Kind: fields added or changed."""
    if not kept:
        return False
    held = {}
    for item in kept.get("held") or []:
        if item["question"]:
            held.setdefault(item["question"], []).append(sorted(item["kind"]))
    for number, unit in enumerate(units):
        for question in unit_questions(number):
            if question in held and unit and sorted(unit) not in held[question]:
                return True
    return False

relabel = relabelled()
# An owner-only question passes the first time when every unit of the ask
# declares an owner-only kind. It spends nothing: a later undeclared ask in
# the turn is still held once. A Kind: line added to a question once it is
# held passes nothing. For a kind that needs a look, a unit that names
# something outside needs research: no repository read settles it.
if not relabel and all(owner_only(unit, looked and not outside) for unit, outside in zip(units, unit_outsides)):
    log(dict(record, outcome="passed: declared " + record["kind"]))
    passes()
if unreadable:
    log(dict(record, outcome="passed: state unreadable"))
    passes()
# The second hold of a turn: a relabel, once. Any other ask after a hold, or
# one after a relabel's hold, passes.
if kept is not None and not (relabel and not kept.get("relabel_held")):
    log(dict(record, outcome="passed: second ask", relabelled=relabel))
    passes()
if kept is None:
    kept = {"held": [], "relabel_held": False}
# A relabel's hold keeps the questions as first held, so the relabel asked
# again still reads as one.
kept["relabel_held"] = kept.get("relabel_held") is True or relabel
if not relabel:
    kept["held"] = list(kept.get("held") or []) + [
        {"question": question, "kind": sorted(unit)}
        for number, unit in enumerate(units) for question in unit_questions(number) if question
    ]
try:
    os.makedirs(folder, exist_ok=True)
    with open(state, "w") as handle:
        handle.write(turn + "\n" + json.dumps(kept, ensure_ascii=False) + "\n")
except Exception:
    log(dict(record, outcome="passed: state unwritable"))
    passes()
log(dict(record, outcome="held: relabelled" if relabel else "held"))

LOOKED = (
    "Since the owner's last message there has been no WebSearch, WebFetch, "
    "browser page read or research subagent (researcher, Explore ...). A look "
    "at the repository (Read, Grep, Glob, read-only git or gh, a test run) "
    "counts only for a question about the repository or its state (a path, a "
    "pull request, a branch, a commit, CI) that names nothing outside it; "
    + ("there was a look, but " if looked else "there was none either, and ") +
    "a question about an outside tool, service, API, price or credentials "
    "needs that research, since no repository read settles it. "
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
DECLARE = (
    "When you first ask such a question, declare it on a line of its own, "
    "Kind: approval (or money, irreversible), and it goes through; Kind: "
    "preference (or private, ambiguity) goes through only after research or "
    "a look at the sources. A Kind: line added once a question is held does "
    "not pass it. A declared researchable kind (api, default, version, limit, "
    "error, convention, state) is held, and every declared kind is logged. "
)
RELABEL = (
    "This question was held earlier in this turn, and only its Kind: line "
    "is new: a label added after a hold passes nothing, and the relabel is "
    "logged. "
)
if stop:
    if relabel:
        reason = (
            "research before you ask. " + RELABEL + LOOKED + RULE +
            "Research and end the turn again with what you found and your "
            "recommendation first; ended again, the turn ends."
        )
    else:
        reason = (
            "research before you ask. Your closing message asks the owner to "
            "choose (" + " / ".join(choices)[:300] + "). " + LOOKED + RULE +
            "Research and end the turn again with what you found and your "
            "recommendation first. If the question is one of those kinds, end "
            "the turn again and it goes through: the owner already sees the "
            "question, so do not repeat it. " + DECLARE
        )
    print(json.dumps({"hookSpecificOutput": {"hookEventName": STOP, "additionalContext": reason}}))
    sys.exit(0)
if relabel:
    print(
        "BLOCKED: research before you ask. " + RELABEL + LOOKED + RULE +
        "Research and ask again with what you found and your recommendation "
        "first; asked once more, it goes through.",
        file=sys.stderr,
    )
    sys.exit(2)
print(
    "BLOCKED: research before you ask. " + LOOKED + RULE +
    "Research and ask again with what you "
    "found and your recommendation first; if the question is one of those "
    "kinds, ask it again unchanged and it goes through. " + DECLARE,
    file=sys.stderr,
)
sys.exit(2)
PYEOF
)
exec "${HOOK_PYTHON:-python3}" -c "$PY_SRC"
