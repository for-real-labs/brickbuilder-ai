import asyncio
import io
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, UploadFile

from src.requests import meshToVoxels as request


def upload(name='mesh.glb', data=b'mesh'):
    return UploadFile(filename=name, file=io.BytesIO(data))


@pytest.fixture(autouse=True)
def tracking(monkeypatch):
    monkeypatch.setattr(request, 'handle_auth_and_tracking', Mock())


@pytest.mark.parametrize('input_format', ['glb', 'obj'])
@pytest.mark.parametrize('output_format', ['vox', 'qb', 'binvox', 'xyzrgb'])
def test_download_is_private_and_forwards_validated_options(monkeypatch, input_format, output_format):
    worker = Mock(return_value=b'voxel-output')
    monkeypatch.setattr(request, 'run_conversion', worker)
    response = asyncio.run(request.mesh_to_voxels(upload(f'input.{input_format}'), input_format, output_format, 32, {'user_id': 'owner'}))
    worker.assert_called_once_with(b'mesh', input_format, output_format, 32)
    assert response.body == b'voxel-output'
    assert response.headers['content-disposition'] == f'attachment; filename="model.{output_format}"'
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['x-content-type-options'] == 'nosniff'


@pytest.mark.parametrize('name,data,input_format,output_format,resolution,status', [
    ('input.exe', b'x', 'glb', 'vox', 40, 400),
    ('input.glb', b'', 'glb', 'vox', 40, 400),
    ('input.glb', b'x', '../glb', 'vox', 40, 400),
    ('input.glb', b'x', 'glb', '../vox', 40, 400),
    ('input.glb', b'x', 'glb', 'vox', 65, 400),
    ('input.glb', b'x', 'glb', 'vox', 0, 400),
])
def test_invalid_input_never_starts_worker(monkeypatch, name, data, input_format, output_format, resolution, status):
    worker = Mock()
    monkeypatch.setattr(request, 'run_conversion', worker)
    with pytest.raises(HTTPException) as error:
        asyncio.run(request.mesh_to_voxels(upload(name, data), input_format, output_format, resolution, {}))
    assert error.value.status_code == status
    worker.assert_not_called()


def test_size_limit_reads_only_one_extra_byte(monkeypatch):
    monkeypatch.setattr(request, 'MAX_UPLOAD_BYTES', 4)
    with pytest.raises(HTTPException) as error:
        asyncio.run(request.mesh_to_voxels(upload(data=b'12345'), 'glb', 'vox', 40, {}))
    assert error.value.status_code == 413


def test_worker_timeout_releases_slot_and_removes_temporary_upload(monkeypatch):
    seen = []
    def timeout(command, **kwargs):
        source = Path(command[3])
        assert source.read_bytes() == b'mesh'
        seen.append(source)
        assert kwargs['timeout'] == 90
        assert kwargs['check'] is False
        raise subprocess.TimeoutExpired(command, 90)
    monkeypatch.setattr(request.subprocess, 'run', timeout)
    for _ in range(3):
        with pytest.raises(HTTPException) as error:
            request.run_conversion(b'mesh', 'glb', 'vox', 40)
        assert error.value.status_code == 422
    assert all(not path.exists() for path in seen)


def test_busy_workers_fail_without_starting_a_process(monkeypatch):
    semaphore = Mock()
    semaphore.acquire.return_value = False
    monkeypatch.setattr(request, '_WORKERS', semaphore)
    with pytest.raises(HTTPException) as error:
        request.run_conversion(b'mesh', 'glb', 'vox', 40)
    assert error.value.status_code == 503
    semaphore.release.assert_not_called()


@pytest.mark.parametrize('input_format,output_format', [('obj', 'vox'), ('glb', 'binvox')])
def test_http_endpoint_runs_real_isolated_worker(monkeypatch, input_format, output_format):
    import trimesh
    from fastapi.testclient import TestClient
    from src import api
    from src.utils.auth import get_user_with_optional_auth
    mesh = trimesh.creation.box(extents=[1, 2, 3])
    contents = mesh.export(file_type=input_format)
    if isinstance(contents, str):
        contents = contents.encode()
    api.app.dependency_overrides[get_user_with_optional_auth] = lambda: {'user_id': 'test-owner'}
    try:
        response = TestClient(api.app).post('/meshToVoxels', files={
            'file': (f'box.{input_format}', contents, 'application/octet-stream'),
        }, data={'input_format': input_format, 'output_format': output_format, 'resolution': 8})
    finally:
        api.app.dependency_overrides.pop(get_user_with_optional_auth, None)
    assert response.status_code == 200, response.text
    assert response.content.startswith(b'VOX ' if output_format == 'vox' else b'#binvox 1\n')
    assert response.headers['cache-control'] == 'private, no-store'
