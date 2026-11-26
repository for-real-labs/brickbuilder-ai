"""Where a part made to nest in another sits: glass in its frame, a door in its frame.

``data/shadow/seats.json`` is worked out from Pip's connector data (``connectors``): for every
pair of parts whose seat connectors fit each other, the place the nested part takes when both
are turned the same way. ``Kit.inset`` reads it, so a pane is put on its real seat and not in
the middle of its frame's outline. The table is plain JSON because build scripts run in a
sandbox that loads nothing else.

Regenerate it after the connector data changes: ``python -m fable_agent.seats``.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

SEATS = Path(__file__).parent / "data" / "shadow" / "seats.json"


@lru_cache(maxsize=1)
def _table() -> dict[str, dict[str, list[float]]]:
    try:
        return json.loads(SEATS.read_text(encoding="utf-8"))["seats"]
    except (OSError, ValueError, KeyError):
        return {}


def seat(host: str, nested: str) -> tuple[float, float, float] | None:
    """The nested part's position in the host's own frame, in LDU, or None when the data has no seat."""
    found = _table().get(host.casefold(), {}).get(nested.casefold())
    return tuple(found) if found else None


def build_seats(library) -> dict[str, dict[str, list[float]]]:
    """Every host and nested part whose seat connectors fit, from a ``ConnectorLibrary``."""
    import numpy as np
    from ldraw.connection_types import ConnectionKind as Kind, ConnectionRole as Role
    from ldraw.connection_types import connections_compatible, snap_transform

    hosts, nested = [], []
    # Every part of the library is read, not only those with a shadow file of their own: a part
    # often gets its connectors through a subpart.
    for path in sorted((library.root / "parts").glob("*.dat")):
        local = library.local(path.stem)
        if local is None:
            continue
        for feature in local[1]:
            if feature.kind is Kind.GENERIC and feature.role in (Role.FEMALE, Role.MALE):
                (hosts if feature.role is Role.FEMALE else nested).append((path.stem.casefold(), feature))
    table: dict[str, dict[str, list[float]]] = {}
    for host, seat_feature in hosts:
        for part, feature in nested:
            if part == host or not connections_compatible(feature, seat_feature):
                continue
            moved = snap_transform(feature, seat_feature)
            if not np.allclose(moved.matrix.rows, np.eye(3), atol=1e-6):
                continue  # the pair mates turned; inset() keeps the host's orientation
            place = [round(float(v), 4) for v in (moved.position.x, moved.position.y, moved.position.z)]
            table.setdefault(host, {}).setdefault(part, place)
    return table


def main() -> None:
    from .connectors import ConnectorLibrary
    from .ldraw import LDrawLibrary
    from .shape import default_cache_dir
    table = build_seats(ConnectorLibrary(LDrawLibrary().root, default_cache_dir()))
    SEATS.write_text(json.dumps({
        "about": "Seat positions of nested parts, derived from the LDCad shadow library in this folder. "
                 "CC BY-SA 4.0; see NOTICE.md.",
        "seats": table}, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{sum(len(v) for v in table.values())} seats in {len(table)} hosts -> {SEATS}")


if __name__ == "__main__":
    main()
