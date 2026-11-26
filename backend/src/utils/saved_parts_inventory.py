"""Store the exact set inventory with its generation and reload it for owner edits."""
import asyncio

from fastapi import HTTPException

from .parts_inventory import PartsInventory
from .storage_upload import upload_artifact


async def save_inventory(storage, generation_id: str, inventory: PartsInventory | None):
    if inventory is None:
        return
    try:
        bucket = storage.client.storage.from_('generation-output')
        await upload_artifact(bucket, path=f'{generation_id}/parts-inventory.json',
                              file=inventory.model_dump_json().encode(), content_type='application/json')
        await asyncio.to_thread(lambda: storage.client.table('generations').update({
            'has_parts_inventory': True
        }).eq('id', generation_id).execute())
    except Exception:
        message = 'Could not save the parts inventory. Please try again.'
        await storage.update_status(generation_id, 'failed', message)
        raise HTTPException(503, message) from None


async def load_inventory(storage, artifact_id: str) -> PartsInventory:
    try:
        bucket = storage.client.storage.from_('generation-output')
        data = await asyncio.to_thread(bucket.download, f'{artifact_id}/parts-inventory.json')
        if len(data) > 2 * 1024 * 1024:
            raise ValueError('Oversized inventory')
        return PartsInventory.model_validate_json(data)
    except Exception:
        raise HTTPException(409, 'The original parts inventory is unavailable. Upload it again to start a new build.') from None
