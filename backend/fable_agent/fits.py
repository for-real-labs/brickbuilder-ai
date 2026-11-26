"""Joints the checks can measure without being told: a peg of one part inside a hole of another.

Studs are found by the checker itself. Everything else that holds LEGO together by a round fit
is found here: a Technic pin in a beam, a bar in a clip, a bar in a hollow stud, a hinge pin in
its base, a wheel pin in a hole. The parts library draws each of these as a cylinder, a peg seen
from outside and a hole from inside, so no list of parts is needed. Two parts are fitted when a
peg of one and a hole of the other have the same radius, lie on the same line and overlap along
it. Axles are cross-shaped, so they are matched by the library's own names for them.

A fit is evidence of a joint. It says nothing about friction, or whether the joint is strong
enough for what hangs on it.
"""

from __future__ import annotations

from collections import defaultdict

import numpy as np

from .kit import Placement
from .ldraw import LDrawError, LDrawLibrary

MIN_RADIUS, MAX_RADIUS = 2.5, 11.0  # LDU: from a thin bar's neighbours to a tyre's bead
MIN_LENGTH = 1.0
RADIUS_PLAY = 0.6  # a hole may be this much wider or narrower than the peg drawn for it
OFF_LINE = 0.75  # how far the two centre lines may be apart
PARALLEL = 0.999
OVERLAP = 1.5  # along the line, the least a peg must be inside its hole
CELL = 16.0  # the grid that brings neighbours together before the exact test
AXLE_FITS = {("axle", "axle_hole"), ("axle", "pin_hole")}
AXLE_RADIUS = 6.0
AXLE_END = 2.0  # a hole may start this far past the end of the axle as drawn
AXLE_CELL = 20.0
WHEEL_SLACK = 12.0  # a rim may sit this far along its pin from where the pin is drawn, or off its tyre's middle
PIN_RADIUS = 6.6  # the widest peg a wheel turns on


def around_a_fit(fits: set[tuple[int, int]]) -> set[tuple[int, int]]:
    """The fitted pairs, and every two parts that are both fitted to the same third part.

    Coarse shapes make a tyre a solid disc, so it seems to cut into the plate whose pin its rim
    turns on. Those two never touch: they only share the rim. The ordinary overlap check may
    excuse such a pair. They are not joined to each other, and solid plastic is still refused.
    """
    partners: dict[int, set[int]] = defaultdict(set)
    for first, second in fits:
        partners[first].add(second)
        partners[second].add(first)
    near = set(fits)
    for shared in partners.values():
        ordered = sorted(shared)
        near.update((a, b) for i, a in enumerate(ordered) for b in ordered[i + 1:])
    return near


