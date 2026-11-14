"""The command guard, driven as Claude Code drives it: a PreToolUse event as
JSON on stdin of ``python3 command_guard.py``, judged by its exit code (and,
where a case names one, a text its stderr must hold).

Every case of command_guard_cases.py is one assertion of the shell suite the
guard was ported from; the kinds below are that suite's helpers. The rest of
this file covers what the table cannot: the module-loading and verdict ends,
input the guard cannot read, and the rules with no settings or other ones.

git is hermetic here, for the fixtures and for the git the guard itself
spawns: the developer's own configuration (a remote.origin.push, diff
settings) must not leak in.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from kavach import git_safety

from .command_guard_cases import CASES

KAVACH = Path(__file__).resolve().parents[1] / "kavach"
GUARD = KAVACH / "command_guard.py"

SAMPLE_CONFIG = {
    "command": {
        "protectedVariables": ["HOSTED_REMOTE", "HOSTED_ENTRYPOINT"],
        "protectedVariablesReason": "they mark a hosted session; leave them as the session set them",
        "pairedChanges": [
            {"changes": "schema.sql", "requires": "changesets/", "reason": "a schema change needs its changeset"}
        ],
    }
}
SCHEMA = "db/schema.sql"
CHANGESET = "db/changesets/20261001000000_x/change.sql"
# The refusal a commit case expects unless it names another.
PAIRED_REFUSAL = "'schema.sql' is staged without a path containing 'changesets/'"

# Only these reach the guard and the fixtures from the developer's
# environment: no GIT_* variable, CDPATH, KAVACH_CONFIG or HOOK_INPUT.
BASE_ENV = {
    key: value
    for key, value in os.environ.items()
    if not key.startswith("GIT_") and key not in ("CDPATH", "KAVACH_CONFIG", "HOOK_INPUT")
}
BASE_ENV.update(GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")
# Fixture commits need an identity, which the hermetic config does not give.
FIXTURE_ENV = {
    **BASE_ENV,
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.com",
}


def make_input(command: object, cwd: str | None = None) -> bytes:
    """A PreToolUse event for a Bash command; `cwd` is the Bash tool shell's
    directory, as Claude Code reports it."""
    event: dict[str, object] = {"tool_input": {"command": command}}
    if cwd:
        event["cwd"] = cwd
    return (json.dumps(event) + "\n").encode()


def fixture(script: str, cwd: str, *args: str) -> None:
    """Run fixture shell code in `cwd`; its output and failures are ignored,
    as the shell suite's `( ... ) >/dev/null 2>&1` ignores them."""
    subprocess.run(
        ["bash", "-c", script, "fixture", *args],
        cwd=cwd,
        env=FIXTURE_ENV,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )


class Guard:
    """Runs the guard with the sample settings unless told otherwise."""

    config_path = ""

    @classmethod
    def run(
        cls,
        stdin: bytes,
        cwd: str,
        *,
        guard: Path | str = GUARD,
        config: str | None = None,
        env: dict[str, str] | None = None,
        python_flags: tuple[str, ...] = (),
    ) -> tuple[int, str]:
        environment = {**BASE_ENV, **(env or {})}
        chosen = cls.config_path if config is None else config
        if chosen:
            environment["KAVACH_CONFIG"] = chosen
        result = subprocess.run(
            [sys.executable, *python_flags, str(guard)],
            input=stdin,
            cwd=cwd,
            env=environment,
            capture_output=True,
            timeout=120,
            check=False,
        )
        return result.returncode, result.stderr.decode("utf-8", "replace")


