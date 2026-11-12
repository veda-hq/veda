#!/usr/bin/env python3
"""Every tracked Python source must run on the interpreter this repo declares.

WHY THIS EXISTS
---------------
The floor in the ``--floor-file`` is only worth declaring if something
notices when code drifts above it. The drift is invisible in CI — Ubuntu
runners ship a new Python — and invisible in review, because a PEP 604 union or
a fresh stdlib import looks like ordinary modern Python. It surfaces on a
developer's Mac, from inside a validator, as a message about something else:

  * ``scripts/run-validation.sh`` grew ``-> bytes | None`` annotations. Before
    3.10 those are evaluated at ``def`` time, so a clean ``git merge`` died with
    ``TypeError: unsupported operand type(s) for |`` — which the Codex isolation
    validator re-reported as "policy history gate rejected authorized
    activation", i.e. as a trust-chain violation.
  * ``validate-codex-workflow-ports.py`` grew ``import tomllib`` (3.11+), which
    fails as ``ModuleNotFoundError`` with no hint that a Python version is the
    cause.

Three checks, all measured against the declared floor rather than a constant,
so lowering the floor re-arms the ones that are currently inert:

  1. syntax — parsed with ``ast``'s ``feature_version`` set to the floor;
  2. stdlib — modules added after the floor, or removed at or before it;
  3. runtime PEP 604 — ``X | Y`` that is *evaluated*, which is every use before
     3.10 except an annotation guarded by ``from __future__ import annotations``.

Usage: python-floor.py --floor-file PATH [--exclude REGEX] [--selector PATH] [--root DIR] [--floor 3.11]
"""

from __future__ import annotations

import argparse
import ast
import io
import re
import subprocess
import tokenize
import sys
from pathlib import Path


# The floor file, relative to the root: --floor-file, set by main().
FLOOR_FILE = Path()

# Top-level stdlib modules and the version that introduced them. Only entries
# at or after 3.9 matter: anything older predates every floor worth declaring.
# An import of a module absent from this table is assumed to be old enough,
# which is the safe default — a false negative here costs a portability bug,
# while a false positive would block a legitimate import.
ADDED_IN = {
    "graphlib": (3, 9),
    "zoneinfo": (3, 9),
    "tomllib": (3, 11),
    "annotationlib": (3, 14),
    "compression": (3, 14),
}

# Modules removed by a given version, so raising the floor catches code that
# still imports them. PEP 594 took most of these out in 3.12.
REMOVED_IN = {
    "asynchat": (3, 12),
    "asyncore": (3, 12),
    "distutils": (3, 12),
    "imp": (3, 12),
    "smtpd": (3, 12),
    "aifc": (3, 13),
    "cgi": (3, 13),
    "cgitb": (3, 13),
    "telnetlib": (3, 13),
}

# A heredoc that feeds Python: the command word on the line is a python
# interpreter. Matching on the command rather than the tag keeps a
# `cat <<PYTHON_NOTES` out of the scan and keeps `python3 - <<EOF` in it.
HEREDOC = re.compile(
    r"\bpython3?(?:\.\d+)?\b[^\n<]*<<(-)?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2\s*$"
)

# `python3 -c '...'` with a single-quoted payload, which may span lines. Double
# quotes are skipped deliberately: the shell interpolates them, so the bytes in
# the file are not the bytes Python sees.
INLINE = re.compile(r"\bpython3?(?:\.\d+)?\b[^\n]*?\s-c\s+'")


class Finding:
    def __init__(self, where: str, line: int, rule: str, detail: str, remedy: str) -> None:
        self.where = where
        self.line = line
        self.rule = rule
        self.detail = detail
        self.remedy = remedy

    def render(self) -> str:
        return (
            f"  {self.where}:{self.line}\n"
            f"      {self.rule}: {self.detail}\n"
            f"      fix: {self.remedy}"
        )


class Source:
    """One unit of Python: a file, a heredoc body, or a `-c` payload."""

    def __init__(self, where: str, first_line: int, text: str) -> None:
        self.where = where
        self.first_line = first_line
        self.text = text

    def at(self, node_line: int) -> int:
        return self.first_line + node_line - 1


