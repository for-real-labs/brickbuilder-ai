import json
from decimal import Decimal

import httpx
import pytest
from fable_agent.app import Options, Workbench, _client, continue_build, start_build
from fable_agent.openai_provider import (ITEM, OpenAIClient, from_response, is_openai_model, to_function_tools,
                                         to_input_items)
from fable_agent.provider import AnthropicClient, Budget, ModelReply, ProviderError, price_usage
from fable_agent.session import Session
from fable_agent.tools import TOOL_DEFINITIONS

from fable_agent_support import CABIN, FakeRenderer, InlineRunner, World

REASONING = {"type": "reasoning", "id": "rs_1", "status": "completed", "encrypted_content": "sealed-1",
             "summary": [{"type": "summary_text", "text": "Plan the walls."}]}
USAGE = {"input_tokens": 5000, "input_tokens_details": {"cached_tokens": 4000, "cache_write_tokens": 600},
         "output_tokens": 300, "output_tokens_details": {"reasoning_tokens": 200}, "total_tokens": 5300}


@pytest.fixture(autouse=True)
def private_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("FABLE_AGENT_CACHE", str(tmp_path / "cache"))


def call(name: str, call_id: str, status: str = "completed", **arguments) -> dict:
    return {"type": "function_call", "id": f"fc_{call_id}", "call_id": call_id, "name": name,
            "arguments": json.dumps(arguments), "status": status}


def message(text: str, **extra) -> dict:
    return {"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
            "content": [{"type": "output_text", "text": text, "annotations": []}], **extra}


def response(*output, status="completed", usage=USAGE, **extra) -> dict:
    return {"id": "resp_1", "object": "response", "status": status, "model": "gpt-6.2-sol-2026-11-02",
            "output": list(output), "usage": usage, **extra}


def sse(*events) -> bytes:
    return "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()


def stream_of(final: dict, kind: str = "response.completed") -> bytes:
    events = [{"type": "response.created", "response": {"id": final["id"]}}]
    for item in final["output"]:
        if item["type"] == "function_call":
            events.append({"type": "response.output_item.added", "item": {**item, "arguments": ""}})
            events.append({"type": "response.function_call_arguments.delta", "delta": item["arguments"]})
        elif item["type"] == "reasoning":
            events.append({"type": "response.reasoning_summary_text.delta", "delta": item["summary"][0]["text"]})
            events.append({"type": "response.reasoning_summary_text.done"})
        elif item["type"] == "message":
            events.append({"type": "response.output_text.delta", "delta": item["content"][0]["text"]})
        events.append({"type": "response.output_item.done", "item": item})
    return sse(*events, {"type": kind, "response": final}) + b"data: [DONE]\n\n"


def client_for(handler, **options) -> OpenAIClient:
    return OpenAIClient("test-key", http=httpx.Client(transport=httpx.MockTransport(handler)),
                        sleep=lambda seconds: None, **{"model": "gpt-6.2-sol", **options})


def test_tools_become_non_strict_functions_with_the_same_schema():
    tools = to_function_tools(TOOL_DEFINITIONS)
    assert [tool["name"] for tool in tools] == [tool["name"] for tool in TOOL_DEFINITIONS]
    render = next(tool for tool in tools if tool["name"] == "render")
    assert render["type"] == "function" and render["strict"] is False
    assert render["parameters"] == next(t for t in TOOL_DEFINITIONS if t["name"] == "render")["input_schema"]
    assert "input_schema" not in render


def test_a_response_becomes_one_turn_that_keeps_every_item_verbatim():
    reply = from_response(response(REASONING, message("Building."), call("write_script", "c1", code="place(1)"),
                                   call("render", "c2", views=["front"], focus=None)), "gpt-6.2-sol")
    assert reply.stop_reason == "tool_use" and not reply.invalid_inputs
    assert reply.model == "gpt-6.2-sol"  # priced as the model that was asked for, not the dated snapshot
    assert reply.content[0] == {"type": "reasoning", "summary": "Plan the walls.", ITEM: REASONING}
    assert reply.content[1]["type"] == "text" and reply.content[1]["text"] == "Building."
    assert reply.content[2]["type"] == "tool_use" and reply.content[2]["id"] == "c1"
    assert reply.content[2]["input"] == {"code": "place(1)"}
    assert reply.content[3]["input"] == {"views": ["front"]}  # a null argument means "not given"
    assert [block[ITEM]["type"] for block in reply.content] == ["reasoning", "message", "function_call",
                                                                 "function_call"]


