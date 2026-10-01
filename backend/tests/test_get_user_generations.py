import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.requests import getUserGenerations as module


@pytest.mark.parametrize("processing, expected_ids", [(True, ["one", "two"]), (False, ["one"])])
def test_processing_lists_each_job_even_with_the_same_image(monkeypatch, processing, expected_ids):
    rows = [dict(id=id, user_id="user", user_type="authenticated", prompt="Castle",
                 detail_level=40, endpoint="llmToBricks", created_at="2026-09-26T00:00:00",
                 status="processing", processed_image_url="https://example.com/same.png")
            for id in ["one", "two"]]
    fetch = AsyncMock(return_value=rows)
    storage = SimpleNamespace(count_user_generations=AsyncMock(return_value=2),
                              get_user_generations=fetch, get_user_orders=AsyncMock(return_value=[]))
    monkeypatch.setattr(module, "generation_storage", storage)
    monkeypatch.setattr(module, "track_api_call", lambda **kwargs: None)
    result = asyncio.run(module.get_user_generations(
        module.GetUserGenerationsRequest(processing=processing),
        {"authenticated": True, "user_id": "user", "user_email": "user@example.com"},
    ))
    assert [row.id for row in result.generations] == expected_ids
    assert fetch.await_args.kwargs["user_id"] == "user"
    assert fetch.await_args.kwargs["status_filter"] == (
        ["processing", "queued", "started", "ldr_processing", "resizing"] if processing else None
    )
