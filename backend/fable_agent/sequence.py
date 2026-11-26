"""The order a model is built in, worked out by Nova's own planner.

Nova publishes instructions that add at most five connected pieces per step, never ask for a
piece before what holds it, never close a piece in before it is placed, and seat the pieces on
the ground first. The planner that guarantees this lives in ``nova-service/flatten.py``. Here a
Fable build is described to it: its stud contacts, its declared joints and the pieces that rest
on the ground.
"""

from __future__ import annotations

from dataclasses import dataclass

from .kit import Build
from .ldraw import LDrawError
from .nova_rules import nova_rules, occurrence
from .shape import STUD, ShapeLibrary

GROUND_TOLERANCE = 0.5  # LDU
FLAT_SHARE = 0.5  # of its footprint a part must rest on to count as standing on the ground


@dataclass(frozen=True)
class Plan:
    order: tuple[int, ...]  # placement ids, in the order they are built
    steps: tuple[int, ...]  # the step each entry of ``order`` belongs to, counting from 1
    together: frozenset[int]  # positions in ``order`` where a small sub-assembly starts

    @property
    def step_count(self) -> int:
        return self.steps[-1] if self.steps else 0


class NoSequence(ValueError):
    """No order adds every piece to something already built."""

    def __init__(self, message: str, remaining: tuple[int, ...] = ()):
        super().__init__(message)
        self.remaining = remaining


def _upright(matrix) -> bool:
    return abs(matrix[1]) < 1e-6 and abs(matrix[4] - 1) < 1e-6 and abs(matrix[7]) < 1e-6


class SequencePlanner:
    def __init__(self, shapes: ShapeLibrary):
        self._shapes = shapes

    def plan(self, build: Build, contacts, boxes: dict[int, list]) -> Plan:
        """``contacts`` are the checker's stud contacts; ``boxes`` its model-space boxes per placement."""
        rules = nova_rules().sequence
        occurrences = [occurrence(placement) for placement in build.placements]
        evidence = [{"instances": [contact.stud, contact.receiver], "status": "confirmed",
                     "kinds": ["stud", "stud_receptacle"], "axes": [list(contact.axis), list(contact.axis)]}
                    for contact in contacts]
        evidence += [{"instances": [first, second], "status": "confirmed", "kinds": ["declared", "declared"]}
                     for first, second, _ in build.links]
        foundation = self._foundation(build, boxes)
        try:
            order = rules.connected_instruction_order(occurrences, evidence, foundation)
            rules.verify_instruction_order(order, evidence, occurrences, foundation)
            groups = rules.instruction_assemblies(order, evidence, occurrences)
        except rules.DisconnectedInstructions as exc:
            raise NoSequence(str(exc), tuple(exc.remaining)) from None
        return Plan(tuple(order), self._steps(build, order, groups, rules.MAX_PARTS_PER_STEP), frozenset(groups))

    def _foundation(self, build: Build, boxes: dict[int, list]) -> set[int]:
        """Upright pieces that rest flat on the ground, on one stud grid: what a baseplate would hold."""
        if not boxes:
            return set()
        ground = max(box[4] for own in boxes.values() for box in own)
        foundation, origin = set(), None
        for index, own in boxes.items():
            placement = build.placements[index]
            resting = [box for box in own if box[4] >= ground - GROUND_TOLERANCE]
            if not resting or not _upright(placement.matrix):
                continue
            try:
                shape = self._shapes.get(placement.part)
            except LDrawError:
                continue
            footprint = (shape.hi[0] - shape.lo[0]) * (shape.hi[2] - shape.lo[2])
            if sum((box[3] - box[0]) * (box[5] - box[2]) for box in resting) < FLAT_SHARE * footprint:
                continue  # a tyre or a round foot touches the ground at a line, not on studs
            corner = (min(box[0] for box in resting), min(box[2] for box in resting))
            origin = origin or corner
            if all(abs((value - start) / STUD - round((value - start) / STUD)) < 1e-6
                   for value, start in zip(corner, origin)):
                foundation.add(index)
        return foundation

    @staticmethod
    def _steps(build: Build, order, groups: dict[int, int], most: int) -> tuple[int, ...]:
        """Nova's step rule: keep sub-assemblies whole, else break at the script's own steps and
        modules, at a change of height and after ``most`` pieces."""
        previous = height_before = None
        number = count = 0
        group_end = -1
        steps = []
        for position, index in enumerate(order):
            placement = build.placements[index]
            key, height = (placement.step, placement.module), placement.position[1]
            moved = height_before is not None and abs(height - height_before) > 1e-6
            if position in groups or position == group_end or (
                    position >= group_end and (key != previous or count == most or moved)):
                number += 1
                count = 0
            if position in groups:
                group_end = position + groups[position]
            steps.append(number)
            count += 1
            previous, height_before = key, height
        return tuple(steps)
