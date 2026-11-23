import asyncio
import json
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fable_agent import app as fable_app
from fastapi import HTTPException, Response
from pydantic import ValidationError
from src.api import building_agents
from src.requests import fableToBricks as fable
from src.requests import novaToBricks as nova
from src.utils.building_agents import FABLE_AGENTS, in_process_agent
from src.utils.generation_budget import GenerationUsage, current_generation_usage

from fable_agent_support import CABIN, FakeClient, FakeRenderer, InlineRunner, World, reply, tool_use

ACCOUNT = {"authenticated": True, "auth_method": "jwt", "user_email": "builder@example.test",
           "user_id": "builder"}
AGENT = "fable-gpt-6.1-sol"


@pytest.fixture(autouse=True)
def configured(tmp_path, monkeypatch):
    monkeypatch.setenv("ASTROLOGY_ALLOWED_EMAILS", ACCOUNT["user_email"])
    monkeypatch.setenv("OPENAI_API_KEY", "openai-test")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-test")
    monkeypatch.setenv("FABLE_AGENT_CACHE", str(tmp_path / "cache"))
    monkeypatch.setattr(fable, "_ready", lambda: True)
    monkeypatch.setattr(fable, "handle_auth_and_tracking", Mock())
    monkeypatch.setattr(nova, "generation_storage", object())


def start_recorder(monkeypatch):
    create = AsyncMock(return_value="generation")
    monkeypatch.setattr(fable, "generation_storage", SimpleNamespace(create_generation=create))
    started = []

    def start(generation_id, work):
        started.append(generation_id)
        work.close()

    monkeypatch.setattr(fable, "start_generation_task", start)
    return create, started


def test_the_agents_are_listed_and_usable_only_on_the_shared_allowlist(monkeypatch):
    listed = asyncio.run(building_agents(Response(), ACCOUNT))["agents"]
    assert listed == ["nova", "astrology", *FABLE_AGENTS]
    assert {"fable-claude-fable-5-2", "fable-gpt-6.2-sol", "fable-gpt-6.1-sol"} <= set(FABLE_AGENTS)
    assert in_process_agent(AGENT) == AGENT and in_process_agent("nova") is None and in_process_agent(7) is None

    outsider = {**ACCOUNT, "user_email": "outsider@example.test"}
    assert asyncio.run(building_agents(Response(), outsider)) == {"agents": ["nova"]}
    create, _ = start_recorder(monkeypatch)
    for identity in (outsider, {**ACCOUNT, "auth_method": "api_key"}, {**ACCOUNT, "is_anonymous": True}):
        with pytest.raises(HTTPException) as denied:
            asyncio.run(nova.nova_to_bricks(nova.NovaToBricksRequest(prompt="A boat", building_agent=AGENT),
                                            identity))
        assert denied.value.status_code == 403
    create.assert_not_called()
    with pytest.raises(ValidationError, match="Unknown building agent"):
        nova.NovaToBricksRequest(prompt="A boat", building_agent="fable-mystery")


def test_all_parts_starts_fable_with_existing_billing_and_ownership(monkeypatch):
    create, started = start_recorder(monkeypatch)
    monkeypatch.setattr(nova, "_nova_service", Mock(side_effect=AssertionError("Wrong agent")))
    request = nova.NovaToBricksRequest(building_agent=AGENT, prompt="A boat under 70 pieces")
    response = asyncio.run(nova.nova_to_bricks(request, ACCOUNT))
    assert response.generation_id == "generation" and started == ["generation"]
    fields = create.await_args.kwargs
    assert fields["endpoint"] == "novaToBricks" and fields["model_3d"] == AGENT
    assert fields["user_id"] == ACCOUNT["user_id"] and fields["max_parts"] == 69
    assert fable.handle_auth_and_tracking.call_args.args[1] == "/novaToBricks"

    request = nova.NovaToBricksRequest(building_agent="fable-lean-claude-fable-5-2", prompt="A boat")
    asyncio.run(nova.nova_to_bricks(request, ACCOUNT))
    assert create.await_args.kwargs["max_parts"] == 1000  # the default ceiling


@pytest.mark.parametrize(("change", "status"), [
    ({"auth_mode": "native"}, 422),
    ({"billing_source": "personal"}, 422),
    ({"max_parts": 6000}, 422),
    ({"image_base64": "bm90IGFuIGltYWdl"}, 422),
    ({"parts_inventory": {"name": "My parts", "parts": [{"part_id": "3001", "color_id": 4, "quantity": 2}]}},
     422),
])
def test_requests_fable_cannot_serve_are_refused_before_anything_is_created(monkeypatch, change, status):
    create, _ = start_recorder(monkeypatch)
    request = nova.NovaToBricksRequest(building_agent=AGENT, prompt="A boat", **change)
    with pytest.raises(HTTPException) as refused:
        asyncio.run(fable.fable_to_bricks(request, ACCOUNT))
    assert refused.value.status_code == status
    create.assert_not_called()


