from pathlib import Path

import pgserver
import psycopg
import pytest


def test_cost_summary_read_access_preserves_row_and_private_column_permissions(tmp_path):
    server = pgserver.get_server(tmp_path / 'cost-access-postgres')
    try:
        with psycopg.connect(server.get_uri(), autocommit=True) as connection:
            connection.execute('create role anon; create role authenticated')
            connection.execute('grant usage on schema public to anon, authenticated')
            connection.execute('create table public.generations(id text primary key, notification_email text)')
            migrations = Path(__file__).parents[2] / 'supabase/migrations'
            connection.execute((migrations / '20261007000001_generation_usage_and_edit_prompt.sql').read_text())
            connection.execute('grant select (id) on public.generations to anon, authenticated')
            connection.execute('alter table public.generations enable row level security')
            connection.execute("create policy visible_generation on public.generations for select using (id = 'visible')")
            connection.execute("insert into public.generations(id, estimated_cost_usd) values ('visible', .01234), ('hidden', .99)")
            migration = (migrations / '20261009000000_generation_cost_read_access.sql').read_text()
            connection.execute(migration)
            connection.execute(migration)

            connection.execute('set role authenticated')
            rows = connection.execute('select id, estimated_cost_usd from public.generations').fetchall()
            assert len(rows) == 1 and rows[0][0] == 'visible' and float(rows[0][1]) == .01234
            for column in ['ai_usage', 'tokens_used', 'notification_email', '*']:
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    connection.execute(f'select {column} from public.generations')

            connection.execute('set role anon')
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                connection.execute('select estimated_cost_usd from public.generations')
    finally:
        server.cleanup()
