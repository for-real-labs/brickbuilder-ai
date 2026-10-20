"""Exercise the real pinned LiteLLM request/response conversion, without API calls."""
import asyncio
import json
from decimal import Decimal
from types import SimpleNamespace

import httpx
import pytest

from test_nova_cost_limits import load_limits
from src.utils.generation_budget import GenerationBudget


@pytest.mark.parametrize('streaming', [False, True])
def test_real_litellm_sends_fast_speed_and_preserves_usage(monkeypatch, streaming):
    litellm = pytest.importorskip('litellm')
    module = load_limits(monkeypatch)
    sent = []
    async def send(client, request, **kwargs):
        sent.append(json.loads(request.content))
        usage = {'input_tokens': 1000, 'output_tokens': 1000, 'speed': 'fast'}
        message = {'id': 'msg_test', 'type': 'message', 'role': 'assistant',
                   'model': 'claude-opus-5-5', 'content': [{'type': 'text', 'text': 'OK'}],
                   'stop_reason': 'end_turn', 'usage': usage}
        if not streaming:
            return httpx.Response(200, json=message, request=request)
        events = [
            {'type': 'message_start', 'message': {**message, 'content': [], 'stop_reason': None,
                'usage': {**usage, 'output_tokens': 0}}},
            {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'OK'}},
            {'type': 'content_block_stop', 'index': 0},
            {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': usage},
            {'type': 'message_stop'},
        ]
        body = ''.join('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n' for event in events)
        return httpx.Response(200, text=body, headers={'content-type': 'text/event-stream'}, request=request)
    monkeypatch.setattr(httpx.AsyncClient, 'send', send)
    # Wrap a local namespace so the global LiteLLM module is restored by pytest.
    llm = SimpleNamespace(acompletion=litellm.acompletion)
    sdk = SimpleNamespace(ClaudeAgentOptions=lambda **kwargs: kwargs,
        ClaudeSDKClient=SimpleNamespace(receive_response=lambda: None))
    module.install_cost_limits(SimpleNamespace(start_turn=lambda: None), None, llm, sdk)
    budget = GenerationBudget('claude-opus-5-5')
    token = module.current_budget.set(budget)
    async def run():
        response = await llm.acompletion(model='anthropic/claude-opus-5-5',
            api_key='test-not-a-real-key', messages=[{'role': 'user', 'content': 'Hi'}], stream=streaming)
        if streaming:
            async for _ in response: pass
    try:
        asyncio.run(run())
    finally:
        module.current_budget.reset(token)
    assert len(sent) == 1 and sent[0]['speed'] == 'fast'
    assert sent[0]['model'] == 'claude-opus-5-5'
    assert budget.spent == Decimal('.048')
    assert budget.usage_records[0]['speed'] == 'fast'
