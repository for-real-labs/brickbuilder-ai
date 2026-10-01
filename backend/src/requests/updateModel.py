import logging
import tempfile
import asyncio
from pathlib import Path
from typing import Optional
from datetime import datetime

from pydantic import BaseModel
from fastapi import HTTPException, Depends

from ..utils.generation_tasks import start_generation_task
from ..utils.generation_storage import RESIZE_SOURCE_KEYS, generation_storage
from ..utils.authorization import get_generation_or_404
from ..utils.posthog_client import track_api_call, track_error
from ..utils.conversions.glb2brick import glb2brick
from ..utils.auth import get_user_with_optional_auth, handle_auth_and_tracking
from ..utils.pack_ldraw_model import LDrawPacker

logger = logging.getLogger(__name__)


class UpdateModelRequest(BaseModel):
    generation_id: str
    xyzrgb_content: str


class UpdateModelResponse(BaseModel):
    generation_id: str
    message: str = "Generation started. Poll /generation/{generation_id} for status."


async def process_update_model_task(
    generation_id: str,
    original_generation_id: str,
    xyzrgb_content: str,
    generation: dict,
    user_email: str,
    is_developer: bool
):
    """
    Background task to process xyzrgb content into LDR/MPD files.
    Updates generation status with heartbeat and stores files in Supabase.
    """
    # Start heartbeat task - updates timestamp every 5 seconds to show we're alive
    async def heartbeat():
        while True:
            await asyncio.sleep(5)
            # Only update timestamp, don't override the actual status
            try:
                generation_storage.client.table("generations").update({
                    "updated_at": datetime.utcnow().isoformat()
                }).eq("id", generation_id).execute()
            except Exception as e:
                logger.warning(f"Heartbeat update failed: {e}")
    
    heartbeat_task = asyncio.create_task(heartbeat())
    
    try:
        # Write xyzrgb content to a temp file and run glb2brick to generate LDR
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_xyzrgb_path = Path(temp_dir) / f"{generation_id}.xyzrgb"
            temp_xyzrgb_path.write_text(xyzrgb_content)
            
            # Run glb2brick with the xyzrgb file in executor to avoid blocking event loop
            # Use a dummy GLB path inside the temp dir so output files land there too
            dummy_glb_path = str(Path(temp_dir) / "unused.glb")
            result = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: glb2brick(
                    glb_path=dummy_glb_path,
                    xyzrgb_path=str(temp_xyzrgb_path),
                    auto_adjust_brick_count=False
                )
            )
            
            # Read the generated LDR file
            ldr_file_path = Path(result['ldr_file'])
            if not ldr_file_path.exists():
                raise Exception("Failed to generate LDR file")
            
            ldr_content = ldr_file_path.read_text()
            
            # Pack LDR to MPD
            logger.info("Packing LDR to MPD")
            packer = LDrawPacker()
            mpd_path = await asyncio.get_event_loop().run_in_executor(
                None, packer.pack_ldraw_model, str(ldr_file_path)
            )
            
            with open(mpd_path, 'r') as f:
                mpd_content = f.read()
            
            # Reference the same files from original generation (don't upload duplicates)
            update_data = {}
            
            # Reference same image URLs
            if generation.get('original_image_url'):
                update_data['original_image_url'] = generation['original_image_url']
            if generation.get('processed_image_url'):
                update_data['processed_image_url'] = generation['processed_image_url']
            if generation.get('external_image_url'):
                update_data['external_image_url'] = generation['external_image_url']
            if generation.get('input_image_name'):
                update_data['input_image_name'] = generation['input_image_name']
            
            # Reference same GLB URLs
            if generation.get('glb_url'):
                update_data['glb_url'] = generation['glb_url']
            if generation.get('external_glb_url'):
                update_data['external_glb_url'] = generation['external_glb_url']
            
            # Reference the same resize source (SAM3D voxel data or LLM design voxels)
            for source_key in RESIZE_SOURCE_KEYS:
                if generation.get(source_key):
                    update_data[source_key] = generation[source_key]
            
            if update_data:
                generation_storage.client.table("generations").update(update_data).eq("id", generation_id).execute()
                logger.info(f"Referenced existing files in new generation: {list(update_data.keys())}")
            
            # Store problematic XYZRGB file (if exists)
            problematic_xyzrgb_path = result.get('problematic_xyzrgb_file')
            if problematic_xyzrgb_path and Path(problematic_xyzrgb_path).exists():
                with open(problematic_xyzrgb_path, 'r') as f:
                    problematic_xyzrgb_content = f.read()
                await generation_storage.store_model_file(
                    generation_id=generation_id,
                    file_content=problematic_xyzrgb_content,
                    file_type="problematic_xyzrgb"
                )
            
            # Store new LDR file
            await generation_storage.store_model_file(
                generation_id=generation_id,
                file_content=ldr_content,
                file_type="ldr"
            )
            
            # Store MPD file
            await generation_storage.store_model_file(
                generation_id=generation_id,
                file_content=mpd_content,
                file_type="mpd"
            )
            
            # Store parts list CSV
            await generation_storage.store_parts_list_csv(
                generation_id=generation_id,
                ldr_content=ldr_content
            )
            
            # Update status to completed
            await generation_storage.update_status(generation_id, "completed")
            
            logger.info(f"Successfully stored updated model files for generation: {generation_id}")
            
            # Track successful update
            track_api_call(
                endpoint="/updateModel",
                user_id=user_email,
                success=True,
                original_generation_id=original_generation_id,
                new_generation_id=generation_id,
                is_developer=is_developer
            )
    
    except Exception as e:
        logger.error(f"Background processing failed for generation {generation_id}: {e}")
        try:
            await generation_storage.update_status(generation_id, "failed", str(e))
        except:
            pass
        
        track_error(
            error_type=type(e).__name__, 
            error_message=str(e), 
            endpoint="/updateModel/background", 
            user_id=user_email
        )
    
    finally:
        # Cancel heartbeat task
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass

        # Clean up tmp artifacts written by glb2brick (vox / problematic xyzrgb
        # land in backend/tmp, outside the TemporaryDirectory used above).
        try:
            result_paths = locals().get('result') or {}
            for key in ('ldr_file', 'vox_file', 'xyzrgb_file', 'problematic_xyzrgb_file'):
                p = result_paths.get(key)
                if p and Path(p).exists():
                    Path(p).unlink()
        except Exception as cleanup_e:
            logger.warning(f"Failed to clean up temporary files: {cleanup_e}")


