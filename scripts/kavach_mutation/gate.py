#!/usr/bin/env python3
"""kavach's Python mutation gate (veda#558, under work item #238).

cosmic-ray 8.9.0 mutates the lines a pull request adds or changes in
packages/kavach/python/kavach, and the gate fails on any mutant that is not
killed, unless the code-owned list (packages/kavach/python/
mutation-equivalents.tsv) names it with the outcome it gets.

- ``plan``: cheap, on every pull request. Fails on a no-mutate pragma
  anywhere under packages/kavach/python/ and on a malformed or stale list,
  and says whether any line or list row needs mutants run.
- ``run``: records, per test, the lines each test runs (in its own process
  and in every Python child), then runs each mutant against only the tests
  recorded on its lines, failfast, under the memory and file caps. A changed
  line no test runs is refused as uncovered, with no mutant run.
- ``cap``: the wrapper each test run goes through. It sets the caps, runs
  the tests and reports the largest child's memory.

cosmic-ray enumerates the mutants (``cosmic-ray init`` and ``dump``) and
applies each one (``cosmic_ray.mutating.use_mutation``). The gate runs the
tests itself, not ``cosmic-ray exec``: exec takes one test command for every
mutant, and scores a timeout as a kill.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = "packages/kavach"
SOURCES = "packages/kavach/python/kavach"
PRAGMA_ROOT = "packages/kavach/python"
LIST = "packages/kavach/python/mutation-equivalents.tsv"
HOOK = Path(__file__).resolve().with_name("hook.py")

PRAGMA = re.compile(r"pragma\s*:\s*no[\s_-]*mutate", re.IGNORECASE)
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
OUTCOMES = ("survived", "timeout", "capped")
COLUMNS = ("file", "line", "operator", "nth", "outcome", "reason")

# #360's caps, as `ulimit -v 3000000` and `ulimit -f 1000000` set them: 3 GB
# of address space for each process and 1 GB for each file it writes.
MEMORY_CAP = 3_000_000 * 1024
FILE_CAP = 1_000_000 * 1024
# A run whose largest process came this close to the memory cap is scored as
# capped: under the cap an allocation fails wherever it happens, and a test
# that sees its child die of it fails as if it had caught the mutant.
NEAR_MEMORY_CAP = 2 * 1024**3
CAP_SIGNS = ("MemoryError", "File too large", "[Errno 27]")


class GateError(Exception):
    """A fault in the gate's own run, not a verdict on a mutant."""


# ---------------------------------------------------------------- the diff


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout


def added_lines(diff: str) -> dict[str, set[int]]:
    """The new-side line numbers each file's hunks add or change."""

    found: dict[str, set[int]] = {}
    path = None
    for line in diff.splitlines():
        if line.startswith("+++ "):
            target = line[4:]
            path = None if target == "/dev/null" else target.removeprefix("b/")
            if path is not None:
                found.setdefault(path, set())
            continue
        match = HUNK.match(line)
        if match and path is not None:
            start = int(match.group(1))
            count = 1 if match.group(2) is None else int(match.group(2))
            found[path].update(range(start, start + count))
    return {path: lines for path, lines in found.items() if lines}


def changed(base: str) -> tuple[dict[str, set[int]], set[int]]:
    """The changed lines of each kavach module, and the list rows the diff adds or changes."""

    diff = git("diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-renames", base, "--", SOURCES, LIST)
    lines = added_lines(diff)
    modules = {
        path: numbers
        for path, numbers in lines.items()
        if path.startswith(SOURCES + "/") and path.endswith(".py") and (ROOT / path).is_file()
    }
    return modules, lines.get(LIST, set())


# ------------------------------------------------------------- the pragma


def pragma_hits(root: Path) -> list[str]:
    hits = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            if PRAGMA.search(line):
                hits.append(f"{path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}:{number}")
    return hits


# ---------------------------------------------------------------- the list


@dataclass(frozen=True)
class Row:
    file: str
    line: str
    operator: str
    nth: int
    outcome: str
    reason: str
    at: int  # the row's own line in the list

    def label(self) -> str:
        return f"{self.file}: `{self.line}` {self.operator} #{self.nth}"


