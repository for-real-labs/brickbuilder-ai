import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.utils import authorization


class FakeGenerationStorage:
    def __init__(self, row):
        self.row = row
        self.generation_id = None

    async def get_generation(self, generation_id: str):
        self.generation_id = generation_id
        return self.row


@pytest.fixture(autouse=True)
def reset_generation_storage(monkeypatch):
    monkeypatch.setattr(authorization, "generation_storage", None)


def run_get_owned_generation(generation_id: str, auth_info: dict):
    return asyncio.run(
        authorization.get_owned_generation_or_403(generation_id, auth_info)
    )


def test_get_owned_generation_allows_owner(monkeypatch):
    row = {
        "id": "generation-1",
        "user_id": "user-1",
        "user_type": "authenticated",
    }
    storage = FakeGenerationStorage(row)
    monkeypatch.setattr(authorization, "generation_storage", storage)

    result = run_get_owned_generation(
        "generation-1",
        {"authenticated": True, "is_anonymous": False, "user_id": "user-1"},
    )

    assert result == row
    assert storage.generation_id == "generation-1"


def test_get_owned_generation_rejects_anonymous(monkeypatch):
    storage = FakeGenerationStorage({"id": "generation-1"})
    monkeypatch.setattr(authorization, "generation_storage", storage)

    with pytest.raises(HTTPException) as exc_info:
        run_get_owned_generation(
            "generation-1",
            {"authenticated": True, "is_anonymous": True, "user_id": "anon-1"},
        )

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "Authentication required"
    assert storage.generation_id is None


def test_get_owned_generation_rejects_different_authenticated_user(monkeypatch):
    storage = FakeGenerationStorage(
        {
            "id": "generation-1",
            "user_id": "user-1",
            "user_type": "authenticated",
        }
    )
    monkeypatch.setattr(authorization, "generation_storage", storage)

    with pytest.raises(HTTPException) as exc_info:
        run_get_owned_generation(
            "generation-1",
            {"authenticated": True, "is_anonymous": False, "user_id": "user-2"},
        )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "You do not have permission to access this generation"


def test_get_owned_generation_returns_404_for_missing_generation(monkeypatch):
    storage = FakeGenerationStorage(None)
    monkeypatch.setattr(authorization, "generation_storage", storage)

    with pytest.raises(HTTPException) as exc_info:
        run_get_owned_generation(
            "missing-generation",
            {"authenticated": True, "is_anonymous": False, "user_id": "user-1"},
        )

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "Generation not found"


def test_get_generation_or_404_allows_public_rows(monkeypatch):
    row = {"id": "generation-1", "is_community": True, "status": "completed"}
    monkeypatch.setattr(authorization, "generation_storage", FakeGenerationStorage(row))
    result = asyncio.run(authorization.get_generation_or_404("generation-1", {"user_id": "reader"}))
    assert result == row


def test_get_generation_or_404_rejects_private_rows_with_wrong_identity(monkeypatch):
    row = {"id": "generation-1", "is_community": False, "user_id": "owner"}
    monkeypatch.setattr(authorization, "generation_storage", FakeGenerationStorage(row))
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(authorization.get_generation_or_404("generation-1", {"user_id": "other"}))
    assert exc_info.value.status_code == 404


def test_get_generation_or_404_requires_stable_identity(monkeypatch):
    monkeypatch.setattr(authorization, "generation_storage", FakeGenerationStorage({"id": "generation-1"}))
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(authorization.get_generation_or_404("generation-1", {}))
    assert exc_info.value.status_code == 404
