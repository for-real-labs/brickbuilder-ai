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
from ..utils.generate_image import generate_image_from_text
from ..utils.generate_3d_model_from_image import generate_3d_model_from_image
from ..utils.sam3d_stream import run_streaming_pipeline

# Import response models from imageToBricks module
from .imageToBricks import ImageToBricksResponse

# Configure logging
logger = logging.getLogger(__name__)


class TextToBricksRequest(BaseModel):
    prompt: str
    detail_level: Optional[float] = 1.6  # Default to 1.6 for fewer bricks
    model_option: Optional[str] = "a"  # Model option: "a" for trellis, "b" for trellis-2, "c" for sam3d
    prompt_option: Optional[str] = "a"  # Prompt option: "a", "b", or "c" to select prompt enhancement file
    stream: Optional[bool] = False  # If True, return an SSE stream (image frames always stream)
    stream_3d: Optional[bool] = True  # If True, use SAM3D streamed voxels; if False, use Trellis (non-streamed 3D)
    voxelizer: Optional[str] = "trimesh"  # Voxelizer for non-streamed 3D: "trimesh" or "obj2voxel"
    _image_model: str = "nano-banana"  # Model for image generation

    @validator('prompt')
    def validate_prompt(cls, v):
        if not v or not v.strip():
            raise ValueError("Prompt cannot be empty")
        
        # Basic validation - ensure prompt isn't too long
        if len(v.strip()) > 1000:
            raise ValueError("Prompt must be 1000 characters or less")
        
        return v.strip()
    
    @validator('model_option')
    def validate_and_set_model(cls, v, values):
        if v not in ["a", "b", "c"]:
            raise ValueError("model_option must be either 'a' or 'b'")
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


