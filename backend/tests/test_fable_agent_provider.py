import json
from decimal import Decimal

import httpx
import pytest
from fable_agent.provider import (AnthropicClient, Budget, BudgetExhausted, ModelReply, ProviderError,
                                  estimate_tokens, price_usage)


def sse(*events) -> bytes:
    return "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()


def stream_events(tool_json='{"code": "place(1)"}', stop_reason="tool_use"):
    return [
        {"type": "message_start", "message": {"model": "claude-fable-5-2", "usage": {
            "input_tokens": 100, "cache_read_input_tokens": 4000, "cache_creation_input_tokens": 50,
            "output_tokens": 1}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Plan."}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Build"}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "ing."}},
        {"type": "content_block_stop", "index": 1},
        {"type": "content_block_start", "index": 2, "content_block": {
            "type": "tool_use", "id": "toolu_1", "name": "write_script", "input": {}}},
        {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta",
                                                             "partial_json": tool_json[:9]}},
        {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta",
                                                             "partial_json": tool_json[9:]}},
        {"type": "content_block_stop", "index": 2},
        {"type": "ping"},
        {"type": "message_delta", "delta": {"stop_reason": stop_reason}, "usage": {"output_tokens": 300}},
        {"type": "message_stop"},
    ]


def client_for(handler, **options) -> AnthropicClient:
    return AnthropicClient("test-key", http=httpx.Client(transport=httpx.MockTransport(handler)),
                           sleep=lambda seconds: None, **options)


