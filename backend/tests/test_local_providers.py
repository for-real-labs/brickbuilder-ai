import asyncio
import json
import os
import stat

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from src.requests.localProviders import ProviderCredentialRequest, router
from src.utils import local_provider_connections as module


@pytest.fixture(autouse=True)
def private_environment(monkeypatch, tmp_path):
    monkeypatch.setattr(module, "PROJECT_ENV_PATH", tmp_path / ".env")
    for provider in module.PROVIDERS.values():
        monkeypatch.delenv(provider.env_key, raising=False)
    monkeypatch.setattr(module, "_connection_cache", {})
    monkeypatch.setattr(module.shutil, "which", lambda _: None)


def request(host="localhost:8000", origin="http://localhost:5173", peer="127.0.0.1"):
    headers = [(b"host", host.encode())]
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    return Request({"type": "http", "headers": headers, "client": (peer, 1)})


def test_local_connections_are_disabled_by_default(monkeypatch):
    monkeypatch.delenv("BRICKBUILDER_LOCAL_PROVIDERS", raising=False)
    with pytest.raises(HTTPException) as error:
        module.require_local_development(request())
    assert error.value.status_code == 404


@pytest.mark.parametrize("host,origin,peer", [
    ("localhost:8000", "https://attacker.example", "127.0.0.1"),
    ("localhost:8000", "null", "127.0.0.1"),
    ("localhost:8000", "http://localhost.evil:5173", "127.0.0.1"),
    ("evil.example", "http://localhost:5173", "127.0.0.1"),
    ("localhost:8000", "http://localhost:5173", "192.168.1.2"),
    ("localhost:8000", "http://localhost:5173/path", "127.0.0.1"),
    ("localhost:wrong", None, "127.0.0.1"),
])
def test_guard_rejects_remote_requests_and_dns_rebinding(monkeypatch, host, origin, peer):
    monkeypatch.setenv("BRICKBUILDER_LOCAL_PROVIDERS", "true")
    with pytest.raises(HTTPException) as error:
        module.require_local_development(request(host, origin, peer))
    assert error.value.status_code == 403


@pytest.mark.parametrize("host,origin,peer", [
    ("localhost:8000", "http://localhost:5173", "127.0.0.1"),
    ("127.0.0.1:8000", None, "127.0.0.1"),
    ("[::1]:8000", "http://[::1]:5173", "::1"),
])
def test_guard_accepts_local_browser_or_local_cli(monkeypatch, host, origin, peer):
    monkeypatch.setenv("BRICKBUILDER_LOCAL_PROVIDERS", "true")
    module.require_local_development(request(host, origin, peer))


def test_api_key_attachment_preserves_other_env_values_and_is_private():
    module.PROJECT_ENV_PATH.write_text("# existing settings\nOTHER='keep'\nexport OPENAI_API_KEY=old\nOPENAI_API_KEY=duplicate\n")
    module.attach_api_key("openai", "sk-project-test-secret")
    text = module.PROJECT_ENV_PATH.read_text()
    assert "OTHER='keep'" in text and "# existing settings" in text
    assert text.count("OPENAI_API_KEY=") == 1
    assert os.environ["OPENAI_API_KEY"] == "sk-project-test-secret"
    assert stat.S_IMODE(module.PROJECT_ENV_PATH.stat().st_mode) == 0o600
    assert not list(module.PROJECT_ENV_PATH.parent.glob(".provider-env-*"))
    module.attach_api_key("openai", None)
    assert "OPENAI_API_KEY" not in module.PROJECT_ENV_PATH.read_text()
    assert "OPENAI_API_KEY" not in os.environ


@pytest.mark.parametrize("provider,key", [("openai", "sk-test\nOTHER=injected"), ("anthropic", "secret'bad"),
                                         ("fal", "missing-colon"), ("../../../other", "valid-secret")])
def test_invalid_key_or_provider_cannot_write_project(provider, key):
    with pytest.raises(ValueError):
        module.attach_api_key(provider, key)
    assert not module.PROJECT_ENV_PATH.exists()


def test_symlink_env_does_not_overwrite_another_file(tmp_path):
    target = tmp_path / "other"
    target.write_text("keep")
    module.PROJECT_ENV_PATH.symlink_to(target)
    with pytest.raises(ValueError, match="regular file"):
        module.attach_api_key("openai", "sk-test-secret")
    assert target.read_text() == "keep"


def test_credentials_endpoint_never_returns_a_key_and_takes_effect_immediately(monkeypatch):
    monkeypatch.setenv("BRICKBUILDER_LOCAL_PROVIDERS", "true")
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app, base_url="http://localhost", client=("127.0.0.1", 1000))
    response = client.post("/local/providers/fal/credentials", json={"api_key": "id-test:secret-test"},
                           headers={"Origin": "http://localhost:5173"})
    assert response.status_code == 200
    assert response.json()["api_key_configured"] is True
    assert response.json()["cli_connected"] is False
    assert "secret-test" not in response.text
    assert "secret-test" not in repr(ProviderCredentialRequest(api_key="id-test:secret-test"))
    assert os.environ["FAL_KEY"] == "id-test:secret-test"
    assert client.delete("/local/providers/fal/credentials").json()["api_key_configured"] is False


