"""Ready-made roofs.

Roof slopes running into each other were the one kind of overlap the automatic repair cannot fix,
and a roof whose courses are not each seated on the one below falls apart. Three constructions
cover every style here, and each keeps every part on studs:

* **pitched**: courses of slope bricks. A slope has studs only on its high row, and the next course
  starts on that row, so each course carries the next. The end walls are filled in as it rises, and
  the ridge is closed with a ridge part or with plates that reach from one stud row to the other.
* **hipped**: the same courses as rings, with a corner slope at each corner.
* **flat and stepped**: plates that each span from wall to wall, with whatever stands on them.

A roof covers a rectangle and rests on the walls under its edge.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..kit import Kit, KitError
from .common import (BRICK, Frame, Helper, brick_color, bridge, choice, column, local_rect, stocked, tiles,
                     whole)


@dataclass(frozen=True)
class Family:
    """Slope bricks of one pitch, by length along the eave."""

    parts: dict[int, str]
    ridge: dict[int, str] = field(default_factory=dict)  # double-sided parts that close a 2-wide ridge
    corner: str | None = None  # convex corner, for hipped roofs


FAMILIES = {
    "18": Family({1: "60477", 2: "30363"}),
    "33": Family({1: "4286", 2: "3298", 3: "4161", 4: "3297"}, {2: "3300", 4: "3299"}, "3675"),
    "45": Family({1: "3040b", 2: "3039", 3: "3038", 4: "3037", 6: "23949", 8: "4445"},
                 {1: "3044c", 2: "3043", 4: "3041"}, "3045"),
    "65": Family({1: "60481a", 2: "3678b"}),
    "75": Family({1: "4460b", 2: "3684c"}, corner="3685"),
    "curved": Family({1: "33243"}),
}


@dataclass(frozen=True)
class RoofStyle:
    kind: str  # pitched | shed | hip | flat | stepped
    front: tuple[str, ...] = ()  # slope family of each course from the eave up; the last one repeats
    back: tuple[str, ...] = ()
    courses: int | None = None  # stop the slopes after this many courses and close the top flat
    finish: str = ""  # what stands on a flat roof
    color: str = "Dark_Bluish_Grey"
    trim: str | None = None


STYLES: dict[str, RoofStyle] = {
    "gable": RoofStyle("pitched", ("45",), ("45",)),
    "steep_gable": RoofStyle("pitched", ("65",), ("65",)),
    "a_frame": RoofStyle("pitched", ("75",), ("75",), color="Reddish_Brown"),
    "low_gable": RoofStyle("pitched", ("33",), ("33",)),
    "shallow_gable": RoofStyle("pitched", ("18",), ("18",)),
    "curved": RoofStyle("pitched", ("curved",), ("curved",)),
    "saltbox": RoofStyle("pitched", ("33",), ("45",)),
    "gambrel": RoofStyle("pitched", ("65", "45"), ("65", "45")),
    "barn": RoofStyle("pitched", ("75", "33"), ("75", "33"), color="Dark_Red", trim="White"),
    "mansard": RoofStyle("pitched", ("65",), ("65",), courses=1),
    "shed": RoofStyle("shed", ("45",)),
    "steep_shed": RoofStyle("shed", ("65",)),
    "low_shed": RoofStyle("shed", ("33",)),
    "hip": RoofStyle("hip", ("45",)),
    "low_hip": RoofStyle("hip", ("33",)),
    "spire": RoofStyle("hip", ("75",)),
    "flat": RoofStyle("flat"),
    "tiled": RoofStyle("flat", finish="tiles"),
    "parapet": RoofStyle("flat", finish="parapet", color="Light_Bluish_Grey"),
    "terrace": RoofStyle("flat", finish="terrace", color="Light_Bluish_Grey", trim="Tan"),
    "crenellated": RoofStyle("flat", finish="crenellated", color="Light_Bluish_Grey"),
    "garden": RoofStyle("flat", finish="garden", color="Green", trim="Bright_Green"),
    "solar": RoofStyle("flat", finish="solar", color="Light_Bluish_Grey", trim="Dark_Blue"),
    "deck": RoofStyle("flat", finish="tiles", color="Reddish_Brown", trim="Reddish_Brown"),
    "stepped": RoofStyle("stepped"),
    "pagoda": RoofStyle("stepped", finish="eaves", color="Dark_Red", trim="Tan"),
}


class _Slopes:
    """One slope family in one color: the lengths that are stocked in it, and how they stack."""

    def __init__(self, kit: Kit, name: str, color):
        family = FAMILIES[name]
        base = next((part for part in (family.parts.get(2), family.parts.get(1)) if part and kit.has_part(part)), None)
        if base is None:
            raise KitError(f"roof() cannot build this style here: the catalog has no {name} degree slopes")
        self.kit, self.family = kit, family
        self.color = kit.stocked_color(base, color)
        self.lengths = {length: part for length, part in family.parts.items()
                        if stocked(kit, part, self.color) == self.color}
        if 1 not in self.lengths and 2 not in self.lengths:
            raise KitError("roof() cannot build this style in that color")
        sample = self.lengths[min(self.lengths)]
        _, _, self.run, self.rise = kit.measure(sample, facing="front")
        self.run, self.rise = int(round(self.run)), int(round(self.rise))
        self.step = self.run - 1  # the next course starts on this one's single row of studs
        self.ridge = {length: part for length, part in family.ridge.items()
                      if stocked(kit, part, self.color) == self.color}

    def row(self, frame: Frame, ly, lz, start: int, end: int, facing: str, shift: bool) -> list[int]:
        """A row of slopes covering local columns [start, end), low edge towards ``facing``."""
        placed, at = [], start
        along_x = facing in ("front", "back")
        sizes = sorted(self.lengths, reverse=True)
        first = next((size for size in (2, 1, 3) if size in self.lengths and size < end - start), None) if shift else None
        while at < end:
            size = first if first else next((s for s in sizes if s <= end - at), None)
            first = None
            if size is None:
                raise KitError("roof() cannot fit slopes of this style to that size; change the size by one stud")
            where = (at, lz) if along_x else (lz, at)
            placed.append(frame.place(self.lengths[size], self.color, where[0], ly, where[1], facing=facing))
            at += size
        return placed


def _deck(frame: Frame, x0: int, z0: int, x1: int, z1: int, ly, color) -> list[int]:
    try:
        return bridge(frame, x0, z0, x1, z1, ly, color, "roof")
    except KitError as error:
        if "bridge" in str(error):
            raise KitError(f"{error}. Make the roof narrower or use a pitched style") from None
        raise


def _tiles(frame: Frame, cells, ly, color) -> list[int]:
    return tiles(frame, cells, ly, color, "roof")


def _pitched(frame: Frame, wide: int, deep: int, look: RoofStyle, color, trim, gable) -> list[int]:
    kit = frame.kit
    placed: list[int] = []
    shed = look.kind == "shed"
    near, far, level, course = 0, deep, 0, 0  # the next front slope starts at ``near``; the next back one ends at ``far``
    slopes: dict[str, _Slopes] = {}

    def family(names, index):
        name = names[min(index, len(names) - 1)]
        if name not in slopes:
            slopes[name] = _Slopes(kit, name, color)
        return slopes[name]

    while look.courses is None or course < look.courses:
        front = family(look.front, course)
        back = None if shed else family(look.back, course)
        room = far - near - front.run - (1 if shed else back.run)
        if room < 0 or (back is not None and back.rise != front.rise):
            break
        placed += front.row(frame, level, near, 0, wide, "front", course % 2 == 1)
        inner_end = far - 1 if shed else far - back.run
        if back is not None:
            placed += back.row(frame, level, far - back.run, 0, wide, "back", course % 2 == 1)
        else:  # a shed roof leans on a back wall that rises with it
            placed += column(frame, local_rect(0, far - 1, wide, far), level, front.rise, gable, "roof")
        ends = local_rect(0, near + front.run, 1, inner_end) | local_rect(wide - 1, near + front.run, wide, inner_end)
        if ends:
            placed += column(frame, ends, level, front.rise, gable, "roof")
        near += front.step
        far -= 0 if shed else back.step
        level += front.rise
        course += 1
    if course == 0:
        raise KitError("roof() needs more depth for this style: the slopes do not fit across it")

    gap = far - near  # from the front stud row to the back one (or to the back wall)
    last = slopes[look.front[min(course - 1, len(look.front) - 1)]]
    same_pitch = not shed and look.front[-1] == look.back[-1]
    if gap == 2 and same_pitch and look.courses is None:
        sizes, at, ridge = sorted(last.ridge, reverse=True), 0, []
        while at < wide and (size := next((s for s in sizes if s <= wide - at), None)):
            ridge.append((at, size))
            at += size
        if at == wide:  # ridge parts reach the whole way; otherwise the ridge is closed with plates
            for start, size in ridge:
                part = last.ridge[size]
                turned = round(kit.part(part).w) != size
                placed.append(frame.place(part, last.color, start, level, near, rot=90 if turned else 0))
            return placed
    placed += _deck(frame, 0, near, wide, far, level, color if trim is None else trim)
    placed += _tiles(frame, local_rect(0, near, wide, far), level + 1, color if trim is None else trim)
    return placed


def _hip(frame: Frame, wide: int, deep: int, look: RoofStyle, color, trim) -> list[int]:
    kit = frame.kit
    slopes = _Slopes(kit, look.front[0], color)
    corner = slopes.family.corner
    if corner is None or stocked(kit, corner, slopes.color) is None:
        raise KitError("roof() cannot build a hipped roof of this pitch here: the catalog has no corner slope for it")
    corner_color = kit.stocked_color(corner, slopes.color)
    run = slopes.run
    stud = kit.part(corner).studs[0]
    high = (int(stud[0]), int(stud[1]))  # the corner part's own high cell at rot=0

    def turned(cell, quarter):
        for _ in range(quarter):
            cell = (cell[1], run - 1 - cell[0])
        return cell

    placed, inset, level, course = [], 0, 0, 0
    while 2 * (inset + run) <= min(wide, deep):
        x1, z1 = wide - inset - run, deep - inset - run
        for lx, lz, inner in ((inset, inset, (run - 1, run - 1)), (x1, inset, (0, run - 1)),
                              (inset, z1, (run - 1, 0)), (x1, z1, (0, 0))):
            quarter = next(q for q in range(4) if turned(high, q) == inner)
            placed.append(frame.place(corner, corner_color, lx, level, lz, rot=90 * quarter))
        shift = course % 2 == 1
        placed += slopes.row(frame, level, inset, inset + run, x1, "front", shift)
        placed += slopes.row(frame, level, z1, inset + run, x1, "back", shift)
        placed += slopes.row(frame, level, inset, inset + run, z1, "left", shift)
        placed += slopes.row(frame, level, x1, inset + run, z1, "right", shift)
        inset += slopes.step
        level += slopes.rise
        course += 1
    if course == 0:
        raise KitError("roof() needs a larger footprint for a hipped roof of this pitch")
    top = color if trim is None else trim
    placed += _deck(frame, inset, inset, wide - inset, deep - inset, level, top)
    placed += _tiles(frame, local_rect(inset, inset, wide - inset, deep - inset), level + 1, top)
    return placed


def _border(x0: int, z0: int, x1: int, z1: int, thick: int = 1) -> set[tuple[int, int]]:
    return local_rect(x0, z0, x1, z1) - local_rect(x0 + thick, z0 + thick, x1 - thick, z1 - thick)


def _flat(frame: Frame, wide: int, deep: int, look: RoofStyle, color, trim) -> list[int]:
    kit = frame.kit
    second = color if trim is None else trim
    placed = _deck(frame, 0, 0, wide, deep, 0, color)
    whole_roof, edge = local_rect(0, 0, wide, deep), _border(0, 0, wide, deep)
    finish = look.finish
    if finish == "tiles":
        placed += _tiles(frame, whole_roof, 1, second)
    elif finish in ("parapet", "terrace", "crenellated"):
        placed += frame.fill(edge, 1, brick_color(kit, color, "roof"))
        if finish == "parapet":
            placed += _tiles(frame, edge, 4, second)
        elif finish == "terrace":
            placed += _tiles(frame, whole_roof - edge, 1, second)
            placed += _tiles(frame, edge, 4, color)
        else:
            merlons = {cell for cell in edge if (cell[0] + cell[1]) % 2 == 0}
            placed += frame.fill(merlons, 4, brick_color(kit, color, "roof"), bond=False)
    elif finish == "garden":
        beds = {cell for cell in whole_roof - edge if (cell[0] * 7 + cell[1] * 3) % 5 == 0}
        leaf = stocked(kit, "4073", second)
        if leaf is not None:
            placed += [frame.place("4073", leaf, lx, 1, lz) for lx, lz in sorted(beds)]
        placed += _tiles(frame, edge, 1, "Light_Bluish_Grey")
    elif finish == "solar":
        panels = {cell for cell in whole_roof - edge if cell[0] % 5 != 0 and cell[1] % 3 != 0}
        placed += _tiles(frame, panels, 1, second)
    return placed


def _stepped(frame: Frame, wide: int, deep: int, look: RoofStyle, color, trim) -> list[int]:
    kit = frame.kit
    eaves = look.finish == "eaves"
    wall = brick_color(kit, color if trim is None else trim, "roof")
    step = 2 if eaves else 1
    placed, inset, level = [], 0, 0
    while True:
        out = inset - 1 if eaves else inset  # a pagoda's deck overhangs the walls under it by a stud
        placed += _deck(frame, out, out, wide - out, deep - out, level, color)
        level += 1
        body = inset + (1 if eaves else 0)
        if min(wide, deep) - 2 * (body + step) < 2:
            placed += _tiles(frame, local_rect(out, out, wide - out, deep - out), level, color)
            return placed
        placed += frame.fill(_border(body, body, wide - body, deep - body, 2), level,
                             wall if eaves else brick_color(kit, color, "roof"))
        level += BRICK
        inset += step


def build_roof(kit: Kit, x, y, z, width, depth, style="gable", color=None, trim=None, facing="front",
               gable=None) -> list[int]:
    """A roof over the rectangle whose min corner is (x, z), ``width`` studs along x and ``depth`` along z."""
    look = STYLES[choice(style, STYLES, "style", "roof")]
    x, z = whole(x, "x", "roof"), whole(z, "z", "roof")
    width, depth = whole(width, "width", "roof", 4, 64), whole(depth, "depth", "roof", 4, 64)
    choice(facing, ("front", "back", "left", "right"), "facing", "roof")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("roof() needs a number of plates for y")
    color = look.color if color is None else color
    trim = look.trim if trim is None else trim
    sideways = facing in ("left", "right")
    wide, deep = (depth, width) if sideways else (width, depth)  # local: along the eave, and across it
    frame = Frame(kit, x, y, z, wide, deep, facing)
    if look.kind in ("pitched", "shed"):
        return _pitched(frame, wide, deep, look, color, trim, color if gable is None else gable)
    if look.kind == "hip":
        return _hip(frame, wide, deep, look, color, trim)
    if look.kind == "flat":
        return _flat(frame, wide, deep, look, color, trim)
    return _stepped(frame, wide, deep, look, color, trim)


HELPER = Helper(
    name="roof", build=build_roof,
    signature='roof(x, y, z, width, depth, style="gable", color=None, trim=None, facing="front", gable=None)',
    summary="A whole roof over the rectangle with min corner (x, z), `width` studs along x and `depth` along z, "
            "its base at y. It rests on the walls under its edge, so put it on a ring of wall of that size. "
            "`facing` is the side a pitched roof slopes down to (its ridge runs across that); a shed roof is low on "
            "that side. `color` is the roofing, `trim` the ridge or the second color, `gable` the end walls a "
            "pitched roof fills in. A flat or stepped style can span at most 16 studs on its shorter side.",
    styles=tuple(STYLES),
)
