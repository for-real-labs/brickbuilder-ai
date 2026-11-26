"""Physical review of a build: overlaps, stud connections, inventory and limits.

These checks are evidence, not proof. They cover parts on axis-aligned rotations and
stud connections; clips, bars, hinges and balance are outside their reach, and the
report says so instead of implying a guarantee.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from decimal import Decimal
from typing import TYPE_CHECKING

from .kit import Build, Placement
from .ldraw import LDrawError, LDrawLibrary
from .palette import Palette
from .shape import PLATE, STUD, ShapeLibrary

if TYPE_CHECKING:
    from .assembly import AssemblyReview
    from .sequence import Plan

HASH = 40.0  # LDU broad-phase cell
OVERLAP_TOLERANCE = 1.0  # LDU of penetration ignored on every axis
STUD_PROBE = 2.0  # LDU along the stud axis where a mating part must be solid
MAX_LISTED = 8


@dataclass(frozen=True)
class Issue:
    kind: str
    message: str
    placements: tuple[int, ...] = ()


@dataclass
class Report:
    parts: int = 0
    lots: int = 0
    size: tuple[float, float, float] = (0, 0, 0)  # studs wide, plates tall, studs deep
    bounds: tuple[float, ...] = (0, 0, 0, 0, 0, 0)  # LDU min xyz, max xyz
    modules: dict[str, int] = field(default_factory=dict)
    colors: dict[int, int] = field(default_factory=dict)
    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    estimated_parts_cost: str | None = None
    plan: Plan | None = None  # the building order, when the build was held to the publication rules

    @property
    def ok(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict:
        return {
            "ok": self.ok, "parts": self.parts, "lots": self.lots, "size": list(self.size),
            "bounds": list(self.bounds), "modules": self.modules,
            "colors": {str(k): v for k, v in self.colors.items()},
            "errors": [{"kind": i.kind, "message": i.message} for i in self.errors],
            "warnings": [{"kind": i.kind, "message": i.message} for i in self.warnings],
            "notes": self.notes, "estimated_parts_cost": self.estimated_parts_cost,
            "physical_validity": "not_proven",
            **({"instruction_steps": self.plan.step_count} if self.plan else {}),
        }

    def to_text(self, color_names: dict[int, str] | None = None) -> str:
        names = color_names or {}
        width, height, depth = self.size
        lines = [
            f"{'BUILD OK' if self.ok else 'BUILD HAS ERRORS'}: {self.parts} parts in {self.lots} part/color lots; "
            f"{width:g} studs wide (x) x {depth:g} studs deep (z) x {height:g} plates tall.",
            "Modules: " + ", ".join(f"{name} {count}" for name, count in self.modules.items()),
            "Colors: " + ", ".join(f"{names.get(code, code)} {count}" for code, count in
                                    sorted(self.colors.items(), key=lambda item: -item[1])[:10]),
        ]
        if self.estimated_parts_cost:
            lines.append(f"Estimated parts cost: ${self.estimated_parts_cost}")
        for title, issues in (("Errors", self.errors), ("Warnings", self.warnings)):
            if issues:
                lines.append(f"{title} ({len(issues)}):")
                lines += [f"- [{issue.kind}] {issue.message}" for issue in issues[:30]]
                if len(issues) > 30:
                    lines.append(f"- ... and {len(issues) - 30} more")
        lines += [f"Note: {note}" for note in self.notes]
        return "\n".join(lines)


def _axis_aligned(matrix) -> bool:
    return all(min(abs(v), abs(abs(v) - 1)) < 1e-6 for v in matrix)


def _world_boxes(shape, placement: Placement) -> list[tuple[float, ...]]:
    m, (tx, ty, tz) = placement.matrix, placement.position
    boxes = []
    for x0, y0, z0, x1, y1, z1 in shape.boxes:
        ax = m[0] * x0 + m[1] * y0 + m[2] * z0 + tx
        ay = m[3] * x0 + m[4] * y0 + m[5] * z0 + ty
        az = m[6] * x0 + m[7] * y0 + m[8] * z0 + tz
        bx = m[0] * x1 + m[1] * y1 + m[2] * z1 + tx
        by = m[3] * x1 + m[4] * y1 + m[5] * z1 + ty
        bz = m[6] * x1 + m[7] * y1 + m[8] * z1 + tz
        boxes.append((min(ax, bx), min(ay, by), min(az, bz), max(ax, bx), max(ay, by), max(az, bz)))
    return boxes


def colliding_pairs(placements, boxes: dict[int, list], cells: dict[tuple[int, int], list]) -> list[tuple[int, int]]:
    """Pairs of placements that occupy the same space, worst first, leaving out declared overlaps."""
    worst: dict[tuple[int, int], float] = {}
    for members in cells.values():
        for a in range(len(members)):
            first, box = members[a]
            for b in range(a + 1, len(members)):
                second, other = members[b]
                if first == second:
                    continue
                dx = min(box[3], other[3]) - max(box[0], other[0])
                dy = min(box[4], other[4]) - max(box[1], other[1])
                dz = min(box[5], other[5]) - max(box[2], other[2])
                if dx > OVERLAP_TOLERANCE and dy > OVERLAP_TOLERANCE and dz > OVERLAP_TOLERANCE:
                    pair = (min(first, second), max(first, second))
                    worst[pair] = max(worst.get(pair, 0.0), dx * dy * dz)
    return [pair for pair, _ in sorted(worst.items(), key=lambda item: -item[1])]


def hash_boxes(boxes: dict[int, list]) -> dict[tuple[int, int], list]:
    """Broad phase: which boxes touch each coarse grid cell."""
    cells: dict[tuple[int, int], list] = defaultdict(list)
    for index, own in boxes.items():
        for box in own:
            for cx in range(int(box[0] // HASH), int((box[3] - 1e-6) // HASH) + 1):
                for cz in range(int(box[2] // HASH), int((box[5] - 1e-6) // HASH) + 1):
                    cells[(cx, cz)].append((index, box))
    return cells


def world_boxes(shape, placement: Placement) -> list[tuple[float, ...]]:
    """A placed part's boxes in model space."""
    return _world_boxes(shape, placement)


