"""Tests of the kavach Python mutation gate's own logic (veda#558).

Run from the repository root:
python3 -B -m unittest discover -s scripts/kavach_mutation -t scripts/kavach_mutation
They need coverage.py (for the statement map) and nothing of kavach's.
"""

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import gate  # noqa: E402
import hook  # noqa: E402

HEADER = "\t".join(gate.COLUMNS)


def row_text(*cells: str) -> str:
    return "\t".join(cells)


class AddedLines(unittest.TestCase):
    def test_new_side_lines_of_each_hunk(self):
        diff = textwrap.dedent(
            """\
            diff --git a/packages/kavach/python/kavach/rules.py b/packages/kavach/python/kavach/rules.py
            --- a/packages/kavach/python/kavach/rules.py
            +++ b/packages/kavach/python/kavach/rules.py
            @@ -10 +10 @@ def x():
            -a
            +b
            @@ -20,0 +21,3 @@ def y():
            +c
            +d
            +e
            @@ -40,2 +43,0 @@ def z():
            -f
            -g
            """
        )
        self.assertEqual(gate.added_lines(diff), {"packages/kavach/python/kavach/rules.py": {10, 21, 22, 23}})

    def test_a_deleted_file_and_a_pure_deletion_add_nothing(self):
        diff = textwrap.dedent(
            """\
            --- a/packages/kavach/python/kavach/old.py
            +++ /dev/null
            @@ -1,2 +0,0 @@
            -a
            -b
            --- a/packages/kavach/python/kavach/rules.py
            +++ b/packages/kavach/python/kavach/rules.py
            @@ -5,1 +4,0 @@
            -a
            """
        )
        self.assertEqual(gate.added_lines(diff), {})

    def test_a_new_file_adds_every_line(self):
        diff = "--- /dev/null\n+++ b/packages/kavach/python/kavach/new.py\n@@ -0,0 +1,2 @@\n+a\n+b\n"
        self.assertEqual(gate.added_lines(diff), {"packages/kavach/python/kavach/new.py": {1, 2}})


class Pragma(unittest.TestCase):
    def test_every_spelling_is_found_and_other_pragmas_are_not(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "a.py").write_text("x = 1  # pragma: no mutate\ny = 2  # pragma: no cover\n")
            (root / "tests").mkdir()
            (root / "tests" / "b.py").write_text("# PRAGMA:no-mutate\n")
            (root / "c.tsv").write_text("ok\tpragma : no_mutate\n")
            (root / "__pycache__").mkdir()
            (root / "__pycache__" / "d.py").write_text("# pragma: no mutate\n")
            hits = gate.pragma_hits(root)
        self.assertEqual([h.rsplit("/", 1)[-1] for h in hits], ["a.py:1", "c.tsv:1", "b.py:1"])


