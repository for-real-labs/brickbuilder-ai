"""Ready-made walls with openings.

A wall is a straight run one stud thick, laid in bonded courses. Its styles are surface
treatments: bands, a plinth, masonry or log bricks, timber framing. The part that goes wrong
when a script does it by hand is the opening: the course above a window or door must be one
piece that reaches the wall on both sides, or what is over the opening hangs in the air. Each
opening here gets such a lintel.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..kit import Kit, KitError
from .common import BRICK, Frame, Helper, brick_color, choice, lay, local_rect, runs, stocked, tiles, whole

ROUND = "3062b"


@dataclass(frozen=True)
class WallStyle:
    pattern: str = "plain"  # how color and trim are laid out over the courses
    bricks: tuple[tuple[int, str], ...] = ()  # (length, part) of a special brick, longest first
    top: str = ""  # tiles | merlons | cornice
    color: str = "White"
    trim: str | None = None


STYLES: dict[str, WallStyle] = {
    "plain": WallStyle(),
    "banded": WallStyle("banded", color="Tan", trim="Dark_Tan"),
    "striped": WallStyle("striped", color="White", trim="Red"),
    "base": WallStyle("base", color="White", trim="Dark_Bluish_Grey"),
    "wainscot": WallStyle("wainscot", color="White", trim="Reddish_Brown"),
    "crown": WallStyle("crown", color="Tan", trim="White"),
    "masonry": WallStyle(bricks=((4, "15533"), (2, "98283")), color="Light_Bluish_Grey"),
    "brickwork": WallStyle(bricks=((4, "15533"), (2, "98283")), color="Dark_Red"),
    "log": WallStyle(bricks=((4, "30137"), (2, "30136")), color="Reddish_Brown"),
    "siding": WallStyle(bricks=((2, "2877"),), color="Sand_Blue"),
    "corrugated": WallStyle(bricks=((2, "2877"),), color="Light_Bluish_Grey"),
    "stone": WallStyle("stone", color="Light_Bluish_Grey", trim="Dark_Bluish_Grey"),
    "checker": WallStyle("checker", color="White", trim="Black"),
    "timber": WallStyle("timber", color="White", trim="Reddish_Brown"),
    "quoins": WallStyle("quoins", color="Tan", trim="White"),
    "pilasters": WallStyle("pilasters", color="Tan", trim="White"),
    "castle": WallStyle(top="merlons", color="Light_Bluish_Grey"),
    "capped": WallStyle(top="tiles", color="Light_Bluish_Grey", trim="Dark_Bluish_Grey"),
    "cornice": WallStyle(top="cornice", color="Tan", trim="White"),
    "glass": WallStyle(color="Trans_Clear"),
}


def _openings(openings, length: int, height: int) -> list[tuple[int, int, int, int]]:
    out = []
    if not isinstance(openings, (list, tuple)):
        raise KitError("wall() openings must be a list of (offset, base, width, height)")
    for opening in openings:
        if not isinstance(opening, (list, tuple)) or len(opening) != 4:
            raise KitError("wall() each opening is (offset, base, width, height): studs along the wall, plates up")
        offset, base, wide, tall = (whole(value, name, "wall") for value, name in
                                    zip(opening, ("opening offset", "opening base", "opening width", "opening height")))
        if offset < 0 or wide < 1 or offset + wide > length or base < 0 or tall < 1 or base + tall > height:
            raise KitError("wall() an opening must lie inside the wall")
        out.append((offset, base, wide, tall))
    return out


def _shade(look: WallStyle, lx: int, course: int, courses: int, length: int) -> bool:
    """Whether this cell of this course is laid in the trim color."""
    pattern = look.pattern
    if pattern == "banded":
        return course % 3 == 2
    if pattern == "striped":
        return course % 2 == 1
    if pattern == "base":
        return course == 0
    if pattern == "wainscot":
        return course < max(1, courses // 3)
    if pattern == "crown":
        return course == courses - 1
    if pattern == "stone":
        return (lx * 7 + course * 13 + (lx // 3) * 5) % 4 == 0
    if pattern == "checker":
        return (lx // 2 + course) % 2 == 1
    if pattern == "timber":
        return lx % 4 == 0 or lx == length - 1 or course == courses - 1
    if pattern == "quoins":
        return lx < (2 if course % 2 == 0 else 1) or lx >= length - (2 if course % 2 == 0 else 1)
    if pattern == "pilasters":
        return lx % 4 == 0 or lx == length - 1
    return False


def build_wall(kit: Kit, x, y, z, length, height, style="plain", color=None, trim=None, facing="front",
               openings=()) -> list[int]:
    """A wall ``length`` studs long and ``height`` plates tall from (x, z), with window and door openings."""
    look = STYLES[choice(style, STYLES, "style", "wall")]
    x, z = whole(x, "x", "wall"), whole(z, "z", "wall")
    length, height = whole(length, "length", "wall", 1, 200), whole(height, "height", "wall", 3, 300)
    choice(facing, ("front", "back", "left", "right"), "facing", "wall")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("wall() needs a number of plates for y")
    color = look.color if color is None else color
    trim = (look.trim or color) if trim is None else trim
    holes = _openings(openings, length, height)
    frame = Frame(kit, x, y, z, length, 1, facing)
    main, second = brick_color(kit, color, "wall"), brick_color(kit, trim, "wall")
    special = [(size, part, stocked(kit, part, color)) for size, part in look.bricks]
    special = [(size, part, code) for size, part, code in special if code is not None]
    post = stocked(kit, ROUND, trim) if look.pattern == "pilasters" else None
    courses = height // BRICK
    placed: list[int] = []

    for course in range(courses):
        low, high = course * BRICK, (course + 1) * BRICK
        open_cells: set[int] = set()
        lintels: list[tuple[int, int]] = []
        for offset, base, wide, tall in holes:
            if base < high and base + tall > low:
                open_cells |= set(range(offset, offset + wide))
            elif base + tall > low - BRICK and base + tall <= low:  # the first course wholly above this opening
                lintels.append((offset, wide))
        solid = set(range(length)) - open_cells
        for offset, wide in lintels:
            start, size = _lintel(kit, offset, wide, length, main, solid)
            if size:
                placed.append(lay(frame, kit.plain_part("brick", 1, size, main)[0], main, start, low, 0, size))
                solid -= set(range(start, start + size))
                continue
            # No single brick fits (a neighbor is in the way, or the wall ends here): laminate plates instead.
            over = set(range(offset, offset + wide)) & solid
            left, right = offset - 1 in solid, offset + wide in solid
            if over and (left or right):
                first, last = min(over) - int(left), max(over) + 1 + int(right)
                placed += _laminate(frame, first, last, low, color, right)
                solid -= set(range(first, last))
        # A partial course under an opening that does not end on a course line is made up with plates.
        for offset, base, wide, tall in holes:
            if low < base + tall < high and base < high:
                gap = high - (base + tall)
                placed += frame.fill(local_rect(offset, 0, offset + wide, 1), base + tall,
                                     brick_color(kit, color, "wall", "plate"), kind="plate", layers=gap)
            if low < base < high:
                placed += frame.fill(local_rect(offset, 0, offset + wide, 1), low,
                                     brick_color(kit, color, "wall", "plate"), kind="plate", layers=base - low)
        trimmed = {lx for lx in solid if _shade(look, lx, course, courses, length)}
        if post is not None:
            placed += [frame.place(ROUND, post, lx, low, 0) for lx in sorted(trimmed)]
        elif trimmed:
            placed += frame.fill({(lx, 0) for lx in trimmed}, low, second, bond=False)
        body = solid - trimmed
        if special:
            for start, end in runs(body):
                at = start + (1 if course % 2 and end - start > 2 else 0)
                if at > start:
                    placed += frame.fill({(start, 0)}, low, main)
                while at < end:
                    fit = next(((size, part, code) for size, part, code in special if size <= end - at), None)
                    if fit is None:
                        placed += frame.fill({(lx, 0) for lx in range(at, end)}, low, main, bond=False)
                        break
                    placed.append(lay(frame, fit[1], fit[2], at, low, 0, fit[0]))
                    at += fit[0]
        elif body:
            cells = {(lx, 0) for lx in body}
            # Seams shift by a stud on alternate courses so the wall bonds.
            placed += frame.kit.fill(frame.cells(cells), frame.y + low, main)
    top = courses * BRICK
    rest = height - top
    solid_top = local_rect(0, 0, length, 1)
    for offset, base, wide, tall in holes:
        if base + tall >= top:
            solid_top -= local_rect(offset, 0, offset + wide, 1)
    if rest:
        placed += frame.fill(solid_top, top, brick_color(kit, color, "wall", "plate"), kind="plate", layers=rest)
        top += rest
    if look.top == "tiles":
        placed += tiles(frame, solid_top, top, trim, "wall")
    elif look.top == "merlons":
        placed += frame.fill({cell for cell in solid_top if cell[0] % 2 == 0}, top, main, bond=False)
    elif look.top == "cornice" and solid_top == local_rect(0, 0, length, 1):
        code = brick_color(kit, trim, "wall", "plate")
        at = 0
        while at < length:
            size = next(s for s in (8, 6, 4, 3, 2, 1) if s <= length - at and kit.plain_part("plate", 2, s, code))
            part = kit.plain_part("plate", 2, size, code)[0]
            turned = round(kit.measure(part)[1]) != size
            placed.append(frame.place(part, code, at, top, -1, rot=90 if turned else 0))
            at += size
        placed += tiles(frame, local_rect(0, -1, length, 1), top + 1, trim, "wall")
    return placed


def _laminate(frame: Frame, first: int, last: int, low: int, color, right: bool) -> list[int]:
    """A lintel one brick tall made of three layers of plates whose joints never line up.

    Each layer is one long plate and a short one. The long plate lies against the supported end on
    the first and third layers and against the other end on the second, so the layers tie together.
    """
    kit = frame.kit
    code = brick_color(kit, color, "wall", "plate")
    span = last - first
    long = next((size for size in range(span, 0, -1) if kit.plain_part("plate", 1, size, code)), 1)
    placed = []
    for layer in range(BRICK):
        at_end = right if layer % 2 == 0 else not right
        start = last - long if at_end else first
        placed.append(lay(frame, kit.plain_part("plate", 1, long, code)[0], code, start, low + layer, 0, long))
        rest = set(range(first, last)) - set(range(start, start + long))
        if rest:
            placed += frame.fill({(lx, 0) for lx in rest}, low + layer, code, kind="plate", bond=False)
    return placed


def _lintel(kit: Kit, offset: int, wide: int, length: int, color, solid: set[int]) -> tuple[int, int]:
    """Where to lay the one brick that carries the wall over an opening: (start, length), or (0, 0)."""
    reach_left, reach_right = offset > 0, offset + wide < length
    need_length = wide + int(reach_left) + int(reach_right)
    for size in range(need_length, need_length + 8):
        if kit.plain_part("brick", 1, size, color) is None:
            continue
        spare = size - wide
        for left in sorted(range(spare + 1), key=lambda value: abs(value - spare / 2)):
            start = offset - left
            cells = set(range(start, start + size))
            if start < 0 or start + size > length or not cells <= solid:
                continue
            if (left >= 1 or not reach_left) and (spare - left >= 1 or not reach_right):
                return start, size
    return 0, 0


HELPER = Helper(
    name="wall", build=build_wall,
    signature='wall(x, y, z, length, height, style="plain", color=None, trim=None, facing="front", openings=())',
    summary="A straight wall one stud thick, `length` studs long from (x, z) and `height` plates tall, with its "
            "base at y on studs. It runs along x when `facing` is front or back and along z when left or right. "
            "`openings` is a list of (offset, base, width, height): studs along the wall from its start, plates up "
            "from its base. Each opening is left clear and gets a lintel that carries the wall over it, so put a "
            "window() or door() of that size in it. Walls that meet at a corner should not both cover the corner "
            "cell.",
    styles=tuple(STYLES),
)
