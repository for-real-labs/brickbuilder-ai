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
            conn.execute((Path(__file__).parents[2] / 'supabase/migrations/20261021010000_generation_concurrency_limit_5.sql').read_text())

    def insert(index, owner='owner', status='processing'):
        with psycopg.connect(uri, autocommit=True) as conn:
            row = {'id': str(uuid4()), 'user_id': owner, 'user_type': 'authenticated',
                   'endpoint': ['llmToBricks', 'novaToBricks', 'textToBricks', 'imageToBricks', 'glbToBricks', 'objToBricks'][index % 6], 'status': status}
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
    assert sum(outcomes) == 5
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
    assert exc.value.status_code == 429 and '5 generations' in exc.value.detail


@pytest.mark.parametrize('local', [False, True])
def test_daily_limit_is_atomic_persistent_and_resets(server, tmp_path, local):
    uri = server.get_uri()
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute('DROP TABLE IF EXISTS generations CASCADE; DROP TABLE IF EXISTS generation_daily_usage')
        if local:
            _create_schema(conn)
        else:
            for role in ('anon', 'authenticated', 'service_role'):
                if not conn.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (role,)).fetchone():
                    conn.execute(f'CREATE ROLE {role}')
            conn.execute('CREATE TABLE generations (id uuid primary key, user_id text, user_type text, endpoint text, status text, created_at timestamptz DEFAULT now())')
            # Existing attempts count immediately after migration.
            conn.execute("INSERT INTO generations SELECT gen_random_uuid(), 'owner', 'authenticated', 'llmToBricks', 'failed', now() FROM generate_series(1, 28)")
            conn.execute((Path(__file__).parents[2] / 'supabase/migrations/20261020000000_generation_daily_limit.sql').read_text())
            conn.execute("INSERT INTO generation_daily_usage VALUES ('over-limit', 'authenticated', (now() AT TIME ZONE 'UTC')::date, 90)")
            conn.execute((Path(__file__).parents[2] / 'supabase/migrations/20261021000000_generation_daily_limit_30.sql').read_text())
        if local:
            conn.execute("INSERT INTO generation_daily_usage VALUES ('owner', 'authenticated', (now() AT TIME ZONE 'UTC')::date, 28)")

    def insert(index, owner='owner', user_type='authenticated'):
        with psycopg.connect(uri, autocommit=True) as conn:
            row = {'id': str(uuid4()), 'user_id': owner, 'user_type': user_type,
                   'endpoint': ['llmToBricks', 'novaToBricks', 'textToBricks', 'imageToBricks'][index % 4],
                   'status': 'failed' if index % 2 else 'cancelled'}
            try:
                if local:
                    LocalSupabaseClient(conn, tmp_path, 'http://localhost').table('generations').insert(row).execute()
                else:
                    conn.execute('INSERT INTO generations (id,user_id,user_type,endpoint,status) VALUES (%s,%s,%s,%s,%s)', tuple(row.values()))
                return True
            except psycopg.errors.RaiseException as exc:
                assert 'BB_GENERATION_DAILY_LIMIT' in str(exc)
                return False

    with ThreadPoolExecutor(max_workers=12) as workers:
        outcomes = list(workers.map(insert, range(12)))
        with psycopg.connect(uri, autocommit=True) as conn:
            assert sum(outcomes) == 2, conn.execute('SELECT *, now() FROM generation_daily_usage').fetchall()
    assert not insert(0)
    if not local:
        assert not insert(0, 'over-limit')  # Lowering the quota preserves already-consumed attempts.
    assert insert(0, 'another-owner')
    assert insert(0, user_type='anonymous')
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute('DELETE FROM generations')
    assert not insert(0)  # Deleting history cannot restore the quota.
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute("UPDATE generation_daily_usage SET usage_day = usage_day - 1")
    assert insert(0)


