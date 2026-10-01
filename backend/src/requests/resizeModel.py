import os
import sys
import logging
import asyncio
import tempfile
from typing import Optional
from datetime import datetime
from fastapi import HTTPException, Depends
from pydantic import BaseModel, validator

# Add parent directories to path for imports
sys.path.append(os.path.dirname(os.path.dirname(__file__)))
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

# Import auth functions and utilities
from ..utils.auth import get_user_with_optional_auth, handle_auth_and_tracking, deduct_credits
from ..utils.posthog_client import track_api_call, track_error
from ..utils.pack_ldraw_model import LDrawPacker
from ..utils.generation_tasks import start_generation_task
from ..utils.generation_storage import RESIZE_SOURCE_KEYS, generation_storage
from ..utils.authorization import get_generation_or_404
from ..utils.conversions.glb2brick import glb2brick, glb2xyzrgb
from ..utils.sam3d_stream import decode_sam3d_voxels_to_xyzrgb
from ..utils.conversions.voxel_utils import downsample_xyzrgb, resample_xyzrgb
from ..utils.color_conversions import convert_xyzrgb_to_ldr_colors

# Configure logging
logger = logging.getLogger(__name__)


class ResizeModelRequest(BaseModel):
    generation_id: str
    detail_level: float = 1.6  # Default to 1.6 for consistency with imageToBricks
    
    @validator('detail_level')
    def validate_detail_level(cls, v):
        if v <= 0 or v > 200:
            raise ValueError("detail_level must be between 0 and 200")
        return v
    
    @validator('generation_id')
    def validate_generation_id(cls, v):
        if not v or not v.strip():
            raise ValueError("generation_id is required")
        return v.strip()


class ResizeModelResponse(BaseModel):
    """Response model returning xyzrgb content and generation id"""
    xyzrgb_content: str
    generation_id: str
    original_generation_id: str
    message: str = "Generation started. Poll /generation/{generation_id} for status."


