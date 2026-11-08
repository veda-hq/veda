"""The shared deterministic shell/path boundary behind the Claude worktree guard.

``worktree_guard.py`` (beside this file) loads this module for its parsing and
checkout classification. It has no entry point of its own, and it reads no
settings file: what a consumer trusts (``trusted_request``) is handed in by
the caller, so the module imports and tests without any configuration.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import stat
import subprocess
import sys
from pathlib import Path
from typing import Protocol, Sequence


# Admission to this set means one thing: NO invocation of the command mutates
# anything -- no option and no operand can name a file it writes, and none
# changes system state. That is the whole test. `sort` and `uniq` are absent
# because `sort -o out` and `uniq in out` name an output; `hostname name` and
# `date -s` set state, and `date` earns a parser below rather than a place
# here. Membership is not "feels harmless": a command missing from this set is
# not refused outright, it falls through to operand analysis, and a command
# with no parser there fails closed with the misleading "mutation targets could
# not be resolved". That message, not a boundary hole, is what kept `date +%F`
# unusable from a worktree.
#
# A member is read-only whatever its words are, expansions
# included, so `find` (`-delete`), `rg` (`--pre`), `file` (`-C` compiles a
# magic file) and `printf` (`-v` assigns a variable, PATH among them) moved to
# parsers of their own in `segment_is_read_only`.
READ_COMMANDS = {
    "[",
    "[[",
    "basename",
    "cmp",
    "cut",
    "diff",
    "dirname",
    "grep",
    "head",
    "id",
    "jq",
    "ls",
    "nl",
    "printenv",
    # Process listings: sessions check for a quiet machine before a heavy
    # emulator run (`pgrep -fl qemu-system`). pkill stays unproven.
    "pgrep",
    "ps",
    "pwd",
    "readlink",
    "realpath",
    "rev",
    "seq",
    "shellcheck",
    "sleep",
    "stat",
    "tail",
    "test",
    "tr",
    "true",
    "type",
    "uname",
    "uptime",
    "wc",
    "which",
    "whoami",
}
READ_GIT = {
    "blame",
    "diff",
    "diff-tree",
    "for-each-ref",
    "log",
    "ls-files",
    "merge-base",
    "rev-list",
    "rev-parse",
    "show",
    "show-ref",
    "status",
}
SHELL_OPERATORS = {";", "&&", "||", "|", "|&", "&", "(", ")"}
SHELL_COMMAND_WRAPPERS = {
    "builtin",
    "command",
    "env",
    "exec",
    "nice",
    "noglob",
    "time",
}
SHELL_INTERPRETERS = {"bash", "dash", "ksh", "sh", "zsh"}
NON_SHELL_INLINE_INTERPRETERS = {
    "bun": {"e", "p"},
    "lua": {"e"},
    "node": {"e", "p"},
    "nodejs": {"e", "p"},
    "perl": {"e", "E"},
    "php": {"r"},
    "ruby": {"e"},
}
GENERIC_SCOPED_COMMANDS = {
    "bun",
    "bundle",
    "cargo",
    "cmake",
    "curl",
    "eslint",
    "gem",
    "gh",
    "go",
    "gradle",
    "java",
    "jest",
    "make",
    "mise",
    "mvn",
    "npm",
    "npx",
    "pnpm",
    "pod",
    "prettier",
    "rsync",
    "tar",
    "tsc",
    "turbo",
    "vitest",
    "yarn",
}
# These reviewed build/package runners intentionally execute repository code.
# This parser cannot see what their child processes write; it confines only the
# path operands declared on their command line, and only from an owned worktree.
#
# The toolchain managers -- `bundle`, `gem`, `mise`, `pod` -- belong HERE and
# not in READ_COMMANDS, and the difference is not a matter of degree.
# Membership above asserts that no invocation writes, so it short-circuits the
# worktree gate entirely; membership here asserts only that the command is a
# reviewed runner, and leaves the gate standing. `mise install` and
# `pod install` plainly write, so the first claim would be false for both. What
# being listed here buys them is narrower and is the whole fix: an executable
# absent from every set is treated as a possible interpreter by
# `has_inline_interpreter_program`, so its targets are unprovable and
# `mise --version` is refused with a message about mutation targets. Naming
# them makes their command lines parseable, which is what lets them run from an
# owned worktree with their declared path operands confined.
#
# mise pins Node, pnpm and Python; it replaced fnm, which is no longer
# listed, so an fnm command is refused again as an unknown executable.
# No mise subcommand earns a read-only parser the way `node --version` does:
# measured on 2026-11-08, the first command to read a config file (`ls`,
# `current`, `which`) records it under `~/.local/state/mise/tracked-configs`,
# `--version` refreshes a latest-version cache, and `ls-remote` a remote
# version cache. Each writes state outside any worktree, so each stays behind
# the worktree gate.
#
# State the limit of this set out loud, because it is easy to read the
# inline-interpreter refusals below as stronger than they are. A reviewed
# runner can invoke an interpreter as its OWN argument -- `pnpm exec node -e`,
# `npx node -e`, `npm exec node -e`, or a `make` recipe -- and this hook does
# not see through it. Those predate the toolchain entries above and behave the
# same with or without them. `mise exec -- node -e` must not be described that
# way: before `mise` was listed it was REFUSED, as an unknown executable, and
# listing `mise` is precisely what admits it. What listing it does not do is
# widen the shape -- it puts `mise` in the same class as the runners already
# here, where only the BARE `node -e` is refused. The refusals in
# NON_SHELL_INLINE_INTERPRETERS therefore constrain the direct spelling, not
# the capability; what bounds the capability is the worktree gate, which still
# applies to every command here.
READ_ONLY_COMMANDS = {"cat", "echo", "printf"}
READ_COMMANDS |= READ_ONLY_COMMANDS - {"printf"}
SHELL_CONTROL_WORDS = {"if", "then", "elif", "else", "fi", "while", "until", "do", "done"}
NAVIGATION_COMMANDS = {"cd", "pushd", "popd"}
ALL_OPERAND_MUTATORS = {
    "mkdir",
    "mkfifo",
    "mv",
    "rm",
    "rmdir",
    "touch",
    "unlink",
}


def git_environment() -> dict[str, str]:
    """Keep caller-supplied Git plumbing from redirecting repository checks.

    Dropping the `GIT_*` prefix covers every environment vector, the config
    injectors (`GIT_CONFIG`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT` and
    its key/value family) included. It deliberately stops there: unlike the
    throwaway fixtures in `test_boundary.py`, these commands inspect the
    REAL checkout, where the machine's configuration — `safe.directory`,
    `core.excludesfile` behind `status --untracked-files=all` — is part of the
    answer the guard is asked for. Nothing here creates a commit, so the
    fixture-teardown race that `hermetic_git_env` exists for cannot start here.
    """

    return {
        key: value for key, value in os.environ.items() if not key.startswith("GIT_")
    }


def run_git(cwd: Path, *args: str) -> str | None:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
        env=git_environment(),
    )
    return result.stdout.strip() if result.returncode == 0 else None


# The probes `checkout_state` needs answered, in the order it needs them.
# `checkout_failure` walks the SAME tuple, which is the point of naming it: an
# earlier version of that function re-ran only the first probe, so a failure in
# any later one was reported as the first one's successful output.
#
# One rev-parse answers all three paths, one line each, and runs alongside the
# worktree listing: this guard gates every Bash, Edit and Write call, and each
# git start costs ~50-70 ms on a loaded host. The answers are
# git's own, unchanged; only the number and order of processes moved.
CHECKOUT_PROBES = (
    (
        "rev-parse", "--path-format=absolute",
        "--show-toplevel", "--git-dir", "--git-common-dir",
    ),
    ("worktree", "list", "--porcelain"),
)


def run_git_all(calls: list[tuple[Path, tuple[str, ...]]]) -> list[str | None]:
    """`run_git` for each (cwd, probe), all started before any is waited on."""

    started: list[subprocess.Popen[str]] = []
    try:
        for cwd, probe in calls:
            started.append(
                subprocess.Popen(
                    ["git", *probe],
                    cwd=cwd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                    env=git_environment(),
                )
            )
    except BaseException:
        # A launch that fails (no git, a vanished cwd) must not leave the
        # probes already started running unreaped; the error still propagates.
        for process in started:
            try:
                process.kill()
            except ProcessLookupError:
                pass  # already exited; communicate() still reaps it
            process.communicate()
        raise
    answers: list[str | None] = []
    for process in started:
        stdout, _ = process.communicate()
        answers.append(stdout.strip() if process.returncode == 0 else None)
    return answers


# The checkout, read from git's own files. Asking git costs two
# process starts on every Bash, Edit and Write call, one of them listing every
# worktree to read the first; the three facts the guard needs are written down
# where git keeps them. Every layout this reader does not model raises
# GitMustAnswer and the caller asks git, so a file answer is git's answer or
# none at all.
#
# Modelled, after git's discovery: from the physical cwd, each directory's
# `.git` is examined before stepping up, and the walk never steps onto another
# filesystem (`git_environment` drops GIT_DISCOVERY_ACROSS_FILESYSTEM and
# GIT_CEILING_DIRECTORIES, so git stops there too, as "not a git repository").
# A `.git` file names the git dir on its first line, relative to its own
# directory; the git dir's `commondir` names the common dir. The top level is
# the directory holding `.git`; the primary checkout, git's first worktree, is
# the common dir's parent.
#
# Asked of git instead: a symlinked or special `.git`; a directory holding a
# `HEAD` before any `.git` (it may itself be a git dir); a git dir without
# `HEAD`, or a common dir without `objects` and `refs`; a cwd inside a git dir;
# any path owned by another user (`safe.directory`); a common dir not named
# `.git` (bare repositories, submodules); and repository config that sets
# `core.worktree` or a true `core.bare`, includes other files, continues a
# line, or declares a format or extension this reader does not know.
#
# Accepted, checked: discovery reads `core.worktree` from the repository's own
# config files only. Set in a global config file it moves nothing (git 2.54,
# 2026-10-06), so global and system config are not read here.
class GitMustAnswer(Exception):
    """The files do not settle where this checkout is; git must answer."""


GIT_EXTENSIONS_READ = frozenset(
    {
        "compatobjectformat",
        "noop",
        "noop-v1",
        "objectformat",
        "partialclone",
        "preciousobjects",
        "refstorage",
        "relativeworktrees",
        "worktreeconfig",
    }
)
GIT_FILE_LIMIT = 1024 * 1024
FALSE_WORDS = {"false", "no", "off", "0"}


def read_git_file(path: Path) -> str | None:
    """A small text file git keeps, or None when it is absent."""

    try:
        status = path.stat()
        # A FIFO or device would block the read: only a regular file is read.
        if not stat.S_ISREG(status.st_mode):
            raise GitMustAnswer(f"{path} is not a regular file")
        if status.st_size > GIT_FILE_LIMIT:
            raise GitMustAnswer(f"{path} is larger than this reader reads")
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError) as error:
        raise GitMustAnswer(f"{path}: {error}") from error


def check_repository_config(path: Path) -> None:
    """Raise GitMustAnswer if this config can move the top level or the format.

    Section-aware on purpose: `extensions.worktreeConfig` and branch names
    contain "worktree", and only `core.worktree` moves the top level.
    """

    text = read_git_file(path)
    if text is None:
        return
    section = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line[0] in "#;":
            continue
        if line.endswith("\\"):
            raise GitMustAnswer(f"{path} continues a line")
        if line.startswith("["):
            header, closed, rest = line[1:].partition("]")
            if not closed:
                raise GitMustAnswer(f"{path} has an unclosed section header")
            if not header.strip():
                raise GitMustAnswer(f"{path} has an empty section header")
            # `[branch "x"]` -> branch, `[includeIf "..."]` -> includeif, and
            # the old `[core.sub]` spelling -> core (read as core: stricter).
            section = header.strip().split(None, 1)[0].split('"', 1)[0]
            section = section.split(".", 1)[0].lower()
            if section.startswith("include"):
                raise GitMustAnswer(f"{path} includes other config")
            # The section is set before the rest of the line is read, so a
            # comment after `]` (`[core] # x`) still leaves it core.
            line = rest.strip()
            if not line or line[0] in "#;":
                continue
        key, _, value = line.partition("=")
        key = key.strip().lower()
        value = value.split("#", 1)[0].split(";", 1)[0].strip().strip('"').lower()
        if section == "core" and key == "worktree":
            raise GitMustAnswer(f"{path} sets core.worktree")
        # A key with no `=` is git's true.
        if section == "core" and key == "bare" and value not in FALSE_WORDS:
            raise GitMustAnswer(f"{path} sets core.bare")
        if section == "core" and key == "repositoryformatversion" and value not in {"0", "1"}:
            raise GitMustAnswer(f"{path} declares format {value}")
        if section == "extensions" and key not in GIT_EXTENSIONS_READ:
            raise GitMustAnswer(f"{path} declares extensions.{key}")


def owned_by_this_user(path: Path) -> None:
    if path.stat().st_uid != os.geteuid():
        raise GitMustAnswer(f"{path} is owned by another user")


def found_checkout(start: Path, top: Path, dot_git: Path, is_file: bool) -> tuple[Path, Path, Path]:
    if is_file:
        text = read_git_file(dot_git) or ""
        first = text.split("\n", 1)[0].rstrip()
        if not first.startswith("gitdir: "):
            raise GitMustAnswer(f"{dot_git} does not name a git dir")
        git_dir = top / first.removeprefix("gitdir: ")
    else:
        git_dir = dot_git
    git_dir = git_dir.resolve(strict=True)
    pointer = read_git_file(git_dir / "commondir")
    if pointer is not None and not pointer.strip():
        raise GitMustAnswer(f"{git_dir}/commondir is empty")
    common = (git_dir / pointer.strip()).resolve(strict=True) if pointer else git_dir
    if not (git_dir / "HEAD").is_file():
        raise GitMustAnswer(f"{git_dir} has no HEAD")
    if not ((common / "objects").is_dir() and (common / "refs").is_dir()):
        raise GitMustAnswer(f"{common} is not a repository")
    if common.name != ".git":
        raise GitMustAnswer(f"{common} is not a checkout's .git")
    for path in (top, dot_git, git_dir, common):
        owned_by_this_user(path)
    if is_inside(start, git_dir) or is_inside(start, common):
        raise GitMustAnswer(f"{start} is inside a git dir")
    check_repository_config(common / "config")
    check_repository_config(common / "config.worktree")
    check_repository_config(git_dir / "config.worktree")
    return top, git_dir, common


def checkout_from_files(cwd: Path) -> tuple[Path, Path, Path] | None:
    """(top level, git dir, common dir) for `cwd`, or None outside any checkout.

    Raises GitMustAnswer for every layout the comment above hands to git.
    """

    try:
        start = cwd.resolve(strict=True)
        if not start.is_dir():
            raise GitMustAnswer(f"{start} is not a directory")
        device = start.stat().st_dev
        directory = start
        while True:
            dot_git = directory / ".git"
            try:
                mode = dot_git.lstat().st_mode
            except FileNotFoundError:
                mode = None
            if mode is not None:
                if stat.S_ISREG(mode) or stat.S_ISDIR(mode):
                    return found_checkout(start, directory, dot_git, stat.S_ISREG(mode))
                raise GitMustAnswer(f"{dot_git} is neither a file nor a directory")
            if os.path.lexists(directory / "HEAD"):
                raise GitMustAnswer(f"{directory} may itself be a git dir")
            parent = directory.parent
            if parent == directory or parent.stat().st_dev != device:
                return None
            directory = parent
    except OSError as error:
        raise GitMustAnswer(str(error)) from error


