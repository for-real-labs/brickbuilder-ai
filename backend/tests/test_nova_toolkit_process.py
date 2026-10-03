import asyncio
import os
import signal
import sys
from pathlib import Path

import pytest

from src.utils import nova_toolkit
from src.utils.nova_toolkit import NovaToolkit


def fixture_runtime(monkeypatch, tmp_path, code, use_jev=True):
    package = tmp_path / "runtime" / "ldraw_tools"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("")
    (package / "cli.py").write_text(code)
    toolkit = NovaToolkit(tmp_path, use_jev=use_jev)
    toolkit.root = package.parent
    toolkit.python = Path(sys.executable)
    monkeypatch.setattr(toolkit, "require_ready", lambda: None)
    return toolkit


@pytest.mark.parametrize("use_jev", [False, True])
def test_subprocess_receives_only_operating_environment_and_optional_jev_key(monkeypatch, tmp_path, use_jev):
    for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "FAL_KEY", "SUPABASE_SERVICE_ROLE_KEY",
                 "DATABASE_URL", "SUPABASE_JWT_SECRET", "CODEX_AUTH_JSON", "UNRELATED_SECRET"):
        monkeypatch.setenv(name, "test-secret-value")
    monkeypatch.setenv("TYPESAFE_API_KEY", "typesafe-test-key")
    toolkit = fixture_runtime(monkeypatch, tmp_path, "import os,json\nprint(json.dumps(dict(os.environ)))\n", use_jev)
    result = asyncio.run(toolkit.run(["doctor"]))
    assert result["LDRAW_DIR"] == str(toolkit.library)
    assert result["PATH"].startswith(str(toolkit.python.parent))
    for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "FAL_KEY", "SUPABASE_SERVICE_ROLE_KEY",
                 "DATABASE_URL", "SUPABASE_JWT_SECRET", "CODEX_AUTH_JSON", "UNRELATED_SECRET"):
        assert name not in result
    assert result.get("TYPESAFE_API_KEY") == ("typesafe-test-key" if use_jev else None)


@pytest.mark.parametrize("stream,limit", [("stdout", nova_toolkit.MAX_TOOLKIT_STDOUT_BYTES),
                                         ("stderr", nova_toolkit.MAX_TOOLKIT_STDERR_BYTES)])
def test_oversized_output_terminates_the_process_group(monkeypatch, tmp_path, stream, limit):
    toolkit = fixture_runtime(monkeypatch, tmp_path,
        f"import sys,time\nsys.{stream}.write('x' * {limit + 1})\nsys.{stream}.flush()\ntime.sleep(30)\n")
    stopped = []
    actual_killpg = os.killpg

    def record_stop(pid, sig):
        stopped.append((pid, sig))
        actual_killpg(pid, sig)

    monkeypatch.setattr(nova_toolkit.os, "killpg", record_stop)
    with pytest.raises(ValueError, match="output exceeds"):
        asyncio.run(toolkit.run(["inspect"], timeout=3))
    assert len(stopped) == 1 and stopped[0][1] == signal.SIGKILL


@pytest.mark.parametrize("cancel", [False, True])
def test_timeout_and_cancellation_terminate_the_process_group(monkeypatch, tmp_path, cancel):
    toolkit = fixture_runtime(monkeypatch, tmp_path, "import time\ntime.sleep(30)\n")
    stopped = []
    actual_killpg = os.killpg

    def record_stop(pid, sig):
        stopped.append((pid, sig))
        actual_killpg(pid, sig)

    monkeypatch.setattr(nova_toolkit.os, "killpg", record_stop)

    async def exercise():
        task = asyncio.create_task(toolkit.run(["inspect"], timeout=.2 if not cancel else 3))
        if cancel:
            await asyncio.sleep(.05)
            task.cancel()
        with pytest.raises(asyncio.CancelledError if cancel else asyncio.TimeoutError):
            await task

    asyncio.run(exercise())
    assert len(stopped) == 1 and stopped[0][1] == signal.SIGKILL
