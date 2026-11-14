"""The shell-expansion rule (git_safety.py, `command.shellExpansion`): a
message given on the command line loses what the shell expands in it.

`git commit -m "fix `parse`"` runs `parse` and commits "fix ". The rule is on
trial: it warns (exit 0, a PreToolUse answer on stdout) until the settings say
"refuse", and every fire is a row of the refusal log either way. The reading
is judged here word by word (`analyse`), then end to end through
command_guard.py as Claude Code runs it.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from kavach import config, git_safety

KAVACH = Path(__file__).resolve().parents[1] / "kavach"
GUARD = KAVACH / "command_guard.py"

ENV = {
    key: value
    for key, value in os.environ.items()
    if not key.startswith("GIT_") and key not in ("CDPATH", "KAVACH_CONFIG", "HOOK_INPUT", "KAVACH_REFUSAL_LOG_OFF")
}
ENV.update(GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")

HEREDOC = "git commit -m \"$(cat <<'EOF'\nfix `parse` and $(this)\n\nbody !here\nEOF\n)\""

# (command, kind, the fragment the reason quotes, the option named)
FIRES = (
    ('git commit -m "fix `parse` bug"', "backticks", "`parse`", "-m"),
    ('git commit -m "today is $(date)"', "substitution", "$(date)", "-m"),
    ('git commit -m "keep !important rules"', "history", "!important", "-m"),
    ('git commit -qam "fix `x`"', "backticks", "`x`", "-m"),
    ('git commit -m"fix `x`"', "backticks", "`x`", "-m"),
    ('git commit --message="fix `x`"', "backticks", "`x`", "--message"),
    ('git commit --mes "fix `x`"', "backticks", "`x`", "--message"),
    ("git commit -m fix!now", "history", "!now", "-m"),
    ('git commit -m ok -m "second `x` paragraph"', "backticks", "`x`", "-m"),
    ('git -C . commit --allow-empty -m "fix `x`"', "backticks", "`x`", "-m"),
    ("bash -c 'git commit -m \"fix `x`\"'", "backticks", "`x`", "-m"),
    ('git commit -m "fix $(foo) bar"', "substitution", "$(foo)", "-m"),
    ('git commit -m "use `x`"', "backticks", "`x`", "-m"),
    ('git commit -m "$(cat .tmp/msg) and more"', "substitution", "$(cat .tmp/msg)", "-m"),
    ('git commit -m "$(a)$(b)"', "substitution", "$(a)", "-m"),
    ('git commit -m "$(a) "', "substitution", "$(a)", "-m"),
    ('git commit -m"see $(x)"', "substitution", "$(x)", "-m"),
    ('gh pr comment 1 --body="see $(x)"', "substitution", "$(x)", "--body"),
    ('git tag -a v1 -m "release `x`"', "backticks", "`x`", "-m"),
    ('git tag -am "release `x`" v1', "backticks", "`x`", "-m"),
    ('git tag --message "release $(x)" v1', "substitution", "$(x)", "--message"),
    ('gh pr create --title t --body "uses `x`"', "backticks", "`x`", "--body"),
    ('gh pr comment 12 -b "see $(x)"', "substitution", "$(x)", "-b"),
    ('gh issue comment 3 --body="a `b`"', "backticks", "`b`", "--body"),
    ('gh issue create -t title -b "x !y"', "history", "!y", "-b"),
    ('gh pr edit 4 -R owner/repo --body "a `b`"', "backticks", "`b`", "--body"),
    ('gh pr review 4 --comment -b"a `b`"', "backticks", "`b`", "-b"),
    ('gh issue edit 4 --body "a `b`"', "backticks", "`b`", "--body"),
)

PASSES = (
    # A value that is wholly one command substitution: its output is the message.
    'git commit -m "$(cat .tmp/msg)"',
    'gh pr create --title t --body "$(git log -1 --format=%s)"',
    'git commit -m "`git log -1 --format=%s`"',
    "git commit -m $(cat .tmp/msg)",
    'git commit -m"$(cat .tmp/msg)"',
    'git commit -qam"$(cat .tmp/msg)"',
    'git commit --message="$(cat .tmp/msg)"',
    'git tag -m "$(cat .tmp/notes)" v1',
    'git tag -am"$(cat .tmp/notes)" v1',
    'git tag --message="$(cat .tmp/notes)" v1',
    'gh pr comment 1 -b"$(cat .tmp/b.md)"',
    'gh issue comment 1 --body="$(cat .tmp/b.md)"',
    'git commit -m "$(cat <<EOF\nuses `x`\nEOF\n)"',
    "git commit -m 'fix `parse` and $(this) and !that'",
    "git commit -F .tmp/message.txt",
    "git commit --file=.tmp/message.txt",
    'gh pr create --title "x" --body-file .tmp/body.md',
    'gh pr create -F .tmp/body.md -t "x"',
    'git commit -m "done!"',
    'git commit -m "a != b"',
    'git commit -m "wow! nice"',
    'git commit -m "a !(b)"',
    'git commit -m "wow\\!"',
    'git commit -m "$MESSAGE"',
    'git commit -m "${MESSAGE}"',
    'git commit -m "pid $!"',
    'git commit -m "$((1 + 2)) fixes"',
    'git commit -m "fix \\`parse\\`"',
    HEREDOC,
    "git commit -m \"$(cat <<-'EOF'\n\tfix `x`\n\tEOF\n)\"",
    'git commit -m "$(cat <<"EOF"\nfix `x`\nEOF\n)"',
    'git commit -m "$(cat <<EOF\nplain $HOME text\nEOF\n)"',
    # A title, a branch and a search are not the text this rule is about.
    'gh pr create --title "fix `x`" --body-file .tmp/b.md',
    'gh pr checkout -b "$(x)" 12',
    'gh pr list --search "`x`"',
    'gh pr create -t "-b `x`" --body-file b.md',
    'echo "fix `x`"',
    'git log -m "`x`"',
    'git tag -F .tmp/notes v1',
    'git tag -u "$(key)" -m plain v1',
    "git commit -c HEAD~1 -m 'ok'",
)


class Reading(unittest.TestCase):
    """What `analyse` finds in each command, without running it."""

    def found(self, command: str) -> list[git_safety.Expansion]:
        reason, found = git_safety.analyse(command, os.getcwd(), read_config=False)
        self.assertIsNone(reason, command)
        return found

    def test_each_expansion_in_a_message_is_found(self) -> None:
        for command, kind, fragment, flag in FIRES:
            with self.subTest(command=command):
                found = self.found(command)
                self.assertTrue(found, command)
                self.assertEqual((found[0].kind, found[0].flag), (kind, flag))
                self.assertTrue(found[0].fragment.startswith(fragment), found[0].fragment)
                message = git_safety.shell_expansion_message(found)
                self.assertIn(fragment, message)
                self.assertIn(f" {flag} before ", message)

    def test_text_the_shell_leaves_alone_is_not_found(self) -> None:
        for command in PASSES:
            with self.subTest(command=command):
                self.assertEqual(self.found(command), [])

    def test_each_expansion_is_named_once(self) -> None:
        # The same message twice, as when one program is read twice
        # (`echo ... | bash`, in both of echo's decodings).
        found = self.found('git commit -m "a `x` b `y`" && git commit -m "a `x` b `y`"')
        self.assertEqual([item.fragment for item in found], ["`x`", "`y`"])
        self.assertEqual(len(self.found("echo 'git commit -m \"a `x`\"' | bash")), 1)
        self.assertIn(
            "expands the backticks `x` and the backticks `y` inside this double-quoted -m before git",
            git_safety.shell_expansion_message(found),
        )

    def test_the_message_names_the_way_out_for_each_program(self) -> None:
        for command, quoting, remedy in (
            ('git commit -m "a `x`"', "double-quoted", "`git commit -F <file>` (or `gh ... --body-file <file>`)"),
            ("git commit -m a!x", "unquoted", "`git commit -F <file>`"),
            ('git tag v1 -m "a `x`"', "double-quoted", "`git tag -F <file>`"),
            ('gh pr comment 1 -b "a `x`"', "double-quoted", "`gh pr comment --body-file <file>`"),
        ):
            with self.subTest(command=command):
                message = git_safety.shell_expansion_message(self.found(command))
                self.assertIn(f"inside this {quoting} ", message)
                self.assertIn(remedy, message)
                self.assertIn("so that text silently disappears from the message.", message)

    def test_a_long_fragment_is_clipped(self) -> None:
        found = self.found('git commit -m "a $(' + "x" * 200 + ')"')
        message = git_safety.shell_expansion_message(found)
        self.assertIn("$(" + "x" * (git_safety.FRAGMENT_LIMIT - 5) + "...", message)
        self.assertNotIn("x" * git_safety.FRAGMENT_LIMIT, message)

    def test_another_refusal_comes_first(self) -> None:
        reason, found = git_safety.analyse('git commit -m "a `x`" --no-verify', os.getcwd(), read_config=False)
        self.assertIn("--no-verify", reason or "")
        self.assertTrue(found)

    def test_a_brace_word_keeps_what_it_expands(self) -> None:
        found = self.found("git commit -m fix!{a,b}")
        self.assertEqual([item.fragment for item in found], ["!{a,b}"])


class Settings(unittest.TestCase):
    def test_the_rule_warns_unless_told_to_refuse(self) -> None:
        self.assertEqual(config.parse({}).shell_expansion, "warn")
        self.assertEqual(config.DEFAULT.shell_expansion_refuses_from, "")
        loaded = config.parse({"command": {"shellExpansion": "refuse", "shellExpansionRefusesFrom": "2026-11-21"}})
        self.assertEqual((loaded.shell_expansion, loaded.shell_expansion_refuses_from), ("refuse", "2026-11-21"))

    def test_other_values_are_refused(self) -> None:
        for command, text in (
            ({"shellExpansion": "off"}, "command.shellExpansion must be one of warn, refuse"),
            ({"shellExpansion": ["warn"]}, "command.shellExpansion must be one of"),
            ({"shellExpansionRefusesFrom": "next week"}, "must be a day, YYYY-MM-DD"),
            ({"shellExpansionRefusesFrom": 20261121}, "must be a day, YYYY-MM-DD"),
        ):
            with self.subTest(command=command):
                with self.assertRaises(config.ConfigError) as raised:
                    config.parse({"command": command})
                self.assertIn(text, str(raised.exception))


class RepoFixture(unittest.TestCase):
    """command_guard.py as Claude Code runs it, in a repository of its own so
    each fire's log row can be read. No tests of its own."""

    def setUp(self) -> None:
        self.work = tempfile.mkdtemp(prefix="shell-expansion-")
        self.addCleanup(shutil.rmtree, self.work, True)
        self.repo = os.path.join(self.work, "repo")
        os.mkdir(self.repo)
        subprocess.run(["git", "init", "-q", "."], cwd=self.repo, env=ENV, check=True)

    def settings(self, document: object) -> str:
        path = os.path.join(self.work, "kavach.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(document, handle)
        return path

    def run_guard(
        self, command: str, settings: str | None = None, guard: Path = GUARD
    ) -> subprocess.CompletedProcess[str]:
        env = dict(ENV)
        if settings:
            env["KAVACH_CONFIG"] = settings
        event = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": self.repo}
        return subprocess.run(
            [sys.executable, str(guard)],
            input=json.dumps(event),
            cwd=self.repo,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )

    def rows(self) -> list[dict[str, str]]:
        path = Path(self.repo, ".git", "kavach", "refusals.jsonl")
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


class Hook(RepoFixture):
    def test_a_warning_allows_the_call_and_puts_the_reason_in_front_of_the_agent(self) -> None:
        result = self.run_guard('git commit --allow-empty -m "fix `parse` bug"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        answer = json.loads(result.stdout)
        self.assertEqual(list(answer), ["hookSpecificOutput"])
        specific = answer["hookSpecificOutput"]
        self.assertEqual(specific["hookEventName"], "PreToolUse")
        self.assertNotIn("permissionDecision", specific)
        context = specific["additionalContext"]
        self.assertTrue(context.startswith("kavach warning (refuses after its trial): the shell expands"), context)
        self.assertIn("the backticks `parse` inside this double-quoted -m before git sees it", context)
        self.assertIn("This call still runs while the rule is on trial", context)
        (row,) = self.rows()
        self.assertEqual((row["guard"], row["rule"], row["mode"]), ("command", "commit-message-shell-expansion", "warn"))
        self.assertTrue(row["reason"].startswith("WARNING: the shell expands the backticks `parse`"), row["reason"])

    def test_a_warning_names_the_day_it_starts_refusing(self) -> None:
        settings = self.settings({"command": {"shellExpansionRefusesFrom": "2026-11-21"}})
        result = self.run_guard('gh pr comment 1 -b fix!now', settings)
        self.assertEqual(result.returncode, 0, result.stderr)
        context = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertTrue(context.startswith("kavach warning (refuses from 2026-11-21): "), context)
        self.assertIn("`gh pr comment --body-file <file>`", context)

    def test_refuse_mode_blocks_and_logs_one_row(self) -> None:
        settings = self.settings({"command": {"shellExpansion": "refuse"}})
        result = self.run_guard('git commit --allow-empty -m "fix `parse` bug"', settings)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertTrue(
            result.stderr.startswith("BLOCKED: the shell expands the backticks `parse` inside this double-quoted -m"),
            result.stderr,
        )
        self.assertIn("Write the message to a file and use `git commit -F <file>`", result.stderr)
        (row,) = self.rows()
        self.assertEqual((row["rule"], row["mode"]), ("commit-message-shell-expansion", "refuse"))
        self.assertTrue(row["reason"].startswith("BLOCKED: the shell expands"), row["reason"])

    def test_a_clean_message_and_other_refusals_are_unchanged(self) -> None:
        settings = self.settings({"command": {"shellExpansion": "refuse"}})
        for command in ("git commit --allow-empty -m 'fix `parse`'", HEREDOC.replace("commit", "commit --allow-empty")):
            with self.subTest(command=command):
                result = self.run_guard(command, settings)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        refused = self.run_guard('git commit -m "fix `x`" --no-verify')
        self.assertEqual(refused.returncode, 2)
        self.assertEqual(refused.stdout, "")
        self.assertNotIn("shell expands", refused.stderr)
        (row,) = self.rows()
        self.assertNotIn("rule", row)
        self.assertNotIn("mode", row)


PLANTED = '\n\ndef is_message_option(name):\n    raise ValueError("planted")\n'
FORCED = 'git commit --allow-empty --message "fix" ; git push --force origin HEAD'


class Exploding:
    """A set whose every lookup raises, standing in for gh's command table."""

    def __contains__(self, item: object) -> bool:
        raise KeyError("x")


class DetectionFailure(RepoFixture):
    """While the rule warns, its own failure must not stop a call: the call
    runs and the trial's log names the error. Refusing, it fails closed, and
    the other checks fail closed in either mode."""

    def planted_guard(self) -> Path:
        """A copy of the guard whose detection raises (a module-level
        monkeypatch: the copy's git_safety.py redefines a function the
        detection calls)."""

        directory = Path(self.work, "kavach")
        shutil.copytree(KAVACH, directory, ignore=shutil.ignore_patterns("__pycache__"))
        with open(directory / "git_safety.py", "a", encoding="utf-8") as handle:
            handle.write(PLANTED)
        return directory / "command_guard.py"

    def test_warn_allows_and_logs_the_failure(self) -> None:
        result = self.run_guard('git commit --allow-empty --message "fix"', guard=self.planted_guard())
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        (row,) = self.rows()
        self.assertEqual((row["rule"], row["mode"]), ("commit-message-shell-expansion", "warn"))
        self.assertIn("the shell-expansion check failed (ValueError)", row["reason"])

    def test_refuse_fails_closed(self) -> None:
        settings = self.settings({"command": {"shellExpansion": "refuse"}})
        result = self.run_guard('git commit --allow-empty --message "fix"', settings, guard=self.planted_guard())
        self.assertEqual(result.returncode, 2)
        self.assertIn("the shell-code check failed (ValueError: planted)", result.stderr)

    def test_a_forced_push_is_still_refused(self) -> None:
        guard = self.planted_guard()
        for settings in (None, self.settings({"command": {"shellExpansion": "refuse"}})):
            with self.subTest(settings=settings):
                result = self.run_guard(FORCED, settings, guard=guard)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("--force", result.stderr)

    def hook(self, command: str, mode: str) -> tuple[int, str, str, list[tuple[str, str, str]]]:
        """git_safety.hook_main alone, in process, so a mock reaches it."""

        heard: list[tuple[str, str, str]] = []
        settings = config.parse({"command": {"shellExpansion": mode}})
        event = json.dumps({"tool_input": {"command": command}, "cwd": self.repo})
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {"HOOK_INPUT": event}), contextlib.redirect_stdout(
            stdout
        ), contextlib.redirect_stderr(stderr):
            try:
                git_safety.hook_main(settings, lambda *fire: heard.append(fire))
            except SystemExit as end:
                code = end.code
        return code, stdout.getvalue(), stderr.getvalue(), heard

    def test_each_part_of_the_detection_is_tolerated_while_warning(self) -> None:
        for target, command in (
            ("is_message_option", 'git commit --message "fix `x`"'),
            ("heredoc_message", 'git commit -m "fix $(x)"'),
            ("shell_expansion_message", 'git commit -m "fix `x`"'),
            ("is_message_option", 'git tag --message "fix `x`" v1'),
            ("GH_BODY_COMMANDS", 'gh pr comment 1 -b "fix `x`"'),
        ):
            with self.subTest(target=target, command=command):
                broken: object = mock.MagicMock(side_effect=KeyError("x"))
                if target == "GH_BODY_COMMANDS":
                    broken = Exploding()
                with mock.patch.object(git_safety, target, broken):
                    code, stdout, _stderr, heard = self.hook(command, "warn")
                    self.assertEqual(code, 0)
                    self.assertIn(
                        ("commit-message-shell-expansion", "warn",
                         "the shell-expansion check failed (KeyError), so it did not judge this command; "
                         "the call was allowed."),
                        heard,
                    )
                    with self.assertRaises(KeyError if target != "heredoc_message" else git_safety.DetectionError):
                        self.hook(command, "refuse")

    def test_other_checks_fail_closed_in_process_too(self) -> None:
        with mock.patch.object(git_safety, "is_message_option", mock.MagicMock(side_effect=KeyError("x"))):
            code, _stdout, stderr, _heard = self.hook(FORCED, "warn")
        self.assertEqual(code, 2)
        self.assertIn("--force", stderr)


if __name__ == "__main__":
    unittest.main()
