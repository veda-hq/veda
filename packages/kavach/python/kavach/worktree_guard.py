#!/usr/bin/env python3
"""Claude Code PreToolUse adapter for the shared deterministic shell/path boundary.

The boundary module (``boundary.py``, beside this file) supplies parsing
only; this adapter owns Claude event semantics and requires this session's own
Claude-managed checkout: a linked worktree under ``.claude/worktrees``, or, in
the environment the consumer's ``worktree.ownCheckout`` names, the plain clone
the session was started in. The consumer's settings (``config.py``, named by the
environment variable ``KAVACH_CONFIG``) are read once per event here and
handed down; a settings file that cannot be used refuses every event.

One thing a Claude session mutates that is not repository state: its own
agent-memory directory. Claude Code keeps that outside every checkout, so the
worktree boundary below has nothing to protect there and would otherwise make
the memory permanently unwritable — a session is told to record findings and
then blocked with a message about worktrees. ``claude_memory_root`` derives
that single directory from the checkout this session is already in and allows
writes confined to it.

Two more folders outside every checkout belong to one session, and from its
owned checkout it may write them (``SessionFolders``): its scratchpad in
Claude Code's temp folder, named by the payload's ``session_id``, and the
side-session notes folders the desktop app granted it.

A managed worktree passes the gate, but not silently when it is another live
session's (rule ``other-sessions-worktree``, veda#363). That is the case when
the desktop app's record of this session names a different worktree and
another record, not archived, names this one. It warns until the consumer's
``rules`` set it to refuse.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from types import ModuleType
from typing import Any, Mapping, NoReturn, Sequence


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
clone_writers = load_module("kavach_worktree_clone_writers", HERE / "clone_writers.py", register=True)


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


# The session ids and the desktop app's record of a session live in
# boundary.py, which the cd-out-of-worktree rule reads them from too.
SESSION_ID = boundary.SESSION_ID
HOST_SESSION = boundary.HOST_SESSION
claude_app_root = boundary.claude_app_root
session_record = boundary.session_record
# One folder name in Claude Code's per-project temp folder (a slug of the
# project's path).
PROJECT_SLUG = re.compile(r"[A-Za-z0-9_-]{1,255}")


def claude_temp_root(environ: Mapping[str, str]) -> Path | None:
    """Claude Code's own per-user temp folder, ``<base>/claude-<uid>``.

    The base is ``CLAUDE_CODE_TMPDIR`` when set, else ``/tmp``, as Claude Code
    builds it (2.1.325). Only an absolute base counts.
    """

    base = environ.get("CLAUDE_CODE_TMPDIR") or "/tmp"
    if not base.startswith("/"):
        return None
    return Path(base).resolve() / f"claude-{os.getuid()}"


def real_directory(path: Path) -> bool:
    """A directory that is not a symlink."""

    return not path.is_symlink() and path.is_dir()


def notes_root() -> Path:
    return claude_app_root() / "side-session-notes"


class SessionFolders:
    """The two folders outside every checkout that a session owns.

    - Its scratchpad, ``<claude temp root>/<project>/<session id>/scratchpad``:
      the payload's ``session_id`` names it.
    - The side-session notes folders the desktop app granted it,
      ``side-session-notes/local_<uuid>/``. A side session's folder is named
      after the session that started it, so ``session_id`` cannot name it.
      The app's record of the session lists the folders it granted
      (``sessionPermissionUpdates``, ``addDirectories``); the record counts
      only when the hook's environment names the app session and the record's
      ``cliSessionId`` is the payload's ``session_id``. The session's own
      folder, where the sessions it starts leave it notes, counts too.

    Nothing here is read from the tool call. Each folder must already be a
    real directory, no symlink at it or on the way from its root, and it must
    not land in a git work tree. Targets are compared resolved, so a ``..`` or
    a symlink that leads out of a folder reaches nothing. The record is the
    app's own format: one that is missing, unreadable or does not match
    grants nothing. Found only when a target needs it, so a write inside the
    worktree pays nothing.
    """

    def __init__(self, session_id: object, environ: Mapping[str, str]) -> None:
        self.session_id = (
            session_id if isinstance(session_id, str) and SESSION_ID.fullmatch(session_id) else None
        )
        self.environ = environ
        self._notes: tuple[Path, ...] | None = None

    def scratchpad_of(self, target: Path) -> Path | None:
        """This session's scratchpad, when ``target`` lies in it."""

        root = claude_temp_root(self.environ)
        if self.session_id is None or root is None:
            return None
        resolved = target.resolve()
        if not boundary.is_inside(resolved, root):
            return None
        parts = resolved.relative_to(root).parts
        if len(parts) < 3 or not PROJECT_SLUG.fullmatch(parts[0]):
            return None
        if parts[1] != self.session_id or parts[2] != "scratchpad":
            return None
        try:
            if root.is_symlink() or root.stat().st_uid != os.getuid():
                return None
        except OSError:
            return None
        project = root / parts[0]
        session = project / parts[1]
        scratchpad = session / parts[2]
        if not all(real_directory(path) for path in (root, project, session, scratchpad)):
            return None
        if lands_in_a_checkout(scratchpad):
            return None
        return scratchpad

    def notes(self) -> tuple[Path, ...]:
        if self._notes is None:
            self._notes = self._find_notes()
        return self._notes

    def _find_notes(self) -> tuple[Path, ...]:
        host = self.environ.get("CLAUDE_CODE_HOST_SESSION_ID", "")
        if self.session_id is None or not HOST_SESSION.fullmatch(host):
            return ()
        app = claude_app_root()
        notes = notes_root()
        if not real_directory(notes) or app.is_symlink():
            return ()
        record = session_record(app, host)
        if record is None or record.get("cliSessionId") != self.session_id:
            return ()
        names = [host, *granted_notes(record, notes)]
        found: list[Path] = []
        for name in names:
            folder = notes / name
            if folder in found or not real_directory(folder) or lands_in_a_checkout(folder):
                continue
            found.append(folder)
        return tuple(found)

    def holds(self, target: Path) -> bool:
        if self.scratchpad_of(target) is not None:
            return True
        resolved = target.resolve()
        if not boundary.is_inside(resolved, notes_root()):
            return False
        return any(boundary.is_inside(resolved, folder) for folder in self.notes())


