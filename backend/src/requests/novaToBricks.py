"""Optional Nova full-set jobs using BrickBuilder's existing generation lifecycle."""
from __future__ import annotations

import asyncio
import io
import json
import logging
import math
import os
import re
import tempfile
import zipfile
from pathlib import Path
from typing import Literal

from fastapi import Depends, HTTPException
from fastapi.responses import Response
from pydantic import Field, model_validator

from .imageToBricks import ImageToBricksResponse
from .llmToBricks import LlmToBricksRequest, SUPPORTED_MODELS
from ..utils.auth import deduct_credits, get_user_with_optional_auth, handle_auth_and_tracking
from ..utils.authorization import require_generation_access
from ..utils.generation_storage import generation_storage
from ..utils.generation_tasks import start_generation_task
from ..utils.llm_output import run_with_output
from ..utils.nova_agent import build_set
from ..utils.nova_toolkit import NovaToolkit
from ..utils.pack_ldraw_model import LDrawPacker
from ..utils.posthog_client import track_error, track_image_conversion

logger = logging.getLogger(__name__)
_background_tasks: set[asyncio.Task] = set()
MAX_REFERENCE_ARCHIVE_BYTES = 32_000_000


def _generation_timeout() -> float:
    try:
        seconds = float(os.getenv("NOVA_TIMEOUT_SECONDS", "1800"))
        return seconds if math.isfinite(seconds) and 60 <= seconds <= 7200 else 1800
    except ValueError:
        return 1800


class NovaToBricksRequest(LlmToBricksRequest):
    auth_mode: Literal["api_key", "native"] = "api_key"
    max_iterations: int = Field(default=30, ge=4, le=80)
    max_parts: int = Field(default=5_000, ge=50, le=10_000)
    use_jev: bool = True

    @model_validator(mode="after")
    def reject_voxel_edit(self):
        if self.generation_id:
            raise ValueError("Nova creates new full sets; use the existing model editor for revisions")
        return self


