import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.requests import getUserGenerations as module


@pytest.mark.parametrize("processing", [True, False])
def test_dashboard_uses_database_pagination_and_preserves_same_image_models(monkeypatch, processing):
    rows = [dict(id=id, generation_id=id, version=version, user_id="user",
                 user_type="authenticated", prompt="Castle", detail_level=40,
                 endpoint="llmToBricks", created_at="2026-09-26T00:00:00",
                 status="processing", processed_image_url="https://example.com/same.png")
            for id, version in [("one", 3), ("two", 1), ("extra", 2)]]
    fetch = AsyncMock(return_value=rows)
    storage = SimpleNamespace(count_user_generations=AsyncMock(return_value=5),
                              get_user_generations=fetch, get_user_orders=AsyncMock(return_value=[]),
                              get_previous_completed_generation=AsyncMock(return_value=None))
    monkeypatch.setattr(module, "generation_storage", storage)
    monkeypatch.setattr(module, "track_api_call", lambda **kwargs: None)
    result = asyncio.run(module.get_user_generations(
        module.GetUserGenerationsRequest(limit=2, offset=1, processing=processing),
        {"authenticated": True, "user_id": "user", "user_email": "user@example.com"},
    ))
    assert [row.id for row in result.generations] == ["one", "two"]
    assert [row.version for row in result.generations] == [3, 1]
    assert result.has_more and result.total_user_generations == 5
    assert fetch.await_args.kwargs == {
        "user_id": "user", "user_type": "authenticated", "limit": 3, "offset": 1,
        "status_filter": ["processing", "queued", "started", "ldr_processing", "resizing"] if processing else None,
    }


@pytest.mark.parametrize("status", ["processing", "queued", "started", "ldr_processing", "resizing"])
@pytest.mark.parametrize("owner_type", ["authenticated", "anonymous"])
@pytest.mark.parametrize("previous", [None, {"id": "completed-v2", "preview_image_url": "https://example.com/v2.png"}])
def test_dashboard_edit_exposes_completed_revision_without_replacing_active_job(monkeypatch, status, owner_type, previous):
    row = dict(id="active-v5", generation_id="root", version=5, user_id="owner",
               user_type=owner_type, prompt="Make it a Pepsi can", detail_level=40,
               endpoint="llmToBricks", created_at="2026-10-01", status=status,
               preview_image_url="https://example.com/unfinished-v5.png")
    storage = SimpleNamespace(count_user_generations=AsyncMock(return_value=1),
                              get_user_generations=AsyncMock(return_value=[row]),
                              get_user_orders=AsyncMock(return_value=[]),
                              get_previous_completed_generation=AsyncMock(return_value=previous))
    monkeypatch.setattr(module, "generation_storage", storage)
    monkeypatch.setattr(module, "track_api_call", lambda **kwargs: None)
    result = asyncio.run(module.get_user_generations(
        module.GetUserGenerationsRequest(),
        {"authenticated": owner_type == "authenticated", "user_id": "owner"},
    ))
    generation = result.generations[0]
    assert generation.id == "active-v5" and generation.version == 5
    assert generation.status == status and generation.prompt == row["prompt"]
    assert generation.preview_image_url == row["preview_image_url"]
    assert generation.previous_completed_generation_id == (previous["id"] if previous else None)
    assert generation.previous_completed_preview_image_url == (previous["preview_image_url"] if previous else None)
    assert result.total_count == result.total_user_generations == 1
    storage.get_previous_completed_generation.assert_awaited_once_with(row)


@pytest.mark.parametrize("status,version", [("processing", 1), ("completed", 3), ("failed", 3)])
def test_dashboard_does_not_lookup_completed_fallback_for_initial_or_finished_jobs(monkeypatch, status, version):
    row = dict(id="revision", generation_id="root", version=version, user_id="owner",
               user_type="authenticated", prompt="Castle", detail_level=40,
               endpoint="llmToBricks", created_at="2026-10-01", status=status)
    storage = SimpleNamespace(count_user_generations=AsyncMock(return_value=1),
                              get_user_generations=AsyncMock(return_value=[row]),
                              get_user_orders=AsyncMock(return_value=[]),
                              get_previous_completed_generation=AsyncMock())
    monkeypatch.setattr(module, "generation_storage", storage)
    monkeypatch.setattr(module, "track_api_call", lambda **kwargs: None)
    result = asyncio.run(module.get_user_generations(
        module.GetUserGenerationsRequest(), {"authenticated": True, "user_id": "owner"},
    ))
    assert result.generations[0].previous_completed_generation_id is None
    storage.get_previous_completed_generation.assert_not_awaited()