class ParseList(unittest.TestCase):
    def test_rows_and_comments(self):
        text = "\n".join(
            [
                "# a comment",
                HEADER,
                row_text("rules.py", "if a == b:", "ReplaceComparisonOperator_Eq_LtE", "1", "survived", "why"),
                "",
                row_text("boundary.py", "while i < n:", "NumberReplacer", "2", "timeout", "runs away"),
            ]
        )
        rows, problems = gate.parse_list(text)
        self.assertEqual(problems, [])
        self.assertEqual(
            [(r.file, r.line, r.operator, r.nth, r.outcome, r.at) for r in rows],
            [
                ("rules.py", "if a == b:", "ReplaceComparisonOperator_Eq_LtE", 1, "survived", 3),
                ("boundary.py", "while i < n:", "NumberReplacer", 2, "timeout", 5),
            ],
        )

    def test_each_fault_is_named_and_its_row_dropped(self):
        text = "\n".join(
            [
                HEADER,
                row_text("rules.py", "x", "Op", "1", "killed", "why"),
                row_text("rules.py", "x", "Op", "0", "survived", "why"),
                row_text("../x.py", "x", "Op", "1", "survived", "why"),
                row_text("rules.py", "", "Op", "1", "survived", "why"),
                row_text("rules.py", "x", "core/Op", "1", "survived", "why"),
                row_text("rules.py", "x", "Op", "1", "survived", ""),
                row_text("rules.py", "x", "Op", "1", "survived"),
                row_text("rules.py", "y", "Op", "1", "capped", "why"),
                row_text("rules.py", "y", "Op", "1", "timeout", "again"),
            ]
        )
        rows, problems = gate.parse_list(text)
        self.assertEqual([r.at for r in rows], [9])
        joined = "\n".join(problems)
        for expected in (
            "line 2: outcome 'killed'",
            "line 3: nth '0'",
            "line 4: '../x.py' is not a module name",
            "line 5: the line's text is empty",
            "line 6: 'core/Op' is not a cosmic-ray operator name",
            "line 7: the reason is empty",
            "line 8: 5 tab-separated cells, not 6",
            "line 10: the same mutant is listed twice",
        ):
            self.assertIn(expected, joined)

    def test_a_wrong_or_missing_header(self):
        self.assertIn("line 1: the header must be", gate.parse_list("file\tline\n")[1][0])
        self.assertEqual(gate.parse_list("# only a comment\n")[1], ["the list has no header"])

    def test_the_repository_list_parses_and_holds_on_main(self):
        rows, problems = gate.parse_list((gate.ROOT / gate.LIST).read_text(encoding="utf-8"))
        self.assertEqual(problems, [])
        self.assertGreaterEqual(len(rows), 12)
        self.assertEqual(gate.stale_rows(rows, gate.read_module), [])


class StaleRows(unittest.TestCase):
    def test_a_row_whose_line_is_gone_or_whose_file_is_missing(self):
        rows, _ = gate.parse_list(
            "\n".join(
                [
                    HEADER,
                    row_text("a.py", "if x == 1:", "Op", "1", "survived", "why"),
                    row_text("a.py", "if y == 1:", "Op", "1", "survived", "why"),
                    row_text("b.py", "z", "Op", "1", "survived", "why"),
                ]
            )
        )

        def read(name):
            if name == "a.py":
                return "def f():\n    if x == 1:\n        pass\n"
            raise FileNotFoundError(name)

        problems = gate.stale_rows(rows, read)
        self.assertEqual(len(problems), 2)
        self.assertIn("if y == 1:", problems[0])
        self.assertIn("b.py does not exist", problems[1])


class StatementsMap(unittest.TestCase):
    SOURCE = textwrap.dedent(
        '''\
        """Docstring."""
        # a comment

        def f(a,
              b=2):
            return g(a,
                     b)
        '''
    )

    def test_continuation_lines_belong_to_their_statement(self):
        s = gate.Statements(self.SOURCE)
        self.assertEqual(s.first(5), 4)
        self.assertEqual(s.first(7), 6)
        self.assertTrue(s.executable(7))

    def test_comments_blank_lines_and_docstrings_are_not_executable(self):
        s = gate.Statements(self.SOURCE)
        for line in (1, 2, 3):
            self.assertFalse(s.executable(line), line)


class Attribute(unittest.TestCase):
    ORDER = ["tests.t.A.test_1", "tests.t.B.test_2"]

    def test_fixtures_between_tests_go_to_the_tests_either_side(self):
        """Teardown of a test's class runs after it; setup of the next test's before that test."""

        cases = {
            "@before": {"tests.t.A.test_1"},
            "@after:tests.t.A.test_1": {"tests.t.A.test_1", "tests.t.B.test_2"},
            # The last class's and module's teardown: no next test, so the last one.
            "@after:tests.t.B.test_2": {"tests.t.B.test_2"},
            "tests.t.A.test_1": {"tests.t.A.test_1"},
        }
        for context, expected in cases.items():
            with self.subTest(context=context):
                self.assertEqual(gate.attribute({context}, self.ORDER), (expected, set(), set()))

    def test_imports_loading_and_strays(self):
        tests, imports, strays = gate.attribute({"", "@load", "@end", "@import:tests.t", "@none"}, self.ORDER)
        self.assertEqual((tests, imports, strays), (set(), {"tests.t"}, {"@none", "(no context)"}))