def granted_notes(record: dict[str, Any], notes: Path) -> list[str]:
    """The notes folders a session record grants: each ``addDirectories``
    entry that names ``<notes>/local_<uuid>`` exactly."""

    names: list[str] = []
    updates = record.get("sessionPermissionUpdates")
    for update in updates if isinstance(updates, list) else []:
        if not isinstance(update, dict) or update.get("type") != "addDirectories":
            continue
        directories = update.get("directories")
        for directory in directories if isinstance(directories, list) else []:
            if not isinstance(directory, str):
                continue
            path = Path(directory)
            if path.parent == notes and HOST_SESSION.fullmatch(path.name) and str(path) == directory.rstrip("/"):
                names.append(path.name)
    return names


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
    collected: list[Any] | None = None,
    push_hosts: Sequence[str] = boundary.DEFAULT_PUSH_HOSTS,
) -> list[Path] | None:
    """Paths a mutation event would write, or ``None`` when unprovable.

    ``collected`` receives a Bash call's mutating segments
    (`boundary.mutation_directories`); ``push_hosts`` are the settings'
    ``worktree.pushHosts``."""

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
                command,
                cwd,
                read_namespaces=read_namespaces,
                collected=collected,
                push_hosts=push_hosts,
            )
            if command
            else None
        )
    boundary.deny("unsupported mutation event")
    return None  # unreachable; deny() raises


def denial(
    target: Path, root: Path, primary: Path, folders: SessionFolders | None = None
) -> str:
    """Explain a refusal, and say so plainly for a near-miss on agent memory
    or on the session's own folders.

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
    try:
        near = session_folder_hint(target, folders)
        if near:
            return message + near
        return message + where_instead(target, root, primary)
    except Exception:
        # Words only: a hint that fails must not turn the denial into a crash.
        return message + GENERIC_INSTEAD


GENERIC_INSTEAD = "; write only inside this worktree, and keep scratch files in its .tmp/"


def session_folder_hint(target: Path, folders: SessionFolders | None) -> str:
    """Words for a write that aimed at Claude Code's temp folder or the
    desktop app's notes folders and missed this session's own."""

    if folders is None:
        return ""
    resolved = target.resolve()
    temp = claude_temp_root(folders.environ)
    if temp is not None and boundary.is_inside(resolved, temp):
        own = folders.session_id or "<session id>"
        return (
            f"; in Claude Code's temp folder only this session's own scratchpad, "
            f"{temp}/<project>/{own}/scratchpad, is writable, and only while it and the "
            "folders above it are real directories, not symlinks"
        )
    if boundary.is_inside(resolved, notes_root()):
        granted = ", ".join(str(folder) for folder in folders.notes()) or "none found"
        return (
            "; of the side-session notes folders only the ones the desktop app granted "
            f"this session are writable ({granted})"
        )
    return ""


def system_temp_roots() -> list[Path]:
    """The system's temp folders, resolved: where scratch files go by habit."""

    roots = [Path("/tmp"), Path("/var/tmp"), Path(tempfile.gettempdir())]
    if os.environ.get("TMPDIR"):
        roots.append(Path(os.environ["TMPDIR"]))
    return [root.resolve() for root in roots]


def linked_worktrees(git_dir: Path) -> list[tuple[Path, Path]]:
    """Each linked worktree's own git folder and its work tree, read from
    ``<git dir>/worktrees/*/gitdir``; what cannot be read is left out."""

    found: list[tuple[Path, Path]] = []
    try:
        entries = sorted((git_dir / "worktrees").iterdir())
    except OSError:
        return found
    for entry in entries:
        try:
            pointer = (entry / "gitdir").read_text(encoding="utf-8").strip()
        except (OSError, ValueError):
            continue
        if pointer:
            found.append((entry.resolve(), Path(pointer).parent.resolve()))
    return found


def where_instead(target: Path, root: Path, primary: Path) -> str:
    """Where the write belongs instead, after naming the place it aimed at.

    Only words: the verdict is already made. Generic on purpose, since every
    consumer's checkout differs: the main checkout, another worktree or its
    git folder, the repository's git folder, a system temp folder, elsewhere.
    """

    resolved, checkout, own = target.resolve(), primary.resolve(), root.resolve()
    git_dir = checkout / ".git"
    own_git_dir = git_dir_of(root)
    worktrees = linked_worktrees(git_dir)
    if own_git_dir is not None and boundary.is_inside(resolved, own_git_dir.resolve()):
        return "; that is this worktree's git folder: change it only through git commands run in this worktree"
    if boundary.is_inside(resolved, git_dir / "worktrees"):
        return (
            "; that is another worktree's git folder: for this worktree's own branch run git here, and "
            "for anything else write a script under this worktree's .tmp/ and run it from this worktree"
        )
    if boundary.is_inside(resolved, git_dir):
        return "; that is the repository's git folder: change it only through git commands run in this worktree"
    if any(boundary.is_inside(resolved, tree) for _gitdir, tree in worktrees if tree != own):
        return (
            "; that is another worktree, which another session may own: make the change in this "
            "worktree, or ask the user to make it there"
        )
    if boundary.is_inside(resolved, checkout):
        relative = resolved.relative_to(checkout)
        return (
            f"; that is the main checkout: make the change in this worktree's own copy, {own / relative}"
        )
    if any(boundary.is_inside(resolved, temp) for temp in system_temp_roots()):
        return (
            "; that is a system temp folder: keep scratch files in this worktree's .tmp/ "
            "(keep it git-ignored) and write them with the Edit or Write tools"
        )
    return GENERIC_INSTEAD


