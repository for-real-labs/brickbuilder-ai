"""Load the deployed supplier snapshot; no network or guessed prices at runtime."""
import csv
import io
import os
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path

from .parts_catalog import PartsCatalog, normalize_part_id

DEFAULT_CATALOG = Path(__file__).resolve().parents[1] / "data/brickwith_parts.csv"


@lru_cache(maxsize=4)
def _load(path: str, modified: int) -> PartsCatalog:
    return PartsCatalog.load(Path(path))


def catalog_path() -> Path:
    return Path(os.getenv("NOVA_PARTS_CATALOG", str(DEFAULT_CATALOG)))


def get_supplier_catalog() -> PartsCatalog:
    path = catalog_path()
    return _load(str(path), path.stat().st_mtime_ns)


def brickwith_csv(rows: Iterable[tuple[str, int, str, int]]) -> str:
    """Use exact SKU imports at Brickwith and retain LDraw columns for saved inventories."""
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Part", "Color", "ProductId", "ElementId", "Quantity", "LdrawId", "LDrawColorId", "Qty"])
    for part, color, sku, quantity in sorted(rows):
        writer.writerow(["", "", sku, "", quantity, normalize_part_id(part) + ".dat", color, quantity])
    return output.getvalue()
