"""The tools the agent works with: find parts, write the build script, look, publish."""

from __future__ import annotations

import csv
import io
import json
import shutil
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from .catalog import PartFinder
from .checks import ModelChecker, Report
from .kit import Build, Placement, to_ldraw
from .ldraw import LDrawError, LDrawLibrary, normalize_part_id
from .palette import Palette
from .render import VIEW_AZIMUTH, Renderer, RenderError, contact_sheet
from .runner import ScriptRunner
from .session import MODEL_FILE, Session
from .shape import PLATE, STUD, PartShape, ShapeLibrary

MAX_VIEWS = 4
PUBLISH_VIEWS = ("front-right", "front-left", "back-left", "back-right")


class ToolError(ValueError):
    """A mistake in a tool call; the message tells the agent how to correct it."""


@dataclass
class ToolOutput:
    text: str
    images: list[Path] = field(default_factory=list)
    is_error: bool = False
    finished: bool = False


def _schema(properties: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


TOOL_DEFINITIONS = [
    {
        "name": "search_parts",
        "description": "Search the parts you may use by description, e.g. 'slope 33 3 x 2', 'window 1 x 4 x 3', "
                       "'fence', 'plate round 2 x 2'. Results are real part ids with the number of available "
                       "colors. Pass color to list only parts available in that color.",
        "input_schema": _schema({
            "query": {"type": "string"},
            "color": {"type": "string", "description": "LDraw color name or code (optional)"},
            "limit": {"type": "integer", "description": "1-40, default 12"},
        }, ["query"]),
    },
    {
        "name": "inspect_part",
        "description": "Measured facts about one part: footprint and height, a height map showing its shape and "
                       "which way it faces, where its studs are, and the colors it comes in. Use before placing "
                       "any part whose shape or orientation you are not sure of.",
        "input_schema": _schema({"part": {"type": "string"}}, ["part"]),
    },
    {
        "name": "view_parts",
        "description": "Render up to 12 parts side by side so you can compare what they look like.",
        "input_schema": _schema({"parts": {"type": "array", "items": {"type": "string"}}}, ["parts"]),
    },
    {
        "name": "write_script",
        "description": "Replace the whole build script, run it, and get the build report (part count, size, "
                       "overlaps, unattached parts, unavailable parts). The script is the source of the model.",
        "input_schema": _schema({"code": {"type": "string"}}, ["code"]),
    },
    {
        "name": "edit_script",
        "description": "Replace one exact piece of text in the build script, then rebuild and report. Prefer this "
                       "over rewriting the script for a local change. 'old' must match exactly once unless "
                       "replace_all is true.",
        "input_schema": _schema({
            "old": {"type": "string"}, "new": {"type": "string"}, "replace_all": {"type": "boolean"},
        }, ["old", "new"]),
    },
    {
        "name": "read_script",
        "description": "Show the current build script with line numbers.",
        "input_schema": _schema({}, []),
    },
    {
        "name": "render",
        "description": "Render the current build and look at it. Views: " + ", ".join(VIEW_AZIMUTH) + ". Up to 4 "
                       "per call. 'focus' zooms on a region given in grid units. 'elevation' is the camera "
                       "height angle in degrees (default 24).",
        "input_schema": _schema({
            "views": {"type": "array", "items": {"type": "string"}},
            "focus": {"type": "object", "properties": {
                "x0": {"type": "number"}, "x1": {"type": "number"}, "z0": {"type": "number"},
                "z1": {"type": "number"}, "y0": {"type": "number"}, "y1": {"type": "number"}},
                "required": ["x0", "x1", "z0", "z1", "y0", "y1"], "additionalProperties": False},
            "elevation": {"type": "number"},
        }, []),
    },
    {
        "name": "finish",
        "description": "Publish the current build as the finished model. Only works when the build report has no "
                       "errors and you have rendered this exact revision. 'summary' is shown to the customer: "
                       "say what was built and name any honest limitations.",
        "input_schema": _schema({"title": {"type": "string"}, "summary": {"type": "string"}}, ["title", "summary"]),
    },
]


def _text(arguments: dict, key: str, *, limit: int = 400_000, required: bool = True) -> str:
    value = arguments.get(key)
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()):
        raise ToolError(f"'{key}' must be a non-empty string")
    if len(value) > limit:
        raise ToolError(f"'{key}' is too long")
    return value


