import asyncio
import sys
from pathlib import Path
from types import ModuleType

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

fake_generation_storage = ModuleType("src.utils.generation_storage")
fake_generation_storage.generation_storage = None
sys.modules.setdefault("src.utils.generation_storage", fake_generation_storage)

fake_posthog = ModuleType("src.utils.posthog_client")
fake_posthog.track_error = lambda **_kwargs: None
sys.modules.setdefault("src.utils.posthog_client", fake_posthog)

fake_auth = ModuleType("src.utils.auth")
fake_auth.handle_auth_and_tracking = lambda **_kwargs: {"user_email": "builder@example.com"}
sys.modules.setdefault("src.utils.auth", fake_auth)

from src.requests import getGenerationLikeStatus as status_module
from src.requests import toggleGenerationLike as toggle_module
from src.requests.getGenerationLikeStatus import GetGenerationLikeStatusRequest
from src.requests.toggleGenerationLike import ToggleGenerationLikeRequest
from src.utils.community_likes import COMMUNITY_LIKES_MIGRATION_REQUIRED_MESSAGE


class FakeQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.operation = "select"
        self.payload = None
        self.filters = []
        self.selected_fields = ""

    def select(self, fields):
        self.operation = "select"
        self.selected_fields = fields
        return self

    def insert(self, payload):
        self.operation = "insert"
        self.payload = payload
        return self

    def delete(self):
        self.operation = "delete"
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def limit(self, _count):
        return self

    def execute(self):
        return self.client.execute(
            self.table_name,
            self.operation,
            self.payload,
            self.filters,
            self.selected_fields,
        )


class FakeClient:
    def __init__(self, *, likes_schema_missing=False, likes_table_missing=False):
        self.likes = set()
        self.likes_schema_missing = likes_schema_missing
        self.likes_table_missing = likes_table_missing
        self.generations = {
            "generation-1": {
                "id": "generation-1",
                "is_community": True,
                "like_count": 2,
            },
            "generation-2": {
                "id": "generation-2",
                "is_community": False,
                "like_count": 0,
            },
        }

    def table(self, table_name):
        return FakeQuery(self, table_name)

    def execute(self, table_name, operation, payload, filters, selected_fields):
        filter_map = dict(filters)

        if table_name == "generations":
            if self.likes_schema_missing and "like_count" in selected_fields:
                raise Exception('column "like_count" does not exist')
            generation = self.generations.get(filter_map["id"])
            if operation == "select":
                if not generation:
                    return type("Result", (), {"data": []})()
                if "like_count" not in selected_fields:
                    generation = {
                        key: value
                        for key, value in generation.items()
                        if key != "like_count"
                    }
                return type("Result", (), {"data": [generation]})()

        if table_name == "generation_likes":
            if self.likes_schema_missing or self.likes_table_missing:
                raise Exception('relation "generation_likes" does not exist')
            key = (filter_map.get("generation_id"), filter_map.get("user_id"))
            if operation == "select":
                return type("Result", (), {"data": [{"generation_id": key[0]}] if key in self.likes else []})()
            if operation == "insert":
                self.likes.add((payload["generation_id"], payload["user_id"]))
                self.generations[payload["generation_id"]]["like_count"] += 1
                return type("Result", (), {"data": [payload]})()
            if operation == "delete":
                self.likes.discard(key)
                self.generations[key[0]]["like_count"] -= 1
                return type("Result", (), {"data": [{"generation_id": key[0], "user_id": key[1]}]})()

        raise AssertionError(f"Unexpected query: {table_name} {operation} {filters}")


def test_get_generation_like_status_reports_count_and_viewer_state(monkeypatch):
    client = FakeClient()
    client.likes.add(("generation-1", "user-1"))
    monkeypatch.setattr(status_module, "generation_storage", type("Storage", (), {"client": client})())

    response = asyncio.run(status_module.get_generation_like_status(
        GetGenerationLikeStatusRequest(generation_id="generation-1"),
        {"authenticated": True, "is_anonymous": False, "user_id": "user-1"},
    ))

    assert response.generation_id == "generation-1"
    assert response.is_community is True
    assert response.like_count == 2
    assert response.viewer_has_liked is True


