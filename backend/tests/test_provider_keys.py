import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from cryptography.fernet import Fernet
from fastapi import HTTPException
from src.utils import provider_keys as keys


class Store:
    def __init__(self):
        self.rows = {'user_provider_keys': [], 'user_ai_preferences': []}
    def table(self, name):
        store = self
        class Query:
            filters = None
            def __init__(self): self.filters = {}; self.operation = 'select'; self.fields = '*'
            def select(self, fields): self.fields = fields; return self
            def eq(self, key, value): self.filters[key] = value; return self
            def upsert(self, row, **kwargs): self.operation = 'upsert'; self.row = row; return self
            def delete(self): self.operation = 'delete'; return self
            def execute(self):
                rows = store.rows[name]
                if self.operation == 'upsert':
                    found = next((r for r in rows if r['user_id'] == self.row['user_id'] and r.get('provider') == self.row.get('provider')), None)
                    if found: found.update(self.row)
                    else: rows.append(dict(self.row))
                    return SimpleNamespace(data=[])
                found = [r for r in rows if all(r[k] == v for k, v in self.filters.items())]
                if self.operation == 'delete':
                    store.rows[name] = [r for r in rows if r not in found]
                    return SimpleNamespace(data=[])
                return SimpleNamespace(data=[dict(r) if self.fields == '*' else {k: r[k] for k in self.fields.split(',')} for r in found])
        return Query()


@pytest.fixture
def store(monkeypatch):
    store = Store()
    monkeypatch.setattr(keys.auth, 'supabase_client', store)
    monkeypatch.setenv('PROVIDER_KEYS_ENCRYPTION_KEY', Fernet.generate_key().decode())
    return store


def identity(): return {'user_id': str(uuid4()), 'authenticated': True, 'is_anonymous': False}
def request(): return SimpleNamespace(billing_source='personal', auth_mode='api_key', _provider_api_key=None)


def test_ciphertext_is_owner_bound_and_never_returned(store):
    async def run():
        alice, bob = identity(), identity()
        secret = 'sk-test-personal-secret'
        result = await keys.save(alice, 'openai', secret)
        assert result['providers'] == ['openai'] and secret not in str(result)
        row = store.rows['user_provider_keys'][0]
        assert secret not in row['encrypted_key']
        req = request()
        await keys.resolve(req, alice, 'openai')
        assert req._provider_api_key == secret
        with pytest.raises(HTTPException, match='400'):
            await keys.resolve(request(), bob, 'openai')
        # Even copying a ciphertext to another account does not grant access.
        store.rows['user_provider_keys'].append({**row, 'user_id': bob['user_id']})
        with pytest.raises(HTTPException) as error:
            await keys.resolve(request(), bob, 'openai')
        assert error.value.status_code == 503
        await keys.remove(bob, 'openai')
        assert (await keys.status(alice))['providers'] == ['openai']
        await keys.remove(alice, 'openai')
        with pytest.raises(HTTPException): await keys.resolve(request(), alice, 'openai')
    asyncio.run(run())


@pytest.mark.parametrize('who', [{}, {'authenticated': False}, {'authenticated': True, 'is_developer': True}, {'authenticated': True, 'is_anonymous': True}, {'authenticated': True, 'user_id': 'invalid'}])
def test_anonymous_or_developer_cannot_store_or_read_keys(store, who):
    with pytest.raises(HTTPException): asyncio.run(keys.save(who, 'openai', 'sk-test-secret'))
    with pytest.raises(HTTPException): asyncio.run(keys.status(who))
    assert store.rows['user_provider_keys'] == []


def test_missing_encryption_key_fails_closed(store, monkeypatch):
    monkeypatch.delenv('PROVIDER_KEYS_ENCRYPTION_KEY')
    with pytest.raises(HTTPException): asyncio.run(keys.save(identity(), 'openai', 'sk-test-secret'))
    assert store.rows['user_provider_keys'] == []


