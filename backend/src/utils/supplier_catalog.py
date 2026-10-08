"""Load the deployed supplier snapshot; no network or guessed prices at runtime."""
import os
from functools import lru_cache
from pathlib import Path

from .parts_catalog import PartsCatalog

DEFAULT_CATALOG = Path(__file__).resolve().parents[1] / "data/brickwith_parts.csv"


@lru_cache(maxsize=4)
def _load(path: str, modified: int) -> PartsCatalog:
    return PartsCatalog.load(Path(path))


def catalog_path() -> Path:
    return Path(os.getenv("NOVA_PARTS_CATALOG", str(DEFAULT_CATALOG)))


def get_supplier_catalog() -> PartsCatalog:
    path = catalog_path()
    return _load(str(path), path.stat().st_mtime_ns)
