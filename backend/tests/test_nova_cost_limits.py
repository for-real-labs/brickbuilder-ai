import asyncio
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from decimal import Decimal

import pytest

from src.utils import generation_budget


def load_limits(monkeypatch):
    monkeypatch.setitem(sys.modules, 'brickbuilder_integration', SimpleNamespace(__path__=[]))
    monkeypatch.setitem(sys.modules, 'brickbuilder_integration.generation_budget', generation_budget)
    spec = importlib.util.spec_from_file_location('brickbuilder_integration.cost_limits', Path(__file__).parents[1] / 'nova-service/cost_limits.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_nova_budget_survives_background_task_and_isolated_between_owners(monkeypatch):
    module = load_limits(monkeypatch)
    tasks, budgets, calls = [], [], []
    async def stream():
        yield SimpleNamespace(usage={'prompt_tokens': 1000, 'completion_tokens': 1000})
    async def completion(**kwargs):
        calls.append(kwargs)
        return stream()
    llm = SimpleNamespace(acompletion=completion)
    async def start(*args):
        async def work():
            budget = module.current_budget.get()
            budgets.append(budget)
            for _ in range(2):
                async for chunk in await llm.acompletion(model='openai/gpt-5.5', messages=[], stream=True, num_retries=2): pass
            assert budget.spent == Decimal('.07')
            budget.spent = Decimal('10')
            with pytest.raises(generation_budget.GenerationBudgetExceeded):
                await llm.acompletion(model='openai/gpt-5.5', messages=[], stream=True)
        tasks.append(asyncio.create_task(work()))
    async def receive(client):
        if False: yield None
    agent = SimpleNamespace(start_turn=start)
    sdk = SimpleNamespace(ClaudeAgentOptions=lambda **kwargs: kwargs, ClaudeSDKClient=SimpleNamespace(receive_response=receive))
    config = SimpleNamespace(get=lambda id: {'litellm_params': {'model': 'openai/gpt-5.5'}})
    module.install_cost_limits(agent, config, llm, sdk)
    async def run():
        await agent.start_turn(None, 'alice', 'cube', 'model')
        await agent.start_turn(None, 'bob', 'cube', 'model')
        await asyncio.gather(*tasks)
        assert module.current_budget.get() is None
        with pytest.raises(ValueError, match='unavailable'):
            await llm.acompletion(messages=[])
    asyncio.run(run())
    assert budgets[0] is not budgets[1] and len(calls) == 4
    assert all(call['num_retries'] == 0 and call['stream_options']['include_usage'] for call in calls)
    assert all(call['max_completion_tokens'] > 0 for call in calls)


def test_claude_sdk_gets_dollar_cap_and_over_budget_results_fail(monkeypatch):
    module = load_limits(monkeypatch)
    class Result:
        total_cost_usd = 10.01
        subtype = 'success'
    async def receive(client): yield Result()
    sdk = SimpleNamespace(ClaudeAgentOptions=lambda **kwargs: kwargs,
        ClaudeSDKClient=SimpleNamespace(receive_response=receive), ResultMessage=Result)
    module.install_cost_limits(SimpleNamespace(start_turn=lambda: None), None, SimpleNamespace(acompletion=lambda: None), sdk)
    token = module.current_budget.set(generation_budget.GenerationBudget('claude-opus-5-5'))
    try:
        assert sdk.ClaudeAgentOptions(model='claude-opus-5-5', max_budget_usd=100)['max_budget_usd'] == 10
        async def run():
            with pytest.raises(generation_budget.GenerationBudgetExceeded):
                async for event in sdk.ClaudeSDKClient.receive_response(None): pass
        asyncio.run(run())
    finally:
        module.current_budget.reset(token)


def test_nova_settings_connection_test_keeps_non_streaming_with_cost_guard(monkeypatch):
    module = load_limits(monkeypatch)
    calls = []
    async def completion(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(usage={'prompt_tokens': 1000, 'completion_tokens': 16})
    sdk = SimpleNamespace(ClaudeAgentOptions=lambda **kwargs: kwargs,
        ClaudeSDKClient=SimpleNamespace(receive_response=lambda: None))
    llm = SimpleNamespace(acompletion=completion)
    module.install_cost_limits(SimpleNamespace(start_turn=lambda: None), None, llm, sdk)
    asyncio.run(llm.acompletion(model='openai/gpt-5.5', messages=[], max_tokens=16))
    assert calls[0]['max_completion_tokens'] == 16
    assert 'stream_options' not in calls[0]


@pytest.mark.parametrize('cost', [None, float('nan'), -1, 'no-result'])
def test_claude_sdk_cannot_complete_without_valid_cost_usage(monkeypatch, cost):
    module = load_limits(monkeypatch)
    class Result:
        total_cost_usd = cost
        subtype = 'success'
    async def receive(client):
        if cost != 'no-result': yield Result()
    sdk = SimpleNamespace(ClaudeAgentOptions=lambda **kwargs: kwargs,
        ClaudeSDKClient=SimpleNamespace(receive_response=receive), ResultMessage=Result)
    module.install_cost_limits(SimpleNamespace(start_turn=lambda: None), None, SimpleNamespace(acompletion=lambda: None), sdk)
    async def run():
        with pytest.raises(ValueError, match='cost usage'):
            async for event in sdk.ClaudeSDKClient.receive_response(None): pass
    asyncio.run(run())


def test_nova_records_each_generation_turn_separately_in_private_files(monkeypatch, tmp_path):
    import json
    module = load_limits(monkeypatch)
    tasks = []
    async def completion(**kwargs):
        return SimpleNamespace(usage={'prompt_tokens': 100, 'completion_tokens': 20})
    llm = SimpleNamespace(acompletion=completion)
    async def start(*args):
        tasks.append(asyncio.create_task(llm.acompletion(model='openai/gpt-5.5', messages=[])))
    agent = SimpleNamespace(start_turn=start)
    config = SimpleNamespace(get=lambda id: {'litellm_params': {'model': 'openai/gpt-5.5'}})
    sdk = SimpleNamespace(ClaudeAgentOptions=lambda **kwargs: kwargs, ClaudeSDKClient=SimpleNamespace(receive_response=lambda: None))
    module.install_cost_limits(agent, config, llm, sdk)
    store = SimpleNamespace(chat_dir=lambda _: tmp_path)
    async def run():
        for id in ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']:
            context = module.current_usage_id.set(id)
            try: await agent.start_turn(store, 'chat', 'fish', 'model')
            finally: module.current_usage_id.reset(context)
        await asyncio.gather(*tasks)
    asyncio.run(run())
    files = list(tmp_path.glob('.brickbuilder-usage-*.json'))
    assert len(files) == 2
    for file in files:
        report = json.loads(file.read_text())
        assert len(report['calls']) == 1
        assert report['calls'][0]['input_tokens'] == 100
        assert report['calls'][0]['output_tokens'] == 20
        assert Decimal(report['calls'][0]['estimated_cost_usd']) == Decimal('.0011')
        assert report['generation_id'] in file.name
        assert 'fish' not in file.read_text()


@pytest.mark.parametrize('budget_failure', [False, True])
def test_native_claude_usage_includes_cached_tokens(monkeypatch, budget_failure):
    module = load_limits(monkeypatch)
    class Result:
        total_cost_usd = .01
        subtype = 'error_max_budget_usd' if budget_failure else 'success'
        usage = {'input_tokens': 1000, 'output_tokens': 200, 'cache_read_input_tokens': 2000, 'cache_creation_input_tokens': 1000}
    async def receive(client): yield Result()
    sdk = SimpleNamespace(ClaudeAgentOptions=lambda **kwargs: kwargs,
        ClaudeSDKClient=SimpleNamespace(receive_response=receive), ResultMessage=Result)
    module.install_cost_limits(SimpleNamespace(start_turn=lambda: None), None, SimpleNamespace(acompletion=lambda: None), sdk)
    budget = generation_budget.GenerationBudget('claude-opus-5-5')
    context = module.current_budget.set(budget)
    try:
        async def run():
            async for _ in sdk.ClaudeSDKClient.receive_response(None): pass
        if budget_failure:
            with pytest.raises(generation_budget.GenerationBudgetExceeded): asyncio.run(run())
        else: asyncio.run(run())
    finally: module.current_budget.reset(context)
    assert budget.usage_records[0]['input_tokens'] == 4000
    assert budget.usage_records[0]['output_tokens'] == 200
    assert budget.spent == Decimal('.0134')
