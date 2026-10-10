"""Persist unvalidated LDraw uploads for preview and catalog-constrained Nova edits."""
import asyncio
import logging
from pathlib import PurePosixPath

from fastapi import HTTPException, UploadFile
from pydantic import BaseModel

from ..utils.auth import handle_auth_and_tracking
from ..utils.generation_storage import generation_storage
from ..utils.ldraw_upload import MAX_UPLOAD_BYTES, normalize_ldraw_upload

logger = logging.getLogger(__name__)


class UploadLdrawResponse(BaseModel):
    generation_id: str
    message: str = 'Model imported. Open it to edit with AI.'


async def upload_ldraw(file: UploadFile, auth_info: dict) -> UploadLdrawResponse:
    if generation_storage is None:
        raise HTTPException(503, 'Generation storage is unavailable')
    try:
        data = await file.read(MAX_UPLOAD_BYTES + 1)
    finally:
        await file.close()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, 'Choose a model smaller than 16 MB.')
    filename = file.filename or 'model.ldr'
    try:
        model = await asyncio.to_thread(normalize_ldraw_upload, filename, data)
    except (ValueError, UnicodeError) as exc:
        raise HTTPException(400, str(exc)) from None
    info = handle_auth_and_tracking(auth_info, '/uploadLdraw', {'format': PurePosixPath(filename).suffix.lower()}, required_credits=0)
    owner = auth_info.get('user_id') or info['user_email']
    name = PurePosixPath(filename.replace('\\', '/')).stem[:120] or 'Imported LDraw model'
    generation_id = await generation_storage.create_generation(
        user_id=owner, user_type='anonymous' if info['is_anonymous'] else 'authenticated',
        prompt=f'Imported LDraw model: {name}', detail_level=40, endpoint='uploadLdraw', model_3d='ldraw-import',
    )
    try:
        await generation_storage.store_model_file(generation_id, model, 'ldr', raise_on_error=True)
        await asyncio.to_thread(lambda: generation_storage.client.table('generations').update({
            'name': name, 'example_edit_prompt': 'Adapt this model to use only available Brickwith parts and colors, preserving its appearance.'
        }).eq('id', generation_id).execute())
        await generation_storage.update_status(generation_id, 'completed')
    except Exception:
        logger.exception('Failed to save imported model %s', generation_id)
        await generation_storage.update_status(generation_id, 'failed', 'Unable to save the uploaded model. Please try again.')
        raise HTTPException(503, 'Unable to save the uploaded model. Please try again.') from None
    return UploadLdrawResponse(generation_id=generation_id)
