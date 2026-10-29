"""Resolve an owned order's saved BOM without fetching arbitrary URLs."""
import asyncio
import logging
from urllib.parse import unquote, urlparse

from fastapi import HTTPException

from .authorization import require_generation_access
from .database import execute_query
from .generation_storage import generation_storage
from .parts_inventory import MAX_UPLOAD_BYTES, parse_inventory

logger = logging.getLogger(__name__)


async def inventory_from_order(order_id: int, auth_info: dict) -> dict:
    if not auth_info.get('user_id'):
        raise HTTPException(401, 'Sign in to view your previous orders.')
    try:
        result = await execute_query(generation_storage.client.table('orders')
            .select('id,generation_id,cancelled,parts_list_csv_url').eq('id', order_id).limit(1))
    except Exception:
        logger.exception('Order inventory lookup failed')
        raise HTTPException(503, 'Could not load this order. Please try again.') from None
    order = next(iter(result.data or []), None)
    if not order:
        raise HTTPException(404, 'Order not found')
    generation = await generation_storage.get_generation(order['generation_id'])
    if not generation:
        raise HTTPException(404, 'Order not found')
    require_generation_access(generation, auth_info)
    if order.get('cancelled'):
        raise HTTPException(409, 'This order was cancelled. Choose another order or upload a parts list.')

    # Use the snapshot recorded at checkout, never a later version of the model.
    path = unquote(urlparse(order.get('parts_list_csv_url') or '').path)
    markers = ('/storage/v1/object/public/generations/', '/local-storage/generations/')
    relative = next((path.split(marker, 1)[1] for marker in markers if marker in path), '')
    if (not relative.startswith(f"generations/{generation['id']}/")
            or '..' in relative.split('/') or '\\' in relative or not relative.endswith('.csv')):
        raise HTTPException(422, 'This order has no saved parts list. Upload its original parts list instead.')
    try:
        data = await asyncio.to_thread(generation_storage.client.storage.from_('generations').download, relative)
    except Exception:
        logger.warning('Saved order parts list unavailable for order %s', order_id)
        raise HTTPException(503, 'This order’s parts list is unavailable. Try again or upload it manually.') from None
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, 'This order’s parts list exceeds the 16 MB upload limit.')
    try:
        inventory = await asyncio.to_thread(parse_inventory, 'order.csv', data)
        inventory.name = f"{generation.get('name') or generation.get('prompt') or 'Your model'} (Order #{order_id})"[:200]
        inventory.source = 'order'
        # Revalidate the generated label as well as the stored quantities.
        inventory = type(inventory).model_validate(inventory.model_dump())
    except ValueError:
        raise HTTPException(422, 'This order’s saved parts list could not be read exactly. Upload its original parts list instead.') from None
    return {'inventory': inventory.model_dump(), 'unavailable': []}