class Entry:
    """One index entry: what a commit made now would record at ``path``."""

    def __init__(self, mode: str, oid: str, stage: str, path: str) -> None:
        self.mode = mode
        self.oid = oid
        self.stage = stage
        self.path = path


# Index modes that are not a regular file's bytes: a symlink's blob is its
# target path, and a gitlink names a commit in another repository.
SYMLINK_MODE = "120000"
GITLINK_MODE = "160000"
REGULAR_MODES = {"100644", "100755"}


def index_entries(root: Path) -> list[Entry]:
    """The index, not the working tree, because this gate runs at pre-commit.

    Reading files from disk judged something other than the commit: a tracked
    file deleted with the deletion unstaged was refused as unreadable although
    the commit keeps it unchanged, and a broken staged file passed as long as
    the copy on disk had been repaired without staging the repair.
    """
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "--stage", "-z"],
        capture_output=True,
        check=True,
    ).stdout.decode()
    entries: list[Entry] = []
    for record in out.split("\0"):
        if not record:
            continue
        meta, path = record.split("\t", 1)
        mode, oid, stage = meta.split(" ")
        entries.append(Entry(mode, oid, stage, path))
    return entries


def read_blobs(root: Path, oids: list[str]) -> dict[str, bytes | None]:
    """Blob bytes by object id, from one `git cat-file --batch`; None if missing."""
    stdout = subprocess.run(
        ["git", "-C", str(root), "cat-file", "--batch"],
        input="".join(f"{oid}\n" for oid in oids).encode(),
        capture_output=True,
        check=True,
    ).stdout
    blobs: dict[str, bytes | None] = {}
    offset = 0
    for oid in oids:
        end = stdout.index(b"\n", offset)
        header = stdout[offset:end].decode().split(" ")
        offset = end + 1
        if len(header) != 3:
            # `<oid> missing`: no content follows the header.
            blobs[oid] = None
            continue
        size = int(header[2])
        blobs[oid] = stdout[offset : offset + size]
        offset += size + 1
    return blobs


def decode(data: bytes, encoding: str) -> str:
    # TextIOWrapper, as tokenize.open and Path.read_text use, so newline
    # translation matches what reading the file from disk produced.
    return io.TextIOWrapper(io.BytesIO(data), encoding=encoding).read()


def read_floor(root: Path, entries: list[Entry]) -> tuple[int, int]:
    staged = [
        entry
        for entry in entries
        if entry.path == FLOOR_FILE.as_posix() and entry.stage == "0"
    ]
    if not staged:
        raise SystemExit(f"{FLOOR_FILE} is not in the index, so there is no declared floor")
    # A symlink's blob is its target path, which could itself read as a version.
    if staged[0].mode not in REGULAR_MODES:
        raise SystemExit(f"{FLOOR_FILE} must be a regular file in the index")
    blob = read_blobs(root, [staged[0].oid])[staged[0].oid]
    if blob is None:
        raise SystemExit(f"{FLOOR_FILE} is staged but its object is missing")
    raw = decode(blob, "utf-8")
    stripped = [
        line.split("#", 1)[0].strip() for line in raw.splitlines()
    ]
    values = [line for line in stripped if line]
    if len(values) != 1:
        raise SystemExit(
            f"{FLOOR_FILE} must hold exactly one version, found {len(values)}"
        )
    parts = values[0].split(".")
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        raise SystemExit(f"{FLOOR_FILE} must hold MAJOR.MINOR, found {values[0]!r}")
    return (int(parts[0]), int(parts[1]))


# Paths nothing executes, no check reads and no edit may touch, matched from
# the start of the path: --exclude, set by main(); None excludes nothing.
FROZEN: re.Pattern[str] | None = None


def is_candidate(path: str) -> bool:
    if FROZEN is not None and FROZEN.match(path):
        return False
    return path.endswith(".py") or path.endswith(".sh") or path.startswith(".husky/")


