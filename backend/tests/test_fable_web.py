import asyncio
import io
import json
import threading
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fable_agent import app as fable_app
from fastapi import HTTPException, Response
from pydantic import ValidationError
from src.api import building_agents
from src.requests import fableToBricks as fable
from src.requests import novaToBricks as nova
from src.utils.build_design_guidance import guided_build_prompt
from src.utils.building_agents import (FABLE_AGENTS, OFFERED_AGENTS, PIP_AGENT, PIP_MODELS, RETIRED_AGENTS,
                                       in_process_agent)
from src.utils.generation_budget import GenerationUsage, current_generation_usage

from fable_agent_support import CABIN, FakeClient, FakeRenderer, InlineRunner, World, reply, tool_use

ORIGINAL_READY = fable._ready
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
    offered = asyncio.run(building_agents(Response(), ACCOUNT))
    assert offered["agents"] == ["nova", *OFFERED_AGENTS] and OFFERED_AGENTS[0] == "astrology"
    assert {"fable-claude-fable-5-2", "fable-gpt-6.2-sol", "fable-thorough-v2-gpt-6.2-sol", "fable-gpt-6.1-sol",
            "fable-lean-claude-fable-5-2", "fable-lean-low-claude-fable-5-2", "fable-lean-gpt-6.2-sol", PIP_AGENT,
            "fable-lean-v2-gpt-6.2-sol", "fable-lean-gpt-6.1-sol"} == set(FABLE_AGENTS)
    # Pip replaced Fable Lean v2: its builds still resolve, but it is not offered for new ones.
    assert PIP_AGENT in offered["agents"] and "fable-lean-v2-gpt-6.2-sol" not in offered["agents"]
    assert in_process_agent("fable-lean-v2-gpt-6.2-sol") == "fable-lean-v2-gpt-6.2-sol"
    assert offered["models"] == {PIP_AGENT: ["gpt-6.2-sol", "gpt-6.2-astra", "claude-opus-5-5", "claude-sonnet-5-5",
                                             "claude-fable-5-2"]}
    assert in_process_agent(AGENT) == AGENT and in_process_agent("nova") is None and in_process_agent(7) is None
    # The v2 agents can read example builds first; Generation settings show the switch only for them.
    assert offered["examples"] == ["fable-thorough-v2-gpt-6.2-sol", PIP_AGENT]

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


@pytest.mark.parametrize(("agent", "effort"), [
    ("fable-lean-low-claude-fable-5-2", "low"), ("fable-lean-claude-fable-5-2", "medium"),
    ("fable-lean-gpt-6.2-sol", "medium"), ("fable-thorough-v2-gpt-6.2-sol", "high"), ("fable-gpt-6.2-sol", "high"),
    ("fable-lean-v2-gpt-6.2-sol", "medium"),
    (AGENT, "high")])
def test_each_option_runs_its_own_model_method_and_effort(monkeypatch, agent, effort):
    seen = []

    def start_build(prompt, run_dir, options, **kwargs):
        seen.append(options.resolved(options.method))
        raise ValueError("stop before any model call")

    monkeypatch.setattr(fable, "start_build", start_build)
    variant = FABLE_AGENTS[agent]
    with pytest.raises(ValueError, match="stop before"):
        fable._run("A boat", variant, 300, None, None, "key", lambda kind, data: None)
    assert (seen[0].model, seen[0].method, seen[0].max_parts) == (variant.model, variant.method, 300)
    assert seen[0].effort == effort  # the option's own effort, or else the method's default
    assert seen[0].api_key == "key"


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


