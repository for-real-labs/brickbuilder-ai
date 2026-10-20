import asyncio

import pytest
from fastapi import HTTPException, Response

from src import api


def test_share_preview_exposes_only_finished_model_card_data(monkeypatch):
    class Storage:
        async def get_generation(self, _generation_id):
            return {
                "status": "completed", "endpoint": "llmToBricks", "name": "A small house",
                "preview_image_url": "https://example.com/house.png", "user_id": "private-owner",
            }

    monkeypatch.setattr(api, "generation_storage", Storage())
    response = Response()
    result = asyncio.run(api.get_generation_share_preview("123e4567-e89b-12d3-a456-426614174000", response))
    assert result == {"name": "A small house", "preview_image_url": "https://example.com/house.png"}
    assert response.headers["Cache-Control"] == "public, max-age=60"


@pytest.mark.parametrize("row", [None, {"status": "processing"}, {"status": "completed", "endpoint": "uploadLdraw"}])
def test_share_preview_hides_unshareable_models(monkeypatch, row):
    class Storage:
        async def get_generation(self, _generation_id):
            return row

    monkeypatch.setattr(api, "generation_storage", Storage())
    with pytest.raises(HTTPException) as error:
        asyncio.run(api.get_generation_share_preview("123e4567-e89b-12d3-a456-426614174000", Response()))
    assert error.value.status_code == 404