def setUpModule() -> None:
    global WORK, PLAIN_REPO
    WORK = tempfile.mkdtemp(prefix="command-guard-")
    path = os.path.join(WORK, "sample.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(SAMPLE_CONFIG, handle)
    Guard.config_path = path
    # Where the shell suite's plain cases ran: a clean repository with a remote.
    PLAIN_REPO = os.path.join(WORK, "plain")
    os.mkdir(PLAIN_REPO)
    fixture(
        "git init -q . && git remote add origin https://example.com/x.git"
        " && echo base > README && git add README && git commit -qm base",
        PLAIN_REPO,
    )


def tearDownModule() -> None:
    shutil.rmtree(WORK, ignore_errors=True)


class Case:
    """The shell suite's helpers, one method per kind."""

    def __init__(self, test: unittest.TestCase) -> None:
        self.test = test

    def expect(self, expected: int, actual: int, desc: str, stderr: str) -> None:
        self.test.assertEqual(actual, expected, f"{desc}: exit {actual}, stderr: {stderr.strip()[:400]}")

    def exit(self, expected: int, desc: str, command: str) -> None:
        actual, stderr = Guard.run(make_input(command), PLAIN_REPO)
        self.expect(expected, actual, desc, stderr)

    def raw(self, expected: int, desc: str, text: str, stdin: str | bytes, cwd: str | None = None) -> None:
        data = stdin.encode() if isinstance(stdin, str) else stdin
        actual, stderr = Guard.run(data, cwd or PLAIN_REPO)
        self.expect(expected, actual, desc, stderr)
        if text:
            self.test.assertIn(text, stderr, desc)

    def tmp_repo(self, expected: int, desc: str, command: str, setup: str) -> None:
        """In a throwaway repository with a remote, configured by `setup`."""
        tmp = tempfile.mkdtemp(dir=WORK)
        fixture('git init -q . && git remote add origin https://example.com/x.git && eval "$1"', tmp, setup)
        actual, stderr = Guard.run(make_input(command), tmp)
        self.expect(expected, actual, desc, stderr)
        shutil.rmtree(tmp, ignore_errors=True)

    def cross_repo(self, expected: int, desc: str, template: str) -> None:
        """<other> carries a forcing refspec, <clean> does not, and the guard
        runs from <clean>: it passes only if it follows the push's target.
        <clean>/other is a decoy with no forcing refspec, for a parser that
        resolves `-C a -C other` from the original cwd."""
        tmp = tempfile.mkdtemp(dir=WORK)
        other, clean = os.path.join(tmp, "other"), os.path.join(tmp, "clean")
        os.makedirs(other)
        os.makedirs(os.path.join(clean, "other"))
        fixture(
            "git init -q . && git remote add origin https://example.com/x.git"
            " && git config remote.origin.push '+refs/heads/*:refs/heads/*'",
            other,
        )
        fixture("git init -q . && git remote add origin https://example.com/y.git", clean)
        fixture("git init -q . && git remote add origin https://example.com/z.git", os.path.join(clean, "other"))
        command = template.replace("__OTHERPARENT__", tmp).replace("__OTHER__", other)
        command = command.replace("__OTHERGIT__", other + "/.git")
        actual, stderr = Guard.run(make_input(command), clean)
        self.expect(expected, actual, desc, stderr)
        shutil.rmtree(tmp, ignore_errors=True)

    def hook_git_dir(self, expected: int, desc: str, command: str) -> None:
        """The guard itself runs with GIT_DIR naming <clean>, from <other>,
        which forces: a command that drops GIT_DIR reads <other>."""
        tmp = tempfile.mkdtemp(dir=WORK)
        other, clean = os.path.join(tmp, "other"), os.path.join(tmp, "clean")
        os.makedirs(other)
        os.makedirs(clean)
        fixture(
            "git init -q . && git remote add origin https://example.com/x.git"
            " && git config remote.origin.push '+refs/heads/*:refs/heads/*'",
            other,
        )
        fixture("git init -q . && git remote add origin https://example.com/y.git", clean)
        actual, stderr = Guard.run(make_input(command), other, env={"GIT_DIR": clean + "/.git"})
        self.expect(expected, actual, desc, stderr)
        shutil.rmtree(tmp, ignore_errors=True)

    def commit(
        self, expected: int, desc: str, template: str, setup: str, input_cwd: str, rundir: str, reason: str
    ) -> None:
        """Three repositories under one temp dir. The guard runs from <clean>,
        whose index is empty; <t> (a sibling) holds the state `setup` builds,
        on top of a base where the schema and its changeset are both modified
        and unstaged. A check that reads the hook's cwd sees nothing in
        <clean> and allows the commit, so every blocking case fails loudly if
        the commit's own repository is not followed. <clean>/t is a clean
        decoy for a parser that resolves `-C __TMP__ -C t` from the original
        cwd. A blocking case must block for the paired change, not for an
        unreadable directory, unless `reason` names the refusal expected."""
        tmp = tempfile.mkdtemp(dir=WORK)
        os.makedirs(os.path.join(tmp, "clean", "t"))
        os.makedirs(os.path.join(tmp, "t", os.path.dirname(CHANGESET)))
        fixture(
            'for r in "$1/clean" "$1/clean/t" "$1/t"; do git -C "$r" init -q . || exit 1; done'
            ' && cd "$1/t" && echo "create table a (id int);" > "$2" && echo "-- x" > "$3"'
            ' && git add "$2" "$3" && git -c user.name=t -c user.email=t@t commit -qm init'
            ' && echo "-- changed" >> "$2" && echo "-- y" >> "$3" && eval "$4"',
            tmp,
            tmp,
            SCHEMA,
            CHANGESET,
            setup,
        )
        command = template.replace("__TMP__", tmp).replace("__T__", tmp + "/t")
        shell_cwd = input_cwd.replace("__T__", tmp + "/t")
        where = (rundir or "__TMP__/clean").replace("__TMP__", tmp)
        actual, stderr = Guard.run(make_input(command, shell_cwd or None), where)
        shutil.rmtree(tmp, ignore_errors=True)
        if actual == 2:
            self.test.assertIn(reason or PAIRED_REFUSAL, stderr, f"{desc}: blocked for another reason")
        self.expect(expected, actual, desc, stderr)


class ShellSuiteCases(unittest.TestCase):
    """One test per row of command_guard_cases.CASES."""


def _add_case(index: int, row: tuple) -> None:
    kind, expected, desc, *args = row

    def test(self: unittest.TestCase) -> None:
        getattr(Case(self), kind)(expected, desc, *args)

    slug = re.sub(r"[^a-z0-9]+", "_", desc.lower()).strip("_")[:60]
    test.__doc__ = f"{kind}: {desc}"
    setattr(ShellSuiteCases, f"test_{index:03d}_{slug}", test)


for _index, _row in enumerate(CASES, 1):
    _add_case(_index, _row)


class Loading(unittest.TestCase):
    """The entry loads its modules from its own directory, and a check that
    fails in any way blocks: Claude Code lets a hook's exit 1 through, so a
    crash would let every command through. Each copy's module is the bug."""

    def copy(self, *names: str, log: bool = True) -> str:
        directory = tempfile.mkdtemp(dir=WORK)
        self.addCleanup(shutil.rmtree, directory, True)
        for name in ("command_guard.py", *(("refusal_log.py",) if log else ()), *names):
            shutil.copy(KAVACH / name, directory)
        return directory

    def test_a_copy_without_its_refusal_log_blocks(self) -> None:
        directory = self.copy("config.py", "bash_guard.py", "git_safety.py", log=False)
        self.assert_blocks(os.path.join(directory, "command_guard.py"), "could not load refusal_log.py")

    def stub(self, source: str) -> str:
        directory = self.copy("config.py")
        Path(directory, "bash_guard.py").write_text(source + "\n", encoding="utf-8")
        return os.path.join(directory, "command_guard.py")

    def assert_blocks(self, guard: str, text: str, command: str = "ls") -> None:
        actual, stderr = Guard.run(make_input(command), PLAIN_REPO, guard=guard)
        self.assertEqual(actual, 2, stderr)
        self.assertIn(text, stderr)

    def test_a_copy_without_its_module_blocks(self) -> None:
        guard = os.path.join(self.copy("config.py"), "command_guard.py")
        self.assert_blocks(guard, "could not load bash_guard.py")

    def test_a_copy_without_the_shell_code_module_blocks(self) -> None:
        guard = os.path.join(self.copy("config.py", "bash_guard.py"), "command_guard.py")
        self.assert_blocks(guard, "could not load git_safety.py", "git status")

    def test_a_copy_without_its_settings_module_blocks(self) -> None:
        guard = os.path.join(self.copy("bash_guard.py", "git_safety.py"), "command_guard.py")
        self.assert_blocks(guard, "could not load config.py")

    def test_run_by_a_relative_path_it_still_loads_its_module(self) -> None:
        actual, stderr = Guard.run(make_input("git push --force origin main"), str(KAVACH), guard="command_guard.py")
        self.assertEqual(actual, 2, stderr)
        self.assertIn("git push --force", stderr)

    def test_a_check_that_raises_blocks_and_names_the_error(self) -> None:
        self.assert_blocks(self.stub('raise RuntimeError("stand-in bug")'), "RuntimeError: stand-in bug")

    def test_a_check_that_does_not_compile_blocks(self) -> None:
        self.assert_blocks(self.stub("def broken(:"), "SyntaxError")

    def test_a_check_missing_a_module_of_its_own_blocks_and_names_it(self) -> None:
        self.assert_blocks(self.stub("import absent_dependency_of_the_check"), "absent_dependency_of_the_check")

    def test_a_check_that_exits_1_blocks(self) -> None:
        self.assert_blocks(self.stub("import sys\nsys.exit(1)"), "exited with 1 instead of a verdict")

    def test_a_check_that_exits_with_no_code_blocks(self) -> None:
        self.assert_blocks(self.stub("import sys\nsys.exit()"), "exited with None instead of a verdict")

    def test_a_check_that_exits_2_0_blocks(self) -> None:
        # Python would exit 1 for 2.0: only the integers 0 and 2 are verdicts.
        self.assert_blocks(self.stub("import sys\nsys.exit(2.0)"), "exited with 2.0 instead of a verdict")

    def test_a_check_that_ends_without_exiting_blocks(self) -> None:
        self.assert_blocks(self.stub("verdict = None"), "finished without a verdict")

    def test_a_check_interrupted_mid_run_blocks(self) -> None:
        self.assert_blocks(self.stub("raise KeyboardInterrupt"), "KeyboardInterrupt")

    def test_a_check_that_allows_still_allows(self) -> None:
        guard = self.stub("import sys\nsys.exit(0)")
        actual, stderr = Guard.run(make_input("ls"), PLAIN_REPO, guard=guard)
        self.assertEqual(actual, 0, stderr)

    def test_the_shell_code_check_failing_blocks(self) -> None:
        directory = self.copy("config.py", "bash_guard.py")
        Path(directory, "git_safety.py").write_text("def hook_main(settings, fired=None):\n    raise ValueError('x')\n")
        self.assert_blocks(os.path.join(directory, "command_guard.py"), "the shell-code check failed (ValueError: x)", "git status")

    def test_files_in_the_cwd_do_not_stand_in_for_the_modules(self) -> None:
        planted = tempfile.mkdtemp(dir=WORK)
        self.addCleanup(shutil.rmtree, planted, True)
        for name in ("bash_guard.py", "git_safety.py", "config.py", "json.py", "re.py"):
            Path(planted, name).write_text("import sys\nsys.exit(0)\n")
        fixture("git init -q .", planted)
        actual, stderr = Guard.run(make_input("git push --force origin main"), planted)
        self.assertEqual(actual, 2, stderr)
        self.assertIn("git push --force", stderr)

    def test_isolated_mode_still_finds_the_modules(self) -> None:
        actual, stderr = Guard.run(make_input("git push --force origin main"), PLAIN_REPO, python_flags=("-I",))
        self.assertEqual(actual, 2, stderr)
        self.assertIn("git push --force", stderr)
        actual, stderr = Guard.run(make_input("git status"), PLAIN_REPO, python_flags=("-I",))
        self.assertEqual(actual, 0, stderr)


class HookInput(unittest.TestCase):
    """Input the guard cannot read blocks. The input reaches Python on stdin,
    not in its environment, where Linux caps one string at 128 KiB and macOS
    all of exec's strings at about 1 MiB; over the cap the exec failed and
    the command ran unjudged."""

    BIG_WORD = "a" * 1_200_000

    def setUp(self) -> None:
        self.case = Case(self)

    def test_a_1_2_mb_command_reaches_both_checks_and_is_allowed(self) -> None:
        self.case.raw(0, "big echo", "", json.dumps({"tool_input": {"command": "echo " + self.BIG_WORD}}))

    def test_a_force_push_in_a_1_2_mb_command_blocked(self) -> None:
        command = "git push --force origin HEAD # " + self.BIG_WORD
        self.case.raw(2, "big force push", "", json.dumps({"tool_input": {"command": command}}))

    def test_a_plain_push_in_a_1_2_mb_command_reads_its_config_and_is_allowed(self) -> None:
        # Neither check hands the input on to the git it starts, which over
        # the cap would not start: the push's configuration is read, not
        # refused unread.
        repo = tempfile.mkdtemp(dir=WORK)
        self.addCleanup(shutil.rmtree, repo, True)
        fixture("git init -q . && git remote add origin https://example.com/x.git", repo)
        command = "git push origin main # " + self.BIG_WORD
        self.case.raw(0, "big plain push", "", json.dumps({"tool_input": {"command": command}}), cwd=repo)

    def test_hook_input_that_is_not_utf8_blocks_as_unreadable(self) -> None:
        self.case.raw(2, "not UTF-8", "could not read a command in its hook input", b"not json \xff")

    def test_a_harmless_command_holding_a_byte_that_is_not_utf8_allowed(self) -> None:
        # The byte survives into os.environ (surrogate escapes encode back
        # losslessly), so a command holding one is judged like any other.
        self.case.raw(0, "harmless byte", "", b'{"tool_input": {"command": "echo \xff"}}')

    def test_a_force_push_holding_a_byte_that_is_not_utf8_blocked(self) -> None:
        self.case.raw(2, "force push byte", "", b'{"tool_input": {"command": "git push --force origin HEAD # \xff"}}')

    def test_a_command_that_is_not_a_string_blocks(self) -> None:
        self.case.raw(2, "command 5", "could not read a command in its hook input", '{"tool_input": {"command": 5}}')


class Settings(unittest.TestCase):
    """KAVACH_CONFIG: no settings turn every consumer rule off; settings that
    cannot be read refuse; other settings change what is protected."""

    def write(self, document: object) -> str:
        directory = tempfile.mkdtemp(dir=WORK)
        self.addCleanup(shutil.rmtree, directory, True)
        path = os.path.join(directory, "settings.json")
        Path(path).write_text(document if isinstance(document, str) else json.dumps(document), encoding="utf-8")
        return path

    def schema_only(self, extra: str = "") -> str:
        """A repository with the schema staged alone (plus `extra` setup)."""
        repo = tempfile.mkdtemp(dir=WORK)
        self.addCleanup(shutil.rmtree, repo, True)
        fixture(
            'git init -q . && mkdir -p db && echo x > db/schema.sql && git add db/schema.sql && eval "$1"', repo, extra
        )
        return repo

    def run_guard(self, command: str, cwd: str, config: str) -> tuple[int, str]:
        return Guard.run(make_input(command), cwd, config=config)

    def test_without_settings_a_protected_variable_may_be_set(self) -> None:
        for command in ("HOSTED_REMOTE=true pnpm test", "export HOSTED_ENTRYPOINT=remote"):
            actual, stderr = self.run_guard(command, PLAIN_REPO, "")
            self.assertEqual(actual, 0, stderr)

    def test_with_settings_a_protected_variable_is_refused_with_its_reason(self) -> None:
        actual, stderr = self.run_guard("export HOSTED_REMOTE=true", PLAIN_REPO, Guard.config_path)
        self.assertEqual(actual, 2, stderr)
        self.assertIn("HOSTED_REMOTE or HOSTED_ENTRYPOINT", stderr)
        self.assertIn("they mark a hosted session; leave them as the session set them", stderr)

    def test_only_the_configured_variables_are_protected(self) -> None:
        config = self.write({"command": {"protectedVariables": ["OTHER_MARK"], "protectedVariablesReason": "r"}})
        self.assertEqual(self.run_guard("export HOSTED_REMOTE=true", PLAIN_REPO, config)[0], 0)
        actual, stderr = self.run_guard("env OTHER_MARK=1 true", PLAIN_REPO, config)
        self.assertEqual(actual, 2, stderr)
        self.assertIn("OTHER_MARK", stderr)

    def test_without_settings_a_schema_only_commit_is_allowed(self) -> None:
        for command in ("git commit -m x", "env -C . git commit -m x", "git add -A && git commit -m x"):
            actual, stderr = self.run_guard(command, self.schema_only(), "")
            self.assertEqual(actual, 0, f"{command}: {stderr}")

    def test_with_settings_a_schema_only_commit_is_refused_with_its_reason(self) -> None:
        actual, stderr = self.run_guard("git commit -m x", self.schema_only(), Guard.config_path)
        self.assertEqual(actual, 2, stderr)
        self.assertIn(PAIRED_REFUSAL, stderr)
        self.assertIn("a schema change needs its changeset", stderr)

    def test_without_settings_nothing_reads_a_commits_repository(self) -> None:
        # Each of these is refused with the paired-change rule on, for a
        # repository it cannot read; with the rule off only the options count.
        for command in (
            "cd $REPO && git commit -m x",
            "git -C $REPO commit -m x",
            "git -C /definitely/not/here commit -m x",
            "git commit --pathspec-from-file=list.txt -m x",
            "env -C missing git commit -m s",
            "env -C / git commit -m s",
        ):
            actual, stderr = self.run_guard(command, PLAIN_REPO, "")
            self.assertEqual(actual, 0, f"{command}: {stderr}")
            self.assertEqual(self.run_guard(command, PLAIN_REPO, Guard.config_path)[0], 2, command)

    def test_without_settings_hook_bypasses_and_force_pushes_are_still_refused(self) -> None:
        for command in (
            "git -C $REPO commit -n -m x",
            "git -C /tmp commit -an -m x",
            "git commit --no-verify -m x",
            "git push --force origin main",
            "git -c core.hooksPath=/dev/null commit -m x",
            "git commit -m 'unterminated",
        ):
            actual, stderr = self.run_guard(command, PLAIN_REPO, "")
            self.assertEqual(actual, 2, f"{command}: {stderr}")

    def test_every_paired_change_is_judged(self) -> None:
        config = self.write(
            {
                "command": {
                    "pairedChanges": [
                        {"changes": "schema.sql", "requires": "changesets/", "reason": "first reason"},
                        {"changes": "api.yaml", "requires": "clients/", "reason": "second reason"},
                    ]
                }
            }
        )
        repo = self.schema_only("mkdir -p db/changesets/1 && echo y > db/changesets/1/a.sql && git add db")
        self.assertEqual(self.run_guard("git commit -m x", repo, config)[0], 0)
        fixture("echo z > api.yaml && git add api.yaml", repo)
        actual, stderr = self.run_guard("git commit -m x", repo, config)
        self.assertEqual(actual, 2, stderr)
        self.assertIn("'api.yaml' is staged without a path containing 'clients/': second reason", stderr)
        fixture("mkdir -p clients && echo c > clients/c.ts && git add clients", repo)
        self.assertEqual(self.run_guard("git commit -m x", repo, config)[0], 0)

    def test_an_index_writer_marks_every_paired_change_it_may_stage(self) -> None:
        config = self.write(
            {
                "command": {
                    "pairedChanges": [
                        {"changes": "schema.sql", "requires": "changesets/", "reason": "first reason"},
                        {"changes": "api.yaml", "requires": "clients/", "reason": "second reason"},
                    ]
                }
            }
        )
        repo = tempfile.mkdtemp(dir=WORK)
        self.addCleanup(shutil.rmtree, repo, True)
        fixture("git init -q . && echo base > README && git add README && git commit -qm base", repo)
        # A stash pop may stage anything: both paired changes count as staged.
        actual, stderr = self.run_guard("git stash pop && git commit -m x", repo, config)
        self.assertEqual(actual, 2, stderr)
        self.assertIn("first reason", stderr)
        # An unresolvable repository's writer marks them too.
        actual, stderr = self.run_guard("git -C $X merge y && git commit -m x", repo, config)
        self.assertEqual(actual, 2, stderr)
        self.assertIn("first reason", stderr)

    def test_settings_that_cannot_be_read_refuse(self) -> None:
        for document, text in (
            ({"command": {"unknownKey": 1}}, "unknown key"),
            ("not json", "is not JSON"),
            ({"command": {"pairedChanges": [{"changes": "a"}]}}, "requires must be a non-empty string"),
        ):
            actual, stderr = self.run_guard("ls", PLAIN_REPO, self.write(document))
            self.assertEqual(actual, 2, stderr)
            self.assertIn("unusable settings", stderr)
            self.assertIn(text, stderr)
        actual, stderr = self.run_guard("ls", PLAIN_REPO, os.path.join(WORK, "absent.json"))
        self.assertEqual(actual, 2, stderr)
        self.assertIn("cannot be read", stderr)


class ShellCodeCheckDirectly(unittest.TestCase):
    """git_safety.check with and without paired changes, for a commit moved
    by `env -C`, which only this module follows."""

    def test_env_chdir_commit_follows_the_paired_changes_it_is_given(self) -> None:
        repo = tempfile.mkdtemp(dir=WORK)
        self.addCleanup(shutil.rmtree, repo, True)
        fixture(
            "git init -q . && git init -q sub && mkdir -p sub/db && echo x > sub/db/schema.sql"
            " && git -C sub add db/schema.sql",
            repo,
        )
        pair = type("Pair", (), {"changes": "schema.sql", "requires": "changesets/", "reason": "r"})()
        saved = os.environ.copy()
        os.environ.clear()
        os.environ.update(BASE_ENV)
        try:
            self.assertIsNone(git_safety.check("env -C sub git commit -m s", repo))
            reason = git_safety.check("env -C sub git commit -m s", repo, paired_changes=[pair])
        finally:
            os.environ.clear()
            os.environ.update(saved)
        self.assertIsNotNone(reason)
        self.assertIn("'schema.sql' is staged without a path containing 'changesets/'", reason or "")


if __name__ == "__main__":
    unittest.main()
