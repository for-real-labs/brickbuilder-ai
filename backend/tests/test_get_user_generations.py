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
                              get_user_generations=fetch, get_user_orders=AsyncMock(return_value=[]))
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