class ModuleOf(unittest.TestCase):
    def test_by_name_but_never_python_or_site_packages(self):
        names = {"rules", "config"}
        self.assertEqual(gate.module_of("/w/record/python/kavach/rules.py", names), "rules")
        self.assertEqual(gate.module_of("/tmp/vt-1/copy/config.py", names), "config")
        self.assertIsNone(gate.module_of("/v/lib/python3.12/site-packages/x/config.py", names))
        self.assertIsNone(gate.module_of(sys.base_prefix + "/lib/python3.12/logging/config.py", names))
        self.assertIsNone(gate.module_of("/w/record/python/tests/test_rules.py", names))


def mutant(line: int, col: int, operator="ReplaceComparisonOperator_Eq_Is", occurrence=0, text="a == b == c"):
    return gate.Mutant("m", operator, occurrence, (line, col), (line, col + 2), {}, text)


class Listed(unittest.TestCase):
    def test_the_nth_by_column_on_every_line_with_the_text(self):
        mutants = [
            mutant(3, 9, occurrence=1),
            mutant(3, 2, occurrence=0),
            mutant(8, 2, occurrence=2),
            mutant(8, 9, operator="Other", occurrence=0),
            mutant(9, 2, occurrence=3, text="x == y"),
        ]
        row = gate.Row("m.py", "a == b == c", "ReplaceComparisonOperator_Eq_Is", 1, "survived", "r", 2)
        self.assertEqual([(m.start, m.occurrence) for m in gate.listed(mutants, row)], [((3, 2), 0), ((8, 2), 2)])
        second = gate.Row("m.py", "a == b == c", "ReplaceComparisonOperator_Eq_Is", 2, "survived", "r", 2)
        self.assertEqual([m.occurrence for m in gate.listed(mutants, second)], [1])


def bar(source: str, line: int, nth: int = 1, operator: str = "ReplaceBinaryOperator_BitOr_Add", module: str = "m"):
    """A mutant of the nth `|` on a line, spanning it as cosmic-ray's does."""

    text = source.split("\n")[line - 1]
    col = -1
    for _ in range(nth):
        col = text.index("|", col + 1)
    return gate.Mutant(module, operator, 0, (line, col), (line, col + 1), {}, text.strip())


DEFERRED = textwrap.dedent(
    """\
    from __future__ import annotations

    def f(x: int | None = a | b, *rest: str | bytes, **kw: int | str) -> Path | None:
        y: int | str = c | d
        return e | f


    class C:
        z: list[int] | None = None
    """
)


