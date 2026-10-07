import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from src.requests import estimatePrice, getPrice
from src.utils.parts_catalog import PartsCatalog
from test_parts_catalog import CATALOG, PLACEMENT


def test_ldr_estimate_uses_color_price_without_brickowl_key(monkeypatch):
    monkeypatch.delenv('BRICKOWL_API_KEY', raising=False)
    monkeypatch.setattr(estimatePrice, 'map_ldraw_to_lego_color', lambda color: 21)
    monkeypatch.setattr('src.utils.supplier_catalog.get_supplier_catalog', lambda: PartsCatalog.from_csv(CATALOG))
    result = asyncio.run(estimatePrice.estimate_price(estimatePrice.EstimatePriceRequest(
        ldr_content=PLACEMENT + '\n' + PLACEMENT.replace('1 4 ', '1 36 ', 1), user_email='test@example.com'), {}))
    assert result.total_price == '0.37' and result.currency == 'USD' and result.parts_count == 2
    assert result.unmapped_parts == 0 and result.cart_id is None
    assert {part.ldraw_color_id for part in result.parts_list} == {4, 36}


@pytest.mark.parametrize('missing', [('3001', 0), ('9999', 4)])
def test_pricing_never_substitutes_a_default_price_or_returns_a_partial_total(monkeypatch, missing):
    monkeypatch.setattr('src.utils.supplier_catalog.get_supplier_catalog', lambda: PartsCatalog.from_csv(CATALOG))
    monkeypatch.setattr(getPrice, 'get_supplier_catalog', lambda: PartsCatalog.from_csv(CATALOG))
    monkeypatch.setattr(getPrice, 'generation_storage', SimpleNamespace(get_generation=AsyncMock(return_value={
        'endpoint': 'novaToBricks', 'parts_list_csv_url': 'https://example.com/parts.csv'})))
    monkeypatch.setattr(getPrice, 'fetch_csv_content', AsyncMock(return_value=
        f'LdrawId,LDrawColorId,Qty\n3001.dat,4,1\n{missing[0]}.dat,{missing[1]},2\n'))
    with pytest.raises(HTTPException) as error:
        asyncio.run(getPrice.get_price(getPrice.GetPriceRequest(generation_id='g'), {}))
    assert error.value.status_code == 422
    model = PLACEMENT + '\n' + PLACEMENT.replace('3001.dat', missing[0] + '.dat').replace('1 4 ', f'1 {missing[1]} ', 1)
    with pytest.raises(HTTPException) as error:
        asyncio.run(estimatePrice.estimate_price(estimatePrice.EstimatePriceRequest(
            ldr_content=model, user_email='test@example.com'), {}))
    assert error.value.status_code == 422


def test_catalog_unavailability_never_reverts_to_estimated_ten_cent_prices(monkeypatch):
    def unavailable(): raise FileNotFoundError()
    monkeypatch.setattr('src.utils.supplier_catalog.get_supplier_catalog', unavailable)
    with pytest.raises(HTTPException) as error:
        asyncio.run(estimatePrice.estimate_price(estimatePrice.EstimatePriceRequest(
            ldr_content=PLACEMENT, user_email='test@example.com'), {}))
    assert error.value.status_code == 503