UNRESOLVED = "mutation targets could not be resolved"
WAY_OUT = (
    "Run one plain command per call; write files with the Edit or Write tools; for more, write a "
    "script under this worktree's .tmp/ and run it through the repository's package runner "
    "(for example `pnpm exec tsx .tmp/x.ts`)."
)
REDIRECTION_WAY_OUT = (
    " A redirection into a file is never read, wherever it points: drop it and read the output, "
    "or write the file with Write."
)
HEREDOC_WAY_OUT = (
    " Write a heredoc's text to a file with Write instead (for a commit message, `git commit -F <file>`)."
)
INTERPRETERS = {
    "python", "python2", "python3", "node", "nodejs", "bun", "deno", "perl", "ruby", "php", "lua",
    "tsx", "ts-node", "osascript", "pwsh", "bash", "sh", "zsh", "dash", "ksh", "mksh", "fish",
}
SHELL_NAMES = {"bash", "sh", "zsh", "dash", "ksh", "mksh", "fish"}
# The option that makes each interpreter run its next word as a program.
INLINE_FLAGS = {"-e", "--eval", "-p", "--print"}
SHOWN = 80


def inline_flags(head: str) -> set[str]:
    if head in SHELL_NAMES or head.startswith("python"):
        return {"-c"}
    if head == "osascript":
        return {"-e"}
    if head == "pwsh":
        return {"-c", "-Command"}
    return INLINE_FLAGS


def shell_reader() -> ModuleType | None:
    """git_safety.py's shell lexer, which sees quoting, to name what a
    refused command holds; None when it cannot load (the refusal then names
    nothing). Loaded only for a refusal, so an allowed call never pays."""

    name = "kavach_worktree_shell"
    if name in sys.modules:
        return sys.modules[name]
    try:
        spec = importlib.util.spec_from_file_location(name, HERE / "git_safety.py")
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    except (Exception, SystemExit):
        sys.modules.pop(name, None)
        return None
    return module


def shown(text: str) -> str:
    text = text.replace("\n", " ")
    return text if len(text) <= SHOWN else text[: SHOWN - 3] + "..."


def unreadable_constructs(
    command: str, cwd: Path, push_hosts: Sequence[str] = boundary.DEFAULT_PUSH_HOSTS
) -> list[str]:
    """What in ``command`` keeps its writes from being read, most specific
    first: a heredoc, a redirection into a file, a substitution, an
    interpreter, a program the guard does not know, then a pipeline or a
    chain. Words for a refusal only: the verdict is ``mutation_directories``'s."""

    reader = shell_reader()
    if reader is None:
        return []
    try:
        commands = reader.parse(command)
    except Exception:
        return []
    found: list[str] = []

    def add(text: str) -> None:
        if text not in found:
            found.append(text)

    for each in commands:
        if each.heredocs:
            add("a heredoc (`<<`)")
    for each in commands:
        for target in each.redirect_targets:
            if target.text != os.devnull and not re.fullmatch(r"[0-9]+|-", target.text):
                add(f"an output redirection (`>` to {shown(target.text)})")
    if any(
        word.bodies
        for each in commands
        for word in (*each.words, *each.redirect_targets, *each.input_targets, *each.herestrings)
    ) or any(each.expanded_bodies for each in commands):
        add("a command substitution (`$(...)`, backticks or `<(...)`)")
    curl_config = boundary.curl_environment_is_moved(command) or boundary.curl_config_is_unproven(
        [[word.text for word in each.words] for each in commands]
    )
    if curl_config:
        add(
            "`curl` with a config that may set its output (`-K`, or `HOME`, "
            "`CURL_HOME` or `XDG_CONFIG_HOME` assigned), a `-w` that writes a file, "
            "or `SSLKEYLOGFILE` or `QLOGDIR` assigned"
        )
    for each in commands:
        words = list(each.words)
        while words and words[0].is_assignment() is not None:
            words.pop(0)
        if (
            len(words) in (2, 3)
            and words[0].text == "claude"
            and words[1].text in boundary.CLAUDE_VERSION_FLAGS
            and [word.text for word in words[2:]] in ([], ["--verbose"])
            and (
                boundary.claude_runtime_is_moved()
                or boundary.claude_environment_is_moved(command)
            )
        ):
            add(
                "`claude` with a `BUN_` variable or `NODE_OPTIONS` set, which can load "
                "a program before it prints its version"
            )
            continue
        if not words or words[0].dynamic:
            continue
        head = os.path.basename(words[0].text)
        texts = [word.text for word in words]
        curl_at = next((i for i, text in enumerate(texts) if os.path.basename(text) == "curl"), None)
        if curl_at is not None and boundary.curl_inherits_writes(texts[curl_at + 1 :]):
            add(
                "`curl` where a default config may set its output, or `SSLKEYLOGFILE` "
                "or `QLOGDIR` is set (`curl -q` first skips the config)"
            )
        if curl_config and any(os.path.basename(word.text) == "curl" for word in words):
            # Named above; a wrapper (`env curl -K cfg`, `timeout 5 curl`)
            # is not a second unknown program.
            continue
        if head in INTERPRETERS or re.fullmatch(r"python[0-9]+(\.[0-9]+)*", head):
            inline = next((word.text for word in words[1:] if word.text in inline_flags(head)), None)
            if inline is not None:
                add(f"an inline {head} program (`{head} {inline}`)")
            elif any(not word.text.startswith("-") for word in words[1:]):
                typed = " ".join(word.text for word in words)
                add(f"an interpreter running a file or module (`{shown(typed)}`)")
            continue
        own = each.heredocs or each.redirect_targets or any(word.bodies or word.dynamic for word in words)
        if own and head == "git" and any(word.dynamic for word in words):
            # `git push $REPO HEAD:x`: the expansion is named elsewhere only
            # as a construct, so name the push whose destination it hides.
            texts = [word.text for word in words]
            verb, _ = boundary.git_command(texts, None)
            if verb is not None and verb < len(texts) and texts[verb] in {"push", "send-pack"}:
                add(f"`git {texts[verb]}` with an expansion on its line, whose destination the guard cannot place")
        if not own and boundary.mutation_directories(
            shlex.join(word.text for word in words), cwd, push_hosts=push_hosts
        ) is None:
            texts = [word.text for word in words]
            verb, _ = boundary.git_command(texts, None) if head == "git" else (None, None)
            if verb is not None and verb < len(texts) and texts[verb] in {"push", "send-pack"}:
                add(
                    f"`git {texts[verb]}` to a repository the guard cannot place "
                    f"(only a URL on a host worktree.pushHosts lists, {listed(push_hosts)}, "
                    "or this repository itself, is placed)"
                )
            elif (
                verb is not None
                and verb < len(texts)
                and texts[verb] in {"remote", "config", "fetch", "pull"}
                and boundary.git_remote_url_writes(texts[verb], texts[verb + 1 :]) not in (None, ([], [], []))
            ):
                add(
                    f"`git {texts[verb]}` writing a push destination into the shared config "
                    "that the guard cannot place (only a URL on a host worktree.pushHosts lists, "
                    f"{listed(push_hosts)}, or this repository itself)"
                )
            elif verb is not None and verb < len(texts):
                # An alias, a verb git does not list, or a form of a known
                # verb the guard does not place (`config core.fsmonitor`).
                add(f"`git {shown(texts[verb])}`, a git command or option whose writes the guard does not read")
            elif head in boundary.GIT_RUNNERS and any(os.path.basename(text) == "git" for text in texts[1:]):
                # `pnpm add git` names a package, but is refused the same
                # way: the word, not where it sits, is what fails closed.
                add(
                    f"`{head}` with `git` on its line, which the guard reads only "
                    "when `git` is the command itself"
                )
            elif head in boundary.GIT_RUNNERS and boundary.runner_runs_shell_program(head, texts[1:]):
                add(
                    f"`{head}` handing a shell a program (`sh -c`, or its own shell mode), "
                    "which the guard does not read"
                )
            elif head in boundary.GIT_RUNNERS and boundary.runner_runs_inline_program(head, texts[1:]):
                add(
                    f"`{head}` handing an interpreter an inline program or its standard input "
                    "(`node -e`, `python3 -c`, or no script), or an option the guard does not "
                    "list for it, which the guard does not read"
                )
            elif head in boundary.GIT_RUNNERS and boundary.runner_program_targets(
                head, texts[1:], cwd, push_hosts=push_hosts
            ) is None:
                add(
                    f"`{head}` starting a program the guard reads as it would without `{head}` and "
                    "cannot prove (`deno eval`, `xargs`), a package or tool it would download or put "
                    "first, a bin that is not installed, or an option the guard does not list for it; "
                    "install the bin as a dependency, or drop the option"
                )
            else:
                add(f"`{head}`, a program whose writes the guard does not know")
    if any(each.piped_from is not None for each in commands):
        add("a pipeline (`|`)")
    if any(each.follows in (";", "&&", "||", "\n", "&") for each in commands[1:]):
        add("a chain of commands (`;`, `&&` or `||`)")
    return found


