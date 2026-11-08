"""Every branch of ``config.py``: what loads, and every shape it refuses."""

from __future__ import annotations

import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from kavach import config


class LoadTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def write(self, text: str) -> str:
        path = self.directory / "kavach.json"
        path.write_text(text, encoding="utf-8")
        return str(path)

    def test_unset_or_empty_is_the_default(self) -> None:
        self.assertIs(config.load({}), config.DEFAULT)
        self.assertIs(config.load({config.ENV_VAR: ""}), config.DEFAULT)
        self.assertEqual(config.DEFAULT, config.Config((), (), "", ()))

    def test_reads_the_process_environment_when_given_none(self) -> None:
        with mock.patch.dict(os.environ, {config.ENV_VAR: ""}):
            self.assertIs(config.load(), config.DEFAULT)
        path = self.write('{"worktree": {}}')
        with mock.patch.dict(os.environ, {config.ENV_VAR: path}):
            self.assertEqual(config.load(), config.DEFAULT)

    def test_an_unreadable_file_is_refused(self) -> None:
        absent = str(self.directory / "absent.json")
        with self.assertRaisesRegex(config.ConfigError, r"cannot be read \(FileNotFoundError\)"):
            config.load({config.ENV_VAR: absent})
        with self.assertRaisesRegex(config.ConfigError, r"cannot be read \(IsADirectoryError\)"):
            config.load({config.ENV_VAR: str(self.directory)})

    def test_text_that_is_not_json_is_refused(self) -> None:
        with self.assertRaisesRegex(config.ConfigError, "is not JSON"):
            config.load({config.ENV_VAR: self.write("{")})

    def test_a_file_names_the_settings_it_holds(self) -> None:
        document = {
            "worktree": {
                "trustedCommands": [
                    {"script": "scripts/worktree.py", "pattern": r"python3 scripts/worktree\.py status"}
                ]
            },
            "command": {
                "protectedVariables": ["SESSION_MARK", "_OTHER2"],
                "protectedVariablesReason": "the session set them",
                "pairedChanges": [
                    {"changes": "schema.sql", "requires": "changes/", "reason": "a schema change needs its change file"}
                ],
            },
        }
        loaded = config.load({config.ENV_VAR: self.write(json.dumps(document))})
        self.assertEqual(len(loaded.trusted_commands), 1)
        entry = loaded.trusted_commands[0]
        self.assertIsInstance(entry, config.TrustedCommand)
        self.assertEqual(entry.script, "scripts/worktree.py")
        self.assertEqual(entry.pattern.pattern, r"python3 scripts/worktree\.py status")
        self.assertEqual(loaded.protected_variables, ("SESSION_MARK", "_OTHER2"))
        self.assertEqual(loaded.protected_variables_reason, "the session set them")
        self.assertEqual(
            loaded.paired_changes,
            (config.PairedChange("schema.sql", "changes/", "a schema change needs its change file"),),
        )