def parse_list(text: str) -> tuple[list[Row], list[str]]:
    """The list's rows, and what is wrong with it. Lines starting with # are comments."""

    rows: list[Row] = []
    problems: list[str] = []
    header_seen = False
    keys = set()
    for at, raw in enumerate(text.splitlines(), 1):
        if not raw.strip() or raw.startswith("#"):
            continue
        cells = raw.split("\t")
        if not header_seen:
            header_seen = True
            if tuple(cells) != COLUMNS:
                problems.append(f"line {at}: the header must be {chr(9).join(COLUMNS)!r}")
            continue
        if len(cells) != len(COLUMNS):
            problems.append(f"line {at}: {len(cells)} tab-separated cells, not {len(COLUMNS)}")
            continue
        file, line, operator, nth, outcome, reason = (cell.strip() for cell in cells)
        if not re.fullmatch(r"[a-z_]+\.py", file):
            problems.append(f"line {at}: {file!r} is not a module name under {SOURCES}")
        if not line:
            problems.append(f"line {at}: the line's text is empty")
        if not re.fullmatch(r"[A-Za-z_]+", operator):
            problems.append(f"line {at}: {operator!r} is not a cosmic-ray operator name without core/")
        if not re.fullmatch(r"[1-9][0-9]*", nth):
            problems.append(f"line {at}: nth {nth!r} is not a positive whole number")
        if outcome not in OUTCOMES:
            problems.append(f"line {at}: outcome {outcome!r} is not one of {', '.join(OUTCOMES)}")
        if not reason:
            problems.append(f"line {at}: the reason is empty")
        key = (file, line, operator, nth)
        if key in keys:
            problems.append(f"line {at}: the same mutant is listed twice")
        keys.add(key)
        if not problems or all(not p.startswith(f"line {at}:") for p in problems):
            rows.append(Row(file, line, operator, int(nth), outcome, reason, at))
    if not header_seen:
        problems.append("the list has no header")
    return rows, problems


def stale_rows(rows: list[Row], read) -> list[str]:
    """Rows whose line text no longer occurs in their module."""

    problems = []
    for row in rows:
        try:
            text = read(row.file)
        except FileNotFoundError:
            problems.append(f"{row.label()}: {row.file} does not exist")
            continue
        if not any(line.strip() == row.line for line in text.splitlines()):
            problems.append(f"{row.label()}: no line of {row.file} reads like this any more")
    return problems


def read_module(name: str) -> str:
    return (ROOT / SOURCES / name).read_text(encoding="utf-8")


# ------------------------------------------------------------- line maps


class Statements:
    """coverage.py's view of a module: which lines are statements, and the
    first line of the statement each line belongs to."""

    def __init__(self, source: str):
        from coverage.parser import PythonParser

        parser = PythonParser(text=source, exclude=None)
        parser.parse_source()
        self.parser = parser
        self.statements = set(parser.statements)

    def first(self, line: int) -> int:
        return self.parser.first_line(line)

    def executable(self, line: int) -> bool:
        return self.first(line) in self.statements


# ---------------------------------------------------------- the recording


def copy_package(target: Path) -> None:
    shutil.copytree(
        ROOT / PACKAGE,
        target,
        ignore=shutil.ignore_patterns("node_modules", "__pycache__", "dist", "reports", ".stryker-tmp"),
        symlinks=True,
    )


def test_modules(python_dir: Path, pattern: str = "test_*.py") -> list[str]:
    return sorted(f"tests.{p.stem}" for p in (python_dir / "tests").glob(pattern))


def run_env(tmp: Path) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith(("GIT_", "COVERAGE_"))}
    bin_dir = str(Path(sys.executable).parent)
    env["PATH"] = bin_dir + os.pathsep + env.get("PATH", "")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    for name in ("TMPDIR", "TEMP", "TMP"):
        env[name] = str(tmp)
    return env


def fresh(path: Path) -> Path:
    shutil.rmtree(path, ignore_errors=True)
    path.mkdir(parents=True)
    return path


