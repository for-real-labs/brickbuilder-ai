"""Ready-made stairs.

Loose steps were the error that most often kept a build from finishing: a step set beside the
last one is attached to nothing. Here every step is a column that stands on the ground, so each
is attached on its own, and anything laid across (a tread, a landing) reaches from one support to
another.

Stairs climb away from their front edge. They take ``width`` studs across and as many studs of
depth as their steps need: the number of steps times the style's tread.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import ceil

from ..kit import Kit, KitError
from .common import (BRICK, Frame, Helper, brick_color, bridge, choice, column, lay, local_rect, need, stocked,
                     tiles, whole)
from .roofs import _Slopes

PREFAB = "30134"
LADDER, RUNG = "4175", 6  # a 1 x 2 plate with a ladder hanging from it, and the plates one climbs
POST, CAP = "3062b", "4073"  # round 1 x 1 brick, round 1 x 1 plate


@dataclass(frozen=True)
class StairStyle:
    tread: int = 2  # studs deep per step
    riser: int = 3  # plates up per step
    kind: str = "solid"  # solid | open | floating | ramp | prefab | ladder
    finish: str = ""  # tiles | carpet | posts | walls
    landing: int = 0  # studs of flat platform at the top
    color: str = "Light_Bluish_Grey"
    trim: str | None = None
    pitch: str = "33"  # slope family of a ramp


STYLES: dict[str, StairStyle] = {
    "brick": StairStyle(),
    "steep": StairStyle(tread=1),
    "shallow": StairStyle(riser=2),
    "gentle": StairStyle(riser=1),
    "porch": StairStyle(riser=2, landing=2, color="White"),
    "tiled": StairStyle(finish="tiles", trim="Dark_Bluish_Grey"),
    "stone": StairStyle(finish="tiles", color="Dark_Bluish_Grey", trim="Light_Bluish_Grey"),
    "grand": StairStyle(tread=3, finish="walls", color="White", trim="Tan"),
    "carpet": StairStyle(finish="carpet", color="White", trim="Red"),
    "garden": StairStyle(riser=1, finish="tiles", color="Dark_Tan", trim="Tan"),
    "wooden": StairStyle(kind="open", color="Reddish_Brown"),
    "open": StairStyle(kind="open"),
    "floating": StairStyle(kind="floating", color="White", trim="Dark_Bluish_Grey"),
    "posts": StairStyle(finish="posts", trim="White"),
    "walled": StairStyle(finish="walls"),
    "stoop": StairStyle(finish="walls", landing=2, color="Tan", trim="Dark_Tan"),
    "landing": StairStyle(landing=3),
    "ramp": StairStyle(kind="ramp", pitch="33"),
    "steep_ramp": StairStyle(kind="ramp", pitch="45"),
    "narrow": StairStyle(tread=1, riser=2),
    "prefab": StairStyle(kind="prefab", color="Light_Bluish_Grey"),
    "ladder": StairStyle(kind="ladder", color="Light_Bluish_Grey", trim="Black"),
}


def footprint(style: str, rise: int) -> tuple[int, int]:
    """(steps, studs of depth) a style needs to climb ``rise`` plates."""
    look = STYLES[style]
    if look.kind == "prefab":
        return 1, 7
    if look.kind == "ladder":
        return max(1, ceil(rise / RUNG)), 2
    if look.kind == "ramp":
        steps = max(1, ceil(rise / BRICK))
        return steps, (steps - 1) * (2 if look.pitch == "33" else 1) + (3 if look.pitch == "33" else 2)
    steps = max(1, ceil(rise / look.riser))
    return steps, steps * look.tread + look.landing


def build_stairs(kit: Kit, x, y, z, width=4, rise=9, style="brick", color=None, trim=None,
                 facing="front") -> list[int]:
    """Stairs whose footprint has its min corner at (x, z), climbing ``rise`` plates away from ``facing``."""
    look = STYLES[choice(style, STYLES, "style", "stairs")]
    x, z = whole(x, "x", "stairs"), whole(z, "z", "stairs")
    width, rise = whole(width, "width", "stairs", 1, 16), whole(rise, "rise", "stairs", 1, 120)
    choice(facing, ("front", "back", "left", "right"), "facing", "stairs")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("stairs() needs a number of plates for y")
    color = look.color if color is None else color
    trim = (look.trim or color) if trim is None else trim
    steps, deep = footprint(style, rise)
    if look.kind == "prefab":
        width = 4
    if look.kind == "ladder":
        width = 2
    frame = Frame(kit, x, y, z, width, deep, facing)
    if look.kind == "prefab":
        part, code = need(kit, PREFAB, color, "stairs", "staircase part")
        return [frame.place(part, code, 0, 0, 0, facing="front")]
    if look.kind == "ramp":
        return _ramp(frame, width, deep, steps, look, color)
    if look.kind == "ladder":
        return _ladder(frame, steps, color, trim)

    heights = [max(1, round(rise * (step + 1) / steps)) for step in range(steps)]
    placed: list[int] = []
    sides = local_rect(0, 0, 1, deep) | local_rect(width - 1, 0, width, deep)
    for step, high in enumerate(heights):
        tread = local_rect(0, step * look.tread, width, (step + 1) * look.tread)
        z0, z1 = step * look.tread, (step + 1) * look.tread
        if look.kind == "open" and width >= 3:
            placed += column(frame, tread & sides, 0, high - 1, color, "stairs")
            placed += bridge(frame, 0, z0, width, z1, high - 1, color, "stairs", across="x")
        elif look.kind == "floating" and width >= 4 and width % 2 == 0:
            spine = local_rect(width // 2 - 1, z0, width // 2 + 1, z1)
            placed += column(frame, spine, 0, high - 1, trim, "stairs")
            placed += _halves(frame, width, z0, z1, high - 1, color)
        else:
            placed += column(frame, tread, 0, high, color, "stairs")
            placed += _finish(frame, look, tread, sides, width, high, color, trim)
    if look.landing:
        top = heights[-1]
        deck = local_rect(0, steps * look.tread, width, deep)
        placed += column(frame, deck, 0, top, color, "stairs")
        placed += _finish(frame, look, deck, sides, width, top, color, trim)
    return placed


def _finish(frame: Frame, look: StairStyle, tread, sides, width: int, high: int, color, trim) -> list[int]:
    kit = frame.kit
    if look.finish == "tiles":
        return tiles(frame, tread, high, trim, "stairs")
    if look.finish == "carpet" and width >= 3:
        return tiles(frame, tread - sides, high, trim, "stairs") + tiles(frame, tread & sides, high, color, "stairs")
    if look.finish == "walls" and width >= 3:
        placed = frame.fill(tread & sides, high, brick_color(kit, color, "stairs"))
        placed += tiles(frame, tread & sides, high + BRICK, trim, "stairs")
        return placed + tiles(frame, tread - sides, high, trim, "stairs")
    if look.finish == "posts" and width >= 3:
        post, cap = stocked(kit, POST, trim), stocked(kit, CAP, trim)
        if post is None:
            return []
        placed = []
        lz = min(cell[1] for cell in tread)
        for lx in (0, width - 1):
            placed += [frame.place(POST, post, lx, high + BRICK * level, lz) for level in range(2)]
            if cap is not None:
                placed.append(frame.place(CAP, cap, lx, high + 2 * BRICK, lz))
        return placed
    return []


def _halves(frame: Frame, width: int, z0: int, z1: int, ly, color) -> list[int]:
    """Treads for a floating stair: each plate reaches the spine in the middle."""
    kit = frame.kit
    code = brick_color(kit, color, "stairs", "plate")
    placed = []
    for lz in range(z0, z1):
        whole_tread = kit.plain_part("plate", 1, width, code)
        if whole_tread is not None:
            placed.append(lay(frame, whole_tread[0], code, 0, ly, lz, width))
            continue
        half = kit.plain_part("plate", 1, width // 2, code)
        if half is None:
            raise KitError("stairs() cannot make floating treads this wide; choose another width or style")
        placed += [lay(frame, half[0], code, lx, ly, lz, width // 2) for lx in (0, width // 2)]
    return placed


def _ladder(frame: Frame, lengths: int, color, trim) -> list[int]:
    """A post with ladder lengths hung on its front. Each length's plate lies on the post and carries the next."""
    kit = frame.kit
    part, code = need(kit, LADDER, trim, "stairs", "ladder part")
    info = kit.part(part)
    back = min(stud[1] for stud in info.studs) - 0.5  # how far the ladder hangs in front of its plate
    placed: list[int] = []
    for number in range(lengths):
        base = number * RUNG
        placed += column(frame, local_rect(0, 1, 2, 2), base, RUNG - 1, color, "stairs")
        # The ladder hangs flush against the post. The checks model it a little thicker than it is, so
        # the fit is declared.
        placed.append(frame.place(part, code, 0, base, 1 - back, allow_overlap=True))
    return placed


