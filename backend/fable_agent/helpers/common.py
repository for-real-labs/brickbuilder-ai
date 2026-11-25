"""What every helper is built from: argument checks, stocked parts, a turnable local grid, and stacks.

A helper is a function a build script calls to get a whole, ready-made piece of a model (a tree, a
roof, a pair of wheels). Helpers use only the kit's public methods, so they obey the same grid and
the same checks as a script written by hand.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable

from ..kit import Kit, KitError

TURNS = {"front": 0, "left": 90, "back": 180, "right": 270}
SIDES = ("front", "left", "back", "right")
BRICK, PLATE = 3, 1


@dataclass(frozen=True)
class Helper:
    """One helper as scripts and the prompt see it."""

    name: str
    build: Callable  # build(kit, *args, **kwargs) -> list of part ids
    signature: str  # shown to the model, e.g. 'roof(x, y, z, width, depth, style="gable", ...)'
    summary: str  # what it builds and what each argument means
    styles: tuple[str, ...]
    notes: dict[str, str] | None = None  # style -> a short fact the model needs, such as its size


def whole(value, name: str, helper: str, low: int | None = None, high: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise KitError(f"{helper}() needs a whole number for {name}")
    number = int(value)
    if (low is not None and number < low) or (high is not None and number > high):
        raise KitError(f"{helper}() {name} must be from {low} to {high}")
    return number


def number(value, name: str, helper: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or abs(value) > 4000:
        raise KitError(f"{helper}() needs a number for {name}")
    return value


def choice(value, options: Iterable[str], name: str, helper: str) -> str:
    options = tuple(options)
    if not isinstance(value, str) or value not in options:
        raise KitError(f"{helper}() {name} must be one of: {', '.join(options)}")
    return value


def stocked(kit: Kit, part: str, color) -> int | None:
    """The stocked color of ``part`` closest to ``color``; None when the part cannot be used at all."""
    if not kit.has_part(part):
        return None
    return kit.stocked_color(part, color)


def first_stocked(kit: Kit, parts: Iterable[str], color) -> tuple[str, int] | None:
    """The first of ``parts`` that is stocked, with the color closest to ``color``."""
    for part in parts:
        found = stocked(kit, part, color)
        if found is not None:
            return part, found
    return None


def need(kit: Kit, parts, color, helper: str, what: str) -> tuple[str, int]:
    found = first_stocked(kit, (parts,) if isinstance(parts, str) else parts, color)
    if found is None:
        raise KitError(f"{helper}() cannot build this style here: the catalog has no {what}")
    return found


def brick_color(kit: Kit, color, helper: str = "helper", kind: str = "brick") -> int:
    """The color plain 1 x 1 parts of this kind are laid in: the stocked one closest to ``color``."""
    found = kit.plain_part(kind, 1, 1, color)
    if found is None:
        raise KitError(f"{helper}() needs 1 x 1 {kind}s, and the catalog has none")
    return found[1]


def strip(kit: Kit, kind: str, length: int, color, helper: str, wide: int = 1) -> tuple[str, int, int]:
    """A plain ``wide`` x n part at least ``length`` long, as short as the catalog allows: (part, color, n)."""
    for size in range(length, length + 9):
        found = kit.plain_part(kind, wide, size, color)
        if found is not None:
            return found[0], found[1], size
    raise KitError(f"{helper}() needs a {wide} x {length} {kind} or longer, and the catalog has none")


class Frame:
    """A local grid for a helper that has a front, so it is written once and can face any way.

    Local ``lx`` runs to the right and ``lz`` to the back of a ``width`` x ``depth`` box whose front
    edge is ``lz = 0``. ``facing`` says which way that front edge looks in the model. ``(x, z)`` is
    always the min corner of the box as it lies in the model.
    """

    def __init__(self, kit: Kit, x, y, z, width: float, depth: float, facing: str = "front"):
        self.kit, self.x, self.y, self.z = kit, x, y, z
        self.width, self.depth, self.turn = width, depth, TURNS[facing]

    def rect(self, lx, lz, wide, deep) -> tuple[float, float]:
        """The model-space min corner of a local rectangle."""
        if self.turn == 0:
            return self.x + lx, self.z + lz
        if self.turn == 90:
            return self.x + lz, self.z + self.width - lx - wide
        if self.turn == 180:
            return self.x + self.width - lx - wide, self.z + self.depth - lz - deep
        return self.x + self.depth - lz - deep, self.z + lx

    def cells(self, local) -> set[tuple[int, int]]:
        return {tuple(int(round(v)) for v in self.rect(lx, lz, 1, 1)) for lx, lz in local}

    def side(self, facing: str) -> str:
        return SIDES[(SIDES.index(facing) + self.turn // 90) % 4]

    def place(self, part, color, lx, ly, lz, rot=0, facing=None, allow_overlap=False) -> int:
        yaw, wide, deep, _ = self.kit.measure(part, rot, facing)
        wx, wz = self.rect(lx, lz, wide, deep)
        return self.kit.place(part, color, wx, self.y + ly, wz, rot=(yaw + self.turn) % 360,
                              allow_overlap=allow_overlap)

    def fill(self, local, ly, color, kind="brick", layers=1, bond=True) -> list[int]:
        return self.kit.fill(self.cells(local), self.y + ly, color, kind=kind, layers=layers, bond=bond)


def local_rect(x0: int, z0: int, x1: int, z1: int) -> set[tuple[int, int]]:
    return {(x, z) for x in range(x0, x1) for z in range(z0, z1)}


def column(frame: Frame, cells, ly, height: int, color, helper: str) -> list[int]:
    """Fill ``cells`` solid from ``ly`` up ``height`` plates, in bricks with plates for the remainder."""
    placed = []
    courses, rest = divmod(int(height), BRICK)
    if courses:
        placed += frame.fill(cells, ly, brick_color(frame.kit, color, helper), layers=courses)
    if rest:
        placed += frame.fill(cells, ly + courses * BRICK, brick_color(frame.kit, color, helper, "plate"),
                             kind="plate", layers=rest)
    return placed


def stack(kit: Kit, x, y, z, layers, helper: str) -> list[int]:
    """Parts set one on another. Each layer is (parts, color, dx, dz): the first stocked part is used.

    ``dx, dz`` move a layer's min corner from ``(x, z)``, so a wide base can sit under a thin post.
    A layer whose first element is ("fill", kind, wide, deep) is a block of plain parts.
    """
    placed, level = [], y
    for parts, color, dx, dz in layers:
        if isinstance(parts, tuple) and parts and parts[0] == "fill":
            _, kind, wide, deep = parts
            cells = {(x + dx + i, z + dz + j) for i in range(wide) for j in range(deep)}
            placed += kit.fill(cells, level, brick_color(kit, color, helper, kind), kind=kind)
            level += BRICK if kind == "brick" else PLATE
            continue
        part, code = need(kit, parts, color, helper, f"part for this style ({parts if isinstance(parts, str) else parts[0]})")
        placed.append(kit.place(part, code, x + dx, level, z + dz))
        level += kit.measure(part)[3]
    return placed


MAX_SPAN = 16  # the longest plate, so the widest gap plates can bridge


def span_lengths(kit: Kit, kind: str, wide: int, length: int, color, helper: str) -> list[int]:
    """One or two plain parts that together are exactly ``length`` long, each reaching one end.

    Each is at least two studs long where it can be, so a piece never lies wholly on an overhang.
    """
    if kit.plain_part(kind, wide, length, color):
        return [length]
    for shortest in (2, 1):
        for first in range(length - shortest, shortest - 1, -1):
            if kit.plain_part(kind, wide, first, color) and kit.plain_part(kind, wide, length - first, color):
                return [first, length - first]
    raise KitError(f"{helper}() cannot span {length} studs with the {kind}s in the catalog")


def bridge(frame: Frame, x0: int, z0: int, x1: int, z1: int, ly, color, helper: str, across: str | None = None,
           kind: str = "plate") -> list[int]:
    """Plates covering a local rectangle, each reaching from one edge to the opposite edge.

    They rest on whatever lies under those two edges (walls, stringers, the studs of a slope
    course), so the rectangle may be hollow underneath. ``across`` is the direction each plate
    runs: "z" front to back, "x" side to side; by default the shorter way.
    """
    kit = frame.kit
    code = brick_color(kit, color, helper, kind)
    wide, deep = x1 - x0, z1 - z0
    across_z = (deep <= wide) if across is None else across == "z"
    reach, run = (deep, wide) if across_z else (wide, deep)
    if reach > MAX_SPAN:
        raise KitError(f"{helper}() cannot bridge {reach} studs: plates span at most {MAX_SPAN}")
    # Two-wide plates, with the odd one out (if any) set in from the edge so it never lies on an overhang.
    widths = [2] * (run // 2)
    if run % 2:
        widths.insert(min(1, len(widths)), 1)
    placed, at = [], 0
    for thick in widths:
        offset = 0
        for length in span_lengths(kit, kind, thick, reach, code, helper):
            part, _ = kit.plain_part(kind, thick, length, code)
            turned = round(kit.part(part).w) != (thick if across_z else length)
            lx, lz = (x0 + at, z0 + offset) if across_z else (x0 + offset, z0 + at)
            placed.append(frame.place(part, code, lx, ly, lz, rot=90 if turned else 0))
            offset += length
        at += thick
    return placed


def tiles(frame: Frame, cells, ly, color, helper: str) -> list[int]:
    return frame.fill(cells, ly, brick_color(frame.kit, color, helper, "tile"), kind="tile", bond=False)


def runs(cells) -> list[tuple[int, int]]:
    """Whole runs of consecutive numbers in ``cells`` as (start, end)."""
    out, ordered = [], sorted(set(cells))
    for value in ordered:
        if out and out[-1][1] == value:
            out[-1] = (out[-1][0], value + 1)
        else:
            out.append((value, value + 1))
    return out


def lay(frame: Frame, part, color, lx, ly, lz, length: int) -> int:
    """Place a part that is ``length`` studs long so that it runs along local x."""
    turned = round(frame.kit.measure(part)[1]) != length
    return frame.place(part, color, lx, ly, lz, rot=90 if turned else 0)
