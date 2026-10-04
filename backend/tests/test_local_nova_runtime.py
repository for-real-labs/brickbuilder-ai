import importlib.util
import os
import runpy
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("brickbuilder_local_run", Path(__file__).parents[1] / "local_run.py")
local_run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_run)


def test_local_runtime_attaches_project_tools_and_existing_library(tmp_path):
    backend = tmp_path / "backend"
    home = tmp_path / "home"
    (home / "ldraw").mkdir(parents=True)
    (home / "ldraw" / "LDConfig.ldr").touch()
    environment = {"PATH": "/existing/bin"}
    local_run.configure_local_runtime(environment, backend, home)
    assert environment["BRICKBUILDER_LOCAL_PROVIDERS"] == "true"
    assert environment["PATH"] == "/existing/bin"
    assert environment["LDRAW_DIR"] == str(home / "ldraw")


def test_local_runtime_preserves_explicit_configuration(tmp_path):
    environment = {"BRICKBUILDER_LOCAL_PROVIDERS": "false", "NOVA_PYTHON": "/custom/python", "NOVA_TOOLKIT_ROOT": "/custom/nova", "LDRAW_DIR": "/custom/parts"}
    local_run.configure_local_runtime(environment, tmp_path / "backend", tmp_path / "home")
    assert environment["BRICKBUILDER_LOCAL_PROVIDERS"] == "false"
    assert environment["NOVA_PYTHON"] == "/custom/python"
    assert environment["NOVA_TOOLKIT_ROOT"] == "/custom/nova"
    assert environment["LDRAW_DIR"] == "/custom/parts"


def test_local_launcher_preserves_raw_peer_for_provider_guards(monkeypatch):
    calls = []
    app = object()
    monkeypatch.setitem(sys.modules, "uvicorn", SimpleNamespace(run=lambda *args, **kwargs: calls.append((args, kwargs))))
    monkeypatch.setitem(sys.modules, "src.api", SimpleNamespace(app=app))
    monkeypatch.setattr("dotenv.load_dotenv", lambda: None)
    monkeypatch.setattr(sys, "path", sys.path.copy())
    with patch.dict(os.environ):
        runpy.run_path(local_run.__file__, run_name="__main__")
    args, options = calls[0]
    assert args == (app,)
    assert options["host"] == "127.0.0.1"
    assert options["proxy_headers"] is False
