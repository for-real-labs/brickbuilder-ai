import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from src import api
from src.utils import auth, llm_output
from src.requests import getGeneration, getUserGenerations, claimGeneration, getGenerationsByImage


def request(secret=None):
    headers = [(b'user-agent', b'Mozilla/5.0')]
    if secret is not None:
        headers.append((b'x-guest-session', secret.encode()))
    return Request({'type': 'http', 'headers': headers, 'client': ('192.0.2.1', 1234)})


def identity(secret):
    return asyncio.run(auth.get_optional_identity(request(secret), None, None))


def test_guests_on_same_ip_are_distinct_and_secrets_are_not_owner_ids():
    first, second = identity('a' * 64), identity('b' * 64)
    assert first['user_id'] != second['user_id']
    assert first['user_id'] == identity('a' * 64)['user_id']
    assert first['user_id'] != 'a' * 64
    assert identity(None)['user_id'] is None
    with pytest.raises(HTTPException):
        identity('Mozilla/5.0')


def test_rate_limits_still_share_ip_and_usage_uses_rate_identity(monkeypatch):
    check = AsyncMock(return_value={'limit_exceeded': False})
    increment = AsyncMock()
    monkeypatch.setattr(auth, 'check_anonymous_rate_limit', check)
    monkeypatch.setattr(auth, 'increment_anonymous_calls', increment)
    monkeypatch.setattr(auth, 'check_anonymous_short_window_limit', Mock(return_value={}))
    first = asyncio.run(auth.verify_authentication_optional(request('a' * 64), identity('a' * 64)))
    second = asyncio.run(auth.verify_authentication_optional(request('b' * 64), identity('b' * 64)))
    assert first['rate_limit_id'] == second['rate_limit_id']
    assert first['user_id'] != first['rate_limit_id']
    asyncio.run(auth.increment_anonymous_usage_after_fal_success(first))
    increment.assert_awaited_once_with(first['rate_limit_id'])
    with pytest.raises(HTTPException):
        asyncio.run(auth.verify_authentication_optional(request(), identity(None)))


def test_guest_list_only_queries_own_identity(monkeypatch):
    storage = SimpleNamespace(count_user_generations=AsyncMock(return_value=0), get_user_generations=AsyncMock(return_value=[]))
    monkeypatch.setattr(getUserGenerations, 'generation_storage', storage)
    for secret in ['a' * 64, 'b' * 64]:
        asyncio.run(getUserGenerations.get_user_generations(getUserGenerations.GetUserGenerationsRequest(processing=True), identity(secret)))
        assert storage.get_user_generations.await_args.kwargs['user_id'] == identity(secret)['user_id']
    with pytest.raises(HTTPException):
        asyncio.run(getUserGenerations.get_user_generations(getUserGenerations.GetUserGenerationsRequest(), identity(None)))


@pytest.mark.parametrize('owner_type', ['anonymous', 'authenticated'])
def test_http_status_and_thinking_require_owner_including_known_ids(monkeypatch, owner_type):
    job_id = str(UUID('7c1326b2-890a-4fb8-9750-d3aa15cdc8e4'))
    owner = identity('a' * 64) if owner_type == 'anonymous' else {'authenticated': True, 'user_id': 'account-owner'}
    row = {'id': job_id, 'user_id': owner['user_id'], 'user_type': owner_type, 'status': 'processing', 'prompt': 'Private prompt'}
    storage = SimpleNamespace(get_generation=AsyncMock(return_value=row))
    monkeypatch.setattr(api, 'generation_storage', storage)
    monkeypatch.setattr(getGeneration, 'generation_storage', storage)
    async def events(*args):
        yield 'data: {"text":"Private thinking"}\n\n'
    output = Mock(side_effect=events)
    monkeypatch.setattr(api, 'output_events', output)
    client = TestClient(api.app)
    for caller in [identity(None), identity('b' * 64), {'authenticated': True, 'user_id': 'other-account'}]:
        api.app.dependency_overrides[auth.get_optional_identity] = lambda: caller
        try:
            assert client.get(f'/generation/{job_id}').status_code == 404
            assert client.post('/getGeneration', json={'generation_id': job_id}).status_code == 404
            assert client.get(f'/generation/{job_id}/output').status_code == 404
        finally:
            api.app.dependency_overrides.clear()
    output.assert_not_called()
    api.app.dependency_overrides[auth.get_optional_identity] = lambda: owner
    try:
        response = client.get(f'/generation/{job_id}')
        assert response.json()['prompt'] == 'Private prompt'
        assert response.headers['cache-control'] == 'private, no-store'
        assert 'Private thinking' in client.get(f'/generation/{job_id}/output').text
    finally:
        api.app.dependency_overrides.clear()
    row.update(status='completed', is_community=True)
    assert client.get(f'/generation/{job_id}').status_code == 200
    assert client.get(f'/generation/{job_id}/output').status_code == 404


