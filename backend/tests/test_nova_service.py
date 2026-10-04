import asyncio
import io
import json
import zipfile
from types import SimpleNamespace

import httpx
import pytest

from src.utils.nova_service import NovaService, read_export


VERSIONS = {'toolkit': 'a' * 40, 'web': 'b' * 40}


def archive(files=None):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, value in (files or {'model.mpd': 'original hierarchical MPD', 'model.ldr': 'flat LDR', 'preview.png': b'png'}).items():
            z.writestr(name, value)
    return out.getvalue()


def test_import_keeps_canonical_source_and_rejects_zip_escapes():
    exported = archive()
    result = read_export(exported, {'chat_id': 'chat'})
    assert result.mpd == 'original hierarchical MPD' and result.archive == exported
    assert result.preview == b'png'
    for name in ('../secret', '/secret', 'folder\\secret'):
        with pytest.raises(ValueError, match='Invalid'):
            read_export(archive({'model.mpd': 'mpd', 'model.ldr': 'ldr', name: 'secret'}), {})
    with pytest.raises(ValueError, match='complete'):
        read_export(archive({'model.mpd': 'mpd'}), {})


def test_import_bounds_decompressed_zip_data(monkeypatch):
    from src.utils import nova_service
    monkeypatch.setattr(nova_service, 'MAX_ARCHIVE_BYTES', 1024)
    with pytest.raises(ValueError, match='Invalid'):
        read_export(archive({'model.mpd': 'm' * 2000, 'model.ldr': 'l'}), {})


def test_runtime_flow_uses_upstream_agent_and_imports_only_new_publications(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'private-provider-key')
    calls, sessions, output = [], [], []
    before = {'chat': {'running': False}, 'models': {'old': {'id': 'old', 'created_at': 1}}, 'messages': []}
    after = {'chat': {'running': False}, 'models': {**before['models'], 'new': {'id': 'new', 'created_at': 2}}, 'messages': []}
    chat_reads = 0

    def transport(req):
        nonlocal chat_reads
        body = json.loads(req.content) if req.content else None
        calls.append((req.method, req.url.path, body))
        if req.url.path == '/integration/runtime':
            return httpx.Response(200, json=VERSIONS)
        if req.url.path == '/api/llm-models' and req.method == 'GET':
            return httpx.Response(200, json={'models': []})
        if req.url.path == '/api/llm-models':
            assert body['litellm_params'] == {'model': 'openai/gpt-5.5', 'api_key': 'private-provider-key'}
            return httpx.Response(200, json={'id': 'model-config'})
        if req.url.path == '/api/chats/chat':
            chat_reads += 1
            return httpx.Response(200, json=before if chat_reads == 1 else after)
        if req.url.path.endswith('/messages'):
            assert body == {'text': 'make the roof red', 'images': [], 'llm_model_id': 'model-config', 'options': {'mode': 'agent', 'permissions': 'full'}}
            return httpx.Response(202, json={'started': True})
        if req.url.path.endswith('/stream'):
            return httpx.Response(200, text='event: progress\ndata: {"summary":"Rendering"}\n\nevent: text\ndata: {"delta":"Nova reply"}\n\nevent: done\ndata: {}\n\n')
        if req.url.path == '/integration/chats/chat/export/new':
            return httpx.Response(200, content=archive(), headers={'content-type': 'application/zip'})
        pytest.fail(str(req.url))

    async def run():
        async def save(value):
            sessions.append(dict(value))
        async def emit(value):
            output.append(value)
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(transport))) as service:
            request = SimpleNamespace(model='gpt-5.5', auth_mode='api_key', prompt='make the roof red', image_base64=None)
            result = await service.run(request, 'openai', save, emit, previous={'chat_id': 'chat'})
        assert result.session['versions'] == VERSIONS
        assert result.session['model_id'] == 'new'
    asyncio.run(run())
    assert sessions[0]['chat_id'] == 'chat' and sessions[-1]['model_id'] == 'new'
    assert output == ['Rendering\n\n', 'Nova reply']
    assert not any(path == '/api/chats' for _, path, _ in calls)


