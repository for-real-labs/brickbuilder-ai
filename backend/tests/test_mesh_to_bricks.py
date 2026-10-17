import asyncio
import io
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, UploadFile
from src.requests import glbToBricks as module


@pytest.mark.parametrize('format', ['glb', 'obj'])
def test_upload_preserves_input_identity_and_queues_voxel_conversion(monkeypatch, format):
    storage = SimpleNamespace(create_generation=AsyncMock(return_value='mesh-id'))
    scheduled = []
    def schedule(generation_id, coroutine):
        scheduled.append((generation_id, coroutine.cr_frame.f_locals.copy()))
        coroutine.close()
    monkeypatch.setattr(module, 'generation_storage', storage)
    monkeypatch.setattr(module, 'start_generation_task', schedule)
    monkeypatch.setattr(module, 'handle_auth_and_tracking', lambda **_: {
        'user_email': 'guest', 'is_anonymous': True, 'is_developer': False})
    file = UploadFile(filename=f'castle.{format}', file=io.BytesIO(b'geometry'))
    response = asyncio.run(module.glb_to_bricks(file, 'trimesh', 30, {'user_id': 'guest'}, f'/{format}-to-lego', format))
    try:
        assert response.generation_id == 'mesh-id'
        saved = storage.create_generation.call_args.kwargs
        assert saved['input_type'] == format and saved['input_format'] == format
        assert saved['entry_page'] == f'/{format}-to-lego'
        assert saved['endpoint'] == f'{format}ToBricks'
        assert scheduled[0][1]['detail_level'] == 30
        assert Path(scheduled[0][1]['glb_path']).read_bytes() == b'geometry'
    finally:
        Path(scheduled[0][1]['glb_path']).unlink()


@pytest.mark.parametrize('filename, content, detail, format, code', [
    ('castle.glb', b'model', 40, 'obj', 400),
    ('castle.obj', b'', 40, 'obj', 400),
    ('castle.obj', b'model', float('nan'), 'obj', 400),
    ('castle.glb', b'model', float('inf'), 'glb', 400),
    ('castle.glb', b'model', 201, 'glb', 400),
    ('castle.obj', b'x' * (50 * 1024 * 1024 + 1), 40, 'obj', 413),
])
def test_invalid_uploads_fail_before_creating_a_generation(monkeypatch, filename, content, detail, format, code):
    storage = SimpleNamespace(create_generation=AsyncMock())
    monkeypatch.setattr(module, 'generation_storage', storage)
    with pytest.raises(HTTPException) as error:
        asyncio.run(module.glb_to_bricks(UploadFile(filename=filename, file=io.BytesIO(content)),
            'trimesh', detail, {'user_id': 'guest'}, None, format))
    assert error.value.status_code == code
    storage.create_generation.assert_not_awaited()


def test_obj_background_task_converts_before_voxelizing_and_cleans_up_on_failure(monkeypatch, tmp_path):
    source = tmp_path / 'castle.obj'; source.write_text('OBJ geometry')
    glb = tmp_path / 'castle.glb'
    def convert(path):
        assert path == str(source)
        glb.write_bytes(b'GLB geometry')
        return str(glb)
    def voxelize(path, **kwargs):
        assert path == str(glb) and glb.exists()
        raise ValueError('Invalid mesh')
    storage = SimpleNamespace(update_status=AsyncMock())
    monkeypatch.setattr(module, 'generation_storage', storage)
    monkeypatch.setattr(module, 'obj_to_glb', convert)
    monkeypatch.setattr(module, 'glb2brick', voxelize)
    monkeypatch.setattr(module, 'track_error', lambda **_: None)
    asyncio.run(module.process_glb_to_bricks_task('g', str(source), 'trimesh', 40, 'guest', False))
    storage.update_status.assert_any_await('g', 'failed', 'Invalid mesh')
    assert not source.exists() and not glb.exists()
