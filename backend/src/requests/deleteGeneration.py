"""Remove an owned model or version from the app and its public links."""

import asyncio
import logging
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel

from ..utils.database import execute_query
from ..utils.generation_storage import generation_storage
from ..utils.local_db import LocalSupabaseClient

logger = logging.getLogger(__name__)


class DeleteGenerationRequest(BaseModel):
    scope: Literal['version', 'model']


class DeleteGenerationResponse(BaseModel):
    next_generation_id: str | None


async def delete_generation(generation_id: str, request: DeleteGenerationRequest, auth_info: dict) -> DeleteGenerationResponse:
    owner = auth_info.get('user_id')
    if not owner:
        raise HTTPException(401, 'Sign in or use the browser where you created this model.')
    if generation_storage is None:
        raise HTTPException(503, 'Model storage is unavailable. Please try again.')

    owner_type = 'authenticated' if auth_info.get('authenticated') else 'anonymous'
    whole_model = request.scope == 'model'
    client = generation_storage.client
    try:
        if isinstance(client, LocalSupabaseClient):
            result = await asyncio.to_thread(client.delete_generation_revision, generation_id, owner, owner_type, whole_model)
        else:
            result = (await execute_query(client.rpc('delete_generation_revision', {
                'p_id': generation_id, 'p_owner': owner, 'p_type': owner_type, 'p_whole_model': whole_model,
            }))).data
        return DeleteGenerationResponse.model_validate(result)
    except Exception as error:
        message = str(error)
        if 'BB_DELETE_NOT_FOUND' in message:
            raise HTTPException(404, 'Model not found.') from None
        if 'BB_DELETE_ACTIVE' in message:
            raise HTTPException(409, 'Wait for the build to finish or cancel it before deleting.') from None
        logger.exception('Could not delete model version %s', generation_id)
        raise HTTPException(503, 'Could not delete this model. Please try again.') from None