def checkout_state(cwd: Path) -> tuple[Path, bool, Path] | None:
    try:
        found = checkout_from_files(cwd)
    except GitMustAnswer:
        return checkout_state_from_git(cwd)
    if found is None:
        return None
    top, git_dir, common = found
    return top, git_dir != common, common.parent


def checkout_state_from_git(cwd: Path) -> tuple[Path, bool, Path] | None:
    paths, listing = run_git_all([(cwd, probe) for probe in CHECKOUT_PROBES])
    if not paths or not listing:
        return None
    lines = paths.splitlines()
    # Exactly one non-empty line per path asked for; anything else (a path with
    # a newline in it, a git that answers differently) is not read as one.
    if len(lines) != 3 or not all(lines):
        return None
    root, git_dir, common = lines
    first = next(
        (
            line.removeprefix("worktree ")
            for line in listing.splitlines()
            if line.startswith("worktree ")
        ),
        "",
    )
    if not first:
        return None
    return (
        Path(root).resolve(),
        Path(git_dir).resolve() != Path(common).resolve(),
        Path(first).resolve(),
    )


def is_inside(path: Path, directory: Path) -> bool:
    return path == directory or directory in path.parents


def is_session_target(target: Path, root: Path, primary: Path) -> bool:
    """Tracked edits stay local; a linked ``.local`` exposes shared documents.

    Besides the worktree itself, one directory outside it is a session target:
    the primary checkout's own ``.local`` (a real directory, not a symlink),
    and only when this worktree's ``.local`` is a symlink resolving to it.
    That is how documents shared across a repository's worktrees are linked
    into each one; a link aimed anywhere else exposes nothing.
    """
    target, root, primary = target.resolve(), root.resolve(), primary.resolve()
    if is_inside(target, root):
        return True
    shared = (primary / ".local").resolve()
    link = root / ".local"
    return (
        (primary / ".local").is_dir()
        and not (primary / ".local").is_symlink()
        and link.is_symlink()
        and link.resolve() == shared
        and is_inside(target, shared)
    )


def is_claude_managed(root: Path, primary: Path) -> bool:
    return is_inside(root.resolve(), (primary / ".claude" / "worktrees").resolve())


def deny(message: str) -> None:
    print(f"BLOCKED: {message}", file=sys.stderr)
    raise SystemExit(2)


def run_git_result(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
        env=git_environment(),
    )


def checkout_failure(cwd: Path) -> str:
    """Why `checkout_state` could not answer, in git's own words.

    `run_git` reports failure as None and drops stderr. That is right for the
    callers who treat "not a repository" as an ordinary answer, and wrong for a
    denial. When git fails for a reason that has nothing to do with worktrees
    -- an unaccepted Xcode licence on macOS exits 69 before git does any work,
    a corrupt index, an unreadable object store -- the session is told it
    cannot determine its repository checkout, reads that as an ownership
    problem, and goes looking for the wrong thing entirely. The real cause was
    on stderr the whole time.

    This re-runs the probes purely to quote them, on the denial path only, so no
    successful call pays for the diagnosis.

    It walks ALL of them and reports the FIRST that fails, naming it. Re-running
    only the first probe was the original bug and it recreated the very
    confusion this function exists to remove: when `--show-toplevel` succeeds
    and a later probe does not -- a corrupt `.git/worktrees`, an unreadable
    common dir -- falling back to stdout returned the resolved toplevel PATH,
    so the denial read "cannot determine this session's repository checkout:
    /repo/path" and presented a successful answer as the cause. Never report
    stdout as a failure reason; an empty answer counts as a failure here
    because `checkout_state` treats it as one.
    """

    for probe in CHECKOUT_PROBES:
        result = run_git_result(cwd, *probe)
        if result.returncode == 0 and result.stdout.strip():
            continue
        spelling = " ".join(probe)
        detail = result.stderr.strip().splitlines()
        if detail:
            return f"`git {spelling}` failed: {detail[0]}"
        return (
            f"`git {spelling}` exited {result.returncode} with no message"
            if result.returncode
            else f"`git {spelling}` answered nothing"
        )
    return (
        "every git probe answered on re-run, so the earlier failure did not "
        "reproduce; `git worktree list --porcelain` naming no worktree is the "
        "remaining way this can happen"
    )


class ShellWord(str):
    """Decoded shell text with per-character expansion protection.

    Keep ordinary string comparisons for command parsers, but preserve this
    metadata explicitly whenever extracting a path from an option value.
    Operators are syntax only when emitted outside quotes by the scanner.
    """

    protected: tuple[bool, ...]
    operator: bool
    quote_start: int | None

    def __new__(
        cls, value: str, protected: tuple[bool, ...], *, operator: bool = False,
        quote_start: int | None = None,
    ) -> ShellWord:
        word = super().__new__(cls, value)
        word.protected = protected
        word.operator = operator
        word.quote_start = quote_start
        return word


def shell_slice(word: str, start: int, end: int | None = None) -> str:
    value = word[start:end]
    if isinstance(word, ShellWord):
        return ShellWord(value, word.protected[start:end])
    return value


def shell_option_value(word: str) -> str:
    return shell_slice(word, word.index("=") + 1)


def has_dynamic_markers(word: str) -> bool:
    return any(
        character in "$`*?[{}"
        and (not isinstance(word, ShellWord) or not word.protected[index])
        for index, character in enumerate(word)
    )


def is_shell_operator(word: str) -> bool:
    return isinstance(word, ShellWord) and word.operator and word in SHELL_OPERATORS


# Characters that end an unquoted redirection target.
REDIRECTION_DELIMITERS = " \t\n;&|)"


def fd_prefix(text: list[str], protected: list[bool], quote_start: int | None) -> bool:
    """Whether the word scanned so far is an unquoted file-descriptor number."""

    return (
        bool(text)
        and quote_start is None
        and not any(protected)
        # ASCII only: str.isdigit() accepts `²`, which every shell reads as
        # an argument before the redirection.
        and re.fullmatch(r"[0-9]+", "".join(text)) is not None
    )


def redirection_end(command: str, start: int, *, duplicate: bool) -> int | None:
    """The end of a reviewed output redirection whose operator ends at ``start``.

    Two forms open no file in any checkout, so they contribute nothing to the
    mutation targets and are dropped from the words: duplicating or
    closing a descriptor (`2>&1`, `>&2`, `>&-`) and writing to /dev/null
    (`2>/dev/null`, `>>/dev/null`, `>|/dev/null`, `&>/dev/null`). Every other
    output target, a here-document and an output process substitution still
    fail closed: a file target is a write this scanner does not resolve. Input
    redirection is read in ``tokenize_command``.
    """

    index = start
    following = command[index : index + 1]
    if duplicate and following == "&":
        # `>&word` with a non-numeric word redirects both streams to a file.
        # bash, zsh and sh all read digits alone as a descriptor (a closed one
        # is "Bad file descriptor", never a file named after it). The move form
        # `>&3-` is not accepted: zsh, the Bash tool's shell here, writes a
        # file named `3-`.
        match = re.match(r"[0-9]+|-", command[index + 1 :])
        if match is None:
            return None
        end = index + 1 + len(match.group())
        if end < len(command) and command[end] not in REDIRECTION_DELIMITERS:
            return None
        return end
    if following in {">", "|"}:
        index += 1
    while command[index : index + 1] in {" ", "\t"}:
        index += 1
    end = index + len(os.devnull)
    if command[index:end] != os.devnull or (
        end < len(command) and command[end] not in REDIRECTION_DELIMITERS
    ):
        return None
    return end


def substitution_end(command: str, start: int) -> int | None:
    """Index of the `)` closing a `$(` or `<(` whose body starts at ``start``.

    Quotes, backslashes and nested parentheses are followed as bash and zsh
    follow them. Anything whose end those shells could place differently is
    refused rather than guessed: backticks, `$'` and `$"` quoting, here
    documents, `case` (its patterns end in a bare `)`) and comments.
    """

    depth = 0
    index = start
    quote = ""
    word_start = True
    while index < len(command):
        character = command[index]
        following = command[index + 1 : index + 2]
        if quote == "'":
            if character == "'":
                quote = ""
            index += 1
            continue
        if character == "\\":
            index += 2
            word_start = False
            continue
        if character == "`":
            return None
        if character == "$" and following in {"'", '"'} and not quote:
            return None
        if character == "$" and following == "(":
            end = substitution_end(command, index + 2)
            if end is None:
                return None
            index = end + 1
            word_start = False
            continue
        if quote == '"':
            if character == '"':
                quote = ""
            index += 1
            continue
        if character in {"'", '"'}:
            quote = character
            word_start = False
            index += 1
            continue
        if character == "#" and word_start:
            return None
        if character == "<" and following == "<":
            return None
        if word_start and command.startswith("case", index) and (
            command[index + 4 : index + 5] in {"", " ", "\t", "\n", ";"}
        ):
            return None
        if character == "(":
            depth += 1
        elif character == ")":
            if depth == 0:
                return index
            depth -= 1
        word_start = character in " \t\n;&|()"
        index += 1
    return None


# The commands whose output can never begin with `-` or hold a blank, a glob
# or a quote: object names and ref names (git refuses a ref name starting with
# `-` or holding `..`, a blank, `*`, `?` or `[`). Their substitution stands for
# a plain word, so `git log $(git merge-base HEAD main)..HEAD` reads like the
# same command with the hash typed out. An argument that is not a literal
# revision (no option but these) makes the output unknown again.
OPTION_FREE_GIT = {"rev-parse", "merge-base"}
OPTION_FREE_FLAGS = {"--verify", "--short", "-q", "--quiet", "--abbrev-ref", "--symbolic-full-name"}
REVISION_WORD = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._/@^~{}:-]*")


def substitution_is_option_free(body: str) -> bool:
    """Whether a read-only substitution prints only object or ref names."""

    segments = split_commands(body)
    if segments is None or len(segments) != 1:
        return False
    words = segments[0]
    if len(words) < 3 or words[0] != "git" or words[1] not in OPTION_FREE_GIT:
        return False
    for word in words[2:]:
        if has_dynamic_markers(word):
            return False
        if word in OPTION_FREE_FLAGS or re.fullmatch(r"--short=[0-9]{1,2}", word):
            continue
        if REVISION_WORD.fullmatch(word) is None:
            return False
    return True


# What a read-only substitution leaves in the word: an object name when its
# output is option-free, otherwise an expansion this parser cannot read.
OPTION_FREE_STAND_IN = "0" * 40
SUBSTITUTION_DEPTH_LIMIT = 8


def tokenize_command(command: str, depth: int = 0) -> list[str] | None:
    """Scan the reviewed shell subset without evaluating any expansions.

    Reject redirections other than the reviewed ones in ``redirection_end``
    and the input forms below, and unsupported quoting, rather than guessing
    their effects. Nested shell programs are scanned afresh.

    A command substitution `$(...)` or an input process substitution `<(...)`
    is admitted only when its body is itself read-only (``shell_is_read_only``):
    it then writes nothing, and the word it sits in is an expansion whose value
    is unknown (the `$` stays unprotected, so ``has_dynamic_markers`` sees it)
    or, for `<(...)`, the `/dev/fd` path bash passes. A body that may write
    makes the whole command unresolved, as before.

    Input redirection opens a file for reading only, so `< file`, `N< file`,
    `<<< word`, `<&N` and `<&-` drop their target. `<<` (a here document) and
    `<>` (which creates its file) stay unresolved.
    """
    if "\0" in command or depth > SUBSTITUTION_DEPTH_LIMIT:
        return None
    tokens: list[str] = []
    text: list[str] = []
    protected: list[bool] = []
    quote = ""
    quote_start: int | None = None
    started = False
    drop_next = False
    index = 0

    def finish() -> None:
        nonlocal started, quote_start, drop_next
        if started:
            if drop_next:
                drop_next = False
            else:
                tokens.append(ShellWord("".join(text), tuple(protected), quote_start=quote_start))
        text.clear()
        protected.clear()
        started = False
        quote_start = None

    def substituted(body_start: int, *, quoted: bool, process: bool) -> int | None:
        """Admit one read-only substitution into the current word."""
        nonlocal started
        end = substitution_end(command, body_start)
        if end is None:
            return None
        body = command[body_start:end]
        if not shell_is_read_only(body, depth=depth + 1):
            return None
        if process:
            stand_in, guarded = "/dev/fd/63", True
        elif substitution_is_option_free(body):
            stand_in, guarded = OPTION_FREE_STAND_IN, True
        else:
            stand_in, guarded = "$(" + body + ")", quoted
        text.extend(stand_in)
        protected.extend(
            [guarded] * len(stand_in) if process or stand_in == OPTION_FREE_STAND_IN
            else [False] + [guarded] * (len(stand_in) - 1)
        )
        started = True
        return end + 1

    while index < len(command):
        character = command[index]
        following = command[index + 1 : index + 2]
        if quote == "'":
            if character == "'":
                quote = ""
            else:
                text.append(character)
                protected.append(True)
            index += 1
            continue
        if character == "\\":
            if not following:
                return None
            if following == "\n":
                index += 2
                continue
            if not quote or following in '$`"\\':
                if quote_start is None:
                    quote_start = len(text)
                text.append(following)
                protected.append(True)
                started = True
                index += 2
                continue
            # In double quotes a backslash before other characters is literal.
            text.append(character)
            protected.append(True)
            index += 1
            continue
        # Line continuations can join a dollar to substitution/quote syntax.
        # Inspect the effective next character without rewriting literal text.
        lookahead = index + 1
        while command[lookahead : lookahead + 2] == "\\\n":
            lookahead += 2
        effective_next = command[lookahead : lookahead + 1]
        if character == "`" or (
            character == "$" and effective_next == "(" and lookahead != index + 1
        ):
            return None
        if character == "$" and following == "(":
            if command[index + 2 : index + 3] == "(":
                # `$((...))` is arithmetic, which may assign; still unproven.
                return None
            resumed = substituted(index + 2, quoted=quote == '"', process=False)
            if resumed is None:
                return None
            index = resumed
            continue
        if not quote and character == "$" and effective_next in {"'", '"'}:
            return None
        if quote == '"':
            if character == '"':
                quote = ""
            else:
                text.append(character)
                protected.append(character != "$")
            index += 1
            continue
        if character in {"'", '"'}:
            if quote_start is None:
                quote_start = len(text)
            quote = character
            started = True
        elif character in " \t":
            finish()
        elif character == "#" and not started:
            newline = command.find("\n", index)
            index = len(command) if newline < 0 else newline
            continue
        elif character == ">" or (character == "&" and following == ">"):
            if drop_next and not started:
                return None
            if character == ">" and fd_prefix(text, protected, quote_start):
                # `2>`: an unquoted all-digit word right before `>` is the
                # descriptor, not an argument.
                text.clear()
                protected.clear()
                started = False
                quote_start = None
            else:
                finish()
            end = redirection_end(
                command, index + (1 if character == ">" else 2),
                duplicate=character == ">",
            )
            if end is None:
                return None
            index = end
            continue
        elif character == "<" and following == "(":
            # `< <(cmd)`: the substitution is the input redirection's target.
            resumed = substituted(index + 2, quoted=False, process=True)
            if resumed is None:
                return None
            index = resumed
            continue
        elif character == "<":
            if drop_next and not started:
                return None
            if fd_prefix(text, protected, quote_start):
                # `2<file`: the digits are the descriptor, not an argument.
                text.clear()
                protected.clear()
                started = False
                quote_start = None
            else:
                finish()
            rest = command[index + 1 :]
            if rest.startswith("<<"):
                # `<<< word`: the word is the input, as with `< file`.
                index += 3
            elif rest.startswith(("<", ">")):
                return None
            elif rest.startswith("&"):
                match = re.match(r"[0-9]+|-", rest[1:])
                end = index + 2 + (len(match.group()) if match else 0)
                if match is None or (
                    end < len(command) and command[end] not in REDIRECTION_DELIMITERS
                ):
                    return None
                index = end
                continue
            else:
                index += 1
            drop_next = True
            continue
        elif character in ";&|()\n":
            if drop_next and not started:
                return None
            finish()
            operator = ";" if character == "\n" else character
            if character + following in {"&&", "||", "|&"}:
                operator += following
                index += 1
            elif character + following in {";;", ";&"}:
                return None
            tokens.append(ShellWord(operator, (False,) * len(operator), operator=True))
        else:
            text.append(character)
            protected.append(False)
            started = True
        index += 1
    if quote:
        return None
    finish()
    if drop_next:
        return None
    return tokens


