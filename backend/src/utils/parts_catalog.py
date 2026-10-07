"""Supplier-independent, exact LDraw part/color inventory and Decimal pricing.

CSV columns: part_id, color_id; optional name, sku, unit_price, weight_kg,
max_quantity. Prices are USD per piece; absent prices are never guessed.
Rows without LDraw mappings can be retained, but cannot authorize placements.
"""
from __future__ import annotations

import csv
import io
import math
import re
from collections import Counter
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

PART_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,79}$")
MAX_CATALOG_BYTES = 16 * 1024 * 1024


def normalize_part_id(value: str) -> str:
    value = value.strip().lower().replace("\\", "/")
    if value.startswith("parts/"):
        value = value[6:]
    if value.endswith(".dat"):
        value = value[:-4]
    if not PART_ID.fullmatch(value):
        raise ValueError("Invalid LDraw part identifier")
    return value


def nonnegative_decimal(value: str) -> Decimal:
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise ValueError("Invalid catalog price or weight") from None
    if not number.is_finite() or number < 0 or number > 1000000:
        raise ValueError("Invalid catalog price or weight")
    return number


@dataclass(frozen=True)
class CatalogPart:
    part_id: str
    color_id: int
    name: str
    sku: str
    unit_price: Decimal | None
    weight_kg: Decimal | None
    max_quantity: int | None = None


class PartsUnavailable(ValueError):
    """An actionable, bounded report for the agent or pricing caller."""


class PartsCatalog:
    def __init__(self, parts: list[CatalogPart], *, name: str = "Parts catalog"):
        self.name = name
        self.parts = {}
        skus = {}
        for part in parts:
            key = (part.part_id, part.color_id)
            if key in self.parts and self.parts[key] != part:
                raise ValueError(f"Ambiguous catalog mapping: {part.part_id}/{part.color_id}")
            self.parts[key] = part
            terms = (part.unit_price, part.weight_kg, part.max_quantity)
            if part.sku in skus and skus[part.sku] != terms:
                raise ValueError('Inconsistent price or quantity limit for a supplier SKU')
            skus[part.sku] = terms
        if not self.parts:
            raise ValueError("Parts catalog has no mapped, purchasable parts")

    @classmethod
    def from_csv(cls, content: str, *, name: str = "Parts catalog") -> PartsCatalog:
        if len(content.encode()) > MAX_CATALOG_BYTES:
            raise ValueError("Parts catalog exceeds its size limit")
        reader = csv.DictReader(io.StringIO(content))
        required = {"part_id", "color_id"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError("Parts catalog is missing required columns")
        parts = []
        for row in reader:
            if not row["part_id"] or not row["color_id"]:
                continue
            color = int(row["color_id"])
            limit = int(row["max_quantity"]) if row.get("max_quantity") else None
            if color < 0 or color in {16, 24} or limit is not None and limit < 0:
                raise ValueError("Invalid catalog color or quantity limit")
            name = row.get('name') or row['part_id']
            sku = row.get('sku') or f"{normalize_part_id(row['part_id'])}-{color}"
            if len(name) > 300 or len(sku) > 100:
                raise ValueError("Invalid catalog description or SKU")
            parts.append(CatalogPart(normalize_part_id(row["part_id"]), color,
                name, sku, nonnegative_decimal(row["unit_price"]) if row.get('unit_price') else None,
                nonnegative_decimal(row["weight_kg"]) if row.get('weight_kg') else None, limit))
        return cls(parts, name=name)

    @classmethod
    def load(cls, path: Path) -> PartsCatalog:
        if path.stat().st_size > MAX_CATALOG_BYTES:
            raise ValueError("Parts catalog exceeds its size limit")
        return cls.from_csv(path.read_text(encoding="utf-8"), name=path.stem)

    def validate(self, inventory: dict[tuple[str, int], int]) -> None:
        errors, quantities, limits = [], Counter(), {}
        for (part_id, color), quantity in inventory.items():
            if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity <= 0:
                raise ValueError("Part quantities must be positive integers")
            part = self.parts.get((normalize_part_id(part_id), color))
            if part is None:
                errors.append(f"{part_id}.dat color {color} (x{quantity})")
                continue
            quantities[part.sku] += quantity
            limits[part.sku] = part.max_quantity
        for sku, quantity in quantities.items():
            limit = limits[sku]
            if limit is not None and quantity > limit:
                errors.append(f"{sku}: requested {quantity}, available {limit}")
        if errors:
            remaining = f"; and {len(errors) - 20} more" if len(errors) > 20 else ""
            raise PartsUnavailable("Parts unavailable in the allowed catalog: " + "; ".join(errors[:20]) + remaining)
        if not inventory:
            raise ValueError("Model contains no physical parts")

    def quote(self, inventory: dict[tuple[str, int], int]) -> tuple[Decimal, Decimal]:
        self.validate(inventory)
        price, weight = Decimal(0), Decimal(0)
        for (part_id, color), quantity in inventory.items():
            part = self.parts[(normalize_part_id(part_id), color)]
            if part.unit_price is None or part.weight_kg is None:
                raise PartsUnavailable(f'No supplier price or weight for {part.part_id}.dat color {color}')
            price += part.unit_price * quantity
            weight += part.weight_kg * quantity
        return price.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP), weight

    def search(self, query: str = "", color_id: int | None = None, *, offset: int = 0, limit: int = 50) -> dict:
        query = query.casefold().strip()
        rows = [part for part in self.parts.values()
                if (color_id is None or part.color_id == color_id)
                and (not query or query in f"{part.part_id} {part.name} {part.sku}".casefold())]
        rows.sort(key=lambda part: (part.part_id, part.color_id))
        return {"total": len(rows), "parts": [
            {"part_id": part.part_id + ".dat", "color_id": part.color_id,
             "name": part.name, "sku": part.sku, "unit_price": str(part.unit_price) if part.unit_price is not None else None,
             "max_quantity": part.max_quantity} for part in rows[offset:offset + limit]]}


