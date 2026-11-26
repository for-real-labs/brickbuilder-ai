"""Composition root: wires the library, palette, checks, sandbox, renderer and model together."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, replace
from decimal import Decimal
from pathlib import Path

from PIL import Image, ImageOps

from .agent import BuildAgent, Event, RunResult
from .assembly import AssemblyReview
from .catalog import PartFinder
from .examples import prompt_section as example_section
from .examples.chooser import choose_category
from .checks import ModelChecker
from .ldraw import LDrawLibrary
from .lean import LEAN_TOOLS, LeanAgent
from .palette import load_palette
from .prompts import (build_request, lean_system_prompt, lean_v2_system_prompt, system_prompt,
                      thorough_v2_system_prompt)
from .openai_provider import OpenAIClient, is_openai_model
from .provider import DEFAULT_MODEL, AnthropicClient, Budget, ModelClient
from .render import LeoCadRenderer, Renderer
from .repair import BuildRepairer
from .runner import KitSettings, ScriptRunner, SubprocessScriptRunner
from .session import Session
from .shape import ShapeLibrary, default_cache_dir
from .tools import THOROUGH_V2_TOOLS, TOOL_DEFINITIONS, Toolbox

MAX_REFERENCE_BYTES = 40 * 1024 * 1024
REFERENCE_SIDE = 1568


# Ways to run a build. "thorough" is one growing conversation with free use of every tool, and
# "lean" is a few short, stateless rounds (see ``lean``). Each has its own sensible limits.
#
# The "-v2" methods are separate so that the first versions keep behaving exactly as they did.
# Both add ready-made trees and automatic repair (``ASSISTED``). "thorough-v2" also puts part
# measurements in the prompt and batches look-ups and edits, so it takes fewer turns.
METHODS = {
    "thorough": {"effort": "high", "budget_usd": 8.0, "max_steps": 60},
    "thorough-v2": {"effort": "high", "budget_usd": 8.0, "max_steps": 60},
    "lean": {"effort": "medium", "budget_usd": 2.0, "max_steps": 8},
    "lean-v2": {"effort": "medium", "budget_usd": 2.0, "max_steps": 8},
}
LEAN = frozenset({"lean", "lean-v2"})
ASSISTED = frozenset({"thorough-v2", "lean-v2"})


@dataclass(frozen=True)
class Options:
    """Settings for one run. Effort, budget and step limit default to the method's own values."""

    ldraw_dir: str | None = None
    catalog_path: str | None = None
    open_palette: bool = False
    model: str = DEFAULT_MODEL
    effort: str | None = None
    budget_usd: float | None = None
    max_steps: int | None = None
    max_parts: int = 1500
    api_key: str | None = None
    method: str = "thorough"
    max_seconds: float | None = None  # stop starting model calls after this long; the best result is kept
    examples: bool = False  # let the model pick a category of example scripts to read first (v2 methods)

    def resolved(self, method: str) -> Options:
        if method not in METHODS:
            raise ValueError(f"Unknown method {method!r}; choose from {', '.join(METHODS)}")
        defaults = METHODS[method]
        return replace(self, method=method, **{key: value for key, value in defaults.items()
                                                 if getattr(self, key) is None})


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
        # Whether Nova's publication rules apply is fixed when the session starts, like repair.
        assembly = AssemblyReview(library, shapes) if settings.get("assembly_rules") else None
        return cls(library, shapes, PartFinder(library, palette),
                   ModelChecker(library, shapes, palette, max_parts=int(settings.get("max_parts", 1500)),
                                assembly=assembly),
                   runner or SubprocessScriptRunner(kit_settings),
                   renderer or LeoCadRenderer(library.root), palette)

    def toolbox(self, session: Session) -> Toolbox:
        # Whether builds are repaired is fixed when the session starts, so a model is always
        # rebuilt the way it was made.
        repairer = (BuildRepairer(self.library, self.shapes, self.palette, self.finder)
                    if session.meta["settings"].get("repair") else None)
        return Toolbox(session, self.library, self.shapes, self.palette, self.finder, self.checker,
                       self.runner, self.renderer, repairer)


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
    """The provider is chosen by the model's name; each reads its own key."""
    if is_openai_model(model):
        return OpenAIClient(options.api_key or os.environ.get("OPENAI_API_KEY", ""), model=model, effort=effort)
    # Lean rounds share only their opening, so they mark the cache point themselves.
    return AnthropicClient(options.api_key or os.environ.get("ANTHROPIC_API_KEY", ""), model=model, effort=effort,
                           auto_cache=options.method not in LEAN)


