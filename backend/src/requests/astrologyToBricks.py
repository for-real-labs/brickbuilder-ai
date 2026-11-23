"""All parts builds and owner-only revisions for the Astrology agent."""

import asyncio
import base64
import json
import logging
import os
from functools import lru_cache

import httpx
from fastapi import HTTPException
from PIL import Image
from storage3.exceptions import StorageApiError

from ..astrology.agent import design
from ..astrology.design import sections
from ..astrology.render import Renderer, prepare_reference
from ..astrology.session import Session, open_client
from ..utils.auth import handle_auth_and_tracking
from ..utils.authorization import require_generation_access
from ..utils.generation_storage import generation_storage
from ..utils.generation_tasks import start_generation_task
from ..utils.llm_output import run_with_output
from ..utils.nova_service import INSTRUCTIONS_FILE
from ..utils.parts_inventory import PartsInventory
from ..utils.prompt_parts_limit import tighter_parts_limit
from ..utils.storage_upload import upload_artifact
from ..utils.supplier_catalog import get_supplier_catalog
from .imageToBricks import ImageToBricksResponse

AGENT = "astrology"
DESIGN_FILE = "astrology-design.json"
logger = logging.getLogger(__name__)


@lru_cache(maxsize=4)
def allowed_emails(config):
    return {email.strip().casefold() for email in config.split(",") if email.strip()}


def astrology_allowed(identity):
    email = identity.get("user_email")
    return (
        identity.get("authenticated") is True
        and identity.get("auth_method") == "jwt"
        and not identity.get("is_anonymous")
        and isinstance(email, str)
        and email.casefold() in allowed_emails(os.getenv("ASTROLOGY_ALLOWED_EMAILS", ""))
    )


async def _source_design(source, auth_info):
    require_generation_access(source, auth_info)
    if source.get("model_used_3d") != AGENT or source.get("status") != "completed":
        raise HTTPException(409, "Choose a completed Astrology model or start a new build.")
    bucket = generation_storage.client.storage.from_("generation-output")
    artifact_id = source.get("restored_from_id") or source["id"]
    try:
        data = await asyncio.to_thread(bucket.download, f"{artifact_id}/{DESIGN_FILE}")
        if len(data) > 4 * 1024 * 1024:
            raise ValueError("Oversized saved design")
        saved = json.loads(data)
        inventory = (
            PartsInventory.model_validate(saved["inventory"]) if saved["inventory"] else None
        )
        return sections(saved["sections"]), inventory
    except (OSError, ValueError, KeyError, TypeError, StorageApiError, httpx.HTTPError):
        raise HTTPException(409, "The saved Astrology design is unavailable.") from None


async def _build(
    generation_id,
    request,
    program,
    inventory,
    reference,
    key,
    renderer,
    _on_thinking=None,
    *,
    on_progress,
):
    async def heartbeat():
        while True:
            await asyncio.sleep(5)
            try:
                await generation_storage.heartbeat(generation_id)
            except Exception:
                logger.warning("Astrology heartbeat failed for %s", generation_id, exc_info=True)

    pulse = asyncio.create_task(heartbeat())
    try:
        await generation_storage.update_status(generation_id, "processing")
        await on_progress("Designing your model")
        catalog = inventory.catalog() if inventory else get_supplier_catalog()
        async with open_client(key) as client:
            session = Session(
                client,
                request.prompt or "Build the subject in the photo.",
                request.max_parts,
                reference,
            )
            build = await design(
                session,
                catalog,
                request.max_parts,
                renderer,
                program=program,
                report=lambda status: logger.debug("Astrology %s: %s", generation_id, status),
                on_review=on_progress,
            )
        await on_progress("Saving your model and building instructions")
        ldraw = build.assembly.ldraw()
        bucket = generation_storage.client.storage.from_("generation-output")
        saved = {
            "sections": build.program,
            "inventory": inventory.model_dump() if inventory else None,
        }
        await upload_artifact(
            bucket,
            path=f"{generation_id}/{DESIGN_FILE}",
            file=json.dumps(saved).encode(),
            content_type="application/json",
        )
        await upload_artifact(
            bucket,
            path=f"{generation_id}/{INSTRUCTIONS_FILE}",
            file=ldraw.encode(),
            content_type="text/plain",
        )
        if reference:
            image = "data:image/jpeg;base64," + base64.b64encode(reference).decode("ascii")
            await generation_storage.store_images(
                generation_id, original_image_url=image, processed_image_url=image
            )
        await generation_storage.store_model_file(generation_id, ldraw, "ldr", raise_on_error=True)
        await generation_storage.store_parts_list_csv(generation_id, ldraw, raise_on_error=True)
        await generation_storage.store_preview_image(generation_id, build.views.front)
        await generation_storage.update_status(generation_id, "completed")
    except Exception as exc:
        logger.exception("Astrology generation failed for %s", generation_id)
        message = (
            str(exc) if isinstance(exc, ValueError) else "Astrology could not complete this build."
        )
        await generation_storage.update_status(generation_id, "failed", message)
        return message
    finally:
        pulse.cancel()
        await asyncio.gather(pulse, return_exceptions=True)


async def astrology_to_bricks(request, auth_info, source=None):
    if not astrology_allowed(auth_info):
        raise HTTPException(403, "Astrology is unavailable for this account.")
    if request.auth_mode != "api_key" or request.billing_source == "personal":
        raise HTTPException(
            422, "Astrology uses BrickBuilder credits and its configured OpenAI connection."
        )
    key = os.getenv("OPENAI_API_KEY")
    if not key or generation_storage is None:
        raise HTTPException(503, "Astrology is temporarily unavailable.")
    program, inventory = (
        await _source_design(source, auth_info) if source else (None, request.parts_inventory)
    )
    request.max_parts = (
        tighter_parts_limit(request.max_parts, source.get("max_parts") if source else None) or 1000
    )
    if request.max_parts > 5000:
        raise HTTPException(422, "Astrology supports a maximum of 5,000 pieces.")
    try:
        renderer = Renderer()
    except ValueError:
        raise HTTPException(503, "Astrology rendering is temporarily unavailable.") from None
    try:
        reference = (
            await asyncio.to_thread(prepare_reference, base64.b64decode(request.image_base64))
            if request.image_base64
            else None
        )
    except (OSError, ValueError, Image.DecompressionBombError):
        raise HTTPException(
            422, "Choose a valid reference image within the supported size."
        ) from None
    # Both engines use the same All parts admission, credit policy and viewer.
    handle_auth_and_tracking(
        auth_info,
        "/novaToBricks",
        {
            "building_agent": AGENT,
            "has_image": bool(reference),
            "is_edit": bool(source),
        },
    )
    job_id = await generation_storage.create_generation(
        user_id=auth_info["user_id"],
        user_type="authenticated",
        prompt=request.prompt or "Image reference",
        detail_level=request.detail_level,
        endpoint="novaToBricks",
        model_3d=AGENT,
        max_parts=request.max_parts,
        input_type="image" if reference else "text",
        entry_page=request.entry_page,
        edit_generation_id=request.generation_id,
    )
    start_generation_task(
        job_id,
        run_with_output(
            job_id,
            _build,
            request,
            program,
            inventory,
            reference,
            key,
            renderer,
            native_progress=True,
        ),
    )
    return ImageToBricksResponse(generation_id=job_id, message="Astrology generation started.")
