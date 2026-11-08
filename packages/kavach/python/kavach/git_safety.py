"""Git hook-bypass and history-rewrite analysis for the command guard.

``command_guard.py`` runs two checks and the command runs only when both allow
it: ``bash_guard.py`` first (the protected-variable refusal, the paired-change
index model and its own hook-bypass and force-push rules), then ``hook_main``
here. The paired-change rule is ``bash_guard.py``'s, except for a commit moved
by ``env -C``, which that module's model does not follow
(``env_chdir_paired``). The guard is run against a shared adversarial corpus
(``corpus/``), whose every row is executed against real bash and git; this
module exists because the text-matching guards were bypassable in the same
ways:

* ``git -c core.hooksPath=/dev/null commit`` (the catalogue example),
  ``--config-env``, ``GIT_CONFIG_*`` in the environment, a persisted
  ``git config core.hooksPath`` and ``-c alias.x='commit --no-verify'``;
* ``'--no-verify'`` in quotes (the old guard deleted quoted text before
  looking), ``$'--no-verify'``, ``--no-veri`` (git accepts an unambiguous
  abbreviation);
* the command inside ``bash -c``, ``eval``, ``$(...)``, backticks, a heredoc
  or a pipe into a shell.

What it does NOT claim, stated so nobody reads more into a green corpus:

* Commands that never run hooks by design (``commit-tree``, ``cherry-pick``,
  ``rebase``) and edits to the tracked hook files themselves are out of
  scope: pre-push and CI still run on everything a push carries.
* A script FILE executed by name (``bash scripts/x.sh``) is committed code
  that pre-commit and review see; only programs written inline are analysed.
* Code inside a non-shell interpreter (``python3 -c``) is scanned for the
  telltale words only; the worktree guard (``worktree_guard.py``) refuses
  inline interpreter programs outright.

Exit contract (``hook_main``): SystemExit(2) = block with a reason on stderr,
SystemExit(0) = allow. Malformed hook input is a refusal, never a pass.
"""

from __future__ import annotations

import json
import os
import posixpath
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Any, Sequence

MAX_DEPTH = 6

HOOK_REMEDY = (
    "Hooks auto-validate every commit and push; fix what they report instead "
    "of bypassing them."
)
FORCE_REMEDY = (
    "Never rewrite a pushed branch. To refresh it against main, merge instead:\n"
    "  git fetch origin main && git merge origin/main\n"
    "then resolve any conflicts, commit, and `git push` normally.\n"
    "If a history rewrite is genuinely unavoidable, stop and ask the user to run it."
)
AMBIGUOUS_REMEDY = (
    "This guard must read the target repository's push config to prove the push "
    "is not forced, and a shell-expanded path cannot be resolved statically.\n"
    "Re-run it with a literal path (or from inside the target repo) so the check "
    "can see the right repository."
)
PAIRED_REMEDY = (
    "Stage the required change with it, running git from inside that repository. "
    "If this change truly needs none, ask the user before committing it alone."
)


class Blocked(Exception):
    """Raised with the reason a command is refused."""


# ---------------------------------------------------------------------------
# Lexing: the subset of bash that decides which words a command receives.
# ---------------------------------------------------------------------------


@dataclass
class Word:
    """One shell word after quote removal.

    ``dynamic`` means the shell would compute part of it at run time
    (a parameter, a substitution, an unquoted glob or brace expansion), so its
    final value is unknowable here. ``bodies`` are the programs of the command
    substitutions inside it, which run no matter where the word lands.
    """

    text: str = ""
    dynamic: bool = False
    quoted: bool = False
    bodies: list[str] = field(default_factory=list)
    started: bool = False
    # Offset in ``text`` of the first quoted or escaped character: bash treats
    # ``NAME=value`` as an assignment only when nothing before ``=`` is quoted.
    first_quoted: int | None = None
    # Offset of the first character computed at run time.
    first_dynamic: int | None = None
    glob: bool = False
    glob_leading: bool = False
    # An unquoted `{a,b}` / `{1..3}`: bash turns the word into several.
    braces: bool = False

    def could_be_flag(self) -> bool:
        """Might the shell turn this word into something starting with '-'/'+'?"""

        return self.dynamic or self.glob_leading or (self.glob and self.text[:1] in "-+")

    def is_assignment(self) -> str | None:
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)\+?=.*", self.text, re.S)
        if match is None:
            return None
        if self.first_quoted is not None and self.first_quoted <= self.text.index("="):
            return None
        return match.group(1)


@dataclass
class Command:
    """A simple command: its words, the programs it feeds a shell, its scope."""

    words: list[Word] = field(default_factory=list)
    redirect_targets: list[Word] = field(default_factory=list)
    # `< file` and `<& fd`: read, never written.
    input_targets: list[Word] = field(default_factory=list)
    heredocs: list[str] = field(default_factory=list)
    # $(…) and `…` bodies inside heredocs whose delimiter is unquoted.
    expanded_bodies: list[str] = field(default_factory=list)
    herestrings: list[Word] = field(default_factory=list)
    piped_from: Command | None = None
    # Parenthesised subshell depth, so `( cd x && ... ); git push` scopes cd.
    depth: int = 0
    # The operator that ended the command before this one ('' for the first):
    # `&&` means this one runs only if that one succeeded.
    follows: str = ""


ANSI_SIMPLE = {
    "a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "n": "\n",
    "r": "\r", "t": "\t", "v": "\v", "\\": "\\", "'": "'", '"': '"', "?": "?",
}


def decode_ansi_c(text: str, start: int) -> tuple[str, int]:
    """Decode a ``$'...'`` body starting after the quote; return (value, end)."""

    out: list[str] = []
    index = start
    while index < len(text):
        char = text[index]
        if char == "'":
            # Bash ends the expansion at its first NUL: $'--force\000x' is --force.
            value = "".join(out)
            return value.split("\0", 1)[0], index + 1
        if char != "\\" or index + 1 >= len(text):
            out.append(char)
            index += 1
            continue
        code = text[index + 1]
        index += 2
        if code in ANSI_SIMPLE:
            out.append(ANSI_SIMPLE[code])
        elif code in "01234567":
            digits = code
            while len(digits) < 3 and index < len(text) and text[index] in "01234567":
                digits += text[index]
                index += 1
            out.append(chr(int(digits, 8) & 0xFF))  # bash keeps 8 bits: \455 is "-"
        elif code in "xuU":
            limit = {"x": 2, "u": 4, "U": 8}[code]
            digits = ""
            while (
                len(digits) < limit
                and index < len(text)
                and text[index] in "0123456789abcdefABCDEF"
            ):
                digits += text[index]
                index += 1
            out.append(chr(int(digits, 16)) if digits else "\\" + code)
        elif code == "c" and index < len(text):
            out.append(chr(ord(text[index]) & 0x1F))
            index += 1
        else:
            out.append("\\" + code)
    raise Blocked("unterminated $'...' quoting")


HEREDOC_OPEN = re.compile(r"<<(-?)[ \t]*(?:'([^']*)'|\"([^\"]*)\"|\\?([A-Za-z0-9_.-]+))")


def skip_heredoc_bodies(text: str, index: int, pending: list[tuple[str, bool]]) -> int:
    """From just after a newline, skip the bodies of ``pending`` heredocs."""

    cursor = index
    for delimiter, strip in pending:
        while cursor < len(text):
            end = text.find("\n", cursor)
            end = len(text) if end < 0 else end
            line = text[cursor:end]
            cursor = end + 1
            if (line.lstrip("\t") if strip else line) == delimiter:
                break
    pending.clear()
    return min(cursor, len(text))


def substitutions_in(text: str) -> list[str]:
    """The ``$(…)`` and backquote bodies an expanding heredoc runs.

    Only a backslash escapes here: quotes in a heredoc body are literal text,
    so ``'$(x)'`` still runs ``x``. ``$((…))`` is arithmetic, not a command.
    """

    bodies: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if text.startswith("$((", index):
            index += 3
            continue
        if text.startswith("$(", index):
            end = matching_close(text, index + 2, "(", ")")
            bodies.append(text[index + 2 : end - 1])
            index = end
            continue
        if char == "`":
            end = text.find("`", index + 1)
            if end < 0:
                raise Blocked("unterminated backquote in a heredoc")
            bodies.append(text[index + 1 : end])
            index = end + 1
            continue
        index += 1
    return bodies


def matching_close(text: str, start: int, opener: str, closer: str) -> int:
    """Index just past the ``closer`` that balances an ``opener`` before ``start``.

    Quotes and nested substitutions inside are respected, so
    ``$(echo ")")`` closes at the second parenthesis.
    """

    depth = 1
    index = start
    quote = ""
    heredocs: list[tuple[str, bool]] = []
    while index < len(text):
        char = text[index]
        if char == "\n" and not quote and heredocs:
            index = skip_heredoc_bodies(text, index + 1, heredocs)
            continue
        if quote == "'":
            if char == "'":
                quote = ""
        elif char == "\\":
            index += 2
            continue
        elif quote == '"':
            if char == '"':
                quote = ""
            elif char == "$" and text[index + 1 : index + 2] == "(":
                index = matching_close(text, index + 2, "(", ")")
                continue
        elif char in "'\"":
            quote = char
        elif text.startswith("<<", index) and not text.startswith("<<<", index):
            # A heredoc body is data: an apostrophe in `$(cat <<'EOF' ... EOF)`
            # must not open a quote that swallows the closing parenthesis.
            match = HEREDOC_OPEN.match(text, index)
            if match is None:
                index += 2
                continue
            delimiter = next(group for group in match.groups()[1:] if group is not None)
            heredocs.append((delimiter, match.group(1) == "-"))
            index = match.end()
            continue
        elif char == "`":
            end = text.find("`", index + 1)
            if end < 0:
                raise Blocked("unterminated backquote")
            index = end + 1
            continue
        elif char == opener:
            depth += 1
        elif char == closer:
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    raise Blocked(f"unbalanced '{opener}'")