def _source_archive(build, packed_mpd: str | None = None) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("model.plan.json", json.dumps(build.plan, indent=2, allow_nan=False))
        archive.writestr("model.mpd", build.mpd)
        if packed_mpd:
            archive.writestr("model-packed.mpd", packed_mpd)
        archive.writestr("model.ldr", build.ldr)
        archive.writestr("inspection.json", json.dumps(build.report, indent=2, allow_nan=False))
        archive.writestr("review.png", build.preview_png)
        if build.runtime:
            archive.writestr("runtime.json", json.dumps(build.runtime, indent=2, allow_nan=False))
        if build.references:
            if len(build.references) > 8:
                raise ValueError("Too many retained reference studies")
            index = []
            reference_bytes = 0
            for reference in build.references:
                # Canonical identity is the only filename component; virtual
                # MPD section names remain data inside the source document.
                if not re.fullmatch(r"(?:model|submodel)-[a-f0-9]{24}", reference.id):
                    raise ValueError("Invalid retained reference identity")
                prefix = f"references/{reference.id}/"
                metadata = {**reference.metadata, "source_resource": prefix + "source.mpd", "preview_resource": prefix + "preview.mpd",
                            "metadata_resource": prefix + "provenance.json"}
                provenance = json.dumps(metadata, indent=2, allow_nan=False)
                reference_bytes += len(reference.source_mpd.encode()) + len(reference.preview_mpd.encode()) + len(provenance.encode()) + len(reference.preview_png or b"")
                if reference_bytes > MAX_REFERENCE_ARCHIVE_BYTES:
                    raise ValueError("Retained reference archive exceeds the source budget")
                archive.writestr(prefix + "source.mpd", reference.source_mpd)
                archive.writestr(prefix + "preview.mpd", reference.preview_mpd)
                archive.writestr(prefix + "provenance.json", provenance)
                if reference.preview_png:
                    archive.writestr(prefix + "review.png", reference.preview_png)
                index.append({"id": reference.id, "model": reference.metadata.get("model"), "section": reference.metadata.get("section"),
                              "source_sha256": reference.metadata.get("source_sha256"), "attribution": reference.metadata.get("attribution")})
            reference_index = json.dumps(index, indent=2, allow_nan=False)
            if reference_bytes + len(reference_index.encode()) > MAX_REFERENCE_ARCHIVE_BYTES:
                raise ValueError("Retained reference archive exceeds the source budget")
            archive.writestr("references/index.json", reference_index)
        archive.writestr("README.txt", "Created with BrickBuilder AI's optional Nova agent.\n"
                         "The deterministic plan can be rebuilt with the separately installed ldraw-nova toolkit.\n"
                         "Geometry and connection evidence does not prove physical buildability.\n"
                         "Reference studies, when present, retain their original source authors and licences in references/.\n"
                         "Toolkit: https://github.com/anteloc/ldraw-nova (AGPL-3.0).\n")
    return output.getvalue()


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
        with tempfile.TemporaryDirectory(prefix="brickbuilder-nova-") as directory:
            workspace = Path(directory)
            try:
                build = await asyncio.wait_for(build_set(request, provider, workspace, on_thinking), timeout=_generation_timeout())
            except asyncio.TimeoutError as exc:
                raise ValueError("Nova reached the build time limit. Try a smaller set or increase NOVA_TIMEOUT_SECONDS for local development.") from exc
            if on_thinking:
                await on_thinking("\n\nPacking the complete set and parts list.\n\n")
            model_path = workspace / "model.ldr"
            model_path.write_text(build.ldr, encoding="utf-8")
            library = NovaToolkit(workspace).library
            packer = LDrawPacker(ldraw_path=str(library))
            packed_path = await asyncio.to_thread(packer.pack_ldraw_model, str(model_path))
            packed_mpd = Path(packed_path).read_text(encoding="utf-8")
            mpd_size = len(packed_mpd.encode("utf-8"))
        if request.image_base64:
            image = f"data:{request.image_media_type};base64,{request.image_base64}"
            await generation_storage.store_images(generation_id=generation_id, original_image_url=image, processed_image_url=image)
        await generation_storage.store_model_file(generation_id, build.ldr, "ldr", raise_on_error=True)
        await generation_storage.store_parts_list_csv(generation_id, build.ldr, raise_on_error=True)
        await generation_storage.store_preview_image(generation_id, build.preview_png)
        bucket = generation_storage.client.storage.from_("generation-output")
        await asyncio.to_thread(bucket.upload, path=f"{generation_id}/nova-source.zip", file=_source_archive(build, packed_mpd),
                                file_options={"content-type": "application/zip", "upsert": "true"})
        await deduct_credits(user_info=user_info, auth_info=auth_info, credits_to_deduct=1,
                             operation_description=f"Nova full-set generation ({request.model})")
        await generation_storage.update_status(generation_id, "completed")
        track_image_conversion(user_id=user_info["user_email"], success=True, has_mpd=True,
                               ldr_size=len(build.ldr), mpd_size=mpd_size, image_type="nova_full_set",
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


async def nova_to_bricks(request: NovaToBricksRequest, auth_info: dict = Depends(get_user_with_optional_auth)) -> ImageToBricksResponse:
    # Native provider sessions must also pass the HTTP peer/Host/Origin guard in
    # api.py before this service entry point is called.
    if generation_storage is None:
        raise HTTPException(status_code=503, detail="Generation storage is unavailable")
    try:
        NovaToolkit(Path(tempfile.gettempdir())).require_ready()
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    provider = SUPPORTED_MODELS[request.model].provider
    user_info = handle_auth_and_tracking(auth_info=auth_info, endpoint="/novaToBricks", required_credits=1,
        track_properties={"has_image": bool(request.image_base64), "model": request.model, "provider": provider,
                          "auth_mode": request.auth_mode, "max_parts": request.max_parts, "use_jev": request.use_jev})
    if request.auth_mode == "api_key":
        key_name = "OPENAI_API_KEY" if provider == "openai" else "ANTHROPIC_API_KEY"
        if not os.getenv(key_name):
            raise HTTPException(status_code=503, detail=f"{key_name} is not configured. Connect a provider in local settings.")
    elif request.auth_mode == "native":
        from ..utils.local_provider_connections import cli_connected, local_providers_enabled
        if not local_providers_enabled() or not await cli_connected(provider):
            raise HTTPException(status_code=503, detail=f"Sign in to {'ChatGPT' if provider == 'openai' else 'Claude'} in local provider settings first.")
    generation_id = await generation_storage.create_generation(
        user_id=auth_info.get("user_id", user_info["user_email"]),
        user_type="anonymous" if user_info["is_anonymous"] else "authenticated",
        prompt=request.prompt or "Image reference", detail_level=request.detail_level,
        endpoint="novaToBricks", model_3d=request.model,
    )
    task = start_generation_task(generation_id, run_with_output(generation_id, process_nova_to_bricks_task, request, user_info, auth_info))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return ImageToBricksResponse(generation_id=generation_id, message="Nova full-set generation started. Poll /generation/{generation_id} for status.")


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
