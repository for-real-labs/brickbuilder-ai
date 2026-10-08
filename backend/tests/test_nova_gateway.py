import asyncio
import importlib.util
import json
from pathlib import Path
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
import httpx


def gateway(tmp_path):
    source = Path(__file__).parents[1] / 'nova-service/gateway.py'
    target = tmp_path / 'gateway.py'
    target.write_text(source.read_text())
    (tmp_path / 'versions.json').write_text(json.dumps({'toolkit': 'a' * 40, 'web': 'b' * 40}))
    spec = importlib.util.spec_from_file_location('nova_gateway_test', target)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.TOKEN = 'runtime-secret'
    module.TENANTS_ROOT = tmp_path / 'tenants'
    module.REFERENCE_ROOT = tmp_path / 'reference-cache'
    module.REFERENCE_SOCKET = tmp_path / 'reference.sock'
    return module


def cached_owner(module, tenant, age):
    import os
    import time
    data = module.TENANTS_ROOT / tenant
    toolkit = data / ('toolkit-' + 'a' * 40)
    cache = toolkit / '.cache'
    for name in (*module.SEARCH_CACHES, 'embedded'):
        path = cache / name
        path.mkdir(parents=True)
        (path / 'saved').write_text('keep or regenerate')
    for name in ('chats/session/model.ldr', 'output/model.mpd', 'provider-config/settings.json'):
        path = data / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('private saved build')
    module.mark_cache_used(tenant)
    stamp = time.time() - age
    os.utime(data / '.cache-last-used', (stamp, stamp))
    return data, cache


def test_cache_expiry_preserves_builds_credentials_and_embedded_parts(tmp_path):
    module = gateway(tmp_path)
    expired, cache = cached_owner(module, 'a' * 64, module.CACHE_RETENTION_SECONDS + 1)
    recent, recent_cache = cached_owner(module, 'b' * 64, module.CACHE_RETENTION_SECONDS - 1)
    asyncio.run(module.expire_search_caches())
    assert cache.is_dir() and (cache / 'embedded/saved').is_file()
    assert all(not (cache / name).exists() for name in module.SEARCH_CACHES)
    assert all((recent_cache / name / 'saved').is_file() for name in module.SEARCH_CACHES)
    assert (expired / 'chats/session/model.ldr').read_text() == 'private saved build'
    assert (expired / 'output/model.mpd').is_file()
    assert (expired / 'provider-config/settings.json').is_file()


def test_active_build_is_not_evicted_and_unknown_worker_state_fails_closed(tmp_path):
    from types import SimpleNamespace
    module = gateway(tmp_path)
    tenant = 'a' * 64
    data, cache = cached_owner(module, tenant, module.CACHE_RETENTION_SECONDS + 1)
    module._workers[tenant] = (SimpleNamespace(returncode=None), 'http://owner')
    module.stop_worker = AsyncMock()
    async def scenario():
        module.app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(
            lambda req: httpx.Response(200, json={'chats': [{'running': True}]})))
        await module.expire_search_caches()
        assert (cache / 'discovery/saved').is_file()
        module.stop_worker.assert_not_called()
        await module.app.state.client.aclose()
        module.app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(
            lambda req: httpx.Response(503)))
        await module.expire_search_caches()
        assert (cache / 'jev-rerank/saved').is_file()
        module.stop_worker.assert_not_called()
        await module.app.state.client.aclose()
    asyncio.run(scenario())


def test_idle_worker_stops_before_cache_removal(tmp_path):
    from types import SimpleNamespace
    module = gateway(tmp_path)
    tenant = 'a' * 64
    data, cache = cached_owner(module, tenant, module.CACHE_RETENTION_SECONDS + 1)
    process = SimpleNamespace(returncode=None)
    module._workers[tenant] = (process, 'http://owner')
    async def stop(worker):
        assert worker is process and (cache / 'discovery/saved').is_file()
    module.stop_worker = AsyncMock(side_effect=stop)
    async def scenario():
        module.app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(
            lambda req: httpx.Response(200, json={'chats': []})))
        await module.expire_search_caches()
        await module.app.state.client.aclose()
    asyncio.run(scenario())
    module.stop_worker.assert_awaited_once_with(process)
    assert tenant not in module._workers and not (cache / 'discovery').exists()


