import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from src.requests import supportEmail as support


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv('RESEND_API_KEY', 'test-only')
    monkeypatch.setenv('GENERATION_NOTIFICATION_FROM', 'BrickBuilder <no-reply@example.com>')
    monkeypatch.setenv('GENERATION_NOTIFICATION_ORIGIN', 'https://brickbuilder.ai')
    monkeypatch.delenv('SUPPORT_EMAIL_FROM', raising=False)


def request(**changes):
    return support.SupportEmailRequest(**{'email': 'reply@example.com', 'message': ' My model is missing. ', 'request_id': uuid4(), **changes})


def generation(owner='owner', **changes):
    return {'id': str(uuid4()), 'user_id': owner, 'user_type': 'authenticated', 'name': 'Castle', 'status': 'completed', **changes}


@pytest.mark.parametrize('authenticated', [True, False])
def test_sends_current_model_and_verified_identity_to_support(monkeypatch, configured, authenticated):
    row = generation(user_type='authenticated' if authenticated else 'anonymous')
    storage = SimpleNamespace(get_generation=AsyncMock(return_value=row), get_user_generations=AsyncMock())
    monkeypatch.setattr(support, 'generation_storage', storage)
    identity = {'user_id': 'owner', 'authenticated': authenticated}
    sent = []
    def respond(http_request):
        sent.append(http_request)
        return httpx.Response(200, json={'id': 'mail-id'})
    message = request(generation_id=row['id'])
    for _ in range(2):
        assert asyncio.run(support.send_support_email(message, identity, httpx.MockTransport(respond))) == {'sent': True}
    payload = json.loads(sent[0].content)
    assert payload['to'] == ['support@brickbuilder.ai']
    assert payload['reply_to'] == 'reply@example.com'
    assert payload['from'] == 'BrickBuilder <no-reply@example.com>'
    assert 'User ID: owner' in payload['text']
    assert f'https://brickbuilder.ai/?id={row["id"]}&exact=1' in payload['text']
    assert 'My model is missing.' in payload['text']
    assert sent[0].headers['Idempotency-Key'] == sent[1].headers['Idempotency-Key']
    storage.get_user_generations.assert_not_called()


@pytest.mark.parametrize('authenticated', [True, False])
def test_uses_last_three_owned_generations_without_current_model(monkeypatch, authenticated):
    rows = [generation(user_type='authenticated' if authenticated else 'anonymous') for _ in range(3)]
    storage = SimpleNamespace(get_generation=AsyncMock(), get_user_generations=AsyncMock(return_value=rows))
    monkeypatch.setattr(support, 'generation_storage', storage)
    result = asyncio.run(support.support_generations(request(), {'user_id': 'owner', 'authenticated': authenticated}))
    assert result == rows
    storage.get_user_generations.assert_awaited_once_with(user_id='owner', user_type='authenticated' if authenticated else 'anonymous', limit=3, include_details=False)
    storage.get_generation.assert_not_called()


@pytest.mark.parametrize('current', [None, generation(owner='someone-else'), RuntimeError('database credentials')])
def test_missing_inaccessible_or_failed_current_lookup_falls_back_to_owned_models(monkeypatch, current):
    rows = [generation()]
    storage = SimpleNamespace(get_generation=AsyncMock(side_effect=current) if isinstance(current, Exception) else AsyncMock(return_value=current),
                              get_user_generations=AsyncMock(return_value=rows))
    monkeypatch.setattr(support, 'generation_storage', storage)
    assert asyncio.run(support.support_generations(request(generation_id=uuid4()), {'user_id': 'owner', 'authenticated': True})) == rows


def test_can_include_the_public_community_model_being_viewed(monkeypatch):
    row = generation(owner='other', is_community=True)
    monkeypatch.setattr(support, 'generation_storage', SimpleNamespace(get_generation=AsyncMock(return_value=row)))
    assert asyncio.run(support.support_generations(request(generation_id=row['id']), {'user_id': 'owner'})) == [row]


def test_storage_failure_does_not_block_the_support_message(monkeypatch, configured):
    monkeypatch.setattr(support, 'generation_storage', SimpleNamespace(get_user_generations=AsyncMock(side_effect=RuntimeError('secret'))))
    seen = []
    def respond(r):
        seen.append(json.loads(r.content))
        return httpx.Response(200, json={'id': 'sent'})
    assert asyncio.run(support.send_support_email(request(), {'user_id': 'owner'}, httpx.MockTransport(respond))) == {'sent': True}
    assert 'Generations: None available' in seen[0]['text']
    assert 'User ID: owner' in seen[0]['text']
    assert 'secret' not in seen[0]['text']


@pytest.mark.parametrize('status,body', [(429, {'message': 'private provider failure'}), (500, {}), (200, {}), (200, [])])
def test_provider_failures_never_report_success(monkeypatch, configured, status, body):
    monkeypatch.setattr(support, 'generation_storage', None)
    with pytest.raises(HTTPException) as error:
        asyncio.run(support.send_support_email(request(), {}, httpx.MockTransport(lambda _: httpx.Response(status, json=body))))
    assert error.value.status_code == 503
    assert error.value.detail == support.SEND_ERROR


def test_network_timeout_and_missing_configuration_are_recoverable(monkeypatch, configured):
    monkeypatch.setattr(support, 'generation_storage', None)
    def timeout(_):
        raise httpx.ReadTimeout('private network details')
    with pytest.raises(HTTPException, match='Could not send'):
        asyncio.run(support.send_support_email(request(), {}, httpx.MockTransport(timeout)))
    monkeypatch.delenv('RESEND_API_KEY')
    with pytest.raises(HTTPException) as error:
        asyncio.run(support.send_support_email(request(), {}))
    assert error.value.status_code == 503


@pytest.mark.parametrize('changes', [{'email': 'not-email'}, {'email': 'bad\r\nBcc: other@example.com'}, {'message': ' '}, {'message': 'x' * 5001}, {'generation_id': 'invalid'}, {'user_id': 'forged'}, {'to': ['attacker@example.com']}])
def test_validates_input_and_rejects_client_supplied_identity_or_recipient(changes):
    with pytest.raises(ValidationError):
        request(**changes)


def test_endpoint_uses_server_identity_and_applies_rate_limits(monkeypatch):
    app = FastAPI()
    app.include_router(support.router)
    identity = {'user_id': 'verified-owner', 'authenticated': True}
    app.dependency_overrides[support.get_optional_identity] = lambda: identity
    deliver = AsyncMock(return_value={'sent': True})
    monkeypatch.setattr(support, 'send_support_email', deliver)
    keys = []
    monkeypatch.setattr(support, 'check_anonymous_short_window_limit', lambda key: keys.append(key))
    with TestClient(app) as client:
        payload = request().model_dump(mode='json')
        assert client.post('/support-email', json=payload).json() == {'sent': True}
        assert deliver.call_args.args[1] == identity
        assert keys[0].startswith('support-ip:')
        assert keys[1] == 'support-user:verified-owner'
        def limited(_):
            raise HTTPException(429, 'Wait')
        monkeypatch.setattr(support, 'check_anonymous_short_window_limit', limited)
        assert client.post('/support-email', json=payload).status_code == 429
        assert deliver.await_count == 1