def split_commands(command: str, depth: int = 0) -> list[list[str]] | None:
    tokens = tokenize_command(command, depth)
    if tokens is None:
        return None
    segments: list[list[str]] = []
    current: list[str] = []
    for token in tokens:
        if is_shell_operator(token):
            if current:
                segments.append(current)
                current = []
        else:
            current.append(token)
    if current:
        segments.append(current)
    return segments


def effective_segment(words: list[str]) -> tuple[list[str], bool, bool] | None:
    """Return the command plus wrapper and executable-lookup metadata."""

    index = 0
    wrapped = False
    lookup_modified = False
    assignments_allowed = True
    while index < len(words):
        name = os.path.basename(words[index])
        if words[index] != name and (
            name in SHELL_CONTROL_WORDS
            or name in SHELL_COMMAND_WRAPPERS
            or name == "!"
        ):
            # Wrapper and control semantics belong only to the reviewed bare
            # shell token. A path-qualified lookalike is arbitrary executable
            # code and must not be stripped before executable validation.
            return None
        if name in SHELL_CONTROL_WORDS | {"!", "noglob"}:
            if wrapped or (
                isinstance(words[index], ShellWord)
                and words[index].quote_start is not None
            ):
                # These words are shell syntax only in an unquoted prefix.
                # After an executable wrapper they instead name a program.
                return None
            if name in SHELL_CONTROL_WORDS:
                index += 1
                continue
        if name in SHELL_COMMAND_WRAPPERS or name == "!":
            assignments_allowed = False
        assignment = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)=.*", words[index])
        if assignment:
            word = words[index]
            if (
                not assignments_allowed or (
                    isinstance(word, ShellWord)
                    and word.quote_start is not None
                    and word.quote_start <= word.index("=")
                )
            ):
                # Quoting in the name or equals sign makes this an executable
                # word, even when the quoted fragment is empty.
                return None
            wrapped = True
            lookup_modified = lookup_modified or assignment.group(1) == "PATH"
            index += 1
            continue
        if name == "!":
            wrapped = True
            index += 1
            continue
        if name == "command":
            wrapped = True
            index += 1
            if index < len(words) and words[index] in {"-v", "-V"}:
                return ["true"], False, lookup_modified
            while index < len(words) and words[index] in {"-p", "--"}:
                lookup_modified = lookup_modified or words[index] == "-p"
                index += 1
            continue
        if name == "env":
            wrapped = True
            index += 1
            while index < len(words):
                option = words[index]
                if option in {"-C", "--chdir"} or option.startswith("--chdir="):
                    return None
                if option in {"-S", "--split-string"} or option.startswith(
                    "--split-string="
                ):
                    return None
                if option in {"-u", "--unset"}:
                    if index + 1 >= len(words):
                        return None
                    lookup_modified = lookup_modified or words[index + 1] == "PATH"
                    index += 2
                    continue
                if option in {"-i", "--ignore-environment", "--"}:
                    lookup_modified = lookup_modified or option != "--"
                    index += 1
                    continue
                if option.startswith("--unset="):
                    lookup_modified = (
                        lookup_modified or option.split("=", 1)[1] == "PATH"
                    )
                    index += 1
                    continue
                assignment = re.fullmatch(
                    r"([A-Za-z_][A-Za-z0-9_]*)=.*", option
                )
                if assignment:
                    lookup_modified = (
                        lookup_modified or assignment.group(1) == "PATH"
                    )
                    index += 1
                    continue
                if option.startswith("-"):
                    return None
                break
            continue
        if name == "exec":
            wrapped = True
            index += 1
            while index < len(words):
                option = words[index]
                if option == "-a":
                    if index + 1 >= len(words):
                        return None
                    index += 2
                    continue
                if option in {"-c", "-l", "--"}:
                    lookup_modified = lookup_modified or option == "-c"
                    index += 1
                    continue
                if option.startswith("-"):
                    return None
                break
            continue
        if name == "time":
            wrapped = True
            index += 1
            while index < len(words):
                option = words[index]
                if option in {"-p", "--"}:
                    index += 1
                    continue
                if option.startswith("-"):
                    return None
                break
            continue
        if name == "nice":
            wrapped = True
            index += 1
            while index < len(words):
                option = words[index]
                if option == "--":
                    index += 1
                    break
                if option in {"-n", "--adjustment"}:
                    if (
                        index + 1 >= len(words)
                        or re.fullmatch(r"[+-]?\d+", words[index + 1]) is None
                    ):
                        return None
                    index += 2
                    continue
                if option.startswith("--adjustment="):
                    if re.fullmatch(r"[+-]?\d+", option.split("=", 1)[1]) is None:
                        return None
                    index += 1
                    continue
                if re.fullmatch(r"-\d+", option):
                    index += 1
                    continue
                if option.startswith(("-", "+")):
                    return None
                break
            continue
        if name in {"builtin", "noglob"}:
            wrapped = True
            index += 1
            if index < len(words) and words[index] == "--":
                index += 1
            continue
        break
    return words[index:], wrapped, lookup_modified


def contains_nested_git_c(words: list[str]) -> bool:
    return any(
        os.path.basename(word) == "git" and "-C" in words[index + 1 :]
        for index, word in enumerate(words[1:], start=1)
    )


def git_is_read_only(words: list[str]) -> bool:
    if any(
        word in {"-c", "--config-env"}
        or word.startswith("--config-env=")
        for word in words[1:]
    ):
        return False
    index, _target = git_command(words, None)
    if index is None:
        return False
    if index >= len(words):
        return True
    verb = words[index]
    args = words[index + 1 :]
    if verb == "branch":
        return branch_is_read_only(args)
    if verb == "remote":
        return remote_is_read_only(args)
    if verb == "tag":
        return tag_is_read_only(args)
    if verb == "stash" and args[:1] in (["list"], ["show"]):
        # Only push, pop, apply, drop, clear, store and create change state;
        # list and show take log and diff options, read like those.
        return git_inspection_outputs([*words[:index], *words[index + 1 :]], index) == []
    if verb in READ_GIT:
        return git_inspection_outputs(words, index) == []
    return (
        verb == "worktree"
        and bool(args)
        and args[0] == "list"
    )


