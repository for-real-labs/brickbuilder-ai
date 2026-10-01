
import os
import sys
import logging
import asyncio
import uuid
from typing import Optional
from datetime import datetime
from fastapi import HTTPException, Depends, BackgroundTasks
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, validator
import base64

# Add parent directories to path for imports
sys.path.append(os.path.dirname(os.path.dirname(__file__)))
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

# Import auth functions and utilities
from ..utils.auth import get_user_with_optional_auth, verify_and_deduct_credits, handle_auth_and_tracking, deduct_credits
from ..utils.posthog_client import track_api_call, track_image_conversion, track_error
from ..utils.pack_ldraw_model import LDrawPacker

# Import shared utilities
from ..utils.generation_tasks import start_generation_task
from ..utils.generation_storage import generation_storage
from ..utils.generate_3d_model_from_image import generate_3d_model_from_image
from ..utils.generate_image import generate_image_from_image
from ..utils.sam3d_stream import run_streaming_pipeline
from ..utils.falApiClient import FalApiClient

# Configure logging
logger = logging.getLogger(__name__)


class ImageToBricksRequest(BaseModel):
    image_url: Optional[str] = None
    image_base64: Optional[str] = None
    prompt: Optional[str] = None
    detail_level: Optional[float] = 1.6  # Default to 1.6 for fewer bricks
    edit_image: Optional[bool] = True   # Flag to apply nano banana edit preprocessing
    model_option: Optional[str] = "a"  # Model option: "a" for trellis, "b" for trellis-2, "c" for sam3d
    prompt_option: Optional[str] = "a"  # Prompt option: "a", "b", or "c" to select prompt enhancement file
    stream: Optional[bool] = False  # If True, return an SSE stream (image frames always stream)
    stream_3d: Optional[bool] = True  # If True, use SAM3D streamed voxels; if False, use Trellis (non-streamed 3D)
    voxelizer: Optional[str] = "trimesh"  # Voxelizer for non-streamed 3D: "trimesh" or "obj2voxel"

    @validator('image_base64')
    def validate_base64(cls, v):
        if v is not None:
            # Validating base64 data
            
            # Remove data URL prefix if present (e.g., "data:image/jpeg;base64,")
            if v.startswith('data:'):
                # Removing data URL prefix
                v = v.split(',', 1)[1] if ',' in v else v
            
            # Validate base64 format
            try:
                base64.b64decode(v)
                # Base64 validation successful
                return v
            except Exception as e:
                logger.error(f"Base64 validation failed: {e}")
                raise ValueError("Invalid base64 image data")
        return v
    
    @validator('image_url')
    def validate_exactly_one_image(cls, v, values):
        image_base64 = values.get('image_base64')
        if v is None and image_base64 is None:
            # Both are None - this is fine, will use default
            return v
        if v is not None and image_base64 is not None:
            raise ValueError("Provide either image_url OR image_base64, not both")
        return v
    
    @validator('model_option')
    def validate_and_set_model(cls, v, values):
        if v not in ["a", "b", "c"]:
            raise ValueError("model_option must be either 'a' or 'b' or 'c'")
        return v
    
    @validator('prompt_option')
    def validate_prompt_option(cls, v):
        if v not in ["a", "b", "c"]:
            raise ValueError("prompt_option must be 'a', 'b', or 'c'")
        return v

    @validator('voxelizer')
    def validate_voxelizer(cls, v):
        if v not in ["trimesh", "obj2voxel"]:
            raise ValueError("voxelizer must be 'trimesh' or 'obj2voxel'")
        return v

    @validator('prompt')
    def normalize_prompt(cls, v):
        if v is None:
            return v
        v = v.strip()
        return v or None
    

class ImageToBricksResponse(BaseModel):
    """Response model for initial request - returns generation_id immediately"""
    generation_id: str
    message: str = "Generation started"


class ImageToBricksFullResponse(BaseModel):
    """Response model containing both LDR and MPD file contents (used by getGeneration)"""
    ldr_content: str
    mpd_content: str
    generation_id: Optional[str] = None
    message: str = "Successfully converted image to brick structure"