def install_hook(work: Path, modules: list[str]) -> tuple[Path, Path, Path]:
    """The coveragerc, the sidecar and the .pth that start coverage in every child."""

    import sysconfig

    data = fresh(work / "coverage")
    rc = work / "coveragerc"
    sidecar = work / "current-test"
    sidecar.write_text("@none", encoding="utf-8")
    include = "".join(f"    */{name}.py\n" for name in modules)
    rc.write_text(
        "[run]\n"
        "parallel = true\n"
        f"data_file = {data}/.coverage\n"
        "context = ${MUTATION_TEST_CONTEXT}\n"
        f"include =\n    */kavach/*.py\n{include}"
        "disable_warnings = no-data-collected, module-not-imported, module-not-measured, include-ignored, couldnt-parse\n",
        encoding="utf-8",
    )
    config = work / "hook.json"
    config.write_text(json.dumps({"sidecar": str(sidecar), "rc": str(rc)}), encoding="utf-8")
    purelib = Path(sysconfig.get_paths()["purelib"])
    shutil.copy(HOOK, purelib / "kavach_mutation_hook.py")
    pth = purelib / "zz_kavach_mutation.pth"
    pth.write_text(f"import kavach_mutation_hook; kavach_mutation_hook.start({str(config)!r})\n", encoding="utf-8")
    return rc, sidecar, pth


def remove_hook(pth: Path) -> None:
    pth.unlink(missing_ok=True)
    (pth.parent / "kavach_mutation_hook.py").unlink(missing_ok=True)


def record_tests(rc: str, sidecar: str, out: str, pattern: str = "test_*.py") -> int:
    """Runs in the recorder process: every test of the suite, each under its own context."""

    import unittest

    import coverage

    os.environ["MUTATION_TEST_CONTEXT"] = ""
    cov = coverage.Coverage(config_file=rc, data_suffix=True)
    side = Path(sidecar)
    order: list[str] = []
    seconds: dict[str, float] = {}
    failed: list[str] = []

    def mark(name: str) -> None:
        side.write_text(name, encoding="utf-8")
        cov.switch_context(name)

    class Recording(unittest.TextTestResult):
        def startTest(self, test):
            name = test.id()
            order.append(name)
            mark(name)
            self._began = time.monotonic()
            super().startTest(test)

        def stopTest(self, test):
            super().stopTest(test)
            seconds[test.id()] = round(time.monotonic() - self._began, 3)
            mark("@after:" + test.id())

        def addError(self, test, err):
            failed.append(test.id())
            super().addError(test, err)

        def addFailure(self, test, err):
            failed.append(test.id())
            super().addFailure(test, err)

        def addSubTest(self, test, subtest, err):
            if err is not None:
                failed.append(test.id())
            super().addSubTest(test, subtest, err)

        def addUnexpectedSuccess(self, test):
            failed.append(test.id())
            super().addUnexpectedSuccess(test)

    cov.start()
    mark("@load")
    suite = unittest.defaultTestLoader.discover("tests", pattern=pattern, top_level_dir=".")
    mark("@before")
    result = unittest.TextTestRunner(resultclass=Recording, verbosity=1, stream=sys.stderr).run(suite)
    mark("@end")
    cov.stop()
    cov.save()
    Path(out).write_text(
        json.dumps({"order": order, "seconds": seconds, "failed": sorted(set(failed)), "ran": result.testsRun}),
        encoding="utf-8",
    )
    return 0 if result.wasSuccessful() and not failed else 1


def attribute(contexts: set[str], order: list[str]) -> tuple[set[str], set[str], set[str]]:
    """The tests and test modules recorded on a line, and any context that names neither.

    ``@after:X`` and ``@before`` cover what runs between tests: class and
    module fixtures, which run before the next test starts, so they go to
    that test. ``@import:M`` is test module M's import, in a fresh process.
    """

    following = {"@before": order[0] if order else None}
    for index, name in enumerate(order):
        following["@after:" + name] = order[index + 1] if index + 1 < len(order) else None
    tests: set[str] = set()
    imports: set[str] = set()
    strays: set[str] = set()
    for context in contexts:
        if context in ("", "@load", "@end"):
            continue
        if context.startswith("@import:"):
            imports.add(context.removeprefix("@import:"))
        elif context in following:
            if following[context] is not None:
                tests.add(following[context])
        elif context.startswith("@"):
            strays.add(context)
        else:
            tests.add(context)
    return tests, imports, strays


def module_of(path: str, modules: set[str]) -> str | None:
    """The kavach module a measured file is, by name: tests copy guards into temp folders."""

    if "/site-packages/" in path or path.startswith(sys.base_prefix + "/lib/") or path.startswith("/usr/lib/"):
        return None
    name = os.path.basename(path)
    return name[:-3] if name.endswith(".py") and name[:-3] in modules else None


