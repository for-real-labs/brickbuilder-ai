import os
import json
import logging
import asyncio
import tempfile
import base64
import struct
import numpy as np
from datetime import datetime
from typing import AsyncGenerator, AsyncIterator, Optional, Tuple, Union

import httpx

from .conversions.glb2brick import glb2brick
from .conversions.voxel_utils import downsample_xyzrgb
from .color_conversions import convert_xyzrgb_to_ldr_colors
from .pack_ldraw_model import LDrawPacker
from .generation_tasks import start_generation_task
from .generation_storage import generation_storage
from .auth import deduct_credits
from .image_processing import remove_background_from_url

logger = logging.getLogger(__name__)

FAL_API_BASE_URL = "https://fal.run"
RUNPOD_API_BASE = os.environ.get("RUNPOD_API_BASE", "https://api.runpod.ai/v2")
# RunPod is optional. It is only enabled when both the API key and endpoint id
# are present. When disabled, SAM-3D streaming raises a clear error at call time
# instead of preventing the app from importing/booting.
RUNPOD_API_KEY = os.environ.get("RUNPOD_API_KEY")
RUNPOD_ENDPOINT_ID = os.environ.get("RUNPOD_ENDPOINT_ID")
RUNPOD_ENABLED = bool(RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID)
RUNPOD_POLL_INTERVAL_S = float(os.environ.get("RUNPOD_POLL_INTERVAL_S", "0.5"))
RUNPOD_TIMEOUT_S = float(os.environ.get("RUNPOD_TIMEOUT_S", "600"))

if not RUNPOD_ENABLED:
    logger.info(
        "RunPod is not configured (RUNPOD_API_KEY or RUNPOD_ENDPOINT_ID missing). "
        "SAM-3D will use fal.ai mesh generation with progress updates."
    )

async def stream_sam3d_raw(
    image_url: str,
    *,
    prompt: str = "",
    stream_geometry_every: int = 1,
    stream_colors_every: int = 2,
    seed: int | None = None,
) -> AsyncIterator[bytes]:
    """
    Submit a SAM-3D job to RunPod Serverless and yield SSE byte chunks
    (`data: {...}\\n\\n`) in the same format the old fal endpoint produced.
    """
    if not RUNPOD_ENABLED:
        raise RuntimeError(
            "RunPod is not configured. Set RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID "
            "to enable SAM-3D streaming."
        )
    base = f"{RUNPOD_API_BASE}/{RUNPOD_ENDPOINT_ID}"
    headers = {"Authorization": f"Bearer {RUNPOD_API_KEY}"}

    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
        # 1. Submit job
        run = await client.post(
            f"{base}/run",
            headers={**headers, "Content-Type": "application/json"},
            json={
                "input": {
                    "image_url": image_url,
                    "prompt": prompt,
                    "stream_geometry_every": stream_geometry_every,
                    "stream_colors_every": stream_colors_every,
                    "seed": seed,
                }
            },
        )
        run.raise_for_status()
        job_id = run.json()["id"]

        stream_url = f"{base}/stream/{job_id}"
        cancel_url = f"{base}/cancel/{job_id}"
        started = asyncio.get_event_loop().time()

        try:
            while True:
                if asyncio.get_event_loop().time() - started > RUNPOD_TIMEOUT_S:
                    yield _sse({"stage": "error", "error": "RunPod stream timeout"})
                    await client.post(cancel_url, headers=headers)
                    return

                res = await client.get(stream_url, headers=headers)
                res.raise_for_status()
                data = res.json()

                for item in data.get("stream", []) or []:
                    output = item.get("output")
                    if isinstance(output, list):
                        for e in output:
                            yield _sse(e)
                    elif isinstance(output, dict):
                        yield _sse(output)

                status = (data.get("status") or "").upper()
                if status in ("COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"):
                    if status != "COMPLETED":
                        yield _sse({
                            "stage": "error",
                            "error": f"RunPod job {status.lower()}: "
                                     f"{data.get('error') or 'no detail'}",
                        })
                    return

                await asyncio.sleep(RUNPOD_POLL_INTERVAL_S)
        except asyncio.CancelledError:
            # Client/pipeline aborted — tell RunPod to stop the GPU job.
            try:
                await client.post(cancel_url, headers=headers)
            except Exception:
                pass
            raise


