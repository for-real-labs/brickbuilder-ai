"""Turn a public LDraw model of an official set into example build scripts.

The LDraw Official Model Repository holds fan-made files of official sets under licences that
allow reuse with credit. A file is a model and its submodels (a bogie, a roof, a tower), and each
can be an example of its own. An example keeps the parts the set really uses, whether or not
BrickBuilder stocks them: it is there to show how something is built, and a build made after it
is still held to the catalog. What is left out is what the checks cannot stand behind:
minifigures, parts that overlap, and parts nothing joins to the rest. If most of a model
survives and passes every check a Pip build must pass, apart from the catalog, it becomes a
script of plain ``place`` calls. A model that does not survive is left out, so an example never
shows something a report would refuse.

Used by ``scripts/build_fable_examples.py``; nothing here runs during a build.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

from ..checks import ModelChecker, colliding_pairs, hash_boxes, stud_contacts, world_boxes
from ..fits import FitFinder, around_a_fit
from ..kit import Build, Kit, KitError, Placement, rect, ring
from ..ldraw import LDrawError, LDrawLibrary
from ..palette import Palette, nearest_color
from ..shape import PLATE, STUD, ShapeLibrary
from ..stock import StockedParts  # noqa: F401  (also imported from here by older callers)

MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_DEPTH = 12
REUSABLE = re.compile(r"CCAL|CC BY", re.IGNORECASE)  # licences that allow reuse, commercial too, with credit
IDENTITY = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
QUARTERS = {0: (1, 0, 0, 0, 1, 0, 0, 0, 1), 90: (0, 0, 1, 0, 1, 0, -1, 0, 0),
            180: (-1, 0, 0, 0, 1, 0, 0, 0, -1), 270: (0, 0, -1, 0, 1, 0, 1, 0, 0)}


@dataclass(frozen=True)
class SetModel:
    """One model file, flattened to its parts."""

    title: str
    author: str
    licence: str
    theme: str
    parts: tuple[tuple[str, int, tuple, tuple], ...]  # part id, color, LDraw position, row-major rotation


@dataclass(frozen=True)
class Limits:
    least_parts: int = 15
    most_parts: int | None = None  # no cap: a large set is as good an example as a small one
    least_kept: float = 0.8  # of the set's parts that must survive
    most_raw: float = 0.5  # of the kept parts that may need place_ldu (sideways building)
    original_parts: bool = True  # keep the parts the set uses; False keeps only what the palette stocks
    # Keep a model as a reference even where the checks cannot follow it: parts they find overlapping or
    # unattached, Technic, parts built off the grid. Pip reads it for how a thing is built; its own build
    # is still held to every check. False keeps only models that pass the checks.
    reference: bool = True
    most_technic: float = 0.5  # of the set's parts that may be Technic: beyond it, it is a Technic model


@dataclass(frozen=True)
class Converted:
    script: str
    parts: int  # in the script
    of: int  # in the set
    checked: bool = True  # passes every check a Pip build must pass, apart from the catalog


@dataclass(frozen=True)
class Section:
    """One ``0 FILE`` block of a model file."""

    name: str
    title: str
    author: str
    licence: str
    lines: tuple[tuple, ...]  # color, position, rotation, what is placed (lower case)


@dataclass(frozen=True)
class ModelFile:
    sections: dict[str, Section]  # by lower-case name, in the order of the file; the first is the model
    theme: str

    @property
    def first(self) -> str:
        return next(iter(self.sections))


def read_file(text: str, *, licence: str = "") -> ModelFile | None:
    """Parse an LDR or MPD file into its sections. None when it is too large or empty.

    ``licence`` is what a section without a ``!LICENSE`` line of its own is under: the licence of
    the collection the file comes from, when it states one for all its files.
    """
    if len(text) > MAX_FILE_BYTES:
        return None
    found: dict[str, dict] = {}
    current = None
    theme = ""

    def start(name: str) -> dict:
        return found.setdefault(name.lower(), {"name": name, "title": "", "author": "", "licence": "", "lines": []})

    for line in text.splitlines():
        tokens = line.split()
        if len(tokens) >= 3 and tokens[0] == "0" and tokens[1].upper() == "FILE":
            current = start(line.split(None, 2)[2].strip())
        elif tokens[:1] == ["0"] and len(tokens) >= 3 and tokens[1] == "!LICENSE":
            section = current if current is not None else start("__main__")
            section["licence"] = section["licence"] or " ".join(tokens[2:])[:120]
        elif tokens[:1] == ["0"] and len(tokens) >= 2 and current is not None:
            if tokens[1] == "Author:":
                current["author"] = current["author"] or " ".join(tokens[2:])[:80]
            elif tokens[1] == "!THEME":
                theme = theme or " ".join(tokens[2:])[:80]
            elif (not current["title"] and not current["lines"] and not tokens[1].startswith(("!", "//"))
                  and tokens[1].upper() not in ("FILE", "NAME:", "AUTHOR:")):
                current["title"] = " ".join(tokens[1:])[:400]
        if len(tokens) >= 15 and tokens[0] == "1":
            section = current if current is not None else start("__main__")
            current = section
            try:
                numbers = [float(value) for value in tokens[2:14]]
                color = int(tokens[1])
            except ValueError:
                continue
            reference = " ".join(tokens[14:]).lower().replace("\\", "/")
            section["lines"].append((color, tuple(numbers[:3]), tuple(numbers[3:]), reference))
    if not found:
        return None
    return ModelFile({key: Section(value["name"], value["title"], value["author"], value["licence"] or licence,
                                   tuple(value["lines"])) for key, value in found.items()}, theme)


def flatten(file: ModelFile, section: str | None = None) -> SetModel | None:
    """One section with every submodel it places, as parts. None when it is empty or may not be reused.

    Every section it draws on must allow reuse, and no section of the file may forbid it: one
    non-commercial submodel taints the whole file, used or not. A part defined inside the file
    (a ``.dat`` section) is not a library part and is left out.
    """
    start = (section or file.first).lower()
    if start not in file.sections:
        return None
    if any(one.licence and not REUSABLE.search(one.licence) for one in file.sections.values()):
        return None
    parts: list[tuple] = []
    used: list[Section] = []

    def walk(name: str, matrix, offset, color: int, depth: int) -> None:
        if depth > MAX_DEPTH:
            return
        used.append(file.sections[name])
        for own_color, position, rotation, reference in file.sections[name].lines:
            shade = color if own_color in (16, 24) else own_color
            placed = tuple(sum(matrix[3 * row + k] * position[k] for k in range(3)) + offset[row] for row in range(3))
            turned = tuple(sum(matrix[3 * row + k] * rotation[3 * k + col] for k in range(3))
                           for row in range(3) for col in range(3))
            if reference in file.sections and reference != name:
                if not reference.endswith(".dat"):
                    walk(reference, turned, placed, shade, depth + 1)
            else:
                parts.append((reference.rsplit("/", 1)[-1].removesuffix(".dat"), shade, placed, turned))

    walk(start, IDENTITY, (0.0, 0.0, 0.0), 16, 0)
    if not parts or not all(REUSABLE.search(one.licence) for one in used):
        return None
    top = file.sections[start]
    main = file.sections[file.first]
    return SetModel(top.title[:400], top.author or main.author, top.licence, file.theme, tuple(parts))


def read_model(text: str) -> SetModel | None:
    """A model file flattened to its parts. None when it is too large, empty or not licensed for reuse."""
    file = read_file(text)
    return flatten(file) if file is not None else None


class SetImporter:
    """Converts set models with one parts library, palette and checker (the one Pip builds are held to)."""

    def __init__(self, library: LDrawLibrary, shapes: ShapeLibrary, palette: Palette, finder,
                 checker: ModelChecker, limits: Limits = Limits(), assembly=None):
        self._library = library
        self._shapes = shapes
        self._palette = palette
        self._finder = finder
        self._checker = checker
        self._limits = limits
        self._stock = StockedParts(library, shapes, palette)
        self._fits = FitFinder(library)
        self._assembly = assembly  # the review the checker uses, so parts are kept by the joints it will find

    def size(self, model: SetModel) -> int:
        """The set's own parts: real library parts, without its minifigures."""
        return sum(1 for part, *_ in model.parts if self._is_set_part(part))

    def _rolling(self, parts) -> int:
        """How many wheels and tyres are among the parts."""
        return sum(1 for part in parts if self._is_set_part(part)
                   and re.search(r"\b(Wheels?|Tyres?)\b", self._library.description(part)))

    def _is_set_part(self, part: str) -> bool:
        return (re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,79}", part) is not None and self._library.has_part(part)
                and not self._library.description(part).lstrip("~_=").startswith("Minifig"))

    def convert(self, model: SetModel) -> Converted | None:
        return self.verdict(model)[0]

    def verdict(self, model: SetModel) -> tuple[Converted | None, str]:
        """The converted model, or None with the reason it is not used."""
        limits = self._limits
        total = self.size(model)
        if total < limits.least_parts:
            return None, "too few parts"
        if limits.most_parts and total > limits.most_parts / limits.least_kept:
            return None, "too many parts"
        technic = sum(1 for part, *_ in model.parts
                      if self._is_set_part(part) and self._library.description(part).lstrip("~_=").startswith("Technic"))
        if not limits.reference and technic > limits.most_technic * total:
            return None, "mostly Technic"
        build = self._standing(self._original(model) if limits.original_parts else self._stocked(model))
        if build is None:
            return None, "nothing stands"
        if limits.reference:
            return self._reference(build, total)
        for _ in range(4):  # dropping a part can strand others, so settle a few times
            kept = self._joined(build)
            if len(kept.placements) == len(build.placements):
                break
            build = kept
        count = len(build.placements)
        if count < limits.least_parts or count < limits.least_kept * total:
            return None, "too many parts overlap or are not joined"
        if limits.most_parts and count > limits.most_parts:
            return None, "too many parts"
        if self._rolling(part for part, *_ in model.parts) > self._rolling(p.part for p in build.placements):
            return None, "a wheel is not joined"  # a car that lost a wheel is not an example of a car
        report = self._checker.check(build)
        if not report.ok:
            return None, f"refused by the checks: {report.errors[0].kind}"
        if report.warnings or report.plan is None:
            return None, f"warned by the checks: {report.warnings[0].kind if report.warnings else 'no order'}"
        script = self._script(build, report.plan.order)
        if script is None:
            return None, "mostly built off the grid"
        if not self._passes(script, count):
            return None, "its script does not rebuild it"
        return Converted(script, count, total), ""

    def _reference(self, build: Build, total: int) -> tuple[Converted | None, str]:
        """Every part of the model, as a reference. The checks only say whether it also passes them.

        A model that passes is written in the building order the checks found; any other from the
        ground up.
        """
        count = len(build.placements)
        if self._limits.most_parts and count > self._limits.most_parts:
            return None, "too many parts"
        report = self._checker.check(build)
        checked = report.ok and not report.warnings and report.plan is not None
        order = (report.plan.order if checked else
                 sorted(range(count), key=lambda i: (-build.placements[i].position[1], build.placements[i].position[0],
                                                     build.placements[i].position[2])))
        script = self._script(build, order, any_grid=True)
        if not self._rebuilds(script, count):
            return None, "its script does not rebuild it"
        return Converted(script, count, total, checked), ""

    # ----- what can be kept ----------------------------------------------

    def _stocked(self, model: SetModel) -> list[Placement]:
        """The set's parts that exist in the catalog, each in the stocked color nearest its own."""
        kept = []
        for named, color, position, matrix in model.parts:
            part = self._stock.find(named) if self._is_set_part(named) else None
            if part is None:
                continue
            try:
                self._shapes.get(part)
            except LDrawError:
                continue
            shade = color if self._palette.allows(part, color) else nearest_color(self._library, self._palette, part, color)
            if shade is None or max(abs(value) for value in position) > 20_000:
                continue
            kept.append(Placement(part, shade, tuple(position), tuple(round(value, 6) for value in matrix)))
        return kept

    def _original(self, model: SetModel) -> list[Placement]:
        """The set's own parts in their own colors, stocked or not."""
        colors = self._library.colors()
        kept = []
        for named, color, position, matrix in model.parts:
            if not self._is_set_part(named) or color not in colors or max(abs(value) for value in position) > 20_000:
                continue
            try:
                self._shapes.get(named)
            except LDrawError:
                continue
            kept.append(Placement(named, color, tuple(position), tuple(round(value, 6) for value in matrix)))
        return kept

    def _standing(self, placements: list[Placement]) -> Build | None:
        """Move the model so the ground is at y = 0 and its studs are on the kit's stud lines."""
        boxes = self._boxes(placements)
        if not boxes:
            return None
        ground = max(box[4] for own in boxes.values() for box in own)
        shift_x = shift_z = 0.0
        for placement in placements:
            studs = [stud for stud in self._shapes.get(placement.part).studs if stud[4] < -0.99]
            if studs and tuple(placement.matrix) in {tuple(map(float, turn)) for turn in QUARTERS.values()}:
                m = placement.matrix
                x = m[0] * studs[0][0] + m[2] * studs[0][2] + placement.position[0]
                z = m[6] * studs[0][0] + m[8] * studs[0][2] + placement.position[2]
                shift_x, shift_z = -((x - STUD / 2) % STUD), -((z - STUD / 2) % STUD)
                break
        low_x = min(box[0] for own in boxes.values() for box in own) + shift_x
        low_z = min(box[2] for own in boxes.values() for box in own) + shift_z
        shift_x -= (low_x // STUD) * STUD
        shift_z -= (low_z // STUD) * STUD
        moved = [Placement(p.part, p.color, (round(p.position[0] + shift_x, 4), round(p.position[1] - ground, 4),
                                             round(p.position[2] + shift_z, 4)), p.matrix) for p in placements]
        return Build(moved)

    def _boxes(self, placements: list[Placement]) -> dict[int, list]:
        boxes = {}
        for index, placement in enumerate(placements):
            if all(min(abs(value), abs(abs(value) - 1)) < 1e-6 for value in placement.matrix):
                boxes[index] = world_boxes(self._shapes.get(placement.part), placement)
        return boxes

    def _joined(self, build: Build) -> Build:
        """Without the later part of each overlapping pair, the largest group that stands on the ground."""
        placements = build.placements
        boxes = self._boxes(placements)
        if not boxes:
            return Build()
        cells = hash_boxes(boxes)
        # A pin in its hole shares space with it by design.
        fits = (self._assembly.measure(placements).fits if self._assembly is not None
                else self._fits.find(placements))
        seated = around_a_fit(fits)
        dropped = {second for first, second in colliding_pairs(placements, boxes, cells) if (first, second) not in seated}
        neighbours: dict[int, set[int]] = defaultdict(set)
        joined = [(contact.stud, contact.receiver)
                  for contact in stud_contacts(placements, self._shapes, boxes, cells, free_rotation=True)]
        for first, second in [*joined, *fits]:
            if first not in dropped and second not in dropped:
                neighbours[first].add(second)
                neighbours[second].add(first)
        ground = max(box[4] for own in boxes.values() for box in own)
        seen: set[int] = set()
        best: set[int] = set()
        for start in range(len(placements)):
            if start in seen or start in dropped:
                continue
            group, frontier = {start}, [start]
            while frontier:
                for other in neighbours[frontier.pop()] - group:
                    group.add(other)
                    frontier.append(other)
            seen |= group
            grounded = any(box[4] >= ground - 0.5 for index in group for box in boxes.get(index, ()))
            if grounded and len(group) > len(best):
                best = group
        return Build([placement for index, placement in enumerate(placements) if index in best])

    # ----- writing the script --------------------------------------------

    def _script(self, build: Build, order, *, any_grid: bool = False) -> str | None:
        names = self._library.colors()
        lines, raw = [], 0
        for index in order:
            placement = build.placements[index]
            color = names[placement.color].name
            call = self._grid_call(placement, color)
            if call is None:
                raw += 1
                numbers = ", ".join(f"{value:g}" for value in placement.position)
                turn = ", ".join(f"{value:g}" for value in placement.matrix)
                call = f'place_ldu("{placement.part}", "{color}", ({numbers}), ({turn}))'
            lines.append(call)
        if not any_grid and raw > self._limits.most_raw * len(lines):
            return None
        return "\n".join(lines) + "\n"

    def _grid_call(self, placement: Placement, color: str) -> str | None:
        """The ``place`` call that puts the part exactly here, or None if the grid cannot say it."""
        turn = next((degrees for degrees, matrix in QUARTERS.items()
                     if all(abs(a - b) < 1e-6 for a, b in zip(matrix, placement.matrix))), None)
        if turn is None:
            return None
        shape = self._shapes.get(placement.part)
        cos, sin = QUARTERS[turn][0], QUARTERS[turn][2]
        corners = [(px, pz) for px in (shape.lo[0], shape.hi[0]) for pz in (shape.lo[2], shape.hi[2])]
        x = (placement.position[0] + min(cos * px + sin * pz for px, pz in corners)) / STUD
        z = (placement.position[2] + min(-sin * px + cos * pz for px, pz in corners)) / STUD
        y = (-placement.position[1] - shape.hi[1]) / PLATE
        if any(abs(value * 4 - round(value * 4)) > 1e-6 for value in (x, y, z)):
            return None  # not on a quarter of the grid: say it in LDraw units instead
        rot = f", rot={turn}" if turn else ""
        return f'place("{placement.part}", "{color}", {x:g}, {y:g}, {z:g}{rot})'

    def _rebuilds(self, script: str, count: int) -> bool:
        """Whether the script runs and places every part."""
        kit = Kit(self._library, self._shapes, self._palette, self._finder, max_placements=100_000)
        try:
            exec(compile(script, "<example>", "exec"), {"place": kit.place, "place_ldu": kit.place_ldu,  # noqa: S102
                                                         "rect": rect, "ring": ring, "__builtins__": {}})
        except (KitError, LDrawError):
            return False
        return len(kit.build.placements) == count

    def _passes(self, script: str, count: int) -> bool:
        """Run the finished script as a build would and hold it to the same checks."""
        kit = Kit(self._library, self._shapes, self._palette, self._finder)
        try:
            exec(compile(script, "<example>", "exec"), {"place": kit.place, "place_ldu": kit.place_ldu,  # noqa: S102
                                                         "rect": rect, "ring": ring, "__builtins__": {}})
        except (KitError, LDrawError):
            return False
        report = self._checker.check(kit.build)
        return report.ok and not report.warnings and report.parts == count
