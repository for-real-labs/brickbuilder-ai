import asyncio
import json
import httpx

import pytest
from fastapi import HTTPException

from src.utils import llm_tool_conversation as module
from src.utils.llm_tool_conversation import (
    AnthropicToolConversation,
    ConversationSettings,
    OpenAIToolConversation,
    ToolResult,
    ToolSpec,
    UserInput,
    create_conversation,
)

TOOLS = [ToolSpec("submit", "Submit a design.", {"type": "object", "properties": {}})]
SETTINGS = ConversationSettings(model="m", system="be a builder", tools=TOOLS, max_tokens=1000,
                                reasoning_effort="high")
USER = UserInput(text="a castle", image_base64="aW1n", image_media_type="image/jpeg")
PNG = b"\x89PNG-bytes"


def _fake_post(monkeypatch, responses):
    sent = []

    async def fake(_client, url, headers, payload, provider):
        sent.append({"url": url, "headers": headers, "payload": json.loads(json.dumps(payload)),
                     "provider": provider})
        return responses[len(sent) - 1]

    monkeypatch.setattr(module, "post_json", fake)
    return sent


def test_anthropic_conversation_round_trips_tool_calls_results_and_images(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a-key")
    monkeypatch.setenv("ANTHROPIC_WORKSPACE_ID", "ws")
    sent = _fake_post(monkeypatch, [
        {"stop_reason": "tool_use", "content": [
            {"type": "text", "text": "Building"},
            {"type": "tool_use", "id": "t1", "name": "submit", "input": {"grid": 1}},
        ]},
        {"stop_reason": "max_tokens", "content": []},
    ])
    conversation = AnthropicToolConversation(None, SETTINGS, USER)

    turn = asyncio.run(conversation.send())
    assert turn.text == "Building" and not turn.truncated
    assert [(c.id, c.name, c.input) for c in turn.tool_calls] == [("t1", "submit", {"grid": 1})]

    conversation.add_tool_results([ToolResult("t1", "Build failed", is_error=True),
                                   ToolResult("t1", "Looks good", image_png=PNG)])
    assert asyncio.run(conversation.send()).truncated

    first, second = sent[0], sent[1]
    assert first["url"] == module.ANTHROPIC_URL
    assert first["headers"]["x-api-key"] == "a-key" and first["headers"]["anthropic-workspace-id"] == "ws"
    payload = first["payload"]
    assert payload["system"] == "be a builder" and payload["tool_choice"] == {"type": "auto"}
    assert payload["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert payload["tools"] == [{"name": "submit", "description": "Submit a design.",
                                 "input_schema": {"type": "object", "properties": {}}}]
    image, text = payload["messages"][0]["content"]
    assert image["source"] == {"type": "base64", "media_type": "image/jpeg", "data": "aW1n"}
    assert text == {"type": "text", "text": "a castle"}

    error_block, image_block = second["payload"]["messages"][-1]["content"]
    assert error_block == {"type": "tool_result", "tool_use_id": "t1", "content": "Build failed", "is_error": True}
    assert image_block["content"][1]["source"]["media_type"] == "image/png"


def test_openai_conversation_chains_responses_and_sends_function_outputs(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "o-key")
    sent = _fake_post(monkeypatch, [
        {"id": "resp_1", "status": "completed", "output": [
            {"type": "reasoning", "summary": []},
            {"type": "message", "content": [{"type": "output_text", "text": "Plan"}]},
            {"type": "function_call", "call_id": "c1", "name": "submit", "arguments": '{"grid": 2}'},
            {"type": "function_call", "call_id": "c2", "name": "submit", "arguments": "not json"},
        ]},
        {"id": "resp_2", "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"},
         "output": []},
    ])
    conversation = OpenAIToolConversation(None, SETTINGS, USER)

    turn = asyncio.run(conversation.send())
    assert turn.text == "Plan"
    assert [(c.id, c.input) for c in turn.tool_calls] == [("c1", {"grid": 2}), ("c2", {})]

    conversation.add_tool_results([ToolResult("c1", "Build failed", is_error=True),
                                   ToolResult("c2", "Looks good", image_png=PNG)])
    conversation.add_user_text("Use the tool")
    assert asyncio.run(conversation.send()).truncated

    first, second = sent[0]["payload"], sent[1]["payload"]
    assert sent[0]["url"] == module.OPENAI_URL
    assert sent[0]["headers"]["Authorization"] == "Bearer o-key"
    assert first["instructions"] == "be a builder" and "previous_response_id" not in first
    assert first["reasoning"] == {"effort": "high", "summary": "auto"} and first["max_output_tokens"] == 1000
    assert first["tools"] == [{"type": "function", "name": "submit", "description": "Submit a design.",
                               "parameters": {"type": "object", "properties": {}}}]
    image, text = first["input"][0]["content"]
    assert image["image_url"] == "data:image/jpeg;base64,aW1n" and text["text"] == "a castle"

    assert second["previous_response_id"] == "resp_1"
    error_output, image_output, nudge = second["input"]
    assert error_output == {"type": "function_call_output", "call_id": "c1", "output": "Error: Build failed"}
    assert image_output["output"][1]["image_url"].startswith("data:image/png;base64,")
    assert nudge == {"role": "user", "content": [{"type": "input_text", "text": "Use the tool"}]}