def collect(root: Path, entries: list[Entry]) -> tuple[list[Source], list[Finding]]:
    """Every Python source a hook, validator or agent tool can execute.

    Each source is its STAGED blob, so the gate judges the commit being made.
    Unreadable sources are REPORTED, never skipped. A guard that quietly drops a
    file it cannot decode passes while that file holds anything at all, which is
    the failure mode this whole script exists to prevent.
    """
    sources: list[Source] = []
    failures: list[Finding] = []
    unmerged: set[str] = set()
    regular: list[Entry] = []
    for entry in entries:
        if not is_candidate(entry.path) or entry.mode == GITLINK_MODE:
            continue
        if entry.stage != "0":
            if entry.path not in unmerged:
                unmerged.add(entry.path)
                failures.append(
                    unreadable(
                        entry.path,
                        "unmerged: the index holds conflict stages",
                        "resolve the conflict and stage the result",
                    )
                )
            continue
        if entry.mode == SYMLINK_MODE:
            failures.append(
                unreadable(
                    entry.path,
                    "a symlink: the gate reads staged blobs and does not follow links",
                    "track the file itself rather than a link to it",
                )
            )
            continue
        regular.append(entry)

    blobs = read_blobs(root, [entry.oid for entry in regular])
    for entry in regular:
        path = entry.path
        blob = blobs[entry.oid]
        if blob is None:
            failures.append(unreadable(path, f"staged object {entry.oid} is missing"))
            continue
        if path.endswith(".py"):
            try:
                # detect_encoding honours the PEP 263 coding declaration and a
                # BOM, as tokenize.open does, so a validly-encoded non-UTF-8
                # source is CHECKED rather than skipped.
                encoding, _ = tokenize.detect_encoding(io.BytesIO(blob).readline)
                text = decode(blob, encoding)
            except (SyntaxError, UnicodeDecodeError, ValueError) as error:
                failures.append(unreadable(path, f"{type(error).__name__}: {error}"))
                continue
            sources.append(Source(path, 1, text))
            continue
        try:
            text = decode(blob, "utf-8")
        except UnicodeDecodeError as error:
            failures.append(unreadable(path, f"{type(error).__name__}: {error}"))
            continue
        sources.extend(embedded(path, text))
    return sources, failures


def unreadable(
    path: str,
    detail: str,
    remedy: str = "give the file a decodable encoding (a PEP 263 declaration for "
    "Python), or untrack it",
) -> Finding:
    return Finding(
        path,
        1,
        "unreadable",
        detail,
        f"{remedy} — this gate will not skip a source it cannot read",
    )


def embedded(path: str, text: str) -> list[Source]:
    lines = text.splitlines()
    found: list[Source] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        heredoc = HEREDOC.search(line)
        if heredoc is not None:
            dash, tag = heredoc.group(1), heredoc.group(3)
            start = index + 1
            end = start
            while end < len(lines) and lines[end].strip() != tag:
                end += 1
            body = lines[start:end]
            # `<<-` tells the shell to strip leading TABS from every body line
            # (and from the terminator, which `.strip()` above already covers).
            # Python never sees them, so neither may this — otherwise a
            # tab-indented heredoc reads as an IndentationError and is reported
            # as syntax the floor cannot parse.
            if dash:
                body = [entry.lstrip("\t") for entry in body]
            found.append(
                Source(f"{path} <<{tag}", start + 1, "\n".join(body))
            )
            index = end + 1
            continue
        inline = INLINE.search(line)
        if inline is not None:
            body, end = inline_payload(lines, index, inline.end())
            found.append(Source(f"{path} python -c", index + 1, body))
            index = end + 1
            continue
        index += 1
    return found


def inline_payload(lines: list[str], index: int, offset: int) -> tuple[str, int]:
    """Text between the opening quote at ``offset`` and the next single quote."""
    first = lines[index][offset:]
    if "'" in first:
        return first[: first.index("'")], index
    collected = [first]
    cursor = index + 1
    while cursor < len(lines):
        if "'" in lines[cursor]:
            collected.append(lines[cursor][: lines[cursor].index("'")])
            return "\n".join(collected), cursor
        collected.append(lines[cursor])
        cursor += 1
    return "\n".join(collected), cursor - 1


def has_future_annotations(tree: ast.Module) -> bool:
    return any(
        isinstance(node, ast.ImportFrom)
        and node.module == "__future__"
        and any(alias.name == "annotations" for alias in node.names)
        for node in tree.body
    )