def test_the_website_runs_scripts_only_under_a_separate_account(monkeypatch, tmp_path):
    from fable_agent.runner import Account, SandboxError

    (tmp_path / "LDConfig.ldr").write_text("0 colours\n")
    monkeypatch.setattr(fable, "_ready", ORIGINAL_READY)
    monkeypatch.setattr(fable, "find_leocad", lambda: "/usr/bin/leocad")
    monkeypatch.setattr(fable, "default_library_dir", lambda: tmp_path)
    monkeypatch.setattr(fable.auth, "LOCAL_DB_ENABLED", False)

    monkeypatch.setattr(fable, "script_account", lambda: Account("fable-sandbox", 990, 991, True))
    assert fable._ready() is True
    # Sharing the API's own account is refused on a hosted service, whatever else is installed.
    monkeypatch.setattr(fable, "script_account", lambda: Account("caller", 0, 0, False))
    assert fable._ready() is False
    create, _ = start_recorder(monkeypatch)
    with pytest.raises(HTTPException) as unavailable:
        asyncio.run(fable.fable_to_bricks(nova.NovaToBricksRequest(building_agent=AGENT, prompt="A boat"),
                                          ACCOUNT))
    assert unavailable.value.status_code == 503
    create.assert_not_called()

    def broken():
        raise SandboxError("The build-script account 'fable-sandbox' does not exist")

    monkeypatch.setattr(fable, "script_account", broken)
    assert fable._ready() is False
    # An offline local checkout has one user, the developer, and may run scripts as them.
    monkeypatch.setattr(fable, "script_account", lambda: Account("caller", 501, 20, False))
    monkeypatch.setattr(fable.auth, "LOCAL_DB_ENABLED", True)
    assert fable._ready() is True
    monkeypatch.setattr(fable, "find_leocad", lambda: None)
    assert fable._ready() is False


def test_a_rush_of_builds_is_refused_instead_of_queued_without_limit(monkeypatch):
    create, _ = start_recorder(monkeypatch)
    monkeypatch.setattr(fable, "_in_flight", fable.MAX_BUILDS + fable.MAX_WAITING)
    with pytest.raises(HTTPException) as busy:
        asyncio.run(fable.fable_to_bricks(nova.NovaToBricksRequest(building_agent=AGENT, prompt="A boat"),
                                          ACCOUNT))
    assert busy.value.status_code == 503 and "busy" in busy.value.detail
    create.assert_not_called()
    monkeypatch.setattr(fable, "_in_flight", fable.MAX_BUILDS + fable.MAX_WAITING - 1)
    asyncio.run(fable.fable_to_bricks(nova.NovaToBricksRequest(building_agent=AGENT, prompt="A boat"), ACCOUNT))
    create.assert_awaited_once()


def test_a_build_far_past_its_time_limit_is_abandoned_with_a_message(monkeypatch):
    storage, _ = web_storage(monkeypatch)
    monkeypatch.setattr(fable, "HARD_STOP_SECONDS", -1)

    def run(prompt, variant, max_parts, reference, script, key, on_event, examples=False):
        on_event("thinking", {"text": "."})  # the first step after the limit raises
        raise AssertionError("the build should have been stopped")

    monkeypatch.setattr(fable, "_run", run)
    request = nova.NovaToBricksRequest(prompt="A cabin", building_agent=AGENT)
    before = fable._in_flight
    error = asyncio.run(fable._build("build", request, AGENT, FABLE_AGENTS[AGENT], None, None, "k",
                                     on_progress=AsyncMock()))
    assert error == "Fable ran out of time on this build. Try a simpler request."
    storage.update_status.assert_awaited_with("build", "failed", error)
    assert fable._in_flight == before  # the slot is released however the build ends


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
            error = await fable._build("build", request, AGENT, FABLE_AGENTS[AGENT], None, None, "openai-test",
                                       on_progress=progress)
        finally:
            current_generation_usage.reset(token)
        return error, ledger

    error, ledger = asyncio.run(job())
    assert error is None
    prompt, options, script = options_seen[0]
    # The request carries the product's 3D default, as Nova's does; the saved design keeps the customer's words.
    assert prompt == guided_build_prompt("A small cabin") and prompt.endswith("User request:\nA small cabin")
    assert (options.model, options.method, options.max_parts, script) == ("gpt-6.1-sol", "thorough", 400, None)
    assert options.max_seconds == fable.BUILD_SECONDS  # every website build has a time limit

    saved = {call.kwargs["path"]: call.kwargs["file"] for call in publish.await_args_list}
    design = json.loads(saved[f"build/{fable.DESIGN_FILE}"])
    assert design == {"agent": AGENT, "model": "gpt-6.1-sol", "script": CABIN, "requests": ["A small cabin"]}
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
    error = asyncio.run(fable._build("build", request, AGENT, FABLE_AGENTS[AGENT], None, None, "k",
                                     on_progress=AsyncMock()))
    assert "could not finish a model" in error
    storage.update_status.assert_awaited_with("build", "failed", error)
    storage.store_model_file.assert_not_awaited()
    publish.assert_not_awaited()

    # Unexpected failures are logged, and the customer sees a generic message.
    monkeypatch.setattr(fable, "start_build", Mock(side_effect=RuntimeError("secret detail")))
    error = asyncio.run(fable._build("build", request, AGENT, FABLE_AGENTS[AGENT], None, None, "k",
                                     on_progress=AsyncMock()))
    assert error == "Fable could not complete this build."


