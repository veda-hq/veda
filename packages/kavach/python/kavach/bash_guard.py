# The git-command check that command_guard.py runs first; its limits and
# rules are in that file's docstring. Importing this module runs the check: it
# exits 0 to allow the command or 2 to block it. It is a module, not code fed
# on stdin, so Python keeps its compiled cache instead of recompiling it on
# every call. Any error it raises also blocks: the entry turns it into exit 2.

import json, os, re, sys

# The consumer's settings (config.py). command_guard.py has already loaded
# them once and refused on a ConfigError; should this second reading fail
# (the file changed in between), the error blocks like any other.
import config

CONFIG = config.load()
# Paired changes (config `pairedChanges`), judged at the end of this module.
# Empty: the rule is off, and nothing reads a commit's repository.
PAIRED = CONFIG.paired_changes


def paired_refusal(pair):
    """The refusal for a commit that may record `pair.changes` without
    certainly recording `pair.requires`."""
    return (
        f"BLOCKED: '{pair.changes}' is staged without a path containing "
        f"'{pair.requires}': {pair.reason.rstrip('.')}. Stage the required change "
        "with it — beforehand, or with `git add ... && git commit` (an add after "
        "`;`, `||` or a pipe may not have run). If this change truly needs none, "
        "ask the user before committing it alone."
    )

# Claude Code always sends a JSON object whose tool_input carries the command
# as a string; anything else leaves the command unknown, so it is refused
# rather than waved through.
try:
    data = json.loads(os.environ.get("HOOK_INPUT", ""))
except ValueError:
    data = None
tool_input = data.get("tool_input") if isinstance(data, dict) else None
raw = tool_input.get("command") if isinstance(tool_input, dict) else None
if not isinstance(raw, str):
    print(
        "BLOCKED: the git-command check could not read a command in its hook "
        "input, so it cannot judge this command.",
        file=sys.stderr,
    )
    sys.exit(2)

