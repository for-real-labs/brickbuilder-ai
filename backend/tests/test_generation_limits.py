import asyncio
import hashlib
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
@pytest.mark.parametrize('active_status', ['queued', 'started', 'processing', 'ldr_processing', 'resizing'])
def test_concurrent_admission_is_atomic_shared_between_modes_and_owner_scoped(server, tmp_path, local, active_status):
    uri = server.get_uri()
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute('DROP TABLE IF EXISTS generations CASCADE; DROP TABLE IF EXISTS generation_daily_usage; DROP TABLE IF EXISTS generation_daily_limit_overrides')
        if local:
            _create_schema(conn)
        else:
            conn.execute('CREATE TABLE generations (id uuid primary key, user_id text, user_type text, endpoint text, status text)')
            conn.execute((Path(__file__).parents[2] / 'supabase/migrations/20261022010000_generation_concurrency_limit_1.sql').read_text())

    def insert(index, owner='owner', status=active_status):
        with psycopg.connect(uri, autocommit=True) as conn:
            row = {'id': str(uuid4()), 'user_id': owner, 'user_type': 'authenticated',
                   'endpoint': ['llmToBricks', 'novaToBricks', 'textToBricks', 'imageToBricks', 'glbToBricks', 'objToBricks'][index % 6], 'status': status}
            try:
                if local:
                    row['guest_ip_hash'] = 'ip_v1_' + hashlib.sha256(owner.encode()).hexdigest()
                    LocalSupabaseClient(conn, tmp_path, 'http://localhost').table('generations').insert(row).execute()
                else:
                    conn.execute('INSERT INTO generations VALUES (%s,%s,%s,%s,%s)', tuple(row.values()))
                return True
            except psycopg.errors.RaiseException as exc:
                assert 'BB_GENERATION_CONCURRENCY_LIMIT' in str(exc)
                return False
    with ThreadPoolExecutor(max_workers=12) as workers:
        outcomes = list(workers.map(insert, range(12)))
    assert sum(outcomes) == 1
    assert insert(1, 'other-owner')
    assert insert(1, status='completed')
    with psycopg.connect(uri, autocommit=True) as conn:
        if local:
            row = conn.execute("SELECT id FROM generations WHERE doc->>'user_id'='owner' AND doc->>'status'=%s LIMIT 1", (active_status,)).fetchone()
            conn.execute("UPDATE generations SET doc = doc || '{\"status\":\"cancelled\"}'::jsonb WHERE id = %s", row)
        else:
            conn.execute("UPDATE generations SET status='cancelled' WHERE id = (SELECT id FROM generations WHERE user_id='owner' AND status=%s LIMIT 1)", (active_status,))
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
    assert exc.value.status_code == 429 and 'one generation' in exc.value.detail


