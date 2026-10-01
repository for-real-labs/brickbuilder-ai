"""
GLB to Bricks

Upload a GLB file directly and run it through the glb2brick pipeline, choosing
the voxelizer (trimesh or obj2voxel). Mirrors the imageToBricks flow: creates a
generation record, processes in a background task, and returns the
generation_id immediately for polling.
"""

import os
import logging
import asyncio
import tempfile
from typing import Optional

from fastapi import UploadFile, File, Form, Depends, HTTPException
from pydantic import BaseModel

from ..utils.auth import get_user_with_optional_auth, handle_auth_and_tracking
from ..utils.posthog_client import track_image_conversion, track_error
from ..utils.pack_ldraw_model import LDrawPacker
from ..utils.generation_tasks import start_generation_task
from ..utils.generation_storage import generation_storage
from ..utils.conversions.glb2brick import glb2brick

logger = logging.getLogger(__name__)


class GlbToBricksResponse(BaseModel):
    """Response model - returns generation_id immediately."""
    generation_id: str
    message: str = "Generation started"


async def process_glb_to_bricks_task(
    generation_id: str,
    glb_path: str,
    voxelizer: str,
    detail_level: float,
    user_email: str,
    is_developer: bool,
):
    """Background task: run glb2brick on the uploaded GLB and store all artifacts."""
    heartbeat_task = None
    try:
        await generation_storage.update_status(generation_id, "processing")

        # Heartbeat to keep updated_at fresh while processing.
        async def heartbeat():
            while True:
                await asyncio.sleep(5)
                try:
                    generation_storage.client.table("generations").update(
                        {"updated_at": __import__("datetime").datetime.utcnow().isoformat()}
                    ).eq("id", generation_id).execute()
                except Exception as e:
                    logger.warning(f"Heartbeat update failed: {e}")

        heartbeat_task = asyncio.create_task(heartbeat())

        # Run the GLB -> bricks pipeline with the selected voxelizer.
        logger.info(f"Running glb2brick (voxelizer={voxelizer}) for {glb_path}")
        info = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: glb2brick(
                glb_path,
                world_size=25.0,
                voxel_size=detail_level,
                voxelizer=voxelizer,
            ),
        )

        ldr_path = info["ldr_file"]
        vox_path = info.get("vox_file", "")
        xyzrgb_path = info.get("xyzrgb_file", "")
        problematic_xyzrgb_path = info.get("problematic_xyzrgb_file")

        if not os.path.exists(ldr_path):
            raise Exception("LDR file was not created successfully")

        with open(ldr_path, "r") as f:
            ldr_content = f.read()

        # Pack LDR to MPD.
        packer = LDrawPacker()
        mpd_path = await asyncio.get_event_loop().run_in_executor(
            None, packer.pack_ldraw_model, ldr_path
        )
        with open(mpd_path, "r") as f:
            mpd_content = f.read()

        # Store the uploaded GLB.
        with open(glb_path, "rb") as f:
            glb_content = f.read()
        await generation_storage.store_model_file(
            generation_id=generation_id,
            file_content=glb_content,
            file_type="glb",
        )

        # Store LDR.
        await generation_storage.store_model_file(
            generation_id=generation_id,
            file_content=ldr_content,
            file_type="ldr",
        )

        # Store parts list CSV.
        await generation_storage.store_parts_list_csv(
            generation_id=generation_id,
            ldr_content=ldr_content,
        )

        # Store MPD.
        await generation_storage.store_model_file(
            generation_id=generation_id,
            file_content=mpd_content,
            file_type="mpd",
        )

        # Store VOX.
        if vox_path and os.path.exists(vox_path):
            with open(vox_path, "rb") as f:
                await generation_storage.store_model_file(
                    generation_id=generation_id,
                    file_content=f.read(),
                    file_type="vox",
                )

        # Store XYZRGB.
        if xyzrgb_path and os.path.exists(xyzrgb_path):
            with open(xyzrgb_path, "r") as f:
                await generation_storage.store_model_file(
                    generation_id=generation_id,
                    file_content=f.read(),
                    file_type="xyzrgb",
                )

        # Store problematic XYZRGB (if any).
        if problematic_xyzrgb_path and os.path.exists(problematic_xyzrgb_path):
            with open(problematic_xyzrgb_path, "r") as f:
                await generation_storage.store_model_file(
                    generation_id=generation_id,
                    file_content=f.read(),
                    file_type="problematic_xyzrgb",
                )

        await generation_storage.update_status(generation_id, "completed")

        if heartbeat_task:
            heartbeat_task.cancel()

        track_image_conversion(
            user_id=user_email,
            success=True,
            has_mpd=True,
            ldr_size=len(ldr_content),
            mpd_size=len(mpd_content),
            image_type="glb_upload",
            is_developer=is_developer,
        )
        logger.info(f"Successfully completed GLB generation {generation_id}")

    except Exception as e:
        logger.error(f"GLB background task failed for generation {generation_id}: {e}")
        if heartbeat_task:
            heartbeat_task.cancel()
        try:
            await generation_storage.update_status(generation_id, "failed", str(e))
        except Exception:
            pass
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/glbToBricks",
            user_id=user_email,
        )
    finally:
        for path_var in ("glb_path", "ldr_path", "mpd_path", "vox_path", "xyzrgb_path", "problematic_xyzrgb_path"):
            try:
                p = locals().get(path_var)
                if p and os.path.exists(p):
                    os.unlink(p)
            except Exception:
                pass


