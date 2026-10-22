import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from src.utils import request_limit_analytics as analytics
from src.utils.generation_storage import GenerationStorage


@pytest.fixture(autouse=True)
def isolated_client(monkeypatch):
    analytics._client.cache_clear()
    monkeypatch.delenv('POSTHOG_API_KEY', raising=False)
    yield
    analytics._client.cache_clear()


@pytest.mark.parametrize('code,kind,value,status', [
    ('BB_GENERATION_DAILY_LIMIT', 'daily', 30, 429),
    ('BB_GENERATION_DAILY_LIMIT:5', 'daily', 5, 429),
    ('BB_GENERATION_GUEST_LIMIT', 'guest_lifetime', 3, 403),
    ('BB_GENERATION_CONCURRENCY_LIMIT', 'concurrent', 1, 429),
])
def test_rejected_admission_emits_once_without_private_payload(monkeypatch, code, kind, value, status):
    client = Mock()
    monkeypatch.setattr(analytics, 'Posthog', Mock(return_value=client))
    monkeypatch.setenv('POSTHOG_API_KEY', 'test-project-key')
    monkeypatch.setenv('RAILWAY_ENVIRONMENT_NAME', 'production')
    table = Mock()
    table.insert.return_value = table
    table.execute.side_effect = ValueError(code)
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = SimpleNamespace(table=lambda _: table)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(storage.create_generation('guest_opaque', 'anonymous', 'private prompt', 40,
                                              endpoint='novaToBricks', guest_ip_hash='private-network-hash'))
    assert exc.value.status_code == status
    if kind == 'daily':
        assert f'limit of {value} generations' in exc.value.detail
    client.capture.assert_called_once_with(distinct_id='guest_opaque', event='request_limit_hit', properties={
        'service': 'brickai-api', 'environment': 'production', 'limit_type': kind,
        'limit_value': value, 'http_status': status, 'user_type': 'anonymous',
        'endpoint': 'novaToBricks', 'metric_version': 1, '$geoip_disable': True,
    })


@pytest.mark.parametrize('error', ['other database failure', 'BB_GENERATION_GUEST_IP_REQUIRED'])
def test_unrelated_failures_are_not_limit_hits(monkeypatch, error):
    constructor = Mock()
    monkeypatch.setattr(analytics, 'Posthog', constructor)
    analytics.track_request_limit(ValueError(error), user_id='u', user_type='authenticated', endpoint='novaToBricks')
    constructor.assert_not_called()


def test_missing_key_and_analytics_outages_do_not_change_admission_error(monkeypatch):
    analytics.track_request_limit(ValueError('BB_GENERATION_DAILY_LIMIT'), user_id='u', user_type='authenticated', endpoint='novaToBricks')
    analytics._client.cache_clear()
    monkeypatch.setenv('POSTHOG_API_KEY', 'test-project-key')
    monkeypatch.setattr(analytics, 'Posthog', Mock(side_effect=RuntimeError('unavailable')))
    table = Mock(); table.insert.return_value = table
    table.execute.side_effect = ValueError('BB_GENERATION_DAILY_LIMIT')
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = SimpleNamespace(table=lambda _: table)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(storage.create_generation('u', 'authenticated', 'cube', 40))
    assert exc.value.status_code == 429
    assert 'Retry-After' in exc.value.headers


def test_client_is_reused_and_flushed(monkeypatch):
    client = Mock(); constructor = Mock(return_value=client)
    monkeypatch.setattr(analytics, 'Posthog', constructor)
    monkeypatch.setenv('POSTHOG_API_KEY', 'test-project-key')
    for _ in range(2):
        analytics.track_request_limit(ValueError('BB_GENERATION_DAILY_LIMIT'), user_id='u', user_type='authenticated', endpoint='novaToBricks')
    assert constructor.call_count == 1
    assert client.capture.call_count == 2
    analytics.shutdown_request_limit_analytics()
    client.shutdown.assert_called_once()
