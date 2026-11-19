import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import jwt
import pytest
from cryptography.fernet import Fernet
from fastapi import HTTPException

from src.utils import apple_sign_in

USER_ID = '00000000-0000-4000-8000-000000000001'
CLIENT_ID = 'ai.brickbuilder.app'
USER = SimpleNamespace(id=USER_ID, identities=[
    SimpleNamespace(provider='apple', identity_data={'sub': 'apple-user'}),
])


@pytest.fixture
def apple(monkeypatch):
    key = Fernet.generate_key()
    monkeypatch.setenv('APPLE_SIGN_IN_ENCRYPTION_KEY', key.decode())
    monkeypatch.setenv('APPLE_SIGN_IN_CLIENT_ID', CLIENT_ID)
    monkeypatch.setenv('APPLE_SIGN_IN_CLIENT_SECRET', 'test-secret')
    context = AsyncMock()
    client = context.__aenter__.return_value
    monkeypatch.setattr(apple_sign_in.httpx, 'AsyncClient', Mock(return_value=context))
    execute = AsyncMock()
    monkeypatch.setattr(apple_sign_in, 'execute_query', execute)
    return client, execute, Fernet(key)


def reply(subject):
    response = Mock()
    response.json.return_value = {
        'id_token': jwt.encode({'iss': apple_sign_in.APPLE_ISSUER, 'aud': CLIENT_ID, 'sub': subject},
                               'test-key-long-enough-for-this-test'),
        'refresh_token': 'apple-refresh-token',
    }
    return response


def test_binds_and_encrypts_apple_token_for_account_deletion(apple):
    client, execute, cipher = apple
    client.post.return_value = reply('apple-user')
    db = Mock()
    asyncio.run(apple_sign_in.save_for_deletion(db, USER, 'one-time-code'))
    record = db.table.return_value.upsert.call_args.args[0]
    assert record['user_id'] == USER_ID
    assert 'apple-refresh-token' not in record['encrypted_refresh_token']
    assert cipher.decrypt(record['encrypted_refresh_token'].encode()).decode() == USER_ID + ':apple-refresh-token'
    client.post.assert_awaited_with('https://appleid.apple.com/auth/token', data={
        'client_id': CLIENT_ID, 'client_secret': 'test-secret',
        'grant_type': 'authorization_code', 'code': 'one-time-code',
    })
    execute.return_value = SimpleNamespace(data=[record])
    asyncio.run(apple_sign_in.revoke_before_deletion(db, USER))
    client.post.assert_awaited_with('https://appleid.apple.com/auth/revoke', data={
        'client_id': CLIENT_ID, 'client_secret': 'test-secret', 'token_type_hint': 'refresh_token',
        'token': 'apple-refresh-token',
    })


def test_discards_an_apple_code_from_a_different_account(apple):
    client, execute, _ = apple
    client.post.return_value = reply('someone-else')
    with pytest.raises(HTTPException) as error:
        asyncio.run(apple_sign_in.save_for_deletion(Mock(), USER, 'wrong-code'))
    assert error.value.status_code == 403
    execute.assert_not_awaited()


def test_non_apple_account_deletion_needs_no_apple_configuration(apple):
    client, execute, _ = apple
    asyncio.run(apple_sign_in.revoke_before_deletion(Mock(), SimpleNamespace(id=USER_ID)))
    execute.assert_not_awaited()
    client.post.assert_not_awaited()
