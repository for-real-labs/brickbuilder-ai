"""Mechanical fixes made to a build before it is checked.

Two kinds of mistake cost a model a whole turn although fixing them takes no judgment:

* a plain brick, plate or tile that runs into another part, usually because two sections of the
  script claim the same cells. The plain part is cut back to the cells that are free;
* a part asked for in a color it is not sold in. It gets the closest color it is sold in.

Nothing else is touched. Shaped parts (slopes, windows, fences, plants) are never cut, parts are
never moved, and unattached parts are left for the model: those need a design decision. The
repaired build still goes through every check, so a repair can never make an invalid model pass.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field, replace

from .catalog import PartFinder
from .checks import OVERLAP_TOLERANCE, colliding_pairs, hash_boxes, world_boxes
from .kit import KIND_HEIGHT, Build, Kit, KitError, Placement
from .ldraw import LDrawError, LDrawLibrary
from .palette import Palette, nearest_color
from .shape import PLATE, STUD, ShapeLibrary

MAX_PASSES = 3


@dataclass
class Repairs:
    """What was changed, in words the model and the customer's record can use."""

    recolored: Counter = field(default_factory=Counter)  # (part, from color, to color) -> parts
    trimmed: Counter = field(default_factory=Counter)  # module -> plain parts cut back
    removed: Counter = field(default_factory=Counter)  # module -> plain parts wholly inside another part

    def __bool__(self) -> bool:
        return bool(self.recolored or self.trimmed or self.removed)

    def notes(self, color_names: dict[int, str]) -> list[str]:
        notes = []
        cut, gone = sum(self.trimmed.values()), sum(self.removed.values())
        if cut or gone:
            where = Counter(self.trimmed) + Counter(self.removed)
            listed = ", ".join(f"{module} {count}" for module, count in where.most_common(6))
            notes.append(f"Automatic repair: {cut + gone} plain part(s) overlapped another part and were cut back "
                         f"to the free cells ({gone} had no free cell and were removed). By module: {listed}. "
                         "Look at those places in the pictures.")
        for (part, old, new), count in sorted(self.recolored.items()):
            notes.append(f"Automatic repair: {part} does not come in {color_names.get(old, old)}; {count} placed in "
                         f"{color_names.get(new, new)} instead.")
        return notes


class BuildRepairer:
    def __init__(self, library: LDrawLibrary, shapes: ShapeLibrary, palette: Palette, finder: PartFinder):
        self._library = library
        self._shapes = shapes
        self._palette = palette
        self._finder = finder
        self._plain: dict[str, str] | None = None

    def repair(self, build: Build) -> tuple[Build, Repairs]:
        repairs = Repairs()
        build = self._recolor(build, repairs)
        for _ in range(MAX_PASSES):
            build, changed = self._trim(build, repairs)
            if not changed:
                break
        return build, repairs

    # ----- colors ---------------------------------------------------------

    def _recolor(self, build: Build, repairs: Repairs) -> Build:
        placements = []
        for placement in build.placements:
            if not self._palette.allows(placement.part, placement.color):
                closest = nearest_color(self._library, self._palette, placement.part, placement.color)
                if closest is not None and closest != placement.color:
                    repairs.recolored[(placement.part, placement.color, closest)] += 1
                    placement = replace(placement, color=closest)
            placements.append(placement)
        return Build(placements, list(build.links))

    # ----- overlaps -------------------------------------------------------

    def _plain_kind(self, part_id: str) -> str | None:
        if self._plain is None:
            self._plain = {part: kind for kind in KIND_HEIGHT
                           for parts in self._finder.basic_alternatives(kind).values() for part in parts}
        return self._plain.get(part_id)

    def _can_give_way(self, placement: Placement) -> bool:
        """A plain part standing upright. One built sideways was placed with care and is left alone."""
        return self._plain_kind(placement.part) is not None and placement.matrix[4] > 0.999

    def _boxes(self, build: Build) -> dict[int, list]:
        boxes = {}
        for index, placement in enumerate(build.placements):
            if all(min(abs(v), abs(abs(v) - 1)) < 1e-6 for v in placement.matrix):
                try:
                    boxes[index] = world_boxes(self._shapes.get(placement.part), placement)
                except LDrawError:
                    continue
        return boxes

    def _trim(self, build: Build, repairs: Repairs) -> tuple[Build, bool]:
        placements = build.placements
        boxes = self._boxes(build)
        makes_room: dict[int, set[int]] = {}
        for first, second in colliding_pairs(placements, boxes, hash_boxes(boxes)):
            if placements[first].allow_overlap or placements[second].allow_overlap:
                continue
            # The later of two plain parts gives way; a shaped part never does.
            if self._can_give_way(placements[second]):
                makes_room.setdefault(second, set()).add(first)
            elif self._can_give_way(placements[first]):
                makes_room.setdefault(first, set()).add(second)
        if not makes_room:
            return build, False

        replaced: dict[int, list[Placement]] = {}
        for index, others in makes_room.items():
            pieces = self._cut_back(placements[index], boxes[index],
                                    [box for other in others for box in boxes[other]])
            if pieces is not None:
                replaced[index] = pieces
                (repairs.trimmed if pieces else repairs.removed)[placements[index].module] += 1
        if not replaced:
            return build, False
        result, moved = [], {}
        for index, placement in enumerate(placements):
            if index in replaced:
                result += replaced[index]
            else:
                moved[index] = len(result)
                result.append(placement)
        links = [(moved[a], moved[b], note) for a, b, note in build.links if a in moved and b in moved]
        return Build(result, links), True

    def _cut_back(self, placement: Placement, own: list, blockers: list) -> list[Placement] | None:
        """The plain parts that cover what is left of ``placement``; None when it cannot be cut."""
        lo = [min(box[axis] for box in own) for axis in range(3)]
        hi = [max(box[axis + 3] for box in own) for axis in range(3)]
        cells = {(x, z) for x in range(round(lo[0] / STUD), round(hi[0] / STUD))
                 for z in range(round(lo[2] / STUD), round(hi[2] / STUD))}
        taken = set()
        for box in blockers:
            if min(hi[1], box[4]) - max(lo[1], box[1]) <= OVERLAP_TOLERANCE:
                continue
            taken |= {(x, z) for x in range(int((box[0] + OVERLAP_TOLERANCE) // STUD),
                                            int((box[3] - OVERLAP_TOLERANCE) // STUD) + 1)
                      for z in range(int((box[2] + OVERLAP_TOLERANCE) // STUD),
                                     int((box[5] - OVERLAP_TOLERANCE) // STUD) + 1)}
        free = cells - taken
        if free == cells:
            return None  # the overlap is not on the stud grid; leave it for the model
        if not free:
            return []
        kit = Kit(self._library, self._shapes, self._palette, self._finder)
        try:
            kit.fill(free, -hi[1] / PLATE, placement.color, self._plain_kind(placement.part), bond=False)
        except KitError:
            return None
        return [replace(piece, module=placement.module, step=placement.step) for piece in kit.build.placements]
