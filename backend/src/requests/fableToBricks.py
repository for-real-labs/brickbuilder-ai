"""All parts builds and owner-only revisions for the Fable agent."""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

import httpx
from fable_agent.app import Options, start_build
from fable_agent.ldraw import default_library_dir
from fable_agent.render import find_leocad
from fastapi import HTTPException
from PIL import Image
from storage3.exceptions import StorageApiError

from ..astrology.render import prepare_reference
from ..utils.auth import handle_auth_and_tracking
from ..utils.authorization import require_generation_access
from ..utils.building_agents import FABLE_AGENTS, FableVariant
from ..utils.generation_budget import current_generation_usage
from ..utils.generation_storage import generation_storage
from ..utils.generation_tasks import start_generation_task
from ..utils.llm_output import run_with_output
from ..utils.nova_service import INSTRUCTIONS_FILE
from ..utils.prompt_parts_limit import tighter_parts_limit
from ..utils.storage_upload import upload_artifact
from .astrologyToBricks import astrology_allowed
from .imageToBricks import ImageToBricksResponse

DESIGN_FILE = "fable-design.json"
MAX_PARTS = 5000
DEFAULT_PARTS = 1000
logger = logging.getLogger(__name__)
# What the customer is shown while the agent uses each of its tools.
PROGRESS = {
    "search_parts": "Choosing parts", "inspect_part": "Choosing parts", "view_parts": "Choosing parts",
    "look_up": "Choosing parts", "write_script": "Building the model", "build": "Building the model",
    "edit_script": "Improving the model", "patch": "Improving the model",
    "render": "Reviewing the rendered model", "finish": "Saving your model and building instructions",
}


class BuildCancelled(Exception):
    """The generation was cancelled; stop the agent at its next step."""


@dataclass(frozen=True)
class Design:
    """What a later revision needs from an earlier build: its script and what was asked for."""

    script: str
    requests: tuple[str, ...]


@dataclass(frozen=True)
class Built:
    ldraw: str
    script: str
    preview: bytes | None


# Fable is offered to the accounts that may use Astrology: one allowlist for the experimental agents.
fable_allowed = astrology_allowed


async def _source_design(source: dict, auth_info: dict) -> Design:
    require_generation_access(source, auth_info)
    if source.get("model_used_3d") not in FABLE_AGENTS or source.get("status") != "completed":
        raise HTTPException(409, "Choose a completed Fable model or start a new build.")
    bucket = generation_storage.client.storage.from_("generation-output")
    artifact_id = source.get("restored_from_id") or source["id"]
    try:
        data = await asyncio.to_thread(bucket.download, f"{artifact_id}/{DESIGN_FILE}")
        if len(data) > 2 * 1024 * 1024:
            raise ValueError("Oversized saved design")
        saved = json.loads(data)
        script, requests = saved["script"], saved["requests"]
        if not isinstance(script, str) or not script.strip() or not isinstance(requests, list) \
                or not all(isinstance(item, str) for item in requests):
            raise ValueError("Invalid saved design")
        return Design(script, tuple(requests[-8:]))
    except (OSError, ValueError, KeyError, TypeError, StorageApiError, httpx.HTTPError):
        raise HTTPException(409, "The saved Fable design is unavailable.") from None


def _run(prompt: str, variant: FableVariant, max_parts: int, reference: bytes | None, script: str | None,
         key: str, on_event) -> Built:
    """Run one build to the end in a scratch directory. Blocking: call it from a worker thread."""
    with tempfile.TemporaryDirectory(prefix="fable-generation-") as scratch:
        root = Path(scratch)
        picture = None
        if reference:
            picture = root / "reference-upload"
            picture.write_bytes(reference)
        options = Options(model=variant.model, method=variant.method, effort=variant.effort,
                          max_parts=max_parts, api_key=key)
        result = start_build(prompt, root / "session", options, reference=picture, on_event=on_event,
                             script=script)
        if result.published is None:
            if result.status == "refused":
                raise ValueError("Fable could not build this request.")
            raise ValueError("Fable could not finish a model that passes its checks. Try a simpler request.")
        published = root / "session" / result.published["path"]
        preview = published / "preview.png"
        return Built((published / "model.ldr").read_text(encoding="utf-8"),
                     (published / "build.py").read_text(encoding="utf-8"),
                     preview.read_bytes() if preview.is_file() else None)


def _change_request(prompt: str, design: Design | None) -> str:
    if not design or not design.requests:
        return prompt
    earlier = "\n".join(f"- {request}" for request in design.requests)
    return f"{prompt}\n\nWhat was asked for before, for context:\n{earlier}"


