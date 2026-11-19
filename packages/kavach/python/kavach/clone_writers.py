"""Git and package-manager commands inside an owned plain clone.

`worktree.ownCheckout` keeps fences closed inside a clone a hosted session
owns (`worktree_guard.clone_fences`): its git folder, the guard's settings
and code, and the consumer's `protectedPaths`. A target is judged from the
command line, and git and package managers write paths their command lines
do not name: `git checkout <ref> -- .claude` and `pnpm install` each count
only the folder they run in. So inside an owned clone those two programs
are judged here as well, by what they can write:

- git: an allowlist of subcommands that never write the work tree; the ones
  that write only the paths they name (`checkout --`, `restore`, `rm`, `mv`)
  when every path misses every fence; a branch switch when the target
  commit's fenced paths match the work tree; `apply` when the patch's paths
  miss every fence. Everything else, an unknown option or subcommand
  included, refuses.
- package installs: refused, but for one shape of `pnpm install` that only
  reinstalls what the fenced manifest and lockfile pin.
- either, run through another program (`xargs git …`, `pnpm exec git …`):
  refused, since what that program passes on is not read here.

What a package script or other repository code writes stays out of reach:
the README names that limit.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence


@dataclass(frozen=True)
class Segment:
    """One mutating simple command, as `boundary.mutation_directories` read it."""

    words: tuple[str, ...]
    # The folder it runs in, after any `cd` before it on the line.
    cwd: Path
    # Words before the command: assignments and wrappers (`env`, `command`).
    prefix: tuple[str, ...]
    # The only command on its line, and on every line that holds it (`sh -c`).
    alone: bool


Fence = tuple[Path, str]
WAY_OUT = "an owned plain clone does not open it"

# Programs judged here, and the ones another program must not run.
PACKAGE_MANAGERS = {"pnpm", "npm", "yarn", "bun", "npx", "bunx", "corepack"}
JUDGED = {"git"} | PACKAGE_MANAGERS

# Options before git's subcommand that change nothing it writes.
GIT_GLOBAL_FLAGS = {"--no-pager", "-P", "--no-optional-locks", "--no-replace-objects", "--version", "--help"}

# Subcommands that never write the work tree. They write refs, objects, the
# index or config sections of their own, all inside the git folder, which a
# file write cannot reach (it is a fence).
TREE_FREE = {
    "add", "blame", "branch", "cat-file", "check-attr", "check-ignore",
    "check-ref-format", "cherry", "commit", "commit-tree", "count-objects",
    "describe", "diff", "diff-files", "diff-index", "diff-tree", "fetch",
    "for-each-ref", "fsck", "gc", "grep", "hash-object", "help", "log",
    "ls-files", "ls-remote", "ls-tree", "merge-base", "mktree", "name-rev",
    "notes", "push", "range-diff", "reflog", "remote", "rev-list", "rev-parse",
    "shortlog", "show", "show-ref", "status", "symbolic-ref", "tag",
    "update-index", "update-ref", "var", "verify-commit", "verify-tag",
    "version", "whatchanged", "worktree", "write-tree",
}
# Options of those that run a program: git starts it on the session's behalf.
# Matched by prefix as well, since git takes any unique abbreviation.
RUNS_PROGRAM = ("--upload-pack", "--receive-pack", "--exec", "--open-files-in-pager")

# How each subcommand judged by its options reads them. A long option is
# matched whole (git's abbreviations are refused); a short one alone or in a
# bundle of flags; a value option takes the next word, or `=value`.
Table = tuple[frozenset[str], frozenset[str]]


def table(flags: str, values: str = "") -> Table:
    return frozenset(flags.split()), frozenset(values.split())


CHECKOUT = table(
    "-q --quiet -f --force --detach --no-track -t --track --ours --theirs "
    "-p --patch --overlay --no-overlay --progress --no-progress --guess --no-guess",
    "-b -B --orphan",
)
SWITCH = table(
    "-q --quiet -d --detach --no-track -t --track --discard-changes -f --force "
    "--progress --no-progress --guess --no-guess",
    "-c -C --create --force-create",
)
RESTORE = table(
    "-q --quiet -S --staged -W --worktree --ours --theirs -p --patch -m --merge "
    "--overlay --no-overlay --progress --no-progress --ignore-unmerged",
    "-s --source",
)
RM = table("-q --quiet -r -f --force --cached -n --dry-run --ignore-unmatch --sparse")
MV = table("-f --force -k -n --dry-run -v --verbose --sparse")
RESET = table("-q --quiet --soft --mixed -N --intent-to-add --no-refresh --refresh -p --patch")
READ_TREE = table("-m -i -n --dry-run -v --trivial --aggressive --reset --empty -q --no-sparse-checkout", "--prefix")
APPLY = table(
    "--cached --index -R --reverse --check --stat --numstat --summary -3 --3way "
    "--recount -v --verbose -q --quiet --ignore-space-change --ignore-whitespace "
    "--reject --unidiff-zero --allow-empty --inaccurate-eof --no-add",
    "--whitespace --directory --include --exclude",
)
# `apply`'s options that change which paths a patch writes, passed on to the
# guard's own `--numstat` read; `-p<n>` and `-C<n>` are read apart.
APPLY_PATH_OPTIONS = {"-R", "--reverse", "--directory", "--include", "--exclude", "--unidiff-zero", "--recount", "--inaccurate-eof", "--allow-empty"}
CONFIG_READS = {"--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--get-color", "--get-colorbool"}
CONFIG = table(
    "--get --get-all --get-regexp --get-urlmatch --list -l --show-origin --show-scope "
    "--name-only -z --null --local --global --system --worktree --includes --no-includes "
    "--bool --int --bool-or-int --path --expiry-date --all --regexp --fixed-value",
    "--type --default --value",
)

# Subcommands each package manager installs or rewrites packages with.
PNPM_INSTALLS = {
    "install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up",
    "upgrade", "link", "ln", "unlink", "import", "rebuild", "rb", "dedupe",
    "prune", "install-test", "it", "patch", "patch-commit", "patch-remove",
    "deploy", "env", "setup", "self-update", "approve-builds",
}
NPM_INSTALLS = {
    "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta",
    "isntal", "isntall", "add", "ci", "clean-install", "ic", "install-clean",
    "isntall-clean", "install-test", "it", "install-ci-test", "cit",
    "uninstall", "remove", "rm", "r", "un", "unlink", "update", "up", "upgrade",
    "udpate", "link", "ln", "rebuild", "rb", "dedupe", "ddp", "prune", "exec", "x",
}
YARN_INSTALLS = {"install", "add", "remove", "upgrade", "up", "link", "unlink", "import", "dedupe", "dlx"}
BUN_INSTALLS = {"install", "i", "add", "a", "remove", "rm", "update", "link", "unlink", "patch", "patch-commit", "pm", "x"}
# pnpm's options before its subcommand: the recursive-run ones veda uses.
PNPM_GLOBAL_FLAGS = {"-r", "--recursive", "-w", "--workspace-root", "-s", "--silent", "--stream", "--parallel", "--aggregate-output", "--no-bail", "--bail", "--sort", "--no-sort", "--if-present"}
PNPM_GLOBAL_VALUES = {"-C", "--dir", "-F", "--filter"}
# The one install that passes: it reinstalls what the fenced lockfile pins,
# runs no lifecycle script and no pnpmfile.
FROZEN_REQUIRED = {"--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile"}
FROZEN_ALLOWED = FROZEN_REQUIRED | {"--offline", "--prefer-offline", "--silent", "-s"}
FROZEN = "pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile"


class Refused(Exception):
    """A segment this module refuses; the message is the reason."""


@dataclass
class Context:
    root: Path
    fences: tuple[Fence, ...]
    in_fence: Callable[[Path, Path], bool]
    boundary: Any

    def fence_reached(self, target: Path) -> Fence | None:
        """The fence ``target`` lies in or holds, the clone's root included:
        a path of `.` names the whole checkout, which holds every fence."""

        for fence in self.fences:
            if self.in_fence(target, fence[0]) or self.in_fence(fence[0], target):
                return fence
        return None

    def literal(self, word: str) -> bool:
        return not self.boundary.has_dynamic_markers(word)

    def git(self, cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "--no-pager", "--no-replace-objects", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=False,
            env=self.boundary.git_environment(),
        )


def judge(
    collected: Sequence[tuple[tuple[str, ...], Path, tuple[str, ...], bool]],
    root: Path,
    fences: tuple[Fence, ...],
    in_fence: Callable[[Path, Path], bool],
    boundary: Any,
) -> str | None:
    """The reason to refuse the first segment that may write a fence, or None.

    ``collected`` is what `boundary.mutation_directories` gathered."""

    context = Context(root.resolve(), fences, in_fence, boundary)
    for words, cwd, prefix, alone in collected:
        # Control words (`then git …`) are syntax; assignments and wrappers
        # before a command are what `prefix` is kept for.
        kept = tuple(word for word in prefix if word not in boundary.SHELL_CONTROL_WORDS)
        try:
            judge_segment(Segment(tuple(words), cwd, kept, alone), context)
        except Refused as refusal:
            return str(refusal)
    return None


def judge_segment(segment: Segment, context: Context) -> None:
    words = list(segment.words)
    name = os.path.basename(words[0])
    if name != "git":
        # Another program that runs git or a package manager (`xargs git`,
        # `pnpm exec git`, `timeout 5 pnpm install`) passes it words this
        # guard does not see.
        for word in words[1:]:
            runs = os.path.basename(word)
            if runs in JUDGED:
                raise Refused(
                    f"`{name}` would run `{runs}`, whose writes this guard reads only from "
                    f"its own command line, and {WAY_OUT}: run `{runs}` as the command itself"
                )
    if name not in JUDGED:
        return
    if name == "git":
        judge_git(words, segment, context)
        return
    if any(not context.literal(word) for word in words):
        raise Refused(f"a `{name}` line with an expansion in it cannot be read here, and {WAY_OUT}")
    judge_package_manager(name, words, segment)


def judge_git(words: list[str], segment: Segment, context: Context) -> None:
    if segment.prefix:
        raise Refused(f"`git` with `{segment.prefix[0]}` before it is not read here, and {WAY_OUT}")
    index, cwd = git_start(words, segment.cwd, context)
    if index >= len(words):
        return
    sub, args = words[index], words[index + 1 :]
    if not context.literal(sub):
        raise Refused(f"a git subcommand spelled with an expansion cannot be read here, and {WAY_OUT}")
    if sub in TREE_FREE:
        # An expansion that could become an option is refused before this
        # check (`boundary.expansions_are_inert`), so literal words suffice.
        runs = next((word for word in args if runs_program(sub, word)), None)
        if runs is not None:
            raise Refused(f"`git {sub} {runs}` runs a program for git, and {WAY_OUT}")
        # `--output=<file>` (the diff and log family) writes a file this
        # guard does not read as a target for every subcommand.
        writes = next((word for word in args if is_long_option(word, "--output")), None)
        if writes is not None:
            raise Refused(
                f"`git {sub} {writes}` writes a file, and {WAY_OUT}: drop it and read the output"
            )
        return
    handler = GIT_HANDLERS.get(sub)
    if handler is None:
        raise Refused(git_refusal(sub))
    if any(not context.literal(word) for word in args):
        raise Refused(f"`git {sub}` with an expansion in it cannot be read here, and {WAY_OUT}")
    handler(args, cwd, segment, context)


def git_start(words: list[str], cwd: Path, context: Context) -> tuple[int, Path]:
    """git's subcommand index and the folder it runs in; only `-C <dir>` and
    options that change nothing it writes may come before the subcommand."""

    index = 1
    while index < len(words) and words[index].startswith("-"):
        option = words[index]
        if not context.literal(option):
            raise Refused(f"`git {option}` before the subcommand is not read here, and {WAY_OUT}")
        if option == "-C" and index + 1 < len(words):
            resolved = context.boundary.resolve_shell_path(words[index + 1], cwd, empty_is_current=True)
            if resolved is None:
                raise Refused(f"`git -C {words[index + 1]}` names no folder this guard can read, and {WAY_OUT}")
            cwd = resolved
            index += 2
            continue
        if option in GIT_GLOBAL_FLAGS:
            index += 1
            continue
        raise Refused(f"`git {option}` before the subcommand is not read here, and {WAY_OUT}")
    return index, cwd


def is_long_option(word: str, option: str) -> bool:
    """Whether ``word`` is ``option`` or an abbreviation git would take for
    it (any prefix of three letters or more after the dashes)."""

    name = word.split("=", 1)[0]
    return name.startswith("--") and len(name) >= 5 and option.startswith(name)


def runs_program(sub: str, word: str) -> bool:
    if sub == "grep" and word.startswith("-") and not word.startswith("--") and "O" in word:
        # `-O<pager>`, alone or after other short flags (`-iO`).
        return True
    name = word.split("=", 1)[0]
    # From three characters on: git 2.54 runs `git push --e <cmd>`.
    if not name.startswith("--") or len(name) < 3:
        return False
    return any(option.startswith(name) for option in RUNS_PROGRAM)


def git_refusal(sub: str) -> str:
    ways = {
        "stash": "commit a WIP instead",
        "merge": "finish on this branch, or start a new one from `main` with `git switch -c <name> origin/main`",
        "pull": "`git fetch`, then start a new branch from what it fetched with `git switch -c <name> <ref>`",
        "rebase": "finish on this branch, or start a new one with `git switch -c <name> <ref>`",
        "cherry-pick": "make the change with Edit or Write",
        "revert": "make the change with Edit or Write",
        "am": "use `git apply`, whose paths this guard reads",
        "clean": "remove files with `rm`, whose paths this guard reads",
    }
    way = ways.get(sub, "use a subcommand this guard reads, or Edit and Write")
    return (
        f"`git {sub}` can write any file of the checkout, the guard's own files among them, "
        f"and {WAY_OUT}: {way}"
    )


Options = Dict[str, List[Optional[str]]]


def parse_options(args: Sequence[str], spec: Table, command: str) -> tuple[Options, list[str], list[str]]:
    """Options (each with every value it was given), the positionals before
    `--`, and the words after it.

    Refuses an option the table lacks, an abbreviation, a bundle holding a
    value option, and `--pathspec-from-file` (which no table lists)."""

    flags, values = spec
    options: Options = {}
    before: list[str] = []
    index = 0
    while index < len(args):
        word = args[index]
        if word == "--":
            return options, before, list(args[index + 1 :])
        if word.startswith("--"):
            name, equals, value = word.partition("=")
            if name in values:
                if equals:
                    options.setdefault(name, []).append(value)
                elif index + 1 < len(args):
                    options.setdefault(name, []).append(args[index + 1])
                    index += 1
                else:
                    raise Refused(f"`{command} {name}` has no value, and {WAY_OUT}")
            elif name in flags and not equals:
                options.setdefault(name, []).append(None)
            else:
                raise Refused(f"`{command} {word}` is not an option this guard reads, and {WAY_OUT}")
        elif word.startswith("-") and len(word) > 1:
            if word in values:
                if index + 1 >= len(args):
                    raise Refused(f"`{command} {word}` has no value, and {WAY_OUT}")
                options.setdefault(word, []).append(args[index + 1])
                index += 1
            elif all(f"-{letter}" in flags for letter in word[1:]):
                for letter in word[1:]:
                    options.setdefault(f"-{letter}", []).append(None)
            else:
                raise Refused(f"`{command} {word}` is not an option this guard reads, and {WAY_OUT}")
        else:
            before.append(word)
        index += 1
    return options, before, []


def check_paths(paths: Sequence[str], cwd: Path, command: str, context: Context) -> None:
    for raw in paths:
        if raw.startswith(":") or any(mark in raw for mark in "*?[\\"):
            raise Refused(
                f"`{command}` with the pathspec `{raw}` cannot be read here, and {WAY_OUT}: "
                "name each path plainly"
            )
        target = context.boundary.resolve_shell_path(raw, cwd)
        if target is None:
            raise Refused(f"`{command}` names `{raw}`, which this guard cannot resolve, and {WAY_OUT}")
        fence = context.fence_reached(target)
        if fence is not None:
            place, what = fence
            raise Refused(
                f"`{command}` would write {target}, which reaches {place}, {what}; {WAY_OUT}"
            )


def require_alone(segment: Segment, command: str) -> None:
    """A segment judged by the state of the checkout passes only alone on its
    line: an earlier command on it could change that state first."""

    if not segment.alone or segment.prefix:
        raise Refused(
            f"`{command}` is judged by the checkout as it is now, so it runs only as a "
            f"command of its own, with nothing before it, and {WAY_OUT}"
        )


def resolve_commit(rev: str, cwd: Path, command: str, context: Context) -> str:
    if rev.startswith("-") and rev != "-":
        raise Refused(f"`{command}` names `{rev}`, which is not a commit, and {WAY_OUT}")
    spelled = "@{-1}" if rev == "-" else rev
    result = context.git(cwd, "rev-parse", "--verify", "--quiet", "--end-of-options", f"{spelled}^{{commit}}")
    sha = result.stdout.strip()
    if result.returncode != 0 or not sha:
        raise Refused(
            f"`{command}`: `{rev}` names no commit this guard can find, and {WAY_OUT}. "
            "Name the commit or branch it starts from (`git switch -c <name> origin/<name>`), "
            "or, for a path, write `git checkout -- <path>`"
        )
    return sha


def fence_pathspecs(context: Context) -> list[str]:
    specs: list[str] = []
    for place, _what in context.fences:
        try:
            relative = place.resolve().relative_to(context.root)
        except ValueError:
            continue
        text = relative.as_posix()
        # The git folder holds no tracked path, and git refuses it as one.
        if text in ("", ".") or relative.parts[0].casefold() == ".git":
            continue
        if any(mark in text for mark in "*?[\\"):
            specs.append(f":(literal){text}")
        else:
            specs.append(f":(icase){text}")
    return specs


def check_switch(rev: str, segment: Segment, cwd: Path, command: str, context: Context) -> None:
    """A branch switch to ``rev`` passes when the guard's files there match
    the work tree, so the switch leaves every one of them as it is."""

    require_alone(segment, command)
    commits = {resolve_commit(rev, cwd, command, context)}
    if rev != "-" and not rev.startswith("refs/"):
        # `checkout <name>` takes the branch where a tag has the same name,
        # which `rev-parse` would not: judge every commit the name can mean.
        branch = context.git(
            cwd, "rev-parse", "--verify", "--quiet", "--end-of-options", f"refs/heads/{rev}^{{commit}}"
        )
        if branch.returncode == 0 and branch.stdout.strip():
            commits.add(branch.stdout.strip())
    specs = fence_pathspecs(context)
    if not specs:
        return
    for sha in sorted(commits):
        result = context.git(
            context.root, "diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv",
            "--no-renames", sha, "--", *specs,
        )
        if result.returncode != 0:
            raise Refused(f"`{command}`: this guard could not compare {rev} with the checkout, and {WAY_OUT}")
        changed = [path for path in result.stdout.split("\0") if path]
        if changed:
            raise Refused(
                f"`{command}` would change {changed[0]}, one of the guard's own files, and {WAY_OUT}. "
                "Stay on this branch, or start one where those files match: "
                "a new session clones the updated `main`"
            )


def git_checkout(args: list[str], cwd: Path, segment: Segment, context: Context) -> None:
    command = "git checkout"
    options, before, after = parse_options(args, CHECKOUT, command)
    creates = any(name in options for name in ("-b", "-B", "--orphan"))
    forced = any(name in options for name in ("-f", "--force"))
    patching = any(name in options for name in ("-p", "--patch"))
    if "--" in args:
        if creates or len(before) > 1:
            raise Refused(f"`{command}` in this shape is not read here, and {WAY_OUT}")
        # No path after `--` checks out nothing; `-p` with none offers every file.
        check_paths(after or (["."] if patching else []), cwd, command, context)
        return
    if len(before) > 1:
        raise Refused(
            f"`{command} {' '.join(before)}` may name paths, and {WAY_OUT}: "
            "write `git checkout [<ref>] -- <path>…`"
        )
    if patching:
        check_paths(["."], cwd, command, context)
    if before:
        check_switch(before[0], segment, cwd, command, context)
    elif forced:
        # `-f` with no commit rewrites the work tree to HEAD.
        check_switch("HEAD", segment, cwd, command, context)


def git_switch(args: list[str], cwd: Path, segment: Segment, context: Context) -> None:
    command = "git switch"
    if any(word == "--orphan" or word.startswith("--orphan=") for word in args):
        raise Refused(f"`git switch --orphan` removes every tracked file, the guard's own among them, and {WAY_OUT}")
    options, before, after = parse_options(args, SWITCH, command)
    if after or len(before) > 1:
        raise Refused(f"`{command}` in this shape is not read here, and {WAY_OUT}")
    if not before:
        if not any(name in options for name in ("-c", "-C", "--create", "--force-create")):
            raise Refused(f"`{command}` with no branch is not read here, and {WAY_OUT}")
        if any(name in options for name in ("-f", "--force", "--discard-changes")):
            # A new branch at HEAD, with the work tree rewritten to HEAD.
            check_switch("HEAD", segment, cwd, command, context)
        return
    check_switch(before[0], segment, cwd, command, context)


def git_restore(args: list[str], cwd: Path, segment: Segment, context: Context) -> None:
    command = "git restore"
    options, before, after = parse_options(args, RESTORE, command)
    staged = "-S" in options or "--staged" in options
    worktree = "-W" in options or "--worktree" in options
    if staged and not worktree:
        return
    # With no path, `-p` offers every file; git refuses the rest.
    check_paths(before + after or ["."], cwd, command, context)


def git_rm(args: list[str], cwd: Path, segment: Segment, context: Context) -> None:
    command = "git rm"
    options, before, after = parse_options(args, RM, command)
    if any(name in options for name in ("--cached", "-n", "--dry-run")):
        return
    check_paths(before + after or ["."], cwd, command, context)


def git_mv(args: list[str], cwd: Path, segment: Segment, context: Context) -> None:
    command = "git mv"
    options, before, after = parse_options(args, MV, command)
    if "-n" in options or "--dry-run" in options:
        return
    check_paths(before + after or ["."], cwd, command, context)


def git_reset(args: list[str], cwd: Path, segment: Segment, context: Context) -> None:
    for word in args:
        if word.startswith("--") and len(word) > 3 and any(mode.startswith(word) for mode in ("--hard", "--merge", "--keep")):
            raise Refused(
                f"`git reset {word}` rewrites the work tree, the guard's own files among them, "
                f"and {WAY_OUT}: use `git reset --soft` or `--mixed`, then restore named paths "
                "with `git restore -- <path>`"
            )
    parse_options(args, RESET, "git reset")


def git_read_tree(args: list[str], cwd: Path, segment: Segment, context: Context) -> None:
    parse_options(args, READ_TREE, "git read-tree")


def git_config(args: list[str], cwd: Path, segment: Segment, context: Context) -> None:
    command = "git config"
    if args[:1] in (["get"], ["list"]):
        parse_options(args[1:], CONFIG, command)
        return
    options, before, after = parse_options(args, CONFIG, command)
    # `git config <name>` alone reads that name.
    reads = any(name in CONFIG_READS for name in options) or (len(before) == 1 and not after)
    if not reads:
        raise Refused(
            f"`{command}` that sets a value can make git run any program (`core.fsmonitor`, "
            f"`core.hooksPath`), and {WAY_OUT}"
        )


def git_apply(args: list[str], cwd: Path, segment: Segment, context: Context) -> None:
    command = "git apply"
    passed: list[str] = []
    rest: list[str] = []
    for word in args:
        if len(word) > 2 and word[:2] in ("-p", "-C") and word[2:].isdigit():
            if word[:2] == "-p":
                passed.append(word)
            continue
        rest.append(word)
    options, before, after = parse_options(rest, APPLY, command)
    reads = {"--check", "--stat", "--numstat", "--summary"}
    if any(name in options for name in reads):
        return
    if "--cached" in options and "--index" not in options:
        return
    patches = before + after
    if not patches or "-" in patches:
        raise Refused(f"`{command}` reading a patch from its input cannot be read here, and {WAY_OUT}: name the patch file")
    require_alone(segment, command)
    for name, given in options.items():
        if name in APPLY_PATH_OPTIONS:
            passed.extend(name if value is None else f"{name}={value}" for value in given)
    files: list[str] = []
    for raw in patches:
        resolved = context.boundary.resolve_shell_path(raw, cwd)
        if resolved is None:
            raise Refused(f"`{command}` names `{raw}`, which this guard cannot resolve, and {WAY_OUT}")
        files.append(str(resolved))
    result = context.git(cwd, "apply", "--numstat", "-z", *passed, "--", *files)
    if result.returncode != 0:
        raise Refused(f"`{command}`: this guard could not read the patch's paths, and {WAY_OUT}")
    for path in numstat_paths(result.stdout):
        for base in (context.root, cwd):
            fence = context.fence_reached(base / path)
            if fence is not None:
                raise Refused(
                    f"`{command}` would write {path}, which reaches {fence[0]}, {fence[1]}; {WAY_OUT}"
                )


def numstat_paths(output: str) -> list[str]:
    """Paths `git apply --numstat -z` lists: each record is
    `added<TAB>deleted<TAB>path<NUL>`, or for a rename the path left empty
    and `old<NUL>new<NUL>` after it."""

    parts = output.split("\0")
    paths: list[str] = []
    index = 0
    while index < len(parts):
        record = parts[index]
        index += 1
        if not record:
            continue
        fields = record.split("\t", 2)
        if len(fields) != 3:
            raise Refused(f"`git apply --numstat` gave a record this guard cannot read, and {WAY_OUT}")
        if fields[2]:
            paths.append(fields[2])
        else:
            paths.extend(parts[index : index + 2])
            index += 2
    return paths


GIT_HANDLERS: dict[str, Callable[[list[str], Path, Segment, Context], None]] = {
    "checkout": git_checkout,
    "switch": git_switch,
    "restore": git_restore,
    "rm": git_rm,
    "mv": git_mv,
    "reset": git_reset,
    "read-tree": git_read_tree,
    "config": git_config,
    "apply": git_apply,
}


def judge_package_manager(name: str, words: list[str], segment: Segment) -> None:
    if name == "pnpm":
        judge_pnpm(words, segment)
        return
    installs = {"npm": NPM_INSTALLS, "yarn": YARN_INSTALLS, "bun": BUN_INSTALLS}.get(name)
    if installs is None:
        raise Refused(f"`{name}` installs and runs packages, and {WAY_OUT}: use `{FROZEN}`")
    if name == "yarn" and len(words) == 1:
        raise Refused(f"`yarn` installs packages into node_modules, and {WAY_OUT}: use `{FROZEN}`")
    found = next((word for word in words[1:] if word in installs), None)
    if found is not None:
        raise Refused(f"`{name} {found}` installs or rewrites packages, and {WAY_OUT}: use `{FROZEN}`")


def judge_pnpm(words: list[str], segment: Segment) -> None:
    index = 1
    while index < len(words) and words[index].startswith("-"):
        option = words[index]
        if option in PNPM_GLOBAL_VALUES:
            index += 2
        elif option in PNPM_GLOBAL_FLAGS or option.split("=", 1)[0] in {"--dir", "--filter", "--reporter", "--workspace-concurrency"}:
            index += 1
        else:
            raise Refused(f"`pnpm {option}` before the subcommand is not read here, and {WAY_OUT}")
    if index >= len(words):
        return
    sub = words[index]
    if sub not in PNPM_INSTALLS:
        return
    rest = set(words[index + 1 :])
    frozen = (
        index == 1
        and sub in ("install", "i")
        and FROZEN_REQUIRED <= rest
        and rest <= FROZEN_ALLOWED
        and len(rest) == len(words) - 2
    )
    if not frozen:
        raise Refused(
            f"`pnpm {sub}` can rewrite node_modules, where the guards are installed, or the "
            f"files that pin them, and {WAY_OUT}: only `{FROZEN}` runs here"
        )
    require_alone(segment, FROZEN)
