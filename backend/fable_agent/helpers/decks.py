"""Ready-made decks, porches and platforms.

After trees, the raised porch was where builds lost the most rounds: a deck floor laid on a
lattice skirt is attached to nothing, because lattice fences have no studs, and steps set beside
it hang loose. A deck here is built so that each part carries the next:

* a **skirt** stands on the ground: a ring of bricks, or posts with open or latticed bays;
* where the skirt is posts, a **beam** of plates runs from post to post all the way round;
* the **floor** is plates that each reach from one side of the ring to the other;
* **railings** stand on the floor's edge, and **steps** stand on the ground beside it, both made
  by the railing and stairs helpers.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..kit import Kit, KitError
from .common import BRICK, Frame, Helper, brick_color, bridge, choice, column, lay, local_rect, need, stocked, tiles, whole
from .railings import STYLES as RAILS, build_railing
from .stairs import STYLES as STEPS, build_stairs, footprint

SIDES = ("front", "back", "left", "right")
ROUND = "3062b"
LATTICE = {6: "3185", 3: "3633"}  # lattice fences by their height in plates


@dataclass(frozen=True)
class DeckStyle:
    skirt: str  # solid | posts | lattice
    rail: str | None  # the railing style it gets by default; None for an open edge
    steps: str  # the stairs style it gets
    round_posts: bool = False
    tiled: bool = True  # tiles inside the edge; the edge keeps its studs for the railing
    color: str = "White"
    floor: str = "Light_Bluish_Grey"


STYLES: dict[str, DeckStyle] = {
    "porch": DeckStyle("lattice", "spindled", "tiled"),
    "veranda": DeckStyle("posts", "spindled", "brick"),
    "deck": DeckStyle("posts", "posts", "wooden", round_posts=True, color="Reddish_Brown", floor="Reddish_Brown"),
    "lattice_deck": DeckStyle("lattice", "lattice", "wooden", color="Reddish_Brown", floor="Dark_Tan"),
    "patio": DeckStyle("solid", None, "gentle", color="Tan", floor="Dark_Tan"),
    "terrace": DeckStyle("solid", "capped", "stone", color="Light_Bluish_Grey", floor="Tan"),
    "boardwalk": DeckStyle("posts", None, "wooden", round_posts=True, tiled=False, color="Dark_Brown",
                           floor="Reddish_Brown"),
    "dock": DeckStyle("posts", "bollards", "open", round_posts=True, tiled=False, color="Dark_Brown",
                      floor="Dark_Tan"),
    "stage": DeckStyle("solid", None, "brick", color="Black", floor="Reddish_Brown"),
    "platform": DeckStyle("solid", "bar", "brick", color="Dark_Bluish_Grey", floor="Light_Bluish_Grey"),
    "lookout": DeckStyle("posts", "picket", "steep", color="Dark_Brown", floor="Reddish_Brown"),
    "stoop": DeckStyle("solid", "wall", "walled", color="Tan", floor="Dark_Tan"),
    "loading_dock": DeckStyle("solid", "bollards", "ramp", tiled=False, color="Light_Bluish_Grey",
                              floor="Light_Bluish_Grey"),
    "pool_deck": DeckStyle("solid", None, "shallow", color="Tan", floor="White"),
    "garden_deck": DeckStyle("posts", "hedge", "garden", round_posts=True, color="Reddish_Brown", floor="Dark_Tan"),
    "bandstand": DeckStyle("solid", "ornamental", "grand", color="White", floor="Tan"),
}
STEP_WIDTH = 4


def _posts(length: int, every: int) -> list[int]:
    return sorted(set(range(0, length, every)) | {length - 1})


def _beam(frame: Frame, lx: int, lz: int, length: int, posts: list[int], every: int, ly, color, along_x: bool) -> list[int]:
    """Plates in a line over a row of posts, cut so that every piece rests on a post."""
    kit = frame.kit
    code = brick_color(kit, color, "deck", "plate")
    placed, at = [], 0
    while at < length:
        left = length - at
        size = next(s for s in (12, 10, 8, 6, 4, 3, 2, 1)
                    if s <= left and kit.plain_part("plate", 1, s, code)
                    and (s >= every or any(at <= post < at + s for post in posts)))
        part = kit.plain_part("plate", 1, size, code)[0]
        turned = round(kit.measure(part)[1]) != size
        if along_x:
            placed.append(frame.place(part, code, lx + at, ly, lz, rot=90 if turned else 0))
        else:
            placed.append(frame.place(part, code, lx, ly, lz + at, rot=0 if turned else 90))
        at += size
    return placed


def _side(frame: Frame, wide: int, deep: int, look: DeckStyle, tall: int, color) -> list[int]:
    """The skirt under a deck: what stands on the ground and carries its floor."""
    kit = frame.kit
    edge = local_rect(0, 0, wide, deep) - local_rect(1, 1, wide - 1, deep - 1)
    if tall < 2:
        return []  # a floor one plate up has no skirt: it lies on the walls or floor already under its edge
    if look.skirt == "solid" or tall < 3:
        return column(frame, edge, 0, tall - 1, color, "deck")
    every = 5 if look.skirt == "lattice" else 4
    high = tall - 2  # posts, then a beam of one plate, then the floor
    panel = LATTICE.get(high) if look.skirt == "lattice" else None
    fence = stocked(kit, panel, color) if panel else None
    post = stocked(kit, ROUND, color) if look.round_posts and high % BRICK == 0 else None
    placed: list[int] = []
    # Front and back rows run the full width; the side rows fill in between them.
    for lz, along_x, length, origin in ((0, True, wide, 0), (deep - 1, True, wide, 0),
                                        (0, False, deep - 2, 1), (wide - 1, False, deep - 2, 1)):
        if length <= 0:
            continue
        spots = _posts(length, every)
        for spot in spots:
            cell = (origin + spot, lz) if along_x else (lz, origin + spot)
            if post is not None:
                placed += [frame.place(ROUND, post, cell[0], BRICK * level, cell[1]) for level in range(high // BRICK)]
            else:
                placed += column(frame, {cell}, 0, high, color, "deck")
        if fence is not None:
            for first, second in zip(spots, spots[1:]):
                if second - first == 5:  # a bay exactly one lattice fence wide
                    at = origin + first + 1
                    if along_x:
                        placed.append(lay(frame, panel, fence, at, 0, lz, 4))
                    else:
                        turned = round(kit.measure(panel)[1]) == 4
                        placed.append(frame.place(panel, fence, lz, 0, at, rot=90 if turned else 0))
        placed += _beam(frame, origin if along_x else lz, lz if along_x else origin, length, spots, every, high,
                        color, along_x)
    return placed


def build_deck(kit: Kit, x, y, z, width, depth, height=6, style="porch", color=None, floor=None, rail=None,
               railing=("front", "left", "right"), steps="front") -> list[int]:
    """A raised deck over the rectangle with min corner (x, z), its floor ``height`` plates above ``y``."""
    look = STYLES[choice(style, STYLES, "style", "deck")]
    x, z = whole(x, "x", "deck"), whole(z, "z", "deck")
    width, depth = whole(width, "width", "deck", 3, 48), whole(depth, "depth", "deck", 3, 48)
    height = whole(height, "height", "deck", 1, 60)
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("deck() needs a number of plates for y")
    if isinstance(railing, str):
        railing = (railing,)
    if not isinstance(railing, (list, tuple)) or any(side not in SIDES for side in railing):
        raise KitError(f"deck() railing must list sides from: {', '.join(SIDES)}")
    if steps is not None:
        choice(steps, SIDES, "steps", "deck")
    rail_style = look.rail if rail is None else rail
    if rail_style is not None:
        choice(rail_style, RAILS, "rail", "deck")
    color = look.color if color is None else color
    floor_color = look.floor if floor is None else floor
    kit.color(color), kit.color(floor_color)
    if min(width, depth) > 16:
        raise KitError("deck() can span at most 16 studs on its shorter side; lay two decks side by side")

    frame = Frame(kit, x, y, z, width, depth)
    placed = _side(frame, width, depth, look, height, color)
    placed += bridge(frame, 0, 0, width, depth, height - 1, floor_color, "deck")
    if look.tiled:
        inside = local_rect(1, 1, width - 1, depth - 1)
        if inside:
            placed += tiles(frame, inside, height, floor_color, "deck")

    # Steps stand on the ground beside the deck and reach its floor; the railing leaves a gap for them.
    gaps: dict[str, tuple[int, int]] = {}
    if steps is not None:
        along = width if steps in ("front", "back") else depth
        span = min(STEP_WIDTH, along)
        start = (along - span) // 2
        gaps[steps] = (start, span)
        _, run = footprint(look.steps, height)
        corner = {"front": (x + start, z - run), "back": (x + start, z + depth),
                  "left": (x - run, z + start), "right": (x + width, z + start)}[steps]
        placed += build_stairs(kit, corner[0], y, corner[1], width=span, rise=height, style=look.steps,
                               color=color, facing=steps)
    if rail_style is not None:
        for side in dict.fromkeys(railing):
            full = side in ("front", "back")
            length, offset = (width, 0) if full else (depth - 2, 1)
            pieces = [(0, length)]
            if side in gaps:
                start, span = gaps[side]
                start -= offset
                pieces = [(0, max(0, start)), (start + span, length - start - span)]
            for begin, run in pieces:
                if run <= 0:
                    continue
                at = offset + begin
                corner = {"front": (x + at, z), "back": (x + at, z + depth - 1),
                          "left": (x, z + at), "right": (x + width - 1, z + at)}[side]
                try:
                    placed += build_railing(kit, corner[0], y + height, corner[1], run, style=rail_style,
                                            color=color, facing="front" if full else "left")
                except KitError:  # the catalog lacks that fence part: posts and a rail do the same job
                    placed += build_railing(kit, corner[0], y + height, corner[1], run, style="posts", color=color,
                                            facing="front" if full else "left")
    return placed


HELPER = Helper(
    name="deck", build=build_deck,
    signature='deck(x, y, z, width, depth, height=6, style="porch", color=None, floor=None, rail=None, '
              'railing=("front", "left", "right"), steps="front")',
    summary="A raised porch, deck, patio or platform, complete with what carries it, its railings and its steps. "
            "(x, z) is the min corner of the floor, `width` studs along x and `depth` along z, and y the ground it "
            "stands on, which must have studs. The floor is `height` plates above y; with height=1 it is only a floor, for a balcony laid on walls that are already there. `railing` lists the sides "
            "that get a railing (front is low z, back is high z); leave out a side that meets a wall. `steps` is "
            "the side the steps go down from, or None; they stand outside the floor, about 4 studs wide. `rail` "
            "is a railing() style in place of the style's own. Use it for every porch, balcony deck and landing "
            "instead of building the floor, skirt and steps by hand. At most 16 studs on the shorter side.",
    styles=tuple(STYLES),
)
