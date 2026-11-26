"""The stocked part that can stand for a part the catalog does not stock.

Models and official sets name a part by the number it had when they were written, and use parts
BrickBuilder does not sell. ``StockedParts`` finds what to use instead: first the same mould
under another number, then a part that measures the same. It never proposes a part that would
not fill the same space with the same studs, so what is built around it still fits.
"""

from __future__ import annotations

import re
from collections import defaultdict

from .ldraw import LDrawError, LDrawLibrary
from .palette import Palette
from .shape import ShapeLibrary

# Older moulds of a part the catalog stocks under a newer number, where the numbers share nothing.
# A stand-in is used only when it measures the same as the part it replaces.
RENUMBERED = {
    "3794": ("15573",), "3794a": ("15573",), "3794b": ("15573",), "4085a": ("4085c",), "4085b": ("4085c",),
    "6019": ("61252",), "2555": ("15712",), "4081a": ("4081b",), "3684": ("3684c",),
    "2780": ("61332", "4459"), "3641": ("87414",), "4589": ("59900",), "4265c": ("32123",), "4265b": ("32123",),
}


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
        self._by_size: dict[tuple[int, ...], list[str]] | None = None

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
        while (target := self._moved_to(target)) and target not in seen:  # the number it moved to, or is an alias of
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
        choices = [*self._variants.get(re.sub(r"[a-z]+$", "", part), ()), *RENUMBERED.get(part, ())]
        return next((choice for choice in choices if self._alike(part, choice)), None)

    def _moved_to(self, part: str) -> str | None:
        path = self._library.root / "parts" / f"{part}.dat"
        if not path.is_file():
            return None
        with path.open(encoding="utf-8", errors="replace") as handle:
            title = " ".join(handle.readline().split())
            moved = re.fullmatch(r"0 ~Moved to (\S+)", title)
            if moved:
                return moved.group(1).lower()
            if title.startswith("0 ="):  # an alias: the file is one reference to the part it stands for
                for line in handle:
                    tokens = line.split()
                    if len(tokens) == 15 and tokens[0] == "1":
                        return tokens[14].lower().removesuffix(".dat")
        return None

    def _alike(self, first: str, second: str) -> bool:
        """The same outline and the same studs: one can stand where the other did."""
        try:
            a, b = self._shapes.get(first), self._shapes.get(second)
        except LDrawError:
            return False
        near = lambda p, q: all(abs(x - y) < 0.6 for x, y in zip(p, q))  # noqa: E731
        return (bool(self._palette.colors_for(second)) and near(a.lo, b.lo) and near(a.hi, b.hi)
                and len(a.studs) == len(b.studs) and all(near(p, q) for p, q in zip(sorted(a.studs), sorted(b.studs))))

    def similar(self, part: str) -> str | None:
        """A stocked part that measures the same as ``part``: outline, height, studs and surfaces.

        Used when the mould itself is not stocked under any number. A part whose name starts with
        the same word (Brick, Plate, Slope, Tile...) is preferred. None when nothing stocked
        would fill the same space and offer the same studs.
        """
        try:
            wanted = self._shapes.get(part)
        except LDrawError:
            return None
        if self._by_size is None:
            self._by_size = defaultdict(list)
            for stocked in self._palette.part_ids():
                try:
                    shape = self._shapes.get(stocked)
                except LDrawError:
                    continue
                self._by_size[self._size(shape)].append(stocked)
        word = self._first_word(part)
        choices = [stocked for stocked in self._by_size.get(self._size(wanted), ()) if stocked != part
                   and self._alike(part, stocked) and self._same_surfaces(wanted, self._shapes.get(stocked))]
        choices.sort(key=lambda stocked: (self._first_word(stocked) != word, stocked))
        return choices[0] if choices else None

    @staticmethod
    def _size(shape) -> tuple[int, ...]:
        return (*(round(hi - lo) for lo, hi in zip(shape.lo, shape.hi)), len(shape.studs))

    @staticmethod
    def _same_surfaces(first, second) -> bool:
        def close(a, b) -> bool:
            return len(a) == len(b) and all(len(p) == len(q) and all(
                (x is None) == (y is None) and (x is None or abs(x - y) < 0.6) for x, y in zip(p, q))
                for p, q in zip(a, b))
        return close(first.top, second.top) and close(first.bottom, second.bottom)

    def _first_word(self, part: str) -> str:
        return (self._library.description(part).lstrip("~_= ").split() or [""])[0]