class AnnotationSpans(unittest.TestCase):
    def spans(self, source: str):
        return gate.annotation_spans(source)

    def test_each_annotation_is_a_span_and_values_are_not(self):
        spans = self.spans(DEFERRED)
        inside = lambda line, nth: gate.inside(bar(DEFERRED, line, nth), spans)
        # x's annotation, then its default a | b, then *rest's, **kw's and the return's.
        self.assertEqual([inside(3, n) for n in range(1, 6)], [True, False, True, True, True])
        self.assertEqual([inside(4, 1), inside(4, 2)], [True, False])  # y: int | str = c | d
        self.assertFalse(inside(5, 1))  # the body
        self.assertTrue(inside(9, 1))  # a class attribute's annotation

    def test_a_module_without_the_future_import_has_none(self):
        self.assertEqual(self.spans(DEFERRED.replace("from __future__ import annotations", "import os")), [])
        self.assertEqual(self.spans("from __future__ import division\ndef f() -> int | None: ...\n"), [])

    def test_columns_are_characters_not_bytes(self):
        source = 'from __future__ import annotations\ndef f(é: str = "üü") -> int | None: ...\n'
        spans = self.spans(source)
        self.assertTrue(gate.inside(bar(source, 2), spans))
        # The span ends with `None`, in characters: a mutant just past it is outside.
        text = source.split("\n")[1]
        end = text.index(":", text.index("None"))
        past = gate.Mutant("m", "Op", 0, (2, end), (2, end + 1), {}, text)
        self.assertFalse(gate.inside(past, spans))

    def test_the_positions_of_veda_650s_run(self):
        # cosmic-ray's positions of the 55 survivors in run 45936765161, on
        # these lines as they read at 17dc453.
        lines = {
            ("boundary", 76): "def recorded_folder(session_id: object, environ: Mapping[str, str]) -> Path | None:",
            ("boundary", 87): "def session_worktree(session_id: object, own: Any, environ: Mapping[str, str]) -> Path | None:",
            ("boundary", 92): "def session_main_checkout(session_id: object, own: Any, environ: Mapping[str, str]) -> Path | None:",
            ("rules", 46): "def recorded_main_checkout(call: Call) -> str | None:",
            ("rules", 84): "def main_checkout_way_out(target: str, root: str, started: str) -> tuple[str, bool] | None:",
        }
        for (module, col), line in lines.items():
            with self.subTest(module=module, col=col):
                source = f"from __future__ import annotations\n{line}\n    pass\n"
                self.assertEqual(line.index("|"), col)
                mutant = gate.Mutant(module, "ReplaceBinaryOperator_BitOr_Pow", 0, (2, col), (2, col + 1), {}, line)
                self.assertTrue(gate.inside(mutant, self.spans(source)))

    def test_a_package_that_reads_annotations_skips_nothing_and_says_where(self):
        for reader in ("typing.get_type_hints(f)", "f.__annotations__", "inspect.signature(f)",
                       "from inspect import signature", "import annotationlib", "f.__annotate__",
                       "from functools import singledispatch"):
            with self.subTest(reader=reader):
                readers = {"a/m.py": DEFERRED, "a/tests/test_m.py": f"{reader}\n"}
                spans, found = gate.unevaluated({"m": DEFERRED}, readers)
                self.assertEqual((spans, found), ({"m": []}, "a/tests/test_m.py"))
        spans, found = gate.unevaluated({"m": DEFERRED}, {"a/m.py": DEFERRED, "a/tests/test_m.py": "x = 1\n"})
        self.assertIsNone(found)
        self.assertNotEqual(spans["m"], [])

    def test_the_scope_reads_kavachs_modules_and_its_tests(self):
        sources, readers = gate.read_annotation_scope()
        self.assertIn("boundary", sources)
        self.assertIn("packages/kavach/python/kavach/boundary.py", readers)
        self.assertIn("packages/kavach/python/tests/test_rules.py", readers)


class Choose(unittest.TestCase):
    def test_annotation_mutants_are_skipped_unless_a_row_names_them(self):
        source = DEFERRED
        spans = {"m": gate.annotation_spans(source)}
        annotated = bar(source, 3, 5)  # the return annotation's `|`
        default = bar(source, 3, 2)  # a | b
        default.occurrence = 1
        listed = bar(source, 4, 1, operator="ReplaceBinaryOperator_BitOr_Sub")  # y's annotation
        every = {"m": [annotated, default, listed]}
        row = gate.Row("m.py", listed.line_text, listed.operator, 1, "survived", "r", 7)
        chosen, skipped, refusals = gate.choose(every, {"m": {3, 4}}, [row], set(), spans)
        self.assertEqual(skipped, [annotated])
        self.assertEqual(sorted(m.start for m in chosen.values()), [default.start, listed.start])
        self.assertEqual(listed.expected, "survived")
        self.assertEqual(refusals, [])

    def test_off_a_changed_line_nothing_is_chosen_or_skipped(self):
        annotated = bar(DEFERRED, 3, 5)
        chosen, skipped, _ = gate.choose({"m": [annotated]}, {"m": {5}}, [], set(), {"m": gate.annotation_spans(DEFERRED)})
        self.assertEqual((chosen, skipped), ({}, []))

    def test_without_spans_every_mutant_is_chosen(self):
        mutants = [bar(DEFERRED, 3, n) for n in range(1, 6)]
        for n, m in enumerate(mutants):
            m.occurrence = n
        chosen, skipped, _ = gate.choose({"m": mutants}, {"m": {3}}, [], set(), {"m": []})
        self.assertEqual((len(chosen), skipped), (5, []))

    def test_the_report_lists_what_was_skipped(self):
        verdict = gate.Verdict(skipped=[bar(DEFERRED, 3, 5)])
        text = gate.report(verdict)
        self.assertIn("- Skipped: 1 mutant(s) inside an annotation never evaluated", text)
        self.assertIn("### Skipped: inside an annotation never evaluated", text)
        self.assertIn("`m.py:3:", text)

    def test_the_report_names_the_file_that_turned_the_skip_off(self):
        text = gate.report(gate.Verdict(annotation_reader="packages/kavach/python/tests/test_x.py"))
        self.assertIn(
            "- Skipped: none: `packages/kavach/python/tests/test_x.py` reads annotations at run time", text
        )


