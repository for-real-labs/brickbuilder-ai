import logging
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel

from ..utils.generation_storage import generation_storage
from ..utils.community_likes import is_community_likes_schema_error
from ..utils.posthog_client import track_error

logger = logging.getLogger(__name__)


class GetGenerationLikeStatusRequest(BaseModel):
    generation_id: str


class GetGenerationLikeStatusResponse(BaseModel):
    generation_id: str
    is_community: bool
    like_count: int = 0
    viewer_has_liked: bool = False


async def get_generation_like_status(
    request: GetGenerationLikeStatusRequest,
    auth_info: dict,
) -> GetGenerationLikeStatusResponse:
    user_id: Optional[str] = auth_info.get("user_id")

    try:
        if generation_storage is None:
            raise HTTPException(
                status_code=404,
                detail=f"Generation {request.generation_id} not found",
            )

        like_count_available = True
        try:
            result = (
                generation_storage.client
                .table("generations")
                .select("id, is_community, like_count")
                .eq("id", request.generation_id)
                .execute()
            )
        except Exception as error:
            if not is_community_likes_schema_error(error):
                raise
            like_count_available = False
            result = (
                generation_storage.client
                .table("generations")
                .select("id, is_community")
                .eq("id", request.generation_id)
                .execute()
            )

        if not result.data:
            raise HTTPException(
                status_code=404,
                detail=f"Generation {request.generation_id} not found",
            )

        row = result.data[0]
        viewer_has_liked = False

        if user_id and auth_info.get("authenticated", False) and not auth_info.get("is_anonymous", False):
            try:
                like_result = (
                    generation_storage.client
                    .table("generation_likes")
                    .select("generation_id")
                    .eq("generation_id", request.generation_id)
                    .eq("user_id", user_id)
                    .limit(1)
                    .execute()
                )
                viewer_has_liked = bool(like_result.data)
            except Exception as error:
                if not is_community_likes_schema_error(error):
                    raise

        return GetGenerationLikeStatusResponse(
            generation_id=request.generation_id,
            is_community=bool(row.get("is_community")),
            like_count=int(row.get("like_count") or 0) if like_count_available else 0,
            viewer_has_liked=viewer_has_liked,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to get generation like status")
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/getGenerationLikeStatus",
            user_id=user_id or "anonymous",
        )
        raise HTTPException(status_code=500, detail="Failed to retrieve generation like status")
