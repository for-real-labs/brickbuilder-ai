import logging
from typing import Dict, Optional
from datetime import datetime, timedelta

from pydantic import BaseModel, Field
from fastapi import HTTPException

from ..utils.authorization import require_generation_access
from ..utils.generation_storage import generation_storage
from ..utils.posthog_client import track_error

logger = logging.getLogger(__name__)


class GetGenerationRequest(BaseModel):
    generation_id: str


class GetGenerationResponse(BaseModel):
    source_generation_id: Optional[str] = None
    endpoint: Optional[str] = None
    generation_id: str
    status: str  # "started", "queued", "processing", "ldr_processing", "completed", "failed"
    prompt: Optional[str] = None
    name: Optional[str] = None
    created_at: Optional[str] = None
    generation_duration_seconds: Optional[float] = None
    detail_level: Optional[float] = None
    ldr_content: Optional[str] = None  # Only available when completed
    mpd_url: Optional[str] = None  # Only available when completed
    external_image_url: Optional[str] = None  # Available during processing and completed
    processed_image_url: Optional[str] = None  # Available when image processing is done
    preview_image_url: Optional[str] = None  # User-uploaded preview image, if set
    reference_images: Dict[str, str] = Field(default_factory=dict)
    xyzrgb_url: Optional[str] = None
    problematic_xyzrgb_url: Optional[str] = None
    error_message: Optional[str] = None  # Only when failed


async def get_generation(request: GetGenerationRequest, auth_info: dict) -> GetGenerationResponse:
    """
    Get generation status and data by generation ID.
    
    This endpoint is used for polling to check generation progress.
    Private jobs require their owner; completed community models remain public.
    
    Returns:
        - status: "started" | "queued" | "processing" | "ldr_processing" | "completed" | "failed"
        - external_image_url: Available once image generation is done (during processing)
        - ldr_content, mpd_url: Available when status is "completed"
        - error_message: Available when status is "failed"
    """
    # Generation storage requires Supabase. When it is not configured there is
    # nothing to retrieve, so report the generation as not found rather than 500.
    if generation_storage is None:
        raise HTTPException(
            status_code=404,
            detail=f"Generation {request.generation_id} not found",
        )

    try:

        # Get the generation record
        generation = await generation_storage.get_generation(request.generation_id)
        if not generation:
            raise HTTPException(status_code=404, detail=f"Generation {request.generation_id} not found")

        require_generation_access(generation, auth_info, allow_community=True)

        # Extract fields
        status = generation.get("status", "started")
        prompt = generation.get("prompt")
        name = generation.get("name")
        detail_level = generation.get("detail_level")
        external_image_url = generation.get("external_image_url")
        processed_image_url = generation.get("processed_image_url")
        preview_image_url = generation.get("preview_image_url")
        reference_images = generation.get("reference_images") or {}
        xyzrgb_url = generation.get("xyzrgb_url")
        problematic_xyzrgb_url = generation.get("problematic_xyzrgb_url")
        error_message = generation.get("error_message")
        ldr_url = generation.get("ldr_url")
        mpd_url = generation.get("mpd_url")
        
        # Check for stuck generations (no heartbeat for 30+ seconds)
        if status in ["processing", "queued", "started", "ldr_processing"]:
            updated_at_str = generation.get("updated_at")
            if updated_at_str:
                try:
                    # Parse timestamp (handle Z and +00:00 formats)
                    updated_at_clean = updated_at_str.replace('Z', '+00:00')
                    updated_at = datetime.fromisoformat(updated_at_clean)
                    
                    # Make timezone-aware current time
                    if updated_at.tzinfo:
                        now = datetime.now(updated_at.tzinfo)
                    else:
                        now = datetime.utcnow()
                    
                    # If no update for 30 seconds, mark as failed (server likely crashed)
                    time_since_update = now - updated_at
                    if time_since_update > timedelta(seconds=30):
                        await generation_storage.update_status(
                            request.generation_id, 
                            "failed", 
                            "Generation interrupted - server may have restarted"
                        )
                        status = "failed"
                        error_message = "Generation timed out (no heartbeat detected)"
                        logger.warning(f"Marked stuck generation {request.generation_id} as failed (no heartbeat for {time_since_update})")
                        
                except Exception as e:
                    logger.warning(f"Failed to check timeout for {request.generation_id}: {e}")

        # Build response based on status
        response = GetGenerationResponse(
            source_generation_id=generation.get("source_generation_id"),
            endpoint=generation.get("endpoint"),
            generation_id=request.generation_id,
            status=status,
            prompt=prompt,
            name=name,
            created_at=generation.get("created_at"),
            generation_duration_seconds=generation.get("generation_duration_seconds"),
            detail_level=detail_level,
            external_image_url=external_image_url,
            processed_image_url=processed_image_url,
            preview_image_url=preview_image_url,
            reference_images=reference_images,
            xyzrgb_url=xyzrgb_url,
            problematic_xyzrgb_url=problematic_xyzrgb_url,
            error_message=error_message,
            mpd_url=mpd_url
        )

        # Only download and include LDR content when completed
        if status == "completed" and ldr_url:
            try:
                ldr_content_bytes = await generation_storage.download_file_from_storage(ldr_url)
                response.ldr_content = ldr_content_bytes.decode('utf-8')
            except Exception as e:
                logger.error(f"Failed to download LDR file from {ldr_url}: {e}")
                # Don't fail the request, just leave ldr_content as None

        # logger.info(f"Retrieved generation {request.generation_id} with status: {status}")
        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to get generation")
        track_error(
            error_type=type(e).__name__, 
            error_message=str(e), 
            endpoint="/getGeneration", 
            user_id="unknown"
        )
        raise HTTPException(status_code=500, detail="Failed to retrieve generation")
