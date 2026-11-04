import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.requests import getPrice
from src.utils.parts_catalog import PartsCatalog, PartsUnavailable
from src.utils.imported_kit import imported_inventory, estimated_inventory

PLACEMENT = '1 {} 0 0 0 1 0 0 0 1 0 0 0 1 {}'
CATALOG = PartsCatalog.from_csv(
    'part_id,color_id,name,sku,unit_price,weight_kg,max_quantity\n'
    '3001,4,Red Brick,red,0.20,0.003,5\n'
    '3001,1,Blue Brick,blue,0.15,0.003,100\n'
)


def test_counts_repeated_submodels_with_inherited_color_and_ignores_unused_sections():
    sub = PLACEMENT.format(4, 'Sub Model.ldr')
    child = PLACEMENT.format(16, '3001.dat')
    assert imported_inventory(f'0 FILE root.ldr\n{sub}\n{sub}\n0 FILE Sub Model.ldr\n{child}\n0 FILE unused.dat\n{child}') == {('3001', 4): 2}


def test_cannot_quote_custom_geometry_as_supplier_parts():
    with pytest.raises(PartsUnavailable):
        imported_inventory(f'0 FILE model.ldr\n{PLACEMENT.format(4, "3001.dat")}\n0 FILE 3001.dat')


def test_estimate_keeps_exact_parts_and_can_use_a_mold_variant_but_never_a_partial_bom():
    assert estimated_inventory({('3001', 4): 5, ('3001a', 1): 1}, CATALOG) == {('3001', 4): 5, ('3001', 1): 1}
    assert estimated_inventory({('3001', 4): 5, ('99999', 4): 1}, CATALOG) is None


@pytest.mark.parametrize('color,credits,price', [(4, None, .20), (25, 20, .20)])
def test_price_checks_import_source_and_marks_substitutions_as_estimates(monkeypatch, color, credits, price):
    source = {'user_type': 'authenticated', 'user_id': 'owner', 'endpoint': 'uploadLdraw',
              'status': 'completed', 'ldr_url': 'saved-source'}
    monkeypatch.setattr(getPrice, 'generation_storage', SimpleNamespace(
        get_generation=AsyncMock(return_value=source),
        download_file_from_storage=AsyncMock(return_value=PLACEMENT.format(color, '3001.dat').encode())))
    monkeypatch.setattr(getPrice, 'get_supplier_catalog', lambda: CATALOG)
    monkeypatch.setattr(getPrice, 'get_member_discount_percent', AsyncMock(return_value=0))
    quote = asyncio.run(getPrice.get_price(getPrice.GetPriceRequest(generation_id='g'),
        {'authenticated': True, 'user_id': 'owner'}))
    assert quote.conversion_credits == credits
    assert quote.total_price == price
