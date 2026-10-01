import os
import sys
import logging
import asyncio
import uuid
import tempfile
from typing import Optional
from datetime import datetime
from fastapi import HTTPException, Depends, BackgroundTasks
from pydantic import BaseModel, validator

# Add parent directories to path for imports
sys.path.append(os.path.dirname(os.path.dirname(__file__)))
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

# Import auth functions and utilities
from ..utils.auth import require_paid_auth, handle_auth_and_tracking, deduct_credits
from ..utils.posthog_client import track_api_call, track_image_conversion, track_error
from ..utils.pack_ldraw_model import LDrawPacker
from ..utils.generation_tasks import start_generation_task
from ..utils.generation_storage import generation_storage
from ..utils.authorization import get_owned_generation_or_403
from ..utils.generate_image import generate_image_from_image
from ..utils.generate_3d_model_from_image import generate_3d_model_from_image

# Import response models from imageToBricks module
from .imageToBricks import ImageToBricksResponse

# Configure logging
logger = logging.getLogger(__name__)


class PromptEditModelRequest(BaseModel):
    generation_id: str
    edit_prompt: str
    model_option: Optional[str] = None  # Model option: "a" for trellis, "b" for trellis-2, "c" for sam3d. If None, uses the original generation's model.
    
    @validator('edit_prompt')
    def validate_edit_prompt(cls, v):
        if not v or not v.strip():
            raise ValueError("edit_prompt cannot be empty")
        if len(v.strip()) > 1000:
            raise ValueError("edit_prompt must be 1000 characters or less")
        return v.strip()
    
    @validator('generation_id')
    def validate_generation_id(cls, v):
        if not v or not v.strip():
            raise ValueError("generation_id is required")
        return v.strip()
    
    @validator('model_option')
    def validate_model_option(cls, v):
        if v is not None and v not in ["a", "b", "c"]:
            raise ValueError("model_option must be 'a', 'b', or 'c'")
        return v