@dataclass(frozen=True)
class StudContact:
    """A stud of one placement that sits inside another."""

    stud: int
    receiver: int
    axis: tuple[float, float, float]  # the way the stud points, in model space


def stud_contacts(placements, shapes: ShapeLibrary, boxes: dict[int, list],
                  cells: dict[tuple[int, int], list], *, free_rotation: bool = False) -> list[StudContact]:
    """Every stud that enters another part, once per pair of parts and direction.

    A part at a free rotation has no boxes in ``cells``. With ``free_rotation`` the stud's probe
    point is turned into that part's own frame and tested against its shape there.
    """
    turned = []
    for index, placement in enumerate(placements if free_rotation else ()):
        if index not in boxes:
            try:
                turned.append((index, placement, shapes.get(placement.part).boxes))
            except LDrawError:
                continue
    found: dict[tuple[int, int, tuple], StudContact] = {}
    for index, placement in enumerate(placements):
        try:
            shape = shapes.get(placement.part)
        except LDrawError:
            continue
        m, (tx, ty, tz) = placement.matrix, placement.position
        for sx, sy, sz, dx, dy, dz in shape.studs:
            # A point inside the stud; a mating part must be solid there.
            lx, ly, lz = sx + dx * STUD_PROBE, sy + dy * STUD_PROBE, sz + dz * STUD_PROBE
            px = m[0] * lx + m[1] * ly + m[2] * lz + tx
            py = m[3] * lx + m[4] * ly + m[5] * lz + ty
            pz = m[6] * lx + m[7] * ly + m[8] * lz + tz
            axis = tuple(round(m[3 * row] * dx + m[3 * row + 1] * dy + m[3 * row + 2] * dz, 6) for row in range(3))
            hit = [other for other, box in cells.get((int(px // HASH), int(pz // HASH)), ())
                   if other != index and _inside(box, px, py, pz)]
            for other, receiver, local in turned:
                if other != index:
                    n, (ox, oy, oz) = receiver.matrix, receiver.position
                    rx, ry, rz = px - ox, py - oy, pz - oz  # the inverse of a rotation is its transpose
                    point = (n[0] * rx + n[3] * ry + n[6] * rz, n[1] * rx + n[4] * ry + n[7] * rz,
                             n[2] * rx + n[5] * ry + n[8] * rz)
                    if any(_inside(box, *point) for box in local):
                        hit.append(other)
            for other in hit:
                found.setdefault((index, other, axis), StudContact(index, other, axis))
    return list(found.values())


def _inside(box, x: float, y: float, z: float) -> bool:
    return box[0] - 0.5 <= x <= box[3] + 0.5 and box[1] - 0.5 <= y <= box[4] + 0.5 and box[2] - 0.5 <= z <= box[5] + 0.5


class _Groups:
    def __init__(self, size: int):
        self.parent = list(range(size))

    def find(self, item: int) -> int:
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def join(self, first: int, second: int) -> None:
        a, b = self.find(first), self.find(second)
        if a != b:
            self.parent[max(a, b)] = min(a, b)


class ModelChecker:
    def __init__(self, library: LDrawLibrary, shapes: ShapeLibrary, palette: Palette, *, max_parts: int = 2000,
                 assembly: AssemblyReview | None = None):
        self._library = library
        self._shapes = shapes
        self._palette = palette
        self._max_parts = max_parts
        self._assembly = assembly  # the publication rules, for the methods that ask for them

    def _label(self, index: int, placement: Placement, boxes: dict[int, list]) -> str:
        own = boxes.get(index)
        where = ""
        if own:
            x = min(b[0] for b in own) / STUD
            z = min(b[2] for b in own) / STUD
            y = -max(b[4] for b in own) / PLATE
            where = f" at x={x:g} y={y:g} z={z:g}"
        names = self._library.colors()
        color = names[placement.color].name if placement.color in names else placement.color
        return f"#{index} {placement.part} {color}{where} [{placement.module}]"

    def check(self, build: Build) -> Report:
        report = Report()
        placements = build.placements
        report.parts = len(placements)
        if not placements:
            report.errors.append(Issue("empty", "The script placed no parts."))
            return report
        inventory = Counter((p.part, p.color) for p in placements)
        report.lots = len(inventory)
        report.modules = dict(Counter(p.module for p in placements))
        report.colors = dict(Counter(p.color for p in placements))

        boxes: dict[int, list] = {}
        free_rotation = []
        for index, placement in enumerate(placements):
            try:
                shape = self._shapes.get(placement.part)
            except LDrawError as exc:
                report.errors.append(Issue("part", str(exc), (index,)))
                continue
            if _axis_aligned(placement.matrix):
                boxes[index] = _world_boxes(shape, placement)
            else:
                free_rotation.append(index)
        if boxes:
            every = [box for own in boxes.values() for box in own]
            lo = [min(b[i] for b in every) for i in range(3)]
            hi = [max(b[i + 3] for b in every) for i in range(3)]
            report.bounds = (*lo, *hi)
            report.size = (round((hi[0] - lo[0]) / STUD, 1), round((hi[1] - lo[1]) / PLATE, 1),
                           round((hi[2] - lo[2]) / STUD, 1))

        self._check_inventory(inventory, placements, report)
        if report.parts > self._max_parts:
            report.errors.append(Issue("limit", f"{report.parts} parts exceeds the limit of {self._max_parts}. "
                                                "Simplify or use larger parts."))
        cells = self._hash(boxes)
        # Joints that can be measured: a peg, pin, bar or axle of one part in a hole or clip of another.
        measured = self._assembly.measure(placements) if self._assembly is not None else None
        fits = measured.fits if measured is not None else set()
        self._check_overlaps(placements, boxes, cells, report, self._assembly.seated(fits) if fits else fits)
        contacts = self._check_connections(build, boxes, cells, report, fits)
        if self._assembly is not None:
            self._assembly.review(build, boxes, contacts, measured, report,
                                  lambda i: self._label(i, placements[i], boxes))
            if free_rotation:
                report.notes.append(f"{len(free_rotation)} placements use a free rotation; only the solid plastic "
                                    "of plain bricks, plates and tiles is checked on them.")
            report.notes.append("Checks cover overlaps, solid plastic, stud connections, connector fit, Technic "
                                "seating, declared joints and the building order. Strength, balance and insertion "
                                "clearance are not verified.")
            return report
        if free_rotation:
            report.notes.append(f"{len(free_rotation)} placements use a free rotation; their overlaps were not "
                                "checked and they only count as connected through their own studs or connect().")
        report.notes.append("Checks cover overlaps and stud connections. Clips, bars, hinges, balance and "
                            "insertion clearance are not verified.")
        return report

    def _check_inventory(self, inventory: Counter, placements, report: Report) -> None:
        names = self._library.colors()
        total = Decimal(0)
        priced = True
        for (part, color), quantity in sorted(inventory.items()):
            if not self._palette.allows(part, color):
                available = self._palette.colors_for(part)
                if available:
                    listed = ", ".join(f"{c} {names[c].name}" if c in names else str(c) for c in available[:14])
                    hint = f"available colors: {listed}{' ...' if len(available) > 14 else ''}"
                else:
                    hint = "this part is not in the catalog; search_parts for an available alternative"
                color_name = names[color].name if color in names else color
                indices = tuple(i for i, p in enumerate(placements) if (p.part, p.color) == (part, color))
                report.errors.append(Issue("palette", f"{part} in {color_name} ({color}) x{quantity} is not "
                                                      f"available; {hint}.", indices[:MAX_LISTED]))
                priced = False
                continue
            limit = self._palette.quantity_limit(part, color)
            if limit is not None and quantity > limit:
                report.errors.append(Issue("quantity", f"{part} color {color}: {quantity} used, {limit} available."))
            price = self._palette.unit_price(part, color)
            if price is None:
                priced = False
            else:
                total += price * quantity
        if priced:
            report.estimated_parts_cost = f"{total:.2f}"

    @staticmethod
    def _hash(boxes: dict[int, list]) -> dict[tuple[int, int], list]:
        return hash_boxes(boxes)

    def _check_overlaps(self, placements, boxes, cells, report: Report, fits: set = frozenset()) -> None:
        declared = fitted = 0
        colliding = []
        for first, second in colliding_pairs(placements, boxes, cells):
            if (first, second) in fits:
                fitted += 1  # seated in each other, or on the same part: coarse shapes that share space
            elif placements[first].allow_overlap or placements[second].allow_overlap:
                declared += 1
            else:
                colliding.append((first, second))
        for first, second in colliding[:MAX_LISTED]:
            report.errors.append(Issue(
                "overlap", f"{self._label(first, placements[first], boxes)} occupies the same space as "
                           f"{self._label(second, placements[second], boxes)}.", (first, second)))
        if len(colliding) > MAX_LISTED:
            by_module = Counter(tuple(sorted({placements[a].module, placements[b].module})) for a, b in colliding)
            summary = ", ".join(f"{' / '.join(pair)} {count}" for pair, count in by_module.most_common(6))
            report.errors.append(Issue("overlap", f"{len(colliding) - MAX_LISTED} more overlapping pairs "
                                                  f"(by module: {summary})."))
        if declared:
            report.notes.append(f"{declared} overlapping pairs were declared intentional with allow_overlap.")
        if fitted:
            report.notes.append(f"{fitted} overlapping pairs are parts seated in or beside a measured joint "
                                "(pin, bar, clip, hinge, wheel, pane or door).")

    def _check_connections(self, build: Build, boxes, cells, report: Report,
                           fits: set = frozenset()) -> list[StudContact]:
        placements = build.placements
        groups = _Groups(len(placements))
        contacts = stud_contacts(placements, self._shapes, boxes, cells, free_rotation=self._assembly is not None)
        for contact in contacts:
            groups.join(contact.stud, contact.receiver)
        for first, second, _ in build.links:
            groups.join(first, second)
        for first, second in fits:
            groups.join(first, second)
        if build.links and self._assembly is None:
            report.notes.append(f"{len(build.links)} connections were declared with connect() and not verified.")
        self._check_grounding(placements, groups, boxes, report)
        return contacts

    def _check_grounding(self, placements, groups: _Groups, boxes, report: Report) -> None:
        members: dict[int, list[int]] = defaultdict(list)
        for index in range(len(placements)):
            members[groups.find(index)].append(index)
        if len(members) == 1 or not boxes:
            return
        ground = max(box[4] for own in boxes.values() for box in own)
        grounded, floating = [], []
        for group in members.values():
            lowest = max((box[4] for i in group for box in boxes.get(i, ())), default=None)
            (grounded if lowest is not None and lowest >= ground - 0.5 else floating).append(group)
        floating.sort(key=len, reverse=True)
        for group in floating[:MAX_LISTED]:
            sample = "; ".join(self._label(i, placements[i], boxes) for i in group[:3])
            more = f" and {len(group) - 3} more" if len(group) > 3 else ""
            report.errors.append(Issue(
                "floating", f"{len(group)} part(s) are not attached to anything that reaches the ground: "
                            f"{sample}{more}. A stud must enter the part above or below it.", tuple(group[:MAX_LISTED])))
        if len(floating) > MAX_LISTED:
            rest = sum(len(g) for g in floating[MAX_LISTED:])
            report.errors.append(Issue("floating", f"{len(floating) - MAX_LISTED} more unattached groups "
                                                   f"({rest} parts)."))
        if len(grounded) > 1:
            grounded.sort(key=len, reverse=True)
            sample = "; ".join(f"{len(g)} parts incl. {self._label(g[0], placements[g[0]], boxes)}"
                               for g in grounded[1:4])
            report.warnings.append(Issue(
                "separate", f"The model is {len(grounded)} separate free-standing assemblies; the main one has "
                            f"{len(grounded[0])} parts. Others: {sample}. Join them with a shared base or "
                            "overlapping plates unless they are meant to be separate."))
