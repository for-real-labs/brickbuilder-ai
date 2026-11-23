"""A tiny synthetic LDraw library and fakes, so the Fable agent tests need no real parts or network."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from fable_agent.catalog import PartFinder
from fable_agent.checks import ModelChecker
from fable_agent.kit import Kit
from fable_agent.ldraw import LDrawLibrary
from fable_agent.palette import load_palette
from fable_agent.provider import ModelReply
from fable_agent.render import RenderedView
from fable_agent.sandbox import ScriptError, ScriptOutcome, execute_script
from fable_agent.shape import ShapeLibrary

COLORS = {0: "Black", 2: "Green", 4: "Red", 15: "White", 71: "Light_Bluish_Grey", 379: "Sand_Blue"}
IDENTITY = "1 0 0 0 1 0 0 0 1"


def _quad(*points) -> str:
    return "4 16 " + " ".join(f"{value:g}" for point in points for value in point)


def _shell(x0, y0, z0, x1, y1, z1, *, top=True, bottom=False) -> list[str]:
    """Faces of a box. Bricks are hollow underneath, like the real ones."""
    lines = [
        _quad((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)),
        _quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)),
        _quad((x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)),
        _quad((x1, y0, z0), (x1, y0, z1), (x1, y1, z1), (x1, y1, z0)),
    ]
    if top:
        lines.append(_quad((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)))
    if bottom:
        lines.append(_quad((x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)))
    return lines


def _studs(width: int, depth: int, x0: float, z0: float) -> list[str]:
    return [f"1 16 {x0 + 10 + 20 * i:g} 0 {z0 + 10 + 20 * k:g} {IDENTITY} stud.dat"
            for i in range(width) for k in range(depth)]


def _block(description: str, width: int, depth: int, height: float, *, studs: bool = True) -> str:
    x0, z0 = -10.0 * width, -10.0 * depth
    lines = [f"0 {description}"] + _shell(x0, 0, z0, -x0, height, -z0)
    return "\n".join(lines + (_studs(width, depth, x0, z0) if studs else [])) + "\n"


PARTS = {
    "3005": _block("Brick  1 x  1", 1, 1, 24),
    "3004": _block("Brick  1 x  2", 2, 1, 24),
    "3010": _block("Brick  1 x  4", 4, 1, 24),
    "3001": _block("Brick  2 x  4", 4, 2, 24),
    "3024": _block("Plate  1 x  1", 1, 1, 8),
    "3023": _block("Plate  1 x  2", 2, 1, 8),
    "3022": _block("Plate  2 x  2", 2, 2, 8),
    "3020": _block("Plate  2 x  4", 4, 2, 8),
    "3070b": _block("Tile  1 x  1 with Groove", 1, 1, 8, studs=False),
    # A 45 degree slope: studs on the back row, low edge at the front (-z).
    "3039": "\n".join([
        "0 Slope Brick 45  2 x  2",
        _quad((-20, 0, -10), (20, 0, -10), (20, 0, 10), (-20, 0, 10)),
        _quad((-20, 20, -30), (20, 20, -30), (20, 0, -10), (-20, 0, -10)),
        _quad((-20, 24, -30), (20, 24, -30), (20, 24, 10), (-20, 24, 10)),
        f"1 16 -10 0 0 {IDENTITY} stud.dat", f"1 16 10 0 0 {IDENTITY} stud.dat",
    ]) + "\n",
    # An arch: two legs and a beam, open underneath the span.
    "3659": "\n".join([
        "0 Arch  1 x  4",
        _quad((-40, 0, -10), (40, 0, -10), (40, 0, 10), (-40, 0, 10)),
        _quad((-40, 24, -10), (-20, 24, -10), (-20, 24, 10), (-40, 24, 10)),
        _quad((20, 24, -10), (40, 24, -10), (40, 24, 10), (20, 24, 10)),
        _quad((-20, 8, -10), (20, 8, -10), (20, 8, 10), (-20, 8, 10)),
        *_studs(4, 1, -40, -10),
    ]) + "\n",
    "3660": f"0 ~Moved to 3039\n1 16 0 0 0 {IDENTITY} 3039.dat\n",
}
STUD = "\n".join(["0 Stud"] + _shell(-6, -4, -6, 6, 0, 6)) + "\n"


def make_library(root: Path) -> Path:
    (root / "parts").mkdir(parents=True)
    (root / "p").mkdir()
    (root / "p" / "stud.dat").write_text(STUD)
    for part_id, text in PARTS.items():
        (root / "parts" / f"{part_id}.dat").write_text(text)
    (root / "LDConfig.ldr").write_text("".join(
        f"0 !COLOUR {name} CODE {code} VALUE #{code * 4099 % 0xFFFFFF:06X} EDGE #333333\n"
        for code, name in COLORS.items()))
    return root


def make_catalog(path: Path, *, skip: set[tuple[str, int]] = frozenset()) -> Path:
    rows = ["part_id,color_id,name,sku,unit_price,weight_kg"]
    for part_id in PARTS:
        if part_id == "3660":
            continue
        for color in COLORS:
            if (part_id, color) not in skip:
                rows.append(f"{part_id},{color},{PARTS[part_id].splitlines()[0][2:].replace('  ', ' ')},"
                            f"S-{part_id}-{color},0.05,0.001")
    path.write_text("\n".join(rows) + "\n")
    return path


class World:
    """The collaborators most tests need, built over the synthetic library."""

    def __init__(self, tmp_path: Path, *, skip: set = frozenset(), max_parts: int = 500):
        self.library = LDrawLibrary(make_library(tmp_path / "ldraw"))
        self.catalog_path = make_catalog(tmp_path / "catalog.csv", skip=skip)
        self.shapes = ShapeLibrary(self.library)
        self.palette = load_palette(self.library, self.catalog_path)
        self.finder = PartFinder(self.library, self.palette)
        self.checker = ModelChecker(self.library, self.shapes, self.palette, max_parts=max_parts)

    def kit(self) -> Kit:
        return Kit(self.library, self.shapes, self.palette, self.finder)

    def settings(self) -> dict:
        return {"ldraw_dir": str(self.library.root), "catalog_path": str(self.catalog_path),
                "open_palette": False, "max_parts": 500, "effort": "low"}


class InlineRunner:
    """Runs scripts in-process through the same validator and kit as the sandbox child."""

    def __init__(self, world: World):
        self._world = world

    def run(self, code: str) -> ScriptOutcome:
        kit = self._world.kit()
        try:
            return ScriptOutcome(kit.build, execute_script(code, kit))
        except ScriptError as exc:
            return ScriptOutcome(None, exc.output, str(exc), exc.line)


class FakeRenderer:
    def __init__(self):
        self.calls = []

    def render(self, model, out_dir, views, bounds, *, prefix="view", elevation=None):
        self.calls.append({"model": Path(model), "views": list(views), "bounds": list(bounds), "elevation": elevation})
        out_dir.mkdir(parents=True, exist_ok=True)
        results = []
        for view in views:
            path = out_dir / f"{prefix}-{view}.png"
            Image.new("RGB", (8, 8), (10 * len(self.calls), 90, 160)).save(path)
            results.append(RenderedView(view, path))
        return results


def reply(*blocks, stop_reason: str | None = None, usage: dict | None = None, **extra) -> ModelReply:
    content = list(blocks)
    reason = stop_reason or ("tool_use" if any(b.get("type") == "tool_use" for b in content) else "end_turn")
    return ModelReply(content=content, stop_reason=reason, model="claude-fable-5-2",
                      usage=usage or {"input_tokens": 1000, "output_tokens": 200}, **extra)


def tool_use(name: str, call_id: str = "call_1", **arguments) -> dict:
    return {"type": "tool_use", "id": call_id, "name": name, "input": arguments}


class FakeClient:
    """Replays scripted replies and records exactly what each request contained."""

    model = "claude-fable-5-2"

    def __init__(self, replies):
        self._replies = list(replies)
        self.requests = []

    def send(self, system, tools, messages, *, max_tokens, on_delta=None):
        self.requests.append({"system": system, "tools": tools, "messages": messages, "max_tokens": max_tokens})
        if not self._replies:
            raise AssertionError("The agent asked for more replies than the test scripted")
        return self._replies.pop(0)


CABIN = """
module("base")
fill(rect(-1, -1, 7, 5), 0, "Green", kind="plate")
module("walls")
for course in range(2):
    fill(ring(0, 0, 6, 4), 1 + 3 * course, "Sand_Blue")
"""
