"""Measured part shapes: solid boxes, studs and height maps derived from library geometry.

A part is sampled into half-stud columns. Each column keeps the highest and lowest
body surface, which describes slopes, inverted slopes, arches and panels well enough
for placement and collision checks. Stud-receiving cavities are closed by a basin
fill, so an ordinary brick is solid while an open arch span stays open.
"""

from __future__ import annotations

import hashlib
import heapq
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .ldraw import LDrawError, LDrawLibrary, PartGeometry

CELL = 10.0  # half a stud, in LDU
STUD = 20.0
PLATE = 8.0
SAMPLE_STEP = 2.5
MAX_CELLS = 200 * 200
SHAPE_VERSION = 5
_BUCKETS = (1, 2, 4, 8, 16, 32, 64, 128, 256)


@dataclass(frozen=True)
class PartShape:
    part_id: str
    lo: tuple[float, float, float]  # body bounds, studs excluded
    hi: tuple[float, float, float]
    boxes: tuple[tuple[float, ...], ...]  # (x0, y0, z0, x1, y1, z1) solids
    studs: tuple[tuple[float, ...], ...]  # (x, y, z, dx, dy, dz)
    top: tuple[tuple[float | None, ...], ...]  # [ix][iz] highest surface (smallest Y)
    bottom: tuple[tuple[float | None, ...], ...]  # [ix][iz] lowest open surface
    front_yaw: int  # yaw that turns -Z onto this part's low or open side
    directional: bool = False  # True when the part visibly leans one way (a slope, an overhang)

    @property
    def width(self) -> float:
        return (self.hi[0] - self.lo[0]) / STUD

    @property
    def depth(self) -> float:
        return (self.hi[2] - self.lo[2]) / STUD

    @property
    def height(self) -> float:
        return (self.hi[1] - self.lo[1]) / PLATE

    def up_studs(self) -> list[tuple[float, float, float]]:
        """Top studs as (x, z) studs from the min corner and plates above the base."""
        return sorted(
            (round((s[0] - self.lo[0]) / STUD, 2), round((s[2] - self.lo[2]) / STUD, 2),
             round((self.hi[1] - s[1]) / PLATE, 2))
            for s in self.studs if s[4] < -0.99
        )

    def side_studs(self) -> int:
        return sum(1 for s in self.studs if s[4] >= -0.99)


