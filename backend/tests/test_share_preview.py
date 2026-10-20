import asyncio
from io import BytesIO

import httpx
import pytest
from fastapi import HTTPException, Response
from PIL import Image

from src import api
from src.utils.share_card import render_share_card


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


def test_share_card_renders_the_model_in_a_branded_landscape():
    source = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    source.paste((130, 95, 55, 255), (55, 25, 145, 180))
    preview = BytesIO()
    source.save(preview, format="PNG")
    result = render_share_card("A Very Nice Cat", preview.getvalue())
    with Image.open(BytesIO(result)) as card:
        assert card.size == (1200, 630)
        assert card.format == "PNG"
        assert card.getpixel((900, 300)) != card.getpixel((520, 300))


def test_share_card_endpoint_returns_png_for_completed_model(monkeypatch):
    source = Image.new("RGBA", (100, 100), (150, 100, 60, 255))
    preview = BytesIO()
    source.save(preview, format="PNG")

    class Storage:
        async def get_generation(self, _generation_id):
            return {"status": "completed", "endpoint": "llmToBricks", "name": "Cat",
                    "preview_image_url": "https://smzdytfghwslpbqnwdov.supabase.co/storage/cat.png"}

    monkeypatch.setattr(api, "generation_storage", Storage())
    real_client = httpx.AsyncClient

    def handler(request):
        assert request.url.host == "smzdytfghwslpbqnwdov.supabase.co"
        return httpx.Response(200, content=preview.getvalue(), headers={"Content-Type": "image/png"})

    monkeypatch.setattr(api.httpx, "AsyncClient", lambda **kwargs: real_client(
        transport=httpx.MockTransport(handler), **kwargs))
    response = asyncio.run(api.get_generation_share_card("123e4567-e89b-12d3-a456-426614174000"))
    assert response.media_type == "image/png"
    assert response.headers["Cache-Control"] == "no-store"
    with Image.open(BytesIO(response.body)) as card:
        assert card.size == (1200, 630)
