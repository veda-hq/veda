#!/usr/bin/env python3
"""Focused tests for the shared deterministic worktree boundary (``boundary.py``),
mostly through the Claude adapter (``worktree_guard.py``) that loads it.

Tests of the adapter's own behaviour live in ``test_worktree_guard.py``, which
reuses the fixtures here."""

from __future__ import annotations

import contextlib
import errno
import importlib.util
import io
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from collections.abc import Callable
from pathlib import Path
from unittest import mock


PACKAGE = Path(__file__).resolve().parents[1] / "kavach"
MODULE_PATH = PACKAGE / "boundary.py"
SPEC = importlib.util.spec_from_file_location("kavach_boundary_under_test", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

ADAPTER_PATH = PACKAGE / "worktree_guard.py"
ADAPTER_SPEC = importlib.util.spec_from_file_location(
    "kavach_worktree_guard_under_test", ADAPTER_PATH
)
assert ADAPTER_SPEC and ADAPTER_SPEC.loader
ADAPTER = importlib.util.module_from_spec(ADAPTER_SPEC)
sys.modules[ADAPTER_SPEC.name] = ADAPTER
ADAPTER_SPEC.loader.exec_module(ADAPTER)


# Values every fixture Git command runs with, whatever the machine adds.
#
# Dropping `GIT_*` keeps a run launched from inside a Git hook — where `GIT_DIR`
# and `GIT_INDEX_FILE` are exported — from operating on the hook's repository
# instead of the fixture, and closes the config-injection vectors git honours
# over the masks below (`GIT_CONFIG`, `GIT_CONFIG_PARAMETERS`, and the
# `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` family). The masks
# then remove what the developer's own configuration adds — in particular
# `trace2.eventtarget`, which reports every fixture commit to the git-ai daemon,
# which writes `refs/notes/ai` back INTO the fixture 0.8-3.6s later and races
# `tearDown` to `ENOTEMPTY`. The trace2 variables cover a target exported rather
# than configured, and take precedence over configuration.
#
# `setUp` sets `user.name`/`user.email` on the fixture, so nothing here needs
# the developer's identity. `boundary.py`'s own `git_environment` deliberately
# stays bare, because it inspects the REAL checkout, where `safe.directory` and
# `core.excludesfile` are part of the answer it is asked for.
#
# The guard's own settings variable is dropped too, so a developer's settings
# file never decides a verdict here; a test that needs settings sets it.
HERMETIC_GIT_VARIABLES = {
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_TRACE2": "0",
    "GIT_TRACE2_EVENT": "0",
    "GIT_TRACE2_PERF": "0",
}


def hermetic_git_env() -> dict[str, str]:
    """Environment for git commands inside a throwaway fixture repository."""

    environment = {
        key: value for key, value in os.environ.items() if not key.startswith("GIT_")
    }
    environment.update(HERMETIC_GIT_VARIABLES)
    environment.pop("KAVACH_CONFIG", None)
    return environment


def git(cwd: Path, *args: str) -> None:
    environment = hermetic_git_env()
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )


def git_output(cwd: Path, *args: str) -> str:
    """`git` for the assertions, isolated the same way as the fixture builder."""

    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        env=hermetic_git_env(),
    ).stdout.strip()


class GuardFixture(unittest.TestCase):
    """Temp-repository bootstrap and teardown shared by the guard fixtures.

    Only the parts that are genuinely identical live here. The two fixtures
    deliberately differ in whether they resolve their paths -- the memory
    fixture must, because the adapter derives a slug from the checkout git
    itself reports (physical), while the boundary fixture asserts against
    unresolved paths -- so path construction stays with each subclass.
    """

    temporary: tempfile.TemporaryDirectory[str]

    def make_repository(self, main: Path) -> None:
        """`git init` plus the one commit every fixture starts from."""
        main.mkdir(parents=True, exist_ok=True)
        git(main, "init", "-q")
        git(main, "config", "user.email", "guard@example.invalid")
        git(main, "config", "user.name", "Guard Test")
        git(main, "config", "commit.gpgsign", "false")
        (main / "tracked.txt").write_text("base\n", encoding="utf-8")
        (main / ".gitignore").write_text(".claude/worktrees/\n", encoding="utf-8")
        git(main, "add", "tracked.txt", ".gitignore")
        git(main, "commit", "-qm", "base")
        git(main, "branch", "-M", "main")

    def tearDown(self) -> None:
        # The git-ai daemon writes refs/notes/ai into any fresh repository a
        # few seconds after a commit, so cleanup races it and raises ENOTEMPTY.
        # `hermetic_git_env` is what removes that writer; these retries are the
        # backstop. They cannot close the window on their own — the racer is
        # another process — so they stay for any writer nobody has thought of.
        for attempt in range(5):
            try:
                self.temporary.cleanup()
                return
            except OSError as error:
                if error.errno != errno.ENOTEMPTY or attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))