def test_get_generation_like_status_defaults_when_likes_schema_is_missing(monkeypatch):
    client = FakeClient(likes_schema_missing=True)
    monkeypatch.setattr(status_module, "generation_storage", type("Storage", (), {"client": client})())

    response = asyncio.run(status_module.get_generation_like_status(
        GetGenerationLikeStatusRequest(generation_id="generation-1"),
        {"authenticated": True, "is_anonymous": False, "user_id": "user-1"},
    ))

    assert response.generation_id == "generation-1"
    assert response.is_community is True
    assert response.like_count == 0
    assert response.viewer_has_liked is False


def test_get_generation_like_status_preserves_like_count_when_only_likes_table_is_missing(monkeypatch):
    client = FakeClient(likes_table_missing=True)
    monkeypatch.setattr(status_module, "generation_storage", type("Storage", (), {"client": client})())

    response = asyncio.run(status_module.get_generation_like_status(
        GetGenerationLikeStatusRequest(generation_id="generation-1"),
        {"authenticated": True, "is_anonymous": False, "user_id": "user-1"},
    ))

    assert response.generation_id == "generation-1"
    assert response.is_community is True
    assert response.like_count == 2
    assert response.viewer_has_liked is False


def test_toggle_generation_like_requires_authentication():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(toggle_module.toggle_generation_like(
            ToggleGenerationLikeRequest(generation_id="generation-1"),
            {"authenticated": False, "is_anonymous": True},
        ))

    assert exc_info.value.status_code == 401


def test_toggle_generation_like_adds_and_removes_likes(monkeypatch):
    client = FakeClient()
    storage = type("Storage", (), {"client": client})()
    monkeypatch.setattr(toggle_module, "generation_storage", storage)
    monkeypatch.setattr(toggle_module, "handle_auth_and_tracking", lambda **_kwargs: {"user_email": "builder@example.com"})

    auth = {"authenticated": True, "is_anonymous": False, "user_id": "user-1"}

    liked = asyncio.run(toggle_module.toggle_generation_like(
        ToggleGenerationLikeRequest(generation_id="generation-1"),
        auth,
    ))
    assert liked.has_liked is True
    assert liked.like_count == 3

    unliked = asyncio.run(toggle_module.toggle_generation_like(
        ToggleGenerationLikeRequest(generation_id="generation-1"),
        auth,
    ))
    assert unliked.has_liked is False
    assert unliked.like_count == 2


def test_toggle_generation_like_reports_missing_migration(monkeypatch):
    client = FakeClient(likes_schema_missing=True)
    storage = type("Storage", (), {"client": client})()
    monkeypatch.setattr(toggle_module, "generation_storage", storage)
    monkeypatch.setattr(toggle_module, "handle_auth_and_tracking", lambda **_kwargs: {"user_email": "builder@example.com"})

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(toggle_module.toggle_generation_like(
            ToggleGenerationLikeRequest(generation_id="generation-1"),
            {"authenticated": True, "is_anonymous": False, "user_id": "user-1"},
        ))

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == COMMUNITY_LIKES_MIGRATION_REQUIRED_MESSAGE


def test_toggle_generation_like_rejects_non_community_models(monkeypatch):
    client = FakeClient()
    storage = type("Storage", (), {"client": client})()
    monkeypatch.setattr(toggle_module, "generation_storage", storage)
    monkeypatch.setattr(toggle_module, "handle_auth_and_tracking", lambda **_kwargs: {"user_email": "builder@example.com"})

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(toggle_module.toggle_generation_like(
            ToggleGenerationLikeRequest(generation_id="generation-2"),
            {"authenticated": True, "is_anonymous": False, "user_id": "user-1"},
        ))

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Only community models can be liked"