def unreadable_found(
    command: str, cwd: Path, push_hosts: Sequence[str] = boundary.DEFAULT_PUSH_HOSTS
) -> list[str]:
    """`unreadable_constructs`, or nothing when it cannot read the command:
    a refusal's wording never turns into a crash."""

    try:
        return unreadable_constructs(command, cwd, push_hosts) if command else []
    except Exception:
        return []


def listed(hosts: Sequence[str]) -> str:
    """The hosts a refusal names, in backticks."""
    return ", ".join(f"`{host}`" for host in hosts) if hosts else "none"


def joined(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def unresolved(
    tool: object,
    values: dict[str, object],
    cwd: Path,
    push_hosts: Sequence[str] = boundary.DEFAULT_PUSH_HOSTS,
) -> str:
    """The refusal for a call whose writes could not be read, naming what in
    it could not be read and the way out. The leading words stay as they
    were, so earlier logs and searches still match."""

    if tool != "Bash":
        return (
            f"{UNRESOLVED}: the file path cannot be read as one place. "
            "Give the tool an absolute path inside this worktree."
        )
    command = boundary.tool_command(values)
    found = unreadable_found(command, cwd, push_hosts)
    if not found:
        return f"{UNRESOLVED}: the guard cannot read off this command what it writes. {WAY_OUT}"
    named = joined(found)
    extra = ""
    if any(item.startswith("an output redirection") for item in found):
        extra += REDIRECTION_WAY_OUT
    if "a heredoc (`<<`)" in found:
        extra += HEREDOC_WAY_OUT
    return (
        f"{UNRESOLVED}: this command uses {named}, so the guard cannot read off it what it writes. "
        f"{WAY_OUT}{extra}"
    )


NOT_OWNED = "Claude mutations require this session's Claude-managed worktree; use EnterWorktree"


def run_folders(segments: list[Any]) -> set[Path]:
    """The folders the mutating segments run in, as `mutation_directories`
    counts them: where each one runs after any `cd`, or git's `-C` folder."""

    folders: set[Path] = set()
    for words, current, *_rest in segments:
        folder = current
        if os.path.basename(words[0]) == "git":
            _verb, git_target = boundary.git_command(list(words), current)
            folder = git_target or current
        folders.add(folder)
    return folders


def not_owned(
    tool: object,
    values: dict[str, object],
    cwd: Path,
    targets: list[Path] | None,
    segments: list[Any] | None = None,
    push_hosts: Sequence[str] = boundary.DEFAULT_PUSH_HOSTS,
) -> str:
    """The refusal outside an owned checkout, naming why the call counts as a
    mutation (veda#6): the words of a command the guard could not read, or
    the places it writes. The leading words stay as they were, so earlier
    logs and searches still match."""

    if targets is None and tool != "Bash":
        return f"{NOT_OWNED}. The tool's file path cannot be read as one place."
    # A folder a command runs in is counted as a write there with every
    # file it names: it comes last, said as that, so the files show first.
    folders = run_folders(segments or []) if tool == "Bash" else set()
    unique = list(dict.fromkeys(targets or []))
    places = [place for place in unique if place not in folders] + [
        place for place in unique if place in folders
    ]
    if not places:
        if tool != "Bash":
            return f"{NOT_OWNED}."
        found = unreadable_found(boundary.tool_command(values), cwd, push_hosts)
        if not found:
            return f"{NOT_OWNED}. The guard cannot prove this command writes nothing."
        return (
            f"{NOT_OWNED}. The guard counts this command as a mutation because it uses "
            f"{joined(found)}, and cannot read off it what it writes."
        )
    shown_places = [
        f"`{place}`, the folder it runs in, where it cannot prove the command writes nothing"
        if place in folders else f"`{place}`"
        for place in places[:3]
    ]
    if len(places) > 3:
        shown_places.append(f"{len(places) - 3} more")
    return f"{NOT_OWNED}. The guard counts this call as writing {joined(shown_places)}."


# A push in progress (0086 P-06). A pre-push hook that runs kavach's
# `push-marker write <git-dir> <pid>` (`src/rule-checks/live-runs.ts`) leaves
# one marker per push in the worktree's own git folder and clears it on exit.
# While one names a live push, the push is checking this tree: an edit now
# makes it fail at its end ("inputs changed") or check what was not pushed.
# This reads the markers exactly as `live-runs.ts` does: the same name, the
# same JSON, and the same rule for an ended push (`isGone`), so a marker a
# killed push left behind, or one whose pid was reused, blocks nothing. A
# marker that cannot be read names no push, as there: it guards against a
# wasted push, not against the agent, whom the boundary above already holds.
PUSH_MARKER = re.compile(r"kavach-push-in-progress\.\d+\.json")
START_IDENTITY_FORMAT = "lstart-utc-c/1"
MAX_SAFE_INTEGER = 2**53 - 1


class PushRun:
    """A push a marker records: its pid, start identity and start time."""

    def __init__(self, pid: int, start_identity: str | None, started_at: str | None):
        self.pid = pid
        self.start_identity = start_identity
        self.started_at = started_at


def parse_push_run(raw: str) -> PushRun | None:
    """A marker's run, as `parseRun` reads it; ``None`` for anything else."""

    try:
        value = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(value, dict):
        return None
    pid = value.get("pid")
    if isinstance(pid, float) and pid.is_integer():
        pid = int(pid)
    if isinstance(pid, bool) or not isinstance(pid, int):
        return None
    if pid <= 1 or pid > MAX_SAFE_INTEGER:
        return None
    # A missing key is not JSON's null: `parseRun` refuses it, so this does.
    if "startIdentity" not in value:
        return None
    identity = value["startIdentity"]
    if identity is not None and not isinstance(identity, str):
        return None
    started = value.get("startedAt")
    # Only a plain timestamp is quoted back in a refusal.
    if not isinstance(started, str) or not re.fullmatch(r"[0-9T:.+Z-]{1,40}", started):
        started = None
    return PushRun(pid, identity, started)


def ps_field(pid: int, field: str, environment: dict[str, str]) -> str | None:
    """``ps -o <field>= -p <pid>``, stripped; ``None`` when ps fails."""

    try:
        result = subprocess.run(
            ["ps", "-o", f"{field}=", "-p", str(pid)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
            env=environment,
        )
    except OSError:
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def process_alive(pid: int) -> bool:
    """As `processProbe.isAlive`: only ESRCH or a zombie is dead."""

    try:
        os.kill(pid, 0)
    except (ProcessLookupError, OverflowError):
        # OverflowError: a safe integer past the system's pid range names no
        # process.
        return False
    except OSError:
        # EPERM (someone else's process) or anything else is no evidence.
        pass
    state = ps_field(pid, "stat", {**os.environ, "LC_ALL": "C"})
    return state is None or not state.startswith("Z")


def start_identity_of(pid: int) -> str | None:
    """As `processProbe.startIdentityOf`: `lstart` read in UTC and the C locale."""

    started = ps_field(pid, "lstart", {**os.environ, "TZ": "UTC", "LC_ALL": "C"})
    return f"{START_IDENTITY_FORMAT} {started}" if started else None


def is_current_identity(identity: str | None) -> bool:
    return identity is not None and identity.startswith(f"{START_IDENTITY_FORMAT} ")


def push_is_gone(run: PushRun) -> bool:
    """As `isGone`: the pid is dead, or now a process that started later."""

    if not process_alive(run.pid):
        return True
    if not is_current_identity(run.start_identity):
        return False
    current = start_identity_of(run.pid)
    if current is None:
        return not process_alive(run.pid)
    return is_current_identity(current) and current != run.start_identity


def git_dir_of(root: Path) -> Path | None:
    """The worktree's own git folder, from its files first, then from git."""

    try:
        found = boundary.checkout_from_files(root)
    except boundary.GitMustAnswer:
        found = None
    if found is not None:
        return found[1]
    answer = boundary.run_git(root, "rev-parse", "--absolute-git-dir")
    return Path(answer) if answer else None


def live_push(root: Path) -> PushRun | None:
    """The first live push a marker in the worktree's git folder records."""

    git_dir = git_dir_of(root)
    if git_dir is None:
        return None
    try:
        names = sorted(name for name in os.listdir(git_dir) if PUSH_MARKER.fullmatch(name))
    except OSError:
        return None
    for name in names:
        try:
            raw = (git_dir / name).read_text(encoding="utf-8")
        except (OSError, ValueError):
            continue
        run = parse_push_run(raw)
        if run is not None and not push_is_gone(run):
            return run
    return None


def git_ignores(root: Path, target: Path) -> bool:
    """Whether git ignores ``target`` in the checkout at ``root``.

    A tracked file is never ignored, whatever the patterns say; an answer git
    cannot give counts as not ignored.
    """

    # `./` keeps a name such as `:(top)x` from being read as pathspec magic.
    relative = f"./{os.path.relpath(target, root)}"
    result = boundary.run_git_result(root, "check-ignore", "-q", "--", relative)
    return result.returncode == 0


def refuse_during_push(tool: object, targets: list[Path], root: Path) -> None:
    """Refuse a write into the worktree while its push runs.

    A Bash command that reached here is one the boundary could not prove
    read-only, and its targets always include the directory it runs in, so
    any such command run in the worktree waits: what it writes there cannot
    be told. An Edit, Write or NotebookEdit names its one path, and a path git
    ignores (a draft, a scratch file) changes nothing a push reads.
    """

    checkout = root.resolve()
    inside = [target for target in targets if boundary.is_inside(target.resolve(), checkout)]
    if not inside:
        return
    run = live_push(root)
    if run is None:
        return
    if tool == "Bash":
        what = "this command may write in it"
    else:
        changed = [target for target in inside if not git_ignores(checkout, target.resolve())]
        if not changed:
            return
        what = f"this edits {os.path.relpath(changed[0].resolve(), checkout)}, which git does not ignore"
    started = f", started {run.started_at}" if run.started_at else ""
    boundary.deny(
        f"this worktree's push (pid {run.pid}{started}) is still running, and {what}. "
        "Wait for the push to end, then retry. Read-only commands still run, "
        "and files git ignores can still be written with Edit or Write."
    )


# A place inside an owned plain clone that stays refused, and what to say.
Fence = tuple[Path, str]


def clone_fences(root: Path, own: Any, environ: Mapping[str, str]) -> tuple[Fence, ...]:
    """The places inside an owned plain clone that stay refused.

    A desktop session finds each of them outside its worktree, so owning the
    clone must not open them: the clone's git folder (a write there could
    plant a hook or rewrite config), the guard's own settings file and code,
    and the consumer's `protectedPaths` (the hook scripts and settings the
    guards run from). A git folder that cannot be found refuses.
    """

    git_dir = git_dir_of(root)
    if git_dir is None:
        boundary.deny(f"cannot find the git folder of this session's checkout {root}")
    fences: list[Fence] = [
        (git_dir.resolve(), "this checkout's git folder: change it only through git commands")
    ]
    settings_file = environ.get(config.ENV_VAR, "")
    if settings_file:
        fences.append((Path(settings_file), "the guard's own settings file"))
    # The package this file ships in (`python/kavach/` sits two below it).
    fences.append((HERE.parents[1], "the guard's own code"))
    for path in own.protected_paths:
        fences.append(
            (root / path, f"a path worktree.ownCheckout.protectedPaths keeps from this session ({path})")
        )
    return tuple(fences)


# How a refusal on a fence ends, by the checkout it is in.
CLONE_WAY_OUT = clone_writers.WAY_OUT
WORKTREE_WAY_OUT = "this session's own worktree does not open it"


def protected_fences(root: Path, loaded: Any) -> tuple[Fence, ...]:
    """The consumer's `worktree.protectedPaths`, refused in every checkout a
    session owns, its worktree included.

    A worktree holds its own copy of the files the repository's git hooks
    run (`core.hooksPath` set to a tracked folder, the scripts and settings
    those hooks read, the guards installed in its `node_modules`), and git
    runs that copy on the session's own commits and pushes. Each refusal
    carries the consumer's reason, which says how such a file is changed.
    """

    reason = loaded.protected_paths_reason.rstrip(".")
    return tuple(
        (root / path, f"a path worktree.protectedPaths keeps from agent sessions ({path}): {reason}")
        for path in loaded.protected_paths
    )


def in_fence(target: Path, fence: Path) -> bool:
    """Whether ``target`` is ``fence`` or lies under it.

    Compared by file identity as well as by path: on a case-insensitive
    filesystem `.GIT/hooks` is the same folder as `.git/hooks`, though no
    path comparison says so. The fence's nearest existing ancestor is found
    by identity among the target's; below it, names compare without case,
    which refuses more on a case-sensitive one and never less.
    """

    resolved, fence = target.resolve(), fence.resolve()
    if boundary.is_inside(resolved, fence):
        return True
    anchor, rest = fence, []
    while not os.path.lexists(anchor) and anchor != anchor.parent:
        rest.insert(0, anchor.name.casefold())
        anchor = anchor.parent
    for ancestor in (resolved, *resolved.parents):
        try:
            same = os.path.samefile(ancestor, anchor)
        except OSError:
            continue
        if same:
            below = [part.casefold() for part in resolved.parts[len(ancestor.parts):]]
            return below[: len(rest)] == rest
    return False


def is_root(target: Path, root: Path) -> bool:
    if target.resolve() == root.resolve():
        return True
    try:
        return os.path.samefile(target, root)
    except OSError:
        return False


def fence_of(target: Path, root: Path, fences: tuple[Fence, ...]) -> tuple[Fence, str] | None:
    """The fence ``target`` reaches, and how: it lies inside one, or holds
    one (`rm -rf .claude` removes `.claude/hooks/` whole). The clone's root
    is exempt from holding: a command whose writes count as the whole
    checkout is the gap the README names."""

    for fence in fences:
        if in_fence(target, fence[0]):
            return fence, "inside"
    if is_root(target, root):
        return None
    for fence in fences:
        if in_fence(fence[0], target):
            return fence, "holds"
    return None


def refuse_named_root(
    segments: list[Any],
    root: Path,
    fences: tuple[Fence, ...],
    read_namespaces: tuple[Path, ...],
    way_out: str,
    push_hosts: Sequence[str] = boundary.DEFAULT_PUSH_HOSTS,
) -> None:
    """Refuse a command that names the checkout's root as what it writes.

    The root is exempt from holding a fence (`fence_of`), since every
    mutating command run there counts it as a target. But an operand that
    is the root itself (`rm -rf .`, `chmod -R a-x .`, `find . -delete`,
    `cp -R src/. .`) writes the whole checkout, every fence in it included.
    The operands are read again here, apart from the folder the command
    runs in, which is all that tells the two apart.
    """

    for words, cwd, _prefix, _alone in segments:
        operands = boundary.mutation_path_operands(
            list(words), cwd, read_namespaces=read_namespaces, push_hosts=push_hosts
        )
        for operand in operands or ():
            if is_root(operand, root):
                place, what = fences[0]
                boundary.deny(
                    f"`{os.path.basename(words[0])}` names {operand}, the checkout's root, as what it "
                    f"writes, and the root holds {place}, {what}; {way_out}. Name the paths it "
                    "writes instead (`./<name>`, not `.`)"
                )


def is_owned_target(target: Path, root: Path, primary: Path, fences: tuple[Fence, ...]) -> bool:
    """A session target (`boundary.is_session_target`) that reaches no fence."""

    if fence_of(target, root, fences) is not None:
        return False
    return boundary.is_session_target(target, root, primary)


def refuse_target(
    target: Path,
    root: Path,
    primary: Path,
    fences: tuple[Fence, ...],
    folders: SessionFolders | None = None,
    way_out: str = CLONE_WAY_OUT,
) -> None:
    fenced = fence_of(target, root, fences)
    if fenced is not None:
        (place, what), how = fenced
        where = "is inside" if how == "inside" else "holds"
        boundary.deny(f"mutation target {target} {where} {place}, {what}; {way_out}")
    boundary.deny(denial(target, root, primary, folders))


def reviewed(
    command: str,
    cwd: Path,
    root: Path,
    primary: Path,
    entries: Any,
    fences: tuple[Fence, ...] = (),
    way_out: str = CLONE_WAY_OUT,
) -> bool:
    """Admit a reviewed CLI's line (`worktree.reviewedCLIs`), reached only
    after ownership; refuse a line that names one but is not admitted.

    Its writes are unproven, so it counts as writing in the checkout while a
    push runs, as a trusted command does; its declared paths are confined like
    any other destination. False: the line names no reviewed CLI, and the
    checks after this one judge it.
    """

    declared = boundary.reviewed_cli_paths(command, cwd, root, entries)
    if declared is not None:
        for target in declared:
            if not is_owned_target(target, root, primary, fences):
                refuse_target(target, root, primary, fences, way_out=way_out)
        refuse_during_push("Bash", [root, *declared], root)
        return True
    named = boundary.reviewed_cli_named(command, entries)
    if named is None:
        return False
    listed = ", ".join(" ".join(subcommand.words) for subcommand in named.subcommands)
    boundary.deny(
        f"{UNRESOLVED}: {named.program} is a reviewed CLI here (worktree.reviewedCLIs), "
        "and runs only as one plain command from this worktree's root: "
        f"`{named.program}` itself (no path, no variable before it), one listed subcommand "
        f"({listed}), then words that are literal: text in single quotes, or in double quotes "
        "with no $, backtick or backslash inside; no redirection, pipe, chain, comment, glob "
        "or `$(...)`. Write long text to a file under .tmp/ and pass the file where the "
        "subcommand takes one."
    )
    return False


OTHER_SESSIONS_WORKTREE = config.OTHER_SESSIONS_WORKTREE_RULE


def rule_mode(loaded: Any, rule: str) -> tuple[str, str]:
    """The mode and `refusesFrom` day the settings give ``rule``; a rule they
    do not name warns (rules.mode_of)."""

    chosen = dict(getattr(loaded, "rules", None) or ()).get(rule)
    if chosen is None:
        return "warn", ""
    return chosen.mode, chosen.refuses_from


def other_sessions_worktree(
    session_id: object, root: Path, loaded: Any, environ: Mapping[str, str]
) -> str | None:
    """Why a write from ``root`` is in another session's worktree, or None.

    It fires only when both hold (veda#363):

    - the desktop app's record of this session names its worktree
      (``boundary.session_worktree``, the record #362's rule trusts), and that
      worktree is not ``root``;
    - another record, not archived, names ``root`` as its ``cwd``
      (``boundary.worktree_owners``).

    So a worktree shared with the session that started this one passes (this
    session's own record names it). So do a worktree the session made itself
    and a subagent's ``agent-*`` worktree, since no other record names them.
    With no record, or one that does not match, nothing fires. Both readers
    never raise, so on any failure nothing fires either."""

    own = boundary.session_worktree(session_id, loaded.own_checkout, environ)
    if own is None or own.resolve() == root.resolve():
        return None
    owners = boundary.worktree_owners(root, environ.get("CLAUDE_CODE_HOST_SESSION_ID", ""))
    if not owners:
        return None
    if len(owners) == 1:
        sessions, whose = "another live session works", "that session's"
    else:
        sessions, whose = f"{len(owners)} other live sessions work", "their"
    return (
        f"the shell is in worktree {root.name}, which {sessions} in; this session's is "
        f"{own.name}. A write here changes {whose} files and branch. Run "
        f"`cd {shlex.quote(str(own))}` alone to return, then retry (the shell is in {root})"
    )


def trial_answer(message: str, refuses_from: str) -> str:
    """The PreToolUse answer that allows a call and puts the warning in front
    of the agent, as the rules on trial do (rules.context)."""

    when = f"refuses from {refuses_from}" if refuses_from else "refuses after its trial"
    context = (
        f"kavach warning, rule {OTHER_SESSIONS_WORKTREE} ({when}): {message}. This call still runs "
        "while the rule is on trial."
    )
    return json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": context}})


def judge_other_sessions_worktree(
    data: dict[str, object], root: Path, loaded: Any, environ: Mapping[str, str]
) -> str | None:
    """Run ``other_sessions_worktree`` in its mode: refusing, deny; warning,
    log the fire and return the answer to print once the call is allowed.

    While it warns, an error in it allows the call and logs a row naming the
    error's type; once it refuses, the error refuses too (``run``)."""

    mode, refuses_from = rule_mode(loaded, OTHER_SESSIONS_WORKTREE)
    try:
        message = other_sessions_worktree(data.get("session_id"), root, loaded, environ)
    except Exception as error:
        if mode == "refuse":
            raise
        message = None
        refusal_log.record(
            "worktree",
            json.dumps(data),
            f"WARNING: the {OTHER_SESSIONS_WORKTREE} check failed ({type(error).__name__}), "
            "so it did not judge this call; the call was allowed.",
            rule=OTHER_SESSIONS_WORKTREE,
            mode=mode,
        )
    if message is None:
        return None
    if mode == "refuse":
        refusal_log.label(OTHER_SESSIONS_WORKTREE, mode)
        boundary.deny(f"{message} (kavach rule {OTHER_SESSIONS_WORKTREE})")
    refusal_log.record("worktree", json.dumps(data), f"WARNING: {message}", rule=OTHER_SESSIONS_WORKTREE, mode=mode)
    return trial_answer(message, refuses_from)


def main() -> None:
    # First, so a misread settings file refuses every event, a read-only one
    # included.
    loaded = settings()
    trusted = loaded.trusted_commands
    data = boundary.read_input()
    cwd = Path(data.get("cwd") or Path.cwd()).resolve()
    state = boundary.checkout_state(cwd)
    if not state:
        # A proven read needs no checkout: it already runs from any checkout,
        # owned or not, before ownership is asked. Admitting it here keeps
        # the way back open for a shell Claude Code left in a folder no
        # repository holds (an additional working directory, after a `cd`
        # there): `cd <worktree>` is a read. Before this, every call from such
        # a folder was refused, the `cd` back included, for the rest of the
        # session (veda#335).
        if data.get("tool_name") == "Bash":
            values = data.get("tool_input")
            command = boundary.tool_command(values) if isinstance(values, dict) else ""
            if command and boundary.shell_is_read_only(command):
                return
        # Quote git rather than paraphrase it. This denial fires for every
        # Bash, Edit and Write call, so a git that is broken for an unrelated
        # reason presents as a total ownership failure and sends the session
        # after its worktree instead of after the actual fault.
        boundary.deny(
            "cannot determine this session's repository checkout: "
            f"{boundary.checkout_failure(cwd)}. The shell is in {cwd}; reads still "
            "run from there, and only they. If that folder is outside your "
            "worktree, run `cd <your worktree>` alone to return, then retry"
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
        # A read the consumer reviewed (`worktree.readOnlyCommands`), from the
        # checkout's root and only in the environment its entry names: like a
        # proven read, it needs no owned worktree and waits for no push.
        if command and boundary.read_only_request(
            command, cwd, root, loaded.read_only_commands, os.environ
        ):
            return
    # Only the shell parser reads these (a file tool is never given them), and
    # finding them costs git starts, so an Edit or Write does not pay for them.
    read_namespaces = harness_state_roots(root, primary) if tool == "Bash" else ()
    segments: list[Any] = []
    targets = mutation_targets(tool, values, cwd, read_namespaces, segments, loaded.push_hosts)
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
    # A plain clone the consumer marks as the session's own
    # (`worktree.ownCheckout`) passes the gate in place of a Claude-managed
    # worktree. Everything after it still applies, and the places inside it
    # that a worktree session finds outside its own (`clone_fences`) stay
    # refused as targets.
    fences: tuple[Fence, ...] = ()
    clone = not linked and boundary.owns_plain_checkout(loaded.own_checkout, root, os.environ)
    if clone:
        fences = clone_fences(root, loaded.own_checkout, os.environ)
    elif not linked or not boundary.is_claude_managed(root, primary):
        boundary.deny(not_owned(tool, values, cwd, targets, segments, loaded.push_hosts))
    # A managed worktree passes the gate, but another live session's does not
    # pass silently (veda#363): on trial it warns once the call is allowed,
    # refusing it denies here. Before the trusted and reviewed returns, so it
    # judges them too.
    warning = None if clone else judge_other_sessions_worktree(data, root, loaded, os.environ)

    def allow() -> None:
        if warning is not None:
            print(warning)

    # The consumer's `protectedPaths` hold in either kind of owned checkout.
    fences += protected_fences(root, loaded)
    way_out = CLONE_WAY_OUT if clone else WORKTREE_WAY_OUT
    if tool == "Bash" and boundary.trusted_request(
        boundary.tool_command(values), cwd, root, trusted
    ):
        # A script the consumer reviewed and trusts, reached only after
        # ownership above. What it writes is unproven, so it counts as
        # writing in the checkout while a push runs.
        refuse_during_push(tool, [root], root)
        allow()
        return
    if tool == "Bash" and reviewed(
        boundary.tool_command(values), cwd, root, primary, loaded.reviewed_clis, fences, way_out
    ):
        allow()
        return
    if targets is None:
        boundary.deny(unresolved(tool, values, cwd, loaded.push_hosts))
    folders = SessionFolders(data.get("session_id"), os.environ)
    for target in targets:
        # From inside an owned worktree the allowances compose, so
        # `touch <memory>/note.md` works while the same command with a second
        # operand outside all of them still fails on that operand. The
        # session's own folders (`SessionFolders`) count only here, after
        # ownership.
        if not (
            is_owned_target(target, root, primary, fences)
            or in_memory(target)
            or folders.holds(target)
        ):
            refuse_target(target, root, primary, fences, folders, way_out)
    if fences and tool == "Bash":
        refuse_named_root(segments, root, fences, read_namespaces, way_out, loaded.push_hosts)
        # git and package managers write paths their command lines do not
        # name (`clone_writers`). In an owned clone they are judged by all
        # they can write. In a worktree, only git's subcommands that write
        # the paths they name are: merges, rebases, branch switches and
        # installs are a worktree's daily work, and stay open (the README's
        # limit).
        if clone:
            reason = clone_writers.judge(segments, root, fences, in_fence, boundary)
        else:
            reason = clone_writers.judge_named_paths(segments, root, fences, in_fence, boundary, way_out)
        if reason is not None:
            boundary.deny(reason)
    refuse_during_push(tool, targets, root)
    allow()


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
