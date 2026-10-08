import hashlib
import json
from decimal import Decimal
from pathlib import Path

import pytest

from src.utils.parts_catalog import PartsCatalog, PartsUnavailable, flat_model_inventory, normalize_part_id
from src.utils.supplier_catalog import DEFAULT_CATALOG
from scripts.refresh_brickwith_catalog import catalog_csv, refresh, flight_chunks

CATALOG = ('part_id,color_id,name,sku,unit_price,weight_kg,max_quantity\n'
           '3001,4,Brick 2 x 4,A,0.15,0.00219,4\n'
           '3001,36,Brick 2 x 4 transparent,B,0.22,0.00228,\n'
           '3005,4,Brick 1 x 1,C,0.035,0.0004,\n')
PLACEMENT = '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat'


def test_exact_color_quantity_and_decimal_quotes():
    catalog = PartsCatalog.from_csv(CATALOG)
    assert catalog.quote({('PARTS/3001.DAT', 4): 4, ('3001', 36): 1}) == (Decimal('.82'), Decimal('.01104'))
    assert catalog.quote({('3005', 4): 3})[0] == Decimal('.11')
    for inventory in ({('3001', 0): 1}, {('3001', 4): 5}, {('unknown', 4): 1}):
        with pytest.raises(PartsUnavailable):
            catalog.validate(inventory)
    for quantity in (0, -1, 1.5, True):
        with pytest.raises(ValueError):
            catalog.validate({('3001', 4): quantity})


def test_search_returns_bounded_relevant_part_color_pairs():
    catalog = PartsCatalog.from_csv(CATALOG)
    assert catalog.search('transparent')['parts'][0]['color_id'] == 36
    assert catalog.search('3001', 4)['total'] == 1
    assert len(catalog.search(limit=1)['parts']) == 1
    assert catalog.search(offset=100)['parts'] == []


def test_plain_allowlist_requires_no_pricing_but_cannot_produce_a_fake_quote():
    catalog = PartsCatalog.from_csv('part_id,color_id,max_quantity\n3001,4,2\n')
    catalog.validate({('3001', 4): 2})
    assert catalog.search()['parts'][0]['unit_price'] is None
    with pytest.raises(PartsUnavailable, match='No supplier price'):
        catalog.quote({('3001', 4): 2})
    with pytest.raises(PartsUnavailable):
        catalog.validate({('3001', 4): 3})


@pytest.mark.parametrize('bad', ['../3001', '/3001', 's/3001', '3001.ldr', '3001;rm'])
def test_unsafe_or_unmapped_part_identifiers_are_rejected(bad):
    with pytest.raises(ValueError):
        normalize_part_id(bad)


@pytest.mark.parametrize('bad', ['NaN', 'Infinity', '-0.1', 'oops'])
def test_catalog_refuses_invalid_prices(bad):
    with pytest.raises(ValueError):
        PartsCatalog.from_csv(CATALOG.replace('0.15', bad))


def test_ambiguous_pairs_and_empty_catalog_fail_closed():
    with pytest.raises(ValueError, match='Ambiguous'):
        PartsCatalog.from_csv(CATALOG + '3001,4,Duplicate,D,0.20,0.002,\n')
    with pytest.raises(ValueError, match='no mapped'):
        PartsCatalog.from_csv(CATALOG.splitlines()[0] + '\n')


def test_physical_inventory_rejects_embedded_impersonation_custom_geometry_and_bad_transforms():
    assert flat_model_inventory('0 FILE root.ldr\n' + PLACEMENT + '\n0 STEP\n' + PLACEMENT) == {('3001', 4): 2}
    for content in [PLACEMENT + '\n0 FILE 3001.dat\n0 Fake geometry',
                    '0 !COLOUR Fake CODE 4 VALUE #000000 EDGE #333333\n' + PLACEMENT,
                    PLACEMENT + '\n3 4 0 0 0 1 1 1 2 2 2',
                    PLACEMENT.replace('0 0 0', 'NaN 0 0', 1),
                    PLACEMENT.replace('3001.dat', 'assembly.ldr')]:
        with pytest.raises(ValueError):
            flat_model_inventory(content)


