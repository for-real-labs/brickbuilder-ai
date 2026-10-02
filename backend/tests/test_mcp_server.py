import asyncio
import os
import subprocess
import sys
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from jsonschema import ValidationError, validate
from starlette.testclient import TestClient

from src import mcp_server as module

USER_ID = str(uuid4())
GENERATION_ID = str(uuid4())
SECRET = "mcp-unit-test-secret-at-least-32-chars"
SETTINGS = module.McpSettings(
    "https://api.example.com/mcp", "https://brick.example.com",
    "https://auth.example.com/auth/v1", frozenset({"chatgpt-client", "claude-client"}), SECRET,
)


def claims(**overrides):
    return {"sub": USER_ID, "email": "builder@example.com", "role": "authenticated",
            "client_id": "chatgpt-client", "aud": SETTINGS.public_url, "iss": SETTINGS.issuer,
            "scope": "email", "iat": int(time.time()), "exp": int(time.time()) + 3600, **overrides}


def token(**overrides):
    return jwt.encode(claims(**overrides), SECRET, algorithm="HS256")


@pytest.fixture
def client(monkeypatch):
    row = {"id": GENERATION_ID, "user_id": USER_ID, "user_type": "authenticated", "status": "processing"}
    storage = SimpleNamespace(get_generation=AsyncMock(return_value=row))
    monkeypatch.setattr(module, "generation_storage", storage)
    monkeypatch.setattr(module, "track_api_call", lambda **kwargs: None)
    server = module.create_mcp_server(SETTINGS)
    with TestClient(server.streamable_http_app(), base_url="https://api.example.com") as http:
        http.headers.update({"Accept": "application/json, text/event-stream", "Authorization": "Bearer " + token()})
        yield http, server, storage


def rpc(client, method, params=None):
    return client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})


def call(client, name, arguments=None):
    response = rpc(client, "tools/call", {"name": name, "arguments": arguments or {}})
    assert response.status_code == 200, response.text
    return response.json()["result"]


