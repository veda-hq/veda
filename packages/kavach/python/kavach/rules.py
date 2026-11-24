"""Rules that hold a lesson: each reads one tool call and names a mistake.

Each rule turns a lesson agents kept relearning into a check at the moment
it matters. A rule has an id, the tools it reads and a detector that returns
what is wrong with the call, or None. The command guard runs the Bash rules
(command_guard.py) and the tool guard every other tool's (tool_guard.py).

A new rule warns before it refuses, since a wrong refusal would stop every
session at once: its mode is "warn" until the consumer's settings say
"refuse" (config.py, ``rules``). Warning, the call runs and the agent reads
the reason; refusing, the guard exits 2 with it. Each fire is a row of the
refusal log naming the rule and its mode, so a trial's fires can be read for
wrong ones before the switch. A finding whose call would leave the session
where a warning cannot help in time is a ``Refuses``, which refuses whatever
the mode. While a rule warns, an error in its detector allows the call and logs a row naming the error's type; once it refuses, the
error refuses too, as every other check does.

The rules (README, "Rules that hold a lesson"):

- ``pipe-masks-exit``: ``cmd | tail && git push`` pushes even when ``cmd``
  failed, since a pipeline exits with its last command's status.
- ``cd-out-of-worktree``: a ``cd`` or ``pushd`` that leaves the session's
  checkout strands every later call of the turn outside it. One to a folder
  in no git repository refuses even on trial: from there the worktree guard
  runs reads only. From a checkout no session can own (another repository, or
  a main checkout other than the ``worktree.ownCheckout`` clone), the ``cd``
  back into one a session can own passes (veda#339). Where the desktop app's
  record names the session's worktree, a ``cd`` into it passes from anywhere,
  another session's worktree included, and a finding names it (veda#362).
- ``stryker-inplace``: ``stryker run --inPlace``, or a Stryker config written
  with ``inPlace: true``, mutates the real files and restores them only after
  a run that finishes.
- ``checkout-discards-uncommitted``: ``git checkout -- <path>``, ``--ours``,
  ``--theirs`` and ``git restore`` overwrite a path's uncommitted changes.
- ``commit-body-ref-line-length``: commitlint reads a body line holding
  ``#<number>`` as a footer and fails it over 100 characters, after every
  other hook has run.
- ``case-fold-path-collision``: a Write to a name that differs only by case
  from another file in its folder overwrites that file on a case-insensitive
  filesystem.
- ``routine-sources-shape``: a RemoteTrigger routine whose
  ``session_context.sources`` entries lack a ``git_repository`` object is
  accepted with its repository dropped.
- ``sync-base-on-origin``: the desktop app's sync-with-base-branch tool with
  no ``base`` merges the branch the worktree was first cut from, which may be
  gone; a base origin lacks fails at fetch.
- ``workflow-name-in-worktree``: ``Workflow({name})`` runs the main
  checkout's script, so from a worktree whose copy differs the branch's edits
  are ignored.
"""

from __future__ import annotations

import json
import os
import posixpath
import re
import subprocess
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Sequence

def parse(command: str) -> list[Any]:
    """git_safety.py's reading of a script, loaded only when a rule needs it:
    a call no rule has a word for costs no lexing. Run as a guard, the module
    comes from this folder only (sys.path[0]); imported as the package (the
    tests), from the package."""

    if __package__:
        from . import git_safety
    else:
        import git_safety  # type: ignore[no-redef]
    return git_safety.parse(command)


@dataclass(frozen=True)
class Call:
    """One tool call as a rule reads it."""

    tool: str
    tool_input: dict[str, Any]
    cwd: str
    # The consumer's settings, which ``judge`` hands every detector.
    settings: Any = field(default=None, compare=False)
    # The payload's ``session_id``, which names the desktop app's record of
    # the session (``boundary.session_worktree``).
    session_id: str | None = field(default=None, compare=False)