async def process_image_to_bricks_task(
    generation_id: str,
    image_input: str,
    is_base64: bool,
    model_3d: str,
    model_option: str,
    prompt_option: str,
    detail_level: float,
    edit_image: bool,
    user_info: dict,
    auth_info: dict,
    user_email: str,
    is_developer: bool,
    prompt: Optional[str] = None,
    storage_original_url: Optional[str] = None,
    voxelizer: str = "trimesh"
):
    """
    Background task that processes the image-to-bricks conversion.
    Updates generation status in DB as it progresses.
    """
    heartbeat_task = None
    try:
        # Capture the current event loop for callbacks from other threads
        main_loop = asyncio.get_running_loop()
        last_status = [None]  # Use list to allow mutation in nested function
        
        # Start heartbeat task - updates timestamp every 5 seconds to show we're alive
        async def heartbeat():
            while True:
                await asyncio.sleep(5)
                # Only update timestamp, don't override the actual status from fal.ai
                try:
                    generation_storage.client.table("generations").update({
                        "updated_at": datetime.utcnow().isoformat()
                    }).eq("id", generation_id).execute()
                except Exception as e:
                    logger.warning(f"Heartbeat update failed: {e}")
        
        heartbeat_task = asyncio.create_task(heartbeat())
        
        # Create status callback to update DB with fal.ai queue status
        def status_callback(status: str):
            """Sync callback that schedules async update on main loop"""
            if status == last_status[0]:
                return  # Skip duplicate status updates
            last_status[0] = status
            try:
                future = asyncio.run_coroutine_threadsafe(
                    generation_storage.update_status(generation_id, status),
                    main_loop
                )
                # Don't wait for result - fire and forget
            except Exception as e:
                logger.warning(f"Failed to update status callback: {e}")
        
        # Update status to processing
        await generation_storage.update_status(generation_id, "processing")
        
        # Step 1: If edit_image is enabled, apply nano banana preprocessing first
        image_input_for_3d = image_input
        is_base64_for_3d = is_base64
        prompt_enhancement = None
        
        if edit_image:
            logger.info("Applying nano banana edit preprocessing to image")
            original_resized_url, processed_image_url, prompt_enhancement = await asyncio.get_event_loop().run_in_executor(
                None, generate_image_from_image, image_input, is_base64, prompt, model_option, prompt_option, status_callback
            )
            
            # Update status with the external_image_url and prompt_enhancement immediately after image editing
            await generation_storage.update_status(
                generation_id, 
                "processing", 
                external_image_url=processed_image_url,
                prompt_enhancement=prompt_enhancement
            )
            
            # Use the processed image for 3D model generation
            image_input_for_3d = processed_image_url
            is_base64_for_3d = False
            logger.info(f"Image editing completed. Proceeding to 3D generation with processed image")
        
        # Step 2: Generate 3D model from (possibly edited) image
        mesh_path, ldr_path, vox_path, xyzrgb_path, model_url, _, _, problematic_xyzrgb_path, _ = await generate_3d_model_from_image(
            image_input=image_input_for_3d,
            model=model_3d,
            is_base64=is_base64_for_3d,
            detail_level=detail_level,
            apply_image_editing=False,  # We already did image editing above if needed
            status_callback=status_callback,
            model_option=model_option,
            voxelizer=voxelizer
        )
        
        # Deduct credit/increment anonymous calls IMMEDIATELY after successful fal.ai API call
        auth_info = await deduct_credits(
            user_info=user_info,
            auth_info=auth_info,
            credits_to_deduct=1,
            operation_description="fal.ai API call"
        )
        
        # Pack LDR to MPD using pack_ldraw_model
        if not os.path.exists(ldr_path):
            raise Exception("LDR file was not created successfully")
        
        # Read LDR content first (we always have this)
        with open(ldr_path, 'r') as f:
            ldr_content = f.read()
        
        # Initialize the LDraw packer
        packer = LDrawPacker()
        
        # Pack the LDR file to MPD
        mpd_path = await asyncio.get_event_loop().run_in_executor(
            None, packer.pack_ldraw_model, ldr_path
        )
        
        logger.info(f"Successfully packed LDR to MPD: {mpd_path}")
        
        # Read the MPD content
        with open(mpd_path, 'r') as f:
            mpd_content = f.read()
        
        # Store all files in Supabase
        # If edit_image was used, store the resized original and processed image URLs
        final_storage_original_url = original_resized_url if edit_image else storage_original_url
        
        # Store images
        await generation_storage.store_images(
            generation_id=generation_id,
            original_image_url=final_storage_original_url,
            processed_image_url=processed_image_url
        )
        
        # Store GLB file - use fal.ai URL directly
        with open(mesh_path, 'rb') as f:
            glb_content = f.read()
        await generation_storage.store_model_file(
            generation_id=generation_id,
            file_content=glb_content,
            file_type="glb",
            external_url=model_url,
            use_external_url=True
        )
        
        # Store LDR file
        await generation_storage.store_model_file(
            generation_id=generation_id,
            file_content=ldr_content,
            file_type="ldr"
        )
        
        # Store parts list CSV
        await generation_storage.store_parts_list_csv(
            generation_id=generation_id,
            ldr_content=ldr_content
        )
        
        # Store MPD file
        await generation_storage.store_model_file(
            generation_id=generation_id,
            file_content=mpd_content,
            file_type="mpd"
        )
        
        # Store VOX file
        if os.path.exists(vox_path):
            with open(vox_path, 'rb') as f:
                vox_content = f.read()
            await generation_storage.store_model_file(
                generation_id=generation_id,
                file_content=vox_content,
                file_type="vox"
            )
        
        # Store XYZRGB file
        if os.path.exists(xyzrgb_path):
            with open(xyzrgb_path, 'r') as f:
                xyzrgb_content = f.read()
            await generation_storage.store_model_file(
                generation_id=generation_id,
                file_content=xyzrgb_content,
                file_type="xyzrgb"
            )
        
        # Store problematic XYZRGB file (if exists)
        if problematic_xyzrgb_path and os.path.exists(problematic_xyzrgb_path):
            with open(problematic_xyzrgb_path, 'r') as f:
                problematic_xyzrgb_content = f.read()
            await generation_storage.store_model_file(
                generation_id=generation_id,
                file_content=problematic_xyzrgb_content,
                file_type="problematic_xyzrgb"
            )
        
        # Update status to completed
        await generation_storage.update_status(generation_id, "completed")
        
        # Cancel heartbeat
        if heartbeat_task:
            heartbeat_task.cancel()
        
        # Track successful conversion
        image_type = "base64" if is_base64 else "url"
        if edit_image:
            image_type += "_edited"
            
        track_image_conversion(
            user_id=user_email,
            success=True,
            has_mpd=True,
            ldr_size=len(ldr_content),
            mpd_size=len(mpd_content),
            image_type=image_type,
            is_developer=is_developer
        )
        
        logger.info(f"Successfully completed generation {generation_id}")
        
    except Exception as e:
        logger.error(f"Background task failed for generation {generation_id}: {e}")
        # Cancel heartbeat
        if heartbeat_task:
            heartbeat_task.cancel()
        # Update status to failed
        try:
            await generation_storage.update_status(generation_id, "failed", str(e))
        except:
            pass
        
        # Track error
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/imageToBricks",
            user_id=user_email
        )
    finally:
        # Clean up temporary files
        try:
            if 'mesh_path' in locals() and os.path.exists(mesh_path):
                os.unlink(mesh_path)
            if 'ldr_path' in locals() and os.path.exists(ldr_path):
                os.unlink(ldr_path)
            if 'mpd_path' in locals() and os.path.exists(mpd_path):
                os.unlink(mpd_path)
            if 'vox_path' in locals() and os.path.exists(vox_path):
                os.unlink(vox_path)
            if 'xyzrgb_path' in locals() and os.path.exists(xyzrgb_path):
                os.unlink(xyzrgb_path)
            if 'problematic_xyzrgb_path' in locals() and problematic_xyzrgb_path and os.path.exists(problematic_xyzrgb_path):
                os.unlink(problematic_xyzrgb_path)
            # Clean up the temporary directory
            if 'mesh_path' in locals():
                temp_dir = os.path.dirname(mesh_path)
                if os.path.exists(temp_dir):
                    os.rmdir(temp_dir)
        except Exception as cleanup_e:
            logger.warning(f"Failed to clean up temporary files: {cleanup_e}")