def _sse(obj: dict) -> bytes:
    return f"data: {json.dumps(obj)}\n\n".encode("utf-8")


def decode_sam3d_voxels_to_xyzrgb(
    voxel_data_b64: str,
    bounds_min: list,
    bounds_max: list,
    grid_resolution: int,
) -> str:
    """
    Decode SAM3D binary voxel data into XYZRGB text format.

    SAM3D encodes 6 bytes per voxel: [x_norm, y_norm, z_norm, r, g, b]
    where positions are uint8 (0-255) normalized within bounds_min/bounds_max.

    The 0-255 values are sparsely distributed (e.g. ~18 unique values per
    axis for grid_resolution=18, spaced ~14 apart).  Using them raw as
    integer grid coords creates visible gaps; compacting to grid_resolution
    cells discards detail.

    Instead we do a per-axis rank remapping: each uint8 value is replaced
    with its rank among the sorted unique values on that axis.  This:
      - Closes all gaps (adjacent voxels become adjacent integer coords)
      - Preserves exactly the same number of unique positions
      - Preserves aspect ratio (SAM3D uses uniform spacing, so axes with
        larger extents produce more unique values proportionally)

    Duplicate positions (same x,y,z) are merged by averaging their colours.
    """
    raw = base64.b64decode(voxel_data_b64)
    n_voxels = len(raw) // 6
    packed = np.frombuffer(raw, dtype=np.uint8).reshape(n_voxels, 6)

    positions = packed[:, :3]   # (N, 3) uint8 0-255
    colors = packed[:, 3:6].astype(np.float64)

    # Per-axis rank remapping: replace sparse uint8 values with dense
    # integer ranks (0, 1, 2, ...).  np.unique returns sorted unique
    # values, and inverse maps each original value to its rank.
    grid_pos = np.empty((n_voxels, 3), dtype=int)
    for axis in range(3):
        _, inverse = np.unique(positions[:, axis], return_inverse=True)
        grid_pos[:, axis] = inverse

    res_x = int(grid_pos[:, 0].max()) + 1
    res_y = int(grid_pos[:, 1].max()) + 1
    res_z = int(grid_pos[:, 2].max()) + 1

    logger.info(
        f"Rank-remapped grid: {res_x}x{res_y}x{res_z} "
        f"(from {n_voxels} input voxels, grid_resolution={grid_resolution})"
    )

    # Accumulate colours per grid cell (merge exact-position duplicates)
    occupancy = np.zeros((res_x, res_y, res_z), dtype=bool)
    color_sum = np.zeros((res_x, res_y, res_z, 3), dtype=np.float64)
    color_count = np.zeros((res_x, res_y, res_z), dtype=np.float64)

    occupancy[grid_pos[:, 0], grid_pos[:, 1], grid_pos[:, 2]] = True
    np.add.at(color_sum, (grid_pos[:, 0], grid_pos[:, 1], grid_pos[:, 2]), colors)
    np.add.at(color_count, (grid_pos[:, 0], grid_pos[:, 1], grid_pos[:, 2]), 1.0)

    # Build output lines
    occupied_coords = np.argwhere(occupancy)
    n_occupied = occupied_coords.shape[0]
    lines = []
    for coord in occupied_coords:
        x, y, z = coord
        cnt = color_count[x, y, z]
        if cnt > 0:
            r, g, b = (color_sum[x, y, z] / cnt).round().astype(int)
        else:
            r, g, b = 128, 128, 128
        lines.append(f"{x} {y} {z} {r} {g} {b}")

    logger.info(
        f"Decoded {n_voxels} SAM3D voxels -> {n_occupied} unique grid cells "
        f"(grid={res_x}x{res_y}x{res_z})"
    )
    return "\n".join(lines)


