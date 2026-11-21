"""kavach's Python suite. Discovery runs ``load_tests`` here: it finds the
tests as usual and adds the running-repository log check after them all,
so a test that writes to that log fails the run (#368)."""

from __future__ import annotations

import os
import unittest


def load_tests(loader: unittest.TestLoader, standard_tests: unittest.TestSuite, pattern: str | None) -> unittest.TestSuite:
    from . import running_log

    # The repository the runner's cwd and these files belong to: the cwd a
    # guard child inherits, and the package folder a test may run one from.
    running_log.watch((os.getcwd(), str(running_log.HERE)))
    standard_tests.addTests(loader.discover(start_dir=str(running_log.HERE), pattern=pattern or "test*.py"))
    # Made directly, not loaded, so a `-k` filter keeps it: a partial run
    # must not write either.
    standard_tests.addTest(
        running_log.RunningRepositoryLog("test_the_suite_wrote_no_row_to_the_running_repository_log")
    )
    return standard_tests
