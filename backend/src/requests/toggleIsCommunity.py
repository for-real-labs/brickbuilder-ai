import logging

from pydantic import BaseModel
from fastapi import HTTPException

from ..utils.generation_storage import generation_storage
from ..utils.auth import handle_auth_and_tracking
from ..utils.posthog_client import track_error

logger = logging.getLogger(__name__)


class ToggleIsCommunityRequest(BaseModel):
    generation_id: str


class ToggleIsCommunityResponse(BaseModel):
    generation_id: str
    is_community: bool


async def toggle_is_community(
    request: ToggleIsCommunityRequest,
    auth_info: dict,
) -> ToggleIsCommunityResponse:
    """
    Toggle the `is_community` column for a generation row in Supabase.

    Reads the current `is_community` value and flips it to the opposite boolean.
    Treats a missing/null value as False (so toggling sets it to True).
    """
    user_email = "anonymous"

    try:
        # Require authentication: anonymous users cannot toggle community flag
        if auth_info.get("is_anonymous", False) or not auth_info.get("authenticated", False):
            raise HTTPException(
                status_code=401,
                detail="Authentication required to toggle community flag",
            )

        user_info = handle_auth_and_tracking(
            auth_info=auth_info,
            endpoint="/toggleIsCommunity",
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

        # Fetch current value plus ownership info
        result = (
            generation_storage.client
            .table("generations")
            .select("id, is_community, user_id, user_type, deleted_at")
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

        current_value = bool(row.get("is_community") or False)
        new_value = not current_value

        # Update with toggled value (scoped to owner as defense-in-depth)
        update_result = (
            generation_storage.client
            .table("generations")
            .update({"is_community": new_value})
            .eq("id", request.generation_id)
            .eq("user_id", authenticated_user_id)
            .eq("user_type", "authenticated")
            .execute()
        )

        if not update_result.data:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to update is_community for generation {request.generation_id}",
            )

        logger.info(
            f"Toggled is_community for generation {request.generation_id}: "
            f"{current_value} -> {new_value}"
        )

        return ToggleIsCommunityResponse(
            generation_id=request.generation_id,
            is_community=new_value,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to toggle is_community")
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/toggleIsCommunity",
            user_id=user_email,
        )
        raise HTTPException(status_code=500, detail="Failed to toggle is_community")
