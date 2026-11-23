"""Read physical placements from a flat LDraw upload; ignore embedded part definitions."""

import math

from src.utils.parts_catalog import normalize_part_id


def read_source(path, limit, color=None):
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Source exceeds 16 MiB")
    root = False
    rows = []
    index = []
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line.startswith("0 FILE "):
            if root or rows:
                break
            root = True
        if line.startswith("0 NOFILE"):
            break
        if not line.startswith("1 "):
            continue
        v = line.split()
        if len(v) != 15 or not v[-1].lower().endswith(".dat"):
            raise ValueError(
                "Provide a flattened LDraw source with physical .dat placements"
            )
        normalize_part_id(v[-1])
        col = int(v[1])
        coords = [float(n) for n in v[2:14]]
        if not all(math.isfinite(n) and abs(n) <= 100000 for n in coords):
            raise ValueError("Invalid source transform")
        if color is None or col == color:
            index.append([len(rows), col, *coords[:3]])
        rows.append(line)
        if len(rows) > limit:
            raise ValueError("Source already exceeds piece limit")
    if not rows:
        raise ValueError("No source placements")
    return rows, "Source rows (zero-based index, color ID, center x,y,z): " + str(index)