def product(count=1, price='0.15'):
    return {'spu_code': 'GDS-542', 'main_ldraw_id': '3001', 'part_name': 'Brick 2 x 4',
            'metadata': {'variantCount': count, 'showVariants': [
                {'spu_code': 'GDS-542', 'sku_code': 'GDS-542-010', 'color_id': '010', 'price': price, 'weight': '2.19'}]}}


def test_storefront_adapter_maps_colors_and_grams_and_retains_unmapped_variants():
    content, counts = catalog_csv([product()], [{'color_id': '010', 'ldraw_color_id': '4'}])
    part = PartsCatalog.from_csv(content).parts[('3001', 4)]
    assert part.weight_kg == Decimal('.00219') and part.unit_price == Decimal('.15')
    assert counts['variants'] == 1
    row = product(); row['main_ldraw_id'] = None
    content, counts = catalog_csv([product(), {**row, 'spu_code': 'sample', 'metadata': {
        'variantCount': 1, 'showVariants': [{'spu_code': 'sample', 'sku_code': 'sample-999999',
                                          'color_id': '999999', 'price': '1', 'weight': '3'}]}}],
        [{'color_id': '010', 'ldraw_color_id': '4'}])
    assert counts['unmapped_variants'] == 1 and 'sample-999999' in content


def test_refresh_does_not_overwrite_good_snapshot_on_truncated_variants(tmp_path):
    output = tmp_path / 'parts.csv'; output.write_text(CATALOG)
    class Source:
        def palette_reference(self): return {'url': 'reference'}
        def products(self): return [product(count=2)]
        def colors(self): return [{'color_id': '010', 'ldraw_color_id': '4'}]
    with pytest.raises(ValueError, match='truncated'):
        refresh(output, Source())
    assert output.read_text() == CATALOG


def test_embedded_storefront_json_is_read_as_data():
    payload = json.dumps([1, 'data:{"colors":[]}'])
    assert list(flight_chunks('<script>self.__next_f.push(' + payload + ')</script>')) == ['data:{"colors":[]}']


def test_shipped_snapshot_is_complete_and_matches_its_provenance():
    metadata = json.loads(DEFAULT_CATALOG.with_suffix('.metadata.json').read_text())
    assert hashlib.sha256(DEFAULT_CATALOG.read_bytes()).hexdigest() == metadata['sha256']
    catalog = PartsCatalog.load(DEFAULT_CATALOG)
    assert len(catalog.parts) == metadata['mapped_part_color_pairs']
    assert metadata['variants'] == metadata['mapped_part_color_pairs'] + metadata['unmapped_variants']
    assert catalog.parts[('3001', 4)].unit_price == Decimal('.15')
    assert catalog.parts[('3001', 36)].unit_price == Decimal('.22')


def test_nova_palette_removes_prices_and_supplier_metadata_but_preserves_limits():
    catalog = PartsCatalog.from_csv(CATALOG + '3001a,4,Alias,A,0.15,0.00219,4\n')
    palette = catalog.to_palette_csv()
    assert palette == catalog.to_palette_csv()
    assert 'unit_price' not in palette and 'weight_kg' not in palette
    assert 'Brick 2 x 4' not in palette and 'transparent' not in palette
    assert 'inventory-' in palette
    available = PartsCatalog.from_csv(palette)
    available.validate({('3001', 4): 2, ('3001a', 4): 2})
    with pytest.raises(ValueError, match='requested 5'):
        available.validate({('3001', 4): 3, ('3001a', 4): 2})
    with pytest.raises(ValueError, match='No supplier price'):
        available.quote({('3001', 4): 1})
    assert catalog.quote({('3001', 4): 1})[0] == Decimal('0.15')