class FitFinder:
    def __init__(self, library: LDrawLibrary):
        self._library = library
        self._rounds: dict[str, tuple | None] = {}

    def find(self, placements: list[Placement]) -> set[tuple[int, int]]:
        """Pairs of placements, lower id first, where a peg or axle of one sits in a hole of the other."""
        pegs, holes = [], []
        for index, placement in enumerate(placements):
            matrix = np.array(placement.matrix, dtype=float).reshape(3, 3)
            origin = np.array(placement.position, dtype=float)
            try:
                surfaces = self._library.cylinders(placement.part)
            except LDrawError:
                continue
            for surface in surfaces:
                if not MIN_RADIUS <= surface.radius <= MAX_RADIUS or surface.length < MIN_LENGTH:
                    continue
                start = matrix @ np.array(surface.base) + origin
                axis = matrix @ np.array(surface.axis)
                (holes if surface.inside else pegs).append((index, start, axis, surface.length, surface.radius))
        found = self._seated(pegs, holes)
        axles = self._axle_fits(placements, pegs)
        return found | axles | self._wheels(placements, pegs)

    @staticmethod
    def _seated(pegs: list, holes: list) -> set[tuple[int, int]]:
        cells: dict[tuple[int, int, int], list[int]] = defaultdict(list)
        for slot, (_, start, axis, length, _) in enumerate(holes):
            for step in range(int(length // (CELL / 2)) + 2):
                point = start + axis * min(length, step * CELL / 2)
                cells[tuple(int(v) for v in point // CELL)].append(slot)
        found: set[tuple[int, int]] = set()
        for owner, start, axis, length, radius in pegs:
            near: set[int] = set()
            for step in range(int(length // (CELL / 2)) + 2):
                cx, cy, cz = (int(v) for v in (start + axis * min(length, step * CELL / 2)) // CELL)
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        for dz in (-1, 0, 1):
                            near.update(cells.get((cx + dx, cy + dy, cz + dz), ()))
            for slot in near:
                other, base, line, reach, bore = holes[slot]
                pair = (min(owner, other), max(owner, other))
                if other == owner or pair in found or abs(bore - radius) > RADIUS_PLAY:
                    continue
                turn = float(axis @ line)
                if abs(turn) < PARALLEL:
                    continue
                offset = base - start
                along = float(offset @ axis)
                if np.linalg.norm(offset - along * axis) > OFF_LINE:
                    continue
                far = along + turn * reach  # the hole's other end, measured along the peg
                if min(length, max(along, far)) - max(0.0, min(along, far)) >= OVERLAP:
                    found.add(pair)
        return found

    def _axle_fits(self, placements: list[Placement], pegs: list) -> set[tuple[int, int]]:
        """Axles in axle holes and pin holes, by the connectors the library names.

        Each axle is also added to ``pegs``, so a wheel can be found on it.
        """
        axles, holes = [], defaultdict(list)
        for index, placement in enumerate(placements):
            try:
                ports = self._library.ports(placement.part)
            except LDrawError:
                continue
            if not ports:
                continue
            matrix = np.array(placement.matrix, dtype=float).reshape(3, 3)
            origin = np.array(placement.position, dtype=float)
            for port in ports:
                point, axis = matrix @ np.array(port.position) + origin, matrix @ np.array(port.axis)
                if port.kind == "axle":
                    axles.append((index, point, axis, port.length + AXLE_END))
                    pegs.append((index, point, axis, port.length, AXLE_RADIUS))
                elif ("axle", port.kind) in AXLE_FITS:
                    holes[tuple(int(v) for v in point // AXLE_CELL)].append((index, point, axis))
        found: set[tuple[int, int]] = set()
        for owner, start, axis, reach in axles:
            near = set()
            for step in range(int(reach // AXLE_CELL) + 2):
                cx, cy, cz = (int(v) for v in (start + axis * step * AXLE_CELL) // AXLE_CELL)
                near.update((cx + dx, cy + dy, cz + dz) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1))
            for cell in near:
                for other, point, line in holes.get(cell, ()):
                    offset = point - start
                    along = float(offset @ axis)
                    if (other != owner and abs(float(axis @ line)) >= PARALLEL and -AXLE_END <= along <= reach
                            and np.linalg.norm(offset - along * axis) <= OFF_LINE):
                        found.add((min(owner, other), max(owner, other)))
        return found

    # ----- wheels ---------------------------------------------------------

    def _wheels(self, placements: list[Placement], pegs: list) -> set[tuple[int, int]]:
        """Tyres on their rims, and wheels on the pin or axle they turn on.

        The library draws many rims and tyres without a single cylinder, so they are recognized by
        what they are called and how they sit: a tyre around a rim shares its centre and its axis,
        and a wheel on a pin has the pin's line through its centre, along its own axis.
        """
        wheels, tyres = [], []
        for index, placement in enumerate(placements):
            name = self._library.description(placement.part).lstrip("~_=")
            if not name.startswith(("Wheel", "Tyre")):
                continue
            round_part = self._round(placement.part)
            if round_part is None:
                continue
            centre, axis, across = round_part
            matrix = np.array(placement.matrix, dtype=float).reshape(3, 3)
            entry = (index, matrix @ centre + np.array(placement.position, dtype=float), matrix @ axis, across)
            (tyres if name.startswith("Tyre") else wheels).append(entry)
        found: set[tuple[int, int]] = set()
        for tyre, centre, axis, across in tyres:
            for wheel, middle, line, width in wheels:
                apart = centre - middle
                if (width < across and abs(float(axis @ line)) >= PARALLEL and np.linalg.norm(apart) <= WHEEL_SLACK
                        and np.linalg.norm(apart - float(apart @ line) * line) <= OFF_LINE * 2):
                    found.add((min(tyre, wheel), max(tyre, wheel)))
        for wheel, middle, line, _ in wheels:
            for owner, start, axis, length, radius in pegs:
                if owner == wheel or radius > PIN_RADIUS or abs(float(axis @ line)) < PARALLEL:
                    continue
                offset = middle - start
                along = float(offset @ axis)
                if -WHEEL_SLACK <= along <= length + WHEEL_SLACK and np.linalg.norm(offset - along * axis) <= OFF_LINE * 2:
                    found.add((min(owner, wheel), max(owner, wheel)))
        return found

    def _round(self, part: str) -> tuple[np.ndarray, np.ndarray, float] | None:
        """A wheel or tyre's centre, the axis it turns on and its width across, in its own frame."""
        if part not in self._rounds:
            self._rounds[part] = None
            try:
                points = self._library.surface(part).reshape(-1, 3)
            except LDrawError:
                return None
            low, high = points.min(axis=0), points.max(axis=0)
            size = high - low
            for turning in range(3):  # the axis whose other two sizes agree: a disc seen edge on
                first, second = (size[k] for k in range(3) if k != turning)
                if abs(first - second) <= 1.5 and first > 4:
                    self._rounds[part] = ((low + high) / 2, np.eye(3)[turning], float(first))
                    break
        return self._rounds[part]
