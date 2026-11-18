import logging

from pydantic import BaseModel, Field
from fastapi import HTTPException

from ..utils.generation_storage import generation_storage
from ..utils.auth import handle_auth_and_tracking
from ..utils.posthog_client import track_error

logger = logging.getLogger(__name__)


class UpdateGenerationNameRequest(BaseModel):
    generation_id: str
    name: str = Field(..., min_length=1, max_length=200)


class UpdateGenerationNameResponse(BaseModel):
    generation_id: str
    name: str


async def update_generation_name(
    request: UpdateGenerationNameRequest,
    auth_info: dict,
) -> UpdateGenerationNameResponse:
    """
    Update the `name` column for a generation row in Supabase.

    Requires the authenticated user to be the owner (`user_id`) of the
    generation row.
    """
    user_email = "anonymous"

    try:
        # Require authentication: anonymous users cannot rename generations
        if auth_info.get("is_anonymous", False) or not auth_info.get("authenticated", False):
            raise HTTPException(
                status_code=401,
                detail="Authentication required to update generation name",
            )

        user_info = handle_auth_and_tracking(
            auth_info=auth_info,
            endpoint="/updateGenerationName",
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

        new_name = request.name.strip()
        if not new_name:
            raise HTTPException(
                status_code=400,
                detail="Name cannot be empty",
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

        # Update the name (scoped to owner as defense-in-depth)
        update_result = (
            generation_storage.client
            .table("generations")
            .update({"name": new_name})
            .eq("id", request.generation_id)
            .eq("user_id", authenticated_user_id)
            .eq("user_type", "authenticated")
            .execute()
        )

        if not update_result.data:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to update name for generation {request.generation_id}",
            )

        logger.info(
            f"Updated name for generation {request.generation_id} to '{new_name}'"
        )

        return UpdateGenerationNameResponse(
            generation_id=request.generation_id,
            name=new_name,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to update generation name")
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/updateGenerationName",
            user_id=user_email,
        )
        raise HTTPException(status_code=500, detail="Failed to update generation name")