def annotation_nodes(tree: ast.Module) -> set[int]:
    """id() of every expression that sits in an annotation position."""
    marked: set[int] = set()
    for node in ast.walk(tree):
        found: list[ast.expr] = []
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            arguments = node.args
            for arg in (
                arguments.posonlyargs
                + arguments.args
                + arguments.kwonlyargs
                + [arguments.vararg, arguments.kwarg]
            ):
                if arg is not None and arg.annotation is not None:
                    found.append(arg.annotation)
            if node.returns is not None:
                found.append(node.returns)
        elif isinstance(node, ast.AnnAssign):
            found.append(node.annotation)
        for expression in found:
            for descendant in ast.walk(expression):
                marked.add(id(descendant))
    return marked


def check_stdlib(source: Source, tree: ast.Module, floor: tuple[int, int]) -> list[Finding]:
    findings: list[Finding] = []
    for node in ast.walk(tree):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names = [node.module]
        for name in names:
            top = name.split(".")[0]
            added = ADDED_IN.get(top)
            if added is not None and added > floor:
                findings.append(
                    Finding(
                        source.where,
                        source.at(node.lineno),
                        "stdlib-too-new",
                        f"{top} was added in Python {added[0]}.{added[1]}, "
                        f"above the declared floor {floor[0]}.{floor[1]}",
                        f"raise {FLOOR_FILE.as_posix()}, or use a module the floor has "
                        "(no __future__ import can supply a missing module)",
                    )
                )
            removed = REMOVED_IN.get(top)
            if removed is not None and removed <= floor:
                findings.append(
                    Finding(
                        source.where,
                        source.at(node.lineno),
                        "stdlib-removed",
                        f"{top} was removed in Python {removed[0]}.{removed[1]}, "
                        f"at or below the declared floor {floor[0]}.{floor[1]}",
                        "use the replacement module named in that release's changelog",
                    )
                )
    return findings


def type_expression_nodes(tree: ast.Module) -> set[int]:
    """id() of expressions that are unambiguously types rather than values.

    `|` is overloaded: set union, dict merge and `os.O_RDONLY | os.O_NOFOLLOW`
    all use it and all predate PEP 604. Flagging every BitOr would bury the real
    finding under false positives from this repo's own hooks, so only positions
    where `|` cannot mean anything but a type union are considered.
    """
    marked: set[int] = set()

    def mark(expression: ast.expr) -> None:
        for descendant in ast.walk(expression):
            marked.add(id(descendant))

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            callee = node.func
            name = callee.attr if isinstance(callee, ast.Attribute) else getattr(callee, "id", "")
            # cast(T, value); isinstance(x, T); issubclass(C, T)
            if name == "cast" and node.args:
                mark(node.args[0])
            elif name in {"isinstance", "issubclass"} and len(node.args) > 1:
                mark(node.args[1])
    return marked


def is_optional_shorthand(node: ast.BinOp) -> bool:
    """`X | None`, which can never be set union or integer bitwise-or."""
    return any(
        isinstance(side, ast.Constant) and side.value is None
        for side in (node.left, node.right)
    )


def check_runtime_unions(
    source: Source, tree: ast.Module, floor: tuple[int, int]
) -> list[Finding]:
    """PEP 604 unions that are evaluated, on a floor that cannot evaluate them.

    Inert at 3.10 and above, and deliberately so: it is the check that makes the
    floor file mean something if anyone lowers it.

    Conservative outside annotations. A bare alias of two names — `IntOrStr =
    int | str` — is indistinguishable from a set union without type knowledge
    and is not reported; `int | None` is, because `None` has no `__or__`.
    """
    if floor >= (3, 10):
        return []
    deferred = has_future_annotations(tree)
    in_annotation = annotation_nodes(tree)
    in_type_position = type_expression_nodes(tree)
    findings: list[Finding] = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr)):
            continue
        annotated = id(node) in in_annotation
        if annotated:
            if deferred:
                continue
            detail = (
                "X | Y in an annotation is evaluated at definition time without "
                "`from __future__ import annotations`"
            )
        elif id(node) in in_type_position or is_optional_shorthand(node):
            detail = "X | Y in a type position outside an annotation is always evaluated"
        else:
            continue
        findings.append(
            Finding(
                source.where,
                source.at(node.lineno),
                "runtime-pep604",
                f"{detail}; PEP 604 unions need Python 3.10, floor is "
                f"{floor[0]}.{floor[1]}",
                "add `from __future__ import annotations` (annotations only), or "
                "write Optional[X] / Union[X, Y]",
            )
        )
    return findings