def _ramp(frame: Frame, width: int, deep: int, steps: int, look: StairStyle, color) -> list[int]:
    slopes = _Slopes(frame.kit, look.pitch, color)
    placed = []
    for step in range(steps):
        near = step * slopes.step
        placed += slopes.row(frame, step * BRICK, near, 0, width, "front", step % 2 == 1)
        behind = local_rect(0, near + slopes.run, width, deep)
        if behind:
            placed += frame.fill(behind, step * BRICK, brick_color(frame.kit, color, "stairs"))
    return placed


HELPER = Helper(
    name="stairs", build=build_stairs,
    signature='stairs(x, y, z, width=4, rise=9, style="brick", color=None, trim=None, facing="front")',
    summary="Steps that climb `rise` plates, starting low at the `facing` side and rising away from it. (x, z) is "
            "the min corner of the whole footprint and y its base, which must stand on studs. The footprint is "
            "`width` studs across and (steps x tread) studs deep, where steps = rise / riser rounded up; the note "
            "after each style gives its tread and riser. Leave that footprint clear.",
    styles=tuple(STYLES),
    notes={name: (f"tread {look.tread}, riser {look.riser}" + (f", +{look.landing} landing" if look.landing else "")
                  if look.kind in ("solid", "open", "floating") else
                  {"ramp": "smooth slope, 1 brick up per 2 studs" if look.pitch == "33" else
                           "smooth slope, 1 brick up per stud",
                   "prefab": "one part: 4 wide, 7 deep, 18 up",
                   "ladder": "upright on a post: 2 wide, 2 deep, 6 up per length"}[look.kind])
           for name, look in STYLES.items()},
)
