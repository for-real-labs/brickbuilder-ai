import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pgserver
import psycopg
import pytest
from fastapi import HTTPException

from src.utils.generation_storage import GenerationStorage
from src.utils.local_db import LocalSupabaseClient, _create_schema


@pytest.fixture(scope='module')
def server(tmp_path_factory):
    instance = pgserver.get_server(tmp_path_factory.mktemp('generation-limits'), cleanup_mode='delete')
    yield instance
    instance.cleanup()


@pytest.mark.parametrize('local', [False, True])
def test_concurrent_admission_is_atomic_shared_between_modes_and_owner_scoped(server, tmp_path, local):
    uri = server.get_uri()
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute('DROP TABLE IF EXISTS generations CASCADE')
        if local:
            _create_schema(conn)
        else:
            conn.execute('CREATE TABLE generations (id uuid primary key, user_id text, user_type text, endpoint text, status text)')
            conn.execute((Path(__file__).parents[2] / 'supabase/migrations/20261005000001_generation_concurrency_limit.sql').read_text())

    def insert(index, owner='owner', status='processing'):
        with psycopg.connect(uri, autocommit=True) as conn:
            row = {'id': str(uuid4()), 'user_id': owner, 'user_type': 'authenticated',
                   'endpoint': 'llmToBricks' if index % 2 else 'novaToBricks', 'status': status}
            try:
                if local:
                    LocalSupabaseClient(conn, tmp_path, 'http://localhost').table('generations').insert(row).execute()
                else:
                    conn.execute('INSERT INTO generations VALUES (%s,%s,%s,%s,%s)', tuple(row.values()))
                return True
            except psycopg.errors.RaiseException as exc:
                assert 'BB_GENERATION_CONCURRENCY_LIMIT' in str(exc)
                return False
    with ThreadPoolExecutor(max_workers=12) as workers:
        outcomes = list(workers.map(insert, range(12)))
    assert sum(outcomes) == 10
    assert insert(1, 'other-owner')
    assert insert(1, status='completed')
    with psycopg.connect(uri, autocommit=True) as conn:
        if local:
            row = conn.execute("SELECT id FROM generations WHERE doc->>'user_id'='owner' AND doc->>'status'='processing' LIMIT 1").fetchone()
            conn.execute("UPDATE generations SET doc = doc || '{\"status\":\"cancelled\"}'::jsonb WHERE id = %s", row)
        else:
            conn.execute("UPDATE generations SET status='cancelled' WHERE id = (SELECT id FROM generations WHERE user_id='owner' AND status='processing' LIMIT 1)")
    assert insert(1)
    assert not insert(2)


def test_storage_returns_actionable_429_for_limit():
    class Table:
        def insert(self, row): return self
        def execute(self): raise ValueError('BB_GENERATION_CONCURRENCY_LIMIT')
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = SimpleNamespace(table=lambda name: Table())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(storage.create_generation('owner', 'authenticated', 'cube', 40, endpoint='llmToBricks'))
    assert exc.value.status_code == 429 and '10 generations' in exc.value.detail