def test_a_build_that_fails_its_checks_leaves_an_unverified_draft_to_download(tmp_path, monkeypatch):
    world = World(tmp_path / "world")
    clash = "place('3001', 'Red', 0, 0, 0)\nplace('3001', 'White', 1, 0, 0)\n"
    real_start = fable_app.start_build

    def start_build(prompt, run_dir, options, **kwargs):
        client = FakeClient([reply(tool_use("write_script", "c1", code=clash)),
                             reply({"type": "text", "text": "I give up."}), reply({"type": "text", "text": "Still."})])
        bench = fable_app.Workbench.open(world.settings(), runner=InlineRunner(world), renderer=FakeRenderer())
        return real_start(prompt, run_dir, options, client=client, workbench=bench, **kwargs)

    monkeypatch.setattr(fable, "start_build", start_build)
    storage, publish = web_storage(monkeypatch)
    request = nova.NovaToBricksRequest(prompt="A wall", max_parts=400, building_agent=AGENT)

    def build():
        return asyncio.run(fable._build("build", request, AGENT, FABLE_AGENTS[AGENT], None, None, "k",
                                        on_progress=AsyncMock()))

    error = build()
    # The words the website looks for before it offers the draft download.
    assert "Download the unverified draft" in error
    storage.update_status.assert_awaited_with("build", "failed", error)
    storage.store_model_file.assert_not_awaited()
    saved = publish.await_args.kwargs
    assert (saved["path"], saved["content_type"]) == ("build/nova-draft.zip", "application/zip")
    with zipfile.ZipFile(io.BytesIO(saved["file"])) as archive:
        assert sorted(archive.namelist()) == ["README.txt", "model.ldr", "parts.csv", "verification.json"]
        checks = json.loads(archive.read("verification.json"))
        assert checks["passed"] is False and checks["errors"][0]["kind"] == "overlap"
        assert b"3001.dat" in archive.read("model.ldr")

    # If the draft cannot be stored, the customer is not promised one.
    publish.side_effect = RuntimeError("storage is down")
    error = build()
    assert "Download" not in error and "could not finish a model" in error
    storage.update_status.assert_awaited_with("build", "failed", error)


def test_a_rejected_draft_of_an_in_process_agent_is_served_but_never_a_nova_source(monkeypatch):
    download = Mock(return_value=b"draft")
    generation = {"user_id": "builder", "user_type": "authenticated", "endpoint": "novaToBricks",
                  "model_used_3d": PIP_AGENT, "status": "failed"}
    storage = SimpleNamespace(get_generation=AsyncMock(return_value=generation),
                              client=SimpleNamespace(storage=SimpleNamespace(from_=lambda _: SimpleNamespace(
                                  download=download))))
    monkeypatch.setattr(nova, "generation_storage", storage)
    owner = {"user_id": "builder", "authenticated": True}
    response = asyncio.run(nova.get_nova_source("generation", owner))
    assert response.body == b"draft" and "nova-draft.zip" in response.headers["content-disposition"]
    download.assert_called_once_with("generation/nova-draft.zip")
    with pytest.raises(HTTPException):
        asyncio.run(nova.get_nova_source("generation", {"user_id": "someone-else", "authenticated": True}))
    generation["status"] = "completed"
    with pytest.raises(HTTPException) as refused:
        asyncio.run(nova.get_nova_source("generation", owner))
    assert refused.value.status_code == 404 and download.call_count == 1


