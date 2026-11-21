"""The running repository's refusal log, watched across a suite run (#368).

A guard a test runs writes its refusal to the log of the repository its
event's ``cwd`` belongs to, or, when it refuses before reading the event, of
the child's own cwd. A test that runs a guard from inside this repository
(the package's own folder, or the runner's cwd it inherits) so adds a row to
the running repository's log: in a worktree that is the main checkout's
``.git/kavach/refusals.jsonl``, beside the real refusals.

``load_tests`` in this package marks where each log stands before the suite runs
and adds ``RunningRepositoryLog`` after every other test, so it runs last,
under ``-k`` too. It reads only the bytes appended during the run.

Locally the log is shared with every live session of the repository, whose
refusals land in it during a run too, so only a row a hook could not have
written fails: one with no tool, as a test's event without ``tool_name`` or a
refusal made before the event was read leaves it. A leaked row that names a
tool looks like a live session's and passes. And a run in another checkout of
the repository, of a branch from before this check, writes its own leaks to
the same shared log: a row this run did not write can still fail it. With
``CI`` set the clone is the run's own, so any appended row fails.
"""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from typing import Any, Iterable, Mapping, NamedTuple, Optional

from kavach import refusal_log

HERE = Path(__file__).resolve().parent


def log_paths(places: Iterable[str]) -> list[Path]:
    """The refusal log of each repository ``places`` belong to, once each."""

    paths: list[Path] = []
    for place in places:
        directory = refusal_log.log_dir(place)
        if directory is not None and directory / refusal_log.FILE not in paths:
            paths.append(directory / refusal_log.FILE)
    return paths


# How many bytes before the mark are kept, to tell the same log from one
# cleaned and written again past its old size.
TAIL = 256


class Mark(NamedTuple):
    """Where a log stood before the run: its size, its file, and its last
    bytes. A log that did not exist yet is ``Mark(0, None, b"")``."""

    size: int
    inode: Optional[int]
    tail: bytes


def mark(path: Path) -> Mark:
    """Where ``path`` stands now."""

    try:
        with open(path, "rb") as handle:
            end = os.fstat(handle.fileno())
            handle.seek(max(0, end.st_size - TAIL))
            return Mark(end.st_size, end.st_ino, handle.read(end.st_size - handle.tell()))
    except FileNotFoundError:
        return Mark(0, None, b"")


def appended(path: Path, since: Mark) -> list[Any]:
    """The rows written to ``path`` after ``since``. A log cleaned during the
    run gives none: one now shorter, another file, or one whose bytes before
    the mark changed (emptied and written again past its old size). A last
    line still being written, with no newline yet, is not read."""

    try:
        with open(path, "rb") as handle:
            now = os.fstat(handle.fileno())
            if now.st_size < since.size or (since.inode is not None and now.st_ino != since.inode):
                return []
            handle.seek(since.size - len(since.tail))
            if handle.read(len(since.tail)) != since.tail:
                return []
            data = handle.read()
    except FileNotFoundError:
        return []
    rows: list[Any] = []
    for line in data.decode("utf-8", "replace").split("\n")[:-1]:
        try:
            rows.append(json.loads(line))
        except ValueError:
            rows.append(line)
    return rows


def leaks(rows: Iterable[Any], strict: bool) -> list[Any]:
    """The rows the suite must have written: every row when ``strict``,
    else those with no tool, which no hook event leaves."""

    rows = list(rows)
    if strict:
        return rows
    return [row for row in rows if not (isinstance(row, dict) and row.get("tool"))]


def strict(environ: Mapping[str, str]) -> bool:
    """True in CI, where the clone's log is the run's own."""

    return bool(environ.get("CI"))


class RunningRepositoryLog(unittest.TestCase):
    """Run after every other test: none wrote to the running repository's
    refusal log."""

    # Each log and where it stood before the run, set by ``watch``.
    before: list[tuple[Path, Mark]] = []
    # Every leaked row in full, so the failure names each one.
    maxDiff = None

    def test_the_suite_wrote_no_row_to_the_running_repository_log(self) -> None:
        mode = strict(os.environ)
        found = [(path, row) for path, since in self.before for row in leaks(appended(path, since), mode)]
        self.assertEqual(
            found,
            [],
            "a test wrote to the running repository's refusal log: run its guard with "
            f"{refusal_log.OFF_VAR} set, or from a cwd outside this repository, and give its event a cwd."
            " Locally the log is shared: a suite run at the same time in another checkout, of a branch"
            " without this check, writes such rows too",
        )


def watch(places: Iterable[str]) -> None:
    """Mark each log now, for ``RunningRepositoryLog``."""

    RunningRepositoryLog.before = [(path, mark(path)) for path in log_paths(places)]
