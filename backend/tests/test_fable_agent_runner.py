import json
import os
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest
from fable_agent import runner as runner_module
from fable_agent.app import Options, Workbench, start_build
from fable_agent.runner import Account, KitSettings, SandboxError, SubprocessScriptRunner, script_account
from fable_agent.sandbox import confine
from fable_agent.shape import ShapeLibrary

from fable_agent_support import CABIN, FakeClient, FakeRenderer, InlineRunner, World, reply, tool_use

SANDBOX = SimpleNamespace(pw_uid=990, pw_gid=991)
ACCOUNTS = {"fable-sandbox": SANDBOX, "nobody": SimpleNamespace(pw_uid=65534, pw_gid=65534),
            "root": SimpleNamespace(pw_uid=0, pw_gid=0), "dev": SimpleNamespace(pw_uid=501, pw_gid=20)}


@pytest.fixture(autouse=True)
def private_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("FABLE_AGENT_CACHE", str(tmp_path / "cache"))


def as_user(monkeypatch, uid: int) -> None:
    import pwd

    monkeypatch.setattr(os, "geteuid", lambda: uid)
    monkeypatch.setattr(os, "getegid", lambda: 20)

    def lookup(name):
        if name not in ACCOUNTS:
            raise KeyError(name)
        return ACCOUNTS[name]

    monkeypatch.setattr(pwd, "getpwnam", lookup)


def test_a_developer_runs_scripts_as_themselves_unless_an_account_is_configured(monkeypatch):
    as_user(monkeypatch, 501)
    assert script_account({}) == Account("caller", 501, 20, False)
    assert script_account({"FABLE_SANDBOX_USER": "dev"}) == Account("dev", 501, 20, False)
    with pytest.raises(SandboxError, match="Only root can run build scripts as 'fable-sandbox'"):
        script_account({"FABLE_SANDBOX_USER": "fable-sandbox"})


def test_root_never_runs_a_script_itself(monkeypatch):
    as_user(monkeypatch, 0)
    assert script_account({"FABLE_SANDBOX_USER": " fable-sandbox "}) == Account("fable-sandbox", 990, 991, True)
    assert script_account({}) == Account("nobody", 65534, 65534, True)  # without the setting: still not root
    with pytest.raises(SandboxError, match="must not run as root"):
        script_account({"FABLE_SANDBOX_USER": "root"})
    with pytest.raises(SandboxError, match="does not exist"):
        script_account({"FABLE_SANDBOX_USER": "missing-account"})


def fake_child(monkeypatch, result: dict | None = None, error: Exception | None = None):
    calls, owners = [], []

    def run(argv, **kwargs):
        if error:
            raise error
        calls.append({"argv": argv, **kwargs})
        payload = result if result is not None else {"ok": True, "uid": 990, "placements": [], "links": []}
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(payload).encode(), stderr=b"")

    monkeypatch.setattr(runner_module.subprocess, "run", run)
    monkeypatch.setattr(runner_module.os, "chown", lambda path, uid, gid: owners.append((uid, gid)))
    return calls, owners


def test_on_a_server_the_script_runs_as_the_separate_account_with_tighter_limits(tmp_path, monkeypatch):
    library = tmp_path / "library"
    library.mkdir()
    (tmp_path / "link").symlink_to(library)
    calls, owners = fake_child(monkeypatch)
    account = Account("fable-sandbox", 990, 991, True)
    runner = SubprocessScriptRunner(KitSettings(str(tmp_path / "link")), account=account)
    assert runner.run("x = 1").error is None and runner.account is account
    call = calls[0]
    assert (call["user"], call["group"], call["extra_groups"]) == (990, 991, [])
    assert owners == [(990, 991)]  # its scratch directory, so the script has a home it can use
    assert "preexec_fn" not in call  # not safe in a threaded server; the child confines itself
    assert call["argv"][1] == "-I" and set(call["env"]) >= {"PATH", "HOME"}
    assert not {key for key in call["env"] if "KEY" in key or "TOKEN" in key or "SECRET" in key}
    limits = json.loads(call["argv"][-1])
    assert limits["NPROC"] == 64 and limits["NOFILE"] == 256 and limits["CORE"] == 0 and limits["CPU"] == 95
    # Links are resolved by the caller: the script account may not be able to follow them.
    sent = json.loads(call["input"])
    assert sent["settings"]["ldraw_dir"] == str(library.resolve()) and sent["code"] == "x = 1"