@pytest.mark.parametrize('local', [False, True])
def test_daily_limit_is_atomic_persistent_and_resets(server, tmp_path, local):
    uri = server.get_uri()
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute('DROP TABLE IF EXISTS generations CASCADE; DROP TABLE IF EXISTS generation_daily_usage; DROP TABLE IF EXISTS generation_daily_limit_overrides')
        if local:
            _create_schema(conn)
        else:
            for role in ('anon', 'authenticated', 'service_role'):
                if not conn.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (role,)).fetchone():
                    conn.execute(f'CREATE ROLE {role}')
            conn.execute('CREATE TABLE generations (id uuid primary key, user_id text, user_type text, endpoint text, status text, created_at timestamptz DEFAULT now())')
            # Existing attempts count immediately after migration.
            conn.execute("INSERT INTO generations SELECT gen_random_uuid(), 'owner', 'authenticated', 'llmToBricks', 'failed', now() FROM generate_series(1, 8)")
            conn.execute((Path(__file__).parents[2] / 'supabase/migrations/20261020000000_generation_daily_limit.sql').read_text())
            conn.execute("INSERT INTO generation_daily_usage VALUES ('over-limit', 'authenticated', (now() AT TIME ZONE 'UTC')::date, 90)")
            conn.execute((Path(__file__).parents[2] / 'supabase/migrations/20261021000000_generation_daily_limit_30.sql').read_text())
            for name in ('20261022020000_account_generation_limits.sql', '20261022040000_ten_daily_generation_limit.sql'):
                conn.execute('CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users (id text PRIMARY KEY, email text, email_confirmed_at timestamptz, is_anonymous boolean DEFAULT false)')
                conn.execute('DROP TABLE IF EXISTS generation_daily_email_exemptions')
                conn.execute((Path(__file__).parents[2] / 'supabase/migrations' / name).read_text())
        if local:
            conn.execute("INSERT INTO generation_daily_usage VALUES ('owner', 'authenticated', (now() AT TIME ZONE 'UTC')::date, 8)")

    def insert(index, owner='owner', user_type='authenticated'):
        with psycopg.connect(uri, autocommit=True) as conn:
            row = {'id': str(uuid4()), 'user_id': owner, 'user_type': user_type,
                   'endpoint': ['llmToBricks', 'novaToBricks', 'textToBricks', 'imageToBricks'][index % 4],
                   'status': 'failed' if index % 2 else 'cancelled'}
            try:
                if local:
                    row['guest_ip_hash'] = 'ip_v1_' + hashlib.sha256(owner.encode()).hexdigest()
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
    assert '10 generations' in exc.value.detail
    from datetime import datetime, timedelta, timezone
    from email.utils import parsedate_to_datetime
    reset_at = parsedate_to_datetime(exc.value.headers['Retry-After'])
    assert reset_at == (datetime.now(timezone.utc) + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    assert 'Please wait until' in exc.value.detail
    assert 'UTC' in exc.value.detail


@pytest.mark.parametrize('module_name,function_name,request_name', [
    ('llmToBricks', 'llm_to_bricks', 'LlmToBricksRequest'),
    ('llmToBricks', 'llm_to_bricks_stream', 'LlmToBricksRequest'),
    ('textToBricks', 'text_to_bricks', 'TextToBricksRequest'),
    ('textToBricks', 'text_to_bricks_stream', 'TextToBricksRequest'),
    ('imageToBricks', 'image_to_bricks', 'ImageToBricksRequest'),
    ('imageToBricks', 'image_to_bricks_stream', 'ImageToBricksRequest'),
])
@pytest.mark.parametrize('status,detail', [(429, 'Daily limit of 30 generations; resets at midnight UTC.'),
                                         (403, 'You have used your 3 free guest generations. Sign in to keep building.')])
def test_generation_routes_preserve_limit_response(monkeypatch, module_name, function_name, request_name, status, detail):
    import importlib
    from unittest.mock import AsyncMock, Mock

    module = importlib.import_module(f'src.requests.{module_name}')
    limit = HTTPException(status_code=status, detail=detail)
    monkeypatch.setattr(module, 'handle_auth_and_tracking', lambda **_: {
        'user_email': 'owner@example.com', 'is_anonymous': False, 'is_developer': False})
    monkeypatch.setattr(module, 'generation_storage', SimpleNamespace(create_generation=AsyncMock(side_effect=limit)))
    start = Mock()
    monkeypatch.setattr(module, 'start_generation_task', start)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(getattr(module, function_name)(getattr(module, request_name)(prompt='cube'), {'user_id': 'owner', 'rate_limit_id': 'ip_v1_' + 'a' * 64}))
    assert exc.value is limit
    assert module.generation_storage.create_generation.await_args.kwargs['guest_ip_hash'] == 'ip_v1_' + 'a' * 64
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
        conn.execute((migrations / '20261022010000_generation_concurrency_limit_1.sql').read_text())
        assert conn.execute("SELECT count(*) FROM generations WHERE status='processing'").fetchone()[0] == 10
        with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_CONCURRENCY_LIMIT'):
            conn.execute("INSERT INTO generations VALUES (%s, 'owner', 'authenticated', 'textToBricks', 'started')", (uuid4(),))
        conn.execute("UPDATE generations SET status='completed' WHERE id IN (SELECT id FROM generations LIMIT 10)")
        conn.execute("INSERT INTO generations VALUES (%s, 'owner', 'authenticated', 'textToBricks', 'started')", (uuid4(),))
        with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_CONCURRENCY_LIMIT'):
            conn.execute("INSERT INTO generations VALUES (%s, 'owner', 'authenticated', 'imageToBricks', 'queued')", (uuid4(),))


@pytest.fixture(params=[False, True])
def guest_trial_db(server, tmp_path, request):
    local = request.param
    uri = server.get_uri()
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute('DROP TABLE IF EXISTS generations CASCADE; DROP TABLE IF EXISTS generation_daily_usage; DROP TABLE IF EXISTS generation_guest_usage; DROP TABLE IF EXISTS anonymous_users')
        if local:
            _create_schema(conn)
        else:
            for role in ('anon', 'authenticated', 'service_role'):
                if not conn.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (role,)).fetchone():
                    conn.execute(f'CREATE ROLE {role}')
            conn.execute('CREATE TABLE generations (id uuid primary key, user_id text, user_type text, endpoint text, status text, created_at timestamptz DEFAULT now())')
            # Match the deployed legacy table's 32-character hash column.
            conn.execute('CREATE TABLE anonymous_users (id serial primary key, ip_hash varchar(32) UNIQUE NOT NULL, call_count integer NOT NULL DEFAULT 0, first_call timestamptz NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())')
            conn.execute("INSERT INTO anonymous_users (ip_hash, call_count, first_call) VALUES (%s, 42, now())", ('f' * 32,))
            migrations = Path(__file__).parents[2] / 'supabase/migrations'
            for name in ('20261020000000_generation_daily_limit.sql', '20261021000000_generation_daily_limit_30.sql',
                         '20261021010000_generation_concurrency_limit_5.sql', '20261021020000_guest_generation_lifetime_limit.sql',
                         '20261021030000_guest_ip_generation_limit.sql'):
                conn.execute((migrations / name).read_text())

    def insert(index, owner='guest_trial', user_type='anonymous', status='cancelled', network='default'):
        with psycopg.connect(uri, autocommit=True) as conn:
            row = {'id': str(uuid4()), 'user_id': owner, 'user_type': user_type,
                   'endpoint': ['llmToBricks', 'novaToBricks', 'textToBricks', 'imageToBricks'][index % 4], 'status': status,
                   'guest_ip_hash': 'ip_v1_' + hashlib.sha256(owner.encode()).hexdigest() if network == 'default' else network}
            if local:
                LocalSupabaseClient(conn, tmp_path, 'http://localhost').table('generations').insert(row).execute()
            else:
                conn.execute('INSERT INTO generations (id,user_id,user_type,endpoint,status,guest_ip_hash) VALUES (%s,%s,%s,%s,%s,%s)', tuple(row.values()))

    return uri, local, insert


