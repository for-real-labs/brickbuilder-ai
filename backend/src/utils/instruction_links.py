"""Order-scoped bearer links; only the verification hash is stored in orders."""
import hashlib
import re
import secrets
from urllib.parse import urlencode
from fastapi import HTTPException

from . import auth
from .database import execute_query


def new_instruction_key():
    return secrets.token_urlsafe(32)


def instruction_key_hash(key):
    return hashlib.sha256(key.encode('ascii')).hexdigest()


def instruction_link(generation_id, key, *, postcard=False):
    page = 'order' if postcard else ''
    query = {'id': generation_id}
    if not postcard:
        query.update(exact='1', instructions='1')
    return f'https://brickbuilder.ai/{page}?' + urlencode(query) + '#access=' + key


async def has_instruction_key(generation_id, key):
    if not key or not re.fullmatch(r'[A-Za-z0-9_-]{43}', key):
        return False
    if not auth.supabase_client:
        return False
    result = await execute_query(auth.supabase_client.table('orders').select('id')
                                 .eq('generation_id', generation_id)
                                 .eq('instructions_key_hash', instruction_key_hash(key))
                                 .eq('cancelled', False).limit(1))
    return bool(result.data)


async def issue_order_instruction_link(order_id, *, replace=False):
    """Administrative recovery for old orders. Never replace a printed key implicitly."""
    if not auth.supabase_client:
        raise RuntimeError('The order database is unavailable.')
    orders = auth.supabase_client.table('orders')
    result = await execute_query(orders.select('id,generation_id,cancelled,instructions_key_hash').eq('id', order_id))
    if not result.data or result.data[0].get('cancelled'):
        raise HTTPException(404, 'Active order not found.')
    order = result.data[0]
    if order.get('instructions_key_hash') and not replace:
        raise HTTPException(409, 'A link already exists. Use the confirmation email, or explicitly replace the existing link.')
    key = new_instruction_key()
    query = auth.supabase_client.table('orders').update({'instructions_key_hash': instruction_key_hash(key)}).eq('id', order_id).eq('cancelled', False)
    if not replace:
        query = query.is_('instructions_key_hash', 'null')
    updated = await execute_query(query)
    if not updated.data:
        raise HTTPException(409, 'Order changed. Read the order again before issuing a link.')
    return {'instructions_url': instruction_link(order['generation_id'], key),
            'postcard_url': instruction_link(order['generation_id'], key, postcard=True)}
