from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from src import api
from src.utils import auth

GUEST = {'authenticated': False, 'is_anonymous': True, 'user_id': 'guest_test',
         'user_email': 'anonymous', 'rate_limit': {'limit': 1000, 'calls_made': 0, 'remaining': 1000}}


@pytest.mark.parametrize('path,payload', [
    ('/textToBricks', {'prompt': 'A little castle'}),
    ('/textToBricks', {'prompt': 'A little castle', 'stream': True}),
    ('/imageToBricks', {'image_base64': 'aW1hZ2U='}),
    ('/imageToBricks', {'image_base64': 'aW1hZ2U=', 'stream': True}),
    ('/llmToBricks', {'prompt': 'A little castle'}),
    ('/llmToBricks/stream', {'prompt': 'A little castle'}),
    ('/novaToBricks', {'prompt': 'A little castle'}),
])
def test_hosted_generation_requires_signup_even_with_a_guest_session(monkeypatch, path, payload):
    monkeypatch.setattr(auth, 'LOCAL_DB_ENABLED', False)
    api.app.dependency_overrides[auth.get_user_with_optional_auth] = lambda: GUEST
    try:
        response = TestClient(api.app).post(path, json=payload)
        assert response.status_code == 401, response.text
        assert 'Sign up to claim your free credits' in response.json()['detail']
    finally:
        api.app.dependency_overrides.clear()


def test_account_generation_leaves_credit_admission_to_the_existing_wallet(monkeypatch):
    monkeypatch.setattr(auth, 'LOCAL_DB_ENABLED', False)
    database = Mock()
    monkeypatch.setattr(auth, 'supabase_client', database)
    account = {'authenticated': True, 'is_anonymous': False, 'user_email': 'builder@example.test'}
    assert not auth.handle_auth_and_tracking(account, '/llmToBricks', {}, 1)['is_anonymous']
    database.table.assert_not_called()


def test_guest_free_tools_and_offline_local_generation_remain_available(monkeypatch):
    monkeypatch.setattr(auth, 'LOCAL_DB_ENABLED', False)
    assert auth.handle_auth_and_tracking(GUEST, '/uploadLdraw', {}, 0)['is_anonymous']
    monkeypatch.setattr(auth, 'LOCAL_DB_ENABLED', True)
    assert auth.handle_auth_and_tracking(GUEST, '/novaToBricks', {}, 1)['is_anonymous']


def test_developer_access_and_anonymous_supabase_identity(monkeypatch):
    monkeypatch.setattr(auth, 'LOCAL_DB_ENABLED', False)
    developer = {'authenticated': True, 'is_developer': True, 'is_anonymous': False}
    assert auth.handle_auth_and_tracking(developer, '/novaToBricks', {}, 1)['is_developer']
    with pytest.raises(HTTPException) as error:
        auth.handle_auth_and_tracking({**GUEST, 'authenticated': True}, '/llmToBricks', {}, 1)
    assert error.value.status_code == 401