async def image_to_bricks(
    request: ImageToBricksRequest = ImageToBricksRequest(),
    auth_info: dict = Depends(get_user_with_optional_auth)
) -> ImageToBricksResponse:
    """
    Start an image to brick structure conversion (returns generation_id immediately)
    
    This endpoint:
    1. Creates a generation record with status "queued"
    2. Spawns a background task to process the conversion
    3. Returns the generation_id immediately
    
    Client should poll GET /generation/{generation_id} to check status and get results.
    
    Args:
        request: JSON body containing either:
        - image_url: URL of the image to convert
        - image_base64: Base64 encoded image data (recommended for React apps)
    
    If neither is provided, uses a default cat image.
    
    Returns:
        JSON response containing:
        - generation_id: UUID for tracking the generation
        - message: Status message
    """
    
    # Map model_option to actual model name
    if request.model_option == "a":
        model_3d = "trellis" 
    elif request.model_option == "b":
        model_3d = "trellis-2"
    elif request.model_option == "c":
        model_3d = "sam3d"
    
    # Handle authentication and tracking using utility function
    track_properties = {
        "has_base64_image": bool(request.image_base64),
        "has_image_url": bool(request.image_url),
        "using_default_image": not (request.image_base64 or request.image_url),
        "detail_level": request.detail_level,
        "edit_image": request.edit_image,
        "model_option": request.model_option,
        "has_prompt": bool(request.prompt),
        "model_3d": model_3d
    }
    
    user_info = handle_auth_and_tracking(
        auth_info=auth_info,
        endpoint="/imageToBricks",
        track_properties=track_properties,
        required_credits=1
    )
    
    user_email = user_info["user_email"]
    is_anonymous = user_info["is_anonymous"]
    is_developer = user_info["is_developer"]
    
    # Create generation record - get user_id from original auth_info
    if is_anonymous:
        user_id = auth_info["user_id"]
        user_type = "anonymous"
    elif is_developer:
        user_id = user_email
        user_type = "authenticated" 
    else:
        user_id = auth_info.get("user_id", user_email)
        user_type = "authenticated"
    
    # Determine image input and type
    image_input = None
    is_base64 = False
    
    if request.image_base64:
        image_input = request.image_base64
        is_base64 = True
    elif request.image_url:
        image_input = request.image_url
        is_base64 = False
    else:
        # Use default cat image
        image_input = "https://smzdytfghwslpbqnwdov.supabase.co/storage/v1/object/sign/brickai-assets/cat.png?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV81NDE4ODcxNy1jYmJkLTQwZGQtYTE3NC00NWEzNjNmNjM3MmUiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJicmlja2FpLWFzc2V0cy9jYXQucG5nIiwiaWF0IjoxNzU5MzMzNTQ3LCJleHAiOjQwNjc0NzU3NTQ3fQ.1JXC4JCE10AfjHLkNE0R0qo8o6ad-DOe9chDr_1piDA"
        is_base64 = False
    
    try:
        # Create generation record immediately (status: queued)
        generation_id = await generation_storage.create_generation(
            user_id=user_id,
            user_type=user_type,
            prompt=request.prompt or "no text prompt",
            detail_level=request.detail_level,
            endpoint="imageToBricks",
            model_3d=model_3d
        )
        
        # Spawn background task to process the generation
        start_generation_task(generation_id, process_image_to_bricks_task(
            generation_id=generation_id,
            image_input=image_input,
            is_base64=is_base64,
            model_3d=model_3d,
            model_option=request.model_option,
            prompt_option=request.prompt_option,
            detail_level=request.detail_level,
            edit_image=request.edit_image,
            user_info=user_info,
            auth_info=auth_info,
            user_email=user_email,
            is_developer=is_developer,
            prompt=request.prompt,
            storage_original_url=image_input if not is_base64 else None,
            voxelizer=request.voxelizer
        ))
        
        # Return immediately with generation_id
        return ImageToBricksResponse(
            generation_id=generation_id,
            message="Generation started. Poll /generation/{generation_id} for status."
        )
        
    except Exception as e:
        logger.error(f"Failed to start generation: {str(e)}")
        
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/imageToBricks",
            user_id=user_email
        )
        
        raise HTTPException(
            status_code=500,
            detail=f"Failed to start generation"
        )