def test_guest_trial_is_atomic_lifetime_and_survives_claims_and_deletion(guest_trial_db):
    uri, local, insert = guest_trial_db

    def attempt(index):
        try:
            insert(index, status='failed' if index % 2 else 'cancelled')
            return True
        except psycopg.errors.RaiseException as exc:
            assert 'BB_GENERATION_GUEST_LIMIT' in str(exc)
            return False

    with ThreadPoolExecutor(max_workers=12) as workers:
        assert sum(workers.map(attempt, range(12))) == 3
    with psycopg.connect(uri, autocommit=True) as conn:
        assert conn.execute("SELECT attempts FROM generation_guest_usage WHERE user_id='guest_trial'").fetchone()[0] == 3
        # Signing in and claiming existing models cannot replenish the guest trial.
        if local:
            conn.execute("UPDATE generations SET doc = doc || '{\"user_id\":\"account\",\"user_type\":\"authenticated\"}'::jsonb")
        else:
            conn.execute("UPDATE generations SET user_id='account', user_type='authenticated'")
        conn.execute('DELETE FROM generations')
        conn.execute('UPDATE generation_daily_usage SET usage_day = usage_day - 1')
    assert not attempt(0)
    for index in range(4):
        insert(index, user_type='authenticated')  # Signed-in users retain their daily quota.
    insert(0, owner='another_guest')


def test_guest_trial_backfills_history_and_preserves_spent_counters(guest_trial_db):
    uri, local, insert = guest_trial_db
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute('DROP TRIGGER generations_0_guest_limit ON generations')
        conn.execute('DROP TRIGGER generations_daily_limit ON generations')
    for index in range(4):
        insert(index, owner='old_guest')
    for index in range(2):
        insert(index, owner='partial_guest')
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute("INSERT INTO generation_daily_usage VALUES ('partial_guest', 'anonymous', CURRENT_DATE, 2), ('deleted_guest', 'anonymous', CURRENT_DATE - 2, 2), ('deleted_guest', 'anonymous', CURRENT_DATE - 1, 1)")
        if local:
            from src.utils.local_db import _create_local_guest_generation_limit
            _create_local_guest_generation_limit(conn)
        else:
            conn.execute((Path(__file__).parents[2] / 'supabase/migrations/20261021020000_guest_generation_lifetime_limit.sql').read_text())
        counters = dict(conn.execute('SELECT user_id, attempts FROM generation_guest_usage').fetchall())
        assert counters == {'old_guest': 4, 'partial_guest': 2, 'deleted_guest': 3}
    insert(0, owner='partial_guest')  # Backfill must not count the same attempts twice.
    for owner in ('old_guest', 'partial_guest', 'deleted_guest'):
        with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_GUEST_LIMIT'):
            insert(0, owner=owner)


