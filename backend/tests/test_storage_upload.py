import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from src.utils import storage_upload


@pytest.mark.parametrize('failure', [httpx.RemoteProtocolError('Server disconnected'),
    httpx.ReadTimeout('Timed out'), SimpleNamespace])
def test_retries_transient_uploads_with_identical_upserts(monkeypatch, failure):
    if failure is SimpleNamespace:
        failure = httpx.HTTPStatusError('Temporary failure', request=httpx.Request('POST', 'https://storage.test'),
                                       response=httpx.Response(503))
    upload = Mock(side_effect=[failure, 'saved'])
    sleep = AsyncMock()
    monkeypatch.setattr(storage_upload, 'retry_sleep', sleep)
    assert asyncio.run(storage_upload.upload_artifact(SimpleNamespace(upload=upload),
        path='id/source.zip', file=b'zip', content_type='application/zip')) == 'saved'
    assert upload.call_count == 2
    assert upload.call_args_list[0] == upload.call_args_list[1]
    assert upload.call_args.kwargs['file_options']['upsert'] == 'true'
    sleep.assert_awaited_once_with(1)


def test_stops_after_four_attempts(monkeypatch):
    upload = Mock(side_effect=httpx.RemoteProtocolError('Server disconnected'))
    monkeypatch.setattr(storage_upload, 'retry_sleep', AsyncMock())
    with pytest.raises(httpx.RemoteProtocolError):
        asyncio.run(storage_upload.upload_artifact(SimpleNamespace(upload=upload), path='file', file=b'x', content_type='text/plain'))
    assert upload.call_count == 4


def test_does_not_retry_permanent_errors(monkeypatch):
    upload = Mock(side_effect=ValueError('Invalid file'))
    sleep = AsyncMock()
    monkeypatch.setattr(storage_upload, 'retry_sleep', sleep)
    with pytest.raises(ValueError):
        asyncio.run(storage_upload.upload_artifact(SimpleNamespace(upload=upload), path='file', file=b'x', content_type='text/plain'))
    assert upload.call_count == 1
    sleep.assert_not_awaited()
