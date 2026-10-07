import asyncio
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pgserver
import psycopg
import pytest

from src.utils import generation_storage, generation_tasks
from src.utils.generation_budget import GenerationBudget, GenerationUsage, current_generation_usage
from src.utils.generation_storage import GenerationStorage


def test_usage_combines_models_cache_and_reasoning_without_double_counting():
    ledger = GenerationUsage('job')
    token = current_generation_usage.set(ledger)
    try:
        GenerationBudget('claude-opus-5-5').record_usage({
            'input_tokens': 1000, 'output_tokens': 1000, 'cache_read_input_tokens': 1000,
            'cache_creation_input_tokens': 2000, 'cache_creation': {'ephemeral_1h_input_tokens': 1000},
        }, 'anthropic')
        GenerationBudget('gpt-5.6-sol').record_usage({
            'input_tokens': 300000, 'output_tokens': 10000,
            'input_tokens_details': {'cached_tokens': 100000},
            'output_tokens_details': {'reasoning_tokens': 9000},
        }, 'openai')
    finally:
        current_generation_usage.reset(token)
    values = ledger.values()
    assert values['input_tokens'] == 304000
    assert values['output_tokens'] == 11000
    assert values['tokens_used'] == 315000
    assert Decimal(values['estimated_cost_usd']) == Decimal('2.0172')
    assert values['ai_usage']['scope'] == 'reported_llm_usage'
    assert len(values['ai_usage']['calls']) == 2


@pytest.mark.parametrize('outcome', ['completed', 'failed', 'cancelled'])
def test_background_job_saves_its_usage_even_on_failure_or_cancellation(monkeypatch, outcome):
    store = SimpleNamespace(get_generation=AsyncMock(return_value={'status': 'processing'}),
                            save_generation_usage=AsyncMock())
    monkeypatch.setattr(generation_storage, 'generation_storage', store)
    async def work():
        GenerationBudget('gpt-5.5').record_usage({'input_tokens': 1000, 'output_tokens': 100}, 'openai')
        if outcome == 'failed':
            raise ValueError('No model published')
        if outcome == 'cancelled':
            raise asyncio.CancelledError
    async def run():
        result = await asyncio.gather(generation_tasks.start_generation_task('job', work()), return_exceptions=True)
        if outcome == 'failed': assert isinstance(result[0], ValueError)
        if outcome == 'cancelled': assert isinstance(result[0], asyncio.CancelledError)
        assert current_generation_usage.get() is None
    asyncio.run(run())
    store.save_generation_usage.assert_awaited_once()
    job, values = store.save_generation_usage.await_args.args
    assert job == 'job' and values['tokens_used'] == 1100
    assert Decimal(values['estimated_cost_usd']) == Decimal('.008')
    assert 'status' not in values


def test_simultaneous_jobs_do_not_share_usage_and_unreported_jobs_stay_unknown(monkeypatch):
    store = SimpleNamespace(get_generation=AsyncMock(return_value={}), save_generation_usage=AsyncMock())
    monkeypatch.setattr(generation_storage, 'generation_storage', store)
    async def work(count):
        await asyncio.sleep(0)
        if count:
            GenerationBudget('gpt-5.5').record_usage({'input_tokens': count, 'output_tokens': count}, 'openai')
    async def run():
        await asyncio.gather(*(generation_tasks.start_generation_task(id, work(count))
                              for id, count in [('alice', 10), ('bob', 20), ('unknown', 0)]))
    asyncio.run(run())
    assert {call.args[0]: call.args[1]['tokens_used'] for call in store.save_generation_usage.await_args_list} == {'alice': 20, 'bob': 40}


def test_storage_persists_usage_on_only_the_requested_row():
    calls = []
    class Query:
        def update(self, values): calls.append(('update', values)); return self
        def eq(self, key, value): calls.append(('eq', key, value)); return self
        def execute(self): return None
    store = GenerationStorage.__new__(GenerationStorage)
    store.client = SimpleNamespace(table=lambda name: Query())
    asyncio.run(store.save_generation_usage('job', {'tokens_used': 120}))
    assert calls == [('update', {'tokens_used': 120}), ('eq', 'id', 'job')]


@pytest.mark.parametrize('invalid', [float('nan'), float('inf'), -1])
def test_invalid_runtime_cost_is_rejected_without_partially_adding_calls(invalid):
    ledger = GenerationUsage('job')
    valid = {'model': 'gpt-5.5', 'input_tokens': 1, 'output_tokens': 1, 'estimated_cost_usd': '.0001'}
    with pytest.raises(ValueError):
        ledger.extend([valid, {**valid, 'estimated_cost_usd': invalid}])
    assert ledger.calls == []


def test_migration_preserves_unknown_history_and_enforces_valid_values(tmp_path):
    server = pgserver.get_server(tmp_path / 'usage-postgres')
    try:
        with psycopg.connect(server.get_uri(), autocommit=True) as connection:
            connection.execute('create table public.generations(id text primary key)')
            connection.execute("insert into public.generations values ('historical')")
            migration = (Path(__file__).parents[2] / 'supabase/migrations/20261007000001_generation_usage_and_edit_prompt.sql').read_text()
            connection.execute(migration)
            connection.execute(migration)
            assert connection.execute('select tokens_used, estimated_cost_usd, example_edit_prompt from public.generations').fetchone() == (None, None, None)
            for column, value in [('input_tokens', '-1'), ('output_tokens', '-1'), ('tokens_used', '-1'),
                                  ('estimated_cost_usd', "'NaN'"), ('estimated_cost_usd', "'Infinity'"),
                                  ('estimated_cost_usd', '-.001'), ('example_edit_prompt', "''"),
                                  ('example_edit_prompt', "repeat('x',201)")]:
                with pytest.raises((psycopg.errors.CheckViolation, psycopg.errors.NumericValueOutOfRange)):
                    connection.execute(f'update public.generations set {column}={value}')
            connection.execute("update public.generations set input_tokens=10,output_tokens=2,tokens_used=12,estimated_cost_usd=.00012,example_edit_prompt='Make the fins blue'")
    finally:
        server.cleanup()