def check(source: Source, floor: tuple[int, int]) -> list[Finding]:
    try:
        tree = ast.parse(source.text, feature_version=floor)
    except SyntaxError as error:
        return [
            Finding(
                source.where,
                source.at(error.lineno or 1),
                "syntax-too-new",
                f"{error.msg} — not valid Python {floor[0]}.{floor[1]}",
                f"rewrite for the declared floor, or raise {FLOOR_FILE.as_posix()}",
            )
        ]
    except ValueError as error:
        return [
            Finding(source.where, source.first_line, "unparseable", str(error), "check the source")
        ]
    return check_stdlib(source, tree, floor) + check_runtime_unions(source, tree, floor)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument(
        "--floor-file",
        required=True,
        help="the file declaring MAJOR.MINOR, relative to --root",
    )
    parser.add_argument(
        "--exclude",
        help="a regular expression matched from the start of each path; matches are not checked",
    )
    parser.add_argument(
        "--selector",
        help="what picks an interpreter at or above the floor, named when this one is below it",
    )
    parser.add_argument(
        "--floor",
        help="override MAJOR.MINOR for testing; defaults to the --floor-file",
    )
    args = parser.parse_args()
    global FLOOR_FILE, FROZEN
    FLOOR_FILE = Path(args.floor_file)
    if args.exclude is not None:
        try:
            FROZEN = re.compile(args.exclude)
        except re.error as error:
            parser.error(f"--exclude is not a regular expression: {error}")
    root = Path(args.root).resolve()
    entries = index_entries(root)

    if args.floor is None:
        floor = read_floor(root, entries)
    else:
        parts = args.floor.split(".")
        floor = (int(parts[0]), int(parts[1]))

    # `feature_version` cannot describe a grammar newer than the running
    # interpreter, so a stale Python would silently under-report. The hook
    # selects an interpreter at or above the floor before calling this.
    if sys.version_info[:2] < floor:
        print(
            f"❌ validate-hook-python-floor: running on Python "
            f"{sys.version_info[0]}.{sys.version_info[1]}, which is below the "
            f"declared floor {floor[0]}.{floor[1]}, so it cannot judge the floor.\n"
            f"   Run it under a newer interpreter"
            + (
                ""
                if args.selector is None
                else f" (the hook does this for you via {args.selector})"
            )
            + ".",
            file=sys.stderr,
        )
        return 2

    sources, unreadable_findings = collect(root, entries)
    if not sources and not unreadable_findings:
        print(
            "❌ validate-hook-python-floor: found no Python to check, which means "
            "the scan is broken rather than the repo clean.",
            file=sys.stderr,
        )
        return 2

    # A nested union (`a | b | c`) is several BinOp nodes on one line, and a
    # line is the unit a developer fixes — so report each line once.
    seen: set[tuple[str, int, str]] = set()
    findings: list[Finding] = list(unreadable_findings)
    for source in sources:
        for finding in check(source, floor):
            key = (finding.where, finding.line, finding.rule)
            if key in seen:
                continue
            seen.add(key)
            findings.append(finding)

    if findings:
        print(
            f"❌ Python that cannot run on the declared floor "
            f"{floor[0]}.{floor[1]} ({FLOOR_FILE.as_posix()}):\n",
            file=sys.stderr,
        )
        for finding in findings:
            print(finding.render(), file=sys.stderr)
        print(
            f"\n{len(findings)} finding(s) across {len(sources)} Python source(s). "
            "These fail on a stock macOS interpreter, usually reported by whatever "
            "validator was running rather than as a version problem.",
            file=sys.stderr,
        )
        return 1

    print(
        f"✅ {len(sources)} Python source(s) run on Python "
        f"{floor[0]}.{floor[1]} ({FLOOR_FILE.as_posix()})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