async def update_model(request: UpdateModelRequest, auth_info: dict) -> UpdateModelResponse:
    """
    Create a new generation from updated xyzrgb content
    
    This endpoint:
    1. Fetches the original generation record by ID
    2. Creates a new generation record with status="ldr_processing"
    3. Stores the xyzrgb_url immediately in Supabase
    4. Returns generation_id immediately
    5. Processes LDR/MPD generation in background with heartbeat updates
    6. Updates status to "completed" when processing finishes
    
    Note: The original generation and its files remain unchanged.
    Client should poll /generation/{generation_id} for completion status.
    
    Args:
        request: UpdateModelRequest containing generation_id and xyzrgb_content
        auth_info: Authentication information
        
    Returns:
        UpdateModelResponse with generation_id and message
    """
    user_email = "anonymous"
    
    try:
        # Handle authentication and tracking
        track_properties = {
            "generation_id": request.generation_id,
        }
        
        user_info = handle_auth_and_tracking(
            auth_info=auth_info,
            endpoint="/updateModel", 
            track_properties=track_properties,
            required_credits=0  # No credits required - just reprocessing existing model
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

        generation = await get_generation_or_404(request.generation_id, auth_info)

        # Create a new generation record with status="ldr_processing"
        new_generation_id = await generation_storage.create_generation(
            user_id=auth_info.get("user_id", user_id),
            user_type=user_type,
            prompt=f"Updated model from {request.generation_id}",
            detail_level=generation.get('detail_level', 1.6),
            endpoint="updateModel",
            model_3d=generation.get('model_used_3d', 'unknown'),
            edit_generation_id=request.generation_id
        )
        
        logger.info(f"Created new generation record: {new_generation_id}")
        
        # Store xyzrgb file immediately and update status to ldr_processing
        await generation_storage.store_model_file(
            generation_id=new_generation_id,
            file_content=request.xyzrgb_content,
            file_type="xyzrgb"
        )
        
        await generation_storage.update_status(new_generation_id, "ldr_processing")
        
        # Spawn background task to process LDR/MPD generation
        start_generation_task(new_generation_id, process_update_model_task(
            generation_id=new_generation_id,
            original_generation_id=request.generation_id,
            xyzrgb_content=request.xyzrgb_content,
            generation=generation,
            user_email=user_email,
            is_developer=is_developer
        ))
        
        logger.info(f"Started background processing for generation {new_generation_id} from updated model {request.generation_id}")

        return UpdateModelResponse(
            generation_id=new_generation_id,
            message=f"Generation started. Poll /generation/{new_generation_id} for status."
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to update model")
        track_error(
            error_type=type(e).__name__, 
            error_message=str(e), 
            endpoint="/updateModel", 
            user_id=user_email
        )
        raise HTTPException(status_code=500, detail="Failed to update model")