def test_storage_returns_sign_in_guidance_for_guest_limit():
    class Table:
        def insert(self, row): return self
        def execute(self): raise ValueError('BB_GENERATION_GUEST_LIMIT')
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = SimpleNamespace(table=lambda name: Table())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(storage.create_generation('guest', 'anonymous', 'cube', 40))
    assert exc.value.status_code == 403
    assert exc.value.detail == 'You have used your 3 free guest generations. Sign in to keep building.'
    assert not exc.value.headers  # Waiting until tomorrow does not renew the trial.


def test_shared_ip_cannot_reset_trial_with_new_browser_sessions(guest_trial_db):
    uri, local, insert = guest_trial_db
    network = 'ip_v1_' + 'a' * 64

    def attempt(index):
        try:
            insert(index, owner=f'new-browser-{index}', network=network)
            return True
        except psycopg.errors.RaiseException as exc:
            assert 'BB_GENERATION_GUEST_LIMIT' in str(exc)
            return False

    with ThreadPoolExecutor(max_workers=12) as workers:
        assert sum(workers.map(attempt, range(12))) == 3
    with psycopg.connect(uri, autocommit=True) as conn:
        query = "SELECT (doc->>'call_count')::integer FROM anonymous_users WHERE doc->>'ip_hash'=%s" if local else 'SELECT call_count FROM anonymous_users WHERE ip_hash=%s'
        assert conn.execute(query, (network,)).fetchone()[0] == 3
        assert conn.execute('SELECT sum(attempts) FROM generation_guest_usage').fetchone()[0] == 3
        query = "SELECT count(*) FROM generations WHERE doc ? 'guest_ip_hash'" if local else 'SELECT count(*) FROM generations WHERE guest_ip_hash IS NOT NULL'
        assert conn.execute(query).fetchone()[0] == 0  # Network hashes never appear in model output/history.
        conn.execute('DELETE FROM generations')
        conn.execute('UPDATE generation_daily_usage SET usage_day = usage_day - 1')
    assert not attempt(100)
    insert(0, owner='signed-in', user_type='authenticated', network=network)
    insert(0, owner='different-network', network='ip_v1_' + 'b' * 64)


def test_browser_limit_cannot_reset_by_changing_network(guest_trial_db):
    uri, local, insert = guest_trial_db
    for digit in 'abc':
        insert(0, network='ip_v1_' + digit * 64)
    with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_GUEST_LIMIT'):
        insert(0, network='ip_v1_' + 'd' * 64)
    with psycopg.connect(uri, autocommit=True) as conn:
        query = "SELECT count(*) FROM anonymous_users WHERE doc->>'identity_type'='ip_v1'" if local else "SELECT count(*) FROM anonymous_users WHERE identity_type='ip_v1'"
        assert conn.execute(query).fetchone()[0] == 3


@pytest.mark.parametrize('network', [None, 'guest_' + 'a' * 64, 'a' * 32, '192.0.2.1'])
def test_guest_network_identity_cannot_be_omitted_or_use_legacy_keys(guest_trial_db, network):
    uri, local, insert = guest_trial_db
    with pytest.raises(psycopg.errors.RaiseException, match='BB_GENERATION_GUEST_IP_REQUIRED'):
        insert(0, network=network)
    with psycopg.connect(uri, autocommit=True) as conn:
        assert conn.execute('SELECT count(*) FROM generation_guest_usage').fetchone()[0] == 0


def test_legacy_anonymous_rows_are_not_confused_with_network_or_browser_identity(guest_trial_db):
    uri, local, insert = guest_trial_db
    with psycopg.connect(uri, autocommit=True) as conn:
        if local:
            conn.execute("INSERT INTO anonymous_users (doc) VALUES ('{\"ip_hash\":\"legacy-browser-key\",\"call_count\":500}'::jsonb)")
        else:
            conn.execute("INSERT INTO anonymous_users (ip_hash, call_count, first_call) VALUES ('legacy-browser-key',500,now())")
    insert(0, owner='legacy-browser-key')
    with psycopg.connect(uri, autocommit=True) as conn:
        query = "SELECT (doc->>'call_count')::integer FROM anonymous_users WHERE doc->>'ip_hash'='legacy-browser-key'" if local else "SELECT call_count FROM anonymous_users WHERE ip_hash='legacy-browser-key' AND identity_type='legacy'"
        assert conn.execute(query).fetchone()[0] == 500