# Strip heredoc bodies
lines = raw.split("\n")
out, marker = [], None
for line in lines:
    if marker is not None:
        if line.strip() == marker:
            marker = None
        continue
    m = re.search(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z_0-9]*)['\"]?", line)
    if m:
        marker = m.group(1)
    out.append(line)
cmd = "\n".join(out)

# Protected variables (config `protectedVariables`): environment variables an
# agent must leave as its session set them, such as the ones that tell a
# hosted session from a laptop. A command that sets one is refused, so an
# agent cannot make its laptop look like the hosted session. Read with
# quoting undone as bash undoes it before `export` or `env` sees the word:
# line continuations joined, $'...' escapes decoded, then quotes and
# backslashes removed (`export HOSTED_""REMOTE=1`, `env $'HOSTED_\x52EMOTE=1'`).
# Reading the value (`$HOSTED_REMOTE`) passes. Limits, accepted: what this
# line cannot see (eval, a script file, a computed name); the consumer keeps
# its own backstop (a check that needs more evidence than the variable, and
# review of every pull request). No protected variables: the rule is off.
PROTECTED_VAR = (
    r"(?:" + "|".join(re.escape(name) for name in CONFIG.protected_variables) + r")\b"
    if CONFIG.protected_variables
    else None
)
ANSI_C = {"a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "n": "\n",
          "r": "\r", "t": "\t", "v": "\v", "\\": "\\", "'": "'", '"': '"', "?": "?"}


def ansi_c(body):
    def one(m):
        s = m.group(0)[1:]
        if s[0] in "xuU":
            return chr(int(s[1:], 16))
        if s[0] == "c":
            return chr(ord(s[1]) & 0x1F)
        if s[0].isdigit():
            return chr(int(s, 8) & 0xFF)
        return ANSI_C.get(s, "\\" + s)

    return re.sub(
        r"\\(?:x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|c.|[0-7]{1,3}|.)",
        one,
        body,
        flags=re.S,
    )


if PROTECTED_VAR is not None:
    bare = re.sub(r"\\\n", "", cmd)
    bare = re.sub(r"\$'((?:[^'\\]|\\.)*)'", lambda m: ansi_c(m.group(1)), bare, flags=re.S)
    bare = re.sub(r"\$(?=\")", "", bare)
    bare = re.sub(r"[\\'\"]", "", bare)
    if (
        re.search(r"(?<![\w$])" + PROTECTED_VAR + r"\s*\+?=", bare)
        or re.search(r"\$\{" + PROTECTED_VAR + r":?=", bare)
        or re.search(
            r"(?<![\w-])(?:export|declare|typeset|readonly|local|read|printf\s[^\n;&|]*?-v)\s[^\n;&|]*?(?<![\w$])"
            + PROTECTED_VAR,
            bare,
        )
    ):
        print(
            "BLOCKED: this command sets " + " or ".join(CONFIG.protected_variables)
            + ", which this repository protects: " + CONFIG.protected_variables_reason.rstrip(".")
            + ". To search for the name, leave out the `=`.",
            file=sys.stderr,
        )
        sys.exit(2)

# Fast exit only for commands that cannot run git: no "git" anywhere (so
# `(git commit)` and `/usr/bin/git commit` are read) and no quoting, escape or
# expansion that could spell it (`g\it`, `g''it`, `$'\x67it'`).
if "git" not in raw and not re.search(r"[\\'\"$]", raw):
    sys.exit(0)
# Heredoc-stripped but quoting INTACT — the push analysis tokenises this, because
# stripping quotes first would let `git push '--force'` slip through as a bare push.
cmd_raw = cmd
# Strip quoted strings (used by the text-matching checks below, so that a flag
# mentioned inside a commit message does not trip them).
cmd = re.sub(r"'[^']*'", "", cmd)
cmd = re.sub(r'"[^"]*"', "", cmd)

def block(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)

NO_VERIFY = "BLOCKED: --no-verify is forbidden on all git commands (hooks auto-validate; fix the failure, never bypass it)."
NO_VERIFY_ALIAS = "BLOCKED: 'git commit -n' (--no-verify alias) is forbidden. Fix the hook failure instead of bypassing it."

if "--no-verify" in cmd:
    block(NO_VERIFY)

# Git accepts an unambiguous abbreviation, and `--no-veri` is one (verified:
# `--no-ver` is ambiguous with --no-verbose, `--no-veri` is not). Shorter stubs
# are ambiguous, so git rejects them anyway; blocking them costs nothing.
for word in re.findall(r"(?<!\S)--no-ve[a-z]*", cmd):
    if "--no-verify".startswith(word):
        block(NO_VERIFY)

# `git commit -n` is an alias for --no-verify (also catch bundled flags like -an)
if re.search(r"git\s+commit[^;&|\n]*\s-[a-zA-Z]*n([a-zA-Z]*)?(\s|$)", cmd):
    flags = re.findall(r"\s(-[a-zA-Z]+)(?=\s|$)", re.search(r"git\s+commit[^;&|\n]*", cmd).group(0))
    if any("n" in f[1:] for f in flags):
        block(NO_VERIFY_ALIAS)

# Force pushes: EVERY form is blocked, including --force-with-lease.
# Rewriting a pushed branch is never the sanctioned way to refresh it — merge
# origin/main in instead, which keeps the remote history append-only so review
# threads, in-flight CI and anyone else's checkout stay valid.
#
# This analysis runs on SHELL TOKENS, not on the quote-stripped text: quoting is
# a bypass otherwise (`git push '--force'` survives quote-stripping as a bare
# `git push`). Tokenising also keeps a commit message that merely mentions a
# force flag safe, because the whole message collapses into a single token.
FORCE_REMEDY = (
    "Never rewrite a pushed branch. To refresh it against main, merge instead:\n"
    "  git fetch origin main && git merge origin/main\n"
    "then resolve any conflicts, commit, and `git push` normally.\n"
    "If a history rewrite is genuinely unavoidable, stop and ask the user to run it."
)

import shlex

# `;;`, `;&` and `;;&` end a case arm, and end its command like `;` does.
CASE_ENDS = {";;", ";&", ";;&"}
TERMINATORS = {";", "\n"} | CASE_ENDS
SEPARATORS = {"&&", "||", "|", "|&", "&", "(", ")"} | TERMINATORS
PUNCTUATION = "();<>|&\n"
# shlex groups a run of operator characters into one token (`)&&`, `;\n`);
# split it into the operators bash reads, longest first.
OPERATOR = re.compile(r";;&|;;|;&|&&|\|\||\|&|&>>|&>|>>|>&|>\||<<<|<<-|<<|<&|<>|[();<>|&\n]")
# Options whose value is a SEPARATE following token — that value must never be
# mistaken for a positional refspec (e.g. `git push -o +ci.skip origin main`).
VALUE_OPTS = {"-o", "--push-option", "--repo", "--receive-pack", "--exec"}
# `git` global options that take a separate value before the subcommand.
GIT_GLOBAL_VALUE_OPTS = {
    "-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace",
}


# Operator characters inside quotes travel as private-use placeholders through
# shlex and are restored afterwards, so only UNQUOTED ones become operators.
HIDE_OPS = str.maketrans({c: chr(0xE000 + n) for n, c in enumerate(";&|<>()")})
SHOW_OPS = str.maketrans({chr(0xE000 + n): c for n, c in enumerate(";&|<>()")})


def strip_comments(text):
    """Drop `# ...` shell comments but KEEP the newline that ends each one.

    shlex's own comment handling swallows that newline, so `pwd # x` NEWLINE
    `cd y` would hide the cd's command boundary. A '#' only starts a comment
    outside quotes and at the start of a word, as in bash.

    Also drops a redirection's file-descriptor number (`2>&1` → `>&1`): shlex
    would split it into a lone `2` word, indistinguishable from an argument.

    And hides operator characters that are QUOTED or backslash-escaped behind
    placeholders: shlex unquotes `'>'` into the same `>` token as a real
    redirection, so `-m '>' schema.sql` would lose both words.
    """
    out, quote, i = [], None, 0
    while i < len(text):
        ch = text[i]
        # Backslash-newline is a line continuation: bash deletes BOTH characters
        # (no space), outside quotes and inside double quotes alike, so
        # `schema.s\` NEWLINE `ql` is one word. Single quotes keep it literal.
        if ch == "\\" and text[i + 1:i + 2] == "\n" and quote != "'":
            i += 2
            continue
        if quote:
            if ch == "\\" and quote == '"' and i + 1 < len(text):
                out.append("\\" + text[i + 1].translate(HIDE_OPS))
                i += 2
                continue
            if ch == quote:
                quote = None
            else:
                ch = ch.translate(HIDE_OPS)
        elif ch == "\\" and i + 1 < len(text):
            out.append("\\" + text[i + 1].translate(HIDE_OPS))
            i += 2
            continue
        elif ch in "'\"":
            quote = ch
        elif ch == "#" and (i == 0 or text[i - 1] in " \t\n;&|()"):
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        elif ch.isdigit() and (i == 0 or text[i - 1] in " \t\n;&|()"):
            j = i
            while j < len(text) and text[j].isdigit():
                j += 1
            if j < len(text) and text[j] in "<>":
                i = j
                continue
        out.append(ch)
        i += 1
    return "".join(out)


def tokenize(text):
    """Shell-tokenise, keeping operators separate. None if unparseable.

    A newline ends a command just like ';', so it is kept as a token: without
    it, `pwd` NEWLINE `cd x` hides the cd from the command-start check.
    """
    try:
        # Backslash-newline is a line continuation, not a command boundary.
        text = strip_comments(text)
        lex = shlex.shlex(text, posix=True, punctuation_chars=PUNCTUATION)
        lex.commenters = ""
        lex.whitespace = " \t\r"
        lex.whitespace_split = True
        tokens = []
        for tok in lex:
            if set(tok) <= set(PUNCTUATION):
                tokens += OPERATOR.findall(tok)
            elif tok.translate(SHOW_OPS) == tok or not set(tok.translate(SHOW_OPS)) <= set(PUNCTUATION):
                tokens.append(tok.translate(SHOW_OPS))
            else:
                # A word made only of quoted operator characters (`'>'`, `';'`)
                # keeps its placeholders, so it can never equal an operator.
                tokens.append(tok)
        return tokens
    except ValueError:
        return None


# Long options that rewrite or delete remote history. Git accepts any
# UNAMBIGUOUS ABBREVIATION of a long option, so `--force-with` and `--mir` are
# real spellings (verified against git) — match by prefix, not by equality.
# Over-matching an ambiguous stub like `--f` is harmless: git rejects it anyway.
DANGEROUS_LONG = ("--force", "--force-with-lease", "--mirror")


def is_dangerous_long(arg):
    base = arg.split("=", 1)[0]
    if not base.startswith("--") or len(base) < 3:
        return None
    for full in DANGEROUS_LONG:
        if full.startswith(base):
            return full
    return None


# A path the shell would expand cannot be resolved by static analysis. Reading
# the WRONG repo would silently allow a forcing refspec or a commit that lacks
# its paired change, so the guard refuses instead of guessing — the one safe
# answer for an undecidable input.
UNRESOLVABLE = re.compile(r"[$`*?\[]|^~")

AMBIGUOUS_REMEDY = (
    "This guard must inspect the repository a push or commit targets (push "
    "config, staged files), and a shell-expanded path cannot be resolved "
    "statically.\nRe-run it with a literal path (or from inside the target repo) "
    "so the check can see the right repository."
)


def shell_cwd():
    """The directory the Bash tool's shell runs this command in.

    The hook input's `cwd` is the shell's directory — for a subagent working in
    its own worktree, that worktree — and this hook process may have been
    started somewhere else. Fall back to the process cwd only when it is absent.
    """
    cwd = data.get("cwd")
    return cwd if isinstance(cwd, str) and os.path.isabs(cwd) else os.getcwd()


SHELL_CWD = shell_cwd()


class Unresolved:
    """A directory only the running shell can compute (`cd $X`, `cd -`, `popd`).

    Kept rather than blocked on sight: it only matters if a push or commit
    later runs there, so `cd $X && git status` stays allowed.
    """

    def __init__(self, target):
        self.target = target


def step_dir(target, cwd):
    """Directory after `cd target` from `cwd` (None = the shell's cwd)."""
    if target == "-" or UNRESOLVABLE.search(target):
        return Unresolved(target)
    if os.path.isabs(target):
        return target
    if isinstance(cwd, Unresolved):
        return cwd
    return os.path.join(cwd or SHELL_CWD, target)


def settle(cwd):
    """`cwd` as a usable path; blocks if the shell alone could compute it."""
    if isinstance(cwd, Unresolved):
        block(
            f"BLOCKED: cannot statically resolve the directory '{cwd.target}'.\n"
            + AMBIGUOUS_REMEDY
        )
    return cwd


def resolve_dir(target, base):
    """Absolute path for `target` relative to `base`; blocks if unresolvable."""
    return settle(step_dir(target, base))


# For a config VALUE, only a shell expansion makes it unreadable. A glob like
# `refs/heads/*` is a legitimate literal refspec, and globbing cannot plausibly
# change whether the value starts with '+', which is all this check needs.
VALUE_UNRESOLVABLE = re.compile(r"[$`]")

REMOTE_PUSH_KEY = re.compile(r"(?i)^remote\..+\.push$")


def check_config_overrides(overrides):
    """Reject `-c remote.<r>.push=+...`, which forces this invocation alone.

    Verified against git: a plain push rejected as non-fast-forward succeeds
    with `(forced update)` under this override. It never touches repo config,
    so it can only be caught here. Only evaluated once the command is known to
    be a push, so `git -c ... config --list` is untouched.
    """
    for opt, val in overrides:
        key, _, cval = val.partition("=")
        if not REMOTE_PUSH_KEY.match(key.strip()):
            continue
        if opt == "--config-env" or VALUE_UNRESOLVABLE.search(cval):
            block(
                f"BLOCKED: '{opt} {key}=...' sets a push refspec from a value this "
                "guard cannot read, so it cannot be proven non-forcing.\n"
                + FORCE_REMEDY
            )
        if cval.strip().startswith("+"):
            block(
                f"BLOCKED: '{opt} {val}' sets a forcing '+' push refspec for this "
                "command.\n" + FORCE_REMEDY
            )


from collections import namedtuple

# One `git <sub>` the guard inspects, with the repository it really targets.
# cwd None means the shell's cwd; env holds GIT_* variables set for it.
GitCall = namedtuple("GitCall", "sub args cwd git_dir work_tree env overrides pos end")

# Variables that move git to another repository or index without any flag.
GIT_REPO_ENV = {"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"}
# Tracked through exports too: CDPATH decides where a relative `cd` lands.
TRACKED_ENV = GIT_REPO_ENV | {"CDPATH"}
ENV_ASSIGN = re.compile(r"^([A-Za-z_][A-Za-z_0-9]*)=(.*)$", re.S)
# Words after which the next token is again a command name. `builtin cd` and
# `command cd` are still the shell's own cd.
COMMAND_LEADERS = SEPARATORS | {
    "if", "then", "else", "elif", "do", "while", "until", "{", "!", "time",
    "builtin", "command",
}
CD_OPTS = {"-L", "-P", "-e", "-@"}
CONTROL_OPENERS = {"if", "while", "until", "for", "select", "case"}


class Branches:
    """One if/while/until/for/select/case being walked: the state before it,
    the state its branches start from, and what any branch changed."""

    def __init__(self, kind, cwd, env, dir_stack):
        self.kind, self.start = kind, None
        self.entry = (cwd, dict(env), list(dir_stack))
        self.cwd_changed, self.env_changed = False, set()

    def note(self, cwd, env, dir_stack):
        """Record what the branch just walked changed relative to the entry."""
        entry_cwd, entry_env, entry_stack = self.entry
        self.cwd_changed |= (
            cwd != entry_cwd or isinstance(cwd, Unresolved) or dir_stack != entry_stack
        )
        self.env_changed |= {
            n for n in set(env) | set(entry_env) if env.get(n) != entry_env.get(n)
        }

    def restart(self):
        """State the next branch starts from."""
        cwd, env, stack = self.start or self.entry
        return cwd, dict(env), list(stack)

    def blend(self, cwd, env, dir_stack):
        """Either this state or the branch start: whatever differs is unknown."""
        start_cwd, start_env, start_stack = self.start or self.entry
        env = dict(env)
        if cwd != start_cwd or isinstance(cwd, Unresolved) or dir_stack != start_stack:
            cwd = Unresolved("a cd inside an if/while/for/case body")
        for name in set(env) | set(start_env):
            if env.get(name) != start_env.get(name):
                env[name] = "$(set only if an if/while/for/case body ran)"
        return cwd, env, list(dir_stack)

    def after(self):
        """State after the compound: anything a branch changed is unknown."""
        cwd, env, stack = self.entry
        env = dict(env)
        if self.cwd_changed:
            cwd = Unresolved("a cd inside an if/while/for/case body")
        for name in self.env_changed:
            env[name] = "$(set only if an if/while/for/case body ran)"
        return cwd, env, list(stack)


def command_head(tokens, i):
    """Index just before the command at `i`, skipping `CDPATH= cd`-style
    assignments and `builtin`/`command` wrappers."""
    k = i - 1
    while k >= 0 and (tokens[k] in ("builtin", "command") or ENV_ASSIGN.match(tokens[k])):
        k -= 1
    return k


def at_command_start(tokens, i):
    k = command_head(tokens, i)
    return k < 0 or tokens[k] in COMMAND_LEADERS


def assignment_only(tokens, i):
    """True for `NAME=value` with no command after it: a shell assignment."""
    j = i
    while j < len(tokens) and ENV_ASSIGN.match(tokens[j]):
        j += 1
    return j > i and (j == len(tokens) or tokens[j] in SEPARATORS)


# Commands that print or search their arguments: a `git` among them is a word,
# not a command (`echo git commit`). Anything else that takes `git` as an
# argument (env, nohup, xargs, sudo…) may run it, so it is still checked.
INERT_COMMANDS = {"echo", "printf", "grep", "egrep", "fgrep", "rg", "man", "type", "which"}
WORD_STARTS = (COMMAND_LEADERS | {"if", "while", "until"}) - {"builtin", "command", "time", "!"}


def is_argument(tokens, i):
    """True if tokens[i] is an argument of an INERT_COMMANDS command."""
    k = i - 1
    while k >= 0 and tokens[k] not in WORD_STARTS:
        k -= 1
    k += 1
    while k < i and ENV_ASSIGN.match(tokens[k]):
        k += 1
    return k < i and tokens[k] in INERT_COMMANDS


PIPES = {"|", "|&"}


def in_pipeline(tokens, i, j):
    """True if the command spanning tokens[i:j…] is a pipeline component, which
    bash forks: its cd/export changes nothing, even later in the same list.
    """
    k = command_head(tokens, i)
    if k >= 0 and tokens[k] in PIPES:
        return True
    while j < len(tokens) and tokens[j] not in SEPARATORS:
        j += 1
    return j < len(tokens) and tokens[j] in PIPES


LIST_ENDS = TERMINATORS | {"&", "(", ")"}


def runs_conditionally(tokens, i):
    """True if the command at tokens[i] follows `&&` or `||` in its list, so
    the shell may skip it (`false && cd x`)."""
    k = command_head(tokens, i)
    while k >= 0 and tokens[k] not in LIST_ENDS:
        if tokens[k] in ("&&", "||"):
            return True
        k -= 1
    return False


def list_end(tokens, j):
    """Index of the `;`/newline/`)` ending the list containing tokens[j], or
    None when nothing follows it."""
    depth = 0
    while j < len(tokens):
        if tokens[j] == "(":
            depth += 1
        elif tokens[j] == ")":
            if depth == 0:
                return j
            depth -= 1
        elif depth == 0 and tokens[j] in TERMINATORS:
            return j
        j += 1
    return None


def first_or(tokens, j, end):
    """Index of the first top-level `||` in tokens[j:end], or None."""
    depth, end = 0, len(tokens) if end is None else end
    while j < end:
        if tokens[j] == "(":
            depth += 1
        elif tokens[j] == ")":
            depth -= 1
        elif depth == 0 and tokens[j] == "||":
            return j
        j += 1
    return None


def background_end(tokens, j):
    """Index of the `&` that backgrounds the AND/OR list containing tokens[j],
    or None. Bash forks the WHOLE list (`cd x && git commit &`), so a cd in it
    holds until that `&` and is gone after it.
    """
    depth = 0
    while j < len(tokens):
        tok = tokens[j]
        if tok == "(":
            depth += 1
        elif tok == ")":
            if depth == 0:
                return None
            depth -= 1
        elif depth == 0 and tok in TERMINATORS:
            return None
        elif depth == 0 and tok == "&":
            return j
        j += 1
    return None


ENV_CLEAR_OPTS = {"-i", "-", "--ignore-environment"}


def command_env(tokens, i, exported):
    """GIT_* variables the `git` at tokens[i] really runs with.

    Reads the words between the command's start and `git`, left to right as
    the shell and env(1) do: `GIT_DIR=x git` scopes x to this call and beats
    an export (the last assignment wins); `env -u GIT_DIR` and `env -i` drop
    exported values, so the guard must not inspect the repo those name.
    """
    s = i
    # `GIT_DIR=x command git` still passes x: wrappers do not end the scan.
    while s > 0 and tokens[s - 1] not in COMMAND_LEADERS - {"builtin", "command", "time"}:
        s -= 1
    env, in_env, k = dict(exported), False, s
    while k < i:
        tok = tokens[k]
        m = ENV_ASSIGN.match(tok)
        if m:
            if m.group(1) in GIT_REPO_ENV:
                env[m.group(1)] = m.group(2)
        elif tok == "env":
            in_env = True
        elif in_env and tok in ENV_CLEAR_OPTS:
            env = {}
        elif in_env and tok in ("-u", "--unset") and k + 1 < i:
            env.pop(tokens[k + 1], None)
            k += 1
        elif in_env and tok.startswith(("--unset=", "-u")):
            env.pop(tok.split("=", 1)[1] if tok.startswith("--") else tok[2:], None)
        k += 1
    return {name: val for name, val in env.items() if name in GIT_REPO_ENV}


def cd_path(tokens, i, env):
    """CDPATH for the `cd` at tokens[i]: its own prefix (`CDPATH=x cd y`), else
    the exported or inherited value."""
    k = i - 1
    while k >= 0 and (tokens[k] in ("builtin", "command") or ENV_ASSIGN.match(tokens[k])):
        m = ENV_ASSIGN.match(tokens[k])
        if m and m.group(1) == "CDPATH":
            return m.group(2)
        k -= 1
    return env.get("CDPATH", "")


def cd_dir(target, cwd, cdpath):
    """Where `cd target` lands, searching CDPATH as bash does.

    Bash tries each CDPATH entry (empty = '.') for a relative target that is
    not '.'/'..'-led or absolute, and takes the first existing directory; only if
    none exists does it fall back to the current directory.
    """
    dotted = target in (".", "..") or target.startswith(("./", "../", "/"))
    if not cdpath or dotted or UNRESOLVABLE.search(target):
        return step_dir(target, cwd)
    if isinstance(cwd, Unresolved) or VALUE_UNRESOLVABLE.search(cdpath):
        return Unresolved(f"CDPATH={cdpath} cd {target}")
    for entry in cdpath.split(":"):
        base = step_dir(entry or ".", cwd)
        if isinstance(base, Unresolved):
            return Unresolved(f"CDPATH={cdpath} cd {target}")
        if os.path.isdir(os.path.normpath(os.path.join(base, target))):
            return os.path.join(base, target)
    return step_dir(target, cwd)


def is_redirect(tok):
    """A redirection operator token (`>`, `>>`, `>&`, `&>`, `<`, `>|`…)."""
    return bool(tok) and set(tok) <= set("<>&|") and ("<" in tok or ">" in tok)


def is_git(tok):
    return tok == "git" or tok.endswith("/git")


def iter_git_calls(tokens, wanted, soft=frozenset()):
    """Yield a GitCall for every `git <sub>` whose subcommand is in `wanted`.

    A sub in `soft` whose repository cannot be resolved is yielded with an
    Unresolved cwd rather than blocked: it only informs a later check.

    Tracks the directory each one runs in, because `cd other/repo && git push`,
    `pushd`, `git -C other/repo push`, `--git-dir`/`--work-tree` and GIT_DIR all
    target a different repository — and that repo's config and index are what
    the checks must read. Subshell parentheses scope the directory and exports,
    matching real shell behaviour.
    """
    # Start from the variables this shell inherited, like git and cd would.
    i, cwd = 0, None
    env = {k: os.environ[k] for k in TRACKED_ENV if k in os.environ}
    scope_stack, dir_stack, restore_at, uncertain_at, settle_at = [], [], {}, {}, {}
    control_stack, case_pattern = [], False
    while i < len(tokens):
        tok = tokens[i]
        # The `&` closing a backgrounded list: its cds and exports end here.
        if i in restore_at:
            cwd, env, dir_stack = restore_at.pop(i)
        # The end of a list whose cd/export may have been skipped: whatever
        # differs from before it is now unknown, and fails closed if used.
        if i in uncertain_at:
            before_cwd, before_env, _ = uncertain_at.pop(i)
            if before_cwd != cwd or isinstance(cwd, Unresolved):
                cwd = Unresolved("a cd that may have been skipped (after && or ||)")
            for name in set(env) | set(before_env):
                if env.get(name) != before_env.get(name):
                    env[name] = "$(set only if an earlier && or || ran it)"
        if i in settle_at:
            cwd, env, dir_stack = settle_at.pop(i)
        # Compound-command bodies may not run (or run repeatedly): a cd or
        # export inside one holds within it, and is unknown after it. Branches
        # are exclusive: `else`/`elif` and each case arm start from the state
        # the condition (or `case WORD in`) left, never from the branch before.
        top = control_stack[-1] if control_stack else None
        if case_pattern:
            # `a|b)` of a case arm: pattern words, not commands or subshells.
            if tok == "esac":
                case_pattern = False
            else:
                case_pattern = tok != ")"
                i += 1
                continue
        if tok in CONTROL_OPENERS and at_command_start(tokens, i):
            control_stack.append(Branches(tok, cwd, env, dir_stack))
        elif top and top.kind == "case" and tok == "in" and top.start is None:
            top.start = (cwd, dict(env), list(dir_stack))
            case_pattern = True
        elif top and tok in ("then", "do") and at_command_start(tokens, i):
            top.start = (cwd, dict(env), list(dir_stack))
        elif top and (
            (top.kind == "if" and tok in ("else", "elif") and at_command_start(tokens, i))
            or (top.kind == "case" and tok in CASE_ENDS)
        ):
            top.note(cwd, env, dir_stack)
            if tok == ";&":
                # Falls through: the next arm runs on this arm's state.
                pass
            elif tok == ";;&":
                # The next arm may run after this one, or alone.
                cwd, env, dir_stack = top.blend(cwd, env, dir_stack)
            else:
                cwd, env, dir_stack = top.restart()
            case_pattern = top.kind == "case"
        elif top and tok in ("fi", "done", "esac") and at_command_start(tokens, i):
            control_stack.pop()
            top.note(cwd, env, dir_stack)
            cwd, env, dir_stack = top.after()
        # `( cd other && git push )` must not leak its cd to later commands.
        if tok == "(":
            scope_stack.append((cwd, dict(env), list(dir_stack)))
            i += 1
            continue
        if tok == ")":
            if scope_stack:
                cwd, env, dir_stack = scope_stack.pop()
            i += 1
            continue
        shell_word = tok in ("cd", "pushd", "popd", "export", "unset") or assignment_only(tokens, i)
        if shell_word and at_command_start(tokens, i):
            saved, j = (cwd, dict(env), list(dir_stack)), i + 1
            if tok in ("cd", "pushd"):
                physical = False
                while j < len(tokens) and tokens[j] in CD_OPTS:
                    if tokens[j] in ("-L", "-P"):
                        physical = tokens[j] == "-P"
                    j += 1
                # `cd -- dir`: the option terminator, not a destination.
                if j < len(tokens) and tokens[j] == "--":
                    j += 1
                if j < len(tokens) and tokens[j] not in SEPARATORS:
                    if tok == "pushd":
                        dir_stack.append(cwd)
                    cwd = cd_dir(tokens[j], cwd, cd_path(tokens, i, env))
                    if not isinstance(cwd, Unresolved):
                        # Bash's cd is logical by default: `cd link; cd ..`
                        # returns to link's parent, not its target's, so
                        # resolve `..` on the path text. `-P` follows links.
                        cwd = os.path.realpath(cwd) if physical else os.path.normpath(cwd)
                    j += 1
                    while j < len(tokens) and is_redirect(tokens[j]):
                        j += 2
                    if j < len(tokens) and tokens[j] not in SEPARATORS:
                        # `cd a b`: bash refuses it, zsh swaps a for b in $PWD.
                        cwd = Unresolved(f"{tok} with more than one operand")
                        while j < len(tokens) and tokens[j] not in SEPARATORS:
                            j += 1
                else:
                    # Bare `cd` goes to $HOME; bare `pushd` swaps the top two.
                    cwd = Unresolved("~" if tok == "cd" else "pushd")
            elif tok == "popd":
                cwd = dir_stack.pop() if dir_stack else Unresolved("popd")
            else:
                # An unexported shell variable is kept under "\0NAME", so it
                # rides along with every saved and restored state; a later
                # bare `export NAME` publishes it.
                if tok not in ("export", "unset"):
                    j = i
                unexport = False
                while j < len(tokens) and tokens[j] not in SEPARATORS:
                    m = ENV_ASSIGN.match(tokens[j])
                    name = m.group(1) if m else tokens[j]
                    if tok == "export" and re.fullmatch(r"-[fnp]+", tokens[j]):
                        unexport |= "n" in tokens[j]
                    elif tok == "unset":
                        env.pop(name, None)
                        env.pop("\0" + name, None)
                    elif name not in TRACKED_ENV:
                        pass
                    elif unexport:
                        # `export -n NAME[=value]`: kept, but no longer exported.
                        value = m.group(2) if m else env.get(name, env.get("\0" + name))
                        env.pop(name, None)
                        if value is not None:
                            env["\0" + name] = value
                    elif tok == "export":
                        if m:
                            env[name] = m.group(2)
                            env.pop("\0" + name, None)
                        elif "\0" + name in env:
                            env[name] = env.pop("\0" + name)
                    elif name in env or name == "CDPATH":
                        # `NAME=value` alone: an exported (or inherited) one
                        # stays exported, and cd reads CDPATH either way.
                        env[name] = m.group(2)
                    else:
                        env["\0" + name] = m.group(2)
                    j += 1
            # `cd x | true` changes a forked shell only; so does every command
            # of a backgrounded list, from its `&` on.
            if in_pipeline(tokens, i, j):
                cwd, env, dir_stack = saved
            else:
                end = background_end(tokens, j)
                if end is not None:
                    restore_at.setdefault(end, saved)
                else:
                    # `false && cd x; git commit`: after the list either state is
                    # possible. Within it, anything past an `||` may run because
                    # the cd's chain failed (`false && cd x || git commit`).
                    end = list_end(tokens, j)
                    conditional = runs_conditionally(tokens, i)
                    if conditional and end is not None:
                        uncertain_at.setdefault(end, saved)
                    alt = first_or(tokens, j, end)
                    if alt is not None:
                        uncertain_at.setdefault(alt, saved)
                        stops = alt + 1 < len(tokens) and tokens[alt + 1] in ("exit", "return")
                        if not conditional and end is not None and stops:
                            # `cd x || exit 1; git commit`: once the list is
                            # over, the cd must have worked. `cd x || true`
                            # proves nothing, so that stays unknown.
                            settle_at[end] = (cwd, dict(env), list(dir_stack))
            i = j
            continue
        if not is_git(tok) or is_argument(tokens, i):
            i += 1
            continue
        call_env = command_env(tokens, i, env)
        # Collect global options WITHOUT judging them: everything here is only
        # relevant if this invocation is one the caller inspects, so an
        # unresolvable path on `git -C $D status` must not be blocked.
        j, raw_cds, raw_git_dir, raw_work_tree, overrides = i + 1, [], None, None, []
        while j < len(tokens) and tokens[j].startswith("-"):
            opt, val = tokens[j], None
            if "=" in opt:
                opt, val = opt.split("=", 1)
            if opt in GIT_GLOBAL_VALUE_OPTS:
                if val is None and j + 1 < len(tokens):
                    val = tokens[j + 1]
                    j += 2
                else:
                    j += 1
                if val is not None:
                    if opt == "-C":
                        # Cumulative: verified that `git -C outer -C inner` lands
                        # in outer/inner, each relative to the one before.
                        raw_cds.append(val)
                    elif opt == "--git-dir":
                        raw_git_dir = val
                    elif opt == "--work-tree":
                        raw_work_tree = val
                    elif opt in ("-c", "--config-env"):
                        overrides.append((opt, val))
            else:
                j += 1
        if j < len(tokens) and tokens[j] in wanted:
            args, k = [], j + 1
            while k < len(tokens) and tokens[k] not in SEPARATORS:
                if is_redirect(tokens[k]):
                    # `> log`, `>&1`, `2>&1`: the shell's, not git's — and read
                    # as a pathspec it would narrow the commit check to nothing.
                    k += 2
                    continue
                args.append(tokens[k])
                k += 1
            inv_cwd = cwd
            for raw_cd in raw_cds:
                inv_cwd = step_dir(raw_cd, inv_cwd)
            unknown = (
                isinstance(inv_cwd, Unresolved)
                or any(UNRESOLVABLE.search(p) for p in (raw_git_dir, raw_work_tree) if p)
                or any(VALUE_UNRESOLVABLE.search(v) or v.startswith("~") for v in call_env.values())
            )
            if unknown and tokens[j] in soft:
                # A `soft` call only informs a later check; the caller decides
                # what an unknown repository means instead of blocking here.
                yield GitCall(tokens[j], args, Unresolved(tokens[j]), None, None, {}, overrides, i, k)
                i = k
                continue
            inv_cwd = settle(inv_cwd)
            git_dir = resolve_dir(raw_git_dir, inv_cwd) if raw_git_dir is not None else None
            work_tree = resolve_dir(raw_work_tree, inv_cwd) if raw_work_tree is not None else None
            for name, val in call_env.items():
                if VALUE_UNRESOLVABLE.search(val) or val.startswith("~"):
                    block(
                        f"BLOCKED: {name} is set from a value this guard cannot "
                        f"resolve ('{val}').\n" + AMBIGUOUS_REMEDY
                    )
            yield GitCall(tokens[j], args, inv_cwd, git_dir, work_tree, call_env, overrides, i, k)
            i = k
        else:
            i = j + 1


def check_push_args(args):
    positionals, skip_next = [], False
    for arg in args:
        if skip_next:
            skip_next = False
            continue
        if arg in VALUE_OPTS:
            skip_next = True
            continue
        danger = is_dangerous_long(arg)
        if danger == "--mirror":
            block(
                "BLOCKED: 'git push --mirror' force-updates and deletes remote "
                "refs.\n" + FORCE_REMEDY
            )
        if danger == "--force-with-lease":
            block("BLOCKED: 'git push --force-with-lease' is forbidden.\n" + FORCE_REMEDY)
        if danger == "--force":
            block("BLOCKED: 'git push --force' is forbidden.\n" + FORCE_REMEDY)
        # Bundled short flags, e.g. -uf / -fu
        if re.fullmatch(r"-[a-zA-Z]+", arg) and "f" in arg[1:]:
            block("BLOCKED: 'git push -f' is forbidden.\n" + FORCE_REMEDY)
        if arg.startswith("-"):
            continue
        positionals.append(arg)
    # A leading '+' on a REFSPEC forces the update: `git push origin +main`.
    for pos in positionals:
        if pos.startswith("+"):
            block("BLOCKED: a '+' refspec on git push forces the update.\n" + FORCE_REMEDY)
    return positionals


# Bash ANSI-C quoting ($'...') and locale quoting ($"...") survive shlex as a
# literal '$' glued to the contents, so $'--force' tokenises as "$--force" and
# defeats EVERY token check. If such quoting appears anywhere in a command that
# also pushes, refuse rather than analyse a string that is not what bash will
# run. The probe decodes the escapes bash does, so `git $'\x70ush'` is a push.
ANSI_C = re.compile(r"\$'((?:[^'\\]|\\.)*)'", re.S)
ANSI_ESCAPE = re.compile(
    r"\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|c.|.)", re.S
)
ANSI_SIMPLE = {
    "a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "n": "\n",
    "r": "\r", "t": "\t", "v": "\v", "\\": "\\", "'": "'", '"': '"', "?": "?",
}


def ansi_char(m):
    s = m.group(1)
    if s[0] in "xuU" and len(s) > 1:
        return chr(int(s[1:], 16))
    if s[0] in "01234567":
        return chr(int(s, 8) & 0xFF)
    if s[0] == "c" and len(s) > 1:
        return chr(ord(s[1]) & 0x1F)
    return ANSI_SIMPLE.get(s, "\\" + s)


def plain_quoting(text):
    """`text` with $'...' decoded as bash does and $"..." read as "..."."""
    text = ANSI_C.sub(lambda m: shlex.quote(ANSI_ESCAPE.sub(ansi_char, m.group(1))), text)
    return re.sub(r"\$(?=['\"])", "", text)


if re.search(r"\$['\"]", cmd_raw):
    probe = tokenize(plain_quoting(cmd_raw))
    if probe is None or any(True for _ in iter_git_calls(probe, {"push"})):
        block(
            "BLOCKED: this command mixes ANSI-C/locale quoting ($'...') with a "
            "git push, and the guard cannot faithfully reproduce what bash will "
            "execute.\nRe-run the push with ordinary quoting so its arguments can "
            "be verified."
        )

import subprocess


def git_out(args, call):
    """stdout of `git_run`, or '' when git could not run (push-config reads)."""
    result = git_run(args, call)
    return result.stdout if result else ""


def git_strict(args, call):
    """stdout of `git_run`; BLOCKS if git failed or timed out.

    The commit check must not read a failed query as "nothing staged".
    """
    result = git_run(args, call)
    if result is None or result.returncode != 0:
        why = "timed out or could not start" if result is None else (
            (result.stderr.strip().splitlines() or ["no output"])[0]
        )
        block(
            f"BLOCKED: could not inspect the repository this commit targets "
            f"(git {' '.join(args)}: {why}), so the paired-change check "
            "cannot run. Fix the repository state or run the commit from "
            "inside the repository."
        )
    return result.stdout


def git_run(args, call):
    """Run a read-only git command against the repository `call` targets.

    Repo selection mirrors the call itself: its cwd (the shell's when None),
    --git-dir, --work-tree, `-c` overrides and GIT_* variables. Returns the
    CompletedProcess, or None when git cannot run. (`-c core.worktree=` does
    NOT move the work tree — verified: git reads that key only from the
    repository's own config.)
    """
    cwd = call.cwd or SHELL_CWD
    if not os.path.isdir(cwd):
        block(
            f"BLOCKED: cannot inspect the target directory '{cwd}'.\n"
            + AMBIGUOUS_REMEDY
        )
    prefix = [f"--git-dir={call.git_dir}"] if call.git_dir else []
    prefix += [f"--work-tree={call.work_tree}"] if call.work_tree else []
    # --config-env is skipped: its variable lives in the shell, so passing it
    # on would make git fail here and read nothing.
    prefix += [a for opt, val in call.overrides if opt == "-c" for a in (opt, val)]
    # The call's GIT_* set is complete (exports, prefixes, `env -u`), so the
    # hook's own copies must not leak back in underneath it.
    # HOOK_INPUT stays out too: over the platform's exec cap git would not start.
    base_env = {k: v for k, v in os.environ.items() if k not in GIT_REPO_ENV and k != "HOOK_INPUT"}
    try:
        return subprocess.run(
            ["git"] + prefix + args,
            capture_output=True, text=True, timeout=10,
            cwd=cwd, env={**base_env, **call.env},
        )
    except Exception:
        return None


def config_force_refspec(remote, call):
    """True if remote.<remote>.push is configured with a forcing '+' refspec."""
    vals = git_out(["config", "--get-all", f"remote.{remote}.push"], call).splitlines()
    return any(v.strip().startswith("+") for v in vals)


# git commit's long options (git 2.5x), mapped to whether the value may be a
# SEPARATE token. Git accepts any unambiguous abbreviation (`--mess x` is
# `--message x`), so a value-taking option is matched by prefix: a missed one
# would read its value as a pathspec and narrow what the check inspects.
COMMIT_LONG = {
    "--all": False, "--patch": False, "--reuse-message": True,
    "--reedit-message": True, "--fixup": True, "--squash": True,
    "--reset-author": False, "--short": False, "--branch": False,
    "--porcelain": False, "--long": False, "--null": False, "--file": True,
    "--author": True, "--date": True, "--message": True, "--template": True,
    "--signoff": False, "--no-signoff": False, "--trailer": True,
    "--verify": False, "--allow-empty": False, "--allow-empty-message": False,
    "--cleanup": True, "--edit": False, "--no-edit": False, "--amend": False,
    "--no-post-rewrite": False, "--include": False, "--only": False,
    "--pathspec-from-file": True, "--pathspec-file-nul": False,
    "--untracked-files": False, "--verbose": False, "--quiet": False,
    "--dry-run": False, "--status": False, "--no-status": False,
    "--gpg-sign": False, "--no-gpg-sign": False, "--interactive": False,
    "--unified": True, "--inter-hunk-context": True, "--ahead-behind": False,
    "--post-rewrite": False,
}
# Short options whose value is the rest of the bundle or the next token, and
# those whose optional value can only be attached (`-S<keyid>`, `-uno`).
COMMIT_VALUE_SHORT = set("mFcCtU")
COMMIT_ATTACHED_SHORT = set("Su")


def commit_long(arg):
    base = arg.split("=", 1)[0]
    if base in COMMIT_LONG:
        return base
    matches = [o for o in COMMIT_LONG if o.startswith(base)]
    return matches[0] if len(matches) == 1 else None


def parse_commit_args(args):
    """(stage_all, include, pathspecs, from_file, only, interactive, dry) for
    `git commit <args>`."""
    stage_all = include = from_file = only = interactive = dry = False
    paths, k = [], 0
    while k < len(args):
        arg = args[k]
        k += 1
        if arg == "--":
            paths += args[k:]
            break
        if arg.startswith("--"):
            opt = commit_long(arg)
            stage_all |= opt == "--all"
            include |= opt == "--include"
            only |= opt == "--only"
            from_file |= opt == "--pathspec-from-file"
            interactive |= opt in ("--patch", "--interactive")
            dry |= opt == "--dry-run"
            if opt and COMMIT_LONG[opt] and "=" not in arg:
                k += 1
            continue
        if arg.startswith("-") and len(arg) > 1:
            for pos, ch in enumerate(arg[1:], 1):
                if ch == "n":
                    # Caught here too: the text check above only sees a
                    # literal `git commit`, not `git -C dir commit -n`.
                    block(NO_VERIFY_ALIAS)
                stage_all |= ch == "a"
                include |= ch == "i"
                only |= ch == "o"
                interactive |= ch == "p"
                if ch in COMMIT_VALUE_SHORT:
                    k += pos == len(arg) - 1
                    break
                if ch in COMMIT_ATTACHED_SHORT:
                    break
            continue
        paths.append(arg)
    return stage_all, include, paths, from_file, only, interactive, dry


class IndexState:
    """What earlier commands IN THIS SAME LINE did to one repository's index.

    The hook runs before the whole line, so `git add schema.sql && git
    commit` would otherwise be judged on the index as it was before the add.
    `may` is every path an earlier add could have staged (counted for a
    paired change's `changes` side); `adds` holds, per add, the paths it
    certainly leaves changed against HEAD (counted for the `requires` side,
    and only when that add is sure to have run before the commit — see
    `runs_before`). `trusted` drops to False once anything else may have
    changed the index or work tree (reset, restore, stash, checkout, an
    earlier commit…): from then on only an add after that point can prove a
    required path is present.
    """

    def __init__(self, trusted=True):
        self.may, self.adds, self.trusted = set(), [], trusted
        self.replaced = set()
        # Set once an earlier command may have moved HEAD (a commit, a branch
        # switch…): a later add's diff against the PRE-LINE HEAD then proves
        # nothing — `git commit -- required && git add -A && git commit`
        # would credit the second commit with the first one's required path.
        self.head_moved = not trusted

    def distrust(self):
        self.adds = [(end, set()) for end, _ in self.adds]
        self.trusted = False


STAGERS = {"add", "stage"}
# Other subcommands that can change the index or the work tree.
INDEX_WRITERS = {
    "reset", "restore", "rm", "stash", "checkout", "switch", "mv", "clean",
    "read-tree", "update-index", "apply", "am", "cherry-pick", "revert",
    "merge", "rebase", "pull", "commit",
}
index_states, unknown_repo_writes, moved_git_dirs = {}, [False], set()
# The `changes` side of every paired change an index writer in a repository
# this guard cannot resolve may have staged.
unknown_repo_stages = set()
# rev-parse --absolute-git-dir per repository selection, keyed on everything
# git_run passes git. The hook runs before the line, so one answer holds for
# every call in it, however often a commit line asks.
git_dirs = {}


def repo_key(call):
    """Identity of the index `call` uses: its git dir plus GIT_INDEX_FILE."""
    if isinstance(call.cwd, Unresolved) or not os.path.isdir(call.cwd or SHELL_CWD):
        return None
    index_file = call.env.get("GIT_INDEX_FILE")
    if index_file is not None and not os.path.isabs(index_file):
        # Git resolves a relative one from where it runs, which this guard
        # would have to reproduce to tell two such indexes apart.
        block(
            f"BLOCKED: GIT_INDEX_FILE='{index_file}' is relative, so the guard "
            "cannot tell which index this commit line stages into.\nUse an "
            "absolute GIT_INDEX_FILE path."
        )
    selection = (
        call.cwd or SHELL_CWD, call.git_dir, call.work_tree,
        tuple(tuple(o) for o in call.overrides), tuple(sorted(call.env.items())),
    )
    if selection not in git_dirs:
        git_dirs[selection] = git_run(["rev-parse", "--absolute-git-dir"], call)
    result = git_dirs[selection]
    if result is None or result.returncode != 0:
        return None
    git_dir = result.stdout.strip()
    if index_file is not None and os.path.realpath(index_file) == os.path.realpath(
        os.path.join(git_dir, "index")
    ):
        index_file = None  # the default index, spelled out
    return (git_dir, index_file)


def index_state(call):
    key = repo_key(call)
    if key not in index_states:
        moved = key is not None and key[0] in moved_git_dirs
        index_states[key] = IndexState(trusted=not unknown_repo_writes[0] and not moved)
    return index_states[key]


def note_head_move(call):
    """HEAD moved in `call`'s repository: every index of it (the default one
    and any GIT_INDEX_FILE) now differs from HEAD in ways not read here."""
    key = repo_key(call)
    if key is not None:
        moved_git_dirs.add(key[0])
    for other, state in index_states.items():
        if other == key or (other is not None and key is not None and other[0] == key[0]):
            state.distrust()
            state.head_moved = True


def head_base(call):
    """HEAD, or the empty tree on an unborn branch (rev-parse exits 1 with no
    output); blocks with git's reason on any other failure."""
    head = git_run(["rev-parse", "--verify", "-q", "HEAD"], call)
    if head is not None and head.returncode == 0:
        return "HEAD"
    if head is not None and head.returncode == 1 and not head.stdout.strip():
        return git_strict(["hash-object", "-t", "tree", os.devnull], call).strip()
    git_strict(["rev-parse", "--verify", "HEAD"], call)
    return "HEAD"


def runs_before(end, pos):
    """True if the command ending at tokens[end] certainly ran, and succeeded,
    before the commit at tokens[pos]: they share one AND list joined only by
    `&&`, with no `||` or pipe earlier in it. `false && git add m; git commit`
    skips the add; `x || git add m && git commit` may too; after `;` a failed
    add still lets the commit run.
    """
    between = [t for t in tokens[end:pos] if t in SEPARATORS]
    if not between or any(t != "&&" for t in between):
        return False
    k = end - 1
    while k >= 0 and tokens[k] not in (";", "\n", "&", "(", ")"):
        if tokens[k] in ("||", "|", "|&"):
            return False
        k -= 1
    return True


# `git add` options that leave the staged content exactly the listed changes.
ADD_EXACT_SHORT, ADD_EXACT_LONG = set("Auvf"), {
    "--all", "--update", "--verbose", "--force", "--no-ignore-removal",
    "--ignore-errors",
}


def note_add(call):
    """Record in the call's IndexState what this `git add` will stage."""
    if isinstance(call.cwd, Unresolved):
        return note_unknown_write()
    stage_all = update = dry = partial = False
    paths, k = [], 0
    while k < len(call.args):
        arg = call.args[k]
        k += 1
        if arg == "--":
            paths += call.args[k:]
            break
        if arg.startswith("--"):
            base = arg.split("=", 1)[0]
            stage_all |= base in ("--all", "--no-ignore-removal")
            update |= base == "--update"
            dry |= "--dry-run".startswith(base) and len(base) > 3
            # -p/-i/-e/-N, --pathspec-from-file, or anything unrecognised:
            # what gets staged cannot be known, so nothing counts as certain.
            partial |= base not in ADD_EXACT_LONG
            continue
        if arg.startswith("-") and len(arg) > 1:
            stage_all |= "A" in arg
            update |= "u" in arg
            dry |= "n" in arg
            partial |= not set(arg[1:]) <= ADD_EXACT_SHORT | {"n"}
            continue
        paths.append(arg)
    if dry or not (paths or stage_all or update or partial):
        return
    if any(VALUE_UNRESOLVABLE.search(p) for p in paths) or (partial and not paths):
        # Paths the shell computes: anything may be staged, nothing certainly.
        paths, partial = [":/"], True
    spec = paths or [":/"]
    # After the add, the index holds the work tree's content for these paths,
    # so what the commit records is the work tree against HEAD — a required
    # path staged earlier but restored in the work tree is UNSTAGED by this add.
    against_head = set(git_strict(
        ["diff", "--name-only", head_base(call), "--"] + spec, call,
    ).splitlines())
    if not update:
        against_head |= set(git_strict(
            ["ls-files", "--others", "--exclude-standard", "--full-name", "--"] + spec,
            call,
        ).splitlines())
    against_index = set(git_strict(["diff", "--name-only", "--"] + spec, call).splitlines())
    state = index_state(call)
    state.may |= against_head | against_index
    if partial:
        # `add -i` can revert, and an unknown option may do anything: what an
        # earlier add certainly staged no longer holds.
        state.distrust()
    state.adds.append((call.end, set() if partial or state.head_moved else against_head))
    # Index entries this add replaces: the pre-line reading of them no longer
    # holds (their new state is in `adds`, when the add certainly ran).
    state.replaced |= set(git_strict(
        ["diff", "--cached", "--name-only", "--"] + spec, call,
    ).splitlines())


def note_unknown_write():
    """A write to a repository the guard cannot resolve: distrust them all."""
    unknown_repo_writes[0] = True
    for state in index_states.values():
        state.distrust()
        state.head_moved = True


def moves_head(call):
    """Whether this index writer may move HEAD. `git reset [HEAD] [-- paths]`,
    `git checkout -- paths`, restore, rm, mv, clean, stash, apply and the
    plumbing writers leave it; anything else is assumed to move it."""
    if call.sub in ("commit", "merge", "rebase", "pull", "cherry-pick", "revert", "am", "switch"):
        return True
    if call.sub in ("reset", "checkout"):
        if call.sub == "reset" and any(a.split("=")[0] in ("--soft", "--hard", "--merge", "--keep") for a in call.args):
            return True
        positional = []
        for arg in call.args:
            if arg == "--":
                break
            if not arg.startswith("-"):
                positional.append(arg)
        return any(p != "HEAD" for p in positional)
    return False


GLOB = re.compile(r"[*?\[]")
# Writers that bring in other commits' changes; which files is not read here.
APPLIERS = {"read-tree", "update-index", "apply", "am", "cherry-pick", "revert", "merge", "rebase", "pull"}


def split_args(args, value_opts):
    """(options, operands before `--`, operands after `--`)."""
    opts, pos, after, k = [], [], None, 0
    while k < len(args):
        arg = args[k]
        k += 1
        if after is not None:
            after.append(arg)
        elif arg == "--":
            after = []
        elif arg.startswith("-") and len(arg) > 1:
            opts.append(arg)
            k += arg in value_opts
        else:
            pos.append(arg)
    return opts, pos, after or []


def revision(word, call):
    """True if `word` names a commit in `call`'s repository."""
    if call is None:
        return True
    result = git_run(["rev-parse", "--verify", "--quiet", word + "^{commit}"], call)
    return result is not None and result.returncode == 0


def changed_from(source, paths, call):
    """The paths taking `paths` from `source` may change against HEAD, or
    None where that is unknown (no repository, or git failed)."""
    if call is None:
        return None
    result = git_run(["diff", "--name-only", source, head_base(call), "--"] + paths, call)
    if result is None or result.returncode != 0:
        return None
    return result.stdout.splitlines()


def changes_in(found):
    """The paired changes whose `changes` side a path in `found` ends with
    (every one when `found` is None: unknown)."""
    if found is None:
        return list(PAIRED)
    return [pair for pair in PAIRED if any(p.endswith(pair.changes) for p in found)]


def differs_in_changes(source, paths, call):
    """The paired changes whose `changes` side taking `paths` from `source`
    may change against HEAD (every one where the repository is unknown)."""
    return changes_in(changed_from(source, paths, call))


def names_changes(paths, call):
    """The paired changes whose tracked `changes` side pathspecs `paths` may
    cover (every one for a glob, pathspec magic or an unknown repository)."""
    if any(GLOB.search(p) or p.startswith(":") for p in paths) or call is None:
        return list(PAIRED)
    named = [pair for pair in PAIRED if any(pair.changes in p for p in paths)]
    if len(named) == len(PAIRED):
        return named
    result = git_run(["ls-files", "--"] + paths, call)
    if result is None or result.returncode != 0:
        return list(PAIRED)
    tracked = changes_in(result.stdout.splitlines())
    return [pair for pair in PAIRED if pair in named or pair in tracked]


def may_stage_changes(call, known=True):
    """The paired changes whose `changes` side index writer `call` may leave
    staged where the pre-line index does not show it (`git restore
    --source=HEAD~1 --staged -- schema.sql`). Unstaging, stashing away and
    branch creation cannot, so ordinary `git reset && git add … && git
    commit` stays allowed."""
    repo = call if known else None
    sub = call.sub
    if sub == "clean":
        return []
    if sub in APPLIERS:
        return list(PAIRED)
    if sub == "stash":
        _, pos, _ = split_args(call.args, {"-m", "--message"})
        return list(PAIRED) if pos and pos[0] in ("apply", "pop", "branch") else []
    if sub in ("rm", "mv"):
        _, pos, after = split_args(call.args, set())
        return names_changes(pos + after, repo)
    if sub == "restore":
        _, pos, after = split_args(call.args, {"-s", "--source"})
        source = None
        for k, arg in enumerate(call.args):
            if arg == "--":
                break
            if arg in ("-s", "--source"):
                source = call.args[k + 1] if k + 1 < len(call.args) else None
            elif arg.startswith("--source="):
                source = arg.split("=", 1)[1]
            elif arg.startswith("-s") and not arg.startswith("--"):
                source = arg[2:]
        if source is not None:
            return differs_in_changes(source, pos + after, repo)
        # Without a source, --staged copies HEAD to the index (an unstage),
        # but the work-tree default copies the index out, which a later
        # `commit -a` records: count it when it may cover a `changes` path.
        def short(flag):
            return any(re.fullmatch(r"-[a-zA-Z]+", o) and flag in o for o in call.args)

        staged_only = ("--staged" in call.args or short("S")) and not (
            "--worktree" in call.args or short("W")
        )
        return [] if staged_only else names_changes(pos + after, repo)
    if sub in ("reset", "checkout", "switch"):
        opts, pos, after = split_args(call.args, {"-b", "-B", "-c", "-C", "--orphan"})
        if sub == "switch" or any(o in ("-b", "-B", "--orphan") for o in opts) and not after:
            return []
        pos = [p for p in pos if not (sub == "reset" and p == "HEAD")]
        if not pos:
            # `reset [HEAD] [-- paths]` unstages; `checkout -- paths` copies
            # the index to the work tree, which a later `commit -a` records.
            return names_changes(after, repo) if sub == "checkout" else []
        if not revision(pos[0], repo):
            return [] if sub == "reset" else names_changes(pos + after, repo)
        if sub == "checkout" and len(pos) == 1 and not after:
            return []  # a branch switch: the index follows the new HEAD
        return differs_in_changes(pos[0], pos[1:] + after, repo)
    return list(PAIRED)


def note_index_write(call):
    if isinstance(call.cwd, Unresolved):
        unknown_repo_stages.update(pair.changes for pair in may_stage_changes(call, known=False))
        return note_unknown_write()
    state = index_state(call)
    state.distrust()
    if moves_head(call):
        note_head_move(call)
    for pair in may_stage_changes(call):
        # A marker, not a path: it starts with "(" and ends with `changes`.
        state.may.add(f"(staged by git {call.sub}) {pair.changes}")


def committed_paths(call):
    """(may_side, certain_side): files `call` (a `git commit`) may record,
    and files it certainly records, read from ITS repository."""
    state = index_state(call)
    for changes in sorted(unknown_repo_stages):
        state.may.add(f"(staged by git in an unresolved repository) {changes}")
    stage_all, include, paths, from_file, only, interactive, _ = parse_commit_args(call.args)
    if only and not paths and not from_file:
        # `git commit --only --amend` (or `--only --allow-empty`) with no paths
        # records none of the index — git documents it as message-only.
        return [], []
    if from_file:
        block(
            "BLOCKED: `git commit --pathspec-from-file` hides which paths it "
            "commits, so the paired-change check cannot see them. Pass the "
            "paths on the command line instead."
        )
    for path in paths:
        if VALUE_UNRESOLVABLE.search(path) or path.startswith("~"):
            block(
                f"BLOCKED: cannot statically resolve the commit pathspec '{path}', "
                "so the paired-change check cannot see what it commits. Pass "
                "literal paths."
            )

    def names(extra):
        return git_strict(["diff", "--name-only"] + extra, call).splitlines()

    def certain(found):
        # Read before the line runs: only trusted while nothing else wrote,
        # and never for an entry an earlier add in the line replaced.
        return [p for p in found if p not in state.replaced] if state.trusted else []

    if interactive:
        # `--patch` / `--interactive` stage from the work tree while the commit
        # runs: any tracked change (and, through --interactive, any untracked
        # file) may be recorded. Which hunks is chosen at the prompt, and
        # --interactive can even unstage, so no required path is certain.
        untracked = git_strict(
            ["ls-files", "--others", "--exclude-standard", "--full-name", ":/"], call,
        ).splitlines()
        return names(["--cached"]) + names([]) + untracked + sorted(state.may), []

    in_paths = []
    if paths:
        # A pathspec commits those paths' WORKING-TREE content, so compare that
        # to HEAD: a required path staged but restored in the work tree is
        # discarded, and must not count.
        in_paths = names([head_base(call), "--"] + paths)
        if not include:
            # Without --include, ONLY those paths are committed; the index
            # (and anything an earlier add put in it) stays behind.
            # An earlier writer that may change a `changes` path (marked,
            # not named by path) can reach these paths too.
            marked = [p for p in state.may if p.startswith("(")]
            return in_paths + marked, certain(in_paths)
        # With --include, the rest of the index is committed too.
        excluded = [f":(exclude){p}" for p in paths]
        staged = names(["--cached", "--", ":/"] + excluded)
    elif stage_all:
        # `git commit -a` records tracked files' WORK-TREE content, so compare
        # that to HEAD (a staged-then-restored required path is not committed).
        staged = names([head_base(call)])
    else:
        staged = names(["--cached"])
    found = staged + in_paths
    added = [p for end, must in state.adds if runs_before(end, call.pos) for p in must]
    return found + sorted(state.may), certain(found) + added


# Judge the words bash will pass: $'...' decoded, so `git commit $'-a'` is -a
# and `git $'\x63ommit'` is a commit, for every check below.
tokens = tokenize(plain_quoting(cmd_raw))
if tokens is None:
    # Unparseable (unbalanced quotes). Fall back to the conservative regex scan
    # rather than silently allowing the push through.
    for push in re.finditer(r"git\s+push[^;&|\n]*", cmd):
        if re.search(r"(--force|--force-with-lease|\s-[a-zA-Z]*f[a-zA-Z]*(\s|$)|\s\+\S)", push.group(0)):
            block("BLOCKED: force push detected in an unparseable command.\n" + FORCE_REMEDY)
    # The paired-change check needs the repository the commit targets, which
    # only the tokens can give; refuse rather than read the wrong index.
    if PAIRED and re.search(r"git\b[^;&|\n]*\scommit\b", cmd):
        block(
            "BLOCKED: this git commit could not be parsed (unbalanced quotes), so "
            "the guard cannot tell which repository it commits to.\n"
            + AMBIGUOUS_REMEDY
        )
    sys.exit(0)

# Quoting must not launder --no-verify or an abbreviation of it: `'--no-veri'`
# survives the quote-stripped text check above as nothing at all, but git sees
# the unquoted word. Checked on the arguments of each git invocation, skipping
# message values (`-m '--no-verify'` is text, not a flag); any other value
# that happens to spell the flag is refused too, which costs nothing.
MESSAGE_OPTS = {"-m", "-F", "--message", "--file"}
for i, tok in enumerate(tokens):
    if not is_git(tok):
        continue
    skip = False
    for word in tokens[i + 1:]:
        if word in SEPARATORS or word == "--":
            break
        if skip:
            skip = False
            continue
        base = word.split("=", 1)[0]
        if len(base) >= len("--no-ve") and "--no-verify".startswith(base):
            block(NO_VERIFY)
        long_opt = commit_long(word) if word.startswith("--") and "=" not in word else None
        skip = (
            word in MESSAGE_OPTS
            or long_opt in ("--message", "--file")
            or bool(re.fullmatch(r"-[a-zA-Z]*[mF]", word))
        )

remotes_cache = {}


def known_remotes(call):
    key = (call.cwd or "", call.git_dir or "", tuple(sorted(call.env.items())))
    if key not in remotes_cache:
        remotes_cache[key] = set(git_out(["remote"], call).split())
    return remotes_cache[key]


# With no paired changes nothing reads a commit's repository, so a commit in
# one this guard cannot resolve is soft too: only its options are judged.
calls = list(iter_git_calls(
    tokens, {"push"} | STAGERS | INDEX_WRITERS,
    soft=STAGERS | INDEX_WRITERS - ({"commit"} if PAIRED else set()),
))
last_commit = max((n for n, c in enumerate(calls) if c.sub == "commit"), default=-1)
for n, call in enumerate(calls):
    if call.sub in STAGERS | INDEX_WRITERS - {"commit"}:
        # Only matters to a commit later in this line; otherwise leave it be.
        if PAIRED and n < last_commit:
            if call.sub in STAGERS:
                note_add(call)
            else:
                note_index_write(call)
        continue
    if call.sub == "push":
        check_config_overrides(call.overrides)
        positionals = check_push_args(call.args)
        # A configured `+` push refspec force-updates even a bare `git push`.
        # Read it from the repo the push actually targets, not the hook's cwd.
        remotes = known_remotes(call)
        target = next((p for p in positionals if p in remotes), None)
        for remote in ([target] if target else list(remotes) or ["origin"]):
            if config_force_refspec(remote, call):
                block(
                    f"BLOCKED: remote.{remote}.push is configured with a forcing "
                    "'+' refspec, so even a plain `git push` rewrites the remote.\n"
                    + FORCE_REMEDY
                )
        continue
    if parse_commit_args(call.args)[6]:
        # `git commit --dry-run` records nothing and leaves the index alone.
        continue
    if not PAIRED:
        # parse_commit_args above has refused `-n`; nothing else reads a commit.
        continue
    # Paired changes (config `pairedChanges`): a commit that may record a path
    # ending in `changes` must also certainly record a path containing
    # `requires`. Read the index of the repository the commit runs in, not the
    # hook's: a subagent in its own worktree could otherwise commit the one
    # without the other past this check. This is the blocking half; the
    # consumer should keep its own CI check behind it, since a static reading
    # of one line cannot see every way a file changes.
    may_side, certain_side = committed_paths(call)
    # This commit consumes the index: a later commit in the line cannot trust it.
    index_state(call).distrust()
    note_head_move(call)
    for pair in PAIRED:
        if any(p.endswith(pair.changes) for p in may_side) and not any(
            pair.requires in p for p in certain_side
        ):
            block(paired_refusal(pair))

sys.exit(0)
