"""All parts builds and owner-only revisions for the Fable agent."""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import json
import logging
import os
import tempfile
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import httpx
from fable_agent.app import ASSISTED as EXAMPLE_METHODS
from fable_agent.app import Options, start_build
from fable_agent.ldraw import default_library_dir
from fable_agent.render import find_leocad
from fable_agent.runner import SandboxError, script_account
from fastapi import HTTPException
from PIL import Image
from storage3.exceptions import StorageApiError

from ..astrology.render import prepare_reference
from ..utils import auth
from ..utils.generation_mode import ALL_PARTS_AGENT_ENDPOINTS
from ..utils.auth import handle_auth_and_tracking
from ..utils.authorization import require_generation_access
from ..utils.build_design_guidance import guided_build_prompt
from ..utils.building_agents import FABLE_AGENTS, PIP_AGENT, PIP_AGENTS, PIP_ENDPOINT, FableVariant, open_to_everyone
from ..utils.generation_budget import current_generation_usage
from ..utils.generation_storage import generation_storage
from ..utils.generation_tasks import start_generation_task
from ..utils.llm_output import run_with_output
from ..utils.pip_source_model import source_script
from ..utils.nova_service import INSTRUCTIONS_FILE
from ..utils.parts_inventory import PartsInventory
from ..utils.saved_parts_inventory import load_inventory, save_inventory
from ..utils.prompt_parts_limit import tighter_parts_limit
from ..utils.storage_upload import upload_artifact
from .astrologyToBricks import astrology_allowed
from .imageToBricks import ImageToBricksResponse

DESIGN_FILE = "fable-design.json"
# A build that failed its checks is kept in the slot Nova's rejected drafts use, so the same
# download serves both.
DRAFT_ARCHIVE = "nova-draft.zip"
DRAFT_FILES = ("model.ldr", "parts.csv", "verification.json", "README.txt")
MAX_DRAFT_FILE_BYTES = 16 * 1024 * 1024
MAX_PARTS = 5000
DEFAULT_PARTS = 1000
# Builds are long and each holds a worker thread, so they get their own small pool: a rush of
# Fable requests waits its turn instead of starving the rest of the API, and is refused past that.
MAX_BUILDS = max(1, int(os.getenv("FABLE_MAX_CONCURRENT_BUILDS", "3")))
MAX_WAITING = 2 * MAX_BUILDS
BUILD_SECONDS = 30 * 60  # no new model call starts after this; the best clean revision is delivered
HARD_STOP_SECONDS = BUILD_SECONDS + 15 * 60  # a build still running then is abandoned
logger = logging.getLogger(__name__)
_builds = ThreadPoolExecutor(max_workers=MAX_BUILDS, thread_name_prefix="fable-build")
_in_flight = 0
# What the customer is shown while the agent uses each of its tools.
PROGRESS = {
    "search_parts": "Choosing parts", "inspect_part": "Choosing parts", "view_parts": "Choosing parts",
    "look_up": "Choosing parts", "write_script": "Building the model", "build": "Building the model",
    "edit_script": "Improving the model", "patch": "Improving the model",
    "render": "Reviewing the rendered model", "finish": "Saving your model and building instructions",
}


class BuildCancelled(Exception):
    """The generation was cancelled; stop the agent at its next step."""


class BuildTimedOut(Exception):
    """The build ran far past its time limit; stop the agent at its next step."""


class RejectedDraft(ValueError):
    """No revision passed the checks. The last build stays downloadable, as Nova's rejected drafts do."""

    def __init__(self, archive: bytes):
        super().__init__("Fable could not finish a model that passes its checks. "
                         "Download the unverified draft and its failed checks.")
        self.archive = archive


