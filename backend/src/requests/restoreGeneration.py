"""Save a completed snapshot as the next revision without another build."""

import logging
import os
from datetime import datetime, timezone
from uuid import NAMESPACE_URL, UUID, uuid5

from fastapi import HTTPException
from pydantic import BaseModel

from ..utils.database import execute_query
from ..utils.generation_storage import generation_storage

logger = logging.getLogger(__name__)

# Copy model data only. Orders, publication, job state, usage and notifications
# belong to their original revisions.
SNAPSHOT_COLUMNS = (
    "prompt", "name", "example_edit_prompt", "detail_level", "max_parts", "mode",
    "input_type", "input_format", "entry_page", "model_used_image", "model_used_3d",
    "nova_build_mode", "has_parts_inventory", "brick_count", "reference_images",
    "ldr_url", "mpd_url", "parts_list_csv_url", "glb_url", "external_glb_url",
    "xyzrgb_url", "problematic_xyzrgb_url", "sam3d_voxel_data_url", "design_voxels_url",
    "original_image_url", "processed_image_url", "external_image_url", "preview_image_url",
    "input_image_name",
)


class RestoreGenerationRequest(BaseModel):
    request_id: UUID


class RestoreGenerationResponse(BaseModel):
    generation_id: str


async def restore_generation(source_id: str, request: RestoreGenerationRequest, auth_info: dict) -> RestoreGenerationResponse:
    if generation_storage is None:
        raise HTTPException(503, "Model storage is unavailable. Please try again.")

    owner_id = auth_info.get("user_id")
    owner_type = "authenticated" if auth_info.get("authenticated") else "anonymous"
    if not owner_id:
        raise HTTPException(401, "Sign in or use the browser where you created this model.")
    source = await generation_storage.get_generation(source_id)
    if not source or (source.get("user_id"), source.get("user_type")) != (owner_id, owner_type):
        raise HTTPException(404, "Generation not found")
    if source.get("status") != "completed" or not (source.get("ldr_url") or source.get("mpd_url")):
        raise HTTPException(409, "This version has no completed model to restore.")

    model_id = source["generation_id"]
    artifact_id = source.get("restored_from_id") or source_id
    revision_id = str(uuid5(NAMESPACE_URL, f"brickbuilder:restore:{source_id}:{request.request_id}"))

    async def already_restored() -> bool:
        existing = await generation_storage.get_generation(revision_id)
        return bool(existing and existing.get("restored_from_id") == artifact_id
                    and existing.get("generation_id") == model_id
                    and (existing.get("user_id"), existing.get("user_type")) == (owner_id, owner_type))

    if await already_restored():
        return RestoreGenerationResponse(generation_id=revision_id)

    now = datetime.now(timezone.utc).isoformat()
    revision = {key: source[key] for key in SNAPSHOT_COLUMNS if source.get(key) is not None}
    revision.update(
        id=revision_id, generation_id=model_id, restored_from_id=source_id,
        user_id=owner_id, user_type=owner_type, endpoint="updateModel", status="completed",
        created_at=now, updated_at=now, notification_seen=True, is_community=False,
        billing_policy_version=2, billing_livemode=os.getenv("API_MODE") == "production",
    )
    try:
        await execute_query(generation_storage.client.table("generations").insert(revision))
    except Exception as error:
        # A duplicate submission or a lost response may follow a committed insert.
        if not await already_restored():
            message = str(error)
            if "BB_RESTORE_NOT_OLDER" in message:
                raise HTTPException(409, "Only an older completed version can be restored.") from None
            if "BB_RESTORE_SOURCE_CHANGED" in message:
                raise HTTPException(409, "This version changed. Reload the model and try again.") from None
            if "BB_GENERATION_DAILY_LIMIT" in message:
                raise HTTPException(429, "Your daily model limit has been reached. Please try again tomorrow.") from None
            logger.exception("Failed to restore model version %s", source_id)
            raise HTTPException(503, "Could not restore this version. Please try again.") from None
    if not revision.get("preview_image_url"):
        await generation_storage.ensure_generation_preview({**revision, "restored_from_id": artifact_id})
    return RestoreGenerationResponse(generation_id=revision_id)
