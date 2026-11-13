#!/usr/bin/env python3
"""Tests of the Claude adapter (``worktree_guard.py``) itself: its settings,
the trusted commands they name, agent memory, the harness's state directories,
and its fail-closed ends. The shell/path boundary it loads is tested in
``test_boundary.py``, whose fixtures these reuse."""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path
from unittest import mock

from .test_boundary import (
    ADAPTER,
    ADAPTER_PATH,
    MODULE,
    BoundaryFixture,
    GuardFixture,
    git,
    hermetic_git_env,
)


# A sample consumer setting: one reviewed worktree-management script and the
# exact command lines that run it. The script name is neutral on purpose; any
# consumer names its own.
WORKTREE_SCRIPT = "scripts/worktree.py"
WORKTREE_PATTERN = (
    r"python3 scripts/worktree\.py (?:"
    r"status|archive-check|retire --pr [1-9][0-9]*"
    r"|begin --branch (?:claude|codex)/[A-Za-z0-9][A-Za-z0-9._-]{0,99}"
    r")"
)
WORKTREE_SETTINGS = {
    "worktree": {
        "trustedCommands": [{"script": WORKTREE_SCRIPT, "pattern": WORKTREE_PATTERN}]
    }
}


# A sample consumer setting: commands the consumer reviewed as only reading,
# allowed in a hosted session alone. The names are neutral on purpose.
# Operands never start with `-`, and the only options are named: pnpm's own
# options after the subcommand (`-C`, `--dir`, `--pnpmfile`) would move or
# widen what it runs.
READ_ONLY_PATTERN = (
    r"pnpm (?:health:check|(?:ls|list|why)(?: [A-Za-z0-9@][A-Za-z0-9@/._-]*)*"
    r"(?: --depth [0-9]+)?(?: --json)?)"
)
READ_ONLY_SETTINGS = {
    "worktree": {
        "readOnlyCommands": [
            {
                "pattern": READ_ONLY_PATTERN,
                "env": {"AGENT_REMOTE": ["true"], "AGENT_ENTRY": ["remote", "remote_desktop"]},
                "reason": "the script and pnpm's listing commands only read",
            }
        ]
    }
}
HOSTED = {"AGENT_REMOTE": "true", "AGENT_ENTRY": "remote"}


