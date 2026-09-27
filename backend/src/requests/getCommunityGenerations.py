import logging
from typing import Literal, Optional, List

from pydantic import BaseModel
from fastapi import HTTPException

from ..utils.community_likes import is_community_likes_schema_error
from ..utils.generation_storage import generation_storage
from ..utils.posthog_client import track_api_call, track_error

logger = logging.getLogger(__name__)


class CommunityGeneration(BaseModel):
    """A community generation record"""
    id: str
    user_id: str
    user_type: str
    username: Optional[str] = None  # username of the generation's owner, if available
    prompt: str
    name: Optional[str] = None
    detail_level: float
    endpoint: str
    created_at: str
    status: str
    ldr_url: Optional[str] = None
    xyzrgb_url: Optional[str] = None
    parts_list_csv_url: Optional[str] = None
    original_image_url: Optional[str] = None
    processed_image_url: Optional[str] = None
    preview_image_url: Optional[str] = None
    external_image_url: Optional[str] = None
    external_glb_url: Optional[str] = None
    model_used_image: Optional[str] = None
    model_used_3d: Optional[str] = None
    ordered: Optional[bool] = False
    updated_at: Optional[str] = None
    is_community: Optional[bool] = True
    like_count: int = 0
    viewer_has_liked: bool = False


class GetCommunityGenerationsRequest(BaseModel):
    limit: int = 50
    offset: int = 0  # Offset for pagination (number of unique generations to skip)
    processing: Optional[bool] = None  # If True, return only processing/queued generations
    sort: Literal["recent", "top"] = "recent"


class GetCommunityGenerationsResponse(BaseModel):
    generations: List[CommunityGeneration]
    total_count: int
    has_more: bool = False  # Whether there are more generations beyond the current page


async def get_community_generations(
    request: GetCommunityGenerationsRequest,
    auth_info: dict,
) -> GetCommunityGenerationsResponse:
    """
    Get all generations in the `generations` table where `is_community` is true.

    - Applies `offset` and `limit` directly at the database level (no deduplication)
    - Returns `has_more` indicating if more pages exist

    Args:
        request: GetCommunityGenerationsRequest with limit, offset, processing
        auth_info: Authentication information (not required, used for tracking)

    Returns:
        GetCommunityGenerationsResponse with paginated community generations
    """
    user_email = auth_info.get("user_email", auth_info.get("user_id", "anonymous"))

    try:
        track_api_call(
            endpoint="/getCommunityGenerations",
            user_id=user_email,
            request_data={
                "limit": request.limit,
                "offset": request.offset,
                "processing": request.processing,
            },
        )

        # Apply status filter at database level if processing filter is requested
        status_filter = ["processing", "queued", "started"] if request.processing else None

        # Fetch one extra row to determine if more pages exist
        generations_batch = await generation_storage.get_community_generations(
            limit=request.limit + 1,
            status_filter=status_filter,
            offset=request.offset,
            sort=request.sort,
        )

        has_more = len(generations_batch) > request.limit
        generations = generations_batch[:request.limit]

        if not generations:
            return GetCommunityGenerationsResponse(
                generations=[],
                total_count=0,
                has_more=False,
            )

        logger.info(
            f"Retrieved {len(generations)} community generations "
            f"(offset={request.offset}, has_more={has_more})"
            + (f" (filtered by status: {status_filter})" if status_filter else "")
        )

        # Batch-fetch usernames for all authenticated owners of the page
        usernames_by_user_id: dict = {}
        owner_ids = sorted({
            gen.get("user_id")
            for gen in generations
            if gen.get("user_type") == "authenticated" and gen.get("user_id")
        })
        if owner_ids:
            try:
                profile_result = (
                    generation_storage.client
                    .table("user_profiles")
                    .select("id, username")
                    .in_("id", owner_ids)
                    .execute()
                )
                for row in (profile_result.data or []):
                    if row.get("id") and row.get("username"):
                        usernames_by_user_id[row["id"]] = row["username"]
            except Exception as e:
                # Non-fatal: just leave usernames as None
                logger.warning(f"Failed to fetch usernames for community generations: {e}")

        viewer_likes = set()
        viewer_user_id = auth_info.get("user_id")
        if (
            viewer_user_id
            and auth_info.get("authenticated", False)
            and not auth_info.get("is_anonymous", False)
        ):
            generation_ids = [gen.get("id") for gen in generations if gen.get("id")]
            if generation_ids:
                try:
                    likes_result = (
                        generation_storage.client
                        .table("generation_likes")
                        .select("generation_id")
                        .eq("user_id", viewer_user_id)
                        .in_("generation_id", generation_ids)
                        .execute()
                    )
                    viewer_likes = {
                        row.get("generation_id")
                        for row in (likes_result.data or [])
                        if row.get("generation_id")
                    }
                except Exception as e:
                    if is_community_likes_schema_error(e):
                        logger.warning(
                            "Community likes schema unavailable while fetching viewer likes; "
                            "defaulting viewer_has_liked to false"
                        )
                    else:
                        raise

        community_generations = [
            CommunityGeneration(
                id=gen.get("id"),
                user_id=gen.get("user_id"),
                user_type=gen.get("user_type"),
                username=usernames_by_user_id.get(gen.get("user_id")),
                prompt=gen.get("prompt", ""),
                name=gen.get("name"),
                detail_level=gen.get("detail_level", 0),
                endpoint=gen.get("endpoint", ""),
                created_at=gen.get("created_at", ""),
                status=gen.get("status", ""),
                ldr_url=gen.get("ldr_url"),
                xyzrgb_url=gen.get("xyzrgb_url"),
                parts_list_csv_url=gen.get("parts_list_csv_url"),
                original_image_url=gen.get("original_image_url"),
                processed_image_url=gen.get("processed_image_url"),
                preview_image_url=gen.get("preview_image_url"),
                external_image_url=gen.get("external_image_url"),
                external_glb_url=gen.get("external_glb_url"),
                model_used_image=gen.get("model_used_image"),
                model_used_3d=gen.get("model_used_3d"),
                ordered=gen.get("ordered", False),
                updated_at=gen.get("updated_at"),
                is_community=gen.get("is_community", True),
                like_count=int(gen.get("like_count") or 0),
                viewer_has_liked=gen.get("id") in viewer_likes,
            )
            for gen in generations
        ]

        return GetCommunityGenerationsResponse(
            generations=community_generations,
            total_count=len(community_generations),
            has_more=has_more,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to get community generations")
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/getCommunityGenerations",
            user_id=user_email,
        )
        raise HTTPException(status_code=500, detail="Failed to retrieve community generations")
