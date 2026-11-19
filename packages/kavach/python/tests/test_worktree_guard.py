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
    git_output,
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


# A sample consumer setting: one CLI whose writes the consumer reviewed (only
# under the git toplevel), with the options and operands that are paths.
REVIEWED_CLI = {
    "program": "niyam",
    "subcommands": {
        "handoff": {"pathOptions": ["--open-brief"]},
        "pr-signals": {},
        "review-thread": {"pathOptions": ["--body-file"]},
        "cubic-dismiss": {"pathOptions": ["--from"]},
        "brief": {"pathOperands": True},
        "keep-going --stop": {},
        "propose": {},
        "--version": {},
    },
    "reason": "writes only under the git toplevel (niyam 0.6.17 audited)",
}
REVIEWED_SETTINGS = {"worktree": {"reviewedCLIs": [REVIEWED_CLI]}}
# The lines a session types, each admitted from the owned worktree's root.
REVIEWED_LINES = (
    'niyam handoff --record --base origin/main --disposition own-work --reason "text with spaces"',
    "niyam handoff --record --base origin/main --disposition handed-off --reason 'why' --open-brief .tmp/b.md",
    "niyam handoff --record --disposition carrying --reason=why --open-brief=.tmp/b.md --brief '#12,#13'",
    'niyam review-thread PRRT_x --reply "text"',
    "niyam review-thread PRRT_x --reply 'it costs $5 and `x` runs nothing here'",
    'niyam review-thread PRRT_x --reply "two\nlines"',
    "niyam review-thread PRRT_x --body-file .tmp/r.md",
    "niyam review-thread PRRT_x --resolve",
    "niyam brief .tmp/d.md",
    "niyam brief --lint ./.tmp/d.md",
    'niyam keep-going --stop "why"',
    "niyam pr-signals 12",
    "niyam pr-signals 12 --ci-only",
    'niyam cubic-dismiss --evidence src/a.ts:12 --title "A title" --reason "it is wrong"',
    "niyam cubic-dismiss --decision https://github.com/o/r/issues/1 --from .tmp/findings.json",
    "niyam propose 67 --page https://claude.ai/artifact/abc",
    "niyam --version",
    '"niyam" pr-signals 12',
    "  niyam\tpr-signals  12  ",
)


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