def record(work: Path, python: str, modules: list[str], pattern: str = "test_*.py") -> dict:
    """Runs the whole suite once under coverage and returns what each line was run by.

    ``pattern`` narrows the suite for a quick local try; CI runs it whole.
    """

    import coverage

    copy = work / "record"
    shutil.rmtree(copy, ignore_errors=True)
    copy_package(copy)
    python_dir = copy / "python"
    tmp = work / "record-tmp"
    rc, sidecar, pth = install_hook(work, modules)
    out = work / "record-run.json"
    timings = {}
    try:
        # Each test module's import, alone in a fresh process, so a line that
        # runs at import is tied to every module that imports it.
        start = time.monotonic()
        for name in test_modules(python_dir, pattern):
            sidecar.write_text("@import:" + name, encoding="utf-8")
            done = subprocess.run(
                [python, "-B", "-c", f"import {name}"],
                cwd=python_dir,
                env=run_env(fresh(tmp)),
                capture_output=True,
                text=True,
                timeout=600,
            )
            if done.returncode != 0:
                raise GateError(f"importing {name} under coverage failed:\n{done.stderr[-2000:]}")
        timings["imports"] = round(time.monotonic() - start, 1)
        sidecar.write_text("@none", encoding="utf-8")
        start = time.monotonic()
        env = run_env(fresh(tmp))
        env["MUTATION_RECORDER"] = "1"
        with open(work / "record.log", "w", encoding="utf-8") as log:
            done = subprocess.run(
                [python, "-B", str(Path(__file__).resolve()), "record-tests", str(rc), str(sidecar), str(out), pattern],
                cwd=python_dir,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=4 * 3600,
            )
        timings["suite"] = round(time.monotonic() - start, 1)
    finally:
        remove_hook(pth)
    run = json.loads(out.read_text(encoding="utf-8")) if out.exists() else None
    if done.returncode != 0 or run is None:
        tail = (work / "record.log").read_text(encoding="utf-8")[-4000:]
        failed = ", ".join(run["failed"][:20]) if run else "none recorded"
        raise GateError(f"the unmutated suite failed under coverage (failed: {failed}):\n{tail}")
    start = time.monotonic()
    cov = coverage.Coverage(data_file=str(work / "coverage" / ".coverage"), config_file=False)
    cov.combine([str(work / "coverage")], strict=True)
    data = cov.get_data()
    names = set(modules)
    lines: dict[str, dict[int, set[str]]] = {m: defaultdict(set) for m in modules}
    for path in data.measured_files():
        module = module_of(path, names)
        if module is None:
            continue
        for number, contexts in data.contexts_by_lineno(path).items():
            lines[module][number].update(contexts)
    timings["combine"] = round(time.monotonic() - start, 1)
    order = run["order"]
    result: dict = {"order": order, "seconds": run["seconds"], "timings": timings, "modules": {}, "strays": []}
    for module in modules:
        statements = Statements(read_module(module + ".py"))
        merged: dict[int, tuple[set[str], set[str]]] = {}
        for number, contexts in lines[module].items():
            tests, imports, strays = attribute(contexts, order)
            result["strays"].extend(f"{module}.py:{number} {s}" for s in sorted(strays))
            first = statements.first(number)
            have = merged.setdefault(first, (set(), set()))
            have[0].update(tests)
            have[1].update(imports)
        result["modules"][module] = {
            str(n): {"tests": sorted(t), "imports": sorted(i)} for n, (t, i) in sorted(merged.items()) if t or i
        }
    return result


# ------------------------------------------------------------ the mutants


@dataclass
class Mutant:
    module: str
    operator: str  # without core/
    occurrence: int
    start: tuple[int, int]
    end: tuple[int, int]
    args: dict
    line_text: str
    expected: str = "killed"
    row: Row | None = None
    tests: list[str] = field(default_factory=list)
    outcome: str = ""
    seconds: float = 0.0
    detail: str = ""

    def lines(self) -> range:
        return range(self.start[0], self.end[0] + 1)

    def label(self) -> str:
        return f"{self.module}.py:{self.start[0]}:{self.start[1]} {self.operator}"


