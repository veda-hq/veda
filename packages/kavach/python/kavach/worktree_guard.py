#!/usr/bin/env python3
"""Claude Code PreToolUse adapter for the shared deterministic shell/path boundary.

The boundary module (``boundary.py``, beside this file) supplies parsing
only; this adapter owns Claude event semantics and requires this session's own
Claude-managed checkout. The consumer's settings (``config.py``, named by the
environment variable ``KAVACH_CONFIG``) are read once per event here and
handed down; a settings file that cannot be used refuses every event.

One thing a Claude session mutates that is not repository state: its own
agent-memory directory. Claude Code keeps that outside every checkout, so the
worktree boundary below has nothing to protect there and would otherwise make
the memory permanently unwritable — a session is told to record findings and
then blocked with a message about worktrees. ``claude_memory_root`` derives
that single directory from the checkout this session is already in and allows
writes confined to it.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from types import ModuleType
from typing import Any, NoReturn


HERE = Path(__file__).resolve().parent


# Claude Code lets a hook's exit 1 through, so an error in this guard or in the
# boundary it loads would wave every mutation on. Any failure refuses instead,
# naming the error. Not caught here: an interpreter that cannot start or is
# killed, and a syntax error in this file, which the guard's behaviour suite
# (`tests/test_worktree_guard.py`) exists to catch before it ships.
def refuse(reason: str) -> NoReturn:
    print(f"BLOCKED: {reason}", file=sys.stderr)
    raise SystemExit(2)


def is_exit(error: SystemExit, *codes: int) -> bool:
    """Whether ``error`` exits with one of ``codes``, as an int: Python exits 1
    for ``SystemExit(2.0)`` although ``2.0 == 2``."""

    return type(error.code) is int and error.code in codes


def failure(error: BaseException) -> str:
    if isinstance(error, SystemExit):
        return f"exit {error.code!r} instead of a verdict"
    return f"{type(error).__name__}: {error}"


def load_module(name: str, path: Path, *, register: bool = False) -> ModuleType:
    """A module of this package, by file; a module that fails to load refuses.

    Loaded by path rather than imported, so the guard runs as a plain script
    from wherever the package is installed. With ``register`` the module is
    entered in ``sys.modules`` under ``name`` while it runs, which a dataclass
    module needs; a load that fails puts back whatever was there.

    Loading has no verdict to give, so any exit but a refusal (2) refuses too:
    an exit 0 here would skip the check, an exit 1 would wave the call on.
    """

    previous = sys.modules.get(name)

    def forget() -> None:
        if not register:
            return
        if previous is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = previous

    try:
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"no loader for {path}")
        module = importlib.util.module_from_spec(spec)
        if register:
            sys.modules[name] = module
        spec.loader.exec_module(module)
    except SystemExit as error:
        forget()
        if is_exit(error, 2):
            raise
        refuse(
            f"the ownership guard could not load {path.name} ({failure(error)}), "
            "so it cannot judge this call"
        )
    except BaseException as error:
        forget()
        refuse(
            f"the ownership guard could not load {path.name} ({failure(error)}), "
            "so it cannot judge this call"
        )
    return module


def load_boundary(path: Path) -> ModuleType:
    """The shared shell/path boundary; a module that fails to load refuses."""

    return load_module("kavach_worktree_boundary", path)


def load_config(path: Path) -> ModuleType:
    """The settings loader; a module that fails to load refuses."""

    return load_module("kavach_worktree_config", path, register=True)


boundary = load_boundary(HERE / "boundary.py")
config = load_config(HERE / "config.py")
refusal_log = load_module("kavach_worktree_refusal_log", HERE / "refusal_log.py")


def settings() -> Any:
    """The consumer's settings (``config.Config``); unusable settings refuse.

    A guard that misread what it trusts must not allow, so an unreadable,
    malformed or wrongly shaped settings file refuses this event, naming why.
    """

    try:
        return config.load()
    except config.ConfigError as error:
        refuse(
            f"the ownership guard cannot use its settings ({error}), "
            "so it cannot judge this call"
        )


def config_root() -> Path:
    """The Claude Code configuration directory this session is using."""

    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".claude"


def settings_memory_directory(home: Path) -> Path | None:
    """``autoMemoryDirectory`` from settings this session cannot rewrite.

    Claude Code reads that key from every settings scope, project and local
    included. This deliberately reads only the USER file, because for a guard
    the key is a scope-WIDENING primitive rather than a preference, and
    ``.claude/settings*`` live inside the worktree the guard gates: honouring
    them would let a session nominate its own exemption -- write the key, then
    write wherever it pointed. A boundary the guarded party can edit is not one.

    Claude Code's own permission model draws the same line. It withholds the
    other widening keys, ``permissions.allow`` and ``additionalDirectories``,
    from project settings until the folder is trusted, and its docs warn that
    ``disableAllHooks`` cannot be enforced from user settings "because the
    repository's project settings take precedence over yours". The trust dialog
    is also never shown to a ``claude -p`` or SDK session -- which is how
    subagents and scripted workflows commonly run.

    The cost is stated rather than hidden: set the key in project or local
    settings and memory writes are refused, with ``denial`` naming the path it
    looked at. Put it in the user file and it is honoured.
    """

    try:
        raw = json.loads((home / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = raw.get("autoMemoryDirectory") if isinstance(raw, dict) else None
    # Claude Code accepts only an absolute path or one starting with "~/".
    if not isinstance(value, str) or not value.startswith(("/", "~/")):
        return None
    return Path(value).expanduser()


def project_state_root(checkout: Path) -> Path:
    """``projects/<slug>``: Claude Code's own state directory for a checkout.

    Two resolutions, in Claude Code's own precedence:

    1. ``CLAUDE_CODE_PROJECT_DIR_NAME``, which Claude Code honours only beside
       ``CLAUDE_CONFIG_DIR``, replaces the derived name. It is read once from
       the launching shell -- a settings ``env`` block cannot supply it -- so a
       session cannot set it for itself. The pattern keeps it to ONE path
       segment, which is what stops a traversal out of ``projects/``.
    2. Otherwise a slug of the checkout path, every character outside
       ``[A-Za-z0-9]`` replaced by ``-``.

    Nothing here is accepted from a tool call: a mutation event cannot nominate
    a directory to be exempted.
    """

    home = config_root()
    name = os.environ.get("CLAUDE_CODE_PROJECT_DIR_NAME")
    if os.environ.get("CLAUDE_CONFIG_DIR") and name and re.fullmatch(
        r"[A-Za-z0-9_-]{1,64}", name
    ):
        return home / "projects" / name
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(checkout))
    return home / "projects" / slug


def memory_path(primary: Path) -> Path:
    """Where Claude Code keeps this project's agent memory, existence aside.

    ``autoMemoryDirectory`` relocates the directory wholesale; otherwise it is
    ``memory`` under the project state root above.

    The slug is taken from the PRIMARY checkout because auto memory is keyed on
    the git repository: every worktree of this repo shares one memory directory,
    which is the whole reason a finding survives the worktree that learned it.
    """

    override = settings_memory_directory(config_root())
    if override is not None:
        return override
    return project_state_root(primary) / "memory"


def claude_memory_root(primary: Path) -> Path | None:
    """The agent-memory directory when it is real, otherwise ``None``.

    Fails closed on anything that is not already a plain directory. A symlink
    at the memory directory or at the project directory above it could aim the
    allowance at a checkout, another provider's tree, or anywhere else, so both
    are refused; an absent directory is refused because a permitted ``mkdir``
    under ``projects/`` would widen this from one known path to a namespace.

    The last check holds no matter how the path was resolved: memory may never
    be, contain, or sit inside the repository. Without it a relocated memory
    directory naming a checkout would hand back exactly the writes the worktree
    boundary exists to refuse.

    This is proportionate rather than absolute. The threat model is a session
    confusing itself about which tree it owns, not a hostile ``~/.claude`` --
    whoever controls that directory already writes the session's instructions.
    """

    memory = memory_path(primary)
    project = memory.parent
    if project.is_symlink() or memory.is_symlink() or not memory.is_dir():
        return None
    resolved, checkout = memory.resolve(), primary.resolve()
    if boundary.is_inside(resolved, checkout) or boundary.is_inside(
        checkout, resolved
    ):
        return None
    return resolved


def lands_in_a_checkout(directory: Path) -> bool:
    """Whether ``directory``, once resolved, sits inside ANY git work tree.

    This is the invariant the namespace claims -- that it holds no repository
    state -- tested directly rather than through a proxy. It holds however the
    path came to point there, so a redirection from a component ABOVE the
    config directory, which no symlink check inside that directory can see, is
    still caught.

    It is deliberately a test of where the path ENDS UP rather than of whether
    a symlink exists on the way. Platform aliases are ordinary: macOS resolves
    ``/tmp`` to ``/private/tmp`` and ``/var`` to ``/private/var``, so a config
    directory under either has a symlinked ancestor while being entirely
    legitimate. Refusing those would withhold the namespace from a perfectly
    normal configuration and silently stop every tool that reads it.
    """

    answer = checkout_per_files(directory)
    if answer is None:
        return boundary.run_git(directory, *WORK_TREE_PROBE) is not None
    return answer


# What `lands_in_a_checkout` asks git when the files do not settle it;
# `harness_state_roots` asks it of every such candidate at once.
WORK_TREE_PROBE = ("rev-parse", "--show-toplevel")


def checkout_per_files(directory: Path) -> bool | None:
    """Whether git's own files put ``directory`` in a work tree; None: ask git.

    The same reader the boundary's `checkout_state` uses, so a file answer is
    git's answer, and every layout it does not model is git's.
    """

    try:
        return boundary.checkout_from_files(directory) is not None
    except boundary.GitMustAnswer:
        return None


def harness_state_roots(root: Path, primary: Path) -> tuple[Path, ...]:
    """Claude Code's state directories for this session, when they are real.

    These hold the harness's own per-project state -- session transcripts and
    the subagent journals a session may hand to a reporting tool -- and no
    repository state whatever. Both slugs are derived: transcripts are keyed on
    the directory a session RUNS in, so a linked worktree has its own, while
    agent memory is keyed on the repository and lives under the primary's.

    This is not an allowance and grants no write. It is handed to the shell
    parser as ``read_namespaces``, where its only effect is that a path-shaped
    operand of an UNKNOWN runner landing inside one stops counting as evidence
    of a declared write. Every command with a real parser still confines such a
    path, and the Edit/Write surface never consults this at all -- so a session
    still cannot write here with a file tool, only pass the location to a
    command that was already free to execute arbitrary code.

    Four gates, and they answer different threats rather than repeating one.
    The directory must already exist as a plain directory. Neither it nor
    ``projects/`` above it may be a symlink, which is what stops a redirection
    planted INSIDE the config directory, whatever it points at. The resolution
    must not land in a git work tree, which is what stops a redirection from
    any component ABOVE the config directory, where the symlink is invisible
    from here. And it must not be, sit inside, or contain this session's own
    checkout, which still holds if a checkout ever stops answering to git.

    One case is deliberately left open: a symlink AT the config directory
    aimed at an ordinary non-repository directory. Planting it requires write
    access to ``~/.claude``, and whoever has that already writes this session's
    hooks, settings and instructions -- the same boundary the agent-memory root
    draws, and for the same reason. Nothing here is accepted from the event.
    """

    checkout = primary.resolve()
    candidates: list[Path] = []
    for candidate in (root, primary):
        directory = project_state_root(candidate)
        if directory.is_symlink() or directory.parent.is_symlink():
            continue
        if not directory.is_dir():
            continue
        resolved = directory.resolve()
        if boundary.is_inside(resolved, checkout) or boundary.is_inside(
            checkout, resolved
        ):
            continue
        if resolved not in candidates:
            candidates.append(resolved)
    # `lands_in_a_checkout` last: git's files first, then one git start per
    # candidate they do not settle, all at once. This runs on every mutating
    # Bash call.
    in_a_checkout = {directory: checkout_per_files(directory) for directory in candidates}
    unsettled = [directory for directory, answer in in_a_checkout.items() if answer is None]
    toplevels = boundary.run_git_all(
        [(directory, WORK_TREE_PROBE) for directory in unsettled]
    )
    for directory, toplevel in zip(unsettled, toplevels):
        in_a_checkout[directory] = toplevel is not None
    return tuple(directory for directory in candidates if not in_a_checkout[directory])


def mutation_targets(
    tool: object,
    values: dict[str, object],
    cwd: Path,
    read_namespaces: tuple[Path, ...] = (),
) -> list[Path] | None:
    """Paths a mutation event would write, or ``None`` when unprovable."""

    if tool in {"Edit", "Write", "NotebookEdit"}:
        raw = values.get("file_path") or values.get("notebook_path")
        if not isinstance(raw, str) or not raw:
            boundary.deny("missing edit target")
        target = boundary.resolve_shell_path(raw, cwd)
        # Deliberately NOT given read_namespaces: a file tool names exactly one
        # path and always writes it, so there is no input operand to misread.
        return [target] if target else None
    if tool == "Bash":
        command = boundary.tool_command(values)
        return (
            boundary.mutation_directories(
                command, cwd, read_namespaces=read_namespaces
            )
            if command
            else None
        )
    boundary.deny("unsupported mutation event")
    return None  # unreachable; deny() raises


def denial(target: Path, root: Path, primary: Path) -> str:
    """Explain a refusal, and say so plainly for a near-miss on agent memory.

    Without the second clause a session that aimed at its own memory sees only
    a message about worktrees, concludes the write is impossible, and drops the
    finding -- which is exactly how this allowance came to be needed.
    """

    message = (
        f"mutation target {target} is outside this session's Claude worktree {root}"
    )
    expected = memory_path(primary)
    if boundary.is_inside(target, expected):
        message += (
            f"; agent memory is writable only when {expected} is a real directory"
            " (it is missing, or it or its parent is a symlink)"
        )
    return message


def main() -> None:
    # First, so a misread settings file refuses every event, a read-only one
    # included.
    trusted = settings().trusted_commands
    data = boundary.read_input()
    cwd = Path(data.get("cwd") or Path.cwd()).resolve()
    state = boundary.checkout_state(cwd)
    if not state:
        # Quote git rather than paraphrase it. This denial fires for every
        # Bash, Edit and Write call, so a git that is broken for an unrelated
        # reason presents as a total ownership failure and sends the session
        # after its worktree instead of after the actual fault.
        boundary.deny(
            "cannot determine this session's repository checkout: "
            f"{boundary.checkout_failure(cwd)}"
        )
    root, linked, primary = state
    tool = data.get("tool_name")
    values = data.get("tool_input")
    if not isinstance(values, dict):
        boundary.deny("missing tool input")
    if tool == "Bash":
        command = boundary.tool_command(values)
        if command and boundary.shell_is_read_only(command):
            return
    # Only the shell parser reads these (a file tool is never given them), and
    # finding them costs git starts, so an Edit or Write does not pay for them.
    read_namespaces = harness_state_roots(root, primary) if tool == "Bash" else ()
    targets = mutation_targets(tool, values, cwd, read_namespaces)
    memory = claude_memory_root(primary)

    def in_memory(target: Path) -> bool:
        return memory is not None and boundary.is_inside(target, memory)

    # Agent memory belongs to no checkout, so the worktree gate below has
    # nothing to protect there. An event whose targets are ENTIRELY inside
    # memory skips that gate outright, which lets a session that has not
    # entered a worktree still record what it learned. That is an edit event in
    # practice: a mutating shell command always counts the directory it runs in
    # among its targets, because this parser cannot prove what it writes there.
    if targets and all(in_memory(target) for target in targets):
        return
    if not linked or not boundary.is_claude_managed(root, primary):
        boundary.deny("Claude mutations require this session's Claude-managed worktree; use EnterWorktree")
    if tool == "Bash" and boundary.trusted_request(
        boundary.tool_command(values), cwd, root, trusted
    ):
        # A script the consumer reviewed and trusts, reached only after
        # ownership above.
        return
    if targets is None:
        boundary.deny("mutation targets could not be resolved")
    for target in targets:
        # From inside an owned worktree the two allowances compose, so
        # `touch <memory>/note.md` works while the same command with a second
        # operand outside both still fails on that operand.
        if not (boundary.is_session_target(target, root, primary) or in_memory(target)):
            boundary.deny(denial(target, root, primary))


def run() -> None:
    """``main``, with anything but its own verdict refusing.

    ``main`` allows by returning and refuses with exit 2; an explicit exit 0
    also allows. Any other exit, a bare ``sys.exit()`` included, refuses.
    """

    try:
        main()
    except SystemExit as error:
        if is_exit(error, 0, 2):
            raise
        refuse(f"the ownership guard failed ({failure(error)}), so it cannot judge this call")
    except BaseException as error:
        refuse(f"the ownership guard failed ({failure(error)}), so it cannot judge this call")


if __name__ == "__main__":
    refusal_log.guarded("worktree", run)
