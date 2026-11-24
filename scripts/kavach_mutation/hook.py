"""Starts coverage.py in every Python child of a recorded test run (veda#558).

The gate copies this file into the recording interpreter's site-packages,
beside a .pth file that calls ``start`` with the path of a JSON config. A
.pth file runs in every process of that interpreter, even one a test starts
with ``-I`` or a bare environment, so a guard a test runs in a subprocess is
measured too.

A child has no test on its stack, so it takes the name of the running test
from the sidecar file the recorder rewrites at each test's start and end. It
reads the file, not an inherited variable: some tests build their child's
environment when their module is imported, before any test runs. The name
goes into ``MUTATION_TEST_CONTEXT``, which the coveragerc names as its static
context, so the child's lines are recorded against that test.
"""

import json
import os

RECORDER = "MUTATION_RECORDER"
CONTEXT = "MUTATION_TEST_CONTEXT"


def start(config: str) -> None:
    # The recorder measures itself, switching its context at each test; its
    # own children must not see the marker, so it is removed here.
    if os.environ.pop(RECORDER, None) is not None:
        return
    try:
        with open(config, encoding="utf-8") as handle:
            settings = json.load(handle)
        with open(settings["sidecar"], encoding="utf-8") as handle:
            name = handle.read().strip()
    except (OSError, ValueError, KeyError):
        return
    os.environ[CONTEXT] = name or "@none"
    os.environ["COVERAGE_PROCESS_START"] = settings["rc"]
    import coverage

    coverage.process_startup()
