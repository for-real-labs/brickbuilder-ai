import asyncio
import io
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from src.requests import novaInstructions as module


def storage(row, bucket):
    return SimpleNamespace(get_generation=AsyncMock(return_value=row),
                           client=SimpleNamespace(storage=SimpleNamespace(from_=lambda _: bucket)))


@pytest.mark.parametrize('row', [None, {'status': 'processing', 'endpoint': 'novaToBricks'},
                                    {'status': 'failed', 'endpoint': 'novaToBricks'},
                                    {'status': 'completed', 'endpoint': 'llmToBricks'}])
def test_only_completed_nova_model_geometry_is_available(monkeypatch, row):
    monkeypatch.setattr(module, 'generation_storage', storage(row, None))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(module.get_nova_instructions('generation'))
    assert exc.value.status_code == 404


def test_finished_model_reads_cached_steps_without_reading_private_source(monkeypatch):
    reads = []
    class Bucket:
        def download(self, path):
            reads.append(path)
            return b'0 FILE model.ldr\n0 STEP\n0 STEP'
    monkeypatch.setattr(module, 'generation_storage', storage({'status': 'completed', 'endpoint': 'novaToBricks'}, Bucket()))
    response = asyncio.run(module.get_nova_instructions('generation'))
    assert response.body.count(b'0 STEP') == 2
    assert reads == ['generation/nova-instructions-reviewed-v1.ldr']


def test_existing_models_use_the_original_nova_hierarchy_and_cache_only_steps(monkeypatch):
    source = '0 FILE main.ldr\n0 STEP\n0 FILE roof.ldr\n0 STEP'
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as zipped:
        zipped.writestr('model.mpd', source)
        zipped.writestr('model.ldr', 'flat placements')
        zipped.writestr('conversation.json', 'PRIVATE CONVERSATION')
    writes, sources = [], []
    class Bucket:
        def download(self, path):
            if path.endswith('.ldr'): raise FileNotFoundError()
            return archive.getvalue()
        def upload(self, **kwargs): writes.append(kwargs)
    class Service:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def instructions(self, original):
            sources.append(original)
            return 'physical construction placements\n0 STEP\n0 STEP'
    monkeypatch.setattr(module, 'generation_storage', storage({'status': 'completed', 'endpoint': 'novaToBricks'}, Bucket()))
    monkeypatch.setattr(module, 'NovaService', Service)
    response = asyncio.run(module.get_nova_instructions('generation'))
    assert sources == [source]
    assert response.body.count(b'0 STEP') == 2
    assert b'PRIVATE' not in response.body
    assert writes[0]['path'] == 'generation/nova-instructions-reviewed-v1.ldr'
    assert writes[0]['file'] == response.body


def test_old_unchecked_cache_cannot_bypass_failed_review(monkeypatch):
    from src.utils.nova_service import NovaBuildReviewError
    reads, writes = [], []
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as zipped:
        zipped.writestr('model.mpd', 'original')
        zipped.writestr('model.ldr', 'flat')
    class Bucket:
        def download(self, path):
            reads.append(path)
            if path.endswith('nova-instructions.ldr'): return b'old unchecked cache'
            if path.endswith('.zip'): return archive.getvalue()
            raise FileNotFoundError()
        def upload(self, **kwargs): writes.append(kwargs)
    class Service:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def instructions(self, source):
            raise NovaBuildReviewError('Nova build review failed. Repair disconnected parts.')
    monkeypatch.setattr(module, 'generation_storage', storage({'status': 'completed', 'endpoint': 'novaToBricks'}, Bucket()))
    monkeypatch.setattr(module, 'NovaService', Service)
    with pytest.raises(HTTPException) as error:
        asyncio.run(module.get_nova_instructions('generation'))
    assert error.value.status_code == 409
    assert 'Repair disconnected' in error.value.detail
    assert reads == ['generation/nova-instructions-reviewed-v1.ldr', 'generation/nova-source.zip']
    assert writes == []