async def process_text_to_bricks_task(
    generation_id: str,
    prompt: str,
    model_3d: str,
    model_option: str,
    prompt_option: str,
    detail_level: float,
    image_model: str,
    user_info: dict,
    auth_info: dict,
    user_email: str,
    is_developer: bool,
    voxelizer: str = "trimesh"
):
    """
    Background task that processes the text-to-bricks conversion.
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
        
        # Step 1: Generate image from text using flux-2 streaming
        # Note: We use streaming for image generation even in non-streaming mode
        # for consistency and better image quality. The intermediate frames aren't
        # sent to the client in this path, but we still get the final result.
        from ..utils.generate_image import generate_image_from_text_simple_streaming
        
        image_url, processed_image_url, prompt_enhancement = await generate_image_from_text_simple_streaming(
            prompt=prompt,
            model_option=model_option,
            prompt_option=prompt_option
        )
        
        # Update status with the external_image_url and prompt_enhancement
        await generation_storage.update_status(
            generation_id, 
            "processing", 
            external_image_url=processed_image_url,
            prompt_enhancement=prompt_enhancement
        )
        
        # Step 2: Generate 3D model from the processed image
        mesh_path, ldr_path, vox_path, xyzrgb_path, model_url, _, _, problematic_xyzrgb_path, _ = await generate_3d_model_from_image(
            image_input=processed_image_url,
            model=model_3d,
            is_base64=False,
            detail_level=detail_level,
            apply_image_editing=False,  # Image is already processed
            status_callback=status_callback,
            voxelizer=voxelizer
        )
        
        # Deduct credits IMMEDIATELY after successful fal.ai API calls
        auth_info = await deduct_credits(
            user_info=user_info,
            auth_info=auth_info,
            credits_to_deduct=2,
            operation_description="fal.ai API calls"
        )
        
        # Pack LDR to MPD
        if not os.path.exists(ldr_path):
            raise Exception("LDR file was not created successfully")
        
        # Read LDR content
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
        # Store images
        await generation_storage.store_images(
            generation_id=generation_id,
            original_image_url=image_url,
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
        track_image_conversion(
            user_id=user_email,
            success=True,
            has_mpd=True,
            ldr_size=len(ldr_content),
            mpd_size=len(mpd_content),
            image_type="text_generated",
            is_developer=is_developer
        )
        
        logger.info(f"Successfully completed text-to-bricks generation {generation_id}")
        
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
            endpoint="/textToBricks",
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


async def text_to_bricks(
    request: TextToBricksRequest,
    auth_info: dict = Depends(get_user_with_optional_auth)
) -> ImageToBricksResponse:
    """
    Start a text to brick structure conversion (returns generation_id immediately)
    
    This endpoint:
    1. Creates a generation record with status "queued"
    2. Spawns a background task to process the conversion
    3. Returns the generation_id immediately
    
    Client should poll GET /generation/{generation_id} to check status and get results.
    
    Args:
        request: JSON body containing:
        - prompt: Text description of what you want to build with LEGO
        - detail_level: Optional detail level for brick generation (default: 1.6)
    
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
        "prompt_length": len(request.prompt),
        "detail_level": request.detail_level,
        "model_option": request.model_option,
        "model_3d": model_3d
    }
    
    user_info = handle_auth_and_tracking(
        auth_info=auth_info,
        endpoint="/textToBricks",
        track_properties=track_properties,
        required_credits=2  # textToBricks uses 2 credits (1 for Flux + 1 for Trellis)
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
    
    try:
        # Create generation record immediately (status: queued)
        generation_id = await generation_storage.create_generation(
            user_id=user_id,
            user_type=user_type,
            prompt=request.prompt,
            detail_level=request.detail_level,
            endpoint="textToBricks",
            image_model=request._image_model,
            model_3d=model_3d
        )
        
        # Spawn background task to process the generation
        start_generation_task(generation_id, process_text_to_bricks_task(
            generation_id=generation_id,
            prompt=request.prompt,
            model_3d=model_3d,
            model_option=request.model_option,
            prompt_option=request.prompt_option,
            detail_level=request.detail_level,
            image_model=request._image_model,
            user_info=user_info,
            auth_info=auth_info,
            user_email=user_email,
            is_developer=is_developer,
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
            endpoint="/textToBricks",
            user_id=user_email
        )
        
        raise HTTPException(
            status_code=500,
            detail=f"Failed to start generation"
        )


async def text_to_bricks_stream(
    request: TextToBricksRequest,
    auth_info: dict = Depends(get_user_with_optional_auth)
) -> StreamingResponse:
    """
    Streaming version of text_to_bricks using SAM3D.
    Generates an image from text first, then streams SAM3D + brick pipeline via SSE.
    """
    # Handle authentication and tracking (same as non-streaming)
    track_properties = {
        "prompt_length": len(request.prompt),
        "detail_level": request.detail_level,
        "model_option": request.model_option,
        "stream": True,
    }

    user_info = handle_auth_and_tracking(
        auth_info=auth_info,
        endpoint="/textToBricks",
        track_properties=track_properties,
        required_credits=2,
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

    try:
        generation_id = await generation_storage.create_generation(
            user_id=user_id,
            user_type=user_type,
            prompt=request.prompt,
            detail_level=request.detail_level,
            endpoint="textToBricks",
            image_model=request._image_model,
            model_3d="sam3d" if request.stream_3d else ("trellis-2" if request.model_option == "b" else "trellis"),
        )

        await generation_storage.update_status(generation_id, "processing")

        # Image generation + SAM3D streaming are both handled inside the
        # streaming pipeline so that flux-2 queue events are forwarded
        # to the client as SSE, just like the SAM3D voxel events.

        return StreamingResponse(
            run_streaming_pipeline(
                image_url="",  # Will be set by the pipeline after flux-2 generation
                generation_id=generation_id,
                detail_level=request.detail_level,
                user_info=user_info,
                auth_info=auth_info,
                credits_to_deduct=2,
                text_prompt=request.prompt,
                model_option=request.model_option,
                prompt_option=request.prompt_option,
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
            endpoint="/textToBricks",
            user_id=user_email,
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to start streaming generation",
        )
