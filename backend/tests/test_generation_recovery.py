import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pgserver
import psycopg
import pytest

from src.utils.generation_recovery import recover_stale_generations, INTERRUPTED
from src.utils.generation_storage import GenerationStorage
from src.utils.local_db import LocalSupabaseClient, _create_schema


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    instance = pgserver.get_server(tmp_path_factory.mktemp("recovery-postgres"), cleanup_mode="delete")
    yield instance
    instance.cleanup()


@pytest.fixture
def storage(server, tmp_path):
    with psycopg.connect(server.get_uri(), autocommit=True) as conn:
        conn.execute('DROP TABLE IF EXISTS generations CASCADE')
        _create_schema(conn)
        value = GenerationStorage.__new__(GenerationStorage)
        value.client = LocalSupabaseClient(conn, tmp_path, 'http://localhost:8002')
        yield value


def save(storage, snapshot=None, **fields):
    old = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    row = {'id': str(uuid4()), 'user_id': 'owner', 'user_type': 'authenticated',
           'status': 'processing', 'endpoint': 'novaToBricks', 'created_at': old,
           'updated_at': old, **fields}
    storage.client.table('generations').insert(row).execute()
    if snapshot is not None:
        storage.client.storage.from_('generation-output').upload(
            path=f"{row['id']}/llm-output.json", file=json.dumps(snapshot).encode())
    return row['id']


def read(storage, job):
    return storage.client.table('generations').select('*').eq('id', job).execute().data[0]


@pytest.mark.parametrize('status', ['completed', 'failed', 'cancelled'])
def test_late_heartbeat_never_revives_terminal_job(storage, status):
    job = save(storage, status=status)
    before = read(storage, job)
    asyncio.run(storage.heartbeat(job))
    assert read(storage, job) == before


def test_heartbeat_updates_only_live_job_and_prevents_recovery(storage):
    job = save(storage)
    before = read(storage, job)['updated_at']
    asyncio.run(storage.heartbeat(job))
    assert read(storage, job)['updated_at'] != before
    assert asyncio.run(recover_stale_generations(storage)) == 0
    assert read(storage, job)['status'] == 'processing'


def test_recovery_restores_completed_artifacts_and_original_duration(storage):
    job = save(storage, {'status': 'completed'}, ldr_url='model', parts_list_csv_url='parts',
               generation_duration_seconds=425.2)
    assert asyncio.run(recover_stale_generations(storage)) == 1
    row = read(storage, job)
    assert row['status'] == 'completed'
    assert row['generation_duration_seconds'] == 425.2
    assert asyncio.run(recover_stale_generations(storage)) == 0


@pytest.mark.parametrize('snapshot,error', [
    ({'status': 'failed', 'error': 'Provider disconnected'}, 'Provider disconnected'),
    ({'status': 'processing'}, INTERRUPTED),
    ({'status': 'completed'}, INTERRUPTED),
    (None, INTERRUPTED),
])
def test_recovery_fails_interrupted_or_incomplete_jobs_without_fabricating_completion(storage, snapshot, error):
    job = save(storage, snapshot)
    assert asyncio.run(recover_stale_generations(storage)) == 1
    row = read(storage, job)
    assert row['status'] == 'failed' and row['error_message'] == error


@pytest.mark.parametrize('change', [
    {'status': 'cancelled'}, {'status': 'completed'},
    {'updated_at': datetime.now(timezone.utc).isoformat()},
])
def test_recovery_does_not_overwrite_concurrent_worker_or_cancellation(storage, monkeypatch, change):
    job = save(storage, {'status': 'processing'})
    bucket = storage.client.storage.from_('generation-output')
    original = bucket.download
    def download(path):
        storage.client.table('generations').update(change).eq('id', job).execute()
        return original(path)
    monkeypatch.setattr(storage.client, 'storage', SimpleNamespace(from_=lambda _: SimpleNamespace(download=download)))
    assert asyncio.run(recover_stale_generations(storage)) == 0
    assert all(read(storage, job)[key] == value for key, value in change.items())


def test_storage_outage_does_not_fail_jobs(storage, monkeypatch):
    job = save(storage)
    monkeypatch.setattr(storage.client, 'storage', SimpleNamespace(from_=lambda _: SimpleNamespace(
        download=Mock(side_effect=ConnectionError('unavailable')))))
    assert asyncio.run(recover_stale_generations(storage)) == 0
    assert read(storage, job)['status'] == 'processing'


def test_recovery_ignores_other_pipelines_and_terminal_jobs(storage):
    jobs = [save(storage, endpoint='textToBricks'), save(storage, status='cancelled'),
            save(storage, status='resizing', user_id='other-owner'), save(storage, status='completed')]
    before = [read(storage, job) for job in jobs]
    assert asyncio.run(recover_stale_generations(storage)) == 0
    assert [read(storage, job) for job in jobs] == before
