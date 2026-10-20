import asyncio
from decimal import Decimal

import httpx
import pytest

from src.utils.generation_budget import GenerationBudget, GenerationBudgetExceeded, GenerationUsage, MODEL_PRICES, input_token_bound
from src.utils.llm_tool_conversation import ConversationSettings, create_conversation, UserInput


@pytest.mark.parametrize('model', MODEL_PRICES)
def test_all_supported_models_allow_exactly_ten_dollars_and_fail_above(model):
    budget = GenerationBudget(model)
    provider = 'anthropic' if model.startswith('claude') else 'openai'
    rate = budget.prices[1]
    output = int(Decimal('10') * 1000000 / rate)
    budget.record_usage({'input_tokens': 0, 'output_tokens': output}, provider)
    assert budget.spent <= 10
    with pytest.raises(GenerationBudgetExceeded):
        budget.record_usage({'input_tokens': 1, 'output_tokens': 1}, provider)


def test_input_reasoning_cache_and_long_context_costs():
    budget = GenerationBudget('gpt-5.6-sol')
    budget.record_usage({'input_tokens': 300000, 'input_tokens_details': {'cached_tokens': 100000},
                         'output_tokens': 10000, 'output_tokens_details': {'reasoning_tokens': 9000}}, 'openai')
    assert budget.spent == Decimal('1.98')
    claude = GenerationBudget('claude-opus-5-5')
    claude.record_usage({'input_tokens': 1000, 'output_tokens': 1000, 'cache_read_input_tokens': 1000,
                         'cache_creation_input_tokens': 2000, 'cache_creation': {'ephemeral_1h_input_tokens': 1000}}, 'anthropic')
    assert claude.spent == Decimal('.0372')


def test_budget_reserves_input_and_limits_output_before_sending():
    budget = GenerationBudget('claude-fable-5')
    budget.spent = Decimal('9')
    assert budget.output_limit(10000, 65536) == 16000
    with pytest.raises(GenerationBudgetExceeded):
        budget.output_limit(50000, 65536)
    assert input_token_bound({'image': {'type': 'input_image', 'image_url': 'data:image/png;base64,' + 'A' * 200000}}) < 35000


@pytest.mark.parametrize('usage', [None, {}, {'input_tokens': -1, 'output_tokens': 2}, {'input_tokens': 1, 'output_tokens': 1, 'input_tokens_details': {'cached_tokens': 3}}])
def test_unknown_or_invalid_usage_fails_closed(usage):
    with pytest.raises(ValueError):
        GenerationBudget('gpt-5.5').record_usage(usage, 'openai')


@pytest.mark.parametrize('stream', [False, True])
@pytest.mark.parametrize('provider,model', [('anthropic', 'claude-opus-5-5'), ('openai', 'gpt-5.6-sol')])
def test_provider_usage_accumulates_across_streamed_and_normal_turns(monkeypatch, provider, model, stream):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'test')
    monkeypatch.setenv('OPENAI_API_KEY', 'test')
    sent = []
    def respond(request):
        payload = __import__('json').loads(request.content)
        sent.append(payload)
        usage = {'input_tokens': 1000, 'output_tokens': 100000}
        result = {'id': 'response', 'output': [], 'content': [], 'usage': usage}
        if stream:
            events = ([{'type': 'message_start', 'message': {'usage': {'input_tokens': 1000}}},
                       {'type': 'message_delta', 'usage': {'output_tokens': 100000}}, {'type': 'message_stop'}]
                      if provider == 'anthropic' else [{'type': 'response.completed', 'response': result}])
            return httpx.Response(200, text=''.join('data: ' + __import__('json').dumps(event) + '\n\n' for event in events))
        return httpx.Response(200, json=result)
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            settings = ConversationSettings(model, 'Build', [], 65536, enforce_cost_limit=True)
            conversation = create_conversation(provider, client, settings, UserInput('castle'))
            async def emit(text): pass
            send = lambda: conversation.send_stream(emit) if stream else conversation.send()
            await send()
            await send()
            assert conversation.budget.spent == Decimal('4.008')
            conversation.budget.spent = Decimal('10')
            with pytest.raises(GenerationBudgetExceeded):
                await send()
            assert len(sent) == 2
    asyncio.run(run())


