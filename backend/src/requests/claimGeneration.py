import logging

from pydantic import BaseModel
from fastapi import HTTPException

from ..utils.generation_storage import generation_storage
from ..utils.auth import handle_auth_and_tracking
from ..utils.posthog_client import track_error

logger = logging.getLogger(__name__)


class ClaimGenerationRequest(BaseModel):
    generation_id: str


class ClaimGenerationResponse(BaseModel):
    generation_id: str
    claimed: bool


async def claim_generation(
    request: ClaimGenerationRequest,
    auth_info: dict,
) -> ClaimGenerationResponse:
    """
    Claim ownership of an anonymous generation for the authenticated user.

    This is used after a logged-out visitor signs in to take ownership of a
    generation they created while anonymous, proven by their guest session secret.

    Rules:
      - Requires authentication (anonymous callers are rejected with 401).
      - If the generation is already owned by the caller, this is a no-op.
      - Anonymous generations require the original guest session proof before
        reassignment (user_type -> "authenticated", user_id -> caller).
      - If the generation is owned by a different authenticated user, the
        caller receives 403.
    """
    user_email = "anonymous"

    try:
        # Require authentication: anonymous users cannot claim generations
        if auth_info.get("is_anonymous", False) or not auth_info.get("authenticated", False):
            raise HTTPException(
                status_code=401,
                detail="Authentication required to claim a generation",
            )

        user_info = handle_auth_and_tracking(
            auth_info=auth_info,
            endpoint="/claimGeneration",
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
            .select("id, generation_id, user_id, user_type")
            .eq("id", request.generation_id)
            .execute()
        )

        if not result.data:
            raise HTTPException(
                status_code=404,
                detail=f"Generation {request.generation_id} not found",
            )

        row = result.data[0]
        current_user_type = row.get("user_type")
        current_user_id = row.get("user_id")

        # Already owned by the caller — nothing to do.
        if current_user_type == "authenticated" and current_user_id == authenticated_user_id:
            return ClaimGenerationResponse(
                generation_id=request.generation_id,
                claimed=False,
            )

        # Owned by a different authenticated user — refuse.
        if current_user_type == "authenticated" and current_user_id != authenticated_user_id:
            raise HTTPException(
                status_code=403,
                detail="You do not have permission to claim this generation",
            )

        if (current_user_type != "anonymous" or not auth_info.get("guest_user_id")
                or current_user_id != auth_info["guest_user_id"]):
            raise HTTPException(status_code=403, detail="You do not own this guest generation")

        # Anonymous generation — reassign ownership to the caller. Scope the
        # update to the current anonymous owner as defense-in-depth so we never
        # overwrite a row that changed underneath us.
        update_result = (
            generation_storage.client
            .table("generations")
            .update({
                "user_id": authenticated_user_id,
                "user_type": "authenticated",
            })
            .eq("generation_id", row.get("generation_id", request.generation_id))
            .eq("user_type", "anonymous")
            .eq("user_id", auth_info["guest_user_id"])
            .execute()
        )

        if not update_result.data:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to claim generation {request.generation_id}",
            )

        logger.info(
            f"Claimed generation {request.generation_id} for authenticated user"
        )

        return ClaimGenerationResponse(
            generation_id=request.generation_id,
            claimed=True,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to claim generation")
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/claimGeneration",
            user_id=user_email,
        )
        raise HTTPException(status_code=500, detail="Failed to claim generation")