class Toolbox:
    def __init__(self, session: Session, library: LDrawLibrary, shapes: ShapeLibrary, palette: Palette,
                 finder: PartFinder, checker: ModelChecker, runner: ScriptRunner, renderer: Renderer):
        self._session = session
        self._library = library
        self._shapes = shapes
        self._palette = palette
        self._finder = finder
        self._checker = checker
        self._runner = runner
        self._renderer = renderer
        self._build: Build | None = None
        self._report: Report | None = None

    def call(self, name: str, arguments: dict) -> ToolOutput:
        handler = getattr(self, f"_tool_{name}", None) if isinstance(name, str) and name.isidentifier() else None
        if handler is None:
            return ToolOutput(f"Unknown tool {name!r}.", is_error=True)
        if not isinstance(arguments, dict):
            return ToolOutput("Tool input must be a JSON object.", is_error=True)
        try:
            return handler(arguments)
        except (ToolError, LDrawError, RenderError) as exc:
            return ToolOutput(str(exc), is_error=True)

    # ----- parts ---------------------------------------------------------

    def _color_names(self) -> dict[int, str]:
        return {color.code: color.name for color in self._library.colors().values()}

    def _color(self, value) -> int:
        names = self._library.colors()
        text = str(value).strip()
        if text.lstrip("-").isdigit():
            code = int(text)
        else:
            key = "".join(ch for ch in text.lower().replace("gray", "grey") if ch.isalnum())
            code = next((c.code for c in names.values()
                         if "".join(ch for ch in c.name.lower().replace("gray", "grey") if ch.isalnum()) == key), None)
        if code is None or code not in names:
            raise ToolError(f"Unknown color {value!r}; use an LDraw color name or code from the color list")
        return code

    def _tool_search_parts(self, arguments: dict) -> ToolOutput:
        query = _text(arguments, "query", limit=200)
        limit = arguments.get("limit", 12)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 40:
            raise ToolError("'limit' must be an integer from 1 to 40")
        color = self._color(arguments["color"]) if arguments.get("color") not in (None, "") else None
        found = self._finder.search(query, limit, color)
        if not found:
            return ToolOutput("No available parts match. Try fewer or more general words.")
        lines = [f"{entry.part_id}: {entry.title}"
                 + (f" [{entry.description}]" if entry.label and entry.description and entry.description != entry.label else "")
                 + f" ({entry.colors} colors)" for entry in found]
        return ToolOutput("\n".join(lines))

    @staticmethod
    def _height_map(shape: PartShape, values, baseline: float, title: str) -> list[str]:
        cells = [(shape.hi[1] - v) / PLATE if v is not None else None for column in values for v in column]
        present = [c for c in cells if c is not None]
        if not present or max(present) - min(present) < 0.05:
            level = present[0] if present else 0
            return [] if abs(level - baseline) < 0.05 and not title.startswith("top") else [
                f"{title}: flat at {level:g} plates"]
        columns, rows = len(values), len(values[0])
        if columns * rows > 480:
            return [f"{title}: varies between {min(present):g} and {max(present):g} plates (part too large to map)"]
        lines = [f"{title} (plates above the part's base; half-stud cells; first row is the BACK (+z), "
                 f"last row is the FRONT (-z); left column is -x):"]
        for k in reversed(range(rows)):
            row = [values[i][k] for i in range(columns)]
            lines.append("  " + " ".join("   ." if v is None else f"{(shape.hi[1] - v) / PLATE:4.1f}" for v in row))
        return lines

    def _tool_inspect_part(self, arguments: dict) -> ToolOutput:
        part_id = normalize_part_id(_text(arguments, "part", limit=80))
        shape = self._shapes.get(part_id)
        entry = self._finder.entry(part_id)
        names = self._color_names()
        title = (entry.title if entry else "") or self._library.description(part_id)
        lines = [f"{part_id}: {title}",
                 f"At rot=0 the footprint is {shape.width:g} studs along x by {shape.depth:g} studs along z; "
                 f"the body is {shape.height:g} plates tall."]
        if shape.directional:
            side = {0: "front (-z)", 90: "left (-x)", 180: "back (+z)", 270: "right (+x)"}[shape.front_yaw]
            lines.append(f"Its low or open side points to the {side} at rot=0. facing='front'|'back'|'left'|'right' "
                         "aims that side for you.")
        lines += self._height_map(shape, shape.top, shape.height, "top surface")
        lines += self._height_map(shape, shape.bottom, 0.0, "underside (0 = rests on the layer below)")
        studs = shape.up_studs()
        if studs:
            shown = ", ".join(f"({x:g},{z:g})" for x, z, _ in studs[:24])
            heights = sorted({h for _, _, h in studs})
            lines.append(f"{len(studs)} studs on top at (x,z) from the min corner: {shown}"
                         f"{' ...' if len(studs) > 24 else ''}; stud base height {', '.join(f'{h:g}' for h in heights)} plates.")
        else:
            lines.append("No studs on top: nothing can attach above it.")
        if shape.side_studs():
            lines.append(f"{shape.side_studs()} studs point sideways or down (for sideways building).")
        colors = self._palette.colors_for(part_id)
        if colors:
            lines.append(f"Available in {len(colors)} colors: "
                         + ", ".join(f"{names.get(c, c)} ({c})" for c in colors))
        else:
            lines.append("NOT AVAILABLE in the parts catalog: do not use it.")
        return ToolOutput("\n".join(lines))

    def _tool_view_parts(self, arguments: dict) -> ToolOutput:
        parts = arguments.get("parts")
        if not isinstance(parts, list) or not 1 <= len(parts) <= 12 or not all(isinstance(p, str) for p in parts):
            raise ToolError("'parts' must be a list of 1 to 12 part ids")
        scratch = self._session.path("parts")
        scratch.mkdir(exist_ok=True)
        tiles, captions = [], []
        for part in parts:
            part_id = normalize_part_id(part)
            shape = self._shapes.get(part_id)
            colors = self._palette.colors_for(part_id)
            color = 71 if 71 in colors or not colors else colors[0]
            model = scratch / f"{part_id}.ldr"
            model.write_text(to_ldraw(Build([Placement(part_id, color, (0.0, 0.0, 0.0), (1, 0, 0, 0, 1, 0, 0, 0, 1))]),
                                      part_id), encoding="utf-8")
            view = self._renderer.render(model, scratch, ["front-right"], (*shape.lo, *shape.hi),
                                         prefix=part_id, elevation=32)[0]
            entry = self._finder.entry(part_id)
            tiles.append((f"{part_id} {(entry.title if entry else '')}", view.path))
            captions.append(part_id)
        sheet = contact_sheet(tiles, self._session.unique_file("renders", "parts", ".png"))
        return ToolOutput("Parts shown left to right, top to bottom (viewed from the front-right, at rot=0): "
                          + ", ".join(captions), images=[sheet])

    # ----- script --------------------------------------------------------

    def _rebuild(self, code: str) -> ToolOutput:
        session = self._session
        revision = session.write_script(code)
        outcome = self._runner.run(code)
        printed = f"\nScript output:\n{outcome.output.strip()[:3000]}" if outcome.output.strip() else ""
        if outcome.build is None:
            self._build = self._report = None
            session.meta["built"] = {"revision": revision, "ok": False, "error": outcome.error}
            session.save()
            where = ""
            if outcome.line:
                source = code.splitlines()
                if 0 < outcome.line <= len(source):
                    where = f" (line {outcome.line}: {source[outcome.line - 1].strip()[:160]})"
            return ToolOutput(f"SCRIPT FAILED{where}: {outcome.error}{printed}\nNothing was built. Fix the script.",
                              is_error=True)
        report = self._checker.check(outcome.build)
        self._build, self._report = outcome.build, report
        session.path(MODEL_FILE).write_text(to_ldraw(outcome.build, session.meta.get("title") or "BrickBuilder model"),
                                            encoding="utf-8")
        session.path("report.json").write_text(json.dumps(report.to_dict(), indent=1), encoding="utf-8")
        session.meta["built"] = {"revision": revision, "ok": report.ok, "parts": report.parts,
                                 "bounds": list(report.bounds), "error": None}
        if report.ok:
            session.meta["clean_revision"] = revision
        session.save()
        return ToolOutput(f"Revision {revision}. " + report.to_text(self._color_names()) + printed)

    def _tool_write_script(self, arguments: dict) -> ToolOutput:
        return self._rebuild(_text(arguments, "code"))

    def _tool_edit_script(self, arguments: dict) -> ToolOutput:
        old = _text(arguments, "old")
        new = arguments.get("new")
        if not isinstance(new, str):
            raise ToolError("'new' must be a string")
        script = self._session.script
        if not script:
            raise ToolError("There is no script yet; use write_script first")
        count = script.count(old)
        if count == 0:
            raise ToolError("'old' was not found in the script. Use read_script to see the exact text.")
        if count > 1 and arguments.get("replace_all") is not True:
            raise ToolError(f"'old' matches {count} places; add surrounding lines to make it unique "
                            "or set replace_all")
        return self._rebuild(script.replace(old, new))

    def _tool_read_script(self, arguments: dict) -> ToolOutput:
        script = self._session.script
        if not script:
            return ToolOutput("There is no script yet.")
        return ToolOutput("\n".join(f"{number:4d}  {line}" for number, line in enumerate(script.splitlines(), 1)))

    # ----- looking -------------------------------------------------------

    def _current_build(self) -> dict:
        built = self._session.meta.get("built") or {}
        if not built or built.get("error") or not self._session.path(MODEL_FILE).is_file():
            raise ToolError("There is no build to look at yet; write a script that runs first")
        return built

    def _tool_render(self, arguments: dict) -> ToolOutput:
        built = self._current_build()
        views = arguments.get("views") or ["front-right", "front-left", "back-left"]
        if not isinstance(views, list) or not 1 <= len(views) <= MAX_VIEWS or any(v not in VIEW_AZIMUTH for v in views):
            raise ToolError(f"'views' must list 1 to {MAX_VIEWS} of: {', '.join(VIEW_AZIMUTH)}")
        elevation = arguments.get("elevation")
        if elevation is not None and (isinstance(elevation, bool) or not isinstance(elevation, (int, float))
                                      or not -10 <= elevation <= 88):
            raise ToolError("'elevation' must be between -10 and 88 degrees")
        bounds = built["bounds"]
        focus = arguments.get("focus")
        note = ""
        if focus is not None:
            keys = ("x0", "x1", "z0", "z1", "y0", "y1")
            if not isinstance(focus, dict) or any(isinstance(focus.get(k), bool)
                                                 or not isinstance(focus.get(k), (int, float)) for k in keys):
                raise ToolError("'focus' needs numeric x0, x1, z0, z1, y0, y1 in grid units")
            if focus["x1"] <= focus["x0"] or focus["z1"] <= focus["z0"] or focus["y1"] <= focus["y0"]:
                raise ToolError("'focus' must have x1 > x0, z1 > z0 and y1 > y0")
            bounds = [focus["x0"] * STUD, -focus["y1"] * PLATE, focus["z0"] * STUD,
                      focus["x1"] * STUD, -focus["y0"] * PLATE, focus["z1"] * STUD]
            note = " (zoomed on the focus region)"
        stem = self._session.unique_file("renders", f"r{built['revision']}", "").name
        rendered = self._renderer.render(self._session.path(MODEL_FILE), self._session.path("renders"),
                                         views, bounds, prefix=stem, elevation=elevation)
        if focus is None:
            self._session.meta["rendered_revision"] = built["revision"]
            self._session.save()
        state = "" if built.get("ok") else " The build report still has errors."
        return ToolOutput(f"Revision {built['revision']}{note}, in order: " + ", ".join(v.name for v in rendered)
                          + "." + state, images=[v.path for v in rendered])

    # ----- publishing ----------------------------------------------------

    def _restore(self) -> None:
        """After a restart the build lives on disk only; rebuild it from the saved script."""
        if self._build is None and self._session.script:
            outcome = self._runner.run(self._session.script)
            if outcome.build is not None:
                self._build, self._report = outcome.build, self._checker.check(outcome.build)

    def _tool_finish(self, arguments: dict) -> ToolOutput:
        title = " ".join(_text(arguments, "title", limit=120).split())
        summary = _text(arguments, "summary", limit=4000).strip()
        built = self._current_build()
        self._restore()
        if self._build is None or self._report is None or not self._report.ok:
            raise ToolError("The build report still has errors. Fix every error, rebuild, then finish.")
        if self._session.meta.get("rendered_revision") != built["revision"]:
            raise ToolError(f"Revision {built['revision']} has not been rendered. Render it, review the "
                            "pictures, then finish.")
        return self.publish(title, summary)

    def publish_draft(self, reason: str) -> bool:
        """Save the most recent error-free revision when a run stops before finish."""
        session = self._session
        self._restore()
        script, revision = session.script, session.meta["revision"]
        if self._report is None or not self._report.ok:
            revision = session.meta.get("clean_revision")
            source = session.path(f"scripts/{revision:03d}.py") if revision else None
            if source is None or not source.is_file():
                return False
            script = source.read_text(encoding="utf-8")
            outcome = self._runner.run(script)
            if outcome.build is None:
                return False
            report = self._checker.check(outcome.build)
            if not report.ok:
                return False
            self._build, self._report = outcome.build, report
        self.publish(session.meta.get("title") or "Draft model",
                     f"Unreviewed draft: the build stopped early ({reason}).",
                     status="draft", script=script, revision=revision)
        return True

    def publish(self, title: str, summary: str, *, status: str = "published", script: str | None = None,
                revision: int | None = None) -> ToolOutput:
        session = self._session
        self._restore()
        if self._build is None or self._report is None:
            raise ToolError("There is no build to publish")
        number = len(session.meta["published"]) + 1
        target = session.path(f"published/{number:03d}")
        target.mkdir(parents=True, exist_ok=True)
        (target / MODEL_FILE).write_text(to_ldraw(self._build, title), encoding="utf-8")
        (target / "build.py").write_text(session.script if script is None else script, encoding="utf-8")
        (target / "report.json").write_text(json.dumps(self._report.to_dict(), indent=1), encoding="utf-8")
        (target / "bom.csv").write_text(self._bill_of_materials(), encoding="utf-8")
        warning = ""
        try:
            views = self._renderer.render(target / MODEL_FILE, target, PUBLISH_VIEWS, self._report.bounds, prefix="view")
            shutil.copyfile(views[0].path, target / "preview.png")
        except RenderError as exc:
            warning = f" Preview rendering failed: {exc}"
        session.meta["title"] = title
        session.meta["status"] = status
        session.meta["published"].append({
            "number": number, "revision": revision or session.meta["revision"], "title": title, "summary": summary,
            "parts": self._report.parts, "status": status, "path": f"published/{number:03d}",
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        session.save()
        return ToolOutput(f"Published '{title}' ({self._report.parts} parts) as {status}.{warning}", finished=True)

    def _bill_of_materials(self) -> str:
        names = self._color_names()
        output = io.StringIO()
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(["part_id", "color_id", "color", "quantity", "description"])
        for (part, color), quantity in sorted(Counter((p.part, p.color) for p in self._build.placements).items()):
            entry = self._finder.entry(part)
            writer.writerow([part, color, names.get(color, ""), quantity,
                             (entry.title if entry else "") or self._library.description(part)])
        return output.getvalue()

    @property
    def report(self) -> Report | None:
        return self._report
