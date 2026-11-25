"""Ready-made railings and fences.

A railing is a straight run one stud deep. Fence parts come four, six or eight studs long, so a
run of any length is made of whole parts with posts making up the rest; a rail laid on posts is
cut so that every piece rests on a post.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..kit import Kit, KitError
from .common import BRICK, Frame, Helper, brick_color, choice, lay, local_rect, need, stocked, tiles, whole

ROUND, CAP, CONE = "3062b", "4073", "59900"  # round 1 x 1 brick, round 1 x 1 plate, 1 x 1 cone


@dataclass(frozen=True)
class RailStyle:
    kind: str  # part | wall | posts
    part: str = ""
    courses: int = 1  # brick courses of a wall, or post height in bricks
    cap: str = ""  # tiles | merlons | cones | dots
    every: int = 4  # studs between posts
    rail: bool = True  # posts carry a rail
    round_posts: bool = False
    color: str = "White"
    trim: str | None = None


STYLES: dict[str, RailStyle] = {
    "spindled": RailStyle("part", "15332"),
    "lattice": RailStyle("part", "3185"),
    "lattice_low": RailStyle("part", "3633"),
    "ornamental": RailStyle("part", "19121", color="Black"),
    "asian": RailStyle("part", "32932", color="Dark_Red"),
    "picket": RailStyle("part", "33303"),
    "bar": RailStyle("part", "6187", color="Light_Bluish_Grey"),
    "bar_studs": RailStyle("part", "4083", color="Light_Bluish_Grey"),
    "wide": RailStyle("part", "30077"),
    "tall": RailStyle("part", "6079", color="Black"),
    "panel": RailStyle("part", "4865a"),
    "glass": RailStyle("part", "4865a", color="Trans_Clear"),
    "wall": RailStyle("wall", color="Light_Bluish_Grey"),
    "capped": RailStyle("wall", cap="tiles", color="Tan", trim="Dark_Tan"),
    "parapet": RailStyle("wall", courses=2, cap="tiles", color="Light_Bluish_Grey"),
    "battlement": RailStyle("wall", cap="merlons", color="Light_Bluish_Grey"),
    "hedge": RailStyle("wall", courses=2, color="Green"),
    "posts": RailStyle("posts", courses=2),
    "round_posts": RailStyle("posts", courses=2, round_posts=True),
    "balustrade": RailStyle("posts", courses=1, every=2, round_posts=True),
    "bollards": RailStyle("posts", courses=1, every=3, rail=False, round_posts=True, cap="dots",
                          color="Dark_Bluish_Grey", trim="Yellow"),
    "palisade": RailStyle("posts", courses=3, every=1, rail=False, round_posts=True, cap="cones",
                          color="Reddish_Brown"),
}


def _post(frame: Frame, lx: int, courses: int, color, round_post: bool) -> list[int]:
    kit = frame.kit
    found = stocked(kit, ROUND, color) if round_post else None
    if found is not None:
        return [frame.place(ROUND, found, lx, BRICK * level, 0) for level in range(courses)]
    return frame.fill({(lx, 0)}, 0, brick_color(kit, color, "railing"), layers=courses)


def build_railing(kit: Kit, x, y, z, length, style="spindled", color=None, trim=None, facing="front") -> list[int]:
    """A railing ``length`` studs long from (x, z): along x when it faces front or back, along z otherwise."""
    look = STYLES[choice(style, STYLES, "style", "railing")]
    x, z = whole(x, "x", "railing"), whole(z, "z", "railing")
    length = whole(length, "length", "railing", 1, 200)
    choice(facing, ("front", "back", "left", "right"), "facing", "railing")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("railing() needs a number of plates for y")
    color = look.color if color is None else color
    trim = (look.trim or color) if trim is None else trim
    frame = Frame(kit, x, y, z, length, 1, facing)
    placed: list[int] = []
    run = local_rect(0, 0, length, 1)

    if look.kind == "part":
        part, code = need(kit, look.part, color, "railing", "fence part of this style")
        _, wide, deep, tall = kit.measure(part)
        unit = int(round(max(wide, deep)))
        at = 0
        while at + unit <= length:
            placed.append(lay(frame, part, code, at, 0, 0, unit))
            at += unit
        for lx in range(at, length):  # what a whole part cannot cover is made up with posts
            placed += _post(frame, lx, max(1, round(tall / BRICK)), color, False)
        return placed

    if look.kind == "wall":
        placed += frame.fill(run, 0, brick_color(kit, color, "railing"), layers=look.courses)
        top = BRICK * look.courses
        if look.cap == "tiles":
            placed += tiles(frame, run, top, trim, "railing")
        elif look.cap == "merlons":
            placed += frame.fill({cell for cell in run if cell[0] % 2 == 0}, top, brick_color(kit, color, "railing"),
                                 bond=False)
        return placed

    posts = sorted(set(range(0, length, look.every)) | {length - 1})
    for lx in posts:
        placed += _post(frame, lx, look.courses, color, look.round_posts)
    top = BRICK * look.courses
    if look.rail:
        # Any plate at least as long as the post spacing covers a post, and the last piece ends on one.
        code = brick_color(kit, trim, "railing", "plate")
        at = 0
        while at < length:
            left = length - at
            size = next(s for s in (8, 6, 4, 3, 2, 1)
                        if s <= left and kit.plain_part("plate", 1, s, code)
                        and (s >= look.every or s == left or any(at <= p < at + s for p in posts)))
            placed.append(lay(frame, kit.plain_part("plate", 1, size, code)[0], code, at, top, 0, size))
            at += size
    elif look.cap in ("cones", "dots"):
        topper = CONE if look.cap == "cones" else CAP
        found = stocked(kit, topper, trim)
        if found is not None:
            placed += [frame.place(topper, found, lx, top, 0) for lx in posts]
    return placed


HELPER = Helper(
    name="railing", build=build_railing,
    signature='railing(x, y, z, length, style="spindled", color=None, trim=None, facing="front")',
    summary="A straight railing, fence or low wall one stud deep, `length` studs long from (x, z) with its base "
            "at y, standing on studs. It runs along x when `facing` is front or back and along z when it is left "
            "or right. Call it once for each side of a balcony, porch or yard.",
    styles=tuple(STYLES),
)