def test_cleanup_does_not_follow_cache_or_owner_symlinks(tmp_path):
    module = gateway(tmp_path)
    data, cache = cached_owner(module, 'a' * 64, module.CACHE_RETENTION_SECONDS + 1)
    protected = tmp_path / 'protected'
    protected.mkdir()
    (protected / 'model.ldr').write_text('keep')
    (cache / 'discovery/link').symlink_to(protected, target_is_directory=True)
    (module.TENANTS_ROOT / ('b' * 64)).symlink_to(protected, target_is_directory=True)
    asyncio.run(module.expire_search_caches())
    assert (protected / 'model.ldr').read_text() == 'keep'


def test_legacy_caches_use_latest_write_and_activity_survives_gateway_restart(tmp_path):
    import os
    import time
    module = gateway(tmp_path)
    data, cache = cached_owner(module, 'a' * 64, module.CACHE_RETENTION_SECONDS + 1)
    (data / '.cache-last-used').unlink()
    assert time.time() - module.cache_last_used(data, list(module.search_cache_paths(data))) < 60
    module.mark_cache_used(data.name)
    again = gateway(tmp_path)
    assert time.time() - again.cache_last_used(data, []) < 60


def test_unused_shared_index_is_removed_and_recreated_on_next_use(tmp_path):
    import os
    import time
    module = gateway(tmp_path)
    version = module.REFERENCE_ROOT / ('a' * 40)
    version.mkdir(parents=True)
    marker = version / '.last-used'
    marker.touch()
    stamp = time.time() - module.CACHE_RETENTION_SECONDS - 1
    os.utime(marker, (stamp, stamp))
    asyncio.run(module.expire_search_caches())
    assert not version.exists()


def test_old_filtered_index_expires_while_shared_catalog_is_still_active(tmp_path):
    import os
    import time
    module = gateway(tmp_path)
    version = module.REFERENCE_ROOT / ('a' * 40)
    stale = version / '.cache/jev-rerank' / ('b' * 64)
    fresh = version / '.cache/jev-rerank' / ('c' * 64)
    for path in (stale, fresh):
        path.mkdir(parents=True)
        (path / '.last-used').touch()
        (path / 'index.sqlite3').write_text('rebuildable')
    (version / '.last-used').touch()
    stamp = time.time() - module.CACHE_RETENTION_SECONDS - 1
    os.utime(stale / '.last-used', (stamp, stamp))
    snapshot = version / '.cache/discovery/public/queries' / (stale.name + '.sqlite')
    snapshot.parent.mkdir(parents=True)
    snapshot.write_text('public candidates')
    catalog = snapshot.parent.parent / 'catalog.sqlite'
    catalog.write_text('keep shared catalog')
    asyncio.run(module.expire_search_caches())
    assert not stale.exists() and not snapshot.exists()
    assert fresh.is_dir() and catalog.is_file()


def test_startup_migration_reclaims_duplicates_without_removing_private_results(tmp_path):
    module = gateway(tmp_path)
    data, cache = cached_owner(module, 'a' * 64, 0)
    asyncio.run(module.migrate_duplicate_indexes())
    assert not (cache / 'discovery').exists() and not (cache / 'jev-rerank').exists()
    assert (cache / 'reference-search/saved').is_file()
    assert (cache / 'embedded/saved').is_file()
    assert (data / 'chats/session/model.ldr').is_file()


def test_private_result_expires_independently_for_an_active_owner(tmp_path):
    import os
    import time
    module = gateway(tmp_path)
    data, cache = cached_owner(module, 'a' * 64, 0)
    stale = cache / 'reference-search/old.json'
    fresh = cache / 'reference-search/new.json'
    stale.write_text('{}')
    fresh.write_text('{}')
    stamp = time.time() - module.CACHE_RETENTION_SECONDS - 1
    os.utime(stale, (stamp, stamp))
    asyncio.run(module.expire_search_caches())
    assert not stale.exists() and fresh.is_file()
    assert (data / 'chats/session/model.ldr').is_file()


def test_reference_broker_rejects_unknown_unix_identity_before_read_or_spawn(tmp_path, monkeypatch):
    import struct
    from unittest.mock import MagicMock
    module = gateway(tmp_path)
    monkeypatch.setattr(module.socket, 'SO_PEERCRED', 17, raising=False)
    reader, writer = AsyncMock(), MagicMock()
    writer.get_extra_info.return_value.getsockopt.return_value = struct.pack('3i', 10, 1234, 1234)
    writer.drain, writer.wait_closed = AsyncMock(), AsyncMock()
    spawn = AsyncMock()
    monkeypatch.setattr(module.asyncio, 'create_subprocess_exec', spawn)
    asyncio.run(module.reference_request(reader, writer))
    reader.readline.assert_not_called()
    spawn.assert_not_called()
    assert b'error' in writer.write.call_args.args[0]