def test_usage_separates_cached_and_written_tokens_from_fresh_input():
    usage = from_response(response(message("ok")), "gpt-6.2-sol").usage
    assert usage == {"input_tokens": 400, "output_tokens": 300, "cache_read_input_tokens": 4000,
                     "cache_creation_input_tokens": 600}
    # 400 fresh at $2, 4000 read at $0.10, 600 written at $2.50, 300 out at $10, per million tokens.
    assert price_usage("gpt-6.2-sol", usage) == Decimal("0.0057")
    for broken in (None, {"input_tokens": 5}, {"input_tokens": -1, "output_tokens": 1},
                   {"input_tokens": 10, "output_tokens": 1, "input_tokens_details": {"cached_tokens": 11}}):
        with pytest.raises(ProviderError, match="usage"):
            from_response(response(message("ok"), usage=broken), "gpt-6.2-sol")


@pytest.mark.parametrize("final, expected", [
    (response(message("Done.")), "end_turn"),
    (response(REASONING, status="incomplete", incomplete_details={"reason": "max_output_tokens"}), "max_tokens"),
    (response(call("write_script", "c1", status="incomplete"), status="incomplete",
              incomplete_details={"reason": "max_output_tokens"}), "max_tokens"),
    (response(status="incomplete", incomplete_details={"reason": "content_filter"}), "refusal"),
    (response({"type": "message", "content": [{"type": "refusal", "refusal": "I can't help with that."}]}),
     "refusal"),
])
def test_stop_reasons_map_to_the_ones_the_loop_understands(final, expected):
    assert from_response(final, "gpt-6.2-sol").stop_reason == expected


@pytest.mark.parametrize("broken", ['{"code": "place(', "[1, 2]", "nonsense"])
def test_unparseable_function_arguments_are_flagged_instead_of_run(broken):
    item = {**call("write_script", "c9"), "arguments": broken}
    reply = from_response(response(item), "gpt-6.2-sol")
    assert reply.invalid_inputs == {"c9": broken} and reply.content[0]["input"] == {}
    # Replaying the turn must still be a valid request, so the call goes back with parseable arguments.
    replayed = to_input_items([{"role": "assistant", "content": reply.content}])
    assert replayed == [{"type": "function_call", "call_id": "c9", "name": "write_script", "arguments": "{}"}]


def test_the_transcript_is_translated_in_order_with_pictures_and_tool_results():
    picture = {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "QUJD"}}
    turn = from_response(response(REASONING, call("render", "c1", views=["front"])), "gpt-6.2-sol").content
    items = to_input_items([
        {"role": "user", "content": [picture, {"type": "text", "text": "Build this."}]},
        {"role": "assistant", "content": turn},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "c1", "content": [
                {"type": "text", "text": "Rendered 1 view."},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "REVG"}}]},
            {"type": "tool_result", "tool_use_id": "c2", "is_error": True,
             "content": [{"type": "text", "text": "Unknown view"}]},
            {"type": "text", "text": "Harness note: only 8 steps remain."}]},
        {"role": "user", "content": "Plain text also works."},
    ])
    assert items == [
        {"role": "user", "content": [
            {"type": "input_image", "detail": "high", "image_url": "data:image/jpeg;base64,QUJD"},
            {"type": "input_text", "text": "Build this."}]},
        REASONING,
        call("render", "c1", views=["front"]),
        {"type": "function_call_output", "call_id": "c1", "output": [
            {"type": "input_text", "text": "Rendered 1 view."},
            {"type": "input_image", "detail": "high", "image_url": "data:image/png;base64,REVG"}]},
        {"type": "function_call_output", "call_id": "c2", "output": "Error: Unknown view"},
        {"role": "user", "content": [{"type": "input_text", "text": "Harness note: only 8 steps remain."}]},
        {"role": "user", "content": [{"type": "input_text", "text": "Plain text also works."}]},
    ]


def test_cut_off_items_are_rebuilt_or_dropped_and_other_providers_are_refused():
    cut = from_response(response(
        {**REASONING, "status": "incomplete", "encrypted_content": None},
        {**message("Half a sent"), "status": "incomplete"},
        status="incomplete", incomplete_details={"reason": "max_output_tokens"}), "gpt-6.2-sol").content
    assert to_input_items([{"role": "assistant", "content": cut}]) == [
        {"role": "assistant", "content": [{"type": "output_text", "text": "Half a sent"}]}]
    with pytest.raises(ProviderError, match="another AI provider"):
        to_input_items([{"role": "assistant", "content": [{"type": "thinking", "thinking": "", "signature": "s"}]}])
    with pytest.raises(ProviderError, match="cannot be sent"):
        to_input_items([{"role": "user", "content": [{"type": "document"}]}])


