import asyncio
import base64
import json
import logging
import math
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

import httpx
from fastapi import Depends, HTTPException
from pydantic import BaseModel, field_validator, model_validator

from ..utils.auth import deduct_credits, get_user_with_optional_auth, handle_auth_and_tracking
from ..utils.brick_design import (
    BuildResult,
    DesignError,
    audit_ldraw,
    build_design,
    load_palette,
    palette_prompt_text,
    render_preview_png,
)
from ..utils.generation_storage import generation_storage
from ..utils.conversions.glb2brick import glb2brick
from ..utils.llm_output import run_with_output
from ..utils.llm_tool_conversation import (
    ConversationSettings,
    ToolConversation,
    ToolResult,
    ToolSpec,
    Turn,
    UserInput,
    create_conversation,
)
from ..utils.pack_ldraw_model import LDrawPacker
from ..utils.posthog_client import track_error, track_image_conversion
from .imageToBricks import ImageToBricksResponse

logger = logging.getLogger(__name__)

ThinkingCallback = Callable[[str], Awaitable[None]]

# Keep jobs alive independently of the HTTP request that started them.
_background_tasks: set[asyncio.Task] = set()


@dataclass(frozen=True)
class LlmModel:
    id: str
    label: str
    provider: str  # "anthropic" or "openai"


# Allow-list of models users can pick. Keep in sync with LLM_MODEL_OPTIONS in
# frontend/src/services/llmToBricksApi.ts.
SUPPORTED_MODELS: Dict[str, LlmModel] = {m.id: m for m in (
    LlmModel("claude-opus-5-5", "Claude Opus 5.5", "anthropic"),
    LlmModel("claude-opus-5", "Claude Opus 5", "anthropic"),
    LlmModel("claude-sonnet-5", "Claude Sonnet 5", "anthropic"),
    LlmModel("claude-fable-5", "Claude Fable 5", "anthropic"),
    LlmModel("gpt-5.6-sol", "GPT-5.6 Sol", "openai"),
    LlmModel("gpt-5.6-terra", "GPT-5.6 Terra", "openai"),
    LlmModel("gpt-5.5", "GPT-5.5", "openai"),
)}
FALLBACK_MODEL = "claude-opus-5-5"
DEFAULT_MODEL = os.getenv("LLM_TO_BRICKS_MODEL", FALLBACK_MODEL)
if DEFAULT_MODEL not in SUPPORTED_MODELS:
    logger.warning("LLM_TO_BRICKS_MODEL=%r is not supported; using %s", DEFAULT_MODEL, FALLBACK_MODEL)
    DEFAULT_MODEL = FALLBACK_MODEL
MAX_OUTPUT_TOKENS = int(os.getenv("LLM_TO_BRICKS_MAX_TOKENS", "65536"))
TIMEOUT_SECONDS = float(os.getenv("LLM_TO_BRICKS_TIMEOUT_SECONDS", "600"))
OPENAI_REASONING_EFFORT = os.getenv("LLM_TO_BRICKS_OPENAI_REASONING_EFFORT", "medium")

# "design" (default): the model describes the build as colored voxel shapes on a stud grid and
# brick_design.py validates and previews the design in a build -> feedback -> review loop.
# The accepted solid voxels go through the same glb2brick/voxel2brick pipeline as image builds.
# "direct": the model writes raw LDraw (the original path), audited for overlaps/floating
# parts with a correction round.
LDR_MODE = os.getenv("LLM_TO_BRICKS_MODE", "design").strip().lower()
DESIGN_MAX_ATTEMPTS = max(1, int(os.getenv("LLM_TO_BRICKS_DESIGN_MAX_ATTEMPTS", "3")))
DESIGN_REVIEW_ROUNDS = max(0, int(os.getenv("LLM_TO_BRICKS_DESIGN_REVIEW_ROUNDS", "1")))
DIRECT_FIX_ROUNDS = max(0, int(os.getenv("LLM_TO_BRICKS_DIRECT_FIX_ROUNDS", "1")))

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_LDR_BYTES = 750_000
MAX_LDR_PARTS = 5_000
SUPPORTED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
PART_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+\.dat$", re.IGNORECASE)


