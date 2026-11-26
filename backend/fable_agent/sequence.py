"""The order a model is built in, and the steps its instructions show.

Instructions add at most five connected pieces per step. They start with the pieces that rest on
the ground and go upward. No step asks for a piece before something that holds it, and no piece
is closed in between two others before it is placed. A piece that hangs under its support is
shown as built together with that support.

The planner reads what the checker measured: which stud sits in which part, and the joints the
script declared. It accounts for upright stud stacks and parts threaded onto an axle. Balance and whether a hand can reach
a part are outside it.
"""

from __future__ import annotations

import heapq
from collections import defaultdict
from dataclasses import dataclass, field, replace

from .kit import Build
from .ldraw import LDrawError
from .shape import STUD, ShapeLibrary

MAX_PARTS_PER_STEP = 5
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


@dataclass(frozen=True)
class _Joints:
    """Who touches whom, and for upright stud joints, who sits on whom."""

    neighbours: list[set[int]]
    above: list[set[int]]  # the parts studded onto each part
    below: list[set[int]]  # the parts each part is studded onto
    # For an axle and for each part on it: the axle, where this part sits along it (None for the
    # axle itself) and everything on that axle as (place along the axle, part).
    stacks: dict[int, list[tuple[int, float | None, list[tuple[float, int]]]]] = field(default_factory=dict)


def _upright(matrix) -> bool:
    return abs(matrix[1]) < 1e-6 and abs(matrix[4] - 1) < 1e-6 and abs(matrix[7]) < 1e-6


def _trapped(index: int, placed: set[int], above: list[set[int]], below: list[set[int]]) -> set[int]:
    """Unplaced pieces that placing ``index`` now would close in against a piece already built."""
    def enclosed(direction: list[set[int]]) -> set[int]:
        parents: dict[int, set[int]] = {}
        found: set[int] = set()
        frontier = [index]
        while frontier:
            current = frontier.pop()
            for neighbour in direction[current]:
                if neighbour in placed:
                    if current != index:
                        found.add(current)
                else:
                    if neighbour not in parents:
                        parents[neighbour] = set()
                        frontier.append(neighbour)
                    if current != index:
                        parents[neighbour].add(current)
        frontier = list(found)
        while frontier:
            for parent in parents[frontier.pop()]:
                if parent not in found:
                    found.add(parent)
                    frontier.append(parent)
        return found
    return enclosed(above) | enclosed(below)


def _shaft_stacks(shafts: dict[int, list[tuple[float, int]]]) -> dict:
    """Index, for every axle and every part on one, what else is on that axle and where."""
    found: dict[int, list] = {}
    for shaft, stack in shafts.items():
        found.setdefault(shaft, []).append((shaft, None, stack))
        for at, receiver in stack:
            found.setdefault(receiver, []).append((shaft, at, stack))
    return found


def _inside_axle_ends(shafts) -> dict[int, set[int]]:
    """For each end piece, the shaft and inner pieces that can be installed before capping it."""
    inside: dict[int, set[int]] = {}
    for shaft, stack in shafts.items():
        if len(stack) < 3:
            continue
        stations = [station for station, _ in stack]
        low, high = min(stations), max(stations)
        inner = {part for station, part in stack if low + 1e-6 < station < high - 1e-6}
        if inner:
            for _, part in stack:
                if part not in inner:
                    inside.setdefault(part, set()).update(inner | {shaft})
    return inside


def _trapped_on_shaft(index: int, placed: set[int], stacks: dict) -> set[int]:
    """Unplaced pieces on an axle that placing ``index`` now would leave between two seated pieces.

    A piece slides onto an axle from an end, so it cannot be added once pieces sit on both sides
    of its place.
    """
    blocked: set[int] = set()
    for shaft, at, stack in stacks.get(index, ()):
        if shaft != index and shaft not in placed:
            continue
        seated = [other for other, receiver in stack if receiver in placed]
        if at is not None:
            seated.append(at)
        if len(seated) > 1:
            low, high = min(seated), max(seated)
            blocked.update(receiver for other, receiver in stack
                           if low + 1e-6 < other < high - 1e-6 and receiver not in placed and receiver != index)
    return blocked