def test_storage_returns_actionable_429_for_daily_limit():
    class Table:
        def insert(self, row): return self
        def execute(self): raise ValueError('BB_GENERATION_DAILY_LIMIT')
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = SimpleNamespace(table=lambda name: Table())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(storage.create_generation('owner', 'authenticated', 'cube', 40))
    assert exc.value.status_code == 429
    assert '30 generations' in exc.value.detail
    from datetime import datetime, timedelta, timezone
    from email.utils import parsedate_to_datetime
    reset_at = parsedate_to_datetime(exc.value.headers['Retry-After'])
    assert reset_at == (datetime.now(timezone.utc) + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    assert 'Please wait until' in exc.value.detail
    assert 'UTC' in exc.value.detail


@pytest.mark.parametrize('module_name,function_name,request_name', [
    ('textToBricks', 'text_to_bricks', 'TextToBricksRequest'),
    ('textToBricks', 'text_to_bricks_stream', 'TextToBricksRequest'),
    ('imageToBricks', 'image_to_bricks', 'ImageToBricksRequest'),
    ('imageToBricks', 'image_to_bricks_stream', 'ImageToBricksRequest'),
])
def test_generation_routes_preserve_daily_limit_response(monkeypatch, module_name, function_name, request_name):
    import importlib
    from unittest.mock import AsyncMock, Mock

    module = importlib.import_module(f'src.requests.{module_name}')
    limit = HTTPException(status_code=429, detail='Daily limit of 30 generations; resets at midnight UTC.')
    monkeypatch.setattr(module, 'handle_auth_and_tracking', lambda **_: {
        'user_email': 'owner@example.com', 'is_anonymous': False, 'is_developer': False})
    monkeypatch.setattr(module, 'generation_storage', SimpleNamespace(create_generation=AsyncMock(side_effect=limit)))
    start = Mock()
    monkeypatch.setattr(module, 'start_generation_task', start)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(getattr(module, function_name)(getattr(module, request_name)(prompt='cube'), {'user_id': 'owner'}))
    assert exc.value is limit
    start.assert_not_called()


def test_upload_route_preserves_daily_limit_and_cleans_upload(monkeypatch, tmp_path):
    from io import BytesIO
    from unittest.mock import AsyncMock, Mock
    from fastapi import UploadFile
    from src.requests import glbToBricks as module
    import tempfile

    mkstemp = tempfile.mkstemp
    monkeypatch.setattr(module.tempfile, 'mkstemp', lambda **kwargs: mkstemp(dir=tmp_path, **kwargs))
    monkeypatch.setattr(module, 'handle_auth_and_tracking', lambda **_: {
        'user_email': 'owner@example.com', 'is_anonymous': False, 'is_developer': False})
    limit = HTTPException(status_code=429, detail='Daily limit of 30 generations')
    monkeypatch.setattr(module, 'generation_storage', SimpleNamespace(create_generation=AsyncMock(side_effect=limit)))
    start = Mock()
    monkeypatch.setattr(module, 'start_generation_task', start)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(module.glb_to_bricks(file=UploadFile(filename='cube.glb', file=BytesIO(b'glb')), voxelizer='trimesh', detail_level=40, auth_info={'user_id': 'owner'}))
    assert exc.value is limit
    start.assert_not_called()
    assert not list(tmp_path.iterdir())


def test_lowering_concurrency_limit_preserves_running_jobs(server):
    uri = server.get_uri()
    migrations = Path(__file__).parents[2] / 'supabase/migrations'
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute('DROP TABLE IF EXISTS generations CASCADE')
        conn.execute('CREATE TABLE generations (id uuid primary key, user_id text, user_type text, endpoint text, status text)')
        conn.execute((migrations / '20261005000001_generation_concurrency_limit.sql').read_text())
        for _ in range(10):
            conn.execute("INSERT INTO generations VALUES (%s, 'owner', 'authenticated', 'novaToBricks', 'processing')", (uuid4(),))
        conn.execute((migrations / '20261021010000_generation_concurrency_limit_5.sql').read_text())
        assert conn.execute("SELECT count(*) FROM generations WHERE status='processing'").fetchone()[0] == 10
        with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_CONCURRENCY_LIMIT'):
            conn.execute("INSERT INTO generations VALUES (%s, 'owner', 'authenticated', 'textToBricks', 'started')", (uuid4(),))
        conn.execute("UPDATE generations SET status='completed' WHERE id IN (SELECT id FROM generations LIMIT 6)")
        conn.execute("INSERT INTO generations VALUES (%s, 'owner', 'authenticated', 'textToBricks', 'started')", (uuid4(),))
        with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_CONCURRENCY_LIMIT'):
            conn.execute("INSERT INTO generations VALUES (%s, 'owner', 'authenticated', 'imageToBricks', 'queued')", (uuid4(),))