def test_a_developer_run_does_not_switch_accounts(tmp_path, monkeypatch):
    calls, owners = fake_child(monkeypatch, {"ok": True, "uid": 501, "placements": [], "links": []})
    runner = SubprocessScriptRunner(KitSettings(str(tmp_path)), account=Account("caller", 501, 20, False))
    assert runner.run("x = 1").error is None
    assert "user" not in calls[0] and owners == []
    assert "NPROC" not in json.loads(calls[0]["argv"][-1])  # that limit would count the developer's own processes


@pytest.mark.parametrize("reported", [0, 501, None])
def test_a_result_from_the_wrong_account_is_discarded(tmp_path, monkeypatch, reported):
    fake_child(monkeypatch, {"ok": True, "uid": reported, "placements": [], "links": []})
    runner = SubprocessScriptRunner(KitSettings(str(tmp_path)), account=Account("fable-sandbox", 990, 991, True))
    with pytest.raises(SandboxError, match="did not run under its own account"):
        runner.run("x = 1")


def test_a_child_that_cannot_start_stops_the_build_instead_of_looking_like_a_script_error(tmp_path, monkeypatch):
    fake_child(monkeypatch, error=PermissionError("setuid"))
    runner = SubprocessScriptRunner(KitSettings(str(tmp_path)), account=Account("fable-sandbox", 990, 991, True))
    with pytest.raises(SandboxError, match="could not be started: PermissionError"):
        runner.run("x = 1")
    fake_child(monkeypatch, result=["not", "an", "object"])
    assert "crashed" in runner.run("x = 1").error


def test_the_real_child_reports_its_account_and_confines_itself(tmp_path):
    world = World(tmp_path)
    runner = SubprocessScriptRunner(KitSettings(str(world.library.root), str(world.catalog_path)))
    assert runner.account.separate is False  # the test suite runs as an ordinary user
    outcome = runner.run("place('3001', 'Red', 0, 0, 0)\nprint('built')")
    assert outcome.error is None and len(outcome.build.placements) == 1 and "built" in outcome.output
    # The limits are applied by the child itself, before it reads the request.
    probe = ("import json, resource, sys; sys.path.insert(0, sys.argv[1]); "
             "from fable_agent.sandbox import confine; confine({'CORE': 0, 'NOFILE': 200, 'MADE_UP': 1}); "
             "print(json.dumps([resource.getrlimit(resource.RLIMIT_CORE), resource.getrlimit(resource.RLIMIT_NOFILE)]))")
    done = subprocess.run([sys.executable, "-I", "-c", probe, runner_module._PACKAGE_ROOT], capture_output=True,
                          check=True)
    assert json.loads(done.stdout) == [[0, 0], [200, 200]]
    confine({})  # nothing to lower is not an error


def test_an_unreadable_shape_cache_is_a_miss_not_an_error(tmp_path):
    world = World(tmp_path)
    locked = tmp_path / "locked"
    shapes = ShapeLibrary(world.library, locked)
    shapes.get("3001")
    cached = next(locked.rglob("3001-*.json"))
    cached.parent.chmod(0o000)
    try:
        assert ShapeLibrary(world.library, locked).get("3001").width == 4
    finally:
        cached.parent.chmod(0o755)


@pytest.mark.parametrize("method", ["thorough", "lean"])
def test_a_build_past_its_time_limit_stops_and_keeps_its_last_clean_revision(tmp_path, monkeypatch, method):
    world = World(tmp_path / "world")
    first = (reply(tool_use("write_script", "c1", code=CABIN)) if method == "thorough"
             else reply(tool_use("build", "c1", code=CABIN, notes="built")))
    client = FakeClient([first])
    clock = {"now": 1000.0}
    monkeypatch.setattr(time, "monotonic", lambda: clock["now"])
    original_send = client.send

    def slow_send(*args, **kwargs):
        clock["now"] += 500.0  # each model call takes a long time
        return original_send(*args, **kwargs)

    client.send = slow_send
    bench = Workbench.open(world.settings(), runner=InlineRunner(world), renderer=FakeRenderer())
    result = start_build("A small cabin", tmp_path / "run", Options(max_parts=500, method=method, max_seconds=300),
                         client=client, workbench=bench)
    assert result.reason == "time limit reached" and result.steps == 1
    assert result.status == "draft" and result.published["parts"] > 4