def test_existing_stream_stops_when_guest_job_is_claimed(monkeypatch):
    guest = identity('a' * 64)
    row = {'user_id': guest['user_id'], 'user_type': 'anonymous', 'status': 'processing'}
    monkeypatch.setattr(llm_output, 'generation_storage', SimpleNamespace(get_generation=AsyncMock(return_value=row)))
    read = AsyncMock(return_value={'text': 'first'})
    monkeypatch.setattr(llm_output, 'read_output', read)
    async def run():
        stream = llm_output.output_events('job', guest)
        await anext(stream)
        row.update(user_id='new-account', user_type='authenticated')
        with pytest.raises(HTTPException):
            await anext(stream)
        assert read.await_count == 1
    asyncio.run(run())


@pytest.mark.parametrize('owner_type,owner_id', [
    ('anonymous', 'legacy-fingerprint'),
    ('anonymous', 'guest_' + 'a' * 64),
    ('authenticated', 'account-owner'),
])
def test_completed_model_links_are_public_but_reasoning_and_ownership_stay_private(
    monkeypatch, owner_type, owner_id,
):
    from src.utils import authorization

    job_id = '7c1326b2-890a-4fb8-9750-d3aa15cdc8e4'
    row = {
        'id': job_id, 'user_id': owner_id, 'user_type': owner_type,
        'status': 'completed', 'is_community': False, 'prompt': 'A little dinosaur',
        'ldr_url': 'https://storage.example.test/model.ldr',
    }
    ldr = b'0 Dinosaur\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n'
    storage = SimpleNamespace(
        get_generation=AsyncMock(return_value=row),
        download_file_from_storage=AsyncMock(return_value=ldr),
    )
    monkeypatch.setattr(api, 'generation_storage', storage)
    monkeypatch.setattr(getGeneration, 'generation_storage', storage)
    monkeypatch.setattr(authorization, 'generation_storage', storage)
    output = Mock()
    monkeypatch.setattr(api, 'output_events', output)
    client = TestClient(api.app)
    for caller in [identity(None), identity('b' * 64), {'authenticated': True, 'user_id': 'other-account'}]:
        api.app.dependency_overrides[auth.get_optional_identity] = lambda: caller
        try:
            model_response = client.get(f'/generation/{job_id}')
            assert model_response.headers['cache-control'] == 'private, no-store'
            for response in [model_response,
                             client.post('/getGeneration', json={'generation_id': job_id})]:
                assert response.status_code == 200
                assert response.json()['ldr_content'] == ldr.decode()
                assert 'user_id' not in response.json()
            assert client.get(f'/generation/{job_id}/output').status_code == 404
            with pytest.raises(HTTPException) as denied:
                asyncio.run(authorization.get_generation_or_404(job_id, caller))
            assert denied.value.status_code == 404
        finally:
            api.app.dependency_overrides.clear()
    output.assert_not_called()


