"""Solid plastic that intersects, which no script can declare intended.

The ordinary overlap check compares coarse part shapes, so a script may waive it for glass in
its frame. This review cannot be waived. It finds pairs of placements whose inscribed solids
(see ``solids``) share space, at any rotation, and neighbours whose real surface passes through
a seat back or a dish rim. No hit is not proof that parts outside that cover fit.
"""

from __future__ import annotations

import re
from collections import defaultdict

import numpy as np

from .kit import Placement
from .ldraw import LDrawError, LDrawLibrary
from .shape import PLATE, ShapeLibrary
from .solids import EXPOSED_PARTS, TOLERANCE, bounds, faces_enter, intersects, placed_solids

CELL = 40.0  # LDU: the grid that finds neighbours before the exact test
MAX_REPORTED_PAIRS = 30  # enough for one report; a build with more has the same thing to fix
PLAIN = re.compile(r"(Brick|Plate|Tile) +\d+ x +\d+( with Groove)?")
BRICK = 3 * PLATE
GROOVE = 2.0  # a tile's underside is cut back this far up its sides


class _Profiles:
    """Sizes of plain rectangular parts, as ``solids.local_solids`` looks them up."""

    def __init__(self, library: LDrawLibrary, shapes: ShapeLibrary):
        self._library = library
        self._shapes = shapes
        self._known: dict[str, dict | None] = {}

    def get(self, code: str) -> dict | None:
        if code not in self._known:
            self._known[code] = self._measure(code)
        return self._known[code]

    def _measure(self, code: str) -> dict | None:
        named = PLAIN.fullmatch(self._library.description(code))
        if not named:
            return None
        try:
            shape = self._shapes.get(code)
        except LDrawError:
            return None
        (x0, y0, z0), (x1, y1, z1) = shape.lo, shape.hi
        studs_x, studs_z = (x1 - x0) / 20, (z1 - z0) / 20
        # Only a part that really is a box centred on its origin with its top at y = 0.
        if (abs(x0 + x1) > 0.01 or abs(z0 + z1) > 0.01 or abs(y0) > 0.01 or min(abs(y1 - PLATE), abs(y1 - BRICK)) > 0.01
                or abs(studs_x - round(studs_x)) > 0.001 or abs(studs_z - round(studs_z)) > 0.001):
            return None
        height = y1 - GROOVE if named.group(1) == "Tile" else y1
        return {"x_studs": round(studs_x), "z_studs": round(studs_z), "height": height}


class MaterialReview:
    def __init__(self, library: LDrawLibrary, shapes: ShapeLibrary):
        self._library = library
        self._profiles = _Profiles(library, shapes)
        self._extents: dict[str, tuple[np.ndarray, np.ndarray]] = {}

    def collisions(self, placements: list[Placement]) -> list[tuple[int, int]]:
        """Pairs of placements whose solid plastic intersects, at most ``MAX_REPORTED_PAIRS``."""
        entries = []
        for index, placement in enumerate(placements):
            try:
                solids = placed_solids(placement, self._profiles)
            except ValueError:  # a sheared or scaled placement: the kit never makes one
                continue
            if solids:
                low, high = bounds(solids)
                entries.append((index, solids, low, high, tuple(low.min(axis=0)), tuple(high.max(axis=0))))
        found = self._intersecting(entries)
        if len(found) < MAX_REPORTED_PAIRS:
            try:
                found += self._cut_into(placements, {tuple(sorted(pair)) for pair in found},
                                        MAX_REPORTED_PAIRS - len(found))
            except (LDrawError, ValueError):
                pass  # a neighbour that cannot be read is left to the ordinary overlap check
        return found

    @staticmethod
    def _intersecting(entries) -> list[tuple[int, int]]:
        cells: dict[tuple[int, int], list[int]] = defaultdict(list)
        for slot, (_, _, _, _, low, high) in enumerate(entries):
            for i in range(int(low[0] // CELL), int(high[0] // CELL) + 1):
                for k in range(int(low[2] // CELL), int(high[2] // CELL) + 1):
                    cells[i, k].append(slot)
        seen: set[tuple[int, int]] = set()
        found = []
        for members in cells.values():
            for a in range(len(members)):
                for b in range(a + 1, len(members)):
                    pair = (members[a], members[b])
                    if pair in seen:
                        continue
                    seen.add(pair)
                    i, first, first_low, first_high, low_a, high_a = entries[pair[0]]
                    j, second, second_low, second_high, low_b, high_b = entries[pair[1]]
                    if any(min(high_a[axis], high_b[axis]) - max(low_a[axis], low_b[axis]) <= TOLERANCE
                           for axis in range(3)):
                        continue
                    near = np.all(np.minimum(first_high[:, None], second_high)
                                  - np.maximum(first_low[:, None], second_low) > TOLERANCE, axis=2)
                    if any(intersects(first[u], second[v]) for u, v in zip(*np.nonzero(near))):
                        found.append((i, j))
                        if len(found) >= MAX_REPORTED_PAIRS:
                            return found
        return found

    def _cut_into(self, placements: list[Placement], reported: set[tuple[int, int]], room: int) -> list[tuple[int, int]]:
        """Neighbours of any shape whose real surface passes through a seat back or a dish rim.

        These features have no press fit, so whatever enters them is a collision. The neighbour's
        own triangles are the other side of the test, studs included.
        """
        exposed = [(index, placement) for index, placement in enumerate(placements)
                   if placement.part in EXPOSED_PARTS]
        if not exposed:
            return []
        extents = [self._world_bounds(placement) for placement in placements]
        world_low = np.array([low for low, _ in extents])
        world_high = np.array([high for _, high in extents])
        found = []
        for index, placement in exposed:
            solids = placed_solids(placement, {})
            lows, highs = bounds(solids)
            nearby = ((world_low < highs.max(axis=0)) & (world_high > lows.min(axis=0))).all(axis=1)
            for other in np.flatnonzero(nearby).tolist():
                pair = tuple(sorted((index, other)))
                if other == index or pair in reported:
                    continue
                candidates = ((world_low[other] < highs) & (world_high[other] > lows)).all(axis=1)
                if not candidates.any():
                    continue
                neighbour = placements[other]
                faces = (self._library.surface(neighbour.part) @ np.array(neighbour.matrix).reshape(3, 3).T
                         + np.array(neighbour.position))
                face_low, face_high = faces.min(axis=1), faces.max(axis=1)
                for k in np.flatnonzero(candidates):
                    close = ((face_low <= highs[k]) & (face_high >= lows[k])).all(axis=1)
                    if close.any() and faces_enter(faces[close], solids[k]):
                        reported.add(pair)
                        found.append((index, other))
                        break
                if len(found) >= room:
                    return found
        return found

    def _world_bounds(self, placement: Placement) -> tuple[np.ndarray, np.ndarray]:
        """The box around the whole placed part, studs included."""
        if placement.part not in self._extents:
            try:
                points = self._library.surface(placement.part).reshape(-1, 3)
                self._extents[placement.part] = (points.min(axis=0), points.max(axis=0))
            except LDrawError:
                self._extents[placement.part] = (np.zeros(3), np.zeros(3))
        low, high = self._extents[placement.part]
        matrix = np.array(placement.matrix).reshape(3, 3)
        centre, half = (low + high) / 2, np.abs(matrix) @ ((high - low) / 2)
        middle = matrix @ centre + np.array(placement.position)
        return middle - half, middle + half