def test_a_streamed_reply_is_reassembled_with_usage_and_deltas():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, content=sse(*stream_events()))

    deltas = []
    reply = client_for(handler).send("system text", [{"name": "write_script", "input_schema": {}}],
                                     [{"role": "user", "content": "hi"}], max_tokens=5000,
                                     on_delta=lambda kind, text: deltas.append((kind, text)))
    assert reply.stop_reason == "tool_use" and not reply.invalid_inputs
    assert reply.content[0] == {"type": "thinking", "thinking": "Plan.", "signature": "sig"}
    assert reply.content[1] == {"type": "text", "text": "Building."}
    assert reply.content[2]["input"] == {"code": "place(1)"}
    assert reply.usage == {"input_tokens": 100, "cache_read_input_tokens": 4000,
                           "cache_creation_input_tokens": 50, "output_tokens": 300}
    assert ("thinking", "Plan.") in deltas and ("tool", "write_script") in deltas

    body = json.loads(seen[0].content)
    assert seen[0].headers["x-api-key"] == "test-key"
    assert body["model"] == "claude-fable-5-2" and body["stream"] is True and body["max_tokens"] == 5000
    assert body["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert body["output_config"] == {"effort": "high"}
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert body["tools"][0]["eager_input_streaming"] is True
    assert "tool_choice" not in body and "temperature" not in body
    assert body["fallbacks"] == "default"


@pytest.mark.parametrize("broken", ['{"code": "place(', "[1, 2]", "nonsense"])
def test_unparseable_tool_input_is_flagged_instead_of_run(broken):
    reply = client_for(lambda request: httpx.Response(200, content=sse(*stream_events(broken, "max_tokens")))).send(
        "s", [], [], max_tokens=100)
    assert reply.invalid_inputs == {"toolu_1": broken}
    assert reply.content[2]["input"] == {}


def test_overload_and_dropped_streams_are_retried_then_surface():
    attempts = []

    def flaky(request):
        attempts.append(1)
        if len(attempts) == 1:
            return httpx.Response(529, json={"error": {"type": "overloaded_error", "message": "busy"}})
        if len(attempts) == 2:
            return httpx.Response(200, content=sse(*stream_events()[:5]))  # ends before message_stop
        return httpx.Response(200, content=sse(*stream_events()))

    assert client_for(flaky).send("s", [], [], max_tokens=100).stop_reason == "tool_use"
    assert len(attempts) == 3

    with pytest.raises(ProviderError) as failure:
        client_for(lambda request: httpx.Response(500, json={"error": {"type": "api_error", "message": "x"}}),
                   max_retries=1).send("s", [], [], max_tokens=100)
    assert failure.value.status == 500


def test_client_errors_are_not_retried_and_never_include_the_key():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(401, json={"error": {"type": "authentication_error", "message": "invalid x-api-key"}})

    with pytest.raises(ProviderError) as failure:
        client_for(handler).send("s", [], [], max_tokens=100)
    assert len(calls) == 1 and failure.value.status == 401
    assert "test-key" not in str(failure.value)


def test_optional_request_features_are_dropped_once_when_the_route_does_not_offer_them():
    bodies = []

    def handler(request):
        body = json.loads(request.content)
        bodies.append(body)
        for field in ("fallbacks", "cache_control"):
            if field in body:
                return httpx.Response(400, json={"error": {"type": "invalid_request_error",
                                                           "message": f"{field}: Extra inputs are not permitted"}})
        return httpx.Response(200, content=sse(*stream_events()))

    client = client_for(handler)
    client.send("s", [], [], max_tokens=100)
    client.send("s", [], [], max_tokens=100)
    assert ["fallbacks" in body for body in bodies] == [True, False, False, False]
    assert ["cache_control" in body for body in bodies] == [True, True, False, False]
    assert all(body["system"][0]["cache_control"] for body in bodies)  # the explicit cache point stays
    assert "anthropic-beta" not in client._request("s", [], [], 100)[0]


def test_configuration_errors_are_explicit():
    with pytest.raises(ProviderError, match="ANTHROPIC_API_KEY"):
        AnthropicClient("")
    with pytest.raises(ProviderError, match="effort"):
        AnthropicClient("key", effort="extreme")


def test_pricing_counts_cache_reads_and_writes_and_fails_closed():
    usage = {"input_tokens": 1_000_000, "output_tokens": 100_000, "cache_read_input_tokens": 2_000_000,
             "cache_creation_input_tokens": 100_000}
    assert price_usage("claude-fable-5-2", usage) == Decimal("8") + Decimal("4") + Decimal("0.4") + Decimal("1")
    with pytest.raises(ProviderError, match="No pricing"):
        price_usage("mystery-model", usage)
    with pytest.raises(ProviderError, match="did not report"):
        price_usage("claude-fable-5-2", {"input_tokens": 1})
    with pytest.raises(ProviderError, match="invalid token usage"):
        price_usage("claude-fable-5-2", {"input_tokens": -5, "output_tokens": 1})


def test_budget_reserves_the_next_call_and_stops_before_overspending():
    budget = Budget("1.00", "claude-fable-5-2")
    assert budget.output_allowance(1000, 32_000) == 24_750  # ($1 - 1000 * $10/M) / $40/M
    budget.record(ModelReply([], "end_turn", {"input_tokens": 50_000, "output_tokens": 10_000}, "claude-fable-5-2"))
    assert budget.spent == Decimal("0.8")
    assert Decimal(budget.calls[0]["estimated_cost_usd"]) == Decimal("0.8")
    with pytest.raises(BudgetExhausted):  # the 60K-token context alone could cost $0.60 uncached
        budget.output_allowance(0, 32_000)
    with pytest.raises(ProviderError):
        Budget("1", "mystery-model")


def test_a_fallback_reply_is_priced_at_the_model_that_served_it():
    budget = Budget("5", "claude-fable-5-2")
    budget.record(ModelReply([], "end_turn", {"input_tokens": 1_000_000, "output_tokens": 0}, "claude-opus-4-8"))
    assert budget.spent == Decimal("5") and budget.calls[0]["model"] == "claude-opus-4-8"


def test_token_estimates_bound_images_without_reading_their_bytes():
    block = {"type": "image", "source": {"type": "base64", "data": "A" * 1_000_000}}
    assert estimate_tokens({"role": "user", "content": [block, {"type": "text", "text": "abcd"}]}) < 7000