async def process_resize_model_task(
    generation_id: str,
    original_generation_id: str,
    xyzrgb_path: str,
    generation: dict,
    user_email: str,
    is_developer: bool,
    detail_level: float,
):
    """
    Background task to run glb2brick (from xyzrgb), pack LDR into MPD,
    store all files, and update status.
    """
    # Start heartbeat task - updates timestamp every 5 seconds to show we're alive
    async def heartbeat():
        while True:
            await asyncio.sleep(5)
            try:
                generation_storage.client.table("generations").update({
                    "updated_at": datetime.utcnow().isoformat()
                }).eq("id", generation_id).execute()
            except Exception as e:
                logger.warning(f"Heartbeat update failed: {e}")

    heartbeat_task = asyncio.create_task(heartbeat())

    ldr_path = None
    mpd_path = None
    vox_path = None
    problematic_xyzrgb_path = None

    try:
        # Run glb2brick with the already-generated xyzrgb file
        logger.info(f"Running glb2brick from xyzrgb: {xyzrgb_path}")
        # Use a dummy GLB path in the same directory as the xyzrgb so output files land there
        dummy_glb_path = os.path.join(os.path.dirname(xyzrgb_path), "unused.glb")
        info = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: glb2brick(
                glb_path=dummy_glb_path,
                xyzrgb_path=xyzrgb_path,
                auto_adjust_brick_count=False,
            )
        )

        ldr_path = info['ldr_file']
        vox_path = info.get('vox_file', '')
        problematic_xyzrgb_path = info.get('problematic_xyzrgb_file', '')

        # Read the generated LDR file
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

        # Store new VOX file (voxel data)
        if vox_path and os.path.exists(vox_path):
            with open(vox_path, 'rb') as f:
                vox_content = f.read()
            await generation_storage.store_model_file(
                generation_id=generation_id,
                file_content=vox_content,
                file_type="vox"
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

        logger.info(f"Successfully stored resized model files for generation: {generation_id}")

        # Track successful resize
        track_api_call(
            endpoint="/resizeModel",
            user_id=user_email,
            success=True,
            original_generation_id=original_generation_id,
            new_generation_id=generation_id,
            detail_level=detail_level,
            voxel_size=detail_level,
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
            endpoint="/resizeModel/background",
            user_id=user_email
        )

    finally:
        # Cancel heartbeat task
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass

        # Clean up temporary files
        try:
            if ldr_path and os.path.exists(ldr_path):
                os.unlink(ldr_path)
            if mpd_path and os.path.exists(mpd_path):
                os.unlink(mpd_path)
            if vox_path and os.path.exists(vox_path):
                os.unlink(vox_path)
            if xyzrgb_path and os.path.exists(xyzrgb_path):
                os.unlink(xyzrgb_path)
            if problematic_xyzrgb_path and os.path.exists(problematic_xyzrgb_path):
                os.unlink(problematic_xyzrgb_path)
        except Exception as cleanup_e:
            logger.warning(f"Failed to clean up temporary files: {cleanup_e}")


async def resize_model(
    request: ResizeModelRequest,
    auth_info: dict = Depends(get_user_with_optional_auth)
) -> ResizeModelResponse:
    """
    Resize an existing model by changing its detail level.

    Returns immediately with xyzrgb content and generation_id once
    voxelization is complete. LDR packing and file storage run in
    the background. Client should poll /generation/{generation_id}
    for completion status.
    """
    user_email = "anonymous"

    try:
        # Handle authentication and tracking
        track_properties = {
            "generation_id": request.generation_id,
            "detail_level": request.detail_level,
            "voxel_size": request.detail_level  # For internal tracking consistency
        }

        user_info = handle_auth_and_tracking(
            auth_info=auth_info,
            endpoint="/resizeModel",
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

        # Step 1: Fetch the original generation record
        logger.info(f"Fetching generation record: {request.generation_id}")
        generation = await get_generation_or_404(request.generation_id, auth_info)

        # Check if we have SAM3D voxel data, LLM design voxels or a GLB file
        sam3d_voxel_data_url = generation.get('sam3d_voxel_data_url')
        design_voxels_url = generation.get('design_voxels_url')
        has_glb = bool(generation.get('glb_url'))

        if not sam3d_voxel_data_url and not design_voxels_url and not has_glb:
            raise HTTPException(
                status_code=400,
                detail="Generation does not have a GLB file or voxel data to resize"
            )

        # Create new generation record early so we can store files to it
        new_generation_id = await generation_storage.create_generation(
            user_id=user_id,
            user_type=user_type,
            prompt=f"Resized model from {request.generation_id}",
            detail_level=request.detail_level,
            endpoint="resizeModel",
            model_3d=generation.get('model_used_3d', 'unknown')
        )
        logger.info(f"Created new generation record: {new_generation_id}")

        temp_glb_path = None
        try:
            if sam3d_voxel_data_url:
                # --- SAM3D path: decode voxel data and downsample ---
                logger.info(f"Downloading SAM3D voxel data from: {sam3d_voxel_data_url}")
                import json as _json
                voxel_json_bytes = await generation_storage.download_file_from_storage(sam3d_voxel_data_url)
                voxel_payload = _json.loads(voxel_json_bytes.decode("utf-8"))

                grid_resolution = voxel_payload.get("grid_resolution", 32)
                loop = asyncio.get_event_loop()

                xyzrgb_content = await loop.run_in_executor(
                    None,
                    decode_sam3d_voxels_to_xyzrgb,
                    voxel_payload["voxel_data"],
                    voxel_payload["bounds_min"],
                    voxel_payload["bounds_max"],
                    grid_resolution,
                )

                # Downsample to the requested detail_level
                target_resolution = int(request.detail_level) if request.detail_level > 2 else 32
                xyzrgb_content = await loop.run_in_executor(
                    None,
                    downsample_xyzrgb,
                    xyzrgb_content,
                    target_resolution,
                )

                # Store unconverted xyzrgb (with raw RGB colors) before LDR conversion
                # Do this early so it's available even if later steps fail
                await generation_storage.store_model_file(
                    generation_id=new_generation_id,
                    file_content=xyzrgb_content,
                    file_type="unconverted_xyzrgb",
                )

                # Convert to LDR colors for consistency with GLB path
                xyzrgb_content = await loop.run_in_executor(
                    None,
                    convert_xyzrgb_to_ldr_colors,
                    xyzrgb_content,
                )

                # Write to temp file for the background brick pipeline
                with tempfile.NamedTemporaryFile(suffix='.xyzrgb', delete=False, mode='w') as temp_xyzrgb:
                    temp_xyzrgb.write(xyzrgb_content)
                    xyzrgb_path = temp_xyzrgb.name

                logger.info(f"SAM3D decode + downsample complete (target={target_resolution}). XYZRGB file: {xyzrgb_path}")

            elif design_voxels_url:
                # --- LLM design path: rescale the model's own voxels ---
                logger.info(f"Downloading LLM design voxels from: {design_voxels_url}")
                design_bytes = await generation_storage.download_file_from_storage(design_voxels_url)
                loop = asyncio.get_event_loop()
                target_resolution = max(1, int(request.detail_level))
                xyzrgb_content = await loop.run_in_executor(
                    None, resample_xyzrgb, design_bytes.decode("utf-8"), target_resolution
                )
                # Downsampling averages colors, so snap them back onto the LDR palette
                xyzrgb_content = await loop.run_in_executor(
                    None, convert_xyzrgb_to_ldr_colors, xyzrgb_content
                )
                with tempfile.NamedTemporaryFile(suffix='.xyzrgb', delete=False, mode='w') as temp_xyzrgb:
                    temp_xyzrgb.write(xyzrgb_content)
                    xyzrgb_path = temp_xyzrgb.name
                logger.info(f"LLM design voxels resampled (target={target_resolution}). XYZRGB file: {xyzrgb_path}")

            else:
                # --- GLB path: voxelize as before ---
                logger.info(f"Downloading GLB file from: {generation['glb_url']}")
                glb_content = await generation_storage.download_file_from_storage(generation['glb_url'])

                with tempfile.NamedTemporaryFile(suffix='.glb', delete=False) as temp_glb:
                    temp_glb.write(glb_content)
                    temp_glb_path = temp_glb.name

                voxel_size = request.detail_level
                logger.info(f"Running glb2xyzrgb with voxel_size={voxel_size}")

                xyzrgb_info = await asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: glb2xyzrgb(
                        temp_glb_path,
                        voxel_size=voxel_size,
                    )
                )

                xyzrgb_path = xyzrgb_info['xyzrgb_file']
                xyzrgb_content = xyzrgb_info['xyzrgb_content']
                logger.info(f"Voxelization complete. XYZRGB file: {xyzrgb_path}")

            # Store xyzrgb immediately and set status to "resizing"
            await generation_storage.store_model_file(
                generation_id=new_generation_id,
                file_content=xyzrgb_content,
                file_type="xyzrgb"
            )

            await generation_storage.update_status(new_generation_id, "resizing")

            # Spawn background task for brick optimization, LDR packing, file storage
            start_generation_task(new_generation_id, process_resize_model_task(
                generation_id=new_generation_id,
                original_generation_id=request.generation_id,
                xyzrgb_path=xyzrgb_path,
                generation=generation,
                user_email=user_email,
                is_developer=is_developer,
                detail_level=request.detail_level,
            ))

            logger.info(f"Started background processing for generation {new_generation_id} from resized model {request.generation_id}")

            return ResizeModelResponse(
                xyzrgb_content=xyzrgb_content,
                generation_id=new_generation_id,
                original_generation_id=request.generation_id,
                message=f"Generation started. Poll /generation/{new_generation_id} for status."
            )

        except Exception:
            # Clean up temp GLB and xyzrgb if we fail before spawning the background task
            try:
                if temp_glb_path and os.path.exists(temp_glb_path):
                    os.unlink(temp_glb_path)
            except:
                pass
            raise
        finally:
            # Background task doesn't need the GLB anymore, clean it up
            try:
                if temp_glb_path and os.path.exists(temp_glb_path):
                    os.unlink(temp_glb_path)
            except:
                pass

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to resize model")
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/resizeModel",
            user_id=user_email
        )
        raise HTTPException(status_code=500, detail="Failed to resize model")
