#!/usr/bin/env python3
"""Tests of the worktree guard's push-in-progress refusal (0086 P-06): while a
push marker in the worktree's git folder names a live push, writes into that
worktree wait. The markers are the ones `src/rule-checks/live-runs.ts` writes,
read as it reads them."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest import mock

from .test_boundary import ADAPTER, BoundaryFixture, git


STARTED = "2026-11-10T03:05:00.000Z"


class PushInProgressTest(BoundaryFixture):
    def setUp(self) -> None:
        super().setUp()
        self.git_dir = self.main / ".git" / "worktrees" / "claude-task"
        self.other_git_dir = self.main / ".git" / "worktrees" / "manual-task"
        # Files git ignores in every worktree of the fixture.
        exclude = self.main / ".git" / "info" / "exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        exclude.write_text("scratch/\n", encoding="utf-8")
        self.sleeper = subprocess.Popen(["sleep", "60"])
        self.addCleanup(self.stop_sleeper)

    def stop_sleeper(self) -> None:
        if self.sleeper.poll() is None:
            self.sleeper.kill()
        self.sleeper.wait()

    def mark(
        self,
        pid: int,
        identity: str | None | object = "live",
        *,
        directory: Path | None = None,
        name: str | None = None,
        started: object = STARTED,
    ) -> Path:
        """Write a marker as `push-marker write` does; "live" reads the pid's identity."""

        if identity == "live":
            identity = ADAPTER.start_identity_of(pid)
            self.assertIsNotNone(identity)
        record: dict[str, object] = {"pid": pid, "startIdentity": identity}
        if started is not None:
            record["startedAt"] = started
        path = (directory or self.git_dir) / (name or f"kavach-push-in-progress.{pid}.json")
        path.write_text(json.dumps(record) + "\n", encoding="utf-8")
        return path

    def write(self, target: Path, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
        return self.invoke(cwd or self.claude, tool_input={"file_path": str(target)})

    # --- the verdicts ---------------------------------------------------------

    def test_without_a_push_every_owned_write_passes(self) -> None:
        self.assertEqual(self.write(self.claude / "tracked.txt").returncode, 0)
        self.assertEqual(self.claude_bash(self.claude, "touch new.txt").returncode, 0)

    def test_a_live_push_refuses_writes_into_the_worktree_and_names_the_push(self) -> None:
        self.mark(self.sleeper.pid)
        pid = str(self.sleeper.pid)
        for result, what in (
            (self.write(self.claude / "tracked.txt"), "this edits tracked.txt, which git does not ignore"),
            (self.write(self.claude / "new.txt"), "this edits new.txt"),
            (self.claude_bash(self.claude, "touch new.txt"), "this command may write in it"),
            (self.claude_bash(self.claude, "sed -i.bak s/a/b/ tracked.txt"), "this command may write in it"),
            (self.claude_bash(self.claude, "gh pr comment 1 --body hi"), "this command may write in it"),
        ):
            with self.subTest(what=what):
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(f"this worktree's push (pid {pid}, started {STARTED}) is still running", result.stderr)
                self.assertIn(what, result.stderr)
                self.assertIn("Wait for the push to end", result.stderr)

    def test_reads_and_ignored_files_still_pass_during_a_push(self) -> None:
        self.mark(self.sleeper.pid)
        (self.claude / "scratch").mkdir()
        for result in (
            self.claude_bash(self.claude, "ls"),
            self.claude_bash(self.claude, "git status --short"),
            self.write(self.claude / "scratch" / "draft.md"),
        ):
            with self.subTest(args=result.args):
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_tracked_file_matching_an_ignore_pattern_is_still_refused(self) -> None:
        (self.claude / "scratch").mkdir()
        (self.claude / "scratch" / "kept.txt").write_text("x\n", encoding="utf-8")
        git(self.claude, "add", "-f", "scratch/kept.txt")
        self.mark(self.sleeper.pid)
        result = self.write(self.claude / "scratch" / "kept.txt")
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_writes_pass_again_once_the_push_ends(self) -> None:
        marker = self.mark(self.sleeper.pid)
        self.assertEqual(self.write(self.claude / "tracked.txt").returncode, 2)
        self.stop_sleeper()
        self.assertTrue(marker.exists())
        self.assertEqual(self.write(self.claude / "tracked.txt").returncode, 0)

    def test_another_worktrees_push_blocks_nothing_here(self) -> None:
        self.mark(self.sleeper.pid, directory=self.other_git_dir)
        self.assertEqual(self.write(self.claude / "tracked.txt").returncode, 0)

    def test_a_reused_pid_blocks_nothing(self) -> None:
        self.mark(self.sleeper.pid, f"{ADAPTER.START_IDENTITY_FORMAT} Thu Jan  1 00:00:00 1970")
        self.assertEqual(self.write(self.claude / "tracked.txt").returncode, 0)

    def test_an_unknown_identity_lives_while_its_pid_does(self) -> None:
        for identity in (None, "lstart-local/0 Thu Jan  1 00:00:00 1970"):
            with self.subTest(identity=identity):
                self.mark(self.sleeper.pid, identity)
                self.assertEqual(self.write(self.claude / "tracked.txt").returncode, 2)

    def test_markers_of_other_names_or_shapes_name_no_push(self) -> None:
        pid = self.sleeper.pid
        for name in (
            f"kavach-push-in-progress.{pid}.json.tmp",
            f"athya-push-in-progress.{pid}.json",
            f"xkavach-push-in-progress.{pid}.json",
        ):
            self.mark(pid, name=name)
        (self.git_dir / "kavach-push-in-progress.7.json").write_text("{", encoding="utf-8")
        self.assertEqual(self.write(self.claude / "tracked.txt").returncode, 0)

    def test_an_odd_start_time_is_not_quoted(self) -> None:
        self.mark(self.sleeper.pid, started="now; rm -rf /")
        result = self.write(self.claude / "tracked.txt")
        self.assertEqual(result.returncode, 2)
        self.assertIn(f"(pid {self.sleeper.pid}) is still running", result.stderr)
        self.assertNotIn("rm -rf", result.stderr)

    # --- the reading, unit by unit -------------------------------------------

    def test_parse_reads_only_what_parse_run_reads(self) -> None:
        cases: tuple[tuple[str, int | None], ...] = (
            ('{"pid": 42, "startIdentity": null}', 42),
            ('{"pid": 42.0, "startIdentity": "x"}', 42),
            ('{"pid": 42.5, "startIdentity": null}', None),
            ('{"pid": true, "startIdentity": null}', None),
            ('{"pid": 1, "startIdentity": null}', None),
            ('{"pid": 9007199254740992, "startIdentity": null}', None),
            ('{"pid": "42", "startIdentity": null}', None),
            ('{"pid": 42, "startIdentity": 7}', None),
            ("[42]", None),
            ("{", None),
        )
        for raw, pid in cases:
            with self.subTest(raw=raw):
                run = ADAPTER.parse_push_run(raw)
                self.assertEqual(None if run is None else run.pid, pid)

    def test_liveness_follows_the_typescript_probe(self) -> None:
        with mock.patch.object(ADAPTER.os, "kill", side_effect=PermissionError):
            with mock.patch.object(ADAPTER, "ps_field", return_value="Ss"):
                self.assertTrue(ADAPTER.process_alive(4242))
            with mock.patch.object(ADAPTER, "ps_field", return_value="Z"):
                self.assertFalse(ADAPTER.process_alive(4242))
            with mock.patch.object(ADAPTER, "ps_field", return_value=None):
                self.assertTrue(ADAPTER.process_alive(4242))
        with mock.patch.object(ADAPTER.os, "kill", side_effect=ProcessLookupError):
            self.assertFalse(ADAPTER.process_alive(4242))
        with mock.patch.object(ADAPTER.subprocess, "run", side_effect=OSError):
            self.assertIsNone(ADAPTER.ps_field(4242, "stat", {}))
        self.assertIsNone(ADAPTER.start_identity_of(self.dead_pid()))

    def test_an_unreadable_start_asks_about_liveness_again(self) -> None:
        run = ADAPTER.PushRun(4242, f"{ADAPTER.START_IDENTITY_FORMAT} then", None)
        with mock.patch.object(ADAPTER, "start_identity_of", return_value=None):
            with mock.patch.object(ADAPTER, "process_alive", side_effect=[True, False]):
                self.assertTrue(ADAPTER.push_is_gone(run))
            with mock.patch.object(ADAPTER, "process_alive", side_effect=[True, True]):
                self.assertFalse(ADAPTER.push_is_gone(run))
        with mock.patch.object(ADAPTER, "process_alive", return_value=True):
            with mock.patch.object(ADAPTER, "start_identity_of", return_value="other/1 later"):
                self.assertFalse(ADAPTER.push_is_gone(run))

    def test_the_git_folder_comes_from_files_then_git(self) -> None:
        self.assertEqual(ADAPTER.git_dir_of(self.claude).resolve(), self.git_dir.resolve())
        with mock.patch.object(
            ADAPTER.boundary, "checkout_from_files", side_effect=ADAPTER.boundary.GitMustAnswer("x")
        ):
            with mock.patch.object(ADAPTER.boundary, "run_git", return_value=str(self.git_dir)):
                self.assertEqual(ADAPTER.git_dir_of(self.claude), self.git_dir)
            with mock.patch.object(ADAPTER.boundary, "run_git", return_value=None):
                self.assertIsNone(ADAPTER.git_dir_of(self.claude))
                self.assertIsNone(ADAPTER.live_push(self.claude))
        with mock.patch.object(ADAPTER.boundary, "checkout_from_files", return_value=None):
            with mock.patch.object(ADAPTER.boundary, "run_git", return_value=None):
                self.assertIsNone(ADAPTER.git_dir_of(self.external))

    def test_an_unreadable_folder_or_marker_names_no_push(self) -> None:
        self.mark(self.sleeper.pid)
        with mock.patch.object(ADAPTER.os, "listdir", side_effect=PermissionError):
            self.assertIsNone(ADAPTER.live_push(self.claude))
        with mock.patch.object(Path, "read_text", side_effect=PermissionError):
            self.assertIsNone(ADAPTER.live_push(self.claude))
        run = ADAPTER.live_push(self.claude)
        self.assertIsNotNone(run)
        assert run is not None
        self.assertEqual((run.pid, run.started_at), (self.sleeper.pid, STARTED))

    def test_targets_outside_the_worktree_are_not_judged_here(self) -> None:
        self.mark(self.sleeper.pid)
        with mock.patch.object(ADAPTER, "live_push", side_effect=AssertionError("read")):
            ADAPTER.refuse_during_push("Write", [self.external / "x"], self.claude)

    def dead_pid(self) -> int:
        process = subprocess.Popen(["true"])
        process.wait()
        return process.pid


if __name__ == "__main__":  # pragma: no cover
    import unittest

    unittest.main()