@dataclass(frozen=True)
class Rule:
    id: str
    tools: tuple[str, ...]
    detect: Callable[[Call], "str | None"]


class Refuses(str):
    """A finding that refuses whatever its rule's mode: its call would leave
    the session where a warning cannot help in time (a shell in a folder from
    which only reads run). A detector returns it in place of a plain ``str``."""


@dataclass(frozen=True)
class Fire:
    rule: str
    mode: str
    message: str
    refuses_from: str = ""


@dataclass
class Outcome:
    refusals: list[Fire]
    warnings: list[Fire]


# ---------------------------------------------------------------------------
# Reading a Bash command.
# ---------------------------------------------------------------------------


def program(word: Any) -> str:
    """The program a command word names, by its last path part."""

    return posixpath.basename(word.text) if word is not None and not word.dynamic else ""


def literal(word: Any) -> str | None:
    """A word's text when nothing in it is computed at run time."""

    return None if word.dynamic else word.text


GIT_VALUE_OPTIONS = {"-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--attr-source", "--exec-path", "--super-prefix"}


def git_subcommand(words: Sequence[Any], cwd: str) -> tuple[str, list[Any], str] | None:
    """For a ``git`` command: its subcommand, the words after it and the
    folder it runs in (``-C`` applied). None when it is not git, or the
    subcommand or a ``-C`` folder is computed at run time."""

    if not words or program(words[0]) != "git":
        return None
    index, where = 1, cwd
    while index < len(words):
        text = literal(words[index])
        if text is None:
            return None
        if text in GIT_VALUE_OPTIONS:
            if index + 1 >= len(words):
                return None
            if text == "-C":
                value = literal(words[index + 1])
                if value is None:
                    return None
                where = posixpath.normpath(posixpath.join(where, value))
            index += 2
            continue
        if text.startswith("-"):
            index += 1
            continue
        return text, list(words[index + 1 :]), where
    return None


def tilde(text: str) -> str:
    if text == "~" or text.startswith("~/"):
        return os.path.expanduser("~") + text[1:]
    return text


@dataclass
class Step:
    """One simple command of a script, with the folder it runs in."""

    command: Any
    cwd: str
    # The next command reads this one's output (`a | b`: a's step).
    pipes_on: bool


def steps(command: str, cwd: str) -> list[Step]:
    """The script's simple commands, each with the folder it runs in: a
    literal top-level ``cd`` or ``pushd`` moves the folder for what follows
    it; one in a subshell or a pipeline moves nothing after it."""

    commands = parse(command)
    found: list[Step] = []
    where = cwd
    for index, item in enumerate(commands):
        following = commands[index + 1] if index + 1 < len(commands) else None
        pipes_on = following is not None and following.piped_from is item
        found.append(Step(item, where, pipes_on))
        if item.depth == 0 and not pipes_on and item.piped_from is None:
            moved = cd_target(item, where)
            if moved is not None:
                where = moved
    return found


def cd_target(command: Any, cwd: str) -> str | None:
    """Where a literal ``cd``/``pushd`` goes, or None (not one, ``cd -``, a
    computed target, an option it does not read)."""

    words = command.words
    if not words or words[0].dynamic or words[0].text not in ("cd", "pushd"):
        return None
    if any(word.dynamic for word in words[1:]):
        return None
    # `cd -P x` and `cd -L x` still move to x; `cd -` and `pushd +1` go
    # where the directory stack says, which this reading does not know.
    operands = [word.text for word in words[1:] if word.text == "-" or not word.text.startswith("-")]
    if not operands:
        return os.path.expanduser("~") if words[0].text == "cd" else None
    target = operands[0]
    if target == "-" or target.startswith("+"):
        return None
    return posixpath.normpath(posixpath.join(cwd, tilde(target)))


def bash_command(call: Call) -> str:
    command = call.tool_input.get("command", "")
    return command if isinstance(command, str) else ""


