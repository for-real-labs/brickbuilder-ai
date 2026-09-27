import logging
from typing import List, Optional

from pydantic import BaseModel
from fastapi import HTTPException

from ..utils.generation_storage import generation_storage
from ..utils.posthog_client import track_api_call, track_error

logger = logging.getLogger(__name__)


class GetGenerationsByImageRequest(BaseModel):
    processed_image_url: str
    user_id: Optional[str] = None  # Optional - if not provided, uses auth_info


class GenerationInfo(BaseModel):
    """Basic generation information"""
    id: str
    user_id: str
    user_type: str
    prompt: str
    name: Optional[str] = None
    detail_level: float
    endpoint: str
    created_at: str
    updated_at: Optional[str] = None
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


class GetGenerationsByImageResponse(BaseModel):
    generations: List[GenerationInfo]
    total_count: int


async def get_generations_by_image(
    request: GetGenerationsByImageRequest, 
    auth_info: dict
) -> GetGenerationsByImageResponse:
    """
    Get all generations for a specific processed_image_url and user_id.
    This is useful for retrieving all edit iterations of a model.
    
    Args:
        request: GetGenerationsByImageRequest containing processed_image_url and optional user_id
        auth_info: Authentication information
        
    Returns:
        GetGenerationsByImageResponse with list of all generations for that image
    """
    try:
        user_id = auth_info.get("user_id")
        if request.user_id and request.user_id != user_id:
            raise HTTPException(status_code=403, detail="Cannot list another user's generations")

        if not user_id:
            raise HTTPException(status_code=401, detail="User ID not found")
        
        # Determine user type
        is_authenticated = auth_info.get("authenticated", False)
        user_type = "authenticated" if is_authenticated else "anonymous"
        user_email = auth_info.get("user_email", user_id if not is_authenticated else "unknown")
        
        # Track API call
        track_api_call(
            endpoint="/getGenerationsByImage",
            user_id=user_email,
            request_data={
                "processed_image_url": request.processed_image_url,
                "user_id": user_id,
                "user_type": user_type
            }
        )
        
        # Fetch generations with matching processed_image_url and user_id
        generations = await generation_storage.get_generations_by_image_url(
            processed_image_url=request.processed_image_url,
            user_id=user_id,
            user_type=user_type
        )
        
        logger.info(
            f"Retrieved {len(generations)} generations for processed_image_url "
            f"'{request.processed_image_url}' and user {user_email}"
        )
        
        # Convert to response model
        generation_infos = [GenerationInfo(**gen) for gen in generations]
        
        return GetGenerationsByImageResponse(
            generations=generation_infos,
            total_count=len(generation_infos)
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to retrieve generations by image")
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/getGenerationsByImage",
            user_id=auth_info.get("user_email", "unknown")
        )
        raise HTTPException(status_code=500, detail="Failed to retrieve generations")
