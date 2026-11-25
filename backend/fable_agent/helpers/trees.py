"""Ready-made trees.

Models spent more turns on trees than on anything else: canopies built from loose leaf parts
collide or hang in the air. ``plant_tree`` builds one from layers that cannot do either.

Every layer rests on the studs of the layer below it:

* a **strip layer** is a square of 2-wide plates that each run the full width. It may be two studs
  wider than the layer under it, because every strip then still crosses that layer;
* a **brick layer** is a ring of bricks no wider than the layer under it, so every brick stands on
  studs.

A style is a recipe of such layers plus a trunk, a top piece and default colors. The parts are
plain plates and bricks, a round trunk and a rounded top, each in the stocked color closest to the
one asked for, so a tree never uses a part that cannot be bought.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..kit import Kit, KitError, rect
from .common import BRICK, PLATE, Helper, brick_color, choice, stocked, whole

MIN_WIDTH, MAX_WIDTH = 4, 10
MIN_HEIGHT, MAX_HEIGHT = 6, 90
TRUNK = "3941"  # round 2 x 2 brick
DOME, CONE, FRUIT = "30367c", "3942c", "4073"  # dome top, cone, round 1 x 1 plate
Plan = list[tuple[str, int]]


def _grow(width: int) -> Plan:
    return [("strips", size) for size in range(4, width + 1, 2)]


def _shrink(width: int, steps: int | None = None, bricks: int = 1) -> Plan:
    plan: Plan = []
    for size in list(range(width - 2, 3, -2))[:steps]:
        plan += [("strips", size)] + [("bricks", size)] * bricks
    return plan


def _closed(plan: Plan) -> Plan:
    """A ring is hollow: close a wide last ring so the top piece has studs under it."""
    return plan + [("strips", plan[-1][1] - 2)] if plan[-1] == ("bricks", plan[-1][1]) and plan[-1][1] > 4 else plan


def _fir(width: int) -> Plan:
    plan = _grow(width)
    for size in range(width - 2, 3, -2):
        plan += [("bricks", size), ("strips", size)]
    return plan if len(plan) > len(_grow(width)) else plan + [("bricks", 4)]


@dataclass(frozen=True)
class TreeStyle:
    plan: Callable[[int], Plan]  # layers from the bottom up for a canopy this wide
    trunk: bool = True
    top: str | None = DOME
    leaves: str = "Green"
    accent: str | None = None
    bark: str = "Reddish_Brown"
    rounded: bool = True
    fruit: str | None = None  # color of round 1 x 1 plates set on the canopy
    ornaments: bool = False  # fruit-like plates on every tier, for a decorated tree
    bare: bool = False  # the canopy is branches in the bark color


STYLES: dict[str, TreeStyle] = {
    "round": TreeStyle(lambda w: _closed(_grow(w) + [("bricks", w)] * (2 if w > 4 else 1) + _shrink(w, 2))),
    "oak": TreeStyle(lambda w: _closed(_grow(w) + [("bricks", w)] * 3 + _shrink(w)), accent="Dark_Green"),
    "pine": TreeStyle(lambda w: _closed(_grow(w) + [("bricks", w)] + _shrink(w)), top=CONE),
    "spruce": TreeStyle(lambda w: _closed(_grow(w) + [("bricks", w)] * 2 + _shrink(w, bricks=2)), top=CONE,
                        leaves="Dark_Green"),
    "fir": TreeStyle(_fir, top=CONE, leaves="Dark_Green"),
    "christmas": TreeStyle(_fir, top=CONE, leaves="Green", ornaments=True),
    "snowy_pine": TreeStyle(lambda w: _closed(_grow(w) + [("bricks", w)] + _shrink(w)), top=CONE, leaves="White",
                            accent="Dark_Green"),
    "bush": TreeStyle(lambda w: _closed([("bricks", w)] + _shrink(w, 2)), trunk=False),
    "hedge": TreeStyle(lambda w: [("bricks", w), ("bricks", w), ("strips", w)], trunk=False, top=None, rounded=False,
                       leaves="Dark_Green"),
    "topiary": TreeStyle(lambda w: _grow(w) + [("bricks", w)] * (w // 2) + [("strips", w)], top=None, rounded=False),
    "poplar": TreeStyle(lambda w: _closed(_grow(w) + [("bricks", w)] * 4 + _shrink(w)), top=CONE),
    "umbrella": TreeStyle(lambda w: _grow(w) + [("bricks", w), ("strips", w)], top=None, leaves="Olive_Green"),
    "palm": TreeStyle(lambda w: _grow(w), bark="Tan", leaves="Bright_Green"),
    "autumn": TreeStyle(lambda w: _closed(_grow(w) + [("bricks", w)] * (2 if w > 4 else 1) + _shrink(w, 2)),
                        leaves="Orange", accent="Dark_Red"),
    "blossom": TreeStyle(lambda w: _closed(_grow(w) + [("bricks", w)] * (2 if w > 4 else 1) + _shrink(w, 2)),
                         leaves="Bright_Pink", accent="White", bark="Dark_Brown"),
    "birch": TreeStyle(lambda w: _closed(_grow(w) + [("bricks", w)] * 3 + _shrink(w)), leaves="Lime", bark="White"),
    "apple": TreeStyle(lambda w: _closed(_grow(w) + [("bricks", w)] * (2 if w > 4 else 1) + _shrink(w, 2)),
                       fruit="Red"),
    "orange": TreeStyle(lambda w: _closed(_grow(w) + [("bricks", w)] * (2 if w > 4 else 1) + _shrink(w, 2)),
                        fruit="Orange", leaves="Dark_Green"),
    "bare": TreeStyle(lambda w: _grow(min(w, 6)), top=None, bare=True, bark="Dark_Brown"),
}
ORNAMENTS = ("Red", "Yellow", "Blue")


def canopy_plan(style: str, width: int) -> Plan:
    """Layers from the bottom up as (kind, width): 'strips' is one plate tall, 'bricks' is one brick tall."""
    return STYLES[style].plan(width)


def canopy_height(style: str, width: int) -> int:
    """Plates from the underside of the canopy to the base of its top piece."""
    return sum(PLATE if kind == "strips" else BRICK for kind, _ in canopy_plan(style, width))


def _ring(x0: int, z0: int, size: int, rounded: bool) -> set[tuple[int, int]]:
    """A square ring two studs thick, with its corners cut when the canopy should read as round."""
    cells = rect(x0, z0, x0 + size, z0 + size)
    if size >= 6:
        cells -= rect(x0 + 2, z0 + 2, x0 + size - 2, z0 + size - 2)
        cut = (2 if size >= 8 else 1) if rounded else 0
        for cx, cz in ((x0, z0), (x0 + size - 1, z0), (x0, z0 + size - 1), (x0 + size - 1, z0 + size - 1)):
            sx, sz = (1 if cx == x0 else -1), (1 if cz == z0 else -1)
            cells -= {(cx + sx * i, cz + sz * j) for i in range(cut) for j in range(cut) if i + j < cut}
    return cells


def plant_tree(kit: Kit, x, y, z, height=30, width=6, style="round", leaves=None, accent=None,
               trunk=None) -> list[int]:
    """Build a tree whose 2 x 2 trunk has its min corner at (x, z) and its base at ``y`` plates.

    The canopy is ``width`` studs across, centered on the trunk. ``height`` is the whole tree in
    plates; the trunk takes what the canopy leaves. A style without a trunk sits on the ground.
    """
    choice(style, STYLES, "style", "tree")
    x, z = whole(x, "x", "tree"), whole(z, "z", "tree")
    width, height = whole(width, "width", "tree"), whole(height, "height", "tree")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("tree() needs a number of plates for y")
    if width % 2 or not MIN_WIDTH <= width <= MAX_WIDTH:
        raise KitError(f"tree() width must be an even number from {MIN_WIDTH} to {MAX_WIDTH}")
    if not MIN_HEIGHT <= height <= MAX_HEIGHT:
        raise KitError(f"tree() height must be from {MIN_HEIGHT} to {MAX_HEIGHT} plates")
    look = STYLES[style]
    bark = look.bark if trunk is None else trunk
    green = look.leaves if leaves is None else leaves
    second = look.accent if accent is None else accent
    tones = [bark, bark] if look.bare else [green, green if second is None else second]
    placed: list[int] = []
    level = y

    if look.trunk:
        courses = max(1, round((height - canopy_height(style, width) - BRICK) / BRICK))
        round_trunk = stocked(kit, TRUNK, bark)
        for _ in range(courses):
            if round_trunk is None:
                placed += kit.fill(rect(x, z, x + 2, z + 2), level, brick_color(kit, bark, "tree"))
            else:
                placed.append(kit.place(TRUNK, round_trunk, x, level, z))
            level += BRICK

    plan = canopy_plan(style, width)
    bricks = 0
    for number, (kind, size) in enumerate(plan):
        x0, z0 = x + 1 - size // 2, z + 1 - size // 2
        if kind == "strips":
            placed += _strips(kit, x0, level, z0, size, tones[0], along_x=number % 2 == 0)
            level += PLATE
            above = plan[number + 1] if number + 1 < len(plan) else None
            if look.ornaments and above is not None and above[1] < size:
                placed += _dots(kit, x0, level, z0, size, ORNAMENTS[number % len(ORNAMENTS)])
        else:
            placed += kit.fill(_ring(x0, z0, size, look.rounded), level, brick_color(kit, tones[bricks % 2], "tree"))
            bricks += 1
            level += BRICK
    last = plan[-1][1]
    if look.fruit is not None and last >= 4:
        placed += _dots(kit, x + 1 - last // 2, level, z + 1 - last // 2, last, look.fruit)
    if look.top is not None:
        top = stocked(kit, look.top, "Yellow" if look.ornaments else tones[0])
        if top is not None:
            placed.append(kit.place(look.top, top, x, level, z))
        else:
            placed += kit.fill(rect(x, z, x + 2, z + 2), level, brick_color(kit, tones[0], "tree", "plate"),
                               kind="plate")
    return placed


def _dots(kit: Kit, x0: int, level, z0: int, size: int, color) -> list[int]:
    """Round 1 x 1 plates on the four corner studs of a layer: fruit, or ornaments."""
    dot = stocked(kit, FRUIT, color)
    if dot is None:
        return []
    return [kit.place(FRUIT, dot, cx, level, cz) for cx in (x0, x0 + size - 1) for cz in (z0, z0 + size - 1)]


def _strips(kit: Kit, x0: int, level, z0: int, size: int, color, *, along_x: bool) -> list[int]:
    """A ``size`` x ``size`` square of 2-wide plates that each run the full width."""
    found = kit.plain_part("plate", 2, size, color)
    if found is None:
        raise KitError(f"tree() needs a 2 x {size} plate, and the catalog has none; choose a smaller width")
    part_id, code = found
    turned = round(kit.part(part_id).w) != (size if along_x else 2)
    return [kit.place(part_id, code, x0 + (0 if along_x else 2 * i), level, z0 + (2 * i if along_x else 0),
                      rot=90 if turned else 0) for i in range(size // 2)]


HELPER = Helper(
    name="tree", build=plant_tree,
    signature='tree(x, y, z, height=30, width=6, style="round", leaves=None, accent=None, trunk=None)',
    summary="A whole tree. (x, z) is the min corner of its 2 x 2 trunk and y its base, which must stand on studs. "
            "The canopy is `width` studs across (4, 6, 8 or 10), centered on the trunk, so keep that square clear "
            "above the trunk. `height` is the whole tree in plates. bush and hedge have no trunk: they sit on the "
            "ground and ignore `height`. `leaves`, `accent` (alternate layers) and `trunk` are colors; each style "
            "has its own defaults.",
    styles=tuple(STYLES),
)
