"""The guards' refusal log: one JSON row per refusal, so a later reading can
say which refusals a guard made and how often.

Where: ``<git common dir>/kavach/refusals.jsonl`` of the repository the
event's ``cwd`` belongs to, shared by all of its worktrees. Each row holds the
time, the guard, the tool, the first line of the reason and the start of the
command or path. A rule on trial also writes a row each time it only warns,
and names itself in both kinds of row (``rule``, ``mode``: "warn" or
"refuse"), so its trial can be read for wrong fires before it refuses.
Commands can hold secrets typed on a command line, so the log
stays inside the repository's git directory, never in the working tree.

Best effort: logging never changes a verdict. Any failure (no git, no
repository, a read-only git directory) is swallowed, and the guard's own
exit stands.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, TextIO

FILE = "refusals.jsonl"
EXCERPT = 200
# Set to any non-empty value to turn the log off (a consumer's own test runs).
OFF_VAR = "KAVACH_REFUSAL_LOG_OFF"


class _Tee(io.TextIOBase):
    """Writes through to ``target`` and keeps a copy."""

    def __init__(self, target: TextIO) -> None:
        self.target = target
        self.copy = io.StringIO()

    def write(self, text: str) -> int:
        self.copy.write(text)
        return self.target.write(text)

    def flush(self) -> None:
        self.target.flush()


def log_dir(cwd: str) -> Path | None:
    """``<git common dir>/kavach`` for ``cwd``, or None when git cannot say."""

    try:
        result = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    common = result.stdout.strip()
    if result.returncode != 0 or not common:
        return None
    return Path(common) / "kavach"


def excerpt(tool_input: Any) -> str:
    """The command, or the file path, clipped."""

    if isinstance(tool_input, dict):
        for key in ("command", "file_path", "notebook_path", "path"):
            value = tool_input.get(key)
            if isinstance(value, str):
                return value[:EXCERPT]
    return ""


# The rule and mode the next refusal row names (``label``), taken by it.
_LABEL: dict[str, str] = {}


def label(rule: str, mode: str) -> None:
    """Name the rule and mode of the refusal about to be made, so its one
    row says which rule fired and in which mode."""

    _LABEL.clear()
    _LABEL.update(rule=rule, mode=mode)


def record(
    guard: str,
    raw_input: str,
    stderr_text: str,
    now: Callable[[], float] = time.time,
    *,
    rule: str | None = None,
    mode: str | None = None,
) -> None:
    """Append one row for a refusal, or for a warning (``mode`` "warn");
    never raises. ``rule`` and ``mode`` are written only when given, so the
    rows of rules with no name keep their shape."""

    try:
        if os.environ.get(OFF_VAR):
            return
        try:
            event = json.loads(raw_input)
        except ValueError:
            event = {}
        if not isinstance(event, dict):
            event = {}
        cwd = event.get("cwd") if isinstance(event.get("cwd"), str) else os.getcwd()
        directory = log_dir(cwd)
        if directory is None:
            return
        reason = next(
            (line for line in stderr_text.splitlines() if line.strip()),
            "",
        )[:EXCERPT]
        row = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now())),
            "guard": guard,
            "tool": event.get("tool_name") if isinstance(event.get("tool_name"), str) else "",
            "reason": reason,
            "excerpt": excerpt(event.get("tool_input")),
        }
        if rule is not None:
            row["rule"] = rule
        if mode is not None:
            row["mode"] = mode
        directory.mkdir(parents=True, exist_ok=True)
        with open(directory / FILE, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    except BaseException:  # noqa: BLE001 - logging must never change a verdict
        return


class _ReadTee:
    """Reads through ``source`` and keeps a copy of the text read. Errors
    pass through untouched, so the guard reads its input as it always did."""

    def __init__(self, source: Any) -> None:
        self.source = source
        self.copy = io.StringIO()

    def read(self, *args: Any) -> Any:
        text = self.source.read(*args)
        if isinstance(text, str):
            self.copy.write(text)
        return text

    def __getattr__(self, name: str) -> Any:
        return getattr(self.source, name)


def guarded(guard: str, body: Callable[[], Any], raw_input: Callable[[], str] | None = None) -> Any:
    """Run ``body``; when it refuses (exit 2 raised, or 2 returned), log it.

    The verdict passes through unchanged. ``raw_input`` returns the event
    text when the guard reads its input another way; by default the text the
    guard read from ``sys.stdin`` is used.
    """

    stderr = _Tee(sys.stderr)
    stdin = _ReadTee(sys.stdin)
    previous = sys.stderr, sys.stdin
    sys.stderr, sys.stdin = stderr, stdin  # type: ignore[assignment]

    _LABEL.clear()

    def log() -> None:
        text = raw_input() if raw_input is not None else stdin.copy.getvalue()
        named = dict(_LABEL)
        _LABEL.clear()
        record(guard, text, stderr.copy.getvalue(), rule=named.get("rule"), mode=named.get("mode"))

    try:
        result = body()
    except SystemExit as end:
        if type(end.code) is int and end.code == 2:
            log()
        raise
    finally:
        sys.stderr, sys.stdin = previous
    if type(result) is int and result == 2:
        log()
    return result
