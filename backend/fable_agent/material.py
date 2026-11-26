"""Solid plastic that intersects: Nova's material rules run on a Fable build.

The ordinary overlap check compares coarse part shapes, so a script may declare an overlap
intended (glass in its frame). This review cannot be waived. It uses Nova's inscribed solids:
pieces of plastic that are certainly there, for plain bricks, plates and tiles and for the parts
Nova measured by hand (seats, dishes, curved tiles, bricks with side studs). A hit proves that two
parts are in the same place, at any rotation. No hit is not proof that parts outside that cover fit.
"""

from __future__ import annotations

import re
from collections import defaultdict

import numpy as np

from .kit import Placement
from .ldraw import LDrawError, LDrawLibrary
from .nova_rules import nova_rules, occurrence
from .shape import PLATE, ShapeLibrary

CELL = 40.0  # LDU: the grid that finds neighbours before the exact test
PLAIN = re.compile(r"(Brick|Plate|Tile) +\d+ x +\d+( with Groove)?")
BRICK = 3 * PLATE
GROOVE = 2.0  # a tile's underside is cut back this far up its sides


class _Profiles:
    """Sizes of plain rectangular parts, in the form Nova's material rules look them up."""

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
        """Pairs of placements whose solid plastic intersects, at most Nova's reporting limit."""
        rules = nova_rules()
        occurrences = [occurrence(placement) for placement in placements]
        entries = []
        for index, part in enumerate(occurrences):
            try:
                solids = rules.material.transformed_solids(part, self._profiles)
            except ValueError:  # a sheared or scaled placement: the kit never makes one
                continue
            if solids:
                low, high = rules.material.bounds(solids)
                entries.append((index, solids, low, high, tuple(low.min(axis=0)), tuple(high.max(axis=0))))
        limit = rules.material.MAX_REPORTED_PAIRS
        found = self._intersecting(entries, rules.material, limit)
        reports = [rules.material.overlap_diagnostic(occurrences, first, second) for first, second in found]
        if len(reports) < limit and any(part.part_code in rules.surfaces.EXPOSED_PARTS for part in occurrences):
            try:
                rules.surfaces.exposed_overlaps(occurrences, [self._world_bounds(p) for p in placements],
                                                self._library.surface, reports)
            except (LDrawError, ValueError):
                pass  # a neighbour that cannot be read is left to the ordinary overlap check
        return [tuple(report["instances"]) for report in reports]

    @staticmethod
    def _intersecting(entries, material, limit: int) -> list[tuple[int, int]]:
        tolerance = material.TOLERANCE
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
                    if any(min(high_a[axis], high_b[axis]) - max(low_a[axis], low_b[axis]) <= tolerance
                           for axis in range(3)):
                        continue
                    near = np.all(np.minimum(first_high[:, None], second_high)
                                  - np.maximum(first_low[:, None], second_low) > tolerance, axis=2)
                    if any(material.intersects(first[u], second[v]) for u, v in zip(*np.nonzero(near))):
                        found.append((i, j))
                        if len(found) >= limit:
                            return found
        return found

    def _world_bounds(self, placement: Placement) -> dict:
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
        return {"bounds": {"min": (middle - half).tolist(), "max": (middle + half).tolist()}}
