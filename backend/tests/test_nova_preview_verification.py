import asyncio
import io
import json
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from src.requests import novaToBricks as jobs
from src.requests import novaInstructions as instructions
from src.utils.nova_service import NovaService, NovaResult, read_export
from test_nova_service import archive, VERSIONS
from test_nova_gateway import worker
from test_nova_build_review import load


def preview_archive():
    return archive({'model.mpd': 'preview source', 'model.ldr': 'preview display',
                    'export-mode.json': json.dumps({'build_mode': 'preview'}),
                    'publication.json': json.dumps({'validation_status': 'preview'})})


def test_request_defaults_to_preview_and_verification_requires_a_saved_revision():
    assert jobs.NovaToBricksRequest(prompt='car').build_mode == 'preview'
    with pytest.raises(ValidationError):
        jobs.NovaToBricksRequest(prompt='car', build_mode='unknown')
    with pytest.raises(ValidationError, match='saved preview'):
        jobs.NovaToBricksRequest(prompt='Verify Build', build_mode='verify')


def test_preview_is_importable_but_cannot_supply_verified_instructions():
    result = read_export(preview_archive(), {})
    result.require_preview()
    assert result.instructions is None and result.build_review is None
    with pytest.raises(ValueError, match='build review failed'):
        result.require_build_review()
    with pytest.raises(ValueError, match='unchecked preview'):
        read_export(archive(), {}).require_preview()
    forged = archive({'model.mpd': 'm', 'model.ldr': 'l', 'nova-instructions.ldr': 'unchecked',
        'export-mode.json': json.dumps({'build_mode': 'preview'}),
        'publication.json': json.dumps({'validation_status': 'preview'})})
    with pytest.raises(ValueError, match='Invalid Nova preview'):
        read_export(forged, {})


def test_preview_export_uses_explicit_mode_and_preserves_legacy_checked_default():
    async def run():
        queries = []
        def respond(request):
            queries.append(dict(request.url.params))
            data = preview_archive() if request.url.params.get('build_mode') == 'preview' else archive()
            return httpx.Response(200, content=data, headers={'content-type': 'application/zip'})
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(respond))) as service:
            (await service.export('chat', 'model', {'build_mode': 'preview'})).require_preview()
            (await service.export('chat', 'model', {})).require_build_review()
        assert queries == [{'build_mode': 'preview'}, {}]
    asyncio.run(run())


@pytest.mark.parametrize('mode', ['preview', 'verify'])
def test_turn_routes_to_preview_or_selected_revision_verification(mode):
    async def run():
        service = NovaService(httpx.AsyncClient(base_url='http://nova'))
        service.ready = AsyncMock(return_value=VERSIONS)
        service.configure_model = AsyncMock(return_value='configured-model')
        service.chat = AsyncMock(side_effect=[
            {'chat': {'running': False}, 'models': {'selected': {}, 'later': {}}, 'messages': []},
            {'chat': {'running': False}, 'models': {'selected': {}, 'later': {},
             'new': {'id': 'new', 'created_at': 2}}, 'messages': []}])
        service.request = AsyncMock(return_value={'parts_catalog_version': 1})
        service.wait_for_turn = AsyncMock()
        service.export = AsyncMock(return_value=read_export(preview_archive() if mode == 'preview' else archive(), {}))
        request = SimpleNamespace(build_mode=mode, model='gpt-5.5', auth_mode='api_key',
                                  prompt='make it red', image_base64=None)
        try:
            await service.run(request, 'openai', AsyncMock(), previous={'chat_id': 'chat', 'model_id': 'selected'})
            call = service.request.call_args_list[1]
            assert call.args[1] == ('api/chats/chat/verify' if mode == 'verify' else 'api/chats/chat/messages')
            if mode == 'verify':
                assert call.kwargs['json'] == {'model_id': 'selected', 'llm_model_id': 'configured-model', 'permissions': 'full'}
            else:
                assert call.kwargs['json']['options']['build_mode'] == 'preview'
            assert service.export.call_args.args[2]['build_mode'] == mode
        finally:
            await service.client.aclose()
    asyncio.run(run())


def test_verification_is_owner_only_before_private_session_or_geometry_reads(monkeypatch):
    download = AsyncMock()
    monkeypatch.setattr(jobs, 'generation_storage', SimpleNamespace(
        get_generation=AsyncMock(return_value={'user_id': 'owner', 'user_type': 'authenticated',
            'status': 'completed', 'endpoint': 'novaToBricks', 'ldr_url': 'model'}),
        download_file_from_storage=download))
    request = jobs.NovaToBricksRequest(prompt='Verify Build', source_generation_id='saved', build_mode='verify')
    with pytest.raises(HTTPException) as error:
        asyncio.run(jobs._prepare_edit(request, {'user_id': 'visitor', 'authenticated': True}))
    assert error.value.status_code == 404
    download.assert_not_awaited()


