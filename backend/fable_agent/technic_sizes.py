"""Record the size and holes of each measured Technic part, so later releases of the parts library still match.

The Technic registry (``toolkit/data/technic-parts.json``) gives a part's measured pins, axles and
holes only when its geometry is exactly the one they were measured on. Releases of the LDraw
library redraw parts from time to time; the axle ends of 2026 are half an LDU shorter than those
of 2025. ``toolkit/data/technic-sizes.json`` keeps, for each part, its outline and the holes the
library draws in it, taken from a library whose geometry matches the registry exactly. A part
that is redrawn is still recognised when those agree.

Regenerate with a library whose geometry matches every measured part:
``LDRAW_DIR=<that library> python -m fable_agent.technic_sizes``.
"""

from __future__ import annotations

import json

from .toolkit.common import DATA

SIZES = DATA / "technic-sizes.json"


def build_sizes(parts) -> dict:
    """Sizes of every registry part this library has with exactly the measured geometry."""
    from .toolkit.technic import canonical, part_size, registry
    import hashlib
    import math
    from .toolkit.common import jsonable
    found = {}
    for code, entry in registry()["parts"].items():
        if parts.find_part(code=code) is None:
            continue
        local = parts.geometry(code)
        digest = hashlib.sha256(json.dumps([jsonable(v) for v in local.points], separators=(",", ":")).encode()).hexdigest()
        points = sorted({tuple(math.floor(round(float(value), 10) * 1e6 + 0.500001) for value in jsonable(v))
                         for v in local.points})
        portable = hashlib.sha256(json.dumps(points, separators=(",", ":")).encode()).hexdigest()
        if digest == entry["geometry_sha256"] or portable == entry.get("geometry_points_sha256"):
            found[canonical(code)] = part_size(local)
    return found


def main() -> None:
    from .connectors import ConnectorLibrary
    from .ldraw import LDrawLibrary
    from .shape import default_cache_dir
    from .toolkit.technic import registry
    library = ConnectorLibrary(LDrawLibrary().root, default_cache_dir())
    found = build_sizes(library.parts)
    missing = sorted(set(registry()["parts"]) - set(found))
    if missing:
        raise SystemExit(f"This library does not have the measured geometry of {', '.join(missing)}; use another")
    SIZES.write_text(json.dumps({"about": "Outline and drawn holes of each measured Technic part, in LDU, from the "
                                          "parts library release the registry was measured on.",
                                 "parts": found}, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(found)} parts -> {SIZES}")


if __name__ == "__main__":
    main()