@pytest.mark.parametrize("provider, env", [("anthropic", "ANTHROPIC_API_KEY"), ("openai", "OPENAI_API_KEY")])
def test_missing_api_key_is_a_503(monkeypatch, provider, env):
    monkeypatch.delenv(env, raising=False)
    with pytest.raises(HTTPException) as info:
        create_conversation(provider, None, SETTINGS, USER)
    assert info.value.status_code == 503 and env in info.value.detail


def test_unknown_provider_is_rejected():
    with pytest.raises(ValueError, match="Unsupported"):
        create_conversation("other", None, SETTINGS, USER)


@pytest.mark.parametrize('provider', ['Anthropic', 'OpenAI'])
def test_streaming_text_and_claude_thinking_reassemble_tools_without_signatures(provider, monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'test')
    monkeypatch.setenv('OPENAI_API_KEY', 'test')
    if provider == 'Anthropic':
        events = [
            {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'Building'}},
            {'type': 'content_block_start', 'index': 1, 'content_block': {'type': 'thinking', 'thinking': ''}},
            {'type': 'content_block_delta', 'index': 1, 'delta': {'type': 'thinking_delta', 'thinking': 'Planning a sturdy base'}},
            {'type': 'content_block_delta', 'index': 1, 'delta': {'type': 'signature_delta', 'signature': 'signature'}},
            {'type': 'content_block_start', 'index': 2, 'content_block': {'type': 'tool_use', 'id': 't1', 'name': 'submit', 'input': {}}},
            {'type': 'content_block_delta', 'index': 2, 'delta': {'type': 'input_json_delta', 'partial_json': '{"grid":'}},
            {'type': 'content_block_delta', 'index': 2, 'delta': {'type': 'input_json_delta', 'partial_json': '1}'}},
            {'type': 'content_block_stop', 'index': 2},
            {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}},
            {'type': 'message_stop'},
        ]
    else:
        events = [
            {'type': 'response.output_text.delta', 'delta': 'Building'},
            {'type': 'response.reasoning_summary_text.delta', 'delta': 'Shaping the castle towers'},
            {'type': 'response.reasoning_summary_text.done', 'text': 'Shaping the castle towers'},
            {'type': 'response.reasoning_text.delta', 'delta': 'private'},
            {'type': 'response.output_item.added', 'item': {'type': 'function_call'}},
            {'type': 'response.function_call_arguments.delta', 'delta': '{"grid":1}'},
            {'type': 'response.function_call_arguments.done', 'arguments': '{"grid":1}'},
            {'type': 'response.completed', 'response': {'id': 'r1', 'status': 'completed', 'output': [
                {'type': 'message', 'content': [{'type': 'output_text', 'text': 'Building'}]},
                {'type': 'function_call', 'call_id': 't1', 'name': 'submit', 'arguments': '{"grid":1}'},
            ]}},
        ]
    async def run():
        chunks = []
        async def on_text(text):
            chunks.append(text)
        def respond(request):
            if provider == 'Anthropic':
                payload = json.loads(request.content)
                assert payload['tools'][0]['eager_input_streaming'] is True
            return httpx.Response(200, text=''.join(
                'data: ' + json.dumps(event) + '\n\n' for event in events))
        transport = httpx.MockTransport(respond)
        async with httpx.AsyncClient(transport=transport) as client:
            cls = AnthropicToolConversation if provider == 'Anthropic' else OpenAIToolConversation
            conversation = cls(client, SETTINGS, USER)
            turn = await conversation.send_stream(on_text)
            assert turn.text == 'Building'
            assert turn.tool_calls[0].input == {'grid': 1}
            assert 'Building' in ''.join(chunks)
            assert 'private' not in ''.join(chunks)
            assert 'signature' not in ''.join(chunks)
            assert '{"grid":1}' in ''.join(chunks)
            assert 'Design output (' in ''.join(chunks)
            assert 'Preparing the brick design' not in ''.join(chunks)
            if provider == 'Anthropic':
                assert 'Planning a sturdy base' in ''.join(chunks)
                assert conversation.messages[-1]['content'][1]['signature'] == 'signature'
            else:
                assert ''.join(chunks).count('Shaping the castle towers') == 1
    asyncio.run(run())


