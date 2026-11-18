import base64
import logging
import time

from pydantic import BaseModel, Field, validator
from fastapi import HTTPException

from ..utils.generation_storage import generation_storage
from ..utils.auth import handle_auth_and_tracking
from ..utils.posthog_client import track_error

logger = logging.getLogger(__name__)


class UpdateImagePreviewRequest(BaseModel):
    generation_id: str
    # Base64-encoded PNG/JPEG image. Accepts raw base64 or a data URI
    # (e.g. "data:image/png;base64,iVBORw0...").
    image_base64: str = Field(..., min_length=1)

    @validator("image_base64")
    def validate_base64(cls, v: str) -> str:
        # Strip data URL prefix if present
        if v.startswith("data:"):
            try:
                v = v.split(",", 1)[1]
            except IndexError:
                raise ValueError("Invalid data URI for image_base64")

        # Validate it's decodable base64
        try:
            base64.b64decode(v, validate=True)
        except Exception as e:
            raise ValueError(f"Invalid base64 image data: {e}")

        return v


class UpdateImagePreviewResponse(BaseModel):
    generation_id: str
    preview_image_url: str


async def update_image_preview(
    request: UpdateImagePreviewRequest,
    auth_info: dict,
) -> UpdateImagePreviewResponse:
    """
    Upload a preview image for a generation and store its URL in the
    `preview_image_url` column of the generations table.

    Requires the authenticated user to be the owner (`user_id`) of the
    generation row.
    """
    user_email = "anonymous"

    try:
        # Require authentication: anonymous users cannot update preview image
        if auth_info.get("is_anonymous", False) or not auth_info.get("authenticated", False):
            raise HTTPException(
                status_code=401,
                detail="Authentication required to update preview image",
            )

        user_info = handle_auth_and_tracking(
            auth_info=auth_info,
            endpoint="/updateImagePreview",
            track_properties={"generation_id": request.generation_id},
            required_credits=0,
        )
        user_email = user_info["user_email"]
        authenticated_user_id = auth_info.get("user_id")

        if not authenticated_user_id:
            raise HTTPException(
                status_code=401,
                detail="Authenticated user has no user_id",
            )

        # Fetch ownership info
        result = (
            generation_storage.client
            .table("generations")
            .select("id, user_id, user_type, deleted_at")
            .eq("id", request.generation_id)
            .execute()
        )

        if not result.data or result.data[0].get("deleted_at"):
            raise HTTPException(
                status_code=404,
                detail=f"Generation {request.generation_id} not found",
            )

        row = result.data[0]

        # Verify the authenticated user owns this generation
        if row.get("user_type") != "authenticated" or row.get("user_id") != authenticated_user_id:
            raise HTTPException(
                status_code=403,
                detail="You do not have permission to modify this generation",
            )

        # Decode base64 and upload to Supabase Storage
        try:
            image_bytes = base64.b64decode(request.image_base64)
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to decode image_base64: {e}",
            )

        # Mirror the processed_image_url path/naming pattern (timestamp busts CDN cache)
        timestamp = int(time.time())
        file_path = f"generations/{request.generation_id}/preview_image_{timestamp}.png"

        try:
            preview_image_url = await generation_storage._upload_file_to_storage(
                file_content=image_bytes,
                file_path=file_path,
                content_type="image/png",
            )
        except Exception as e:
            logger.error(f"Failed to upload preview image for generation {request.generation_id}: {e}")
            raise HTTPException(
                status_code=500,
                detail="Failed to upload preview image to storage",
            )

        # Save preview_image_url to the row (scoped to owner as defense-in-depth)
        update_result = (
            generation_storage.client
            .table("generations")
            .update({"preview_image_url": preview_image_url})
            .eq("id", request.generation_id)
            .eq("user_id", authenticated_user_id)
            .eq("user_type", "authenticated")
            .execute()
        )

        if not update_result.data:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to update preview_image_url for generation {request.generation_id}",
            )

        logger.info(
            f"Updated preview_image_url for generation {request.generation_id}"
        )

        return UpdateImagePreviewResponse(
            generation_id=request.generation_id,
            preview_image_url=preview_image_url,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to update image preview")
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/updateImagePreview",
            user_id=user_email,
        )
        raise HTTPException(status_code=500, detail="Failed to update image preview")
