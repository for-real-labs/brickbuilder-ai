"""Ready-made doors.

A door is a frame with a leaf hung in it, a pair of them, or a door built from bricks (a garage
door). The leaf sits in the frame exactly where customers' models hang it; a hinge is not a stud
connection, so the helper records that joint itself. A door fills an opening of exactly its
size, which each style states.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..kit import Kit, KitError
from .common import BRICK, Frame, Helper, brick_color, choice, lay, local_rect, need, stocked, whole

FRAME = "60596"  # door frame 1 x 4 x 6
# Where a 1 x 4 x 6 leaf hangs in that frame, in the frame's own LDraw units: hinged left, hinged right.
HUNG = {"left": ((-32, 0, 5), (1, 0, 0, 0, 1, 0, 0, 0, 1)), "right": ((32, 0, 5), (-1, 0, 0, 0, 1, 0, 0, 0, -1))}
GRILLE_BRICK = "2877"


@dataclass(frozen=True)
class DoorStyle:
    kind: str  # hung | inset | part | pair | bricks | shop
    frame: str = FRAME
    leaf: str | None = None
    right: str | None = None  # the right-hand part of a handed door
    wide: int = 4
    tall: int = 18
    count: int = 1  # frames side by side
    glazed: bool = False  # the leaf is glass
    color: str = "White"
    leaf_color: str = "Reddish_Brown"


STYLES: dict[str, DoorStyle] = {
    "panel": DoorStyle("hung", leaf="60623"),
    "smooth": DoorStyle("hung", leaf="60616a"),
    "barred": DoorStyle("hung", leaf="60621", leaf_color="Black"),
    "lattice": DoorStyle("hung", leaf="92589", leaf_color="Black"),
    "doorway": DoorStyle("hung", leaf=None),
    "double": DoorStyle("hung", leaf="60623", count=2, wide=8),
    "double_smooth": DoorStyle("hung", leaf="60616a", count=2, wide=8),
    "glazed": DoorStyle("inset", frame="57894", leaf="57895", glazed=True),
    "glazed_double": DoorStyle("inset", frame="57894", leaf="57895", glazed=True, count=2, wide=8),
    "arched": DoorStyle("inset", frame="40066", leaf="65066", glazed=True, wide=6, tall=21),
    "hatch": DoorStyle("inset", frame="6154", leaf="6155", wide=4, tall=12, leaf_color="Light_Bluish_Grey"),
    "cabin": DoorStyle("part", leaf="3861c", wide=4, tall=15),
    "train": DoorStyle("part", leaf="4182", wide=4, tall=15, leaf_color="Dark_Bluish_Grey"),
    "saloon": DoorStyle("pair", leaf="3193a", right="58380", wide=6, tall=12),
    "car_low": DoorStyle("part", leaf="3822", right="3821", wide=3, tall=3, leaf_color="Red"),
    "car": DoorStyle("part", leaf="92262", right="92263", wide=3, tall=6, leaf_color="Red"),
    "car_tall": DoorStyle("part", leaf="60658", right="60657", wide=3, tall=9, leaf_color="Red"),
    "car_full": DoorStyle("part", leaf="3193a", right="58380", wide=3, tall=12, leaf_color="Red"),
    "garage": DoorStyle("bricks", wide=8, tall=12, leaf_color="White"),
    "garage_wide": DoorStyle("bricks", wide=12, tall=12, leaf_color="White"),
    "garage_tall": DoorStyle("bricks", wide=8, tall=18, leaf_color="Light_Bluish_Grey"),
    "barn": DoorStyle("bricks", wide=6, tall=15, color="White", leaf_color="Dark_Red"),
    "shopfront": DoorStyle("shop", leaf="60616a", wide=8, tall=18, leaf_color="Dark_Bluish_Grey"),
}


def build_door(kit: Kit, x, y, z, style="panel", color=None, leaf=None, glass="Trans_Clear", hinge="left",
               facing="front") -> list[int]:
    """A door whose opening has its min corner at (x, z) and its threshold at ``y`` plates."""
    look = STYLES[choice(style, STYLES, "style", "door")]
    x, z = whole(x, "x", "door"), whole(z, "z", "door")
    choice(facing, ("front", "back", "left", "right"), "facing", "door")
    choice(hinge, ("left", "right"), "hinge", "door")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("door() needs a number of plates for y")
    color = look.color if color is None else color
    leaf_color = look.leaf_color if leaf is None else leaf
    frame = Frame(kit, x, y, z, look.wide, 1, facing)
    placed: list[int] = []

    if look.kind in ("hung", "inset"):
        for index in range(look.count):
            part, code = need(kit, look.frame, color, "door", "door frame of this style")
            host = frame.place(part, code, 4 * index, 0, 0)
            placed.append(host)
            if look.leaf is None:
                continue
            tone = stocked(kit, look.leaf, glass if look.glazed else leaf_color)
            if tone is None:
                continue
            if look.kind == "inset":
                placed.append(kit.inset(look.leaf, tone, host, "door in its frame"))
            else:
                # A pair of doors meets in the middle: the left one hinges left, the right one right.
                side = hinge if look.count == 1 else ("left" if index == 0 else "right")
                offset, turn = HUNG[side]
                placed.append(kit.attach(look.leaf, tone, host, offset, turn, "door on its hinges"))
        return placed

    if look.kind == "part":
        handed = look.right if (hinge == "right" and look.right) else look.leaf
        part, code = need(kit, handed, leaf_color, "door", "door part of this style")
        return [_along(frame, part, code, 0, look.wide)]

    if look.kind == "pair":
        left = need(kit, look.leaf, leaf_color, "door", "door part of this style")
        right = need(kit, look.right, leaf_color, "door", "door part of this style")
        half = look.wide // 2
        return [_along(frame, left[0], left[1], 0, half), _along(frame, right[0], right[1], half, half)]

    if look.kind == "bricks":
        courses = look.tall // BRICK
        if style == "barn":
            trim, body = brick_color(kit, color, "door"), brick_color(kit, leaf_color, "door")
            edge = local_rect(0, 0, 1, 1) | local_rect(look.wide - 1, 0, look.wide, 1)
            placed += frame.fill(edge, 0, trim, layers=courses)
            placed += frame.fill(local_rect(1, 0, look.wide - 1, 1), 0, body, layers=courses - 1)
            placed += frame.fill(local_rect(1, 0, look.wide - 1, 1), BRICK * (courses - 1), trim)
            return placed
        slat = stocked(kit, GRILLE_BRICK, leaf_color)
        for course in range(courses):
            if slat is None:
                placed += frame.fill(local_rect(0, 0, look.wide, 1), BRICK * course, brick_color(kit, leaf_color, "door"))
            else:
                placed += [lay(frame, GRILLE_BRICK, slat, lx, BRICK * course, 0, 2) for lx in range(0, look.wide, 2)]
        return placed

    # A shop front: a door with a tall window beside it.
    part, code = need(kit, FRAME, color, "door", "door frame")
    host = frame.place(part, code, 0, 0, 0)
    placed.append(host)
    tone = stocked(kit, look.leaf, leaf_color)
    if tone is not None:
        offset, turn = HUNG[hinge]
        placed.append(kit.attach(look.leaf, tone, host, offset, turn, "door on its hinges"))
    window, pane = need(kit, "60594", color, "door", "window frame"), stocked(kit, "60603", glass)
    for level in (0, 9):
        side = frame.place(window[0], window[1], 4, level, 0)
        placed.append(side)
        if pane is not None:
            placed.append(kit.inset("60603", pane, side, "pane in its frame"))
    return placed


def _along(frame: Frame, part: str, color: int, lx: int, wide: int) -> int:
    """Place a door part so that it lies along the wall: its long side along local x."""
    _, across, _, _ = frame.kit.measure(part)
    return frame.place(part, color, lx, 0, 0, rot=0 if round(across) >= wide else 90)


HELPER = Helper(
    name="door", build=build_door,
    signature='door(x, y, z, style="panel", color=None, leaf=None, glass="Trans_Clear", hinge="left", '
              'facing="front")',
    summary="A door with its leaf. (x, z) is the min corner of the opening it fills and y its threshold; it "
            "stands on the studs under it. The note after each style is the opening it needs, studs wide x plates "
            "tall; every door is one stud deep. It lies along x when `facing` is front or back and along z when "
            "left or right. `color` is the frame, `leaf` the door itself, `hinge` the side it is hung on. The car "
            "styles are car doors that stand on one stud at their hinge end.",
    styles=tuple(STYLES),
    notes={name: f"{look.wide}x{look.tall}" for name, look in STYLES.items()},
)
