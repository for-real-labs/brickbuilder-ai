"""Turn a public LDraw model of an official set into an example build script.

The LDraw Official Model Repository holds fan-made files of official sets under licences that
allow reuse with credit. A set is not a build script, and much of it is held together in ways
the checks cannot follow (clips, hinges, minifigures). This module keeps what the kit can stand
behind: parts and colors that are stocked, on the ground or joined to it by studs, with no
overlap, in an order that can be built. If most of a set survives and passes every check a Pip
build must pass, it becomes a script of plain ``place`` calls. Sets that do not survive are
left out, so an example never shows the model something its own report would refuse.

Used by ``scripts/build_fable_examples.py``; nothing here runs during a build.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

from ..checks import ModelChecker, colliding_pairs, hash_boxes, stud_contacts, world_boxes
from ..kit import Build, Kit, KitError, Placement, rect, ring
from ..ldraw import LDrawError, LDrawLibrary
from ..palette import Palette, nearest_color
from ..shape import PLATE, STUD, ShapeLibrary

MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_DEPTH = 12
REUSABLE = re.compile(r"CCAL|CC BY", re.IGNORECASE)  # licences that allow reuse with credit
IDENTITY = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
QUARTERS = {0: (1, 0, 0, 0, 1, 0, 0, 0, 1), 90: (0, 0, 1, 0, 1, 0, -1, 0, 0),
            180: (-1, 0, 0, 0, 1, 0, 0, 0, -1), 270: (0, 0, -1, 0, 1, 0, 1, 0, 0)}


# Older moulds of a part the catalog stocks under a newer number, where the numbers share nothing.
# A stand-in is used only when it measures the same as the part it replaces.
RENUMBERED = {"3794": "15573", "3794a": "15573", "3794b": "15573", "4085a": "4085c", "4085b": "4085c",
              "6019": "61252", "2555": "15712", "4081a": "4081b", "3684": "3684c", "3683": "3683"}


class StockedParts:
    """Finds the stocked part that stands for a part a model file names.

    Model files name a part by the number it had when the file was written. The catalog may stock
    the same mould under the number it moved to, the number it moved from, or a later variant.
    """

    def __init__(self, library: LDrawLibrary, shapes: ShapeLibrary, palette: Palette):
        self._library = library
        self._shapes = shapes
        self._palette = palette
        self._known: dict[str, str | None] = {}
        self._moved_from: dict[str, str] | None = None
        self._variants: dict[str, list[str]] | None = None

    def find(self, part: str) -> str | None:
        if part not in self._known:
            self._known[part] = self._look_up(part)
        return self._known[part]

    def _look_up(self, part: str) -> str | None:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,79}", part) or not self._library.has_part(part):
            return None
        if self._palette.colors_for(part):
            return part
        target, seen = part, {part}
        while (target := self._moved_to(target)) and target not in seen:  # the number it moved to
            if self._palette.colors_for(target):
                return target
            seen.add(target)
        if self._moved_from is None:  # a stocked number whose file says it moved to this one
            self._moved_from = {}
            for stocked in self._palette.part_ids():
                moved = self._moved_to(stocked)
                if moved:
                    self._moved_from.setdefault(moved, stocked)
        if part in self._moved_from:
            return self._moved_from[part]
        if self._variants is None:
            self._variants = defaultdict(list)
            for stocked in self._palette.part_ids():
                self._variants[re.sub(r"[a-z]+$", "", stocked)].append(stocked)
        choices = [*self._variants.get(re.sub(r"[a-z]+$", "", part), ()), RENUMBERED.get(part)]
        return next((choice for choice in choices if choice and self._alike(part, choice)), None)

    def _moved_to(self, part: str) -> str | None:
        path = self._library.root / "parts" / f"{part}.dat"
        if not path.is_file():
            return None
        with path.open(encoding="utf-8", errors="replace") as handle:
            moved = re.fullmatch(r"0 ~Moved to (\S+)", " ".join(handle.readline().split()))
        return moved.group(1).lower() if moved else None

    def _alike(self, first: str, second: str) -> bool:
        """The same outline and the same studs: one can stand where the other did."""
        try:
            a, b = self._shapes.get(first), self._shapes.get(second)
        except LDrawError:
            return False
        near = lambda p, q: all(abs(x - y) < 0.6 for x, y in zip(p, q))  # noqa: E731
        return (bool(self._palette.colors_for(second)) and near(a.lo, b.lo) and near(a.hi, b.hi)
                and len(a.studs) == len(b.studs) and all(near(p, q) for p, q in zip(sorted(a.studs), sorted(b.studs))))


# Which category a set belongs to, by the words in its name and then by its theme. The first rule
# that matches wins, so the narrow ones come first. A set that matches none is not used.
CATEGORY_WORDS = (
    ("flat", ("flag", "mosaic", "portrait")),
    ("characters", ("halloween", "pumpkin", "ghost", "santa", "snowman", "robot", "mech", "figure", "brickheadz")),
    ("spacecraft", ("star destroyer", "starfighter", "x wing", "tie fighter", "spaceship", "space ship", "shuttle",
                    "rocket", "falcon", "ufo")),
    ("aircraft", ("plane", "airplane", "seaplane", "helicopter", "jet", "flyer", "glider", "biplane", "bi plane")),
    ("boats", ("boat", "ship", "tug", "ferry", "yacht", "submarine", "raft")),
    ("castles", ("castle", "fort", "knight")),
    # Before trains and houses: a train station and a lighthouse are buildings.
    ("buildings", ("station", "store", "shop", "tower", "building", "center", "centre", "lighthouse", "windmill",
                   "garage", "hospital", "school", "church", "hotel", "museum", "bridge", "hall")),
    ("trains", ("train", "locomotive", "tram", "wagon")),
    ("houses", ("house", "cottage", "cabin", "home", "villa", "bungalow")),
    ("animals", ("fish", "lion", "dinosaur", "cow", "elephant", "turtle", "bird", "dog", "cat", "horse", "dragon",
                 "crocodile", "parrot", "duck", "frog", "bear", "rabbit", "shark", "whale", "spider", "animal")),
    ("cars", ("car", "truck", "tractor", "jeep", "van", "bus", "taxi", "racer", "buggy", "kart", "lorry")),
)
CATEGORY_THEMES = (
    ("buildings", ("architecture", "modular buildings")), ("spacecraft", ("star wars", "space")),
    ("castles", ("castle",)), ("trains", ("train",)), ("characters", ("brickheadz", "mixels")),
)


def categorize(name: str, theme: str = "") -> str | None:
    """The example category for a set with this name (and theme, when one is known)."""
    tokens = re.sub(r"[^a-z0-9]+", " ", name.lower()).split()
    text = " ".join(tokens)

    def named(word: str) -> bool:
        if " " in word:
            return word in text
        # The word itself, its plural, or the end of a compound: tugboat, seaplane.
        return any(token in (word, word + "s") or (len(word) >= 4 and token.endswith(word)) for token in tokens)

    for category, words in CATEGORY_WORDS:
        if any(named(word) for word in words):
            return category
    kind = theme.lower()
    return next((category for category, themes in CATEGORY_THEMES if any(word in kind for word in themes)), None)


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
    most_parts: int = 160
    least_kept: float = 0.8  # of the set's parts that must survive
    most_raw: float = 0.2  # of the kept parts that may need place_ldu (sideways building)


@dataclass(frozen=True)
class Converted:
    script: str
    parts: int  # in the script
    of: int  # in the set


def read_model(text: str) -> SetModel | None:
    """Parse an LDR or MPD file. None when it is too large, empty or not licensed for reuse."""
    if len(text) > MAX_FILE_BYTES:
        return None
    files: dict[str, list] = {}
    current = first = None
    header = {"title": "", "author": "", "theme": ""}
    licences: list[str] = []
    for line in text.splitlines():
        tokens = line.split()
        if len(tokens) >= 3 and tokens[0] == "0" and tokens[1].upper() == "FILE":
            current = " ".join(tokens[2:]).lower()
            files.setdefault(current, [])
            first = first or current
        elif tokens[:1] == ["0"] and len(tokens) >= 3 and tokens[1] == "!LICENSE":
            licences.append(" ".join(tokens[2:]))
        elif tokens[:1] == ["0"] and len(tokens) >= 3 and current in (None, first):
            if tokens[1] == "Author:" and not header["author"]:
                header["author"] = " ".join(tokens[2:])[:80]
            elif tokens[1] == "!THEME" and not header["theme"]:
                header["theme"] = " ".join(tokens[2:])[:80]
        if tokens[:1] == ["0"] and len(tokens) >= 2 and not header["title"] and current in (None, first) \
                and not tokens[1].startswith("!") and tokens[1].upper() not in ("FILE", "NAME:", "AUTHOR:"):
            header["title"] = " ".join(tokens[1:])[:80]
        if len(tokens) >= 15 and tokens[0] == "1":
            if current is None:
                current = first = "__main__"
                files[current] = []
            try:
                numbers = [float(value) for value in tokens[2:14]]
                color = int(tokens[1])
            except ValueError:
                continue
            reference = " ".join(tokens[14:]).lower().replace("\\", "/")
            files[current].append((color, tuple(numbers[:3]), tuple(numbers[3:]), reference))
    # Every file inside must allow reuse: one non-commercial submodel taints the whole model.
    if not first or not licences or not all(REUSABLE.search(licence) for licence in licences):
        return None
    parts: list[tuple] = []

    def walk(name: str, matrix, offset, color: int, depth: int) -> None:
        if depth > MAX_DEPTH:
            return
        for own_color, position, rotation, reference in files.get(name, ()):
            shade = color if own_color in (16, 24) else own_color
            placed = tuple(sum(matrix[3 * row + k] * position[k] for k in range(3)) + offset[row] for row in range(3))
            turned = tuple(sum(matrix[3 * row + k] * rotation[3 * k + col] for k in range(3))
                           for row in range(3) for col in range(3))
            if reference in files and reference != name:
                walk(reference, turned, placed, shade, depth + 1)
            else:
                parts.append((reference.rsplit("/", 1)[-1].removesuffix(".dat"), shade, placed, turned))

    walk(first, IDENTITY, (0.0, 0.0, 0.0), 16, 0)
    if not parts:
        return None
    return SetModel(header["title"], header["author"], licences[0][:120], header["theme"], tuple(parts))


class SetImporter:
    """Converts set models with one parts library, palette and checker (the one Pip builds are held to)."""

    def __init__(self, library: LDrawLibrary, shapes: ShapeLibrary, palette: Palette, finder,
                 checker: ModelChecker, limits: Limits = Limits()):
        self._library = library
        self._shapes = shapes
        self._palette = palette
        self._finder = finder
        self._checker = checker
        self._limits = limits
        self._stock = StockedParts(library, shapes, palette)

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
        limits = self._limits
        total = self.size(model)
        if not limits.least_parts <= total <= limits.most_parts / limits.least_kept:
            return None
        build = self._standing(self._stocked(model))
        if build is None:
            return None
        for _ in range(4):  # dropping a part can strand others, so settle a few times
            kept = self._joined(build)
            if len(kept.placements) == len(build.placements):
                break
            build = kept
        count = len(build.placements)
        if not limits.least_parts <= count <= limits.most_parts or count < limits.least_kept * total:
            return None
        if self._rolling(part for part, *_ in model.parts) > self._rolling(p.part for p in build.placements):
            return None  # a car that lost a wheel is not an example of a car
        report = self._checker.check(build)
        if not report.ok or report.warnings or report.plan is None:
            return None
        script = self._script(build, report.plan.order)
        if script is None or not self._passes(script, count):
            return None
        return Converted(script, count, total)

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
        dropped = {second for _, second in colliding_pairs(placements, boxes, cells)}
        neighbours: dict[int, set[int]] = defaultdict(set)
        for contact in stud_contacts(placements, self._shapes, boxes, cells, free_rotation=True):
            if contact.stud not in dropped and contact.receiver not in dropped:
                neighbours[contact.stud].add(contact.receiver)
                neighbours[contact.receiver].add(contact.stud)
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

    def _script(self, build: Build, order) -> str | None:
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
        if raw > self._limits.most_raw * len(lines):
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