def parse_fal_stream_results(raw_text: str) -> dict:
    """
    Parse the accumulated FAL SSE text after the stream ends.
    Extracts the last appearance event's voxel data, model_glb_url, and glb_data.
    """
    last_appearance = None
    model_glb_url = None
    glb_bytes = None

    for block in raw_text.split("\n\n"):
        for line in block.split("\n"):
            line = line.strip()
            if not line.startswith("data: "):
                continue
            raw_data = line[6:]

            # Only parse events we care about
            if '"appearance"' in raw_data or '"complete"' in raw_data or '"error"' in raw_data or '"glb_ready"' in raw_data:
                try:
                    parsed = json.loads(raw_data)
                except json.JSONDecodeError:
                    continue

                event_type = parsed.get("stage") or parsed.get("type") or parsed.get("event")

                if event_type == "appearance":
                    # Keep the latest appearance event (has the best colors)
                    if parsed.get("voxel_data") and parsed.get("bounds_min") and parsed.get("bounds_max"):
                        last_appearance = parsed

                elif event_type == "glb_ready":
                    glb_b64 = parsed.get("glb_data")
                    if glb_b64 and not glb_bytes:
                        glb_bytes = base64.b64decode(glb_b64)

                elif event_type == "complete":
                    model_glb_url = parsed.get("model_glb_url")
                    if not glb_bytes:
                        glb_b64 = parsed.get("glb_data")
                        if glb_b64:
                            glb_bytes = base64.b64decode(glb_b64)

                elif event_type == "error":
                    error_msg = parsed.get("message") or parsed.get("error") or "SAM3D error"
                    raise Exception(error_msg)

    return {
        "last_appearance": last_appearance,
        "model_glb_url": model_glb_url,
        "glb_bytes": glb_bytes,
    }