async def process_prompt_edit_task(
    new_generation_id: str,
    original_generation_id: str,
    edit_prompt: str,
    processed_image_url: str,
    model_3d: str,
    detail_level: float,
    user_info: dict,
    auth_info: dict,
    user_email: str,
    is_developer: bool
):
    """
    Background task that processes the prompt edit model conversion.
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
                    }).eq("id", new_generation_id).execute()
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
                    generation_storage.update_status(new_generation_id, status),
                    main_loop
                )
                # Don't wait for result - fire and forget
            except Exception as e:
                logger.warning(f"Failed to update status callback: {e}")
        
        # Update status to processing
        await generation_storage.update_status(new_generation_id, "processing")
        
        # Step 1: Apply nano banana edit to the processed image using the edit prompt
        logger.info(f"Applying nano banana edit with prompt: {edit_prompt}")
        original_resized_url, edited_image_url, prompt_enhancement = generate_image_from_image(
            processed_image_url, 
            is_base64=False,
            edit_prompt=edit_prompt,
            status_callback=status_callback
        )
        
        # Update status with the external_image_url (edited image) and prompt_enhancement
        await generation_storage.update_status(
            new_generation_id, 
            "processing", 
            external_image_url=edited_image_url,
            prompt_enhancement=prompt_enhancement
        )
        
        # Step 2: Generate 3D model from the edited image
        logger.info("Generating 3D model from edited image")
        mesh_path, ldr_path, vox_path, xyzrgb_path, model_url, _, _, problematic_xyzrgb_path, _ = await generate_3d_model_from_image(
            image_input=edited_image_url,
            model=model_3d,
            is_base64=False,
            detail_level=detail_level,
            apply_image_editing=False,  # Image is already edited
            status_callback=status_callback
        )
        
        # Deduct credits IMMEDIATELY after successful fal.ai API calls
        auth_info = await deduct_credits(
            user_info=user_info,
            auth_info=auth_info,
            credits_to_deduct=2,
            operation_description="fal.ai API calls"
        )
        
        # Read the generated LDR file
        if not os.path.exists(ldr_path):
            raise Exception("LDR file was not created successfully")
        
        with open(ldr_path, 'r') as f:
            ldr_content = f.read()
        
        # Pack LDR to MPD
        logger.info("Packing LDR to MPD")
        packer = LDrawPacker()
        mpd_path = await asyncio.get_event_loop().run_in_executor(
            None, packer.pack_ldraw_model, ldr_path
        )
        
        with open(mpd_path, 'r') as f:
            mpd_content = f.read()
        
        # Store all files in Supabase
        # Store images (original resized and edited)
        await generation_storage.store_images(
            generation_id=new_generation_id,
            original_image_url=original_resized_url,
            processed_image_url=edited_image_url
        )
        
        # Store GLB file - use fal.ai URL directly
        with open(mesh_path, 'rb') as f:
            glb_content = f.read()
        await generation_storage.store_model_file(
            generation_id=new_generation_id,
            file_content=glb_content,
            file_type="glb",
            external_url=model_url,
            use_external_url=True
        )
        
        # Store LDR file
        await generation_storage.store_model_file(
            generation_id=new_generation_id,
            file_content=ldr_content,
            file_type="ldr"
        )
        
        # Store parts list CSV
        await generation_storage.store_parts_list_csv(
            generation_id=new_generation_id,
            ldr_content=ldr_content
        )
        
        # Store MPD file
        await generation_storage.store_model_file(
            generation_id=new_generation_id,
            file_content=mpd_content,
            file_type="mpd"
        )
        
        # Store VOX file
        if os.path.exists(vox_path):
            with open(vox_path, 'rb') as f:
                vox_content = f.read()
            await generation_storage.store_model_file(
                generation_id=new_generation_id,
                file_content=vox_content,
                file_type="vox"
            )
        
        # Store XYZRGB file
        if os.path.exists(xyzrgb_path):
            with open(xyzrgb_path, 'r') as f:
                xyzrgb_content = f.read()
            await generation_storage.store_model_file(
                generation_id=new_generation_id,
                file_content=xyzrgb_content,
                file_type="xyzrgb"
            )
        
        # Store problematic XYZRGB file (if exists)
        if problematic_xyzrgb_path and os.path.exists(problematic_xyzrgb_path):
            with open(problematic_xyzrgb_path, 'r') as f:
                problematic_xyzrgb_content = f.read()
            await generation_storage.store_model_file(
                generation_id=new_generation_id,
                file_content=problematic_xyzrgb_content,
                file_type="problematic_xyzrgb"
            )
        
        # Update status to completed
        await generation_storage.update_status(new_generation_id, "completed")
        
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
            image_type="prompt_edited",
            is_developer=is_developer
        )
        
        logger.info(f"Successfully completed prompt edit generation {new_generation_id}")
        
    except Exception as e:
        logger.error(f"Background task failed for generation {new_generation_id}: {e}")
        # Cancel heartbeat
        if heartbeat_task:
            heartbeat_task.cancel()
        # Update status to failed
        try:
            await generation_storage.update_status(new_generation_id, "failed", str(e))
        except:
            pass
        
        # Track error
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/promptEditModel",
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


async def prompt_edit_model(
    request: PromptEditModelRequest,
    auth_info: dict = Depends(require_paid_auth)
) -> ImageToBricksResponse:
    """
    Start editing an existing model using a text prompt (returns generation_id immediately)
    
    This endpoint:
    1. Fetches the original generation record by ID
    2. Creates a new generation record with status "queued"
    3. Spawns a background task to process the edit
    4. Returns the new generation_id immediately
    
    Client should poll GET /generation/{generation_id} to check status and get results.
    
    Args:
        request: JSON body containing:
        - generation_id: The ID of the generation to edit
        - edit_prompt: Text prompt describing how to edit the model
    
    Returns:
        JSON response containing:
        - generation_id: New generation ID for tracking the edited model
        - message: Status message
    """
    
    # Handle authentication and tracking
    track_properties = {
        "generation_id": request.generation_id,
        "edit_prompt": request.edit_prompt,
        "model_option": request.model_option
    }
    
    user_info = handle_auth_and_tracking(
        auth_info=auth_info,
        endpoint="/promptEditModel", 
        track_properties=track_properties,
        required_credits=2  # 1 for nano banana edit + 1 for 3D generation
    )
    
    user_email = user_info["user_email"]
    is_anonymous = user_info["is_anonymous"]
    is_developer = user_info["is_developer"]
    
    # Get user info for new generation record
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
        # Step 1: Fetch the original generation record
        logger.info(f"Fetching generation record: {request.generation_id}")
        generation = await get_owned_generation_or_403(request.generation_id, auth_info)
        
        # Check if the generation has a processed_image_url
        if not generation.get('processed_image_url'):
            raise HTTPException(
                status_code=400,
                detail="Error retrieving generation"
            )
        
        # Get detail_level from the original generation
        detail_level = generation.get('detail_level', 30)
        
        # Map model_option to actual model name, or use original generation's model
        if request.model_option == "a":
            model_3d = "trellis"
        elif request.model_option == "b":
            model_3d = "trellis-2"
        elif request.model_option == "c":
            model_3d = "sam3d"
        else:
            # No model_option provided, use the original generation's model
            model_3d = generation.get('model_used_3d', 'trellis')
        
        processed_image_url = generation['processed_image_url']
        logger.info(f"Using processed_image_url: {processed_image_url[:50]}...")
        logger.info(f"Using detail_level: {detail_level}, model_3d: {model_3d}")
        
        # Create new generation record immediately (status: queued)
        new_generation_id = await generation_storage.create_generation(
            user_id=auth_info.get("user_id", user_id),
            user_type=user_type,
            prompt=f"Edited from {request.generation_id}: {request.edit_prompt}",
            detail_level=detail_level,
            endpoint="promptEditModel",
            model_3d=model_3d,
            edit_generation_id=request.generation_id
        )
        
        logger.info(f"Created new generation record: {new_generation_id}")
        
        # Spawn background task to process the generation
        start_generation_task(new_generation_id, process_prompt_edit_task(
            new_generation_id=new_generation_id,
            original_generation_id=request.generation_id,
            edit_prompt=request.edit_prompt,
            processed_image_url=processed_image_url,
            model_3d=model_3d,
            detail_level=detail_level,
            user_info=user_info,
            auth_info=auth_info,
            user_email=user_email,
            is_developer=is_developer
        ))
        
        # Return immediately with new generation_id
        return ImageToBricksResponse(
            generation_id=new_generation_id,
            message="Generation started. Poll /generation/{generation_id} for status."
        )
            
    except HTTPException as he:
        # Track HTTP errors
        track_error(
            error_type="HTTPException",
            error_message=str(he.detail),
            endpoint="/promptEditModel",
            user_id=user_email
        )
        raise
    except Exception as e:
        logger.error(f"Failed to start generation: {str(e)}")
        
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/promptEditModel",
            user_id=user_email
        )
        
        raise HTTPException(
            status_code=500,
            detail=f"Failed to start generation"
        )