async def glb_to_bricks(
    file: UploadFile = File(...),
    voxelizer: str = Form("trimesh"),
    detail_level: float = Form(40.0),
    auth_info: dict = Depends(get_user_with_optional_auth),
) -> GlbToBricksResponse:
    """
    Upload a GLB and convert it to a brick structure.

    Form fields:
    - file: the .glb file (multipart upload)
    - voxelizer: "trimesh" (default) or "obj2voxel"
    - detail_level: voxel resolution (default 40)

    Returns generation_id immediately; poll GET /generation/{id} for status.
    """
    if voxelizer not in ("trimesh", "obj2voxel"):
        raise HTTPException(status_code=400, detail="voxelizer must be 'trimesh' or 'obj2voxel'")

    filename = (file.filename or "").lower()
    if not filename.endswith(".glb"):
        raise HTTPException(status_code=400, detail="Only .glb files are supported")

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    user_info = handle_auth_and_tracking(
        auth_info=auth_info,
        endpoint="/glbToBricks",
        track_properties={
            "voxelizer": voxelizer,
            "detail_level": detail_level,
            "glb_size": len(contents),
        },
        required_credits=0,
    )

    user_email = user_info["user_email"]
    is_developer = user_info["is_developer"]
    is_anonymous = user_info["is_anonymous"]

    if is_anonymous:
        user_id = auth_info["user_id"]
        user_type = "anonymous"
    elif is_developer:
        user_id = user_email
        user_type = "authenticated"
    else:
        user_id = auth_info.get("user_id", user_email)
        user_type = "authenticated"

    # Persist the upload to a temp file the background task can read.
    fd, glb_path = tempfile.mkstemp(suffix=".glb")
    with os.fdopen(fd, "wb") as f:
        f.write(contents)

    try:
        generation_id = await generation_storage.create_generation(
            user_id=user_id,
            user_type=user_type,
            prompt=f"GLB upload: {file.filename}",
            detail_level=detail_level,
            endpoint="glbToBricks",
            model_3d=f"upload:{voxelizer}",
        )

        start_generation_task(generation_id,
            process_glb_to_bricks_task(
                generation_id=generation_id,
                glb_path=glb_path,
                voxelizer=voxelizer,
                detail_level=detail_level,
                user_email=user_email,
                is_developer=is_developer,
            )
        )

        return GlbToBricksResponse(
            generation_id=generation_id,
            message="Generation started. Poll /generation/{generation_id} for status.",
        )
    except Exception as e:
        if os.path.exists(glb_path):
            os.unlink(glb_path)
        logger.error(f"Failed to start GLB generation: {e}")
        track_error(
            error_type=type(e).__name__,
            error_message=str(e),
            endpoint="/glbToBricks",
            user_id=user_email,
        )
        raise HTTPException(status_code=500, detail="Failed to start generation")
