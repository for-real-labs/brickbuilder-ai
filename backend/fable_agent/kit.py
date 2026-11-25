"""The build kit a script draws with: grid placement, a bonding packer and LDraw output.

Scripts work in a stud grid instead of raw LDraw units:

* ``x`` runs to the right and ``z`` to the back, both in studs; the model's front is
  the low-``z`` side.
* ``y`` runs up in plates (a brick is three plates).
* A placement names the min corner of the part's footprint and the bottom of its
  body. The kit measures the part and works out the LDraw origin and matrix.
"""

from __future__ import annotations

import difflib
import math
import re
from dataclasses import dataclass, field

from .catalog import PartFinder
from .ldraw import LDrawError, LDrawLibrary, normalize_part_id
from .palette import RESERVED_COLORS, Palette, nearest_color
from .shape import PLATE, STUD, PartShape, ShapeLibrary

MAX_PLACEMENTS = 6000
MAX_FILL_CELLS = 40_000
FACINGS = {"front": 0, "left": 90, "back": 180, "right": 270}
KIND_HEIGHT = {"brick": 3, "plate": 1, "tile": 1}
Matrix = tuple[float, float, float, float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)


class KitError(ValueError):
    """A mistake in the build script that the agent can correct."""


@dataclass(frozen=True)
class Placement:
    part: str
    color: int
    position: tuple[float, float, float]  # LDU
    matrix: Matrix  # row-major rotation
    module: str = "model"
    step: int = 0
    allow_overlap: bool = False


@dataclass
class Build:
    placements: list[Placement] = field(default_factory=list)
    links: list[tuple[int, int, str]] = field(default_factory=list)  # declared connections


def yaw_matrix(degrees: float) -> Matrix:
    quarter = {0: (1.0, 0.0), 90: (0.0, 1.0), 180: (-1.0, 0.0), 270: (0.0, -1.0)}
    turn = degrees % 360
    cos, sin = quarter.get(turn) or (math.cos(math.radians(turn)), math.sin(math.radians(turn)))
    return (cos, 0.0, sin, 0.0, 1.0, 0.0, -sin, 0.0, cos)


def rect(x0: int, z0: int, x1: int, z1: int) -> set[tuple[int, int]]:
    """Cells with x0 <= x < x1 and z0 <= z < z1."""
    return {(x, z) for x in range(int(x0), int(x1)) for z in range(int(z0), int(z1))}


def ring(x0: int, z0: int, x1: int, z1: int, thickness: int = 1) -> set[tuple[int, int]]:
    """The border of a rectangle, ``thickness`` cells wide."""
    t = int(thickness)
    return rect(x0, z0, x1, z1) - rect(x0 + t, z0 + t, x1 - t, z1 - t)


@dataclass(frozen=True)
class PartInfo:
    """What a script may ask about a part before placing it (sizes at rot=0)."""

    id: str
    w: float  # studs along x
    d: float  # studs along z
    h: float  # plates
    studs: tuple[tuple[float, float, float], ...]


