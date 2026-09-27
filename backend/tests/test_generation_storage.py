import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.utils.generation_storage import GenerationStorage


class FakeCommunityQuery:
    def __init__(self, client):
        self.client = client
        self.filters = []
        self.ordering = []
        self.range_values = None

    def select(self, _fields):
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def in_(self, key, values):
        self.filters.append((key, tuple(values)))
        return self

    def order(self, key, desc=False):
        self.ordering.append((key, desc))
        return self

    def range(self, start, end):
        self.range_values = (start, end)
        return self

    def execute(self):
        if any(key == "like_count" for key, _desc in self.ordering):
            raise Exception('column "like_count" does not exist')

        return type("Result", (), {
            "data": [
                {"id": "generation-2", "created_at": "2026-09-26T00:00:00Z"},
                {"id": "generation-1", "created_at": "2026-09-25T00:00:00Z"},
            ]
        })()


class FakeCommunityClient:
    def __init__(self):
        self.queries = []

    def table(self, table_name):
        assert table_name == "generations"
        query = FakeCommunityQuery(self)
        self.queries.append(query)
        return query


def test_get_community_generations_falls_back_to_recent_when_like_count_is_missing():
    client = FakeCommunityClient()
    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = client

    result = asyncio.run(storage.get_community_generations(limit=2, offset=0, sort="top"))

    assert [row["id"] for row in result] == ["generation-2", "generation-1"]
    assert len(client.queries) == 2
    assert ("like_count", True) in client.queries[0].ordering
    assert client.queries[1].ordering == [("created_at", True)]


def test_store_preview_image_uploads_png_and_saves_its_url():
    updates = []

    class FakeUpdate:
        def __init__(self, data):
            self.data = data

        def eq(self, key, value):
            updates.append((self.data, key, value))
            return self

        def execute(self):
            return self

    class FakeTable:
        def update(self, data):
            return FakeUpdate(data)

    class FakeClient:
        def table(self, table_name):
            assert table_name == "generations"
            return FakeTable()

    uploads = []

    async def fake_upload(content, path, content_type):
        uploads.append((content, path, content_type))
        return "https://example.com/preview.png"

    storage = GenerationStorage.__new__(GenerationStorage)
    storage.client = FakeClient()
    storage._upload_file_to_storage = fake_upload

    url = asyncio.run(storage.store_preview_image("generation-1", b"png"))

    assert url == "https://example.com/preview.png"
    content, path, content_type = uploads[0]
    assert (content, content_type) == (b"png", "image/png")
    assert path.startswith("generations/generation-1/preview_image_") and path.endswith(".png")
    assert updates == [({"preview_image_url": url}, "id", "generation-1")]
