import os

import pytest
from fable_agent.runner import KitSettings, SubprocessScriptRunner
from fable_agent.sandbox import ScriptError, execute_script, validate_script

from fable_agent_support import CABIN, World


@pytest.mark.parametrize("code", [
    "import os",
    "from os import path",
    "from math import *",
    "import math, subprocess",
    "x = (1).__class__",
    "x = [].__class__.__mro__",
    "__import__('os')",
    "open('/etc/passwd')",
    "eval('1')",
    "exec('x = 1')",
    "getattr(place, 'x')",
    "type(1)",
    "globals()",
    "def g():\n    yield 1\nframe = g().gi_frame",
    "x = place.f_back",
    "'{0.real}'.format(1)",
    "class A:\n    pass",
    "with place as x:\n    pass",
    "async def f():\n    pass",
    "x = __builtins__",
    "def f(:\n    pass",
])
def test_scripts_outside_the_dialect_are_refused_before_running(code):
    with pytest.raises(ScriptError):
        validate_script(code)


def test_oversized_scripts_are_refused():
    with pytest.raises(ScriptError, match="too large"):
        validate_script("x = 1\n" * 100_000)


def test_a_script_builds_through_the_kit_and_returns_its_output(tmp_path):
    kit = World(tmp_path).kit()
    printed = execute_script(CABIN + "\nimport math\nprint('height', math.floor(7.5), random.randint(1, 1))", kit)
    assert printed == "height 7 1\n"
    assert {p.module for p in kit.build.placements} == {"base", "walls"}


def test_script_failures_report_the_line_and_keep_earlier_output(tmp_path):
    kit = World(tmp_path).kit()
    with pytest.raises(ScriptError) as failure:
        execute_script("print('before')\nplace('3001', 'Red', 0, 0, 0)\nx = 1 / 0\n", kit)
    assert failure.value.line == 3
    assert "ZeroDivisionError" in str(failure.value)
    assert failure.value.output == "before\n"
    with pytest.raises(ScriptError, match="Unknown color") as kit_failure:
        execute_script("\nplace('3001', 'Blurple', 0, 0, 0)", World(tmp_path / "b").kit())
    assert kit_failure.value.line == 2


def test_builtins_that_reach_the_host_are_absent_at_run_time(tmp_path):
    kit = World(tmp_path).kit()
    with pytest.raises(ScriptError, match="NameError"):
        execute_script("x = bytearray(1)", kit)
    # The provided random is a narrow namespace, not the module: nothing else can be pulled from it.
    with pytest.raises(ScriptError, match="ImportError"):
        execute_script("import math\nimport random as r\nfrom random import os", kit)


def test_the_subprocess_runner_isolates_scripts_from_the_parent(tmp_path, monkeypatch):
    world = World(tmp_path)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "secret-value")
    runner = SubprocessScriptRunner(KitSettings(str(world.library.root), str(world.catalog_path)), timeout=60)
    outcome = runner.run(CABIN + "print(len(rect(0, 0, 2, 2)))")
    assert outcome.error is None and outcome.output == "4\n"
    assert len(outcome.build.placements) > 4
    assert outcome.build.placements[0].module == "base"
    failed = runner.run("place('3001', 'Red', 0, 0, 0)\nimport os\n")
    assert failed.build is None and failed.line == 2
    assert "secret-value" not in (failed.error or "") + failed.output
    assert os.environ["ANTHROPIC_API_KEY"] == "secret-value"


def test_the_subprocess_runner_stops_scripts_that_never_finish(tmp_path):
    world = World(tmp_path)
    runner = SubprocessScriptRunner(KitSettings(str(world.library.root), str(world.catalog_path)), timeout=2)
    outcome = runner.run("while True:\n    pass")
    assert outcome.build is None and "stopped" in outcome.error


def test_the_subprocess_runner_reports_a_missing_library_without_a_traceback(tmp_path):
    outcome = SubprocessScriptRunner(KitSettings(str(tmp_path / "missing"), open_palette=True)).run("x = 1")
    assert outcome.build is None and outcome.error.startswith("Build environment error")


def test_bundled_example_scripts_stay_within_the_dialect():
    from pathlib import Path

    import fable_agent

    examples = sorted((Path(fable_agent.__file__).parent / "examples").glob("*.py"))
    assert examples
    for example in examples:
        validate_script(example.read_text(encoding="utf-8"))