def test_protocol_initialization_and_tool_contracts(client):
    http, _, _ = client
    result = rpc(http, "initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                     "clientInfo": {"name": "test", "version": "1"}}).json()["result"]
    assert result["serverInfo"]["name"] == "BrickBuilder AI"
    assert "voxel" in result["instructions"] or "brick conversion" in result["instructions"]
    tools = rpc(http, "tools/list").json()["result"]["tools"]
    assert {tool["name"] for tool in tools} == {"generate_lego_model", "edit_lego_model", "get_lego_model", "get_brick_builder_account"}
    for tool in tools:
        assert tool["securitySchemes"] == [{"type": "oauth2", "scopes": ["email"]}]
        assert tool["outputSchema"]["type"] == "object"
        assert "user_id" not in tool["inputSchema"]["properties"]
        assert "token" not in tool["inputSchema"]["properties"]
        assert tool["annotations"]["openWorldHint"] is False
        assert tool["annotations"]["title"] == tool["title"]
        if "model" in tool["inputSchema"]["properties"]:
            assert tool["inputSchema"]["properties"]["model"]["type"] == "string"
            validate({"prompt": "A cube", **({"generation_id": GENERATION_ID} if tool["name"] == "edit_lego_model" else {})}, tool["inputSchema"])
            with pytest.raises(ValidationError):
                validate({"prompt": "A cube", "generation_id": GENERATION_ID, "model": "unapproved-model"}, tool["inputSchema"])
    assert next(tool for tool in tools if tool["name"] == "generate_lego_model")["annotations"]["idempotentHint"] is False
    assert next(tool for tool in tools if tool["name"] == "get_lego_model")["annotations"]["readOnlyHint"] is True


def test_tool_descriptions_are_self_contained_capability_descriptions(client):
    http, _, _ = client
    tools = rpc(http, "tools/list").json()["result"]["tools"]
    for tool in tools:
        # Directory tool descriptions must describe their own function rather
        # than issue instructions about other tools or external instructions.
        for other in tools:
            if other["name"] != tool["name"]:
                assert other["name"] not in tool["description"]
        assert "Open model_url" not in tool["description"]
        assert "poll the returned" not in tool["description"]


def test_discovery_and_unauthenticated_challenge(client):
    http, _, _ = client
    http.headers.pop("Authorization")
    response = rpc(http, "tools/list")
    assert response.status_code == 401
    assert '/.well-known/oauth-protected-resource/mcp' in response.headers["www-authenticate"]
    metadata = http.get("/.well-known/oauth-protected-resource/mcp").json()
    assert metadata["resource"] == SETTINGS.public_url
    assert metadata["authorization_servers"] == [SETTINGS.issuer]


@pytest.mark.parametrize("overrides", [
    {"aud": "authenticated"}, {"client_id": "unknown"}, {"client_id": None},
    {"iss": "https://other.example.com/auth/v1"}, {"exp": 1}, {"nbf": int(time.time()) + 3600},
    {"scope": "profile"}, {"sub": "invalid"}, {"role": "service_role"},
    {"is_anonymous": True}, {"email": ""},
])
def test_verifier_rejects_wrong_resource_client_identity_or_claims(overrides):
    assert asyncio.run(module.SupabaseMcpTokenVerifier(SETTINGS).verify_token(token(**overrides))) is None


def test_verifier_requires_claims_and_valid_signature():
    verifier = module.SupabaseMcpTokenVerifier(SETTINGS)
    minimal = claims()
    del minimal["exp"]
    for invalid in ("bad-token", jwt.encode(minimal, SECRET, algorithm="HS256"),
                    jwt.encode(claims(), "wrong-signature-secret", algorithm="HS256")):
        assert asyncio.run(verifier.verify_token(invalid)) is None
    verified = asyncio.run(verifier.verify_token(token(client_id="claude-client")))
    assert verified.subject == USER_ID
    assert verified.resource == SETTINGS.public_url


def test_asymmetric_signing_and_jwks_failure(monkeypatch):
    key = ec.generate_private_key(ec.SECP256R1())
    signed = jwt.encode(claims(), key, algorithm="ES256", headers={"kid": "test-key"})
    verifier = module.SupabaseMcpTokenVerifier(SETTINGS)
    monkeypatch.setattr(verifier.jwks, "get_signing_key_from_jwt", lambda _: SimpleNamespace(key=key.public_key()))
    assert asyncio.run(verifier.verify_token(signed)).subject == USER_ID
    def fail(_):
        raise jwt.PyJWKClientError("unavailable")
    monkeypatch.setattr(verifier.jwks, "get_signing_key_from_jwt", fail)
    assert asyncio.run(verifier.verify_token(signed)) is None


def test_creation_and_edit_use_existing_pipeline_with_verified_identity(client, monkeypatch):
    http, server, _ = client
    start = AsyncMock(return_value=SimpleNamespace(generation_id=GENERATION_ID))
    monkeypatch.setattr(module, "llm_to_bricks", start)
    for name, args in [("generate_lego_model", {"prompt": "A red castle", "detail_level": 24}),
                       ("edit_lego_model", {"generation_id": GENERATION_ID, "prompt": "Make the roof blue"})]:
        result = call(http, name, args)
        data = result["structuredContent"]
        assert data["generation_id"] == GENERATION_ID
        assert data["status"] == "started"
        assert data["next_tool"] == "get_lego_model"
        assert "exact=1" in data["model_url"]
        schema = next(tool for tool in asyncio.run(server.list_tools()) if tool.name == name).outputSchema
        validate(data, schema)
    request, identity = start.call_args.args
    assert start.await_args_list[0].args[0].generation_id is None
    assert request.generation_id == GENERATION_ID
    assert identity["user_id"] == USER_ID
    assert identity["is_developer"] is False
    assert identity["is_anonymous"] is False


@pytest.mark.parametrize("args", [{"prompt": ""}, {"prompt": "a" * 2001},
                                  {"prompt": "castle", "detail_level": 100000},
                                  {"prompt": "castle", "detail_level": -1},
                                  {"prompt": "castle", "model": "not-supported"}])
def test_invalid_generation_inputs_never_start_a_job(client, monkeypatch, args):
    http, _, _ = client
    start = AsyncMock()
    monkeypatch.setattr(module, "llm_to_bricks", start)
    assert call(http, "generate_lego_model", args)["isError"] is True
    start.assert_not_called()


def test_reads_only_expose_owner_artifacts_when_completed(client):
    http, _, storage = client
    result = call(http, "get_lego_model", {"generation_id": GENERATION_ID})["structuredContent"]
    assert result["poll_after_seconds"] == 10
    assert "ldr_url" not in result
    storage.get_generation.return_value.update(
        status="completed", brick_count=20, ldr_url="https://storage.example.com/model.ldr",
        parts_list_csv_url="https://storage.example.com/parts.csv", preview_image_url="https://storage.example.com/model.png",
        error_message="secret-provider-error", llm_output_snapshot_url="private-thinking", prompt="private prompt",
    )
    result = call(http, "get_lego_model", {"generation_id": GENERATION_ID})["structuredContent"]
    assert result["brick_count"] == 20
    assert result["ldr_url"].endswith(".ldr")
    assert "secret-provider-error" not in str(result) and "private-thinking" not in str(result)
    storage.get_generation.return_value["user_id"] = str(uuid4())
    denied = call(http, "get_lego_model", {"generation_id": GENERATION_ID})
    assert denied["isError"] is True
    assert "model.ldr" not in str(denied)
    assert "not found" in str(denied)


def test_failed_missing_models_and_invalid_id(client):
    http, _, storage = client
    storage.get_generation.return_value.update(status="failed", error_message="SECRET")
    failed = call(http, "get_lego_model", {"generation_id": GENERATION_ID})
    assert failed["structuredContent"]["status"] == "failed"
    assert "SECRET" not in str(failed)
    storage.get_generation.return_value = None
    assert call(http, "get_lego_model", {"generation_id": GENERATION_ID})["isError"] is True
    storage.get_generation.reset_mock()
    assert call(http, "get_lego_model", {"generation_id": "bad-id"})["isError"] is True
    storage.get_generation.assert_not_called()


@pytest.mark.parametrize("timestamp", ["2000-01-01T00:00:00Z", "2000-01-01T00:00:00+00:00", "2000-01-01T00:00:00"])
def test_interrupted_jobs_do_not_poll_forever(client, timestamp):
    http, _, storage = client
    row = storage.get_generation.return_value
    row["updated_at"] = timestamp
    result = call(http, "get_lego_model", {"generation_id": GENERATION_ID})["structuredContent"]
    assert result["status"] == "failed"
    assert "poll_after_seconds" not in result
    # A progress read does not alter stored state; a fresh heartbeat can resume.
    assert row["status"] == "processing"
    row["updated_at"] = module.datetime.now(module.timezone.utc).isoformat()
    assert call(http, "get_lego_model", {"generation_id": GENERATION_ID})["structuredContent"]["status"] == "processing"


def test_credit_errors_and_unexpected_errors_are_safe(client, monkeypatch):
    http, _, _ = client
    for exc, message in [(HTTPException(status_code=402), "credit"), (RuntimeError("SECRET"), "try again")]:
        monkeypatch.setattr(module, "llm_to_bricks", AsyncMock(side_effect=exc))
        result = call(http, "generate_lego_model", {"prompt": "Castle"})
        assert result["isError"] is True and message in str(result)
        assert "SECRET" not in str(result)


def test_account_is_scoped_to_signed_in_email(client):
    http, _, storage = client
    class Query:
        def table(self, value):
            assert value == "user_profiles"
            return self
        def select(self, value):
            assert value == "credits"
            return self
        def eq(self, column, value):
            assert (column, value) == ("email", "builder@example.com")
            return self
        def single(self):
            return self
        def execute(self):
            return SimpleNamespace(data={"credits": 7})
    storage.client = Query()
    assert call(http, "get_brick_builder_account")["structuredContent"]["credits"] == 7


def test_host_and_origin_protection(client):
    http, _, _ = client
    assert http.post("/mcp", headers={"Host": "attacker.example.com"}, json={}).status_code == 421
    assert http.post("/mcp", headers={"Origin": "https://attacker.example.com"}, json={}).status_code == 403


def test_settings_fail_closed(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://auth.example.com")
    monkeypatch.setenv("MCP_OAUTH_CLIENT_IDS", "client")
    monkeypatch.setenv("MCP_WEBSITE_URL", "https://brick.example.com")
    for invalid in ("http://api.example.com/mcp", "https://api.example.com/wrong", "https://user@api.example.com/mcp", "https://api.example.com/mcp?q=1"):
        monkeypatch.setenv("MCP_PUBLIC_URL", invalid)
        with pytest.raises(ValueError):
            module.McpSettings.from_env()
    monkeypatch.setenv("MCP_PUBLIC_URL", SETTINGS.public_url)
    assert module.McpSettings.from_env().public_url == SETTINGS.public_url
    monkeypatch.setenv("MCP_OAUTH_CLIENT_IDS", " , ")
    with pytest.raises(ValueError):
        module.McpSettings.from_env()


@pytest.mark.parametrize("enabled", ["false", "true"])
def test_api_mount_and_lifespan_in_the_deployed_entrypoint(enabled):
    # A fresh process avoids changing the API singleton imported by other tests.
    environment = {**os.environ, "MCP_ENABLED": enabled, "MCP_PUBLIC_URL": SETTINGS.public_url,
                   "MCP_WEBSITE_URL": SETTINGS.website_url, "MCP_OAUTH_CLIENT_IDS": "chatgpt-client",
                   "SUPABASE_URL": "https://auth.example.com", "SUPABASE_SERVICE_ROLE_KEY": "test-key",
                   "SUPABASE_JWT_SECRET": SECRET, "POSTHOG_API_KEY": "", "MCP_SMOKE_TOKEN": token()}
    script = '''
import os
from starlette.testclient import TestClient
from src.api import app
from src.utils.auth import get_user_with_optional_auth
app.dependency_overrides[get_user_with_optional_auth] = lambda: {"authenticated": False}
with TestClient(app, base_url="https://api.example.com") as client:
    assert client.get("/").status_code == 200
    challenge_path = "/.well-known/openai-apps-challenge"
    for invalid in ("", "short", "valid-looking-but-with-a-newline\\n", "x" * 201):
        os.environ["OPENAI_APPS_CHALLENGE"] = invalid
        assert client.get(challenge_path).status_code == 404
    os.environ["OPENAI_APPS_CHALLENGE"] = "directory-challenge-test-token"
    challenge = client.get(challenge_path)
    assert challenge.status_code == 200
    assert challenge.text == os.environ["OPENAI_APPS_CHALLENGE"]
    assert challenge.headers["content-type"].startswith("text/plain")
    assert challenge.headers["cache-control"] == "no-store"
    assert client.post("/llmToBricks", json={}).status_code == 422
    response = client.post("/mcp", json={})
    assert response.status_code == (401 if os.environ["MCP_ENABLED"] == "true" else 503)
    if os.environ["MCP_ENABLED"] == "true":
        assert client.get("/.well-known/oauth-protected-resource/mcp").json()["resource"] == os.environ["MCP_PUBLIC_URL"]
        client.headers.update({"Authorization": "Bearer " + os.environ["MCP_SMOKE_TOKEN"], "Accept": "application/json, text/event-stream"})
        initialized = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "smoke", "version": "1"}}})
        assert initialized.status_code == 200, initialized.text
        assert initialized.json()["result"]["serverInfo"]["name"] == "BrickBuilder AI"
'''
    result = subprocess.run([sys.executable, "-c", script], env=environment, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
