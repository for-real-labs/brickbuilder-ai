from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from src.utils import verified_signup_analytics as module


def user(id='account', provider='email', confirmed=True, anonymous=False):
    return SimpleNamespace(id=id, app_metadata={'provider': provider}, is_anonymous=anonymous,
                           email_confirmed_at=datetime(2026, 10, 1, tzinfo=timezone.utc) if confirmed else None)


def client_for(pages):
    return SimpleNamespace(auth=SimpleNamespace(admin=SimpleNamespace(list_users=Mock(side_effect=pages))))


def test_verified_email_only_and_no_private_data():
    analytics = Mock(); analytics.capture.return_value = 'accepted'
    client = client_for([[user(), user('pending', confirmed=False), user('google', provider='google'), user('anon', anonymous=True)]])
    assert module.sync_verified_signups(client, analytics, set()) == 1
    args, kwargs = analytics.capture.call_args
    assert args == ('verified_email_signup',)
    assert kwargs['distinct_id'] == 'account'
    assert kwargs['timestamp'] == datetime(2026, 10, 1, tzinfo=timezone.utc)
    assert kwargs['properties'] == {'service': 'brickai-api', 'environment': 'production', 'signup_method': 'email', 'metric_version': 1, '$geoip_disable': True}


def test_pagination_and_reconciliation_retry_dedupe(monkeypatch):
    monkeypatch.setattr(module, 'PAGE_SIZE', 2)
    analytics = Mock(); analytics.capture.return_value = 'accepted'
    delivered = set()
    assert module.sync_verified_signups(client_for([[user('a'),user('b')],[user('c')]]), analytics, delivered) == 3
    first_uuid = analytics.capture.call_args_list[0].kwargs['uuid']
    assert module.sync_verified_signups(client_for([[user('a')]]), analytics, delivered) == 0
    assert module.sync_verified_signups(client_for([[user('a')]]), analytics, set()) == 1
    assert analytics.capture.call_args.kwargs['uuid'] == first_uuid


def test_failed_delivery_is_retried():
    analytics = Mock(); analytics.capture.return_value = None
    delivered = set()
    with pytest.raises(RuntimeError):
        module.sync_verified_signups(client_for([[user()]]), analytics, delivered)
    assert delivered == set()
    analytics.capture.return_value = 'accepted'
    assert module.sync_verified_signups(client_for([[user()]]), analytics, delivered) == 1


@pytest.mark.parametrize('environment', ['', 'staging', 'pr-290'])
def test_worker_never_sends_preview_or_local_data_as_production(monkeypatch, environment):
    monkeypatch.setenv('RAILWAY_ENVIRONMENT_NAME', environment)
    monkeypatch.setenv('POSTHOG_API_KEY', 'test')
    assert module.start_verified_signup_worker(Mock()) is None
