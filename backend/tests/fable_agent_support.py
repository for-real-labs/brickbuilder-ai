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


# Parts the ready-made trees use, for the tests that plant them (``World(extra=TREE_PARTS)``).
TREE_PARTS = {
    "3795": _block("Plate  2 x  6", 6, 2, 8),
    "3034": _block("Plate  2 x  8", 8, 2, 8),
    "3832": _block("Plate  2 x 10", 10, 2, 8),
    "3941": _block("Cylinder  2 x  2 Trunk", 2, 2, 24),
    "30367c": _block("Dome  2 x  2 Top", 2, 2, 20, studs=False),
    "3942c": _block("Cone  2 x  2 x  2", 2, 2, 48, studs=False),
}


def _studded(description: str, width: float, depth: float, height: float, studs=()) -> str:
    """A block with studs only on the given (column, row) cells, counted from its min corner."""
    x0, z0 = -10.0 * width, -10.0 * depth
    lines = [f"0 {description}"] + _shell(x0, 0, z0, -x0, height, -z0)
    lines += [f"1 16 {x0 + 10 + 20 * i:g} 0 {z0 + 10 + 20 * k:g} {IDENTITY} stud.dat" for i, k in studs]
    return "\n".join(lines) + "\n"


# Stand-ins for the parts the helpers use: the right size and the right studs, as plain blocks.
# The real shapes are checked by tests/test_fable_helpers_real.py wherever a parts library is installed.
HELPER_PARTS = {
    **TREE_PARTS,
    "3003": _block("Cube  2 x  2 Block", 2, 2, 24),
    "3623": _block("Plate  1 x  3", 3, 1, 8),
    "3710": _block("Plate  1 x  4", 4, 1, 8),
    "3666": _block("Plate  1 x  6", 6, 1, 8),
    "3460": _block("Plate  1 x  8", 8, 1, 8),
    "3021": _block("Plate  2 x  3", 3, 2, 8),
    "3622": _block("Brick  1 x  3", 3, 1, 24),
    "3009": _block("Brick  1 x  6", 6, 1, 24),
    "3008": _block("Brick  1 x  8", 8, 1, 24),
    "60481a": _studded("Slope 65  2 x  1 x  2", 1, 2, 48, [(0, 1)]),
    "3678b": _studded("Slope 65  2 x  2 x  2", 2, 2, 48, [(0, 1), (1, 1)]),
    "3040b": _studded("Slope 45  2 x  1", 1, 2, 24, [(0, 1)]),
    "3037": _studded("Slope 45  2 x  4", 4, 2, 24, [(i, 1) for i in range(4)]),
    "3043": _studded("Slope 45  2 x  2 Double", 2, 2, 24),
    "3044c": _studded("Slope 45  2 x  1 Double", 1, 2, 24),
    "3045": _studded("Slope 45  2 x  2 Double Convex", 2, 2, 24, [(1, 1)]),
    "3298": _studded("Slope 33  3 x  2", 2, 3, 24, [(0, 2), (1, 2)]),
    "4286": _studded("Slope 33  3 x  1", 1, 3, 24, [(0, 2)]),
    "60592": _studded("Window  1 x  2 x  2 Flat Front", 2, 1, 48, [(0, 0), (1, 0)]),
    "60601": _studded("Glass for Window  1 x  2 x  2", 1.6, 0.2, 38),
    "60594": _studded("Window  1 x  4 x  3", 4, 1, 72, [(1, 0), (2, 0)]),
    "60603": _studded("Glass for Window  1 x  4 x  3", 3.6, 0.4, 60),
    "60596": _studded("Door Frame  1 x  4 x  6", 4, 1, 144, [(1, 0), (2, 0)]),
    "60623": _studded("Door  1 x  4 x  6 with 4 Panes", 3.5, 0.3, 134),
    "15332": _block("Fence  1 x  4 x  2 Spindled", 4, 1, 48),
    "3062b": _block("Cylinder  1 x  1 Round", 1, 1, 24),
    "4073": _block("Disc  1 x  1 Round", 1, 1, 8),
    "24866": _block("Disc  1 x  1 Flower", 1, 1, 8),
    "11062": _studded("Support  2 x  2 x  7 Lamp Post", 2, 2, 168, [(0.5, 0.5)]),  # one stud, in the middle
    "4600": _block("Holder  2 x  2 for Wheels", 2, 2, 8),
    "4624": _studded("Wheel  8mm", 1, 0.8, 20),
    "87414": _studded("Tyre 15mm", 1.8, 0.8, 36),
    "3823": _studded("Windscreen  2 x  4 x  2", 4, 2, 48),
    "4079": _studded("Seat  2 x  2", 2, 2, 48),
    "87087": _block("Cube  1 x  1 with Stud on Side", 1, 1, 24),
    "16091": _studded("Steering Wheel Small", 2, 2, 16),
}
HELPER_COLORS = {72: "Dark_Bluish_Grey", 70: "Reddish_Brown", 19: "Tan", 14: "Yellow", 47: "Trans_Clear",
                 320: "Dark_Red", 28: "Dark_Tan", 10: "Bright_Green", 288: "Dark_Green", 46: "Trans_Yellow",
                 25: "Orange", 29: "Bright_Pink", 27: "Lime", 330: "Olive_Green", 308: "Dark_Brown", 1: "Blue",
                 484: "Dark_Orange", 57: "Trans_Orange", 36: "Trans_Red", 34: "Trans_Green",
                 43: "Trans_Light_Blue", 272: "Dark_Blue"}


def make_library(root: Path, parts: dict | None = None, colors: dict | None = None) -> Path:
    parts = PARTS if parts is None else parts
    colors = COLORS if colors is None else colors
    (root / "parts").mkdir(parents=True)
    (root / "p").mkdir()
    (root / "p" / "stud.dat").write_text(STUD)
    for part_id, text in parts.items():
        (root / "parts" / f"{part_id}.dat").write_text(text)
    (root / "LDConfig.ldr").write_text("".join(
        f"0 !COLOUR {name} CODE {code} VALUE #{code * 4099 % 0xFFFFFF:06X} EDGE #333333\n"
        for code, name in colors.items()))
    return root


def make_catalog(path: Path, *, skip: set[tuple[str, int]] = frozenset(), parts: dict | None = None,
                 colors: dict | None = None) -> Path:
    parts = PARTS if parts is None else parts
    colors = COLORS if colors is None else colors
    rows = ["part_id,color_id,name,sku,unit_price,weight_kg"]
    for part_id in parts:
        if part_id == "3660":
            continue
        for color in colors:
            if (part_id, color) not in skip:
                rows.append(f"{part_id},{color},{parts[part_id].splitlines()[0][2:].replace('  ', ' ')},"
                            f"S-{part_id}-{color},0.05,0.001")
    path.write_text("\n".join(rows) + "\n")
    return path


class World:
    """The collaborators most tests need, built over the synthetic library."""

    def __init__(self, tmp_path: Path, *, skip: set = frozenset(), max_parts: int = 500,
                 extra: dict | None = None, colors: dict | None = None):
        parts = {**PARTS, **(extra or {})}
        colors = {**COLORS, **(colors or {})}
        self.library = LDrawLibrary(make_library(tmp_path / "ldraw", parts, colors))
        self.catalog_path = make_catalog(tmp_path / "catalog.csv", skip=skip, parts=parts, colors=colors)
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