OPERATORS = ("&&", "||", "|&", ";;", ";&", "|", "&", ";", "(", ")", "\n")
REDIRECTS = ("&>>", "<<<", "<<-", ">>", "<<", "<>", ">&", "<&", ">|", "&>", "<", ">")
NAME_CHAR = re.compile(r"[A-Za-z0-9_]")


class Lexer:
    """Turn a script into Commands, following bash closely where it matters."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.index = 0
        self.commands: list[Command] = []
        self.current = Command()
        self.word = Word()
        self.depth = 0
        # (delimiter, strip tabs, command, body expands: delimiter unquoted)
        self.pending_heredocs: list[tuple[str, bool, Command, bool]] = []
        self.pipe_next = False
        self.expect: str | None = None  # "redirect" | "heredoc" | "herestring"
        self.heredoc_strip = False

    # -- word assembly -----------------------------------------------------

    def add(self, text: str, *, dynamic: bool = False, quoted: bool = False) -> None:
        if (quoted or dynamic) and self.word.first_quoted is None:
            self.word.first_quoted = len(self.word.text)
        if dynamic and self.word.first_dynamic is None:
            self.word.first_dynamic = len(self.word.text)
        self.word.text += text
        self.word.dynamic = self.word.dynamic or dynamic
        self.word.quoted = self.word.quoted or quoted
        self.word.started = True

    def finish_word(self) -> None:
        if not self.word.started:
            return
        word = self.word
        self.word = Word()
        if self.expect == "redirect":
            self.current.redirect_targets.append(word)
        elif self.expect == "input":
            self.current.input_targets.append(word)
        elif self.expect == "herestring":
            self.current.herestrings.append(word)
        elif self.expect == "heredoc":
            self.pending_heredocs.append((word.text, self.heredoc_strip, self.current, not word.quoted))
        else:
            self.current.words.append(word)
        self.expect = None

    def finish_command(self, operator: str) -> None:
        self.finish_word()
        if (
            self.current.words
            or self.current.redirect_targets
            or self.current.input_targets
            or self.current.herestrings
        ):
            self.commands.append(self.current)
            previous: Command | None = self.current
        else:
            previous = None
        # A newline after `&&`, `||` or `|` continues the list (`a &&\n b`).
        follows = operator
        # The pipe's source rolls across the newline with it: in
        # `printf 'git push -f' |\n bash` bash still reads printf's program.
        piped_from: Command | None = None
        if previous is None and operator == "\n" and self.current.follows in ("&&", "||", "|", "|&"):
            follows = self.current.follows
            piped_from = self.current.piped_from
        self.current = Command(depth=self.depth, follows=follows, piped_from=piped_from)
        if operator in ("|", "|&") and previous is not None:
            self.current.piped_from = previous

    # -- expansions ----------------------------------------------------------

    def dollar(self, in_double: bool) -> None:
        text, index = self.text, self.index
        following = text[index + 1 : index + 2]
        if following == "(":
            # `$((...))` arithmetic closes the same way; its body, analysed as
            # a program, is a harmless subshell unless it nests a `$(...)`.
            end = matching_close(text, index + 2, "(", ")")
            self.word.bodies.append(text[index + 2 : end - 1])
            self.add(text[index:end], dynamic=True)
            self.index = end
            return
        if following == "{":
            end = matching_close(text, index + 2, "{", "}")
            inner = text[index + 2 : end - 1]
            self.word.bodies.extend(substitution_bodies(inner))
            self.add(text[index:end], dynamic=True)
            self.index = end
            return
        if not in_double and following == "'":
            value, end = decode_ansi_c(text, index + 2)
            self.add(value, quoted=True)
            self.index = end
            return
        if not in_double and following == '"':
            # $"..." is looked up in the TEXTDOMAIN message catalog, which can
            # map it to any text (a `+main` refspec included): dynamic. The
            # string itself still lexes as double-quoted for its bodies.
            self.add("", dynamic=True)
            self.index += 1
            return
        if following and (NAME_CHAR.match(following) or following in "@*#?$!-"):
            end = index + 2
            if NAME_CHAR.match(following) and not following.isdigit():
                while end < len(text) and NAME_CHAR.match(text[end]):
                    end += 1
            self.add(text[index:end], dynamic=True)
            self.index = end
            return
        self.add("$")
        self.index += 1

    def backquote(self) -> None:
        end = self.text.find("`", self.index + 1)
        while end > 0 and self.text[end - 1] == "\\":
            end = self.text.find("`", end + 1)
        if end < 0:
            raise Blocked("unterminated backquote")
        body = self.text[self.index + 1 : end].replace("\\`", "`")
        self.word.bodies.append(body)
        self.add(self.text[self.index : end + 1], dynamic=True)
        self.index = end + 1

    # -- heredocs ------------------------------------------------------------

    def read_heredocs(self) -> None:
        """At a newline, consume the bodies of the heredocs opened on the line."""

        for delimiter, strip, command, expands in self.pending_heredocs:
            lines: list[str] = []
            while self.index <= len(self.text):
                end = self.text.find("\n", self.index)
                end = len(self.text) if end < 0 else end
                line = self.text[self.index : end]
                self.index = end + 1
                check = line.lstrip("\t") if strip else line
                if check == delimiter:
                    break
                lines.append(check)
                if end >= len(self.text):
                    break
            body = "\n".join(lines)
            command.heredocs.append(body)
            if expands:
                # An unquoted delimiter expands the body before the recipient
                # runs: `cat <<EOF` with `$(git commit -n)` inside commits.
                command.expanded_bodies.extend(substitutions_in(body))
        self.pending_heredocs = []

    # -- main loop -------------------------------------------------------------

    def run(self) -> list[Command]:
        text = self.text
        while self.index < len(text):
            char = text[self.index]
            if char == "\\":
                following = text[self.index + 1 : self.index + 2]
                if following == "\n":
                    self.index += 2
                    continue
                if not following:
                    raise Blocked("trailing backslash")
                self.add(following, quoted=True)
                self.index += 2
                continue
            if char == "'":
                end = text.find("'", self.index + 1)
                if end < 0:
                    raise Blocked("unterminated single quote")
                self.add(text[self.index + 1 : end], quoted=True)
                self.index = end + 1
                continue
            if char == '"':
                self.double_quoted()
                continue
            if char == "$":
                self.dollar(in_double=False)
                continue
            if char == "`":
                self.backquote()
                continue
            if char == "#" and not self.word.started:
                end = text.find("\n", self.index)
                self.index = len(text) if end < 0 else end
                continue
            if char in " \t":
                self.finish_word()
                self.index += 1
                continue
            if char in "<>" and text[self.index + 1 : self.index + 2] == "(":
                end = matching_close(text, self.index + 2, "(", ")")
                self.word.bodies.append(text[self.index + 2 : end - 1])
                self.add(text[self.index : end], dynamic=True)
                self.index = end
                continue
            redirect = next((r for r in REDIRECTS if text.startswith(r, self.index)), None)
            if redirect:
                # A digit-only word just before a redirect is its fd, not an argument.
                if self.word.started and self.word.text.isdigit() and not self.word.quoted:
                    self.word = Word()
                self.finish_word()
                self.index += len(redirect)
                if redirect in ("<<", "<<-"):
                    self.expect = "heredoc"
                    self.heredoc_strip = redirect == "<<-"
                elif redirect == "<<<":
                    self.expect = "herestring"
                elif redirect in ("<", "<&"):
                    self.expect = "input"
                else:
                    self.expect = "redirect"
                continue
            operator = next((o for o in OPERATORS if text.startswith(o, self.index)), None)
            if operator:
                self.finish_command(operator)
                self.index += len(operator)
                if operator == "(":
                    self.depth += 1
                    self.current.depth = self.depth
                elif operator == ")":
                    self.depth = max(0, self.depth - 1)
                    self.current.depth = self.depth
                if operator == "\n" and self.pending_heredocs:
                    self.read_heredocs()
                continue
            if char in "*?[" or (char == "{" and self.brace_expands()):
                # Pathname or brace expansion: the LITERAL prefix survives, so
                # only a word that starts with one could turn into a flag.
                if not self.word.started:
                    self.word.glob_leading = True
                self.word.glob = True
                if char == "{":
                    self.word.braces = True
                self.add(char)
                self.index += 1
                continue
            self.add(char)
            self.index += 1
        self.finish_command(";")
        if self.pending_heredocs:
            # A heredoc with no body line yet: treat what follows as empty.
            for _delimiter, _strip, command, _expands in self.pending_heredocs:
                command.heredocs.append("")
        return self.commands

    def brace_expands(self) -> bool:
        end = self.text.find("}", self.index)
        if end < 0:
            return False
        inner = self.text[self.index + 1 : end]
        # A list `{a,b}` or a sequence expression `{1..3}`; not a path.
        listed = "," in inner or re.search(r"\.\.", inner) is not None
        return listed and not re.search(r"[\s;&|]", inner)

    def double_quoted(self) -> None:
        text = self.text
        self.index += 1
        self.word.quoted = True
        self.word.started = True
        while self.index < len(text):
            char = text[self.index]
            if char == '"':
                self.index += 1
                return
            if char == "\\" and text[self.index + 1 : self.index + 2] in ('$', '`', '"', "\\", "\n"):
                if text[self.index + 1] != "\n":
                    self.add(text[self.index + 1], quoted=True)
                self.index += 2
                continue
            if char == "$":
                self.dollar(in_double=True)
                continue
            if char == "`":
                self.backquote()
                continue
            self.add(char, quoted=True)
            self.index += 1
        raise Blocked("unterminated double quote")


def substitution_bodies(text: str) -> list[str]:
    """Programs of the ``$(...)`` and backquotes inside ``${...}`` text."""

    try:
        lexer = Lexer(f"_ {text}")
        commands = lexer.run()
    except Blocked:
        return [text]
    return [body for command in commands for word in command.words for body in word.bodies]


def parse(script: str) -> list[Command]:
    return Lexer(script).run()


# ---------------------------------------------------------------------------
# Analysis.
# ---------------------------------------------------------------------------

SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "mksh", "fish"}
# Script operands that name the shell's own stdin.
STDIN_SCRIPTS = {"-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"}
# `source -` reads a file named "-": only a shell takes a lone - as stdin.
SOURCED_STDIN = STDIN_SCRIPTS - {"-"}
INLINE_INTERPRETERS = {
    "python", "python2", "python3", "node", "nodejs", "bun", "deno", "perl",
    "ruby", "php", "lua", "osascript", "pwsh", "tsx", "ts-node",
}
WRAPPERS = {
    "command", "builtin", "exec", "nohup", "time", "nice", "sudo", "doas",
    "env", "timeout", "stdbuf", "caffeinate", "noglob", "then", "do", "else",
    "elif", "if", "while", "until", "!", "{", "}",
}
CONTROL_WORDS = {"fi", "done", "esac", "in"}
# Reserved words take no options: `if -x` runs a command named -x.
KEYWORD_WRAPPERS = {"then", "do", "else", "elif", "if", "while", "until", "!", "{", "}"}
# Each wrapper's (flags, value-taking options), so the command it runs is
# found past its options' values (`caffeinate -t 60 git …`).
WRAPPER_OPTIONS: dict[str, tuple[set[str], set[str]]] = {
    "command": ({"-p", "-v", "-V"}, set()),
    "exec": ({"-c", "-l"}, {"-a"}),
    "time": (
        {"-p", "-l", "-h", "-a", "-v", "-q", "--portability", "--verbose", "--quiet", "--append"},
        {"-o", "-f", "--output", "--format"},
    ),
    "nice": (set(), {"-n", "--adjustment"}),
    "sudo": (
        {
            "-A", "-b", "-B", "-E", "-e", "-H", "-i", "-K", "-k", "-l", "-N", "-n", "-P", "-S", "-s", "-V", "-v",
            "--askpass", "--background", "--bell", "--preserve-env", "--edit", "--set-home", "--login",
            "--remove-timestamp", "--reset-timestamp", "--list", "--no-update", "--non-interactive",
            "--preserve-groups", "--stdin", "--shell", "--version", "--validate",
        },
        {
            "-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t", "-D", "-R", "-T", "--user", "--group",
            "--close-from", "--host", "--prompt", "--other-user", "--role", "--type", "--chdir",
            "--chroot", "--command-timeout",
        },
    ),
    "doas": ({"-n", "-s", "-L"}, {"-u", "-C"}),
    "env": (
        {"-i", "-0", "-v", "--ignore-environment", "--null", "--debug"},
        {"-u", "-C", "-S", "-P", "-L", "-U", "--unset", "--chdir", "--split-string"},
    ),
    "timeout": (
        {"-f", "-p", "-v", "--foreground", "--preserve-status", "--verbose"},
        {"-k", "-s", "--kill-after", "--signal"},
    ),
    "stdbuf": (set(), {"-i", "-o", "-e", "--input", "--output", "--error"}),
    "caffeinate": ({"-d", "-i", "-m", "-s", "-u"}, {"-t", "-w"}),
}
# Words a git flag scan never needs to see: they only appear as the program
# of opaque interpreters, where a textual scan is all that is possible.
RISKY_TEXT = re.compile(
    r"no-verify|hookspath|core\.hooks|--force|--mirror|git_config|alias\.|\+refs/|remote\.[^\s=]*\.push",
    re.IGNORECASE,
)
# `git` as a word of its own (a program name or path), not `.git` or `digit`.
GIT_WORD = re.compile(r"(?<![\w.-])git(?![\w.-])")
GIT_ENV_INJECTION = re.compile(
    r"^(GIT_CONFIG(_[A-Z0-9_]*)?|GIT_EXEC_PATH|GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE)$"
)
# Any case: macOS's default filesystem reads `.GIT/Config` as `.git/config`.
GIT_CONFIG_FILE = re.compile(
    r"(^|/)(\.git/(config|config\.worktree|hooks(/|$))|config\.worktree$)", re.IGNORECASE
)


def writes_git_config(path: str) -> bool:
    """Whether a literal write target names git's config or hooks, as written or
    with `.`, `..` and doubled slashes resolved (`.git/./config`, `.git//config`,
    `.git/hooks/../config`). Both forms count, so normalising never drops one."""
    return any(GIT_CONFIG_FILE.search(form) for form in (path, posixpath.normpath(path)))
GIT_GLOBAL_VALUE_OPTS = {
    "-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace",
    "--exec-path", "--super-prefix", "--attr-source", "--list-cmds",
}
REMOTE_PUSH_KEY = re.compile(r"(?i)^remote\..+\.push$")
UNRESOLVABLE = re.compile(r"[$`*?\[]|^~")
KNOWN_SUBCOMMANDS = {
    "add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch",
    "bundle", "cat-file", "check-attr", "check-ignore", "check-ref-format",
    "checkout", "cherry", "cherry-pick", "clean", "clone", "commit",
    "commit-graph", "commit-tree", "config", "count-objects", "describe",
    "diff", "diff-files", "diff-index", "diff-tree", "difftool", "fetch",
    "for-each-ref", "format-patch", "fsck", "gc", "grep", "hash-object", "help",
    "init", "log", "ls-files", "ls-remote", "ls-tree", "maintenance", "merge",
    "merge-base", "merge-file", "merge-tree", "mergetool", "mv", "name-rev",
    "notes", "pack-refs", "prune", "pull", "push", "range-diff", "read-tree",
    "rebase", "reflog", "remote", "repack", "replace", "reset", "restore",
    "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-branch",
    "show-ref", "sparse-checkout", "stash", "status", "submodule", "switch",
    "symbolic-ref", "tag", "update-index", "update-ref", "var", "verify-commit",
    "verify-pack", "verify-tag", "version", "whatchanged", "worktree",
    "write-tree",
}


def is_no_verify(word: str) -> bool:
    """``--no-verify`` or an abbreviation git could resolve to it."""

    name = word.split("=", 1)[0]
    return len(name) >= 6 and name.startswith("--no-v") and "--no-verify".startswith(name)


DANGEROUS_LONG = ("--force", "--force-with-lease", "--mirror")


def dangerous_long(word: str) -> str | None:
    # The option as typed, which git accepts as any unambiguous abbreviation.
    typed = word.split("=", 1)[0]
    if not typed.startswith("--") or len(typed) < 3:
        return None
    for full in DANGEROUS_LONG:
        if full.startswith(typed):
            return full
    return None


@dataclass
class Scope:
    """What earlier commands in the same script changed for later ones."""

    cwd: str | None
    # Git-configuration variables exported to every later command.
    env_injected: frozenset[str] = frozenset()
    # `set -a`: every later assignment is exported.
    allexport: bool = False
    # Git-configuration variables `unset` or `export -n` took from every later
    # command; "*" stands for all of them.
    env_dropped: frozenset[str] = frozenset()


BRACE_LIMIT = 256


def brace_alternatives(text: str) -> list[str] | None:
    """The words bash's brace expansion makes of ``text`` (`--{force,x}` is
    `--force --x`), or None when this reader cannot expand it faithfully."""

    for start, char in enumerate(text):
        if char != "{" or (start > 0 and text[start - 1] == "$"):
            continue
        depth = 0
        commas: list[int] = []
        end = -1
        for index in range(start, len(text)):
            if text[index] == "{":
                depth += 1
            elif text[index] == "}":
                depth -= 1
                if depth == 0:
                    end = index
                    break
            elif text[index] == "," and depth == 1:
                commas.append(index)
        if end < 0:
            return [text]
        inner = text[start + 1 : end]
        prefix, suffix = text[:start], text[end + 1 :]
        if commas:
            cuts = [start, *commas, end]
            parts = [text[cuts[i] + 1 : cuts[i + 1]] for i in range(len(cuts) - 1)]
        else:
            sequence = re.fullmatch(r"(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?", inner)
            if sequence is None:
                continue  # `{x}` is literal; a later group may still expand
            first, last, step_text = sequence.groups()
            step = abs(int(step_text)) if step_text else 1
            if first.lstrip("-").isdigit() != last.lstrip("-").isdigit() or step == 0:
                return None
            # Counted before it is built: `{1..1000000000}` would exhaust the
            # guard's memory or time, even in a branch bash never runs.
            span = abs(int(last) - int(first)) if first.lstrip("-").isdigit() else abs(ord(last) - ord(first))
            if span // step + 1 > BRACE_LIMIT:
                return None
            if first.lstrip("-").isdigit():
                low, high = int(first), int(last)
                values = range(low, high + (1 if high >= low else -1), step if high >= low else -step)
                parts = [str(value) for value in values]
            else:
                low, high = ord(first), ord(last)
                values = range(low, high + (1 if high >= low else -1), step if high >= low else -step)
                parts = [chr(value) for value in values]
            if len(parts) > BRACE_LIMIT:
                return None
        out: list[str] = []
        for part in parts:
            expanded = brace_alternatives(prefix + part + suffix)
            if expanded is None:
                return None
            out.extend(expanded)
            if len(out) > BRACE_LIMIT:
                return None
        return out
    return [text]


def expand_braces(words: list[Word]) -> list[Word]:
    """Each brace-expanded word as the words bash makes of it. One this
    reader cannot expand (a quoted part, too many results) becomes a computed
    word, which every check treats as possibly anything."""

    out: list[Word] = []
    for word in words:
        if not word.braces or word.is_assignment() is not None:
            out.append(word)
            continue
        alternatives = None if word.first_quoted is not None else brace_alternatives(word.text)
        if alternatives is None:
            out.append(Word(text=word.text, dynamic=True, quoted=word.quoted, bodies=word.bodies, started=True, first_dynamic=0))
            continue
        for index, text in enumerate(alternatives):
            out.append(
                Word(
                    text=text,
                    dynamic=word.dynamic,
                    quoted=word.quoted,
                    bodies=word.bodies if index == 0 else [],
                    started=True,
                    first_dynamic=word.first_dynamic,
                    glob=any(char in text for char in "*?["),
                    glob_leading=text[:1] in ("*", "?", "["),
                )
            )
    return out


class Analyzer:
    def __init__(self, base_cwd: str | None, read_config: bool = True, paired_changes: Sequence[Any] = ()) -> None:
        self.base_cwd = base_cwd
        self.read_config = read_config
        # The consumer's paired changes (config.PairedChange: `changes`,
        # `requires`, `reason`); empty turns the env -C half of that rule off.
        self.paired_changes = tuple(paired_changes)
        # A git-configuration variable the current nested program inherits.
        self.inherited: str | None = None
        # The git-configuration variables this guard's own lookups inherit
        # (`git_read` runs with the hook's environment), so a command that
        # drops one runs a git that reads another repository or configuration.
        self.hook_selectors = frozenset(name for name in os.environ if GIT_ENV_INJECTION.match(name))
        # The current command (or a program it runs) was moved by `env -C`,
        # which bash_guard.py's paired-change model does not follow.
        self.chdir_by_env = False

    # -- entry -------------------------------------------------------------

    def script(self, text: str, cwd: str | None, depth: int = 0, into: Scope | None = None) -> None:
        """Analyse ``text`` as a shell program run in ``cwd``. ``into`` is the
        scope of a caller whose own shell runs it (`eval`, `source` of a
        heredoc): its cd, exports and `set -a` then hold for the caller's
        later commands too, as they do in bash."""

        if depth > MAX_DEPTH:
            raise Blocked("nested shell programs too deep to verify")
        try:
            commands = parse(text)
        except Blocked as error:
            # Bash runs every complete line before the one it cannot parse, so
            # an unparseable script that runs git at all (`git push -f` on a
            # line of its own, then an unterminated quote) is refused whole.
            if RISKY_TEXT.search(text) or GIT_WORD.search(text):
                raise Blocked(f"the command cannot be parsed ({error}) and runs git or mentions a hook or push override") from None
            return
        scope = into or Scope(
            cwd=cwd,
            env_injected=frozenset({self.inherited}) if self.inherited else frozenset(),
        )
        stack: list[str | None] = []
        last_depth = 0
        for command in commands:
            while command.depth > last_depth:
                stack.append(scope.cwd)
                last_depth += 1
            while command.depth < last_depth:
                scope.cwd = stack.pop() if stack else scope.cwd
                last_depth -= 1
            self.command(command, scope, depth)

    # -- one command -----------------------------------------------------------

    def command(self, command: Command, scope: Scope, depth: int) -> None:
        # Programs this command runs in a nested shell (bash -c, eval, xargs,
        # find -exec, aliases) inherit its environment, so a git configuration
        # injected here -- by an earlier export or by this command's own
        # NAME=value prefix -- reaches the git inside them too.
        saved = self.inherited
        saved_chdir = self.chdir_by_env
        try:
            # A command xargs, find -exec or eval runs keeps what the command
            # that ran it was given (`GIT_CONFIG_COUNT=1 xargs git commit`).
            self.inherited = min(scope.env_injected) if scope.env_injected else saved
            self.one_command(command, scope, depth)
        finally:
            self.inherited = saved
            self.chdir_by_env = saved_chdir

    def one_command(self, command: Command, scope: Scope, depth: int) -> None:
        for word in [
            *command.words,
            *command.redirect_targets,
            *command.input_targets,
            *command.herestrings,
        ]:
            for body in word.bodies:
                self.script(body, scope.cwd, depth + 1)
        for body in command.expanded_bodies:
            self.script(body, scope.cwd, depth + 1)
        for target in command.redirect_targets:
            if not target.dynamic and writes_git_config(target.text):
                raise Blocked(f"writing '{target.text}' directly can disable the repository hooks. {HOOK_REMEDY}")

        # `git push --{force,verbose}` is `git push --force --verbose`.
        words = expand_braces(list(command.words))
        assignments: list[str] = []
        chdirs: list[Word] = []
        # Variables `env -u NAME` or `env -i` ("*") take from the command.
        drops: list[str] = []
        # Leading NAME=value words, then wrappers and their own options.
        index = 0
        while index < len(words):
            word = words[index]
            assigned = word.is_assignment()
            if assigned is not None:
                assignments.append(assigned)
                index += 1
                continue
            name = os.path.basename(word.text) if not word.dynamic else word.text
            # Quoting a wrapper's name does not stop bash running it:
            # `'env' git push --force` is env running git.
            if name in WRAPPERS:
                index = self.skip_wrapper(words, index, assignments, chdirs, drops)
                continue
            if name in ("coproc", "function") and not word.dynamic:
                # `coproc [NAME] { …; }` and `function NAME { …; }` run the
                # body that follows: a NAME is skipped only before a group,
                # since `coproc NAME cmd` runs the simple command NAME.
                index += 1
                if name == "function" or (index + 1 < len(words) and words[index + 1].text in ("{", "(")):
                    index += 1
                continue
            break
        words = words[index:]
        if chdirs:
            # `env -C DIR cmd` runs cmd in DIR: its git reads DIR's config.
            cwd = scope.cwd
            for chdir in chdirs:
                cwd = self.resolve_dir(chdir, cwd, strict=False)
            scope = Scope(
                cwd=cwd, env_injected=scope.env_injected, allexport=scope.allexport, env_dropped=scope.env_dropped
            )
            self.chdir_by_env = True
        if drops:
            # `env -u NAME` / `env -i` drop NAME for this command only.
            scope = Scope(
                cwd=scope.cwd,
                env_injected=scope.env_injected,
                allexport=scope.allexport,
                env_dropped=scope.env_dropped | frozenset(drops),
            )
        self.dropped_selector(scope, words)
        for name in assignments:
            if GIT_ENV_INJECTION.match(name):
                if not words:
                    # `NAME=value` alone sets a shell variable, which git sees
                    # only once it is exported: by `set -a`, by an earlier
                    # export, or by the environment this shell started with.
                    if scope.allexport or name in scope.env_injected or name in os.environ:
                        scope.env_injected = scope.env_injected | {name}
                else:
                    self.injected(name, words)
                    self.inherited = name
        if not words:
            return
        head = words[0]
        name = os.path.basename(head.text)
        if head.dynamic:
            # A computed command may be a wrapper (`$W git push -f`, W=env):
            # its arguments are then a command of their own.
            if any(RISKY_TEXT.search(word.text) or is_no_verify(word.text) or GIT_WORD.search(word.text) for word in words[1:]):
                raise Blocked(f"'{head.text}' is computed at run time and its arguments run git or override hooks or pushes. {HOOK_REMEDY}")
            return
        if name in ("export", "declare", "typeset", "readonly", "local"):
            # `export -n NAME` keeps the variable but stops exporting it. Any
            # other declaration of a git-configuration name is read as an
            # export, which fails closed for `local` and plain `declare`.
            unexport = name == "export" and any(
                not word.dynamic and re.fullmatch(r"-[a-z]*n[a-z]*", word.text) for word in words[1:]
            )
            for word in words[1:]:
                match = re.match(r"([A-Za-z_][A-Za-z0-9_]*)", word.text)
                if match and GIT_ENV_INJECTION.match(match.group(1)):
                    if unexport:
                        scope.env_injected = scope.env_injected - {match.group(1)}
                        scope.env_dropped = scope.env_dropped | {match.group(1)}
                    else:
                        scope.env_injected = scope.env_injected | {match.group(1)}
            return
        if name == "unset":
            # `unset NAME` takes the variable from every later command (`-f`
            # is read the same way, as bash_guard.py does). A computed
            # name may be any variable.
            for word in words[1:]:
                if word.dynamic:
                    scope.env_dropped = scope.env_dropped | {"*"}
                elif GIT_ENV_INJECTION.match(word.text):
                    scope.env_dropped = scope.env_dropped | {word.text}
            return
        if name == "set":
            self.set_options(words[1:], scope)
            return
        if name == "cd" and len(words) > 1:
            scope.cwd = self.resolve_dir(words[1], scope.cwd, strict=False)
            return
        if name in CONTROL_WORDS:
            return
        if name in SHELLS:
            self.shell(command, words, scope, depth)
            return
        if name in ("source", "."):
            self.source(command, words, scope, depth)
            return
        if name == "eval":
            if any(word.dynamic for word in words[1:]):
                raise Blocked("eval of a computed string cannot be verified")
            self.script(" ".join(word.text for word in words[1:]), scope.cwd, depth + 1, scope)
            return
        if name == "xargs":
            self.xargs(words, scope, depth)
            return
        if name == "find":
            self.find_exec(words, scope, depth)
            return
        if name in INLINE_INTERPRETERS or re.fullmatch(r"python\d+(\.\d+)*", name):
            for word in words[1:]:
                if RISKY_TEXT.search(word.text):
                    raise Blocked(f"an inline {name} program mentions a hook or push override. {HOOK_REMEDY}")
            return
        if name in ("tee", "cp", "mv", "ln", "install", "dd", "sed", "perl", "truncate"):
            for word in self.written_operands(name, words[1:]):
                if not word.dynamic and writes_git_config(word.text.removeprefix("of=")):
                    if name != "sed" or any(w.text.startswith("-i") or w.text.startswith("--in-place") for w in words[1:]):
                        raise Blocked(f"'{name}' on '{word.text}' can disable the repository hooks. {HOOK_REMEDY}")
        if name == "git":
            self.git(words, scope, depth)

    @staticmethod
    def written_operands(name: str, operands: list[Word]) -> list[Word]:
        """The operands ``name`` may write. cp, ln and install write only their
        destination (the last operand, or ``-t DIR``), so copying .git/config
        out is a read; every other writer is judged on all its operands."""

        if name not in ("cp", "ln", "install"):
            return operands
        for index, word in enumerate(operands):
            if word.text in ("-t", "--target-directory") and index + 1 < len(operands):
                return [operands[index + 1]]
            if word.text.startswith("--target-directory="):
                return [word]
        if any(word.dynamic for word in operands):
            return operands
        plain = [word for word in operands if not word.text.startswith("-")]
        return plain[-1:] if plain else operands

    def skip_wrapper(
        self, words: list[Word], index: int, assignments: list[str], chdirs: list[Word], drops: list[str]
    ) -> int:
        """The index of the command a wrapper runs, past its own options.

        Each wrapper's options are read from WRAPPER_OPTIONS, values included
        (`caffeinate -t 60 git …`: 60 is no command). An option this table does
        not know may take a value, so the command is unknown: refused when
        what follows mentions git or a hook or push override.
        """

        name = os.path.basename(words[index].text)
        index += 1
        if name in KEYWORD_WRAPPERS:
            return index
        flags, values = WRAPPER_OPTIONS.get(name, (set(), set()))
        while index < len(words):
            word = words[index]
            text = word.text
            if name == "env" and text == "-":
                index += 1  # `env -` is `env -i`
                drops.append("*")
                continue
            if name == "env" and not text.startswith("-"):
                # env takes every NAME=VALUE argument as an assignment, quoted
                # or not (`env 'X=y' git …`), up to its first command word.
                literal = text if word.first_dynamic is None else text[: word.first_dynamic]
                if "=" in literal and not literal.startswith("="):
                    assignments.append(literal.split("=", 1)[0])
                    index += 1
                    continue
                break
            if not text.startswith("-") or text == "-" or word.dynamic:
                break
            index += 1
            if text == "--":
                break
            option, has_value, attached = text.partition("=")
            if option.startswith("--"):
                if option in values:
                    if has_value:
                        value = Word(text=attached, dynamic=word.dynamic, started=True)
                    else:
                        value = words[index] if index < len(words) else Word(text="", started=True)
                        index += 1
                    self.wrapper_value(name, option, value, chdirs, drops)
                    continue
                if option in flags:
                    if name == "env" and option == "--ignore-environment":
                        drops.append("*")
                    continue
            elif name == "nice" and re.fullmatch(r"-\d+", text):
                continue
            else:
                known = True
                for position, letter in enumerate(text[1:], start=1):
                    short = f"-{letter}"
                    if short in values:
                        if position + 1 < len(text):
                            value = Word(text=text[position + 1 :], dynamic=word.dynamic, started=True)
                        else:
                            value = words[index] if index < len(words) else Word(text="", started=True)
                            index += 1
                        self.wrapper_value(name, short, value, chdirs, drops)
                        break
                    if short not in flags:
                        known = False
                        break
                    if name == "env" and short == "-i":
                        drops.append("*")
                if known:
                    continue
            if any(RISKY_TEXT.search(w.text) or GIT_WORD.search(w.text) or is_no_verify(w.text) for w in words[index:]):
                raise Blocked(f"'{name} {text}' is an option this guard does not know, so the command it runs cannot be verified")
        if name == "timeout" and index < len(words):
            index += 1  # the duration
        return index

    @staticmethod
    def wrapper_value(name: str, option: str, value: Word, chdirs: list[Word], drops: list[str]) -> None:
        if name == "env" and option in ("-S", "--split-string"):
            raise Blocked("env -S splits a string into a command that cannot be verified")
        if name == "env" and option in ("-C", "--chdir"):
            chdirs.append(value)
        if name == "env" and option in ("-u", "--unset"):
            drops.append("*" if value.dynamic else value.text)

    def lost_selectors(self, scope: Scope) -> frozenset[str]:
        """The hook's git-configuration variables this command runs without.

        The guard's lookups (`git_read`) inherit the hook's environment, so
        when `env -u`/`env -i` or an earlier `unset`/`export -n` drops the
        hook's own `GIT_DIR` or `GIT_CONFIG_*`, the command's git reads another
        repository or configuration than the one the lookup checked.
        """

        if "*" in scope.env_dropped:
            return self.hook_selectors
        return self.hook_selectors & scope.env_dropped

    def refuse_lost(self, scope: Scope) -> None:
        lost = self.lost_selectors(scope)
        if lost:
            raise Blocked(
                f"'{min(lost)}' is set for this guard, and the command runs git without it, so git would "
                f"read a repository or configuration the guard did not check. {HOOK_REMEDY}"
            )

    def dropped_selector(self, scope: Scope, words: list[Word]) -> None:
        """Another program run without a hook selector may run git in a nested
        program, whose lookups this guard makes with the hook's environment.
        Git itself is refused only where its configuration is read."""

        if not words or (not words[0].dynamic and os.path.basename(words[0].text) == "git"):
            return
        if any(word.dynamic or GIT_WORD.search(word.text) for word in words):
            self.refuse_lost(scope)

    @staticmethod
    def set_options(args: list[Word], scope: Scope) -> None:
        """`set -a` and `set -o allexport` export every later assignment;
        `+a` and `+o allexport` stop it. A cluster with `o` takes the next
        word as an option name (`set -eo allexport`). Options end at `--`,
        `-` or the first operand. A computed word may be any of them, so it
        turns the export on."""

        position = 0
        while position < len(args):
            word = args[position]
            if word.dynamic:
                scope.allexport = True
                return
            text = word.text
            if text in ("--", "-") or not re.fullmatch(r"[-+][A-Za-z]+", text):
                return
            on = text.startswith("-")
            if "a" in text:
                scope.allexport = on
            if "o" in text:
                position += 1
                if position < len(args) and (args[position].dynamic or args[position].text == "allexport"):
                    scope.allexport = on or args[position].dynamic
            position += 1

    def injected(self, name: str, words: list[Word]) -> None:
        if os.path.basename(words[0].text) == "git" or words[0].dynamic:
            raise Blocked(
                f"'{name}' injects git configuration or repository selection through the "
                f"environment, which this guard cannot verify. {HOOK_REMEDY}"
            )

    # -- nested programs ---------------------------------------------------------

    def shell(self, command: Command, words: list[Word], scope: Scope, depth: int) -> None:
        args = words[1:]
        # bash reads options up to its first operand: `-c` anywhere among them
        # makes that operand the program. `-o`/`-O` and the rc-file options
        # take a value, which is no operand (`bash -o pipefail -c '...'`).
        command_flag = False
        stdin_flag = False
        index = 0
        while index < len(args):
            word = args[index]
            text = word.text
            if word.dynamic:
                # A computed word could be `-c`: then a later word is a program.
                if any(RISKY_TEXT.search(w.text) or GIT_WORD.search(w.text) or is_no_verify(w.text) for w in args[index + 1 :]):
                    raise Blocked("a shell whose options are computed at run time cannot be verified")
                break
            if text == "--":
                index += 1
                break
            if text in ("-o", "+o", "-O", "+O", "--rcfile", "--init-file"):
                index += 2
                continue
            if re.fullmatch(r"[-+][A-Za-z]+", text):
                if text.startswith("-") and "c" in text[1:]:
                    command_flag = True
                if text.startswith("-") and "s" in text[1:]:
                    stdin_flag = True
                index += 1
                continue
            if text.startswith("--"):
                index += 1
                continue
            break
        operands = args[index:]
        self.shell_program(command, operands, command_flag, stdin_flag, scope, depth)

    def source(self, command: Command, words: list[Word], scope: Scope, depth: int) -> None:
        """`source FILE` / `. FILE` runs FILE in this shell: a committed file is
        out of scope, but stdin or a process substitution is the command's own."""
        operands = words[1:]
        if operands and operands[0].text == "--":
            operands = operands[1:]
        if operands and (operands[0].text in SOURCED_STDIN or operands[0].text.startswith("<(")):
            self.shell_program(command, operands, False, False, scope, depth, same_shell=True)

    def shell_program(
        self,
        command: Command,
        operands: list[Word],
        command_flag: bool,
        stdin_flag: bool,
        scope: Scope,
        depth: int,
        *,
        same_shell: bool = False,
    ) -> None:
        # `source` of a heredoc or here-string runs it in this shell; a pipe
        # into `source` runs it in a subshell, as does every `bash`.
        into = scope if same_shell else None
        if operands and operands[0].text.startswith("<("):
            raise Blocked("a shell running a process substitution's output cannot be verified")
        if not command_flag and (stdin_flag or (operands and operands[0].text in STDIN_SCRIPTS)):
            # `bash -s args`, `bash /dev/stdin`, `bash -`: the program is stdin,
            # the operands only its positional arguments.
            operands = []
        if command_flag:
            if not operands:
                return
            program = operands[0]
            # The literal parts and substitutions are analysed first, for the
            # most specific refusal; a program with any computed part is then
            # refused anyway, since the computed part is code this guard never
            # sees (`bash -c "$P # --force"` runs whatever P holds).
            self.script(program.text, scope.cwd, depth + 1)
            for body in program.bodies:
                self.script(body, scope.cwd, depth + 1)
            if program.dynamic:
                raise Blocked("a nested shell program built at run time cannot be verified")
            return
        if operands:
            return  # a script file: committed code, out of this guard's scope
        for body in command.heredocs:
            self.script(body, scope.cwd, depth + 1, into)
        for word in command.herestrings:
            if word.dynamic:
                raise Blocked("a shell reading a computed here-string cannot be verified")
            self.script(word.text, scope.cwd, depth + 1, into)
        source = command.piped_from
        if source is not None:
            head = os.path.basename(source.words[0].text) if source.words else ""
            if head in ("echo", "printf") and not any(w.dynamic for w in source.words[1:]):
                if head == "echo":
                    texts = [w.text for w in source.words[1:] if not re.fullmatch(r"-[neE]+", w.text)]
                    raw = " ".join(texts)
                    # Whether echo decodes escapes depends on -e, xpg_echo and
                    # which shell's echo runs, and either reading can hide a
                    # command from the other (`\x27` is a quote only once
                    # decoded), so both are analysed.
                    for program in dict.fromkeys((raw, printf_unescape(raw))):
                        self.script(program, scope.cwd, depth + 1)
                    return
                rendered = render_printf([w.text for w in source.words[1:]])
                if rendered is None:
                    raise Blocked("a shell reading printf output in a format this guard cannot render cannot be verified")
                self.script(rendered, scope.cwd, depth + 1)
                return
            raise Blocked("a shell reading its program from a pipe cannot be verified")

    def xargs(self, words: list[Word], scope: Scope, depth: int) -> None:
        index = 1
        value_options = {"-I", "-i", "-n", "-L", "-l", "-P", "-s", "-d", "-E", "-e", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs"}
        while index < len(words) and words[index].text.startswith("-"):
            index += 2 if words[index].text in value_options else 1
        rest = words[index:]
        if rest:
            # xargs runs the rest as a command of its own -- wrappers and all
            # (`xargs env git push --force`) -- with words read from stdin
            # appended: an unknown, possibly a flag.
            self.command(Command(words=[*rest, Word(text="$XARGS", dynamic=True, started=True)]), scope, depth + 1)

    def find_exec(self, words: list[Word], scope: Scope, depth: int) -> None:
        for index, word in enumerate(words):
            if word.text in ("-exec", "-execdir", "-ok", "-okdir"):
                inner: list[Word] = []
                for item in words[index + 1 :]:
                    if item.text in (";", "+"):
                        break
                    inner.append(item)
                if inner:
                    self.command(Command(words=inner), scope, depth + 1)

    # -- git -----------------------------------------------------------------------

    def resolve_dir(self, word: Word, base: str | None, *, strict: bool) -> str | None:
        if word.dynamic or UNRESOLVABLE.search(word.text):
            if strict:
                raise Blocked(f"cannot statically resolve the directory '{word.text}'.\n{AMBIGUOUS_REMEDY}")
            return "\0unresolved"
        root = base if base and base != "\0unresolved" else (self.base_cwd or os.getcwd())
        if base == "\0unresolved" and not os.path.isabs(word.text):
            return "\0unresolved"
        return word.text if os.path.isabs(word.text) else os.path.join(root, word.text)

    def git(self, words: list[Word], scope: Scope, depth: int) -> None:
        injected = min(scope.env_injected) if scope.env_injected else self.inherited
        if injected:
            raise Blocked(
                f"'{injected}' was set earlier in this command and injects git "
                f"configuration through the environment. {HOOK_REMEDY}"
            )
        index = 1
        overrides: list[tuple[str, Word]] = []
        cds: list[Word] = []
        git_dir: Word | None = None
        while index < len(words) and words[index].text.startswith("-"):
            word = words[index]
            option, _, attached = word.text.partition("=")
            if word.text.startswith("-c") and word.text != "-c" and not word.text.startswith("--"):
                overrides.append(("-c", Word(text=word.text[2:], dynamic=word.dynamic, started=True)))
                index += 1
                continue
            if option in GIT_GLOBAL_VALUE_OPTS:
                if attached or "=" in word.text:
                    value = Word(text=attached, dynamic=word.dynamic, started=True)
                    index += 1
                elif index + 1 < len(words):
                    value = words[index + 1]
                    index += 2
                else:
                    index += 1
                    continue
                if option == "-C":
                    cds.append(value)
                elif option == "--git-dir":
                    git_dir = value
                elif option in ("-c", "--config-env"):
                    overrides.append((option, value))
                continue
            index += 1
        for option, value in overrides:
            self.override(option, value)
        if index >= len(words):
            return
        sub = words[index]
        args = words[index + 1 :]
        if sub.dynamic:
            if any(is_no_verify(w.text) or RISKY_TEXT.search(w.text) for w in args):
                raise Blocked(f"a computed git subcommand with hook or push overrides cannot be verified. {HOOK_REMEDY}")
            return
        name = sub.text
        if name not in KNOWN_SUBCOMMANDS:
            self.alias(name, args, scope, cds, depth, git_dir, overrides)
        if name == "commit":
            stages_all = self.commit(args)
            if self.chdir_by_env and self.paired_changes:
                self.env_chdir_paired(stages_all, scope, cds, git_dir)
        elif name == "push":
            self.push(args, scope, cds, git_dir, overrides)
        elif name == "config":
            self.config(args)
        else:
            for word in args:
                if word.text == "--":
                    break
                if is_no_verify(word.text):
                    raise Blocked(f"--no-verify is forbidden on all git commands. {HOOK_REMEDY}")

    def override(self, option: str, value: Word) -> None:
        key, _, setting = value.text.partition("=")
        lowered = key.strip().lower()
        if value.dynamic and not re.fullmatch(r"[a-z0-9._-]+", lowered):
            # `K=core.hooksPath; git -c "$K=/dev/null"`: the key is only known
            # once the shell expands it, so no literal-key rule can apply.
            raise Blocked(f"'{option} {value.text}' computes its configuration key in the shell, so it cannot be verified. {HOOK_REMEDY}")
        if lowered == "core.hookspath":
            raise Blocked(f"'{option} {key}=...' repoints the repository hooks. {HOOK_REMEDY}")
        if lowered.startswith("alias."):
            raise Blocked(f"'{option} {key}=...' defines an alias this guard cannot see through. {HOOK_REMEDY}")
        if lowered in ("include.path",) or (lowered.startswith("includeif.") and lowered.endswith(".path")):
            raise Blocked(f"'{option} {key}=...' includes configuration this guard cannot read. {HOOK_REMEDY}")

    def push_override(self, option: str, value: Word) -> None:
        """A `-c remote.<r>.push=+...` forces this invocation alone.

        Verified against git: a plain push rejected as non-fast-forward
        succeeds with `(forced update)` under this override. Only judged once
        the command is known to be a push, so `git -c ... config --list` is
        untouched.
        """

        key, _, setting = value.text.partition("=")
        if REMOTE_PUSH_KEY.match(key.strip()):
            if option == "--config-env" or value.dynamic:
                raise Blocked(
                    f"'{option} {key}=...' sets a push refspec from a value this guard cannot read, "
                    f"so it cannot be proven non-forcing.\n{FORCE_REMEDY}"
                )
            if setting.strip().startswith("+"):
                raise Blocked(f"'{option} {value.text}' sets a forcing '+' push refspec.\n{FORCE_REMEDY}")

    def alias(
        self,
        name: str,
        args: list[Word],
        scope: Scope,
        cds: list[Word],
        depth: int,
        git_dir: Word | None = None,
        overrides: list[tuple[str, Word]] | None = None,
    ) -> None:
        if not self.read_config:
            return
        # Past the limit the alias is neither read nor judged, so its command
        # is refused, never let through unchecked.
        if depth > MAX_DEPTH:
            raise Blocked(f"'git {name}' is an alias chain too deep to verify. {HOOK_REMEDY}")
        cwd = scope.cwd if scope.cwd and scope.cwd != "\0unresolved" else self.base_cwd
        for cd in cds:
            if cd.dynamic or UNRESOLVABLE.search(cd.text):
                # `git -C "$D" publish`: D's repository may define publish.
                raise Blocked(f"'git {name}' may be an alias of a repository chosen at run time, which cannot be read. {HOOK_REMEDY}")
            cwd = cd.text if os.path.isabs(cd.text) else os.path.join(cwd or os.getcwd(), cd.text)
        # The alias is read from the repository git will use: `--git-dir`
        # selects one whose aliases the current checkout does not have.
        selected = None
        if git_dir is not None:
            if git_dir.dynamic or UNRESOLVABLE.search(git_dir.text):
                raise Blocked(f"'git {name}' may be an alias of a repository chosen at run time, which cannot be read. {HOOK_REMEDY}")
            selected = git_dir.text if os.path.isabs(git_dir.text) else os.path.join(cwd or os.getcwd(), git_dir.text)
        self.refuse_lost(scope)
        read = git_read(["config", "--get", f"alias.{name}"], cwd, selected)
        if read is None:
            raise Blocked(f"the configuration that says whether 'git {name}' is an alias could not be read. {HOOK_REMEDY}")
        expansion = read.strip()
        if not expansion:
            return
        def spelled(word: Word) -> str:
            # A word the shell computes stays computed in the re-read: quoting
            # its text would turn `"$FLAG"` (maybe --no-verify) into a literal.
            return '"$GIT_ALIAS_ARG"' if word.dynamic or word.could_be_flag() else shlex.quote(word.text)

        rest = " ".join(spelled(word) for word in args)
        if expansion.startswith("!"):
            self.script(f"{expansion[1:]} {rest}", cwd, depth + 1)
        else:
            # git keeps this invocation's `-c` settings for the expansion:
            # `git -c remote.origin.push=+HEAD:main publish` pushes with them.
            # (-C and --git-dir already chose `cwd`.)
            carried = " ".join(f"{option} {spelled(value)}" for option, value in overrides or [])
            self.script(f"git {carried} {expansion} {rest}", cwd, depth + 1)

    def env_chdir_paired(self, stages_all: bool, scope: Scope, cds: list[Word], git_dir: Word | None) -> None:
        """Refuse a commit moved by `env -C` that would record a paired
        change's `changes` path without its `requires` path. bash_guard.py
        owns this rule but reads the index of the directory the command
        starts in, so `env -C sub git commit` is judged here, in the
        repository git will really use. A repository chosen at run time, or
        an index that cannot be read, is refused: no answer is not "no
        change"."""

        run_in = scope.cwd if scope.cwd is not None else (self.base_cwd or os.getcwd())
        for cd in cds:
            run_in = self.resolve_dir(cd, run_in, strict=False)
        selected: str | None = None
        if git_dir is not None:
            selected = self.resolve_dir(git_dir, run_in, strict=False)
        if "\0unresolved" in (run_in, selected):
            raise Blocked(f"'env -C' runs this commit in a repository chosen at run time, whose index cannot be read. {PAIRED_REMEDY}")
        staged = git_read(["diff", "--cached", "--name-only"], run_in, selected)
        tracked = git_read(["diff", "--name-only"], run_in, selected) if stages_all else ""
        if staged is None or tracked is None or not os.path.isdir(run_in):
            raise Blocked(f"the index of the repository 'env -C' moves this commit into could not be read. {PAIRED_REMEDY}")
        paths = [*staged.splitlines(), *tracked.splitlines()]
        for pair in self.paired_changes:
            if any(path.endswith(pair.changes) for path in paths) and not any(pair.requires in path for path in paths):
                raise Blocked(
                    f"'{pair.changes}' is staged without a path containing '{pair.requires}' in the "
                    f"repository 'env -C' moves this commit into: {pair.reason.rstrip('.')}. {PAIRED_REMEDY}"
                )

    def commit(self, args: list[Word]) -> bool:
        """Refuse a hook bypass among git commit's options, and return whether
        they stage tracked changes too (`-a`, `--all`). Option values
        (`-m '-n'`, `-m '-a'`) are skipped, so they are never read as options."""

        stages_all = False
        value_long = {
            "--message", "--file", "--reuse-message", "--reedit-message", "--fixup",
            "--squash", "--author", "--date", "--template", "--cleanup", "--trailer",
            "--pathspec-from-file",
        }
        runtime = Blocked(
            "a word expanded at run time sits in an option position of git commit, "
            f"where it could become --no-verify. Write the flags literally. {HOOK_REMEDY}"
        )
        index = 0
        while index < len(args):
            word = args[index]
            text = word.text
            literal = text if word.first_dynamic is None else text[: word.first_dynamic]
            if text == "--" and not word.could_be_flag():
                return stages_all
            if literal.startswith("--") and "=" in literal:
                # `--message="$MSG"`: the option NAME is literal, only its value is not.
                if is_no_verify(literal):
                    raise Blocked(f"--no-verify is forbidden on all git commands. {HOOK_REMEDY}")
                index += 1
                continue
            if literal.startswith("-") and len(literal) > 1 and not literal.startswith("--"):
                cluster = literal[1:]
                consumed = False
                for position, flag in enumerate(cluster):
                    if flag == "n":
                        raise Blocked(f"'git commit -n' is --no-verify. {HOOK_REMEDY}")
                    if flag == "a":
                        stages_all = True
                    if flag in "mFCct":
                        consumed = True
                        if position == len(cluster) - 1 and literal == text:
                            index += 1  # the value is the next word
                        break
                    if flag in "Su":
                        consumed = True
                        break
                if literal != text and not consumed:
                    raise runtime
                index += 1
                continue
            if word.could_be_flag():
                raise runtime
            if text.startswith("--"):
                if is_no_verify(text):
                    raise Blocked(f"--no-verify is forbidden on all git commands. {HOOK_REMEDY}")
                stages_all = stages_all or text == "--all"
                # git takes any unambiguous abbreviation (`--mes '-n'` is a
                # message); an ambiguous one is an error and nothing runs.
                takes_value = len(text) > 2 and any(option.startswith(text) for option in value_long)
                index += 2 if takes_value else 1
                continue
            index += 1
        return stages_all

    def push(
        self,
        args: list[Word],
        scope: Scope,
        cds: list[Word],
        git_dir: Word | None,
        overrides: list[tuple[str, Word]],
    ) -> None:
        for option, value in overrides:
            self.push_override(option, value)
        value_options = {"-o", "--push-option", "--repo", "--receive-pack", "--exec"}
        positionals: list[Word] = []
        index = 0
        while index < len(args):
            word = args[index]
            text = word.text
            if text == "--":
                positionals.extend(args[index + 1 :])
                break
            if text in value_options:
                index += 2
                continue
            literal = text if word.first_dynamic is None else text[: word.first_dynamic]
            if literal.startswith("-") and literal != text and "=" not in literal:
                raise Blocked(f"the push option '{text}' is completed at run time and could become --force.\n{FORCE_REMEDY}")
            if text.startswith("--"):
                if is_no_verify(text):
                    raise Blocked(f"--no-verify is forbidden on all git commands. {HOOK_REMEDY}")
                danger = dangerous_long(text)
                if danger == "--mirror":
                    raise Blocked(f"'git push --mirror' force-updates and deletes remote refs.\n{FORCE_REMEDY}")
                if danger:
                    raise Blocked(f"'git push {danger}' is forbidden.\n{FORCE_REMEDY}")
                index += 1
                continue
            if text.startswith("-") and len(text) > 1 and not word.dynamic:
                for flag in text[1:]:
                    if flag == "o":
                        if text.endswith("o"):
                            index += 1
                        break
                    if flag == "f":
                        raise Blocked(f"'git push -f' is forbidden.\n{FORCE_REMEDY}")
                index += 1
                continue
            positionals.append(word)
            index += 1
        for word in positionals:
            if word.could_be_flag():
                raise Blocked(
                    f"the refspec '{word.text}' is computed at run time and could carry a forcing '+'. "
                    f"Push a literal refspec (e.g. HEAD).\n{FORCE_REMEDY}"
                )
            if word.text.startswith("+") or re.search(r"(^|[\s])\+", word.text):
                raise Blocked(f"a '+' refspec on git push forces the update.\n{FORCE_REMEDY}")
        if not self.read_config:
            return
        cwd = scope.cwd
        if cwd == "\0unresolved":
            raise Blocked(f"cannot statically resolve the directory this push runs in.\n{AMBIGUOUS_REMEDY}")
        for cd in cds:
            cwd = self.resolve_dir(cd, cwd, strict=True)
        directory = None
        if git_dir is not None:
            directory = self.resolve_dir(git_dir, cwd, strict=True)
        target = cwd or self.base_cwd
        if target and not os.path.isdir(target):
            raise Blocked(f"cannot inspect the target directory '{target}'.\n{AMBIGUOUS_REMEDY}")
        unread = f"the push configuration this push would follow could not be read.\n{AMBIGUOUS_REMEDY}"
        self.refuse_lost(scope)
        listed = git_read(["remote"], target, directory)
        if listed is None:
            raise Blocked(unread)
        remotes = set(listed.split())
        named = next((w.text for w in positionals if w.text in remotes), None)
        for remote in [named] if named else sorted(remotes) or ["origin"]:
            values = git_read(["config", "--get-all", f"remote.{remote}.push"], target, directory)
            if values is None:
                raise Blocked(unread)
            if any(line.strip().startswith("+") for line in values.splitlines()):
                raise Blocked(
                    f"remote.{remote}.push is configured with a forcing '+' refspec, so even a "
                    f"plain `git push` rewrites the remote.\n{FORCE_REMEDY}"
                )

    def config(self, args: list[Word]) -> None:
        readers = {
            "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l",
            "--show-origin", "--show-scope", "--name-only", "get", "list",
            "--get-color", "--get-colorbool",
        }
        # Edit mode names no key yet opens the whole file, and GIT_EDITOR can
        # write core.hooksPath or an alias into it unseen. Every spelling is
        # refused: `edit`, `--edit` and its abbreviations, `-e` in a short
        # cluster (`-ze`; `-f` takes the rest of the cluster as its file).
        edits = Blocked(f"editing git configuration can repoint the hooks or add an alias unseen. {HOOK_REMEDY}")
        if args and args[0].text == "edit":
            raise edits
        for word in args:
            if word.text == "--" and not word.dynamic:
                break
            literal = word.text if word.first_dynamic is None else word.text[: word.first_dynamic]
            if literal.startswith("-") and literal != word.text:
                raise Blocked(f"a git config option completed at run time could be --edit. {HOOK_REMEDY}")
            if literal.startswith("--"):
                name = literal.split("=", 1)[0]
                # `--e` is ambiguous (with --expiry-date) and errors; refused anyway.
                if len(name) > 2 and "--edit".startswith(name):
                    raise edits
            elif literal.startswith("-"):
                cluster = literal[1:].split("f", 1)[0]
                if "e" in cluster:
                    raise edits
        value_options = {"--file", "-f", "--blob", "--type", "-t", "--default", "--comment", "--value", "--url"}
        # Every option git config takes without a value. git also takes any
        # unique prefix of a long option and a separate value for it, so
        # `--typ path core.hooksPath /dev/null` sets the hooks path: an option
        # outside these two sets is refused, never skipped.
        flag_options = {
            "--global", "--system", "--local", "--worktree",
            "--replace-all", "--add", "--unset", "--unset-all", "--rename-section", "--remove-section",
            "-e", "--edit", "--no-type", "--bool", "--int", "--bool-or-int", "--bool-or-str", "--path",
            "--expiry-date", "--fixed-value", "-z", "--null", "--includes", "--no-includes",
            "--all", "--regexp", "--show-names", "--no-show-names", "--append",
        }
        positionals: list[Word] = []
        index = 0
        subcommand_style = bool(args) and args[0].text in (
            "set", "unset", "get", "list", "rename-section", "remove-section",
        )
        if subcommand_style:
            if args[0].text in ("get", "list"):
                return
            index = 1
        # After `--` every word is a key or value: `git config -- core.hooksPath
        # --list` SETS the hooks path to `--list`.
        options_end = len(args)
        while index < len(args):
            word = args[index]
            if word.text == "--" and not word.dynamic:
                options_end = index
                positionals.extend(args[index + 1 :])
                break
            if word.text in readers:
                return
            if word.text in value_options:
                index += 2
                continue
            if word.text.startswith("-"):
                name, attached = word.text.split("=", 1)[0], "=" in word.text
                if word.dynamic or name not in (value_options if attached else flag_options):
                    raise Blocked(
                        f"git config {word.text!r} is an option this guard does not know, so what it writes cannot be verified. {HOOK_REMEDY}"
                    )
                index += 1
                continue
            positionals.append(word)
            index += 1
        if not positionals:
            return
        # `git config KEY` alone reads KEY: no value and only options that
        # select where to read (an unknown or abbreviated option may be a
        # write such as `--unset`, so it keeps the key judged).
        location_options = {
            "--global", "--local", "--system", "--worktree", "--file", "-f", "--blob",
            "--type", "--bool", "--int", "--bool-or-int", "--path", "--expiry-date",
            "--null", "-z", "--includes", "--no-includes", "--default",
        }
        options = [
            word.text for word in args[1 if subcommand_style else 0 : options_end] if word.text.startswith("-")
        ]
        # A lone computed word before `--` may itself be `--edit`.
        if len(positionals) == 1 and positionals[0].could_be_flag() and options_end == len(args):
            raise Blocked(f"a git config word computed at run time could be --edit. {HOOK_REMEDY}")
        if (
            not subcommand_style
            and len(positionals) == 1
            and all(option.split("=", 1)[0] in location_options for option in options)
        ):
            return
        key = positionals[0]
        if key.dynamic:
            raise Blocked(f"git config with a computed key cannot be verified. {HOOK_REMEDY}")
        lowered = key.text.lower()
        if lowered == "core.hookspath":
            raise Blocked(f"changing core.hooksPath repoints the repository hooks. {HOOK_REMEDY}")
        if lowered.startswith("alias."):
            raise Blocked(f"a git alias can hide --no-verify or --force from this guard. {HOOK_REMEDY}")
        if lowered == "include.path" or (lowered.startswith("includeif.") and lowered.endswith(".path")):
            raise Blocked(f"an included config file can repoint the hooks unseen. {HOOK_REMEDY}")
        if REMOTE_PUSH_KEY.match(key.text):
            value = positionals[1] if len(positionals) > 1 else None
            if value is not None and (value.dynamic or value.text.strip().startswith("+")):
                raise Blocked(f"a forcing '+' push refspec rewrites the remote on every push.\n{FORCE_REMEDY}")


PRINTF_DIRECTIVE = re.compile(r"%(.)", re.DOTALL)
PRINTF_ESCAPES = {"n": "\n", "t": "\t", "\\": "\\", "r": "\r", "a": "\a", "v": "\v", "f": "\f", "'": "'", '"': '"'}


def printf_unescape(text: str) -> str:
    """Decode printf's escapes as bash does: named ones, `\\xHH`, `\\uHHHH`,
    `\\UHHHHHHHH` and octal `\\NNN` (and `%b`'s `\\0NNN`), so `\\x2dn` is `-n`."""

    def decode(match: re.Match[str]) -> str:
        escape = match.group(1)
        if escape[0] in "xuU" and len(escape) > 1:
            code = int(escape[1:], 16)
            return chr(code) if code <= 0x10FFFF else "�"
        if escape[0] in "01234567":
            return chr(int(escape, 8) & 0xFF)
        return PRINTF_ESCAPES.get(escape, "\\" + escape)

    return re.sub(
        r"\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|0[0-7]{0,3}|[1-7][0-7]{0,2}|.)",
        decode,
        text,
        flags=re.DOTALL,
    )


def render_printf(words: list[str]) -> str | None:
    """What `printf WORDS` writes: the program a `printf … | bash` runs.

    The format is reused until the arguments run out, as printf does, so
    `printf '%s ' git push --force` writes `git push --force `. Only %s, %b,
    %d, %i and %% are rendered; any other directive (widths included) is
    None, and the caller refuses.
    """

    if words[:1] == ["--"]:
        words = words[1:]
    if not words:
        return ""
    if words[0] == "-v":
        return ""  # printf -v writes to a variable, not the pipe
    fmt, args = words[0], words[1:]
    if any(directive not in "sbdi%" for directive in PRINTF_DIRECTIVE.findall(fmt)):
        return None
    # Literal text and directives alternate. printf decodes escapes in the
    # format and in %b arguments only: a %s argument is written as it is, so
    # `printf '%s' 'echo \x27; git push -f #\x27'` writes the backslashes and
    # bash runs the push. Decoding it would turn them into quotes and hide it.
    pieces = PRINTF_DIRECTIVE.split(fmt)
    out: list[str] = []
    while True:
        used = 0
        for position, piece in enumerate(pieces):
            if position % 2 == 0:
                out.append(printf_unescape(piece))
            elif piece == "%":
                out.append("%")
            else:
                value = args[used] if used < len(args) else ""
                used += 1
                if piece in "di":
                    # bash converts: `%d` of `'x` writes 120, never the quote.
                    # Only a plain integer is rendered; anything else refuses.
                    if value == "":
                        value = "0"
                    elif re.fullmatch(r"[ \t]*[+-]?\d+", value) is None:
                        return None
                    else:
                        value = str(int(value))
                out.append(printf_unescape(value) if piece == "b" else value)
        args = args[used:]
        if used == 0 or not args:
            break
    return "".join(out)


def git_read(args: list[str], cwd: str | None, git_dir: str | None) -> str | None:
    """Configuration git will act on, or None when it could not be read.

    A timeout, a crash or an error status is no answer: a guard reading "no alias" or "no forcing refspec" from a failed lookup
    would allow exactly what the lookup exists to find. `git config --get`'s
    status 1 means the key is unset, which is an answer. A directory that
    does not exist yet (made later in the same command) is read from its
    nearest existing ancestor: git finds a repository by walking up, so
    `mkdir plain; git -C plain publish` uses the enclosing repository's
    aliases.
    """

    while cwd and not os.path.isdir(cwd) and os.path.dirname(cwd) != cwd:
        cwd = os.path.dirname(cwd)
    prefix = [f"--git-dir={git_dir}"] if git_dir else []
    # The hook's input stays out of git's environment: over the platform's
    # exec cap git would not start, and the guard would refuse for want of
    # an answer.
    env = {key: value for key, value in os.environ.items() if key != "HOOK_INPUT"}
    try:
        result = subprocess.run(
            ["git", *prefix, *args],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=cwd or None,
            env=env,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode == 0:
        return result.stdout
    if result.returncode == 1 and args[:1] == ["config"]:
        return ""
    return None


def check(
    command: str, cwd: str | None, *, read_config: bool = True, paired_changes: Sequence[Any] = ()
) -> str | None:
    """The reason ``command`` must be refused, or None when it may run.
    ``paired_changes`` are the consumer's (config.PairedChange); none turns
    that rule off."""

    analyzer = Analyzer(cwd, read_config=read_config, paired_changes=paired_changes)
    try:
        analyzer.script(command, cwd)
    except Blocked as reason:
        return str(reason)
    return None


# ---------------------------------------------------------------------------
# command_guard.py entry point.
# ---------------------------------------------------------------------------


def block(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(2)


def read_hook_input(raw: str) -> tuple[str, str]:
    """The Bash command from a PreToolUse payload and the directory its shell
    runs in; refuse anything malformed.

    The directory is the payload's ``cwd`` when it is absolute: hooks run from
    the main checkout, so a subagent's command in its own worktree would
    otherwise be judged against the wrong repository (bash_guard.py reads it
    the same way). Without one, the hook process's own directory.
    """

    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):
        block("BLOCKED: malformed hook input (not JSON); refusing to run the command unchecked.")
    if not isinstance(data, dict):
        block("BLOCKED: malformed hook input (expected a JSON object).")
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        block("BLOCKED: malformed hook input (tool_input is not an object).")
    command = tool_input.get("command", "")
    if not isinstance(command, str):
        block("BLOCKED: malformed hook input (command is not a string).")
    cwd = data.get("cwd")
    return command, cwd if isinstance(cwd, str) and os.path.isabs(cwd) else os.getcwd()


def hook_main(settings: Any = None) -> None:
    """command_guard.py's second check: the hook input is in ``HOOK_INPUT``,
    ``settings`` the consumer's config.Config (None: no paired changes).

    Always ends in SystemExit(0) or SystemExit(2); the entry blocks on any
    other end, an exception included. The paired-change rule is
    bash_guard.py's, whose index model the command-guard suite holds, except
    for commits moved by `env -C` (Analyzer.env_chdir_paired).
    """

    paired = tuple(getattr(settings, "paired_changes", ()))
    command, cwd = read_hook_input(os.environ.get("HOOK_INPUT", ""))
    if command.strip():
        reason = check(command, cwd, paired_changes=paired)
        if reason is not None:
            block(f"BLOCKED: {reason}")
    raise SystemExit(0)