@pytest.mark.parametrize("missing", ["key", "tools"])
def test_fable_is_unavailable_without_its_key_or_its_tools(monkeypatch, missing):
    create, _ = start_recorder(monkeypatch)
    if missing == "key":
        monkeypatch.delenv("OPENAI_API_KEY")
    else:
        monkeypatch.setattr(fable, "_ready", lambda: False)
    with pytest.raises(HTTPException) as unavailable:
        asyncio.run(fable.fable_to_bricks(nova.NovaToBricksRequest(building_agent=AGENT, prompt="A boat"),
                                          ACCOUNT))
    assert unavailable.value.status_code == 503
    create.assert_not_called()


def test_a_revision_keeps_its_engine_and_accepts_only_owners(monkeypatch):
    source = {"id": "previous", "status": "completed", "model_used_3d": AGENT, "user_id": "other-owner",
              "user_type": "authenticated"}
    monkeypatch.setattr(nova, "generation_storage",
                        SimpleNamespace(get_generation=AsyncMock(return_value=source)))
    monkeypatch.setattr(fable, "generation_storage", object())
    request = nova.NovaToBricksRequest(prompt="Paint it blue", source_generation_id="previous")
    with pytest.raises(HTTPException) as denied:
        asyncio.run(nova.nova_to_bricks(request, ACCOUNT))
    assert denied.value.status_code == 404


def test_a_revision_starts_from_the_saved_script_of_a_completed_fable_build(monkeypatch):
    saved = json.dumps({"agent": AGENT, "script": CABIN, "requests": ["A cabin"]}).encode()
    bucket = Mock(download=Mock(return_value=saved))
    storage = SimpleNamespace(client=SimpleNamespace(storage=SimpleNamespace(from_=lambda _: bucket)))
    monkeypatch.setattr(fable, "generation_storage", storage)
    source = {"id": "previous", "status": "completed", "model_used_3d": AGENT, "user_id": "builder",
              "user_type": "authenticated", "restored_from_id": "original"}
    design = asyncio.run(fable._source_design(source, ACCOUNT))
    assert design == fable.Design(CABIN, ("A cabin",))
    bucket.download.assert_called_once_with(f"original/{fable.DESIGN_FILE}")
    assert "Paint it blue" in fable._change_request("Paint it blue", design)
    assert "- A cabin" in fable._change_request("Paint it blue", design)
    assert fable._change_request("A boat", None) == "A boat"

    for broken in (b"not json", json.dumps({"script": "", "requests": []}).encode(),
                   json.dumps({"script": CABIN}).encode()):
        bucket.download.return_value = broken
        with pytest.raises(HTTPException) as unavailable:
            asyncio.run(fable._source_design(source, ACCOUNT))
        assert unavailable.value.status_code == 409
    for unfinished in ({**source, "status": "failed"}, {**source, "model_used_3d": "astrology"}):
        with pytest.raises(HTTPException) as refused:
            asyncio.run(fable._source_design(unfinished, ACCOUNT))
        assert refused.value.status_code == 409


def web_storage(monkeypatch):
    bucket = Mock()
    storage = SimpleNamespace(
        client=SimpleNamespace(storage=SimpleNamespace(from_=lambda _: bucket)),
        update_status=AsyncMock(), store_model_file=AsyncMock(), store_parts_list_csv=AsyncMock(),
        store_preview_image=AsyncMock(), store_images=AsyncMock(), heartbeat=AsyncMock())
    monkeypatch.setattr(fable, "generation_storage", storage)
    publish = AsyncMock()
    monkeypatch.setattr(fable, "upload_artifact", publish)
    return storage, publish