class ReviewedCLITest(AdapterTest):
    """A reviewed CLI runs from the owned worktree's root, as one command of
    literal words, with its declared paths inside the worktree."""

    def reviewed_env(self, **settings: object) -> dict[str, str]:
        document = {"worktree": dict(REVIEWED_SETTINGS["worktree"])}
        if settings:
            document["command"] = settings
        return self.settings_env(document)

    def test_its_lines_run_from_the_owned_worktree_root(self) -> None:
        environment = self.reviewed_env()
        for command in REVIEWED_LINES:
            with self.subTest(command=command):
                result = self.claude_bash(self.claude, command, environment)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_without_the_setting_they_stay_refused(self) -> None:
        for environment in (hermetic_git_env(), self.settings_env(WORKTREE_SETTINGS)):
            result = self.claude_bash(self.claude, REVIEWED_LINES[0], environment)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("mutation targets could not be resolved", result.stderr)
            self.assertNotIn("reviewed CLI", result.stderr)

    def test_no_other_checkout_and_no_subfolder_runs_them(self) -> None:
        environment = self.reviewed_env()
        (self.claude / "sub").mkdir()
        for cwd, message in (
            (self.main, "Claude-managed worktree"),
            (self.manual, "Claude-managed worktree"),
            (self.external, "cannot determine this session's repository checkout"),
            (self.claude / "sub", "runs only as one plain command from this worktree's root"),
        ):
            for command in (REVIEWED_LINES[0], REVIEWED_LINES[3], "niyam pr-signals 12"):
                with self.subTest(cwd=cwd, command=command):
                    result = self.claude_bash(cwd, command, environment)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn(message, result.stderr)

    def test_a_declared_path_outside_the_worktree_is_refused(self) -> None:
        environment = self.reviewed_env()
        outside = self.external / "r.md"
        (self.claude / "link").symlink_to(self.external)
        for command in (
            f"niyam review-thread PRRT_x --body-file {outside}",
            f"niyam review-thread PRRT_x --body-file '{outside}'",
            "niyam review-thread PRRT_x --body-file ../../../r.md",
            f"niyam brief {self.main}/d.md",
            f"niyam brief --lint {self.manual}/d.md",
            "niyam brief link/d.md",
            f"niyam handoff --record --disposition carrying --reason x --open-brief={outside}",
            f"niyam cubic-dismiss --evidence x --from {outside}",
            f"niyam brief -- {outside}",
            "niyam brief -x/../../../../r.md",
            "niyam brief --lint/../../../../r.md",
        ):
            with self.subTest(command=command):
                result = self.claude_bash(self.claude, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("outside this session's Claude worktree", result.stderr)

    def test_anything_but_literal_words_is_refused_even_while_expansion_warns(self) -> None:
        outside = self.external / "made.txt"
        refused = (
            f"niyam pr-signals 12 > {outside}",
            "niyam pr-signals 12 > .tmp/out.txt",
            "niyam pr-signals 12 2>&1",
            "niyam pr-signals 12 2>/dev/null",
            "niyam pr-signals 12 | tail -5",
            f"niyam pr-signals 12 && touch {outside}",
            "niyam pr-signals 12; niyam pr-signals 13",
            "niyam pr-signals 12\nniyam pr-signals 13",
            "niyam pr-signals 12 &",
            f'niyam review-thread PRRT_x --reply "fixed $(touch {outside})"',
            f"niyam review-thread PRRT_x --reply \"fixed `touch {outside}`\"",
            f"niyam review-thread PRRT_x --reply fixed`touch {outside}`",
            'niyam review-thread PRRT_x --reply "$HOME"',
            'niyam review-thread PRRT_x --reply "a \\" b"',
            "niyam review-thread PRRT_x --reply \\$x",
            "niyam review-thread PRRT_x --reply $'x'",
            "niyam review-thread PRRT_x --reply 'unclosed",
            'niyam review-thread PRRT_x --reply "unclosed',
            "niyam review-thread PRRT_x --body-file ~/r.md",
            "niyam review-thread PRRT_x --body-file .tmp/*.md",
            "niyam review-thread PRRT_x --body-file =ls",
            "niyam brief {a,b}.md",
            "niyam pr-signals #12",
            "niyam pr-signals <(echo 12)",
            "niyam review-thread PRRT_x --body-file",
            "niyam review-thread PRRT_x --body-file ''",
        )
        for mode in ("warn", "refuse"):
            environment = self.reviewed_env(shellExpansion=mode)
            for command in refused:
                with self.subTest(mode=mode, command=command):
                    result = self.claude_bash(self.claude, command, environment)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn("mutation targets could not be resolved", result.stderr)
        self.assertFalse(outside.exists())

    def test_the_program_must_open_the_line_bare(self) -> None:
        environment = self.reviewed_env()
        for command in (
            "GIT_DIR=../.. niyam pr-signals 12",
            "GIT_WORK_TREE=/tmp niyam handoff --record --disposition own-work --reason x",
            "FOO=1 niyam pr-signals 12",
            "env niyam pr-signals 12",
            "command niyam pr-signals 12",
            "./niyam pr-signals 12",
            "node_modules/.bin/niyam pr-signals 12",
            "/usr/local/bin/niyam pr-signals 12",
            "sudo niyam pr-signals 12",
        ):
            with self.subTest(command=command):
                result = self.claude_bash(self.claude, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)

    def test_only_listed_subcommands_run(self) -> None:
        environment = self.reviewed_env()
        for command in (
            "niyam",
            "niyam onboard",
            "niyam onboard owner agent --dry-run",
            "niyam machine",
            "niyam pr-autocreate watch --root ../.. --branch x --sha y",
            "niyam keep-going",
            "niyam keep-going --stopx",
            "niyam handoffs --record",
            "niyam HANDOFF --record",
            "niyam -- handoff --record",
        ):
            with self.subTest(command=command):
                result = self.claude_bash(self.claude, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("niyam is a reviewed CLI here", result.stderr)
                self.assertIn("(handoff, pr-signals, review-thread, cubic-dismiss", result.stderr)

    def test_a_program_the_guard_judges_itself_is_never_reviewed(self) -> None:
        for program, command in (
            ("rm", f"rm -rf {self.external}"),
            ("git", f"git -C {self.external} commit -m x"),
            ("bash", f"bash -c 'touch {self.external}/x'"),
            ("pnpm", f"pnpm exec touch {self.external}/x"),
            ("python3", "python3 x.py"),
            ("env", f"env touch {self.external}/x"),
        ):
            flag = "-rf" if program == "rm" else command.split()[1]
            entry = {**REVIEWED_CLI, "program": program, "subcommands": {flag: {}}}
            environment = self.settings_env({"worktree": {"reviewedCLIs": [entry]}})
            with self.subTest(program=program):
                self.assertTrue(MODULE.judged_here(program))
                result = self.claude_bash(self.claude, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertNotIn("reviewed CLI", result.stderr)


OWN_CHECKOUT = {
    "env": {"AGENT_REMOTE": ["true"]},
    "reason": "a hosted session clones the repository for itself",
    "protectedPaths": [".claude/hooks/", ".claude/guards.json", "node_modules"],
}
NOT_OWNED = "Claude mutations require this session's Claude-managed worktree"


class OwnCheckoutTest(BoundaryFixture):
    """`worktree.ownCheckout`: the plain clone a hosted session was started in
    counts as its own, in the environment the setting names, with its git
    folder still refused."""

    def test_a_program_option_is_read_from_three_characters(self) -> None:
        """git 2.54 runs `git push --e <cmd>`: `--e` abbreviates --exec, the
        receive-pack it starts. The boundary refuses it before this reader
        runs; `runs_program` must not let it through on its own either."""
        from kavach import clone_writers

        for verb, word in (
            ("push", "--e"),
            ("push", "--e=x"),
            ("fetch", "--upl=x"),
            ("ls-remote", "--exec"),
            ("grep", "-iO.tmp/x.sh"),
        ):
            with self.subTest(word=word):
                self.assertTrue(clone_writers.runs_program(verb, word))
        for verb, word in (("push", "--"), ("log", "--reverse"), ("push", "-u"), ("fetch", "--all")):
            with self.subTest(word=word):
                self.assertFalse(clone_writers.runs_program(verb, word))

    def hosted_env(
        self, project: Path | None = None, *, setting: bool = True, **variables: str
    ) -> dict[str, str]:
        """The hook's environment: the setting (unless ``setting`` is false),
        ``CLAUDE_PROJECT_DIR`` naming ``project`` (``self.main`` by default),
        and ``variables``, with AGENT_REMOTE=true unless they say otherwise."""

        worktree: dict[str, object] = {"reviewedCLIs": [REVIEWED_CLI]}
        if setting:
            worktree["ownCheckout"] = OWN_CHECKOUT
        # One file per setting: environments built together must not share one.
        path = self.external / ("kavach.json" if setting else "kavach-without.json")
        path.write_text(json.dumps({"worktree": worktree}), encoding="utf-8")
        environment = hermetic_git_env()
        environment.pop("CLAUDE_PROJECT_DIR", None)
        environment.pop("AGENT_REMOTE", None)
        environment["KAVACH_CONFIG"] = str(path)
        environment["CLAUDE_PROJECT_DIR"] = str(self.main if project is None else project)
        environment["AGENT_REMOTE"] = "true"
        environment.update(variables)
        return environment

    def write(self, cwd: Path, target: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        return self.invoke(
            cwd, tool_input={"file_path": str(target), "content": "x\n"}, env=env
        )

    def test_git_destinations_in_the_owned_clone(self) -> None:
        """In the hosted clone, a write to the global config is unproven, as
        in a desktop worktree, and a read of it runs. The other #179 verbs
        stay refused there by clone_writers, which allows only the git
        subcommands it reads, even into the clone's own folders."""
        environment = self.hosted_env()
        for command, expected in (
            ("git config --global user.name x", "mutation targets could not be resolved"),
            ("git config -f .tmp/x core.x y", "an owned plain clone does not open it"),
            ("git bugreport -o .tmp", "an owned plain clone does not open it"),
            ("git checkout-index -a --prefix=.tmp/co/", "an owned plain clone does not open it"),
            ("git config --global user.name", ""),
            ("git config --global --get user.name", ""),
        ):
            with self.subTest(command=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 2 if expected else 0, result.stderr)
                self.assertIn(expected, result.stderr)

    def test_git_writers_and_runners_in_the_owned_clone(self) -> None:
        """In the hosted clone, a steering assignment before git and a
        runner whose command cannot be placed are unproven, as in a desktop
        worktree. The #182 writers stay refused there by clone_writers,
        even into the clone's own folders, and so do the runners it can
        place, and an inert assignment before git."""
        environment = self.hosted_env()
        for command, expected in (
            ("GIT_DIR=.tmp/g git init", "mutation targets could not be resolved"),
            ("GIT_TRACE=.tmp/t git status", "mutation targets could not be resolved"),
            ("git filter-branch --msg-filter cat HEAD", "mutation targets could not be resolved"),
            ("git submodule foreach true", "mutation targets could not be resolved"),
            ("git merge-file .tmp/cur base other", "an owned plain clone does not open it"),
            ("git read-tree --index-output=.tmp/idx HEAD", "an owned plain clone does not open it"),
            ("git pack-objects --revs .tmp/p", "an owned plain clone does not open it"),
            ("git rebase -x 'touch .tmp/x' HEAD~1", "an owned plain clone does not open it"),
            ("GIT_EDITOR=true git commit --amend", "an owned plain clone does not open it"),
            ("git fast-export HEAD", "an owned plain clone does not open it"),
        ):
            with self.subTest(command=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(expected, result.stderr)

    def test_a_push_in_the_owned_clone(self) -> None:
        """In the hosted clone, a push to the clone itself writes only its
        git folder, as a commit does, so the fence on it does not refuse
        one; a push into another local repository is unproven, as in a
        desktop worktree (#200)."""
        environment = self.hosted_env()
        git(self.main, "remote", "add", "origin", "https://example.invalid/veda.git")
        for command, expected in (
            ("git push origin HEAD:x", ""),
            ("git push . HEAD:refs/heads/x", ""),
            (f"git push {self.main} HEAD:x", ""),
            ("git push .git HEAD:x", ""),
            (f"git push {self.external}/repo HEAD:x", "mutation targets could not be resolved"),
            ("git push .tmp/repo HEAD:x", "mutation targets could not be resolved"),
            (f"git send-pack {self.external}/repo main", "mutation targets could not be resolved"),
        ):
            with self.subTest(command=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 2 if expected else 0, result.stderr)
                self.assertIn(expected, result.stderr)

    def test_the_clone_is_owned_in_the_named_environment(self) -> None:
        environment = self.hosted_env()
        (self.main / "sub").mkdir()
        for label, result in (
            ("write a tracked file", self.write(self.main, self.main / "tracked.txt", environment)),
            ("write a new file", self.write(self.main, self.main / "docs" / "new.md", environment)),
            ("write from a subfolder", self.write(self.main / "sub", self.main / "sub" / "a.txt", environment)),
            ("touch", self.claude_bash(self.main, "touch new.txt", environment)),
            ("git add", self.claude_bash(self.main, "git add tracked.txt", environment)),
            ("git commit", self.claude_bash(self.main, "git commit -q -m x", environment)),
            ("reviewed CLI", self.claude_bash(self.main, "niyam pr-signals 12", environment)),
        ):
            with self.subTest(label):
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_trusted_script_runs_after_the_gate(self) -> None:
        script = self.main / WORKTREE_SCRIPT
        script.parent.mkdir()
        script.write_text("", encoding="utf-8")
        path = self.external / "trusted.json"
        path.write_text(
            json.dumps({"worktree": {**WORKTREE_SETTINGS["worktree"], "ownCheckout": OWN_CHECKOUT}}),
            encoding="utf-8",
        )
        command = "python3 scripts/worktree.py status"
        environment = {**self.hosted_env(), "KAVACH_CONFIG": str(path)}
        result = self.claude_bash(self.main, command, environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.claude_bash(self.main, command, {**environment, "AGENT_REMOTE": "false"})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(NOT_OWNED, result.stderr)

    def test_its_git_folder_stays_refused(self) -> None:
        environment = self.hosted_env()
        git_dir = self.main / ".git"
        (self.main / "hooks-link").symlink_to(git_dir / "hooks")
        if (self.main / ".GIT").exists():
            # A case-insensitive filesystem: another spelling is the same folder.
            result = self.write(self.main, self.main / ".GIT" / "hooks" / "pre-commit", environment)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("git folder", result.stderr)
        for label, result in (
            ("write a hook", self.write(self.main, git_dir / "hooks" / "pre-commit", environment)),
            ("write config", self.write(self.main, git_dir / "config", environment)),
            ("touch a hook", self.claude_bash(self.main, "touch .git/hooks/pre-commit", environment)),
            ("through a symlink", self.write(self.main, self.main / "hooks-link" / "pre-commit", environment)),
            ("reviewed CLI path", self.claude_bash(self.main, "niyam brief .git/hooks/pre-commit", environment)),
        ):
            with self.subTest(label):
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("git folder", result.stderr)
        # From inside the git folder, git finds no work tree, so nothing runs.
        result = self.write(git_dir, git_dir / "config", environment)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("cannot determine this session's repository checkout", result.stderr)

    def test_the_guards_files_stay_refused(self) -> None:
        """The consumer's protected paths, existing or not, under any case
        spelling or link; the guard's settings file when it sits inside."""

        hooks = self.main / ".claude" / "hooks"
        hooks.mkdir(parents=True)
        (hooks / "guard.sh").write_text("", encoding="utf-8")
        (self.main / "node_modules" / "pkg").mkdir(parents=True)
        (self.main / "hooks-link").symlink_to(hooks)
        environment = self.hosted_env()
        settings_inside = self.main / ".claude" / "settings-in-clone.json"
        settings_inside.write_text(Path(environment["KAVACH_CONFIG"]).read_text(encoding="utf-8"), encoding="utf-8")
        inside = {**environment, "KAVACH_CONFIG": str(settings_inside)}
        cases = [
            ("a hook script", self.main / ".claude" / "hooks" / "guard.sh", environment),
            ("a new hook script", self.main / ".claude" / "hooks" / "new.sh", environment),
            ("a missing protected file", self.main / ".claude" / "guards.json", environment),
            ("an installed package", self.main / "node_modules" / "pkg" / "index.js", environment),
            ("through a link", self.main / "hooks-link" / "guard.sh", environment),
            ("the settings file inside", settings_inside, inside),
        ]
        if (self.main / ".CLAUDE").exists():
            # A case-insensitive filesystem: other spellings are the same paths.
            cases += [
                ("hooks in capitals", self.main / ".CLAUDE" / "HOOKS" / "guard.sh", environment),
                ("a missing file in capitals", self.main / ".Claude" / "Guards.JSON", environment),
            ]
        for label, target, env in cases:
            with self.subTest(label):
                result = self.write(self.main, target, env)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("an owned plain clone does not open it", result.stderr)
        with self.subTest("touch a hook script"):
            result = self.claude_bash(self.main, "touch .claude/hooks/guard.sh", environment)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("protectedPaths", result.stderr)
        for command in (
            "cp tracked.txt .claude/hooks/guard.sh",
            # A target that holds a fence removes or moves it whole.
            "rm -rf .claude",
            "mv .claude .claude-off",
            "rm -rf node_modules",
            "rm -rf .CLAUDE",
        ):
            with self.subTest(command=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("an owned plain clone does not open it", result.stderr)
        # The gap #136 closed: a command whose writes count as the whole
        # checkout is judged by what it can write (`clone_writers`).
        for command in (
            "git checkout HEAD -- .claude/hooks/guard.sh",
            "git restore .claude/hooks/guard.sh",
            "git apply .tmp/x.patch",
            "pnpm install",
        ):
            with self.subTest(gap=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("an owned plain clone does not open it", result.stderr)
        # Next to them, the rest of `.claude` stays writable.
        result = self.write(self.main, self.main / ".claude" / "guards.json.bak", environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.write(self.main, self.main / ".claude" / "notes.md", environment)
        self.assertEqual(result.returncode, 0, result.stderr)

    def writers_fixture(self) -> dict[str, str]:
        """A committed hook script; branch `evil`, where it differs, and
        `safe`, where only `tracked.txt` does; patches touching each under
        `.tmp/`. Returns the hosted environment."""

        hooks = self.main / ".claude" / "hooks"
        hooks.mkdir(parents=True)
        (hooks / "guard.sh").write_text("guard\n", encoding="utf-8")
        git(self.main, "add", ".claude/hooks/guard.sh")
        git(self.main, "commit", "-qm", "hooks")
        git(self.main, "checkout", "-qb", "evil")
        (hooks / "guard.sh").write_text("exit 0\n", encoding="utf-8")
        git(self.main, "commit", "-qam", "evil")
        git(self.main, "checkout", "-q", "main")
        git(self.main, "checkout", "-qb", "safe")
        (self.main / "tracked.txt").write_text("safe\n", encoding="utf-8")
        git(self.main, "commit", "-qam", "safe")
        git(self.main, "checkout", "-q", "main")
        (self.main / "sub").mkdir()
        scratch = self.main / ".tmp"
        scratch.mkdir()
        (scratch / "hooks.patch").write_text(
            "--- a/.claude/hooks/guard.sh\n+++ b/.claude/hooks/guard.sh\n"
            "@@ -1 +1 @@\n-guard\n+exit 0\n",
            encoding="utf-8",
        )
        (scratch / "plain.patch").write_text(
            "--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-base\n+patched\n",
            encoding="utf-8",
        )
        (scratch / "new.patch").write_text(
            "--- /dev/null\n+++ b/guard.sh\n@@ -0,0 +1 @@\n+exit 0\n",
            encoding="utf-8",
        )
        return self.hosted_env()

    def test_git_writers_stop_at_the_fences(self) -> None:
        environment = self.writers_fixture()
        refused = (
            "git checkout HEAD -- .claude/hooks/guard.sh",
            "git checkout evil -- .claude",
            "git checkout -- .",
            "git checkout -p",
            "git restore .claude/hooks/guard.sh",
            "git restore --source=evil -- .claude",
            "git restore -SW .claude/hooks/guard.sh",
            "git restore -p",
            "git restore --pathspec-from-file=.tmp/list",
            "git restore ':(glob).claude/**'",
            "git rm -r .claude",
            "git rm -rf .claude/hooks",
            "git mv .claude/hooks hooks-off",
            "git mv tracked.txt .claude/hooks/guard.sh",
            "git checkout evil",
            "git switch evil",
            "git checkout -b fresh evil",
            "git switch -c fresh evil",
            "git switch --orphan fresh",
            "git switch nowhere",
            "git apply .tmp/hooks.patch",
            "git apply -p1 .tmp/hooks.patch",
            "git apply --directory=.claude/hooks .tmp/new.patch",
            "git apply --index .tmp/plain.patch .tmp/hooks.patch",
            "git apply --apply --stat .tmp/hooks.patch",
            "git apply",
            "git merge evil",
            "git pull",
            "git rebase evil",
            "git cherry-pick evil",
            "git revert HEAD",
            "git am .tmp/x.mbox",
            "git stash",
            "git stash pop",
            "git reset --hard evil",
            "git reset --har evil",
            "git reset --keep evil",
            "git clean -fdx",
            "git sparse-checkout set docs",
            "git read-tree -u -m evil",
            "git read-tree -mu evil",
            "git checkout-index -a -f",
            "git submodule update",
            "git bisect start",
            "git clone . .tmp/copy",
            "git config user.name x",
            "git diff-files --output=.claude/hooks/guard.sh",
        )
        for command in refused:
            with self.subTest(command=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("an owned plain clone does not open it", result.stderr)
        # An abbreviated --output, a verb git does not list (an alias), a
        # config key that runs a program and an option that does are
        # unproven in any checkout, before the owned clone's fences are read.
        for command in (
            "git whatchanged --outpu=.claude/hooks/guard.sh",
            "git co evil",
            "git config core.fsmonitor .tmp/x.sh",
            "git config --add core.hooksPath .tmp",
            "git fetch --upload-pack=.tmp/x.sh .",
            "git fetch --upload-p=.tmp/x.sh .",
            "git push --receive-pack=.tmp/x.sh .",
            "git push --e .tmp/x.sh .",
            "git grep -O.tmp/x.sh guard",
            "git grep -iO.tmp/x.sh guard",
            "git apply --unsafe-paths .tmp/plain.patch",
            "git --exec-path=.tmp commit -qm x",
        ):
            with self.subTest(command=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("mutation targets could not be resolved", result.stderr)
        # From a subfolder, and through `-C`: the paths, not the folder, count.
        for cwd, command in (
            (self.main / "sub", "git checkout HEAD -- ../.claude/hooks/guard.sh"),
            (self.main / "sub", "git -C .. restore .claude"),
            (self.main / "sub", "git restore .."),
        ):
            with self.subTest(cwd=cwd.name, command=command):
                result = self.claude_bash(cwd, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("an owned plain clone does not open it", result.stderr)

    def test_a_state_checked_writer_runs_alone(self) -> None:
        """A switch or `apply` is judged by the checkout as it is now, so an
        earlier command on its line could change what it reads."""

        environment = self.writers_fixture()
        for command in (
            "git branch -f safe evil && git switch safe",
            "cp .tmp/hooks.patch .tmp/plain.patch && git apply .tmp/plain.patch",
            "git switch safe; git status",
            "pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile && pnpm check",
            "sh -c 'git branch -f safe evil; git switch safe'",
        ):
            with self.subTest(command=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("command of its own", result.stderr)

    def test_git_through_another_program_is_refused(self) -> None:
        environment = self.writers_fixture()
        for command in (
            "xargs git checkout HEAD --",
            "find . -name guard.sh -exec git checkout HEAD -- {} +",
            "pnpm exec git checkout HEAD -- .claude",
            "mise exec -- git restore .claude",
            "timeout 5 git restore .claude/hooks/guard.sh",
            "env git restore .claude/hooks/guard.sh",
            "command git restore .claude/hooks/guard.sh",
            "sh -c 'git restore .claude/hooks/guard.sh'",
            "bash -c 'git checkout evil -- .claude'",
            "pnpm exec npm install",
            "timeout 60 pnpm install",
        ):
            with self.subTest(command=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
        # The runner itself is one kavach knows; git under it is unproven in
        # any checkout (#198), before the owned clone's check reads it.
        for command in ("pnpm exec git checkout HEAD -- .claude", "mise exec -- git restore .claude"):
            with self.subTest(reason=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertIn("with `git` on its line, which the guard reads only", result.stderr)

    def test_a_name_both_a_tag_and_a_branch_is_judged_both_ways(self) -> None:
        """`git checkout twin` takes branch `twin` where `rev-parse twin`
        names tag `twin`: both commits are compared."""

        environment = self.writers_fixture()
        git(self.main, "tag", "twin", "safe")
        git(self.main, "branch", "twin", "evil")
        for command in ("git checkout twin", "git switch twin", "git checkout -b fresh twin"):
            with self.subTest(command=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(".claude/hooks/guard.sh", result.stderr)

    def test_git_config_from_the_environment_is_refused(self) -> None:
        """A line that exports git's config injectors before git runs."""

        environment = self.writers_fixture()
        command = (
            "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor "
            "GIT_CONFIG_VALUE_0=.tmp/x.sh; git add ."
        )
        result = self.claude_bash(self.main, command, environment)
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_git_that_misses_the_fences_runs(self) -> None:
        environment = self.writers_fixture()
        (self.main / ".claude" / "hooks" / "guard.sh").write_text("guard\n", encoding="utf-8")
        # A push is placed through its remote's URL.
        git(self.main, "remote", "add", "origin", "https://example.invalid/veda.git")
        for command in (
            "git add .",
            "git commit -qm x",
            "git push",
            "git fetch",
            "git branch fresh",
            "git tag v1",
            "git checkout HEAD -- tracked.txt",
            "git checkout -- tracked.txt sub",
            "git checkout evil -- tracked.txt",
            "git checkout -b fresh",
            "git checkout -b fresh safe",
            "git checkout safe",
            "git switch safe",
            "git switch -c fresh",
            "git switch -c fresh safe",
            "git switch --detach safe",
            "git restore tracked.txt",
            "git restore --source=evil tracked.txt",
            "git restore --staged .claude/hooks/guard.sh",
            "git rm tracked.txt",
            "git rm --cached .claude/hooks/guard.sh",
            "git rm -rf sub",
            "git mv tracked.txt moved.txt",
            "git apply .tmp/plain.patch",
            "git apply --check .tmp/hooks.patch",
            "git apply --stat .tmp/hooks.patch",
            "git apply --cached .tmp/hooks.patch",
            "git apply --directory=sub .tmp/new.patch",
            "git reset --soft HEAD~1",
            "git reset HEAD tracked.txt",
            "git reset -q",
            "git read-tree -m HEAD",
            "git config user.name",
            "git config --get user.name",
            "git config get user.name",
            "git config --list",
            "git update-index --refresh",
            "git -C sub status",
            "git --no-pager commit -qm x",
        ):
            with self.subTest(command=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 0, result.stderr)
        with self.subTest("from a subfolder"):
            result = self.claude_bash(self.main / "sub", "git checkout HEAD -- ../tracked.txt", environment)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_forced_checkout_is_judged_against_head(self) -> None:
        environment = self.writers_fixture()
        for command in ("git checkout -f", "git switch -f -c fresh", "git checkout safe"):
            with self.subTest(clean=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 0, result.stderr)
        # A hook script that differs from HEAD: forcing HEAD back over it, or
        # switching while it differs, would write it.
        (self.main / ".claude" / "hooks" / "guard.sh").write_text("changed\n", encoding="utf-8")
        for command in ("git checkout -f", "git switch -f -c fresh", "git checkout safe"):
            with self.subTest(changed=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(".claude/hooks/guard.sh", result.stderr)

    def test_only_a_frozen_install_runs(self) -> None:
        environment = self.writers_fixture()
        for command in (
            "pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile",
            "pnpm i --ignore-pnpmfile --frozen-lockfile --ignore-scripts --prefer-offline",
            "pnpm check",
            "pnpm -r check",
            "pnpm --filter pkg test",
            "pnpm run build",
            "npm --version",
        ):
            with self.subTest(runs=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 0, result.stderr)
        for command in (
            "pnpm install",
            "pnpm i",
            "pnpm install --frozen-lockfile",
            "pnpm install --frozen-lockfile --ignore-scripts",
            "pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --no-frozen-lockfile",
            "pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --modules-dir=.claude/hooks",
            "pnpm -C sub install --frozen-lockfile --ignore-scripts --ignore-pnpmfile",
            "pnpm --config.x=y install --frozen-lockfile --ignore-scripts --ignore-pnpmfile",
            "pnpm add left-pad",
            "pnpm update",
            "pnpm remove left-pad",
            "pnpm rebuild",
            "pnpm -r install",
            "npm install",
            "npm ci",
            "npm i left-pad",
            "yarn",
            "yarn add left-pad",
            "npx left-pad",
        ):
            with self.subTest(refused=command):
                result = self.claude_bash(self.main, command, environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("an owned plain clone does not open it", result.stderr)

    def test_a_worktree_session_is_judged_as_before(self) -> None:
        """Outside an owned clone nothing here applies: a Claude-managed
        worktree's own files are its own to rewrite."""

        environment = hermetic_git_env()
        for command in (
            "git checkout HEAD -- .claude",
            "git merge main",
            "git stash",
            "pnpm install",
        ):
            with self.subTest(command=command):
                result = self.claude_bash(self.claude, command, environment)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_numstat_records_and_program_options(self) -> None:
        writers = ADAPTER.clone_writers
        self.assertEqual(
            writers.numstat_paths("1\t1\ta.txt\0" "0\t0\t\0old.txt\0new dir/b.txt\0-\t-\tbin\0"),
            ["a.txt", "old.txt", "new dir/b.txt", "bin"],
        )
        with self.assertRaises(writers.Refused):
            writers.numstat_paths("garbage\0")
        for sub, word, runs in (
            ("fetch", "--upload-pack=x", True),
            ("fetch", "--upload-p=x", True),
            ("push", "--rec=x", True),
            ("push", "--exec=x", True),
            ("grep", "-O", True),
            ("grep", "-nOx", True),
            ("log", "-SOther", False),
            ("fetch", "--all", False),
            ("ls-files", "--exclude=x", False),
        ):
            with self.subTest(sub=sub, word=word):
                self.assertEqual(writers.runs_program(sub, word), runs)

    def test_the_fences_name_the_guards_own_places(self) -> None:
        own = mock.Mock(protected_paths=(".claude/hooks/",))
        settings_file = self.main / ".claude" / "kavach.json"
        fences = ADAPTER.clone_fences(self.main, own, {"KAVACH_CONFIG": str(settings_file)})
        places = [place for place, _what in fences]
        self.assertEqual(
            places,
            [
                (self.main / ".git").resolve(),
                settings_file,
                ADAPTER.HERE.parents[1],
                self.main / ".claude/hooks/",
            ],
        )
        self.assertEqual(ADAPTER.HERE.parents[1].name, "kavach")
        self.assertTrue((ADAPTER.HERE.parents[1] / "package.json").is_file())
        without = ADAPTER.clone_fences(self.main, own, {})
        self.assertNotIn(settings_file, [place for place, _what in without])

    def test_the_fences_compare_by_identity(self) -> None:
        """`in_fence` directly: a path below a fence, the fence itself, a
        sibling, and a fence whose own folder does not exist yet."""

        fence = self.main / ".claude" / "hooks"
        fence.mkdir(parents=True)
        self.assertTrue(ADAPTER.in_fence(fence, fence))
        self.assertTrue(ADAPTER.in_fence(fence / "a" / "b.sh", fence))
        self.assertFalse(ADAPTER.in_fence(self.main / ".claude" / "hooks2", fence))
        self.assertFalse(ADAPTER.in_fence(self.main / "tracked.txt", fence))
        missing = self.main / "missing" / "deeper"
        self.assertTrue(ADAPTER.in_fence(missing / "x", missing))
        self.assertFalse(ADAPTER.in_fence(self.main / "missing" / "other", missing))
        self.assertFalse(ADAPTER.in_fence(self.external / "missing" / "deeper", missing))

    def test_targets_outside_the_clone_stay_refused(self) -> None:
        environment = self.hosted_env()
        for label, result in (
            ("write outside", self.write(self.main, self.external / "x.txt", environment)),
            ("write a worktree", self.write(self.main, self.manual / "tracked.txt", environment)),
            ("touch outside", self.claude_bash(self.main, f"touch {self.external / 'x.txt'}", environment)),
        ):
            with self.subTest(label):
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("is outside this session's Claude worktree", result.stderr)

    def test_without_the_setting_or_its_environment_the_clone_is_refused(self) -> None:
        cases = (
            ("no setting", self.hosted_env(setting=False)),
            ("remote false", self.hosted_env(AGENT_REMOTE="false")),
            ("remote upper case", self.hosted_env(AGENT_REMOTE="TRUE")),
            ("remote empty", self.hosted_env(AGENT_REMOTE="")),
        )
        unset = self.hosted_env()
        unset.pop("AGENT_REMOTE")
        for label, environment in (*cases, ("remote unset", unset)):
            with self.subTest(label):
                result = self.write(self.main, self.main / "tracked.txt", environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(NOT_OWNED, result.stderr)

    def test_only_the_clone_the_session_started_in(self) -> None:
        other = self.external / "other"
        self.make_repository(other)
        unset = self.hosted_env()
        unset.pop("CLAUDE_PROJECT_DIR")
        for label, cwd, environment in (
            ("project unset", self.main, unset),
            ("project empty", self.main, {**unset, "CLAUDE_PROJECT_DIR": ""}),
            ("project missing", self.main, self.hosted_env(self.external / "missing")),
            ("project is another folder", self.main, self.hosted_env(self.external)),
            ("project is a subfolder", self.main, self.hosted_env(self.main / ".claude")),
            ("another clone", other, self.hosted_env()),
        ):
            with self.subTest(label):
                result = self.write(cwd, cwd / "tracked.txt", environment)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(NOT_OWNED, result.stderr)
        # The same other clone, named as the project, is owned.
        result = self.write(other, other / "tracked.txt", self.hosted_env(other))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_linked_worktrees_are_judged_as_before(self) -> None:
        # An unmanaged worktree gains nothing from the setting, even named as
        # the project; a Claude-managed one is still owned, git folder rule aside.
        result = self.write(
            self.manual, self.manual / "tracked.txt", self.hosted_env(self.manual)
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(NOT_OWNED, result.stderr)
        result = self.write(self.claude, self.claude / "tracked.txt", self.hosted_env())
        self.assertEqual(result.returncode, 0, result.stderr)


PROTECTED_REASON = "the repository's git hooks run them on commit and push; the owner changes them"
PROTECTED_SETTINGS = {
    "worktree": {
        "protectedPaths": [".githooks/", "scripts/pins.mjs", "node_modules/.bin/"],
        "protectedPathsReason": PROTECTED_REASON,
    }
}
PROTECTED = "a path worktree.protectedPaths keeps from agent sessions"
WORKTREE_WAY_OUT = "this session's own worktree does not open it"


class ProtectedPathsTest(BoundaryFixture):
    """`worktree.protectedPaths`: the files a repository's own git hooks run
    stay refused inside a session's own worktree (veda#235), which holds its
    own copy of them."""

    settings_env = AdapterTest.settings_env

    def setUp(self) -> None:
        super().setUp()
        hooks = self.claude / ".githooks"
        hooks.mkdir()
        (hooks / "pre-push").write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        (self.claude / "scripts").mkdir()
        (self.claude / "scripts" / "pins.mjs").write_text("// pins\n", encoding="utf-8")
        (self.claude / "scripts" / "other.mjs").write_text("// other\n", encoding="utf-8")
        git(self.claude, "add", ".githooks/pre-push", "scripts")
        git(self.claude, "commit", "-qm", "hooks")
        (self.claude / "node_modules" / ".bin").mkdir(parents=True)
        (self.claude / "node_modules" / "pkg").mkdir()
        self.env = self.settings_env(PROTECTED_SETTINGS)

    def refused(self, result: subprocess.CompletedProcess[str], *expected: str) -> None:
        self.assertEqual(result.returncode, 2, result.stderr)
        for text in expected or (PROTECTED, WORKTREE_WAY_OUT):
            self.assertIn(text, result.stderr)

    def bash(self, command: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
        return self.claude_bash(self.claude if cwd is None else cwd, command, self.env)

    def test_an_edit_of_the_hook_is_refused(self) -> None:
        hook = self.claude / ".githooks" / "pre-push"
        result = self.invoke(
            self.claude,
            tool_name="Edit",
            tool_input={"file_path": str(hook), "old_string": "exit 1", "new_string": "exit 0"},
            env=self.env,
        )
        self.refused(result, PROTECTED, "(.githooks/)", PROTECTED_REASON, WORKTREE_WAY_OUT)
        self.assertNotIn("owned plain clone", result.stderr)

    def test_a_write_of_the_hook_is_refused(self) -> None:
        for label, target in (
            ("the hook", self.claude / ".githooks" / "pre-push"),
            ("a new hook", self.claude / ".githooks" / "pre-commit"),
            ("a protected script", self.claude / "scripts" / "pins.mjs"),
            ("an installed bin", self.claude / "node_modules" / ".bin" / "dvara"),
            ("a relative spelling", self.claude / "scripts" / ".." / ".githooks" / "pre-push"),
        ):
            with self.subTest(label):
                result = self.invoke(
                    self.claude, tool_input={"file_path": str(target), "content": "exit 0\n"}, env=self.env
                )
                self.refused(result)
        result = self.invoke(
            self.claude,
            tool_name="NotebookEdit",
            tool_input={"notebook_path": str(self.claude / ".githooks" / "x.ipynb"), "new_source": "x"},
            env=self.env,
        )
        self.refused(result)

    def test_a_bash_write_of_the_hook_is_refused(self) -> None:
        # A redirection into a file is refused wherever it points.
        for command in ("printf 'exit 0\\n' > .githooks/pre-push", "echo 'exit 0' >> .githooks/pre-push"):
            with self.subTest(command=command):
                self.refused(self.bash(command), "output redirection")
        for command in (
            "sed -i '' 's/exit 1/exit 0/' .githooks/pre-push",
            "cp tracked.txt .githooks/pre-push",
            "touch .githooks/pre-commit",
            "chmod -x .githooks/pre-push",
            "rm .githooks/pre-push",
            "rm -f scripts/pins.mjs",
            "tee .githooks/pre-push < tracked.txt",
            "ln -sf /bin/true node_modules/.bin/dvara",
            # A target that holds a protected path removes or moves it whole.
            "rm -rf .githooks",
            "mv .githooks .githooks-off",
            "rm -rf node_modules",
            "rm -r scripts",
        ):
            with self.subTest(command=command):
                self.refused(self.bash(command))

    def test_a_case_spelling_or_a_link_reaches_the_same_hook(self) -> None:
        (self.claude / "hooks-link").symlink_to(self.claude / ".githooks")
        self.refused(self.bash("touch hooks-link/pre-push"))
        if (self.claude / ".GITHOOKS").exists():
            # A case-insensitive filesystem: another spelling is the same file.
            self.refused(self.bash("touch .GITHOOKS/pre-push"))
            result = self.invoke(
                self.claude,
                tool_input={"file_path": str(self.claude / ".GitHooks" / "pre-push"), "content": "x"},
                env=self.env,
            )
            self.refused(result)

    def test_git_writes_of_a_named_protected_path_are_refused(self) -> None:
        for command in (
            "git checkout HEAD -- .githooks/pre-push",
            "git checkout -- .githooks",
            "git checkout HEAD~1 -- scripts/pins.mjs",
            "git checkout .githooks/pre-push",
            "git checkout HEAD .githooks/pre-push",
            "git checkout -p",
            "git restore .githooks/pre-push",
            "git restore --source=HEAD~1 -- scripts/pins.mjs",
            "git restore .",
            "git rm .githooks/pre-push",
            "git rm -r .githooks",
            "git mv .githooks/pre-push .githooks/off",
            "git -C .githooks rm pre-push",
        ):
            with self.subTest(command=command):
                self.refused(self.bash(command), WORKTREE_WAY_OUT)

    def test_git_options_before_a_path_writer_are_not_read(self) -> None:
        """An option before git's subcommand that `git_start` does not read
        leaves the line open, unless a path writer follows it."""
        from kavach import clone_writers

        fences = ((self.claude / ".githooks", "a protected path"),)

        def judge(*words: str) -> str | None:
            return clone_writers.judge_named_paths(
                [(words, self.claude, (), True)], self.claude, fences, ADAPTER.in_fence, ADAPTER.boundary, "way out"
            )

        self.assertIsNone(judge("git", "--literal-pathspecs", "log"))
        reason = judge("git", "--literal-pathspecs", "rm", ".githooks/pre-push")
        self.assertIsNotNone(reason)
        self.assertIn("options before `rm`", str(reason))
        self.assertTrue(str(reason).endswith("run `git rm` with none"))
        self.assertIn("way out", str(judge("git", "rm", ".githooks/pre-push")))
        self.assertIsNone(judge("ls", ".githooks"))
        self.assertIsNone(judge("git"))

    def test_a_patch_onto_the_hook_is_refused(self) -> None:
        tmp = self.claude / ".tmp"
        tmp.mkdir()
        (self.claude / ".githooks" / "pre-push").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        patch = git_output(self.claude, "diff") + "\n"
        git(self.claude, "checkout", "--", ".githooks/pre-push")
        (tmp / "x.patch").write_text(patch, encoding="utf-8")
        self.refused(self.bash("git apply .tmp/x.patch"), ".githooks/pre-push", WORKTREE_WAY_OUT)
        self.assertEqual(self.bash("git apply --check .tmp/x.patch").returncode, 0)

    def test_reads_of_the_hook_pass(self) -> None:
        for command in (
            "cat .githooks/pre-push",
            "head -n 1 .githooks/pre-push",
            "grep exit .githooks/pre-push",
            "ls -la .githooks node_modules/.bin",
            "git diff -- .githooks",
            "git log -p -- .githooks/pre-push",
            "git show HEAD:.githooks/pre-push",
            "wc -l scripts/pins.mjs",
        ):
            with self.subTest(command=command):
                result = self.bash(command)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_rest_of_the_worktree_stays_open(self) -> None:
        """Beside the protected paths, writes go on as before, and git's
        merges, branch switches and package installs stay open."""

        for label, target in (
            ("a tracked file", self.claude / "tracked.txt"),
            ("a script beside a protected one", self.claude / "scripts" / "other.mjs"),
            ("a package beside .bin", self.claude / "node_modules" / "pkg" / "index.js"),
            ("a name that only starts like the folder", self.claude / ".githooks-notes.md"),
        ):
            with self.subTest(label):
                result = self.invoke(self.claude, tool_input={"file_path": str(target), "content": "x\n"}, env=self.env)
                self.assertEqual(result.returncode, 0, result.stderr)
        for command in (
            "touch new.txt",
            "rm scripts/other.mjs",
            "git rm tracked.txt",
            "git rm --cached .githooks/pre-push",
            "git restore --staged .githooks/pre-push",
            "git checkout -- tracked.txt",
            "git checkout main",
            "git checkout -b next origin/main",
            "git switch -c next",
            "git merge main",
            "git rebase main",
            "git stash",
            "git reset --hard HEAD",
            "pnpm install",
        ):
            with self.subTest(command=command):
                result = self.bash(command)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_mutation_from_a_folder_holding_one_is_refused(self) -> None:
        """A mutating command counts the folder it runs in among its targets,
        and `scripts/` holds a protected path: run it from the root."""

        self.refused(self.bash("touch other.mjs", cwd=self.claude / "scripts"))
        result = self.bash("touch scripts/new.mjs")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_without_the_setting_the_hook_is_open(self) -> None:
        result = self.invoke(
            self.claude,
            tool_input={"file_path": str(self.claude / ".githooks" / "pre-push"), "content": "x\n"},
            env=self.settings_env({}, "empty.json"),
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_an_owned_clone_keeps_them_too(self) -> None:
        """In a hosted session's own clone, the paths join the clone's own
        fences, and its refusal says so."""

        (self.main / ".githooks").mkdir()
        (self.main / ".githooks" / "pre-push").write_text("exit 1\n", encoding="utf-8")
        environment = self.settings_env(
            {"worktree": {**PROTECTED_SETTINGS["worktree"], "ownCheckout": OWN_CHECKOUT}}, "clone.json"
        )
        environment["CLAUDE_PROJECT_DIR"] = str(self.main)
        environment["AGENT_REMOTE"] = "true"
        result = self.invoke(
            self.main,
            tool_input={"file_path": str(self.main / ".githooks" / "pre-push"), "content": "exit 0\n"},
            env=environment,
        )
        self.refused(result, PROTECTED, PROTECTED_REASON, "an owned plain clone does not open it")
        result = self.claude_bash(self.main, "git restore .githooks/pre-push", environment)
        self.refused(result, "an owned plain clone does not open it")
        result = self.invoke(
            self.main, tool_input={"file_path": str(self.main / "tracked.txt"), "content": "x\n"}, env=environment
        )
        self.assertEqual(result.returncode, 0, result.stderr)


class ReviewedCLIWordsTest(unittest.TestCase):
    """`reviewed_cli_words` and `reviewed_cli_paths` need no settings module."""

    def test_words_are_what_the_shell_passes(self) -> None:
        for command, words in (
            ("niyam a", ["niyam", "a"]),
            ('niyam --reply "a b" c', ["niyam", "--reply", "a b", "c"]),
            ("niyam --reply='a b'c\"d\"", ["niyam", "--reply=a bcd"]),
            ("niyam '' \"\"", ["niyam", "", ""]),
            ("niyam a=b", ["niyam", "a=b"]),
            ("niyam '=ls' \"=x\"", ["niyam", "=ls", "=x"]),
            ("", []),
            (" \t", []),
        ):
            with self.subTest(command=command):
                self.assertEqual(MODULE.reviewed_cli_words(command), words)
        for command in ("niyam =ls", "niyam a\\ b", "niyam a~", "niyam (a)", "niyam a|b", "niyam !x"):
            with self.subTest(command=command):
                self.assertIsNone(MODULE.reviewed_cli_words(command))

    def test_paths_resolve_against_the_root_and_need_their_entries(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        sub = mock.Mock(words=("brief",), path_options=("--body-file", "-f"), path_operands=True)
        entry = mock.Mock(program="niyam", subcommands=(sub,))
        self.assertEqual(MODULE.reviewed_cli_paths("niyam brief a", root, root, ()), None)
        self.assertEqual(MODULE.reviewed_cli_paths("niyam brief a", root / "x", root, (entry,)), None)
        self.assertEqual(MODULE.reviewed_cli_paths("", root, root, (entry,)), None)
        self.assertEqual(MODULE.reviewed_cli_paths("niyam other a", root, root, (entry,)), None)
        self.assertEqual(
            MODULE.reviewed_cli_paths("niyam brief a -f b -fc --body-file=d --x e -- -g", root, root, (entry,)),
            [root / name for name in ("a", "b", "c", "d", "--x", "e", "-g")],
        )
        # Without operand paths, only the declared options' values are paths.
        options_only = mock.Mock(words=("reply",), path_options=("--body-file",), path_operands=False)
        other = mock.Mock(program="niyam", subcommands=(options_only,))
        self.assertEqual(
            MODULE.reviewed_cli_paths("niyam reply a -x/../b --body-file c -- d", root, root, (other,)),
            [root / "c"],
        )
        self.assertEqual(MODULE.reviewed_cli_paths("niyam brief /x", root, root, (entry,)), [Path("/x").resolve()])
        self.assertIsNone(MODULE.reviewed_cli_paths("niyam brief -f", root, root, (entry,)))
        self.assertIsNone(MODULE.reviewed_cli_paths("niyam brief --body-file=", root, root, (entry,)))
        self.assertIs(MODULE.reviewed_cli_named("  niyam x", (entry,)), entry)
        self.assertIsNone(MODULE.reviewed_cli_named("", (entry,)))
        self.assertIsNone(MODULE.reviewed_cli_named("niyamx", (entry,)))


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


SESSION = "11111111-2222-4333-8444-555555555555"
OTHER_SESSION = "66666666-7777-4888-8999-aaaaaaaaaaaa"
HOST = "local_0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e"
STARTER = "local_5f5f5f5f-6a6a-4b7b-8c8c-9d9d9d9d9d9d"
STRANGER = "local_e0e0e0e0-f1f1-4a2a-8b3b-c4c4c4c4c4c4"


class SessionFoldersTest(GuardFixture):
    """A session's scratchpad and its granted notes folders (veda#68).

    Claude Code gives each session a scratchpad under its own temp folder, and
    the desktop app grants a side session its starter's notes folder. Both are
    writable for the session that owns them and for no other, and nothing
    else under the temp folder or the app's support folder opens with them.
    """

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        temp = Path(self.temporary.name).resolve()
        self.main = temp / "main"
        self.claude = self.main / ".claude" / "worktrees" / "claude-task"
        self.make_repository(self.main)
        self.claude.parent.mkdir(parents=True)
        git(self.main, "worktree", "add", "-qb", "claude-task", str(self.claude))
        self.home = temp / "home"
        self.tmp = temp / "tmp"
        self.temp_root = self.tmp / f"claude-{os.getuid()}"
        self.project = self.temp_root / "-Users-x-code-acme--claude-worktrees-task"
        self.scratchpad = self.project / SESSION / "scratchpad"
        self.others = self.project / OTHER_SESSION / "scratchpad"
        for folder in (self.scratchpad, self.others):
            folder.mkdir(parents=True)
        self.app = self.home / "Library" / "Application Support" / "Claude"
        self.notes = self.app / "side-session-notes"
        for name in (HOST, STARTER, STRANGER):
            (self.notes / name).mkdir(parents=True)
        self.records = self.app / "claude-code-sessions" / "account" / "org"
        self.records.mkdir(parents=True)
        self.write_record()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_record(
        self, cli: str = SESSION, host: str = HOST, granted: tuple[str, ...] | None = None
    ) -> None:
        directories = (
            [str(self.notes / STARTER)] if granted is None else list(granted)
        )
        record = {
            "sessionId": host,
            "cliSessionId": cli,
            "spawnedFrom": {"sessionId": STARTER},
            "sessionPermissionUpdates": [
                {"type": "addRules", "rules": []},
                {"type": "addDirectories", "directories": directories, "destination": "session"},
            ],
        }
        (self.records / f"{host}.json").write_text(json.dumps(record), encoding="utf-8")

    def environment(self, **changes: str | None) -> dict[str, str]:
        environment = hermetic_git_env()
        environment.update(
            {
                "HOME": str(self.home),
                "CLAUDE_CONFIG_DIR": str(self.home / ".claude"),
                "CLAUDE_CODE_TMPDIR": str(self.tmp),
                "CLAUDE_CODE_HOST_SESSION_ID": HOST,
            }
        )
        for name, value in changes.items():
            if value is None:
                environment.pop(name, None)
            else:
                environment[name] = value
        return environment

    def adapter(
        self,
        tool_input: dict[str, str],
        tool_name: str = "Write",
        session: str | None = SESSION,
        cwd: Path | None = None,
        **changes: str | None,
    ) -> subprocess.CompletedProcess[str]:
        payload: dict[str, object] = {
            "cwd": str(cwd or self.claude),
            "tool_name": tool_name,
            "tool_input": tool_input,
        }
        if session is not None:
            payload["session_id"] = session
        return subprocess.run(
            [sys.executable, str(ADAPTER_PATH)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            check=False,
            env=self.environment(**changes),
        )

    def assert_allowed(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(result.returncode, 0, result.stderr)

    def assert_refused(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_this_sessions_folders_are_writable(self) -> None:
        for target in (
            self.scratchpad / "a.txt",
            self.scratchpad / "deep" / "er" / "b.md",
            self.notes / STARTER / "handover.md",
            self.notes / HOST / "for-my-children.md",
        ):
            for tool in ("Write", "Edit"):
                with self.subTest(target=target, tool=tool):
                    self.assert_allowed(self.adapter({"file_path": str(target)}, tool))
        shell = self.adapter(
            {"command": f"touch {shlex.quote(str(self.scratchpad / 'c.txt'))}"}, "Bash"
        )
        self.assert_allowed(shell)
        notes = self.adapter(
            {"command": f"mkdir -p {shlex.quote(str(self.notes / STARTER / 'logs'))}"}, "Bash"
        )
        self.assert_allowed(notes)

    def test_another_sessions_folders_are_refused(self) -> None:
        for target in (
            self.others / "a.txt",
            self.notes / STRANGER / "a.md",
        ):
            with self.subTest(target=target):
                self.assert_refused(self.adapter({"file_path": str(target)}))
        # The other session's own payload is what opens its scratchpad.
        self.assert_allowed(
            self.adapter({"file_path": str(self.others / "a.txt")}, session=OTHER_SESSION)
        )

    def test_the_rest_of_the_temp_and_app_folders_stays_refused(self) -> None:
        for target in (
            self.temp_root / "a.txt",
            self.project / "a.txt",
            self.project / SESSION / "a.txt",
            self.project / SESSION / "tasks" / "a.output",
            self.tmp / "a.txt",
            self.notes / "a.md",
            self.notes / "local_not-a-uuid" / "a.md",
            self.app / "config.json",
            self.records / f"{HOST}.json",
        ):
            with self.subTest(target=target):
                self.assert_refused(self.adapter({"file_path": str(target)}))

    def test_dot_dot_and_symlink_escapes_are_refused(self) -> None:
        self.assert_refused(
            self.adapter({"file_path": str(self.scratchpad / ".." / ".." / OTHER_SESSION / "scratchpad" / "a")})
        )
        self.assert_refused(
            self.adapter({"file_path": str(self.notes / STARTER / ".." / STRANGER / "a.md")})
        )
        self.assert_refused(
            self.adapter({"file_path": str(self.scratchpad / ".." / "a.txt")})
        )
        # A symlink inside an allowed folder that leads out of it.
        (self.scratchpad / "out").symlink_to(self.main, target_is_directory=True)
        self.assert_refused(self.adapter({"file_path": str(self.scratchpad / "out" / "x.txt")}))
        (self.notes / STARTER / "peer").symlink_to(self.notes / STRANGER, target_is_directory=True)
        self.assert_refused(self.adapter({"file_path": str(self.notes / STARTER / "peer" / "x.md")}))
        shell = self.adapter(
            {"command": f"touch {shlex.quote(str(self.scratchpad / 'out' / 'y.txt'))}"}, "Bash"
        )
        self.assert_refused(shell)
        self.assertFalse((self.main / "y.txt").exists())

    def test_a_symlinked_folder_opens_nothing(self) -> None:
        # The scratchpad itself a link to the main checkout.
        shutil.rmtree(self.scratchpad)
        self.scratchpad.symlink_to(self.main, target_is_directory=True)
        self.assert_refused(self.adapter({"file_path": str(self.scratchpad / "x.txt")}))
        # A granted notes folder that is a link to elsewhere.
        shutil.rmtree(self.notes / STARTER)
        elsewhere = Path(self.temporary.name).resolve() / "elsewhere"
        elsewhere.mkdir()
        (self.notes / STARTER).symlink_to(elsewhere, target_is_directory=True)
        self.assert_refused(self.adapter({"file_path": str(self.notes / STARTER / "x.md")}))

    def test_a_symlinked_temp_root_opens_nothing(self) -> None:
        shutil.rmtree(self.temp_root)
        real = Path(self.temporary.name).resolve() / "real-root"
        (real / "p" / SESSION / "scratchpad").mkdir(parents=True)
        self.temp_root.symlink_to(real, target_is_directory=True)
        self.assert_refused(
            self.adapter({"file_path": str(self.temp_root / "p" / SESSION / "scratchpad" / "x")})
        )

    def test_a_scratchpad_inside_a_checkout_opens_nothing(self) -> None:
        inside = self.claude / "tmp"
        target = inside / f"claude-{os.getuid()}" / "p" / SESSION / "scratchpad"
        target.mkdir(parents=True)
        # Inside the owned worktree it was writable anyway; from the main
        # checkout's own copy it must not become so.
        other = self.main / "tmp"
        (other / f"claude-{os.getuid()}" / "p" / SESSION / "scratchpad").mkdir(parents=True)
        self.assert_refused(
            self.adapter(
                {"file_path": str(other / f"claude-{os.getuid()}" / "p" / SESSION / "scratchpad" / "x")},
                CLAUDE_CODE_TMPDIR=str(other),
            )
        )

    def test_the_payload_and_environment_decide(self) -> None:
        note = {"file_path": str(self.notes / STARTER / "a.md")}
        scratch = {"file_path": str(self.scratchpad / "a.txt")}
        # No session id: neither folder.
        self.assert_refused(self.adapter(scratch, session=None))
        self.assert_refused(self.adapter(note, session=None))
        # A session id that is no UUID names nothing.
        self.assert_refused(self.adapter(scratch, session="../" + SESSION))
        # No host session in the hook's environment, or one of the wrong
        # shape: no notes folder, the scratchpad still.
        self.assert_refused(self.adapter(note, CLAUDE_CODE_HOST_SESSION_ID=None))
        self.assert_refused(self.adapter(note, CLAUDE_CODE_HOST_SESSION_ID="local_../x"))
        self.assert_allowed(self.adapter(scratch, CLAUDE_CODE_HOST_SESSION_ID=None))
        # A host session whose record belongs to another CLI session.
        self.assert_refused(self.adapter(note, session=OTHER_SESSION))
        # A relative temp base names nothing.
        self.assert_refused(self.adapter(scratch, CLAUDE_CODE_TMPDIR="tmp"))

    def test_the_record_must_match_and_be_one(self) -> None:
        note = {"file_path": str(self.notes / STARTER / "a.md")}
        self.assert_allowed(self.adapter(note))
        self.write_record(cli=OTHER_SESSION)
        self.assert_refused(self.adapter(note))
        self.write_record()
        # A second record of the same host session: neither counts.
        second = self.app / "claude-code-sessions" / "account" / "org2"
        second.mkdir()
        shutil.copy(self.records / f"{HOST}.json", second / f"{HOST}.json")
        self.assert_refused(self.adapter(note))
        shutil.rmtree(second)
        self.assert_allowed(self.adapter(note))
        # Unreadable, or a record whose own id is not the host session.
        (self.records / f"{HOST}.json").write_text("{not json", encoding="utf-8")
        self.assert_refused(self.adapter(note))
        self.write_record()
        record = json.loads((self.records / f"{HOST}.json").read_text(encoding="utf-8"))
        record["sessionId"] = STRANGER
        (self.records / f"{HOST}.json").write_text(json.dumps(record), encoding="utf-8")
        self.assert_refused(self.adapter(note))
        # The own folder needs the record too.
        self.assert_refused(self.adapter({"file_path": str(self.notes / HOST / "a.md")}))

    def test_only_exact_grants_count(self) -> None:
        note = {"file_path": str(self.notes / STARTER / "a.md")}
        for granted in (
            (),
            (str(self.notes / STARTER / "sub"),),
            (f"{self.notes}/./{STARTER}",),
            (f"{self.notes}//{STARTER}",),
            (f"{self.notes}/{STRANGER}/../{STARTER}",),
            (str(self.app / STARTER),),
            ("side-session-notes/" + STARTER,),
        ):
            with self.subTest(granted=granted):
                self.write_record(granted=granted)
                self.assert_refused(self.adapter(note))
        self.write_record(granted=(str(self.notes / STARTER) + "/",))
        self.assert_allowed(self.adapter(note))

    def test_the_folders_count_only_after_ownership(self) -> None:
        # From the main checkout, which this session does not own, its
        # scratchpad is no way around the gate.
        self.assert_refused(
            self.adapter({"file_path": str(self.scratchpad / "a.txt")}, cwd=self.main)
        )
        # One command, two operands: the one outside every allowance decides.
        mixed = self.adapter(
            {
                "command": "touch "
                f"{shlex.quote(str(self.scratchpad / 'a'))} {shlex.quote(str(self.main / 'b'))}"
            },
            "Bash",
        )
        self.assert_refused(mixed)

    def test_a_near_miss_says_which_folders_are_this_sessions(self) -> None:
        scratch = self.adapter({"file_path": str(self.others / "a.txt")})
        self.assert_refused(scratch)
        self.assertIn(f"/{SESSION}/scratchpad, is writable", scratch.stderr)
        note = self.adapter({"file_path": str(self.notes / STRANGER / "a.md")})
        self.assert_refused(note)
        self.assertIn("granted this session are writable", note.stderr)
        self.assertIn(str(self.notes / STARTER), note.stderr)


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