async def _run_trellis_3d_branch(
    *,
    queue: asyncio.Queue,
    generation_id: str,
    detail_level: float,
    user_info: dict,
    auth_info: dict,
    credits_to_deduct: int,
    original_image_url: Optional[str],
    processed_image_url: Optional[str],
    image_url: str,
    prompt_enhancement: Optional[str],
    model_option: Optional[str],
    model_3d: Optional[str] = None,
) -> None:
    """
    Non-streamed 3D path used when stream_3d is False. The flux-2 image frames
    have already been streamed to the client by the caller; this runs Trellis
    for the 3D step (no live voxel preview) and forwards coarse progress events.
    """
    from .generate_3d_model_from_image import generate_3d_model_from_image

    main_loop = asyncio.get_running_loop()

    def status_callback(status: str):
        # Called from executor threads — hand the event back to the loop safely.
        try:
            event = _sse({
                "type": "pipeline", "stage": "brick_conversion",
                "message": f"Generating 3D model... ({status})",
            })
            main_loop.call_soon_threadsafe(queue.put_nowait, event)
        except Exception:
            pass

    model_3d = model_3d or ("trellis-2" if (model_option or "a").lower() == "b" else "trellis")
    source_image = processed_image_url or image_url

    await queue.put(_sse({"type": "pipeline", "stage": "brick_conversion", "message": "Generating 3D model...", "progress": 0}))

    (mesh_path, ldr_path, vox_path, xyzrgb_path, model_url,
     _, _, problematic_xyzrgb_path, _) = await generate_3d_model_from_image(
        image_input=source_image,
        model=model_3d,
        is_base64=False,
        detail_level=detail_level,
        apply_image_editing=False,
        status_callback=status_callback,
        model_option=model_option or "a",
    )

    await queue.put(_sse({"type": "pipeline", "stage": "brick_conversion", "message": "Brick conversion complete", "progress": 100}))

    # Deduct credits after a successful 3D generation
    await deduct_credits(
        user_info=user_info,
        auth_info=auth_info,
        credits_to_deduct=credits_to_deduct,
        operation_description=f"{model_3d} API call",
    )

    # Pack LDR -> MPD
    await queue.put(_sse({"type": "pipeline", "stage": "brick_packing", "message": "Packing brick model...", "progress": 0}))
    if not os.path.exists(ldr_path):
        raise Exception("LDR file was not created successfully")
    with open(ldr_path, "r") as f:
        ldr_content = f.read()

    loop = asyncio.get_running_loop()
    packer = LDrawPacker()
    mpd_path = await loop.run_in_executor(None, packer.pack_ldraw_model, ldr_path)
    with open(mpd_path, "r") as f:
        mpd_content = f.read()
    await queue.put(_sse({"type": "pipeline", "stage": "brick_packing", "message": "Packing complete", "progress": 100}))

    # Store files
    await queue.put(_sse({"type": "pipeline", "stage": "storage", "message": "Storing files...", "progress": 0}))
    await generation_storage.store_images(
        generation_id=generation_id,
        original_image_url=original_image_url,
        processed_image_url=processed_image_url,
    )
    if model_url:
        await generation_storage.store_model_file(
            generation_id=generation_id,
            file_content=b"",
            file_type="glb",
            external_url=model_url,
            use_external_url=True,
        )
    await generation_storage.store_model_file(
        generation_id=generation_id, file_content=ldr_content, file_type="ldr",
    )
    await generation_storage.store_parts_list_csv(
        generation_id=generation_id, ldr_content=ldr_content,
    )
    await generation_storage.store_model_file(
        generation_id=generation_id, file_content=mpd_content, file_type="mpd",
    )
    if vox_path and os.path.exists(vox_path):
        with open(vox_path, "rb") as f:
            await generation_storage.store_model_file(
                generation_id=generation_id, file_content=f.read(), file_type="vox",
            )
    if xyzrgb_path and os.path.exists(xyzrgb_path):
        with open(xyzrgb_path, "r") as f:
            await generation_storage.store_model_file(
                generation_id=generation_id, file_content=f.read(), file_type="xyzrgb",
            )
    if problematic_xyzrgb_path and os.path.exists(problematic_xyzrgb_path):
        with open(problematic_xyzrgb_path, "r") as f:
            await generation_storage.store_model_file(
                generation_id=generation_id, file_content=f.read(), file_type="problematic_xyzrgb",
            )
    await queue.put(_sse({"type": "pipeline", "stage": "storage", "message": "Storage complete", "progress": 100}))

    if prompt_enhancement:
        await generation_storage.update_status(
            generation_id, "processing", prompt_enhancement=prompt_enhancement,
        )

    await generation_storage.update_status(generation_id, "completed")
    await queue.put(_sse({"type": "pipeline", "stage": "pipeline_complete", "generation_id": generation_id}))