def flat_model_inventory(content: str) -> dict[tuple[str, int], int]:
    """Read only root physical placements of Nova's already-expanded export.

    Embedded DAT geometry is retained for rendering, never counted as inventory.
    Custom colors/geometry cannot be used to impersonate a purchasable part.
    """
    reject_custom_parts(content)
    inventory = Counter()
    root_started = False
    for line in content.splitlines():
        tokens = line.split()
        if not tokens:
            continue
        if tokens[:2] == ["0", "FILE"]:
            if root_started:
                break
            root_started = True
            continue
        if tokens[:2] == ["0", "!COLOUR"]:
            raise PartsUnavailable("Custom colors are not allowed by the parts catalog")
        if tokens[0] in {"2", "3", "4", "5"}:
            raise PartsUnavailable("Custom geometry is not a purchasable part")
        if tokens[0] != "1":
            continue
        if len(tokens) != 15 or not tokens[14].lower().endswith(".dat"):
            raise ValueError("Expected expanded physical DAT placements")
        try:
            color = int(tokens[1])
            if not all(math.isfinite(float(value)) for value in tokens[2:14]):
                raise ValueError()
        except ValueError:
            raise ValueError("Invalid physical placement") from None
        inventory[(normalize_part_id(tokens[14]), color)] += 1
    return dict(inventory)


def reject_custom_parts(content: str) -> None:
    for line in content.splitlines():
        tokens = line.split()
        if tokens[:2] == ['0', '!COLOUR']:
            raise PartsUnavailable('Custom colors are not allowed by the parts catalog')
        if tokens[:2] == ['0', 'FILE'] and tokens[-1].lower().endswith('.dat'):
            raise PartsUnavailable('Embedded DAT definitions cannot override supplier parts')
        if tokens and tokens[0] in {'2', '3', '4', '5'}:
            raise PartsUnavailable('Custom geometry is not a purchasable part')


def parts_csv_inventory(content: str) -> dict[tuple[str, int], int]:
    """Parse saved BOMs strictly, retaining color and rejecting partial quotes."""
    reader = csv.DictReader(io.StringIO(content))
    if not {'LdrawId', 'LDrawColorId', 'Qty'}.issubset(reader.fieldnames or []):
        raise ValueError('Parts CSV requires LdrawId, LDrawColorId and Qty')
    inventory = Counter()
    for row in reader:
        try:
            part = normalize_part_id(row['LdrawId'])
            color, quantity = int(row['LDrawColorId']), int(row['Qty'])
            if quantity <= 0 or color < 0:
                raise ValueError()
        except (ValueError, TypeError):
            raise ValueError('Invalid part, color or quantity in parts CSV') from None
        inventory[(part, color)] += quantity
    return dict(inventory)
