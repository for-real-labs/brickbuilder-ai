import asyncio
import io
import json
import zipfile
from types import SimpleNamespace

import httpx
import pytest
from unittest.mock import AsyncMock

from src.utils.nova_service import NovaService, read_export
from nova_review_helpers import receipt


VERSIONS = {'toolkit': 'a' * 40, 'web': 'b' * 40, 'generation_cost_limit_usd': 10, 'parts_catalog_version': 1, 'build_review_version': 1, 'preview_build_version': 1}


@pytest.mark.parametrize('versions,error', [({}, 'cost limit'),
    ({'parts_catalog_version': 1}, 'cost limit'),
    ({'generation_cost_limit_usd': 10}, 'parts catalog')])
def test_older_nova_runtime_is_rejected_before_provider_calls(versions, error):
    async def run():
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(
                lambda req: httpx.Response(200, json=versions)))) as service:
            with pytest.raises(ValueError, match=error):
                await service.ready()
    asyncio.run(run())


def test_budget_stream_error_is_visible_and_stops_the_turn():
    from src.utils.generation_budget import BUDGET_ERROR
    async def run():
        data = 'event: turn_error\ndata: ' + json.dumps({'message': BUDGET_ERROR}) + '\n\n'
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(
                lambda req: httpx.Response(200, text=data)))) as service:
            with pytest.raises(ValueError, match=r'\$10'):
                await service.wait_for_turn('chat', None)
    asyncio.run(run())


def test_final_import_blocks_a_runtime_publication_that_bypassed_the_parts_gate():
    async def run():
        async with NovaService(httpx.AsyncClient(base_url='http://nova')) as service:
            service.ready = AsyncMock(return_value=VERSIONS)
            service.configure_model = AsyncMock(return_value='config')
            service.request = AsyncMock(return_value={'parts_catalog_version': 1})
            service.chat = AsyncMock(side_effect=[{'chat': {'running': False}, 'models': {}},
                {'chat': {'running': False}, 'models': {'new': {'id': 'new', 'created_at': 1}}}])
            service.wait_for_turn = AsyncMock()
            service.cancel = AsyncMock()
            invalid = archive({'model.mpd': 'original MPD',
                               'model.ldr': '1 999999 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat'})
            service.export = AsyncMock(return_value=read_export(invalid, {}))
            request = SimpleNamespace(model='gpt-5.5', auth_mode='api_key', prompt='build', image_base64=None)
            with pytest.raises(ValueError, match='Parts unavailable'):
                await service.run(request, 'openai', AsyncMock(), previous={'chat_id': 'chat'})
            assert service.request.call_args_list[0].args[:2] == ('PUT', 'integration/chats/chat/parts-catalog')
            service.cancel.assert_awaited_once_with('chat')
    asyncio.run(run())


def archive(files=None):
    out = io.BytesIO()
    if files is None:
        files = {'model.mpd': 'original hierarchical MPD', 'model.ldr': '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', 'preview.png': b'png'}
        files['nova-instructions.ldr'] = files['model.ldr'] + '\n0 STEP\n'
        files['build-review.json'] = json.dumps(receipt(files['model.mpd'], files['model.ldr'], files['nova-instructions.ldr']))
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, value in files.items():
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
        if req.url.path.endswith('/parts-catalog'):
            assert req.method == 'PUT' and 'unit_price' not in body['csv']
            assert 'weight_kg' not in body['csv'] and 'supplier_color' not in body['csv']
            assert 'GDS-' not in body['csv']
            return httpx.Response(200, json={'parts_catalog_version': 1})
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
            assert body == {'text': 'make the roof red', 'images': [], 'llm_model_id': 'model-config', 'options': {'mode': 'agent', 'permissions': 'full', 'build_mode': 'verify'}}
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
            if req.url.path.endswith('/parts-catalog'): return httpx.Response(200, json={'parts_catalog_version': 1})
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
    progress = []
    events = ('event: snapshot\ndata: {"running": true, "activity": {"phase": "Running LDraw Nova"}}\n\n'
              'event: activity\ndata: {"phase": "Running LDraw Nova"}\n\n'
              'event: activity\ndata: {"phase": "Reviewing a rendered image"}\n\n'
              'event: done\ndata: {}\n\n')
    async def run():
        async def emit(text): output.append(text)
        async def report(phase): progress.append(phase)
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(
                lambda req: httpx.Response(200, text=events)))) as service:
            await service.wait_for_turn('chat', emit, report)
    asyncio.run(run())
    assert output == ['Running LDraw Nova\n\n', 'Reviewing a rendered image\n\n']
    assert progress[-1] == 'Reviewing a rendered image'