def test_ip_migration_preserves_legacy_records_and_restricts_counter_access(guest_trial_db):
    uri, local, insert = guest_trial_db
    if local:
        return  # Local embedded tables are not exposed through PostgREST.
    with psycopg.connect(uri, autocommit=True) as conn:
        assert conn.execute("SELECT call_count, identity_type FROM anonymous_users WHERE ip_hash=%s", ('f' * 32,)).fetchone() == (42, 'legacy')
        for role in ('anon', 'authenticated'):
            conn.execute(f'SET ROLE {role}')
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute('SELECT * FROM anonymous_users')
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute('SELECT reserve_guest_ip_generation(%s)', ('ip_v1_' + 'a' * 64,))
            conn.execute('RESET ROLE')
    insert(0)  # New 70-character HMAC keys coexist with the original records.

@pytest.mark.parametrize('local', [False, True])
def test_account_daily_override_is_atomic_and_preserves_usage(server, tmp_path, local):
    uri = server.get_uri()
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute('DROP TABLE IF EXISTS generations CASCADE; DROP TABLE IF EXISTS generation_daily_usage; DROP TABLE IF EXISTS generation_daily_limit_overrides')
        if local:
            _create_schema(conn)
        else:
            for role in ('anon', 'authenticated', 'service_role'):
                if not conn.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (role,)).fetchone():
                    conn.execute(f'CREATE ROLE {role}')
            conn.execute('CREATE TABLE generations (id uuid primary key, user_id text, user_type text, created_at timestamptz DEFAULT now())')
            root = Path(__file__).parents[2] / 'supabase/migrations'
            conn.execute((root / '20261020000000_generation_daily_limit.sql').read_text())
            conn.execute((root / '20261022020000_account_generation_limits.sql').read_text())
            conn.execute('CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users (id text PRIMARY KEY, email text, email_confirmed_at timestamptz, is_anonymous boolean DEFAULT false); DROP TABLE IF EXISTS generation_daily_email_exemptions')
            conn.execute((root / '20261022040000_ten_daily_generation_limit.sql').read_text())
            assert not conn.execute("SELECT has_table_privilege('authenticated','generation_daily_limit_overrides','INSERT')").fetchone()[0]
        conn.execute("INSERT INTO generation_daily_limit_overrides(user_id,user_type,daily_limit) VALUES ('restricted','authenticated',5),('already-used','authenticated',5)")
        conn.execute("INSERT INTO generation_daily_usage VALUES ('already-used','authenticated',(now() AT TIME ZONE 'UTC')::date,23)")

    def reserve(owner):
        with psycopg.connect(uri, autocommit=True) as conn:
            try:
                conn.execute("SELECT reserve_daily_generation(%s,'authenticated')", (owner,))
                return True
            except psycopg.errors.RaiseException as exc:
                assert 'BB_GENERATION_DAILY_LIMIT:' in str(exc)
                return False
    with ThreadPoolExecutor(max_workers=12) as workers:
        assert sum(workers.map(reserve, ['restricted'] * 12)) == 5
    assert not reserve('already-used')
    assert sum(reserve('ordinary') for _ in range(11)) == 10
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute("INSERT INTO generation_daily_limit_overrides(user_id,user_type,daily_limit,unlimited) VALUES ('exempt','authenticated',10,true)")
    assert all(reserve('exempt') for _ in range(50))
    if not local:
        with psycopg.connect(uri, autocommit=True) as conn:
            conn.execute("INSERT INTO generation_daily_email_exemptions VALUES ('owner@example.com')")
            conn.execute("INSERT INTO auth.users VALUES ('verified-owner','owner@example.com',now(),false),('pending-owner','owner@example.com',null,false)")
        assert all(reserve('verified-owner') for _ in range(50))
        assert sum(reserve('pending-owner') for _ in range(11)) == 10
        assert sum(reserve('owner@example.com') for _ in range(11)) == 10

    with psycopg.connect(uri, autocommit=True) as conn:
        assert conn.execute("SELECT attempts FROM generation_daily_usage WHERE user_id='already-used'").fetchone()[0] == 23
        conn.execute("UPDATE generation_daily_usage SET usage_day=usage_day-1")
    assert sum(reserve('restricted') for _ in range(6)) == 5