# ---------------------------------------------------------------------------
# The Bash rules.
# ---------------------------------------------------------------------------


def pushes(command: Any, cwd: str) -> bool:
    found = git_subcommand(command.words, cwd)
    return found is not None and found[0] == "push"


def pipe_masks_exit(call: Call) -> str | None:
    script = bash_command(call)
    if "push" not in script or not re.search(r"\b(?:tail|head)\b", script):
        return None
    if re.search(r"pipefail", script):
        return None
    walked = steps(script, call.cwd)
    for index, step in enumerate(walked):
        if not pushes(step.command, step.cwd):
            continue
        back = index
        while back > 0 and walked[back].command.follows == "&&":
            back -= 1
            earlier = walked[back].command
            if earlier.piped_from is not None and program(earlier.words[0] if earlier.words else None) in ("tail", "head"):
                return (
                    f"`... | {program(earlier.words[0])} && git push` pushes even when the command before the "
                    f"pipe failed: a pipeline exits with its last command's status, here {program(earlier.words[0])}'s, "
                    "which is 0. Run the check on its own (in the background if it is long), read its result, "
                    "then push in a separate call; or start the line with `set -o pipefail`."
                )
    return None


def git_toplevel(cwd: str) -> str | None:
    try:
        done = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    top = done.stdout.strip()
    return top if done.returncode == 0 and top else None


def session_checkout(cwd: str) -> str | None:
    """The checkout the session works in: the git work tree holding ``cwd``.

    A clone nested inside a work tree (a scratch clone under ``.tmp/``) is
    part of the work tree around it, so from inside one the outer checkout
    counts. A linked worktree is never climbed out of, though it sits inside
    the main checkout's folder: its ``.git`` is a file, not a folder."""

    top = git_toplevel(cwd)
    for _ in range(8):
        if top is None or not os.path.isdir(os.path.join(top, ".git")):
            return top
        outer = git_toplevel(os.path.dirname(top))
        if outer is None or outer == top:
            return top
        top = outer
    return top


def inside(path: str, root: str) -> bool:
    path, root = os.path.realpath(path), os.path.realpath(root)
    return path == root or path.startswith(root.rstrip("/") + "/")


