import io
import zipfile

import pytest
from pydantic import ValidationError

from src.utils.parts_inventory import InventoryPart, PartsInventory, parse_inventory
from src.utils.parts_catalog import PartsUnavailable


def placement(part='3001.dat', color=4):
    return f'1 {color} 0 0 0 1 0 0 0 1 0 0 0 1 {part}\n'


@pytest.mark.parametrize('header,row', [
    ('part_id,color_id,quantity', '3001,4,2'),
    ('LdrawId,LDrawColorId,Qty', '3001.dat,4,2'),
    ('part_num,color_id,quantity', '3001,4,2'),
    ('Part,Color,Quantity', '3001,4,2'),
    ('Part Number,Color,Quantity', '3001,5,2'),
])
def test_common_csv_layouts_and_exact_color_systems(header, row):
    parsed = parse_inventory('bricks.csv', f'{header}\n{row}\n{row}\n'.encode())
    assert parsed.parts == [InventoryPart(part_id='3001', color_id=4, quantity=4)]
    parsed.catalog().validate({('3001', 4): 4})
    for inventory in [{('3001', 4): 5}, {('3001', 0): 1}, {('3002', 4): 1}]:
        with pytest.raises(PartsUnavailable):
            parsed.catalog().validate(inventory)


def test_bricklink_xml_maps_red_and_sums_duplicates():
    item = '<ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID>3001</ITEMID><COLOR>5</COLOR><MINQTY>2</MINQTY></ITEM>'
    result = parse_inventory('parts.xml', f'<INVENTORY>{item}{item}</INVENTORY>'.encode())
    assert result.parts[0].color_id == 4 and result.parts[0].quantity == 4


@pytest.mark.parametrize('data', [
    b'<!DOCTYPE INVENTORY [<!ENTITY e SYSTEM "file:///etc/passwd">]><INVENTORY/>',
    b'<INVENTORY><ITEM><ITEMTYPE>M</ITEMTYPE></ITEM></INVENTORY>',
    b'<INVENTORY><ITEM><ITEMID>3001</ITEMID></ITEM></INVENTORY>',
    b'<invalid',
])
def test_xml_fails_closed(data):
    with pytest.raises(ValueError):
        parse_inventory('parts.xml', data)


@pytest.mark.parametrize('row', ['3001,4,0', '3001,4,-1', '3001,4,1.5', '3001,16,1', '../secret,4,1',
    '3001,4,100001', '3001,4', '3001,4,2,extra'])
def test_invalid_csv_never_becomes_unlimited_or_partial(row):
    with pytest.raises(ValueError):
        parse_inventory('bad.csv', f'part_id,color_id,quantity\n{row}\n'.encode())


def test_mpd_counts_repeated_nested_models_and_inherited_colors():
    model = '0 FILE root.ldr\n' + placement('sub.ldr', 4) * 3 + placement('sub.ldr', 0)
    model += '0 FILE sub.ldr\n' + placement(color=16) * 2
    model += '0 FILE unreferenced.ldr\n' + placement('3002.dat') * 7
    parts = parse_inventory('set.ldr', model.encode()).parts
    assert parts == [InventoryPart(part_id='3001', color_id=0, quantity=2), InventoryPart(part_id='3001', color_id=4, quantity=6)]


def test_studio_io_and_lowercase_mpd_commands():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('model.ldr', '0 file root.ldr\n' + placement())
    assert parse_inventory('set.io', buffer.getvalue()).parts[0].quantity == 1


@pytest.mark.parametrize('model', [
    '0 FILE root.ldr\n' + placement('root.ldr'),
    '0 FILE root.ldr\n' + placement() + '0 file 3001.dat\n' + placement(),
    placement(color=16), placement(color=24), placement() + '0 !colour Custom CODE 4 VALUE #FF0000 EDGE #000000',
    placement() + '3 4 0 0 0 1 0 0 0 1 0',
])
def test_models_cannot_override_parts_colors_or_recurse(model):
    with pytest.raises(ValueError):
        parse_inventory('bad.ldr', model.encode())


def test_compressed_repetition_cannot_expand_unbounded():
    model = ''
    for index in range(8):
        model += f'0 FILE sub{index}.ldr\n' + placement(f'sub{index+1}.ldr') * 10
    model += '0 FILE sub8.ldr\n' + placement()
    with pytest.raises(ValueError, match='limit'):
        parse_inventory('huge.mpd', model.encode())


def test_request_quantities_are_strict_integers_and_combined_limits_are_bounded():
    for quantity in [True, 1.5, '3', 0]:
        with pytest.raises(ValidationError):
            InventoryPart(part_id='3001', color_id=4, quantity=quantity)
    with pytest.raises(ValidationError):
        PartsInventory(name='too many', parts=[InventoryPart(part_id='3001', color_id=4, quantity=60000)] * 2)


def test_common_modern_colors_and_transparent_colors_are_available():
    from src.utils.parts_inventory import mapped_color
    assert mapped_color(71, 'rebrickable') == 71
    assert mapped_color(86, 'bricklink') == 71
    assert mapped_color(47, 'rebrickable') == 47
    assert mapped_color(12, 'bricklink') == 47  # Trans-Clear.


def test_studio_alternate_render_export_is_not_counted_or_used_as_an_override():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('model.ldr', placement(color=4))
        archive.writestr('model2.ldr', placement(color=5) + '0 FILE 3001.dat\n3 16 0 0 0 1 0 0 0 1 0')
    assert parse_inventory('studio.io', buffer.getvalue()).parts == [InventoryPart(part_id='3001', color_id=4, quantity=1)]