@pytest.mark.parametrize('missing_workspace', [False, True])
def test_foreign_model_import_is_saved_before_edit_and_requires_new_publication(monkeypatch, missing_workspace):
    monkeypatch.setenv('OPENAI_API_KEY', 'callers-key')
    geometry = '1 19 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat'
    sessions, calls = [], []
    chat_reads = 0
    def transport(req):
        nonlocal chat_reads
        calls.append(req.url.path)
        if req.url.path == '/integration/runtime': return httpx.Response(200, json=VERSIONS)
        if req.url.path == '/api/llm-models' and req.method == 'GET': return httpx.Response(200, json={'models': []})
        if req.url.path == '/api/llm-models': return httpx.Response(200, json={'id': 'caller-model'})
        if req.url.path.endswith('/parts-catalog'):
            assert req.url.path == '/integration/chats/copy-chat/parts-catalog'
            assert sessions == []
            return httpx.Response(200, json={'parts_catalog_version': 1})
        if req.url.path == '/api/chats/missing-chat':
            return httpx.Response(404, json={'detail': 'Chat not found'})
        if req.url.path == '/integration/import':
            assert json.loads(req.content) == {'model': geometry, 'llm_model_id': 'caller-model'}
            return httpx.Response(200, json={'id': 'copy-chat', 'model_id': 'seed'})
        if req.url.path == '/api/chats/copy-chat':
            chat_reads += 1
            models = {'seed': {'id': 'seed', 'created_at': 1}}
            if chat_reads > 1: models['edited'] = {'id': 'edited', 'created_at': 2}
            return httpx.Response(200, json={'chat': {'running': False}, 'models': models})
        if req.url.path.endswith('/messages'):
            assert sessions[0]['model_id'] == 'seed'
            assert json.loads(req.content)['text'] == 'add a door'
            return httpx.Response(202, json={})
        if req.url.path.endswith('/stream'): return httpx.Response(200, text='event: done\ndata: {}\n\n')
        if req.url.path == '/integration/chats/copy-chat/export/edited':
            return httpx.Response(200, content=archive(), headers={'content-type': 'application/zip'})
        pytest.fail(str(req.url))
    async def run():
        async def save(session): sessions.append(dict(session))
        request = SimpleNamespace(model='gpt-5.5', auth_mode='api_key', prompt='add a door',
            image_base64=None, _nova_source_ldr=geometry)
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(transport))) as service:
            result = await service.run(request, 'openai', save,
                previous={'chat_id': 'missing-chat'} if missing_workspace else None)
            assert result.session['chat_id'] == 'copy-chat' and result.session['model_id'] == 'edited'
    asyncio.run(run())
    assert '/api/chats' not in calls
    assert sessions[-1]['model_id'] == 'edited'
    assert '/api/chats/missing-chat/messages' not in calls
    assert calls.index('/integration/chats/copy-chat/parts-catalog') < calls.index('/api/chats/copy-chat/messages')


@pytest.mark.parametrize('status', [409, 500])
def test_workspace_recovery_does_not_hide_busy_sessions_or_runtime_failures(monkeypatch, status):
    monkeypatch.setenv('OPENAI_API_KEY', 'key')
    calls = []
    def transport(req):
        calls.append(req.url.path)
        if req.url.path == '/integration/runtime': return httpx.Response(200, json=VERSIONS)
        if req.url.path == '/api/llm-models' and req.method == 'GET': return httpx.Response(200, json={'models': []})
        if req.url.path == '/api/llm-models': return httpx.Response(200, json={'id': 'model'})
        return httpx.Response(status, json={})
    async def run():
        async def save(session): pass
        request = SimpleNamespace(model='gpt-5.5', auth_mode='api_key', _nova_source_ldr='saved geometry')
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(transport))) as service:
            with pytest.raises(ValueError):
                await service.run(request, 'openai', save, previous={'chat_id': 'chat'})
    asyncio.run(run())
    assert '/integration/import' not in calls


