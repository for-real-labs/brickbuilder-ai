"""Parts-list uploads and read-only official set search."""
import asyncio
import logging

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import ValidationError

from ..utils.auth import supabase_client
from ..utils.lego_sets import CATALOG_TABLE, search_sets, set_inventory
from ..utils.parts_inventory import MAX_UPLOAD_BYTES, parse_inventory

router = APIRouter(prefix='/parts-inventory', tags=['Parts inventory'])
logger = logging.getLogger(__name__)


@router.post('/upload')
async def upload_inventory(file: UploadFile = File(...)):
    try:
        data = await file.read(MAX_UPLOAD_BYTES + 1)
    finally:
        await file.close()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, 'Choose a parts list smaller than 16 MB.')
    try:
        inventory = await asyncio.to_thread(parse_inventory, file.filename or '', data)
        return {'inventory': inventory.model_dump(), 'unavailable': []}
    except ValidationError:
        raise HTTPException(400, 'Each part needs a valid part ID, a specific color and a positive whole-number quantity. Lists may contain up to 100,000 pieces.') from None
    except (ValueError, UnicodeError) as exc:
        raise HTTPException(400, str(exc)) from None


@router.get('/sets')
async def find_sets(q: str = Query(min_length=2, max_length=100)):
    if supabase_client is None:
        raise HTTPException(503, 'Set search is unavailable. You can still upload a parts list.')
    try:
        rows = await asyncio.to_thread(search_sets, supabase_client, q)
        return {'sets': rows, 'source': 'Rebrickable'}
    except Exception:
        logger.exception('Set catalog search failed')
        raise HTTPException(503, 'Set search is temporarily unavailable. Upload a parts list or try again later.') from None


@router.get('/sets/{set_num}')
async def get_set_inventory(set_num: str):
    import re
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', set_num):
        raise HTTPException(400, 'Invalid LEGO set number.')
    if supabase_client is None:
        raise HTTPException(503, 'Set search is unavailable. You can still upload a parts list.')
    try:
        rows = await asyncio.to_thread(lambda: supabase_client.table(CATALOG_TABLE).select('*').eq('set_num', set_num).limit(1).execute().data)
    except Exception:
        logger.exception('Set catalog inventory read failed')
        raise HTTPException(503, 'Could not load this set. Upload its parts list or try again later.') from None
    if not rows:
        raise HTTPException(404, 'This set is not in our catalog. Download its parts list from Rebrickable or BrickLink and upload it here.')
    try:
        return await asyncio.to_thread(set_inventory, rows[0])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
