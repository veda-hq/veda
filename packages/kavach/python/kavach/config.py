"""The consumer's settings for the guards, read from the JSON file named by
the environment variable KAVACH_CONFIG.

kavach knows no product. What one product trusts or requires (a script its
agents may run from any checkout, a command it reviewed as only reading and allows in one
environment, environment variables an agent must leave alone, a file whose change needs another in the same commit) comes from this
file, and with no file every such rule is off.

A file that cannot be read, is not JSON, has a key this module does not know,
or a value of the wrong shape raises ConfigError. Each guard's entry point
turns that into a refusal: a guard that misread its settings must not allow.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any, Mapping

ENV_VAR = "KAVACH_CONFIG"
# A variable name as the shell accepts it in an assignment.
VARIABLE_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class ConfigError(Exception):
    """The settings file is unreadable or not in the shape below."""


@dataclass(frozen=True)
class TrustedCommand:
    """A script in the consumer's repository that an agent may run from any
    checkout, and the exact command lines that run it. `script` is a path
    relative to the repository root; `pattern` must match the whole command."""

    script: str
    pattern: re.Pattern[str]


@dataclass(frozen=True)
class ReadOnlyCommand:
    """A command line the consumer reviewed as only reading, allowed from a
    checkout's root without an owned worktree, and only where the hook's own
    environment holds one of the listed values for every variable in `env`.
    `pattern` must match the whole command; `reason` says what was checked."""

    pattern: re.Pattern[str]
    env: tuple[tuple[str, tuple[str, ...]], ...]
    reason: str


@dataclass(frozen=True)
class PairedChange:
    """A commit that may record a path ending in `changes` must also certainly
    record a path containing `requires`."""

    changes: str
    requires: str
    reason: str


@dataclass(frozen=True)
class Config:
    trusted_commands: tuple[TrustedCommand, ...] = ()
    protected_variables: tuple[str, ...] = ()
    protected_variables_reason: str = ""
    paired_changes: tuple[PairedChange, ...] = ()
    read_only_commands: tuple[ReadOnlyCommand, ...] = ()


DEFAULT = Config()

SHAPE: dict[str, set[str]] = {
    "": {"worktree", "command"},
    "worktree": {"trustedCommands", "readOnlyCommands"},
    "command": {"protectedVariables", "protectedVariablesReason", "pairedChanges"},
}


def _object(value: Any, where: str, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"{where or 'the settings'} must be a JSON object")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ConfigError(f"{where or 'the settings'} has unknown key(s): {', '.join(unknown)}")
    return value


def _text(value: Any, where: str) -> str:
    if not isinstance(value, str) or not value:
        raise ConfigError(f"{where} must be a non-empty string")
    return value


def _list(value: Any, where: str) -> list[Any]:
    if not isinstance(value, list):
        raise ConfigError(f"{where} must be a JSON array")
    return value


def _trusted(value: Any, index: int) -> TrustedCommand:
    where = f"worktree.trustedCommands[{index}]"
    entry = _object(value, where, {"script", "pattern"})
    script = _text(entry.get("script"), f"{where}.script")
    if script.startswith("/") or ".." in script.split("/"):
        raise ConfigError(f"{where}.script must be a path inside the repository")
    source = _text(entry.get("pattern"), f"{where}.pattern")
    try:
        pattern = re.compile(source)
    except re.error as error:
        raise ConfigError(f"{where}.pattern is not a regular expression: {error}") from None
    return TrustedCommand(script, pattern)


def _read_only(value: Any, index: int) -> ReadOnlyCommand:
    where = f"worktree.readOnlyCommands[{index}]"
    entry = _object(value, where, {"pattern", "env", "reason"})
    source = _text(entry.get("pattern"), f"{where}.pattern")
    try:
        pattern = re.compile(source)
    except re.error as error:
        raise ConfigError(f"{where}.pattern is not a regular expression: {error}") from None
    # The environment is required: an entry with no condition would widen the
    # guard on every machine, which is what kavach's own read-only list is
    # kept narrow to avoid.
    raw_env = entry.get("env")
    if not isinstance(raw_env, dict) or not raw_env:
        raise ConfigError(f"{where}.env must be a non-empty JSON object of variable names")
    env: list[tuple[str, tuple[str, ...]]] = []
    for name, values in raw_env.items():
        if not VARIABLE_NAME.fullmatch(name):
            raise ConfigError(f"{where}.env has a key that is not a variable name: {name!r}")
        listed = _list(values, f"{where}.env.{name}")
        if not listed:
            raise ConfigError(f"{where}.env.{name} must list at least one value")
        env.append((name, tuple(_text(item, f"{where}.env.{name}[{at}]") for at, item in enumerate(listed))))
    reason = _text(entry.get("reason"), f"{where}.reason")
    return ReadOnlyCommand(pattern, tuple(env), reason)


def _paired(value: Any, index: int) -> PairedChange:
    where = f"command.pairedChanges[{index}]"
    entry = _object(value, where, {"changes", "requires", "reason"})
    return PairedChange(
        _text(entry.get("changes"), f"{where}.changes"),
        _text(entry.get("requires"), f"{where}.requires"),
        _text(entry.get("reason"), f"{where}.reason"),
    )


def parse(data: Any) -> Config:
    """The Config a decoded JSON document describes."""
    top = _object(data, "", SHAPE[""])
    worktree = _object(top.get("worktree", {}), "worktree", SHAPE["worktree"])
    command = _object(top.get("command", {}), "command", SHAPE["command"])
    trusted = tuple(
        _trusted(entry, index)
        for index, entry in enumerate(_list(worktree.get("trustedCommands", []), "worktree.trustedCommands"))
    )
    variables = tuple(
        _text(name, f"command.protectedVariables[{index}]")
        for index, name in enumerate(_list(command.get("protectedVariables", []), "command.protectedVariables"))
    )
    for index, name in enumerate(variables):
        if not VARIABLE_NAME.fullmatch(name):
            raise ConfigError(f"command.protectedVariables[{index}] is not a variable name: {name!r}")
    reason = command.get("protectedVariablesReason", "")
    if variables:
        reason = _text(reason, "command.protectedVariablesReason")
    elif reason != "":
        raise ConfigError("command.protectedVariablesReason needs command.protectedVariables")
    paired = tuple(
        _paired(entry, index)
        for index, entry in enumerate(_list(command.get("pairedChanges", []), "command.pairedChanges"))
    )
    read_only = tuple(
        _read_only(entry, index)
        for index, entry in enumerate(_list(worktree.get("readOnlyCommands", []), "worktree.readOnlyCommands"))
    )
    return Config(trusted, variables, reason, paired, read_only)


def load(environ: Mapping[str, str] | None = None) -> Config:
    """The settings named by KAVACH_CONFIG, or DEFAULT when it is unset or empty."""
    env = os.environ if environ is None else environ
    path = env.get(ENV_VAR, "")
    if not path:
        return DEFAULT
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError as error:
        raise ConfigError(f"{ENV_VAR} names {path!r}, which cannot be read ({type(error).__name__})") from None
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        raise ConfigError(f"{path} is not JSON: {error}") from None
    return parse(data)