def test_a_streamed_response_is_sent_stateless_and_reassembled_with_deltas():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, content=stream_of(response(
            REASONING, message("Building."), call("write_script", "c1", code="place(1)"))))

    deltas = []
    reply = client_for(handler, model="gpt-6.2-astra", effort="xhigh").send(
        "system text", TOOL_DEFINITIONS, [{"role": "user", "content": "hi"}], max_tokens=5000,
        on_delta=lambda kind, text: deltas.append((kind, text)))
    assert reply.stop_reason == "tool_use" and reply.content[2]["input"] == {"code": "place(1)"}
    assert ("thinking", "Plan the walls.") in deltas and ("text", "Building.") in deltas
    assert ("tool", "write_script") in deltas

    body = json.loads(seen[0].content)
    assert seen[0].headers["authorization"] == "Bearer test-key"
    assert body["model"] == "gpt-6.2-astra" and body["stream"] is True and body["max_output_tokens"] == 5000
    # The system prompt is the first input item, where every model caches it.
    assert "instructions" not in body
    assert body["input"] == [{"role": "developer", "content": [{"type": "input_text", "text": "system text"}]},
                             {"role": "user", "content": [{"type": "input_text", "text": "hi"}]}]
    assert body["reasoning"] == {"effort": "xhigh", "summary": "auto"}
    # Nothing is stored with the provider; reasoning comes back encrypted so it can be replayed.
    assert body["store"] is False and body["include"] == ["reasoning.encrypted_content"]
    assert "previous_response_id" not in body and "temperature" not in body
    assert len(body["tools"]) == len(TOOL_DEFINITIONS) and body["tool_choice"] == "auto"


def test_items_are_recovered_from_the_stream_when_the_final_event_omits_them():
    final = response(call("read_script", "c1"))
    content = stream_of(final).replace(json.dumps({"type": "response.completed", "response": final}).encode(),
                                       json.dumps({"type": "response.completed",
                                                   "response": {**final, "output": []}}).encode())
    reply = client_for(lambda request: httpx.Response(200, content=content)).send("s", [], [], max_tokens=100)
    assert [block["name"] for block in reply.content] == ["read_script"]


def test_temporary_failures_are_retried_and_permanent_ones_surface_without_the_key():
    attempts = []
    good = stream_of(response(message("ok")))

    def flaky(request):
        attempts.append(1)
        if len(attempts) == 1:
            return httpx.Response(429, json={"error": {"type": "rate_limit_error", "message": "slow down"}})
        if len(attempts) == 2:
            return httpx.Response(200, content=good.split(b"event: response.completed")[0])  # dropped stream
        if len(attempts) == 3:
            return httpx.Response(200, content=sse({"type": "response.failed", "response": {
                "error": {"code": "server_error", "message": "boom"}}}))
        return httpx.Response(200, content=good)

    assert client_for(flaky).send("s", [], [], max_tokens=100).stop_reason == "end_turn"
    assert len(attempts) == 4

    calls = []

    def denied(request):
        calls.append(1)
        return httpx.Response(401, json={"error": {
            "type": "invalid_request_error", "message": "Incorrect API key provided: test*****-key."}})

    with pytest.raises(ProviderError, match="API key was rejected") as failure:
        client_for(denied).send("s", [], [], max_tokens=100)
    assert len(calls) == 1 and failure.value.status == 401
    assert "test-key" not in str(failure.value) and "-key" not in str(failure.value)  # not even the masked echo

    with pytest.raises(ProviderError, match="invalid_prompt") as failure:
        client_for(lambda request: httpx.Response(200, content=sse({"type": "response.failed", "response": {
            "error": {"code": "invalid_prompt", "message": "no"}}}))).send("s", [], [], max_tokens=100)
    assert failure.value.status == 400


