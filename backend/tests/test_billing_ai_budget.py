import asyncio
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi import HTTPException

from src.utils import billing, billing_ai_budget as budget
from src.utils.generation_budget import GenerationUsage, current_generation_usage
from src.utils.llm_tool_conversation import post_json

PAYLOAD={'model':'gpt-5.6-sol','max_output_tokens':256,'input':'hello'}


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv('API_MODE','production')
    monkeypatch.setattr(billing,'settings',AsyncMock(return_value={'enabled':True}))
    rpc=AsyncMock(return_value=True)
    monkeypatch.setattr(billing,'rpc',rpc)
    return rpc


def test_auxiliary_request_reserves_before_provider_and_settles_reported_cost(enabled):
    async def call(*args,**kwargs):
        assert enabled.await_count==1
        return SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'usage':{'input_tokens':100,'output_tokens':10}})
    client=SimpleNamespace(post=AsyncMock(side_effect=call))
    asyncio.run(post_json(client,'https://provider.test',{},PAYLOAD,'OpenAI'))
    assert enabled.await_args_list[0].args==('billing_reserve_ai',)
    assert enabled.await_args_list[1].args==('billing_settle_ai',)
    assert Decimal(enabled.await_args_list[1].kwargs['p_amount'])==Decimal('.0006')


def test_storage_failure_stops_before_any_provider_request(enabled):
    enabled.side_effect=RuntimeError('database down')
    client=SimpleNamespace(post=AsyncMock())
    with pytest.raises(HTTPException) as error:
        asyncio.run(post_json(client,'https://provider.test',{},PAYLOAD,'OpenAI'))
    assert error.value.status_code==503
    client.post.assert_not_called()


def test_timeout_and_missing_usage_keep_the_full_reservation(enabled):
    client=SimpleNamespace(post=AsyncMock(side_effect=httpx.ReadTimeout('timeout')))
    with pytest.raises(HTTPException): asyncio.run(post_json(client,'https://provider.test',{},PAYLOAD,'OpenAI'))
    assert enabled.await_count==1
    asyncio.run(budget.settle('held',PAYLOAD,{},'OpenAI'))
    assert enabled.await_count==1


def test_estimate_rejects_unbounded_output_tools_and_unknown_models():
    for payload in ({'model':'unknown','max_tokens':10}, {'model':'gpt-5.6-sol'}, {**PAYLOAD,'tools':[{}]}):
        with pytest.raises(ValueError): budget.upper_bound(payload)
    assert budget.upper_bound(PAYLOAD)>Decimal('.0006')


def test_disabled_and_local_requests_do_not_consume_live_budget(enabled,monkeypatch):
    monkeypatch.setenv('API_MODE','local')
    assert asyncio.run(budget.reserve(PAYLOAD)) is None
    enabled.assert_not_called()
    monkeypatch.setenv('API_MODE','production')
    monkeypatch.setattr(billing,'settings',AsyncMock(return_value={'enabled':False}))
    assert asyncio.run(budget.reserve(PAYLOAD)) is None
    enabled.assert_not_called()


def test_settlement_does_not_duplicate_generation_usage(enabled):
    usage=GenerationUsage('generation')
    token=current_generation_usage.set(usage)
    try:
        asyncio.run(budget.settle('auxiliary',PAYLOAD,{'usage':{'input_tokens':100,'output_tokens':10}},'OpenAI'))
        assert usage.calls==[]
    finally: current_generation_usage.reset(token)