async def image_to_bricks_stream(
    request: ImageToBricksRequest = ImageToBricksRequest(),
    auth_info: dict = Depends(get_user_with_optional_auth)
) -> StreamingResponse:
    """
    Streaming version of image_to_bricks using SAM3D.
    Returns an SSE stream with real-time 3D generation events followed by brick pipeline events.
    """
    # Handle authentication and tracking (same as non-streaming)
    track_properties = {
        "has_base64_image": bool(request.image_base64),
        "has_image_url": bool(request.image_url),
        "using_default_image": not (request.image_base64 or request.image_url),
        "detail_level": request.detail_level,
        "edit_image": request.edit_image,
        "model_option": request.model_option,
        "has_prompt": bool(request.prompt),
        "stream": True,
    }

    user_info = handle_auth_and_tracking(
        auth_info=auth_info,
        endpoint="/imageToBricks",
        track_properties=track_properties,
        required_credits=1
    )

    user_email = user_info["user_email"]
    is_anonymous = user_info["is_anonymous"]
    is_developer = user_info["is_developer"]

    if is_anonymous:
        user_id = auth_info["user_id"]
        user_type = "anonymous"
    elif is_developer:
        user_id = user_email
        user_type = "authenticated"
    else:
        user_id = auth_info.get("user_id", user_email)
        user_type = "authenticated"

    # Determine image input
    image_url = None
    storage_original_url = None

    if request.image_base64:
        # SAM3D needs a URL, so upload base64 to fal storage first
        fal_client = FalApiClient()
        image_url = fal_client.upload_base64_image(request.image_base64)
        storage_original_url = image_url
    elif request.image_url:
        image_url = request.image_url
        storage_original_url = request.image_url
    else:
        # Default cat image
        image_url = "https://smzdytfghwslpbqnwdov.supabase.co/storage/v1/object/sign/brickai-assets/cat.png?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV81NDE4ODcxNy1jYmJkLTQwZGQtYTE3NC00NWEzNjNmNjM3MmUiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJicmlja2FpLWFzc2V0cy9jYXQucG5nIiwiaWF0IjoxNzU5MzMzNTQ3LCJleHAiOjQwNjc0NzU3NTQ3fQ.1JXC4JCE10AfjHLkNE0R0qo8o6ad-DOe9chDr_1piDA"
        storage_original_url = image_url

    try:
        generation_id = await generation_storage.create_generation(
            user_id=user_id,
            user_type=user_type,
            prompt=request.prompt or "no text prompt",
            detail_level=request.detail_level,
            endpoint="imageToBricks",
            model_3d="sam3d" if request.stream_3d else ("trellis-2" if request.model_option == "b" else "trellis"),
        )

        return StreamingResponse(
            run_streaming_pipeline(
                image_url=image_url,
                generation_id=generation_id,
                detail_level=request.detail_level,
                user_info=user_info,
                auth_info=auth_info,
                credits_to_deduct=1,
                original_image_url=storage_original_url,
                model_option=request.model_option,
                prompt_option=request.prompt_option,
                image_prompt=request.prompt,
                edit_image=request.edit_image,
                stream_3d=request.stream_3d,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    except Exception as e:
        logger.error(f"Failed to start streaming generation: {str(e)}")
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/imageToBricks",
            user_id=user_email,
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to start streaming generation",
        )
