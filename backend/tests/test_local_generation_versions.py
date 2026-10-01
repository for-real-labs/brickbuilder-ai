"""Local development uses JSONB tables and must match hosted version behavior."""
import asyncio
from uuid import uuid4

import pgserver
import psycopg
import pytest

from src.utils.local_db import LocalSupabaseClient, _create_schema
from src.utils.generation_storage import GenerationStorage


@pytest.fixture(scope="module")
def local_server(tmp_path_factory):
    instance = pgserver.get_server(tmp_path_factory.mktemp("local-versions"), cleanup_mode="delete")
    yield instance
    instance.cleanup()


@pytest.fixture
def local_db(local_server, tmp_path):
    with psycopg.connect(local_server.get_uri(), autocommit=True) as conn:
        conn.execute('DROP TABLE IF EXISTS generations CASCADE')
        _create_schema(conn)
        yield conn, LocalSupabaseClient(conn, tmp_path, 'http://localhost:8002')


def save(client, *, id=None, model_id=None, legacy_parent=None, owner='guest', date='2026-10-01', image=None):
    return client.table('generations').insert({
        'id': id or str(uuid4()), 'generation_id': model_id, 'source_generation_id': legacy_parent, 'user_id': owner,
        'user_type': 'anonymous', 'status': 'completed', 'created_at': date,
        'processed_image_url': image,
    }).execute().data[0]


def test_embedded_generations_share_versions_and_latest_dashboard_queries(local_db):
    _conn, client = local_db
    root = save(client, image='same')
    independent = save(client, image='same')
    for version in range(2, 13):
        latest = save(client, model_id=root['id'])
        assert latest['generation_id'] == root['id'] and latest['version'] == version
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = client
    history = asyncio.run(storage.get_generation_versions(root['id'], 'guest', 'anonymous'))
    assert [row['version'] for row in history] == list(range(12, 0, -1))
    assert all('source_generation_id' not in row for row in history)
    assert asyncio.run(storage.count_user_generations('guest', 'anonymous')) == 2
    dashboard = asyncio.run(storage.get_user_generations('guest', 'anonymous'))
    assert {row['id'] for row in dashboard} == {latest['id'], independent['id']}
    assert [row['version'] for row in client.table('generations').select('*')
            .eq('generation_id', root['id']).gt('version', 9).order('version', desc=True).execute().data] == [12, 11, 10]
    with pytest.raises(psycopg.errors.RaiseException):
        save(client, model_id=root['id'], owner='other')


def test_embedded_schema_backfills_explicit_parent_prompt_and_image_free_edits(local_db):
    conn, client = local_db
    conn.execute('DROP TRIGGER generations_assign_local_version ON generations')
    root = save(client, image='same', date='2026-09-01')
    independent = save(client, image='same', date='2026-09-02')
    manual = save(client, date='2026-09-03')
    client.table('generations').update({'prompt': f"Updated model from {root['id']}", 'endpoint': 'updateModel', 'processed_image_url': 'same'}).eq('id', manual['id']).execute()
    llm = save(client, legacy_parent=manual['id'], date='2026-09-04')
    _create_schema(conn)
    rows = client.table('generations').select('*').eq('generation_id', root['id']).order('version').execute().data
    assert [row['id'] for row in rows] == [root['id'], manual['id'], llm['id']]
    assert [row['version'] for row in rows] == [1, 2, 3]
    assert client.table('generations').select('*').eq('id', independent['id']).execute().data[0]['version'] == 1
    assert all('source_generation_id' not in row for row in client.table('generations').select('*').execute().data)
    _create_schema(conn)  # reinitializing must preserve assigned versions
    assert save(client, model_id=root['id'])['version'] == 4


def test_embedded_dashboard_orders_by_time_then_id_after_selecting_latest(local_db):
    _conn, client = local_db
    save(client, id='ffffffff-ffff-ffff-ffff-ffffffffffff', date='2026-09-01')
    newer = save(client, id='00000000-0000-0000-0000-000000000000', date='2026-10-01')
    # Make the older ID sort after the newer ID, so ordering solely by ID fails.
    rows = client.table('latest_generations').select('*').order('created_at', desc=True).order('id', desc=True).execute().data
    assert rows[0]['id'] == newer['id']


def test_previous_completed_revision_skips_cancelled_failed_active_and_other_models(local_db):
    _conn, client = local_db
    root = save(client)
    completed = save(client, model_id=root['id'])
    for status in ['failed', 'cancelled', 'processing']:
        row = save(client, model_id=root['id'])
        client.table('generations').update({'status': status}).eq('id', row['id']).execute()
    current = save(client, model_id=root['id'])
    save(client)  # unrelated completed model must not be the fallback
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = client
    assert asyncio.run(storage.get_previous_completed_generation(current))['id'] == completed['id']
    assert asyncio.run(storage.get_previous_completed_generation(root)) is None
