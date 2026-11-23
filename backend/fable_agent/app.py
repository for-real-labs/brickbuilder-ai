"""Composition root: wires the library, palette, checks, sandbox, renderer and model together."""

from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

from PIL import Image, ImageOps

from .agent import BuildAgent, Event, RunResult
from .catalog import PartFinder
from .checks import ModelChecker
from .ldraw import LDrawLibrary
from .palette import load_palette
from .prompts import build_request, system_prompt
from .provider import DEFAULT_MODEL, AnthropicClient, Budget, ModelClient
from .render import LeoCadRenderer, Renderer
from .runner import KitSettings, ScriptRunner, SubprocessScriptRunner
from .session import Session
from .shape import ShapeLibrary, default_cache_dir
from .tools import TOOL_DEFINITIONS, Toolbox

MAX_REFERENCE_BYTES = 40 * 1024 * 1024
REFERENCE_SIDE = 1568


@dataclass(frozen=True)
class Options:
    ldraw_dir: str | None = None
    catalog_path: str | None = None
    open_palette: bool = False
    model: str = DEFAULT_MODEL
    effort: str = "high"
    budget_usd: float = 8.0
    max_steps: int = 60
    max_parts: int = 1500
    api_key: str | None = None


@dataclass
class Workbench:
    """Everything one session needs, built once and shared by the tools."""

    library: LDrawLibrary
    shapes: ShapeLibrary
    finder: PartFinder
    checker: ModelChecker
    runner: ScriptRunner
    renderer: Renderer
    palette: object

    @classmethod
    def open(cls, settings: dict, *, runner: ScriptRunner | None = None,
             renderer: Renderer | None = None) -> Workbench:
        library = LDrawLibrary(settings.get("ldraw_dir"))
        cache = default_cache_dir()
        shapes = ShapeLibrary(library, cache)
        palette = load_palette(library, settings.get("catalog_path"), open_palette=bool(settings.get("open_palette")))
        kit_settings = KitSettings(str(library.root), settings.get("catalog_path"),
                                   bool(settings.get("open_palette")), str(cache))
        return cls(library, shapes, PartFinder(library, palette),
                   ModelChecker(library, shapes, palette, max_parts=int(settings.get("max_parts", 1500))),
                   runner or SubprocessScriptRunner(kit_settings),
                   renderer or LeoCadRenderer(library.root), palette)

    def toolbox(self, session: Session) -> Toolbox:
        return Toolbox(session, self.library, self.shapes, self.palette, self.finder, self.checker,
                       self.runner, self.renderer)


def save_reference(source: Path, session: Session) -> Path:
    """Store an upright, bounded JPEG copy of the customer's picture inside the session."""
    if not source.is_file() or source.stat().st_size > MAX_REFERENCE_BYTES:
        raise ValueError("The reference image is missing or larger than 40 MB")
    try:
        with Image.open(source) as opened:
            picture = ImageOps.exif_transpose(opened).convert("RGBA")
    except (OSError, ValueError, Image.DecompressionBombError):
        raise ValueError("The reference image could not be read") from None
    flat = Image.new("RGB", picture.size, "white")
    flat.paste(picture, mask=picture.getchannel("A"))
    flat.thumbnail((REFERENCE_SIDE, REFERENCE_SIDE))
    target = session.path("reference.jpg")
    flat.save(target, "JPEG", quality=88)  # re-encoding also drops EXIF such as GPS position
    return target


def _client(options: Options, model: str, effort: str) -> ModelClient:
    return AnthropicClient(options.api_key or os.environ.get("ANTHROPIC_API_KEY", ""), model=model, effort=effort)


def start_build(prompt: str, run_dir: Path | str, options: Options, *, reference: Path | None = None,
                on_event: Event | None = None, client: ModelClient | None = None,
                workbench: Workbench | None = None) -> RunResult:
    """Create a session in ``run_dir`` and build the request."""
    if not prompt.strip():
        raise ValueError("Describe what to build")
    settings = {"ldraw_dir": options.ldraw_dir, "catalog_path": options.catalog_path,
                "open_palette": options.open_palette, "max_parts": options.max_parts, "effort": options.effort}
    bench = workbench or Workbench.open(settings)
    settings["ldraw_dir"] = str(bench.library.root)
    client = client or _client(options, options.model, options.effort)
    session = Session.create(run_dir, system=system_prompt(bench.finder, bench.palette.name),
                             tools=TOOL_DEFINITIONS, model=client.model, settings=settings)
    content = []
    if reference is not None:
        content.append(session.image_block(save_reference(Path(reference), session)))
    content.append({"type": "text", "text": build_request(prompt, has_reference=reference is not None,
                                                          max_parts=options.max_parts)})
    agent = BuildAgent(session, client, bench.toolbox(session), Budget(Decimal(str(options.budget_usd)), client.model),
                       max_steps=options.max_steps, on_event=on_event)
    return agent.run(content)


def continue_build(request: str, run_dir: Path | str, options: Options, *, on_event: Event | None = None,
                   client: ModelClient | None = None, workbench: Workbench | None = None) -> RunResult:
    """Send a follow-up edit to an existing session, keeping its conversation and script."""
    if not request.strip():
        raise ValueError("Describe the change")
    session = Session.load(run_dir)
    settings = session.meta["settings"]
    bench = workbench or Workbench.open(settings)
    # Earlier reasoning can only be continued by the model that produced it.
    client = client or _client(options, session.meta["model"], settings.get("effort", options.effort))
    agent = BuildAgent(session, client, bench.toolbox(session), Budget(Decimal(str(options.budget_usd)), client.model),
                       max_steps=options.max_steps, on_event=on_event)
    return agent.run([{"type": "text", "text": f"Change request: {request.strip()}\n\nUpdate the existing "
                                               "build script, check and render the result, then finish again."}])
