import asyncio
import io
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException, UploadFile

from src.utils.ldraw_upload import normalize_ldraw_upload, MAX_UPLOAD_BYTES
from src.requests import uploadLdraw as module
from src.requests import getGeneration, getPrice, novaToBricks

BRICK = '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n'


def archive(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zip:
        for name, contents in files.items(): zip.writestr(name, contents)
    return output.getvalue()


@pytest.mark.parametrize('filename', ['brick.ldr', 'brick.LDR', 'brick.mpd'])
def test_plain_geometry_becomes_nova_ready_mpd(filename):
    assert normalize_ldraw_upload(filename, ('\ufeff0 Author: Original creator\r\n' + BRICK).encode()).startswith('0 FILE model.ldr\n0 Author: Original creator\n')


def test_mpd_preserves_hierarchy_inherited_colors_and_steps():
    source = '0 FILE root.ldr\n1 4 10 0 0 1 0 0 0 1 0 0 0 1 child.ldr\n0 STEP\n0 FILE child.ldr\n' + BRICK.replace('1 4 ', '1 16 ')
    assert normalize_ldraw_upload('model.mpd', source.encode()) == source


def test_io_unwraps_encrypted_studio_archive():
    result = normalize_ldraw_upload('brick.io', Path(__file__).with_name('fixtures').joinpath('studio-brick.io').read_bytes())
    assert BRICK in result and result.startswith('0 FILE model.ldr')


def test_io_preserves_embedded_custom_part_definitions():
    result = normalize_ldraw_upload('brick.io', archive({'model.ldr': BRICK.replace('3001.dat', 'CustomParts/part.dat'),
        'CustomParts/part.dat': '0 Custom part\n3 16 0 0 0 10 0 0 0 10 0\n'}))
    assert '0 FILE CustomParts/part.dat\n0 Custom part' in result


@pytest.mark.parametrize('filename,data', [
    ('brick.txt', BRICK.encode()), ('brick.ldr', b''), ('brick.ldr', b'not ldraw'),
    ('brick.ldr', b'0 empty'), ('brick.ldr', BRICK.replace('3001.dat', '../secrets.dat').encode()),
    ('brick.ldr', BRICK.replace('3001.dat', '/etc/passwd').encode()),
    ('brick.ldr', BRICK.replace('0 0 0 1', 'nan 0 0 1', 1).encode()),
    ('brick.mpd', ('0 FILE loop.ldr\n' + BRICK.replace('3001.dat', 'loop.ldr')).encode()),
    ('brick.mpd', ('0 FILE model.ldr\n' + BRICK.replace('3001.dat', 'missing.ldr')).encode()),
    ('brick.io', b'not a zip'), ('brick.io', archive({'notes.txt': 'missing model'})),
    ('brick.io', archive({'model.ldr': BRICK, '../secret.dat': 'bad'})),
])
def test_rejects_invalid_uploads(filename, data):
    with pytest.raises(ValueError): normalize_ldraw_upload(filename, data)


def test_rejects_zip_bomb_before_reading():
    with pytest.raises(ValueError, match='too large'):
        normalize_ldraw_upload('model.io', archive({'model.ldr': BRICK, 'large.txt': '0' * (MAX_UPLOAD_BYTES + 1)}))


@pytest.mark.parametrize('anonymous', [True, False])
def test_upload_stores_private_unorderable_geometry_without_running_ai(monkeypatch, anonymous):
    builder = Mock(); builder.table.return_value.update.return_value.eq.return_value.execute.return_value = SimpleNamespace(data=[{}])
    storage = SimpleNamespace(client=builder, create_generation=AsyncMock(return_value='g'), store_model_file=AsyncMock(), update_status=AsyncMock())
    monkeypatch.setattr(module, 'generation_storage', storage)
    tracking = Mock(return_value={'user_email': 'builder@example.com', 'is_anonymous': anonymous, 'is_developer': False})
    monkeypatch.setattr(module, 'handle_auth_and_tracking', tracking)
    response = asyncio.run(module.upload_ldraw(UploadFile(filename='castle.ldr', file=io.BytesIO(BRICK.encode())), {'user_id': 'owner'}))
    assert response.generation_id == 'g'
    assert storage.create_generation.call_args.kwargs['endpoint'] == 'uploadLdraw'
    assert storage.create_generation.call_args.kwargs['user_id'] == 'owner'
    assert storage.create_generation.call_args.kwargs['user_type'] == ('anonymous' if anonymous else 'authenticated')
    assert tracking.call_args.kwargs['required_credits'] == 0
    assert storage.store_model_file.call_args.args == ('g', '0 FILE model.ldr\n' + BRICK, 'ldr')
    storage.update_status.assert_awaited_with('g', 'completed')


def test_invalid_upload_never_creates_a_generation(monkeypatch):
    storage = SimpleNamespace(create_generation=AsyncMock())
    monkeypatch.setattr(module, 'generation_storage', storage)
    with pytest.raises(HTTPException) as error:
        asyncio.run(module.upload_ldraw(UploadFile(filename='model.io', file=io.BytesIO(b'invalid')), {}))
    assert error.value.status_code == 400
    storage.create_generation.assert_not_called()


def test_upload_read_requires_its_owner_even_when_completed(monkeypatch):
    monkeypatch.setattr(getGeneration, 'generation_storage', SimpleNamespace(get_generation=AsyncMock(return_value={
        'status': 'completed', 'endpoint': 'uploadLdraw', 'user_type': 'authenticated', 'user_id': 'owner'})))
    with pytest.raises(HTTPException) as error:
        asyncio.run(getGeneration.get_generation(getGeneration.GetGenerationRequest(generation_id='g'), {'authenticated': True, 'user_id': 'other'}))
    assert error.value.status_code == 404


def test_upload_price_is_blocked_without_fetching_inventory(monkeypatch):
    monkeypatch.setattr(getPrice, 'generation_storage', SimpleNamespace(get_generation=AsyncMock(return_value={'endpoint': 'uploadLdraw'})))
    fetch = AsyncMock(); monkeypatch.setattr(getPrice, 'fetch_csv_content', fetch)
    with pytest.raises(HTTPException) as error:
        asyncio.run(getPrice.get_price(getPrice.GetPriceRequest(generation_id='g'), {}))
    assert error.value.status_code == 409
    fetch.assert_not_called()


@pytest.mark.parametrize('owner', [True, False])
def test_nova_edit_imports_only_owned_uploads(monkeypatch, owner):
    storage = SimpleNamespace(get_generation=AsyncMock(return_value={'user_id': 'owner', 'user_type': 'authenticated',
        'status': 'completed', 'endpoint': 'uploadLdraw', 'ldr_url': 'source'}), download_file_from_storage=AsyncMock(return_value=BRICK.encode()))
    monkeypatch.setattr(novaToBricks, 'generation_storage', storage)
    session = AsyncMock(); monkeypatch.setattr(novaToBricks, '_owned_session', session)
    request = novaToBricks.NovaToBricksRequest(prompt='Make it blue', source_generation_id='g')
    if owner:
        asyncio.run(novaToBricks._prepare_edit(request, {'authenticated': True, 'user_id': 'owner'}))
        assert request._nova_source_ldr == BRICK and request._nova_uploaded_source is True
        session.assert_not_called()
    else:
        with pytest.raises(HTTPException) as error:
            asyncio.run(novaToBricks._prepare_edit(request, {'authenticated': True, 'user_id': 'other'}))
        assert error.value.status_code == 404
        storage.download_file_from_storage.assert_not_called()


def test_upload_response_marks_geometry_unorderable_and_all_parts(monkeypatch):
    monkeypatch.setattr(getGeneration, 'generation_storage', SimpleNamespace(get_generation=AsyncMock(return_value={
        'status': 'completed', 'endpoint': 'uploadLdraw', 'user_type': 'authenticated', 'user_id': 'owner', 'ldr_url': 'source'}),
        download_file_from_storage=AsyncMock(return_value=BRICK.encode())))
    response = asyncio.run(getGeneration.get_generation(getGeneration.GetGenerationRequest(generation_id='g'), {'authenticated': True, 'user_id': 'owner'}))
    assert response.orderable is False and response.mode == 'all_parts'
    assert response.ldr_content == BRICK
