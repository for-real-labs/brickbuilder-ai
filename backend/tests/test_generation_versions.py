"""Exercise migration/backfill/version allocation against real PostgreSQL."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import pgserver
import psycopg
import pytest

DURATION_MIGRATION = (Path(__file__).resolve().parents[2] / "supabase/migrations/20261001000001_generation_duration.sql").read_text()
MIGRATION = (Path(__file__).resolve().parents[2] / "supabase/migrations/20261001000002_generation_versions.sql").read_text()
REMOVE_SOURCE = (Path(__file__).resolve().parents[2] / "supabase/deferred-migrations/20261001000003_remove_generation_source.sql").read_text()


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    instance = pgserver.get_server(tmp_path_factory.mktemp("versions-postgres"), cleanup_mode="delete")
    yield instance
    instance.cleanup()


@pytest.fixture
def db(server):
    with psycopg.connect(server.get_uri(), autocommit=True) as conn:
        conn.execute("drop view if exists public.latest_generations")
        conn.execute("drop table if exists public.generations cascade")
        conn.execute("drop function if exists public.assign_generation_version()")
        for role in ["anon", "authenticated", "service_role"]:
            if not conn.execute("select 1 from pg_roles where rolname = %s", (role,)).fetchone():
                conn.execute(f"create role {role}")
        conn.execute("""create table public.generations (
            id uuid primary key, user_id text not null, user_type text not null default 'authenticated',
            source_generation_id uuid references public.generations(id),
            prompt text, endpoint text, processed_image_url text, status text default 'completed',
            created_at timestamptz default now(), is_community boolean default false
        )""")
        yield conn


def insert(db, *, id=None, parent=None, prompt="model", endpoint="llmToBricks", image=None, owner="owner", date="2026-09-30", status="completed", community=False):
    id = id or uuid4()
    db.execute("""insert into public.generations
        (id, source_generation_id, prompt, endpoint, processed_image_url, user_id, created_at, status, is_community)
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (id, parent, prompt, endpoint, image, owner, date, status, community))
    return id


def migrate(db):
    with db.transaction():
        db.execute(DURATION_MIGRATION)
        db.execute(MIGRATION)


def versions(db):
    return {id: (group, version) for id, group, version in db.execute(
        "select id, generation_id, version from public.generations")}


def test_backfill_mixed_edits_and_independent_models_with_identical_images(db):
    root = insert(db, image="same", date="2026-09-01")
    independent = insert(db, image="same", date="2026-09-02")
    manual = insert(db, prompt=f"Updated model from {root}", endpoint="updateModel", image="same", date="2026-09-03")
    llm = insert(db, parent=manual, date="2026-09-04")
    resize = insert(db, prompt=f"Resized model from {llm}", endpoint="resizeModel", date="2026-09-05")
    image_edit = insert(db, prompt=f"Edited from {resize}: blue roof", endpoint="promptEditModel", image="new-image", date="2026-09-06")
    other_owner = insert(db, image="same", owner="other", date="2026-09-07")
    migrate(db)
    saved = versions(db)
    assert [saved[id] for id in [root, manual, llm, resize, image_edit]] == [(root, v) for v in range(1, 6)]
    assert saved[independent] == (independent, 1)
    assert saved[other_owner] == (other_owner, 1)
    assert set(row[0] for row in db.execute("select id from public.latest_generations")) == {image_edit, independent, other_owner}


def test_legacy_image_fallback_is_only_for_owned_derived_rows(db):
    root = insert(db, image="same", date="2026-09-01")
    edit = insert(db, image="same", endpoint="updateModel", date="2026-09-02")
    other = insert(db, image="same", endpoint="updateModel", owner="other", date="2026-09-03")
    migrate(db)
    assert versions(db) == {root: (root, 1), edit: (root, 2), other: (other, 1)}


def test_concurrent_edits_of_old_version_allocate_unique_numbers(db, server):
    migrate(db)
    root = insert(db)
    insert(db, parent=root, status="cancelled")
    def save(_):
        with psycopg.connect(server.get_uri(), autocommit=True) as conn:
            return insert(conn, parent=root, endpoint="updateModel")
    with ThreadPoolExecutor(max_workers=4) as pool:
        edits = list(pool.map(save, range(8)))
    saved = versions(db)
    assert sorted(saved[id][1] for id in edits) == list(range(3, 11))
    assert all(saved[id][0] == root for id in edits)
    assert db.execute("select version from public.latest_generations").fetchall() == [(10,)]


def test_private_cross_owner_edits_rejected_and_community_forks_are_separate(db):
    migrate(db)
    root = insert(db)
    with pytest.raises(psycopg.errors.RaiseException, match="another owner"):
        insert(db, parent=root, owner="other")
    published = insert(db, community=True)
    fork = insert(db, parent=published, owner="other")
    assert versions(db)[fork] == (fork, 1)


def test_latest_view_honors_rls_and_version_before_pagination(db):
    migrate(db)
    root = insert(db, date="2026-09-01")
    latest = insert(db, parent=root, date="2026-09-02")
    insert(db, parent=root, date="2026-09-01")  # highest version despite older timestamp
    private = insert(db, owner="other", date="2026-10-01")
    db.execute("alter table public.generations enable row level security")
    db.execute("create policy owner_read on public.generations for select using (user_id = current_setting('app.test_owner', true))")
    db.execute("grant select on public.generations to authenticated")
    with db.transaction():
        db.execute("set local role authenticated")
        db.execute("select set_config('app.test_owner', 'owner', true)")
        rows = db.execute("select id, version from public.latest_generations order by created_at desc limit 1").fetchall()
        assert rows[0][1] == 3 and rows[0][0] not in [latest, private]


def test_removal_preserves_backfilled_history_and_allocates_without_parent_column(db, server):
    root = insert(db, date="2026-09-01")
    old_edit = insert(db, parent=root, date="2026-09-02")
    migrate(db)
    def save_revision(conn, owner="owner"):
        return conn.execute("""insert into generations (id, generation_id, user_id, version)
            values (%s, %s, %s, 999) returning id, generation_id, version""",
            (uuid4(), root, owner)).fetchone()
    # New code can run during rollout while the legacy column still exists.
    assert save_revision(db)[2] == 3
    with db.transaction():
        db.execute(REMOVE_SOURCE)
    assert not db.execute("""select 1 from information_schema.columns
        where table_name = 'generations' and column_name = 'source_generation_id'""").fetchone()
    assert versions(db)[old_edit] == (root, 2)
    assert save_revision(db)[2] == 4
    with pytest.raises(psycopg.errors.RaiseException, match="this owner"):
        save_revision(db, owner="other")
    def concurrent_save(_):
        with psycopg.connect(server.get_uri(), autocommit=True) as conn:
            return save_revision(conn)
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(concurrent_save, range(8)))
    assert sorted(row[2] for row in rows) == list(range(5, 13))
    assert all(row[1] == root for row in rows)
    assert db.execute("select version from latest_generations").fetchall() == [(12,)]