def _draft_archive(folder: Path) -> bytes:
    """The rejected build, its parts list and its failed checks as one bounded zip."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in DRAFT_FILES:
            source = folder / name
            if source.is_file() and not source.is_symlink() and source.stat().st_size <= MAX_DRAFT_FILE_BYTES:
                archive.write(source, name)
    return buffer.getvalue()


@dataclass(frozen=True)
class Design:
    """What a later revision needs from an earlier build: its script and what was asked for."""

    script: str
    requests: tuple[str, ...]
    model: str | None = None  # the model that built it, for an agent that offers a choice


@dataclass(frozen=True)
class Built:
    ldraw: str
    script: str
    preview: bytes | None


# Fable is offered to the accounts that may use Astrology: one allowlist for the experimental agents.
fable_allowed = astrology_allowed


async def _import_geometry(source: dict, auth_info: dict) -> Design:
    """A completed Nova build or upload can be edited from its public geometry."""
    if source.get("status") != "completed":
        require_generation_access(source, auth_info)
        raise HTTPException(409, "Pip needs a completed model. Start a new build to use Pip.")
    if source.get("endpoint") not in {*ALL_PARTS_AGENT_ENDPOINTS, "uploadLdraw", "glbToBricks", "objToBricks"}:
        raise HTTPException(409, "Keep the original build mode when editing this model.")
    if not source.get("ldr_url"):
        raise HTTPException(409, "This model has no saved geometry to edit.")
    content = await generation_storage.download_file_from_storage(source["ldr_url"])
    try:
        script = await asyncio.to_thread(source_script, content, MAX_PARTS)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    return Design(script, ())


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
        model = saved.get("model")
        return Design(script, tuple(requests[-8:]), model if isinstance(model, str) else None)
    except (OSError, ValueError, KeyError, TypeError, StorageApiError, httpx.HTTPError):
        raise HTTPException(409, "The saved Fable design is unavailable.") from None


def _run(prompt: str, variant: FableVariant, max_parts: int, reference: bytes | None, script: str | None,
         key: str, on_event, examples: bool = False, example_query: str | None = None,
         inventory: PartsInventory | None = None) -> Built:
    """Run one build to the end in a scratch directory. Blocking: call it from a worker thread.

    ``example_query`` is what examples are searched for: the customer's own request, without the
    design guidance the app adds to ``prompt``.
    """
    with tempfile.TemporaryDirectory(prefix="fable-generation-") as scratch:
        root = Path(scratch)
        picture = None
        if reference:
            picture = root / "reference-upload"
            picture.write_bytes(reference)
        inventory_csv = None
        if inventory is not None:
            inventory_csv = inventory.catalog().to_palette_csv()
            # Keep the brief bounded on large sets. Every row is also accessible through lookup.
            rows = [f"{p.part_id} {p.color_id} {p.quantity}" for p in inventory.parts[:150]]
            prompt += ("\n\nBuild only with the supplied parts. You may use fewer pieces. "
                       "Each row gives part ID, LDraw color and available quantity. "
                       "Use look_up for additional parts and exact quantities.\n" + "\n".join(rows))
        options = Options(inventory_csv=inventory_csv, model=variant.model, method=variant.method, effort=variant.effort,
                          max_parts=max_parts, api_key=key, max_seconds=BUILD_SECONDS,
                          examples=examples and variant.method in EXAMPLE_METHODS, example_query=example_query)
        result = start_build(prompt, root / "session", options, reference=picture, on_event=on_event,
                             script=script)
        if result.published is None:
            if result.status == "refused":
                raise ValueError("Fable could not build this request.")
            if result.rejected:
                raise RejectedDraft(_draft_archive(root / "session" / result.rejected))
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


async def _build(generation_id, request, agent_id, variant, design, reference, key, _on_thinking=None, *,
                 on_progress):
    async def heartbeat():
        while True:
            await asyncio.sleep(5)
            try:
                await generation_storage.heartbeat(generation_id)
            except Exception:
                logger.warning("Fable heartbeat failed for %s", generation_id, exc_info=True)

    global _in_flight
    loop = asyncio.get_running_loop()
    ledger = current_generation_usage.get()
    cancelled = threading.Event()
    clock = {"hard_stop": float("inf")}  # set when the build leaves the queue and starts
    calls: list[dict] = []
    shown: list[str] = []

    def on_event(kind: str, data: dict) -> None:
        """Called on the agent's worker thread for every step it takes."""
        if cancelled.is_set():
            raise BuildCancelled
        if time.monotonic() >= clock["hard_stop"]:
            raise BuildTimedOut
        if kind == "turn":
            calls.append(data["usage"])
            if ledger is not None:
                ledger.replace_source(f"fable-{generation_id}", calls)
        elif kind == "tool_call":
            text = PROGRESS.get(data.get("name"))
            if text and shown[-1:] != [text]:
                shown.append(text)
                asyncio.run_coroutine_threadsafe(on_progress(text), loop)

    def work() -> Built:
        """Runs on a build thread once one is free; time spent waiting for it does not count."""
        clock["hard_stop"] = time.monotonic() + HARD_STOP_SECONDS
        return _run(_change_request(guided_build_prompt(prompt), design), variant, request.max_parts, reference,
                    design.script if design else None, key, on_event, request.use_examples,
                    request.prompt or "", request.parts_inventory)

    pulse = asyncio.create_task(heartbeat())
    prompt = request.prompt or "Build the subject in the photo."
    _in_flight += 1
    try:
        await generation_storage.update_status(generation_id, "processing")
        await on_progress("Designing your model")
        built = await loop.run_in_executor(_builds, work)
        await on_progress("Saving your model and building instructions")
        bucket = generation_storage.client.storage.from_("generation-output")
        saved = {"agent": agent_id, "model": variant.model, "script": built.script,
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
        if isinstance(exc, RejectedDraft):
            try:
                await upload_artifact(generation_storage.client.storage.from_("generation-output"),
                                      path=f"{generation_id}/{DRAFT_ARCHIVE}", file=exc.archive,
                                      content_type="application/zip")
            except Exception:  # the draft is a courtesy: without it the build simply failed
                logger.warning("Fable draft upload failed for %s", generation_id, exc_info=True)
                exc = ValueError("Fable could not finish a model that passes its checks. Try a simpler request.")
        message = (str(exc) if isinstance(exc, ValueError)
                   else "Fable ran out of time on this build. Try a simpler request."
                   if isinstance(exc, BuildTimedOut) else "Fable could not complete this build.")
        await generation_storage.update_status(generation_id, "failed", message)
        return message
    finally:
        _in_flight -= 1
        pulse.cancel()
        await asyncio.gather(pulse, return_exceptions=True)


def _ready() -> bool:
    """The parts library and renderer are installed, and build scripts can be run safely.

    A build script is code the model wrote. On a shared service it must run under its own
    unprivileged account, away from the API's secrets; anything less is refused. Only an offline
    local checkout, where the developer is the only user, may run scripts as the caller.
    """
    try:
        isolated = script_account().separate or auth.LOCAL_DB_ENABLED
        return isolated and bool(find_leocad()) and (default_library_dir() / "LDConfig.ldr").is_file()
    except (OSError, SandboxError):
        return False


async def fable_to_bricks(request, auth_info, source=None):
    source_agent = source.get("model_used_3d") if source else None
    agent_id = source_agent if source_agent in FABLE_AGENTS else request.building_agent
    # A change is built with the model that built the original, so only a new build's choice is checked here.
    if not fable_allowed(auth_info) and not open_to_everyone(agent_id, None if source else request.agent_model):
        raise HTTPException(403, "Fable is unavailable for this account.")
    variant = FABLE_AGENTS.get(agent_id)
    if variant is None:
        raise HTTPException(422, "Unknown building agent.")
    auth.require_generation_account(auth_info)
    if request.auth_mode != "api_key" or request.billing_source == "personal":
        raise HTTPException(422, "Fable uses BrickBuilder credits and its configured AI connections.")
    if request.parts_inventory is not None and agent_id != PIP_AGENT:
        raise HTTPException(422, "Choose Pip to build from a parts inventory with this method.")
    if generation_storage is None or not _ready():
        raise HTTPException(503, "Fable is temporarily unavailable.")
    if _in_flight >= MAX_BUILDS + MAX_WAITING:
        raise HTTPException(503, "Fable is busy right now. Try again in a few minutes.")
    design = None
    if source:
        if source_agent in FABLE_AGENTS:
            design = await _source_design(source, auth_info)
            owned = True
        elif agent_id == PIP_AGENT:
            design = await _import_geometry(source, auth_info)
            try:
                require_generation_access(source, auth_info)
                owned = True
            except HTTPException:
                owned = False
        else:
            raise HTTPException(409, "Choose Pip to edit this model.")
        if owned and source.get("has_parts_inventory"):
            request.parts_inventory = await load_inventory(
                generation_storage, source.get("restored_from_id") or request.generation_id)
    # A change is built with the model that built the original; a new build with the one chosen.
    try:
        variant = variant.using(design.model if source_agent in FABLE_AGENTS else request.agent_model)
    except ValueError:
        if source_agent not in FABLE_AGENTS:
            raise HTTPException(422, "This building agent does not offer that model.") from None
        # The saved model is no longer offered: change it with the agent's default model.
    key = os.getenv(variant.key_env)
    if not key:
        raise HTTPException(503, "Fable is temporarily unavailable.")
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
    endpoint = PIP_ENDPOINT if agent_id in PIP_AGENTS else "novaToBricks"
    handle_auth_and_tracking(auth_info, f"/{endpoint}", {
        "building_agent": agent_id, "agent_model": variant.model, "has_image": bool(reference),
        "use_examples": request.use_examples and variant.method in EXAMPLE_METHODS,
        "is_edit": bool(source)})
    job_id = await generation_storage.create_generation(
        user_id=auth_info["user_id"], user_type="anonymous" if auth_info.get("is_anonymous") else "authenticated",
        guest_ip_hash=auth_info.get("rate_limit_id"), prompt=request.prompt or "Image reference",
        detail_level=request.detail_level, endpoint=endpoint, model_3d=agent_id,
        max_parts=request.max_parts, input_type=(source or {}).get("input_type") or ("image" if reference else "text"),
        input_format=(source or {}).get("input_format"),
        entry_page=request.entry_page, edit_generation_id=request.generation_id)
    await save_inventory(generation_storage, job_id, request.parts_inventory)
    start_generation_task(job_id, run_with_output(job_id, _build, request, agent_id, variant, design, reference,
                                                  key, native_progress=True))
    return ImageToBricksResponse(generation_id=job_id, message="Fable generation started.")

