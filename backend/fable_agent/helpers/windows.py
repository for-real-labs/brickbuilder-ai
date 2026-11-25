"""Ready-made windows.

A window is a frame with its pane seated in it, or a few of them set together. The frame and
pane pairs, and how the pane sits in the frame, are the ones customers' models use most. A
window fills an opening of exactly its size, which each style states, and the wall carries on
above it.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..kit import Kit, KitError
from .common import BRICK, Frame, Helper, brick_color, choice, need, stocked, whole


@dataclass(frozen=True)
class Unit:
    """One frame, with what sits in it. ``pane`` is glass unless ``solid`` says it is a lattice or bars."""

    frame: str
    pane: str | None = None
    solid: bool = False
    wide: int = 2
    tall: int = 6
    deep: int = 1
    glazing: bool = False  # the part is itself the glass: a clear panel with no frame


SMALL = Unit("60592", "60601")
WIDE = Unit("60594", "60603", wide=4, tall=9)
ARCHED = Unit("30044", None, tall=8)
FAN = Unit("20309", None, wide=4, tall=5)
SQUARE = Unit("51239", "51266", wide=3, tall=9)
SHEET = Unit("60581", wide=4, tall=9, glazing=True)
CURTAIN = Unit("59349", wide=6, tall=15, glazing=True)
# A style is a list of (unit, dx, dy): where each unit stands in the window, in studs and plates.
STYLES: dict[str, list[tuple[Unit, int, int]]] = {
    "small": [(SMALL, 0, 0)],
    "diamond": [(Unit("60592", "38320", solid=True), 0, 0)],
    "plane": [(Unit("60032", "60601"), 0, 0)],
    "square": [(SQUARE, 0, 0)],
    "arched": [(ARCHED, 0, 0)],
    "arched_lattice": [(Unit("30044", "30046", solid=True, tall=8), 0, 0)],
    "fan": [(FAN, 0, 0)],
    "strip": [(Unit("61345", None, wide=4), 0, 0)],
    "wide": [(WIDE, 0, 0)],
    "barred": [(Unit("60594", "6016", solid=True, wide=4, tall=9), 0, 0)],
    "grille": [(Unit("60594", "62113", solid=True, wide=4, tall=9), 0, 0)],
    "train": [(Unit("6556", "4034", wide=4, tall=9), 0, 0)],
    "picture": [(Unit("2493b", "2494", wide=4, tall=15), 0, 0)],
    "french": [(Unit("57894", "57895", wide=4, tall=18), 0, 0)],
    "panorama": [(Unit("42205", "42509", wide=6, tall=18), 0, 0)],
    "deep": [(Unit("60598", None, wide=4, tall=9, deep=2), 0, 0)],
    "skylight": [(Unit("4447", "4448", wide=4, tall=9, deep=4), 0, 0)],
    "double": [(SMALL, 0, 0), (SMALL, 2, 0)],
    "triple": [(SMALL, 0, 0), (SMALL, 2, 0), (SMALL, 4, 0)],
    "ribbon": [(SMALL, 2 * i, 0) for i in range(4)],
    "stacked": [(SMALL, 0, 0), (SMALL, 0, 6)],
    "grid": [(SMALL, 0, 0), (SMALL, 2, 0), (SMALL, 0, 6), (SMALL, 2, 6)],
    "tall": [(SQUARE, 0, 0), (SQUARE, 0, 9)],
    "transom": [(WIDE, 0, 0), (FAN, 0, 9)],
    "arched_pair": [(ARCHED, 0, 0), (ARCHED, 2, 0)],
    "shuttered": [(SMALL, 1, 0)],
    # Frameless glass, as official sets glaze shop fronts, cabs and towers (docs/fable-helpers.md).
    "glass_block": [(Unit("87552", glazing=True), 0, 0)],
    "glass_pane": [(Unit("87544", tall=9, glazing=True), 0, 0)],
    "glass_wall": [(SHEET, 0, 0)],
    "glass_tower": [(SHEET, 0, 0), (SHEET, 0, 9)],
    "curtain_wall": [(CURTAIN, 0, 0)],
    "storefront": [(CURTAIN, 0, 0), (CURTAIN, 6, 0)],
}
SHUTTERED = {"shuttered": 4}  # styles with a brick shutter either side, and their whole width


def size(style: str) -> tuple[int, int, int]:
    """(studs wide, plates tall, studs deep) of the opening a style fills."""
    units = STYLES[style]
    wide = SHUTTERED.get(style) or max(dx + unit.wide for unit, dx, _ in units)
    return wide, max(dy + unit.tall for unit, _, dy in units), max(unit.deep for unit, _, _ in units)


def build_window(kit: Kit, x, y, z, style="small", color="White", glass="Trans_Clear", trim=None,
                 facing="front") -> list[int]:
    """A window whose opening has its min corner at (x, z) and its sill at ``y`` plates."""
    choice(style, STYLES, "style", "window")
    x, z = whole(x, "x", "window"), whole(z, "z", "window")
    choice(facing, ("front", "back", "left", "right"), "facing", "window")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("window() needs a number of plates for y")
    wide, tall, deep = size(style)
    frame = Frame(kit, x, y, z, wide, deep, facing)
    placed: list[int] = []
    for unit, dx, dy in STYLES[style]:
        part, code = need(kit, unit.frame, glass if unit.glazing else color, "window",
                          "window frame of this style")
        host = frame.place(part, code, dx, dy, 0)
        placed.append(host)
        if unit.pane is not None:
            pane = stocked(kit, unit.pane, color if unit.solid else glass)
            if pane is not None:
                placed.append(kit.inset(unit.pane, pane, host, "pane in its frame"))
    if style in SHUTTERED:
        shutter = brick_color(kit, color if trim is None else trim, "window")
        for lx in (0, wide - 1):
            placed += frame.fill({(lx, 0)}, 0, shutter, layers=tall // BRICK)
    return placed


def _note(style: str) -> str:
    wide, tall, deep = size(style)
    return f"{wide}x{tall}" + (f", {deep} deep" if deep > 1 else "")


HELPER = Helper(
    name="window", build=build_window,
    signature='window(x, y, z, style="small", color="White", glass="Trans_Clear", trim=None, facing="front")',
    summary="A window with its glass. (x, z) is the min corner of the opening it fills and y its sill; it stands "
            "on the studs under it. The note after each style is the opening it needs, studs wide x plates tall, "
            "and it is one stud deep unless the note says more. It lies along x when `facing` is front or back and "
            "along z when left or right. `color` is the frame, `glass` the pane, `trim` the shutters. The "
            "glass_ styles, curtain_wall and storefront are sheets of glass with no frame.",
    styles=tuple(STYLES),
    notes={style: _note(style) for style in STYLES},
)