@pytest.mark.parametrize('failure', [False, True])
def test_nova_usage_is_read_for_only_this_generation_including_failed_edits(monkeypatch, failure):
    from unittest.mock import AsyncMock
    from src.utils.generation_budget import GenerationUsage, current_generation_usage
    id = '11111111-1111-1111-1111-111111111111'
    ledger = GenerationUsage(id)
    before = {'chat': {'running': False}, 'models': {}, 'messages': []}
    after = {'chat': {'running': False}, 'models': {} if failure else {'new': {'id': 'new', 'created_at': 1}}, 'messages': []}
    service = NovaService(httpx.AsyncClient(base_url='http://nova'))
    service.ready = AsyncMock(return_value={**VERSIONS, 'generation_usage_version': 1})
    service.configure_model = AsyncMock(return_value='model')
    service.chat = AsyncMock(side_effect=[before, after])
    service.wait_for_turn = AsyncMock()
    exported = read_export(archive(), {})
    service.export = AsyncMock(return_value=exported)
    async def respond(method, path, **kwargs):
        if path.endswith('/parts-catalog'):
            return {'parts_catalog_version': 1}
        if path.endswith('/messages'):
            assert kwargs['headers'] == {'X-BrickBuilder-Generation-Id': id}
            return {}
        if path.endswith('/cancel'): return {}
        assert path == f'integration/chats/chat/usage/{id}'
        return {'generation_id': id, 'calls': [{'model': 'gpt-5.5', 'input_tokens': 100, 'output_tokens': 50, 'estimated_cost_usd': '.002'}]}
    service.request = AsyncMock(side_effect=respond)
    async def run():
        context = current_generation_usage.set(ledger)
        try:
            request = SimpleNamespace(model='gpt-5.5', auth_mode='api_key', prompt='make fins blue', image_base64=None)
            if failure:
                with pytest.raises(ValueError, match='without publishing'):
                    await service.run(request, 'openai', AsyncMock(), previous={'chat_id': 'chat'})
            else:
                assert await service.run(request, 'openai', AsyncMock(), previous={'chat_id': 'chat'}) == exported
        finally:
            current_generation_usage.reset(context)
            await service.client.aclose()
    asyncio.run(run())
    assert ledger.values()['tokens_used'] == 150
    assert ledger.values()['estimated_cost_usd'] == '0.002'


@pytest.mark.parametrize('change', ['missing', 'failed', 'source', 'display', 'instructions', 'steps', 'contacts', 'truncated', 'groups'])
def test_completion_rejects_unreviewed_or_mismatched_artifacts(change):
    from dataclasses import replace
    result = read_export(archive(), {})
    if change == 'missing': result = replace(result, build_review=None)
    elif change == 'failed': result.build_review['passed'] = False
    elif change == 'source': result = replace(result, mpd='different model')
    elif change == 'display': result = replace(result, ldr='different display')
    elif change == 'instructions': result = replace(result, instructions='different steps')
    elif change == 'steps': result.build_review['instructions']['failed_step_count'] = 1
    elif change == 'contacts': result.build_review['geometry']['contacts_checked'] = False
    elif change == 'truncated': result.build_review['geometry']['contacts_truncated'] = True
    elif change == 'groups': result.build_review['instructions']['final_component_count'] = 2
    with pytest.raises(ValueError, match='build review failed'):
        result.require_build_review()


def test_readiness_requires_review_capability_before_a_turn():
    async def run():
        versions = {k: v for k, v in VERSIONS.items() if k != 'build_review_version'}
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(
                lambda req: httpx.Response(200, json=versions)))) as service:
            with pytest.raises(ValueError, match='connectivity and instruction review'):
                await service.ready()
    asyncio.run(run())


def test_completed_review_rejections_are_visible_without_echoing_runtime_content():
    async def run():
        def respond(req):
            if req.url.path == '/integration/runtime': return httpx.Response(200, json=VERSIONS)
            return httpx.Response(422, json={'detail': 'private runtime content'})
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(respond))) as service:
            for operation in [service.export('chat', 'model', {}), service.instructions('model')]:
                with pytest.raises(ValueError, match='Repair disconnected') as error:
                    await operation
                assert 'private runtime content' not in str(error.value)
    asyncio.run(run())