def _sample(triangles: np.ndarray, lo: np.ndarray, nx: int, nz: int) -> tuple[np.ndarray, np.ndarray]:
    top = np.full(nx * nz, np.inf)
    bottom = np.full(nx * nz, -np.inf)
    a, b, c = triangles[:, 0], triangles[:, 1], triangles[:, 2]
    spans = np.stack([b - a, c - b, a - c])[:, :, [0, 2]]
    longest = np.sqrt((spans**2).sum(axis=2)).max(axis=0)
    needed = np.maximum(1, np.ceil(longest / SAMPLE_STEP)).astype(int)
    bucket = np.searchsorted(_BUCKETS, np.minimum(needed, _BUCKETS[-1]))
    for index, steps in enumerate(_BUCKETS):
        chosen = np.nonzero(bucket == index)[0]
        if not len(chosen):
            continue
        i, j = np.meshgrid(np.arange(steps + 1), np.arange(steps + 1), indexing="ij")
        keep = (i + j) <= steps
        u, v = i[keep] / steps, j[keep] / steps
        chunk = max(1, 400_000 // len(u))
        for start in range(0, len(chosen), chunk):
            rows = chosen[start:start + chunk]
            origin = a[rows][:, None, :]
            points = (origin + u[None, :, None] * (b[rows] - a[rows])[:, None, :]
                      + v[None, :, None] * (c[rows] - a[rows])[:, None, :]).reshape(-1, 3)
            ix = np.clip(np.floor((points[:, 0] - lo[0]) / CELL).astype(int), 0, nx - 1)
            iz = np.clip(np.floor((points[:, 2] - lo[2]) / CELL).astype(int), 0, nz - 1)
            cell = ix * nz + iz
            np.minimum.at(top, cell, points[:, 1])
            np.maximum.at(bottom, cell, points[:, 1])
    return top.reshape(nx, nz), bottom.reshape(nx, nz)


def _fill_basins(bottom: np.ndarray, empty: np.ndarray) -> np.ndarray:
    """Close cavities that are walled in on every side (priority flood)."""
    nx, nz = bottom.shape
    filled = bottom.copy()
    seen = empty.copy()
    heap: list[tuple[float, int, int]] = []
    for i in range(nx):
        for k in range(nz):
            if empty[i, k]:
                continue
            edge = i in (0, nx - 1) or k in (0, nz - 1) or bool(
                empty[i - 1, k] or empty[i + 1, k] or empty[i, k - 1] or empty[i, k + 1])
            if edge:
                seen[i, k] = True
                heapq.heappush(heap, (float(filled[i, k]), i, k))
    while heap:
        level, i, k = heapq.heappop(heap)
        for di, dk in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ni, nk = i + di, k + dk
            if 0 <= ni < nx and 0 <= nk < nz and not seen[ni, nk]:
                seen[ni, nk] = True
                filled[ni, nk] = max(float(filled[ni, nk]), level)
                heapq.heappush(heap, (float(filled[ni, nk]), ni, nk))
    return filled


def _merge_boxes(top: np.ndarray, bottom: np.ndarray, empty: np.ndarray, lo: np.ndarray,
                 hi: np.ndarray) -> list[tuple[float, ...]]:
    nx, nz = top.shape
    keys = {}
    for i in range(nx):
        for k in range(nz):
            if not empty[i, k] and bottom[i, k] - top[i, k] > 0.25:
                keys[(i, k)] = (round(float(top[i, k]), 1), round(float(bottom[i, k]), 1))
    boxes = []
    used = set()
    for i in range(nx):
        for k in range(nz):
            key = keys.get((i, k))
            if key is None or (i, k) in used:
                continue
            width = 1
            while keys.get((i + width, k)) == key and (i + width, k) not in used:
                width += 1
            length = 1
            while all(keys.get((i + w, k + length)) == key and (i + w, k + length) not in used
                      for w in range(width)):
                length += 1
            used.update((i + w, k + d) for w in range(width) for d in range(length))
            # The last column of a part that is not a whole number of cells wide stops at the part's edge.
            boxes.append((float(lo[0] + i * CELL), key[0], float(lo[2] + k * CELL),
                          float(min(hi[0], lo[0] + (i + width) * CELL)), key[1],
                          float(min(hi[2], lo[2] + (k + length) * CELL))))
    return boxes


def _front_yaw(top: np.ndarray, bottom: np.ndarray, empty: np.ndarray) -> int | None:
    """Slopes face downhill; inverted slopes face their overhang. None when the part has no lean."""

    def lean(values: np.ndarray) -> tuple[float, float]:
        masked = np.where(empty, np.nan, values)
        nx, nz = masked.shape
        if np.all(np.isnan(masked)):
            return 0.0, 0.0
        with np.errstate(all="ignore"):
            rows = np.nanmean(masked, axis=0)  # by z
            cols = np.nanmean(masked, axis=1)  # by x
            dz = np.nanmean(rows[: max(1, nz // 2)]) - np.nanmean(rows[nz - max(1, nz // 2):])
            dx = np.nanmean(cols[: max(1, nx // 2)]) - np.nanmean(cols[nx - max(1, nx // 2):])
        return (0.0 if math.isnan(dz) else float(dz)), (0.0 if math.isnan(dx) else float(dx))

    dz, dx = lean(top)
    if max(abs(dz), abs(dx)) < 3:
        # An overhang has the smaller Y; negate so it reads like a downhill side.
        dz, dx = (-value for value in lean(bottom))
    if max(abs(dz), abs(dx)) < 3:
        return None
    if abs(dz) >= abs(dx):
        return 0 if dz > 0 else 180
    return 90 if dx > 0 else 270


def compute_shape(part_id: str, geometry: PartGeometry) -> PartShape:
    points = geometry.triangles.reshape(-1, 3)
    # Curved primitives overshoot their nominal size by a few thousandths; do not let that add a column.
    lo, hi = np.round(points.min(axis=0), 2), np.round(points.max(axis=0), 2)
    nx = max(1, math.ceil((hi[0] - lo[0]) / CELL - 0.02))
    nz = max(1, math.ceil((hi[2] - lo[2]) / CELL - 0.02))
    if nx * nz > MAX_CELLS:
        raise LDrawError(f"Part {part_id} is too large to analyze")
    top, raw_bottom = _sample(geometry.triangles, lo, nx, nz)
    empty = ~np.isfinite(top)
    upward = geometry.studs[geometry.studs[:, 4] < -0.99] if len(geometry.studs) else geometry.studs
    if len(upward):
        # Some parts model a few studs by hand. Geometry within one stud height above
        # the stud plane is a connector, not body, so it must not block the next layer.
        plane = float(upward[:, 1].min())
        if plane - 4.5 <= lo[1] < plane - 0.01:
            top = np.where(empty, top, np.maximum(top, plane))
            lo = lo.copy()
            lo[1] = plane
    filled = _fill_basins(raw_bottom, empty)
    boxes = _merge_boxes(top, filled, empty, lo, hi)
    if not boxes:
        boxes = [(float(lo[0]), float(lo[1]), float(lo[2]), float(hi[0]), float(hi[1]), float(hi[2]))]

    lean = _front_yaw(top, filled, empty)

    def grid(values: np.ndarray) -> tuple[tuple[float | None, ...], ...]:
        return tuple(tuple(None if empty[i, k] else round(float(values[i, k]), 2) for k in range(nz))
                     for i in range(nx))

    return PartShape(
        part_id=part_id,
        lo=tuple(round(float(v), 3) for v in lo),
        hi=tuple(round(float(v), 3) for v in hi),
        boxes=tuple(boxes),
        studs=tuple(tuple(round(float(v), 4) for v in stud) for stud in geometry.studs),
        top=grid(top),
        bottom=grid(filled),
        front_yaw=lean or 0,
        directional=lean is not None,
    )


def default_cache_dir() -> Path:
    configured = os.environ.get("FABLE_AGENT_CACHE")
    return Path(configured).expanduser() if configured else Path.home() / ".cache" / "brickbuilder-fable"


class ShapeLibrary:
    """Shapes on demand, cached in memory and (optionally) on disk."""

    def __init__(self, library: LDrawLibrary, cache_dir: Path | None = None):
        self.library = library
        self._memory: dict[str, PartShape] = {}
        self._cache_dir = None
        if cache_dir is not None:
            tag = hashlib.sha256(str(library.root.resolve()).encode()).hexdigest()[:12]
            self._cache_dir = Path(cache_dir) / f"shapes-v{SHAPE_VERSION}-{tag}"

    def _cache_file(self, part_id: str) -> Path | None:
        if self._cache_dir is None:
            return None
        source = self.library.root / "parts" / f"{part_id}.dat"
        try:
            stat = source.stat()
        except OSError:
            return None
        return self._cache_dir / f"{part_id}-{stat.st_mtime_ns:x}-{stat.st_size:x}.json"

    def get(self, part_id: str) -> PartShape:
        if part_id in self._memory:
            return self._memory[part_id]
        cache = self._cache_file(part_id)
        shape = None
        if cache is not None:
            # A missing or unreadable cache file is a miss: the script account may not see the cache.
            try:
                data = json.loads(cache.read_text(encoding="utf-8"))
                shape = PartShape(
                    part_id=part_id, lo=tuple(data["lo"]), hi=tuple(data["hi"]),
                    boxes=tuple(tuple(box) for box in data["boxes"]),
                    studs=tuple(tuple(stud) for stud in data["studs"]),
                    top=tuple(tuple(row) for row in data["top"]),
                    bottom=tuple(tuple(row) for row in data["bottom"]),
                    front_yaw=int(data["front_yaw"]), directional=bool(data["directional"]),
                )
            except (OSError, ValueError, KeyError, TypeError):
                shape = None
        if shape is None:
            shape = compute_shape(part_id, self.library.geometry(part_id))
            if cache is not None:
                try:
                    cache.parent.mkdir(parents=True, exist_ok=True)
                    temporary = cache.with_suffix(f".{os.getpid()}.tmp")
                    temporary.write_text(json.dumps({
                        "lo": shape.lo, "hi": shape.hi, "boxes": shape.boxes, "studs": shape.studs,
                        "top": shape.top, "bottom": shape.bottom, "front_yaw": shape.front_yaw,
                        "directional": shape.directional,
                    }), encoding="utf-8")
                    temporary.replace(cache)
                except OSError:
                    pass  # The cache is an optimization; an unwritable directory is not an error.
        self._memory[part_id] = shape
        return shape