def test_local_status_response_is_not_browser_cached(monkeypatch):
    monkeypatch.setenv("BRICKBUILDER_LOCAL_PROVIDERS", "true")
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app, base_url="http://localhost", client=("127.0.0.1", 1000))
    response = client.get("/local/providers")
    assert response.headers["cache-control"] == "no-store"
    assert [item["id"] for item in response.json()["providers"]] == ["openai", "anthropic", "fal"]


@pytest.mark.parametrize("route,body", [
    ("/openai/credentials", {"apikey": "sk-private-secret"}),
    ("/anthropic/credentials", {"api_key": {"value": "sk-private-secret"}}),
    ("/anthropic/login/code", {"authorization_code": "sk-private-secret"}),
    ("/fal/login", {"connection": "sk-private-secret"}),
])
def test_invalid_provider_requests_never_echo_secret_input(monkeypatch, route, body):
    monkeypatch.setenv("BRICKBUILDER_LOCAL_PROVIDERS", "true")
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app, base_url="http://localhost", client=("127.0.0.1", 1000))
    response = client.post("/local/providers" + route, json=body)
    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid provider request"}
    assert "sk-private-secret" not in response.text


@pytest.mark.parametrize("provider,output,connected", [
    ("openai", "Logged in using ChatGPT", True),
    ("openai", "Logged in using API key", False),
    ("anthropic", '{"loggedIn":true,"authMethod":"oauth"}', True),
    ("anthropic", '{"loggedIn":true,"authMethod":"api_key"}', False),
    ("anthropic", "not JSON", False),
    ("anthropic", "null", False),
])
def test_native_connection_is_distinct_from_api_key_auth(monkeypatch, provider, output, connected):
    monkeypatch.setattr(module.shutil, "which", lambda binary: "/fake/" + binary)
    async def execute(_command):
        return 0, output
    monkeypatch.setattr(module, "_command_output", execute)
    assert asyncio.run(module.cli_connected(provider)) is connected


def test_native_cli_environment_does_not_inherit_project_api_secrets(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "secret")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "secret")
    monkeypatch.setenv("FAL_KEY", "id:secret")
    monkeypatch.setenv("CLAUDECODE", "parent-session")
    assert not {"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "FAL_KEY", "CLAUDECODE"} & module.native_cli_environment().keys()


def test_only_official_login_links_reach_browser():
    assert module.login_url("openai", "https://evil.example/oauth") is None
    assert module.login_url("openai", "https://auth.openai.com.evil.example/oauth") is None
    assert module.login_url("anthropic", "https://user:password@claude.com/oauth") is None
    assert module.login_url("fal", "Follow https://fal.ai/api/auth/cli/session-seed?user_code=CODE\n") == "https://fal.ai/api/auth/cli/session-seed?user_code=CODE"


def test_login_urls_wait_for_complete_cli_output_and_keep_long_links_unwrapped():
    partial = "Open https://auth.openai.com/oauth/authorize?state=unfinished"
    assert module.login_url("openai", partial) is None
    complete = partial + "-value\n"
    assert module.login_url("openai", complete) == partial.removeprefix("Open ") + "-value"
    assert int(module.native_cli_environment()["COLUMNS"]) >= 4096


@pytest.mark.parametrize("previous,connected,expected", [("connected", False, "disconnected"),
                                                        ("error", True, "connected")])
def test_provider_status_reconciles_a_completed_login_with_current_native_state(monkeypatch, previous, connected, expected):
    async def current_status(_provider):
        return connected
    monkeypatch.setattr(module, "cli_connected", current_status)
    connections = module.LocalProviderConnections()
    connections.sessions["openai"] = module.LoginSession(status=previous, message="Stale login message")
    status = asyncio.run(connections.status("openai"))
    assert status["cli_connected"] is connected and status["login"]["status"] == expected
    assert status["login"].get("message") != "Stale login message"


def test_cached_fal_login_creates_api_scoped_key_and_attaches_without_secret_response(monkeypatch):
    monkeypatch.setattr(module.shutil, "which", lambda _: "/fake/fal")
    commands = []
    async def execute(command, **_kwargs):
        commands.append(command)
        if "whoami" in command:
            return 0, "Authenticated user"
        return 0, "Generated a key.\nFAL_KEY='project-id:private-\nsecret'\n"
    monkeypatch.setattr(module, "_command_output", execute)
    connections = module.LocalProviderConnections()
    async def login():
        await connections.start("fal")
        await connections.sessions["fal"].task
        return await connections.status("fal")
    status = asyncio.run(login())
    assert status["api_key_configured"] is True and status["cli_connected"] is True
    assert status["login"]["status"] == "connected"
    assert "private-secret" not in json.dumps(status)
    assert "--scope" in commands[-1] and commands[-1][commands[-1].index("--scope") + 1] == "API"
    assert os.environ["FAL_KEY"] == "project-id:private-secret"


def test_fal_key_failures_do_not_expose_runtime_output(monkeypatch):
    async def connected(*_args, **_kwargs):
        return True
    async def execute(*_args, **_kwargs):
        raise RuntimeError("server echoed FAL_KEY=private-secret")
    monkeypatch.setattr(module, "cli_connected", connected)
    monkeypatch.setattr(module, "_command_output", execute)
    connections = module.LocalProviderConnections()
    session = module.LoginSession()
    asyncio.run(connections._login("fal", session, "google"))
    assert session.status == "error"
    assert "private-secret" not in json.dumps(session.public())