def _agent(options: Options, session: Session, client: ModelClient, bench: Workbench, on_event: Event | None,
           budget: Budget | None = None):
    budget = budget or Budget(Decimal(str(options.budget_usd)), client.model)
    deadline = time.monotonic() + options.max_seconds if options.max_seconds else None
    if options.method in LEAN:
        return LeanAgent(session, client, bench.toolbox(session), budget, max_rounds=options.max_steps,
                         on_event=on_event, deadline=deadline)
    return BuildAgent(session, client, bench.toolbox(session), budget, max_steps=options.max_steps,
                      on_event=on_event, deadline=deadline)


def start_build(prompt: str, run_dir: Path | str, options: Options, *, reference: Path | None = None,
                on_event: Event | None = None, client: ModelClient | None = None,
                workbench: Workbench | None = None, script: str | None = None) -> RunResult:
    """Create a session in ``run_dir`` and build the request.

    ``script`` starts from an existing model's build script, for a change made without the
    session that produced it.
    """
    if not prompt.strip():
        raise ValueError("Describe what to build")
    options = options.resolved(options.method)
    settings = {"ldraw_dir": options.ldraw_dir, "catalog_path": options.catalog_path,
                "open_palette": options.open_palette, "max_parts": options.max_parts, "effort": options.effort,
                "method": options.method, "repair": options.method in ASSISTED,
                "assembly_rules": options.method in ASSISTED,
                "examples": options.examples and options.method in ASSISTED}
    bench = workbench or Workbench.open(settings)
    settings["ldraw_dir"] = str(bench.library.root)
    client = client or _client(options, options.model, options.effort)
    if options.method == "lean":
        system, tools = lean_system_prompt(bench.finder, bench.shapes, bench.palette.name), LEAN_TOOLS
    elif options.method == "lean-v2":
        system, tools = lean_v2_system_prompt(bench.finder, bench.shapes, bench.palette.name), LEAN_TOOLS
    elif options.method == "thorough-v2":
        system, tools = (thorough_v2_system_prompt(bench.finder, bench.shapes, bench.palette.name),
                         THOROUGH_V2_TOOLS)
    else:
        system, tools = system_prompt(bench.finder, bench.palette.name), TOOL_DEFINITIONS
    session = Session.create(run_dir, system=system, tools=tools, model=client.model, settings=settings)
    content = []
    if reference is not None:
        content.append(session.image_block(save_reference(Path(reference), session)))
    budget = Budget(Decimal(str(options.budget_usd)), client.model)
    if settings["examples"]:
        asked = [*content, {"type": "text", "text": f"Request: {prompt.strip()}"}]
        _add_examples(session, client, budget, asked, on_event)
    agent = _agent(options, session, client, bench, on_event, budget)
    existing = agent.load(script) if script and script.strip() else None
    content.append({"type": "text", "text": build_request(prompt, has_reference=reference is not None,
                                                          max_parts=options.max_parts, existing=existing)})
    return agent.run(content)


def _add_examples(session: Session, client: ModelClient, budget: Budget, asked: list[dict],
                  on_event: Event | None) -> None:
    """Let the model name a category of examples, and add that category's scripts to its prompt.

    This happens once, before the first round, so the prompt is then fixed for the whole session
    like any other. The choice is a model call: it is charged to the run and reported like a turn.
    """
    choice = choose_category(client, session.inflate(asked))
    if choice.reply is not None:
        budget.record(choice.reply, carried=False)
        session.meta["usage"] = session.meta.get("usage", []) + budget.calls[-1:]
        if on_event is not None:
            on_event("turn", {"step": 0, "spent_usd": str(budget.spent), "usage": budget.calls[-1]})
    session.meta["settings"]["example_category"] = choice.category
    if choice.category is not None:
        session.meta["system"] += "\n\n" + example_section(choice.category)
    session.save()


def continue_build(request: str, run_dir: Path | str, options: Options, *, on_event: Event | None = None,
                   client: ModelClient | None = None, workbench: Workbench | None = None) -> RunResult:
    """Send a follow-up edit to an existing session, keeping its conversation and script."""
    if not request.strip():
        raise ValueError("Describe the change")
    session = Session.load(run_dir)
    settings = session.meta["settings"]
    # A session continues with the method, model and effort that started it: its prompt, tools and
    # (for the thorough method) earlier reasoning belong to them.
    options = replace(options, effort=settings.get("effort") or options.effort).resolved(
        settings.get("method", "thorough"))
    bench = workbench or Workbench.open(settings)
    client = client or _client(options, session.meta["model"], options.effort)
    change = f"Change request: {request.strip()}"
    if options.method not in LEAN:
        change += "\n\nUpdate the existing build script, check and render the result, then finish again."
    return _agent(options, session, client, bench, on_event).run([{"type": "text", "text": change}])