def test_a_completed_job_exports_the_model_instructions_usage_and_owner_design(tmp_path, monkeypatch):
    world = World(tmp_path / "world")
    client = FakeClient([
        reply(tool_use("write_script", "c1", code=CABIN)),
        reply(tool_use("render", "c2", views=["front-right"])),
        reply(tool_use("finish", "c3", title="Cabin", summary="A small cabin.")),
    ])
    real_start = fable_app.start_build
    options_seen = []

    def start_build(prompt, run_dir, options, **kwargs):
        options_seen.append((prompt, options, kwargs.get("script")))
        bench = fable_app.Workbench.open(world.settings(), runner=InlineRunner(world), renderer=FakeRenderer())
        return real_start(prompt, run_dir, options, client=client, workbench=bench, **kwargs)

    monkeypatch.setattr(fable, "start_build", start_build)
    storage, publish = web_storage(monkeypatch)
    progress = AsyncMock()
    request = nova.NovaToBricksRequest(prompt="A small cabin", max_parts=400, building_agent=AGENT)

    async def job():
        ledger = GenerationUsage("build")
        token = current_generation_usage.set(ledger)
        try:
            error = await fable._build("build", request, AGENT, None, None, "openai-test", on_progress=progress)
        finally:
            current_generation_usage.reset(token)
        return error, ledger

    error, ledger = asyncio.run(job())
    assert error is None
    prompt, options, script = options_seen[0]
    assert (prompt, options.model, options.method, options.max_parts, script) == (
        "A small cabin", "gpt-6.1-sol", "thorough", 400, None)

    saved = {call.kwargs["path"]: call.kwargs["file"] for call in publish.await_args_list}
    design = json.loads(saved[f"build/{fable.DESIGN_FILE}"])
    assert design == {"agent": AGENT, "script": CABIN, "requests": ["A small cabin"]}
    ldraw = saved[f"build/{fable.INSTRUCTIONS_FILE}"].decode()
    assert ldraw.startswith("0 Cabin") and "0 STEP" in ldraw and "3020.dat" in ldraw
    storage.store_model_file.assert_awaited_once_with("build", ldraw, "ldr", raise_on_error=True)
    storage.store_parts_list_csv.assert_awaited_once_with("build", ldraw, raise_on_error=True)
    assert storage.store_preview_image.await_args.args[1].startswith(b"\x89PNG")
    storage.store_images.assert_not_awaited()
    storage.update_status.assert_awaited_with("build", "completed")
    # Every model call is reported to the generation's usage ledger, as the other engines do.
    assert len(ledger.calls) == 3 and {call["model"] for call in ledger.calls} == {"claude-fable-5-2"}
    said = [call.args[0] for call in progress.await_args_list]
    assert said[0] == "Designing your model" and "Building the model" in said
    assert said[-1] == "Saving your model and building instructions"


def test_a_build_that_never_passes_its_checks_fails_with_a_message_for_the_customer(tmp_path, monkeypatch):
    world = World(tmp_path / "world")
    client = FakeClient([reply({"type": "text", "text": "I give up."}), reply({"type": "text", "text": "Still."})])
    real_start = fable_app.start_build

    def start_build(prompt, run_dir, options, **kwargs):
        bench = fable_app.Workbench.open(world.settings(), runner=InlineRunner(world), renderer=FakeRenderer())
        return real_start(prompt, run_dir, options, client=client, workbench=bench, **kwargs)

    monkeypatch.setattr(fable, "start_build", start_build)
    storage, publish = web_storage(monkeypatch)
    request = nova.NovaToBricksRequest(prompt="A cabin", max_parts=400, building_agent=AGENT)
    error = asyncio.run(fable._build("build", request, AGENT, None, None, "k", on_progress=AsyncMock()))
    assert "could not finish a model" in error
    storage.update_status.assert_awaited_with("build", "failed", error)
    storage.store_model_file.assert_not_awaited()
    publish.assert_not_awaited()

    # Unexpected failures are logged, and the customer sees a generic message.
    monkeypatch.setattr(fable, "start_build", Mock(side_effect=RuntimeError("secret detail")))
    error = asyncio.run(fable._build("build", request, AGENT, None, None, "k", on_progress=AsyncMock()))
    assert error == "Fable could not complete this build."


def test_cancelling_a_generation_stops_the_agent_at_its_next_step(monkeypatch):
    storage, _ = web_storage(monkeypatch)
    entered, stopped = threading.Event(), threading.Event()

    def run(prompt, variant, max_parts, reference, script, key, on_event):
        entered.set()
        try:
            while True:
                on_event("thinking", {"text": "."})
        except fable.BuildCancelled:
            stopped.set()
            raise

    monkeypatch.setattr(fable, "_run", run)
    request = nova.NovaToBricksRequest(prompt="A cabin", building_agent=AGENT)

    async def job():
        task = asyncio.create_task(fable._build("build", request, AGENT, None, None, "k", on_progress=AsyncMock()))
        await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.to_thread(stopped.wait, 5)

    asyncio.run(job())
    assert stopped.is_set()
    assert all(call.args[1] != "completed" for call in storage.update_status.await_args_list)