class ParseTest(unittest.TestCase):
    def refused(self, data: object, message: str) -> None:
        with self.assertRaises(config.ConfigError) as raised:
            config.parse(data)
        self.assertIn(message, str(raised.exception))

    def test_empty_sections_are_the_default(self) -> None:
        self.assertEqual(config.parse({}), config.DEFAULT)
        self.assertEqual(config.parse({"worktree": {}, "command": {}}), config.DEFAULT)
        self.assertEqual(
            config.parse(
                {
                    "worktree": {"trustedCommands": []},
                    "command": {"protectedVariables": [], "protectedVariablesReason": "", "pairedChanges": []},
                }
            ),
            config.DEFAULT,
        )

    def test_objects_and_their_keys(self) -> None:
        self.refused([], "the settings must be a JSON object")
        self.refused({"other": 1}, "the settings has unknown key(s): other")
        self.refused({"b": 1, "a": 2}, "unknown key(s): a, b")
        self.refused({"worktree": []}, "worktree must be a JSON object")
        self.refused({"worktree": {"x": 1}}, "worktree has unknown key(s): x")
        self.refused({"command": "x"}, "command must be a JSON object")
        self.refused({"command": {"x": 1}}, "command has unknown key(s): x")

    def test_lists(self) -> None:
        self.refused({"worktree": {"trustedCommands": {}}}, "worktree.trustedCommands must be a JSON array")
        self.refused({"command": {"protectedVariables": "A"}}, "command.protectedVariables must be a JSON array")
        self.refused({"command": {"pairedChanges": {}}}, "command.pairedChanges must be a JSON array")

    def test_trusted_commands(self) -> None:
        def trusted(*entries: object) -> dict[str, object]:
            return {"worktree": {"trustedCommands": list(entries)}}

        good = {"script": "scripts/worktree.py", "pattern": "x"}
        self.refused(trusted(good, "x"), "worktree.trustedCommands[1] must be a JSON object")
        self.refused(trusted({**good, "extra": 1}), "worktree.trustedCommands[0] has unknown key(s): extra")
        self.refused(trusted({"pattern": "x"}), "worktree.trustedCommands[0].script must be a non-empty string")
        self.refused(trusted({**good, "script": ""}), ".script must be a non-empty string")
        self.refused(trusted({**good, "script": 3}), ".script must be a non-empty string")
        self.refused(trusted({**good, "script": "/abs/worktree.py"}), ".script must be a path inside the repository")
        self.refused(trusted({**good, "script": "scripts/../../x.py"}), ".script must be a path inside the repository")
        self.refused(trusted({**good, "script": ".."}), ".script must be a path inside the repository")
        self.refused(trusted({"script": "s.py"}), "worktree.trustedCommands[0].pattern must be a non-empty string")
        self.refused(trusted({**good, "pattern": ["x"]}), ".pattern must be a non-empty string")
        self.refused(trusted({**good, "pattern": "("}), "worktree.trustedCommands[0].pattern is not a regular expression")
        # A dotted name that is not `..` stays inside the repository.
        parsed = config.parse(trusted({**good, "script": "scripts/..hidden/x.py"}))
        self.assertEqual(parsed.trusted_commands[0].script, "scripts/..hidden/x.py")
        self.assertEqual(parsed.trusted_commands[0].pattern, re.compile("x"))

    def test_protected_variables(self) -> None:
        def command(**values: object) -> dict[str, object]:
            return {"command": values}

        self.refused(command(protectedVariables=[""]), "command.protectedVariables[0] must be a non-empty string")
        self.refused(command(protectedVariables=["A", 1]), "command.protectedVariables[1] must be a non-empty string")
        for name in ("1A", "A-B", "A B", "$A"):
            with self.subTest(name=name):
                self.refused(
                    command(protectedVariables=[name], protectedVariablesReason="r"),
                    f"command.protectedVariables[0] is not a variable name: {name!r}",
                )
        self.refused(command(protectedVariables=["A"]), "command.protectedVariablesReason must be a non-empty string")
        self.refused(
            command(protectedVariables=["A"], protectedVariablesReason=""),
            "command.protectedVariablesReason must be a non-empty string",
        )
        self.refused(
            command(protectedVariables=["A"], protectedVariablesReason=5),
            "command.protectedVariablesReason must be a non-empty string",
        )
        self.refused(
            command(protectedVariablesReason="r"),
            "command.protectedVariablesReason needs command.protectedVariables",
        )
        self.refused(
            command(protectedVariables=[], protectedVariablesReason="r"),
            "command.protectedVariablesReason needs command.protectedVariables",
        )
        self.refused(
            command(protectedVariablesReason=None),
            "command.protectedVariablesReason needs command.protectedVariables",
        )
        parsed = config.parse(command(protectedVariables=["A_1"], protectedVariablesReason="why"))
        self.assertEqual((parsed.protected_variables, parsed.protected_variables_reason), (("A_1",), "why"))

    def test_paired_changes(self) -> None:
        def paired(*entries: object) -> dict[str, object]:
            return {"command": {"pairedChanges": list(entries)}}

        good = {"changes": "a.sql", "requires": "b/", "reason": "r"}
        self.refused(paired(1), "command.pairedChanges[0] must be a JSON object")
        self.refused(paired({**good, "extra": 1}), "command.pairedChanges[0] has unknown key(s): extra")
        for key in ("changes", "requires", "reason"):
            with self.subTest(missing=key):
                self.refused(
                    paired({name: value for name, value in good.items() if name != key}),
                    f"command.pairedChanges[0].{key} must be a non-empty string",
                )
            with self.subTest(empty=key):
                self.refused(paired({**good, key: ""}), f"command.pairedChanges[0].{key} must be a non-empty string")
        self.assertEqual(
            config.parse(paired(good, good)).paired_changes,
            (config.PairedChange("a.sql", "b/", "r"),) * 2,
        )

    def test_the_settings_are_frozen(self) -> None:
        parsed = config.parse({})
        with self.assertRaises(AttributeError):
            setattr(parsed, "trusted_commands", ())


if __name__ == "__main__":
    unittest.main()