def git_inspection_outputs(words: list[str], command_index: int) -> list[str] | None:
    """Classify reviewed inspection flags and collect every explicit output.

    Unknown options fail closed, including Git's abbreviated long options.
    A pathspec after -- is data, even when it looks like an unsafe option.
    """
    index = 1
    while index < command_index:
        option = words[index]
        if option == "-C":
            index += 2
        elif option in {"--no-pager", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"}:
            index += 1
        else:
            return None
    # Exact names only: never accept --out as an abbreviation of --output.
    flags = {
        "--all", "--binary", "--cached", "--check", "--count", "--compact-summary",
        "--date-order", "--decorate", "--exit-code", "--first-parent", "--follow",
        "--full-history", "--full-index", "--graph", "--header", "--left-right",
        "--name-only", "--name-status", "--no-abbrev", "--no-color", "--no-decorate",
        # Negates the revisions after it (`HEAD --not origin/main`); names no file.
        "--not",
        "--no-ext-diff", "--no-merges", "--no-patch", "--no-renames", "--no-textconv",
        "--numstat", "--objects", "--oneline", "--parents", "--patch", "--porcelain",
        "--quiet", "--raw", "--relative", "--reverse", "--short", "--shortstat",
        "--show-toplevel", "--git-dir", "--git-common-dir", "--show-prefix",
        "--is-inside-work-tree", "--is-bare-repository", "--symbolic-full-name",
        "--abbrev-ref", "--verify", "--staged", "--stat", "--summary", "--topo-order",
        "--unmerged", "--deleted", "--modified", "--others", "--exclude-standard",
        "--recurse-submodules", "--text", "--ignore-all-space", "--ignore-space-change",
        # `git status` display options; none names an output.
        "--branch", "--ahead-behind", "--no-ahead-behind", "--show-stash",
        "--untracked-files",
    }
    values = {
        "--abbrev", "--author", "--before", "--after", "--since", "--until",
        "--color", "--date", "--decorate", "--diff-filter", "--diff-algorithm",
        "--format", "--pretty", "--grep", "--max-count", "--skip", "--sort",
        "--path-format", "--unified", "--find-renames", "--find-copies",
        "--output-indicator-new", "--output-indicator-old", "--output-indicator-context",
    }
    outputs: list[str] = []
    index = command_index + 1
    while index < len(words):
        option = words[index]
        if option == "--":
            break
        if option == "--output" or option.startswith("--output="):
            if "=" in option:
                value = shell_option_value(option)
            else:
                index += 1
                if index >= len(words):
                    return None
                value = words[index]
            if not value or value.startswith("-"):
                return None
            outputs.append(value)
        elif option in flags:
            pass
        elif option in values or option in {"-n", "-L", "-S", "-G", "-O"}:
            index += 1
            if index >= len(words) or words[index].startswith("-"):
                return None
        elif "=" in option and option.split("=", 1)[0] in values | flags:
            pass
        elif re.fullmatch(r"-(?:[0-9]+|[purszabw]+|[UMCBn][0-9]+)", option):
            pass
        elif option.startswith("-"):
            return None
        index += 1
    return outputs


def git_command(words: list[str], cwd: Path | None) -> tuple[int | None, Path | None]:
    """Return the subcommand index and cumulative ``git -C`` directory."""

    index = 1
    target = cwd
    while index < len(words) and words[index].startswith("-"):
        option = words[index]
        if option == "-C":
            if index + 1 >= len(words):
                return None, None
            if target is not None:
                target = resolve_shell_path(words[index + 1], target, empty_is_current=True)
                if target is None:
                    return None, None
            index += 2
            continue
        if option in {"-c", "--config-env", "--git-dir", "--work-tree"}:
            if index + 1 >= len(words):
                return None, None
            index += 2
            continue
        if any(
            option.startswith(f"{prefix}=")
            for prefix in ("--config-env", "--git-dir", "--work-tree")
        ):
            index += 1
            continue
        index += 1
    return index, target


def resolve_shell_path(
    raw_value: str, base: Path, *, empty_is_current: bool = False
) -> Path | None:
    if empty_is_current and not raw_value:
        return base.resolve()
    if not raw_value or raw_value == "-" or has_dynamic_markers(raw_value):
        return None
    raw = Path(raw_value)
    literal_tilde = isinstance(raw_value, ShellWord) and raw_value.protected[0]
    if not literal_tilde:
        raw = raw.expanduser()
        if "~" in raw.as_posix():
            return None
    return (raw if raw.is_absolute() else base / raw).resolve()


def branch_is_read_only(args: list[str]) -> bool:
    if not args:
        return True
    if args == ["--show-current"]:
        return True
    safe_flags = {
        "-a",
        "--all",
        "-r",
        "--remotes",
        "--list",
        "--no-color",
        "--ignore-case",
        "--omit-empty",
        "-v",
        "-vv",
        "--verbose",
    }
    value_options = {
        "--contains",
        "--no-contains",
        "--merged",
        "--no-merged",
        "--points-at",
        "--format",
        "--sort",
        "--color",
        "--column",
    }
    list_mode = any(
        arg in {"-a", "--all", "-r", "--remotes", "--list"}
        or any(arg == option or arg.startswith(f"{option}=") for option in value_options)
        for arg in args
    )
    return option_list_is_safe(args, safe_flags, value_options, list_mode)


def remote_is_read_only(args: list[str]) -> bool:
    if not args or all(arg in {"-v", "--verbose"} for arg in args):
        return True
    prefix = 0
    while prefix < len(args) and args[prefix] in {"-v", "--verbose"}:
        prefix += 1
    if prefix >= len(args):
        return True
    verb = args[prefix]
    rest = args[prefix + 1 :]
    if verb == "get-url":
        return bool(rest) and all(
            item in {"--all", "--push"} or not item.startswith("-") for item in rest
        )
    if verb == "show":
        return bool(rest) and all(
            item == "-n" or not item.startswith("-") for item in rest
        )
    return False


def tag_is_read_only(args: list[str]) -> bool:
    if not args:
        return True
    safe_flags = {
        "-l",
        "--list",
        "--ignore-case",
        "--omit-empty",
        "--no-column",
    }
    value_options = {
        "--contains",
        "--no-contains",
        "--merged",
        "--no-merged",
        "--points-at",
        "--format",
        "--sort",
        "--color",
        "--column",
    }
    list_mode = any(arg in {"-l", "--list"} for arg in args)
    return option_list_is_safe(args, safe_flags, value_options, list_mode)


def option_list_is_safe(
    args: list[str],
    safe_flags: set[str],
    value_options: set[str],
    allow_positionals: bool,
) -> bool:
    index = 0
    while index < len(args):
        item = args[index]
        if item in safe_flags:
            index += 1
            continue
        matching = next(
            (option for option in value_options if item == option),
            None,
        )
        if matching:
            if index + 1 >= len(args):
                return False
            index += 2
            continue
        if any(item.startswith(f"{option}=") for option in value_options):
            index += 1
            continue
        if item.startswith("-") or not allow_positionals:
            return False
        index += 1
    return True


def date_is_read_only(args: list[str]) -> bool:
    """`date` reports a clock unless an argument sets one.

    It needs a parser rather than a place in READ_COMMANDS because two
    unrelated spellings set the system clock: GNU's `-s` / `--set=`, and BSD's
    bare operand (`date 202609121200`), which carries no option at all. Spotting
    the setters is therefore not enough -- an unrecognised word IS a setter --
    so admission is an allowlist and everything else fails closed.

    Deliberately narrow to the forms that mean the same thing on both GNU and
    BSD. `-d`, `-f`, `-j`, `-r` and `-v` are all excluded because they diverge:
    BSD's `-d` sets daylight saving and its `-f` parses a new date and then sets
    the clock, while GNU's `-d` merely displays a given date. The long
    `--date=` / `--reference=` spellings are GNU-only and unambiguous, so they
    stay. This is the same test that keeps `hostname` out.
    """

    flags = {
        "-u", "--utc", "--universal", "-R", "--rfc-email",
        "--help", "--version",
    }
    for item in args:
        if item.startswith("+"):
            continue
        if item in flags:
            continue
        if item == "-I" or re.fullmatch(r"--iso-8601(?:=\w+)?", item):
            continue
        if re.fullmatch(r"-I\w+|--rfc-(?:3339)=\w+", item):
            continue
        if re.fullmatch(r"--(?:date|reference)=.+", item):
            continue
        return False
    return True


SED_LONG_OPTIONS = {
    "expression": "program",
    "file": "unknown",
    "in-place": "writes",
    "line-length": "value",
    "null-data": "flag",
    "zero-terminated": "flag",
    "posix": "flag",
    "quiet": "flag",
    "silent": "flag",
    "regexp-extended": "flag",
    "separate": "flag",
    "sandbox": "flag",
    "unbuffered": "flag",
    "debug": "flag",
    "follow-symlinks": "flag",
    "binary": "flag",
    "help": "flag",
    "version": "flag",
}
SED_BARE_COMMANDS = set("=dDgGhHnNpPxzFlLqQ")


def sed_is_read_only(args: list[str]) -> bool:
    """Whether `sed` only prints: no in-place edit and no program that writes.

    A sed program writes files itself (`w`/`W`, the `w` flag of `s`) or runs
    commands (`e`, the `e` flag of `s`), so the program is parsed too. A
    script file (`-f`) is unseen code, and a program this parser cannot read
    is refused rather than guessed at.
    """
    programs: list[str] = []
    index = 0
    operands: list[str] = []
    while index < len(args):
        item = args[index]
        index += 1
        if item == "--":
            operands.extend(args[index:])
            break
        if item.startswith("--"):
            name, has_value, attached = item[2:].partition("=")
            kinds = {kind for option, kind in SED_LONG_OPTIONS.items() if option.startswith(name)}
            if not name or not kinds or kinds & {"writes", "unknown"} or len(kinds) > 1 and "program" in kinds:
                return False
            if "program" in kinds or "value" in kinds:
                if has_value:
                    value = attached
                elif index < len(args):
                    value = args[index]
                    index += 1
                else:
                    return False
                if "program" in kinds:
                    programs.append(value)
            continue
        if item.startswith("-") and item != "-":
            cluster = item[1:]
            for position, flag in enumerate(cluster):
                if flag in "iIf":
                    return False
                if flag in "el":
                    value = cluster[position + 1 :]
                    if not value:
                        if index >= len(args):
                            return False
                        value = args[index]
                        index += 1
                    if flag == "e":
                        programs.append(value)
                    break
                if flag not in "nsuzrEb":
                    return False
            continue
        operands.append(item)
    if not programs:
        if not operands:
            return False
        programs.append(operands[0])
    script = "\n".join(programs)
    # GNU sed ends a regex at the first unescaped delimiter; BSD sed skips
    # delimiters inside a bracket expression. Both readings must be safe.
    return all(sed_program_is_read_only(script, brackets) for brackets in (False, True))


def sed_delimited(script: str, index: int, delimiter: str, brackets: bool) -> int | None:
    """Index just past the part of `script` ending at `delimiter`, or None."""
    while index < len(script):
        char = script[index]
        if char == "\\":
            index += 2
            continue
        if char == "\n" and delimiter != "\n":
            return None
        if brackets and char == "[":
            start = index + 1
            if script[start : start + 1] == "^":
                start += 1
            if script[start : start + 1] == "]":
                start += 1
            close = script.find("]", start)
            if close == -1:
                return None
            index = close + 1
            continue
        if char == delimiter:
            return index + 1
        index += 1
    return None


def sed_line_end(script: str, index: int) -> int:
    """Index of the end of a text argument, following `\\`-newline continuations."""
    while index < len(script):
        if script[index] == "\\":
            index += 2
            continue
        if script[index] == "\n":
            return index
        index += 1
    return index


def sed_program_is_read_only(script: str, brackets: bool) -> bool:
    index = 0
    length = len(script)
    while index < length:
        char = script[index]
        if char in " \t\n;{}!":
            index += 1
            continue
        if char == "#":
            index = sed_line_end(script, index)
            continue
        # Addresses: a line number, `$`, `first~step`, `+N`, or a regex.
        if char.isdigit() or char in "$,~+":
            index += 1
            continue
        if char in "/\\":
            if char == "\\":
                if index + 1 >= length:
                    return False
                delimiter = script[index + 1]
                index += 2
            else:
                delimiter = "/"
                index += 1
            end = sed_delimited(script, index, delimiter, brackets)
            if end is None:
                return False
            index = end
            while index < length and script[index] in "IM":
                index += 1
            continue
        index += 1
        if char in "wWe":
            return False
        if char in SED_BARE_COMMANDS:
            while index < length and script[index] in " \t0123456789":
                index += 1
            continue
        if char in "aicrR:bTtv":
            index = sed_line_end(script, index) if char in "aicrR" else sed_label_end(script, index)
            continue
        if char in "sy":
            if index >= length or script[index] in "\\\n":
                return False
            delimiter = script[index]
            index += 1
            for part in range(2):
                end = sed_delimited(script, index, delimiter, brackets and part == 0 and char == "s")
                if end is None:
                    return False
                index = end
            if char == "s":
                while index < length and (script[index].isdigit() or script[index] in "gpiImMwe"):
                    if script[index] in "we":
                        return False
                    index += 1
            continue
        return False
    return True


def sed_label_end(script: str, index: int) -> int:
    """End of a label: GNU stops at `;`, so the rest is parsed as commands."""
    while index < len(script) and script[index] not in ";\n}":
        index += 1
    return index


def node_is_read_only(args: list[str]) -> bool:
    """Node asked only to identify itself.

    Node is an interpreter, and the guard already knows it:
    NON_SHELL_INLINE_INTERPRETERS denies `-e` and `-p`, and
    `mutation_path_operands` denies a script file because no parser can prove
    what opaque program text writes. Both denials are correct and both stay.
    This admits the version and help queries alone, which run no program, and
    requires at least one of them -- a bare `node` opens a REPL that can
    execute anything.

    The spellings are NOT shared with the shell interpreters below. For node
    `-v` is the version; for bash `-v` is verbose mode, which still executes
    every command. One set covering both would quietly allow `bash -v`.
    """

    return bool(args) and all(
        item in {"-v", "--version", "-h", "--help"} for item in args
    )


def shell_interpreter_is_read_only(args: list[str]) -> bool:
    """A shell that reports itself, or parses a program without running it.

    `-n` is noexec: the shell reads its program, parses it, and never runs a
    command. That is the only way a session can syntax-check the shell
    libraries in the repository that it is editing, and it writes nothing.

    The exclusions carry the proof. Option scanning stops at the first
    operand, because a `-n` AFTER the script name is a positional parameter
    and the program then executes normally. `-i` is refused because an
    interactive shell IGNORES `-n`. `-o`, `+o`, `-O`, `+O` and every long
    option but the two queries are refused because their values name options
    this parser does not interpret, and `-c` is refused so that the reviewed
    spelling cannot become an arbitrary program if the noexec requirement is
    ever relaxed.

    Only `--version` and `--help` count as queries: bash's `-v` is verbose.
    """

    if args and all(item in {"--version", "--help"} for item in args):
        return True
    noexec = False
    for item in args:
        if item in {"--", "-"} or not item.startswith("-"):
            break
        if not re.fullmatch(r"-[nvx]+", item):
            return False
        noexec = noexec or "n" in item
    return noexec


# adb drives an Android device; it runs nothing on the host but itself. What
# it can do to the host is fixed by its subcommand, so it gets a parser of its
# own rather than a place in READ_COMMANDS or GENERIC_SCOPED_COMMANDS: the
# first would claim `adb pull` writes nothing, the second would read the
# device path in `adb push app.apk /data/local/tmp` as a host destination.
#
# Three tiers. `adb_is_read_only` admits what changes neither the host nor the
# device, from any checkout. `adb_mutation_paths` names what the rest write on
# the HOST -- `pull`'s local destination, a bugreport, a backup, a key pair --
# so those are confined like any other operand. Everything else it lists
# changes only the device (install, uninstall, push, `shell pm clear`, port
# forwards, reboot); those write nothing in any checkout, and run from this
# session's own worktree, which is where the reviewed runners run (a
# deliberate choice: a device is no checkout, but its writes stay behind the
# same ownership gate as every other runner's).
#
# Every adb client starts the adb server when none is running. Its state lives
# under ~/.android and $TMPDIR, never in a checkout, and no operand names it --
# but the environment can (ANDROID_USER_HOME, TMPDIR), which is why
# `mutation_directories` takes an adb behind an assignment or wrapper out of
# the read-only tier.
ADB_FLAGS = {"-d", "-e"}
ADB_VALUE_OPTIONS = {"-s", "-t", "-H", "-P"}
ADB_READ_SUBCOMMANDS = {
    "devices",
    "features",
    "get-devpath",
    "get-serialno",
    "get-state",
    "help",
    "host-features",
    "version",
}
ADB_WAIT = re.compile(
    r"wait-for(?:-(?:usb|local|any))?"
    r"-(?:device|recovery|rescue|sideload|bootloader|disconnect)"
)
# Subcommands whose only host effect is reading host files or talking to the
# server. `emu` and `ppp` are absent on purpose: the emulator console can
# write host files (`screenrecord start <file>`), and `ppp` runs a host pppd.
ADB_DEVICE_SUBCOMMANDS = ADB_READ_SUBCOMMANDS | {
    "connect",
    "disable-verity",
    "disconnect",
    "enable-verity",
    "exec-in",
    "exec-out",
    "forward",
    "install",
    "install-multi-package",
    "install-multiple",
    "jdwp",
    "kill-server",
    "logcat",
    "mdns",
    "pair",
    "push",
    "reboot",
    "reboot-bootloader",
    "reconnect",
    "remount",
    "restore",
    "reverse",
    "root",
    "shell",
    "sideload",
    "start-server",
    "sync",
    "tcpip",
    "track-devices",
    "uninstall",
    "unroot",
    "usb",
}
# logcat options that leave the device's log buffers as they are. Mutators are
# absent and so refused: -c clears, -G and -P set the buffer size and prune
# list, -f/-r/-n write a file ON THE DEVICE (logcat runs there; it is not a
# host write). `-g` and `-p` only print what `-G` and `-P` would set.
LOGCAT_FLAGS = set("BDLSdgsp")
LOGCAT_VALUE_FLAGS = set("Tbemtv")
LOGCAT_LONG = re.compile(
    r"--(?:binary|dividers|last|print|statistics|wrap"
    r"|(?:buffer|format|max-count|pid|regex|uid)=.+)"
)
# The device's own shell re-parses `adb shell`'s words joined by spaces, with
# no escaping, so one quoted word can carry `;`, `|`, `>` or a newline to the
# device. A device command is read-only only when the joined line holds none of
# that: the reviewed characters plus the space, and nothing else.
DEVICE_LINE = re.compile(r"[A-Za-z0-9_.:/=,@%+ -]*")
PACKAGE_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+")
PM_LISTS = {
    "features",
    "instrumentation",
    "libraries",
    "packages",
    "permission-groups",
    "permissions",
    "users",
}


# Variables that move where the adb server writes on ANY call: its log and its
# key pair. A value given one of these is a destination like an operand.
ADB_STATE_ASSIGNMENT = re.compile(
    r"(?:TMPDIR|HOME|ANDROID_SDK_HOME|ANDROID_USER_HOME|ANDROID_PREFS_ROOT"
    r"|ANDROID_ADB_LOG_PATH)=(.*)",
    re.DOTALL,
)


def adb_state_paths(words: list[str], cwd: Path) -> list[Path] | None:
    """Destinations named by state-moving assignments among ``words``.

    Applied to an adb command's own prefix, and to an assignment-only segment
    whatever follows it: TMPDIR and HOME are already exported, so `TMPDIR=x;`
    reaches every later command on the line, nested shells included. A value
    that cannot be resolved (empty, or a `$VAR`) fails closed.
    """

    values = [
        match.group(1)
        for word in words
        if (match := ADB_STATE_ASSIGNMENT.fullmatch(word))
    ]
    return resolve_mutation_paths(values, cwd)


def adb_subcommand(args: list[str]) -> int | None:
    """Index of adb's subcommand past the reviewed global options, or None.

    `-L` (a server socket, which may be a host filesystem path) and `-a` (the
    server listens on every interface) are not reviewed, so they fail closed
    along with any other unrecognised option. So does an attached value
    (`-sSERIAL`): adb's own reading of `-s<word>` depends on the word, and a
    prefix match here would take `-shell` for `-s hell`.
    """

    index = 0
    while index < len(args):
        item = args[index]
        if item in ADB_FLAGS:
            index += 1
            continue
        if item in ADB_VALUE_OPTIONS:
            if index + 1 >= len(args):
                return None
            index += 2
            continue
        if item.startswith("-") and item not in {"--version", "--help"}:
            return None
        return index
    return None


def logcat_is_read_only(args: list[str]) -> bool:
    """logcat asked to print, never to clear, resize, prune or write a file.

    An allowlist over each short-option cluster: `-dc` must not pass because
    its first letter does. A value option ends its cluster, taking the rest of
    the word or the next one. Positionals are filterspecs (`ReactNativeJS:V`,
    `*:S`); adb escapes each before the device shell sees it, so they carry no
    command.
    """

    index = 0
    while index < len(args):
        item = args[index]
        index += 1
        if item.startswith("--"):
            if not LOGCAT_LONG.fullmatch(item):
                return False
            continue
        if not item.startswith("-") or item == "-":
            continue
        for position, letter in enumerate(item[1:], start=1):
            if letter in LOGCAT_VALUE_FLAGS:
                if position == len(item) - 1:
                    if index >= len(args):
                        return False
                    index += 1
                break
            if letter not in LOGCAT_FLAGS:
                return False
    return True


def dumpsys_is_read_only(args: list[str]) -> bool:
    """dumpsys listing services, or dumping one, without a service command.

    A service reads dumpsys's trailing words as its own arguments, and several
    act on them: `battery set level 5`, `battery unplug`, `deviceidle
    force-idle`, `gfxinfo <pkg> reset`, `batterystats --reset`. So past the
    service name only a package name and the plain dump options are admitted;
    any other word sends the command to the device-mutation tier.
    """

    if not args or args == ["-l"]:
        return True
    service, rest = args[0], args[1:]
    return not service.startswith("-") and all(
        PACKAGE_NAME.fullmatch(item) or item in {"-a", "-c", "-h", "--checkin"}
        for item in rest
    )


def device_command_is_read_only(line: str) -> bool:
    """A device shell command line that only reads.

    Split here exactly as the device shell will split it, which is only sound
    because `DEVICE_LINE` leaves nothing in the line but words and spaces.
    """

    if not DEVICE_LINE.fullmatch(line):
        return False
    words = line.split()
    if not words:
        return False
    name, args = words[0], words[1:]
    if name == "getprop":
        return len(args) <= 2
    if name == "pm":
        if args[:1] == ["path"]:
            return len(args) >= 2
        return args[:1] == ["list"] and len(args) >= 2 and args[1] in PM_LISTS
    if name == "dumpsys":
        return dumpsys_is_read_only(args)
    if name == "logcat":
        return logcat_is_read_only(args)
    return name in {"pidof", "ps"}


def adb_is_read_only(args: list[str]) -> bool:
    """adb that changes neither this host's files nor the device.

    `logcat` without `-d` streams until interrupted. That is a long command,
    not a mutation, so it is admitted; it is the caller's job not to wait on
    it.
    """

    index = adb_subcommand(args)
    if index is None:
        return False
    subcommand, rest = args[index], args[index + 1 :]
    if subcommand in {"--version", "--help", "help", "version"}:
        return not rest
    if subcommand == "devices":
        return all(item == "-l" for item in rest)
    if subcommand in ADB_READ_SUBCOMMANDS or ADB_WAIT.fullmatch(subcommand):
        return not rest
    if subcommand == "logcat":
        return logcat_is_read_only(rest)
    if subcommand in {"shell", "exec-out"}:
        while subcommand == "shell" and rest[:1] and rest[0] in {"-n", "-T", "-t", "-x"}:
            rest = rest[1:]
        return device_command_is_read_only(" ".join(rest))
    return False


def adb_mutation_paths(args: list[str], cwd: Path) -> list[Path] | None:
    """HOST paths an adb command writes; None when it is not reviewed.

    Device paths are never resolved: `/sdcard/x` in `adb pull /sdcard/x` names
    the phone. The directory the command runs in is already counted by the
    caller, which covers every default destination (`pull` with one operand,
    a bare `bugreport`, `backup.ab`).
    """

    index = adb_subcommand(args)
    if index is None:
        return None
    subcommand, rest = args[index], args[index + 1 :]
    if subcommand == "pull":
        # Only pull's own options, each with its arity: an unreviewed option
        # that took a value could hide the real destination among the
        # positionals, so it fails closed instead of being skipped.
        positionals: list[str] = []
        position = 0
        while position < len(rest):
            item = rest[position]
            if item == "-z":
                if position + 1 >= len(rest):
                    return None
                position += 2
                continue
            if item in {"-a", "-Z"}:
                position += 1
                continue
            if item.startswith("-"):
                return None
            positionals.append(item)
            position += 1
        return resolve_mutation_paths(positionals[-1:] if len(positionals) >= 2 else [], cwd)
    if subcommand == "bugreport":
        if len(rest) > 1 or rest[:1] and rest[0].startswith("-"):
            return None
        return resolve_mutation_paths(rest, cwd)
    if subcommand == "backup":
        if any(item.startswith("-f") and item != "-f" for item in rest):
            return None
        if "-f" not in rest:
            return []
        position = rest.index("-f")
        if position + 1 >= len(rest):
            return None
        return resolve_mutation_paths([rest[position + 1]], cwd)
    if subcommand == "keygen":
        if len(rest) != 1:
            return None
        return resolve_mutation_paths([rest[0], f"{rest[0]}.pub"], cwd)
    if subcommand in ADB_DEVICE_SUBCOMMANDS or ADB_WAIT.fullmatch(subcommand):
        return []
    return None


def segment_is_read_only(words: list[str]) -> bool:
    if not words:
        return True
    name = os.path.basename(words[0])
    if words[0] != name:
        # A path-qualified executable may be a repository-controlled shim. It
        # cannot inherit any trusted bare command's read-only behavior.
        return False
    if has_dynamic_markers(words[0]) and words[0] not in {"[", "[["}:
        # `$cmd args` runs whatever the expansion names. A lone `[` or `[[`
        # opens no glob: the test builtin and keyword.
        return False
    if name in READ_COMMANDS:
        # No option and no operand of these writes, so no expansion can.
        return True
    if name not in OWN_EXPANSION_RULES and not expansions_are_inert(name, words[1:]):
        return False
    if name in {"awk", "gawk", "mawk", "nawk"}:
        return awk_is_read_only(words[1:])
    if name == "sort":
        return sort_is_read_only(words[1:])
    if name == "uniq":
        return uniq_is_read_only(words[1:])
    if name == "xargs":
        return xargs_is_read_only(words[1:])
    if name == "tee":
        return tee_is_read_only(words[1:])
    if name == "gh":
        return gh_is_read_only(words[1:])
    if name == "file":
        return file_is_read_only(words[1:])
    if name == "printf":
        return printf_is_read_only(words[1:])
    if name == "cd":
        return (len(words) == 2 and words[1] != "--") or (
            len(words) == 3 and words[1] == "--"
        )
    if name == "git":
        return git_is_read_only(words)
    if name == "env":
        # Bare `env` prints the environment, as `printenv` does. With any
        # operand it is a wrapper that runs a program, which stays unproven.
        return len(words) == 1
    if name == "find":
        write_actions = {
            "-delete",
            "-exec",
            "-execdir",
            "-ok",
            "-okdir",
            "-fls",
            "-fprint",
            "-fprint0",
            "-fprintf",
        }
        return not any(word in write_actions for word in words[1:])
    if name == "rg":
        executable_options = {"--pre", "--hostname-bin"}
        return not any(
            word in executable_options
            or any(word.startswith(f"{option}=") for option in executable_options)
            for word in words[1:]
        )
    if name == "sed":
        return sed_is_read_only(words[1:])
    if name == "date":
        return date_is_read_only(words[1:])
    if name in {"node", "nodejs"}:
        return node_is_read_only(words[1:])
    if name == "adb":
        return adb_is_read_only(words[1:])
    if name in SHELL_INTERPRETERS:
        return shell_interpreter_is_read_only(words[1:])
    if name == "for":
        return for_header_is_read_only(words)
    if name == "read":
        return read_is_read_only(words[1:])
    return False


# zsh's own lowercase parameters (`print -l ${(k)parameters}` with zsh/parameter
# and zsh/mapfile loaded). Several steer what runs or what is written: `path`
# and `commands` command lookup, `cdpath` where cd lands, `functions` and
# `aliases` what a word means, `mapfile` writes files.
SHELL_SPECIAL_LOWERCASE = frozenset(
    "_ aliases argv builtins cdpath commands dirstack dis_aliases dis_builtins "
    "dis_functions dis_functions_source dis_galiases dis_patchars dis_reswords "
    "dis_saliases fignore fpath funcfiletrace funcsourcetrace funcstack functions "
    "functions_source functrace galiases histchars history historywords jobdirs "
    "jobstates jobtexts keymaps mailpath manpath mapfile module_path modules "
    "nameddirs options parameters patchars path pipestatus prompt psvar reswords "
    "saliases signals status termcap terminfo userdirs usergroups watch widgets "
    "zsh_eval_context zsh_scheduled_events".split()
)


def assignable_name(name: str) -> bool:
    """A variable a loop or `read` may set without changing anything but itself.

    Lowercase only: bash's and zsh's lookup and repository variables (PATH,
    CDPATH, BASH_ENV, GIT_DIR) are uppercase. Not one of zsh's lowercase
    specials, and not exported here: an exported name (`npm_config_prefix`)
    reaches every child process. This hook cannot see what the Bash tool's
    shell exports, so `mutation_directories` also refuses any write on a
    line that sets one; only all-read lines rely on this check alone.
    """

    return (
        re.fullmatch(r"[a-z_][a-z0-9_]*", name) is not None
        and name not in SHELL_SPECIAL_LOWERCASE
        and name not in os.environ
        and not name.startswith(("npm_", "pnpm_"))
    )


def for_header_is_read_only(words: list[str]) -> bool:
    """`for NAME in WORDS` only sets a shell variable; the body is its own segments.

    The listed words are expanded, never run (backticks are refused by the
    scanner, and a `$(...)` it admits is read-only), so the header writes
    nothing. Only
    the bare unquoted keyword is syntax: `"for"` runs a program named for.
    The arithmetic form `for ((...))` stays unproven. The name must be
    `assignable_name`.
    """

    keyword = words[0]
    if not isinstance(keyword, ShellWord) or keyword.quote_start is not None:
        return False
    if len(words) < 2 or not assignable_name(words[1]):
        return False
    return len(words) == 2 or words[2] == "in"


def read_is_read_only(args: list[str]) -> bool:
    """The `read` builtin reads stdin into `assignable_name` variables.

    Only `-r` and `-s`, the flags bash and zsh read alike and that take no
    value. The rest differ: zsh's `-p` reads the coprocess, so the next word
    is a name and not bash's prompt; its `-e` echoes instead of assigning;
    `-a` is bash's array and not a zsh option. With no name it sets REPLY.
    zsh's `read name?prompt` form is not an identifier, so it stays unproven.
    """

    index = 0
    while index < len(args) and args[index].startswith("-"):
        option = args[index]
        if option == "--":
            index += 1
            break
        if re.fullmatch(r"-[rs]+", option) is None:
            return False
        index += 1
    return all(assignable_name(name) for name in args[index:])


def long_option_kinds(word: str, table: dict[str, str]) -> tuple[str, str | None] | None:
    """The kind of a GNU long option, its abbreviations included, and its value.

    GNU getopt accepts any unambiguous prefix (`--out` is `--output`), so a
    prefix of a writing option is refused even when it is ambiguous. None when
    the word names no option, more than one, or one that writes.
    """

    name, has_value, value = word[2:].partition("=")
    if not name:
        return None
    kinds = {kind for option, kind in table.items() if option.startswith(name)}
    exact = table.get(name)
    if "writes" in kinds or not kinds:
        return None
    if exact is None and len(kinds) > 1:
        return None
    kind = exact or next(iter(kinds))
    return kind, value if has_value else None


def option_words_are_read_only(
    args: list[str],
    *,
    flags: str,
    values: str,
    writes: str,
    long_options: dict[str, str],
) -> tuple[list[str], int] | None:
    """Operands of a getopt command when no option it is given writes.

    ``flags`` take no value, ``values`` take one (attached or the next word),
    ``writes`` are refused. Long options map to `flag`, `value`, `optional`
    or `writes`. Returns the operands, and how many came after `--`.
    """

    operands: list[str] = []
    index = 0
    while index < len(args):
        item = args[index]
        index += 1
        if item == "--":
            return operands + list(args[index:]), len(args) - index
        if item.startswith("--"):
            parsed = long_option_kinds(item, long_options)
            if parsed is None:
                return None
            kind, value = parsed
            if kind == "value" and value is None:
                if index >= len(args):
                    return None
                index += 1
            continue
        if item.startswith("-") and item != "-":
            cluster = item[1:]
            for position, flag in enumerate(cluster):
                if flag in writes:
                    return None
                if flag in values:
                    # getopt takes the rest of the word as the value, but a
                    # value that spells a writing option is refused anyway:
                    # no reading here rests on one getopt's choice.
                    if any(letter in writes for letter in cluster[position + 1:]):
                        return None
                    if position == len(cluster) - 1:
                        if index >= len(args):
                            return None
                        index += 1
                    break
                if flag not in flags:
                    return None
            continue
        operands.append(item)
    return operands, 0


# "writes" refuses the option. `--files0-from` is among them: the operands it
# reads from a file are words this parser never sees.
SORT_LONG_OPTIONS = {
    "batch-size": "value", "buffer-size": "value", "check": "optional",
    "compress-program": "writes", "debug": "flag", "dictionary-order": "flag",
    "field-separator": "value", "files0-from": "writes",
    "general-numeric-sort": "flag", "help": "flag", "human-numeric-sort": "flag",
    "ignore-case": "flag", "ignore-leading-blanks": "flag",
    "ignore-nonprinting": "flag", "key": "value", "merge": "flag",
    "month-sort": "flag", "numeric-sort": "flag", "output": "writes",
    "parallel": "value", "random-sort": "flag", "random-source": "value",
    "reverse": "flag", "sort": "value", "stable": "flag",
    "temporary-directory": "writes", "unique": "flag", "version": "flag",
    "version-sort": "flag", "zero-terminated": "flag",
}


def sort_is_read_only(args: list[str]) -> bool:
    """`sort` prints unless `-o` names an output, `-T` a directory it writes
    temporary files in, or `--compress-program` a program it runs. A short
    cluster is read as getopt reads it: in `-to` the `o` is `-t`'s value."""

    return (
        option_words_are_read_only(
            args, flags="bcCdfghiMmnRrsuVz", values="kSt", writes="oT",
            long_options=SORT_LONG_OPTIONS,
        )
        is not None
    )


UNIQ_LONG_OPTIONS = {
    "all-repeated": "optional", "check-chars": "value", "count": "flag",
    "group": "optional", "help": "flag", "ignore-case": "flag",
    "repeated": "flag", "skip-chars": "value", "skip-fields": "value",
    "unique": "flag", "version": "flag", "zero-terminated": "flag",
}


def uniq_is_read_only(args: list[str]) -> bool:
    """`uniq [input [output]]`: a second operand is the file it writes."""

    parsed = option_words_are_read_only(
        args, flags="cdDiuz", values="fsw", writes="", long_options=UNIQ_LONG_OPTIONS,
    )
    return parsed is not None and len(parsed[0]) <= 1


XARGS_LONG_OPTIONS = {
    "arg-file": "value", "delimiter": "value", "eof": "optional", "exit": "flag",
    "help": "flag", "interactive": "flag", "max-args": "value",
    "max-chars": "value", "max-lines": "optional", "max-procs": "value",
    "no-run-if-empty": "flag", "null": "flag", "open-tty": "flag",
    "process-slot-var": "writes", "replace": "optional", "show-limits": "flag",
    "verbose": "flag", "version": "flag",
}


def xargs_is_read_only(args: list[str]) -> bool:
    """`xargs` runs one command with words from its input appended.

    Those words are unknown, so the command must be read-only whatever its
    words are: a bare member of READ_COMMANDS. With no command it runs echo.
    The value-taking options are read as GNU and BSD take them; `-i` and `-l`
    take theirs attached only.
    """

    def literal(word: str) -> bool:
        # `-I {}`: an empty brace pair is no brace expansion in bash or zsh.
        return not has_dynamic_markers(word.replace("{}", ""))

    index = 0
    while index < len(args):
        item = args[index]
        if not literal(item):
            return False
        if item == "--":
            index += 1
            break
        if item.startswith("--"):
            parsed = long_option_kinds(item, XARGS_LONG_OPTIONS)
            if parsed is None:
                return False
            kind, value = parsed
            index += 1
            if kind == "value" and value is None:
                if index >= len(args) or not literal(args[index]):
                    return False
                index += 1
            continue
        if not item.startswith("-") or item == "-":
            break
        cluster = item[1:]
        index += 1
        for position, flag in enumerate(cluster):
            if flag in "nLPsdEIJRSa":
                if position == len(cluster) - 1:
                    if index >= len(args) or not literal(args[index]):
                        return False
                    index += 1
                break
            if flag in "il":
                break
            if flag not in "0rtpxo":
                return False
    if index == len(args):
        return True
    command = args[index]
    return (
        os.path.basename(command) == command
        and not has_dynamic_markers(command)
        and command in READ_COMMANDS
    )


def tee_is_read_only(args: list[str]) -> bool:
    """`tee` with /dev/null as every file only copies stdin to stdout."""

    files: list[str] = []
    options = True
    for item in args:
        if options and item == "--":
            options = False
            continue
        if options and (
            item in {"--append", "--ignore-interrupts", "--output-error"}
            or item.startswith("--output-error=")
            or re.fullmatch(r"-[aip]+", item)
        ):
            continue
        if options and item.startswith("-"):
            return False
        files.append(item)
    return all(item == os.devnull and expansion_risk(item) is None for item in files)


def file_is_read_only(args: list[str]) -> bool:
    """`file` reports types; `-C` compiles a magic file, which it writes."""

    for item in args:
        if item == "--":
            return True
        if item.startswith("--") and len(item) > 2 and "--compile".startswith(item.partition("=")[0]):
            return False
        if item.startswith("-") and not item.startswith("--") and "C" in item[1:]:
            return False
    return True


def printf_is_read_only(args: list[str]) -> bool:
    """`printf` prints, unless `-v name` assigns the result to a variable.

    `-v` is its only option, so any first word that is an option (a cluster
    such as `-xv` included) is refused; `--` before the format is fine.
    """

    if not args:
        return True
    first = args[0]
    return expansions_are_inert("printf", args[:1]) and not (
        first.startswith("-") and first not in {"-", "--"}
    )


AWK_KEYWORDS_BEFORE_OPERAND = {
    "print", "printf", "return", "in", "if", "while", "for", "do", "else",
    "delete", "case", "getline",
}


def awk_is_read_only(args: list[str]) -> bool:
    """`awk` with a program that writes no file and runs no command.

    `-F` and `-v` are the only options: `-f` is unseen code, and gawk's `-i`,
    `-l`, `-e` and long options load or add code (`-i inplace` rewrites its
    operands). Operands are input files or `name=value` assignments.
    """

    index = 0
    while index < len(args):
        item = args[index]
        if expansion_risk(item) == "split":
            # It may become several words, `-f file` among them.
            return False
        if item == "--":
            # Not every awk reads `--` as the end of options; where the
            # program sits would then differ by implementation.
            return False
        if item in {"-F", "-v"}:
            if index + 1 < len(args) and expansion_risk(args[index + 1]) == "split":
                return False
            index += 2
            continue
        if item.startswith(("-F", "-v")):
            index += 1
            continue
        if item.startswith("-") and item != "-":
            return False
        break
    if index >= len(args):
        return False
    program = args[index]
    return not has_dynamic_markers(program) and awk_program_is_read_only(program)


def awk_program_is_read_only(program: str) -> bool:
    """Whether an awk program has no output redirection, pipe or `system`.

    It is lexed as awk lexes it: strings, regular expressions (a `/` where an
    operand is expected starts one, as gawk decides) and comments are skipped.
    Within a `print` or `printf` statement any `>` is refused, the
    redirections `>` and `>>` and a parenthesised comparison alike; elsewhere
    `>` compares. Any `|` but `||` is a pipe or a coprocess; `@` loads code in
    gawk; anything that does not close (a string, a regex, a parenthesis) is
    refused rather than guessed at.
    """

    index = 0
    length = len(program)
    operand = False
    in_print = False
    parens = 0
    braces = 0
    while index < length:
        character = program[index]
        if character == '"':
            index += 1
            while index < length and program[index] != '"':
                if program[index] == "\n":
                    return False
                index += 2 if program[index] == "\\" else 1
            if index >= length:
                return False
            index += 1
            operand = True
            continue
        if character == "#":
            newline = program.find("\n", index)
            index = length if newline < 0 else newline
            continue
        if character in " \t\r":
            index += 1
            continue
        if character == "/" and not operand:
            index += 1
            while index < length and program[index] != "/":
                if program[index] == "\n":
                    return False
                if program[index] == "[":
                    close = program.find("]", index + 2)
                    if close < 0:
                        return False
                    index = close + 1
                    continue
                index += 2 if program[index] == "\\" else 1
            if index >= length:
                return False
            index += 1
            operand = True
            continue
        if character.isalpha() or character == "_":
            end = index
            while end < length and (program[end].isalnum() or program[end] == "_"):
                end += 1
            word = program[index:end]
            if word == "system":
                return False
            if word in {"print", "printf"}:
                in_print = True
            operand = word not in AWK_KEYWORDS_BEFORE_OPERAND
            index = end
            continue
        if character.isdigit() or (character == "." and program[index + 1 : index + 2].isdigit()):
            while index < length and (program[index].isalnum() or program[index] == "."):
                index += 1
            operand = True
            continue
        if character in "@`\\":
            return False
        if character == "|":
            if program[index + 1 : index + 2] != "|":
                return False
            index += 2
            operand = False
            continue
        if character == ">" and in_print:
            return False
        if character in "+-" and program[index + 1 : index + 2] == character:
            # `x++` keeps an operand before it; `++x` had none to keep.
            index += 2
            continue
        if character == "(":
            parens += 1
        elif character == ")":
            parens -= 1
            if parens < 0:
                return False
        elif character == "{":
            braces += 1
            in_print = False
        elif character == "}":
            braces -= 1
            if braces < 0:
                return False
            in_print = False
        elif character in ";\n":
            in_print = False
        operand = character in ")]"
        index += 1
    return parens == 0 and braces == 0


# `gh` subcommands that only read GitHub. An extension cannot shadow a built-in
# command, so the names mean these commands. `--web` opens a browser and is
# refused with them. gh's update check writes `~/.local/state/gh/state.yml`
# only on a terminal: measured 2026-11-08, `gh issue view` from the Bash tool
# left its mtime unchanged.
GH_READS = {
    "issue": {"list", "status", "view"},
    "label": {"list"},
    "pr": {"checks", "diff", "list", "status", "view"},
    "release": {"list", "view"},
    "repo": {"view"},
    "run": {"list", "view"},
    "search": {"code", "commits", "issues", "prs", "repos"},
    "secret": {"list"},
    "variable": {"list"},
    "workflow": {"list", "view"},
}


def gh_is_read_only(args: list[str]) -> bool:
    """`gh` asked only to read: a read subcommand, or `gh api` with GET."""

    if args in (["--version"], ["auth", "status"], ["status"]):
        return True
    if any(item in {"-w", "--web"} for item in args):
        return False
    if len(args) >= 2 and args[1] in GH_READS.get(args[0], set()):
        return True
    if args[:1] == ["api"]:
        return gh_api_is_read_only(args[1:])
    return False


def gh_api_is_read_only(args: list[str]) -> bool:
    """`gh api` with no method but GET, and no field (which makes it POST).

    `--cache` writes a cache directory, `--input` sends a body. A GraphQL
    request is a POST whatever it does, so `graphql` is read only for a
    literal query with no `mutation` in it and literal variables.
    """

    values = {
        "-H", "--header", "--hostname", "-p", "--preview", "-q", "--jq",
        "-t", "--template",
    }
    flags = {"--paginate", "--slurp", "-i", "--include", "--silent", "--verbose"}
    fields: list[str] = []
    endpoint: str | None = None
    index = 0
    while index < len(args):
        item = args[index]
        index += 1
        if item in values:
            # A value option with nothing after it would take the next word
            # in another reading: refuse rather than guess the endpoint.
            if index >= len(args):
                return False
            index += 1
            continue
        if item.startswith("--") and "=" in item and item.split("=", 1)[0] in values:
            continue
        if item in flags:
            continue
        if item in {"-X", "--method"} or item.startswith("--method="):
            method = item.split("=", 1)[1] if "=" in item else (
                args[index] if index < len(args) else ""
            )
            index += 0 if "=" in item else 1
            if method.upper() != "GET":
                return False
            continue
        if item in {"-f", "-F", "--field", "--raw-field"}:
            if index >= len(args):
                return False
            fields.append(args[index])
            index += 1
            continue
        if item.startswith("-"):
            return False
        if endpoint is not None:
            return False
        endpoint = item
    if endpoint is None:
        return False
    if not fields:
        return True
    if endpoint != "graphql":
        return False
    query = [field for field in fields if field.startswith("query=")]
    if len(query) != 1 or has_dynamic_markers(query[0]):
        return False
    text = query[0].split("=", 1)[1].lstrip()
    return (
        (text.startswith("{") or text.startswith("query"))
        and "mutation" not in text
        and "subscription" not in text
        and all(
            re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", field, re.DOTALL) is not None
            and not has_dynamic_markers(field)
            for field in fields
        )
    )


def shell_is_read_only(command: str, depth: int = 0) -> bool:
    """Whether no segment of ``command`` writes anything.

    Leading control words (`do`, `then`, `done`, ...) are syntax and are
    dropped first, so a loop or `if` whose every command reads is read-only
    from any checkout. Loop variables bound to literal words are read with
    each of their values (``bound_variants``).
    """

    segments = split_commands(command, depth)
    if segments is None:
        return False
    bindings: dict[str, tuple[str, ...]] = {}
    for raw in segments:
        words = without_control_words(raw)
        if words is None:
            return False
        if not segment_is_read_only_bound(words, bindings):
            return False
        update_bindings(words, bindings)
    return True


def without_control_words(words: list[str]) -> list[str] | None:
    """``words`` past its leading unquoted control words and `!`."""

    index = 0
    while index < len(words):
        word = words[index]
        if word not in SHELL_CONTROL_WORDS and word != "!":
            break
        if not isinstance(word, ShellWord) or word.quote_start is not None:
            # `"do"` runs a program named do.
            return None
        index += 1
    return words[index:]


# A loop value substituted for `$name` must mean the same quoted or not: no
# blank, glob, quote, tilde or expansion character.
LITERAL_VALUE = re.compile(r"[A-Za-z0-9._/,:+=@%^-]+")
VARIANT_LIMIT = 64


def update_bindings(words: list[str], bindings: dict[str, tuple[str, ...]]) -> None:
    """Record what a `for` header binds; forget whatever else a segment sets."""

    if not words:
        return
    if words[0] == "for" and for_header_is_read_only(words):
        values = tuple(words[3:]) if len(words) > 3 else ()
        if values and all(
            not has_dynamic_markers(value) and LITERAL_VALUE.fullmatch(value)
            for value in values
        ):
            bindings[words[1]] = values
        else:
            bindings.pop(words[1], None)
        return
    if words[0] == "read":
        bindings.pop("REPLY", None)
    for word in words:
        assignment = re.match(r"([A-Za-z_][A-Za-z0-9_]*)=", word)
        if assignment:
            bindings.pop(assignment.group(1), None)
        elif word in bindings:
            # `read name`, `unset name`, `export name`, ...: set elsewhere.
            bindings.pop(word, None)


def bound_variants(
    words: list[str], bindings: dict[str, tuple[str, ...]]
) -> list[list[str]] | None:
    """``words`` once per combination of the bound loop values they name.

    Only `$name` and `${name}` with an unprotected `$` are replaced, and only
    for names bound to literal words; anything else stays an expansion. None
    when the combinations exceed ``VARIANT_LIMIT``.
    """

    if not bindings:
        return [words]
    reference = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))")
    used: list[str] = []
    for word in words:
        for match in reference.finditer(word):
            name = match.group(1) or match.group(2)
            if name in bindings and name not in used and not (
                isinstance(word, ShellWord) and word.protected[match.start()]
            ):
                used.append(name)
    if not used:
        return [words]
    combinations = 1
    for name in used:
        combinations *= len(bindings[name])
    if combinations > VARIANT_LIMIT:
        return None

    def substitute(word: str, values: dict[str, str]) -> str:
        if not isinstance(word, ShellWord):
            return word
        text: list[str] = []
        guard: list[bool] = []
        position = 0
        for match in reference.finditer(word):
            name = match.group(1) or match.group(2)
            if name not in values or word.protected[match.start()]:
                continue
            text.extend(word[position : match.start()])
            guard.extend(word.protected[position : match.start()])
            text.extend(values[name])
            guard.extend([True] * len(values[name]))
            position = match.end()
        text.extend(word[position:])
        guard.extend(word.protected[position:])
        return ShellWord("".join(text), tuple(guard), quote_start=word.quote_start)

    choices: list[dict[str, str]] = [{}]
    for name in used:
        choices = [
            {**choice, name: value} for choice in choices for value in bindings[name]
        ]
    return [[substitute(word, choice) for word in words] for choice in choices]


