"""Which part/color pairs a build may use.

The agent depends on this small interface rather than on a supplier. BrickBuilder's
exact supplier inventory is adapted from the existing ``PartsCatalog``; pricing and
supplier identifiers never reach the model.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from typing import Protocol

from .ldraw import LDrawLibrary

RESERVED_COLORS = frozenset({16, 24})  # inherited color and edge color


class Palette(Protocol):
    name: str

    def part_ids(self) -> list[str]: ...

    def allows(self, part_id: str, color: int) -> bool: ...

    def colors_for(self, part_id: str) -> list[int]: ...

    def label(self, part_id: str) -> str: ...

    def quantity_limit(self, part_id: str, color: int) -> int | None: ...

    def unit_price(self, part_id: str, color: int) -> Decimal | None: ...


class OpenPalette:
    """Every library part in every standard color; used when no inventory applies."""

    name = "all LDraw parts"

    def __init__(self, library: LDrawLibrary):
        self._library = library
        self._colors = sorted(code for code in library.colors() if code not in RESERVED_COLORS)
        self._parts: list[str] | None = None

    def part_ids(self) -> list[str]:
        if self._parts is None:
            self._parts = self._library.part_ids()
        return self._parts

    def allows(self, part_id: str, color: int) -> bool:
        return color in self._library.colors() and color not in RESERVED_COLORS and self._library.has_part(part_id)

    def colors_for(self, part_id: str) -> list[int]:
        return self._colors if self._library.has_part(part_id) else []

    def label(self, part_id: str) -> str:
        return ""

    def quantity_limit(self, part_id: str, color: int) -> int | None:
        return None

    def unit_price(self, part_id: str, color: int) -> Decimal | None:
        return None


class CatalogPalette:
    """Adapter over BrickBuilder's supplier ``PartsCatalog``."""

    def __init__(self, catalog, library: LDrawLibrary, name: str = "parts catalog"):
        self.name = name
        self._by_part: dict[str, dict[int, object]] = {}
        for (part_id, color), entry in catalog.parts.items():
            if color in RESERVED_COLORS or not library.has_part(part_id):
                continue  # A part the library cannot draw cannot be placed or checked.
            self._by_part.setdefault(part_id, {})[color] = entry

    def part_ids(self) -> list[str]:
        return sorted(self._by_part)

    def allows(self, part_id: str, color: int) -> bool:
        return color in self._by_part.get(part_id, {})

    def colors_for(self, part_id: str) -> list[int]:
        return sorted(self._by_part.get(part_id, {}))

    def label(self, part_id: str) -> str:
        entries = self._by_part.get(part_id)
        label = next(iter(entries.values())).name if entries else ""
        return "" if label == part_id else label

    def quantity_limit(self, part_id: str, color: int) -> int | None:
        entry = self._by_part.get(part_id, {}).get(color)
        return entry.max_quantity if entry is not None else None

    def unit_price(self, part_id: str, color: int) -> Decimal | None:
        entry = self._by_part.get(part_id, {}).get(color)
        return entry.unit_price if entry is not None else None


def nearest_color(library: LDrawLibrary, palette: Palette, part_id: str, color: int) -> int | None:
    """The color ``part_id`` is available in that looks most like ``color``; None if it comes in none.

    A transparent color is matched with transparent ones first, so glass stays glass.
    """
    known = library.colors()
    choices = [code for code in palette.colors_for(part_id) if code in known]
    if not choices or color not in known:
        return choices[0] if choices else None
    if color in choices:
        return color
    wanted = known[color]
    alike = [code for code in choices if known[code].transparent == wanted.transparent] or choices

    def channels(value: str) -> tuple[int, int, int]:
        digits = value.lstrip("#")
        return int(digits[0:2], 16), int(digits[2:4], 16), int(digits[4:6], 16)

    target = channels(wanted.hex)
    return min(alike, key=lambda code: (sum((a - b) ** 2 for a, b in zip(channels(known[code].hex), target)), code))


def load_palette(library: LDrawLibrary, catalog_path: Path | str | None = None, *, open_palette: bool = False,
                 inventory_csv: str | None = None):
    """The supplier inventory by default; ``open_palette`` lifts the restriction."""
    from src.utils.parts_catalog import PartsCatalog

    if inventory_csv is not None:
        palette = CatalogPalette(PartsCatalog.from_csv(inventory_csv), library, "your parts inventory")
        if not palette.part_ids():
            raise ValueError("Pip could not find any of these parts in the LDraw library.")
        return palette
    if open_palette:
        return OpenPalette(library)
    from src.utils.supplier_catalog import catalog_path as default_catalog_path

    path = Path(catalog_path) if catalog_path else default_catalog_path()
    return CatalogPalette(PartsCatalog.load(path), library, path.stem.replace("_", " "))
