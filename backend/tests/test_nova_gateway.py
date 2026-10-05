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
    return module


def test_runtime_rejects_missing_token_and_invalid_tenant_before_spawn(tmp_path):
    module = gateway(tmp_path)
    with TestClient(module.app) as client:
        assert client.get('/integration/runtime').status_code == 401
        assert client.get('/api/chats', headers={'Authorization': 'Bearer runtime-secret', 'X-Nova-Tenant': '../../other'}).status_code == 400
        response = client.get('/integration/runtime', headers={'Authorization': 'Bearer runtime-secret', 'X-Nova-Tenant': 'a' * 64})
        assert response.json() == {'toolkit': 'a' * 40, 'web': 'b' * 40}
    assert not module._workers


def test_gateway_routes_only_to_selected_tenant_and_strips_browser_headers(tmp_path):
    module = gateway(tmp_path)
    module.worker_url = AsyncMock(return_value='http://127.0.0.1:1234')
    def handle(request):
        assert request.url.host == '127.0.0.1' and request.url.port == 1234
        assert request.url.path == '/api/chats'
        assert 'origin' not in request.headers and 'cookie' not in request.headers
        assert request.headers['authorization'] == 'Bearer runtime-secret'
        class Body(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b'{"chats": []}'
        return httpx.Response(200, headers={'Content-Type': 'application/json'}, stream=Body())
    with TestClient(module.app) as client:
        asyncio.run(module.app.state.client.aclose())
        module.app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        response = client.get('/api/chats', headers={'Authorization': 'Bearer runtime-secret',
            'X-Nova-Tenant': 'b' * 64, 'Origin': 'https://untrusted.example', 'Cookie': 'private-browser-data'})
        assert response.json() == {'chats': []}
    module.worker_url.assert_awaited_once_with('b' * 64)


def test_worker_exports_precede_upstream_frontend_fallback(tmp_path, monkeypatch):
    from types import SimpleNamespace
    import sys
    from fastapi import FastAPI
    upstream = FastAPI()
    @upstream.get('/{path:path}')
    def frontend(path):
        return {'frontend': True}
    monkeypatch.setitem(sys.modules, 'main', SimpleNamespace(app=upstream))
    monkeypatch.setitem(sys.modules, 'agent', SimpleNamespace())
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
    module.export_sources = lambda chat, model: b'zip'
    with TestClient(upstream) as client:
        headers = {'Authorization': 'Bearer worker-secret'}
        assert client.get('/integration/runtime', headers=headers).json() == {'toolkit': 'revision'}
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
