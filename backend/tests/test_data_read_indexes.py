from pathlib import Path

import pgserver
import psycopg


def test_feed_indexes_keep_owner_filters_and_order_without_full_table_scans(tmp_path):
    server = pgserver.get_server(tmp_path / "feed-db", cleanup_mode="delete")
    migration = next(
        (Path(__file__).resolve().parents[2] / "supabase/migrations").glob(
            "*_data_read_indexes.sql"
        )
    )
    try:
        with psycopg.connect(server.get_uri(), autocommit=True) as db:
            db.execute("""CREATE TABLE generations (
                id int PRIMARY KEY, user_id text, user_type text, status text,
                updated_at timestamptz, created_at timestamptz, like_count int,
                is_community boolean, prompt text
            )""")
            db.execute("""INSERT INTO generations
                SELECT n, 'owner-' || (n % 10), 'authenticated',
                       CASE WHEN n % 2 = 0 THEN 'completed' ELSE 'processing' END,
                       now() + n * interval '1 second', now() + n * interval '1 second',
                       n % 7, n % 100 = 0, repeat('private model data ', 50)
                FROM generate_series(1, 10000) n""")
            community = "SELECT id FROM generations WHERE is_community=true ORDER BY like_count DESC,created_at DESC LIMIT 9"
            history = "SELECT id FROM generations WHERE user_id='owner-0' AND user_type='authenticated' AND status='completed' ORDER BY updated_at DESC LIMIT 30"
            before = [db.execute(query).fetchall() for query in (community, history)]
            db.execute(migration.read_text())
            db.execute(migration.read_text())
            db.execute("VACUUM ANALYZE generations")
            for query, expected, index in zip(
                (community, history),
                before,
                (
                    "generations_community_top_idx",
                    "generations_completed_owner_updated_idx",
                ),
            ):
                assert db.execute(query).fetchall() == expected
                plan = db.execute("EXPLAIN (FORMAT JSON) " + query).fetchone()[0][0][
                    "Plan"
                ]
                assert plan["Plans"][0]["Index Name"] == index
    finally:
        server.cleanup()
