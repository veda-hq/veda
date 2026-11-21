"""The running-repository log check: what it reads and what fails it (#368)."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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

    def test_only_the_rows_past_the_mark_are_read(self) -> None:
        self.write(json.dumps(row("Bash")) + "\n")
        since = running_log.mark(self.path)
        self.write(json.dumps(row("")) + "\nnot json\n" + json.dumps(row("Edit")))
        # The last line has no newline yet: still being written, not read.
        self.assertEqual(running_log.appended(self.path, since), [row(""), "not json"])

    def test_a_long_log_keeps_only_its_last_bytes_in_the_mark(self) -> None:
        text = "".join(json.dumps(row("Bash")) + "\n" for _ in range(20))
        self.write(text)
        since = running_log.mark(self.path)
        self.assertEqual((since.size, since.tail), (len(text), text[-running_log.TAIL :].encode()))
        self.write(json.dumps(row("")) + "\n")
        self.assertEqual(running_log.appended(self.path, since), [row("")])

    def test_a_log_absent_at_the_mark_is_read_whole(self) -> None:
        since = running_log.mark(self.path)
        self.assertEqual(since, running_log.Mark(0, None, b""))
        self.assertEqual(running_log.appended(self.path, since), [])
        self.write(json.dumps(row("")) + "\n")
        self.assertEqual(running_log.appended(self.path, since), [row("")])

    def test_a_log_cleaned_during_the_run_gives_no_rows(self) -> None:
        old = "".join(json.dumps(row("Bash")) + "\n" for _ in range(3))
        refill = "".join(json.dumps(row("")) + "\n" for _ in range(6))
        cases = {
            # Shorter than at the mark.
            "shrank": lambda: self.path.write_text(old[:10], encoding="utf-8"),
            # Emptied in place, then written past its old size.
            "refilled": lambda: self.path.write_text(refill, encoding="utf-8"),
            # Replaced by another file, which may reuse the inode number.
            "replaced": lambda: (
                self.path.unlink(),
                self.path.write_text(old.replace("Bash", "Edit") + refill, encoding="utf-8"),
            ),
            "removed": lambda: self.path.unlink(),
        }
        for label, clean in cases.items():
            with self.subTest(label):
                self.path.write_text(old, encoding="utf-8")
                since = running_log.mark(self.path)
                clean()
                self.assertEqual(running_log.appended(self.path, since), [])

    def test_another_file_with_the_same_bytes_gives_no_rows(self) -> None:
        self.write(json.dumps(row("Bash")) + "\n")
        since = running_log.mark(self.path)
        self.write(json.dumps(row("")) + "\n")
        self.assertEqual(running_log.appended(self.path, since._replace(inode=since.inode + 1)), [])
        self.assertEqual(running_log.appended(self.path, since), [row("")])


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

    def test_the_check_reads_the_logs_watch_marked(self) -> None:
        """``watch`` marks a repository's log; a row a guard then writes there
        fails the check, and with no row since the check passes."""

        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        repo = Path(temp.name, "repo").resolve()
        repo.mkdir()
        subprocess.run(["git", "init", "-q", str(repo)], check=True, env=hermetic_git_env(), timeout=60)
        saved = running_log.RunningRepositoryLog.before
        self.addCleanup(setattr, running_log.RunningRepositoryLog, "before", saved)
        check = running_log.RunningRepositoryLog("test_the_suite_wrote_no_row_to_the_running_repository_log")

        running_log.watch([str(repo)])
        log = repo / ".git" / "kavach" / refusal_log.FILE
        self.assertEqual(running_log.RunningRepositoryLog.before, [(log, running_log.Mark(0, None, b""))])
        check.test_the_suite_wrote_no_row_to_the_running_repository_log()
        with mock.patch.dict(os.environ, {refusal_log.OFF_VAR: ""}):
            refusal_log.record("command", json.dumps({"cwd": str(repo)}), "BLOCKED: a leak")
        with self.assertRaises(AssertionError) as raised:
            check.test_the_suite_wrote_no_row_to_the_running_repository_log()
        self.assertIn("BLOCKED: a leak", str(raised.exception))

        running_log.watch([str(repo)])
        check.test_the_suite_wrote_no_row_to_the_running_repository_log()


if __name__ == "__main__":
    unittest.main()
