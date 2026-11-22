"""A folder outside every repository, for what a test runs (#387).

A guard that refuses before it reads its event, or a mutant of
``refusal_log.record`` that drops the event's ``cwd``, logs to the
repository of its own working directory. A guard child that inherits the
runner's cwd, or runs from the package's folder, would put that row in the
running repository's log: from a worktree, the main checkout's. Run each
guard child here instead, and an in-process ``record`` from here too.

It asks git itself, not ``refusal_log``, so a mutant of the module under
test cannot make it pass.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


def in_a_repository(path: Path) -> bool:
    """Whether git finds a repository at ``path`` or above it."""

    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    result = subprocess.run(
        ["git", "rev-parse", "--git-common-dir"], cwd=path, env=env, capture_output=True, timeout=60, check=False
    )
    return result.returncode == 0


def outside(test: unittest.TestCase) -> Path:
    """An empty folder outside every repository, made once per test and
    removed after it."""

    made = getattr(test, "_outside", None)
    if made is not None:
        return made
    temporary = tempfile.TemporaryDirectory(prefix="outside-")
    test.addCleanup(temporary.cleanup)
    path = Path(temporary.name).resolve()
    if in_a_repository(path):
        raise AssertionError(f"{path} is inside a repository: run the suite with TMPDIR outside every repository")
    test._outside = path  # type: ignore[attr-defined]
    return path


def run_outside(test: unittest.TestCase) -> Path:
    """Make ``outside(test)`` the working directory for the test's body, and
    go back before the folder is removed."""

    previous = os.getcwd()
    path = outside(test)
    os.chdir(path)
    test.addCleanup(os.chdir, previous)
    return path
