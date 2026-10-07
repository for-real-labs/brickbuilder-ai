import asyncio
import base64

import pytest
from pydantic import ValidationError

from src.requests.estimatePrice import EstimatePriceRequest
from src.requests.getPrice import calculate_price
from src.requests import getPrice as get_price_module
from src.requests.getPrice import GetPriceRequest
from src.utils.parts_catalog import PartsCatalog, parts_csv_inventory
from src.requests.ldrToMpd import LdrToMpdRequest, extract_last_step_from_ldr
from src.requests.textToBricks import TextToBricksRequest
from src.requests.updateImagePreview import UpdateImagePreviewRequest
from src.requests.updateUsername import UpdateUsernameRequest


CATALOG = "part_id,color_id,name,sku,unit_price,weight_kg\n3001,4,Brick 2 x 4,A,0.15,0.00219\n2456,4,Brick 2 x 6,B,0.22,0.003\n"


def test_parts_csv_preserves_colors_and_rejects_invalid_rows():
    csv_text = "LdrawId,LDrawColorId,Qty,Weight\n3001.dat,4,2,1.5\n3001.dat,4,3,1.5\n3001.dat,0,1,1.5\n"
    assert parts_csv_inventory(csv_text) == {("3001", 4): 5, ("3001", 0): 1}
    with pytest.raises(ValueError):
        parts_csv_inventory(csv_text + "3003.dat,4,nope,nope\n")


def test_calculate_price_uses_exact_colors_prices_and_supplier_weights():
    total, details, weight = calculate_price({("3001", 4): 4, ("2456", 4): 2}, PartsCatalog.from_csv(CATALOG))
    assert total == 1.04
    assert [detail.part_id for detail in details] == ["3001.dat", "2456.dat"]
    assert details[0].unit_price == 0.15
    assert weight == pytest.approx(4 * .00219 + 2 * .003)


@pytest.mark.parametrize("endpoint", ["llmToBricks", "claudeToBricks", "novaToBricks", "imageToBricks"])
def test_get_price_uses_supplier_prices_for_every_generation_mode(monkeypatch, endpoint):
    class FakeStorage:
        async def get_generation(self, _generation_id):
            return {"endpoint": endpoint, "parts_list_csv_url": "https://example.com/parts.csv"}

    async def fake_fetch(_url):
        return "LdrawId,LDrawColorId,Qty,Weight\n3001.dat,4,4,1\n2456.dat,4,2,1\n"

    monkeypatch.setattr(get_price_module, "generation_storage", FakeStorage())
    monkeypatch.setattr(get_price_module, "fetch_csv_content", fake_fetch)
    monkeypatch.setattr(get_price_module, "track_api_call", lambda **_kwargs: None)
    monkeypatch.setattr(get_price_module, "get_supplier_catalog", lambda: PartsCatalog.from_csv(CATALOG))
    response = asyncio.run(get_price_module.get_price(GetPriceRequest(generation_id="generation-1"), {}))
    assert response.total_parts == 6
    assert response.total_price == 1.04
    assert response.total_weight == pytest.approx(.01476)
    assert 'exclude shipping' in response.message


def test_extract_last_step_handles_explicit_implicit_and_no_steps():
    first = "1 4 0 0 0 1 0 0 0 1 0 0 0 1 a.dat"
    last = "1 4 1 0 0 1 0 0 0 1 0 0 0 1 b.dat"
    assert extract_last_step_from_ldr(f"{first}\n0 STEP\n{last}") == last + "\n"
    assert extract_last_step_from_ldr(f"{first}\n{last}") == first + "\n" + last + "\n"
    assert extract_last_step_from_ldr(f"{first}\n0 STEP") == first + "\n"


def test_generation_status_returns_the_original_creation_timestamp(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from src.requests import getGeneration as module
    started = '2026-10-01T18:00:00+00:00'
    row = {'id': 'g', 'user_id': 'owner', 'user_type': 'authenticated', 'status': 'completed', 'created_at': started, 'generation_duration_seconds': 32.5}
    monkeypatch.setattr(module, 'generation_storage', SimpleNamespace(get_generation=AsyncMock(return_value=row)))
    result = asyncio.run(module.get_generation(module.GetGenerationRequest(generation_id='g'),
        {'authenticated': True, 'user_id': 'owner'}))
    assert result.created_at == started
    assert result.generation_duration_seconds == 32.5


def test_generation_timestamp_does_not_bypass_ownership(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from fastapi import HTTPException
    from src.requests import getGeneration as module
    row = {'id': 'g', 'user_id': 'owner', 'user_type': 'authenticated', 'status': 'processing', 'created_at': '2026-10-01T18:00:00Z'}
    monkeypatch.setattr(module, 'generation_storage', SimpleNamespace(get_generation=AsyncMock(return_value=row)))
    with pytest.raises(HTTPException) as error:
        asyncio.run(module.get_generation(module.GetGenerationRequest(generation_id='g'),
            {'authenticated': True, 'user_id': 'other'}))
    assert error.value.status_code == 404


@pytest.mark.parametrize("bad", ["", "   "])
def test_ldr_request_rejects_empty_content(bad):
    with pytest.raises(ValidationError):
        LdrToMpdRequest(ldr_content=bad)


def test_estimate_price_request_validates_fields():
    valid = EstimatePriceRequest(ldr_content="1 brick", user_email="a@b.com")
    assert valid.condition == "usedg"
    for kwargs in ({"ldr_content": "", "user_email": "a@b.com"}, {"ldr_content": "x", "user_email": "bad"}, {"ldr_content": "x", "user_email": "a@b.com", "condition": "mint"}):
        with pytest.raises(ValidationError):
            EstimatePriceRequest(**kwargs)


def test_generation_request_models_normalize_and_validate():
    request = TextToBricksRequest(prompt="  a castle  ", model_option="c", prompt_option="b", voxelizer="obj2voxel")
    assert request.prompt == "a castle"
    for kwargs in ({"prompt": ""}, {"prompt": "x" * 1001}, {"prompt": "x", "model_option": "z"}, {"prompt": "x", "prompt_option": "z"}, {"prompt": "x", "voxelizer": "bad"}):
        with pytest.raises(ValidationError):
            TextToBricksRequest(**kwargs)


def test_image_preview_and_username_validators():
    encoded = base64.b64encode(b"png").decode()
    assert UpdateImagePreviewRequest(generation_id="g", image_base64=f"data:image/png;base64,{encoded}").image_base64 == encoded
    for value in ("not base64!", "data:broken"):
        with pytest.raises(ValidationError):
            UpdateImagePreviewRequest(generation_id="g", image_base64=value)
    assert UpdateUsernameRequest(username="  brick.builder-1 ").username == "brick.builder-1"
    for username in ("ab", "bad name", "x" * 31):
        with pytest.raises(ValidationError):
            UpdateUsernameRequest(username=username)