def segment_is_read_only_bound(
    words: list[str], bindings: dict[str, tuple[str, ...]]
) -> bool:
    variants = bound_variants(words, bindings)
    return variants is not None and all(
        segment_is_read_only(variant) for variant in variants
    )


def expansion_risk(word: str) -> str | None:
    """How an expansion in ``word`` may change it: None, quoted, or split.

    `quoted`: every unprotected character is a `$` (`"$x"`, `"$(cmd)"`), so
    the word stays one word, though its value is unknown. `split`: an unquoted
    expansion or glob may become several words, each of them an option.
    """

    if not has_dynamic_markers(word):
        return None
    if not isinstance(word, ShellWord):
        return "split"
    if all(guard or character == "$" for character, guard in zip(word, word.protected)):
        return "quoted"
    return "split"


# Parsers that judge options: an unknown word could be any of them, so these
# take no expansion at all.
NO_EXPANSION_COMMANDS = {"adb", "date", "env", "node", "nodejs"} | SHELL_INTERPRETERS
# After a literal `--` these read every operand as a file or pathspec.
OPERANDS_AFTER_DASHES = {"git", "rg", "sed", "sort"}
# Parsers that know which of their words can be options and judge expansions
# there themselves: `cd` writes nothing whatever its operand, `printf` takes
# an option only first, awk none after its program, xargs none after its
# command.
OWN_EXPANSION_RULES = {
    "awk", "cd", "for", "gawk", "mawk", "nawk", "printf", "read", "xargs",
}
# Mutators whose operand parsers pass over a word they do not know, so an
# expansion there could be the option that writes (`find /x $X`, X=-delete;
# `cp "$x" a b`, x=-t<elsewhere>). The others refuse an expanded file operand
# by themselves, and a reviewed runner judges its own expansions
# (`generic_mutation_paths`).
OPTION_BLIND_MUTATORS = {"cp", "find", "git", "install", "ln", "mv", "sed"}


