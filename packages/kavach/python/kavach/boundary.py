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
from pathlib import Path, PurePath
from typing import Mapping, Protocol, Sequence


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
    # macOS's Perl shasum: its GetOptions lists no option that writes, and it
    # opens its operands and a --check list read-only (read 2026-11-16).
    "shasum",
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
# The other mutators with a parser of their own here (`mutation_path_operands`).
PARSED_MUTATORS = {
    "adb", "chgrp", "chmod", "chown", "cp", "dd", "find", "git", "install",
    "ln", "sed", "tee", "truncate",
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


def shell_suffixed(word: str, suffix: str) -> str:
    """``word`` with literal ``suffix`` text after it, its quoting kept."""
    if isinstance(word, ShellWord):
        return ShellWord(word + suffix, (*word.protected, *(True,) * len(suffix)))
    return word + suffix


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
    if verb in GIT_LISTING_OPTIONS:
        return git_globals_are_inert(words, index) and git_options_are_listed(
            args, *GIT_LISTING_OPTIONS[verb]
        )
    return (
        verb == "worktree"
        and bool(args)
        and args[0] == "list"
    )


def git_globals_are_inert(words: list[str], command_index: int) -> bool:
    """Only `-C` and the reviewed display switches come before the subcommand."""

    index = 1
    while index < command_index:
        option = words[index]
        if option == "-C":
            index += 2
        elif option in {"--no-pager", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"}:
            index += 1
        else:
            return False
    return True


# Git subcommands that list or search what a repository holds, and write
# nothing: (short flags, short options taking a value, long flags, long
# options taking a value, long options whose value is optional). Exact names
# only, since git takes an abbreviation of a long option (`--open` for
# --open-files-in-pager). Left out on purpose: `grep -O` and
# `--open-files-in-pager`, which run a program on the matches, and
# `--textconv` and `--filters`, which run the repository's configured
# drivers. `-c` alone is refused before these tables, as git's `-c <config>`.
GIT_LISTING_OPTIONS: dict[str, tuple[str, str, frozenset[str], frozenset[str], frozenset[str]]] = {
    "grep": (
        "aiIvwrhHnlLzcopWFEGPq",
        "efABCm",
        frozenset({
            "--cached", "--no-index", "--index", "--recursive", "--no-recursive",
            "--untracked", "--exclude-standard",
            "--no-exclude-standard", "--recurse-submodules", "--text",
            "--no-textconv", "--ignore-case", "--word-regexp", "--invert-match",
            "--full-name", "--extended-regexp", "--basic-regexp", "--fixed-strings",
            "--perl-regexp", "--line-number", "--column", "--files-with-matches",
            "--name-only", "--files-without-match", "--null", "--only-matching",
            "--count", "--no-color", "--break", "--heading", "--show-function",
            "--function-context", "--and", "--or", "--not", "--all-match", "--quiet",
        }),
        frozenset({
            "--max-depth", "--threads", "--context", "--after-context",
            "--before-context", "--max-count",
        }),
        frozenset({"--color"}),
    ),
    "ls-tree": (
        "drtlz",
        "",
        frozenset({
            "--long", "--name-only", "--name-status", "--object-only",
            "--full-name", "--full-tree",
        }),
        frozenset({"--format"}),
        frozenset({"--abbrev"}),
    ),
    "cat-file": (
        "tsepZ",
        "",
        frozenset({
            "--batch-all-objects", "--buffer", "--follow-symlinks", "--unordered",
            "--allow-unknown-type", "--mailmap", "--no-mailmap", "--use-mailmap",
            "--no-use-mailmap",
        }),
        frozenset(),
        frozenset({"--batch", "--batch-check", "--batch-command"}),
    ),
}


def git_options_are_listed(
    args: list[str],
    short: str,
    short_values: str,
    long: frozenset[str],
    long_values: frozenset[str],
    long_optional: frozenset[str],
) -> bool:
    """Every option before `--` is one of the subcommand's listed ones.

    A short cluster (`-niE`) may end in one option that takes a value,
    attached or as the next word; a bare number (`-3`) is grep's context.
    Words that are not options (patterns, revisions, paths) read nothing but
    the repository. Unknown options fail closed.
    """

    index = 0
    while index < len(args):
        word = args[index]
        index += 1
        if word == "--":
            return True
        if word.startswith("--"):
            name, equals, _value = word.partition("=")
            if name in long and not equals or name in long_optional:
                continue
            if name in long_values:
                if not equals:
                    if index >= len(args):
                        return False
                    index += 1
                continue
            return False
        if not word.startswith("-") or word == "-":
            continue
        letters = word[1:]
        if letters.isdigit() and "C" in short_values:
            continue
        for position, letter in enumerate(letters):
            if letter in short_values:
                if position == len(letters) - 1:
                    if index >= len(args):
                        return False
                    index += 1
                break
            if letter not in short:
                return False
    return True


def git_inspection_outputs(words: list[str], command_index: int) -> list[str] | None:
    """Classify reviewed inspection flags and collect every explicit output.

    Unknown options fail closed, including Git's abbreviated long options.
    A pathspec after -- is data, even when it looks like an unsafe option.
    """
    if not git_globals_are_inert(words, command_index):
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


def git_output_options(words: list[str], command_index: int) -> list[str] | None:
    """Collect every ``--output`` a git subcommand outside READ_GIT names.

    diff-files, diff-index, range-diff, shortlog, whatchanged, format-patch,
    stash show and others take Git's diff option ``--output=<file>``. Their
    other options are not reviewed here, so this reads only that one: a
    missing or option-like value and any abbreviation (``--outp``) fail
    closed. A pathspec after -- is data.
    """
    outputs: list[str] = []
    index = command_index + 1
    while index < len(words):
        option = words[index]
        if option == "--":
            break
        name, has_value, value = option.partition("=")
        if name == "--output":
            if not has_value:
                index += 1
                if index >= len(words):
                    return None
                value = words[index]
            else:
                value = shell_option_value(option)
            if not value or value.startswith("-"):
                return None
            outputs.append(value)
        elif len(name) > 2 and "--output".startswith(name):
            return None
        index += 1
    return outputs


def git_destination_operands(words: list[str], command_index: int) -> list[str] | None:
    """Collect what format-patch, archive, bundle, clone and init write.

    Each names its destination its own way, so each is read exactly: ``-o``
    means other things on other verbs (``git grep -o``, ``git push -o``).
    Anything the reader cannot place fails closed. ``--output`` itself is
    read by ``git_output_options``.
    """
    verb = words[command_index]
    args = words[command_index + 1 :]
    if verb == "format-patch":
        return git_dash_o_outputs(args, ("--output-directory", "--output"))
    if verb == "archive":
        return git_dash_o_outputs(args, ())
    if verb == "bundle":
        return git_bundle_outputs(args)
    if verb == "clone":
        return git_repository_destinations(args, GIT_CLONE_OPTIONS, max_operands=2)
    if verb == "init":
        return git_repository_destinations(args, GIT_INIT_OPTIONS, max_operands=1)
    if verb in {"bugreport", "diagnose"}:
        # `-o`/`--output-directory`; git 2.54 writes `--suffix -- -o <dir>`
        # and `--suffix -- --outp <dir>`.
        return git_dash_o_outputs(
            args, ("--output-directory",), abbreviated="--output-directory"
        )
    if verb == "index-pack":
        return git_index_pack_outputs(args)
    if verb == "config":
        return git_config_file_outputs(args)
    if verb == "merge-file":
        return git_merge_file_outputs(args)
    if verb == "fast-import":
        return git_fast_import_outputs(args)
    if verb == "credential-store":
        return git_credential_store_outputs(args)
    return []


def git_long_option(name: str, options: frozenset[str]) -> str | None:
    """The one option of ``options`` that ``name`` spells or abbreviates,
    as parse-options takes it; an unknown or ambiguous name is None."""
    if name in options:
        return name
    matches = [option for option in options if option.startswith(name)]
    return matches[0] if len(name) > len("--") and len(matches) == 1 else None


# `git merge-file` options, from git 2.54's `git merge-file -h`.
GIT_MERGE_FILE_FLAGS = frozenset({
    "--stdout", "--object-id", "--diff3", "--zdiff3", "--ours", "--theirs",
    "--union", "--quiet",
})
GIT_MERGE_FILE_VALUES = frozenset({"--diff-algorithm", "--marker-size"})


def git_merge_file_outputs(args: list[str]) -> list[str] | None:
    """``git merge-file <current> <base> <other>`` writes ``<current>``,
    resolved from the folder git runs in, unless ``-p``/``--stdout``
    prints it or ``--object-id`` names objects. Git permutes options, and
    ``-L`` takes the next word, ``--`` too (git 2.54 writes
    ``merge-file -L -- <current> base other``). An option the reader does
    not know, or other than three operands, fails closed."""
    operands: list[str] = []
    prints = False
    index = 0
    while index < len(args):
        word = args[index]
        index += 1
        if word == "--":
            operands.extend(args[index:])
            break
        if word.startswith("--"):
            name, has_value, _ = word.partition("=")
            option = git_long_option(name, GIT_MERGE_FILE_FLAGS | GIT_MERGE_FILE_VALUES)
            if option is None:
                return None
            if option in GIT_MERGE_FILE_VALUES:
                if not has_value:
                    if index >= len(args):
                        return None
                    index += 1
            elif has_value:
                return None
            prints = prints or option in {"--stdout", "--object-id"}
        elif word.startswith("-") and word != "-":
            letters = word[1:]
            for position, letter in enumerate(letters):
                if letter == "L":
                    if position + 1 == len(letters):
                        if index >= len(args):
                            return None
                        index += 1
                    break
                if letter == "p":
                    prints = True
                elif letter != "q":
                    return None
        else:
            operands.append(word)
    if len(operands) != 3:
        return None
    return [] if prints else operands[:1]


def git_fast_import_outputs(args: list[str]) -> list[str] | None:
    """The marks and pack-edges files ``git fast-import`` writes.

    fast-import reads its own arguments: exact names, values only with
    ``=``, resolved from the folder git runs in. ``--allow-unsafe-features``
    lets the stream itself name files to write (``feature export-marks=``),
    and ``--relative-marks`` moves them into the repository's own folder,
    so both fail closed, as does ``--export-marks`` without ``=``."""
    outputs: list[str] = []
    for word in args:
        name, has_value, _ = word.partition("=")
        if name in {"--export-marks", "--export-pack-edges"}:
            if not has_value:
                return None
            value = shell_option_value(word)
            if not value or value.startswith("-"):
                return None
            outputs.append(value)
        elif name in {"--allow-unsafe-features", "--relative-marks"}:
            return None
    return outputs


def git_credential_store_outputs(args: list[str]) -> list[str] | None:
    """The file ``git credential-store --file <f> store`` writes, with any
    abbreviation of ``--file``. Without one, ``store`` and ``erase`` write
    ``~/.git-credentials``, outside any worktree: unproven."""
    files: list[str] = []
    index = 0
    while index < len(args):
        word = args[index]
        index += 1
        name, has_value, _ = word.partition("=")
        if len(name) > len("--") and "--file".startswith(name):
            if has_value:
                value = shell_option_value(word)
            elif index < len(args):
                value = args[index]
                index += 1
            else:
                return None
            if not value or value.startswith("-"):
                return None
            files.append(value)
    if not files and any(word in {"store", "erase"} for word in args):
        return None
    return files


def git_top_relative_outputs(verb: str, args: list[str]) -> list[str] | None:
    """What fast-export, pack-objects and read-tree write. Git resolves
    these from the top of the work tree, not from the folder it runs in:
    from `git -C sub`, `--export-marks=m` writes `<top>/m` (git 2.54).

    - ``fast-export --export-marks`` exactly, anywhere. Git 2.54 calls
      ``--export-m=`` ambiguous, so an abbreviation is unproven.
    - ``pack-objects <base>`` writes ``<base>-<hash>.pack`` and its
      ``.idx`` and ``.rev``. Every word that is not an option counts as a
      base, so a value an option takes counts too: that only refuses more.
    - ``read-tree --index-output`` and each abbreviation from ``--i`` on
      (git 2.54 takes ``--i=``), anywhere, past ``--`` too.
    """
    outputs: list[str] = []
    if verb == "pack-objects":
        dashes = False
        for word in args:
            if word == "--" and not dashes:
                dashes = True
            elif dashes or not word.startswith("-") or word == "-":
                outputs.append(shell_suffixed(word, "-pack"))
        return outputs
    option = "--export-marks" if verb == "fast-export" else "--index-output"
    shortest = len(option) if verb == "fast-export" else len("--i")
    index = 0
    while index < len(args):
        word = args[index]
        index += 1
        name, has_value, _ = word.partition("=")
        if not (name.startswith("--") and len(name) > len("--") and option.startswith(name)):
            continue
        if len(name) < shortest:
            return None
        if has_value:
            value = shell_option_value(word)
        elif index < len(args):
            value = args[index]
            index += 1
        else:
            return None
        if not value or value.startswith("-"):
            return None
        outputs.append(value)
    return outputs


# `git index-pack` reads its own arguments, not through parse-options: exact
# names, options anywhere, and only `-o` and `--progress-title` take the next
# word. Optional values come with `=`.
GIT_INDEX_PACK_FLAGS = frozenset({
    "-v", "--stdin", "--fix-thin", "--verify", "--verify-stat", "--verify-stat-only",
    "--rev-index", "--no-rev-index", "--check-self-contained-and-connected",
    "--report-end-of-input", "--keep", "--strict", "--fsck-objects", "--promisor",
})
GIT_INDEX_PACK_ATTACHED = frozenset({
    "--keep", "--strict", "--fsck-objects", "--promisor", "--threads", "--pack_header",
    "--index-version", "--max-input-size", "--object-format",
})


def git_index_pack_outputs(args: list[str]) -> list[str] | None:
    """The index ``-o`` names, and the pack file: git writes its ``.idx``,
    ``.rev`` and ``.keep`` beside it, and with ``--stdin`` the pack itself."""
    outputs: list[str] = []
    pack: list[str] = []
    index = 0
    while index < len(args):
        word = args[index]
        index += 1
        if word in {"-o", "--progress-title"}:
            if index >= len(args) or args[index].startswith("-"):
                return None
            if word == "-o":
                outputs.append(args[index])
            index += 1
        elif word in GIT_INDEX_PACK_FLAGS:
            continue
        elif word.startswith("-"):
            name, has_value, _ = word.partition("=")
            if not has_value or name not in GIT_INDEX_PACK_ATTACHED:
                return None
        elif pack:
            return None
        else:
            pack.append(word)
    return outputs + pack


# `git config` options, from git 2.54's `git config -h` (both the legacy
# form and the subcommands). Long options may be abbreviated, and one that
# takes a value can swallow the next word (`--comm --list` sets a comment),
# so where a file option is given, a word outside these sets fails closed.
GIT_CONFIG_VALUES = frozenset({
    "--file", "--blob", "--type", "--default", "--comment", "--value", "--url",
})
GIT_CONFIG_FLAGS = frozenset({
    "--local", "--worktree", "--replace-all", "--add", "--unset", "--unset-all",
    "--rename-section", "--remove-section", "--edit", "--no-type", "--bool", "--int",
    "--bool-or-int", "--bool-or-str", "--path", "--expiry-date", "--fixed-value",
    "--null", "--includes", "--no-includes", "--all", "--regexp", "--show-names",
    "--no-show-names", "--append", "--show-origin", "--show-scope", "--name-only",
})
GIT_CONFIG_READERS = frozenset({
    "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l",
    "--get-color", "--get-colorbool",
})
GIT_CONFIG_WRITERS = frozenset({
    "--add", "--replace-all", "--unset", "--unset-all", "--rename-section",
    "--remove-section", "--edit", "-e",
})
GIT_CONFIG_SUBCOMMANDS = frozenset({
    "get", "list", "set", "unset", "rename-section", "remove-section", "edit",
})


def git_config_file_outputs(args: list[str]) -> list[str] | None:
    """The file ``git config -f <file>`` writes; ``--global`` and
    ``--system`` write outside any worktree and fail closed.

    Without them git config writes the repository's own config, which the
    guard does not read here. A read writes nothing: ``get``, ``list``,
    ``--get``, ``--list``, or a lone key with no action
    (``git config --global user.name``). Anything else with a file option
    is a write, and an option the reader does not know fails closed.
    """
    files: list[str] = []
    elsewhere = False
    unplaced = False
    writes = False
    subcommand = bool(args) and args[0] in GIT_CONFIG_SUBCOMMANDS
    reads = subcommand and args[0] in {"get", "list"}
    positionals = 0
    index = 1 if subcommand else 0
    while index < len(args):
        word = args[index]
        index += 1
        if word == "--":
            positionals += len(args) - index
            break
        if not word.startswith("-") or word == "-":
            positionals += 1
        elif word in GIT_CONFIG_READERS:
            reads = True
        elif word in GIT_CONFIG_WRITERS:
            writes = True
        elif word.startswith("--"):
            name, has_value, _ = word.partition("=")
            if len(name) > len("--fi") and "--file".startswith(name):
                if has_value:
                    value = shell_option_value(word)
                elif index < len(args):
                    value = args[index]
                    index += 1
                else:
                    return None
                files.append(value)
            elif len(name) > len("--g") and "--global".startswith(name):
                elsewhere = True
            elif len(name) > len("--s") and "--system".startswith(name):
                elsewhere = True
            elif name in GIT_CONFIG_VALUES:
                if not has_value:
                    index += 1
            elif name not in GIT_CONFIG_FLAGS or has_value:
                unplaced = True
        else:
            letters = word[1:]
            for position, letter in enumerate(letters):
                if letter in "ft":
                    if position + 1 < len(letters):
                        value = shell_slice(word, position + 2)
                    elif index < len(args):
                        value = args[index]
                        index += 1
                    else:
                        return None
                    if letter == "f":
                        files.append(value)
                    break
                if letter == "l":
                    reads = True
                elif letter == "e":
                    writes = True
                elif letter != "z":
                    unplaced = True
    if unplaced:
        # An abbreviated value option swallows the next word: git 2.54
        # writes `git config --comm -- -f <file> core.x y`, where this read
        # stopped at the `--`. git_safety refuses these options too.
        return None
    if not files and not elsewhere:
        return []
    if not subcommand and positionals == 1 and not writes:
        reads = True
    if reads and not writes:
        return []
    if elsewhere or any(not value or value.startswith("-") for value in files):
        return None
    return files


def git_checkout_index_prefixes(args: list[str]) -> list[str] | None:
    """Every ``--prefix`` of ``git checkout-index``, or any abbreviation
    (``--pre=``) git takes; a missing value fails closed. Read past ``--``,
    as `git_dash_o_outputs` is: that only refuses more. A word after
    ``--stage`` is read too, for the same reason."""
    prefixes: list[str] = []
    index = 0
    while index < len(args):
        word = args[index]
        index += 1
        name, has_value, _ = word.partition("=")
        if len(name) > len("--") and "--prefix".startswith(name):
            if has_value:
                value = shell_option_value(word)
            elif index < len(args):
                value = args[index]
                index += 1
            else:
                return None
            prefixes.append(value)
    return prefixes


def git_dash_o_outputs(
    args: list[str], long_options: tuple[str, ...], *, abbreviated: str = ""
) -> list[str] | None:
    """``-o <v>``, ``-o<v>`` and each of ``long_options`` with ``=<v>`` or ``<v>``.

    Where ``abbreviated`` names the verb's only long option that starts
    with ``--o``, every prefix of it from ``--o`` on is read as that option:
    after a swallowed ``--``, git 2.54 writes
    ``bugreport --suffix -- --o=<dir>``, where `git_output_options` has
    stopped reading.

    Git permutes options, so every word is read, not only those before the
    first operand. A ``--`` does not end the read: an option that takes the
    next word takes ``--`` too, and git 2.54 then still writes
    ``format-patch -1 --subject-prefix -- -o <dir>``. Reading past it
    only refuses more. A short cluster that hides ``o`` (format-patch takes
    ``-ko <dir>``), a strict prefix of ``--output-directory`` longer than
    ``--output``, and a missing or option-like value fail closed.
    """
    outputs: list[str] = []
    index = 0
    while index < len(args):
        word = args[index]
        name, has_value, _ = word.partition("=")
        if (
            word == "-o"
            or name in long_options
            or (abbreviated and len(name) > len("--") and abbreviated.startswith(name))
        ):
            if has_value and word != "-o":
                value = shell_option_value(word)
            else:
                index += 1
                if index >= len(args):
                    return None
                value = args[index]
        elif word.startswith("-o"):
            value = shell_slice(word, 2)
        elif word.startswith("-") and not word.startswith("--") and "o" in word:
            return None
        elif (
            "--output-directory" in long_options
            and len(name) > len("--output")
            and "--output-directory".startswith(name)
        ):
            return None
        else:
            index += 1
            continue
        if not value or value.startswith("-"):
            return None
        outputs.append(value)
        index += 1
    return outputs


def git_bundle_outputs(args: list[str]) -> list[str] | None:
    """``git bundle create [options] <file> <rev-list args>``: the first word
    after create's own options is the file. Other bundle verbs read a bundle
    or write into the repository."""
    if not args or args[0] != "create":
        return []
    flags = {
        "-q", "--quiet", "--progress", "--no-progress", "--all-progress",
        "--all-progress-implied",
    }
    index = 1
    while index < len(args):
        word = args[index]
        if word in flags or word.startswith("--version="):
            index += 1
        elif word == "--version":
            index += 2
        elif word.startswith("-"):
            return None
        else:
            return [word]
    return None


# Options of `git clone` and `git init` the destination reader knows. Git
# takes abbreviations of long options here and lets options follow operands,
# so a word outside these tables fails closed: it could take the next word
# and shift which operand is the destination. `-c`/`--config`,
# `-u`/`--upload-pack` and `--template` are left out: they run or install
# programs. Optional values (`--shared`, `--recurse-submodules`) are taken
# only with `=`, as git does.
GitOptionTable = tuple[frozenset[str], frozenset[str], frozenset[str], frozenset[str]]
GIT_CLONE_OPTIONS: GitOptionTable = (
    frozenset("qvnls"),
    frozenset("obj"),
    frozenset({
        "--quiet", "--verbose", "--progress", "--no-progress", "--no-checkout",
        "--bare", "--mirror", "--local", "--no-local", "--no-hardlinks",
        "--shared", "--dissociate", "--single-branch", "--no-single-branch",
        "--no-tags", "--tags", "--shallow-submodules", "--no-shallow-submodules",
        "--remote-submodules", "--no-remote-submodules", "--sparse",
        "--also-filter-submodules", "--reject-shallow", "--no-reject-shallow",
        "--recurse-submodules", "--recursive", "--no-recurse-submodules",
    }),
    frozenset({
        "--origin", "--branch", "--revision", "--reference", "--reference-if-able",
        "--depth", "--shallow-since", "--shallow-exclude", "--jobs", "--filter",
        "--bundle-uri", "--server-option", "--ref-format", "--separate-git-dir",
    }),
)
GIT_INIT_OPTIONS: GitOptionTable = (
    frozenset("q"),
    frozenset("b"),
    frozenset({"--quiet", "--bare", "--shared"}),
    frozenset({
        "--initial-branch", "--object-format", "--ref-format", "--separate-git-dir",
    }),
)
GIT_OPTIONAL_VALUES = {"--shared", "--recurse-submodules", "--recursive"}


def git_repository_destinations(
    args: list[str], table: GitOptionTable, *, max_operands: int
) -> list[str] | None:
    """The directory `git clone <repo> [<dir>]` or `git init [<dir>]` makes,
    and its ``--separate-git-dir``.

    The directory is the last of ``max_operands`` operands. Without it git
    writes under the folder it runs in, which the guard already counts.
    clone's repository is read, never resolved: it may be a URL.
    """
    short_flags, short_values, long_flags, long_values = table
    outputs: list[str] = []
    operands: list[str] = []
    index = 0
    while index < len(args):
        word = args[index]
        index += 1
        if word == "--":
            operands.extend(args[index:])
            break
        if not word.startswith("-") or word == "-":
            operands.append(word)
            continue
        if word.startswith("--"):
            name, has_value, _ = word.partition("=")
            if name in long_flags:
                if has_value and name not in GIT_OPTIONAL_VALUES:
                    return None
                continue
            if name not in long_values:
                return None
            if has_value:
                value = shell_option_value(word)
            elif index < len(args):
                value = args[index]
                index += 1
            else:
                return None
            if not value or value.startswith("-"):
                return None
            if name == "--separate-git-dir":
                outputs.append(value)
            continue
        for position, letter in enumerate(word[1:], start=1):
            if letter in short_flags:
                continue
            if letter not in short_values:
                return None
            if position + 1 == len(word):
                if index >= len(args) or args[index].startswith("-"):
                    return None
                index += 1
            break
    if len(operands) > max_operands:
        return None
    if len(operands) == max_operands:
        outputs.append(operands[-1])
    return outputs


# Git's global options, before the subcommand, as git 2.54 reads them: exact
# names, no abbreviations (`--git-d=x` is refused). Those in
# GIT_GLOBAL_VALUES take the next word or `=<value>`; `--exec-path` and
# `--list-cmds` take a value only with `=`. Any other word fails closed: a
# global that takes the next word moves which word is the subcommand, and
# `git --namespace x init <dir>` once read `x` as the verb.
GIT_GLOBAL_FLAGS = frozenset({
    "-p", "--paginate", "-P", "--no-pager", "--no-replace-objects",
    "--no-lazy-fetch", "--no-optional-locks", "--no-advice", "--bare",
    "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs",
    "--icase-pathspecs", "--exec-path", "--html-path", "--man-path",
    "--info-path", "-v", "--version", "-h", "--help",
})
GIT_GLOBAL_VALUES = frozenset({
    "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--attr-source",
})
GIT_GLOBAL_ATTACHED = GIT_GLOBAL_VALUES - {"-c"} | {"--exec-path", "--list-cmds"}

# Verbs that run a command from a place the guard cannot read: filter-branch
# evals its filters in a temporary tree, difftool and mergetool run a tool
# (`-x <cmd>`, or the configured one) on temporary files. `submodule foreach`
# runs in each submodule and fails closed beside these.
GIT_UNPLACED_RUNNERS = frozenset({"filter-branch", "difftool", "mergetool"})

# Assignments before `git` that change where it writes or what it runs:
# every `GIT_*` name (GIT_DIR, GIT_INDEX_FILE, GIT_TRACE=<file>,
# GIT_CONFIG_COUNT, GIT_EXTERNAL_DIFF, ...), and the editors, pager and
# config homes git reads. All fail closed as unproven, as `--git-dir` does,
# except the names below, which name no file and run nothing, and the
# editors as the literal `true` or `:`.
GIT_STEERING_NAMES = frozenset({"EDITOR", "VISUAL", "PAGER", "HOME", "XDG_CONFIG_HOME"})
GIT_INERT_ASSIGNMENTS = frozenset({
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE",
    "GIT_TERMINAL_PROMPT",
})
GIT_EDITOR_NAMES = frozenset({"GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "EDITOR", "VISUAL"})


def git_prefix_is_inert(prefix: list[str]) -> bool:
    """Whether every assignment before a `git` command, bare or through
    `env`, leaves where git writes and what it runs as they are."""
    for word in prefix:
        assignment = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)=.*", word, re.DOTALL)
        if not assignment:
            continue
        name = assignment.group(1)
        if not name.startswith("GIT_") and name not in GIT_STEERING_NAMES:
            continue
        if name in GIT_INERT_ASSIGNMENTS:
            continue
        if name in GIT_EDITOR_NAMES and shell_option_value(word) in {"true", ":"}:
            continue
        return False
    return True


def git_runner_programs(words: list[str], command_index: int) -> list[str] | None:
    """The commands ``git rebase -x`` and ``git bisect run`` run, as shell
    programs; None where one cannot be placed.

    rebase runs each ``-x``/``--exec`` value through the shell. Every word is
    read, so a value option that swallows ``--`` (``-X -- -x <cmd>``, which
    git 2.54 runs) does not hide one: ``-x <cmd>``, ``-x<cmd>``, an ``x``
    in a short cluster (``-qx``), and ``--exec`` with any abbreviation from
    ``--e`` on, ``=`` or the next word. Reading a value as ``-x`` only
    judges more. bisect runs the words after ``run`` as they are, with no
    shell, so they are quoted back into one program.
    """
    verb = words[command_index]
    args = words[command_index + 1 :]
    if verb == "bisect":
        if not args or args[0] != "run":
            return []
        if len(args) < 2:
            return None
        return [shlex.join(args[1:])]
    if verb != "rebase":
        return []
    programs: list[str] = []
    index = 0
    while index < len(args):
        word = args[index]
        index += 1
        name, has_value, _ = word.partition("=")
        if name.startswith("--") and len(name) > len("--") and "--exec".startswith(name):
            if has_value:
                programs.append(shell_option_value(word))
                continue
        elif word.startswith("-") and not word.startswith("--") and "x" in word:
            position = word.index("x")
            if position + 1 < len(word):
                programs.append(shell_slice(word, position + 1))
                continue
        else:
            continue
        if index >= len(args):
            return None
        programs.append(args[index])
        index += 1
    return programs


def git_command(words: list[str], cwd: Path | None) -> tuple[int | None, Path | None]:
    """Return the subcommand index and cumulative ``git -C`` directory.

    A global option outside the tables above fails closed, as ``(None, None)``.
    """

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
        if option in GIT_GLOBAL_VALUES:
            if index + 1 >= len(words):
                return None, None
            index += 2
            continue
        if option in GIT_GLOBAL_FLAGS or option.partition("=")[0] in GIT_GLOBAL_ATTACHED:
            index += 1
            continue
        return None, None
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
    if name == "base64":
        return base64_is_read_only(words[1:])
    if name == "openssl":
        return openssl_is_read_only(words[1:])
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


def base64_is_read_only(args: list[str]) -> bool:
    """`base64`, or `base64 -d`, from stdin or one input file to stdout.

    macOS's base64 writes a file with `-o`/`--output` and takes no operand;
    GNU's takes one input file. Any other option is refused.
    """

    operands = [word for word in args if word not in {"-d", "-D", "--decode"}]
    return len(operands) <= 1 and not any(
        word.startswith("-") and word != "-" for word in operands
    )


# `openssl x509` options that only print what a certificate holds. Left out:
# `-out`, the signing and CA options, and `-engine`/`-provider*`, which load code.
OPENSSL_X509_FLAGS = frozenset({
    "-noout", "-text", "-subject", "-issuer", "-dates", "-startdate", "-enddate",
    "-serial", "-fingerprint", "-sha1", "-sha256", "-sha512", "-purpose",
    "-pubkey", "-modulus", "-hash", "-subject_hash", "-issuer_hash", "-email",
    "-ocsp_uri", "-ocspid", "-alias",
})
OPENSSL_X509_VALUES = frozenset({"-in", "-inform", "-nameopt", "-certopt", "-ext", "-checkend"})


def openssl_is_read_only(args: list[str]) -> bool:
    """`openssl x509` printing a certificate from stdin or `-in`."""

    if args[:1] != ["x509"]:
        return False
    index = 1
    while index < len(args):
        word = args[index]
        index += 1
        if word in OPENSSL_X509_FLAGS:
            continue
        if word in OPENSSL_X509_VALUES and index < len(args):
            index += 1
            continue
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


def option_words(args: list[str], value_options: set[str]) -> tuple[set[str], list[str]]:
    """The short option letters and the long option names before ``--``,
    skipping each value ``value_options`` takes (``-S .bak`` or ``-S.bak``)."""

    letters: set[str] = set()
    longs: list[str] = []
    index = 0
    while index < len(args):
        item = args[index]
        index += 1
        if item == "--":
            break
        if item.startswith("--"):
            option = item.split("=", 1)[0]
            longs.append(option)
            if option in value_options and "=" not in item:
                index += 1
        elif item.startswith("-") and len(item) > 1:
            for position, letter in enumerate(item[1:]):
                letters.add(letter)
                if f"-{letter}" in value_options:
                    if position == len(item) - 2:
                        index += 1
                    break
    return letters, longs


# Options of `ln` and `cp` that take a value, which is never read as flags
# (`ln -ts/b/c` names the folder `s/b/c`).
LINK_VALUE_OPTIONS = {"-S", "--suffix", "-t", "--target-directory"}


NOT_AN_ENTRY = Path("/")


def link_location(raw: str, base: Path) -> Path | None:
    """Where a path names an entry, without following the entry itself: its
    folder resolved, then its own name. ``NOT_AN_ENTRY`` for a name no link
    can have (``.``, ``..``, a root); ``None`` when it cannot be read."""

    if "~" in raw or has_dynamic_markers(raw):
        return None
    pure = PurePath(raw)
    if pure.name in {"", ".", ".."}:
        return NOT_AN_ENTRY
    folder = resolve_shell_path(str(pure.parent), base, empty_is_current=True)
    return None if folder is None else folder / pure.name


def abbreviates(longs: list[str], full: str) -> bool:
    """Whether a long option names ``full``, as getopt reads an abbreviation."""

    return any(len(option) >= 3 and full.startswith(option) for option in longs)


def link_modes(name: str, args: list[str]) -> set[str]:
    """How ``ln``, or ``cp`` in link mode, links (veda#110): ``symbolic``,
    ``hard``, ``relative`` (``ln -r``, read from the working directory).
    Empty for a command that makes no link."""

    if name not in {"ln", "cp"}:
        return set()
    letters, longs = option_words(args, LINK_VALUE_OPTIONS)
    modes: set[str] = set()
    if name == "ln":
        symbolic = "s" in letters or abbreviates(longs, "--symbolic")
        modes.add("symbolic" if symbolic else "hard")
        if "r" in letters or abbreviates(longs, "--relative"):
            modes.add("relative")
        return modes
    if "s" in letters or abbreviates(longs, "--symbolic-link"):
        modes.add("symbolic")
    if "l" in letters or abbreviates(longs, "--link"):
        modes.add("hard")
    return modes


def link_sources(
    positionals: list[str], target_directory: str | None, cwd: Path, modes: set[str]
) -> list[Path] | None:
    """What the links a command makes lead to, as mutation targets.

    A link to a place makes every later write through it a write there, and
    a link the same command makes does not exist yet when the guard looks
    (veda#110): so each operand counts as written. A hard link's operand, and
    ``ln -r``'s, is read from the working directory; a symbolic link's from
    the folder the link lands in, which is the named folder or the
    destination's parent, both taken when the guard cannot tell which.
    ``None`` when an operand cannot be read.
    """

    folders: list[Path] = []
    if modes & {"hard", "relative"}:
        folders.append(cwd)
    if "symbolic" in modes:
        if target_directory is not None:
            places = [target_directory]
        elif len(positionals) >= 2:
            places = positionals[-1:]
        else:
            # `ln -s <source>` makes the link in the working directory.
            places = []
            folders.append(cwd)
        for raw in places:
            # The link lands in the named folder when it is one, else beside
            # the named entry (`ln -n`, `-T`, or a new name): both are read.
            place = resolve_shell_path(raw, cwd)
            beside = link_location(raw, cwd)
            if place is None or beside is None:
                return None
            folders.append(place)
            if beside != NOT_AN_ENTRY:
                folders.append(beside.parent)
    sources = positionals if target_directory is not None else positionals[:-1] or positionals
    targets: list[Path] = []
    for raw in sources:
        for folder in folders:
            target = resolve_shell_path(raw, folder)
            if target is None:
                return None
            if target not in targets:
                targets.append(target)
    return targets


def relinked_locations(words: list[str], cwd: Path) -> list[Path] | None:
    """Entries an ``ln``, ``cp`` or ``mv`` segment may make into links.

    A later segment of the same command resolves through them as they are
    before the command runs, not as it leaves them (veda#110): ``ln -s ../..
    a && touch a/../x`` or a moved relative symlink, ``mv deep/S S && touch
    S/x``. ``ln`` always counts; ``cp`` when it makes links, copies a tree
    (``-R``, ``-r``, ``-a``) or keeps links (``-P``, ``-d``), or a source is
    a symlink or a folder; ``mv`` when a source is a symlink or a folder.
    ``None`` when a path cannot be read.
    """

    name = os.path.basename(words[0])
    if name not in {"ln", "cp", "mv"}:
        return []
    args = words[1:]
    parsed = command_positionals(
        args,
        value_options={"-S", "--suffix"},
        target_options={"-t", "--target-directory"},
    )
    if parsed is None:
        return None
    positionals, target_directory = parsed
    if target_directory is not None:
        sources = positionals
    elif len(positionals) >= 2:
        sources = positionals[:-1]
    else:
        sources = positionals
    if name != "ln":
        letters, longs = option_words(args, LINK_VALUE_OPTIONS)
        keeps_links = name == "cp" and (
            bool(link_modes(name, args))
            or bool(letters & {"R", "r", "a", "P", "d"})
            or any(
                abbreviates(longs, full)
                for full in ("--recursive", "--archive", "--no-dereference")
            )
        )
        if not keeps_links:
            for raw in sources:
                place = link_location(raw, cwd)
                if place is None:
                    return None
                if place != NOT_AN_ENTRY and (place.is_symlink() or place.is_dir()):
                    break
            else:
                return []
    named: list[str] = []
    if target_directory is not None:
        named = [f"{target_directory}/{PurePath(raw).name}" for raw in sources]
    elif len(positionals) >= 2:
        destination = positionals[-1]
        named = [destination, *(f"{destination}/{PurePath(raw).name}" for raw in sources)]
    else:
        named = [PurePath(raw).name for raw in sources]
    locations: list[Path] = []
    for raw in named:
        place = link_location(raw, cwd)
        if place is None:
            return None
        if place != NOT_AN_ENTRY:
            locations.append(place)
    return locations


def goes_through(words: list[str], cwd: Path, relinked: list[Path]) -> bool:
    """Whether a word of the segment names a path at or through an entry an
    earlier segment of the same command may have made into a link."""

    for word in words[1:]:
        candidates = [word]
        if word.startswith("-") and "=" in word:
            candidates.append(word.split("=", 1)[1])
        for candidate in candidates:
            parts = PurePath(candidate).parts
            for end in range(1, len(parts) + 1):
                place = link_location(str(PurePath(*parts[:end])), cwd)
                if place is not None and place != NOT_AN_ENTRY and place in relinked:
                    return True
    return False


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


def pnpm_exec_program_index(name: str, args: list[str]) -> int | None:
    """Where ``pnpm exec`` names the program it runs, or None.

    Only the two plain shapes, ``pnpm exec <program>`` and
    ``pnpm exec -- <program>``. Options before ``exec`` (``-C``, ``--filter``,
    ``-r``) or after it (``-c``, ``--shell-mode``) change what the next words
    mean, so any of them leaves every word confined, as before.
    """

    if name != "pnpm" or args[:1] != ["exec"]:
        return None
    index = 2 if args[1:2] == ["--"] else 1
    if index >= len(args):
        return None
    program = args[index]
    if program.startswith("-") or "=" in program:
        return None
    return index


PNPM_SELECTOR_OPTIONS = {"-C": "dir", "--dir": "dir", "-F": "filter", "--filter": "filter"}


def workspace_packages(root: Path) -> list[tuple[Path, str]] | None:
    """Each package of the pnpm workspace at ``root`` and its name, from
    ``pnpm-workspace.yaml``'s ``packages`` list; None when a pattern is one
    this reading does not follow (only a folder and ``folder/*`` are)."""

    try:
        lines = (root / "pnpm-workspace.yaml").read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return None
    patterns: list[str] = []
    listing = False
    for line in lines:
        if re.match(r"packages\s*:\s*$", line):
            listing = True
            continue
        if listing and re.match(r"\s+-\s", line):
            patterns.append(line.split("-", 1)[1].split(" #", 1)[0].strip().strip("'\""))
            continue
        if listing and line.strip() and not line.startswith((" ", "\t", "#")):
            listing = False
    folders: list[Path] = []
    for pattern in patterns:
        if pattern.startswith("!"):
            return None
        parts = pattern.rstrip("/").split("/")
        if any(re.search(r"[*?\[\]{}]", part) for part in parts[:-1]) or ".." in parts:
            return None
        last = parts[-1]
        if last == "*":
            base = root.joinpath(*parts[:-1])
            try:
                folders.extend(sorted(entry for entry in base.iterdir() if entry.is_dir()))
            except OSError:
                continue
        elif re.search(r"[*?\[\]{}]", last):
            return None
        else:
            folders.append(root.joinpath(*parts))
    found: list[tuple[Path, str]] = []
    for folder in folders:
        try:
            manifest = json.loads((folder / "package.json").read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            continue
        if isinstance(manifest, dict) and isinstance(manifest.get("name"), str):
            found.append((folder, manifest["name"]))
    return found


def pnpm_selected_directory(args: list[str], cwd: Path) -> tuple[Path, int] | None:
    """Where ``pnpm exec``/``pnpm run`` runs when one selector before the
    subcommand names exactly one folder, and the index of the subcommand.

    ``--dir``/``-C`` name the folder; ``--filter``/``-F`` name it by a path
    (``./apps/server``, ``{./apps/server}``) or by one package's name, with or
    without its scope, as pnpm matches it. Anything else before the
    subcommand, a second selector, a pattern (``@scope/*``, ``server...``) or
    a name more than one package has leaves the operands resolved from the
    command's own folder, as before."""

    index = 0
    selector: tuple[str, str] | None = None
    while index < len(args) and args[index].startswith("-"):
        item = args[index]
        option, attached = (item.split("=", 1) + [None])[:2] if item.startswith("--") else (item, None)
        kind = PNPM_SELECTOR_OPTIONS.get(option)
        if kind is None or selector is not None:
            return None
        if attached is None:
            if index + 1 >= len(args):
                return None
            value = args[index + 1]
            index += 2
        else:
            value = shell_option_value(item)
            index += 1
        if not value or has_dynamic_markers(value) and not re.fullmatch(r"\{\.{1,2}/[^{}$`*?\[]*\}", value):
            return None
        selector = (kind, value)
    if selector is None or index >= len(args) or args[index] not in ("exec", "run"):
        return None
    kind, value = selector
    if kind == "dir" or value.startswith(("./", "../", "{./", "{../")) or value in (".", ".."):
        relative = value[1:-1] if value.startswith("{") and value.endswith("}") else value
        target = resolve_shell_path(relative, cwd)
        if target is None or not target.is_dir():
            return None
        if kind == "filter" and not (target / "package.json").is_file():
            return None
        return target, index
    if re.search(r"[^A-Za-z0-9@/._-]", value) or value.startswith(("-", ".")):
        return None
    root = next((folder for folder in (cwd, *cwd.parents) if (folder / "pnpm-workspace.yaml").is_file()), None)
    packages = workspace_packages(root) if root is not None else None
    if not packages:
        return None
    exact = [folder for folder, package in packages if package == value]
    if not exact and "/" not in value:
        exact = [folder for folder, package in packages if package.startswith("@") and package.split("/", 1)[-1] == value]
    return (exact[0].resolve(), index) if len(exact) == 1 else None


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
    selected = pnpm_selected_directory(args, cwd) if name == "pnpm" else None
    if selected is not None:
        # `pnpm --filter server exec tsx ../../.tmp/x.ts` runs in the
        # package's folder, so what follows the subcommand is read from
        # there; the selector itself is still read from the command's folder.
        # The program word stays confined, as for any shape but the plain
        # `pnpm exec <program>`.
        folder, subcommand = selected
        before = generic_mutation_paths(name, args[:subcommand], cwd, read_namespaces=read_namespaces)
        after = generic_mutation_paths(name, args[subcommand + 1 :], folder, read_namespaces=read_namespaces)
        return None if before is None or after is None else before + after
    turbo_run = (name == "turbo" and args[:1] == ["run"]) or (
        name == "pnpm" and args[:2] == ["turbo", "run"]
    )
    program_index = pnpm_exec_program_index(name, args)
    for index, item in enumerate(args):
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
        if index == program_index:
            # The program pnpm runs, not a place the command writes: after the
            # dynamic-marker refusal above, `/bin/bash` reads as `bash` does.
            continue
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
    line = ReviewedLine(command)
    for entry in trusted:
        if not line.matches(entry.pattern):
            continue
        resolved = root.resolve()
        script = resolved / entry.script
        if cwd.resolve() == resolved and script.is_file() and script.resolve() == script:
            return True
    return False


class ReviewedLine:
    """One command line, as a consumer's reviewed pattern is matched to it.

    A whole line of plain words matches when the pattern matches all of it. A
    loose pattern (`.*`) must not admit a line that hides another command, so
    any other line matches only by its first segment, as plain words, followed
    by nothing but read-only segments (reviewed redirections included). The
    parse is done once, for the first pattern that needs it.
    """

    def __init__(self, command: str) -> None:
        self.command = command
        self.plain = TRUSTED_LINE_UNSAFE.search(command) is None
        self.opening: tuple[str, list[list[str]]] | None = None
        self.rest_is_inert: bool | None = None

    def matches(self, pattern: re.Pattern[str]) -> bool:
        if self.plain and pattern.fullmatch(self.command):
            return True
        if self.opening is None:
            self.opening = trusted_opening(self.command)
        first, rest = self.opening
        if not first or not pattern.fullmatch(first):
            return False
        if self.rest_is_inert is None:
            self.rest_is_inert = all(segment_is_read_only(words) for words in rest)
        return self.rest_is_inert


class ReadOnlyEntry(Protocol):
    """One reviewed read-only command, as `config.ReadOnlyCommand` carries it:
    `pattern` must match the whole command line, and `env` pairs each
    variable with the values the hook's environment may hold for it."""

    pattern: re.Pattern[str]
    env: tuple[tuple[str, tuple[str, ...]], ...]


def read_only_request(
    command: str,
    cwd: Path,
    root: Path,
    entries: Sequence[ReadOnlyEntry],
    environ: Mapping[str, str],
) -> bool:
    """Recognize a command line the consumer reviewed as only reading.

    Such a command reads although this parser cannot prove it: a package
    runner's script, say, whose writes are the consumer's to review, not
    kavach's. It needs no owned worktree, so the match is held as tight as a
    trusted command's (``ReviewedLine``), and two more conditions apply:

    - It runs from the checkout's root (``root``), so a relative script or
      a package manifest means the root's own, never a subfolder's.
    - Every variable the entry names holds one of its listed values in
      ``environ``, the hook's own environment, which the command line cannot
      set.

    No entries: nothing is admitted here.
    """

    if not entries or cwd.resolve() != root.resolve():
        return False
    line = ReviewedLine(command)
    for entry in entries:
        if all(environ.get(name) in values for name, values in entry.env) and line.matches(
            entry.pattern
        ):
            return True
    return False


class ReviewedSubcommandEntry(Protocol):
    """One subcommand of a reviewed CLI, as `config.ReviewedSubcommand`
    carries it: its leading words, the options whose value is a path, and
    whether its operands are paths."""

    words: tuple[str, ...]
    path_options: tuple[str, ...]
    path_operands: bool


class ReviewedCLIEntry(Protocol):
    """One reviewed CLI, as `config.ReviewedCLI` carries it."""

    program: str
    subcommands: tuple[ReviewedSubcommandEntry, ...]


# What a bare (unquoted) word of a reviewed CLI's line may hold: characters no
# shell gives a meaning to, mid-word. Everything else -- an operator, a
# redirection, `$`, a backtick, a backslash, a glob, `~`, `#`, a brace --
# makes the line no reviewed CLI's at all.
REVIEWED_BARE = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/=:,@+%-"
)
# Inside double quotes, the characters that still expand (`$`, a backtick) or
# escape (`\`).
REVIEWED_DOUBLE_QUOTED_UNSAFE = frozenset("$`\\")


def reviewed_cli_words(command: str) -> list[str] | None:
    """The words of ``command`` as the shell passes them, quotes removed; None
    unless every character is literal.

    The grammar is a small one, so nothing in it needs evaluating: words split
    by spaces and tabs, each made of bare characters (``REVIEWED_BARE``),
    single-quoted text (anything but a single quote) and double-quoted text
    holding no ``$``, backtick or backslash. An unquoted ``=`` may not start a
    word: zsh replaces ``=name`` with the path of the program ``name``. So a
    line with a redirection, a pipe, a chain, a newline outside quotes, a
    comment, a substitution, an expansion or a glob is no list of words here.
    """

    words: list[str] = []
    current: list[str] | None = None
    index = 0
    while index < len(command):
        character = command[index]
        if character in " \t":
            if current is not None:
                words.append("".join(current))
                current = None
            index += 1
            continue
        if current is None:
            if character == "=":
                return None
            current = []
        if character == "'":
            end = command.find("'", index + 1)
            if end < 0:
                return None
            current.append(command[index + 1 : end])
            index = end + 1
        elif character == '"':
            end = command.find('"', index + 1)
            if end < 0:
                return None
            text = command[index + 1 : end]
            if any(unsafe in text for unsafe in REVIEWED_DOUBLE_QUOTED_UNSAFE):
                return None
            current.append(text)
            index = end + 1
        elif character in REVIEWED_BARE:
            current.append(character)
            index += 1
        else:
            return None
    if current is not None:
        words.append("".join(current))
    return words


def judged_here(name: str) -> bool:
    """Whether this module reads ``name``'s writes itself (a reader, a
    mutator, a runner, a shell, a wrapper or an interpreter), so no consumer
    may list it as a reviewed CLI: its own parser keeps judging it."""

    return (
        name in READ_COMMANDS
        or name in READ_ONLY_COMMANDS
        or name in GENERIC_SCOPED_COMMANDS
        or name in SHELL_INTERPRETERS
        or name in SHELL_COMMAND_WRAPPERS
        or name in SHELL_CONTROL_WORDS
        or name in NAVIGATION_COMMANDS
        or name in ALL_OPERAND_MUTATORS
        or name in PARSED_MUTATORS
        or is_non_shell_interpreter(name)
    )


def declared_path_values(
    args: list[str], subcommand: ReviewedSubcommandEntry
) -> list[str] | None:
    """The values ``args`` gives the subcommand's declared paths; None when a
    declared option has no value.

    Every word is looked at, without knowing which other options take a
    value, so this finds every path the CLI could read the line as naming,
    and perhaps a few more: an operand that is really an option's value, or
    an option, is still confined when operands are paths. After a literal
    ``--`` every word is an operand.
    """

    values: list[str] = []
    options = subcommand.path_options
    operands_only = False
    index = 0
    while index < len(args):
        word = args[index]
        index += 1
        if not operands_only:
            if word == "--":
                operands_only = True
                continue
            if word in options:
                if index >= len(args):
                    return None
                values.append(args[index])
                index += 1
                continue
            attached = next(
                (
                    option
                    for option in options
                    if word.startswith(f"{option}=")
                    or (not option.startswith("--") and word.startswith(option))
                ),
                None,
            )
            if attached is not None:
                value = word[len(attached) :]
                values.append(value[1:] if value.startswith("=") else value)
                continue
            if word.startswith("-") and not subcommand.path_operands:
                continue
        # An operand path is confined even when it starts with `-`: a CLI
        # may read `-x/../../r.md` as one, and `--lint` resolves inside.
        if subcommand.path_operands:
            values.append(word)
    return values


def reviewed_cli_paths(
    command: str, cwd: Path, root: Path, entries: Sequence[ReviewedCLIEntry]
) -> list[Path] | None:
    """The paths a reviewed CLI's command line declares, resolved; None when
    the line is no reviewed CLI's.

    Such a CLI writes off its command line, so this parser cannot follow it;
    the consumer reviewed what it writes instead (the settings'
    ``worktree.reviewedCLIs``): only under the git toplevel, and on the paths
    its options and operands declare. So the line is admitted only as tight
    as that review: one command of literal words (``reviewed_cli_words``),
    the program named bare first (no variable prefix, no path), one listed
    subcommand's words next, run from the worktree's root. What the caller
    confines is the returned paths; every other word is data, however it
    reads. Callers must establish ownership first.
    """

    if not entries or cwd.resolve() != root.resolve():
        return None
    words = reviewed_cli_words(command)
    if not words:
        return None
    for entry in entries:
        if words[0] != entry.program or judged_here(entry.program):
            continue
        for subcommand in entry.subcommands:
            end = 1 + len(subcommand.words)
            if tuple(words[1:end]) != subcommand.words:
                continue
            values = declared_path_values(words[end:], subcommand)
            if values is None or "" in values:
                continue
            return [
                (Path(value) if Path(value).is_absolute() else cwd / value).resolve()
                for value in values
            ]
    return None


def reviewed_cli_named(
    command: str, entries: Sequence[ReviewedCLIEntry]
) -> ReviewedCLIEntry | None:
    """The reviewed CLI whose program opens ``command``, admitted or not."""

    first = command.strip().split(maxsplit=1)
    return next(
        (
            entry
            for entry in entries
            if first and first[0] == entry.program and not judged_here(entry.program)
        ),
        None,
    )


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


def git_checkout_index_paths(args: list[str], cwd: Path) -> list[Path] | None:
    """The folders ``git checkout-index --prefix=<p>`` writes into.

    Git prepends the prefix to each path as text and resolves the result
    from the top of the work tree, not from the folder it runs in:
    ``git -C sub checkout-index --prefix=../x/ ../a`` writes ``<top>/../x/a``
    (git 2.54). ``--prefix=../x`` writes ``<top>/../xa``, so the folder is
    the parent of the prefix with a name appended.
    """
    prefixes = git_checkout_index_prefixes(args)
    if prefixes is None:
        return None
    if not prefixes:
        return []
    state = checkout_state(cwd)
    if state is None:
        return None
    targets: list[Path] = []
    for prefix in prefixes:
        named = (
            ShellWord(prefix + "x", (*prefix.protected, True))
            if isinstance(prefix, ShellWord) else prefix + "x"
        )
        target = resolve_shell_path(named, state[0])
        if target is None:
            return None
        targets.append(target.parent)
    return targets


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
        if words[command_index] == "checkout-index":
            return git_checkout_index_paths(words[command_index + 1 :], git_cwd)
        if words[command_index] in GIT_UNPLACED_RUNNERS or (
            words[command_index] == "submodule"
            and "foreach" in words[command_index + 1 :]
        ):
            return None
        if words[command_index] in {"fast-export", "pack-objects", "read-tree"}:
            top_relative = git_top_relative_outputs(
                words[command_index], words[command_index + 1 :]
            )
            state = checkout_state(git_cwd) if top_relative else None
            if top_relative is None or (top_relative and state is None):
                return None
            others = git_output_options(words, command_index)
            if others is None:
                return None
            written = resolve_mutation_paths(others, git_cwd)
            above = resolve_mutation_paths(top_relative, state[0]) if state else []
            if written is None or above is None:
                return None
            return written + above
        if words[command_index] in READ_GIT:
            outputs = git_inspection_outputs(words, command_index)
            return (
                resolve_mutation_paths(outputs, git_cwd)
                if outputs is not None else None
            )
        outputs = git_output_options(words, command_index)
        destinations = git_destination_operands(words, command_index)
        if outputs is None or destinations is None:
            return None
        return resolve_mutation_paths(outputs + destinations, git_cwd)
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
        written = resolve_mutation_paths(destinations, cwd)
        modes = link_modes(name, words[1:])
        if written is None or not modes:
            return written
        linked = link_sources(positionals, target_directory, cwd, modes)
        return None if linked is None else written + linked
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
    relinked: list[Path] | None = None,
    collected: list[tuple[tuple[str, ...], Path, tuple[str, ...], bool]] | None = None,
    alone: bool = True,
) -> list[Path] | None:
    """Resolve the directory in which each mutating segment would run.

    ``relinked`` holds the entries earlier segments may have made into links
    (`relinked_locations`), shared with a nested shell's program: a later
    write at or through one is unprovable.

    ``collected``, when given, receives each mutating segment as (its words
    after wrappers, the folder it runs in, the words before it, whether it is
    the only command on its line and on every line holding it), for the
    owned-clone check (`clone_writers`). ``alone`` says the line holding this
    one is a single command.
    """

    if nested_depth > 8:
        return None
    if relinked is None:
        relinked = []
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
    alone = alone and len(segments) == 1
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
        if relinked and (name == "cd" or not read_only) and goes_through(words, current, relinked):
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
                relinked=relinked,
                collected=collected,
                alone=alone,
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
            # Above the read-only gate: `GIT_EXTERNAL_DIFF=<cmd> git diff`
            # runs the command, and `GIT_TRACE=<file> git status` writes.
            if not git_prefix_is_inert(prefix):
                return None
            programs = (
                git_runner_programs(words, _index) if _index < len(words) else []
            )
            if programs is None:
                return None
            if programs:
                # git runs these from the top of the work tree, after
                # `git -C sub` too (git 2.54), once per commit.
                state = checkout_state(git_target)
                if state is None:
                    return None
                for program in programs:
                    if has_dynamic_markers(program):
                        return None
                    nested = mutation_directories(
                        program,
                        state[0],
                        nested_depth=nested_depth + 1,
                        read_namespaces=read_namespaces,
                        relinked=relinked,
                        collected=collected,
                        alone=False,
                    )
                    if nested is None:
                        return None
                    mutations.extend(nested)
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
            if collected is not None:
                collected.append((tuple(words), current, tuple(prefix), alone))
            operand_targets = mutation_path_operands(
                words, current if name == "git" else target,
                lookup_modified=lookup_modified,
                read_namespaces=read_namespaces,
            )
            if operand_targets is None:
                return None
            mutations.extend(operand_targets)
            made = relinked_locations(words, current)
            if made is None:
                return None
            relinked.extend(made)
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
