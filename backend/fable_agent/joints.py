"""Evidence for the joints a script declares with ``connect()``.

A declared joint used to be taken on trust. A v2 build must show evidence for each one: at
least, two parts that touch. A Technic pin or axle must also lie in a
hole of the other part: both have connectors the parts library names, so a pin beside its hole
is caught. Clips, bars, tyres on rims and panes in frames have no such names in the library; for
those, touching is all that is checked, and the report says how many.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .kit import Build, Placement
from .ldraw import LDrawError, LDrawLibrary
from .shape import PLATE, ShapeLibrary

CONTACT_GAP = PLATE / 2  # LDU between coarse shapes that still counts as touching; the kit's own stand() rule
ALIGNED = 1.0  # LDU a hole's centre may be off the pin's line
REACH = 40.0  # LDU along the line from a pin's origin to the hole it sits in
FITS = {("pin", "pin_hole"), ("axle", "axle_hole"), ("axle", "pin_hole")}


@dataclass(frozen=True)
class JointFindings:
    apart: tuple[tuple[int, int, str], ...]  # declared joints whose parts do not touch
    missed: tuple[tuple[int, int, str], ...]  # a pin or axle that is in none of the other part's holes
    seated: int  # joints measured as one part seated in the other
    touching: int  # other joints, checked for contact only


class JointReview:
    def __init__(self, library: LDrawLibrary, shapes: ShapeLibrary):
        self._library = library
        self._shapes = shapes

    def review(self, build: Build, boxes: dict[int, list], studded: set[frozenset[int]],
               fits: set[tuple[int, int]] = frozenset()) -> JointFindings:
        """``boxes`` are the checker's model-space boxes, ``studded`` the pairs already joined by a
        stud and ``fits`` the pairs measured as a peg in a hole (see ``fits``)."""
        apart, missed, seated, touching = [], [], 0, 0
        for first, second, note in build.links:
            a, b = build.placements[first], build.placements[second]
            if (min(first, second), max(first, second)) in fits:
                seated += 1
                continue
            if self._gap(self._boxes(first, a, boxes), self._boxes(second, b, boxes)) > CONTACT_GAP:
                apart.append((first, second, note))
                continue
            fit = self._technic_fit(a, b)
            if fit is True:
                seated += 1
            elif fit is False and frozenset((first, second)) not in studded:
                missed.append((first, second, note))
            else:
                touching += 1
        return JointFindings(tuple(apart), tuple(missed), seated, touching)

    def _boxes(self, index: int, placement: Placement, boxes: dict[int, list]) -> list:
        if index in boxes:
            return boxes[index]
        try:
            local = self._shapes.get(placement.part).boxes
        except LDrawError:
            return []
        matrix, origin = np.array(placement.matrix).reshape(3, 3), np.array(placement.position)
        turned = []
        for x0, y0, z0, x1, y1, z1 in local:  # the box that holds the turned box: never smaller than the part
            centre = matrix @ np.array([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]) + origin
            half = np.abs(matrix) @ np.array([(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2])
            turned.append((*(centre - half), *(centre + half)))
        return turned

    @staticmethod
    def _gap(first: list, second: list) -> float:
        if not first or not second:
            return 0.0  # a part that cannot be measured is not called apart
        return min(max(0.0, *(max(p[axis] - q[axis + 3], q[axis] - p[axis + 3]) for axis in range(3)))
                   for p in first for q in second)

    def _technic_fit(self, a: Placement, b: Placement) -> bool | None:
        """True when a pin or axle of one lies in a hole of the other, False when the two have
        such connectors and none lines up, None when the library names no matching pair."""
        try:
            ports_a, ports_b = self._world_ports(a), self._world_ports(b)
        except LDrawError:
            return None
        possible = False
        for males, holes in ((ports_a, ports_b), (ports_b, ports_a)):
            for kind, origin, axis in males:
                for other, centre, line in holes:
                    if (kind, other) not in FITS:
                        continue
                    possible = True
                    along = float((centre - origin) @ axis)
                    off = float(np.linalg.norm(centre - origin - along * axis))
                    if abs(float(axis @ line)) > 0.999 and off <= ALIGNED and abs(along) <= REACH:
                        return True
        return False if possible else None

    def _world_ports(self, placement: Placement) -> list[tuple[str, np.ndarray, np.ndarray]]:
        matrix, origin = np.array(placement.matrix).reshape(3, 3), np.array(placement.position)
        return [(port.kind, matrix @ np.array(port.position) + origin, matrix @ np.array(port.axis))
                for port in self._library.ports(placement.part)]