def glob_keeps_its_prefix(word: str) -> bool:
    """A glob or brace pattern with no variable, after a literal first character.

    Each word it expands to begins with that character, and it is not `-`, so
    none is an option. Splitting comes only from `$` expansions, refused here.
    """

    if not isinstance(word, ShellWord) or not word:
        return False
    if any(
        character in "$`" and not guard for character, guard in zip(word, word.protected)
    ):
        return False
    first = word[0]
    return first != "-" and (word.protected[0] or first not in "$`*?[{}~")


def expansions_are_inert(name: str, args: list[str]) -> bool:
    """Whether no expansion in ``args`` can become an option of ``name``.

    A parser judges the words it sees: `X=--output=/elsewhere; git log $X`
    reads as `git log` with a revision, yet git writes the file. So an
    expansion is admitted only where it cannot start a new option: inside
    double quotes and after a literal first character (`"HEAD..$x"`), or after
    a literal `--` for commands that read every later word as an operand.
    """

    if name in NO_EXPANSION_COMMANDS:
        return not any(expansion_risk(word) for word in args)
    operands = False
    for word in args:
        if word == "--" and expansion_risk(word) is None and name in OPERANDS_AFTER_DASHES:
            operands = True
            continue
        risk = expansion_risk(word)
        if risk is None or operands:
            continue
        if risk == "split" and glob_keeps_its_prefix(word):
            # `codex/*`: every word it expands to starts `codex/`.
            continue
        if risk == "split":
            return False
        if not isinstance(word, ShellWord) or not word or (
            word[0] == "$" and not word.protected[0]
        ):
            return False
    return True