async def _pipeline_worker(
    queue: asyncio.Queue,
    image_url: str,
    generation_id: str,
    detail_level: float,
    user_info: dict,
    auth_info: dict,
    credits_to_deduct: int,
    original_image_url: Optional[str],
    processed_image_url: Optional[str],
    prompt_enhancement: Optional[str],
    text_prompt: Optional[str] = None,
    model_option: Optional[str] = None,
    prompt_option: Optional[str] = None,
    image_prompt: Optional[str] = None,
    edit_image: bool = False,
    stream_3d: bool = True,
) -> None:
    """
    Background task that runs the full streaming pipeline.
    Puts SSE events onto *queue* for the client-facing generator to forward.
    Runs independently of the HTTP connection — if the client disconnects,
    this task keeps going so the generation completes and files are stored.
    """
    temp_dir = None
    heartbeat_task = None
    try:
        temp_dir = tempfile.mkdtemp(prefix="sam3d_")

        # Heartbeat: update updated_at every 5 s so polling clients know we're alive
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

        # Update status to processing
        await generation_storage.update_status(generation_id, "processing")

        # --- Optional Phase 0: Generate image from text using flux-2 ---
        if text_prompt:
            from .generate_image import generate_image_from_text_streaming

            original_image_url, processed_image_url, prompt_enhancement = (
                await generate_image_from_text_streaming(
                    prompt=text_prompt,
                    queue=queue,
                    model_option=model_option or "a",
                    prompt_option=prompt_option or "a",
                )
            )
            image_url = processed_image_url

            # Persist the generated image info
            await generation_storage.update_status(
                generation_id,
                "processing",
                external_image_url=processed_image_url,
                prompt_enhancement=prompt_enhancement,
            )

        # --- Optional Phase 0b: Edit image (nano-banana) for imageToBricks ---
        if edit_image and not text_prompt:
            from .generate_image import generate_image_from_image_streaming

            original_image_url, edited_url, prompt_enhancement = (
                await generate_image_from_image_streaming(
                    image_url=image_url,
                    queue=queue,
                    edit_prompt=image_prompt,
                    model_option=model_option or "a",
                    prompt_option=prompt_option or "a",
                )
            )
            processed_image_url = edited_url
            image_url = edited_url

            await generation_storage.update_status(
                generation_id,
                "processing",
                external_image_url=edited_url,
                prompt_enhancement=prompt_enhancement,
            )

        # --- Background removal (for imageToBricks path) ---
        if not text_prompt:
            await queue.put(
                f"data: {json.dumps({'type': 'pipeline', 'stage': 'background_removal', 'message': 'Processing environment...', 'progress': 0})}\n\n"
            )

            loop = asyncio.get_running_loop()
            bg_removed_url = await loop.run_in_executor(
                None, remove_background_from_url, image_url, temp_dir
            )
            if bg_removed_url != image_url:
                logger.info(f"Background removed successfully: {bg_removed_url[:80]}...")
                processed_image_url = bg_removed_url
                image_url = bg_removed_url
            else:
                logger.warning("Background removal returned original image (may have failed)")

            await queue.put(
                f"data: {json.dumps({'type': 'pipeline', 'stage': 'background_removal', 'message': 'Background removed', 'progress': 100})}\n\n"
            )

        # Send the processed image URL before SAM3D streaming begins
        if processed_image_url:
            await queue.put(f"data: {json.dumps({'type': 'pipeline', 'stage': 'input_processed', 'image_url': processed_image_url})}\n\n")

        # --- 3D generation: Trellis (non-streamed) when stream_3d is False ---
        # Image frames have already streamed above; here we only choose how the
        # 3D step runs. SAM3D streams live voxels, Trellis does not.
        if not stream_3d or not RUNPOD_ENABLED:
            if stream_3d:
                await queue.put(_sse({
                    "type": "pipeline", "stage": "brick_conversion",
                    "message": "Generating SAM3D through fal.ai (mesh preview when ready)…",
                }))
            await _run_trellis_3d_branch(
                queue=queue,
                generation_id=generation_id,
                detail_level=detail_level,
                user_info=user_info,
                auth_info=auth_info,
                credits_to_deduct=credits_to_deduct,
                original_image_url=original_image_url,
                processed_image_url=processed_image_url,
                image_url=image_url,
                prompt_enhancement=prompt_enhancement,
                model_option=model_option,
                model_3d="sam3d" if stream_3d else None,
            )
            return

        # --- Phase 1: Stream FAL data, parse voxel events inline ---
        # We parse SSE events into complete blocks and selectively
        # forward only voxel-relevant events (geometry, appearance).
        # Once the final appearance step arrives we break immediately —
        # no waiting for GLB mesh generation (mesh_preview/glb_ready/complete).
        # This also prevents forwarding partial/truncated GLB events
        # that would corrupt the SSE stream for the client.
        sse_buffer = ""
        last_appearance = None
        model_glb_url = None
        voxels_ready = False

        # Stages related to GLB mesh that we don't need to forward
        _GLB_STAGES = frozenset(("mesh_preview", "glb_ready", "complete"))

        async for chunk in stream_sam3d_raw(image_url):
            sse_buffer += chunk.decode("utf-8", errors="replace")

            # Process complete SSE events (delimited by \n\n)
            while "\n\n" in sse_buffer:
                block, sse_buffer = sse_buffer.split("\n\n", 1)

                # Determine whether to forward or skip this block
                skip_forward = False
                for line in block.split("\n"):
                    line = line.strip()
                    if not line.startswith("data: "):
                        continue
                    raw_data = line[6:]

                    # Quick keyword check to avoid JSON-parsing every event
                    if not any(kw in raw_data for kw in (
                        '"appearance"', '"error"', '"mesh_preview"',
                        '"glb_ready"', '"complete"',
                    )):
                        continue

                    try:
                        parsed = json.loads(raw_data)
                    except json.JSONDecodeError:
                        continue

                    stage = parsed.get("stage") or parsed.get("type") or parsed.get("event")

                    if stage == "appearance":
                        if parsed.get("voxel_data") and parsed.get("bounds_min") and parsed.get("bounds_max"):
                            last_appearance = parsed
                            # Break as soon as the last appearance step
                            # arrives (progress ≥ 0.9) — no need to wait
                            # for mesh_preview which takes ~30s.
                            progress = parsed.get("progress", 0)
                            if progress >= 0.9:
                                voxels_ready = True
                                logger.info(
                                    f"Final appearance event received (progress={progress}) "
                                    "— breaking out of FAL stream (skipping GLB mesh generation)"
                                )
                    elif stage == "error":
                        error_msg = parsed.get("message") or parsed.get("error") or "SAM3D error"
                        raise Exception(error_msg)
                    elif stage in _GLB_STAGES:
                        # All voxel data is finalized once we see these.
                        skip_forward = True
                        if stage == "complete":
                            model_glb_url = parsed.get("model_glb_url")
                        if last_appearance:
                            voxels_ready = True

                # Forward only complete, non-GLB SSE blocks to the client
                if not skip_forward:
                    await queue.put((block + "\n\n").encode("utf-8"))

            if voxels_ready:
                break

        del sse_buffer

        if not last_appearance:
            raise Exception("SAM3D stream completed without providing voxel data")

        # --- Phase 2: Brick pipeline using voxels directly (skip GLB→OBJ→voxel) ---
        # Send progress immediately so the client transitions from the voxel view
        await queue.put(f"data: {json.dumps({'type': 'pipeline', 'stage': 'brick_conversion', 'message': 'Converting...', 'progress': 0})}\n\n")

        loop = asyncio.get_running_loop()

        # Decode SAM3D voxel data to XYZRGB format
        grid_resolution = int(detail_level) if detail_level > 2 else 32
        xyzrgb_content = await loop.run_in_executor(
            None,
            decode_sam3d_voxels_to_xyzrgb,
            last_appearance["voxel_data"],
            last_appearance["bounds_min"],
            last_appearance["bounds_max"],
            grid_resolution,
        )

        # Downsample to the requested detail_level
        target_resolution = int(detail_level) if detail_level > 2 else 32
        xyzrgb_content = await loop.run_in_executor(
            None,
            downsample_xyzrgb,
            xyzrgb_content,
            target_resolution,
        )

        # Save unconverted xyzrgb for deferred upload during storage phase
        unconverted_xyzrgb_content = xyzrgb_content

        # Convert to LDR colors for consistency with GLB path
        xyzrgb_content = await loop.run_in_executor(
            None,
            convert_xyzrgb_to_ldr_colors,
            xyzrgb_content,
        )

        # Write XYZRGB to temp file
        xyzrgb_input_path = os.path.join(temp_dir, "model.xyzrgb")
        with open(xyzrgb_input_path, "w") as f:
            f.write(xyzrgb_content)

        # Run glb2brick with xyzrgb_path to skip GLB→OBJ→voxel conversion entirely
        # A dummy GLB path is required by glb2brick's interface, but the actual
        # conversion is bypassed entirely when xyzrgb_path is provided.
        dummy_glb_path = os.path.join(temp_dir, "model.glb")
        with open(dummy_glb_path, "wb") as f:
            f.write(b"")

        brick_result = await loop.run_in_executor(
            None,
            lambda: glb2brick(dummy_glb_path, 25.0, detail_level, xyzrgb_path=xyzrgb_input_path),
        )

        ldr_path = brick_result["ldr_file"]
        vox_path = brick_result["vox_file"]
        xyzrgb_path = xyzrgb_input_path
        problematic_xyzrgb_path = brick_result.get("problematic_xyzrgb_file")

        await queue.put(f"data: {json.dumps({'type': 'pipeline', 'stage': 'brick_conversion', 'message': 'Brick conversion complete', 'progress': 100, 'brick_count': brick_result.get('brick_count', 0)})}\n\n")

        # Deduct credits
        auth_info = await deduct_credits(
            user_info=user_info,
            auth_info=auth_info,
            credits_to_deduct=credits_to_deduct,
            operation_description="SAM3D streaming API call"
        )

        # Step 2: Pack LDR to MPD
        await queue.put(f"data: {json.dumps({'type': 'pipeline', 'stage': 'brick_packing', 'message': 'Packing brick model...', 'progress': 0})}\n\n")

        if not os.path.exists(ldr_path):
            raise Exception("LDR file was not created successfully")

        with open(ldr_path, "r") as f:
            ldr_content = f.read()

        packer = LDrawPacker()
        mpd_path = await loop.run_in_executor(None, packer.pack_ldraw_model, ldr_path)

        with open(mpd_path, "r") as f:
            mpd_content = f.read()

        await queue.put(f"data: {json.dumps({'type': 'pipeline', 'stage': 'brick_packing', 'message': 'Packing complete', 'progress': 100})}\n\n")

        # Step 3: Store all files in Supabase
        await queue.put(f"data: {json.dumps({'type': 'pipeline', 'stage': 'storage', 'message': 'Storing files...', 'progress': 0})}\n\n")

        # Store images
        await generation_storage.store_images(
            generation_id=generation_id,
            original_image_url=original_image_url,
            processed_image_url=processed_image_url,
        )

        # Store GLB file (from glb_ready/complete event if available)
        if model_glb_url:
            await generation_storage.store_model_file(
                generation_id=generation_id,
                file_content=b"",
                file_type="glb",
                external_url=model_glb_url,
                use_external_url=True,
            )

        # Store unconverted xyzrgb (deferred from earlier to avoid blocking brick conversion)
        await generation_storage.store_model_file(
            generation_id=generation_id,
            file_content=unconverted_xyzrgb_content,
            file_type="unconverted_xyzrgb",
        )

        # Store LDR file
        await generation_storage.store_model_file(
            generation_id=generation_id,
            file_content=ldr_content,
            file_type="ldr",
        )

        # Store parts list CSV
        await generation_storage.store_parts_list_csv(
            generation_id=generation_id,
            ldr_content=ldr_content,
        )

        # Store MPD file
        await generation_storage.store_model_file(
            generation_id=generation_id,
            file_content=mpd_content,
            file_type="mpd",
        )

        # Store VOX file
        if os.path.exists(vox_path):
            with open(vox_path, "rb") as f:
                vox_content = f.read()
            await generation_storage.store_model_file(
                generation_id=generation_id,
                file_content=vox_content,
                file_type="vox",
            )

        # Store raw SAM3D voxel data (base64 binary + bounds metadata)
        sam3d_voxel_payload = json.dumps({
            "voxel_data": last_appearance["voxel_data"],
            "bounds_min": last_appearance["bounds_min"],
            "bounds_max": last_appearance["bounds_max"],
            "grid_resolution": grid_resolution,
        })
        await generation_storage.store_model_file(
            generation_id=generation_id,
            file_content=sam3d_voxel_payload,
            file_type="sam3d_voxel_data",
        )

        # Store XYZRGB file
        if os.path.exists(xyzrgb_path):
            with open(xyzrgb_path, "r") as f:
                xyzrgb_content_stored = f.read()
            await generation_storage.store_model_file(
                generation_id=generation_id,
                file_content=xyzrgb_content_stored,
                file_type="xyzrgb",
            )

        # Store problematic XYZRGB file
        if problematic_xyzrgb_path and os.path.exists(problematic_xyzrgb_path):
            with open(problematic_xyzrgb_path, "r") as f:
                problematic_xyzrgb_content = f.read()
            await generation_storage.store_model_file(
                generation_id=generation_id,
                file_content=problematic_xyzrgb_content,
                file_type="problematic_xyzrgb",
            )

        await queue.put(f"data: {json.dumps({'type': 'pipeline', 'stage': 'storage', 'message': 'Storage complete', 'progress': 100})}\n\n")

        # Update prompt_enhancement if provided
        if prompt_enhancement:
            await generation_storage.update_status(
                generation_id, "processing",
                prompt_enhancement=prompt_enhancement,
            )

        # Mark generation as completed
        await generation_storage.update_status(generation_id, "completed")

        await queue.put(f"data: {json.dumps({'type': 'pipeline', 'stage': 'pipeline_complete', 'generation_id': generation_id})}\n\n")

    except Exception as e:
        logger.error(f"Streaming pipeline failed for generation {generation_id}: {e}")
        await queue.put(f"data: {json.dumps({'type': 'pipeline', 'stage': 'error', 'message': str(e)})}\n\n")
        try:
            await generation_storage.update_status(generation_id, "failed", str(e))
        except Exception:
            pass

    finally:
        # Cancel heartbeat
        if heartbeat_task:
            heartbeat_task.cancel()
        # Clean up temp files
        if temp_dir:
            try:
                import shutil
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception as cleanup_e:
                logger.warning(f"Failed to clean up temp dir: {cleanup_e}")
        # Signal the consumer generator that we're done
        await queue.put(None)


