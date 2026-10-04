"""BrickBuilder jobs and persistence around Nova's own private agent service."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import tempfile
from pathlib import Path
from typing import Literal

from fastapi import Depends, HTTPException
from fastapi.responses import Response
from pydantic import PrivateAttr

from .imageToBricks import ImageToBricksResponse
from .llmToBricks import LlmToBricksRequest, SUPPORTED_MODELS
from ..utils.auth import deduct_credits, get_user_with_optional_auth, handle_auth_and_tracking
from ..utils.authorization import require_generation_access
from ..utils.generation_storage import generation_storage
from ..utils.generation_tasks import start_generation_task
from ..utils.llm_output import run_with_output
from ..utils.nova_service import NovaService
from ..utils.pack_ldraw_model import LDrawPacker
from ..utils.posthog_client import track_error, track_image_conversion

def _nova_service(request, auth_info):
    previous = request._nova_session
    key = 'local-native' if request.auth_mode == 'native' else f"{auth_info.get('is_anonymous', True)}:{auth_info.get('user_id') or auth_info.get('guest_user_id')}"
    return NovaService(tenant_key=key, tenant_id=previous.get('tenant') if previous else None)


logger = logging.getLogger(__name__)
_background_tasks: set[asyncio.Task] = set()


def _generation_timeout() -> float:
    try:
        seconds = float(os.getenv("NOVA_TIMEOUT_SECONDS", "1800"))
        return seconds if math.isfinite(seconds) and 60 <= seconds <= 7200 else 1800
    except ValueError:
        return 1800


class NovaToBricksRequest(LlmToBricksRequest):
    auth_mode: Literal["api_key", "native"] = "api_key"
    _nova_session: dict | None = PrivateAttr(default=None)


async def _save_session(generation_id: str, session: dict):
    bucket = generation_storage.client.storage.from_("generation-output")
    await asyncio.to_thread(bucket.upload, path=f"{generation_id}/nova-session.json",
                            file=json.dumps(session, allow_nan=False).encode(),
                            file_options={"content-type": "application/json", "upsert": "true"})


async def _owned_session(generation_id: str, auth_info: dict) -> dict:
    generation = await generation_storage.get_generation(generation_id)
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")
    require_generation_access(generation, auth_info)
    if generation.get("endpoint") != "novaToBricks":
        raise HTTPException(status_code=400, detail="This generation does not have a Nova session")
    if generation.get("status") not in {"completed", "failed", "cancelled"}:
        raise HTTPException(status_code=409, detail="Wait for the current Nova job to finish before continuing it")
    try:
        bucket = generation_storage.client.storage.from_("generation-output")
        data = await asyncio.to_thread(bucket.download, f"{generation_id}/nova-session.json")
        if len(data) > 16000:
            raise ValueError("Oversized session metadata")
        session = json.loads(data)
        NovaService.session_id(session['chat_id'])
        if not isinstance(session.get('tenant'), str) or len(session['tenant']) != 64:
            raise ValueError('Invalid tenant metadata')
        if session['model'] not in SUPPORTED_MODELS or session['auth_mode'] not in {'api_key', 'native'}:
            raise ValueError("Invalid session metadata")
        return session
    except Exception:
        raise HTTPException(status_code=409, detail="This generation predates the Nova runtime integration or its session is unavailable") from None


async def process_nova_to_bricks_task(generation_id, request, user_info, auth_info, on_thinking=None):
    async def heartbeat():
        while True:
            await asyncio.sleep(5)
            await generation_storage.update_status(generation_id, "processing")

    heartbeat_task = None
    try:
        await generation_storage.update_status(generation_id, "processing")
        heartbeat_task = asyncio.create_task(heartbeat())
        provider = SUPPORTED_MODELS[request.model].provider
        async with _nova_service(request, auth_info) as nova:
            try:
                result = await asyncio.wait_for(nova.run(request, provider,
                    lambda session: _save_session(generation_id, session), on_thinking, request._nova_session),
                    timeout=_generation_timeout())
            except asyncio.TimeoutError:
                raise ValueError("Nova reached the build time limit. Its session is retained for continuation.") from None
        if on_thinking:
            await on_thinking("\n\nSaving Nova's model and source files.\n\n")
        with tempfile.TemporaryDirectory(prefix="brickbuilder-nova-import-") as directory:
            model_path = Path(directory) / "model.mpd"
            model_path.write_text(result.mpd, encoding="utf-8")
            packer = LDrawPacker(ldraw_path=os.getenv("LDRAW_DIR"))
            packed_path = await asyncio.to_thread(packer.pack_ldraw_model, str(model_path))
            packed_mpd = Path(packed_path).read_text(encoding="utf-8")
        if request.image_base64:
            image = f"data:{request.image_media_type};base64,{request.image_base64}"
            await generation_storage.store_images(generation_id=generation_id, original_image_url=image, processed_image_url=image)
        await generation_storage.store_model_file(generation_id, result.ldr, "ldr", raise_on_error=True)
        await generation_storage.store_model_file(generation_id, packed_mpd, "mpd", raise_on_error=True)
        # The display export has one root physical placement per line. Embedded
        # DAT definitions, if present, are retained for viewing but are not inventory.
        root = result.ldr.split("\n0 FILE ", 1)[0]
        await generation_storage.store_parts_list_csv(generation_id, root, raise_on_error=True)
        if result.preview:
            await generation_storage.store_preview_image(generation_id, result.preview)
        bucket = generation_storage.client.storage.from_("generation-output")
        await asyncio.to_thread(bucket.upload, path=f"{generation_id}/nova-source.zip", file=result.archive,
                                file_options={"content-type": "application/zip", "upsert": "true"})
        await deduct_credits(user_info=user_info, auth_info=auth_info, credits_to_deduct=1,
                             operation_description=f"Nova generation ({request.model})")
        await generation_storage.update_status(generation_id, "completed")
        track_image_conversion(user_id=user_info["user_email"], success=True, has_mpd=True,
                               ldr_size=len(result.ldr), mpd_size=len(packed_mpd.encode()), image_type="nova_full_set",
                               is_developer=user_info["is_developer"])
        return None
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("Nova generation failed for %s", generation_id)
        message = str(getattr(exc, "detail", None) or exc) or "Nova generation failed"
        await generation_storage.update_status(generation_id, "failed", message)
        track_error(error_type=type(exc).__name__, error_message=message, endpoint="/novaToBricks",
                    user_id=user_info.get("user_email", "anonymous"))
        return message
    finally:
        if heartbeat_task:
            heartbeat_task.cancel()
            await asyncio.gather(heartbeat_task, return_exceptions=True)


async def nova_to_bricks(request: NovaToBricksRequest, auth_info: dict = Depends(get_user_with_optional_auth), http_request=None) -> ImageToBricksResponse:
    if generation_storage is None:
        raise HTTPException(status_code=503, detail="Generation storage is unavailable")
    if request.generation_id:
        request._nova_session = await _owned_session(request.generation_id, auth_info)
        # Continue with the original provider settings and workspace.
        request.model = request._nova_session['model']
        request.auth_mode = request._nova_session['auth_mode']
    if request.auth_mode == 'native':
        from ..utils.local_provider_connections import require_local_development
        if http_request is None:
            raise HTTPException(status_code=403, detail="Native Nova connections require localhost")
        require_local_development(http_request)
    provider = SUPPORTED_MODELS[request.model].provider
    user_info = handle_auth_and_tracking(auth_info=auth_info, endpoint="/novaToBricks", required_credits=1,
        track_properties={"has_image": bool(request.image_base64), "model": request.model, "provider": provider,
                          "auth_mode": request.auth_mode, "is_edit": bool(request.generation_id)})
    try:
        async with _nova_service(request, auth_info) as nova:
            await nova.ready()
            await nova.configure_model(request.model, SUPPORTED_MODELS[request.model].provider, request.auth_mode)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    generation_id = await generation_storage.create_generation(
        user_id=auth_info.get("user_id", user_info["user_email"]),
        user_type="anonymous" if user_info["is_anonymous"] else "authenticated",
        prompt=request.prompt or "Image reference", detail_level=request.detail_level,
        endpoint="novaToBricks", model_3d=request.model, edit_generation_id=request.generation_id,
    )
    task = start_generation_task(generation_id, run_with_output(generation_id, process_nova_to_bricks_task, request, user_info, auth_info))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return ImageToBricksResponse(generation_id=generation_id, message="Nova generation started. Poll /generation/{generation_id} for status.")


async def get_nova_source(generation_id: str, auth_info: dict = Depends(get_user_with_optional_auth)) -> Response:
    if generation_storage is None:
        raise HTTPException(status_code=503, detail="Generation storage is unavailable")
    generation = await generation_storage.get_generation(generation_id)
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")
    require_generation_access(generation, auth_info)
    if generation.get("endpoint") != "novaToBricks" or generation.get("status") != "completed":
        raise HTTPException(status_code=404, detail="Nova source is not available for this generation")
    try:
        bucket = generation_storage.client.storage.from_("generation-output")
        data = await asyncio.to_thread(bucket.download, f"{generation_id}/nova-source.zip")
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Nova source archive not found") from exc
    return Response(data, media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="nova-set-source.zip"',
                                                                "Cache-Control": "private, no-store"})