def enumerate_mutants(work: Path, module: str) -> list[Mutant]:
    where = fresh(work / "init" / module)
    shutil.copy(ROOT / SOURCES / f"{module}.py", where / f"{module}.py")
    config = where / "cosmic-ray.toml"
    config.write_text(
        f'[cosmic-ray]\nmodule-path = "{module}.py"\ntimeout = 600.0\nexcluded-modules = []\n'
        'test-command = "true"\n\n[cosmic-ray.distributor]\nname = "local"\n',
        encoding="utf-8",
    )
    tool = str(Path(sys.executable).parent / "cosmic-ray")
    subprocess.run([tool, "init", str(config), "session.sqlite"], cwd=where, check=True, capture_output=True)
    dump = subprocess.run([tool, "dump", "session.sqlite"], cwd=where, check=True, capture_output=True, text=True).stdout
    source = read_module(module + ".py").splitlines()
    found = []
    for line in dump.splitlines():
        if not line.strip():
            continue
        item, _ = json.loads(line)
        (m,) = item["mutations"]
        start, end = tuple(m["start_pos"]), tuple(m.get("end_pos") or m["start_pos"])
        found.append(
            Mutant(
                module=module,
                operator=m["operator_name"].removeprefix("core/"),
                occurrence=m["occurrence"],
                start=start,
                end=end,
                args=m.get("operator_args") or {},
                line_text=source[start[0] - 1].strip() if start[0] - 1 < len(source) else "",
            )
        )
    return found


def listed(mutants: list[Mutant], row: Row) -> list[Mutant]:
    """The mutants a row names: the nth of its operator, by column, on each line with its text."""

    by_line: dict[int, list[Mutant]] = defaultdict(list)
    for mutant in mutants:
        if mutant.operator == row.operator and mutant.line_text == row.line:
            by_line[mutant.start[0]].append(mutant)
    picked = []
    for _, group in sorted(by_line.items()):
        group.sort(key=lambda m: (m.start[1], m.occurrence))
        if row.nth <= len(group):
            picked.append(group[row.nth - 1])
    return picked


def select(mutant_lines, statements: Statements, recorded: dict, seconds: dict) -> list[str]:
    """The unittest names a mutant runs: its lines' tests, then the test modules that import them."""

    tests: set[str] = set()
    imports: set[str] = set()
    for number in mutant_lines:
        entry = recorded.get(str(statements.first(number)))
        if entry:
            tests.update(entry["tests"])
            imports.update(entry["imports"])
    # Tests of one class run together, so its fixtures run once; the cheapest
    # class first, so a killing test is reached soon.
    classes: dict[str, list[str]] = defaultdict(list)
    for name in tests:
        classes[name.rsplit(".", 1)[0]].append(name)
    ordered = []
    for _, names in sorted(classes.items(), key=lambda kv: (sum(seconds.get(n, 0) for n in kv[1]), kv[0])):
        ordered.extend(sorted(names, key=lambda n: (seconds.get(n, 0), n)))
    module_cost = defaultdict(float)
    for name, value in seconds.items():
        module_cost[".".join(name.split(".")[:2])] += value
    ordered.extend(sorted(imports, key=lambda m: (module_cost[m], m)))
    return ordered


def cost(names: list[str], seconds: dict) -> float:
    total = 0.0
    for name in names:
        if name.count(".") == 1:
            total += sum(v for k, v in seconds.items() if k.startswith(name + "."))
        else:
            total += seconds.get(name, 0.0)
    return total


# ------------------------------------------------------------ test runs


def cap_main(report: str, command: list[str]) -> int:
    """Runs in the wrapper: the caps hold for the tests and every child they start."""

    import resource

    applied = []
    for limit, value in ((resource.RLIMIT_AS, MEMORY_CAP), (resource.RLIMIT_FSIZE, FILE_CAP)):
        try:
            resource.setrlimit(limit, (value, value))
            applied.append(limit)
        except (ValueError, OSError):
            pass
    code = subprocess.run(command).returncode
    maxrss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    # Linux reports kilobytes, macOS bytes.
    maxrss = maxrss if sys.platform == "darwin" else maxrss * 1024
    Path(report).write_text(json.dumps({"code": code, "maxrss": maxrss, "caps": len(applied)}), encoding="utf-8")
    return 128 - code if code < 0 else code


def classify(timed_out: bool, code: int | None, output: str, maxrss: int, big_file: bool) -> str:
    if timed_out:
        return "timeout"
    if code is None or code >= 128 or code < 0 or big_file or maxrss >= NEAR_MEMORY_CAP:
        return "capped"
    if any(sign in output for sign in CAP_SIGNS):
        return "capped"
    if code == 0:
        return "survived"
    if code == 5:
        return "error"  # unittest ran no test
    return "killed"