class Kit:
    """Collects placements. One instance builds one model."""

    def __init__(self, library: LDrawLibrary, shapes: ShapeLibrary, palette: Palette, finder: PartFinder,
                 *, max_placements: int = MAX_PLACEMENTS):
        self._library = library
        self._shapes = shapes
        self._palette = palette
        self._finder = finder
        self._max = max_placements
        self._module = "model"
        self._step = 0
        self._families: dict[str, dict[tuple[int, int], list[str]]] = {}
        self._color_names: dict[str, int] | None = None
        self.build = Build()

    # ----- vocabulary ----------------------------------------------------

    def color(self, value) -> int:
        if isinstance(value, bool):
            raise KitError("A color must be an LDraw color code or name")
        known = self._library.colors()
        if isinstance(value, int):
            code = value
        elif isinstance(value, str):
            if self._color_names is None:
                self._color_names = {self._color_key(c.name): c.code for c in known.values()}
            key = self._color_key(value)
            if key.isdigit():
                code = int(key)
            elif key in self._color_names:
                code = self._color_names[key]
            else:
                close = difflib.get_close_matches(key, list(self._color_names), n=4, cutoff=0.6)
                names = ", ".join(known[self._color_names[k]].name for k in close)
                raise KitError(f"Unknown color {value!r}." + (f" Did you mean: {names}?" if names else ""))
        else:
            raise KitError("A color must be an LDraw color code or name")
        if code in RESERVED_COLORS or (known and code not in known):
            raise KitError(f"Color {code} is not a placeable LDraw color")
        return code

    @staticmethod
    def _color_key(name: str) -> str:
        return re.sub(r"[^a-z0-9]", "", name.lower().replace("gray", "grey"))

    def _shape(self, part) -> tuple[str, PartShape]:
        try:
            part_id = normalize_part_id(part)
            return part_id, self._shapes.get(part_id)
        except LDrawError as exc:
            raise KitError(str(exc)) from None

    def part(self, part) -> PartInfo:
        part_id, shape = self._shape(part)
        return PartInfo(part_id, round(shape.width, 2), round(shape.depth, 2), round(shape.height, 2),
                        tuple(shape.up_studs()))

    def stocked_color(self, part, color) -> int | None:
        """``color`` if the part comes in it, else the closest color it does come in; None if it is not stocked."""
        part_id, _ = self._shape(part)
        return nearest_color(self._library, self._palette, part_id, self.color(color))

    def plain_part(self, kind: str, short: int, long: int, color) -> tuple[str, int] | None:
        """A plain ``short`` x ``long`` brick, plate or tile and the stocked color closest to ``color``."""
        if kind not in KIND_HEIGHT:
            raise KitError("kind must be 'brick', 'plate' or 'tile'")
        code = self.color(color)
        choices = self._family(kind).get((min(short, long), max(short, long)), [])
        for part_id in choices:
            if self._palette.allows(part_id, code):
                return part_id, code
        for part_id in choices:
            closest = nearest_color(self._library, self._palette, part_id, code)
            if closest is not None:
                return part_id, closest
        return None

    def has_part(self, part) -> bool:
        """Whether the parts library can draw this part at all."""
        try:
            self._shape(part)
        except KitError:
            return False
        return True

    def measure(self, part, rot=0, facing=None) -> tuple[float, float, float, float]:
        """How a part sits when placed with ``rot`` or ``facing``: (yaw, studs along x, studs along z, plates tall)."""
        _, shape = self._shape(part)
        yaw = self._yaw_for(shape, rot, facing)
        turned = round(yaw / 90) % 2 == 1
        return (yaw, round(shape.depth if turned else shape.width, 3), round(shape.width if turned else shape.depth, 3),
                round(shape.height, 3))

    def footing(self, part) -> list[tuple[int, int]]:
        """Whole-stud cells, from the min corner at rot=0, where the part reaches down to its base.

        An arch stands on its legs and a window frame on its sill; this says where those are.
        """
        _, shape = self._shape(part)
        cells = set()
        for ix, column in enumerate(shape.bottom):
            for iz, low in enumerate(column):
                if low is not None and low >= shape.hi[1] - 0.6:
                    cells.add((ix // 2, iz // 2))
        return sorted(cells)

    def attach(self, part, color, host: int, offset=(0, 0, 0), matrix=None, note: str = "") -> int:
        """Place a part at an LDraw offset and rotation relative to a placed part, and record the joint.

        For joints studs cannot make and the checks cannot see: a wheel on its pin, a door in its
        frame. The offset and rotation are in the host's own frame, as LDraw models record them.
        """
        if isinstance(host, bool) or not isinstance(host, int) or not 0 <= host < len(self.build.placements):
            raise KitError("attach() needs the id of the part to attach to, as returned by place()")
        part_id, _ = self._shape(part)
        base = self.build.placements[host]
        m = base.matrix
        turn = IDENTITY if matrix is None else tuple(float(v) for v in matrix)
        if len(turn) != 9 or len(tuple(offset)) != 3:
            raise KitError("attach() needs a 3-number offset and a 9-number rotation")
        position = tuple(base.position[row] + sum(m[3 * row + col] * float(offset[col]) for col in range(3))
                         for row in range(3))
        rotation = tuple(sum(m[3 * row + k] * turn[3 * k + col] for k in range(3))
                         for row in range(3) for col in range(3))
        index = self._add(part_id, self.color(color), position, rotation, True)
        self.build.links.append((host, index, str(note)[:80] or "attached part"))
        return index

    def stand(self, parts, note: str = "") -> int | None:
        """Join parts that stand on a surface without studs, such as tyres on a road, to what is under them.

        Looks under the lowest of ``parts`` for an earlier part whose top is level with it and records
        that joint. Returns the part found, or None when they stand on nothing but the ground.
        """
        own = set(parts)
        count = len(self.build.placements)
        if not own or not all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < count for i in own):
            raise KitError("stand() takes ids returned by place()")
        feet = {i: self._boxes(i) for i in own}
        bottom = max(box[4] for boxes in feet.values() for box in boxes)
        lowest = {i: [box for box in boxes if bottom - box[4] <= 1] for i, boxes in feet.items()}
        found = None
        for index, soles in lowest.items():
            under = self._under(soles, bottom, own)
            if under is not None:  # every part that touches down is joined, so none is left hanging
                self.build.links.append((under, index, str(note)[:80] or "standing on it"))
                found = under if found is None else found
        return found

    def _under(self, soles, bottom: float, own: set[int]) -> int | None:
        for other in range(len(self.build.placements)):
            if other in own:
                continue
            for top in self._boxes(other):
                if abs(top[1] - bottom) <= PLATE / 2 and any(
                        sole[0] < top[3] and top[0] < sole[3] and sole[2] < top[5] and top[2] < sole[5]
                        for sole in soles):
                    return other
        return None

    def _boxes(self, index: int) -> list[tuple[float, ...]]:
        """A placed part's boxes in model space, as (x0, y0, z0, x1, y1, z1) with y pointing down."""
        placement = self.build.placements[index]
        m, t = placement.matrix, placement.position
        boxes = []
        for x0, y0, z0, x1, y1, z1 in self._shapes.get(placement.part).boxes:
            a = [m[3 * row] * x0 + m[3 * row + 1] * y0 + m[3 * row + 2] * z0 + t[row] for row in range(3)]
            b = [m[3 * row] * x1 + m[3 * row + 1] * y1 + m[3 * row + 2] * z1 + t[row] for row in range(3)]
            boxes.append((*(min(p, q) for p, q in zip(a, b)), *(max(p, q) for p, q in zip(a, b))))
        return boxes

    # ----- structure -----------------------------------------------------

    def module(self, name: str) -> None:
        """Name the section that following placements belong to (shown in reports)."""
        text = re.sub(r"[^A-Za-z0-9 _.-]", "", str(name))[:40].strip()
        self._module = text or "model"

    def step(self) -> None:
        """Start a new building step."""
        self._step += 1

    def connect(self, first: int, second: int, note: str = "") -> None:
        """Declare a non-stud connection (clip, bar, hinge, pane in frame) between two placements."""
        count = len(self.build.placements)
        if not all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < count for i in (first, second)):
            raise KitError("connect() takes two ids returned by place()")
        if first == second:
            raise KitError("connect() needs two different placements")
        self.build.links.append((first, second, str(note)[:80]))

    # ----- placement -----------------------------------------------------

    def _add(self, part_id: str, color: int, position, matrix: Matrix, allow_overlap: bool) -> int:
        if len(self.build.placements) >= self._max:
            raise KitError(f"The script placed more than {self._max} parts")
        if not all(math.isfinite(v) for v in (*position, *matrix)):
            raise KitError("Placement coordinates must be finite numbers")
        if any(abs(v) > 40_000 for v in position):
            raise KitError("Placement is outside the supported build volume")
        self.build.placements.append(Placement(
            part_id, color, tuple(round(float(v), 4) for v in position),
            tuple(round(float(v), 6) for v in matrix), self._module, self._step, bool(allow_overlap)))
        return len(self.build.placements) - 1

    def _yaw_for(self, shape: PartShape, rot, facing) -> float:
        if facing is not None:
            if rot not in (0, None):
                raise KitError("Give rot or facing, not both")
            if facing not in FACINGS:
                raise KitError(f"facing must be one of {', '.join(FACINGS)}")
            return (FACINGS[facing] - shape.front_yaw) % 360
        if isinstance(rot, bool) or not isinstance(rot, (int, float)) or not math.isfinite(rot):
            raise KitError("rot must be a number of degrees")
        return float(rot) % 360

    def place(self, part, color, x, y, z, rot=0, facing=None, allow_overlap=False) -> int:
        """Place a part with its footprint's min corner at (x, z) studs and its base at y plates."""
        for value in (x, y, z):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise KitError("place() coordinates must be numbers")
        part_id, shape = self._shape(part)
        code = self.color(color)
        matrix = yaw_matrix(self._yaw_for(shape, rot, facing))
        cos, sin = matrix[0], matrix[2]
        xs = [cos * px + sin * pz for px in (shape.lo[0], shape.hi[0]) for pz in (shape.lo[2], shape.hi[2])]
        zs = [-sin * px + cos * pz for px in (shape.lo[0], shape.hi[0]) for pz in (shape.lo[2], shape.hi[2])]
        tx = STUD * x - min(xs)
        tz = STUD * z - min(zs)
        ty = -PLATE * y - shape.hi[1]
        upward = [s for s in shape.studs if s[4] < -0.99]
        if upward:
            # Irregular outlines (leaves, animals) rarely start on a stud line. Nudge by
            # less than a quarter stud so the part's own studs land on the stud lattice.
            sx = cos * upward[0][0] + sin * upward[0][2] + tx
            sz = -sin * upward[0][0] + cos * upward[0][2] + tz
            for axis, value in (("x", sx), ("z", sz)):
                delta = (round((value - 10) / STUD) * STUD + 10) - value
                if 0.01 < abs(delta) < 4.99:
                    tx, tz = (tx + delta, tz) if axis == "x" else (tx, tz + delta)
        return self._add(part_id, code, (tx, ty, tz), matrix, allow_overlap)

    def place_ldu(self, part, color, position, matrix=None, allow_overlap=False) -> int:
        """Place by LDraw origin (LDU, Y down) and an optional 3x3 row-major rotation matrix."""
        part_id, _ = self._shape(part)
        code = self.color(color)
        try:
            origin = tuple(float(v) for v in position)
            rotation = IDENTITY if matrix is None else tuple(float(v) for row in matrix for v in (
                row if isinstance(row, (list, tuple)) else (row,)))
        except (TypeError, ValueError):
            raise KitError("place_ldu() needs a 3-number position and a 3x3 matrix") from None
        if len(origin) != 3 or len(rotation) != 9:
            raise KitError("place_ldu() needs a 3-number position and a 3x3 matrix")
        rows = [rotation[0:3], rotation[3:6], rotation[6:9]]
        determinant = (rows[0][0] * (rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1])
                       - rows[0][1] * (rows[1][0] * rows[2][2] - rows[1][2] * rows[2][0])
                       + rows[0][2] * (rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0]))
        orthonormal = all(abs(sum(a * b for a, b in zip(rows[i], rows[j])) - (1.0 if i == j else 0.0)) < 1e-3
                          for i in range(3) for j in range(3))
        if not orthonormal or abs(determinant - 1) > 1e-3:
            raise KitError("The matrix must be a pure rotation: parts cannot be mirrored, scaled or sheared")
        return self._add(part_id, code, origin, rotation, allow_overlap)

    def inset(self, part, color, host: int, note: str = "") -> int:
        """Seat a part made to nest in another (glass in its window frame, a door in its frame).

        The part takes the host's orientation and is centered in the host's width and height,
        because frames have equal borders. It keeps its own depth where that lies inside the
        host. The pair is recorded as an intended overlap and a connection.
        """
        if isinstance(host, bool) or not isinstance(host, int) or not 0 <= host < len(self.build.placements):
            raise KitError("inset() needs the id of the part to sit in, as returned by place()")
        part_id, inner = self._shape(part)
        frame = self.build.placements[host]
        outer = self._shapes.get(frame.part)
        shift = [(outer.lo[axis] + outer.hi[axis] - inner.lo[axis] - inner.hi[axis]) / 2 for axis in range(3)]
        if outer.lo[2] <= inner.lo[2] and inner.hi[2] <= outer.hi[2]:
            shift[2] = 0.0
        m = frame.matrix
        position = tuple(frame.position[row] + sum(m[3 * row + col] * shift[col] for col in range(3))
                         for row in range(3))
        index = self._add(part_id, self.color(color), position, frame.matrix, True)
        self.build.links.append((host, index, str(note)[:80] or "nested part"))
        return index

    def row(self, part, color, x, y, z, count, axis="x", rot=0, facing=None, gap=0) -> list[int]:
        """Repeat a part ``count`` times along ``axis``, each next to the previous one."""
        if axis not in ("x", "z"):
            raise KitError("axis must be 'x' or 'z'")
        if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= 500:
            raise KitError("count must be an integer between 0 and 500")
        _, shape = self._shape(part)
        quarter = round(self._yaw_for(shape, rot, facing) / 90) % 2
        along_x, along_z = (shape.depth, shape.width) if quarter else (shape.width, shape.depth)
        pitch = (along_x if axis == "x" else along_z) + gap
        return [self.place(part, color, x + (pitch * i if axis == "x" else 0), y,
                           z + (pitch * i if axis == "z" else 0), rot=rot, facing=facing)
                for i in range(count)]

    # ----- packing -------------------------------------------------------

    def _family(self, kind: str) -> dict[tuple[int, int], list[str]]:
        if kind not in self._families:
            self._families[kind] = self._finder.basic_alternatives(kind)
        return self._families[kind]

    def fill(self, cells, y, color, kind="brick", layers=1, bond=True) -> list[int]:
        """Cover grid cells with the largest available bricks, plates or tiles.

        Seams are staggered between consecutive layers so walls bond, and the long
        direction alternates so corners of a ring interlock.
        """
        if kind not in KIND_HEIGHT:
            raise KitError("kind must be 'brick', 'plate' or 'tile'")
        if isinstance(layers, bool) or not isinstance(layers, int) or not 1 <= layers <= 200:
            raise KitError("layers must be an integer between 1 and 200")
        if isinstance(y, bool) or not isinstance(y, (int, float)) or not math.isfinite(y):
            raise KitError("y must be a number of plates")
        try:
            wanted = {(int(cx), int(cz)) for cx, cz in cells}
        except (TypeError, ValueError):
            raise KitError("cells must be (x, z) integer pairs, e.g. from rect() or ring()") from None
        if len(wanted) * layers > MAX_FILL_CELLS:
            raise KitError("fill() covers too many cells in one call")
        code = self.color(color)
        pieces = []
        for (short, long), part_ids in self._family(kind).items():
            part_id = next((p for p in part_ids if self._palette.allows(p, code)), None)
            if part_id is not None:
                pieces.append((short, long, part_id))
        if not any(short == 1 and long == 1 for short, long, _ in pieces):
            names = self._library.colors()
            raise KitError(f"No 1 x 1 {kind} is available in color {code} "
                           f"({names[code].name if code in names else '?'}); choose another color or kind")
        height = KIND_HEIGHT[kind]
        placed: list[int] = []
        for layer in range(layers):
            level = y + layer * height
            parity = (int(math.floor(level / height + 1e-9)) % 2) if bond else 0
            placed += self._pack(wanted, level, code, pieces, parity, bond)
        return placed

    def _pack(self, cells: set, level: float, color: int, pieces, parity: int, bond: bool) -> list[int]:
        longest: dict[int, int] = {}
        candidates = []
        for short, long, part_id in pieces:
            longest[short] = max(longest.get(short, 1), long)
            candidates.append((long, short, part_id))  # long side along x
            if long != short:
                candidates.append((short, long, part_id))  # long side along z
        prefer_x = parity == 0
        candidates.sort(key=lambda c: (-(c[0] * c[1]), (c[0] >= c[1]) != prefer_x, -max(c[0], c[1])))
        remaining = set(cells)
        placed = []
        for x, z in sorted(cells, key=lambda cell: (cell[1], cell[0])):
            if (x, z) not in remaining:
                continue
            for width, depth, part_id in candidates:
                if not all((x + i, z + j) in remaining for j in range(depth) for i in range(width)):
                    continue
                if bond and parity and max(width, depth) > 1:
                    # Start odd layers with a half-length piece so seams never line up.
                    along_x = width >= depth
                    starts_run = ((x - 1, z) not in cells) if along_x else ((x, z - 1) not in cells)
                    half = max(1, longest[min(width, depth)] // 2)
                    if starts_run and max(width, depth) > half:
                        run = 0
                        while ((x + run, z) if along_x else (x, z + run)) in remaining:
                            run += 1
                        if run > half:
                            continue
                placed.append(self._place_footprint(part_id, color, x, level, z, width, depth))
                remaining.difference_update((x + i, z + j) for j in range(depth) for i in range(width))
                break
        return placed

    def _place_footprint(self, part_id: str, color: int, x: int, level: float, z: int, width: int, depth: int) -> int:
        shape = self._shapes.get(part_id)
        own = (round(shape.width), round(shape.depth))
        if own == (width, depth):
            return self.place(part_id, color, x, level, z, rot=0)
        if own == (depth, width):
            return self.place(part_id, color, x, level, z, rot=90)
        raise KitError(f"Part {part_id} does not measure {width} x {depth} studs")


# ----- LDraw output -------------------------------------------------------


def _number(value: float) -> str:
    rounded = round(value, 4)
    if rounded == int(rounded):
        return str(int(rounded))
    return f"{rounded:.4f}".rstrip("0").rstrip(".")


def to_ldraw(build: Build, title: str = "BrickBuilder model") -> str:
    """A flat, self-describing LDraw model with one STEP per building step."""
    safe_title = " ".join(re.sub(r"[^\w .,'()&+-]", " ", title).split())[:80] or "BrickBuilder model"
    lines = [f"0 {safe_title}", "0 Name: model.ldr", "0 Author: BrickBuilder Fable agent",
             "0 !LDRAW_ORG Unofficial_Model", ""]
    steps = sorted({p.step for p in build.placements})
    banded = len(steps) <= 1
    ordered = sorted(enumerate(build.placements),
                     key=lambda item: (-item[1].position[1] // 24 if banded else item[1].step, item[0]))
    previous_key = None
    previous_module = None
    for _, placement in ordered:
        key = -placement.position[1] // 24 if banded else placement.step
        if previous_key is not None and key != previous_key:
            lines.append("0 STEP")
            previous_module = None
        if placement.module != previous_module:
            lines.append(f"0 // {placement.module}")
        previous_key, previous_module = key, placement.module
        numbers = " ".join(_number(v) for v in (*placement.position, *placement.matrix))
        lines.append(f"1 {placement.color} {numbers} {placement.part}.dat")
    lines.append("0 STEP")
    return "\r\n".join(lines) + "\r\n"