def test_unknown_model_cannot_silently_bypass_budget():
    with pytest.raises(ValueError, match='unavailable'):
        GenerationBudget('unpriced-model')


def test_astra_costs_and_response_bridge_share_the_generation_budget():
    budget = GenerationBudget('openai/responses/gpt-6-astra')
    budget.record_usage({'input_tokens': 2000, 'input_tokens_details': {'cached_tokens': 1000},
                         'output_tokens': 1000}, 'openai')
    assert budget.spent == Decimal('.061')
    budget.spent = Decimal('9')
    assert budget.output_limit(10000, 65536) == 17500


def test_astra_cache_writes_are_charged_at_the_published_rate():
    budget = GenerationBudget('gpt-6-astra')
    budget.record_usage({'input_tokens': 2000, 'input_tokens_details': {'cached_tokens': 500, 'cache_write_tokens': 1000},
                         'output_tokens': 1000}, 'openai')
    assert budget.spent == Decimal('.068')
    assert budget.usage_records[0]['cache_write_tokens'] == 1000


def test_sol_usage_prices_and_responses_model_normalization():
    budget = GenerationBudget('openai/responses/gpt-6.1-sol')
    budget.record_usage({'input_tokens': 2000,
                         'input_tokens_details': {'cached_tokens': 500, 'cache_write_tokens': 1000},
                         'output_tokens': 1000}, 'openai')
    assert budget.spent == Decimal('.01355')
    assert budget.usage_records[0]['model'] == 'gpt-6.1-sol'
    assert budget.usage_records[0]['cache_read_tokens'] == 500
    assert budget.usage_records[0]['cache_write_tokens'] == 1000


@pytest.mark.parametrize('inputs,multiplier', [(98000, 1), (98001, 5)])
def test_haiku_context_price_includes_cached_and_written_tokens(inputs, multiplier):
    budget = GenerationBudget('anthropic/claude-haiku-5-5')
    budget.record_usage({'input_tokens': inputs, 'output_tokens': 1000,
        'cache_read_input_tokens': 1000, 'cache_creation_input_tokens': 1000,
        'cache_creation': {'ephemeral_1h_input_tokens': 500}}, 'anthropic')
    expected = (Decimal(inputs) * Decimal('.1') + Decimal('10') + Decimal('62.5')
                + Decimal('100') + Decimal('500')) * multiplier / 1000000
    assert budget.spent == expected
    assert budget.usage_records[0]['input_tokens'] == inputs + 2000


def test_haiku_output_budget_reserves_the_long_context_rate():
    budget = GenerationBudget('claude-haiku-5-5')
    budget.spent = Decimal('9.8')
    assert budget.output_limit(100000, 128000) == 128000
    assert budget.output_limit(100001, 128000) == 39999


def test_opus_fast_mode_prices_cache_and_reserves_double_cost():
    budget = GenerationBudget('claude-opus-5-5')
    budget.record_usage({'input_tokens': 1000, 'output_tokens': 1000,
        'cache_read_input_tokens': 1000, 'cache_creation_input_tokens': 2000,
        'cache_creation': {'ephemeral_1h_input_tokens': 1000}, 'speed': 'fast'}, 'anthropic')
    assert budget.spent == Decimal('.0744')
    assert budget.usage_records[0]['speed'] == 'fast'
    budget.spent = Decimal('9')
    assert budget.output_limit(10000, 65536, speed='fast') == 21000
    assert budget.output_limit(10000, 65536) == 46000
    with pytest.raises(ValueError, match='model speed'):
        GenerationBudget('claude-sonnet-5').output_limit(100, 100, speed='fast')


def test_generation_ledger_preserves_fast_mode():
    ledger = GenerationUsage('test')
    budget = GenerationBudget('claude-opus-5-5')
    budget.record_usage({'input_tokens': 100, 'output_tokens': 10, 'speed': 'fast'}, 'anthropic')
    ledger.extend(budget.usage_records)
    assert ledger.values()['ai_usage']['calls'][0]['speed'] == 'fast'
