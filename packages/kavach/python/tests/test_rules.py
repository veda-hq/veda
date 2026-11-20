"""The rules that hold a lesson (rules.py): what each finds, how its mode is
set, and both guards that run them, end to end as Claude Code runs them."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from kavach import boundary, config, rules

KAVACH = Path(__file__).resolve().parents[1] / "kavach"
COMMAND_GUARD = KAVACH / "command_guard.py"
TOOL_GUARD = KAVACH / "tool_guard.py"

ENV = {
    key: value
    for key, value in os.environ.items()
    if not key.startswith("GIT_") and key not in ("CDPATH", "KAVACH_CONFIG", "HOOK_INPUT", "KAVACH_REFUSAL_LOG_OFF")
}
ENV.update(GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")

LONG_REF = (
    "This body line runs well past the hundred characters that commitlint allows a footer line, and it names #3606 too."
)
assert len(LONG_REF) > 100


def git(cwd: str, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, env=ENV, check=True, capture_output=True)


class Repo(unittest.TestCase):
    """A repository with one committed file, `a.txt`, and a folder beside it."""

    def setUp(self) -> None:
        self.work = os.path.realpath(tempfile.mkdtemp(prefix="kavach-rules-"))
        self.addCleanup(shutil.rmtree, self.work, True)
        self.repo = os.path.join(self.work, "repo")
        os.mkdir(self.repo)
        git(self.repo, "init", "-q", ".")
        git(self.repo, "config", "user.email", "t@example.com")
        git(self.repo, "config", "user.name", "t")
        Path(self.repo, "a.txt").write_text("one\n", encoding="utf-8")
        Path(self.repo, "b.txt").write_text("one\n", encoding="utf-8")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "init")
        os.mkdir(os.path.join(self.work, "elsewhere"))

    def bash(self, command: str, cwd: str | None = None) -> rules.Call:
        return rules.Call("Bash", {"command": command}, cwd or self.repo)


class PipeMasksExit(unittest.TestCase):
    def find(self, command: str) -> str | None:
        return rules.pipe_masks_exit(rules.Call("Bash", {"command": command}, "/"))

    def test_a_pipe_into_tail_or_head_before_a_push_fires(self) -> None:
        for command in (
            "pnpm test | tail -5 && git push",
            "pnpm -r check 2>&1 | head -n 3 && git push origin HEAD",
            "make | tail && echo ok && git -C . push",
            "pnpm test | tail -5 && git --attr-source HEAD push",
            "pnpm test | tail -5 && git --config-env x=Y push",
        ):
            with self.subTest(command=command):
                self.assertIn("pushes even when the command before the pipe failed", self.find(command) or "")

    def test_other_shapes_pass(self) -> None:
        for command in (
            "pnpm test | tail -5; git push",
            "pnpm test && git push",
            "set -o pipefail; pnpm test | tail -5 && git push",
            "pnpm test | grep ok && git push",
            "git log | head -3 && git status",
            "git push | tail -1",
            "git push",
        ):
            with self.subTest(command=command):
                self.assertIsNone(self.find(command))


class CdOutOfWorktree(Repo):
    def test_a_cd_or_pushd_out_of_the_checkout_fires(self) -> None:
        elsewhere = os.path.join(self.work, "elsewhere")
        for command in (f"cd {elsewhere} && ls", f"pushd {elsewhere}", "cd ..", "cd sub && cd ../..", "cd"):
            with self.subTest(command=command):
                found = rules.cd_out_of_worktree(self.bash(command))
                self.assertIn("outside this session's checkout", found or "")
                self.assertIn(self.repo, found or "")

    def test_moves_inside_or_that_do_not_last_pass(self) -> None:
        os.mkdir(os.path.join(self.repo, "sub"))
        for command in (
            "cd sub && ls",
            "cd sub && cd ..",
            f"(cd {self.work} && ls)",
            f"cd {self.work} | cat",
            "cd -",
            "cd $HOME",
            "pushd +1",
            "ls ..",
            f"git -C {self.work} status",
        ):
            with self.subTest(command=command):
                self.assertIsNone(rules.cd_out_of_worktree(self.bash(command)))

    def test_a_clone_nested_in_the_checkout_counts_as_inside_it(self) -> None:
        nested = os.path.join(self.repo, "nested")
        os.mkdir(nested)
        git(nested, "init", "-q", ".")
        self.assertEqual(rules.session_checkout(nested), self.repo)
        self.assertIsNone(rules.cd_out_of_worktree(self.bash(f"cd {self.repo}", nested)))

    def test_a_peer_worktree_is_named(self) -> None:
        peer = os.path.join(self.work, "peer")
        git(self.repo, "worktree", "add", "-q", peer)
        found = rules.cd_out_of_worktree(self.bash(f"cd {peer}"))
        self.assertIn(f"another worktree, {peer}, which another session may own", found or "")
        # From the linked worktree, the main checkout is outside it too.
        found = rules.cd_out_of_worktree(self.bash(f"cd {self.repo}", peer))
        self.assertIn("another worktree", found or "")

    def test_only_a_folder_in_no_repository_refuses_whatever_the_mode(self) -> None:
        other = os.path.join(self.work, "other")
        os.mkdir(other)
        git(other, "init", "-q", ".")
        peer = os.path.join(self.work, "peer")
        git(self.repo, "worktree", "add", "-q", peer)
        elsewhere = os.path.join(self.work, "elsewhere")
        for command, refuses in (
            (f"cd {elsewhere}", True),
            (f"pushd {elsewhere}", True),
            ("cd ..", True),
            (f"cd {other}", False),
            (f"cd {peer}", False),
            # A folder that is not there: the `cd` fails and the shell stays.
            (f"cd {os.path.join(self.work, 'missing')}", False),
        ):
            with self.subTest(command=command):
                found = rules.cd_out_of_worktree(self.bash(command))
                self.assertIsNotNone(found)
                self.assertIs(isinstance(found, rules.Refuses), refuses)
                self.assertIs("in no git repository" in (found or ""), refuses)
        found = rules.cd_out_of_worktree(self.bash(f"cd {other}"))
        self.assertIn(f"until `cd {self.repo}` brings it back", found or "")
        self.assertNotIn("the `cd` back included", found or "")

    def test_judge_files_a_refusing_finding_with_the_refusals(self) -> None:
        settings = config.parse({"rules": {"cd-out-of-worktree": "warn"}})
        fires: list[tuple[str, str, str]] = []
        call = self.bash(f"cd {os.path.join(self.work, 'elsewhere')}")
        outcome = rules.judge(call, settings, lambda *fire: fires.append(fire))
        self.assertEqual([fire.mode for fire in outcome.refusals], ["refuse"])
        self.assertEqual(outcome.warnings, [])
        self.assertEqual([(rule, mode) for rule, mode, _ in fires], [("cd-out-of-worktree", "refuse")])

    def test_outside_any_checkout_nothing_is_judged(self) -> None:
        self.assertIsNone(rules.cd_out_of_worktree(self.bash("cd /", os.path.join(self.work, "elsewhere"))))

    def test_git_that_cannot_run_is_no_checkout(self) -> None:
        with mock.patch.object(rules.subprocess, "run", side_effect=OSError("no git")):
            self.assertIsNone(rules.git_toplevel(self.repo))
            self.assertIsNone(rules.peer_worktree("/x", self.repo))


class StrykerInPlace(unittest.TestCase):
    def find(self, command: str) -> str | None:
        return rules.stryker_inplace(rules.Call("Bash", {"command": command}, "/"))

    def test_in_place_runs_fire(self) -> None:
        for command in (
            "pnpm exec stryker run --inPlace",
            "npx stryker run stryker.config.mjs --inPlace --mutate src/a.ts",
            "node_modules/.bin/stryker run --inPlace=true",
        ):
            with self.subTest(command=command):
                self.assertIn("--inPlace mutates your real files", self.find(command) or "")

    def test_sandboxed_runs_pass(self) -> None:
        for command in (
            "pnpm exec stryker run",
            "pnpm exec stryker run --inPlace=false",
            "grep inPlace stryker.config.mjs",
            "echo stryker --inPlace",
        ):
            with self.subTest(command=command):
                self.assertIsNone(self.find(command))


class StrykerConfigInPlace(unittest.TestCase):
    def find(self, tool: str, tool_input: dict[str, object]) -> str | None:
        return rules.stryker_inplace(rules.Call(tool, tool_input, "/"))

    def test_a_config_written_with_in_place_fires(self) -> None:
        for tool, tool_input in (
            ("Write", {"file_path": "/r/stryker.config.mjs", "content": "export default { inPlace: true };"}),
            ("Write", {"file_path": "/r/stryker.conf.json", "content": '{"inPlace": true}'}),
            ("Edit", {"file_path": "/r/apps/m/stryker.mobile.config.ts", "old_string": "x", "new_string": "inPlace : true,"}),
            ("MultiEdit", {"file_path": "/r/stryker.config.cjs", "edits": [{"new_string": "a"}, {"new_string": "'inPlace': true"}]}),
        ):
            with self.subTest(tool_input=tool_input):
                self.assertIn("sets `inPlace: true`", self.find(tool, tool_input) or "")

    def test_other_writes_pass(self) -> None:
        for tool, tool_input in (
            ("Write", {"file_path": "/r/stryker.config.mjs", "content": "export default { inPlace: false };"}),
            ("Write", {"file_path": "/r/notes.md", "content": "inPlace: true"}),
            ("Write", {"file_path": 3}),
            ("MultiEdit", {"file_path": "/r/stryker.config.mjs", "edits": "x"}),
            ("Edit", {"file_path": "/r/stryker.config.mjs", "new_string": "mutate: []"}),
        ):
            with self.subTest(tool_input=tool_input):
                self.assertIsNone(self.find(tool, tool_input))


class CheckoutDiscardsUncommitted(Repo):
    def setUp(self) -> None:
        super().setUp()
        Path(self.repo, "a.txt").write_text("changed\n", encoding="utf-8")

    def test_overwriting_a_changed_path_fires(self) -> None:
        for command, cwd in (
            ("git checkout -- a.txt", self.repo),
            ("git checkout HEAD -- a.txt b.txt", self.repo),
            ("git checkout --theirs a.txt", self.repo),
            ("git restore a.txt", self.repo),
            ("git restore --source HEAD~0 a.txt", self.repo),
            ("git restore --staged --worktree a.txt", self.repo),
            ("git checkout -- .", self.repo),
            (f"cd {self.repo} && git restore a.txt", self.work),
            (f"git -C {self.repo} restore a.txt", self.work),
        ):
            with self.subTest(command=command):
                found = rules.checkout_discards_uncommitted(self.bash(command, cwd))
                self.assertIn("a.txt holds uncommitted changes", found or "")

    def test_clean_paths_and_other_forms_pass(self) -> None:
        for command in (
            "git checkout -- b.txt",
            "git restore b.txt",
            "git restore --staged a.txt",
            "git checkout main",
            "git checkout -b topic",
            'git restore "$FILE"',
            "git status",
        ):
            with self.subTest(command=command):
                self.assertIsNone(rules.checkout_discards_uncommitted(self.bash(command)))

    def test_a_failing_status_is_an_error(self) -> None:
        with self.assertRaises(RuntimeError):
            rules.uncommitted(["a.txt"], os.path.join(self.work, "elsewhere"))


class CommitBodyRefLineLength(Repo):
    def find(self, command: str) -> str | None:
        return rules.commit_body_ref_line_length(self.bash(command))

    def test_a_long_body_line_with_a_reference_fires(self) -> None:
        Path(self.repo, "message.txt").write_text(f"fix: title\n\n{LONG_REF}\n", encoding="utf-8")
        for command in (
            f'git commit -m "fix: title" -m "{LONG_REF}"',
            f'git commit -am "fix: title" -m "{LONG_REF}"',
            f'git commit --message="fix: title" --message "{LONG_REF}"',
            f"git commit -m 'fix: title\n\nshort\n{LONG_REF}'",
            "git commit -F message.txt",
            "git commit --file=message.txt",
            "git commit -qF message.txt",
        ):
            with self.subTest(command=command):
                found = self.find(command)
                self.assertIn("holding `#3606`", found or "")
                self.assertIn(f"{len(LONG_REF)} characters", found or "")

    def test_other_messages_pass(self) -> None:
        Path(self.repo, "comment.txt").write_text(f"fix: title\n\n# {LONG_REF}\n", encoding="utf-8")
        for command in (
            f'git commit -m "{LONG_REF}"',  # the title is the header, not a footer
            'git commit -m "fix: title" -m "short line, #3606"',
            f'git commit -m "fix: title" -m "{LONG_REF.replace("#", "no. ")}"',
            "git commit -F comment.txt",
            "git commit -F missing.txt",
            "git commit -F -",
            'git commit -m "$MESSAGE"',
            "git commit -m",
            "git commit --amend --no-edit",
            "git log -1",
        ):
            with self.subTest(command=command):
                self.assertIsNone(self.find(command))


class CaseFoldPathCollision(Repo):
    def write(self, path: str) -> str | None:
        return rules.case_fold_path_collision(rules.Call("Write", {"file_path": path, "content": "x"}, self.repo))

    def test_a_name_that_differs_only_by_case_fires(self) -> None:
        for path in (os.path.join(self.repo, "A.txt"), "A.txt"):
            with self.subTest(path=path):
                self.assertIn("A.txt differs only by letter case from a.txt", self.write(path) or "")

    def test_the_same_name_a_new_name_or_a_new_folder_passes(self) -> None:
        for path in (os.path.join(self.repo, "a.txt"), "c.txt", os.path.join(self.repo, "new", "A.txt"), ""):
            with self.subTest(path=path):
                self.assertIsNone(self.write(path))
        self.assertIsNone(rules.case_fold_path_collision(rules.Call("Write", {"file_path": 3}, self.repo)))


class RoutineSourcesShape(unittest.TestCase):
    def find(self, tool_input: dict[str, object]) -> str | None:
        return rules.routine_sources_shape(rules.Call("RemoteTrigger", tool_input, "/"))

    @staticmethod
    def body(sources: object) -> dict[str, object]:
        return {"job_config": {"ccr": {"session_context": {"sources": sources}}}}

    def test_a_source_without_its_git_repository_object_fires(self) -> None:
        for sources in ([{"type": "git_repository", "url": "u"}], [{"git_repository": {"url": "u"}}, "u"]):
            with self.subTest(sources=sources):
                found = self.find({"action": "create", "body": self.body(sources)})
                self.assertIn("has no `git_repository` object", found or "")
        self.assertIsNotNone(self.find({"action": "update", "body": self.body([{"git_repository": "u"}])}))

    def test_the_documented_shape_and_other_calls_pass(self) -> None:
        for tool_input in (
            {"action": "create", "body": self.body([{"git_repository": {"url": "u"}}])},
            {"action": "create", "body": self.body([])},
            {"action": "create", "body": {"job_config": {"ccr": {}}}},
            {"action": "create", "body": {"job_config": "x"}},
            {"action": "create", "body": self.body("u")},
            {"action": "list"},
            {"action": "run", "body": self.body(["u"])},
        ):
            with self.subTest(tool_input=tool_input):
                self.assertIsNone(self.find(tool_input))


class SyncBaseOnOrigin(Repo):
    def setUp(self) -> None:
        super().setUp()
        self.origin = os.path.join(self.work, "origin.git")
        git(self.work, "init", "-q", "--bare", self.origin)
        git(self.repo, "remote", "add", "origin", self.origin)
        git(self.repo, "push", "-q", "origin", "HEAD:refs/heads/main")
        git(self.repo, "fetch", "-q", "origin")

    def find(self, tool_input: dict[str, object], cwd: str | None = None) -> str | None:
        return rules.sync_base_on_origin(rules.Call(rules.SYNC_TOOL, tool_input, cwd or self.repo))

    def test_no_base_or_a_base_origin_lacks_fires(self) -> None:
        self.assertIn("with no `base` merges the branch", self.find({}) or "")
        self.assertIn("with no `base`", self.find({"base": ""}) or "")
        found = self.find({"base": "claude/gone"})
        self.assertIn('`base: "claude/gone"` names no branch this checkout knows on origin', found or "")

    def test_a_base_on_origin_passes(self) -> None:
        for base in ("main", "origin/main"):
            with self.subTest(base=base):
                self.assertIsNone(self.find({"base": base}))
        self.assertIsNone(self.find({"base": 3}))
        self.assertIsNone(self.find({"base": "x"}, os.path.join(self.work, "elsewhere")))


class WorkflowNameInWorktree(Repo):
    def setUp(self) -> None:
        super().setUp()
        flows = Path(self.repo, ".claude", "workflows")
        flows.mkdir(parents=True)
        (flows / "pipeline.js").write_text("main\n", encoding="utf-8")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "flows")
        self.peer = os.path.join(self.work, "peer")
        git(self.repo, "worktree", "add", "-q", self.peer)

    def find(self, tool_input: dict[str, object], cwd: str | None = None) -> str | None:
        return rules.workflow_name_in_worktree(rules.Call("Workflow", tool_input, cwd or self.peer))

    def test_a_name_whose_worktree_copy_differs_fires(self) -> None:
        Path(self.peer, ".claude", "workflows", "pipeline.js").write_text("branch\n", encoding="utf-8")
        found = self.find({"name": "pipeline", "args": {}})
        self.assertIn(f"runs the main checkout's copy in {self.repo}", found or "")
        self.assertIn(os.path.join(self.peer, ".claude", "workflows", "pipeline.js"), found or "")
        Path(self.peer, ".claude", "workflows", "only-here.js").write_text("x\n", encoding="utf-8")
        self.assertIsNotNone(self.find({"name": "only-here"}))

    def test_the_same_copy_a_script_path_or_the_main_checkout_passes(self) -> None:
        self.assertIsNone(self.find({"name": "pipeline"}))
        Path(self.peer, ".claude", "workflows", "pipeline.js").write_text("branch\n", encoding="utf-8")
        self.assertIsNone(self.find({"name": "pipeline", "scriptPath": "/abs/pipeline.js"}))
        self.assertIsNone(self.find({"name": "pipeline"}, self.repo))
        self.assertIsNone(self.find({"name": "absent"}))
        self.assertIsNone(self.find({}))
        self.assertIsNone(self.find({"name": "pipeline"}, os.path.join(self.work, "elsewhere")))

    def test_unreadable_workflow_folders_and_git_are_nothing(self) -> None:
        self.assertEqual(rules.workflow_files(os.path.join(self.work, "elsewhere"), "pipeline"), {})
        os.mkdir(os.path.join(self.repo, ".claude", "workflows", "pipeline.d"))
        self.assertEqual(list(rules.workflow_files(self.repo, "pipeline")), ["pipeline.js"])
        self.assertIsNone(rules.main_checkout(os.path.join(self.work, "elsewhere")))


class Settings(unittest.TestCase):
    def test_every_rule_warns_unless_named(self) -> None:
        self.assertEqual(config.parse({}).rules, ())
        self.assertEqual(rules.mode_of(config.DEFAULT, "pipe-masks-exit"), ("warn", ""))

    def test_a_rule_is_named_by_its_mode_or_an_object(self) -> None:
        loaded = config.parse(
            {"rules": {"pipe-masks-exit": "refuse", "stryker-inplace": {"mode": "warn", "refusesFrom": "2026-11-23"}}}
        )
        self.assertEqual(rules.mode_of(loaded, "pipe-masks-exit"), ("refuse", ""))
        self.assertEqual(rules.mode_of(loaded, "stryker-inplace"), ("warn", "2026-11-23"))

    def test_the_shell_expansion_rule_can_be_named_here(self) -> None:
        loaded = config.parse({"rules": {config.SHELL_EXPANSION_RULE: {"mode": "refuse", "refusesFrom": "2026-11-21"}}})
        self.assertEqual((loaded.shell_expansion, loaded.shell_expansion_refuses_from), ("refuse", "2026-11-21"))
        with self.assertRaises(config.ConfigError) as raised:
            config.parse({"rules": {config.SHELL_EXPANSION_RULE: "refuse"}, "command": {"shellExpansion": "refuse"}})
        self.assertIn("name the same rule: keep one", str(raised.exception))

    def test_bad_entries_are_refused(self) -> None:
        for document, text in (
            ({"rules": []}, "rules must be a JSON object"),
            ({"rules": {"no-such-rule": "warn"}}, "rules has unknown key(s): no-such-rule"),
            ({"rules": {"pipe-masks-exit": "off"}}, "rules.pipe-masks-exit.mode must be one of warn, refuse"),
            ({"rules": {"pipe-masks-exit": {"mode": "refuse", "when": 1}}}, "unknown key(s): when"),
            ({"rules": {"pipe-masks-exit": {"mode": "warn", "refusesFrom": "soon"}}}, "must be a day, YYYY-MM-DD"),
        ):
            with self.subTest(document=document):
                with self.assertRaises(config.ConfigError) as raised:
                    config.parse(document)
                self.assertIn(text, str(raised.exception))

    def test_the_known_ids_are_the_rules(self) -> None:
        self.assertEqual(
            set(config.RULE_IDS), {rule.id for rule in rules.RULES} | {config.SHELL_EXPANSION_RULE}
        )

    def test_the_tool_matcher_names_every_tool_but_bash(self) -> None:
        self.assertEqual(
            rules.TOOL_MATCHER,
            "Write|Edit|MultiEdit|RemoteTrigger|mcp__ccd_host__sync_with_base_branch|Workflow",
        )


class Judging(unittest.TestCase):
    CALL = rules.Call("Bash", {"command": "pnpm test | tail && git push"}, "/")

    def test_warn_and_refuse(self) -> None:
        heard: list[tuple[str, str, str]] = []
        outcome = rules.judge(self.CALL, config.DEFAULT, lambda *fire: heard.append(fire))
        self.assertEqual([fire.rule for fire in outcome.warnings], ["pipe-masks-exit"])
        self.assertEqual(outcome.refusals, [])
        self.assertEqual(heard[0][:2], ("pipe-masks-exit", "warn"))
        refusing = config.parse({"rules": {"pipe-masks-exit": "refuse"}})
        outcome = rules.judge(self.CALL, refusing)
        self.assertEqual([fire.rule for fire in outcome.refusals], ["pipe-masks-exit"])
        self.assertTrue(rules.refusal(outcome.refusals).startswith("BLOCKED: `... | tail && git push`"))

    def test_a_rule_reads_only_its_own_tools(self) -> None:
        call = rules.Call("Write", {"file_path": "/x", "command": "pnpm test | tail && git push"}, "/")
        self.assertEqual(rules.judge(call, config.DEFAULT), rules.Outcome([], []))

    def test_a_failing_detector_allows_while_it_warns_and_raises_once_it_refuses(self) -> None:
        broken = rules.Rule("pipe-masks-exit", ("Bash",), lambda call: 1 / 0)
        with mock.patch.object(rules, "RULES", (broken,)):
            heard: list[tuple[str, str, str]] = []
            self.assertEqual(rules.judge(self.CALL, config.DEFAULT, lambda *fire: heard.append(fire)), rules.Outcome([], []))
            self.assertEqual(heard[0][:2], ("pipe-masks-exit", "warn"))
            self.assertIn("check failed (ZeroDivisionError)", heard[0][2])
            self.assertEqual(rules.judge(self.CALL, config.DEFAULT), rules.Outcome([], []))
            with self.assertRaises(ZeroDivisionError):
                rules.judge(self.CALL, config.parse({"rules": {"pipe-masks-exit": "refuse"}}))

    def test_the_warning_names_its_rule_and_day(self) -> None:
        text = rules.context(rules.Fire("x", "warn", "Why.", "2026-11-23"))
        self.assertEqual(text, "kavach warning, rule x (refuses from 2026-11-23): Why. This call still runs while the rule is on trial.")
        self.assertIn("(refuses after its trial)", rules.context(rules.Fire("x", "warn", "Why.")))

    def test_a_payload_that_is_not_a_tool_call_is_none(self) -> None:
        for raw in ("", "[]", '{"tool_name": 1, "tool_input": {}}', '{"tool_name": "Write", "tool_input": []}'):
            with self.subTest(raw=raw):
                self.assertIsNone(rules.read_call(raw))
        call = rules.read_call('{"tool_name": "Write", "tool_input": {}, "cwd": "relative"}')
        self.assertEqual(call, rules.Call("Write", {}, os.getcwd()))


class Guards(Repo):
    """Both guards as Claude Code runs them, with their refusal-log rows."""

    def settings(self, document: object) -> str:
        path = os.path.join(self.work, "kavach.json")
        Path(path).write_text(json.dumps(document), encoding="utf-8")
        return path

    def run_guard(self, guard: Path, tool: str, tool_input: object, settings: str | None = None, raw: str | None = None) -> subprocess.CompletedProcess[str]:
        env = dict(ENV)
        if settings:
            env["KAVACH_CONFIG"] = settings
        event = raw if raw is not None else json.dumps({"tool_name": tool, "tool_input": tool_input, "cwd": self.repo})
        return subprocess.run(
            [sys.executable, str(guard)], input=event, cwd=self.repo, env=env, capture_output=True, text=True, timeout=120, check=False
        )

    def rows(self) -> list[dict[str, str]]:
        path = Path(self.repo, ".git", "kavach", "refusals.jsonl")
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    def test_the_command_guard_shows_every_warning_in_one_answer(self) -> None:
        command = 'git commit --allow-empty -m "fix `x`" -m "' + LONG_REF + '"'
        result = self.run_guard(COMMAND_GUARD, "Bash", {"command": command})
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        context = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
        first, second = context.split("\n\n")
        self.assertTrue(first.startswith("kavach warning (refuses after its trial): the shell expands"), first)
        self.assertTrue(second.startswith("kavach warning, rule commit-body-ref-line-length"), second)
        self.assertEqual(
            sorted((row["rule"], row["mode"]) for row in self.rows()),
            [("commit-body-ref-line-length", "warn"), ("commit-message-shell-expansion", "warn")],
        )

    def other_repository(self) -> str:
        other = os.path.join(self.work, "other")
        os.mkdir(other)
        git(other, "init", "-q", ".")
        return other

    def test_the_command_guard_warns_on_a_command_with_no_git(self) -> None:
        other = self.other_repository()
        result = self.run_guard(COMMAND_GUARD, "Bash", {"command": f"cd {other}"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("rule cd-out-of-worktree", json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"])

    def test_the_command_guard_refuses_once_told_to(self) -> None:
        other = self.other_repository()
        settings = self.settings({"rules": {"cd-out-of-worktree": "refuse"}})
        result = self.run_guard(COMMAND_GUARD, "Bash", {"command": f"cd {other}"}, settings)
        self.assertEqual((result.returncode, result.stdout), (2, ""))
        self.assertTrue(result.stderr.startswith(f"BLOCKED: `cd {other}` moves the shell"), result.stderr)
        self.assertIn("(kavach rule cd-out-of-worktree)", result.stderr)
        (row,) = self.rows()
        self.assertEqual((row["guard"], row["rule"], row["mode"]), ("command", "cd-out-of-worktree", "refuse"))

    def test_a_cd_to_a_folder_in_no_repository_refuses_on_trial(self) -> None:
        """veda#335: from there the worktree guard runs reads only, so the
        rule refuses whatever its mode, with no setting or a warn one."""

        warn = self.settings({"rules": {"cd-out-of-worktree": {"mode": "warn", "refusesFrom": "2099-01-01"}}})
        for settings in (None, warn):
            with self.subTest(settings=settings):
                result = self.run_guard(COMMAND_GUARD, "Bash", {"command": f"cd {self.work} && cat *.md"}, settings)
                self.assertEqual((result.returncode, result.stdout), (2, ""))
                self.assertEqual(
                    result.stderr,
                    f"BLOCKED: `cd {self.work}` moves the shell outside this session's checkout "
                    f"({self.repo} is this session's), to a folder in no git repository. Where the shell "
                    "keeps that folder for later calls, the guards run only reads from there: no write, "
                    "Edit or Write until a bare `cd` back. This refuses even while the rule is on trial. "
                    "Stay in the checkout: read elsewhere with absolute paths, `git -C <dir>` or `ls <dir>`. "
                    "(kavach rule cd-out-of-worktree)\n",
                )
        modes = [(row["rule"], row["mode"]) for row in self.rows()]
        self.assertEqual(modes, [("cd-out-of-worktree", "refuse")] * 2)

    def test_from_a_folder_in_no_repository_the_cd_back_passes(self) -> None:
        event = json.dumps({"tool_name": "Bash", "tool_input": {"command": f"cd {self.repo}"}, "cwd": self.work})
        result = subprocess.run(
            [sys.executable, str(COMMAND_GUARD)], input=event, cwd=self.work, env=dict(ENV),
            capture_output=True, text=True, timeout=120, check=False,
        )
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_a_clean_command_prints_nothing(self) -> None:
        result = self.run_guard(COMMAND_GUARD, "Bash", {"command": "ls"})
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_the_tool_guard_warns_and_refuses(self) -> None:
        tool_input = {"action": "create", "body": RoutineSourcesShape.body([{"url": "u"}])}
        result = self.run_guard(TOOL_GUARD, "RemoteTrigger", tool_input)
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        self.assertIn("rule routine-sources-shape", json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"])
        settings = self.settings({"rules": {"routine-sources-shape": "refuse"}})
        result = self.run_guard(TOOL_GUARD, "RemoteTrigger", tool_input, settings)
        self.assertEqual((result.returncode, result.stdout), (2, ""))
        self.assertIn("has no `git_repository` object", result.stderr)
        self.assertEqual(
            [(row["guard"], row["rule"], row["mode"]) for row in self.rows()],
            [("tool", "routine-sources-shape", "warn"), ("tool", "routine-sources-shape", "refuse")],
        )

    def test_the_tool_guard_allows_a_clean_call(self) -> None:
        result = self.run_guard(TOOL_GUARD, "Write", {"file_path": os.path.join(self.repo, "c.txt"), "content": "x"})
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_the_tool_guard_fails_closed(self) -> None:
        bad = self.settings({"rules": {"no-such-rule": "warn"}})
        for settings, raw, said in (
            (None, "not json", "got a payload that is not a tool call"),
            (bad, None, "could not load its settings (ConfigError"),
        ):
            with self.subTest(said=said):
                result = self.run_guard(TOOL_GUARD, "Write", {"file_path": "x"}, settings, raw)
                self.assertEqual(result.returncode, 2)
                self.assertTrue(result.stderr.startswith("BLOCKED: the tool guard "), result.stderr)
                self.assertIn(said, result.stderr)

    def test_the_tool_guard_refuses_input_it_cannot_read(self) -> None:
        # Open for writing only, so reading it fails (OSError): a guard that
        # cannot read the call must refuse it, not crash with exit 1, which
        # Claude Code lets through.
        stdin = os.open(os.path.join(self.work, "input"), os.O_WRONLY | os.O_CREAT)
        self.addCleanup(os.close, stdin)
        result = subprocess.run(
            [sys.executable, str(TOOL_GUARD)], stdin=stdin, cwd=self.repo, env=ENV, capture_output=True, text=True, timeout=120, check=False
        )
        self.assertEqual(
            (result.returncode, result.stdout, result.stderr),
            (2, "", "BLOCKED: the tool guard could not read its hook input (OSError), so it cannot judge this call.\n"),
        )

    def test_the_tool_guard_refuses_when_a_module_does_not_load(self) -> None:
        for name, source, said in (
            ("rules.py", None, "could not load rules.py (ModuleNotFoundError)"),
            ("rules.py", "raise RuntimeError('planted')", "could not load rules.py (RuntimeError)"),
            ("refusal_log.py", None, "could not load refusal_log.py (ModuleNotFoundError)"),
            ("refusal_log.py", "raise RuntimeError('planted')", "could not load refusal_log.py (RuntimeError)"),
        ):
            with self.subTest(said=said):
                directory = Path(tempfile.mkdtemp(dir=self.work), "kavach")
                shutil.copytree(KAVACH, directory, ignore=shutil.ignore_patterns("__pycache__"))
                if source is None:
                    (directory / name).unlink()
                else:
                    (directory / name).write_text(source + "\n", encoding="utf-8")
                result = self.run_guard(directory / "tool_guard.py", "Write", {"file_path": os.path.join(self.repo, "c.txt"), "content": "x"})
                self.assertEqual(
                    (result.returncode, result.stdout, result.stderr),
                    (2, "", "BLOCKED: the tool guard %s, so it cannot judge this call.\n" % said),
                )

    def test_a_refusing_rule_that_fails_refuses(self) -> None:
        directory = Path(self.work, "kavach")
        shutil.copytree(KAVACH, directory, ignore=shutil.ignore_patterns("__pycache__"))
        with open(directory / "rules.py", "a", encoding="utf-8") as handle:
            handle.write("\n\ndef routine_sources_shape(call):\n    raise ValueError('planted')\n\n"
                         "RULES = tuple(Rule(r.id, r.tools, routine_sources_shape) if r.id == 'routine-sources-shape' else r for r in RULES)\n")
        tool_input = {"action": "create", "body": RoutineSourcesShape.body([])}
        warned = self.run_guard(directory / "tool_guard.py", "RemoteTrigger", tool_input)
        self.assertEqual((warned.returncode, warned.stdout, warned.stderr), (0, "", ""))
        settings = self.settings({"rules": {"routine-sources-shape": "refuse"}})
        refused = self.run_guard(directory / "tool_guard.py", "RemoteTrigger", tool_input, settings)
        self.assertEqual(refused.returncode, 2)
        self.assertIn("BLOCKED: the tool guard failed (ValueError: planted)", refused.stderr)
        planted_command = self.settings({"rules": {"pipe-masks-exit": "refuse"}})
        with open(directory / "rules.py", "a", encoding="utf-8") as handle:
            handle.write("\n\nRULES = tuple(Rule(r.id, r.tools, routine_sources_shape) for r in RULES)\n")
        refused = self.run_guard(directory / "command_guard.py", "Bash", {"command": "ls"}, planted_command)
        self.assertEqual(refused.returncode, 2)
        self.assertIn("BLOCKED: the lesson rules failed (ValueError: planted)", refused.stderr)


class PnpmSelectedDirectory(unittest.TestCase):
    """`pnpm --filter <one package>` and `--dir` run in that package's folder,
    so the boundary reads what follows the subcommand from there."""

    def setUp(self) -> None:
        self.root = Path(os.path.realpath(tempfile.mkdtemp(prefix="kavach-pnpm-")))
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / "pnpm-workspace.yaml").write_text(
            "packages:\n  - 'apps/*'\n  - \"packages/shared\" # shared\n  - tools/x\nother: 1\n", encoding="utf-8"
        )
        for folder, name in (("apps/server", "@acme/server"), ("apps/web", "web"), ("packages/shared", "@acme/shared"), ("apps/twin", "@other/web")):
            (self.root / folder).mkdir(parents=True)
            (self.root / folder / "package.json").write_text(json.dumps({"name": name}), encoding="utf-8")
        (self.root / "apps" / "loose").mkdir()

    def selected(self, line: str) -> Path | None:
        found = boundary.pnpm_selected_directory(line.split()[1:], self.root)
        return None if found is None else found[0]

    def test_one_package_or_folder_is_selected(self) -> None:
        server = self.root / "apps" / "server"
        for line in (
            "pnpm --filter server exec tsx ../../.tmp/x.ts",
            "pnpm -F @acme/server exec tsx x.ts",
            "pnpm --filter=server run build",
            "pnpm --filter ./apps/server exec tsx x.ts",
            "pnpm --filter {./apps/server} exec tsx x.ts",
            "pnpm --dir apps/server exec tsx x.ts",
            "pnpm -C apps/server run x",
            "pnpm --dir=apps/server exec tsx x.ts",
        ):
            with self.subTest(line=line):
                self.assertEqual(self.selected(line), server)
        self.assertEqual(self.selected("pnpm --filter shared exec x"), self.root / "packages" / "shared")

    def test_anything_less_certain_selects_nothing(self) -> None:
        for line in (
            "pnpm exec tsx x.ts",
            "pnpm --filter '@acme/*' exec x",
            "pnpm --filter server... exec x",
            "pnpm --filter server --filter web exec x",
            "pnpm -r --filter server exec x",
            "pnpm --filter missing exec x",
            "pnpm --filter ./apps/loose exec x",
            "pnpm --dir apps/missing exec x",
            "pnpm --dir $DIR exec x",
            "pnpm --filter server add x",
            "pnpm --filter",
            "pnpm --filter server",
        ):
            with self.subTest(line=line):
                self.assertIsNone(self.selected(line))
        # `web` and `@other/web`: the exact name wins, as in pnpm.
        self.assertEqual(self.selected("pnpm --filter web exec x"), self.root / "apps" / "web")

    def test_a_scope_less_name_must_be_unique(self) -> None:
        (self.root / "apps" / "web2").mkdir()
        (self.root / "apps" / "web2" / "package.json").write_text(json.dumps({"name": "@third/twin"}), encoding="utf-8")
        (self.root / "apps" / "web3").mkdir()
        (self.root / "apps" / "web3" / "package.json").write_text(json.dumps({"name": "@fourth/twin"}), encoding="utf-8")
        self.assertIsNone(self.selected("pnpm --filter twin exec x"))

    def test_patterns_it_does_not_follow_select_nothing(self) -> None:
        for listing in ("packages:\n  - 'apps/**'\n", "packages:\n  - '!apps/web'\n", "packages:\n  - 'a*/server'\n", "packages:\n  - 'ap?s'\n"):
            with self.subTest(listing=listing):
                (self.root / "pnpm-workspace.yaml").write_text(listing, encoding="utf-8")
                self.assertIsNone(self.selected("pnpm --filter server exec x"))
        (self.root / "pnpm-workspace.yaml").unlink()
        self.assertIsNone(self.selected("pnpm --filter server exec x"))

    def test_the_boundary_reads_operands_from_the_package_and_still_refuses_an_escape(self) -> None:
        server = self.root / "apps" / "server"
        inside = boundary.generic_mutation_paths("pnpm", "--filter server exec tsx ../../.tmp/x.ts".split(), self.root)
        self.assertEqual(inside, [self.root / ".tmp" / "x.ts"])
        escape = boundary.generic_mutation_paths("pnpm", "--filter server exec touch ../../../outside".split(), self.root)
        self.assertEqual(escape, [self.root.parent / "outside"])
        selector = boundary.generic_mutation_paths("pnpm", "--dir apps/server exec tsx x.ts".split(), self.root)
        self.assertEqual(selector, [server])
        unread = boundary.generic_mutation_paths("pnpm", ["--filter", "server", "exec", "tsx", "$X/y"], self.root)
        self.assertIsNone(unread)


if __name__ == "__main__":
    unittest.main()