async def _build(generation_id, request, agent_id, design, reference, key, _on_thinking=None, *, on_progress):
    async def heartbeat():
        while True:
            await asyncio.sleep(5)
            try:
                await generation_storage.heartbeat(generation_id)
            except Exception:
                logger.warning("Fable heartbeat failed for %s", generation_id, exc_info=True)

    loop = asyncio.get_running_loop()
    ledger = current_generation_usage.get()
    cancelled = threading.Event()
    calls: list[dict] = []
    shown: list[str] = []

    def on_event(kind: str, data: dict) -> None:
        """Called on the agent's worker thread for every step it takes."""
        if cancelled.is_set():
            raise BuildCancelled
        if kind == "turn":
            calls.append(data["usage"])
            if ledger is not None:
                ledger.replace_source(f"fable-{generation_id}", calls)
        elif kind == "tool_call":
            text = PROGRESS.get(data.get("name"))
            if text and shown[-1:] != [text]:
                shown.append(text)
                asyncio.run_coroutine_threadsafe(on_progress(text), loop)

    pulse = asyncio.create_task(heartbeat())
    prompt = request.prompt or "Build the subject in the photo."
    try:
        await generation_storage.update_status(generation_id, "processing")
        await on_progress("Designing your model")
        built = await asyncio.to_thread(
            _run, _change_request(prompt, design), FABLE_AGENTS[agent_id], request.max_parts, reference,
            design.script if design else None, key, on_event)
        await on_progress("Saving your model and building instructions")
        bucket = generation_storage.client.storage.from_("generation-output")
        saved = {"agent": agent_id, "script": built.script,
                 "requests": [*(design.requests if design else ()), prompt]}
        await upload_artifact(bucket, path=f"{generation_id}/{DESIGN_FILE}", file=json.dumps(saved).encode(),
                              content_type="application/json")
        await upload_artifact(bucket, path=f"{generation_id}/{INSTRUCTIONS_FILE}", file=built.ldraw.encode(),
                              content_type="text/plain")
        if reference:
            image = "data:image/jpeg;base64," + base64.b64encode(reference).decode("ascii")
            await generation_storage.store_images(generation_id, original_image_url=image,
                                                  processed_image_url=image)
        await generation_storage.store_model_file(generation_id, built.ldraw, "ldr", raise_on_error=True)
        await generation_storage.store_parts_list_csv(generation_id, built.ldraw, raise_on_error=True)
        if built.preview:
            await generation_storage.store_preview_image(generation_id, built.preview)
        await generation_storage.update_status(generation_id, "completed")
    except asyncio.CancelledError:
        cancelled.set()  # the worker thread stops at the agent's next step, so no more is spent
        raise
    except Exception as exc:
        logger.exception("Fable generation failed for %s", generation_id)
        message = str(exc) if isinstance(exc, ValueError) else "Fable could not complete this build."
        await generation_storage.update_status(generation_id, "failed", message)
        return message
    finally:
        pulse.cancel()
        await asyncio.gather(pulse, return_exceptions=True)


def _ready() -> bool:
    """The parts library and renderer the agent needs are installed."""
    try:
        return bool(find_leocad()) and (default_library_dir() / "LDConfig.ldr").is_file()
    except OSError:
        return False


async def fable_to_bricks(request, auth_info, source=None):
    if not fable_allowed(auth_info):
        raise HTTPException(403, "Fable is unavailable for this account.")
    agent_id = source.get("model_used_3d") if source else request.building_agent
    variant = FABLE_AGENTS.get(agent_id)
    if variant is None:
        raise HTTPException(422, "Unknown building agent.")
    if request.auth_mode != "api_key" or request.billing_source == "personal":
        raise HTTPException(422, "Fable uses BrickBuilder credits and its configured AI connections.")
    if request.parts_inventory is not None:
        raise HTTPException(422, "Fable builds from the BrickBuilder catalog and cannot use a parts inventory yet.")
    key = os.getenv(variant.key_env)
    if not key or generation_storage is None or not _ready():
        raise HTTPException(503, "Fable is temporarily unavailable.")
    design = await _source_design(source, auth_info) if source else None
    request.max_parts = (tighter_parts_limit(request.max_parts, source.get("max_parts") if source else None)
                         or DEFAULT_PARTS)
    if request.max_parts > MAX_PARTS:
        raise HTTPException(422, "Fable supports a maximum of 5,000 pieces.")
    try:
        reference = (await asyncio.to_thread(prepare_reference, base64.b64decode(request.image_base64))
                     if request.image_base64 else None)
    except (OSError, ValueError, binascii.Error, Image.DecompressionBombError):
        raise HTTPException(422, "Choose a valid reference image within the supported size.") from None
    # Every All parts engine uses the same admission, credit policy and viewer.
    handle_auth_and_tracking(auth_info, "/novaToBricks", {
        "building_agent": agent_id, "has_image": bool(reference), "is_edit": bool(source)})
    job_id = await generation_storage.create_generation(
        user_id=auth_info["user_id"], user_type="authenticated", prompt=request.prompt or "Image reference",
        detail_level=request.detail_level, endpoint="novaToBricks", model_3d=agent_id,
        max_parts=request.max_parts, input_type="image" if reference else "text",
        entry_page=request.entry_page, edit_generation_id=request.generation_id)
    start_generation_task(job_id, run_with_output(job_id, _build, request, agent_id, design, reference, key,
                                                  native_progress=True))
    return ImageToBricksResponse(generation_id=job_id, message="Fable generation started.")