def test_runtime_rejects_missing_token_and_invalid_tenant_before_spawn(tmp_path):
    module = gateway(tmp_path)
    with TestClient(module.app) as client:
        assert client.get('/integration/runtime').status_code == 401
        assert client.get('/api/chats', headers={'Authorization': 'Bearer runtime-secret', 'X-Nova-Tenant': '../../other'}).status_code == 400
        response = client.get('/integration/runtime', headers={'Authorization': 'Bearer runtime-secret', 'X-Nova-Tenant': 'a' * 64})
        assert response.json() == {'toolkit': 'a' * 40, 'web': 'b' * 40, 'generation_cost_limit_usd': 10, 'generation_usage_version': 1}
    assert not module._workers


def test_gateway_routes_only_to_selected_tenant_and_strips_browser_headers(tmp_path):
    module = gateway(tmp_path)
    module.worker_url = AsyncMock(return_value='http://127.0.0.1:1234')
    def handle(request):
        assert request.url.host == '127.0.0.1' and request.url.port == 1234
        assert request.url.path == '/api/chats'
        assert 'origin' not in request.headers and 'cookie' not in request.headers
        assert request.headers['authorization'] == 'Bearer runtime-secret'
        assert request.headers['x-brickbuilder-generation-id'] == '11111111-1111-1111-1111-111111111111'
        class Body(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b'{"chats": []}'
        return httpx.Response(200, headers={'Content-Type': 'application/json'}, stream=Body())
    with TestClient(module.app) as client:
        asyncio.run(module.app.state.client.aclose())
        module.app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        response = client.get('/api/chats', headers={'Authorization': 'Bearer runtime-secret',
            'X-Nova-Tenant': 'b' * 64, 'X-BrickBuilder-Generation-Id': '11111111-1111-1111-1111-111111111111', 'Origin': 'https://untrusted.example', 'Cookie': 'private-browser-data'})
        assert response.json() == {'chats': []}
    module.worker_url.assert_awaited_once_with('b' * 64)


def worker(tmp_path, monkeypatch):
    from types import SimpleNamespace
    import sys
    from fastapi import FastAPI
    upstream = FastAPI()
    @upstream.get('/{path:path}')
    def frontend(path):
        return {'frontend': True}
    monkeypatch.setitem(sys.modules, 'main', SimpleNamespace(app=upstream))
    monkeypatch.setitem(sys.modules, 'agent', SimpleNamespace())
    for name in ['llm_config', 'litellm', 'claude_agent']:
        monkeypatch.setitem(sys.modules, name, SimpleNamespace())
    monkeypatch.setitem(sys.modules, 'brickbuilder_integration.cost_limits', SimpleNamespace(install_cost_limits=lambda *args: None, current_usage_id=__import__('contextvars').ContextVar('test_usage_id', default=None)))
    monkeypatch.setitem(sys.modules, 'settings', SimpleNamespace())
    monkeypatch.setitem(sys.modules, 'store', SimpleNamespace(get_store=lambda: None))
    monkeypatch.setitem(sys.modules, 'leocad_render', SimpleNamespace(bom_path_for=lambda p: p, snapshot_path_for=lambda p: p))
    monkeypatch.setenv('NOVA_SERVICE_TOKEN', 'worker-secret')
    target = tmp_path / 'worker.py'
    target.write_text((Path(__file__).parents[1] / 'nova-service/worker.py').read_text())
    (tmp_path / 'versions.json').write_text(json.dumps({'toolkit': 'revision'}))
    spec = importlib.util.spec_from_file_location('nova_worker_test', target)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_worker_exports_precede_upstream_frontend_fallback(tmp_path, monkeypatch):
    module = worker(tmp_path, monkeypatch)
    upstream = module.app
    module.export_sources = lambda chat, model: b'zip'
    with TestClient(upstream) as client:
        headers = {'Authorization': 'Bearer worker-secret'}
        assert client.get('/integration/runtime', headers=headers).json() == {'toolkit': 'revision', 'generation_cost_limit_usd': 10, 'generation_usage_version': 1}
        result = client.get('/integration/chats/chat/export/model', headers=headers)
        assert result.content == b'zip' and result.headers['content-type'] == 'application/zip'
        assert client.get('/integration/chats/chat/export/model').status_code == 401


def test_instruction_export_uses_only_model_data_and_does_not_start_an_owner_worker(tmp_path):
    module = gateway(tmp_path)
    calls = []
    module.export_instruction_placements = lambda source: calls.append(source) or b'physical placements\n0 STEP'
    module.worker_url = AsyncMock()
    with TestClient(module.app) as client:
        url = '/integration/instructions'
        assert client.post(url, content='model').status_code == 401
        result = client.post(url, content=b'model', headers={'Authorization': 'Bearer runtime-secret'})
        assert result.status_code == 200 and result.text == 'physical placements\n0 STEP'
        assert client.post(url, content=b'\xff', headers={'Authorization': 'Bearer runtime-secret'}).status_code == 502
    assert calls == [b'model']
    module.worker_url.assert_not_called()


def test_worker_import_seeds_independent_workspace_and_rejects_unsafe_references(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    module = worker(tmp_path, monkeypatch)
    workspace = tmp_path / 'work'
    workspace.mkdir()
    generated = tmp_path / 'generated'
    generated.mkdir()
    module.settings.GENERATED_DIR = generated
    chats, messages, models = [], [], []
    def create_chat(title, provider):
        chats.append((title, provider))
        return {'id': 'new-chat'}
    def add_model(chat, title, model, parts):
        models.append((chat, model.read_text()))
        return {'id': 'imported-model'}
    module.get_store = lambda: SimpleNamespace(create_chat=create_chat, add_model=add_model,
        work_dir=lambda chat: workspace, add_message=lambda chat, message: messages.append((chat, message)))
    accessible = []
    monkeypatch.setitem(sys.modules, 'sandbox', SimpleNamespace(give_to_agent=accessible.append))
    geometry = '0 !COLOUR Cream CODE 100027 VALUE #EFDBB2 EDGE #333333\n1 100027 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat'
    with TestClient(module.app) as client:
        headers = {'Authorization': 'Bearer worker-secret'}
        body = {'model': geometry, 'llm_model_id': 'callers-provider'}
        assert client.post('/integration/import', json=body).status_code == 401
        for reference in ('../secret', '/config/secret', 'C:\\secret'):
            bad = {**body, 'model': geometry.replace('3001.dat', reference)}
            assert client.post('/integration/import', json=bad, headers=headers).status_code == 400
        assert not chats
        result = client.post('/integration/import', json=body, headers=headers)
        assert result.json() == {'id': 'new-chat', 'model_id': 'imported-model'}
    assert chats == [('Model copy', 'callers-provider')]
    assert models == [('new-chat', geometry)]
    assert workspace in accessible and workspace / 'model.ldr' in accessible
    assert (workspace / 'model.ldr').read_text() == geometry
    assert len(messages) == 1 and 'independent copy' in messages[0][1]['content']


def test_usage_endpoint_reads_private_per_generation_file_and_validates_identity(tmp_path, monkeypatch):
    from types import SimpleNamespace
    module = worker(tmp_path, monkeypatch)
    generation_id = '11111111-1111-1111-1111-111111111111'
    report = {'generation_id': generation_id, 'calls': [{'model': 'gpt-5.5', 'input_tokens': 100, 'output_tokens': 20, 'estimated_cost_usd': '.0011'}]}
    (tmp_path / f'.brickbuilder-usage-{generation_id}.json').write_text(json.dumps(report))
    module.get_store = lambda: SimpleNamespace(get_chat=lambda id: {} if id != 'chat' else {'id': 'chat'}, chat_dir=lambda _: tmp_path)
    headers = {'Authorization': 'Bearer worker-secret'}
    with TestClient(module.app) as client:
        assert client.get(f'/integration/chats/chat/usage/{generation_id}').status_code == 401
        assert client.get(f'/integration/chats/chat/usage/{generation_id}', headers=headers).json() == report
        assert client.get(f'/integration/chats/other/usage/{generation_id}', headers=headers).status_code == 404
        assert client.get('/integration/chats/chat/usage/not-a-uuid', headers=headers).status_code == 422
        assert client.get('/integration/runtime', headers={**headers, 'X-BrickBuilder-Generation-Id': '../../secret'}).status_code == 400
