from pathlib import Path

import pgserver
import psycopg
import pytest

MIGRATION = Path(__file__).resolve().parents[2] / 'supabase/migrations/20261001000001_generation_duration.sql'


@pytest.fixture(scope='module')
def duration_database(tmp_path_factory):
    server = pgserver.get_server(tmp_path_factory.mktemp('duration-postgres'))
    try:
        with psycopg.connect(server.get_uri(), autocommit=True) as connection:
            connection.execute('''create table public.generations (
                id text primary key, status text, name text,
                created_at timestamptz default now(), updated_at timestamptz default now()
            )''')
            connection.execute("insert into public.generations(id, status, created_at) values ('historical', 'completed', now() - interval '7 days')")
            connection.execute(MIGRATION.read_text())
        yield server.get_uri()
    finally:
        server.cleanup()


@pytest.fixture
def duration_connection(duration_database):
    connection = psycopg.connect(duration_database)
    try:
        yield connection
    finally:
        connection.rollback()
        connection.close()


def test_duration_records_first_completion_and_survives_metadata_and_resize(duration_connection):
    connection = duration_connection
    connection.execute("insert into public.generations(id,status,created_at) values ('job','processing',clock_timestamp() - interval '90 seconds')")
    assert connection.execute("select generation_duration_seconds from public.generations where id='job'").fetchone()[0] is None
    duration = connection.execute("update public.generations set status='completed' where id='job' returning generation_duration_seconds").fetchone()[0]
    assert 90 <= duration < 95
    connection.execute("update public.generations set name='Tortoise', updated_at=now() where id='job'")
    connection.execute("update public.generations set status='resizing' where id='job'")
    connection.execute("update public.generations set status='completed' where id='job'")
    assert connection.execute("select generation_duration_seconds from public.generations where id='job'").fetchone()[0] == duration


def test_historical_completed_rows_are_not_given_inaccurate_backfilled_durations(duration_connection):
    row = duration_connection.execute("update public.generations set status='completed', updated_at=now() where id='historical' returning generation_duration_seconds").fetchone()
    assert row[0] is None


@pytest.mark.parametrize('status', ['started', 'processing', 'failed', 'cancelled'])
def test_unfinished_and_unsuccessful_generations_have_no_final_duration(duration_connection, status):
    row = duration_connection.execute('insert into public.generations(id,status) values (%s,%s) returning generation_duration_seconds', ('job', status)).fetchone()
    assert row[0] is None


def test_future_start_is_clamped_and_inserted_completion_is_calculated_by_database(duration_connection):
    row = duration_connection.execute("insert into public.generations(id,status,created_at,generation_duration_seconds) values ('job','completed',clock_timestamp() + interval '1 minute',999) returning generation_duration_seconds").fetchone()
    assert row[0] == 0


@pytest.mark.parametrize('value', [-1, float('inf'), float('nan')])
def test_duration_rejects_negative_and_nonfinite_values(duration_connection, value):
    with pytest.raises(psycopg.errors.CheckViolation):
        duration_connection.execute('insert into public.generations(id,status,generation_duration_seconds) values (%s,%s,%s)', ('job', 'processing', value))


def test_migration_can_be_reapplied_without_duplicate_trigger(duration_connection):
    duration_connection.execute(MIGRATION.read_text())
    assert duration_connection.execute("select count(*) from pg_trigger where tgname='record_generation_duration' and tgrelid='public.generations'::regclass").fetchone()[0] == 1