COSMIC_RAY = Path(sys.executable).parent / "cosmic-ray"


# In CI the plan job installs cosmic-ray, so there the test runs or fails.
@unittest.skipUnless(COSMIC_RAY.exists() or os.environ.get("GITHUB_ACTIONS"), "cosmic-ray is installed in the plan job")
class RealMutants(unittest.TestCase):
    def test_exactly_the_annotation_mutants_of_a_module_are_skipped(self):
        source = textwrap.dedent(
            """\
            from __future__ import annotations

            def f(x: int | None = 1 | 2) -> str | None:
                return x | 4
            """
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fixture.py"
            path.write_text(source, encoding="utf-8")
            mutants = gate.enumerate_mutants(Path(tmp) / "work", "fixture", path)
        spans = gate.annotation_spans(source)
        bitor = [m for m in mutants if m.operator.startswith("ReplaceBinaryOperator_BitOr_")]
        line3 = source.split("\n")[2]
        columns = [i for i, ch in enumerate(line3) if ch == "|"]
        skipped = {m.start for m in bitor if gate.inside(m, spans)}
        kept = {m.start for m in bitor if not gate.inside(m, spans)}
        # The return annotation's `|`, as in veda#650's run, and the
        # parameter annotation's if cosmic-ray mutates it.
        self.assertIn((3, columns[2]), skipped)
        self.assertLessEqual(skipped, {(3, columns[0]), (3, columns[2])})
        self.assertEqual(kept, {(3, columns[1]), (4, source.split("\n")[3].index("|"))})
        # Nothing but an annotation's `|` is skipped.
        self.assertFalse([m for m in mutants if gate.inside(m, spans) and m not in bitor])


class Select(unittest.TestCase):
    def test_line_tests_by_class_cost_then_importing_modules(self):
        s = gate.Statements("x = (1,\n     2)\ny = 3\n")
        recorded = {
            "1": {"tests": ["tests.a.Slow.t1", "tests.b.Fast.t2"], "imports": ["tests.c"]},
            "3": {"tests": ["tests.a.Slow.t0"], "imports": ["tests.a"]},
        }
        seconds = {"tests.a.Slow.t1": 5, "tests.a.Slow.t0": 1, "tests.b.Fast.t2": 2, "tests.c.X.t": 0.5}
        self.assertEqual(
            gate.select([2, 3], s, recorded, seconds),
            ["tests.b.Fast.t2", "tests.a.Slow.t0", "tests.a.Slow.t1", "tests.c", "tests.a"],
        )
        self.assertEqual(gate.select([9], s, recorded, seconds), [])

    def test_cost_counts_a_module_as_all_its_tests(self):
        seconds = {"tests.a.X.t1": 1.5, "tests.a.X.t2": 2, "tests.ab.X.t": 7, "tests.b.Y.t": 4}
        self.assertEqual(gate.cost(["tests.a", "tests.b.Y.t"], seconds), 7.5)


class Classify(unittest.TestCase):
    def test_outcomes(self):
        self.assertEqual(gate.classify(True, 0, "", 0, False), "timeout")
        self.assertEqual(gate.classify(False, 0, "", 0, False), "survived")
        self.assertEqual(gate.classify(False, 1, "FAILED (failures=1)", 0, False), "killed")
        self.assertEqual(gate.classify(False, 5, "NO TESTS RAN", 0, False), "error")
        for code in (137, -9, None):
            self.assertEqual(gate.classify(False, code, "", 0, False), "capped", code)
        self.assertEqual(gate.classify(False, 1, "", 0, True), "capped")
        self.assertEqual(gate.classify(False, 1, "", gate.NEAR_MEMORY_CAP, False), "capped")
        self.assertEqual(gate.classify(False, 1, "", gate.NEAR_MEMORY_CAP - 1, False), "killed")
        for sign in gate.CAP_SIGNS:
            self.assertEqual(gate.classify(False, 1, f"... {sign} ...", 0, False), "capped", sign)


class Judge(unittest.TestCase):
    def test_killed_or_listed_outcome_passes_anything_else_is_refused(self):
        row = gate.Row("m.py", "a == b == c", "ReplaceComparisonOperator_Eq_Is", 1, "survived", "r", 7)
        cases = [
            mutant(1, 0), mutant(2, 0), mutant(3, 0), mutant(4, 0), mutant(5, 0), mutant(6, 0),
        ]
        for case, outcome in zip(cases, ["killed", "survived", "timeout", "uncovered", "survived", "killed"]):
            case.outcome = outcome
        cases[4].expected, cases[4].row = "survived", row
        cases[5].expected, cases[5].row = "survived", row
        refusals = gate.judge(cases)
        self.assertEqual(len(refusals), 3)
        self.assertIn("m.py:2:0", refusals[0])
        self.assertIn(": survived", refusals[0])
        self.assertIn("m.py:3:0", refusals[1])
        self.assertIn("listed as survived (list line 7), got killed", refusals[2])


class Cap(unittest.TestCase):
    def test_the_wrapper_passes_the_exit_code_and_reports(self):
        with tempfile.TemporaryDirectory() as folder:
            report = Path(folder) / "r.json"
            code = subprocess.run(
                [sys.executable, "-B", str(Path(gate.__file__)), "cap", str(report), "--",
                 sys.executable, "-c", "import sys; sys.exit(3)"],
            ).returncode
            self.assertEqual(code, 3)
            self.assertEqual(json.loads(report.read_text())["code"], 3)

    @unittest.skipUnless(sys.platform.startswith("linux"), "address-space limits hold on Linux only")
    def test_the_memory_cap_stops_a_large_allocation(self):
        with tempfile.TemporaryDirectory() as folder:
            report = Path(folder) / "r.json"
            done = subprocess.run(
                [sys.executable, "-B", str(Path(gate.__file__)), "cap", str(report), "--",
                 sys.executable, "-c", "x = bytearray(8 * 2**30)"],
                capture_output=True, text=True,
            )
            # The cap stopped it, not the host: both limits applied, and the
            # allocation itself failed.
            self.assertEqual(json.loads(report.read_text())["caps"], 2)
            self.assertNotEqual(done.returncode, 0)
            self.assertIn("MemoryError", done.stderr)
            self.assertEqual(gate.classify(False, done.returncode, done.stderr, 0, False), "capped")

    @unittest.skipUnless(sys.platform.startswith("linux"), "the runner's file cap is checked on Linux")
    def test_the_file_cap_stops_a_large_write(self):
        with tempfile.TemporaryDirectory() as folder:
            report = Path(folder) / "r.json"
            target = Path(folder) / "big"
            program = f"f = open({str(target)!r}, 'wb')\nfor _ in range(1100): f.write(b'x' * 2**20)\n"
            done = subprocess.run(
                [sys.executable, "-B", str(Path(gate.__file__)), "cap", str(report), "--", sys.executable, "-c", program],
                capture_output=True, text=True,
            )
            self.assertEqual(json.loads(report.read_text())["caps"], 2)
            # The write stopped at the cap and the writer failed.
            self.assertNotEqual(done.returncode, 0)
            self.assertIn("File too large", done.stderr)
            self.assertLessEqual(target.stat().st_size, gate.FILE_CAP)
            self.assertGreaterEqual(target.stat().st_size, gate.FILE_CAP - 2**20)
            big = gate.largest_file(Path(folder)) >= gate.FILE_CAP - 2**20
            self.assertEqual(gate.classify(False, done.returncode, done.stderr, 0, big), "capped")

    def test_a_run_whose_caps_did_not_hold_is_an_error(self):
        with tempfile.TemporaryDirectory() as folder:
            copy = RunTests.copy_with(Path(folder), "        pass\n")
            saved = gate.CAPS_REQUIRED
            gate.CAPS_REQUIRED = 3  # more than the wrapper can apply
            try:
                outcome, _, detail = gate.run_tests(copy, ["tests.test_x.X.test_x"], 60, Path(folder) / "tmp")
            finally:
                gate.CAPS_REQUIRED = saved
        self.assertEqual(outcome, "error")
        self.assertIn("caps were applied", detail)


class RunTests(unittest.TestCase):
    """One real, capped run of named tests in a copy, as each mutant gets."""

    @staticmethod
    def copy_with(folder: Path, body: str) -> Path:
        copy = folder / "kavach"
        (copy / "python" / "tests").mkdir(parents=True)
        (copy / "python" / "tests" / "__init__.py").write_text("")
        (copy / "python" / "tests" / "test_x.py").write_text(
            "import time, unittest\n\nclass X(unittest.TestCase):\n    def test_x(self):\n" + body
        )
        return copy

    def test_a_run_past_its_limit_is_a_timeout_not_a_kill(self):
        with tempfile.TemporaryDirectory() as folder:
            copy = self.copy_with(Path(folder), "        time.sleep(60)\n")
            outcome, seconds, _ = gate.run_tests(copy, ["tests.test_x.X.test_x"], 2, Path(folder) / "tmp")
        self.assertEqual(outcome, "timeout")
        self.assertLess(seconds, 30)

    def test_a_failing_test_is_a_kill_and_a_passing_one_survives(self):
        for body, expected in (("        self.fail('caught')\n", "killed"), ("        pass\n", "survived")):
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as folder:
                copy = self.copy_with(Path(folder), body)
                outcome, _, _ = gate.run_tests(copy, ["tests.test_x.X.test_x"], 60, Path(folder) / "tmp")
                self.assertEqual(outcome, expected)


class Hook(unittest.TestCase):
    def setUp(self):
        saved = dict(os.environ)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(saved)))
        hook._started.clear()
        self.addCleanup(hook._started.clear)

    def test_the_recorder_is_skipped_and_its_marker_removed(self):
        os.environ[hook.RECORDER] = "1"
        os.environ.pop(hook.CONTEXT, None)
        hook.start("/nonexistent/config.json")
        self.assertNotIn(hook.RECORDER, os.environ)
        self.assertNotIn(hook.CONTEXT, os.environ)

    def test_only_the_first_call_counts(self):
        os.environ[hook.RECORDER] = "1"
        hook.start("/nonexistent/config.json")
        os.environ[hook.RECORDER] = "1"
        hook.start("/nonexistent/config.json")
        self.assertEqual(os.environ.get(hook.RECORDER), "1")

    def test_a_missing_config_or_sidecar_starts_nothing(self):
        os.environ.pop(hook.RECORDER, None)
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "c.json"
            config.write_text(json.dumps({"sidecar": str(Path(folder) / "missing"), "rc": "x"}))
            hook.start(str(config))
            hook._started.clear()
            hook.start(str(Path(folder) / "absent.json"))
        self.assertNotIn(hook.CONTEXT, os.environ)

    def test_children_and_grandchildren_record_against_the_sidecar_test(self):
        """Through the installed .pth, as the recording runs it: a child
        handed a stale context and a bare environment, and its own child."""

        import coverage

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "kavach").mkdir()
            grand = root / "kavach" / "grandlike.py"
            grand.write_text("import os\nprint(os.environ.get('COVERAGE_PROCESS_START'))\nz = 3\n")
            child = root / "kavach" / "guardlike.py"
            child.write_text(
                "import os, subprocess, sys\n"
                "print(os.environ.get('COVERAGE_PROCESS_START'))\n"
                f"subprocess.run([sys.executable, {str(grand)!r}], check=True, env={{'MUTATION_TEST_CONTEXT': 'stale'}})\n"
            )
            rc, sidecar, pth = gate.install_hook(root, ["guardlike", "grandlike"])
            try:
                sidecar.write_text("tests.t.A.test_x")
                done = subprocess.run(
                    [sys.executable, "-B", str(child)],
                    env={"PATH": os.environ.get("PATH", ""), "MUTATION_TEST_CONTEXT": "stale"},
                    capture_output=True,
                    text=True,
                    check=True,
                )
            finally:
                gate.remove_hook(pth)
            self.assertEqual(done.stdout.split(), ["None", "None"])
            cov = coverage.Coverage(data_file=str(root / "coverage" / ".coverage"), config_file=False)
            cov.combine([str(root / "coverage")], strict=True)
            measured = cov.get_data()
            found = {
                Path(p).name: measured.contexts_by_lineno(p)
                for p in measured.measured_files()
                if p.endswith(("guardlike.py", "grandlike.py"))
            }
        self.assertEqual(sorted(found), ["grandlike.py", "guardlike.py"])
        for name, contexts in found.items():
            self.assertEqual({c for cs in contexts.values() for c in cs}, {"tests.t.A.test_x"}, name)
        self.assertFalse(pth.exists())


