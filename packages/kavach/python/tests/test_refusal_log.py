"""The refusal log: a row per refusal, never a changed verdict."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent / "kavach"
sys.path.insert(0, str(PACKAGE))
import refusal_log  # noqa: E402

GIT_ENV = {
    key: value for key, value in os.environ.items() if not key.startswith("GIT_")
} | {"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}


class RefusalLogTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name, "repo").resolve()
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True, env=GIT_ENV)
        patcher = mock.patch.dict(os.environ, {"KAVACH_REFUSAL_LOG_OFF": ""})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.log = self.repo / ".git" / "kavach" / refusal_log.FILE

    def event(self, **fields: object) -> str:
        return json.dumps({"cwd": str(self.repo), "tool_name": "Bash"} | fields)

    def rows(self) -> list[dict[str, object]]:
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def test_a_refusal_is_one_row(self) -> None:
        refusal_log.record(
            "worktree",
            self.event(tool_input={"command": "touch /x" + "y" * 300}),
            "\nBLOCKED: outside\nmore\n",
            now=lambda: 0,
        )
        refusal_log.record("command", self.event(tool_name="Edit", tool_input={"file_path": "/a"}), "")
        first, second = self.rows()
        self.assertEqual(first["ts"], "1970-01-01T00:00:00Z")
        self.assertEqual(first["guard"], "worktree")
        self.assertEqual(first["tool"], "Bash")
        self.assertEqual(first["reason"], "BLOCKED: outside")
        self.assertEqual(len(str(first["excerpt"])), refusal_log.EXCERPT)
        self.assertEqual((second["tool"], second["reason"], second["excerpt"]), ("Edit", "", "/a"))

    def test_unreadable_events_still_log_from_the_working_directory(self) -> None:
        with mock.patch.object(os, "getcwd", return_value=str(self.repo)):
            refusal_log.record("command", "not json", "BLOCKED: x")
            refusal_log.record("command", "[]", "BLOCKED: y")
            refusal_log.record("command", json.dumps({"cwd": 3, "tool_name": 4}), "BLOCKED: z")
        self.assertEqual([row["reason"] for row in self.rows()], ["BLOCKED: x", "BLOCKED: y", "BLOCKED: z"])
        self.assertEqual({row["tool"] for row in self.rows()}, {""})
        self.assertEqual(refusal_log.excerpt({"other": 1}), "")
        self.assertEqual(refusal_log.excerpt("text"), "")

    def test_nothing_is_written_when_off_or_outside_a_repository(self) -> None:
        with mock.patch.dict(os.environ, {"KAVACH_REFUSAL_LOG_OFF": "1"}):
            refusal_log.record("worktree", self.event(), "BLOCKED")
        outside = Path(self.temp.name, "plain")
        outside.mkdir()
        refusal_log.record("worktree", json.dumps({"cwd": str(outside)}), "BLOCKED")
        refusal_log.record("worktree", json.dumps({"cwd": str(outside / "missing")}), "BLOCKED")
        self.assertFalse(self.log.exists())
        with mock.patch.object(subprocess, "run", side_effect=OSError("no git")):
            self.assertIsNone(refusal_log.log_dir(str(self.repo)))

    def test_a_failing_write_is_swallowed(self) -> None:
        with mock.patch.object(Path, "mkdir", side_effect=PermissionError("read-only")):
            refusal_log.record("worktree", self.event(), "BLOCKED")
        self.assertFalse(self.log.exists())

    def test_guarded_logs_refusals_and_passes_every_verdict_through(self) -> None:
        stdin = io.StringIO(self.event(tool_input={"command": "rm x"}))

        def refuse_by_exit() -> None:
            sys.stdin.read()
            sys.stderr.write("BLOCKED: by exit\n")
            raise SystemExit(2)

        with mock.patch.object(sys, "stdin", stdin), mock.patch.object(sys, "stderr", io.StringIO()) as err:
            with self.assertRaises(SystemExit) as end:
                refusal_log.guarded("worktree", refuse_by_exit)
            self.assertEqual(end.exception.code, 2)
            self.assertIn("BLOCKED: by exit", err.getvalue())
            self.assertIs(sys.stdin, stdin)
            self.assertIs(sys.stderr, err)
            with self.assertRaises(SystemExit):
                refusal_log.guarded("worktree", lambda: sys.exit(0))
            self.assertIsNone(refusal_log.guarded("worktree", lambda: None))

            def refuse_by_return() -> int:
                sys.stderr.write("BLOCKED: by return\n")
                sys.stderr.flush()
                return 2

            raw = self.event(tool_input={"command": "git push -f"})
            self.assertEqual(refusal_log.guarded("command", refuse_by_return, lambda: raw), 2)
            self.assertEqual(refusal_log.guarded("command", lambda: 0, lambda: raw), 0)
        self.assertEqual(
            [(row["guard"], row["reason"], row["excerpt"]) for row in self.rows()],
            [("worktree", "BLOCKED: by exit", "rm x"), ("command", "BLOCKED: by return", "git push -f")],
        )

    def test_an_excerpt_is_the_first_200_characters(self) -> None:
        text = "".join(chr(ord("a") + index % 26) for index in range(300))
        self.assertEqual(refusal_log.excerpt({"command": text}), text[:200])
        refusal_log.record("command", self.event(), "BLOCKED: " + text)
        (row,) = self.rows()
        self.assertEqual(row["reason"], ("BLOCKED: " + text)[:200])

    def test_a_row_keeps_text_that_is_not_ascii_as_utf8(self) -> None:
        refusal_log.record("command", self.event(tool_input={"command": "echo café"}), "BLOCKED: déjà")
        text = self.log.read_text(encoding="utf-8")
        self.assertEqual((text.count("café"), text.count("déjà"), text.count("\\u")), (1, 1, 0))

    def test_the_log_folder_is_made_with_its_parents(self) -> None:
        folder = self.repo / ".git" / "missing" / "kavach"
        with mock.patch.object(refusal_log, "log_dir", return_value=folder):
            refusal_log.record("command", self.event(), "BLOCKED: x")
        self.assertEqual(len((folder / refusal_log.FILE).read_text(encoding="utf-8").splitlines()), 1)

    def test_git_is_asked_once_with_a_timeout_and_its_failure_read(self) -> None:
        def answer(returncode: int, stdout: str) -> tuple[Path | None, mock.MagicMock]:
            run = mock.MagicMock(return_value=subprocess.CompletedProcess([], returncode, stdout, ""))
            with mock.patch.object(subprocess, "run", run):
                return refusal_log.log_dir(str(self.repo)), run

        found, run = answer(0, "/common\n")
        self.assertEqual(found, Path("/common", "kavach"))
        run.assert_called_once_with(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=str(self.repo),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        # A git that fails says nothing usable, whatever it printed.
        for returncode in (1, -1, 128):
            with self.subTest(returncode=returncode):
                self.assertIsNone(answer(returncode, "/common\n")[0])
        self.assertIsNone(answer(0, "\n")[0])

    def test_guarded_logs_only_an_exit_or_a_return_of_2(self) -> None:
        def end(code: object) -> None:
            sys.stderr.write("BLOCKED: %r\n" % (code,))
            raise SystemExit(code)

        with mock.patch.object(sys, "stdin", io.StringIO(self.event())), mock.patch.object(sys, "stderr", io.StringIO()):
            for code in (0, 1, 3, None, "2"):
                with self.subTest(code=code):
                    with self.assertRaises(SystemExit):
                        refusal_log.guarded("command", lambda: end(code), self.event)
            for result in (0, 1, 3, "2"):
                with self.subTest(result=result):
                    self.assertEqual(refusal_log.guarded("command", lambda: result, self.event), result)
        self.assertFalse(self.log.exists())
        # The same calls with a 2 do write, here: the log above is the right one to watch.
        with mock.patch.object(sys, "stderr", io.StringIO()):
            with self.assertRaises(SystemExit):
                refusal_log.guarded("command", lambda: end(2), self.event)
            refusal_log.guarded("command", lambda: 2, self.event)
        self.assertEqual(len(self.rows()), 2)

    def test_the_read_tee_reads_through(self) -> None:
        source = io.BytesIO(b"raw")
        tee = refusal_log._ReadTee(source)
        self.assertEqual(tee.read(), b"raw")
        self.assertEqual(tee.copy.getvalue(), "")
        self.assertEqual(tee.tell(), 3)

    def test_both_guards_log_a_refusal_end_to_end(self) -> None:
        env = GIT_ENV | {"KAVACH_REFUSAL_LOG_OFF": "", "KAVACH_CONFIG": ""}
        target = Path(self.temp.name, "outside.txt")
        for script, tool_input in (
            ("worktree_guard.py", {"command": f"touch {target}"}),
            ("command_guard.py", {"command": "git commit --no-verify -m x"}),
        ):
            result = subprocess.run(
                [sys.executable, str(PACKAGE / script)],
                input=self.event(tool_input=tool_input),
                capture_output=True,
                text=True,
                check=False,
                env=env,
                cwd=self.repo,
            )
            self.assertEqual(result.returncode, 2, result.stderr)
        guards = [row["guard"] for row in self.rows()]
        self.assertEqual(guards, ["worktree", "command"])
        self.assertTrue(all(str(row["reason"]).startswith("BLOCKED") for row in self.rows()))


if __name__ == "__main__":
    unittest.main()