def test_cancelling_a_generation_stops_the_agent_at_its_next_step(monkeypatch):
    storage, _ = web_storage(monkeypatch)
    entered, stopped = threading.Event(), threading.Event()

    def run(prompt, variant, max_parts, reference, script, key, on_event, examples=False):
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
        task = asyncio.create_task(fable._build("build", request, AGENT, FABLE_AGENTS[AGENT], None, None, "k", on_progress=AsyncMock()))
        await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.to_thread(stopped.wait, 5)

    asyncio.run(job())
    assert stopped.is_set()
    assert all(call.args[1] != "completed" for call in storage.update_status.await_args_list)


# ----- the Pip agent ---------------------------------------------------------------


def test_the_pip_agent_is_lean_v2_with_a_choice_of_model():
    pip = FABLE_AGENTS[PIP_AGENT]
    assert (pip.model, pip.method, pip.key_env) == ("gpt-6.2-sol", "lean-v2", "OPENAI_API_KEY")
    assert set(PIP_MODELS) == {"gpt-6.2-sol", "gpt-6.2-astra", "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"}
    assert pip.using(None) is pip and pip.using("gpt-6.2-sol") is pip
    opus = pip.using("claude-opus-5-5")
    assert (opus.model, opus.method, opus.key_env, opus.models) == ("claude-opus-5-5", "lean-v2", "ANTHROPIC_API_KEY",
                                                                     PIP_MODELS)
    assert pip.using("gpt-6.2-astra").key_env == "OPENAI_API_KEY"
    for refused in ("gpt-6.1-sol", "claude-opus-5", ""):
        with pytest.raises(ValueError):
            pip.using(refused)
    with pytest.raises(ValueError):
        FABLE_AGENTS[AGENT].using("claude-opus-5-5")  # options without a choice keep their model
    # Every model it offers has a price, or its spending limit could not be enforced.
    from fable_agent.provider import PRICES
    assert set(PIP_MODELS) <= set(PRICES)


@pytest.mark.parametrize("model", PIP_MODELS)
def test_a_pip_build_runs_on_the_chosen_model_and_its_own_key(monkeypatch, model):
    create, _ = start_recorder(monkeypatch)
    jobs = []
    monkeypatch.setattr(fable, "run_with_output", lambda *args, **kwargs: jobs.append(args) or AsyncMock()())
    request = nova.NovaToBricksRequest(building_agent=PIP_AGENT, agent_model=model, prompt="A boat")
    asyncio.run(nova.nova_to_bricks(request, ACCOUNT))
    _, _, _, agent, variant, design, reference, key = jobs[0]
    assert (agent, variant.model, variant.method, design) == (PIP_AGENT, model, "lean-v2", None)
    assert key == ("openai-test" if model.startswith("gpt-") else "anthropic-test")
    assert create.await_args.kwargs["model_3d"] == PIP_AGENT
    assert fable.handle_auth_and_tracking.call_args.args[2]["agent_model"] == model


@pytest.mark.parametrize(("agent", "asked", "given"), [
    (PIP_AGENT, True, True), (PIP_AGENT, False, False),
    (AGENT, True, False),  # a first-version agent has no examples to read, whatever is sent
])
def test_example_builds_are_off_unless_asked_for_and_only_for_the_v2_agents(tmp_path, monkeypatch, agent, asked, given):
    seen = []

    def start_build(prompt, run_dir, options, **kwargs):
        seen.append(options)
        return SimpleNamespace(published=None, status="refused", rejected=None)

    monkeypatch.setattr(fable, "start_build", start_build)
    web_storage(monkeypatch)
    request = nova.NovaToBricksRequest(prompt="A boat", building_agent=agent, **({"use_examples": True} if asked else {}))
    assert request.use_examples is asked
    asyncio.run(fable._build("build", request, agent, FABLE_AGENTS[agent], None, None, "k", on_progress=AsyncMock()))
    assert seen[0].examples is given
    with pytest.raises(ValidationError):
        nova.NovaToBricksRequest(prompt="A boat", building_agent=PIP_AGENT, use_examples="sometimes")