def test_concurrent_jobs_do_not_share_credentials_or_fallback(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'server-secret')
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'server-claude')
    monkeypatch.setenv('TYPESAFE_API_KEY', 'shared-jev')
    @keys.personal_billing_task
    async def run_job(generation_id, req):
        await asyncio.sleep(0)
        return (keys.provider_env('OPENAI_API_KEY'), keys.provider_env('ANTHROPIC_API_KEY'), keys.provider_env('TYPESAFE_API_KEY'))
    async def run():
        results = await asyncio.gather(*(run_job('id', SimpleNamespace(model='gpt-test', _provider_api_key=key)) for key in ['alice-key','bob-key',None]))
        assert results == [('alice-key',None,'shared-jev'),('bob-key',None,'shared-jev'),('server-secret','server-claude','shared-jev')]
        assert keys.provider_env('OPENAI_API_KEY') == 'server-secret'
    asyncio.run(run())


def test_personal_generation_does_not_reserve_platform_ai_budget(monkeypatch):
    from src.utils.billing_ai_budget import reserve
    monkeypatch.setenv('API_MODE', 'production')
    @keys.personal_billing_task
    async def run_job(generation_id, req):
        assert await reserve({'model': 'gpt-test'}) is None
    asyncio.run(run_job('id', SimpleNamespace(model='gpt-test', _provider_api_key='sk-personal')))


def test_private_key_is_not_serialized_with_generation_request():
    from src.requests.llmToBricks import LlmToBricksRequest
    req = LlmToBricksRequest(prompt='castle', billing_source='personal')
    req._provider_api_key = 'sk-not-public'
    assert 'sk-not-public' not in req.model_dump_json()
    assert 'sk-not-public' not in repr(req)


def test_personal_key_routes_never_return_ciphertext_or_accept_owner_from_body(store):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from src.requests.providerKeys import router
    from src.utils.auth import get_optional_identity
    app = FastAPI(); app.include_router(router)
    alice = identity()
    app.dependency_overrides[get_optional_identity] = lambda: alice
    client = TestClient(app)
    response = client.put('/provider-keys/openai', json={'api_key': 'sk-test-secret-123456'})
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    assert response.json()['providers'] == ['openai']
    assert 'encrypted_key' not in response.text and 'sk-test' not in response.text
    assert client.put('/provider-keys/openai',json={'api_key': 'short'}).status_code == 400
    assert client.put('/provider-keys/preferences',json={'billing_source':'personal','skip_confirmation':True,'user_id':str(uuid4())}).status_code == 422
    assert client.put('/provider-keys/fal',json={'api_key':'sk-test-secret-123456'}).status_code == 422
    assert client.delete('/provider-keys/openai').json()['providers'] == []


def test_nova_uses_personal_key_and_preserves_shared_search(monkeypatch):
    from src.utils.nova_service import NovaService
    monkeypatch.setenv('OPENAI_API_KEY', 'server-openai')
    monkeypatch.setenv('TYPESAFE_API_KEY', 'shared-jev')
    calls = []
    async def respond(method,path,**kwargs):
        calls.append((method,path,kwargs))
        if path == 'api/llm-models' and method == 'GET': return {'models': []}
        if path == 'api/environment' and method == 'GET': return {'variables': [{'name':'TYPESAFE_API_KEY','value':''}]}
        return {'id':'a'*32}
    service = NovaService(client=SimpleNamespace(aclose=AsyncMock()), api_key='sk-personal')
    service.request = respond
    async def run():
        async with service:
            await service.configure_model('gpt-5.5','openai','api_key')
    asyncio.run(run())
    assert calls[-1][2]['json']['litellm_params']['api_key'] == ''
    model = next(c[2]['json'] for c in calls if c[0] == 'POST')
    assert model['litellm_params']['api_key'] == 'sk-personal'
    assert 'sk-personal' not in model['model_name']
    env = next(c[2]['json'] for c in calls if c[1] == 'api/environment' and c[0] == 'PUT')
    assert env['variables'][0]['value'] == 'shared-jev'
