"""Every refusal names the way out.

The worktree guard's "mutation targets could not be resolved" names what in
the command it could not read and what to do instead; a write outside the
worktree names where it aimed (the main checkout, another worktree or its git
folder, a system temp folder) and where it belongs. The command guard's
refusals that named no way out end in one. The leading words of each refusal
are kept, so earlier logs and searches still match.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from kavach import git_safety

from .test_boundary import ADAPTER, BoundaryFixture, hermetic_git_env

COMMAND_GUARD = Path(__file__).resolve().parents[1] / "kavach" / "command_guard.py"

WAY_OUT = (
    "Run one plain command per call; write files with the Edit or Write tools; for more, write a "
    "script under this worktree's .tmp/ and run it through the repository's package runner "
    "(for example `pnpm exec tsx .tmp/x.ts`)."
)


class UnresolvedNamesTheConstruct(BoundaryFixture):
    def refused(self, command: str) -> str:
        result = self.claude_bash(self.claude, command)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertTrue(
            result.stderr.startswith("BLOCKED: mutation targets could not be resolved: "), result.stderr
        )
        self.assertIn(WAY_OUT, result.stderr)
        return result.stderr

    def test_each_construct_is_named(self) -> None:
        for command, named in (
            (
                "gh issue view 1 --json comments --jq '.comments[].body' > .tmp/notes.md",
                "this command uses an output redirection (`>` to .tmp/notes.md), so the guard cannot read",
            ),
            (
                "pnpm install --frozen-lockfile > /tmp/scratch/install.log 2>&1; echo exit $?",
                "uses an output redirection (`>` to /tmp/scratch/install.log) and a chain of commands",
            ),
            ("cat > notes.md <<'EOF'\ntext\nEOF", "uses a heredoc (`<<`) and an output redirection"),
            ("touch `date +%s`.txt", "uses a command substitution (`$(...)`, backticks or `<(...)`)"),
            ("node .tmp/report.js", "uses an interpreter running a file or module (`node .tmp/report.js`)"),
            ("bash -e .tmp/run.sh", "uses an interpreter running a file or module (`bash -e .tmp/run.sh`)"),
            ("python3 -m unittest", "uses an interpreter running a file or module (`python3 -m unittest`)"),
            ("python3 -c 'print(1)'", "uses an inline python3 program (`python3 -c`)"),
            ("node -e 'require(1)'", "uses an inline node program (`node -e`)"),
            ("frobnicate --apply", "uses `frobnicate`, a program whose writes the guard does not know"),
            (
                "echo ready && frobnicate --apply",
                "uses `frobnicate`, a program whose writes the guard does not know and a chain of commands",
            ),
            ("frobnicate | sort", "uses `frobnicate`, a program whose writes the guard does not know and a pipeline"),
        ):
            with self.subTest(command=command):
                self.assertIn(named, self.refused(command))

    def test_a_redirection_and_a_heredoc_say_what_to_do_instead(self) -> None:
        stderr = self.refused("cat > notes.md <<'EOF'\ntext\nEOF")
        self.assertIn("A redirection into a file is never read, wherever it points", stderr)
        self.assertIn("for a commit message, `git commit -F <file>`", stderr)
        plain = self.refused("frobnicate --apply")
        self.assertNotIn("A redirection", plain)
        self.assertNotIn("heredoc", plain)

    def test_an_unreadable_command_still_names_the_way_out(self) -> None:
        stderr = self.refused("echo 'unterminated")
        self.assertIn("the guard cannot read off this command what it writes", stderr)

    def test_the_hint_never_needs_the_shell_reader(self) -> None:
        values = {"command": "frobnicate --apply"}
        real = ADAPTER.shell_reader
        try:
            ADAPTER.shell_reader = lambda: None
            message = ADAPTER.unresolved("Bash", values, self.claude)
        finally:
            ADAPTER.shell_reader = real
        self.assertEqual(
            message,
            f"mutation targets could not be resolved: the guard cannot read off this command what it writes. {WAY_OUT}",
        )

    def test_a_file_tool_path_that_cannot_be_read(self) -> None:
        result = self.invoke(self.claude, tool_input={"file_path": "$HOME/x"})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("the file path cannot be read as one place", result.stderr)
        self.assertEqual(
            ADAPTER.unresolved("Write", {"file_path": "$HOME/x"}, self.claude),
            "mutation targets could not be resolved: the file path cannot be read as one place. "
            "Give the tool an absolute path inside this worktree.",
        )


class OutsideNamesWhereItBelongs(BoundaryFixture):
    def refused(self, target: Path) -> str:
        result = self.invoke(self.claude, tool_input={"file_path": str(target)})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(f"mutation target {target.resolve()} is outside this session's Claude worktree", result.stderr)
        return result.stderr

    def test_each_place_names_its_alternative(self) -> None:
        git_dir = self.main / ".git"
        for target, hint in (
            (
                self.main / "docs" / "new.md",
                f"; that is the main checkout: make the change in this worktree's own copy, "
                f"{self.claude.resolve() / 'docs' / 'new.md'}",
            ),
            (self.manual / "new.txt", "; that is another worktree, which another session may own"),
            (
                git_dir / "worktrees" / "manual-task" / "x",
                "; that is another worktree's git folder: for this worktree's own branch run git here, and "
                "for anything else write a script under this worktree's .tmp/ and run it from this worktree",
            ),
            (git_dir / "worktrees" / "claude-task" / "x", "; that is this worktree's git folder"),
            (git_dir / "config", "; that is the repository's git folder"),
            (
                Path(tempfile.gettempdir()) / "kavach-scratch.txt",
                "; that is a system temp folder: keep scratch files in this worktree's .tmp/",
            ),
            (Path("/usr/local/kavach-nowhere/x"), "; write only inside this worktree, and keep scratch files in its .tmp/"),
        ):
            with self.subTest(target=str(target)):
                self.assertIn(hint, self.refused(target))

    def test_another_session_worktree_is_not_the_main_checkout(self) -> None:
        other = self.main / ".claude" / "worktrees" / "other-task"
        subprocess.run(
            ["git", "worktree", "add", "-qb", "other-task", str(other)],
            cwd=self.main, env=hermetic_git_env(), check=True, capture_output=True,
        )
        stderr = self.refused(other / "new.txt")
        self.assertIn("; that is another worktree, which another session may own", stderr)
        self.assertNotIn("main checkout", stderr)

    def test_a_failing_hint_keeps_the_denial(self) -> None:
        real = ADAPTER.where_instead

        def broken(*_args: object) -> str:
            raise OSError("no")

        try:
            ADAPTER.where_instead = broken
            message = ADAPTER.denial(self.main / "x", self.claude, self.main)
        finally:
            ADAPTER.where_instead = real
        self.assertTrue(message.endswith("; write only inside this worktree, and keep scratch files in its .tmp/"))

    def test_a_bash_write_outside_names_it_too(self) -> None:
        result = self.claude_bash(self.claude, f"touch {self.main / 'new.txt'}")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("; that is the main checkout", result.stderr)

    def test_unreadable_worktree_pointers_are_skipped(self) -> None:
        (self.main / ".git" / "worktrees" / "broken").mkdir()
        self.assertEqual(
            [tree for _gitdir, tree in ADAPTER.linked_worktrees((self.main / ".git").resolve())],
            sorted([self.claude.resolve(), self.manual.resolve()], key=lambda tree: tree.name),
        )
        self.assertEqual(ADAPTER.linked_worktrees(self.external), [])


class CommandGuardNamesTheWayOut(unittest.TestCase):
    def test_a_refusal_without_a_way_out_gets_one(self) -> None:
        self.assertEqual(
            git_safety.with_way_out("eval of a computed string cannot be verified"),
            f"eval of a computed string cannot be verified. {git_safety.PLAIN_REMEDY}",
        )
        for reason in (
            f"'git commit -n' is --no-verify. {git_safety.HOOK_REMEDY}",
            f"a '+' refspec forces the update.\n{git_safety.FORCE_REMEDY}",
        ):
            with self.subTest(reason=reason):
                self.assertEqual(git_safety.with_way_out(reason), reason)

    def run_guard(self, command: str) -> subprocess.CompletedProcess[str]:
        env = {**hermetic_git_env(), "KAVACH_REFUSAL_LOG_OFF": "1"}
        env.pop("KAVACH_CONFIG", None)
        return subprocess.run(
            [sys.executable, str(COMMAND_GUARD)],
            input=json.dumps({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": os.getcwd()}),
            capture_output=True, text=True, env=env, check=False, timeout=120,
        )

    def test_the_hook_appends_the_way_out(self) -> None:
        result = self.run_guard('eval "$PROGRAM"; git status')
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("eval of a computed string cannot be verified", result.stderr)
        self.assertIn(git_safety.PLAIN_REMEDY, result.stderr)

    def test_a_bare_exclamation_keeps_its_fast_exit(self) -> None:
        # An inline node program mentioning --force is refused by the
        # shell-code check; with no git or gh in it, that check never runs.
        result = self.run_guard("if ! node build.js --force; then echo failed; fi")
        self.assertEqual((result.returncode, result.stdout), (0, ""), result.stderr)


if __name__ == "__main__":
    unittest.main()