def test_a_pip_build_without_a_choice_uses_its_default_model(monkeypatch):
    start_recorder(monkeypatch)
    jobs = []
    monkeypatch.setattr(fable, "run_with_output", lambda *args, **kwargs: jobs.append(args) or AsyncMock()())
    asyncio.run(nova.nova_to_bricks(nova.NovaToBricksRequest(building_agent=PIP_AGENT, prompt="A boat"), ACCOUNT))
    assert jobs[0][4].model == "gpt-6.2-sol"


@pytest.mark.parametrize(("fields", "message"), [
    ({"building_agent": PIP_AGENT, "agent_model": "gpt-6.1-sol"}, "does not offer that model"),
    ({"building_agent": PIP_AGENT, "agent_model": "x" * 65}, "at most 64"),
    ({"building_agent": AGENT, "agent_model": "claude-opus-5-5"}, "does not offer that model"),
    ({"building_agent": "nova", "agent_model": "claude-opus-5-5"}, "does not offer that model"),
    ({"building_agent": "fable-lean-v2-gpt-6.2-sol"}, "has been replaced"),
])
def test_a_model_or_agent_that_is_not_offered_is_refused(fields, message):
    with pytest.raises(ValidationError, match=message):
        nova.NovaToBricksRequest(prompt="A boat", **fields)
    assert RETIRED_AGENTS == {"fable-lean-v2-gpt-6.2-sol"}


def test_a_pip_change_is_built_with_the_model_that_built_the_original(monkeypatch):
    start_recorder(monkeypatch)
    jobs = []
    monkeypatch.setattr(fable, "run_with_output", lambda *args, **kwargs: jobs.append(args) or AsyncMock()())
    source = {"id": "previous", "status": "completed", "model_used_3d": PIP_AGENT, "user_id": "builder",
              "user_type": "authenticated", "max_parts": 400}

    async def saved(design_model):
        return fable.Design(CABIN, ("A cabin",), design_model)

    for design_model, expected in (("claude-sonnet-5-5", "claude-sonnet-5-5"), (None, "gpt-6.2-sol"),
                                   ("model-no-longer-offered", "gpt-6.2-sol")):
        monkeypatch.setattr(fable, "_source_design", lambda source, auth, m=design_model: saved(m))
        request = nova.NovaToBricksRequest(prompt="Paint it blue", generation_id="previous")
        asyncio.run(fable.fable_to_bricks(request, ACCOUNT, source))
        assert jobs[-1][4].model == expected
    # Earlier builds of the retired option can still be changed.
    request = nova.NovaToBricksRequest(prompt="Paint it blue", generation_id="previous",
                                       building_agent="fable-lean-v2-gpt-6.2-sol")
    retired = {**source, "model_used_3d": "fable-lean-v2-gpt-6.2-sol"}
    asyncio.run(fable.fable_to_bricks(request, ACCOUNT, retired))
    assert jobs[-1][3] == "fable-lean-v2-gpt-6.2-sol"


def test_a_saved_design_remembers_its_model(monkeypatch):
    saved = json.dumps({"agent": PIP_AGENT, "model": "claude-opus-5-5", "script": CABIN, "requests": ["A cabin"]})
    bucket = Mock(download=Mock(return_value=saved.encode()))
    storage = SimpleNamespace(client=SimpleNamespace(storage=SimpleNamespace(from_=lambda _: bucket)))
    monkeypatch.setattr(fable, "generation_storage", storage)
    source = {"id": "previous", "status": "completed", "model_used_3d": PIP_AGENT, "user_id": "builder",
              "user_type": "authenticated"}
    assert asyncio.run(fable._source_design(source, ACCOUNT)).model == "claude-opus-5-5"
    bucket.download.return_value = json.dumps({"script": CABIN, "requests": [], "model": 7}).encode()
    assert asyncio.run(fable._source_design(source, ACCOUNT)).model is None
