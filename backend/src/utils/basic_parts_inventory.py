"""Exact compatibility with the basic-brick converter's checked-in palette."""
from ..data.brick_library import brick_library
from .brick_design import load_palette, audit_ldraw
from .parts_catalog import normalize_part_id, flat_model_inventory
from .parts_inventory import PartsInventory


def basic_inventory_compatibility(inventory: PartsInventory) -> dict:
    part_ids = {normalize_part_id(part['partID']) for part in brick_library.values()}
    colors = load_palette()
    available, unavailable = [], []
    for part in inventory.parts:
        (available if part.part_id in part_ids and part.color_id in colors else unavailable).append(part)
    return {
        'inventory': inventory.model_copy(update={'parts': available}).model_dump() if available else None,
        'available_count': sum(p.quantity for p in available),
        'unavailable_count': sum(p.quantity for p in unavailable),
        'unavailable': [p.model_dump() for p in unavailable],
    }


def basic_inventory(inventory: PartsInventory) -> PartsInventory:
    compatible = basic_inventory_compatibility(inventory)['inventory']
    if compatible is None:
        raise ValueError('No pieces in this inventory match the Basic bricks palette. Choose All parts.')
    return PartsInventory.model_validate(compatible)


def validate_inventory_model(ldr: str, inventory: PartsInventory) -> None:
    basic_inventory(inventory).catalog().validate(flat_model_inventory(ldr))
    audit = audit_ldraw(ldr)
    if not audit.ok or audit.skipped:
        raise ValueError('Repair the Basic bricks placement: ' + audit.describe())