def largest_file(root: Path) -> int:
    biggest = 0
    for dirpath, _, files in os.walk(root):
        for name in files:
            try:
                biggest = max(biggest, os.lstat(os.path.join(dirpath, name)).st_size)
            except OSError:
                pass
    return biggest


def run_tests(copy: Path, names: list[str], timeout: float, tmp: Path) -> tuple[str, float, str]:
    """One capped, failfast run of the named tests in a copy of the package."""

    fresh(tmp)
    report = tmp.parent / (tmp.name + ".report.json")
    report.unlink(missing_ok=True)
    command = [sys.executable, "-B", str(Path(__file__).resolve()), "cap", str(report), "--"]
    command += [sys.executable, "-B", "-m", "unittest", "-f", *names]
    start = time.monotonic()
    proc = subprocess.Popen(
        command,
        cwd=copy / "python",
        env=run_env(tmp),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    timed_out = False
    try:
        output, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, 9)
        except OSError:
            proc.kill()
        output, _ = proc.communicate()
    seconds = round(time.monotonic() - start, 1)
    text = output.decode("utf-8", "replace")
    try:
        reported = json.loads(report.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        reported = {"code": None, "maxrss": 0}
    # The wrapper dies with its tests only when a cap or a signal took it.
    code = proc.returncode if reported["code"] is None else reported["code"]
    big = largest_file(tmp) >= FILE_CAP - 1024 * 1024
    outcome = classify(timed_out, code, text, reported["maxrss"], big)
    shutil.rmtree(tmp, ignore_errors=True)
    return outcome, seconds, text[-3000:]


class Copies:
    """One copy of the package per worker; cosmic-ray mutates a file in place."""

    def __init__(self, work: Path, count: int):
        self.free: queue.Queue[tuple[int, Path]] = queue.Queue()
        for index in range(count):
            target = work / f"w{index}"
            shutil.rmtree(target, ignore_errors=True)
            copy_package(target)
            self.free.put((index, target))

    def take(self):
        return self.free.get()

    def give(self, item):
        self.free.put(item)


def mutate_and_run(copies: Copies, work: Path, mutant: Mutant, timeout: float) -> None:
    import cosmic_ray.plugins
    from cosmic_ray.mutating import use_mutation

    index, copy = copies.take()
    try:
        operator = cosmic_ray.plugins.get_operator("core/" + mutant.operator)(**mutant.args)
        path = copy / "python" / "kavach" / f"{mutant.module}.py"
        with use_mutation(path, operator, mutant.occurrence) as (_, mutated):
            if mutated is None:
                mutant.outcome, mutant.detail = "error", "cosmic-ray made no mutation"
                return
            for stale in (copy / "python" / "kavach" / "__pycache__",):
                shutil.rmtree(stale, ignore_errors=True)
            mutant.outcome, mutant.seconds, mutant.detail = run_tests(
                copy, mutant.tests, timeout, work / "tmp" / f"w{index}"
            )
    finally:
        copies.give((index, copy))


def baseline(copies: Copies, work: Path, names: list[str], timeout: float) -> tuple[str, float, str]:
    index, copy = copies.take()
    try:
        return run_tests(copy, names, timeout, work / "tmp" / f"w{index}")
    finally:
        copies.give((index, copy))


# ------------------------------------------------------------- the verdict


@dataclass
class Verdict:
    refusals: list[str] = field(default_factory=list)
    uncovered: list[str] = field(default_factory=list)
    mutants: list[Mutant] = field(default_factory=list)
    faults: list[str] = field(default_factory=list)
    timings: dict = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return not (self.refusals or self.uncovered or self.faults)


def judge(mutants: list[Mutant]) -> list[str]:
    refusals = []
    for mutant in mutants:
        if mutant.outcome == mutant.expected:
            continue
        if mutant.outcome == "uncovered" and mutant.row is None:
            continue  # its changed line is refused as uncovered already
        if mutant.row is not None:
            refusals.append(
                f"{mutant.label()} on `{mutant.line_text}`: listed as {mutant.expected} "
                f"(list line {mutant.row.at}), got {mutant.outcome}"
            )
        else:
            refusals.append(f"{mutant.label()} on `{mutant.line_text}`: {mutant.outcome}")
    return refusals


def plan(base: str) -> dict:
    """What the pull request asks the gate to judge; problems found without running a mutant."""

    modules, list_lines = changed(base)
    problems = [f"`{hit}` has a no-mutate pragma" for hit in pragma_hits(ROOT / PRAGMA_ROOT)]
    rows: list[Row] = []
    if (ROOT / LIST).exists():
        rows, list_problems = parse_list((ROOT / LIST).read_text(encoding="utf-8"))
        problems += [f"{LIST}, {p}" for p in list_problems]
        problems += [f"{LIST}: {p}" for p in stale_rows(rows, read_module)]
    else:
        problems.append(f"{LIST} is missing")
    changed_rows = [row.at for row in rows if row.at in list_lines]
    lines = {Path(path).stem: sorted(numbers) for path, numbers in sorted(modules.items())}
    return {"lines": lines, "rows": changed_rows, "problems": problems, "any": bool(lines or changed_rows)}


def run(base: str, work: Path, workers: int, pattern: str = "test_*.py") -> Verdict:
    verdict = Verdict()
    began = time.monotonic()
    planned = plan(base)
    verdict.refusals += planned["problems"]
    rows, _ = parse_list((ROOT / LIST).read_text(encoding="utf-8"))
    changed_rows = set(planned["rows"])
    work.mkdir(parents=True, exist_ok=True)

    # The mutants on changed lines, and those of the rows to check.
    wanted: dict[str, set[int]] = {m: set(lines) for m, lines in planned["lines"].items()}
    for row in rows:
        module = row.file[:-3]
        if row.at in changed_rows:
            wanted.setdefault(module, set())
    start = time.monotonic()
    every: dict[str, list[Mutant]] = {module: enumerate_mutants(work, module) for module in sorted(wanted)}
    verdict.timings["enumerate"] = round(time.monotonic() - start, 1)
    chosen: dict[tuple, Mutant] = {}
    for module, mutants in every.items():
        lines = wanted[module]
        for mutant in mutants:
            if lines.intersection(mutant.lines()):
                chosen[(module, mutant.operator, mutant.occurrence)] = mutant
    for row in rows:
        module = row.file[:-3]
        if module not in every:
            continue
        on_changed = any(m.start[0] in wanted[module] for m in listed(every[module], row))
        named = listed(every[module], row)
        if not named and (row.at in changed_rows or on_changed):
            verdict.refusals.append(f"{LIST} line {row.at}, {row.label()}: cosmic-ray makes no such mutant")
        for mutant in named:
            if row.at in changed_rows or mutant.start[0] in wanted[module]:
                mutant = chosen.setdefault((module, mutant.operator, mutant.occurrence), mutant)
                mutant.expected, mutant.row = row.outcome, row

    executable = [
        (module, number)
        for module, lines in planned["lines"].items()
        for number in lines
        if Statements(read_module(module + ".py")).executable(number)
    ]
    if not chosen and not executable:
        # Comments, blank lines or docstrings only: nothing to record or run.
        verdict.timings["total"] = round(time.monotonic() - began, 1)
        return verdict

    modules = sorted(p.stem for p in (ROOT / SOURCES).glob("*.py") if p.stem != "__init__")
    recorded = record(work, sys.executable, modules, pattern)
    verdict.timings["record"] = recorded["timings"]
    if recorded["strays"]:
        verdict.faults.append("lines recorded under no test: " + ", ".join(recorded["strays"][:20]))
    seconds = recorded["seconds"]

    # Uncovered: a changed statement no test runs.
    for module, lines in planned["lines"].items():
        statements = Statements(read_module(module + ".py"))
        source = read_module(module + ".py").splitlines()
        cover = recorded["modules"].get(module, {})
        for number in lines:
            if statements.executable(number) and str(statements.first(number)) not in cover:
                verdict.uncovered.append(f"{module}.py:{number} `{source[number - 1].strip()}`")

    statements_of = {module: Statements(read_module(module + ".py")) for module in every}
    for mutant in chosen.values():
        mutant.tests = select(mutant.lines(), statements_of[mutant.module], recorded["modules"].get(mutant.module, {}), seconds)
        if not mutant.tests:
            mutant.outcome = "uncovered"

    to_run = [m for m in chosen.values() if m.tests]
    copies = Copies(work, max(1, workers))
    selections = sorted({tuple(m.tests) for m in to_run})
    start = time.monotonic()
    limits: dict[tuple, float] = {}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {
            names: pool.submit(baseline, copies, work, list(names), max(600.0, 4 * cost(list(names), seconds) + 120))
            for names in selections
        }
        for names, future in futures.items():
            outcome, took, detail = future.result()
            if outcome != "survived":
                verdict.faults.append(
                    f"the unmutated run of {len(names)} selected test(s) gave {outcome}, not a pass: "
                    f"{' '.join(names[:5])}{' ...' if len(names) > 5 else ''}\n{detail[-1500:]}"
                )
            limits[names] = max(60.0, 3 * took + 30)
    verdict.timings["baselines"] = round(time.monotonic() - start, 1)
    if verdict.faults:
        verdict.mutants = list(chosen.values())
        verdict.timings["total"] = round(time.monotonic() - began, 1)
        return verdict

    start = time.monotonic()
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for future in [pool.submit(mutate_and_run, copies, work, m, limits[tuple(m.tests)]) for m in to_run]:
            future.result()
    verdict.timings["mutants"] = round(time.monotonic() - start, 1)
    verdict.mutants = sorted(chosen.values(), key=lambda m: (m.module, m.start, m.operator, m.occurrence))
    verdict.refusals += judge(verdict.mutants)
    verdict.timings["total"] = round(time.monotonic() - began, 1)
    return verdict


def report(verdict: Verdict) -> str:
    counts: dict[str, int] = defaultdict(int)
    for mutant in verdict.mutants:
        counts[mutant.outcome] += 1
    md = ["## kavach Python mutation (cosmic-ray 8.9.0)", ""]
    md.append(f"- **{'Passed' if verdict.passed else 'Refused'}.** {len(verdict.mutants)} mutant(s): "
              + (", ".join(f"{n} {k}" for k, n in sorted(counts.items())) or "none"))
    md.append(f"- Time: `{json.dumps(verdict.timings)}`")
    for title, items in (("Faults in the run", verdict.faults), ("Uncovered changed lines", verdict.uncovered),
                         ("Refused", verdict.refusals)):
        if items:
            md += ["", f"### {title}", ""] + [f"- {item}" for item in items]
    if verdict.mutants:
        md += ["", "<details><summary>Every mutant</summary>", "", "| Mutant | Line | Expected | Outcome | Tests | Time |",
               "|---|---|---|---|---|---|"]
        for m in verdict.mutants:
            md.append(f"| `{m.label()}` | `{m.line_text[:80]}` | {m.expected} | {m.outcome} | {len(m.tests)} | {m.seconds} s |")
        md += ["", "</details>"]
    return "\n".join(md) + "\n"


def main(argv: list[str]) -> int:
    if argv[:1] == ["cap"]:
        split = argv.index("--")
        return cap_main(argv[1], argv[split + 1 :])
    if argv[:1] == ["record-tests"]:
        return record_tests(*argv[1:5])
    parser = argparse.ArgumentParser(prog="gate.py", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--base", required=True)
    r = sub.add_parser("run")
    r.add_argument("--base", required=True)
    r.add_argument("--work", required=True, type=Path)
    r.add_argument("--workers", type=int, default=os.cpu_count() or 1)
    r.add_argument("--pattern", default="test_*.py", help="the test files to record, for a quick local try")
    args = parser.parse_args(argv)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if args.command == "plan":
        planned = plan(args.base)
        print(json.dumps(planned, indent=1))
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            with open(output, "a", encoding="utf-8") as handle:
                handle.write(f"any={'true' if planned['any'] else 'false'}\n")
        if planned["problems"]:
            text = "## kavach Python mutation plan\n\n" + "".join(f"- {p}\n" for p in planned["problems"])
            print(text, file=sys.stderr)
            if summary:
                Path(summary).open("a", encoding="utf-8").write(text)
            return 1
        return 0
    args.work.mkdir(parents=True, exist_ok=True)
    try:
        verdict = run(args.base, args.work.resolve(), args.workers, args.pattern)
    except GateError as error:
        verdict = Verdict(faults=[str(error)])
    text = report(verdict)
    (args.work / "report.md").write_text(text, encoding="utf-8")
    (args.work / "mutants.json").write_text(
        json.dumps([{k: v for k, v in vars(m).items() if k != "row"} for m in verdict.mutants], indent=1, default=str),
        encoding="utf-8",
    )
    print(text)
    if summary:
        Path(summary).open("a", encoding="utf-8").write(text)
    return 0 if verdict.passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