def test_truncated_provider_stream_is_not_accepted_as_success():
    async def run():
        transport = httpx.MockTransport(lambda request: httpx.Response(200, text='data: {"type":"ping"}\n\n'))
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(HTTPException, match='ended before completion'):
                await module.post_stream_json(client, 'https://example.com', {}, {}, 'Anthropic', AsyncMock())
    from unittest.mock import AsyncMock
    asyncio.run(run())


def test_claude_thinking_is_forwarded_before_the_response_finishes(monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'test')
    async def run():
        received = asyncio.Event()
        finish = asyncio.Event()
        class Stream(httpx.AsyncByteStream):
            async def __aiter__(self):
                for event in [
                    {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'thinking', 'thinking': ''}},
                    {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'thinking_delta', 'thinking': 'Planning the firetruck'}},
                ]:
                    yield ('data: ' + json.dumps(event) + '\n\n').encode()
                await finish.wait()
                yield b'data: {"type":"message_stop"}\n\n'
        async def on_text(text):
            if 'Planning the firetruck' in text:
                received.set()
        transport = httpx.MockTransport(lambda request: httpx.Response(200, stream=Stream()))
        async with httpx.AsyncClient(transport=transport) as client:
            conversation = AnthropicToolConversation(client, SETTINGS, USER)
            task = asyncio.create_task(conversation.send_stream(on_text))
            try:
                await asyncio.wait_for(received.wait(), 1)
                assert not task.done()
            finally:
                finish.set()
                await task
    asyncio.run(run())


@pytest.mark.parametrize('outcome', ['failed', 'cancelled', 'completed'])
def test_direct_anthropic_stream_records_cumulative_usage_even_if_interrupted(monkeypatch, outcome):
    from dataclasses import replace
    from decimal import Decimal
    from src.utils.generation_budget import GenerationUsage, current_generation_usage
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'test')
    async def run():
        ledger = GenerationUsage('job')
        token = current_generation_usage.set(ledger)
        events = [
            {'type': 'message_start', 'message': {'usage': {'input_tokens': 100, 'output_tokens': 0}}},
            {'type': 'message_delta', 'usage': {'output_tokens': 10}},
        ]
        class Stream(httpx.AsyncByteStream):
            async def __aiter__(self):
                for event in events:
                    yield ('data: ' + json.dumps(event) + '\n\n').encode()
                assert ledger.values()['tokens_used'] == 110
                if outcome == 'cancelled': raise asyncio.CancelledError
                if outcome == 'failed': raise httpx.ReadError('disconnect')
                yield b'data: {"type":"message_stop"}\n\n'
        async def on_text(text): pass
        try:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=Stream()))) as client:
                conversation = AnthropicToolConversation(client, replace(SETTINGS, model='claude-opus-5-5', enforce_cost_limit=True), USER)
                if outcome == 'completed':
                    await conversation.send_stream(on_text)
                else:
                    with pytest.raises(asyncio.CancelledError if outcome == 'cancelled' else HTTPException):
                        await conversation.send_stream(on_text)
            assert ledger.values()['tokens_used'] == 110
            assert Decimal(ledger.values()['estimated_cost_usd']) == Decimal('.0006')
            assert len(ledger.calls) == 1
        finally:
            current_generation_usage.reset(token)
    asyncio.run(run())
