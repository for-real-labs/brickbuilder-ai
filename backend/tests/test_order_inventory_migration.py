from pathlib import Path

import pgserver
import psycopg


def test_backfill_uses_only_pre_order_artifacts_and_preserves_existing_snapshots(tmp_path):
    server = pgserver.get_server(tmp_path / 'postgres', cleanup_mode='delete')
    try:
        with psycopg.connect(server.get_uri(), autocommit=True) as db:
            db.execute("CREATE TABLE generations (id text PRIMARY KEY, parts_list_csv_url text)")
            db.execute("CREATE TABLE orders (id int PRIMARY KEY, generation_id text, created_at timestamptz, parts_list_csv_url text)")
            db.execute("INSERT INTO generations VALUES ('old', 'https://storage/parts_list_1600000000.csv?download=1'), ('new', 'https://storage/parts_list_1800000000.csv')")
            db.execute("INSERT INTO orders VALUES (1, 'old', to_timestamp(1700000000), NULL), (2, 'new', to_timestamp(1700000000), NULL), (3, 'old', to_timestamp(1700000000), 'original.csv')")
            sql = (Path(__file__).parents[2] / 'supabase/migrations/20261029143000_order_parts_snapshots.sql').read_text()
            db.execute(sql)
            db.execute(sql)
            assert db.execute('SELECT parts_list_csv_url FROM orders ORDER BY id').fetchall() == [
                ('https://storage/parts_list_1600000000.csv?download=1',), (None,), ('original.csv',)]
    finally:
        server.cleanup()