def test_configuration_errors_are_explicit_and_the_model_name_picks_the_provider(monkeypatch):
    with pytest.raises(ProviderError, match="OPENAI_API_KEY"):
        OpenAIClient("", model="gpt-6.2-sol")
    with pytest.raises(ProviderError, match="effort"):
        OpenAIClient("key", model="gpt-6.2-sol", effort="extreme")
    assert is_openai_model("gpt-6.2-sol") and not is_openai_model("claude-fable-5-2")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-test")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-test")
    assert isinstance(_client(Options(), "gpt-6.2-astra", "high"), OpenAIClient)
    assert isinstance(_client(Options(), "claude-fable-5-2", "high"), AnthropicClient)
    monkeypatch.delenv("OPENAI_API_KEY")
    with pytest.raises(ProviderError, match="OPENAI_API_KEY"):
        _client(Options(), "gpt-6.2-sol", "high")


def test_long_prompts_are_priced_and_reserved_at_long_context_rates():
    short = {"input_tokens": 272_000, "output_tokens": 1_000_000}
    long = {"input_tokens": 1_000, "cache_read_input_tokens": 271_000, "cache_creation_input_tokens": 1_000,
            "output_tokens": 1_000_000}
    assert price_usage("gpt-6.2-sol", short) == Decimal("0.544") + Decimal("10")
    assert price_usage("gpt-6.2-sol", long) == (Decimal("0.004") + Decimal("0.0542") + Decimal("0.005")
                                                 + Decimal("15"))
    # Claude models have no long-context surcharge.
    assert price_usage("claude-fable-5-2", {"input_tokens": 300_000, "output_tokens": 0}) == Decimal("2.4")

    budget = Budget("10", "gpt-6.2-sol")
    assert budget.output_allowance(100_000, 10 ** 9) == 975_000  # ($10 - 100K * $2.50/M) / $10/M
    budget.record(ModelReply([], "end_turn", {"input_tokens": 0, "cache_read_input_tokens": 250_000,
                                              "output_tokens": 0}, "gpt-6.2-sol"))
    assert budget.spent == Decimal("0.025")
    # 280K tokens of context is past the threshold: reserve at $5/M and allow output at $15/M.
    assert budget.output_allowance(30_000, 10 ** 9) == 571_666


def test_a_build_runs_end_to_end_on_an_openai_model_and_replays_reasoning(tmp_path):
    world = World(tmp_path / "world")
    replies = [
        response(REASONING, call("write_script", "c1", code=CABIN)),
        response({**REASONING, "id": "rs_2", "encrypted_content": "sealed-2"},
                 call("render", "c2", views=["front-right"], elevation=None)),
        response(message("Publishing."), call("finish", "c3", title="Cabin", summary="A small cabin.")),
        response(REASONING, call("edit_script", "c4", old='"Sand_Blue"', new='"Red"')),
        response(call("render", "c5", views=["front"])),
        response(call("finish", "c6", title="Red cabin", summary="Now red.")),
    ]
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, content=stream_of(replies[len(bodies) - 1]))

    def bench():
        return Workbench.open(world.settings(), runner=InlineRunner(world), renderer=FakeRenderer())

    result = start_build("A small cabin", tmp_path / "run", Options(max_parts=500, model="gpt-6.2-sol"),
                         client=client_for(handler), workbench=bench())
    assert result.status == "published" and result.steps == 3
    assert Decimal("0") < result.spent_usd < Decimal("0.05")
    session = Session.load(tmp_path / "run")
    assert session.meta["model"] == "gpt-6.2-sol" and len(session.meta["usage"]) == 3

    first, second, third = (body["input"] for body in bodies)
    assert second[:len(first)] == first and third[:len(second)] == second  # append-only, so the cache holds
    assert first[0]["role"] == "developer" and first[0]["content"][0]["text"] == session.meta["system"]
    assert second[2] == REASONING and second[3] == call("write_script", "c1", code=CABIN)
    assert second[4]["type"] == "function_call_output" and second[4]["call_id"] == "c1"
    picture = third[-1]["output"][1]
    assert picture["type"] == "input_image" and picture["image_url"].startswith("data:image/png;base64,")
    assert "base64" not in json.dumps(session.messages)  # pictures stay files in the stored transcript

    # A follow-up edit replays the whole stored conversation, reasoning items included.
    later = continue_build("Make it red", tmp_path / "run", Options(), client=client_for(handler),
                           workbench=bench())
    assert later.status == "published" and later.published["title"] == "Red cabin"
    assert bodies[3]["input"][:len(third)] == third
    assert '"Red"' in (tmp_path / "run" / "build.py").read_text()