def command_positionals(
    args: list[str],
    *,
    value_options: set[str] | None = None,
    target_options: set[str] | None = None,
) -> tuple[list[str], str | None] | None:
    """Return positional arguments and an optional explicit target directory."""

    values = value_options or set()
    targets = target_options or set()
    positionals: list[str] = []
    target_directory: str | None = None
    index = 0
    options = True
    while index < len(args):
        item = args[index]
        if options and item == "--":
            options = False
            index += 1
            continue
        matching_target = next(
            (
                option
                for option in targets
                if item == option
                or item.startswith(f"{option}=")
                or (
                    option.startswith("-")
                    and not option.startswith("--")
                    and item.startswith(option)
                    and item != option
                )
            ),
            None,
        )
        if options and matching_target:
            if item == matching_target:
                if index + 1 >= len(args):
                    return None
                target_directory = args[index + 1]
                index += 2
            elif item.startswith(f"{matching_target}="):
                target_directory = shell_option_value(item)
                index += 1
            else:
                target_directory = shell_slice(item, len(matching_target))
                index += 1
            continue
        matching_value = next(
            (
                option
                for option in values
                if item == option
                or item.startswith(f"{option}=")
                or (
                    option.startswith("-")
                    and not option.startswith("--")
                    and item.startswith(option)
                    and item != option
                )
            ),
            None,
        )
        if options and matching_value:
            if item == matching_value:
                if index + 1 >= len(args):
                    return None
                index += 2
            else:
                index += 1
            continue
        if options and item.startswith("-"):
            index += 1
            continue
        positionals.append(item)
        index += 1
    return positionals, target_directory


def resolve_mutation_paths(raw_values: list[str], cwd: Path) -> list[Path] | None:
    targets: list[Path] = []
    for raw_value in raw_values:
        target = resolve_shell_path(raw_value, cwd)
        if target is None:
            return None
        targets.append(target)
    return targets


def bun_run_is_package_script(words: list[str], cwd: Path) -> bool:
    """Whether ``bun run`` names a script in the current package manifest."""

    if words[:2] != ["bun", "run"] or len(words) < 3:
        return False
    script = words[2]
    if (
        script == "-"
        or script.startswith(("-", "."))
        or "/" in script
        or "\\" in script
    ):
        # Bun also accepts source files, stdin, project binaries, and system
        # commands. Only an unambiguous package.json script gets the reviewed
        # generic-runner contract.
        return False
    manifest_path = cwd / "package.json"
    try:
        if manifest_path.is_symlink():
            return False
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    scripts = manifest.get("scripts") if isinstance(manifest, dict) else None
    return isinstance(scripts, dict) and isinstance(scripts.get(script), str)


def generic_mutation_paths(
    name: str,
    args: list[str],
    cwd: Path,
    *,
    read_namespaces: tuple[Path, ...] = (),
) -> list[Path] | None:
    """Conservatively resolve path-like operands for an unknown mutator.

    Every path-shaped operand counts as a destination, because argv semantics
    are command-specific and this parser cannot tell an input from an output.
    That is deliberately over-broad, and `read_namespaces` is the one exception:
    directories a PROVIDER has derived (never accepted from the event) and
    declared to hold no repository state, so an operand landing inside one is
    not read as a declared write.

    The exception is narrow in three ways worth keeping. It reaches only this
    unknown-mutator path, so `rm`, `cp`, `tee` and every other command with a
    real parser still confine such a path. It removes an operand from the
    destination list rather than adding an allowance, so it cannot widen any
    other check. And it applies after the dynamic-marker and attached-option
    refusals below, so an unexpandable operand still fails closed wherever it
    would have pointed.

    What it does NOT claim is that the command only reads there. Nothing on a
    command line can establish that; a scoped runner executes code whose writes
    this parser never sees, in a namespace or out of it. It claims only that the
    operand is not EVIDENCE of a write, which is all the operand check ever
    established for the paths it does confine.
    """

    destinations: list[str] = []
    turbo_run = (name == "turbo" and args[:1] == ["run"]) or (
        name == "pnpm" and args[:2] == ["turbo", "run"]
    )
    for item in args:
        if turbo_run and item.startswith("--filter="):
            # Turbo filters are graph selectors rather than filesystem paths.
            continue
        attached = "=" in item
        candidate = shell_option_value(item) if attached else item
        path_like = (
            candidate in {".", ".."}
            or candidate.startswith(("/", "./", "../", "~/"))
            or "/" in candidate
        )
        dynamic = has_dynamic_markers(candidate)
        if dynamic and (attached or path_like or not item.startswith("-")):
            return None
        if item.startswith("-") and not attached and path_like:
            # An attached short option such as curl -o/tmp/out or
            # tar -cf/tmp/out.tar embeds a destination whose option grammar is
            # command-specific. Never reinterpret the complete token as a safe
            # relative path under the worktree.
            return None
        if path_like:
            destinations.append(candidate)
    resolved = resolve_mutation_paths(destinations, cwd)
    if resolved is None or not read_namespaces:
        return resolved
    return [
        target
        for target in resolved
        if not any(is_inside(target, space) for space in read_namespaces)
    ]


def nested_shell_program(args: list[str]) -> str | None:
    """Return a shell interpreter's ``-c`` program, or fail closed."""

    for index, item in enumerate(args):
        if item == "--":
            return None
        if item == "-c" or re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", item):
            if index + 1 >= len(args):
                return None
            return args[index + 1]
        if not item.startswith(("-", "+")):
            # Executing a script delegates mutation semantics to file content
            # that is outside this command parser's proof boundary.
            return None
    return None


def has_inline_interpreter_program(name: str, args: list[str]) -> bool:
    """Whether a non-shell interpreter executes source from an option."""

    if re.fullmatch(r"python(?:\d+(?:\.\d+)*)?", name):
        # CPython accepts interpreter flags before ``-c`` in the same short
        # option word (for example ``-Ic``). ``-W`` and ``-X`` consume the
        # remainder as their own value, so a later c is not another option.
        index = 0
        while index < len(args):
            item = args[index]
            if item == "--" or not item.startswith("-"):
                return False
            if item in {"-W", "-X"}:
                if index + 1 >= len(args):
                    return False
                index += 2
                continue
            if item.startswith(("-W", "-X")) and len(item) > 2:
                index += 1
                continue
            if item.startswith("--"):
                index += 1
                continue
            for option in item[1:]:
                if option == "c":
                    return True
                if option in {"W", "X"}:
                    break
            index += 1
        return False

    short_options = NON_SHELL_INLINE_INTERPRETERS.get(name)
    if short_options is None:
        parsed_commands = {
            "adb",
            "chmod",
            "chown",
            "chgrp",
            "cp",
            "dd",
            "find",
            "git",
            "install",
            "ln",
            "sed",
            "tee",
            "truncate",
            *ALL_OPERAND_MUTATORS,
            *NAVIGATION_COMMANDS,
            *READ_ONLY_COMMANDS,
        }
        # An unrecognized executable may itself be an interpreter (for
        # example pwsh -Command). No option-name heuristic can prove opaque
        # program text safe, so only commands with an explicit parser or a
        # reviewed worktree-scoped contract reach generic operand analysis.
        return name not in parsed_commands | GENERIC_SCOPED_COMMANDS
    long_options = (
        {"--eval", "--print"} if name in {"bun", "node", "nodejs"} else set()
    )
    for item in args:
        if item == "--" or not item.startswith("-"):
            return False
        if item in long_options or any(
            item.startswith(f"{option}=") for option in long_options
        ):
            return True
        if item.startswith("--"):
            continue
        short_word = item[1:]
        if short_word and (
            short_word[0] in short_options or short_word[-1] in short_options
        ):
            return True
    return False


class TrustedEntry(Protocol):
    """One trusted command, as `config.TrustedCommand` carries it.

    Typed structurally so this module needs no import of the settings loader:
    `script` is a path relative to the repository root, `pattern` must match
    the whole command line.
    """

    script: str
    pattern: re.Pattern[str]


TRUSTED_LINE_UNSAFE = re.compile(r"[^A-Za-z0-9 ._/=:,@+%-]")


def trusted_request(
    command: str, cwd: Path, root: Path, trusted: Sequence[TrustedEntry] = ()
) -> bool:
    """Recognize a consumer's trusted script command, and nothing else.

    Every other python script stays unprovable: its writes cannot be read off
    its command line, so ``mutation_path_operands`` refuses it. A consumer may
    name scripts whose writes it reviewed instead, each with the exact command
    lines that run it (the settings' ``worktree.trustedCommands``). A reviewed
    worktree-management script is the intended case: one whose every write is
    one this guard already permits from the owning worktree as a plain ``git``
    or ``gh`` command, and which refuses the primary checkout and unmanaged
    worktrees itself. No entries: no script is trusted.

    A pattern should accept no quoting and no shell metacharacter, so word
    splitting of any string it accepts yields exactly its words: nothing then
    needs parsing to prove what runs.

    The match is exact so nothing else inherits it: the whole command matches
    one entry's pattern (no extra words, no path-qualified or versioned
    interpreter, no environment prefix unless the pattern spells one), run from
    the worktree root, with that entry's script a regular file of the
    worktree's own reached through no symlink. Callers must establish
    ownership first.

    The command may also open the line and be followed only by reviewed
    redirections and read-only segments, which change nothing:
    ``... begin --branch claude/x 2>&1 | tail -5; git log -1``.
    First, so no `cd` before it can move which script runs.
    """

    if not trusted:
        return False
    # A loose pattern (`.*`) must not trust a whole line that hides another
    # command: the whole-line match holds only for plain words.
    plain = TRUSTED_LINE_UNSAFE.search(command) is None
    opening: tuple[str, list[list[str]]] | None = None
    rest_is_inert: bool | None = None
    for entry in trusted:
        if not (plain and entry.pattern.fullmatch(command)):
            if opening is None:
                opening = trusted_opening(command)
            first, rest = opening
            if not first or not entry.pattern.fullmatch(first):
                continue
            if rest_is_inert is None:
                rest_is_inert = all(segment_is_read_only(words) for words in rest)
            if not rest_is_inert:
                continue
        resolved = root.resolve()
        script = resolved / entry.script
        if cwd.resolve() == resolved and script.is_file() and script.resolve() == script:
            return True
    return False


def trusted_opening(command: str) -> tuple[str, list[list[str]]]:
    """The first segment of ``command`` as plain words, and the segments after.

    The words are empty when the line does not parse or when any word of the
    first segment carries quoting: a pattern then has nothing to match.
    """

    segments = split_commands(command)
    if not segments:
        return "", []
    first, rest = segments[0], segments[1:]
    if not all(
        isinstance(word, ShellWord) and not any(word.protected) for word in first
    ):
        return "", []
    return " ".join(first), rest


def is_non_shell_interpreter(name: str) -> bool:
    """Whether an executable can run opaque source or script files directly."""

    return name in NON_SHELL_INLINE_INTERPRETERS or bool(
        re.fullmatch(r"python(?:\d+(?:\.\d+)*)?", name)
    )


def install_uses_directory_mode(args: list[str]) -> bool:
    """Recognize ``install -d`` without mistaking attached option values."""

    value_options = {"g", "m", "o", "S", "t", "Z"}
    for item in args:
        if item == "--":
            return False
        if item == "--directory":
            return True
        if item.startswith("--") or not item.startswith("-"):
            continue
        for option in item[1:]:
            if option == "d":
                return True
            if option in value_options:
                break
    return False


def install_long_options_are_unambiguous(args: list[str]) -> bool:
    """Reject GNU long-option abbreviations and unsupported long options."""

    flags = {
        "--backup",
        "--compare",
        "--context",
        "--directory",
        "--help",
        "--no-target-directory",
        "--preserve-context",
        "--preserve-timestamps",
        "--strip",
        "--verbose",
        "--version",
    }
    values = {
        "--group",
        "--mode",
        "--owner",
        "--strip-program",
        "--suffix",
        "--target-directory",
    }
    index = 0
    while index < len(args):
        item = args[index]
        if item == "--":
            return True
        if not item.startswith("--"):
            index += 1
            continue
        option, separator, value = item.partition("=")
        if option in flags:
            if separator and (
                option not in {"--backup", "--context"} or not value
            ):
                return False
            index += 1
            continue
        if option not in values:
            return False
        if separator:
            if not value:
                return False
            index += 1
            continue
        if index + 1 >= len(args):
            return False
        index += 2
    return True


def sed_mutation_paths(args: list[str], cwd: Path) -> list[Path] | None:
    """Resolve input files for an in-place sed invocation."""

    positionals: list[str] = []
    program_from_option = False
    empty_suffix = False
    index = 0
    options = True
    while index < len(args):
        item = args[index]
        if options and item == "--":
            options = False
            index += 1
            continue
        if options and item in {"-e", "--expression", "-f", "--file"}:
            if index + 1 >= len(args):
                return None
            program_from_option = True
            index += 2
            continue
        if options and any(
            item.startswith(prefix)
            for prefix in ("-e", "-f", "--expression=", "--file=")
        ):
            program_from_option = True
            index += 1
            continue
        if (
            options
            and item == "-i"
            and index + 1 < len(args)
            and args[index + 1] == ""
        ):
            empty_suffix = True
            index += 2
            continue
        if options and item.startswith("-"):
            index += 1
            continue
        positionals.append(item)
        index += 1
    # BSD sed reads `-i ''` as an empty suffix and the next positional as the
    # program; GNU sed reads `''` as the program and every positional as a
    # file. Which sed runs is unknown, so both readings' files are resolved.
    files = (
        positionals
        if program_from_option or empty_suffix
        else positionals[1:]
    )
    resolved = resolve_mutation_paths(files, cwd)
    if resolved and empty_suffix and not program_from_option:
        # The first positional is BSD's program and only GNU's file. sed -i
        # rewrites files it could open and creates none, so as a file it can
        # only be written if it exists: `sed -i '' '/^import/d' f` edits f
        # alone unless a file /^import/d exists.
        program = resolved[0]
        if not os.path.lexists(program):
            resolved = resolved[1:]
    return resolved


def find_mutation_paths(args: list[str], cwd: Path) -> list[Path] | None:
    """Resolve paths changed by supported mutating ``find`` actions."""

    index = 0
    while index < len(args) and args[index] in {"-H", "-L", "-P"}:
        index += 1
    if index < len(args) and args[index] == "-D":
        if index + 1 >= len(args):
            return None
        index += 2
    if index < len(args) and re.fullmatch(r"-O\d+", args[index]):
        index += 1
    if index < len(args) and args[index] == "--":
        index += 1
    elif index < len(args) and args[index].startswith("-"):
        # An unknown leading option makes the path/expression boundary
        # ambiguous. A mutating invocation must therefore fail closed.
        return None

    roots: list[str] = []
    while index < len(args):
        item = args[index]
        if item in {"!", "(", ")", ","} or item.startswith("-"):
            break
        roots.append(item)
        index += 1

    expression = args[index:]
    if any(
        action in expression
        for action in {"-exec", "-execdir", "-ok", "-okdir"}
    ):
        # The nested command can compute an arbitrary destination.
        return None

    destinations: list[str] = []
    if "-delete" in expression:
        destinations.extend(roots or ["."])

    output_action_values = {
        "-fls": 1,
        "-fprint": 1,
        "-fprint0": 1,
        "-fprintf": 2,
    }
    expression_index = 0
    while expression_index < len(expression):
        action = expression[expression_index]
        value_count = output_action_values.get(action)
        if value_count is None:
            expression_index += 1
            continue
        if expression_index + value_count >= len(expression):
            return None
        destinations.append(expression[expression_index + 1])
        expression_index += value_count + 1

    return resolve_mutation_paths(destinations, cwd)


