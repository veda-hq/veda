"""The consumer's settings for the guards, read from the JSON file named by
the environment variable KAVACH_CONFIG.

kavach knows no product. What one product trusts or requires (a script its
agents may run from any checkout, a command it reviewed as only reading and allows in one
environment, a CLI whose writes it reviewed, the environment where a plain clone is a session's own checkout, environment variables an agent must leave alone, a file whose change needs another in the same commit) comes from this
file, and with no file every such rule is off. So does the mode of each rule
that holds a lesson (`rules`, rules.py; the shell-expansion rule may also be
set by `command.shellExpansion`), which warns until the file says "refuse".

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
class OwnCheckout:
    """Where the session's own checkout is a plain clone rather than a linked
    worktree (a hosted session that clones the repository for itself): that
    clone counts as the session's own, but only where the hook's own
    environment holds one of the listed values for every variable in `env`.
    `reason` says why that environment marks such a session.
    `protected_paths` are paths relative to the clone's root that stay
    refused inside it: the files the guards themselves run from, which a
    desktop session finds in the main checkout, outside its worktree."""

    env: tuple[tuple[str, tuple[str, ...]], ...]
    reason: str
    protected_paths: tuple[str, ...] = ()


@dataclass(frozen=True)
class ReviewedSubcommand:
    """One subcommand of a reviewed CLI: its leading words (`keep-going
    --stop` is two), the options whose value is a path, and whether its
    operands are paths."""

    words: tuple[str, ...]
    path_options: tuple[str, ...]
    path_operands: bool


@dataclass(frozen=True)
class ReviewedCLI:
    """A CLI the consumer reviewed, run from the owned worktree's root: every
    write it makes lands under the git toplevel or on the paths its command
    line declares (`subcommands`), which the guard confines to the worktree.
    Every other argument is data. `reason` says what was audited."""

    program: str
    subcommands: tuple[ReviewedSubcommand, ...]
    reason: str


@dataclass(frozen=True)
class PairedChange:
    """A commit that may record a path ending in `changes` must also certainly
    record a path containing `requires`."""

    changes: str
    requires: str
    reason: str


@dataclass(frozen=True)
class RuleMode:
    """How one rule that holds a lesson runs (rules.py): "warn" allows the
    call with the reason in front of the agent, "refuse" blocks it.
    `refuses_from` (YYYY-MM-DD) is only shown in a warning."""

    mode: str
    refuses_from: str = ""


@dataclass(frozen=True)
class Config:
    trusted_commands: tuple[TrustedCommand, ...] = ()
    protected_variables: tuple[str, ...] = ()
    protected_variables_reason: str = ""
    paired_changes: tuple[PairedChange, ...] = ()
    read_only_commands: tuple[ReadOnlyCommand, ...] = ()
    # The shell-expansion rule (git_safety.py): "warn" allows with a warning,
    # "refuse" blocks. A new refusal warns first, so the default is "warn".
    shell_expansion: str = "warn"
    # The day it is to start refusing, shown in its warning (YYYY-MM-DD).
    # Shown only: what makes it refuse is "refuse" above, set once its log
    # shows no wrong fire.
    shell_expansion_refuses_from: str = ""
    reviewed_clis: tuple[ReviewedCLI, ...] = ()
    own_checkout: OwnCheckout | None = None
    # The mode of each rule in rules.py the settings name; one not named warns.
    rules: tuple[tuple[str, RuleMode], ...] = ()


DEFAULT = Config()
SHELL_EXPANSION_MODES = ("warn", "refuse")
RULE_MODES = SHELL_EXPANSION_MODES
DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
# The shell-expansion rule's id, which `rules` may name too.
SHELL_EXPANSION_RULE = "commit-message-shell-expansion"
# Every rule `rules` may name: rules.RULES and the shell-expansion rule.
RULE_IDS = (
    SHELL_EXPANSION_RULE,
    "pipe-masks-exit",
    "cd-out-of-worktree",
    "stryker-inplace",
    "checkout-discards-uncommitted",
    "commit-body-ref-line-length",
    "case-fold-path-collision",
    "routine-sources-shape",
)

SHAPE: dict[str, set[str]] = {
    "": {"worktree", "command", "rules"},
    "worktree": {"trustedCommands", "readOnlyCommands", "reviewedCLIs", "ownCheckout"},
    "command": {
        "protectedVariables", "protectedVariablesReason", "pairedChanges",
        "shellExpansion", "shellExpansionRefusesFrom",
    },
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
    env = _env(entry.get("env"), where)
    reason = _text(entry.get("reason"), f"{where}.reason")
    return ReadOnlyCommand(pattern, env, reason)


def _env(raw_env: Any, where: str) -> tuple[tuple[str, tuple[str, ...]], ...]:
    """A required environment condition: each variable and the values it may hold."""
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
    return tuple(env)


def _own_checkout(value: Any) -> OwnCheckout:
    where = "worktree.ownCheckout"
    entry = _object(value, where, {"env", "reason", "protectedPaths"})
    # Required for the same reason as a read-only command's: with no
    # condition, every plain clone on every machine would count as owned.
    env = _env(entry.get("env"), where)
    reason = _text(entry.get("reason"), f"{where}.reason")
    paths = tuple(
        _text(item, f"{where}.protectedPaths[{at}]")
        for at, item in enumerate(_list(entry.get("protectedPaths", []), f"{where}.protectedPaths"))
    )
    for at, path in enumerate(paths):
        if path.startswith("/") or ".." in path.split("/") or path.strip("/") in ("", "."):
            raise ConfigError(f"{where}.protectedPaths[{at}] must be a path inside the repository")
    return OwnCheckout(env, reason, paths)


# A program is named bare, as the shell finds it on PATH: a path-qualified
# executable could be a repository's own shim.
PROGRAM_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
# A subcommand's words and option names are plain words, so the guard can
# compare them with the words of a command line once its quotes are removed.
SUBCOMMAND_WORD = re.compile(r"[A-Za-z0-9._:@+%-][A-Za-z0-9._/:,@+%=-]*")
OPTION_NAME = re.compile(r"--?[A-Za-z0-9][A-Za-z0-9-]*")


def _subcommand(key: str, value: Any, where: str) -> ReviewedSubcommand:
    words = tuple(key.split(" "))
    if not key or not all(SUBCOMMAND_WORD.fullmatch(word) for word in words):
        raise ConfigError(f"{where} has a key that is not words separated by single spaces: {key!r}")
    entry = _object(value, f"{where}.{key}", {"pathOptions", "pathOperands"})
    options = tuple(
        _text(item, f"{where}.{key}.pathOptions[{at}]")
        for at, item in enumerate(_list(entry.get("pathOptions", []), f"{where}.{key}.pathOptions"))
    )
    for at, option in enumerate(options):
        if not OPTION_NAME.fullmatch(option):
            raise ConfigError(f"{where}.{key}.pathOptions[{at}] is not an option name: {option!r}")
    operands = entry.get("pathOperands", False)
    if not isinstance(operands, bool):
        raise ConfigError(f"{where}.{key}.pathOperands must be true or false")
    return ReviewedSubcommand(words, options, operands)


def _reviewed(value: Any, index: int) -> ReviewedCLI:
    where = f"worktree.reviewedCLIs[{index}]"
    entry = _object(value, where, {"program", "subcommands", "reason"})
    program = _text(entry.get("program"), f"{where}.program")
    if not PROGRAM_NAME.fullmatch(program):
        raise ConfigError(f"{where}.program must be a bare program name, such as niyam")
    raw = entry.get("subcommands")
    if not isinstance(raw, dict) or not raw:
        raise ConfigError(f"{where}.subcommands must be a non-empty JSON object")
    subcommands = tuple(_subcommand(key, item, f"{where}.subcommands") for key, item in raw.items())
    return ReviewedCLI(program, subcommands, _text(entry.get("reason"), f"{where}.reason"))


def _paired(value: Any, index: int) -> PairedChange:
    where = f"command.pairedChanges[{index}]"
    entry = _object(value, where, {"changes", "requires", "reason"})
    return PairedChange(
        _text(entry.get("changes"), f"{where}.changes"),
        _text(entry.get("requires"), f"{where}.requires"),
        _text(entry.get("reason"), f"{where}.reason"),
    )


def _rule_mode(key: str, value: Any) -> RuleMode:
    where = f"rules.{key}"
    if isinstance(value, str):
        value = {"mode": value}
    entry = _object(value, where, {"mode", "refusesFrom"})
    mode = entry.get("mode")
    if mode not in RULE_MODES:
        raise ConfigError(f"{where}.mode must be one of {', '.join(RULE_MODES)}")
    refuses_from = entry.get("refusesFrom", "")
    if refuses_from != "" and not (isinstance(refuses_from, str) and DAY.fullmatch(refuses_from)):
        raise ConfigError(f"{where}.refusesFrom must be a day, YYYY-MM-DD")
    return RuleMode(mode, refuses_from)


def _rules(value: Any) -> tuple[tuple[str, RuleMode], ...]:
    """`rules`: a rule id to "warn", "refuse" or {"mode", "refusesFrom"}. An
    id this kavach does not know is an error, as an unknown key is."""
    entries = _object(value, "rules", set(RULE_IDS))
    return tuple((key, _rule_mode(key, item)) for key, item in entries.items())


def parse(data: Any) -> Config:
    """The Config a decoded JSON document describes."""
    top = _object(data, "", SHAPE[""])
    rules = _rules(top.get("rules", {}))
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
    mode = command.get("shellExpansion", "warn")
    if mode not in SHELL_EXPANSION_MODES:
        raise ConfigError(f"command.shellExpansion must be one of {', '.join(SHELL_EXPANSION_MODES)}")
    refuses_from = command.get("shellExpansionRefusesFrom", "")
    if refuses_from != "" and not (isinstance(refuses_from, str) and DAY.fullmatch(refuses_from)):
        raise ConfigError("command.shellExpansionRefusesFrom must be a day, YYYY-MM-DD")
    named = dict(rules).get(SHELL_EXPANSION_RULE)
    if named is not None:
        if "shellExpansion" in command or "shellExpansionRefusesFrom" in command:
            raise ConfigError(
                f"rules.{SHELL_EXPANSION_RULE} and command.shellExpansion name the same rule: keep one"
            )
        mode, refuses_from = named.mode, named.refuses_from
    reviewed = tuple(
        _reviewed(entry, index)
        for index, entry in enumerate(_list(worktree.get("reviewedCLIs", []), "worktree.reviewedCLIs"))
    )
    own = _own_checkout(worktree["ownCheckout"]) if "ownCheckout" in worktree else None
    return Config(
        trusted, variables, reason, paired, read_only, mode, refuses_from, reviewed, own_checkout=own, rules=rules
    )


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
