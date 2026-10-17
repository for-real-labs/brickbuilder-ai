import asyncio
import sys
from pathlib import Path

import pgserver
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.requests import getGenerationStats
from src.utils.generation_storage import GenerationStorage


class FakeGenerationStorage:
    async def get_generation_stats(self):
        return {"generation_count": 12, "brick_count": 3456}


def test_get_generation_stats(monkeypatch):
    monkeypatch.setattr(
        getGenerationStats, "generation_storage", FakeGenerationStorage()
    )

    response = asyncio.run(getGenerationStats.get_generation_stats())

    assert response.generation_count == 12
    assert response.brick_count == 3456


def test_get_generation_stats_without_storage(monkeypatch):
    monkeypatch.setattr(getGenerationStats, "generation_storage", None)

    response = asyncio.run(getGenerationStats.get_generation_stats())

    assert response.generation_count == 0
    assert response.brick_count == 0


class FakeGenerationTable:
    def __init__(self):
        self.updated = None

    def update(self, values):
        self.updated = values
        return self

    def eq(self, _column, _value):
        return self

    def execute(self):
        return type("Result", (), {"data": [self.updated]})()


class FakeClient:
    def __init__(self):
        self.generations = FakeGenerationTable()

    def table(self, name):
        assert name == "generations"
        return self.generations


def test_store_parts_list_persists_brick_count():
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = FakeClient()

    async def fake_upload(**_kwargs):
        return "https://example.com/parts.csv"

    storage._upload_file_to_storage = fake_upload
    ldr_content = "\n".join(
        [
            "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
            "1 4 1 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
            "1 1 2 0 0 1 0 0 0 1 0 0 0 1 3002.dat",
        ]
    )

    result = asyncio.run(storage.store_parts_list_csv("generation-1", ldr_content))

    assert result == "https://example.com/parts.csv"
    assert storage.client.generations.updated == {
        "parts_list_csv_url": "https://example.com/parts.csv",
        "brick_count": 3,
    }


def test_stats_index_preserves_totals_and_avoids_scanning_model_rows(tmp_path):
    server = pgserver.get_server(tmp_path / "stats-db", cleanup_mode="delete")
    migrations = Path(__file__).resolve().parents[2] / "supabase/migrations"
    try:
        with psycopg.connect(server.get_uri(), autocommit=True) as db:
            for role in ("anon", "authenticated", "service_role"):
                db.execute(f"CREATE ROLE {role}")
            db.execute("CREATE TABLE public.generations (id integer PRIMARY KEY, model text)")
            db.execute((migrations / "20260903000000_add_generation_stats.sql").read_text())
            db.execute("""
                INSERT INTO public.generations (id, model, brick_count)
                SELECT n, repeat('model data ', 100), CASE WHEN n % 2 = 0 THEN n END
                FROM generate_series(1, 2000) AS n
            """)
            migration = (migrations / "20261017014134_index_generation_stats.sql").read_text()
            db.execute(migration)
            db.execute(migration)  # Safe to reconcile an index applied during recovery.
            db.execute("VACUUM ANALYZE public.generations")

            assert db.execute("SELECT * FROM public.get_generation_stats()").fetchone() == (2000, 1001000)
            plan = db.execute("""
                EXPLAIN (FORMAT JSON) SELECT count(*), coalesce(sum(brick_count), 0)
                FROM public.generations
            """).fetchone()[0][0]["Plan"]
            scan = plan["Plans"][0]
            assert scan["Node Type"] == "Index Only Scan"
            assert scan["Index Name"] == "generations_stats_brick_count_idx"

            db.execute("UPDATE public.generations SET brick_count = 10 WHERE id = 1")
            db.execute("DELETE FROM public.generations WHERE id = 2")
            assert db.execute("SELECT * FROM public.get_generation_stats()").fetchone() == (1999, 1001008)
            for role in ("anon", "authenticated"):
                assert not db.execute(
                    "SELECT has_function_privilege(%s, 'public.get_generation_stats()', 'execute')", (role,)
                ).fetchone()[0]
    finally:
        server.cleanup()
