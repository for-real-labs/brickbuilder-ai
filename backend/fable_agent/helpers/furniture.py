"""Ready-made furniture: tables, seats, beds, cupboards and what stands in a kitchen or bathroom.

Rooms are where a hand-built model spends parts without gaining shape: a table whose top rests on
nothing, a cupboard door that hangs beside its cupboard. Each piece here is built so that every part
stands on the one below, and a top always reaches from one support to another. The cupboard,
drawer, box and chest joints, which studs do not make, are the ones official sets use (see
docs/fable-helpers.md).

A piece has a front: the side it is used from. A sofa or chair faces it, a cupboard opens towards
it, a bed has its foot there and its headboard at the back.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..kit import Kit, KitError
from .common import BRICK, Frame, Helper, brick_color, bridge, choice, first_stocked, local_rect, stocked, tiles, whole

SAME = (1, 0, 0, 0, 1, 0, 0, 0, 1)
CUPBOARD, DRAWER, CUPBOARD_DOOR = "92410", "4536", "4533"
DRAWERS = ((0, 4, 0), (0, 22, 0))  # the two drawers of a cupboard, from its origin
DOOR_HUNG = ((-24, 4, -17), (0, 0, 1, 0, 1, 0, -1, 0, 0))
BOX, BOX_DOOR, CHEST, CHEST_LID = "4345b", "4346", "4738a", "4739"
ROUND1, DOT, ROUND2, ROUND_PLATE2, ROUND_TILE2 = "3062b", "4073", "3941", "4032a", "14769"
SEAT, TAP, SCREEN, BARREL, BIN, CRATE = "4079", "4599b", "60581", "2489", "92926", "30150"
BOOKS = ("Red", "Blue", "Dark_Green", "Yellow", "Dark_Red", "Tan")


class _Maker:
    """What a furniture recipe builds with: plain parts by cells, and special parts set on the grid."""

    def __init__(self, frame: Frame, color, accent):
        self.frame, self.kit, self.color, self.accent = frame, frame.kit, color, accent
        self.placed: list[int] = []

    def bricks(self, cells, ly, color=None, layers: int = 1) -> None:
        tone = brick_color(self.kit, self.color if color is None else color, "furniture")
        self.placed += self.frame.fill(cells, ly, tone, layers=layers)

    def plates(self, cells, ly, color=None, layers: int = 1) -> None:
        tone = brick_color(self.kit, self.color if color is None else color, "furniture", "plate")
        self.placed += self.frame.fill(cells, ly, tone, kind="plate", layers=layers)

    def tiles(self, cells, ly, color=None) -> None:
        self.placed += tiles(self.frame, cells, ly, self.color if color is None else color, "furniture")

    def top(self, x0: int, z0: int, x1: int, z1: int, ly, color=None, across: str | None = None) -> None:
        """Plates over a rectangle, each reaching from one of its edges to the opposite one."""
        self.placed += bridge(self.frame, x0, z0, x1, z1, ly, self.color if color is None else color, "furniture",
                              across=across)

    def part(self, parts, color, lx, ly, lz, wide: int = 1, deep: int = 1) -> int | None:
        """The first stocked of ``parts``, with its studs on the grid; one without studs is centered on
        a ``wide`` x ``deep`` patch. None when the library has none of them."""
        found = first_stocked(self.kit, (parts,) if isinstance(parts, str) else parts, color)
        if found is None:
            return None
        part, code = found
        info = self.kit.part(part)
        if info.studs:
            dx, dz = min(s[0] for s in info.studs) - 0.5, min(s[1] for s in info.studs) - 0.5
        else:
            dx, dz = (info.w - wide) / 2, (info.d - deep) / 2
        index = self.frame.place(part, code, lx - dx, ly, lz - dz)
        self.placed.append(index)
        return index

    def joined(self, part, color, host: int | None, offset, turn, note: str) -> None:
        code = stocked(self.kit, part, color) if host is not None else None
        if code is not None:
            self.placed.append(self.kit.attach(part, code, host, offset, turn, note))

    def post(self, lx, lz, courses: int, color=None) -> None:
        """A leg: round 1 x 1 bricks, or square ones where the library has no round brick."""
        tone = self.color if color is None else color
        code = stocked(self.kit, ROUND1, tone)
        if code is None:
            self.bricks({(lx, lz)}, 0, tone, layers=courses)
            return
        self.placed += [self.frame.place(ROUND1, code, lx, BRICK * level, lz) for level in range(courses)]


def _corners(wide: int, deep: int) -> tuple[tuple[int, int], ...]:
    return (0, 0), (wide - 1, 0), (0, deep - 1), (wide - 1, deep - 1)


def _table(m: _Maker) -> None:
    for lx, lz in _corners(4, 2):
        m.post(lx, lz, 1)
    m.top(0, 0, 4, 2, 3)
    m.tiles(local_rect(0, 0, 4, 2), 4, m.accent)


def _dining_table(m: _Maker) -> None:
    for lx, lz in _corners(6, 4):
        m.post(lx, lz, 1)
    m.top(0, 0, 6, 1, 3, across="x")  # an apron along the front and the back carries the top
    m.top(0, 3, 6, 4, 3, across="x")
    m.top(0, 0, 6, 4, 4, across="z")
    m.tiles(local_rect(0, 0, 6, 4), 5, m.accent)


def _coffee_table(m: _Maker) -> None:
    m.plates(set(_corners(4, 2)), 0, layers=2)
    m.top(0, 0, 4, 2, 2)
    m.tiles(local_rect(0, 0, 4, 2), 3, m.accent)


def _pedestal_table(m: _Maker) -> None:
    if m.part(ROUND2, m.color, 1, 0, 1) is None:
        m.bricks(local_rect(1, 1, 3, 3), 0)
    m.top(0, 0, 4, 4, 3, across="x")
    m.tiles(local_rect(0, 0, 4, 4), 4, m.accent)


def _desk(m: _Maker) -> None:
    host = m.part(CUPBOARD, m.color, 0, 0, 0)
    if host is None:
        m.bricks(local_rect(0, 0, 3, 2), 0, layers=2)
    for offset in DRAWERS:
        m.joined(DRAWER, m.accent, host, offset, SAME, "drawer in its cupboard")
    m.bricks(local_rect(5, 0, 6, 2), 0, layers=2)
    m.top(0, 0, 6, 2, 6, across="x")
    m.tiles(local_rect(0, 0, 6, 2), 7)


def _chair(m: _Maker) -> None:
    if m.part((ROUND_PLATE2, "3022"), m.color, 0, 0, 0) is None:
        m.plates(local_rect(0, 0, 2, 2), 0)
    code = stocked(m.kit, SEAT, m.accent)
    if code is not None:
        m.placed.append(m.frame.place(SEAT, code, 0, 1, 0, facing="front"))
    else:
        m.plates(local_rect(0, 0, 2, 2), 1, m.accent)
        m.bricks(local_rect(0, 1, 2, 2), 2, m.accent)


def _stool(m: _Maker) -> None:
    m.post(0, 0, 1)
    code = stocked(m.kit, ROUND_TILE2, m.accent)
    if code is not None:  # a round tile with one stud holder, centered on the leg
        m.placed.append(m.frame.place(ROUND_TILE2, code, -0.5, 3, -0.5))
    else:
        m.part(DOT, m.accent, 0, 3, 0)


def _bench(m: _Maker) -> None:
    m.bricks(local_rect(0, 0, 1, 2) | local_rect(3, 0, 4, 2), 0)
    m.top(0, 0, 4, 2, 3, m.accent)
    m.bricks(local_rect(0, 1, 4, 2), 4, m.accent)


def _sofa(seats: int) -> Callable[[_Maker], None]:
    wide = 2 * seats + 2

    def build(m: _Maker) -> None:
        m.bricks(local_rect(0, 0, wide, 3), 0)
        arms = local_rect(0, 0, 1, 2) | local_rect(wide - 1, 0, wide, 2)
        back = local_rect(0, 2, wide, 3)
        m.bricks(arms | back, 3)
        m.tiles(local_rect(1, 0, wide - 1, 2), 3, m.accent)  # the cushions
        m.tiles(arms, 6)
        m.plates(back, 6)
        m.tiles(back, 7)

    return build


def _bed(wide: int) -> Callable[[_Maker], None]:
    deep = 7

    def build(m: _Maker) -> None:
        m.bricks(local_rect(0, 0, wide, deep), 0)
        m.plates(local_rect(0, 0, wide, deep - 1), 3, "White")  # the mattress
        m.bricks(local_rect(0, deep - 1, wide, deep), 3, layers=2)  # the headboard
        m.tiles(local_rect(0, 0, wide, deep - 3), 4, m.accent)  # the blanket
        m.tiles(local_rect(0, deep - 3, wide, deep - 1), 4, "White")  # the pillows

    return build


def _cupboards(count: int, drawers: bool) -> Callable[[_Maker], None]:
    def build(m: _Maker) -> None:
        for level in range(count):
            host = m.part(CUPBOARD, m.color, 0, 6 * level, 0)
            if host is None:
                m.bricks(local_rect(0, 0, 3, 2), 6 * level, layers=2)
            elif drawers:
                for offset in DRAWERS:
                    m.joined(DRAWER, m.accent, host, offset, SAME, "drawer in its cupboard")
            else:
                m.joined(CUPBOARD_DOOR, m.accent, host, *DOOR_HUNG, "door on its cupboard")
        m.tiles(local_rect(0, 0, 3, 2), 6 * count)

    return build


def _bookshelf(m: _Maker) -> None:
    sides = local_rect(0, 0, 1, 2) | local_rect(3, 0, 4, 2)
    for shelf in range(3):
        ly = 4 * shelf
        m.bricks(sides, ly)
        for lx in (1, 2):
            m.bricks({(lx, 1)}, ly, BOOKS[(2 * shelf + lx) % len(BOOKS)])
        m.top(0, 0, 4, 2, ly + 3)


def _counter(m: _Maker) -> None:
    m.bricks(local_rect(0, 0, 4, 2), 0)
    m.plates(local_rect(0, 0, 4, 2), 3)
    m.tiles(local_rect(0, 0, 4, 2), 4, m.accent)


def _stove(m: _Maker) -> None:
    m.bricks(local_rect(0, 0, 2, 2), 0)
    m.plates(local_rect(0, 0, 2, 2), 3, "Black")
    for lx, lz in _corners(2, 2):
        m.part(DOT, m.accent, lx, 4, lz)


def _fridge(m: _Maker) -> None:
    cells = local_rect(0, 0, 2, 2)
    m.bricks(cells, 0, layers=2)
    m.plates(cells, 6, m.accent)
    m.bricks(cells, 7)
    m.tiles(cells, 10)


def _sink(m: _Maker) -> None:
    m.bricks(local_rect(0, 0, 2, 2), 0)
    m.plates(local_rect(0, 0, 2, 2), 3)
    m.tiles(local_rect(0, 0, 2, 1), 4, "Trans_Light_Blue")
    if m.part(TAP, m.accent, 0, 4, 1) is None:
        m.part(DOT, m.accent, 0, 4, 1)
    m.tiles({(1, 1)}, 4)


def _bathtub(m: _Maker) -> None:
    rim = local_rect(0, 0, 5, 3) - local_rect(1, 1, 4, 2)
    m.plates(local_rect(0, 0, 5, 3), 0)
    m.bricks(rim, 1)
    m.tiles(local_rect(1, 1, 4, 2), 1, "Trans_Light_Blue")
    if m.part(TAP, m.accent, 4, 4, 1) is None:
        m.part(DOT, m.accent, 4, 4, 1)


def _toilet(m: _Maker) -> None:
    if m.part(ROUND2, m.color, 0, 0, 0) is None:
        m.bricks(local_rect(0, 0, 2, 2), 0)
    if m.part(ROUND_PLATE2, m.accent, 0, 3, 0) is None:
        m.plates(local_rect(0, 0, 2, 2), 3, m.accent)
    m.bricks(local_rect(0, 2, 2, 3), 0, layers=2)
    m.tiles(local_rect(0, 2, 2, 3), 6)


def _tv(m: _Maker) -> None:
    m.bricks(local_rect(0, 0, 4, 2), 0)
    if m.part(SCREEN, m.accent, 0, 3, 1) is None:
        m.bricks(local_rect(0, 1, 4, 2), 3, m.accent, layers=3)
    m.tiles(local_rect(0, 0, 4, 1), 3)


def _fireplace(m: _Maker) -> None:
    m.bricks(local_rect(0, 0, 1, 2) | local_rect(3, 0, 4, 2), 0, layers=2)
    m.bricks(local_rect(1, 1, 3, 2), 0, "Black", layers=2)
    for lx in (1, 2):
        m.part(DOT, "Trans_Orange", lx, 0, 0)
    m.top(0, 0, 4, 2, 6)
    m.tiles(local_rect(0, 0, 4, 2), 7, m.accent)


def _single(part: str, wide: int, deep: int) -> Callable[[_Maker], None]:
    def build(m: _Maker) -> None:
        if m.part(part, m.color, 0, 0, 0, wide, deep) is None:
            raise KitError("furniture() cannot build this style here: the catalog has no such container")

    return build


def _chest(m: _Maker) -> None:
    host = m.part(CHEST, m.color, 0, 0, 0, 4, 2)
    if host is None:
        raise KitError("furniture() cannot build this style here: the catalog has no chest")
    m.joined(CHEST_LID, m.color, host, (0, -16, 0), SAME, "lid on its chest")


def _box(base: bool, lid: bool) -> Callable[[_Maker], None]:
    def build(m: _Maker) -> None:
        level = 0
        if base:  # a mailbox stands on a post
            if m.part(ROUND2, m.accent, 0, 0, 0) is None:
                m.bricks(local_rect(0, 0, 2, 2), 0, m.accent)
            level = BRICK
        host = m.part(BOX, m.color, 0, level, 0)
        if host is None:
            m.bricks(local_rect(0, 0, 2, 2), level, layers=2)
        m.joined(BOX_DOOR, m.accent if not base else m.color, host, (0, 0, 0), SAME, "door on its box")
        if lid:
            m.tiles(local_rect(0, 0, 2, 2), level + 6)

    return build


def _rug(m: _Maker) -> None:
    inner = local_rect(1, 1, 5, 3)
    m.tiles(local_rect(0, 0, 6, 4) - inner, 0)
    m.tiles(inner, 0, m.accent)


@dataclass(frozen=True)
class Piece:
    wide: int
    deep: int
    build: Callable[[_Maker], None]
    color: str = "Reddish_Brown"
    accent: str = "Tan"


STYLES: dict[str, Piece] = {
    "table": Piece(4, 2, _table, accent="Reddish_Brown"),
    "dining_table": Piece(6, 4, _dining_table, accent="Reddish_Brown"),
    "coffee_table": Piece(4, 2, _coffee_table, color="Black", accent="Trans_Clear"),
    "pedestal_table": Piece(4, 4, _pedestal_table, color="White", accent="White"),
    "desk": Piece(6, 2, _desk),
    "chair": Piece(2, 2, _chair, color="Black", accent="Red"),
    "stool": Piece(1, 1, _stool, color="Light_Bluish_Grey", accent="Red"),
    "bench": Piece(4, 2, _bench, color="Dark_Bluish_Grey", accent="Reddish_Brown"),
    "armchair": Piece(4, 3, _sofa(1), color="Dark_Red", accent="Red"),
    "sofa": Piece(6, 3, _sofa(2), color="Dark_Blue", accent="Blue"),
    "long_sofa": Piece(8, 3, _sofa(3), color="Dark_Bluish_Grey", accent="Light_Bluish_Grey"),
    "bed": Piece(4, 7, _bed(4), accent="Blue"),
    "double_bed": Piece(6, 7, _bed(6), accent="Dark_Red"),
    "cupboard": Piece(3, 2, _cupboards(1, False), color="White", accent="White"),
    "dresser": Piece(3, 2, _cupboards(1, True)),
    "wardrobe": Piece(3, 2, _cupboards(2, False)),
    "chest_of_drawers": Piece(3, 2, _cupboards(2, True), color="White", accent="Light_Bluish_Grey"),
    "bookshelf": Piece(4, 2, _bookshelf),
    "counter": Piece(4, 2, _counter, color="White", accent="Light_Bluish_Grey"),
    "stove": Piece(2, 2, _stove, color="White", accent="Dark_Bluish_Grey"),
    "fridge": Piece(2, 2, _fridge, color="White", accent="Light_Bluish_Grey"),
    "sink": Piece(2, 2, _sink, color="White", accent="Light_Bluish_Grey"),
    "bathtub": Piece(5, 3, _bathtub, color="White", accent="Light_Bluish_Grey"),
    "toilet": Piece(2, 3, _toilet, color="White", accent="White"),
    "tv": Piece(4, 2, _tv, accent="Black"),
    "fireplace": Piece(4, 2, _fireplace, color="Dark_Red", accent="Dark_Bluish_Grey"),
    "crate": Piece(3, 4, _single(CRATE, 3, 4)),
    "barrel": Piece(2, 2, _single(BARREL, 2, 2)),
    "chest": Piece(4, 2, _chest),
    "mailbox": Piece(2, 2, _box(True, False), color="Red", accent="Light_Bluish_Grey"),
    "nightstand": Piece(2, 2, _box(False, True)),
    "bin": Piece(2, 2, _single(BIN, 2, 2), color="Dark_Bluish_Grey"),
    "rug": Piece(6, 4, _rug, color="Dark_Red", accent="Tan"),
}


def build_furniture(kit: Kit, x, y, z, style="table", color=None, accent=None, facing="front") -> list[int]:
    """A piece of furniture whose footprint has its min corner at (x, z), used from its ``facing`` side."""
    look = STYLES[choice(style, STYLES, "style", "furniture")]
    x, z = whole(x, "x", "furniture"), whole(z, "z", "furniture")
    choice(facing, ("front", "back", "left", "right"), "facing", "furniture")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("furniture() needs a number of plates for y")
    color = look.color if color is None else color
    accent = look.accent if accent is None else accent
    kit.color(color), kit.color(accent)
    maker = _Maker(Frame(kit, x, y, z, look.wide, look.deep, facing), color, accent)
    look.build(maker)
    return maker.placed


HELPER = Helper(
    name="furniture", build=build_furniture,
    signature='furniture(x, y, z, style="table", color=None, accent=None, facing="front")',
    summary="A piece of furniture for a room, a street or a yard. (x, z) is the min corner of its footprint and y "
            "the floor it stands on, which must have studs. The note after each style is that footprint when "
            "facing front, studs wide x studs deep. `facing` is the side it is used from: a sofa or chair looks "
            "that way, a cupboard opens that way, a bed has its foot there. `color` is the main color and "
            "`accent` the second one (cushions, blanket, table top, doors); each style has its own defaults.",
    styles=tuple(STYLES),
    notes={style: f"{look.wide}x{look.deep}" for style, look in STYLES.items()},
)