def test_preview_jobs_skip_packing_and_checked_instruction_cache_and_charge_after_saving(monkeypatch):
    writes, events = [], []
    class Bucket:
        def upload(self, **kwargs):
            writes.append(kwargs['path'])
            events.append('upload')
    class Storage:
        client = SimpleNamespace(storage=SimpleNamespace(from_=lambda *_: Bucket()))
        update_status = AsyncMock()
        store_model_file = AsyncMock()
        store_parts_list_csv = AsyncMock()
        store_preview_image = AsyncMock()
    result = NovaResult('source', 'display', None, b'archive', {}, build_mode='preview')
    class Service:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def run(self, *args, **kwargs): return result
    def pack(*args, **kwargs):
        pytest.fail('Preview must not run MPD dependency packing')
    async def charge(**kwargs):
        assert writes == ['generation/nova-source.zip']
        assert kwargs['credits_to_deduct'] == 1
        events.append('charge')
    storage = Storage()
    monkeypatch.setattr(jobs, 'generation_storage', storage)
    monkeypatch.setattr(jobs, '_nova_service', lambda *_: Service())
    monkeypatch.setattr(jobs, 'LDrawPacker', pack)
    monkeypatch.setattr(jobs, 'deduct_credits', charge)
    monkeypatch.setattr(jobs, 'track_image_conversion', lambda **kwargs: None)
    error = asyncio.run(jobs.process_nova_to_bricks_task('generation', jobs.NovaToBricksRequest(prompt='car'),
        {'user_email': 'owner', 'is_developer': False}, {}))
    assert error is None and events == ['upload', 'charge']
    storage.update_status.assert_awaited_with('generation', 'completed')
    storage.store_model_file.assert_awaited_once()


def test_preview_instructions_cannot_trigger_implicit_review_or_read_a_cache(monkeypatch):
    bucket = SimpleNamespace(download=lambda *_: pytest.fail('Preview instruction reads must stop before storage'))
    monkeypatch.setattr(instructions, 'generation_storage', SimpleNamespace(
        get_generation=AsyncMock(return_value={'status': 'completed', 'endpoint': 'novaToBricks', 'nova_build_mode': 'preview'}),
        client=SimpleNamespace(storage=SimpleNamespace(from_=lambda *_: bucket))))
    with pytest.raises(HTTPException) as error:
        asyncio.run(instructions.get_nova_instructions('preview'))
    assert error.value.status_code == 409 and 'Verify Build' in error.value.detail


def test_preview_publication_bypasses_review_without_weakening_checked_publication(monkeypatch, tmp_path):
    policy = load('build_policy')
    publish = AsyncMock(return_value='preview')
    tools = SimpleNamespace(TOOLS={'publish_model': ({'function': {'description': 'Publish'}}, publish)})
    policy.install_build_policy(tools, SimpleNamespace())
    monkeypatch.setattr(policy, 'review_source', lambda *_: pytest.fail('Preview must not review'))
    ctx = SimpleNamespace(build_mode='preview')
    assert asyncio.run(tools.TOOLS['publish_model'][1](ctx, 'output/model.mpd')) == 'preview'
    publish.assert_awaited_once_with(ctx, 'output/model.mpd', None)


def test_worker_preview_exports_captured_geometry_without_review_or_instructions(tmp_path, monkeypatch):
    module = worker(tmp_path, monkeypatch)
    generated, work = tmp_path / 'generated', tmp_path / 'work'
    generated.mkdir(); work.mkdir()
    model = generated / 'model.mpd'; model.write_bytes(b'preview bytes')
    (work / 'build-review.json').write_text('{"passed":true}')
    ref = {'id': 'model', 'model': str(model), 'validation_status': 'preview'}
    module.settings.GENERATED_DIR, module.settings.LDRAW_DIR = generated, tmp_path
    module.agent.is_running = lambda *_: False
    module.get_store = lambda: SimpleNamespace(get_chat=lambda *_: {'id': 'chat'}, models=lambda *_: [ref],
        resolve=lambda *_: model, work_dir=lambda *_: work, messages=lambda *_: [])
    module.review_source = lambda *_: pytest.fail('Preview export must skip review')
    def display(source, library):
        assert source == b'preview bytes'
        model.write_bytes(b'changed')
        return b'flat preview'
    module.preview_display = display
    with zipfile.ZipFile(io.BytesIO(module.export_sources('chat', 'model', 'preview'))) as exported:
        assert exported.read('model.mpd') == b'preview bytes'
        assert exported.read('model.ldr') == b'flat preview'
        assert 'build-review.json' not in exported.namelist()
        assert 'nova-instructions.ldr' not in exported.namelist()
        assert json.loads(exported.read('export-mode.json')) == {'build_mode': 'preview'}
    ref.pop('validation_status')
    with pytest.raises(HTTPException) as error:
        module.export_sources('chat', 'model', 'preview')
    assert error.value.status_code == 409


def test_old_preview_incapable_runtimes_are_rejected_before_starting_a_job():
    async def run():
        old = {key: value for key, value in VERSIONS.items() if key != 'preview_build_version'}
        async with NovaService(httpx.AsyncClient(base_url='http://nova', transport=httpx.MockTransport(
                lambda request: httpx.Response(200, json=old)))) as service:
            with pytest.raises(ValueError, match='quick previews'):
                await service.ready()
    asyncio.run(run())