@pytest.mark.parametrize('status', ['queued', 'started', 'processing', 'ldr_processing', 'failed', 'cancelled'])
def test_unfinished_and_failed_models_remain_private(monkeypatch, status):
    job_id = '7c1326b2-890a-4fb8-9750-d3aa15cdc8e4'
    row = {'id': job_id, 'user_id': 'legacy-owner', 'user_type': 'anonymous',
           'status': status, 'is_community': True, 'prompt': 'Private prompt'}
    monkeypatch.setattr(getGeneration, 'generation_storage', SimpleNamespace(get_generation=AsyncMock(return_value=row)))
    client = TestClient(api.app)
    api.app.dependency_overrides[auth.get_optional_identity] = lambda: identity(None)
    try:
        assert client.get(f'/generation/{job_id}').status_code == 404
    finally:
        api.app.dependency_overrides.clear()


def test_claim_requires_guest_proof_and_scopes_update(monkeypatch):
    guest = identity('a' * 64)
    row = {'id': 'job', 'generation_id': 'model', 'user_type': 'anonymous', 'user_id': guest['user_id']}
    query = Mock()
    query.select.return_value = query
    query.eq.return_value = query
    query.update.return_value = query
    query.execute.return_value = SimpleNamespace(data=[row])
    monkeypatch.setattr(claimGeneration, 'generation_storage', SimpleNamespace(client=SimpleNamespace(table=Mock(return_value=query))))
    monkeypatch.setattr(claimGeneration, 'handle_auth_and_tracking', lambda **kwargs: {'user_email': 'owner@example.test'})
    logged_in = {'authenticated': True, 'user_id': 'account'}
    for proof in [None, identity('b' * 64)['user_id']]:
        with pytest.raises(HTTPException):
            asyncio.run(claimGeneration.claim_generation(claimGeneration.ClaimGenerationRequest(generation_id='job'), {**logged_in, 'guest_user_id': proof}))
    query.update.assert_not_called()
    result = asyncio.run(claimGeneration.claim_generation(claimGeneration.ClaimGenerationRequest(generation_id='job'), {**logged_in, 'guest_user_id': guest['user_id']}))
    assert result.claimed
    query.eq.assert_any_call('generation_id', 'model')
    query.eq.assert_any_call('user_id', guest['user_id'])


def test_image_history_cannot_override_owner():
    with pytest.raises(HTTPException) as error:
        asyncio.run(getGenerationsByImage.get_generations_by_image(
            getGenerationsByImage.GetGenerationsByImageRequest(generation_id='model', user_id='victim'), identity('a' * 64)))
    assert error.value.status_code == 403


def test_local_storage_route_never_serves_thinking_snapshots(monkeypatch, tmp_path):
    from src.utils import local_db
    monkeypatch.setattr(local_db, 'STORAGE_ROOT', tmp_path)
    for bucket in ['generation-output', 'generations']:
        directory = tmp_path / bucket / 'job'
        directory.mkdir(parents=True)
        (directory / 'llm-output.json').write_text('{"text":"secret"}')
        response = TestClient(api.app).get(f'/local-storage/{bucket}/job/llm-output.json')
        assert response.status_code == 404


def test_login_keeps_guest_proof_without_treating_invalid_jwt_as_guest(monkeypatch):
    monkeypatch.setattr(auth, 'supabase_client', object())
    monkeypatch.setattr(auth, 'extract_user_from_token', lambda token: {'user_id': 'account', 'email': 'owner@example.test'})
    logged_in = asyncio.run(auth.get_optional_identity(request('a' * 64), 'Bearer valid', None))
    assert logged_in['user_id'] == 'account'
    assert logged_in['guest_user_id'] == identity('a' * 64)['user_id']
    from src.utils.authorization import require_generation_access
    require_generation_access({'user_type': 'anonymous', 'user_id': logged_in['guest_user_id']}, logged_in)
    with pytest.raises(HTTPException):
        asyncio.run(auth.get_optional_identity(request('a' * 64), 'Basic invalid', None))
