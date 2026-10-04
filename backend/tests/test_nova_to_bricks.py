import asyncio
import io
import json
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from src.requests import novaToBricks as module
from src.utils.nova_service import NovaResult


def test_request_accepts_nova_continuation_and_validates_provider_input():
    request = module.NovaToBricksRequest(prompt='  red roof  ', source_generation_id='previous', model='gpt-5.5')
    assert request.prompt == 'red roof' and request.generation_id == 'previous'
    with pytest.raises(ValidationError):
        module.NovaToBricksRequest(prompt='castle', auth_mode='oauth-token')


def test_timeout_is_bounded(monkeypatch):
    for value in ('NaN', 'infinity', 'invalid', '-2', '999999'):
        monkeypatch.setenv('NOVA_TIMEOUT_SECONDS', value)
        assert module._generation_timeout() == 1800
    monkeypatch.setenv('NOVA_TIMEOUT_SECONDS', '300')
    assert module._generation_timeout() == 300


def test_source_and_sessions_recheck_owner_before_accessing_runtime_or_storage(monkeypatch):
    storage = SimpleNamespace(get_generation=AsyncMock(return_value={
        'user_id': 'owner', 'user_type': 'authenticated', 'endpoint': 'novaToBricks', 'status': 'completed'}))
    monkeypatch.setattr(module, 'generation_storage', storage)
    for action in (module.get_nova_source, module._owned_session):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(action('generation', {'user_id': 'intruder', 'authenticated': True}))
        assert exc.value.status_code == 404


def test_resume_cannot_bypass_native_loopback_guard(monkeypatch):
    monkeypatch.setattr(module, 'generation_storage', object())
    monkeypatch.setattr(module, '_owned_session', AsyncMock(return_value={
        'chat_id': 'chat', 'model': 'gpt-5.5', 'auth_mode': 'native', 'tenant': 'a' * 64}))
    request = module.NovaToBricksRequest(prompt='red roof', source_generation_id='source')
    with pytest.raises(HTTPException) as exc:
        asyncio.run(module.nova_to_bricks(request, {'user_id': 'owner'}))
    assert exc.value.status_code == 403


def test_nova_import_saves_original_model_and_durable_session_before_charging(monkeypatch, tmp_path):
    calls = []
    session = {'chat_id': 'chat', 'tenant': 'a' * 64, 'versions': {'toolkit': 'revision'}, 'model_id': 'new'}
    result = NovaResult('hierarchical MPD', 'flat LDR', b'png', b'archive', session)
    class Bucket:
        def upload(self, **kwargs): calls.append(('upload', kwargs['path'], kwargs['file']))
    class Storage:
        client = SimpleNamespace(storage=SimpleNamespace(from_=lambda _: Bucket()))
        async def update_status(self, generation_id, status, error_message=None): calls.append(('status', status))
        async def store_model_file(self, generation_id, content, file_type, **kwargs): calls.append(('model', file_type, content))
        async def store_parts_list_csv(self, generation_id, content, **kwargs): calls.append(('parts', content))
        async def store_preview_image(self, generation_id, content): calls.append(('preview', content))
    class Service:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def run(self, request, provider, save, on_output, previous):
            await save(session)
            return result
    class Packer:
        def __init__(self, **kwargs): pass
        def pack_ldraw_model(self, source):
            assert open(source).read() == result.mpd
            target = tmp_path / 'packed.mpd'; target.write_text('packed hierarchy')
            return str(target)
    async def charge(**kwargs): calls.append(('charge', 1))
    monkeypatch.setattr(module, 'generation_storage', Storage())
    monkeypatch.setattr(module, '_nova_service', lambda *args: Service())
    monkeypatch.setattr(module, 'LDrawPacker', Packer)
    monkeypatch.setattr(module, 'deduct_credits', charge)
    monkeypatch.setattr(module, 'track_image_conversion', lambda **kwargs: None)
    request = module.NovaToBricksRequest(prompt='castle', model='gpt-5.5')
    assert asyncio.run(module.process_nova_to_bricks_task('generation', request,
        {'user_email': 'test', 'is_developer': False}, {})) is None
    assert calls[1][1] == 'generation/nova-session.json'
    assert json.loads(calls[1][2]) == session
    assert ('model', 'ldr', 'flat LDR') in calls and ('model', 'mpd', 'packed hierarchy') in calls
    assert calls[-2:] == [('charge', 1), ('status', 'completed')]


def test_failed_nova_turn_does_not_charge(monkeypatch):
    storage = SimpleNamespace(update_status=AsyncMock())
    class Service:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def run(self, *args): raise ValueError('Nova did not publish a model')
    charge = AsyncMock()
    monkeypatch.setattr(module, 'generation_storage', storage)
    monkeypatch.setattr(module, '_nova_service', lambda *args: Service())
    monkeypatch.setattr(module, 'deduct_credits', charge)
    monkeypatch.setattr(module, 'track_error', lambda **kwargs: None)
    request = module.NovaToBricksRequest(prompt='castle', model='gpt-5.5')
    asyncio.run(module.process_nova_to_bricks_task('generation', request, {'user_email': 'test'}, {}))
    charge.assert_not_awaited()
    storage.update_status.assert_awaited_with('generation', 'failed', 'Nova did not publish a model')