async def run_streaming_pipeline(
    image_url: str,
    generation_id: str,
    detail_level: float,
    user_info: dict,
    auth_info: dict,
    credits_to_deduct: int = 1,
    original_image_url: Optional[str] = None,
    processed_image_url: Optional[str] = None,
    prompt_enhancement: Optional[str] = None,
    text_prompt: Optional[str] = None,
    model_option: Optional[str] = None,
    prompt_option: Optional[str] = None,
    image_prompt: Optional[str] = None,
    edit_image: bool = False,
    stream_3d: bool = True,
) -> AsyncGenerator[str, None]:
    """
    Top-level async generator for StreamingResponse.
    Spawns the actual pipeline in a background asyncio.Task so that it
    survives client disconnects, then forwards events from a queue.

    If text_prompt is provided, the pipeline will first generate an image
    from text using fal-ai/flux-2 (with streamed status updates) before
    proceeding with the SAM3D streaming pipeline.

    If edit_image is True, the pipeline will preprocess the image using
    nano-banana edit and background removal (with streamed status updates)
    before proceeding with the SAM3D streaming pipeline.

    If the client refreshes / disconnects mid-stream the background task
    keeps running (with its heartbeat), so the generation completes
    normally and the polling client picks it up.
    """
    queue: asyncio.Queue = asyncio.Queue()

    # Spawn pipeline as a fire-and-forget background task
    task = start_generation_task(generation_id,
        _pipeline_worker(
            queue=queue,
            image_url=image_url,
            generation_id=generation_id,
            detail_level=detail_level,
            user_info=user_info,
            auth_info=auth_info,
            credits_to_deduct=credits_to_deduct,
            original_image_url=original_image_url,
            processed_image_url=processed_image_url,
            prompt_enhancement=prompt_enhancement,
            text_prompt=text_prompt,
            model_option=model_option,
            prompt_option=prompt_option,
            image_prompt=image_prompt,
            edit_image=edit_image,
            stream_3d=stream_3d,
        )
    )

    # Also close the observer if the job is cancelled before its worker starts.
    task.add_done_callback(lambda _: queue.put_nowait(None))
    yield _sse({"type": "pipeline", "stage": "started", "generation_id": generation_id})
    try:
        while True:
            event = await queue.get()
            if event is None:  # Sentinel — worker finished
                break
            yield event
    except (asyncio.CancelledError, GeneratorExit):
        # Client disconnected — let the background task continue
        logger.info(
            f"Client disconnected from stream for generation {generation_id}, "
            "pipeline continues in background"
        )
