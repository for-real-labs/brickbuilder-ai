import asyncio
import sys
from pathlib import Path
from types import ModuleType

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

fake_generation_storage = ModuleType("src.utils.generation_storage")
fake_generation_storage.generation_storage = None
sys.modules.setdefault("src.utils.generation_storage", fake_generation_storage)

fake_posthog = ModuleType("src.utils.posthog_client")
fake_posthog.track_api_call = lambda **_kwargs: None
fake_posthog.track_error = lambda **_kwargs: None
sys.modules.setdefault("src.utils.posthog_client", fake_posthog)
sys.modules["src.utils.posthog_client"].track_api_call = lambda **_kwargs: None
sys.modules["src.utils.posthog_client"].track_error = lambda **_kwargs: None

from src.requests import getCommunityGenerations as community_module
from src.requests.getCommunityGenerations import GetCommunityGenerationsRequest


class FakeCommunityQuery:
    def __init__(self, table_name):
        self.table_name = table_name
        self.filters = []

    def select(self, _fields):
        return self

    def in_(self, key, values):
        self.filters.append((key, tuple(values)))
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def execute(self):
        if self.table_name == "user_profiles":
            return type("Result", (), {"data": [{"id": "owner-1", "username": "builder"}]})()
        if self.table_name == "generation_likes":
            raise Exception('relation "generation_likes" does not exist')
        raise AssertionError(f"Unexpected table {self.table_name}")


class FakeCommunityClient:
    def table(self, table_name):
        return FakeCommunityQuery(table_name)


class FakeCommunityStorage:
    def __init__(self):
        self.client = FakeCommunityClient()

    async def get_community_generations(self, **_kwargs):
        return [{
            "id": "generation-1",
            "user_id": "owner-1",
            "user_type": "authenticated",
            "prompt": "castle",
            "name": "Castle",
            "detail_level": 10,
            "endpoint": "llm",
            "created_at": "2026-09-26T00:00:00Z",
            "status": "completed",
            "is_community": True,
            "like_count": 4,
        }]


def test_get_community_generations_defaults_viewer_likes_when_schema_missing(monkeypatch):
    monkeypatch.setattr(community_module, "generation_storage", FakeCommunityStorage())

    response = asyncio.run(community_module.get_community_generations(
        GetCommunityGenerationsRequest(limit=10, offset=0),
        {"authenticated": True, "is_anonymous": False, "user_id": "user-1"},
    ))

    assert response.total_count == 1
    assert response.generations[0].username == "builder"
    assert response.generations[0].like_count == 4
    assert response.generations[0].viewer_has_liked is False
