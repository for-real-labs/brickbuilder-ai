"""Ready-made trees for build scripts.

Models spent more turns on trees than on anything else: canopies built from loose leaf parts
collide or hang in the air. ``plant_tree`` builds one from layers that cannot do either.

Every layer rests on the studs of the layer below it:

* a **strip layer** is a square of 2-wide plates that each run the full width. It may be two studs
  wider than the layer under it, because every strip then still crosses that layer;
* a **brick layer** is a ring of bricks no wider than the strip layer under it, so every brick
  stands on studs.

The parts are plain plates and bricks plus a round trunk and a rounded top, and each is placed in
the stocked color closest to the one asked for, so a tree never uses a part that cannot be bought.
"""

from __future__ import annotations

from .kit import Kit, KitError, rect

STYLES = ("round", "pine", "bush")
MIN_WIDTH, MAX_WIDTH = 4, 10
MIN_HEIGHT, MAX_HEIGHT = 6, 90
TRUNK = "3941"  # round 2 x 2 brick
TOPS = {"round": "30367c", "bush": "30367c", "pine": "3942c"}  # dome top, cone
BRICK, PLATE = 3, 1


def canopy_plan(style: str, width: int) -> list[tuple[str, int]]:
    """Layers from the bottom up as (kind, width): 'strips' is one plate tall, 'bricks' is one brick tall."""
    grow = [("strips", size) for size in range(4, width + 1, 2)]
    if style == "bush":
        plan = [("bricks", width)]
    elif style == "pine":
        plan = grow + [("bricks", width)]
    else:
        plan = grow + [("bricks", width)] * (2 if width > 4 else 1)
    steps = range(width - 2, 3, -2)
    for size in (steps if style == "pine" else list(steps)[:2]):
        plan += [("strips", size), ("bricks", size)]
    if plan[-1][1] > 4:
        plan.append(("strips", plan[-1][1] - 2))  # a ring is hollow: close it so the top has studs under it
    return plan


def canopy_height(style: str, width: int) -> int:
    """Plates from the underside of the canopy to the base of its top piece."""
    return sum(PLATE if kind == "strips" else BRICK for kind, _ in canopy_plan(style, width))


def _whole(value, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise KitError(f"tree() needs a whole number for {name}")
    return int(value)


def _ring(x0: int, z0: int, size: int) -> set[tuple[int, int]]:
    """A square ring two studs thick with its corners cut, so the canopy reads as round."""
    cells = rect(x0, z0, x0 + size, z0 + size)
    if size >= 6:
        cells -= rect(x0 + 2, z0 + 2, x0 + size - 2, z0 + size - 2)
        cut = 2 if size >= 8 else 1
        for cx, cz in ((x0, z0), (x0 + size - 1, z0), (x0, z0 + size - 1), (x0 + size - 1, z0 + size - 1)):
            sx, sz = (1 if cx == x0 else -1), (1 if cz == z0 else -1)
            cells -= {(cx + sx * i, cz + sz * j) for i in range(cut) for j in range(cut) if i + j < cut}
    return cells


def plant_tree(kit: Kit, x, y, z, *, height=30, width=6, style="round", leaves="Green", accent=None,
               trunk="Reddish_Brown") -> list[int]:
    """Build a tree whose 2 x 2 trunk has its min corner at (x, z) and its base at ``y`` plates.

    The canopy is ``width`` studs across, centered on the trunk. ``height`` is the whole tree in
    plates; the trunk takes what the canopy leaves. A bush has no trunk and sits on the ground.
    """
    if style not in STYLES:
        raise KitError(f"tree() style must be one of {', '.join(STYLES)}")
    x, z, width, height = _whole(x, "x"), _whole(z, "z"), _whole(width, "width"), _whole(height, "height")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("tree() needs a number of plates for y")
    if width % 2 or not MIN_WIDTH <= width <= MAX_WIDTH:
        raise KitError(f"tree() width must be an even number from {MIN_WIDTH} to {MAX_WIDTH}")
    if not MIN_HEIGHT <= height <= MAX_HEIGHT:
        raise KitError(f"tree() height must be from {MIN_HEIGHT} to {MAX_HEIGHT} plates")
    tones = [leaves, leaves if accent is None else accent]
    placed: list[int] = []
    level = y

    if style != "bush":
        courses = max(1, round((height - canopy_height(style, width) - BRICK) / BRICK))
        stocked = _stocked(kit, TRUNK, trunk)
        for _ in range(courses):
            if stocked is None:
                placed += kit.fill(rect(x, z, x + 2, z + 2), level, _brick_color(kit, trunk))
            else:
                placed.append(kit.place(TRUNK, stocked, x, level, z))
            level += BRICK

    bricks = 0
    for number, (kind, size) in enumerate(canopy_plan(style, width)):
        x0, z0 = x + 1 - size // 2, z + 1 - size // 2
        if kind == "strips":
            placed += _strips(kit, x0, level, z0, size, tones[0], along_x=number % 2 == 0)
            level += PLATE
        else:
            placed += kit.fill(_ring(x0, z0, size), level, _brick_color(kit, tones[bricks % 2]))
            bricks += 1
            level += BRICK
    top = _stocked(kit, TOPS[style], tones[0])
    if top is not None:
        placed.append(kit.place(TOPS[style], top, x, level, z))
    else:
        placed += kit.fill(rect(x, z, x + 2, z + 2), level, _brick_color(kit, tones[0]), kind="plate")
    return placed


def _stocked(kit: Kit, part: str, color) -> int | None:
    try:
        return kit.stocked_color(part, color)
    except KitError:
        return None  # this parts library has no such part; the caller falls back to plain bricks


def _brick_color(kit: Kit, color) -> int:
    """The color bricks of this layer are laid in: the stocked 1 x 1 brick color closest to ``color``."""
    found = kit.plain_part("brick", 1, 1, color)
    if found is None:
        raise KitError("tree() needs 1 x 1 bricks, and the catalog has none")
    return found[1]


def _strips(kit: Kit, x0: int, level, z0: int, size: int, color, *, along_x: bool) -> list[int]:
    """A ``size`` x ``size`` square of 2-wide plates that each run the full width."""
    found = kit.plain_part("plate", 2, size, color)
    if found is None:
        raise KitError(f"tree() needs a 2 x {size} plate, and the catalog has none; choose a smaller width")
    part_id, code = found
    turned = round(kit.part(part_id).w) != (size if along_x else 2)
    return [kit.place(part_id, code, x0 + (0 if along_x else 2 * i), level, z0 + (2 * i if along_x else 0),
                      rot=90 if turned else 0) for i in range(size // 2)]