def test_provider_errors_never_echo_credentials():
    def transport(req):
        return httpx.Response(400, json={'detail': 'private-key was rejected'})
    async def run():
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(transport))) as service:
            with pytest.raises(ValueError) as exc:
                await service.request('POST', 'api/llm-models', json={'api_key': 'private-key'})
            assert 'private-key' not in str(exc.value)
    asyncio.run(run())


def test_owner_routes_use_different_runtime_tenants(monkeypatch):
    monkeypatch.setenv('NOVA_SERVICE_URL', 'http://127.0.0.1:8778')
    monkeypatch.setenv('NOVA_SERVICE_TOKEN', 'private-runtime-token')
    async def run():
        async with NovaService(tenant_key='authenticated:alice') as a, NovaService(tenant_key='authenticated:bob') as b:
            assert a.tenant != b.tenant
            assert a.client.headers['X-Nova-Tenant'] != b.client.headers['X-Nova-Tenant']
            assert a.client.headers['Authorization'] == 'Bearer private-runtime-token'
    asyncio.run(run())


def test_cancellation_stops_the_upstream_turn_but_conflicts_do_not(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'key')
    async def exercise(conflict):
        calls = []
        ready = asyncio.Event()
        def transport(req):
            calls.append(req.url.path)
            if req.url.path == '/integration/runtime': return httpx.Response(200, json=VERSIONS)
            if req.url.path == '/api/llm-models' and req.method == 'GET': return httpx.Response(200, json={'models': []})
            if req.url.path == '/api/llm-models': return httpx.Response(200, json={'id': 'llm'})
            if req.url.path == '/api/chats': return httpx.Response(200, json={'id': 'chat'})
            if req.url.path.endswith('/messages'): return httpx.Response(409 if conflict else 202, json={})
            if req.url.path.endswith('/cancel'): return httpx.Response(200, json={'cancelled': True})
            pytest.fail(str(req.url))
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(transport))) as service:
            async def wait(*args):
                ready.set()
                await asyncio.Event().wait()
            service.wait_for_turn = wait
            async def save(value): pass
            request = SimpleNamespace(model='gpt-5.5', auth_mode='api_key', prompt='castle', image_base64=None)
            task = asyncio.create_task(service.run(request, 'openai', save))
            if conflict:
                with pytest.raises(ValueError, match='already working'): await task
            else:
                await ready.wait()
                task.cancel()
                with pytest.raises(asyncio.CancelledError): await task
            assert ('/api/chats/chat/cancel' in calls) is not conflict
    asyncio.run(exercise(False))
    asyncio.run(exercise(True))


def test_sse_reconnect_does_not_resubmit_messages():
    calls = []
    def transport(req):
        calls.append(req.url.path)
        if req.url.path.endswith('/stream'):
            text = 'event: reconnect\ndata: {}\n\n' if calls.count(req.url.path) == 1 else 'event: done\ndata: {}\n\n'
            return httpx.Response(200, text=text)
        return httpx.Response(200, json={'chat': {'running': True}})
    async def run():
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(transport))) as service:
            await service.wait_for_turn('chat', None)
    asyncio.run(run())
    assert calls == ['/api/chats/chat/stream', '/api/chats/chat', '/api/chats/chat/stream']


def test_upstream_activity_is_shown_without_repeating_heartbeat_phases():
    output = []
    events = ('event: snapshot\ndata: {"running": true, "activity": {"phase": "Running LDraw Nova"}}\n\n'
              'event: activity\ndata: {"phase": "Running LDraw Nova"}\n\n'
              'event: activity\ndata: {"phase": "Reviewing a rendered image"}\n\n'
              'event: done\ndata: {}\n\n')
    async def run():
        async def emit(text): output.append(text)
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(
                lambda req: httpx.Response(200, text=events)))) as service:
            await service.wait_for_turn('chat', emit)
    asyncio.run(run())
    assert output == ['Running LDraw Nova\n\n', 'Reviewing a rendered image\n\n']