class BoundaryFixture(GuardFixture):
    """A primary checkout, a Claude-managed worktree, a manual one, and an
    outside directory; and the adapter's verdict on one event, as the hook
    runs it. No tests of its own, so importing it runs nothing twice."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        temp = Path(self.temporary.name)
        self.main = temp / "main"
        self.claude = self.main / ".claude" / "worktrees" / "claude-task"
        self.manual = temp / "manual-task"
        self.external = temp / "external"
        self.external.mkdir()
        self.make_repository(self.main)
        self.claude.parent.mkdir(parents=True)
        git(self.main, "worktree", "add", "-qb", "claude-task", str(self.claude))
        git(self.main, "worktree", "add", "-qb", "manual-task", str(self.manual))

    def claude_bash(
        self, cwd: Path, command: str, env: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        """The Claude adapter's verdict on one Bash call, as the hook runs it."""

        return self.invoke(
            cwd, tool_name="Bash", tool_input={"command": command}, env=env
        )

    def invoke(
        self,
        cwd: Path,
        *,
        tool_name: str = "Write",
        tool_input: dict[str, str],
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        """The Claude adapter's verdict on one event, as the hook runs it."""

        return subprocess.run(
            [sys.executable, str(ADAPTER_PATH)],
            input=json.dumps(
                {"cwd": str(cwd), "tool_name": tool_name, "tool_input": tool_input}
            ),
            capture_output=True,
            text=True,
            check=False,
            env=hermetic_git_env() if env is None else env,
        )


class WorktreeBoundaryTest(BoundaryFixture):
    def test_classifies_all_checkout_types(self) -> None:
        main_state = MODULE.checkout_state(self.main)
        claude_state = MODULE.checkout_state(self.claude)
        manual_state = MODULE.checkout_state(self.manual)
        assert main_state and claude_state and manual_state
        primary = self.main.resolve()
        self.assertEqual(main_state, (primary, False, primary))
        self.assertEqual(claude_state, (self.claude.resolve(), True, primary))
        self.assertEqual(manual_state, (self.manual.resolve(), True, primary))
        self.assertFalse(MODULE.is_claude_managed(self.main, self.main))
        self.assertTrue(MODULE.is_claude_managed(self.claude, self.main))
        self.assertFalse(MODULE.is_claude_managed(self.manual, self.main))

    def test_checkout_state_reads_one_line_per_path_or_nothing(self) -> None:
        """The three paths come from one rev-parse.

        Its answer is read only when it is exactly three non-empty lines; any
        other shape is no answer, which every caller turns into a denial. This
        is the git path, which the file reader hands every layout it does not
        model.
        """

        expected = (self.claude.resolve(), True, self.main.resolve())
        self.assertEqual(MODULE.checkout_state_from_git(self.claude), expected)
        real = MODULE.run_git_all
        paths, listing = real([(self.claude, probe) for probe in MODULE.CHECKOUT_PROBES])
        assert paths and listing
        lines = paths.splitlines()
        for shape, answer in (
            ("two lines", "\n".join(lines[:2])),
            ("four lines", "\n".join([*lines, lines[0]])),
            ("an empty line", "\n".join([lines[0], "", lines[2]])),
        ):
            with self.subTest(shape=shape):
                MODULE.run_git_all = lambda calls, _answer=answer: [_answer, listing]
                try:
                    self.assertIsNone(MODULE.checkout_state_from_git(self.claude))
                finally:
                    MODULE.run_git_all = real

    def test_files_answer_as_git_does_without_starting_git(self) -> None:
        """The checkout read from git's files is git's own answer.

        Git is made to fail if started, so each case also proves the file
        reader settled it: a layout quietly handed back to git would not be
        faster, and a repository may run with per-worktree config.
        """

        (self.main / "sub").mkdir()
        (self.claude / "sub").mkdir()
        (self.external / "into-claude").symlink_to(self.claude, target_is_directory=True)
        git(self.main, "config", "extensions.worktreeConfig", "true")
        git(self.claude, "config", "--worktree", "core.untrackedCache", "true")
        places = (
            self.main,
            self.main / "sub",
            self.claude,
            self.claude / "sub",
            self.manual,
            self.external,
            self.external / "into-claude",
        )
        expected = {place: MODULE.checkout_state_from_git(place) for place in places}
        self.assertIsNone(expected[self.external])
        self.assertEqual(expected[self.claude], (self.claude.resolve(), True, self.main.resolve()))
        with mock.patch.object(MODULE, "run_git_all", side_effect=AssertionError("git started")):
            for place in places:
                with self.subTest(place=str(place)):
                    self.assertEqual(MODULE.checkout_state(place), expected[place])

    def test_layouts_the_files_do_not_model_go_to_git(self) -> None:
        """Each of these raises GitMustAnswer, and the guard then asks git."""

        bare = self.external / "bare.git"
        git(self.external, "init", "-q", "--bare", str(bare))
        through_bare = self.external / "through-bare"
        through_bare.mkdir()
        (through_bare / ".git").write_text(f"gitdir: {bare}\n", encoding="utf-8")
        garbled = self.external / "garbled"
        garbled.mkdir()
        (garbled / ".git").write_text("not a pointer\n", encoding="utf-8")
        linked = self.external / "linked"
        linked.mkdir()
        (linked / ".git").symlink_to(self.main / ".git", target_is_directory=True)
        cases = {
            "a git dir itself": self.main / ".git",
            "inside a linked worktree's git dir": self.main / ".git" / "worktrees" / "claude-task",
            "a bare repository's work tree": through_bare,
            "a .git file naming no git dir": garbled,
            "a symlinked .git": linked,
            "a missing directory": self.external / "missing",
        }
        for name, place in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(MODULE.GitMustAnswer):
                    MODULE.checkout_from_files(place)
                if place.is_dir():
                    self.assertEqual(
                        MODULE.checkout_state(place), MODULE.checkout_state_from_git(place)
                    )
        for name, key, value in (
            ("core.worktree", "core.worktree", str(self.external)),
            ("an include", "include.path", os.devnull),
            ("an unknown extension", "extensions.frobnicate", "true"),
        ):
            with self.subTest(config=name):
                git(self.main, "config", key, value)
                try:
                    with self.assertRaises(MODULE.GitMustAnswer):
                        MODULE.checkout_from_files(self.claude)
                    self.assertEqual(
                        MODULE.checkout_state(self.claude),
                        MODULE.checkout_state_from_git(self.claude),
                    )
                finally:
                    git(self.main, "config", "--unset", key)
        with self.subTest(case="owned by another user"):
            with mock.patch.object(MODULE.os, "geteuid", return_value=os.geteuid() + 1):
                with self.assertRaises(MODULE.GitMustAnswer):
                    MODULE.checkout_from_files(self.claude)

    def test_config_reader_moves_only_on_keys_that_move_the_checkout(self) -> None:
        config = self.external / "config"
        moves = {
            "core.worktree": "[core]\n\tworktree = /elsewhere\n",
            "core.bare true": "[core]\n\tbare = true\n",
            "core.bare as a bare key": "[core]\n\tbare\n",
            "a key on the header line": "[core] worktree = /elsewhere\n",
            "a comment after the header": "[core] # set below\n\tworktree = /elsewhere\n",
            "a comment hard after the header": "[ core ];x\n\tworktree = /elsewhere\n",
            "the old [core.sub] spelling": "[Core.sub]\n\tWorkTree = /elsewhere\n",
            "an include": '[includeIf "gitdir:/x/"]\n\tpath = y\n',
            "a continued line": "[core]\n\tbare = fa\\\nlse\n",
            "an unclosed header": "[core\n",
            "an empty header": "[]\n\tworktree = /elsewhere\n",
            "a blank header": "[ ]\n",
            "format 2": "[core]\n\trepositoryformatversion = 2\n",
            "an unknown extension": "[extensions]\n\tfrobnicate = true\n",
        }
        stays = {
            "an ordinary repository's shape": (
                "[core]\n\trepositoryformatversion = 1\n\tbare = false\n"
                '[extensions]\n\tworktreeConfig = true\n[branch "claude/worktree-x"]\n'
                "\tremote = origin\n"
            ),
            "a worktree key in another section": '[remote "worktree"]\n\tworktree = /x\n',
            "bare false with a comment": "[core]\n\tbare = false ; set by init\n",
            "comments and blank lines": "# [core]\n; worktree = /x\n\n[core]\n",
        }
        for name, text in moves.items():
            with self.subTest(moves=name):
                config.write_text(text, encoding="utf-8")
                with self.assertRaises(MODULE.GitMustAnswer):
                    MODULE.check_repository_config(config)
        for name, text in stays.items():
            with self.subTest(stays=name):
                config.write_text(text, encoding="utf-8")
                MODULE.check_repository_config(config)
        config.unlink()
        MODULE.check_repository_config(config)
        # A FIFO or device at a git path is refused before reading (a FIFO
        # would block forever). The null device reads empty, so only the
        # regular-file check can refuse it.
        with self.assertRaises(MODULE.GitMustAnswer):
            MODULE.check_repository_config(Path(os.devnull))

    def test_parallel_probes_reap_earlier_starts_when_one_fails(self) -> None:
        """A failed launch must not leave the probes already started behind."""

        class Started:
            def __init__(self, exited: bool) -> None:
                self.exited = exited
                self.events: list[str] = []

            def kill(self) -> None:
                self.events.append("kill")
                if self.exited:
                    raise ProcessLookupError

            def communicate(self) -> tuple[str, str]:
                self.events.append("communicate")
                return "", ""

        for exited in (False, True):
            with self.subTest(exited=exited):
                running, still_running = Started(exited), Started(False)
                launches = iter((running, still_running, OSError("no such directory")))

                def launch(*_args, **_kwargs) -> Started:
                    outcome = next(launches)
                    if isinstance(outcome, OSError):
                        raise outcome
                    return outcome

                with mock.patch.object(MODULE.subprocess, "Popen", launch):
                    with self.assertRaisesRegex(OSError, "no such directory"):
                        MODULE.run_git_all(
                            [(self.claude, ("rev-parse",))] * 2
                            + [(self.claude, ("status",))]
                        )
                # An already-exited probe is still reaped, and so is every later one.
                self.assertEqual(running.events, ["kill", "communicate"])
                self.assertEqual(still_running.events, ["kill", "communicate"])

    def test_unresolvable_checkout_denial_quotes_git(self) -> None:
        """A broken git must not present as a worktree-ownership problem.

        This denial fires for every Bash, Edit and Write call, so when git
        fails for an unrelated reason -- an unaccepted Xcode licence exits 69
        before git does any work -- a session reads "cannot determine this
        session's repository checkout" as an ownership fault and goes looking
        for the wrong thing. `run_git` had git's own message on stderr and
        dropped it.
        """

        # Negative control, `checkout_failure` reverted to `return ""`:
        #   AssertionError: 'not a git repository' not found in ''
        # This is the assertion defending the fix -- it observes git's own text,
        # which is exactly what the old paraphrase discarded. Confirmed.
        self.assertIn("not a git repository", MODULE.checkout_failure(self.external))
        adapter = ADAPTER_PATH
        result = subprocess.run(
            [sys.executable, str(adapter)],
            input=json.dumps(
                {
                    "cwd": str(self.external),
                    "tool_name": "Bash",
                    "tool_input": {"command": "touch x"},
                }
            ),
            capture_output=True, text=True, check=False,
            env=hermetic_git_env(),
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("cannot determine this session's repository", result.stderr)
        self.assertIn("not a git repository", result.stderr)

        # A LATER probe failing must not be reported as the first one's
        # successful output. Found in review: re-running only
        # `rev-parse --show-toplevel` meant stdout — the resolved repository
        # path — became the "failure reason", recreating exactly the confusion
        # this function removes. Every probe is named so the message can never
        # be a path.
        for index, probe in enumerate(MODULE.CHECKOUT_PROBES):
            with self.subTest(failing_probe=" ".join(probe)):
                real = MODULE.run_git_result

                def only_this_one_fails(cwd, *args, _index=index, _real=real):
                    if list(args) == list(MODULE.CHECKOUT_PROBES[_index]):
                        return subprocess.CompletedProcess(
                            args=["git", *args], returncode=128,
                            stdout="", stderr="fatal: probe %d is broken\n" % _index,
                        )
                    return _real(cwd, *args)

                MODULE.run_git_result = only_this_one_fails
                try:
                    message = MODULE.checkout_failure(self.claude)
                finally:
                    MODULE.run_git_result = real
                self.assertIn(f"probe {index} is broken", message)
                self.assertIn(" ".join(probe), message)
                self.assertNotIn(str(self.claude), message)

    def test_quoted_commands_preserve_the_boundary(self) -> None:
        owned = self.claude
        (owned / "escape").symlink_to(self.external, target_is_directory=True)
        allowed = (
            "gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}'",
            "gh api 'repos/{owner}/{repo}/pulls/404'",
            'echo "a > b"',
            "grep -n pattern file",
            "bash -c 'ls'",
            'touch "line\nname"',
            "touch './{literal}'",
            "echo '$(literal)'",
            "ONE=a TWO='b' grep -n pattern file",
            "! true",
            "noglob ls",
        )
        denied = (
            "tar -cf archive.tar *",
            "tar -cf archive.tar dist/*",
            'gh api graphql -f query="mutation($id)"',
            "echo hi > /etc/x",
            "python3 scripts/task.py",
            "python3 scripts/worktree.py retire --pr 404 --help",
            "python3 -c 'pass'",
            "python3 /outside/worktree/script.py",
            "/usr/bin/python3 script.py",
            f"touch '{self.external}/{{literal}}'",
            "touch 'escape/{literal}'",
            f"sh -c 'touch {self.external}/result'",
            "sh -c 'echo $(touch outside)'",
            "./grep -n pattern file",
            "PATH=./bin grep -n pattern file",
            "'NAME=value'",
            "NAME''=value",
            "''if",
            "command NAME=value",
            "exec NAME=value",
            "command if",
            '"!" true',
            "!'' true",
            "command ! true",
            "exec ! true",
            "env ! true",
            '"noglob" true',
            "noglob'' true",
            r"no\glob true",
            "command noglob true",
            "exec noglob true",
            "env noglob true",
        )
        for command, expected in [(value, 0) for value in allowed] + [(value, 2) for value in denied]:
            with self.subTest(command=command):
                result = self.claude_bash(owned, command)
                self.assertEqual(result.returncode, expected, result.stderr)
        # An empty target list must not permit execution from an unowned
        # checkout, and syntax failure must never become an empty success.
        for cwd in (self.main, self.manual):
            result = self.claude_bash(cwd, "bash -c 'ls'")
            self.assertEqual(result.returncode, 2, result.stderr)
        result = self.claude_bash(owned, "bash -c 'echo >'")
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_shared_documents_require_the_expected_worktree_link(self) -> None:
        shared = self.main / ".local"
        shared.mkdir()
        target = shared / "audits" / "run.md"
        self.assertFalse(MODULE.is_session_target(target, self.claude, self.main))
        (self.claude / ".local").symlink_to(shared, target_is_directory=True)
        self.assertTrue(MODULE.is_session_target(target, self.claude, self.main))
        self.assertFalse(MODULE.is_session_target(self.main / "tracked.txt", self.claude, self.main))
        self.assertFalse(MODULE.is_session_target(self.manual / "tracked.txt", self.claude, self.main))
        (self.claude / ".local").unlink()
        (self.claude / ".local").symlink_to(self.main, target_is_directory=True)
        self.assertFalse(MODULE.is_session_target(target, self.claude, self.main))

    def test_shared_document_exception_requires_real_directory(self) -> None:
        shared = self.main / ".local"
        root = self.claude
        (root / ".local").symlink_to(shared, target_is_directory=True)
        for state in ("absent", "file", "symlink", "directory"):
            if state == "file":
                shared.write_text("not a directory")
            elif state == "symlink":
                shared.unlink()
                shared.symlink_to(self.external, target_is_directory=True)
            elif state == "directory":
                shared.unlink()
                shared.mkdir()
            with self.subTest(state=state):
                # Target the exception root itself: a regular file cannot
                # hide behind an impossible child path in this regression.
                result = self.claude_bash(root, 'touch .local')
                self.assertEqual(result.returncode, 0 if state == "directory" else 2, result.stderr)
                edit = self.invoke(root, tool_input={"file_path": str(root / ".local")})
                self.assertEqual(edit.returncode, 0 if state == "directory" else 2, edit.stderr)

    def test_git_output_destinations_are_confined(self) -> None:
        owned = self.claude
        nested = owned / "nested"
        nested.mkdir()
        for verb in ("diff", "show", "log"):
            for separator in ("=", " "):
                for cwd, destination, expected in (
                    (owned, "result with spaces.patch", 0),
                    (owned, str(self.external / "outside.patch"), 2),
                    (owned, os.path.relpath(self.external / "outside.patch", owned), 2),
                    (self.main, "outside.patch", 2),
                    (self.manual, "outside.patch", 2),
                ):
                    command = f'git {verb} --output{separator}"{destination}"'
                    with self.subTest(command=command, cwd=cwd):
                        result = self.claude_bash(cwd, command)
                        self.assertEqual(result.returncode, expected, result.stderr)
            for destination, expected in (("result.patch", 0), ("../../../../outside.patch", 2)):
                command = f'git -C nested -C .. {verb} --output="{destination}"'
                with self.subTest(command=command):
                    result = self.claude_bash(owned, command)
                    self.assertEqual(result.returncode, expected, result.stderr)
            # Resolving -C twice would put this output inside owned/nested
            # and accidentally allow the actual outside-owned destination.
            command = f'git -C nested {verb} --output=../../outside.patch'
            result = self.claude_bash(owned, command)
            self.assertEqual(result.returncode, 2, result.stderr)

    def test_git_inspection_flags_preserve_reads_and_deny_ambiguous_writes(self) -> None:
        reads = ("git diff --stat", "git show HEAD", "git log -1 --oneline", "git diff -- --output=filename", "git show -- --ext-diff")
        writes = ("git diff --output", "git diff --output=", "git diff --ext-diff", "git log --textconv", "git diff --out=result", "git rev-list --unknown-write-option", "git --paginate log", "git log --pretty --output=outside.patch")
        for cwd in (self.claude, self.main, self.manual):
            for command, expected in [(command, 0) for command in reads] + [(command, 2) for command in writes]:
                with self.subTest(cwd=cwd, command=command):
                    result = self.claude_bash(cwd, command)
                    self.assertEqual(result.returncode, expected, result.stderr)

    def test_managed_task_resolves_relative_shell_navigation(self) -> None:
        relative_main = os.path.relpath(self.main, self.claude)
        inspection = self.invoke(
            self.claude,
            tool_name="Bash",
            tool_input={"command": f"cd {relative_main} && git status --short"},
        )
        mutation = self.invoke(
            self.claude,
            tool_name="Bash",
            tool_input={"command": f"cd {relative_main} && touch changed.txt"},
        )
        self.assertEqual(inspection.returncode, 0, inspection.stderr)
        self.assertEqual(mutation.returncode, 2, mutation.stderr)
        self.assertIn("outside this session's Claude worktree", mutation.stderr)

        unresolved = self.invoke(
            self.claude,
            tool_name="Bash",
            tool_input={"command": 'cd "$OTHER_WORKTREE" && touch changed.txt'},
        )
        self.assertEqual(unresolved.returncode, 2, unresolved.stderr)
        self.assertIn("could not be resolved", unresolved.stderr)

    def test_managed_task_rejects_conditional_shell_navigation(self) -> None:
        relative_main = os.path.relpath(self.main, self.claude)
        result = self.invoke(
            self.claude,
            tool_name="Bash",
            tool_input={
                "command": (
                    f"cd {relative_main} || cd {self.claude}; "
                    "touch changed.txt"
                )
            },
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("could not be resolved", result.stderr)

    def test_managed_task_rejects_wrapped_shell_navigation(self) -> None:
        relative_main = os.path.relpath(self.main, self.claude)
        commands = (
            f"! cd {relative_main}; touch changed.txt",
            f"builtin cd {relative_main}; touch changed.txt",
            f"command cd {relative_main}; touch changed.txt",
            f"command -p git -C {relative_main} branch unsafe-branch",
            f"command -- git -C {relative_main} branch unsafe-branch",
            f"env git -C {relative_main} branch unsafe-branch",
            f'env -S "git -C {relative_main} branch unsafe-branch"',
            f"exec git -C {relative_main} branch unsafe-branch",
            f"time git -C {relative_main} branch unsafe-branch",
            f"nice git -C {relative_main} branch unsafe-branch",
            f"noglob cd {relative_main}; touch changed.txt",
            f"if cd {relative_main}; then touch changed.txt; fi",
            f"command git -C {relative_main} branch unsafe-branch",
        )
        for command in commands:
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("BLOCKED:", result.stderr)

    def test_managed_task_rejects_directory_stack_navigation(self) -> None:
        relative_main = os.path.relpath(self.main, self.claude)
        commands = (
            f"pushd {relative_main}; touch changed.txt",
            "popd; touch changed.txt",
        )
        for command in commands:
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                # Negative control before directory-stack parsing:
                # AssertionError: 0 != 2
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("could not be resolved", result.stderr)

    def test_navigation_words_as_arguments_remain_allowed(self) -> None:
        commands = (
            "touch cd",
            "touch -- -C",
            "rg cd tracked.txt && touch changed.txt",
            "if rg cd tracked.txt; then touch changed.txt; fi",
            "rg cd tracked.txt || touch changed.txt",
            "rg git -C tracked.txt && touch changed.txt",
        )
        for command in commands:
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_managed_task_resolves_cumulative_git_c_paths(self) -> None:
        temp_root = self.main.parent
        relative_root = os.path.relpath(temp_root, self.claude)
        inspection = self.invoke(
            self.claude,
            tool_name="Bash",
            tool_input={"command": f"git -C {relative_root} -C main status --short"},
        )
        mutation = self.invoke(
            self.claude,
            tool_name="Bash",
            tool_input={"command": f"git -C {relative_root} -C main branch new-branch"},
        )
        self.assertEqual(inspection.returncode, 0, inspection.stderr)
        self.assertEqual(mutation.returncode, 2, mutation.stderr)
        self.assertIn("outside this session's Claude worktree", mutation.stderr)

        unresolved = self.invoke(
            self.claude,
            tool_name="Bash",
            tool_input={"command": 'git -C "$OTHER_WORKTREE" branch new-branch'},
        )
        self.assertEqual(unresolved.returncode, 2, unresolved.stderr)
        self.assertIn("could not be resolved", unresolved.stderr)

    # The forms once refused with `-C` and allowed without it: control
    # operators, subshells and wrappers.
    GIT_C_FORMS = (
        "{git} commit --amend --no-edit",
        "{git} commit --amend --no-edit || true",
        "({git} commit --amend --no-edit)",
        "GIT_EDITOR=true {git} commit --amend",
        "env GIT_EDITOR=true {git} commit --amend",
        "command {git} commit --amend --no-edit",
        "time {git} commit --amend --no-edit",
        "nice {git} commit --amend --no-edit",
        "exec {git} commit --amend --no-edit",
        "! {git} commit --amend --no-edit",
        "{git} log -1 --format='%(trailers)'",
        "{git} log -1 --format='%(trailers)' || true",
        "GIT_PAGER=cat {git} log -1 --format='%(trailers:key=Signed-off-by,valueonly)'",
        "{git} log --oneline HEAD --not main",
        "{git} rev-list --count HEAD --not main || true",
        "{git} commit --amend --no-edit && {git} log -1 --format='%(trailers)'",
    )

    def test_git_c_own_worktree_is_judged_as_the_plain_command(self) -> None:
        subdirectory = self.claude / "sub"
        subdirectory.mkdir()
        relative = os.path.relpath(self.claude, subdirectory)
        for form in self.GIT_C_FORMS:
            for cwd, git_c in (
                (self.claude, "git"),
                (self.claude, f"git -C {self.claude}"),
                (self.claude, "git -C ."),
                (subdirectory, f"git -C {self.claude}"),
                (subdirectory, f"git -C {relative}"),
            ):
                command = form.format(git=git_c)
                with self.subTest(cwd=str(cwd), command=command):
                    result = self.invoke(
                        cwd, tool_name="Bash", tool_input={"command": command}
                    )
                    # Negative control before these forms were read, `|| true`, wrapper and
                    # subshell forms only: AssertionError: 2 != 0 ... BLOCKED:
                    # mutation targets could not be resolved
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_git_c_other_checkout_stays_refused_in_every_form(self) -> None:
        for form in self.GIT_C_FORMS:
            if "commit" not in form:
                # Read-only inspection of another checkout is allowed with
                # or without -C; only its mutations are confined.
                continue
            for other in (self.main, self.manual):
                command = form.format(git=f"git -C {other}")
                with self.subTest(command=command):
                    result = self.invoke(
                        self.claude, tool_name="Bash", tool_input={"command": command}
                    )
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn("outside this session's Claude worktree", result.stderr)

    def test_git_c_own_worktree_keeps_every_other_refusal(self) -> None:
        commands = (
            # cd under control flow or a wrapper still fails closed, so a
            # relative -C can never resolve from a directory the model lost.
            f"cd {self.main} || git -C . commit --amend --no-edit",
            f"(cd {self.main} && git -C . commit --amend --no-edit)",
            f"builtin cd {self.main}; git -C . commit --amend --no-edit",
            # Repository selection and lookup changes stay refused.
            f"git -C {self.claude} -c core.hooksPath=/dev/null commit --amend",
            f"git -C {self.claude} --git-dir={self.main}/.git commit --amend",
            f"PATH=/tmp git -C {self.claude} commit --amend --no-edit",
            f"command -p git -C {self.claude} commit --amend --no-edit",
            f"env -C {self.main} git -C . commit --amend --no-edit",
            f'git -C "$OTHER_WORKTREE" commit --amend --no-edit || true',
            f"xargs git -C {self.claude} commit --amend --no-edit",
        )
        for command in commands:
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude, tool_name="Bash", tool_input={"command": command}
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("BLOCKED:", result.stderr)

    def test_reviewed_redirections_open_no_file(self) -> None:
        """`2>&1`, `>&2` and /dev/null targets resolve; every other one fails closed.

        Once any `<` or `>` made the scanner give up, so
        `grep -rl x . 2>/dev/null | head` was refused although the same
        command without the redirection passed.
        """

        (self.claude / "victim.txt").write_text("x", encoding="utf-8")
        allowed = (
            "grep -rl base . 2>/dev/null | head",
            "grep base tracked.txt 2>&1 | head -5",
            "git log -1 --format=%B 2>&1",
            "git status --short >/dev/null",
            "ls 2>>/dev/null",
            "ls &>/dev/null",
            "ls &>>/dev/null",
            "ls >|/dev/null",
            "ls > /dev/null 2>&1",
            "ls >&2",
            "ls 3>&- >&-",
            # Digits alone are a descriptor in bash, zsh and sh: a closed one
            # fails with "Bad file descriptor" and creates no file `123`.
            "ls >&123",
            "2>/dev/null ls",
            "(ls 2>/dev/null)",
            "rm -f victim.txt 2>/dev/null",
            "git commit --amend --no-edit 2>&1 | tail -3",
            # Input opens a file for reading only.
            "ls < tracked.txt",
            "wc -l <tracked.txt",
            "cat 0< tracked.txt <&0 <&-",
            "cat <<< 'some text'",
            "wc -l <tracked.txt; echo x",
            "cat <tracked.txt | head -1",
            "cat <tracked.txt>/dev/null",
            "cat < <(ls)",
        )
        for command in allowed:
            with self.subTest(command=command):
                result = self.claude_bash(self.claude, command)
                self.assertEqual(result.returncode, 0, result.stderr)
        unresolved = (
            "ls > out.txt",
            "ls >> out.txt",
            "ls >& out.txt",
            "ls &> out.txt",
            "ls 2>/dev/nullx",
            "ls >/dev/null/x",
            "ls >&1x",
            # zsh, the Bash tool's shell here, writes a file named `3-`.
            "ls 4>&3-",
            "ls >&9-",
            "ls 2>& 1",
            "ls >'/dev/null'",
            "cat <<EOF",
            # `<>` opens its file for writing too, creating it.
            "cat <> tracked.txt",
            "ls >(cat)",
            # A quoted digit is an argument, so this runs a program named 2.
            '"2">/dev/null ls',
        )
        for command in unresolved:
            with self.subTest(command=command):
                result = self.claude_bash(self.claude, command)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("could not be resolved", result.stderr)
        # `²` is not a descriptor in any shell: it stays touch's operand, here
        # a link out of the worktree (str.isdigit() would have dropped it).
        (self.claude / "²").symlink_to(self.external / "linked.txt")
        outside = (
            "touch ²>/dev/null",
            f"rm -f {self.external / 'x'} 2>/dev/null",
            f"git -C {self.main} commit --amend --no-edit 2>&1 | tail -3",
        )
        for command in outside:
            with self.subTest(command=command):
                result = self.claude_bash(self.claude, command)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("outside this session's Claude worktree", result.stderr)

    def test_a_for_header_writes_nothing(self) -> None:
        """Every `for` loop was once refused, its body unread."""

        allowed = (
            'for n in 1 2; do sed -n "${n},5p" tracked.txt; echo ---; done; '
            "git stash list | head -0; git show main:tracked.txt | grep -c base",
            "for f in tracked.txt; do git log -1 --format=%h -- $f; done",
            "for n; do echo $n; done",
            "for n in a b\ndo\n  sed -n \"${n}p\" tracked.txt\ndone",
            "while read -r line; do echo $line; done",
            "read -rs answer rest",
            "read -r -- line",
            "read",
            # The quiet-machine check before a heavy emulator run.
            "pgrep -fl qemu-system",
            "pgrep -fl GradleDaemon; pgrep -fl detox; uptime",
            "ps -axo pid,command | grep -c gradle",
            # Read-only substitutions in a header.
            "for n in $(ls); do echo $n; done",
        )
        for command in allowed:
            with self.subTest(command=command):
                result = self.claude_bash(self.claude, command)
                self.assertEqual(result.returncode, 0, result.stderr)
        unresolved = (
            # The variable makes the body's path unknown.
            "for n in a b; do touch made-$n.txt; done",
            # The name may be exported in the Bash tool's shell, which the
            # hook cannot see, so a write on the same line fails closed.
            "for n in a b; do touch made.txt; done",
            "read -r line; touch made.txt",
            "while read -r line; do rm -f victim.txt; done",
            # These names change what later segments run or which repository.
            "for PATH in /tmp; do git status; done",
            "for GIT_DIR in /tmp; do git commit --amend; done",
            '"for" n in a b; do echo; done',
            "for ((i=0;i<2;i++)); do echo; done",
            # A substitution that may write is still refused.
            "for n in $(touch made.txt); do echo $n; done",
            "pkill -f qemu-system",
            # zsh's lowercase specials and exported names steer later segments.
            "for path in /tmp; do git status; done",
            "zsh -c 'for path in /tmp; do git status; done'",
            "for cdpath in /tmp; do cd x; done",
            "for npm_config_prefix in /tmp; do echo; done",
            "read PATH; touch made.txt",
            "read -r path; touch made.txt",
            "read -a commands",
            "read -A fpath",
            # zsh's -p reads the coprocess: PATH is then a name, not a prompt.
            "read -p PATH; touch made.txt",
            "read -e words",
            "read -a words",
            "read 'x?prompt'",
            "read -k x",
            # A body runs once per iteration; one modelled `cd` would be short.
            "for n in a b; do cd ..; done; touch made.txt",
            "while true; do cd ..; done; touch made.txt",
            "until false; do cd ..; done; touch made.txt",
        )
        for command in unresolved:
            with self.subTest(command=command):
                result = self.claude_bash(self.claude, command)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("could not be resolved", result.stderr)
        result = self.claude_bash(
            self.claude, f"for n in a b; do rm -f {self.external / 'x'}; done"
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("BLOCKED:", result.stderr)
        for command in ("git stash list", "git stash show -p", "git stash list --oneline"):
            with self.subTest(command=command):
                self.assertTrue(MODULE.shell_is_read_only(command))
        for command in ("git stash", "git stash pop", "git stash list --output=x"):
            with self.subTest(command=command):
                self.assertFalse(MODULE.shell_is_read_only(command))

    def test_sed_empty_suffix_program_is_a_file_only_if_it_exists(self) -> None:
        """BSD `sed -i ''` reads the next word as the program, GNU as a file.

        sed -i rewrites only files it can open, so that word is a target only
        when it names an existing path.
        """

        (self.claude / "edited.txt").write_text("import x\n", encoding="utf-8")
        outside = self.external / "existing.txt"
        outside.write_text("x\n", encoding="utf-8")
        allowed = (
            "sed -i '' '/^import/d' edited.txt",
            "sed -i '' '/^import/d; s/a/b/' edited.txt",
            f"sed -i '' '/^import/d' {self.claude / 'edited.txt'}",
            "sed -i '' 's/a/b/' edited.txt 2>&1",
        )
        for command in allowed:
            with self.subTest(command=command):
                result = self.claude_bash(self.claude, command)
                self.assertEqual(result.returncode, 0, result.stderr)
        refused = (
            # The word names an existing file outside: GNU sed would edit it.
            f"sed -i '' '{outside}' edited.txt",
            f"sed -i '' '/^import/d' {outside}",
            f"sed -i '' -e 's/a/b/' {outside}",
        )
        for command in refused:
            with self.subTest(command=command):
                result = self.claude_bash(self.claude, command)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("outside this session's Claude worktree", result.stderr)

    def test_managed_task_confines_mutation_path_operands(self) -> None:
        outside_commands = (
            f"rm {self.external / 'removed.txt'}",
            f"chmod 600 {self.external / 'chmod-target.txt'}",
            f"chown 1000 {self.external / 'chown-target.txt'}",
            f"chgrp 1000 {self.external / 'chgrp-target.txt'}",
            f"cp tracked.txt {self.external / 'copied.txt'}",
            f"cp -t {self.external} tracked.txt",
            f"install -d {self.external / 'installed-directory'}",
            f"mv movable.txt {self.external / 'moved.txt'}",
            f"git worktree add {self.external / 'new-worktree'} HEAD",
            f"git worktree add -b review-test {self.external / 'branched-worktree'} HEAD",
            f"sed --in-place s/base/changed/ {self.external / 'edited.txt'}",
            f"find {self.external} -delete",
            f"find . -fprint {self.external / 'find-report.txt'}",
            f"truncate -s 0 {self.external / 'truncated.txt'}",
            f"tee {self.external / 'tee-output.txt'}",
            f"dd if=/dev/null of={self.external / 'dd-output.txt'}",
            f"time rm {self.external / 'timed-remove.txt'}",
            f"time -p chmod 600 {self.external / 'timed-chmod-target.txt'}",
            f"nice -n 5 chown 1000 {self.external / 'nice-chown-target.txt'}",
            f"sh -c 'rm {self.external / 'nested-shell-remove.txt'}'",
            f"bash -c 'cp tracked.txt {self.external / 'nested-shell-copy.txt'}'",
        )
        for command in outside_commands:
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("outside this session's Claude worktree", result.stderr)

        unresolved_commands = (
            'rm "$REMOVE_TARGET"',
            'chmod 600 "$CHMOD_TARGET"',
            'chown 1000 "$CHOWN_TARGET"',
            'chgrp 1000 "$CHGRP_TARGET"',
            'cp tracked.txt "$COPY_TARGET"',
            'git worktree add "$WORKTREE_TARGET" HEAD',
            'find "$FIND_TARGET" -delete',
            'find . -fprint "$FIND_REPORT"',
            'truncate -s 0 "$TRUNCATE_TARGET"',
            'tee "$TEE_TARGET"',
            'dd if=/dev/null "of=$DD_TARGET"',
            'time rm "$TIMED_REMOVE_TARGET"',
        )
        for command in unresolved_commands:
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("could not be resolved", result.stderr)

        inside_commands = (
            "rm removable.txt",
            "chmod 600 tracked.txt",
            'chmod "$MODE" tracked.txt',
            "chmod --reference=/tmp/reference-mode tracked.txt",
            "chown 1000 tracked.txt",
            'chown "$OWNER" tracked.txt',
            "chown --reference=/tmp/reference-owner tracked.txt",
            "chgrp 1000 tracked.txt",
            "cp tracked.txt copied.txt",
            f"cp {self.external / 'readable-source.txt'} copied-from-outside.txt",
            f"ln -s {self.external / 'link-target.txt'} inside-link.txt",
            "git worktree add nested-worktree HEAD",
            "sed --in-place s/base/changed/ tracked.txt",
            "find . -delete",
            "find . -fprint find-report.txt",
            "truncate -s 0 truncated.txt",
            "tee tee-output.txt",
            "dd if=/dev/null of=dd-output.txt",
            "time rm removable.txt",
            "nice -n 5 chmod 600 tracked.txt",
            "sh -c 'rm removable.txt'",
            "bash -lc 'cp tracked.txt nested-shell-copy.txt'",
            "time pnpm test",
            "nice pnpm test",
        )
        for command in inside_commands:
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_managed_task_rejects_ambiguous_mutator_destinations(self) -> None:
        commands = (
            f"find -Z {self.external} -delete",
            f"truncate --unknown {self.external / 'truncated.txt'}",
            f"tee --unknown {self.external / 'tee-output.txt'}",
            f"dd unsupported {self.external / 'dd-output.txt'}",
            f"rsync tracked.txt {self.external / 'rsync-output.txt'}",
            f"unknown --output={self.external / 'unknown-output.txt'}",
            'unknown "$UNKNOWN_TARGET"',
            'unknown "--output=$UNKNOWN_TARGET"',
            f"curl -o{self.external / 'curl-output.txt'} https://example.test",
            f"tar -cf{self.external / 'archive.tar'} tracked.txt",
            "sh script-that-cannot-be-inspected.sh",
        )
        for command in commands:
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                unresolved = (
                    "$" in command
                    or "--unknown" in command
                    or "unsupported" in command
                    or " -Z " in command
                    or command.startswith(
                        ("curl -o", "tar -cf", "sh script", "unknown")
                    )
                )
                if unresolved:
                    self.assertIn("could not be resolved", result.stderr)
                else:
                    self.assertIn(
                        "outside this session's Claude worktree", result.stderr
                    )

    def test_managed_task_rejects_non_shell_inline_programs(self) -> None:
        commands = (
            (
                "python3 -c 'from pathlib import Path; "
                'Path("..", "..", "escaped").write_text("x")\''
            ),
            (
                "python3 -Ic 'from pathlib import Path; "
                'Path("..", "..", "escaped").write_text("x")\''
            ),
            (
                "python3 -X dev -W ignore -c 'from pathlib import Path; "
                'Path("..", "..", "escaped").write_text("x")\''
            ),
            (
                "julia -e 'open(joinpath(\"..\", \"..\", \"escaped\"), "
                '\"w\") do io; write(io, \"x\"); end\''
            ),
            (
                "pwsh -Command '$parts = @(\"..\", \"..\", \"escaped\"); "
                "Set-Content -Path ([IO.Path]::Combine($parts)) -Value x'"
            ),
            (
                "node --eval 'require(\"fs\").writeFileSync("
                '"..".concat(String.fromCharCode(47), "..", '
                'String.fromCharCode(47), "escaped"), "x")\''
            ),
            (
                "bun -e 'Bun.write(String.fromCharCode(46,46,47,46,46,47,"
                "101,115,99,97,112,101,100), \"x\")'"
            ),
            'ruby -e \'File.write(File.join("..", "..", "escaped"), "x")\'',
            (
                "perl -MFile::Spec -e 'open(F, \">\", "
                'File::Spec->catfile("..", "..", "escaped"))\''
            ),
            (
                "php -r 'file_put_contents(join(DIRECTORY_SEPARATOR, "
                'array("..", "..", "escaped")), "x");\''
            ),
        )
        for command in commands:
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("could not be resolved", result.stderr)

    def test_managed_task_rejects_non_shell_interpreter_script_files(self) -> None:
        for command in (
            "python3 scripts/task.py",
            "python3 -I scripts/task.py",
            "python3.12 scripts/task.py",
            "node scripts/task.js",
            "node --import tsx scripts/task.ts",
            "bun scripts/task.ts",
            "ruby scripts/task.rb",
            "perl scripts/task.pl",
            "php scripts/task.php",
            "lua scripts/task.lua",
        ):
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("could not be resolved", result.stderr)

    def test_read_only_shell_segment_does_not_poison_a_compound_command(self) -> None:
        """A read-only `bash -n` beside a mutation must not deny the whole line.

        `shell_is_read_only` needs EVERY segment to be read-only, so a compound
        command containing one mutation arrives at `mutation_directories`
        entire. The nested-program branch there fails closed on any shell not
        running a `-c` program, which refused `rm -f x && bash -n y` even
        though each half is allowed alone. Found by running the command, not by
        reading the parser.
        """

        (self.claude / "victim.txt").write_text("x", encoding="utf-8")
        for command in (
            "rm -f victim.txt && bash -n scripts/task.sh",
            "bash -n scripts/task.sh && touch made.txt",
            "touch made.txt && bash --version",
        ):
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude, tool_name="Bash", tool_input={"command": command}
                )
                # Negative control, the read-only short-circuit
                # before the nested-shell branch reverted to `and False`:
                #   all three subTests
                #   AssertionError: 2 != 0 : BLOCKED: shell mutation target
                #   could not be resolved
                # This is the assertion defending the fix -- the denial it
                # catches is the poisoned compound command itself, not a
                # fixture or import failure. Confirmed.
                self.assertEqual(result.returncode, 0, result.stderr)
        # The mutating half is still gated, and an executing shell still fails
        # closed, so the skip cannot be reached by dropping the -n.
        for command, expected in (
            (f"rm -f {self.external / 'victim.txt'} && bash -n scripts/task.sh", 2),
            ("touch made.txt && bash scripts/task.sh", 2),
            ("touch made.txt && bash -v scripts/task.sh", 2),
        ):
            with self.subTest(denied=command):
                result = self.invoke(
                    self.claude, tool_name="Bash", tool_input={"command": command}
                )
                self.assertEqual(result.returncode, expected, result.stderr)

    def test_toolchain_managers_stay_behind_the_worktree_gate(self) -> None:
        """`mise`, `pod`, `bundle` and `gem` are runners, not read-only commands.

        Naming them makes their command lines parseable, which is the whole
        fix -- an executable absent from every set is treated as a possible
        interpreter and refused with a message about mutation targets. It does
        NOT claim they write nothing, so each must still be refused from a
        checkout this session does not own. For mise that is measured, not
        assumed: `--version` refreshes a cache and the first config read
        records the file under mise's state directory.

        `mise exec -- node -e` is in the allowed list deliberately, and it is
        the case worth being explicit about: a reviewed runner may invoke an
        interpreter as its own argument, and this hook does not see through
        that. Listing `mise` is what newly admits it -- it was refused before,
        as an unknown executable -- but it does not widen the shape: the
        equivalence assertion below pins identical behaviour on `pnpm exec`,
        `npx` and `npm exec`, which all predate this change, so a reader can
        see that the inline-interpreter refusals in
        test_version_queries_and_noexec_run_from_any_checkout constrain the
        BARE spelling rather than the capability. What bounds the capability is
        the worktree gate, which every command here still faces.
        """

        for command in (
            "mise",
            "mise --version",
            "mise ls",
            "mise install",
            "mise exec -- node -e '1'",
            "pod install",
            "bundle exec fastlane",
            "gem list",
        ):
            with self.subTest(command=command):
                owned = self.invoke(
                    self.claude, tool_name="Bash", tool_input={"command": command}
                )
                # Negative control, `"mise"` removed from
                # GENERIC_SCOPED_COMMANDS: every mise subTest fails here with
                #   AssertionError: 2 != 0 : BLOCKED: mutation targets could
                #   not be resolved
                # which is the refusal this change fixes.
                self.assertEqual(owned.returncode, 0, owned.stderr)
                for cwd in (self.main, self.manual):
                    refused = self.invoke(
                        cwd, tool_name="Bash", tool_input={"command": command}
                    )
                    self.assertEqual(refused.returncode, 2, refused.stderr)
                    self.assertIn("Claude-managed worktree", refused.stderr)
        # Declared path operands stay confined even for a reviewed runner.
        escape = self.invoke(
            self.claude,
            tool_name="Bash",
            tool_input={"command": f"pod install --project-directory={self.external}"},
        )
        self.assertEqual(escape.returncode, 2, escape.stderr)
        self.assertIn("outside this session's Claude worktree", escape.stderr)
        # The equivalence that makes `mise exec -- node -e` unremarkable. Every
        # one of these predates `mise`'s admission, so the runner-invokes-an-
        # interpreter shape is the set's standing contract and not a hole this
        # change opened. Asserted rather than asserted-in-prose because the
        # claim is exactly what a reviewer would otherwise have to take on
        # trust.
        for command in (
            "pnpm exec node -e '1'",
            "npx node -e '1'",
            "npm exec node -e '1'",
        ):
            with self.subTest(predates=command):
                result = self.invoke(
                    self.claude, tool_name="Bash", tool_input={"command": command}
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_retired_fnm_is_an_unknown_executable(self) -> None:
        """fnm was replaced by mise, so the guard no longer reviews it.

        Even this session's own worktree refuses it, as it refuses every unlisted
        executable is: it might be an interpreter, so its targets
        cannot be proved. Its read-only spellings no longer pass from the
        primary checkout either.
        """

        for command in (
            "fnm",
            "fnm list",
            "fnm --version",
            "fnm install 22",
            "fnm exec --using=22 node -e '1'",
        ):
            with self.subTest(command=command):
                owned = self.invoke(
                    self.claude, tool_name="Bash", tool_input={"command": command}
                )
                self.assertEqual(owned.returncode, 2, owned.stderr)
                self.assertIn("mutation targets could not be resolved", owned.stderr)
                primary = self.invoke(
                    self.main, tool_name="Bash", tool_input={"command": command}
                )
                self.assertEqual(primary.returncode, 2, primary.stderr)

    def test_version_queries_and_noexec_run_from_any_checkout(self) -> None:
        """The node probes of the fnm/node brief, plus what must stay denied.

        These write nothing, so they are read-only and run from the primary
        checkout as well as an owned worktree. The negatives are the point:
        the interpreter contract for `node` survives for the BARE spelling,
        and `bash`'s `-v` is verbose mode rather than a version query.

        "For the bare spelling" is the honest scope, and it is narrower than
        it looks. A reviewed runner can still invoke `node -e` as its own
        argument, which predates this change and is pinned in
        test_toolchain_managers_stay_behind_the_worktree_gate. These negatives
        say the direct spelling is refused; they do not claim the capability is
        unreachable.
        """

        for command in (
            "node --version",
            "node -v",
            "nodejs --version",
            "bash -n scripts/lib/select-node.sh",
            "bash -nx scripts/lib/select-node.sh",
            "sh -n scripts/lib/select-node.sh",
            "bash --version",
            "shellcheck scripts/lib/select-node.sh",
        ):
            for cwd in (self.claude, self.main, self.manual):
                with self.subTest(allowed=command, cwd=cwd.name):
                    result = self.invoke(
                        cwd, tool_name="Bash", tool_input={"command": command}
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
        for command in (
            # The inline-interpreter contract for node is unchanged.
            "node -e '1'",
            "node -p 'process.env'",
            "node --eval '1'",
            "node scripts/task.js",
            "node",
            # bash -v is verbose mode; the program still executes.
            "bash -v scripts/task.sh",
            # -n after the operand is a positional parameter, not noexec.
            "bash scripts/task.sh -n",
            # An interactive shell ignores -n.
            "bash -i -n scripts/task.sh",
            # -c names a program whose options this parser does not interpret.
            "bash -no errexit scripts/task.sh",
            # Every mise command can write mise's own state (the toolchain
            # comment in worktree-boundary.py), so none is read-only.
            "mise --version",
            "mise ls",
            # A path-qualified lookalike is arbitrary code.
            "./mise ls",
            "./node --version",
        ):
            with self.subTest(denied=command):
                result = self.invoke(
                    self.main, tool_name="Bash", tool_input={"command": command}
                )
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_adb_reads_run_from_every_checkout(self) -> None:
        """Debugging a mobile app over USB starts with these, from anywhere.

        Every one was refused before with "mutation targets could not be
        resolved": an executable no parser knew was treated as a possible
        interpreter. They change neither this host's files nor the device.
        """

        for command in (
            "adb devices -l",
            "adb version",
            "adb -s emulator-5554 get-state",
            "adb logcat -d -v time",
            "adb logcat -d -b crash ReactNativeJS:V",
            "adb shell pm list packages",
            "adb shell pm list packages -3 example",
            "adb shell 'pm path com.example.app'",
            "adb shell dumpsys package com.example.app",
            "adb shell dumpsys meminfo com.example.app",
            "adb shell getprop ro.build.version.sdk",
            "adb exec-out getprop",
            "adb shell logcat -d -t 200",
            "adb shell pidof com.example.app",
        ):
            for cwd in (self.claude, self.main, self.manual):
                with self.subTest(command=command, cwd=cwd.name):
                    result = self.claude_bash(cwd, command)
                    # Negative control, the `adb` branch of
                    # `segment_is_read_only` removed:
                    #   subTest command='adb devices -l', cwd='main'
                    #   AssertionError: 2 != 0 : BLOCKED: Claude mutations
                    #   require this session's Claude-managed worktree
                    # Removing the `adb` parser too reproduces the reported
                    # "mutation targets could not be resolved" from the
                    # session's own worktree.
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_adb_device_writes_run_only_from_the_owned_worktree(self) -> None:
        """Phone-side changes write nothing in a checkout.

        They take the reviewed runners' place: allowed from this session's
        own worktree, refused from one it does not own. A host file they only
        READ, such as the APK, is not a destination, and a device path is never
        resolved on the host at all.
        """

        for command in (
            "adb install -r android/app/build/outputs/apk/debug/app-debug.apk",
            f"adb install {self.external / 'app.apk'}",
            "adb uninstall com.example.app",
            "adb shell pm clear com.example.app",
            "adb shell",
            "adb push tracked.txt /sdcard/Download/tracked.txt",
            "adb reverse tcp:8081 tcp:8081",
            "adb logcat -c",
            "adb shell dumpsys battery set level 5",
            "adb shell 'getprop; reboot'",
            "TMPDIR=. adb devices",
        ):
            with self.subTest(command=command):
                owned = self.claude_bash(self.claude, command)
                # Negative control, `adb` dropped from
                # `adb_mutation_paths`'s device tier (`return []` -> `None`):
                #   subTest command='adb uninstall com.example.app'
                #   AssertionError: 2 != 0 : BLOCKED: mutation targets could
                #   not be resolved
                self.assertEqual(owned.returncode, 0, owned.stderr)
                for cwd in (self.main, self.manual):
                    refused = self.claude_bash(cwd, command)
                    self.assertEqual(refused.returncode, 2, refused.stderr)
                    self.assertIn("Claude-managed worktree", refused.stderr)

    def test_adb_host_destinations_are_confined_to_the_worktree(self) -> None:
        """`pull`, `bugreport`, `backup -f` and `keygen` write on this host."""

        for command in (
            "adb pull /sdcard/Download/report.csv",
            "adb pull -a /sdcard/Download/report.csv .tmp/report.csv",
            "adb bugreport .tmp/bugreport.zip",
            "adb backup -f .tmp/app.ab com.example.app",
            "TMPDIR=.tmp adb devices",
        ):
            with self.subTest(allowed=command):
                result = self.claude_bash(self.claude, command)
                self.assertEqual(result.returncode, 0, result.stderr)
        for command in (
            f"adb pull /sdcard/Download/report.csv {self.external}",
            f"adb pull /sdcard/a /sdcard/b {self.main / 'report.csv'}",
            f"adb bugreport {self.external / 'bugreport.zip'}",
            f"adb backup -f {self.external / 'app.ab'} com.example.app",
            f"adb keygen {self.external / 'adbkey'}",
            # The server's log and keys follow these variables, so moving them
            # out of the worktree is a write out of it, read-only verb or not.
            f"TMPDIR={self.external} adb devices",
            f"ANDROID_USER_HOME={self.main} adb shell getprop",
            f"TMPDIR={self.external}; adb devices -l",
        ):
            with self.subTest(denied=command):
                result = self.claude_bash(self.claude, command)
                # Negative control, the `pull` branch of
                # `adb_mutation_paths` returning []:
                #   subTest denied='adb pull /sdcard/Download/report.csv <external>'
                #   AssertionError: 0 != 2
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("outside this session's Claude worktree", result.stderr)
        for command in (
            # Unreviewed: the emulator console writes host files, ppp runs a
            # host daemon, -L may name a host socket path.
            "adb emu screenrecord start /tmp/x.webm",
            "adb ppp dev:/dev/ttyUSB0",
            "adb -L localfilesystem:/tmp/adb.sock devices",
            "adb backup -f.tmp/app.ab com.example.app",
            "./adb devices",
            "adb",
        ):
            with self.subTest(unreviewed=command):
                result = self.claude_bash(self.claude, command)
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_managed_task_detects_combined_install_directory_flags(self) -> None:
        for option in ("-vd", "-dm755"):
            with self.subTest(option=option):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={
                        "command": f"install {option} {self.external / 'escaped'}"
                    },
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("outside this session's Claude worktree", result.stderr)

    def test_managed_task_rejects_path_qualified_generic_runners(self) -> None:
        for command in (
            "./npm run clean",
            "nested/npm run clean",
            "/usr/bin/npm run clean",
        ):
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("could not be resolved", result.stderr)

    def test_managed_task_rejects_all_path_qualified_trusted_commands(self) -> None:
        for command in (
            "./cat tracked.txt",
            "nested/echo hello",
            "/usr/bin/printf hello",
            "./ls",
            "nested/rg needle tracked.txt",
            "/tmp/git status",
            "./find .",
            "./sed -n 1p tracked.txt",
            "./cd ..",
            "./sh -c 'touch changed.txt'",
        ):
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("could not be resolved", result.stderr)

    def test_managed_task_allows_bun_run_but_rejects_direct_bun_code(self) -> None:
        (self.claude / "package.json").write_text(
            json.dumps(
                {
                    "scripts": {
                        "test": "echo test",
                        "./scripts/task.ts": "echo path-like",
                        "-": "echo stdin-like",
                    }
                }
            ),
            encoding="utf-8",
        )
        allowed = self.invoke(
            self.claude,
            tool_name="Bash",
            tool_input={"command": "bun run test"},
        )
        self.assertEqual(allowed.returncode, 0, allowed.stderr)

        for command in (
            "FOO=value bun run test",
            "env FOO=value bun run test",
            "command bun run test",
        ):
            with self.subTest(command=command):
                allowed_wrapped = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(allowed_wrapped.returncode, 0, allowed_wrapped.stderr)

        for command in (
            "bun scripts/task.ts",
            "bun run missing",
            "bun run ./scripts/task.ts",
            "bun run -",
            "bun -e 'Bun.write(\"x\", \"y\")'",
        ):
            with self.subTest(command=command):
                rejected = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(rejected.returncode, 2, rejected.stderr)
                self.assertIn("could not be resolved", rejected.stderr)

    def test_managed_task_rejects_bun_run_with_modified_command_lookup(self) -> None:
        (self.claude / "package.json").write_text(
            json.dumps({"scripts": {"test": "echo test"}}),
            encoding="utf-8",
        )
        for command in (
            "PATH=. bun run test",
            "env PATH=. bun run test",
            "env -i bun run test",
            "env -u PATH bun run test",
            "env --unset=PATH bun run test",
            "command -p bun run test",
            "exec -c bun run test",
            "PATH=. sh -c 'bun run test'",
            "env PATH=. bash -c 'bun run test'",
            "command -p zsh -c 'bun run test'",
            "exec -c sh -c 'bun run test'",
            "PATH=.; bun run test",
            "PATH=.; sh -c 'bun run test'",
            "PATH=.; touch changed.txt",
            "PATH=. touch changed.txt",
        ):
            with self.subTest(command=command):
                rejected = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                # Negative controls without lookup_modified in Bun
                # classification or before nested-shell recursion:
                # AssertionError: 0 != 2. This exit-code assertion defends the
                # review findings it was written for.
                self.assertEqual(rejected.returncode, 2, rejected.stderr)
                self.assertIn("could not be resolved", rejected.stderr)

    def test_managed_task_rejects_abbreviated_install_long_options(self) -> None:
        for option in ("--dir", "--direc", "--target-d", "--unknown"):
            with self.subTest(option=option):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={
                        "command": f"install {option} {self.external / 'escaped'}"
                    },
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("could not be resolved", result.stderr)

    def test_install_context_does_not_consume_path_operands(self) -> None:
        for option in ("--context", "--context=system_u:object_r:bin_t:s0"):
            with self.subTest(option=option):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={
                        "command": (
                            f"install {option} {self.claude / 'tracked.txt'} "
                            f"{self.external / 'escaped'}"
                        )
                    },
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("outside this session's Claude worktree", result.stderr)

    def test_managed_task_allows_read_only_output_and_external_cat_input(self) -> None:
        for command in (
            "echo hello",
            "printf '%s\\n' hello",
            f"cat {self.external / 'source'}",
        ):
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_unsafe_checkout_allows_read_only_output_and_external_cat_input(self) -> None:
        for command in (
            "echo hello",
            "printf '%s\\n' hello",
            f"cat {self.external / 'source'}",
        ):
            with self.subTest(command=command):
                result = self.invoke(
                    self.main,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_managed_task_still_blocks_read_only_command_redirection_outside(self) -> None:
        for command in (
            f"echo hello > {self.external / 'echo-output.txt'}",
            f"printf hello > {self.external / 'printf-output.txt'}",
            f"cat tracked.txt > {self.external / 'cat-output.txt'}",
        ):
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                # The parser never resolves a redirection target; it refuses
                # the whole command as unprovable.
                self.assertIn("could not be resolved", result.stderr)

    def test_install_option_values_and_non_directory_flags_remain_allowed(self) -> None:
        for command in (
            f"install -gdevelopers {self.external / 'source'} installed.txt",
            f"install -m755 {self.external / 'source'} installed.txt",
            f"install -D {self.external / 'source'} nested/installed.txt",
            "install -d nested/one nested/two",
            "install --directory nested/one nested/two",
            "install -t nested tracked.txt",
            "install tracked.txt installed.txt",
            "install -vd nested/one nested/two",
        ):
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_managed_task_allows_generic_in_worktree_destinations(self) -> None:
        commands = (
            "rsync tracked.txt rsync-output.txt",
            "pnpm turbo run test --filter='...[origin/main]'",
        )
        for command in commands:
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_execution_wrappers_fail_closed_when_options_are_ambiguous(self) -> None:
        for command in (
            "time --format=%e pnpm test",
            "nice --unknown-option pnpm test",
        ):
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("could not be resolved", result.stderr)

    def test_managed_task_rejects_path_qualified_shell_normalizers(self) -> None:
        for token in (
            "builtin",
            "command",
            "env",
            "exec",
            "nice",
            "noglob",
            "time",
            "!",
            "if",
            "then",
            "elif",
            "else",
            "fi",
            "while",
            "until",
            "do",
            "done",
        ):
            command = f"./{token} git status"
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                # Negative control with the production raw-token check removed:
                # self.assertEqual(result.returncode, 2, result.stderr)
                # AssertionError: 0 != 2 :
                # This is the exit-code assertion that defends SIG-001.
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("could not be resolved", result.stderr)

    def test_managed_task_preserves_bare_shell_normalizers(self) -> None:
        for command in (
            "builtin -- git status",
            "command -- git status",
            "env KEY=value git status",
            "exec -- git status",
            "nice -n 5 git status",
            "noglob -- git status",
            "time -p git status",
            "! git status",
        ):
            with self.subTest(command=command):
                result = self.invoke(
                    self.claude,
                    tool_name="Bash",
                    tool_input={"command": command},
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_sed_long_in_place_options_are_mutating(self) -> None:
        for option in ("--in-place", "--in-place=.bak"):
            with self.subTest(option=option):
                result = self.invoke(
                    self.main,
                    tool_name="Bash",
                    tool_input={"command": f"sed {option} s/base/changed/ tracked.txt"},
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("Claude-managed worktree", result.stderr)

        short = self.invoke(
            self.main,
            tool_name="Bash",
            tool_input={"command": "sed -i.bak s/base/changed/ tracked.txt"},
        )
        plain = self.invoke(
            self.main,
            tool_name="Bash",
            tool_input={"command": "sed s/base/changed/ tracked.txt"},
        )
        self.assertEqual(short.returncode, 2, short.stderr)
        self.assertEqual(plain.returncode, 0, plain.stderr)

    def test_sed_programs_that_write_or_execute_are_mutating(self) -> None:
        """A sed program writes files (`w`, `W`, the `s///w` flag) or runs
        commands (`e`, the `s///e` flag) without any in-place option."""
        for command in (
            "sed 'w /tmp/pwned.txt' tracked.txt",
            "sed -n 'W out.txt' tracked.txt",
            "sed '1e touch x' tracked.txt",
            "sed 's/a/b/w out.txt' tracked.txt",
            "sed 's/a/b/gw out.txt' tracked.txt",
            "sed 's/.*/date/e' tracked.txt",
            "sed -e p -e 'w out.txt' tracked.txt",
            "sed --expression='w out.txt' tracked.txt",
            "sed --expr 'w out.txt' tracked.txt",
            "sed -ne 'w out.txt' tracked.txt",
            "sed -new_out.txt tracked.txt",
            "sed '/x/{p;w out.txt\n}' tracked.txt",
            "sed 'b;w out.txt' tracked.txt",
            "sed '/[/]/w out.txt' tracked.txt",
            "sed 's/[/]/x/w out.txt' tracked.txt",
            "sed -f script.sed tracked.txt",
            "sed --file=script.sed tracked.txt",
            "sed -I '' s/a/b/ tracked.txt",
            "sed --in s/a/b/ tracked.txt",
            "sed -a p tracked.txt",
            "sed 'k' tracked.txt",
            "sed 's/a/b' tracked.txt",
            "sed",
        ):
            with self.subTest(command=command):
                self.assertFalse(MODULE.shell_is_read_only(command))
        for command in (
            "sed -n 1,5p tracked.txt",
            "sed s/base/changed/ tracked.txt",
            "sed -E 's/(a|b)+/c/g' tracked.txt",
            "sed -n '/^$/!{p;q}' tracked.txt",
            "sed '1!G;h;$!d' tracked.txt",
            "sed 's|/usr|/opt|2' tracked.txt",
            "sed 'y/abc/xyz/' tracked.txt",
            "sed -n '$=' tracked.txt",
            "sed '0,/re/d' tracked.txt",
            "sed -n 'l 80' tracked.txt",
            "sed 's/[[:space:]]*$//' tracked.txt",
            "sed '/x/a appended' tracked.txt",
            "sed -e 's/a/b/I' -e 's/c/d/M' tracked.txt",
            "sed -n --quiet -- p tracked.txt",
            "sed 's/w/e/' tracked.txt",
            "sed 'r other.txt' tracked.txt",
        ):
            with self.subTest(command=command):
                self.assertTrue(MODULE.shell_is_read_only(command))

class ShellPolicyTest(unittest.TestCase):
    def test_scanner_preserves_literal_words_and_real_operators(self) -> None:
        cases = (
            ('echo "a > b"', [["echo", "a > b"]]),
            ("echo ';' '|' '(' ')'", [["echo", ";", "|", "(", ")"]]),
            ("echo a'b'c ''", [["echo", "abc", ""]]),
            ('touch "line\nname"', [["touch", "line\nname"]]),
            ('touch "line\rname"', [["touch", "line\rname"]]),
            ("echo a\\\nb", [["echo", "ab"]]),
            (r'echo \; \> \$ \`', [["echo", ";", ">", "$", "`"]]),
            (r'echo "\$id" "a\qb"', [["echo", "$id", "a\\qb"]]),
            ("echo x#y # ignored $(program) > x\npwd", [["echo", "x#y"], ["pwd"]]),
            ("echo ''; pwd && ls || true | head", [["echo", ""], ["pwd"], ["ls"], ["true"], ["head"]]),
        )
        for command, expected in cases:
            with self.subTest(command=command):
                self.assertEqual(MODULE.split_commands(command), expected)

    def test_literal_metadata_survives_path_option_extraction(self) -> None:
        cwd = Path.cwd()
        for command, target in (
            # A GET is read-only; a POST is a runner's write.
            ("gh api -X POST 'repos/{owner}/{repo}/pulls/404'", "repos/{owner}/{repo}/pulls/404"),
            ("touch 'file$[?*{x}`'", "file$[?*{x}`"),
            ('touch "line\nname"', "line\nname"),
            ("touch '~/literal'", "~/literal"),
            ("git diff --output='./{report}.patch'", "{report}.patch"),
            ("cp source --target-directory='./{directory}'", "{directory}"),
            ("cp source -t'./{directory}'", "{directory}"),
            ("dd 'of=./{report}'", "{report}"),
        ):
            with self.subTest(command=command):
                self.assertEqual(MODULE.mutation_directories(command, cwd), [cwd, cwd / target])
        for command in (
            'git diff --output="./$REPORT"',
            'cp source --target-directory="./$DIRECTORY"',
            'cp source -t"./$DIRECTORY"',
            'dd "of=./$REPORT"',
            "tar -cf archive.tar dist/*",
            "tar -cf archive.tar *",
            "gh api graphql -f query='literal'$id",
            'gh api graphql -f query="mutation($id)"',
        ):
            with self.subTest(command=command):
                self.assertIsNone(MODULE.mutation_directories(command, cwd))

    def test_scanner_rejects_active_execution_and_unsupported_syntax(self) -> None:
        for command in (
            'echo "$(touch outside)"',
            "echo $\\\n(touch outside)",
            'echo "$\\\n(touch outside)"',
            "echo `touch outside`",
            "echo hi > /etc/x",
            "cat <(program)",
            "echo 'unterminated",
            'echo "unterminated',
            "echo trailing\\",
            "echo $'escaped'",
            'echo $"translated"',
            "echo x\0y",
            "echo x ;; pwd",
        ):
            with self.subTest(command=command):
                self.assertIsNone(MODULE.tokenize_command(command))
                self.assertFalse(MODULE.shell_is_read_only(command))
        for command in ("echo '$(literal)'", "echo '`literal`'", 'echo "a > b"', "grep -n pattern file"):
            with self.subTest(command=command):
                self.assertTrue(MODULE.shell_is_read_only(command))

    def test_nested_shell_reparses_program_without_outer_quote_protection(self) -> None:
        cwd = Path.cwd()
        self.assertEqual(MODULE.mutation_directories("bash -c 'ls'", cwd), [])
        for command in (
            "sh -c 'echo $(touch outside)'",
            "sh -c 'echo `touch outside`'",
            "sh -c 'touch $TARGET'",
            'sh -c "echo $PROGRAM"',
            'sh -c "$PROGRAM"',
            "'if' touch x",
            "i''f touch x",
            "'NAME=value'",
            "NAME''=value",
            r"NAME\=value",
            "command NAME=value",
            "exec NAME=value",
            "command if",
            '"!" true',
            "!'' true",
            "command ! true",
            "exec ! true",
            "env ! true",
            '"noglob" true',
            "noglob'' true",
            r"no\glob true",
            "command noglob true",
            "exec noglob true",
            "env noglob true",
        ):
            with self.subTest(command=command):
                self.assertIsNone(MODULE.mutation_directories(command, cwd))

    def test_mutation_analysis_rejects_path_qualified_normalizers(self) -> None:
        for token in (
            *sorted(MODULE.SHELL_COMMAND_WRAPPERS),
            *sorted(MODULE.SHELL_CONTROL_WORDS),
            "!",
        ):
            command = f"./{token} git status"
            with self.subTest(command=command):
                self.assertIsNone(MODULE.mutation_directories(command, Path.cwd()))

    def test_allows_read_commands_only(self) -> None:
        self.assertTrue(MODULE.shell_is_read_only("rg -n worktree AGENTS.md | head -20"))
        self.assertTrue(MODULE.shell_is_read_only("git worktree list --porcelain"))
        self.assertFalse(
            MODULE.shell_is_read_only(
                "git worktree add -b codex/x /tmp/codex-x origin/main"
            )
        )

    def test_operand_free_read_commands_are_allowed(self) -> None:
        """Commands with no way to name an output file.

        These were refused before, not because the boundary caught anything,
        but because an unparsed command name falls through to operand analysis
        and fails closed there -- reported as the misleading "mutation targets
        could not be resolved". `date +%F` was the everyday casualty.
        """
        for command in (
            "date +%F",
            "date -u +%Y-%m-%dT%H:%M:%SZ",
            "uname -a",
            "uptime",
            "whoami",
            "id -u",
            "printenv PATH",
            "seq 1 5",
            "sleep 1",
            "diff tracked.txt other.txt",
            "cmp tracked.txt other.txt",
            "nl tracked.txt",
            "rev tracked.txt",
            "cat tracked.txt | tr a-z A-Z",
            "date +%F | wc -c",
        ):
            with self.subTest(command=command):
                self.assertTrue(MODULE.shell_is_read_only(command))

    def test_realpath_reads_like_readlink(self) -> None:
        """`realpath` resolves a path and prints it; no option names an output.

        It was refused as "mutation targets could not be resolved" for the
        same reason `date +%F` once was.
        """
        for command in (
            "realpath .",
            "realpath -e tracked.txt",
            "realpath -m missing/path",
            "realpath -s --relative-to=. tracked.txt",
            "realpath --relative-base=/ -z tracked.txt other.txt",
            "readlink -f . | realpath -q tracked.txt",
        ):
            with self.subTest(command=command):
                self.assertTrue(MODULE.shell_is_read_only(command))
        for command in (
            "realpath . ; touch changed.txt",
            "realpath . > report.txt",
            "realpath . | tee report.txt",
        ):
            with self.subTest(command=command):
                self.assertFalse(MODULE.shell_is_read_only(command))

    def test_status_checks_a_question_session_runs_before_any_worktree(self) -> None:
        """A cloud session that only answers a question has no worktree.

        `git status --short --branch` and a bare `env` were refused in the
        clone root as "Claude mutations require this session's Claude-managed
        worktree": `--branch` was missing from the reviewed
        status flags, and a bare `env` (a wrapper with no program) had no
        reading at all. `env` running a program stays refused.
        """
        for command in (
            "git status --short --branch",
            "git status --branch",
            "git status -sb",
            "git status --porcelain --branch --ahead-behind",
            "git status --untracked-files=no",
            "git status --show-stash",
            "env",
        ):
            with self.subTest(command=command):
                self.assertTrue(MODULE.shell_is_read_only(command))
        for command in (
            "env touch changed.txt",
            "env FOO=bar bash scripts/setup.sh",
            "env -u PATH touch changed.txt",
            "env > report.txt",
            "git status --branch > report.txt",
        ):
            with self.subTest(command=command):
                self.assertFalse(MODULE.shell_is_read_only(command))

    def test_date_reading_a_clock_is_allowed_but_setting_one_is_not(self) -> None:
        """`date` is parsed, not allowlisted, because two spellings set state.

        The bare-operand form carries no option, so an unrecognised word has to
        be treated AS a setter -- which is why admission is an allowlist and
        the divergent short options are excluded rather than guessed at.
        """
        for command in (
            "date",
            "date +%F",
            "date -u +%Y-%m-%dT%H:%M:%SZ",
            "date --utc +%s",
            "date -R",
            "date -Iseconds",
            "date --iso-8601=seconds",
            "date --date=yesterday +%F",
        ):
            with self.subTest(command=command):
                self.assertTrue(MODULE.shell_is_read_only(command))
        for command in (
            "date -s '2026-01-01 00:00:00'",
            "date --set=2026-01-01",
            "date 202601010000",
            "date -f fmt 2026-01-01",
            "date -d dst",
            "date -j 202601010000",
            "date -v +1d",
        ):
            with self.subTest(command=command):
                self.assertFalse(MODULE.shell_is_read_only(command))

    def test_near_neighbours_that_name_an_output_stay_excluded(self) -> None:
        """The admission test is "cannot name a file it writes", not a feeling.

        Each of these looks as harmless as the set above and is deliberately
        absent: two take an output path, and one sets system state.
        """
        for command in (
            "sort -o report.txt tracked.txt",
            "sort --output=report.txt tracked.txt",
            "uniq tracked.txt report.txt",
            "hostname newname",
            "tee report.txt",
        ):
            with self.subTest(command=command):
                self.assertFalse(MODULE.shell_is_read_only(command))

    def test_read_only_prefix_never_licenses_a_later_write(self) -> None:
        """A newly allowed command cannot launder the segment beside it."""
        for command in (
            "date +%F ; touch changed.txt",
            "date +%F && rm tracked.txt",
            "uname -a | tee report.txt",
        ):
            with self.subTest(command=command):
                self.assertFalse(MODULE.shell_is_read_only(command))

    def test_git_read_allowlist_is_option_aware(self) -> None:
        for command in (
            "git branch",
            "git branch --list codex/*",
            "git branch --show-current",
            "git remote -v",
            "git remote get-url --all origin",
            "git tag",
            "git tag --list v1.*",
        ):
            with self.subTest(command=command):
                self.assertTrue(MODULE.shell_is_read_only(command))
        for command in (
            "git fetch origin main",
            "git -c core.pager='touch changed.txt' log -1",
            "git branch new-branch",
            "git branch -D old-branch",
            "git remote add upstream https://example.invalid/repo.git",
            "git remote remove origin",
            "git tag v1.0.0",
            "git tag -d v1.0.0",
        ):
            with self.subTest(command=command):
                self.assertFalse(MODULE.shell_is_read_only(command))

    def test_rejects_hidden_execution_in_read_commands(self) -> None:
        for command in (
            "rg \"$(touch changed.txt)\"",
            "rg `touch changed.txt`",
            "find . -exec touch changed.txt ;",
            "find . -execdir touch changed.txt ;",
            "find . -delete",
            "find . -fprint report.txt",
            "rg --pre 'touch changed.txt' needle",
            "rg --pre=./filter needle",
            "rg --hostname-bin 'touch changed.txt' needle",
            "rg --hostname-bin=./filter needle",
        ):
            with self.subTest(command=command):
                self.assertFalse(MODULE.shell_is_read_only(command))

    def test_blocks_writes_unknown_interpreters_and_redirection(self) -> None:
        self.assertFalse(MODULE.shell_is_read_only("touch changed.txt"))
        self.assertFalse(MODULE.shell_is_read_only("bash scripts/setup.sh"))
        self.assertFalse(MODULE.shell_is_read_only("python3 -c 'open(\"x\", \"w\")'"))
        self.assertFalse(MODULE.shell_is_read_only("sed -i '' s/a/b/ file"))
        self.assertFalse(MODULE.shell_is_read_only("sed --in-place s/a/b/ file"))
        self.assertFalse(
            MODULE.shell_is_read_only("sed --in-place=.bak s/a/b/ file")
        )
        # After `--`, `--in-place` is a file operand; the program is `p`.
        self.assertTrue(MODULE.shell_is_read_only("sed -- p --in-place"))
        self.assertFalse(MODULE.shell_is_read_only("git commit -m nope"))
        self.assertFalse(MODULE.shell_is_read_only("rg needle > report.txt"))

    def test_path_qualified_commands_are_not_trusted_as_read_only(self) -> None:
        for command in (
            "./cat tracked.txt",
            "nested/echo hello",
            "/bin/printf x",
            "./ls",
            "nested/rg needle tracked.txt",
            "/tmp/git status",
            "./find .",
            "./sed -n 1p tracked.txt",
            "./cd ..",
            "./sh -c 'pwd'",
        ):
            with self.subTest(command=command):
                self.assertFalse(MODULE.shell_is_read_only(command))

    def test_adb_read_only_tier_refuses_every_device_or_host_write(self) -> None:
        """What `adb_is_read_only` must NOT admit, each for its own reason."""

        for command in (
            # logcat clusters are read letter by letter: -c clears, -G/-P set.
            "adb logcat -dc",
            "adb logcat -c",
            "adb logcat --clear",
            "adb logcat -G 16M",
            "adb logcat -P '~1000'",
            "adb logcat -f /sdcard/log.txt",
            "adb logcat --file=/sdcard/log.txt",
            # The device shell re-parses the joined line, unescaped.
            "adb shell 'getprop; reboot'",
            "adb shell 'getprop\nreboot'",
            "adb shell getprop '&&' reboot",
            "adb shell 'pm list packages > /sdcard/p.txt'",
            "adb shell 'getprop $(reboot)'",
            # A service reads trailing words as commands of its own.
            "adb shell dumpsys battery set level 5",
            "adb shell dumpsys battery unplug",
            "adb shell dumpsys deviceidle force-idle",
            "adb shell dumpsys gfxinfo com.example.app reset",
            "adb shell dumpsys batterystats --reset",
            "adb shell pm clear com.example.app",
            "adb shell pm list",
            "adb shell setprop debug.x 1",
            "adb shell",
            # Host or server state, and options nobody reviewed.
            "adb pull /sdcard/x",
            "adb -a devices",
            "adb devices --everything",
            "adb version extra",
            "adb kill-server",
            "adb -s",
            "adb",
            # An attached value is not parsed: `-shell` is not `-s hell`.
            "adb -shell devices",
            "adb -semulator-5554 devices",
        ):
            with self.subTest(command=command):
                # Negative control, `LOGCAT_FLAGS` given "c":
                #   subTest command='adb logcat -dc'
                #   AssertionError: True is not false
                self.assertFalse(MODULE.shell_is_read_only(command))

    def test_adb_resolves_host_writes_and_never_device_paths(self) -> None:
        cwd = Path.cwd()
        for command, expected in (
            ("adb push app.apk /data/local/tmp/app.apk", [cwd]),
            ("adb install -r /elsewhere/app.apk", [cwd]),
            ("adb pull /sdcard/a", [cwd]),
            ("adb pull -z brotli /sdcard/a /sdcard/b out", [cwd, cwd / "out"]),
            ("adb -s emulator-5554 bugreport /tmp/br.zip", [cwd, Path("/tmp/br.zip").resolve()]),
            ("adb keygen keys/adbkey", [cwd, cwd / "keys/adbkey", cwd / "keys/adbkey.pub"]),
            ("adb devices -l", []),
            # An assignment that moves adb's server state is a destination.
            ("env TMPDIR=. adb devices", [cwd, cwd]),
            ("TMPDIR=other ANDROID_SERIAL=emulator-5554 adb devices", [cwd / "other", cwd]),
            ("ANDROID_SERIAL=emulator-5554 adb devices", [cwd]),
            ("TMPDIR=/tmp/x; adb devices", [Path("/tmp/x").resolve()]),
            ("ANDROID_USER_HOME=keys adb install app.apk", [cwd / "keys", cwd]),
        ):
            with self.subTest(command=command):
                self.assertEqual(MODULE.mutation_directories(command, cwd), expected)
        for command in (
            "adb emu kill",
            "adb ppp dev:/dev/ttyUSB0",
            "adb bugreport -x out.zip",
            "adb backup -f",
            "adb pull /sdcard/a \"$OUT\"",
            # An unreviewed pull option could take a value and hide the real
            # destination among the positionals, so it is never skipped.
            "adb pull --sync /elsewhere/out /sdcard/a .",
            "adb pull -q /sdcard/a out",
            "adb pull -z",
            "adb -semulator-5554 uninstall com.example.app",
            'TMPDIR="$OUT" adb devices',
            "HOME= adb devices",
        ):
            with self.subTest(unresolved=command):
                self.assertIsNone(MODULE.mutation_directories(command, cwd))


class ReadOnlyFormsTest(unittest.TestCase):
    """Read-only commands pass from any checkout.

    Every command in READ was once refused or is newly read here, and must
    be `shell_is_read_only`; every one in WRITES names a file it writes, runs a
    command, or hides an option in an expansion, and must not be.
    """

    READ = (
        # sort and uniq
        "git log --format=%an | sort | uniq -c | sort -rn | head",
        "sort -u -k2,2 -t: tracked.txt",
        "sort --numeric --reverse tracked.txt",
        "sort -- -o",
        "uniq -c tracked.txt",
        "uniq -f1 -",
        # awk
        "awk '{print $1}' tracked.txt",
        "awk -F, 'NR>1 {s+=$2} END {print s}' tracked.txt",
        "awk -F: -v n=2 '$1 > n && length($0) > 3 {print NR / 2}' tracked.txt",
        "awk '/a\\/b/ {print}' tracked.txt",
        "awk '{ if ($1 ~ /x[/]y/) print; else print \"a > b\" }' tracked.txt",
        "awk 'BEGIN { getline line < \"tracked.txt\"; print line }'",
        "awk '{print (x || y)}' tracked.txt",
        "gawk '{n++} END {print n}' tracked.txt",
        # input redirection, loops and tests
        "while read -r line; do echo \"$line\"; done < tracked.txt",
        "[ -d scripts ] && ls scripts | head -3",
        "[[ -f tracked.txt ]] && echo yes",
        "if [ -f tracked.txt ]; then cat tracked.txt; fi",
        "for f in a b; do git log -1 --format=%h -- \"$f\"; done",
        "for n in 1 2; do sed -n \"${n}p\" tracked.txt; done",
        "for n in 3191 3193; do gh api repos/o/r/issues/$n --jq .title; done",
        # substitutions
        "echo \"$(git rev-parse HEAD)\"",
        "git show --stat $(git rev-parse origin/main)",
        "git log $(git merge-base HEAD origin/main)..HEAD --oneline",
        "diff <(git show HEAD:tracked.txt) tracked.txt",
        "wc -l $(git ls-files)",
        "echo \"$(echo \")\")\"",
        "echo $(echo $(pwd))",
        # xargs and tee
        "git ls-files | xargs wc -l | tail -1",
        "xargs -n1 echo < tracked.txt",
        "find . -name '*.py' -print0 | xargs -0 grep -l x",
        "xargs -I {} echo {} < tracked.txt",
        "ls | tee /dev/null",
        # gh and the rest
        "gh issue view 3200 --json title --jq .title",
        "gh pr list --search 'is:open' --json number",
        "gh api repos/o/r/pulls --paginate --jq '.[].number'",
        "gh api -X GET repos/o/r",
        "gh api graphql -f query='{ viewer { login } }'",
        "gh run view 1 --log",
        "printf '%s\\n' \"$x\"",
        "file tracked.txt",
        "git branch --list codex/*",
    )

    WRITES = (
        "sort -o out tracked.txt",
        "sort --output=out tracked.txt",
        "sort --out=out tracked.txt",
        "sort --o=out tracked.txt",
        "sort -uo out tracked.txt",
        "sort -T /tmp tracked.txt",
        "sort --compress-program=gzip tracked.txt",
        "sort --files0-from=list.txt",
        "sort -k1oout tracked.txt",
        # Not a write in getopt (separator "o"), but refused: an attached value
        # spelling a writing option is not read on one getopt's word.
        "sort -to tracked.txt",
        "uniq tracked.txt out",
        "uniq -c - out",
        "awk '{print > \"out\"}' tracked.txt",
        "awk '{print $1 >> \"out\"}' tracked.txt",
        "awk '{printf(\"%s\", $1) > \"out\"}' tracked.txt",
        "awk '{print (1 > 0)}' tracked.txt",
        "awk 'BEGIN { system(\"touch out\") }'",
        "awk '{print | \"cat\"}' tracked.txt",
        "awk '{\"date\" | getline d}' tracked.txt",
        "awk '{ if ($0 ~ /}/) print > \"out\" }' tracked.txt",
        "awk '{ x = /;/; print > \"out\" }' tracked.txt",
        "awk '{ print \"a\" \\\n > \"out\" }' tracked.txt",
        "awk '@include \"x\"'",
        "awk -f prog.awk tracked.txt",
        "awk -- '{print}' tracked.txt",
        "gawk -i inplace '{print}' tracked.txt",
        "awk --source='{print}' tracked.txt",
        "awk \"$prog\" tracked.txt",
        "awk -F $sep '{print}' tracked.txt",
        "awk '{print \"unterminated}' tracked.txt",
        "awk '{print /unterminated}' tracked.txt",
        "echo out | xargs touch",
        "xargs rm < tracked.txt",
        "xargs sh -c 'touch x'",
        "xargs sed -i s/a/b/",
        "xargs printf -v PATH %s",
        "xargs $cmd",
        "xargs --process-slot-var=PATH echo",
        "xargs -I",
        "ls | tee out",
        "tee /dev/null out",
        "echo $(touch out)",
        "echo \"$(touch out)\"",
        "diff <(touch out) tracked.txt",
        "cat <(touch out)",
        "echo $(echo ')'; touch out)",
        "echo $(echo # ); touch out )",
        "echo $(case x in x) touch out;; esac)",
        "echo $(cat <<EOF\nx\nEOF\n)",
        "echo $((x = 1))",
        "echo $(echo `touch out`)",
        "cat <> out",
        "cat < tracked.txt > out",
        "cat <",
        "cat < ;",
        "cat <&x",
        "[ -f x ] && touch out",
        "while read -r l; do touch out; done < tracked.txt",
        "\"do\" ls",
        "X=--output=out; git log -1 $X",
        "git log -1 \"$X\"",
        "git log -1 $(echo --output=out)",
        "git log $(git rev-parse --output=out HEAD)",
        "git log $(git rev-parse $X)",
        "x=w; sed -n \"$x out\" tracked.txt",
        "f=-i; sed -n p \"$f\" tracked.txt",
        "find . $X",
        "find \"$dir\" -name x",
        "date $X",
        "for n in 1w; do sed -n \"$n out\" tracked.txt; done",
        "for n in 1; do n=w; sed \"$n out\" tracked.txt; done",
        "for n in 'a b'; do git log $n; done",
        "printf -v PATH %s ./bin",
        "printf -xv PATH %s ./bin",
        "printf \"$fmt\" x",
        "$cmd tracked.txt",
        "gh api -X POST repos/o/r/issues",
        "gh api repos/o/r -H",
        "gh api -H repos/o/r",
        "gh api repos/o/r/issues -f title=x",
        "gh api --cache 1h repos/o/r",
        "gh api repos/o/r --input body.json",
        "gh api graphql -f query='mutation { x }'",
        "gh api graphql -f query=\"$q\"",
        "gh api",
        "gh pr create --title x",
        "gh pr view 1 --web",
        "gh run download 1",
        "gh my-extension",
        "file -C -m magic",
        "file --compile -m magic",
        "git branch --list $X",
    )

    def test_read_only_forms_are_read_only(self) -> None:
        for command in self.READ:
            with self.subTest(command=command):
                self.assertTrue(MODULE.shell_is_read_only(command))

    def test_writing_forms_are_not(self) -> None:
        for command in self.WRITES:
            with self.subTest(command=command):
                self.assertFalse(MODULE.shell_is_read_only(command))

    def test_expansions_that_may_be_options_leave_operands_unknown(self) -> None:
        """Once, `X=--output=<elsewhere>; git log -1 $X` passed: the
        parser read `$X` as a revision. Now an option-blind mutator with such
        an expansion has no provable targets."""

        cwd = Path.cwd()
        for command in (
            "X=--output=/elsewhere/out; git log -1 $X",
            "git log -1 \"$X\"",
            "X=-delete; find /elsewhere $X",
            "x=w; sed \"$x /elsewhere/out\" tracked.txt",
            "X='-C /elsewhere'; git $X commit --allow-empty -m x",
            "printf -v PATH %s ./bin; ls",
            # GNU cp, mv, ln and install read -t<dir> as the destination.
            'x=-t/elsewhere; cp "$x" a b',
            'mv "$x" a b',
            'ln "$x" a b',
            'install "$x" a b',
        ):
            with self.subTest(command=command):
                self.assertIsNone(MODULE.mutation_directories(command, cwd))
        # The checked mutators still take an expansion they confine.
        for command in ('chmod "$MODE" tracked.txt', "rm -f tracked.txt 2>/dev/null"):
            with self.subTest(command=command):
                self.assertEqual(MODULE.mutation_directories(command, cwd), [cwd, cwd / "tracked.txt"])

    def test_tee_to_dev_null_writes_no_file(self) -> None:
        cwd = Path.cwd()
        self.assertEqual(MODULE.mutation_directories("echo x | tee /dev/null out", cwd), [cwd, cwd / "out"])
        self.assertEqual(MODULE.mutation_directories("ls | tee /dev/null; touch x", cwd), [cwd, cwd / "x"])

    def test_loop_values_are_read_once_each(self) -> None:
        bindings: dict[str, tuple[str, ...]] = {}
        header = MODULE.split_commands("for n in 1 2")[0]
        MODULE.update_bindings(header, bindings)
        self.assertEqual(bindings, {"n": ("1", "2")})
        words = MODULE.split_commands('sed -n "${n}p" f')[0]
        self.assertEqual(
            [list(map(str, variant)) for variant in MODULE.bound_variants(words, bindings)],
            [["sed", "-n", "1p", "f"], ["sed", "-n", "2p", "f"]],
        )
        many = MODULE.split_commands("for a in " + " ".join(map(str, range(9))))[0]
        MODULE.update_bindings(many, bindings)
        MODULE.update_bindings(MODULE.split_commands("for b in " + " ".join(map(str, range(9))))[0], bindings)
        self.assertIsNone(MODULE.bound_variants(MODULE.split_commands("echo $a$b")[0], bindings))
        MODULE.update_bindings(MODULE.split_commands("read -r n")[0], bindings)
        self.assertNotIn("n", bindings)
        MODULE.update_bindings(MODULE.split_commands("for a in $(ls)")[0], bindings)
        self.assertNotIn("a", bindings)


if __name__ == "__main__":
    unittest.main()