def truncate_mutation_paths(args: list[str], cwd: Path) -> list[Path] | None:
    """Resolve files truncated by a supported GNU ``truncate`` invocation."""

    positionals: list[str] = []
    index = 0
    options = True
    while index < len(args):
        item = args[index]
        if options and item == "--":
            options = False
            index += 1
            continue
        if options and item in {"-r", "--reference", "-s", "--size"}:
            if index + 1 >= len(args):
                return None
            index += 2
            continue
        if options and (
            re.fullmatch(r"-[rs].+", item)
            or item.startswith("--reference=")
            or item.startswith("--size=")
        ):
            index += 1
            continue
        if options and (
            item in {"--help", "--io-blocks", "--no-create", "--version"}
            or re.fullmatch(r"-[co]+", item)
        ):
            index += 1
            continue
        if options and item.startswith("-"):
            return None
        positionals.append(item)
        index += 1
    return resolve_mutation_paths(positionals, cwd)


def tee_mutation_paths(args: list[str], cwd: Path) -> list[Path] | None:
    """Resolve output files for a supported GNU ``tee`` invocation."""

    positionals: list[str] = []
    options = True
    for item in args:
        if options and item == "--":
            options = False
            continue
        if options and (
            item in {
                "--append",
                "--help",
                "--ignore-interrupts",
                "--output-error",
                "--version",
            }
            or item.startswith("--output-error=")
            or re.fullmatch(r"-[aip]+", item)
        ):
            continue
        if options and item.startswith("-"):
            return None
        if item == os.devnull and expansion_risk(item) is None:
            # Writing /dev/null changes no file.
            continue
        positionals.append(item)
    return resolve_mutation_paths(positionals, cwd)


def dd_mutation_paths(args: list[str], cwd: Path) -> list[Path] | None:
    """Resolve the output file for a supported GNU ``dd`` invocation."""

    operands = {
        "bs",
        "cbs",
        "conv",
        "count",
        "ibs",
        "if",
        "iflag",
        "obs",
        "of",
        "oflag",
        "oseek",
        "seek",
        "skip",
        "status",
    }
    destinations: list[str] = []
    for item in args:
        if item in {"--help", "--version"}:
            continue
        if "=" not in item:
            return None
        name, value = item.split("=", 1)[0], shell_option_value(item)
        if name not in operands:
            return None
        if name == "of":
            destinations.append(value)
    return resolve_mutation_paths(destinations, cwd)


def git_worktree_mutation_paths(
    words: list[str], command_index: int, cwd: Path
) -> list[Path] | None:
    args = words[command_index + 1 :]
    if not args:
        return []
    action = args[0]
    parsed = command_positionals(
        args[1:],
        value_options={"-b", "-B", "--reason"},
    )
    if parsed is None:
        return None
    positionals, _target_directory = parsed
    if action == "add":
        path_values = positionals[:1]
    elif action == "move":
        path_values = positionals[:2]
    elif action in {"lock", "remove", "unlock"}:
        path_values = positionals[:1]
    elif action == "repair":
        path_values = positionals
    else:
        return []
    return resolve_mutation_paths(path_values, cwd)


def metadata_mutation_paths(
    name: str, args: list[str], cwd: Path
) -> list[Path] | None:
    """Resolve files changed by chmod, chown, and chgrp."""

    short_flags = {
        "chmod": set("RfcvHLP"),
        "chown": set("RcfhvnHLPx"),
        "chgrp": set("RcfhvnHLPx"),
    }[name]
    long_flags = {
        "--changes",
        "--dereference",
        "--help",
        "--no-dereference",
        "--no-preserve-root",
        "--preserve-root",
        "--quiet",
        "--recursive",
        "--silent",
        "--verbose",
        "--version",
    }
    value_options = {"--reference"}
    if name == "chown":
        value_options.add("--from")

    positionals: list[str] = []
    reference_mode = False
    index = 0
    options = True
    chmod_mode = re.compile(
        r"[ugoa]*[-+=][rwxXstugo]*(?:,[ugoa]*[-+=][rwxXstugo]*)*"
    )
    while index < len(args):
        item = args[index]
        if options and item == "--":
            options = False
            index += 1
            continue
        if options and name == "chmod" and chmod_mode.fullmatch(item):
            positionals.append(item)
            options = False
            index += 1
            continue
        matching_value = next(
            (
                option
                for option in value_options
                if item == option or item.startswith(f"{option}=")
            ),
            None,
        )
        if options and matching_value:
            reference_mode = reference_mode or matching_value == "--reference"
            if item == matching_value:
                if index + 1 >= len(args):
                    return None
                index += 2
            else:
                index += 1
            continue
        if options and item in long_flags:
            index += 1
            continue
        if options and item.startswith("--"):
            return None
        if options and item.startswith("-"):
            if len(item) == 1 or not set(item[1:]).issubset(short_flags):
                return None
            index += 1
            continue
        positionals.append(item)
        index += 1

    path_values = positionals if reference_mode else positionals[1:]
    return resolve_mutation_paths(path_values, cwd)


def mutation_path_operands(
    words: list[str],
    cwd: Path,
    *,
    lookup_modified: bool = False,
    read_namespaces: tuple[Path, ...] = (),
) -> list[Path] | None:
    """Resolve filesystem operands mutated by a simple command."""

    name = os.path.basename(words[0])
    if name in GENERIC_SCOPED_COMMANDS | READ_ONLY_COMMANDS and words[0] != name:
        # A path-qualified executable can be a repository-controlled shim, so
        # its behavior cannot inherit the reviewed command's basename contract.
        return None
    if is_non_shell_interpreter(name) and not (
        not lookup_modified and bun_run_is_package_script(words, cwd)
    ):
        # Script files and interpreter options execute code whose mutation
        # targets cannot be proven from command operands. Keep the contract
        # fail-closed for both inline programs and file-backed programs. Bun's
        # reviewed package-script form instead uses the generic runner contract;
        # a consumer's trusted commands are matched before this parser runs,
        # by `trusted_request`.
        return None
    if has_inline_interpreter_program(name, words[1:]):
        return None
    if name == "printf" and not printf_is_read_only(words[1:]):
        # `printf -v PATH ...` steers every later lookup.
        return None
    if name in READ_ONLY_COMMANDS:
        # Shell redirections are parsed separately. These commands do not
        # mutate their path-like operands, so external inputs remain readable.
        return []
    if name in NAVIGATION_COMMANDS:
        # Navigation semantics are handled by mutation_directories before this
        # operand-only fallback is reached.
        return []
    if name == "git":
        command_index, git_cwd = git_command(words, cwd)
        if command_index is None or git_cwd is None or command_index >= len(words):
            return None
        if words[command_index] == "worktree":
            return git_worktree_mutation_paths(words, command_index, git_cwd)
        if words[command_index] in READ_GIT:
            outputs = git_inspection_outputs(words, command_index)
            return (
                resolve_mutation_paths(outputs, git_cwd)
                if outputs is not None else None
            )
        return []
    if name == "sed":
        return sed_mutation_paths(words[1:], cwd)
    if name == "adb":
        return adb_mutation_paths(words[1:], cwd)
    if name == "find":
        return find_mutation_paths(words[1:], cwd)
    if name == "truncate":
        return truncate_mutation_paths(words[1:], cwd)
    if name == "tee":
        return tee_mutation_paths(words[1:], cwd)
    if name == "dd":
        return dd_mutation_paths(words[1:], cwd)
    if name in {"chmod", "chown", "chgrp"}:
        return metadata_mutation_paths(name, words[1:], cwd)
    if name in {"cp", "install", "ln"}:
        if name == "install" and not install_long_options_are_unambiguous(
            words[1:]
        ):
            return None
        value_options = {
            "cp": {"-S", "--suffix"},
            "install": {
                "-g",
                "-m",
                "-o",
                "-S",
                "--group",
                "--mode",
                "--owner",
                "--strip-program",
                "--suffix",
            },
            "ln": {"-S", "--suffix"},
        }[name]
        parsed = command_positionals(
            words[1:],
            value_options=value_options,
            target_options={"-t", "--target-directory"},
        )
        if parsed is None:
            return None
        positionals, target_directory = parsed
        directory_mode = name == "install" and install_uses_directory_mode(words[1:])
        if target_directory is not None:
            destinations = [target_directory]
        elif directory_mode:
            destinations = positionals
        elif len(positionals) >= 2:
            destinations = positionals[-1:]
        else:
            destinations = []
        return resolve_mutation_paths(destinations, cwd)
    if name in ALL_OPERAND_MUTATORS:
        value_options = {
            "mkdir": {"-m", "--mode"},
            "mkfifo": {"-m", "--mode"},
            "mv": {"-S", "--suffix"},
            "touch": {
                "-d",
                "-r",
                "-t",
                "--date",
                "--reference",
                "--time",
            },
        }.get(name, set())
        target_options = (
            {"-t", "--target-directory"}
            if name == "mv"
            else set()
        )
        parsed = command_positionals(
            words[1:],
            value_options=value_options,
            target_options=target_options,
        )
        if parsed is None:
            return None
        positionals, target_directory = parsed
        path_values = positionals + (
            [target_directory] if target_directory is not None else []
        )
        return resolve_mutation_paths(path_values, cwd)
    return generic_mutation_paths(
        name, words[1:], cwd, read_namespaces=read_namespaces
    )


def mutation_directories(
    command: str,
    cwd: Path,
    *,
    nested_depth: int = 0,
    read_namespaces: tuple[Path, ...] = (),
) -> list[Path] | None:
    """Resolve the directory in which each mutating segment would run."""

    if nested_depth > 8:
        return None
    tokens = tokenize_command(command)
    if tokens is None:
        return None
    # The simple directory model below follows successful sequential `cd`
    # operations. Directory changes in failure branches or subshells require a
    # control-flow graph, so actual navigation commands in those forms fail
    # closed. Ordinary arguments named cd or -C remain valid.
    complex_control = any(
        is_shell_operator(token) and token in {"||", "(", ")"}
        for token in tokens
    )
    segments = split_commands(command)
    if segments is None:
        return None
    # A loop body runs once per iteration while this model applies each `cd`
    # once, so `for n in a b; do cd ..; done` would be read one level short:
    # loops navigate under the same fail-closed rule.
    complex_control = complex_control or any(
        isinstance(words[0], ShellWord)
        and words[0].quote_start is None
        and words[0] in {"for", "while", "until"}
        for words in segments
    )
    current = cwd.resolve()
    mutations: list[Path] = []
    persistent_lookup_modified = False
    sets_variable = False
    bindings: dict[str, tuple[str, ...]] = {}
    for raw_words in segments:
        parsed = effective_segment(raw_words)
        if parsed is None:
            return None
        words, wrapped, lookup_modified = parsed
        prefix = raw_words[: len(raw_words) - len(words)]
        read_only = segment_is_read_only_bound(words, bindings) if words else True
        update_bindings(without_control_words(raw_words) or [], bindings)
        if not words:
            persistent_lookup_modified = (
                persistent_lookup_modified or lookup_modified
            )
            state = adb_state_paths(prefix, current)
            if state is None:
                return None
            mutations.extend(state)
            continue
        lookup_modified = lookup_modified or persistent_lookup_modified
        name = os.path.basename(words[0])
        if words[0] != name:
            # The basename may match a parser below while the actual executable
            # is a repository-controlled shim with unrelated behavior.
            return None
        if lookup_modified:
            # A PATH-affecting wrapper or prior assignment-only segment can
            # resolve any reviewed basename to repository-controlled code.
            # Fail closed before applying command-specific semantics.
            return None
        if name in {"pushd", "popd"}:
            return None
        if name in {"for", "read"} and read_only:
            # The variable it sets may be exported in the Bash tool's shell,
            # which this hook's environment does not show, and so reach every
            # later child: reads still pass, any later write fails closed.
            sets_variable = True
        elif sets_variable and not read_only:
            return None
        if (
            not wrapped
            and name != "git"
            and not read_only
            and contains_nested_git_c(words)
        ):
            return None
        # Only `cd` moves `current`, and it fails closed here, so a `git -C`
        # under these forms resolves against the same directory as the plain
        # command and is judged like it: `git -C <own worktree>
        # commit --amend || true` passes, `-C <main checkout>` is still refused
        # as a mutation outside the worktree. No accepted wrapper changes
        # directory (`env -C` and `env -S` already fail closed).
        if complex_control and name == "cd":
            return None
        if wrapped and name == "cd":
            return None
        if name == "cd":
            if len(words) == 2 and words[1] != "--":
                raw_value = words[1]
            elif len(words) == 3 and words[1] == "--":
                raw_value = words[2]
            else:
                return None
            resolved = resolve_shell_path(raw_value, current)
            if resolved is None:
                return None
            current = resolved
            continue
        if name in SHELL_INTERPRETERS and read_only:
            # A shell under `-n`, or asked only for its version, runs no
            # command and so contributes no mutation. This has to be tested
            # BEFORE the nested-program branch below, which fails closed on any
            # shell that is not running a `-c` program. Without it a read-only
            # shell segment poisons every command it appears in: `rm -f x &&
            # bash -n y` was refused outright, even though each half is allowed
            # on its own, because `shell_is_read_only` needs EVERY segment to
            # be read-only and the whole command therefore arrives here.
            continue
        if name in SHELL_INTERPRETERS:
            program = nested_shell_program(words[1:])
            if program is None or has_dynamic_markers(program):
                return None
            nested = mutation_directories(
                program,
                current,
                nested_depth=nested_depth + 1,
                read_namespaces=read_namespaces,
            )
            if nested is None:
                return None
            mutations.extend(nested)
            continue
        target = current
        if name == "git":
            _index, git_target = git_command(words, current)
            if _index is None or git_target is None:
                return None
            target = git_target
            if not read_only and any(
                option in {"-c", "--config-env", "--git-dir", "--work-tree"}
                or option.startswith(
                    ("--config-env=", "--git-dir=", "--work-tree=")
                )
                for option in words[1:_index]
            ):
                return None
        # A read-only adb stays read-only only bare: an assignment can move
        # the server it may start (ANDROID_USER_HOME, TMPDIR) into a checkout,
        # so the command needs an owned worktree and the moved state directory
        # is confined like any other destination.
        if not read_only or (wrapped and name == "adb"):
            if has_dynamic_markers(words[0]) or (
                name in OPTION_BLIND_MUTATORS
                and not expansions_are_inert(name, words[1:])
            ):
                # An expansion that may become an option makes the operands
                # unknown: `git log $X` with X=--output=<elsewhere> writes
                # there.
                return None
            if name == "adb":
                state = adb_state_paths(prefix, current)
                if state is None:
                    return None
                mutations.extend(state)
            mutations.append(target)
            operand_targets = mutation_path_operands(
                words, current if name == "git" else target,
                lookup_modified=lookup_modified,
                read_namespaces=read_namespaces,
            )
            if operand_targets is None:
                return None
            mutations.extend(operand_targets)
    return mutations


def tool_command(values: dict[str, object]) -> str:
    for key in ("command", "cmd", "input", "patch"):
        value = values.get(key)
        if isinstance(value, str):
            return value
    return ""


def read_input() -> dict[str, object]:
    try:
        value = json.load(sys.stdin)
    # ValueError covers undecodable bytes as well as bad JSON, and deep nesting
    # raises RecursionError: either escaping here exited 1, which hosts read as
    # "run the tool anyway".
    except (ValueError, TypeError, RecursionError, OSError):
        deny("invalid hook payload; refusing to run without isolation context")
    if not isinstance(value, dict):
        deny("invalid hook payload; expected a JSON object")
    for key, kind in (("cwd", str), ("tool_name", str), ("tool_input", dict)):
        field = value.get(key)
        if field is not None and not isinstance(field, kind):
            deny(f"invalid hook payload; {key} is not a {kind.__name__}")
    return value