def peer_worktree(target: str, root: str) -> str | None:
    """The other worktree of ``root``'s repository that holds ``target``."""

    try:
        done = subprocess.run(
            ["git", "-C", root, "worktree", "list", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    trees = [line[len("worktree ") :] for line in done.stdout.splitlines() if line.startswith("worktree ")]
    holding = [tree for tree in trees if inside(target, tree) and not inside(root, tree)]
    return max(holding, key=len) if holding else None


def ownable(folder: str, settings: Any) -> bool:
    """Whether the checkout holding ``folder`` is one the worktree guard takes
    as a session's own: a linked worktree under its repository's
    ``.claude/worktrees``, or the ``worktree.ownCheckout`` clone. The guard's
    own test (``boundary.ownable_checkout``), so the two cannot disagree."""

    if __package__:
        from . import boundary
    else:
        import boundary  # type: ignore[no-redef]
    own = getattr(settings, "own_checkout", None)
    return boundary.ownable_checkout(Path(folder), own, os.environ) is not None


def recorded_worktree(call: Call) -> str | None:
    """The worktree the desktop app's record names as this session's
    (``boundary.session_worktree``), or ``None`` with no record that fits."""

    if __package__:
        from . import boundary
    else:
        import boundary  # type: ignore[no-redef]
    own = getattr(call.settings, "own_checkout", None)
    found = boundary.session_worktree(call.session_id, own, os.environ)
    return str(found) if found is not None else None


# Not yet read: ``recorded_worktree`` runs at most once per call.
UNREAD = object()


def cd_out_of_worktree(call: Call) -> str | None:
    script = bash_command(call)
    if not re.search(r"\b(?:cd|pushd)\b", script):
        return None
    root: str | None = None
    owned: bool | None = None
    recorded: Any = UNREAD
    for step in steps(script, call.cwd):
        command = step.command
        if command.depth != 0 or step.pipes_on or command.piped_from is not None:
            continue
        target = cd_target(command, step.cwd)
        if target is None:
            continue
        if root is None:
            root = session_checkout(call.cwd)
            if root is None:
                return None
        if inside(target, root):
            continue
        if owned is None:
            # Only for a cd that leaves the checkout: one inside it costs no
            # git starts, and an error here cannot refuse it.
            owned = ownable(root, call.settings)
        if not owned and os.path.isdir(target) and ownable(target, call.settings):
            # The shell is in a checkout no session owns, so this rule has no
            # checkout of the session's to keep it in. A cd into one a session
            # can own is the way back, and refusing it strands the session
            # where the worktree guard refuses every write (veda#339). A later
            # cd in the same command is judged from the checkout it entered.
            root, owned = session_checkout(target) or target, True
            continue
        if recorded is UNREAD:
            # The desktop app's record names the session's worktree where the
            # hook input does not: from another session's worktree, which
            # looks ownable, the cd back is told apart (veda#362).
            recorded = recorded_worktree(call)
        if recorded is not None and inside(target, recorded):
            root, owned = recorded, True
            continue
        moves =f"`{command.words[0].text} {target}` moves the shell"
        elsewhere = recorded is not None and not inside(root, recorded)
        whose = "this session's" if owned and not elsewhere else "its"
        if elsewhere:
            # The shell's checkout is not the one the record names: name that
            # one as the session's, and the way back to it.
            mine = f" (the shell is in {root}; {recorded} is this session's)"
            back = f"`cd {recorded}` brings it back"
            stay = "Read elsewhere with absolute paths, `git -C <dir>` or `ls <dir>`."
        elif owned:
            mine = f" ({root} is this session's)"
            back = f"`cd {root}` brings it back"
            stay = "Stay in the checkout: read elsewhere with absolute paths, `git -C <dir>` or `ls <dir>`."
        else:
            # Which checkout is this session's, the hook input does not say:
            # the message names none.
            mine = f" (the shell is in {root}, which the worktree guard takes as no session's own)"
            back = "a `cd` into your own worktree brings it back"
            stay = "Read elsewhere with absolute paths, `git -C <dir>` or `ls <dir>`."
        if os.path.isdir(target) and git_toplevel(target) is None:
            # From a folder no repository holds, the worktree guard finds no
            # checkout and runs reads only (veda#335): a session whose shell
            # Claude Code keeps there can write nothing until it returns.
            return Refuses(
                f"{moves} outside {whose} checkout{mine}, to a "
                "folder in no git repository. Where the shell keeps that folder for later calls, the "
                f"guards run only reads from there: no write, Edit or Write until {back}. "
                f"This refuses even while the rule is on trial. {stay}"
            )
        peer = peer_worktree(target, root)
        where = (
            f"another worktree, {peer}, which another session may own"
            if peer is not None
            else f"outside {whose} checkout"
        )
        return (
            f"{moves} to {where}{mine}. "
            "Where the shell keeps that folder for later calls, each of them runs outside the checkout, "
            f"where the guards refuse every write until {back}. {stay}"
        )
    return None


# What runs stryker: itself, or a package runner naming it.
STRYKER_RUNNERS = {"stryker", "npx", "pnpm", "yarn", "bunx", "npm"}


STRYKER_CONFIG = re.compile(r"^stryker(?:\.[\w-]+)*\.(?:conf|config)\.(?:[cm]?js|[cm]?ts|json)$")
IN_PLACE_TRUE = re.compile(r"""["']?\binPlace\b["']?\s*:\s*true\b""")
IN_PLACE_REASON = (
    "Stryker's --inPlace mutates your real files, and disableTypeChecks writes "
    "`// @ts-nocheck` into them; they are restored only after a run that finishes, so an "
    "interrupted run leaves mutated sources behind."
)


def stryker_inplace(call: Call) -> str | None:
    if call.tool == "Bash":
        return stryker_inplace_command(call)
    path = call.tool_input.get("file_path")
    if not isinstance(path, str) or not STRYKER_CONFIG.search(os.path.basename(path)):
        return None
    texts = [call.tool_input.get(key) for key in ("content", "new_string")]
    edits = call.tool_input.get("edits")
    if isinstance(edits, list):
        texts.extend(edit.get("new_string") for edit in edits if isinstance(edit, dict))
    if any(isinstance(text, str) and IN_PLACE_TRUE.search(text) for text in texts):
        return (
            f"this sets `inPlace: true` in {os.path.basename(path)}. {IN_PLACE_REASON} Leave inPlace "
            "out (Stryker's sandbox is the default)."
        )
    return None


def stryker_inplace_command(call: Call) -> str | None:
    script = bash_command(call)
    if "inPlace" not in script or "stryker" not in script:
        return None
    for step in steps(script, call.cwd):
        words = step.command.words
        names = [program(word) for word in words]
        if "stryker" not in names or names[0] not in STRYKER_RUNNERS:
            continue
        after = words[names.index("stryker") + 1 :]
        for word in after:
            text = literal(word) or ""
            if text == "--inPlace" or (text.startswith("--inPlace=") and text.split("=", 1)[1] != "false"):
                return (
                    f"{IN_PLACE_REASON} Run it in its sandbox (drop --inPlace), for one file "
                    "`stryker run <config> --mutate <file>`."
                )
    return None


def uncommitted(paths: Sequence[str], cwd: str) -> list[str]:
    """Which of ``paths`` hold uncommitted changes (staged, unstaged or in
    conflict), by ``git status``. Raises when git cannot say."""

    done = subprocess.run(
        ["git", "-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=no", "--", *paths],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    if done.returncode != 0:
        raise RuntimeError("git status failed")
    return [entry[3:] for entry in done.stdout.split("\0") if len(entry) > 3]


def checkout_discards_uncommitted(call: Call) -> str | None:
    script = bash_command(call)
    if not re.search(r"\b(?:checkout|restore)\b", script):
        return None
    for step in steps(script, call.cwd):
        found = git_subcommand(step.command.words, step.cwd)
        if found is None or found[0] not in ("checkout", "restore"):
            continue
        sub, args, where = found
        texts = [literal(word) for word in args]
        if any(text is None for text in texts):
            continue  # a computed word: which paths it names is unknown
        words = [text for text in texts if text is not None]
        sided = next((text for text in words if text in ("--ours", "--theirs")), None)
        if "--" in words:
            split = words.index("--")
            options, paths = words[:split], words[split + 1 :]
        else:
            if sub == "checkout" and sided is None:
                continue  # a branch switch: git itself refuses to overwrite local changes
            options, paths, skip = [], [], False
            for text in words:
                if skip:
                    skip = False
                elif text.startswith("-"):
                    options.append(text)
                    skip = text in ("-s", "--source")
                else:
                    paths.append(text)
        if sub == "restore" and any(text in ("--staged", "-S") for text in options) and not any(
            text in ("--worktree", "-W") for text in options
        ):
            continue  # only the index changes; the files keep their changes
        if not paths:
            continue
        changed = uncommitted(paths, where)
        if not changed:
            continue
        shown = ", ".join(changed[:5]) + (" and more" if len(changed) > 5 else "")
        how = f"`git {sub} {sided}`" if sided else f"`git {sub}`"
        return (
            f"{how} overwrites the whole of each file it names, and {shown} holds uncommitted changes "
            "that would be lost (with --ours or --theirs, the other side's changes to the file). Resolve "
            "a conflict hunk by hunk in the file itself; to throw local work away, first keep it: commit "
            "it (a WIP commit), or `git stash push -m <tag> -- <path>` where stash runs (kavach refuses "
            "it in a cloud session's own clone), after which the path is clean and this passes."
        )
    return None


SHORT_VALUE_OPTIONS = set("mFCctS")


def commit_messages(args: Sequence[Any], cwd: str) -> list[str] | None:
    """The message paragraphs a ``git commit`` gives on its command line
    (``-m``, in order; a computed one as a blank) or the text of its ``-F``
    file; None when the file is computed at run time or cannot be read."""

    found: list[str] = []
    index = 0

    def take(value: str | None, kind: str) -> bool:
        if kind == "m":
            # A computed paragraph keeps its place, as a blank: the lines
            # around it are still the title and the body they were.
            found.append("" if value is None else value)
            return True
        if value is None:
            return False
        if value == "-":
            return False
        path = posixpath.join(cwd, tilde(value))
        try:
            with open(path, encoding="utf-8") as handle:
                found.append(handle.read())
        except (OSError, UnicodeDecodeError):
            return False
        return True

    while index < len(args):
        word = args[index]
        text = literal(word)
        index += 1
        if text is None:
            continue
        if text == "--":
            break
        if text in ("-m", "--message", "-F", "--file"):
            if index >= len(args) or not take(literal(args[index]), "m" if text in ("-m", "--message") else "F"):
                return None
            index += 1
            continue
        if text.startswith(("--message=", "--file=")):
            option, value = text.split("=", 1)
            if not take(value, "m" if option == "--message" else "F"):
                return None
            continue
        if text.startswith("-") and not text.startswith("--") and len(text) > 1:
            for at, letter in enumerate(text[1:], start=1):
                if letter in SHORT_VALUE_OPTIONS:
                    rest = text[at + 1 :]
                    if rest:
                        value: str | None = rest
                    elif index < len(args):
                        value = literal(args[index])
                        index += 1
                    else:
                        return None
                    if letter in "mF" and not take(value, letter):
                        return None
                    break
    return found


REFERENCE = re.compile(r"#[0-9]+")


def commit_body_ref_line_length(call: Call) -> str | None:
    script = bash_command(call)
    if "commit" not in script:
        return None
    for step in steps(script, call.cwd):
        found = git_subcommand(step.command.words, step.cwd)
        if found is None or found[0] != "commit":
            continue
        messages = commit_messages(found[1], found[2])
        if not messages:
            continue
        lines = "\n\n".join(messages).split("\n")[1:]
        for line in lines:
            if line.startswith("#"):
                continue  # a comment, which git strips
            if len(line) > 100 and REFERENCE.search(line):
                return (
                    f"this commit message has a body line of {len(line)} characters holding "
                    f"`{REFERENCE.search(line).group(0)}`; commitlint reads such a line as a footer and fails "
                    "footer-max-line-length (100), after every other hook has run. Wrap body lines well under "
                    "100 characters and keep issue references off long lines."
                )
    return None


# ---------------------------------------------------------------------------
# The rules for other tools.
# ---------------------------------------------------------------------------


def case_fold_path_collision(call: Call) -> str | None:
    path = call.tool_input.get("file_path")
    if not isinstance(path, str) or not path:
        return None
    if not os.path.isabs(path):
        path = os.path.join(call.cwd, path)
    folder, name = os.path.split(path)
    try:
        entries = os.listdir(folder)
    except OSError:
        return None
    if name in entries:
        return None
    twins = sorted(entry for entry in entries if entry.casefold() == name.casefold())
    if not twins:
        return None
    return (
        f"{name} differs only by letter case from {twins[0]}, already in {folder}; on a case-insensitive "
        f"filesystem (macOS APFS) this Write overwrites {twins[0]}. Name the file so it differs by more "
        "than case: key per-item files by index or a numeric id, not by a case-sensitive id."
    )


def routine_sources_shape(call: Call) -> str | None:
    if call.tool_input.get("action") not in ("create", "update"):
        return None
    body = call.tool_input.get("body")
    sources: Any = body
    for key in ("job_config", "ccr", "session_context", "sources"):
        if not isinstance(sources, dict):
            return None
        sources = sources.get(key)
    if not isinstance(sources, list):
        return None
    for at, entry in enumerate(sources):
        if not (isinstance(entry, dict) and isinstance(entry.get("git_repository"), dict)):
            return (
                f"session_context.sources[{at}] has no `git_repository` object, and the API accepts such an "
                "entry with a 200 and drops the repository. Give each source as "
                '`{"git_repository": {"url": "<url>"}}`, then check `session_request.sources` in the response.'
            )
    return None


# The desktop app's sync-with-base-branch tool. Its name and its `base` field
# are as recorded from real calls (2026-10-22); the tool was not offered to
# the session that wrote this rule, so it is tested on fixtures only.
SYNC_TOOL = "mcp__ccd_host__sync_with_base_branch"
SYNC_WAY_OUT = 'Pass `base: "main"` (or another branch that exists on origin).'


def sync_base_on_origin(call: Call) -> str | None:
    base = call.tool_input.get("base")
    if base is None or base == "":
        return (
            "the sync-with-base-branch tool with no `base` merges the branch this worktree was first cut "
            "from, which in a reused worktree may since have been deleted, and the sync then fails at "
            "fetch. " + SYNC_WAY_OUT
        )
    if not isinstance(base, str):
        return None
    name = base[len("origin/") :] if base.startswith("origin/") else base
    # The remote-tracking ref, not the network: a hook has no credentials of
    # its own, and a fetch would cost every call.
    done = subprocess.run(
        ["git", "-C", call.cwd, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{name}"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    if done.returncode == 0:
        return None
    if git_toplevel(call.cwd) is None:
        return None
    return (
        f"`base: {json.dumps(base)}` names no branch this checkout knows on origin "
        f"(no refs/remotes/origin/{name}), so the sync would fail at fetch. " + SYNC_WAY_OUT
    )


def workflow_files(folder: str, name: str) -> dict[str, bytes]:
    """The workflow scripts named ``name`` in a checkout's .claude/workflows,
    by file name, with their bytes."""

    directory = os.path.join(folder, ".claude", "workflows")
    try:
        entries = os.listdir(directory)
    except OSError:
        return {}
    found: dict[str, bytes] = {}
    for entry in entries:
        if os.path.splitext(entry)[0] != name:
            continue
        try:
            with open(os.path.join(directory, entry), "rb") as handle:
                found[entry] = handle.read()
        except OSError:
            continue
    return found


def main_checkout(top: str) -> str | None:
    """The main checkout of the repository whose worktree is ``top``."""

    done = subprocess.run(
        ["git", "-C", top, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    common = done.stdout.strip()
    return os.path.dirname(common) if done.returncode == 0 and common else None


def workflow_name_in_worktree(call: Call) -> str | None:
    """`Workflow({name})` resolves the script from the main checkout's
    .claude/workflows, not the worktree's (recorded 2026-09-03; the tool was
    not offered to the session that wrote this rule: fixtures only)."""

    name = call.tool_input.get("name")
    if not isinstance(name, str) or not name or call.tool_input.get("scriptPath"):
        return None
    top = git_toplevel(call.cwd)
    if top is None or not os.path.isfile(os.path.join(top, ".git")):
        return None  # not a linked worktree: the name resolves where the session is
    main = main_checkout(top)
    if main is None or os.path.realpath(main) == os.path.realpath(top):
        return None
    mine, theirs = workflow_files(top, name), workflow_files(main, name)
    if not mine or mine == theirs:
        return None
    script = os.path.join(top, ".claude", "workflows", sorted(mine)[0])
    return (
        f"`Workflow({{name: {json.dumps(name)}}})` runs the main checkout's copy in {main}, and this "
        "worktree's differs (or the main checkout has none), so the branch's edits are ignored. Pass "
        f"`scriptPath: {json.dumps(script)}` with the same args."
    )


RULES: tuple[Rule, ...] = (
    Rule("pipe-masks-exit", ("Bash",), pipe_masks_exit),
    Rule("cd-out-of-worktree", ("Bash",), cd_out_of_worktree),
    Rule("stryker-inplace", ("Bash", "Write", "Edit", "MultiEdit"), stryker_inplace),
    Rule("checkout-discards-uncommitted", ("Bash",), checkout_discards_uncommitted),
    Rule("commit-body-ref-line-length", ("Bash",), commit_body_ref_line_length),
    Rule("case-fold-path-collision", ("Write",), case_fold_path_collision),
    Rule("routine-sources-shape", ("RemoteTrigger",), routine_sources_shape),
    Rule("sync-base-on-origin", (SYNC_TOOL,), sync_base_on_origin),
    Rule("workflow-name-in-worktree", ("Workflow",), workflow_name_in_worktree),
)

# The tools the tool guard reads: give its hook this matcher.
TOOL_MATCHER = "|".join(dict.fromkeys(tool for rule in RULES for tool in rule.tools if tool != "Bash"))


# ---------------------------------------------------------------------------
# Judging a call.
# ---------------------------------------------------------------------------


def judge(call: Call, settings: Any, fired: Callable[[str, str, str], None] | None = None) -> Outcome:
    """Run every rule for ``call.tool`` in the mode ``settings`` gives it.

    A refusing rule's error is raised (the guard's entry refuses on it); a
    warning rule's error is reported to ``fired`` and allows."""

    outcome = Outcome([], [])
    call = replace(call, settings=settings)
    for rule in RULES:
        if call.tool not in rule.tools:
            continue
        mode, refuses_from = mode_of(settings, rule.id)
        try:
            message = rule.detect(call)
        except Exception as error:
            if mode == "refuse":
                raise
            if fired is not None:
                fired(
                    rule.id,
                    mode,
                    f"the {rule.id} check failed ({type(error).__name__}), so it did not judge this call; "
                    "the call was allowed.",
                )
            continue
        if message is None:
            continue
        if isinstance(message, Refuses):
            mode = "refuse"
        if fired is not None:
            fired(rule.id, mode, message)
        fire = Fire(rule.id, mode, message, refuses_from)
        (outcome.refusals if mode == "refuse" else outcome.warnings).append(fire)
    return outcome


def mode_of(settings: Any, rule: str) -> tuple[str, str]:
    chosen = dict(getattr(settings, "rules", None) or ()).get(rule)
    if chosen is None:
        return "warn", ""
    return chosen.mode, chosen.refuses_from


def refusal(fires: Sequence[Fire]) -> str:
    return "\n".join(f"BLOCKED: {fire.message} (kavach rule {fire.rule})" for fire in fires)


def context(fire: Fire) -> str:
    when = f"refuses from {fire.refuses_from}" if fire.refuses_from else "refuses after its trial"
    return (
        f"kavach warning, rule {fire.rule} ({when}): {fire.message} This call still runs while the rule is "
        "on trial."
    )


def answer(contexts: Sequence[str]) -> str:
    """One PreToolUse answer that allows the call and shows every warning."""

    return json.dumps(
        {"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "\n\n".join(contexts)}}
    )


def read_call(raw: str) -> Call | None:
    """The tool call a PreToolUse payload carries; None when it is malformed."""

    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):
        return None
    if not isinstance(data, dict):
        return None
    tool, tool_input, cwd = data.get("tool_name"), data.get("tool_input"), data.get("cwd")
    if not isinstance(tool, str) or not isinstance(tool_input, dict):
        return None
    session = data.get("session_id")
    return Call(
        tool,
        tool_input,
        cwd if isinstance(cwd, str) and os.path.isabs(cwd) else os.getcwd(),
        session_id=session if isinstance(session, str) else None,
    )
