"""Finding parts: keyword search, basic brick/plate/tile families and the starter sheet."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Callable

from .ldraw import LDrawLibrary
from .palette import Palette

_WORD = re.compile(r"[a-z0-9]+(?:/[0-9]+)?")
_DIMENSIONS = re.compile(r"\d+(?:\s*/\s*\d+)?(?:\s*x\s*\d+(?:\s*/\s*\d+)?)+")
_STOP = frozenset({"with", "and", "the", "for", "of", "a", "an", "lego", "piece", "part", "x", "in", "on", "to"})
_NEUTRAL = frozenset({"groove", "brick", "without", "type"})  # words that do not make a part a variant
_SUPPLIER_NOISE = re.compile(r"\s*-\s*\(Undetermined Version\)")
_SYNONYMS = {
    "roof": ("slope",), "roofing": ("slope",), "railing": ("fence", "bar"), "rail": ("fence", "bar"),
    "balustrade": ("fence",), "picket": ("fence", "paled"), "smooth": ("tile",), "tree": ("plant", "tree"),
    "leaf": ("leaves", "plant"), "bush": ("plant", "leaves"), "shrub": ("plant", "leaves"),
    "grass": ("plant", "grass"), "flower": ("flower", "plant"), "pane": ("glass", "pane"),
    "lamp": ("light", "lamp", "lantern"), "light": ("light", "lamp"), "pillar": ("support", "column", "round"),
    "column": ("support", "column", "round"), "post": ("support", "bar"), "stairs": ("stairs", "staircase"),
    "wheel": ("wheel", "tyre"), "tire": ("tyre", "tire"), "gray": ("grey",), "sideways": ("side", "stud"),
    "snot": ("side", "stud", "bracket"), "curved": ("curved", "round"), "wedge": ("wedge",),
    "garage": ("garage", "roller"), "chimney": ("brick", "round"), "awning": ("slope", "curved"),
}
_BASIC = {
    "brick": re.compile(r"^Brick (\d+) x (\d+)$"),
    "plate": re.compile(r"^Plate (\d+) x (\d+)$"),
    "tile": re.compile(r"^Tile (\d+) x (\d+)(?: with Groove)?$"),
}
# Categories shown in the starter sheet, in building priority order, with their size.
_SHEET = (
    ("Brick", 18), ("Plate", 36), ("Tile", 14), ("Slope", 24), ("Slope, Inverted", 10),
    ("Slope, Curved", 14), ("Brick, Modified", 16), ("Plate, Modified", 16), ("Tile, Modified", 6),
    ("Brick, Round", 8), ("Plate, Round", 8), ("Tile, Round", 4), ("Window", 12), ("Glass for Window", 6),
    ("Pane for Window", 4), ("Door", 8), ("Door, Frame", 4), ("Fence", 8), ("Panel", 8), ("Arch", 10),
    ("Plant", 5), ("Plant Leaves", 4), ("Plant Flower", 3), ("Bar", 8), ("Wedge", 6), ("Wedge, Plate", 8),
    ("Cone", 4), ("Cylinder", 3), ("Dish", 3), ("Support", 4), ("Stairs", 2), ("Bracket", 8),
    ("Hinge Brick", 4), ("Hinge Plate", 4), ("Garage Roller Door Section", 2), ("Roof Tile", 4),
)


@dataclass(frozen=True)
class PartEntry:
    part_id: str
    description: str  # LDraw library description
    label: str  # supplier's name, when there is one
    colors: int

    @property
    def title(self) -> str:
        return self.label or self.description or self.part_id


def _tokens(text: str) -> list[str]:
    lowered = text.lower().replace("grey", "gray")
    lowered = re.sub(r"(?<=\d)\s*x\s*(?=\d)", " x ", lowered)
    words = [word for word in _WORD.findall(lowered) if word not in _STOP]
    words += [re.sub(r"\s+", "", match) for match in _DIMENSIONS.findall(lowered)]
    return words


def _singular(word: str) -> str:
    return word[:-1] if len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word


class PartFinder:
    def __init__(self, library: LDrawLibrary, palette: Palette):
        self._library = library
        self._palette = palette
        self._entries: list[PartEntry] | None = None
        self._index: list[tuple[PartEntry, frozenset[str], str]] | None = None
        self._frequency: dict[str, int] = {}

    def entries(self) -> list[PartEntry]:
        if self._entries is None:
            self._entries = [
                PartEntry(part_id, self._library.description(part_id),
                          _SUPPLIER_NOISE.sub("", self._palette.label(part_id)),
                          len(self._palette.colors_for(part_id)))
                for part_id in self._palette.part_ids()
            ]
        return self._entries

    def entry(self, part_id: str) -> PartEntry | None:
        return next((item for item in self.entries() if item.part_id == part_id), None)

    # ----- search --------------------------------------------------------

    def _build_index(self) -> None:
        index = []
        frequency: dict[str, int] = {}
        for entry in self.entries():
            text = f"{entry.part_id} {entry.label} {entry.description}"
            tokens = frozenset(_singular(token) for token in _tokens(text))
            for token in tokens:
                frequency[token] = frequency.get(token, 0) + 1
            index.append((entry, tokens, text.lower().replace("grey", "gray")))
        self._index, self._frequency = index, frequency

    def search(self, query: str, limit: int = 12, color: int | None = None) -> list[PartEntry]:
        if self._index is None:
            self._build_index()
        wanted = [_singular(token) for token in _tokens(query)]
        if not wanted:
            return []
        total = max(1, len(self._index))
        phrase = " ".join(query.lower().replace("grey", "gray").split())
        scored = []
        for entry, tokens, text in self._index:
            if color is not None and not self._palette.allows(entry.part_id, color):
                continue
            score = 0.0
            matched = 0
            for token in wanted:
                weight = math.log(1 + total / (1 + self._frequency.get(token, 0)))
                if token in tokens:
                    score += weight * (2.0 if "x" in token and token[0].isdigit() else 1.0)
                    matched += 1
                elif any(alias in tokens for alias in _SYNONYMS.get(token, ())):
                    score += 0.7 * math.log(1 + total / 50)
                    matched += 1
                elif len(token) >= 4 and any(other.startswith(token) or token.startswith(other)
                                             for other in tokens if len(other) >= 4):
                    score += 0.5 * weight
                    matched += 1
            if not matched:
                continue
            score *= matched / len(wanted)
            if phrase and phrase in text:
                score *= 1.5
            if entry.part_id == phrase:
                score += 100
            if "pattern" in tokens and "pattern" not in wanted:
                score *= 0.4
            # Prefer the plain part over its variants, then the more widely available one.
            extra = len(tokens - set(wanted) - _NEUTRAL - {entry.part_id})
            score *= (1 + 0.15 * math.log(1 + entry.colors)) / (1 + 0.06 * extra)
            scored.append((score, entry))
        scored.sort(key=lambda item: (-item[0], -item[1].colors, item[1].part_id))
        return [entry for _, entry in scored[:max(1, min(limit, 40))]]

    # ----- basic families ------------------------------------------------

    def basic_family(self, kind: str) -> list[tuple[str, int, int]]:
        """Plain rectangular parts of one kind as (part_id, short side, long side)."""
        pattern = _BASIC[kind]
        found: dict[tuple[int, int], PartEntry] = {}
        for entry in self.entries():
            match = pattern.match(entry.label) or pattern.match(entry.description)
            if not match:
                continue
            size = tuple(sorted((int(match.group(1)), int(match.group(2)))))
            if size not in found or entry.colors > found[size].colors:
                found[size] = entry
        return [(entry.part_id, size[0], size[1]) for size, entry in sorted(found.items())]

    def basic_alternatives(self, kind: str) -> dict[tuple[int, int], list[str]]:
        """Every catalog part of each plain size, most widely available first."""
        pattern = _BASIC[kind]
        sizes: dict[tuple[int, int], list[PartEntry]] = {}
        for entry in self.entries():
            match = pattern.match(entry.label) or pattern.match(entry.description)
            if match:
                size = tuple(sorted((int(match.group(1)), int(match.group(2)))))
                sizes.setdefault(size, []).append(entry)
        return {size: [e.part_id for e in sorted(items, key=lambda e: (-e.colors, e.part_id))]
                for size, items in sizes.items()}

    # ----- starter sheet -------------------------------------------------

    @staticmethod
    def _category(title: str) -> str:
        match = re.search(r"\d", title)
        head = title[: match.start()] if match else title
        head = re.split(r"\s+(?:with|without)\b", head)[0]
        return head.strip(" ,-") or "Other"

    def sheet(self, describe: Callable[[PartEntry], str] | None = None, search_tool: str = "search_parts") -> str:
        """The most widely stocked parts of each category. ``describe`` adds facts to an entry."""
        groups: dict[str, list[PartEntry]] = {}
        for entry in self.entries():
            groups.setdefault(self._category(entry.title), []).append(entry)
        lines = []
        shown = set()
        for category, size in _SHEET:
            members = sorted(groups.get(category, []), key=lambda e: (-e.colors, e.part_id))
            if not members:
                continue
            shown.add(category)
            items = "; ".join(f"{e.part_id} {e.title.removeprefix(category).strip(' ,') or e.title} ({e.colors})"
                              + (describe(e) if describe else "") for e in members[:size])
            more = f"; +{len(members) - size} more" if len(members) > size else ""
            lines.append(f"{category}: {items}{more}")
        rest = sorted(((len(v), k) for k, v in groups.items() if k not in shown), reverse=True)
        if rest:
            lines.append(f"Other categories (use {search_tool}): "
                         + ", ".join(f"{name} ({count})" for count, name in rest[:60]))
        return "\n".join(lines)

    def color_sheet(self) -> str:
        counts: dict[int, int] = {}
        for part_id in self._palette.part_ids():
            for color in self._palette.colors_for(part_id):
                counts[color] = counts.get(color, 0) + 1
        known = self._library.colors()
        rows = []
        for color, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
            info = known.get(color)
            if info is None:
                continue
            rows.append(f"{color} {info.name} {info.hex}{' transparent' if info.transparent else ''} ({count})")
        return "; ".join(rows)