class AdapterTest(BoundaryFixture):
    def settings_env(self, document: object, name: str = "kavach.json") -> dict[str, str]:
        """The hook's environment with KAVACH_CONFIG naming ``document``.

        The file is written outside every checkout, so writing it is no
        mutation any verdict here could be about. A str is written verbatim.
        """

        path = self.external / name
        text = document if isinstance(document, str) else json.dumps(document)
        path.write_text(text, encoding="utf-8")
        environment = hermetic_git_env()
        environment["KAVACH_CONFIG"] = str(path)
        return environment

    def test_adapter_reads_work_trees_from_files_first(self) -> None:
        cases = (
            (self.claude, True),
            (self.external, False),
            (self.main / ".git", None),
        )
        with mock.patch.object(
            ADAPTER.boundary, "run_git_all", side_effect=AssertionError("git started")
        ):
            for place, expected in cases:
                with self.subTest(place=str(place)):
                    self.assertEqual(ADAPTER.checkout_per_files(place), expected)
        self.assertTrue(ADAPTER.lands_in_a_checkout(self.claude))
        self.assertFalse(ADAPTER.lands_in_a_checkout(self.external))
        # Inside a git dir, git answers: no work tree there.
        self.assertFalse(ADAPTER.lands_in_a_checkout(self.main / ".git"))

    def test_claude_adapter_enforces_session_ownership(self) -> None:
        for cwd, target, expected, message in (
            (self.claude, self.claude / "new.txt", 0, ""),
            (self.claude, self.manual / "new.txt", 2, "outside this session's Claude worktree"),
            (self.claude, self.main / "new.txt", 2, "outside this session's Claude worktree"),
            (self.main, self.main / "new.txt", 2, "Claude-managed worktree"),
            (self.manual, self.manual / "new.txt", 2, "Claude-managed worktree"),
        ):
            with self.subTest(cwd=cwd, target=target):
                result = self.invoke(cwd, tool_input={"file_path": str(target)})
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertIn(message, result.stderr)

    def test_hook_rejects_malformed_and_non_object_payloads(self) -> None:
        for payload in ("{", "[]"):
            with self.subTest(payload=payload):
                result = subprocess.run(
                    [sys.executable, str(ADAPTER_PATH)],
                    input=payload,
                    capture_output=True,
                    text=True,
                    check=False,
                    env=hermetic_git_env(),
                    cwd=self.claude,
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("invalid hook payload", result.stderr)

        missing_input = subprocess.run(
            [sys.executable, str(ADAPTER_PATH)],
            input=json.dumps({"cwd": str(self.claude), "tool_name": "Bash"}),
            capture_output=True,
            text=True,
            check=False,
            env=hermetic_git_env(),
        )
        self.assertEqual(missing_input.returncode, 2, missing_input.stderr)
        self.assertIn("missing tool input", missing_input.stderr)

        missing_command = self.invoke(self.claude, tool_name="Bash", tool_input={})
        self.assertEqual(missing_command.returncode, 2, missing_command.stderr)
        self.assertIn("mutation targets could not be resolved", missing_command.stderr)

    def test_trusted_commands_are_the_only_python_scripts_an_owner_may_run(self) -> None:
        """A script the settings trust runs, by its exact command lines alone.

        The sample stands for a reviewed worktree-management script whose every
        write the guard already permits from the owning worktree as a plain
        ``git`` or ``gh`` command; the constituents below are those writes.
        """

        environment = self.settings_env(WORKTREE_SETTINGS)
        exact = (
            "python3 scripts/worktree.py status",
            "python3 scripts/worktree.py archive-check",
            "python3 scripts/worktree.py retire --pr 471",
            # The sample pattern accepts any positive integer.
            "python3 scripts/worktree.py retire --pr 12345678901",
            "python3 scripts/worktree.py begin --branch claude/next-task",
            "python3 scripts/worktree.py begin --branch codex/follow_up.2",
        )
        owned = self.claude
        checkouts = (self.main, self.claude, self.manual)
        with self.subTest(script="absent"):
            result = self.claude_bash(owned, exact[2], environment)
            self.assertEqual(result.returncode, 2, result.stderr)
        for checkout in checkouts:
            script = checkout / WORKTREE_SCRIPT
            script.parent.mkdir(parents=True, exist_ok=True)
            script.write_text("", encoding="utf-8")
        # The writing commands such a script runs, plus two of its reads. The
        # carve-out is only as wide as these writes, so if any stops being
        # allowed from the owning worktree its rationale no longer holds.
        constituents = (
            "git worktree list --porcelain -z",
            "git ls-remote --exit-code origin refs/heads/main",
            "git fetch origin main",
            "git fetch origin refs/pull/471/head",
            "git switch --no-overwrite-ignore --no-track -c claude/next refs/remotes/origin/main",
            f"git update-ref refs/worktree-script/abc {'a' * 40} {'0' * 40}",
            "git switch --no-overwrite-ignore --detach HEAD",
            f"git update-ref -d refs/heads/task {'a' * 40}",
            "gh api --hostname github.com repos/owner/repo/pulls/471",
        )
        # The same words opening the line, then only reviewed redirections
        # and read-only segments.
        followed = (
            f"{exact[2]} ",
            f"{exact[0]} 2>&1 | tail -5",
            f"{exact[4]} 2>&1 | tail -5; git log -1",
            f"{exact[1]} 2>/dev/null && git status --short",
            f"{exact[2]} | grep -c merged",
        )
        near_misses = (
            f"{exact[2]} --branch claude/next",
            f"{exact[2]} extra",
            f"{exact[2]}; touch outside",
            f"{exact[2]} > receipt.txt",
            f"{exact[2]} 2>&1 | tee receipt.txt",
            f"{exact[2]}; git log -1 --output=receipt.txt",
            f"cd scripts; {exact[2]}",
            f"git log -1; {exact[2]}",
            f"{exact[2]}; {exact[0]}",
            f"{exact[2]} && touch /etc/x",
            f"{exact[2]}\ntouch outside",
            f"{exact[0]} --json",
            f"{exact[1]} extra",
            "python3 scripts/worktree.py retire --pr abc",
            "python3 scripts/worktree.py retire --pr 0",
            "python3 scripts/worktree.py retire --pr -1",
            "python3 scripts/worktree.py retire --pr=471",
            "python3 scripts/worktree.py retire --pr '471'",
            "python3 scripts/worktree.py retire --pr $PR",
            "python3 scripts/worktree.py retire",
            "python3 scripts/worktree.py begin",
            "python3 scripts/worktree.py begin --branch feature/next",
            "python3 scripts/worktree.py begin --branch claude/",
            "python3 scripts/worktree.py begin --branch claude/-next",
            "python3 scripts/worktree.py begin --branch claude/a/b",
            "python3 scripts/worktree.py begin --branch 'claude/next'",
            "python3 scripts/worktree.py begin --branch claude/$(touch x)",
            "python3 scripts/worktree.py begin --branch=claude/next",
            "python3 scripts/other.py retire --pr 471",
            "python3 ./scripts/worktree.py retire --pr 471",
            f"python3 {self.claude}/scripts/worktree.py retire --pr 471",
            "python3 -S scripts/worktree.py retire --pr 471",
            "/usr/bin/python3 scripts/worktree.py retire --pr 471",
            "python3.12 scripts/worktree.py retire --pr 471",
            "python scripts/worktree.py retire --pr 471",
            "env python3 scripts/worktree.py retire --pr 471",
            "PYTHONPATH=. python3 scripts/worktree.py retire --pr 471",
        )
        for command in (*exact, *constituents, *followed):
            with self.subTest(command=command):
                result = self.claude_bash(owned, command, environment)
                self.assertEqual(result.returncode, 0, result.stderr)
        for command in near_misses:
            with self.subTest(command=command):
                result = self.claude_bash(owned, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
        # Ownership still comes first, and the relative script only means
        # the worktree's own file when run from the worktree root.
        for cwd in (*(item for item in checkouts if item != owned), owned / "scripts"):
            for command in (exact[2], followed[2]):
                with self.subTest(cwd=cwd, command=command):
                    result = self.claude_bash(cwd, command, environment)
                    self.assertEqual(result.returncode, 2, result.stderr)
        script = owned / WORKTREE_SCRIPT
        decoy = self.external / "claude-worktree.py"
        decoy.write_text("", encoding="utf-8")
        script.unlink()
        script.symlink_to(decoy)
        with self.subTest(script="symlink"):
            result = self.claude_bash(owned, exact[2], environment)
            self.assertEqual(result.returncode, 2, result.stderr)

    def test_no_settings_trust_no_script(self) -> None:
        """Without settings, or with an empty list, the script is unprovable."""

        script = self.claude / WORKTREE_SCRIPT
        script.parent.mkdir(parents=True)
        script.write_text("", encoding="utf-8")
        command = "python3 scripts/worktree.py status"
        for label, environment in (
            ("unset", hermetic_git_env()),
            ("empty", {**hermetic_git_env(), "KAVACH_CONFIG": ""}),
            ("no entries", self.settings_env({"worktree": {"trustedCommands": []}})),
            ("no worktree section", self.settings_env({})),
        ):
            with self.subTest(settings=label):
                result = self.claude_bash(self.claude, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("mutation targets could not be resolved", result.stderr)
        with self.subTest(settings="trusted"):
            result = self.claude_bash(self.claude, command, self.settings_env(WORKTREE_SETTINGS))
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_loose_pattern_trusts_no_hidden_command(self) -> None:
        """A pattern ending in `.*` still trusts only plain words: a line that
        hides a second command is judged as any other line is."""

        environment = self.settings_env(
            {
                "worktree": {
                    "trustedCommands": [
                        {"script": WORKTREE_SCRIPT, "pattern": r"python3 scripts/worktree\.py .*"}
                    ]
                }
            }
        )
        script = self.claude / WORKTREE_SCRIPT
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text("", encoding="utf-8")
        allowed = self.claude_bash(self.claude, "python3 scripts/worktree.py status", environment)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        outside = self.external / "made.txt"
        for command in (
            f"python3 scripts/worktree.py status; touch {outside}",
            f"python3 scripts/worktree.py status && touch {outside}",
            f"python3 scripts/worktree.py status $(touch {outside})",
            f"python3 scripts/worktree.py status > {outside}",
            f"python3 scripts/worktree.py 'status; touch {outside}'",
        ):
            with self.subTest(command=command):
                result = self.claude_bash(self.claude, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_each_entry_trusts_only_its_own_script(self) -> None:
        """A command matching one entry needs that entry's script, no other's."""

        environment = self.settings_env(
            {
                "worktree": {
                    "trustedCommands": [
                        {"script": WORKTREE_SCRIPT, "pattern": WORKTREE_PATTERN},
                        {"script": "tools/check.py", "pattern": r"python3 tools/check\.py run"},
                    ]
                }
            }
        )
        first, second = "python3 scripts/worktree.py status", "python3 tools/check.py run"
        own = self.claude / "tools/check.py"
        own.parent.mkdir(parents=True)
        own.write_text("", encoding="utf-8")
        for command, expected in ((first, 2), (second, 0), (f"{second} | tail -1", 0)):
            with self.subTest(command=command, present="tools/check.py"):
                result = self.claude_bash(self.claude, command, environment)
                self.assertEqual(result.returncode, expected, result.stderr)
        own.unlink()
        script = self.claude / WORKTREE_SCRIPT
        script.parent.mkdir(parents=True)
        script.write_text("", encoding="utf-8")
        for command, expected in ((first, 0), (second, 2), (f"{first} 2>&1 | tail -5", 0)):
            with self.subTest(command=command, present=WORKTREE_SCRIPT):
                result = self.claude_bash(self.claude, command, environment)
                self.assertEqual(result.returncode, expected, result.stderr)

    def read_only_env(self, **variables: str) -> dict[str, str]:
        """The hook's environment with READ_ONLY_SETTINGS and ``variables``."""

        return {**self.settings_env(READ_ONLY_SETTINGS), **variables}

    def test_reviewed_reads_run_from_a_checkout_root_in_their_environment(self) -> None:
        """A reviewed read runs from any checkout's root, an unowned one
        included, when the hook's environment is the entry's."""

        environment = self.read_only_env(**HOSTED)
        allowed = (
            "pnpm health:check",
            "pnpm ls",
            "pnpm list",
            "pnpm ls @scope/pkg --depth 0",
            "pnpm why left-pad",
            "pnpm list --depth 1 --json",
            # The same words opening the line, then only read-only segments.
            "pnpm health:check 2>&1 | tail -5",
            "pnpm health:check; echo done",
            "pnpm ls @scope/pkg --depth 0 2>/dev/null | grep -c pkg",
        )
        for cwd in (self.main, self.manual, self.claude):
            for command in allowed:
                with self.subTest(cwd=cwd, command=command):
                    result = self.claude_bash(cwd, command, environment)
                    self.assertEqual(result.returncode, 0, result.stderr)
        with self.subTest(entry="remote_desktop"):
            result = self.claude_bash(
                self.main, "pnpm ls", {**environment, "AGENT_ENTRY": "remote_desktop"}
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_everything_else_stays_refused_where_no_worktree_is_owned(self) -> None:
        environment = self.read_only_env(**HOSTED)
        outside = self.external / "made.txt"
        refused = (
            "pnpm install",
            "pnpm i",
            "pnpm add left-pad",
            "pnpm exec tsx script.ts",
            "pnpm run build",
            "pnpm build",
            "pnpm health:check extra",
            "pnpm health:check --fix",
            "pnpm -C sub ls",
            "pnpm --dir sub ls",
            "pnpm --filter app ls",
            "pnpm ls -C sub",
            "pnpm ls --dir /elsewhere",
            "pnpm ls --pnpmfile=probe.cjs",
            "pnpm why x --filter app",
            "pnpm list --depth=1",
            "pnpm list --json --depth 1",
            "pnpm --config.verify-deps-before-run=install health:check",
            "pnpm ls > list.txt",
            f"pnpm ls >> {outside}",
            "pnpm ls 2>&1 | tee list.txt",
            f"pnpm ls; touch {outside}",
            f"pnpm health:check && touch {outside}",
            f"pnpm ls $(touch {outside})",
            f"pnpm ls 'a; touch {outside}'",
            "pnpm ls $PKG",
            f"pnpm ls\ntouch {outside}",
            f"touch {outside}; pnpm ls",
            "cd sub; pnpm ls",
            "AGENT_REMOTE=true pnpm ls",
            "FORCE=1 pnpm health:check",
            "env pnpm ls",
            "/usr/local/bin/pnpm ls",
            "./pnpm ls",
            "npx pnpm ls",
            "npm ls",
        )
        for command in refused:
            with self.subTest(command=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("BLOCKED", result.stderr)
        self.assertFalse(outside.exists())
        # A subfolder's manifest is not the root's: its `health:check` is
        # another script.
        sub = self.main / "sub"
        sub.mkdir()
        for command in ("pnpm health:check", "pnpm ls"):
            with self.subTest(cwd="sub", command=command):
                result = self.claude_bash(sub, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("Claude-managed worktree", result.stderr)

    def test_reviewed_reads_need_every_variable_of_their_environment(self) -> None:
        cases = (
            ("on a laptop", {}),
            ("remote only", {"AGENT_REMOTE": "true"}),
            ("entry only", {"AGENT_ENTRY": "remote"}),
            ("remote false", {**HOSTED, "AGENT_REMOTE": "false"}),
            ("remote upper case", {**HOSTED, "AGENT_REMOTE": "TRUE"}),
            ("remote empty", {**HOSTED, "AGENT_REMOTE": ""}),
            ("another entry", {**HOSTED, "AGENT_ENTRY": "cli"}),
        )
        for label, variables in cases:
            environment = self.read_only_env(**variables)
            for command in ("pnpm health:check", "pnpm ls"):
                with self.subTest(environment=label, command=command):
                    result = self.claude_bash(self.main, command, environment)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn("Claude-managed worktree", result.stderr)
        for label, environment in (
            ("no settings", {**hermetic_git_env(), **HOSTED}),
            ("no entries", {**self.settings_env({"worktree": {"readOnlyCommands": []}}), **HOSTED}),
            ("trusted commands only", {**self.settings_env(WORKTREE_SETTINGS), **HOSTED}),
        ):
            with self.subTest(settings=label):
                result = self.claude_bash(self.main, "pnpm ls", environment)
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_read_only_request_matches_each_entry_in_its_own_environment(self) -> None:
        """In process: an entry admits only its own lines, in its own
        environment, from the root it is handed."""

        # Any entry shaped like `config.ReadOnlyCommand` will do.
        entries = (
            mock.Mock(pattern=re.compile(r"pnpm ls"), env=(("A", ("1",)),)),
            mock.Mock(pattern=re.compile(r"pnpm why x"), env=(("B", ("2", "3")),)),
        )
        root = self.main
        for command, environ, expected in (
            ("pnpm ls", {"A": "1"}, True),
            ("pnpm ls", {"B": "2"}, False),
            ("pnpm why x", {"B": "3"}, True),
            ("pnpm why x", {"A": "1"}, False),
            ("pnpm why x | tail -1", {"B": "2"}, True),
            ("pnpm why x | tee out", {"B": "2"}, False),
        ):
            with self.subTest(command=command, environ=environ):
                self.assertEqual(
                    MODULE.read_only_request(command, root, root, entries, environ), expected
                )
        self.assertFalse(MODULE.read_only_request("pnpm ls", root, root, (), {"A": "1"}))
        self.assertFalse(
            MODULE.read_only_request("pnpm ls", root / "sub", root, entries, {"A": "1"})
        )

    def test_unusable_settings_refuse_every_event(self) -> None:
        """A guard that misread what it trusts must not allow, a read included."""

        cases = (
            ("unreadable", None, "cannot be read"),
            ("not JSON", "{", "is not JSON"),
            ("an unknown key", {"worktree": {"trusted": []}}, "unknown key(s): trusted"),
            (
                "a bad pattern",
                {"worktree": {"trustedCommands": [{"script": WORKTREE_SCRIPT, "pattern": "("}]}},
                "is not a regular expression",
            ),
        )
        for label, document, reason in cases:
            if document is None:
                environment = hermetic_git_env()
                environment["KAVACH_CONFIG"] = str(self.external / "absent.json")
            else:
                environment = self.settings_env(document)
            for event in (
                {"tool_name": "Bash", "tool_input": {"command": "ls"}},
                {"tool_name": "Write", "tool_input": {"file_path": str(self.claude / "new.txt")}},
            ):
                with self.subTest(settings=label, tool=event["tool_name"]):
                    result = self.invoke(self.claude, env=environment, **event)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn("BLOCKED: the ownership guard cannot use its settings", result.stderr)
                    self.assertIn(reason, result.stderr)

    def test_settings_are_read_from_the_environment_in_process(self) -> None:
        trusted = self.settings_env(WORKTREE_SETTINGS)["KAVACH_CONFIG"]
        with mock.patch.dict(os.environ, {"KAVACH_CONFIG": trusted}):
            loaded = ADAPTER.settings()
        self.assertEqual([entry.script for entry in loaded.trusted_commands], [WORKTREE_SCRIPT])
        with mock.patch.dict(os.environ, {"KAVACH_CONFIG": ""}):
            self.assertEqual(ADAPTER.settings().trusted_commands, ())
        broken = self.settings_env("[]", name="broken.json")["KAVACH_CONFIG"]
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {"KAVACH_CONFIG": broken}):
            with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
                ADAPTER.settings()
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("the settings must be a JSON object", stderr.getvalue())


class TrustedRequestTest(unittest.TestCase):
    """`trusted_request` takes any entries shaped like `config.TrustedCommand`,
    so the boundary needs no settings file and no settings module."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        (self.root / "scripts").mkdir()
        (self.root / WORKTREE_SCRIPT).write_text("", encoding="utf-8")

    def entry(self, script: str, pattern: str) -> object:
        return mock.Mock(script=script, pattern=re.compile(pattern))

    def test_no_entries_trust_nothing(self) -> None:
        command = "python3 scripts/worktree.py status"
        self.assertFalse(MODULE.trusted_request(command, self.root, self.root))
        self.assertFalse(MODULE.trusted_request(command, self.root, self.root, ()))

    def test_an_entry_is_matched_whole_and_needs_its_script(self) -> None:
        trusted = (self.entry(WORKTREE_SCRIPT, WORKTREE_PATTERN),)
        for command, expected in (
            ("python3 scripts/worktree.py status", True),
            ("python3 scripts/worktree.py status; ls", True),
            ("python3 scripts/worktree.py status extra", False),
            ("python3 scripts/worktree.py status; touch x", False),
            ("'python3' scripts/worktree.py status", False),
            ("python3 scripts/worktree.py 'status'", False),
            ("echo >", False),
        ):
            with self.subTest(command=command):
                self.assertIs(
                    MODULE.trusted_request(command, self.root, self.root, trusted), expected
                )
        self.assertFalse(
            MODULE.trusted_request(
                "python3 scripts/worktree.py status", self.root / "scripts", self.root, trusted
            )
        )
        absent = (self.entry("scripts/absent.py", WORKTREE_PATTERN),)
        self.assertFalse(
            MODULE.trusted_request("python3 scripts/worktree.py status", self.root, self.root, absent)
        )


class ClaudeAgentMemoryTest(GuardFixture):
    """The one mutation target that is not repository state.

    Claude Code keeps a session's agent memory outside every checkout, so the
    worktree boundary has nothing to protect there. These tests pin both halves
    of the allowance: that a memory write is permitted from any checkout, and
    that it buys nothing else -- not the directory above it, not a path that
    escapes it, and not a command that touches memory and the repository at
    once.
    """

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        temp = Path(self.temporary.name)
        self.main = (temp / "main").resolve()
        self.claude = self.main / ".claude" / "worktrees" / "claude-task"
        self.other = (temp / "other-task").resolve()
        self.config = (temp / "claude-home").resolve()
        self.make_repository(self.main)
        self.claude.parent.mkdir(parents=True)
        git(self.main, "worktree", "add", "-qb", "claude-task", str(self.claude))
        git(self.main, "worktree", "add", "-qb", "other-task", str(self.other))
        self.environment = hermetic_git_env()
        self.environment["CLAUDE_CONFIG_DIR"] = str(self.config)
        # The adapter derives the slug from the PRIMARY checkout, so this is
        # the only directory any of this repository's worktrees may write.
        slug = re.sub(r"[^A-Za-z0-9]", "-", str(self.main))
        self.project = self.config / "projects" / slug
        self.memory = self.project / "memory"

    def adapter(
        self, cwd: Path, tool_input: dict[str, str], tool_name: str = "Write"
    ) -> subprocess.CompletedProcess[str]:
        environment = hermetic_git_env()
        environment["CLAUDE_CONFIG_DIR"] = str(self.config)
        return subprocess.run(
            [sys.executable, str(ADAPTER_PATH)],
            input=json.dumps(
                {"cwd": str(cwd), "tool_name": tool_name, "tool_input": tool_input}
            ),
            capture_output=True,
            text=True,
            check=False,
            env=environment,
        )

    def test_memory_path_follows_claude_code_project_slug(self) -> None:
        """Every character outside [A-Za-z0-9] becomes a dash, dots included."""
        with mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.config)}):
            self.assertEqual(
                ADAPTER.memory_path(Path("/Users/x/code/acme/acme_mono")),
                self.config
                / "projects"
                / "-Users-x-code-acme-acme-mono"
                / "memory",
            )
            self.assertEqual(
                ADAPTER.memory_path(Path("/Users/x/.harness/cache/a.b")),
                self.config / "projects" / "-Users-x--harness-cache-a-b" / "memory",
            )

    def test_project_dir_name_override_is_honoured_within_its_namespace(self) -> None:
        """Claude Code honours it beside CLAUDE_CONFIG_DIR; so must the guard."""
        pinned = self.config / "projects" / "pinned_name-1" / "memory"
        pinned.mkdir(parents=True)
        environment = dict(self.environment)
        environment["CLAUDE_CODE_PROJECT_DIR_NAME"] = "pinned_name-1"
        with mock.patch.dict(os.environ, environment, clear=True):
            self.assertEqual(ADAPTER.claude_memory_root(self.main), pinned)
        # Without CLAUDE_CONFIG_DIR Claude Code ignores the name, and so does
        # this; and a name that is not a single safe segment cannot traverse.
        for override in (
            {"CLAUDE_CODE_PROJECT_DIR_NAME": "pinned_name-1"},
            {
                "CLAUDE_CONFIG_DIR": str(self.config),
                "CLAUDE_CODE_PROJECT_DIR_NAME": "../../../etc",
            },
            {
                "CLAUDE_CONFIG_DIR": str(self.config),
                "CLAUDE_CODE_PROJECT_DIR_NAME": "a" * 65,
            },
        ):
            with self.subTest(override=override):
                with mock.patch.dict(os.environ, override, clear=True):
                    self.assertNotEqual(
                        ADAPTER.memory_path(self.main).resolve(), pinned
                    )

    def test_auto_memory_directory_is_read_only_from_user_settings(self) -> None:
        """Project and local settings live in the worktree this guard gates."""
        relocated = (Path(self.temporary.name) / "relocated-memory").resolve()
        relocated.mkdir()
        self.config.mkdir(parents=True, exist_ok=True)
        (self.config / "settings.json").write_text(
            json.dumps({"autoMemoryDirectory": str(relocated)}), encoding="utf-8"
        )
        with mock.patch.dict(os.environ, self.environment, clear=True):
            self.assertEqual(ADAPTER.claude_memory_root(self.main), relocated)
        note = self.adapter(self.claude, {"file_path": str(relocated / "note.md")})
        self.assertEqual(note.returncode, 0, note.stderr)
        # A relocation naming a checkout hands back the writes the worktree
        # boundary exists to refuse, so it is rejected however it was set.
        for hostile in (str(self.main), str(self.main.parent)):
            with self.subTest(hostile=hostile):
                (self.config / "settings.json").write_text(
                    json.dumps({"autoMemoryDirectory": hostile}), encoding="utf-8"
                )
                with mock.patch.dict(os.environ, self.environment, clear=True):
                    self.assertIsNone(ADAPTER.claude_memory_root(self.main))
                escalation = self.adapter(
                    self.claude, {"file_path": str(self.main / "tracked.txt")}
                )
                self.assertEqual(escalation.returncode, 2, escalation.stderr)

    def test_project_scoped_auto_memory_setting_is_ignored(self) -> None:
        """A session can write .claude/settings.local.json; it must not count."""
        relocated = Path(self.temporary.name) / "self-granted"
        relocated.mkdir()
        for scope in ("settings.json", "settings.local.json"):
            with self.subTest(scope=scope):
                settings = self.claude / ".claude" / scope
                settings.parent.mkdir(parents=True, exist_ok=True)
                settings.write_text(
                    json.dumps({"autoMemoryDirectory": str(relocated)}),
                    encoding="utf-8",
                )
                with mock.patch.dict(os.environ, self.environment, clear=True):
                    self.assertIsNone(ADAPTER.claude_memory_root(self.main))
                result = self.adapter(
                    self.claude, {"file_path": str(relocated / "note.md")}
                )
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_malformed_user_settings_fall_back_to_the_derived_path(self) -> None:
        self.config.mkdir(parents=True, exist_ok=True)
        self.memory.mkdir(parents=True)
        for payload in ("{ not json", json.dumps([1, 2]), json.dumps(
            {"autoMemoryDirectory": "relative/path"}
        ), json.dumps({"autoMemoryDirectory": 7})):
            with self.subTest(payload=payload):
                (self.config / "settings.json").write_text(payload, encoding="utf-8")
                with mock.patch.dict(os.environ, self.environment, clear=True):
                    self.assertEqual(
                        ADAPTER.claude_memory_root(self.main), self.memory
                    )

    def test_memory_root_is_withheld_unless_it_is_a_real_directory(self) -> None:
        elsewhere = Path(self.temporary.name) / "elsewhere"
        elsewhere.mkdir()
        with mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.config)}):
            self.assertIsNone(ADAPTER.claude_memory_root(self.main))
            self.project.mkdir(parents=True)
            self.memory.write_text("not a directory", encoding="utf-8")
            self.assertIsNone(ADAPTER.claude_memory_root(self.main))
            self.memory.unlink()
            self.memory.symlink_to(elsewhere, target_is_directory=True)
            self.assertIsNone(ADAPTER.claude_memory_root(self.main))
            self.memory.unlink()
            self.memory.mkdir()
            self.assertEqual(ADAPTER.claude_memory_root(self.main), self.memory)
            # A symlink one level up would redirect the allowance just as well.
            shutil.rmtree(self.project)
            self.project.symlink_to(elsewhere, target_is_directory=True)
            (elsewhere / "memory").mkdir()
            self.assertIsNone(ADAPTER.claude_memory_root(self.main))

    def test_memory_writes_are_allowed_from_every_checkout(self) -> None:
        self.memory.mkdir(parents=True)
        note = self.memory / "docker-vm-disk-blocks-push.md"
        for cwd in (self.claude, self.main, self.other):
            with self.subTest(cwd=cwd):
                result = self.adapter(cwd, {"file_path": str(note)})
                self.assertEqual(result.returncode, 0, result.stderr)
        nested = self.adapter(self.claude, {"file_path": str(self.memory / "a" / "b.md")})
        self.assertEqual(nested.returncode, 0, nested.stderr)
        # A mutating shell command also counts the directory it runs in, so it
        # needs an owned worktree for that half and the allowance for the file.
        shell = self.adapter(
            self.claude,
            {"command": f"touch {shlex.quote(str(note))}"},
            tool_name="Bash",
        )
        self.assertEqual(shell.returncode, 0, shell.stderr)
        unowned = self.adapter(
            self.main,
            {"command": f"touch {shlex.quote(str(note))}"},
            tool_name="Bash",
        )
        self.assertEqual(unowned.returncode, 2, unowned.stderr)

    def test_memory_allowance_stops_at_the_memory_directory(self) -> None:
        self.memory.mkdir(parents=True)
        note = self.memory / "note.md"
        for target in (
            self.project / "transcript.jsonl",
            self.config / "settings.json",
            self.memory.parent.parent / "other-project" / "memory" / "note.md",
            self.memory / ".." / "escaped.md",
        ):
            with self.subTest(target=target):
                result = self.adapter(self.claude, {"file_path": str(target)})
                self.assertEqual(result.returncode, 2, result.stderr)
        # One command, two operands: the operand outside memory still decides.
        mixed = self.adapter(
            self.claude,
            {
                "command": "touch "
                f"{shlex.quote(str(note))} {shlex.quote(str(self.main / 'new.txt'))}"
            },
            tool_name="Bash",
        )
        self.assertEqual(mixed.returncode, 2, mixed.stderr)
        self.assertIn("new.txt", mixed.stderr)

    def test_absent_memory_leaves_worktree_ownership_exactly_as_it_was(self) -> None:
        owned = self.adapter(self.claude, {"file_path": str(self.claude / "new.txt")})
        self.assertEqual(owned.returncode, 0, owned.stderr)
        for cwd, target in (
            (self.claude, self.other / "new.txt"),
            (self.claude, self.main / "new.txt"),
            (self.other, self.other / "new.txt"),
            (self.main, self.main / "new.txt"),
        ):
            with self.subTest(cwd=cwd, target=target):
                result = self.adapter(cwd, {"file_path": str(target)})
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_a_refused_memory_write_says_why_rather_than_naming_worktrees(self) -> None:
        """A bare worktree message is what made the last finding evaporate."""
        blocked = self.adapter(self.claude, {"file_path": str(self.memory / "note.md")})
        self.assertEqual(blocked.returncode, 2, blocked.stderr)
        self.assertIn("agent memory is writable only when", blocked.stderr)
        self.memory.mkdir(parents=True)
        allowed = self.adapter(self.claude, {"file_path": str(self.memory / "note.md")})
        self.assertEqual(allowed.returncode, 0, allowed.stderr)


class ClaudeHarnessStateTest(GuardFixture):
    """The read-namespace that lets a report read a worktree run's transcripts.

    Harness transcripts live under the user's Claude config directory, so
    passing one to a reporting script made it a path operand of a scoped
    runner and the guard counted it as a declared write. These tests pin the
    narrowness of the fix, not its convenience: it must reach ONLY the
    unknown-runner operand path, leave every command with a real parser
    confining the same directory, and leave the file tools untouched.
    """

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        temp = Path(self.temporary.name)
        self.main = (temp / "main").resolve()
        self.claude = self.main / ".claude" / "worktrees" / "claude-task"
        self.config = (temp / "claude-home").resolve()
        self.make_repository(self.main)
        self.claude.parent.mkdir(parents=True)
        git(self.main, "worktree", "add", "-qb", "claude-task", str(self.claude))
        # Transcripts are keyed on the directory a session RUNS in, so the
        # worktree has its own state root beside the repository's.
        self.worktree_state = self.config / "projects" / re.sub(
            r"[^A-Za-z0-9]", "-", str(self.claude.resolve())
        )
        self.main_state = self.config / "projects" / re.sub(
            r"[^A-Za-z0-9]", "-", str(self.main)
        )

    def adapter(
        self, cwd: Path, tool_input: dict[str, str], tool_name: str = "Bash"
    ) -> subprocess.CompletedProcess[str]:
        environment = hermetic_git_env()
        environment["CLAUDE_CONFIG_DIR"] = str(self.config)
        return subprocess.run(
            [sys.executable, str(ADAPTER_PATH)],
            input=json.dumps(
                {"cwd": str(cwd), "tool_name": tool_name, "tool_input": tool_input}
            ),
            capture_output=True,
            text=True,
            check=False,
            env=environment,
        )

    def test_a_runner_may_be_handed_a_transcript_directory(self) -> None:
        """The reported failure: no worktree-launched run could be reported on."""
        for state in (self.worktree_state, self.main_state):
            transcript = state / "session" / "subagents" / "workflows" / "wf_1"
            transcript.mkdir(parents=True)
            command = (
                "npx tsx scripts/report.ts "
                f"{shlex.quote(str(transcript))} --parent=pr-1 --run=r1"
            )
            with self.subTest(state=state):
                result = self.adapter(self.claude, {"command": command})
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_commands_with_a_parser_still_confine_that_directory(self) -> None:
        """The namespace excuses an UNKNOWN runner's operand, nothing else.

        Each of these names the very same path the runner above was allowed to
        read. A parser knows these write it, so the boundary still decides.
        """
        transcript = self.main_state / "session"
        transcript.mkdir(parents=True)
        # It exists: GNU sed edits a file named after `-i ''` only if it can
        # open it, so a missing one would prove nothing here.
        (transcript / "agent-1.jsonl").write_text("{}\n", encoding="utf-8")
        victim = shlex.quote(str(transcript / "agent-1.jsonl"))
        for command in (
            f"rm -rf {shlex.quote(str(transcript))}",
            f"cp tracked.txt {victim}",
            f"mv tracked.txt {victim}",
            f"tee {victim}",
            f"touch {victim}",
            f"mkdir -p {shlex.quote(str(transcript / 'new'))}",
            f"sed -i '' s/a/b/ {victim}",
            # GNU sed reads `''` as the program and the victim as its file.
            f"sed -i '' {victim}",
        ):
            with self.subTest(command=command):
                result = self.adapter(self.claude, {"command": command})
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_an_empty_sed_suffix_is_read_both_ways(self) -> None:
        """Under either sed's reading every operand here is inside the worktree."""
        for command in (
            "sed -i '' s/a/b/ tracked.txt",
            "sed -i '' tracked.txt",
        ):
            with self.subTest(command=command):
                result = self.adapter(self.claude, {"command": command})
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_file_tools_never_consult_the_namespace(self) -> None:
        """A file tool names one path and always writes it."""
        transcript = self.main_state / "session"
        transcript.mkdir(parents=True)
        for tool in ("Write", "Edit", "NotebookEdit"):
            key = "notebook_path" if tool == "NotebookEdit" else "file_path"
            with self.subTest(tool=tool):
                result = self.adapter(
                    self.claude,
                    {key: str(transcript / "agent-1.jsonl")},
                    tool_name=tool,
                )
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_the_namespace_is_withheld_until_the_directory_exists(self) -> None:
        """An absent state root buys nothing, and neither does a redirected one.

        Each redirection below resolves to a directory that really EXISTS, so
        the refusal is the redirection and not mere absence. Getting that wrong
        makes the assertion pass whatever the gate does: a symlink into a repo
        that has no `<slug>` child fails `is_dir()` first, and the test then
        proves nothing about redirection at all.
        """
        slug = re.sub(r"[^A-Za-z0-9]", "-", str(self.main))
        peer = Path(self.temporary.name) / "peer-repo"
        self.make_repository(peer)
        # The child a `projects/`-level redirect would land on, so that case
        # resolves to something real rather than tripping the absence check.
        (peer / slug / "session" / "wf_1").mkdir(parents=True)
        target = self.main_state / "session" / "wf_1"
        command = f"npx tsx x.ts {shlex.quote(str(target))}"
        # Absent.
        self.assertEqual(self.adapter(self.claude, {"command": command}).returncode, 2)
        # A symlink AT the state root. `peer` exists and is a checkout.
        self.main_state.parent.mkdir(parents=True, exist_ok=True)
        self.main_state.symlink_to(peer, target_is_directory=True)
        self.assertTrue(self.main_state.resolve().is_dir())
        self.assertEqual(self.adapter(self.claude, {"command": command}).returncode, 2)
        self.main_state.unlink()
        # The same one level up, at `projects/`. The state root now resolves to
        # `peer/<slug>`, which exists because of the mkdir above.
        shutil.rmtree(self.main_state.parent)
        self.main_state.parent.symlink_to(peer, target_is_directory=True)
        self.assertTrue(self.main_state.resolve().is_dir())
        self.assertEqual(self.adapter(self.claude, {"command": command}).returncode, 2)
        self.main_state.parent.unlink()

    def test_a_redirect_inside_the_config_directory_is_refused_outright(self) -> None:
        """The symlink gate answers a threat the checkout test cannot see.

        A symlink at `projects/` or `projects/<slug>` aimed at an ordinary
        directory lands nowhere near a repository, so only the symlink check
        refuses it. Both targets below really exist, so absence cannot be what
        withholds the namespace.
        """
        slug = re.sub(r"[^A-Za-z0-9]", "-", str(self.main))
        plain = Path(self.temporary.name) / "not-a-repo"
        (plain / slug / "session" / "wf_1").mkdir(parents=True)
        (plain / "session" / "wf_1").mkdir(parents=True)
        target = self.main_state / "session" / "wf_1"
        command = f"npx tsx x.ts {shlex.quote(str(target))}"
        for level in ("state-root", "projects"):
            with self.subTest(level=level):
                if level == "state-root":
                    self.main_state.parent.mkdir(parents=True, exist_ok=True)
                    self.main_state.symlink_to(plain, target_is_directory=True)
                else:
                    self.main_state.parent.symlink_to(
                        plain, target_is_directory=True
                    )
                self.assertTrue(self.main_state.resolve().is_dir())
                self.assertFalse(
                    ADAPTER.lands_in_a_checkout(self.main_state.resolve()),
                    "fixture must not accidentally point at a repository",
                )
                result = self.adapter(self.claude, {"command": command})
                self.assertEqual(result.returncode, 2, result.stderr)
                if level == "state-root":
                    self.main_state.unlink()
                    shutil.rmtree(self.main_state.parent)
                else:
                    self.main_state.parent.unlink()
        # A real directory finally earns it.
        target.mkdir(parents=True)
        self.assertEqual(self.adapter(self.claude, {"command": command}).returncode, 0)

    def test_a_redirection_into_any_checkout_withholds_the_namespace(self) -> None:
        """A symlink ABOVE the state root aims it at another repository.

        The `is_inside` guards only prove the result is not THIS checkout, so a
        symlink at the config directory can point `projects/` into a peer
        repository and excuse ITS paths. The redirection is caught wherever on
        the path it sits, because the test is where the directory LANDS.
        """
        peer = Path(self.temporary.name) / "peer-repo"
        self.make_repository(peer)
        (peer / "projects" / re.sub(
            r"[^A-Za-z0-9]", "-", str(self.main)
        ) / "session").mkdir(parents=True)
        target = self.main_state / "session"
        command = f"npx tsx x.ts {shlex.quote(str(target))}"
        # A real config directory holding a real state root earns the namespace.
        target.mkdir(parents=True)
        self.assertEqual(self.adapter(self.claude, {"command": command}).returncode, 0)
        # Redirect the config directory itself and it must be withheld again,
        # even though neither the state root nor `projects/` is a symlink.
        shutil.rmtree(self.config)
        self.config.symlink_to(peer, target_is_directory=True)
        with mock.patch.dict(
            os.environ, {"CLAUDE_CONFIG_DIR": str(self.config)}, clear=True
        ):
            self.assertEqual(
                ADAPTER.harness_state_roots(self.claude, self.main), ()
            )
        self.assertEqual(self.adapter(self.claude, {"command": command}).returncode, 2)

    def test_a_benign_alias_above_the_namespace_still_earns_it(self) -> None:
        """Refusing every symlinked ancestor punished ordinary configurations.

        macOS resolves `/tmp` and `/var` through symlinks, so a config
        directory under either has a symlinked ancestor while being entirely
        legitimate. What matters is that it does not land in a checkout.
        """
        real = Path(self.temporary.name) / "real-home"
        alias = Path(self.temporary.name) / "aliased-home"
        alias.symlink_to(real, target_is_directory=True)
        state = real / "projects" / re.sub(
            r"[^A-Za-z0-9]", "-", str(self.main)
        ) / "session"
        state.mkdir(parents=True)
        aliased_state = (
            alias / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(self.main))
        )
        with mock.patch.dict(
            os.environ, {"CLAUDE_CONFIG_DIR": str(alias)}, clear=True
        ):
            self.assertEqual(
                ADAPTER.harness_state_roots(self.claude, self.main),
                (aliased_state.resolve(),),
            )
        environment = hermetic_git_env()
        environment["CLAUDE_CONFIG_DIR"] = str(alias)
        result = subprocess.run(
            [sys.executable, str(ADAPTER_PATH)],
            input=json.dumps(
                {
                    "cwd": str(self.claude),
                    "tool_name": "Bash",
                    "tool_input": {
                        "command": f"npx tsx x.ts {shlex.quote(str(state))}"
                    },
                }
            ),
            capture_output=True,
            text=True,
            check=False,
            env=environment,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_namespace_naming_the_checkout_is_refused(self) -> None:
        """Otherwise a relocation hands back the repository writes."""
        with mock.patch.dict(
            os.environ,
            {
                "CLAUDE_CONFIG_DIR": str(self.config),
                "CLAUDE_CODE_PROJECT_DIR_NAME": "pinned",
            },
            clear=True,
        ):
            pinned = self.config / "projects" / "pinned"
            pinned.mkdir(parents=True)
            self.assertEqual(
                ADAPTER.harness_state_roots(self.claude, self.main),
                (pinned.resolve(),),
            )
        # A state root that IS the checkout, or contains it, is withheld.
        for hostile in (self.main, self.main.parent):
            with self.subTest(hostile=hostile):
                with mock.patch.dict(
                    os.environ, {"CLAUDE_CONFIG_DIR": str(self.config)}, clear=True
                ):
                    with mock.patch.object(
                        ADAPTER, "project_state_root", lambda _c: hostile
                    ):
                        self.assertEqual(
                            ADAPTER.harness_state_roots(self.claude, self.main), ()
                        )

    def test_other_outside_paths_are_untouched_by_the_namespace(self) -> None:
        """It excuses this project's state root, not the config dir at large."""
        (self.main_state / "session").mkdir(parents=True)
        sibling = self.config / "projects" / "-other-project"
        sibling.mkdir(parents=True)
        for target in (
            sibling / "wf_1",
            self.config / "plans" / "some-plan.md",
            self.config / "settings.json",
            Path(self.temporary.name) / "elsewhere.txt",
        ):
            with self.subTest(target=target):
                result = self.adapter(
                    self.claude,
                    {"command": f"npx tsx x.ts {shlex.quote(str(target))}"},
                )
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_unprovable_operands_still_fail_closed_inside_the_namespace(self) -> None:
        """The namespace is applied AFTER the refusals, never instead of them."""
        transcript = self.main_state / "session"
        transcript.mkdir(parents=True)
        for command in (
            # An unexpanded variable: where it points is unknown.
            f"npx tsx x.ts {shlex.quote(str(self.config))}/projects/$SLUG/wf",
            # An attached short option embeds a destination in a grammar this
            # parser does not know, so the whole token stays unreadable.
            f"npx tsx x.ts -o{shlex.quote(str(transcript / 'out'))}",
        ):
            with self.subTest(command=command):
                result = self.adapter(self.claude, {"command": command})
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_the_parser_defaults_to_no_namespace(self) -> None:
        """Only a caller that passes ``read_namespaces`` gets the allowance."""
        transcript = self.main_state / "session"
        transcript.mkdir(parents=True)
        command = f"npx tsx x.ts {shlex.quote(str(transcript))}"
        self.assertEqual(
            MODULE.mutation_directories(command, self.claude),
            MODULE.mutation_directories(command, self.claude, read_namespaces=()),
        )
        without = MODULE.mutation_directories(command, self.claude)
        assert without is not None
        self.assertIn(transcript.resolve(), without)


class ClaudeAdapterFailureTest(unittest.TestCase):
    """Any error in the Claude adapter refuses the call.

    Claude Code lets a hook's exit 1 through, so an uncaught error would wave
    every Bash, Edit and Write call on unchecked.
    """

    def refusal(self, call: Callable[[], object]) -> str:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
            call()
        self.assertEqual(raised.exception.code, 2)
        return stderr.getvalue()

    def test_an_error_in_the_guard_refuses_and_names_it(self) -> None:
        with mock.patch.object(ADAPTER, "main", side_effect=RuntimeError("stand-in bug")):
            message = self.refusal(ADAPTER.run)
        self.assertIn("BLOCKED: the ownership guard failed", message)
        self.assertIn("RuntimeError: stand-in bug", message)

    def test_an_interrupted_guard_refuses(self) -> None:
        # The handler catches BaseException on purpose: narrowed to Exception,
        # an interrupt would escape as exit 1 and wave the call on.
        with mock.patch.object(ADAPTER, "main", side_effect=KeyboardInterrupt()):
            message = self.refusal(ADAPTER.run)
        self.assertIn("KeyboardInterrupt", message)

    def test_the_guards_own_verdicts_pass_through(self) -> None:
        for code in (0, 2):
            with self.subTest(code=code), mock.patch.object(
                ADAPTER, "main", side_effect=SystemExit(code)
            ):
                with self.assertRaises(SystemExit) as raised:
                    ADAPTER.run()
                self.assertEqual(raised.exception.code, code)
        with mock.patch.object(ADAPTER, "main", return_value=None):
            ADAPTER.run()

    def test_an_exit_that_is_not_a_verdict_refuses(self) -> None:
        for code in (1, "a message", None, 2.0):
            with self.subTest(code=code), mock.patch.object(
                ADAPTER, "main", side_effect=SystemExit(code)
            ):
                message = self.refusal(ADAPTER.run)
                self.assertIn(f"exit {code!r} instead of a verdict", message)

    def test_a_boundary_that_fails_to_load_refuses(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            for name, source, error in (
                ("raises.py", "raise RuntimeError('stand-in bug')\n", "RuntimeError: stand-in bug"),
                ("broken.py", "def broken(:\n", "SyntaxError"),
                ("exits-0.py", "raise SystemExit(0)\n", "exit 0 instead of a verdict"),
                ("exits-1.py", "raise SystemExit(1)\n", "exit 1 instead of a verdict"),
                ("exits-2-float.py", "raise SystemExit(2.0)\n", "exit 2.0 instead of a verdict"),
                ("interrupted.py", "raise KeyboardInterrupt\n", "KeyboardInterrupt"),
            ):
                with self.subTest(name=name):
                    path = Path(scratch) / name
                    path.write_text(source, encoding="utf-8")
                    message = self.refusal(lambda: ADAPTER.load_boundary(path))
                    self.assertIn(f"could not load {name}", message)
                    self.assertIn(error, message)
            message = self.refusal(lambda: ADAPTER.load_boundary(Path(scratch) / "absent.py"))
            self.assertIn("could not load absent.py", message)

    def test_a_settings_loader_that_fails_to_load_refuses_and_is_forgotten(self) -> None:
        """The settings module is registered while it runs; a failed load
        leaves the registry as it found it."""

        name = "kavach_worktree_config"
        before = sys.modules.get(name)
        with tempfile.TemporaryDirectory() as scratch:
            for source, error, code in (
                ("raise RuntimeError('stand-in bug')\n", "RuntimeError: stand-in bug", 2),
                ("raise SystemExit(1)\n", "exit 1 instead of a verdict", 2),
            ):
                with self.subTest(source=source):
                    path = Path(scratch) / "config.py"
                    path.write_text(source, encoding="utf-8")
                    message = self.refusal(lambda: ADAPTER.load_config(path))
                    self.assertIn("could not load config.py", message)
                    self.assertIn(error, message)
                    self.assertIs(sys.modules.get(name), before)
            # A refusal raised while loading passes through as it is.
            path = Path(scratch) / "config.py"
            path.write_text("raise SystemExit(2)\n", encoding="utf-8")
            with self.assertRaises(SystemExit) as raised:
                ADAPTER.load_config(path)
            self.assertEqual(raised.exception.code, 2)
            self.assertIs(sys.modules.get(name), before)
        with mock.patch.dict(sys.modules):
            sys.modules.pop(name, None)
            with tempfile.TemporaryDirectory() as scratch:
                path = Path(scratch) / "config.py"
                path.write_text("raise RuntimeError('first load')\n", encoding="utf-8")
                self.refusal(lambda: ADAPTER.load_config(path))
                self.assertNotIn(name, sys.modules)