class Recorder(unittest.TestCase):
    def test_each_test_and_its_child_are_recorded_under_its_own_name(self):
        """The recorder switches a dynamic context at every test, which
        coverage.py's sys.monitoring core does not record (3.14's default)."""

        import coverage

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "kavach").mkdir()
            (root / "kavach" / "guardlike.py").write_text("def one():\n    return 1\n\n\ndef two():\n    return 2\n")
            (root / "tests").mkdir()
            (root / "tests" / "__init__.py").write_text("")
            (root / "tests" / "test_x.py").write_text(
                "import subprocess, sys, unittest\n"
                "sys.path.insert(0, 'kavach')\n"
                "import guardlike\n\n"
                "class X(unittest.TestCase):\n"
                "    def test_a(self):\n"
                "        self.assertEqual(guardlike.one(), 1)\n\n"
                "    def test_b(self):\n"
                "        self.assertEqual(guardlike.one(), 1)\n"
                "        code = 'import sys; sys.path.insert(0, \"kavach\"); import guardlike; guardlike.two()'\n"
                "        subprocess.run([sys.executable, '-c', code], check=True)\n"
            )
            rc, sidecar, pth = gate.install_hook(root, ["guardlike"])
            rc_text = rc.read_text()
            out = root / "run.json"
            try:
                done = subprocess.run(
                    [sys.executable, "-B", str(Path(gate.__file__)), "record-tests", str(rc), str(sidecar), str(out)],
                    cwd=root,
                    env={**os.environ, "MUTATION_RECORDER": "1"},
                    capture_output=True,
                    text=True,
                )
            finally:
                gate.remove_hook(pth)
            self.assertEqual(done.returncode, 0, done.stderr)
            run = json.loads(out.read_text())
            self.assertEqual(run["order"], ["tests.test_x.X.test_a", "tests.test_x.X.test_b"])
            cov = coverage.Coverage(data_file=str(root / "coverage" / ".coverage"), config_file=False)
            cov.combine([str(root / "coverage")], strict=True)
            measured = cov.get_data()
            lines: dict[int, set[str]] = {}
            for path in measured.measured_files():
                if path.endswith("guardlike.py"):
                    for number, contexts in measured.contexts_by_lineno(path).items():
                        lines.setdefault(number, set()).update(contexts)
        # A line two tests run is recorded under both, not only the first.
        self.assertEqual(lines[2], {"tests.test_x.X.test_a", "tests.test_x.X.test_b"})
        self.assertEqual(lines[6], {"tests.test_x.X.test_b"})
        self.assertIn("core = ctrace", rc_text)


if __name__ == "__main__":
    unittest.main()
