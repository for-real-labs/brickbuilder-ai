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


@pytest.mark.parametrize('identity', [{}, {'user_id': 'other', 'authenticated': True}])
def test_completed_unlisted_model_is_available_for_forking(monkeypatch, identity):
    row = {'id': 'source', 'status': 'completed', 'is_community': False,
           'user_id': 'owner', 'user_type': 'authenticated'}
    monkeypatch.setattr(authorization, 'generation_storage', FakeGenerationStorage(row))
    assert asyncio.run(authorization.get_generation_or_404('source', identity)) == row


@pytest.mark.parametrize('identity,expected_status', [
    ({}, 401),
    ({'authenticated': True, 'user_id': 'buyer'}, 403),
    ({'authenticated': True, 'user_id': 'creator'}, None),
])
def test_only_creator_can_publish_model_to_community(monkeypatch, identity, expected_status):
    from types import SimpleNamespace
    from unittest.mock import Mock
    from src.requests import toggleIsCommunity as community

    row = {'id': 'model', 'user_type': 'authenticated', 'user_id': 'creator', 'is_community': False}
    query = Mock()
    query.select.return_value = query
    query.eq.return_value = query
    query.update.return_value = query
    query.execute.return_value = SimpleNamespace(data=[row])
    monkeypatch.setattr(community, 'generation_storage', SimpleNamespace(client=SimpleNamespace(table=lambda _: query)))
    monkeypatch.setattr(community, 'handle_auth_and_tracking', lambda **_: {'user_email': 'test@example.com'})
    request = community.ToggleIsCommunityRequest(generation_id='model')
    if expected_status:
        with pytest.raises(HTTPException) as error:
            asyncio.run(community.toggle_is_community(request, identity))
        assert error.value.status_code == expected_status
        query.update.assert_not_called()
    else:
        result = asyncio.run(community.toggle_is_community(request, identity))
        assert result.is_community is True
        query.update.assert_called_once_with({'is_community': True})
        assert ('user_id', 'creator') in [call.args for call in query.eq.call_args_list]