class SequencePlanner:
    def __init__(self, shapes: ShapeLibrary):
        self._shapes = shapes

    def plan(self, build: Build, contacts, boxes: dict[int, list], fits=frozenset(), shafts=None) -> Plan:
        """``contacts`` are the checker's stud contacts, ``boxes`` its model-space boxes per placement,
        ``fits`` the pairs joined by a measured peg in a hole, and ``shafts`` what sits where along
        each measured axle (see ``connectors``)."""
        if not build.placements:
            raise NoSequence("There are no pieces to place")
        joints = self._joints(build, contacts, fits)
        if shafts:
            joints = replace(joints, stacks=_shaft_stacks(shafts))
        foundation = self._foundation(build, boxes)
        inside = _inside_axle_ends(shafts or {})
        order = self._order(build, joints, foundation, inside)
        self._verify(order, joints, foundation)
        groups = self._together(order, joints)
        return Plan(tuple(order), self._steps(build, order, groups, inside), frozenset(groups))

    @staticmethod
    def _joints(build: Build, contacts, fits=frozenset()) -> _Joints:
        placements = build.placements
        count = len(placements)
        neighbours, above, below = ([set() for _ in range(count)] for _ in range(3))
        for contact in contacts:
            lower, upper = contact.stud, contact.receiver
            neighbours[lower].add(upper)
            neighbours[upper].add(lower)
            x, y, z = contact.axis
            vertical = abs(x) < 1e-6 and abs(abs(y) - 1) < 1e-6 and abs(z) < 1e-6
            # LDraw's y points down, so the lower part has the larger y.
            if (vertical and _upright(placements[lower].matrix) and _upright(placements[upper].matrix)
                    and placements[lower].position[1] > placements[upper].position[1] + 1e-6):
                above[lower].add(upper)
                below[upper].add(lower)
        for first, second in [*((first, second) for first, second, _ in build.links), *fits]:
            neighbours[first].add(second)
            neighbours[second].add(first)
        return _Joints(neighbours, above, below)

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
    def _order(build: Build, joints: _Joints, foundation: set[int], ends=None) -> list[int]:
        """Grow one attached assembly, lowest pieces first, without closing in an unplaced piece.

        The pieces on the ground are seated first. With none, the lowest piece starts. Among the
        pieces that can be attached next, prefer axle interiors, then lower pieces, then script order.
        A piece may still hang under a bridge while what stands below it is missing.
        """
        heights = [placement.position[1] for placement in build.placements]
        count = len(heights)
        if foundation:  # the ground must not be what holds a model together
            reached, frontier = {0}, [0]
            while frontier:
                for neighbour in joints.neighbours[frontier.pop()] - reached:
                    reached.add(neighbour)
                    frontier.append(neighbour)
            if len(reached) != count:
                raise NoSequence("The model is not one connected piece",
                                 tuple(sorted(set(range(count)) - reached)))

        ends = ends or {}
        caps = defaultdict(set)
        for end, interior in ends.items():
            for part in interior:
                caps[part].add(end)
        placed: set[int] = set()

        def priority(index: int) -> tuple:
            # If a wheel is reachable from the body before its axle, leave it until the inner
            # pieces are fitted. An open end is still usable if it is the only way to proceed.
            premature_end = index in ends and not ends[index] <= placed
            return (index not in foundation, premature_end, index not in caps, -heights[index], index)

        seeds = foundation or {min(range(count), key=priority)}
        frontier = [priority(index) for index in seeds]
        heapq.heapify(frontier)
        discovered, scheduled = set(seeds), set(seeds)
        waiting: list[set[int]] = [set() for _ in range(count)]
        order: list[int] = []
        while frontier:
            index = heapq.heappop(frontier)[-1]
            if index not in scheduled:
                continue  # an old heap entry for an end piece that was reprioritized
            scheduled.remove(index)
            blockers = (_trapped(index, placed, joints.above, joints.below)
                        | _trapped_on_shaft(index, placed, joints.stacks))
            if blockers:
                for middle in blockers:
                    waiting[middle].add(index)
                continue
            order.append(index)
            placed.add(index)
            for end in caps.get(index, ()):
                if end in scheduled and ends[end] <= placed:
                    heapq.heappush(frontier, priority(end))
            for candidate in waiting[index]:
                if candidate not in placed and candidate not in scheduled:
                    heapq.heappush(frontier, priority(candidate))
                    scheduled.add(candidate)
            for neighbour in joints.neighbours[index]:
                if neighbour not in discovered:
                    discovered.add(neighbour)
                    heapq.heappush(frontier, priority(neighbour))
                    scheduled.add(neighbour)
        if len(order) != count:
            raise NoSequence("Remaining pieces are disconnected or require a blocked placement",
                             tuple(sorted(set(range(count)) - placed)))
        return order

    @staticmethod
    def _verify(order: list[int], joints: _Joints, foundation: set[int]) -> None:
        """Check every step of the order on its own, without trusting how it was found."""
        if sorted(order) != list(range(len(joints.neighbours))):
            raise NoSequence("The building order must hold every piece exactly once")
        placed: set[int] = set()
        for index in order:
            if index not in foundation and foundation - placed:
                raise NoSequence("Pieces on the ground must be placed before building above them")
            if placed and index not in foundation and not joints.neighbours[index] & placed:
                raise NoSequence("A piece is placed before anything that holds it", (index,))
            if _trapped(index, placed, joints.above, joints.below) or _trapped_on_shaft(index, placed, joints.stacks):
                raise NoSequence("A piece is closed in before it is placed", (index,))
            placed.add(index)

    @staticmethod
    def _together(order: list[int], joints: _Joints) -> dict[int, int]:
        """Positions in ``order`` where a support starts a small group that hangs under it, and its size.

        The group is the pieces right after the support that touch nothing built earlier and are
        held only by studs of the group above them. The support itself must sit on studs below it.
        """
        placed: set[int] = set()
        groups: dict[int, int] = {}
        cursor = 0
        while cursor < len(order):
            anchor = order[cursor]
            mounts = joints.neighbours[anchor] & placed
            group = {anchor}
            end = cursor + 1
            if mounts and mounts <= joints.below[anchor]:
                while end < len(order):
                    candidate = order[end]
                    holds = joints.neighbours[candidate] & group
                    if joints.neighbours[candidate] & placed or not holds or not holds <= joints.above[candidate]:
                        break
                    group.add(candidate)
                    end += 1
                    if len(group) > MAX_PARTS_PER_STEP:  # too large to show as one step: leave it apart
                        break
            if 1 < len(group) <= MAX_PARTS_PER_STEP:
                groups[cursor] = len(group)
                placed.update(group)
                cursor = end
            else:
                placed.add(anchor)
                cursor += 1
        return groups

    @staticmethod
    def _steps(build: Build, order: list[int], groups: dict[int, int], inside: dict[int, set[int]]) -> tuple[int, ...]:
        """Keep groups whole; otherwise break at the script's own steps and modules, at a change of
        height and after ``MAX_PARTS_PER_STEP`` pieces."""
        previous = height_before = None
        number = 0
        current: set[int] = set()
        group_end = -1
        steps = []
        for position, index in enumerate(order):
            placement = build.placements[index]
            key, height = (placement.step, placement.module), placement.position[1]
            moved = height_before is not None and abs(height - height_before) > 1e-6
            cap = index in inside and not current.isdisjoint(inside[index])
            if position in groups or position == group_end or (
                    position >= group_end and (key != previous or len(current) == MAX_PARTS_PER_STEP or moved or cap)):
                number += 1
                current.clear()
            if position in groups:
                group_end = position + groups[position]
            steps.append(number)
            current.add(index)
            previous, height_before = key, height
        return tuple(steps)
