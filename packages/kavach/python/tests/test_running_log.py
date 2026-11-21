"""The running-repository log check: what it reads and what fails it (#368)."""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from kavach import refusal_log

from . import running_log
from .test_boundary import hermetic_git_env


def row(tool: str) -> dict[str, str]:
    return {"ts": "2026-11-21T00:00:00Z", "guard": "command", "tool": tool, "reason": "BLOCKED: x", "excerpt": ""}


class AppendedTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name, refusal_log.FILE)

    def write(self, text: str) -> None:
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write(text)

    def test_only_the_rows_past_the_start_are_read(self) -> None:
        self.write(json.dumps(row("Bash")) + "\n")
        start = running_log.size(self.path)
        self.write(json.dumps(row("")) + "\nnot json\n" + json.dumps(row("Edit")))
        # The last line has no newline yet: still being written, not read.
        self.assertEqual(running_log.appended(self.path, start), [row(""), "not json"])

    def test_a_log_that_is_absent_or_shrank_gives_no_rows(self) -> None:
        self.assertEqual(running_log.size(self.path), 0)
        self.assertEqual(running_log.appended(self.path, 0), [])
        self.write(json.dumps(row("")) + "\n")
        self.assertEqual(running_log.appended(self.path, running_log.size(self.path) + 1), [])
        self.assertEqual(running_log.appended(self.path, 0), [row("")])


class LeaksTest(unittest.TestCase):
    def test_locally_only_a_row_no_hook_writes_is_a_leak(self) -> None:
        rows = [row("Bash"), row(""), {"guard": "worktree"}, "not json", [1]]
        self.assertEqual(running_log.leaks(rows, strict=False), [row(""), {"guard": "worktree"}, "not json", [1]])

    def test_in_ci_every_row_is_a_leak(self) -> None:
        rows = [row("Bash"), row("")]
        self.assertEqual(running_log.leaks(rows, strict=True), rows)

    def test_ci_is_strict(self) -> None:
        self.assertTrue(running_log.strict({"CI": "true"}))
        self.assertFalse(running_log.strict({"CI": ""}))
        self.assertFalse(running_log.strict({}))


class LogPathsTest(unittest.TestCase):
    def test_each_repository_s_log_once_and_none_outside_one(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        repo = Path(temp.name, "repo").resolve()
        (repo / "sub").mkdir(parents=True)
        outside = Path(temp.name, "plain")
        outside.mkdir()
        subprocess.run(["git", "init", "-q", str(repo)], check=True, env=hermetic_git_env(), timeout=60)
        expected = repo / ".git" / "kavach" / refusal_log.FILE
        self.assertEqual(running_log.log_paths([str(repo), str(repo / "sub"), str(outside)]), [expected])

    def test_the_check_reads_the_logs_watch_noted(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name, refusal_log.FILE)
        path.write_text(json.dumps(row("")) + "\n", encoding="utf-8")
        saved = running_log.RunningRepositoryLog.before
        self.addCleanup(setattr, running_log.RunningRepositoryLog, "before", saved)
        check = running_log.RunningRepositoryLog("test_the_suite_wrote_no_row_to_the_running_repository_log")
        running_log.RunningRepositoryLog.before = [(path, 0)]
        with self.assertRaises(AssertionError):
            check.test_the_suite_wrote_no_row_to_the_running_repository_log()
        running_log.RunningRepositoryLog.before = [(path, running_log.size(path))]
        check.test_the_suite_wrote_no_row_to_the_running_repository_log()


if __name__ == "__main__":
    unittest.main()