class LlmToBricksRequest(BaseModel):
    prompt: Optional[str] = None
    image_base64: Optional[str] = None
    image_media_type: str = "image/png"
    detail_level: float = 40.0
    model: str = DEFAULT_MODEL

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        value = value.strip()
        if value not in SUPPORTED_MODELS:
            raise ValueError(f"model must be one of: {', '.join(SUPPORTED_MODELS)}")
        return value

    @field_validator("prompt")
    @classmethod
    def normalize_prompt(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if len(value) > 2_000:
            raise ValueError("Prompt must be 2000 characters or less")
        return value or None

    @field_validator("image_media_type")
    @classmethod
    def validate_image_media_type(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized == "image/jpg":
            normalized = "image/jpeg"
        if normalized not in SUPPORTED_IMAGE_TYPES:
            raise ValueError("image_media_type must be JPEG, PNG, GIF, or WebP")
        return normalized

    @field_validator("image_base64")
    @classmethod
    def validate_image_base64(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if value.startswith("data:"):
            _, separator, value = value.partition(",")
            if not separator:
                raise ValueError("Invalid image data URL")
        try:
            decoded = base64.b64decode(value, validate=True)
        except Exception as exc:
            raise ValueError("Invalid base64 image data") from exc
        if not decoded:
            raise ValueError("Image cannot be empty")
        if len(decoded) > MAX_IMAGE_BYTES:
            raise ValueError("Image must be 10 MB or smaller")
        return value

    @field_validator("detail_level")
    @classmethod
    def validate_detail_level(cls, value: float) -> float:
        if not math.isfinite(value) or value <= 0:
            raise ValueError("detail_level must be a positive number")
        return value

    @model_validator(mode="after")
    def require_prompt_or_image(self) -> "LlmToBricksRequest":
        if not self.prompt and not self.image_base64:
            raise ValueError("Provide a text prompt, an image, or both")
        return self


DEFAULT_IMAGE_PROMPT = "Recreate the main subject in the reference image as a recognizable brick model."


def _user_input(request: LlmToBricksRequest) -> UserInput:
    return UserInput(
        text=request.prompt or DEFAULT_IMAGE_PROMPT,
        image_base64=request.image_base64,
        image_media_type=request.image_media_type,
    )


def _open_conversation(
    request: LlmToBricksRequest,
    client: httpx.AsyncClient,
    system: str,
    tools: List[ToolSpec],
) -> ToolConversation:
    """Start a tool conversation with the request's model on its provider's API."""
    settings = ConversationSettings(
        model=request.model,
        system=system,
        tools=tools,
        max_tokens=MAX_OUTPUT_TOKENS,
        reasoning_effort=OPENAI_REASONING_EFFORT,
    )
    provider = SUPPORTED_MODELS[request.model].provider
    return create_conversation(provider, client, settings, _user_input(request))


DIRECT_SYSTEM_PROMPT = """You are an expert LEGO-compatible model designer using the LDraw file format.
Create a complete, physically connected, stable model from the user's text and/or image. Return only
official LDraw part references through the submit_ldr_model tool. Use common, currently available parts,
standard integer LDraw color codes, valid type-1 transformation matrices, and useful 0 STEP boundaries.
Orient the finished model upright with its lowest bricks at y=0. Prefer a practical 150-500 piece model;
use fewer pieces for a simple subject and never exceed 5,000 pieces. Before each submit_ldr_model call,
briefly explain the design direction in 1-3 concise sentences. Do not use MPD submodels, embedded
files, custom geometry, stickers, base64, Markdown fences, or explanatory prose inside ldr_content."""

DIRECT_TOOLS = [
    ToolSpec(
        name="submit_ldr_model",
        description="Submit the finished model as a single valid LDraw .ldr file.",
        schema={
            "type": "object",
            "properties": {
                "title": {"type": "string", "maxLength": 120},
                "ldr_content": {
                    "type": "string",
                    "description": "Complete plain-text LDraw model content.",
                },
            },
            "required": ["ldr_content"],
            "additionalProperties": False,
        },
    )
]


def _extract_ldr_content(turn: Turn) -> str:
    if turn.truncated:
        raise ValueError("The model's LDraw response was truncated; try a simpler model")
    for call in turn.tool_calls:
        ldr_content = call.input.get("ldr_content") if call.name == "submit_ldr_model" else None
        if isinstance(ldr_content, str):
            return ldr_content

    # Tool choice must remain automatic (Opus 5.5 rejects forced tool use), so tolerate a
    # plain-text final answer and pass it through the same strict LDraw validator.
    if turn.text:
        try:
            decoded = json.loads(turn.text)
        except json.JSONDecodeError:
            return turn.text
        if isinstance(decoded, dict) and isinstance(decoded.get("ldr_content"), str):
            return decoded["ldr_content"]
    raise ValueError("The model did not return an LDraw model")


def validate_ldr_content(raw_content: str) -> str:
    content = raw_content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:ldr|ldraw)?\s*", "", content, flags=re.IGNORECASE)
        content = re.sub(r"\s*```$", "", content)
    if not content or len(content.encode("utf-8")) > MAX_LDR_BYTES:
        raise ValueError("The model returned an empty or oversized LDraw model")

    normalized_lines = []
    part_count = 0
    saw_file_header = False
    for line_number, raw_line in enumerate(content.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        tokens = line.split()
        if tokens[0] == "0":
            if len(tokens) > 1 and tokens[1].upper() == "FILE":
                is_standalone_header = (
                    not normalized_lines
                    and not saw_file_header
                    and len(tokens) == 3
                    and tokens[2].lower().endswith(".ldr")
                )
                if is_standalone_header:
                    saw_file_header = True
                    continue
                raise ValueError("MPD and embedded FILE sections are not supported")
            if len(tokens) > 1 and tokens[1].upper() == "NOFILE":
                raise ValueError("MPD and embedded FILE sections are not supported")
            normalized_lines.append(line)
            continue
        if tokens[0] != "1" or len(tokens) != 15:
            raise ValueError(f"Invalid LDraw command on line {line_number}")
        try:
            color = int(tokens[1])
            numeric_values = [float(token) for token in tokens[2:14]]
        except ValueError as exc:
            raise ValueError(f"Invalid LDraw values on line {line_number}") from exc
        if color < 0 or color > 511 or not all(math.isfinite(value) for value in numeric_values):
            raise ValueError(f"Invalid LDraw values on line {line_number}")
        if not PART_NAME_RE.fullmatch(tokens[14]):
            raise ValueError(f"Unsafe or unsupported LDraw part name on line {line_number}")
        part_count += 1
        if part_count > MAX_LDR_PARTS:
            raise ValueError(f"LDraw model exceeds the {MAX_LDR_PARTS:,}-piece limit")
        normalized_lines.append(" ".join(tokens))

    if part_count == 0:
        raise ValueError("The model returned an LDraw model with no parts")

    if not any(line.lower().startswith("0 name:") for line in normalized_lines):
        normalized_lines.insert(0, "0 Name: llm-model.ldr")
    if not any(line.lower().startswith("0 author:") for line in normalized_lines):
        normalized_lines.insert(1, "0 Author: BrickBuilder AI")
    return "\n".join(normalized_lines) + "\n"


DESIGN_SYSTEM_PROMPT = """You are an expert LEGO-compatible model designer. Design a model from the user's text
and/or reference image and submit it with the submit_brick_design tool. You do NOT write LDraw: you describe
the model as colored voxels on a stud grid, and a deterministic builder turns every voxel into real bricks,
checks that everything connects, and sends you back a report and preview renders.

GRID AND COORDINATES
- One voxel = 1 x 1 stud footprint and one layer tall. x runs left -> right (0..width-1), z runs front -> back
  (0..depth-1; z = 0 is the side facing the viewer), y is the layer number from the ground (0..layers-1).
- layer_unit "brick" (default): a layer is one brick tall = 1.2 studs. A shape that should look round and 10
  studs tall needs about 8 layers. Good for most models.
- Use layer_unit "brick": the final voxel-to-brick converter uses brick-height voxels.
- Size: {size_hint} Hard limits: 64 x 64 studs, 96 brick layers, 5,000 pieces.

SHAPES (applied in order; later shapes override earlier ones)
- {{"shape":"box","x":[x0,x1],"y":[y0,y1],"z":[z0,z1],"color":C}}  (inclusive integer ranges)
- {{"shape":"ellipsoid","center":[x,y,z],"radius":[rx,ry,rz],"color":C}}  (y and ry in layers; cells whose
  center is inside are filled)
- {{"shape":"cylinder","axis":"x"|"y"|"z","center":[a,b],"radius":[ra,rb] or r,"range":[lo,hi],"color":C}}
  (center/radius are the two coordinates other than the axis, in x,y,z order: axis "y" -> [x,z])
- {{"shape":"layer","y":Y or [y0,y1],"rows":["....AAAA....", ...],"legend":{{"A":C}}}}  a pixel map of one
  layer (or repeated over a range): rows[z] is a row from front (z=0) to back, character index = x,
  "." = leave unchanged. Best for detailed patterns, lettering, mosaics and irregular outlines.
- every shape takes "mode": "fill" (default, adds voxels), "paint" (recolors only voxels that already
  exist: use it for faces, stripes, windows and details on a surface) or "carve" (removes voxels; no color).

COLORS: use only these LDraw color codes (code name): {palette}

BUILD RULES (the builder enforces them; follow them to avoid rework)
- Everything must connect to layer 0 through touching voxels. Nothing may float.
- Bricks only hold together by overlapping the layer above or below, and one brick is one color. So a
  one-stud-wide feature of a different color stacked straight up against the side of the model (an ear,
  a trim line, the edge of hair) cannot attach. Make such details at least 2 studs deep, match the color
  of the cells they sit against, or support them from below.
- Overhangs: each layer should step out at most 1-2 studs beyond the layer below it.
- Solid volumes are hollowed automatically (hollow: true); keep walls you design at least 2 studs thick.
- If the model needs a base, include it as box shapes in layer 0 and put the model above it.
  The base must be part of the voxel design so it survives final conversion.

WORKFLOW: think about proportions and the recognizable features first, then submit one complete design.
After each build you get a report and two isometric renders (front-left and back-right). Fix any errors you
are told about. When you review a successful build, compare it to the request/reference; if it looks
right call accept_design, otherwise submit an improved design."""

DESIGN_SYSTEM_PROMPT += """

Before each submit_brick_design call, briefly explain in 1-3 concise sentences what you are changing and
why so the user can follow along while the model is being designed."""

DESIGN_TOOLS = [
    ToolSpec(
        name="submit_brick_design",
        description="Submit a complete voxel design for the builder to turn into bricks.",
        schema={
            "type": "object",
            "properties": {
                "title": {"type": "string", "maxLength": 120},
                "layer_unit": {"type": "string", "enum": ["brick"]},
                "grid": {
                    "type": "object",
                    "properties": {
                        "width": {"type": "integer", "minimum": 1, "maximum": 64},
                        "depth": {"type": "integer", "minimum": 1, "maximum": 64},
                        "layers": {"type": "integer", "minimum": 1, "maximum": 96},
                    },
                    "required": ["width", "depth", "layers"],
                },
                "hollow": {"type": "boolean"},
                "shapes": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Ordered shape operations (box, ellipsoid, cylinder, layer).",
                },
            },
            "required": ["grid", "shapes"],
        },
    ),
    ToolSpec(
        name="accept_design",
        description="Accept the most recent successful build as the final model.",
        schema={"type": "object", "properties": {}},
    ),
]


def _design_size_hint(detail_level: float) -> str:
    target = int(min(64, max(12, round(detail_level))))
    return (f"aim for about {target} studs across the largest horizontal dimension unless the subject "
            "clearly needs a different size.")


def _design_system_prompt(request: LlmToBricksRequest) -> str:
    return DESIGN_SYSTEM_PROMPT.format(
        size_hint=_design_size_hint(request.detail_level),
        palette=palette_prompt_text(),
    )


@dataclass(frozen=True)
class LlmBuild:
    ldr: str
    voxels_xyzrgb: Optional[str] = None  # set in design mode: the model's voxels for editing/resizing
    problematic_xyzrgb: Optional[str] = None


def _convert_design_voxels(xyzrgb: str) -> LlmBuild:
    """Build the final bricks with the image pipeline, without re-voxelizing a mesh."""
    if not xyzrgb.strip():
        raise ValueError("The model did not produce any voxels")
    with tempfile.TemporaryDirectory(prefix="llm-voxels-") as temp_dir:
        # The converter also uses the stem for diagnostics in tmp; keep it unique per job.
        stem = Path(temp_dir) / Path(temp_dir).name
        xyzrgb_path = stem.with_suffix(".xyzrgb")
        xyzrgb_path.write_text(xyzrgb, encoding="utf-8")
        info = glb2brick(
            glb_path=str(stem.with_suffix(".glb")),
            xyzrgb_path=str(xyzrgb_path),
            auto_adjust_brick_count=False,
        )
        problematic_path = info.get("problematic_xyzrgb_file")
        try:
            ldr = validate_ldr_content(Path(info["ldr_file"]).read_text(encoding="utf-8"))
            problematic = Path(problematic_path).read_text(encoding="utf-8") if problematic_path else None
            return LlmBuild(ldr=ldr, voxels_xyzrgb=xyzrgb, problematic_xyzrgb=problematic)
        finally:
            if problematic_path:
                Path(problematic_path).unlink(missing_ok=True)


def voxel_extent(xyzrgb: str) -> int:
    """Longest axis of xyzrgb voxels in cells: the unit /resizeModel's detail_level uses."""
    coords = [tuple(map(int, line.split()[:3])) for line in xyzrgb.splitlines() if line.strip()]
    return max(max(axis) - min(axis) + 1 for axis in zip(*coords)) if coords else 0


async def _generate_ldr_with_design(
    request: LlmToBricksRequest,
    on_thinking: Optional[ThinkingCallback] = None,
) -> BuildResult:
    """The model designs voxels; brick_design builds, verifies and renders; the model fixes and reviews."""
    palette = load_palette()
    loop = asyncio.get_running_loop()
    best = None
    failures = 0
    reviews = 0

    def build(design: Dict[str, Any], repair: bool):
        return build_design(design, max_pieces=MAX_LDR_PARTS, repair=repair, palette=palette)

    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        conversation = _open_conversation(request, client, _design_system_prompt(request), DESIGN_TOOLS)
        for _ in range(DESIGN_MAX_ATTEMPTS + DESIGN_REVIEW_ROUNDS + 2):
            turn = await conversation.send_stream(on_thinking) if on_thinking else await conversation.send()
            if turn.truncated:
                if best:
                    break
                raise ValueError("The model's design was truncated; try a simpler model")
            calls = turn.tool_calls
            submits = [c for c in calls if c.name == "submit_brick_design"]

            if not calls:
                if best:
                    break  # answered in text after a successful build: keep that build
                failures += 1
                if failures >= DESIGN_MAX_ATTEMPTS:
                    break
                conversation.add_user_text("Please submit the model with the submit_brick_design tool.")
                continue
            if best and not submits and any(c.name == "accept_design" for c in calls):
                break  # the model accepted the reviewed build

            results: List[ToolResult] = []
            done = False
            for call in calls:
                if call is not (submits[0] if submits else None):
                    message = ("No successful build to accept yet." if call.name == "accept_design"
                               else "Submit exactly one submit_brick_design call per turn.")
                    results.append(ToolResult(call.id, message, is_error=True))
                    continue
                try:
                    result = await loop.run_in_executor(None, build, call.input, False)
                except DesignError as exc:
                    failures += 1
                    if failures < DESIGN_MAX_ATTEMPTS:
                        results.append(ToolResult(call.id, f"Build failed: {exc}", is_error=True))
                        continue
                    if best:  # a revision failed on the last try: keep the earlier good build
                        done = True
                        break
                    # Out of retries: repair what can't connect rather than failing the generation.
                    try:
                        result = await loop.run_in_executor(None, build, call.input, True)
                    except DesignError as final_exc:
                        if best:
                            done = True
                            break
                        raise ValueError(f"The brick design could not be built: {final_exc}") from final_exc
                best = result
                if reviews >= DESIGN_REVIEW_ROUNDS or failures >= DESIGN_MAX_ATTEMPTS:
                    done = True
                    break
                reviews += 1
                preview = await loop.run_in_executor(None, render_preview_png, result.grid, result.unit, palette)
                results.append(ToolResult(
                    call.id,
                    result.summary(palette) + "\n\nReview the renders against the request (and reference"
                    " image, if any). Call accept_design if it is right, or submit_brick_design with a"
                    " corrected complete design.",
                    image_png=preview,
                ))
            if done:
                break
            conversation.add_tool_results(results)

    if not best:
        raise ValueError("The model did not produce a buildable brick design")
    return best


async def _generate_ldr_direct(
    request: LlmToBricksRequest,
    on_thinking: Optional[ThinkingCallback] = None,
) -> str:
    """Original mode: the model writes LDraw; basic bricks/plates are audited for overlaps, off-grid
    and floating parts, and the model gets DIRECT_FIX_ROUNDS chances to correct them."""
    best: Optional[str] = None
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        conversation = _open_conversation(request, client, DIRECT_SYSTEM_PROMPT, DIRECT_TOOLS)
        for round_number in range(DIRECT_FIX_ROUNDS + 1):
            turn = await conversation.send_stream(on_thinking) if on_thinking else await conversation.send()
            try:
                ldr = validate_ldr_content(_extract_ldr_content(turn))
            except ValueError as exc:
                if best:
                    break
                raise HTTPException(status_code=502, detail=str(exc)) from exc
            best = ldr
            audit = audit_ldraw(ldr)
            submits = [c for c in turn.tool_calls if c.name == "submit_ldr_model"]
            if audit.ok or round_number == DIRECT_FIX_ROUNDS or not submits:
                break
            feedback = (f"The model has placement problems: {audit.describe()}. Positions must be on the stud "
                        "grid (x/z centers at multiples of 10 LDU consistent with the part size; brick tops at "
                        "multiples of 8 LDU in y), parts may not overlap, and every part must rest on or hang "
                        "from another part. Submit the corrected complete model with submit_ldr_model.")
            conversation.add_tool_results([ToolResult(c.id, feedback, is_error=True) for c in turn.tool_calls])
    return best


async def _generate_ldr(
    request: LlmToBricksRequest,
    on_thinking: Optional[ThinkingCallback] = None,
) -> LlmBuild:
    if LDR_MODE == "direct":
        return LlmBuild(ldr=await _generate_ldr_direct(request, on_thinking))
    try:
        result = await _generate_ldr_with_design(request, on_thinking)
        return await asyncio.get_running_loop().run_in_executor(None, _convert_design_voxels, result.xyzrgb())
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


async def process_llm_to_bricks_task(
    generation_id: str,
    request: LlmToBricksRequest,
    user_info: Dict[str, Any],
    auth_info: Dict[str, Any],
    on_thinking: Optional[ThinkingCallback] = None,
) -> Optional[str]:
    heartbeat_task: Optional[asyncio.Task] = None

    async def heartbeat() -> None:
        while True:
            await asyncio.sleep(5)
            try:
                await generation_storage.update_status(generation_id, "processing")
            except Exception as exc:
                logger.warning("LLM generation heartbeat failed: %s", exc)

    try:
        await generation_storage.update_status(generation_id, "processing")
        heartbeat_task = asyncio.create_task(heartbeat())
        build = await _generate_ldr(request, on_thinking)
        ldr_content = build.ldr

        await deduct_credits(
            user_info=user_info,
            auth_info=auth_info,
            credits_to_deduct=1,
            operation_description=f"LLM LDraw generation ({request.model})",
        )

        with tempfile.TemporaryDirectory(prefix="llm-ldr-") as temp_dir:
            ldr_path = Path(temp_dir) / "model.ldr"
            ldr_path.write_text(ldr_content, encoding="utf-8")
            packer = LDrawPacker()
            mpd_path = await asyncio.get_running_loop().run_in_executor(
                None, packer.pack_ldraw_model, str(ldr_path)
            )
            mpd_content = Path(mpd_path).read_text(encoding="utf-8")

        if request.image_base64:
            image_data_url = (
                f"data:{request.image_media_type};base64,{request.image_base64}"
            )
            await generation_storage.store_images(
                generation_id=generation_id,
                original_image_url=image_data_url,
                processed_image_url=image_data_url,
            )

        await generation_storage.store_model_file(
            generation_id, ldr_content, "ldr", raise_on_error=True
        )
        await generation_storage.store_parts_list_csv(
            generation_id, ldr_content, raise_on_error=True
        )
        if build.voxels_xyzrgb:
            # xyzrgb feeds the block editor (and is replaced by its saves); design_voxels keeps
            # the original voxels as the source for /resizeModel.
            await generation_storage.store_model_file(
                generation_id, build.voxels_xyzrgb, "xyzrgb", raise_on_error=True
            )
            await generation_storage.store_model_file(
                generation_id, build.voxels_xyzrgb, "design_voxels", raise_on_error=True
            )
            await generation_storage.update_detail_level(generation_id, voxel_extent(build.voxels_xyzrgb))
        if build.problematic_xyzrgb:
            await generation_storage.store_model_file(
                generation_id, build.problematic_xyzrgb, "problematic_xyzrgb", raise_on_error=True
            )
        # The shared generations schema persists the LDR and parts list but
        # does not require an mpd_url column. The frontend follows the same
        # path as existing generations and converts the saved LDR through
        # /ldrToMpd when no MPD URL is present. Packing above still verifies
        # that the model's LDraw output can be expanded successfully.
        await generation_storage.update_status(generation_id, "completed")

        track_image_conversion(
            user_id=user_info["user_email"],
            success=True,
            has_mpd=True,
            ldr_size=len(ldr_content),
            mpd_size=len(mpd_content),
            image_type="llm_direct_ldr" if LDR_MODE == "direct" else "llm_brick_design",
            is_developer=user_info["is_developer"],
        )
        return None
    except Exception as exc:
        logger.exception("LLM-to-bricks generation failed for %s", generation_id)
        await generation_storage.update_status(generation_id, "failed", str(exc))
        track_error(
            error_type=type(exc).__name__,
            error_message=str(exc),
            endpoint="/llmToBricks",
            user_id=user_info.get("user_email", "anonymous"),
        )
        return str(exc)
    finally:
        if heartbeat_task:
            heartbeat_task.cancel()


async def llm_to_bricks(
    request: LlmToBricksRequest,
    auth_info: dict = Depends(get_user_with_optional_auth),
) -> ImageToBricksResponse:
    user_info = handle_auth_and_tracking(
        auth_info=auth_info,
        endpoint="/llmToBricks",
        track_properties={
            "has_image": bool(request.image_base64),
            "has_prompt": bool(request.prompt),
            "model": request.model,
            "provider": SUPPORTED_MODELS[request.model].provider,
        },
        required_credits=1,
    )

    if user_info["is_anonymous"]:
        user_id = auth_info["user_id"]
        user_type = "anonymous"
    elif user_info["is_developer"]:
        user_id = user_info["user_email"]
        user_type = "authenticated"
    else:
        user_id = auth_info.get("user_id", user_info["user_email"])
        user_type = "authenticated"

    try:
        generation_id = await generation_storage.create_generation(
            user_id=user_id,
            user_type=user_type,
            prompt=request.prompt or "Image reference",
            detail_level=request.detail_level,
            endpoint="llmToBricks",
            model_3d=request.model,
        )
        task = asyncio.create_task(
            run_with_output(generation_id, process_llm_to_bricks_task, request, user_info, auth_info)
        )
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
        return ImageToBricksResponse(
            generation_id=generation_id,
            message="LLM generation started. Poll /generation/{generation_id} for status.",
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to start LLM-to-bricks generation")
        track_error(
            error_type=type(exc).__name__,
            error_message=str(exc),
            endpoint="/llmToBricks",
            user_id=user_info.get("user_email", "anonymous"),
        )
        raise HTTPException(status_code=500, detail="Failed to start LLM generation") from exc


async def llm_to_bricks_stream(
    request: LlmToBricksRequest,
    auth_info: dict = Depends(get_user_with_optional_auth),
):
    user_info = handle_auth_and_tracking(
        auth_info=auth_info,
        endpoint="/llmToBricks",
        track_properties={
            "has_image": bool(request.image_base64),
            "has_prompt": bool(request.prompt),
            "model": request.model,
            "provider": SUPPORTED_MODELS[request.model].provider,
        },
        required_credits=1,
    )

    if user_info["is_anonymous"]:
        user_id = auth_info["user_id"]
        user_type = "anonymous"
    elif user_info["is_developer"]:
        user_id = user_info["user_email"]
        user_type = "authenticated"
    else:
        user_id = auth_info.get("user_id", user_info["user_email"])
        user_type = "authenticated"

    generation_id = await generation_storage.create_generation(
        user_id=user_id,
        user_type=user_type,
        prompt=request.prompt or "Image reference",
        detail_level=request.detail_level,
        endpoint="llmToBricks",
        model_3d=request.model,
    )

    async def event_stream():
        yield f'data: {json.dumps({"type": "started", "generation_id": generation_id})}\n\n'
        queue: asyncio.Queue[Optional[str]] = asyncio.Queue()

        async def on_thinking(delta: str) -> None:
            await queue.put(f'data: {json.dumps({"type": "thinking", "delta": delta})}\n\n')

        async def run_generation() -> None:
            error_message = await process_llm_to_bricks_task(
                generation_id,
                request,
                user_info,
                auth_info,
                on_thinking,
            )
            if error_message:
                await queue.put(f'data: {json.dumps({"type": "error", "detail": error_message})}\n\n')
            else:
                await queue.put(
                    f'data: {json.dumps({"type": "result", "data": {"generation_id": generation_id, "message": "LLM generation completed"}})}\n\n'
                )
            await queue.put(None)

        generation_task = asyncio.create_task(run_generation())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield event
        finally:
            await generation_task

    return event_stream()
