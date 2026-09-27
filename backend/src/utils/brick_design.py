"""Turn a Claude "brick design" (colored voxel shapes) into a buildable LDraw model.

Claude is good at deciding *what* a model should look like but unreliable at emitting
thousands of exact LDraw coordinates. So instead of raw LDraw, Claude describes the model
as colored voxels on a stud grid (boxes, ellipsoids, cylinders, per-layer maps), and this
module does the parts that must be exact:

1. rasterize the shapes into a colored voxel grid (1 stud x 1 stud x 1 brick/plate layer)
2. hollow the interior (keeps a 2-stud shell) to save pieces
3. pack voxels into real bricks, layer by layer, choosing bricks that bond to the
   already-grounded structure below (overhanging cells get first pick of a brick that
   reaches back to support, farthest overhang first)
4. check connectivity; where a group is floating, back-fill hidden interior voxels around
   it and re-pack until everything connects to the ground layer
5. report problems (floating islands, loose bricks, weak joints) in the design's own
   coordinates so Claude can fix them, and render preview images Claude can look at

Nothing can overlap by construction (each voxel belongs to exactly one brick) and every
brick sits on the stud grid, so the classic "bricks placed incorrectly" failures of
free-form LDraw generation can't happen here.
"""

from __future__ import annotations

import csv
import io
import math
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from scipy import ndimage

from ..data.brick_structure import Brick, reorder_bricks_for_stability
EMPTY = -1
LDU_PER_STUD = 20

# Footprints are (width, length) with width <= length. Default LDraw orientation of these
# parts has the long side along X.
BRICK_PARTS: Dict[Tuple[int, int], str] = {
    (2, 8): "3007", (2, 6): "2456", (2, 4): "3001", (2, 3): "3002", (2, 2): "3003",
    (1, 8): "3008", (1, 6): "3009", (1, 4): "3010", (1, 3): "3622", (1, 2): "3004",
    (1, 1): "3005",
}
PLATE_PARTS: Dict[Tuple[int, int], str] = {
    (2, 8): "3034", (2, 6): "3795", (2, 4): "3020", (2, 3): "3021", (2, 2): "3022",
    (1, 8): "3460", (1, 6): "3666", (1, 4): "3710", (1, 3): "3623", (1, 2): "3023",
    (1, 1): "3024",
}
UNITS = {
    # layer height in LDraw units, height in studs (for proportions), and parts
    "brick": {"ldu": 24, "studs": 1.2, "mm": 9.6, "parts": BRICK_PARTS},
    "plate": {"ldu": 8, "studs": 0.4, "mm": 3.2, "parts": PLATE_PARTS},
}
# Largest area first; among equal areas prefer the more compact footprint.
SIZES = sorted(BRICK_PARTS.keys(), key=lambda s: (-(s[0] * s[1]), -s[0]))

MAX_WIDTH = 64
MAX_DEPTH = 64
MAX_LAYERS = {"brick": 96, "plate": 240}
MAX_SHAPES = 600
MAX_VOXELS = 250_000

_COLORS_CSV = Path(__file__).resolve().parents[2] / "gobrick_colors.csv"
ROT0 = "1 0 0 0 1 0 0 0 1"
ROT90 = "0 0 1 0 1 0 -1 0 0"  # 90 degrees about Y: long side from X to Z


class DesignError(ValueError):
    """The design can't be built as submitted. The message is written for Claude."""


def load_palette() -> Dict[int, Tuple[str, str]]:
    """LDraw color code -> (name, hex RGB) for the colors the app can source."""
    palette: Dict[int, Tuple[str, str]] = {}
    with open(_COLORS_CSV, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            match = re.match(r"(\d+)", row.get("LDraw", ""))
            rgb = (row.get("RGB") or "").strip()
            if match and len(rgb) == 6:
                palette[int(match.group(1))] = (row.get("Name", "").strip(), rgb)
    return palette


def palette_prompt_text(palette: Optional[Dict[int, Tuple[str, str]]] = None) -> str:
    palette = palette or load_palette()
    return ", ".join(f"{code} {name}" for code, (name, _) in sorted(palette.items()))


# --------------------------------------------------------------------------- rasterize


def _as_range(value: Any, name: str, limit: int) -> Tuple[int, int]:
    if isinstance(value, (int, float)):
        value = [value, value]
    if not (isinstance(value, (list, tuple)) and len(value) == 2):
        raise DesignError(f"'{name}' must be [start, end] (inclusive integers)")
    lo, hi = sorted(int(round(float(v))) for v in value)
    lo, hi = max(lo, 0), min(hi, limit - 1)
    return lo, hi


def _floats(value: Any, n: int, name: str) -> List[float]:
    if isinstance(value, (int, float)) and n > 1:
        value = [value] * n
    if not (isinstance(value, (list, tuple)) and len(value) == n):
        raise DesignError(f"'{name}' must be a list of {n} numbers")
    try:
        out = [float(v) for v in value]
    except (TypeError, ValueError) as exc:
        raise DesignError(f"'{name}' must contain numbers") from exc
    if not all(np.isfinite(out)):
        raise DesignError(f"'{name}' must contain finite numbers")
    return out


def rasterize(design: Dict[str, Any], palette: Optional[Dict[int, Tuple[str, str]]] = None) -> Tuple[np.ndarray, str]:
    """Apply the design's shapes in order. Returns (grid[x, z, layer] of color or -1, unit)."""
    palette = palette or load_palette()
    unit = str(design.get("layer_unit", "brick")).lower()
    if unit not in UNITS:
        raise DesignError("layer_unit must be 'brick' or 'plate'")
    grid_spec = design.get("grid") or {}
    try:
        width, depth, layers = (int(grid_spec[k]) for k in ("width", "depth", "layers"))
    except (KeyError, TypeError, ValueError) as exc:
        raise DesignError("grid must have integer width, depth and layers") from exc
    if not (1 <= width <= MAX_WIDTH and 1 <= depth <= MAX_DEPTH and 1 <= layers <= MAX_LAYERS[unit]):
        raise DesignError(
            f"grid too large: max {MAX_WIDTH} x {MAX_DEPTH} studs and {MAX_LAYERS[unit]} {unit} layers"
        )
    shapes = design.get("shapes")
    if not isinstance(shapes, list) or not shapes:
        raise DesignError("shapes must be a non-empty list")
    if len(shapes) > MAX_SHAPES:
        raise DesignError(f"too many shapes ({len(shapes)}); max {MAX_SHAPES}")

    grid = np.full((width, depth, layers), EMPTY, dtype=np.int32)
    X, Z, Y = np.meshgrid(np.arange(width), np.arange(depth), np.arange(layers), indexing="ij")

    for index, shape in enumerate(shapes):
        where = f"shapes[{index}]"
        if not isinstance(shape, dict):
            raise DesignError(f"{where} must be an object")
        kind = shape.get("shape")
        mode = shape.get("mode", "fill")
        if mode not in ("fill", "paint", "carve"):
            raise DesignError(f"{where}: mode must be fill, paint or carve")
        color = shape.get("color")
        if mode != "carve" and kind != "layer":
            if not isinstance(color, int) or color not in palette:
                raise DesignError(
                    f"{where}: color {color!r} is not in the palette. Use one of: {palette_prompt_text(palette)}"
                )

        if kind == "box":
            x0, x1 = _as_range(shape.get("x"), f"{where}.x", width)
            y0, y1 = _as_range(shape.get("y"), f"{where}.y", layers)
            z0, z1 = _as_range(shape.get("z"), f"{where}.z", depth)
            mask = np.zeros_like(grid, dtype=bool)
            if x0 <= x1 and y0 <= y1 and z0 <= z1:
                mask[x0:x1 + 1, z0:z1 + 1, y0:y1 + 1] = True
        elif kind == "ellipsoid":
            cx, cy, cz = _floats(shape.get("center"), 3, f"{where}.center")
            rx, ry, rz = _floats(shape.get("radius"), 3, f"{where}.radius")
            if min(rx, ry, rz) <= 0:
                raise DesignError(f"{where}: radius values must be positive")
            mask = ((X - cx) / rx) ** 2 + ((Y - cy) / ry) ** 2 + ((Z - cz) / rz) ** 2 <= 1.0
        elif kind == "cylinder":
            axis = shape.get("axis", "y")
            if axis not in ("x", "y", "z"):
                raise DesignError(f"{where}: axis must be x, y or z")
            others = {"x": ("y", "z"), "y": ("x", "z"), "z": ("x", "y")}[axis]
            ca, cb = _floats(shape.get("center"), 2, f"{where}.center")
            ra, rb = _floats(shape.get("radius"), 2, f"{where}.radius")
            if min(ra, rb) <= 0:
                raise DesignError(f"{where}: radius values must be positive")
            coords = {"x": X, "y": Y, "z": Z}
            limit = {"x": width, "y": layers, "z": depth}[axis]
            lo, hi = _as_range(shape.get("range"), f"{where}.range", limit)
            along = coords[axis]
            mask = (((coords[others[0]] - ca) / ra) ** 2 + ((coords[others[1]] - cb) / rb) ** 2 <= 1.0) & (
                along >= lo) & (along <= hi)
        elif kind == "layer":
            y0, y1 = _as_range(shape.get("y"), f"{where}.y", layers)
            rows = shape.get("rows")
            legend = shape.get("legend") or {}
            if not isinstance(rows, list) or not all(isinstance(r, str) for r in rows):
                raise DesignError(f"{where}: rows must be a list of strings (one per z row, front first)")
            if not isinstance(legend, dict):
                raise DesignError(f"{where}: legend must map single characters to color codes")
            colors: Dict[str, int] = {}
            for char, code in legend.items():
                if len(char) != 1 or (mode != "carve" and (not isinstance(code, int) or code not in palette)):
                    raise DesignError(f"{where}: legend entry {char!r}: {code!r} must map one character to a palette color")
                colors[char] = code if isinstance(code, int) else EMPTY
            for z, row in enumerate(rows[:depth]):
                for x, char in enumerate(row[:width]):
                    if char in (".", " "):
                        continue
                    if char not in colors:
                        raise DesignError(f"{where}: character {char!r} in row {z} is not in the legend")
                    cells = (x, z, slice(y0, y1 + 1))
                    if mode == "carve":
                        grid[cells] = EMPTY
                    elif mode == "paint":
                        grid[cells] = np.where(grid[cells] != EMPTY, colors[char], EMPTY)
                    else:
                        grid[cells] = colors[char]
            continue
        else:
            raise DesignError(f"{where}: unknown shape {kind!r} (use box, ellipsoid, cylinder or layer)")

        if mode == "carve":
            grid[mask] = EMPTY
        elif mode == "paint":
            grid[mask & (grid != EMPTY)] = color
        else:
            grid[mask] = color

    filled = int((grid != EMPTY).sum())
    if filled == 0:
        raise DesignError("the design is empty after applying all shapes")
    if filled > MAX_VOXELS:
        raise DesignError(f"design has {filled} voxels; keep it under {MAX_VOXELS}")
    return grid, unit


# --------------------------------------------------------------------------- packing


@dataclass
class PackResult:
    bricks: List[Tuple[int, int, int, int, int, int]]  # (color, x0, z0, layer, fx, fz)
    owner: np.ndarray
    loose: List[int]
    grounded_groups: int
    roots: List[int] = field(default_factory=list)


def _pack(grid: np.ndarray, has_base: bool = False) -> PackResult:
    """Pack voxels into bricks. With has_base, layer 0 is a plate base that is packed last so
    its plates can be chosen to bridge under as many bricks above as possible."""
    if not has_base:
        bricks, owner = _pack_layers(grid)
        return _connectivity(bricks, owner)
    bricks, owner = _pack_layers(grid[:, :, 1:])
    roots = _component_roots(len(bricks), owner)
    above = owner[:, :, 0] if owner.shape[2] else None
    priority: Dict[Tuple[int, int], int] = {}
    best = None
    for _ in range(8):
        base_bricks, base_owner = _pack_base(grid[:, :, 0], above, roots, priority)
        shift = len(base_bricks)
        shifted = np.where(owner >= 0, owner + shift, -1)
        combined = base_bricks + [(c, x, z, layer + 1, fx, fz) for c, x, z, layer, fx, fz in bricks]
        result = _connectivity(combined, np.concatenate([base_owner[:, :, None], shifted], axis=2))
        if best is None or result.grounded_groups < best.grounded_groups:
            best = result
        if result.grounded_groups <= 1:
            break
        # Base cells next to a base cell of another group are where a bridging plate is needed.
        group = np.full(base_owner.shape, -1)
        for i, (_, x0, z0, _, fx, fz) in enumerate(base_bricks):
            group[x0:x0 + fx, z0:z0 + fz] = result.roots[i]
        sizes = Counter(result.roots)
        new: Dict[Tuple[int, int], int] = {}
        for dx, dz in ((1, 0), (0, 1)):
            a, b = group[:group.shape[0] - dx, :group.shape[1] - dz], group[dx:, dz:]
            seam = (a >= 0) & (b >= 0) & (a != b)
            for i, k in zip(*np.nonzero(seam)):
                # smallest group first, so a lone column gets its bridging plate before the
                # neighboring cells are used up
                rank = min(sizes[a[i, k]], sizes[b[i, k]])
                for cell in ((int(i), int(k)), (int(i + dx), int(k + dz))):
                    new[cell] = min(rank, new.get(cell, rank))
        if not set(new) - set(priority):
            break
        for cell, rank in new.items():
            priority[cell] = min(rank, priority.get(cell, rank))
    return best


def _component_roots(count: int, owner: np.ndarray) -> List[int]:
    parent = list(range(count))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for layer in range(owner.shape[2] - 1):
        a, b = owner[:, :, layer], owner[:, :, layer + 1]
        both = (a >= 0) & (b >= 0)
        for p, q in set(zip(a[both].tolist(), b[both].tolist())):
            parent[find(p)] = find(q)
    return [find(i) for i in range(count)]


def _pack_base(colors: np.ndarray, above: Optional[np.ndarray], roots: List[int],
               priority: Optional[Dict[Tuple[int, int], int]] = None):
    """Pack a single base layer, preferring plates that tie together separate structures above
    (e.g. a tower and a wall of different colors), then plates under many bricks."""
    width, depth = colors.shape
    priority = priority or {}
    owner = np.full((width, depth), -1, dtype=np.int32)
    bricks = []
    covered = above >= 0 if above is not None else np.zeros_like(owner, dtype=bool)
    dist = ndimage.distance_transform_cdt(~covered, metric="taxicab") if covered.any() else np.zeros(owner.shape, int)
    cells = sorted(zip(*np.nonzero(colors != EMPTY)), key=lambda ik: (ik not in priority, priority.get(ik, 0), -dist[ik]))
    for i, k in cells:
        if owner[i, k] != -1:
            continue
        color = colors[i, k]
        best, best_score = None, None
        for w, l in SIZES:
            for fx, fz in ((w, l),) if w == l else ((l, w), (w, l)):
                for x0 in range(max(0, i - fx + 1), min(i, width - fx) + 1):
                    for z0 in range(max(0, k - fz + 1), min(k, depth - fz) + 1):
                        if not (colors[x0:x0 + fx, z0:z0 + fz] == color).all() or (
                                owner[x0:x0 + fx, z0:z0 + fz] != -1).any():
                            continue
                        over = set(above[x0:x0 + fx, z0:z0 + fz].ravel().tolist()) - {-1} if above is not None else set()
                        groups = {roots[b] for b in over}
                        score = (bool(over), len(groups), len(over), fx * fz)
                        if best_score is None or score > best_score:
                            best, best_score = (x0, z0, fx, fz), score
        x0, z0, fx, fz = best
        owner[x0:x0 + fx, z0:z0 + fz] = len(bricks)
        bricks.append((int(color), int(x0), int(z0), 0, fx, fz))
    return bricks, owner


def _connectivity(bricks, owner: np.ndarray) -> PackResult:
    """Group bricks joined by vertical overlap; anything not joined to layer 0 is loose."""
    parent = list(range(len(bricks)))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for layer in range(owner.shape[2] - 1):
        a, b = owner[:, :, layer], owner[:, :, layer + 1]
        both = (a >= 0) & (b >= 0)
        for p, q in set(zip(a[both].tolist(), b[both].tolist())):
            parent[find(p)] = find(q)
    ground_roots = {find(i) for i, brick in enumerate(bricks) if brick[3] == 0}
    loose = [i for i in range(len(bricks)) if find(i) not in ground_roots]
    return PackResult(bricks, owner, loose, len(ground_roots), [find(i) for i in range(len(bricks))])


def _pack_layers(grid: np.ndarray):
    """Bottom-up greedy packer that prefers bricks bonding to the grounded structure."""
    width, depth, layers = grid.shape
    owner = np.full(grid.shape, -1, dtype=np.int32)
    bricks: List[Tuple[int, int, int, int, int, int]] = []
    parent: List[int] = []
    grounded_roots: set = set()

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for layer in range(layers):
        along_x = layer % 2 == 0  # alternate the bond direction per layer
        colors = grid[:, :, layer]
        free = owner[:, :, layer]
        below_owner = owner[:, :, layer - 1] if layer else None
        present = colors != EMPTY
        cells = list(zip(*np.nonzero(present)))
        if layer:
            dist = ndimage.distance_transform_cdt(below_owner == -1, metric="taxicab")
        else:
            dist = np.zeros(colors.shape, dtype=int)
        # Most-constrained cells first: those with few same-colored neighbors (tips, one-stud
        # columns) get a brick before their neighbors are used up.
        same = np.zeros(colors.shape, dtype=int)
        for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            shifted = np.full(colors.shape, EMPTY - 1)
            xs = slice(max(dx, 0), colors.shape[0] + min(dx, 0))
            zs = slice(max(dz, 0), colors.shape[1] + min(dz, 0))
            xd = slice(max(-dx, 0), colors.shape[0] + min(-dx, 0))
            zd = slice(max(-dz, 0), colors.shape[1] + min(-dz, 0))
            shifted[xd, zd] = colors[xs, zs]
            same += (shifted == colors) & present
        # Vary the scan direction per layer so seams don't line up from layer to layer.
        sx, sz = ((1, 1), (-1, -1), (1, -1), (-1, 1))[layer % 4]
        cells.sort(key=lambda ik: (-dist[ik], same[ik] >= 3, sx * ik[0], sz * ik[1]))
        for i, k in cells:
            if free[i, k] != -1:
                continue
            color = colors[i, k]
            best = None
            best_score = None
            for w, l in SIZES:
                if w == l:
                    orientations = ((w, l),)
                else:
                    orientations = ((l, w), (w, l)) if along_x else ((w, l), (l, w))
                for fx, fz in orientations:
                    for x0 in range(max(0, i - fx + 1), min(i, width - fx) + 1):
                        for z0 in range(max(0, k - fz + 1), min(k, depth - fz) + 1):
                            block = colors[x0:x0 + fx, z0:z0 + fz]
                            if not (block == color).all() or (free[x0:x0 + fx, z0:z0 + fz] != -1).any():
                                continue
                            if layer:
                                below = set(below_owner[x0:x0 + fx, z0:z0 + fz].ravel().tolist())
                                below.discard(-1)
                            else:
                                below = set()
                            roots = {find(b) for b in below}
                            grounded = layer == 0 or bool(roots & grounded_roots)
                            score = (grounded, bool(below), len(roots), len(below), fx * fz,
                                     (fx >= fz) == along_x)
                            if best_score is None or score > best_score:
                                best, best_score = (x0, z0, fx, fz), score
            x0, z0, fx, fz = best
            idx = len(bricks)
            free[x0:x0 + fx, z0:z0 + fz] = idx
            bricks.append((int(color), int(x0), int(z0), layer, fx, fz))
            parent.append(idx)
            grounded = layer == 0
            if layer:
                for b in set(below_owner[x0:x0 + fx, z0:z0 + fz].ravel().tolist()) - {-1}:
                    grounded = grounded or find(b) in grounded_roots
                    parent[find(b)] = find(idx)
            if grounded:
                grounded_roots.add(find(idx))
    return bricks, owner


def _voxel_islands(solid: np.ndarray) -> List[Tuple[int, Tuple[slice, ...]]]:
    """Face-connected voxel groups that never reach layer 0 (can't be fixed by packing)."""
    labels, count = ndimage.label(solid)
    grounded = set(np.unique(labels[:, :, 0]).tolist()) - {0}
    boxes = ndimage.find_objects(labels)
    islands = []
    for label in range(1, count + 1):
        if label not in grounded:
            islands.append((int((labels == label).sum()), boxes[label - 1]))
    return islands


def _describe_box(box: Tuple[slice, ...], layer_offset: int = 0) -> str:
    xs, zs, ys = box
    return (f"x {xs.start}-{xs.stop - 1}, z {zs.start}-{zs.stop - 1}, "
            f"layers {ys.start - layer_offset}-{ys.stop - 1 - layer_offset}")


def _joint_degrees(owner: np.ndarray) -> Counter:
    degree: Counter = Counter()
    for layer in range(owner.shape[2] - 1):
        a, b = owner[:, :, layer], owner[:, :, layer + 1]
        both = (a >= 0) & (b >= 0)
        for p, q in set(zip(a[both].tolist(), b[both].tolist())):
            degree[p] += 1
            degree[q] += 1
    return degree


# --------------------------------------------------------------------------- build


@dataclass
class BuildResult:
    ldr: str
    unit: str
    grid: np.ndarray  # voxels actually built (after hollowing / back-fill / repair), design layers only
    bricks: List[Tuple[int, int, int, int, int, int]]
    has_base: bool = False
    weak_bricks: int = 0
    grounded_groups: int = 1
    warnings: List[str] = field(default_factory=list)
    solid_grid: Optional[np.ndarray] = None  # grid before hollowing, design layers only

    @property
    def piece_count(self) -> int:
        return len(self.bricks)

    def xyzrgb(self, palette: Optional[Dict[int, Tuple[str, str]]] = None) -> str:
        """The model's solid voxels (without the plate base) as xyzrgb; see grid_to_xyzrgb."""
        grid = self.solid_grid if self.solid_grid is not None else self.grid
        return grid_to_xyzrgb(grid, self.unit, palette or load_palette())

    def summary(self, palette: Optional[Dict[int, Tuple[str, str]]] = None) -> str:
        palette = palette or load_palette()
        spec = UNITS[self.unit]
        w, d, n = self.grid.shape
        base = " plus a 1-plate base" if self.has_base else ""
        lines = [
            f"Built {self.piece_count} pieces on a {w} x {d} stud footprint, {n} {self.unit} layers{base} "
            f"(about {w * 0.8:.0f} x {d * 0.8:.0f} x {n * spec['mm'] / 10:.0f} cm).",
            f"Bricks bonded to only one other brick (weak joints): {self.weak_bricks}.",
        ]
        if self.grounded_groups > 1:
            lines.append(
                f"Warning: the model is {self.grounded_groups} separate pieces that only sit on the table. "
                "Connect them, or set base_color to build everything on one plate base."
            )
        lines += self.warnings
        by_color = Counter(b[0] for b in self.bricks)
        lines.append("Pieces by color: " + ", ".join(
            f"{palette.get(c, (str(c), ''))[0]} {n}" for c, n in by_color.most_common()))
        return "\n".join(lines)


PLATES_PER_BRICK = 3


def grid_to_xyzrgb(grid: np.ndarray, unit: str, palette: Dict[int, Tuple[str, str]]) -> str:
    """Export a design grid in the voxel pipeline's xyzrgb format ("x y z r g b" per line).

    The pipeline's voxels are one stud square and one brick tall with z up, and its y axis is the
    design's z (front = 0), so this file feeds the block editor, /updateModel and /resizeModel like
    any other generation. Plate layers are merged three at a time into brick layers: a cell is
    filled if any of its plates is, taking the most common plate color."""
    if unit == "plate":
        layers = grid.shape[2]
        merged = np.full(grid.shape[:2] + (-(-layers // PLATES_PER_BRICK),), EMPTY, dtype=grid.dtype)
        for out_layer in range(merged.shape[2]):
            chunk = grid[:, :, out_layer * PLATES_PER_BRICK:(out_layer + 1) * PLATES_PER_BRICK]
            for x, z in zip(*np.nonzero((chunk != EMPTY).any(axis=2))):
                colors = chunk[x, z][chunk[x, z] != EMPTY]
                merged[x, z, out_layer] = Counter(colors.tolist()).most_common(1)[0][0]
        grid = merged
    lines = []
    for x, z, layer in zip(*np.nonzero(grid != EMPTY)):
        rgb = palette.get(int(grid[x, z, layer]), ("", "808080"))[1]
        r, g, b = (int(rgb[i:i + 2], 16) for i in (0, 2, 4))
        lines.append(f"{x} {z} {layer} {r} {g} {b}")
    return "\n".join(lines) + ("\n" if lines else "")


def _hollow(grid: np.ndarray) -> np.ndarray:
    """Remove voxels more than 2 studs inside the surface. The ground below the model counts as
    solid, so the bottom layer is hollowed too (open-bottomed like a real brick sculpture)."""
    solid = grid != EMPTY
    padded = np.concatenate([np.ones(solid.shape[:2] + (1,), dtype=bool), solid], axis=2)
    inner = ndimage.binary_erosion(padded, structure=np.ones((5, 5, 3), dtype=bool))[:, :, 1:]
    out = grid.copy()
    out[inner] = EMPTY
    return out


def _repair_loose(work: np.ndarray, result: PackResult, warnings: List[str], offset: int) -> np.ndarray:
    """Last resort: recolor loose cells to match a grounded neighbor on the same layer (so a brick
    can bridge to it); anything still loose after that is removed."""
    loose = set(result.loose)
    changed = 0
    for n in loose:
        color, x0, z0, layer, fx, fz = result.bricks[n]
        neighbors: Counter = Counter()
        for x in range(max(0, x0 - 1), min(work.shape[0], x0 + fx + 1)):
            for z in range(max(0, z0 - 1), min(work.shape[1], z0 + fz + 1)):
                o = result.owner[x, z, layer]
                if o >= 0 and o not in loose:
                    neighbors[int(work[x, z, layer])] += 1
        if neighbors:
            new_color = neighbors.most_common(1)[0][0]
            if new_color != color:
                work[x0:x0 + fx, z0:z0 + fz, layer] = new_color
                changed += fx * fz
    if changed:
        warnings.append(f"Recolored {changed} stud(s) of unsupported overhang so they could bond to the model.")
    return work


def build_design(design: Dict[str, Any], *, max_pieces: int = 5_000, repair: bool = False,
                 palette: Optional[Dict[int, Tuple[str, str]]] = None) -> BuildResult:
    """Rasterize, hollow, pack and verify. Raises DesignError with Claude-readable fixes.

    repair=True never raises for connectivity: it recolors or drops unsupported bricks instead
    (used for the final attempt so the user always gets a buildable model)."""
    palette = palette or load_palette()
    grid, unit = rasterize(design, palette)

    islands = _voxel_islands(grid != EMPTY)
    if islands and not repair:
        details = "; ".join(f"{size} voxels at {_describe_box(box)}" for size, box in islands[:8])
        raise DesignError(
            f"{len(islands)} part(s) of the design float with nothing connecting them to the ground "
            f"layer (layer 0): {details}. Every voxel must connect to layer 0 through touching voxels; "
            "add supports or move these parts so they touch the rest of the model."
        )
    warnings: List[str] = []
    if islands:
        labels, _ = ndimage.label(grid != EMPTY)
        keep = set(np.unique(labels[:, :, 0]).tolist()) - {0}
        dropped = int(((labels > 0) & ~np.isin(labels, list(keep))).sum())
        grid[(labels > 0) & ~np.isin(labels, list(keep))] = EMPTY
        warnings.append(f"Removed {dropped} floating voxel(s) that had no connection to the ground.")

    base_color = design.get("base_color")
    if base_color is not None and (not isinstance(base_color, int) or base_color not in palette):
        raise DesignError(f"base_color {base_color!r} is not in the palette")
    offset = 1 if base_color is not None else 0

    solid = grid != EMPTY
    work = _hollow(grid) if design.get("hollow", True) else grid.copy()
    if offset:
        margin = int(design.get("base_margin", 0) or 0)
        footprint = solid[:, :, 0]
        if margin > 0:
            footprint = ndimage.binary_dilation(footprint, iterations=min(margin, 4))
        base = np.where(footprint, base_color, EMPTY)[:, :, None]
        work = np.concatenate([base, work], axis=2)
        solid = np.concatenate([footprint[:, :, None], solid], axis=2)
        grid = np.concatenate([base, grid], axis=2)

    result = _pack(work, bool(offset))
    for attempt in range(30):  # back-fill hidden interior around floating groups, then re-pack
        if not result.loose:
            break
        added = 0
        for n in result.loose:
            _, x0, z0, layer, fx, fz = result.bricks[n]
            regions = [(slice(x0, x0 + fx), slice(z0, z0 + fz), ll)
                       for ll in (layer - 1, layer + 1) if 0 <= ll < work.shape[2]]
            regions.append((slice(max(0, x0 - 1), x0 + fx + 1), slice(max(0, z0 - 1), z0 + fz + 1), layer))
            for region in regions:
                fill = solid[region] & (work[region] == EMPTY)
                if fill.any():
                    work[region] = np.where(fill, grid[region], work[region])
                    added += int(fill.sum())
        if not added:
            if not repair:
                break
            before = work.copy()
            work = _repair_loose(work, result, warnings, offset)
            if np.array_equal(before, work):
                break
        result = _pack(work, bool(offset))

    removed = np.zeros(work.shape, dtype=bool)
    if result.loose:
        mask = np.isin(result.owner, result.loose)
        labels, _ = ndimage.label(mask)
        areas = [_describe_box(box, offset) for box in ndimage.find_objects(labels)[:8]]
        if not repair:
            raise DesignError(
                f"{len(result.loose)} bricks can't be connected to the rest of the model. Problem areas: "
                + "; ".join(areas)
                + ". Bricks only hold by overlapping bricks directly above or below, and a brick can only "
                "span cells of one color. Usual causes: a one-stud-wide feature of a different color stacked "
                "straight up beside the model (e.g. an ear, a trim line or a hair edge), or an overhang with "
                "nothing under it. Make such features match the color of the cells they sit against, make them "
                "at least 2 studs deep, or support them from below."
            )
        work[mask] = EMPTY
        removed |= mask
        warnings.append(f"Removed {len(result.loose)} brick(s) that could not be connected ({'; '.join(areas)}).")
        result = _pack(work, bool(offset))

    if len(result.bricks) > max_pieces:
        raise DesignError(
            f"the design needs {len(result.bricks)} pieces; keep it under {max_pieces}. "
            "Use a smaller grid, 'brick' instead of 'plate' layers, or hollow: true."
        )

    degree = _joint_degrees(result.owner)
    weak = sum(1 for i in range(len(result.bricks)) if degree[i] == 1)
    layer_units = (["plate"] if offset else []) + [unit] * (work.shape[2] - offset)
    ldr = to_ldraw(result.bricks, work.shape, layer_units,
                   title=str(design.get("title") or "Brick model"))
    # The un-hollowed model with the builder's recolors and removals applied: a solid source for
    # the voxel pipeline (block editor / resize), which hollows models itself.
    solid_grid = np.where(work != EMPTY, work, grid)
    solid_grid[removed] = EMPTY
    return BuildResult(ldr=ldr, unit=unit, grid=work[:, :, offset:], bricks=result.bricks,
                       has_base=bool(offset), weak_bricks=weak,
                       grounded_groups=result.grounded_groups, warnings=warnings,
                       solid_grid=solid_grid[:, :, offset:])


def to_ldraw(bricks, shape, layer_units, title: str = "Brick model") -> str:
    """Write bricks as LDraw. The front of the model (z = 0) faces -Z.

    Bricks are ordered with the voxel2brick stability reordering so every step only adds parts
    resting on or hanging from parts placed in earlier steps (e.g. an overhang that hangs from
    the layer above is placed after that layer). Consecutive bricks on the same layer share a
    step, so a model without hanging parts gets one step per layer.

    layer_units is "brick"/"plate" for every layer, or a list with one entry per layer."""
    width, depth, layers = shape
    if isinstance(layer_units, str):
        layer_units = [layer_units] * layers
    bottoms = np.concatenate([[0], np.cumsum([UNITS[u]["ldu"] for u in layer_units])])
    safe_title = re.sub(r"[\r\n]+", " ", title).strip()[:120] or "Brick model"
    lines = [f"0 {safe_title}", "0 Name: llm-model.ldr", "0 Author: BrickBuilder AI"]
    by_brick = {Brick(h=fx, w=fz, x=x0, y=z0, z=layer, color=color): (color, x0, z0, layer, fx, fz)
                for color, x0, z0, layer, fx, fz in bricks}
    ordered, _ = reorder_bricks_for_stability(list(by_brick), (width, depth, layers))
    step_layer = None
    for brick in ordered:
        color, x0, z0, layer, fx, fz = by_brick[brick]
        if step_layer is not None and layer != step_layer:
            lines.append("0 STEP")
        step_layer = layer
        part = UNITS[layer_units[layer]]["parts"][tuple(sorted((fx, fz)))]
        x = (x0 + fx / 2 - width / 2) * LDU_PER_STUD
        z = (z0 + fz / 2 - depth / 2) * LDU_PER_STUD
        y = -int(bottoms[layer + 1])  # LDraw -Y is up; part origin is its top face
        rot = ROT90 if fz > fx else ROT0
        lines.append(f"1 {color} {x:g} {y:g} {z:g} {rot} {part}.dat")
    if step_layer is not None:
        lines.append("0 STEP")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- preview


def render_preview_png(grid: np.ndarray, unit: str, palette: Optional[Dict[int, Tuple[str, str]]] = None,
                       max_size: int = 1100) -> bytes:
    """Two isometric views (front-left and back-right) of the built voxels, as PNG bytes."""
    from PIL import Image, ImageDraw

    palette = palette or load_palette()
    h = UNITS[unit]["studs"]
    width, depth, layers = grid.shape
    span = width + depth + layers * h
    scale = max(3.0, min(14.0, (max_size / 2 - 40) / (span * 0.95)))

    def view(g: np.ndarray) -> "Image.Image":
        w, d, n = g.shape
        cos30, sin30 = 0.866, 0.5
        img_w = int((w + d) * cos30 * scale) + 40
        img_h = int(((w + d) * sin30 + n * h) * scale) + 40
        image = Image.new("RGB", (img_w, img_h), (246, 246, 244))
        draw = ImageDraw.Draw(image)
        ox, oy = 20 + d * cos30 * scale, 20 + n * h * scale

        def project(x, y, z):
            # viewer is front-left and above; farther along +x/+z moves up the screen
            return (ox + (x - z) * cos30 * scale,
                    oy - y * scale + ((w + d) - (x + z)) * sin30 * scale)

        filled = g != EMPTY
        xs, zs, ls = np.nonzero(filled)
        order = np.argsort(-(xs + zs - ls * h), kind="stable")
        for idx in order:
            x, z, l = int(xs[idx]), int(zs[idx]), int(ls[idx])
            rgb_hex = palette.get(int(g[x, z, l]), ("", "888888"))[1]
            base = tuple(int(rgb_hex[i:i + 2], 16) for i in (0, 2, 4))
            y0, y1 = l * h, (l + 1) * h
            faces = []
            if l + 1 >= n or not filled[x, z, l + 1]:
                faces.append(([(x, y1, z), (x + 1, y1, z), (x + 1, y1, z + 1), (x, y1, z + 1)], 1.0))
            if z == 0 or not filled[x, z - 1, l]:
                faces.append(([(x, y0, z), (x + 1, y0, z), (x + 1, y1, z), (x, y1, z)], 0.82))
            if x == 0 or not filled[x - 1, z, l]:
                faces.append(([(x, y0, z), (x, y0, z + 1), (x, y1, z + 1), (x, y1, z)], 0.66))
            for corners, shade in faces:
                fill = tuple(int(c * shade) for c in base)
                outline = tuple(int(c * shade * 0.8) for c in base)
                draw.polygon([project(*c) for c in corners], fill=fill, outline=outline)
        return image

    front = view(grid)
    back = view(grid[::-1, ::-1, :])
    canvas = Image.new("RGB", (front.width + back.width, max(front.height, back.height)), (246, 246, 244))
    canvas.paste(front, (0, 0))
    canvas.paste(back, (front.width, 0))
    draw = ImageDraw.Draw(canvas)
    draw.text((10, 6), "front-left", fill=(90, 90, 90))
    draw.text((front.width + 10, 6), "back-right", fill=(90, 90, 90))
    buffer = io.BytesIO()
    canvas.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


# Camera and framing of captureCleanPreview in frontend/src/components/ThreeLDRViewer.tsx.
PREVIEW_SIZE = 1024
_PREVIEW_FOV_DEGREES = 45.0
_PREVIEW_DISTANCE = 1.8  # times the model's largest dimension
_PREVIEW_DIRECTION = (-1.0, 0.5, 1.0)
_PREVIEW_TURN_DEGREES = 15.0
_PREVIEW_SUPERSAMPLE = 2
_PLATE_LDU = 8
_STUD_RADIUS = 6
_STUD_HEIGHT = 4
_STUD_SEGMENTS = 16
_KEY_LIGHT = tuple(np.array((200.0, 400.0, 200.0)) / np.linalg.norm((200.0, 400.0, 200.0)))
_FILL_LIGHT = tuple(np.array((-150.0, 200.0, -100.0)) / np.linalg.norm((-150.0, 200.0, -100.0)))
_EDGE_SHADE = 0.7
# Cell axes are (stud x, stud z, plate level); each face lists its two in-plane axes.
_CELL_FACES = tuple((axis, sign, tuple(a for a in range(3) if a != axis)) for axis in range(3) for sign in (1, -1))


def _cell_to_world(i: float, k: float, h: float) -> Tuple[float, float, float]:
    """Viewer world space: the viewer flips LDraw models about X, so +Y is up and LDraw +Z is -Z."""
    return i * LDU_PER_STUD, h * _PLATE_LDU, -k * LDU_PER_STUD


def _cell_normal(axis: int, sign: int) -> Tuple[float, float, float]:
    return ((float(sign), 0.0, 0.0), (0.0, 0.0, float(-sign)), (0.0, float(sign), 0.0))[axis]


def _dot(a, b) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def render_ldraw_preview_png(ldr: str, palette: Optional[Dict[int, Tuple[str, str]]] = None,
                             size: int = PREVIEW_SIZE) -> bytes:
    """The model page's saved preview of an LDraw model: square, white, from the same camera."""
    from PIL import Image, ImageDraw

    palette = palette or load_palette()
    parts, owner = _ldraw_part_cells(ldr)
    if not parts:
        raise ValueError("the model has no basic bricks or plates to draw")

    cells = np.array(list(owner))
    lo, hi = cells.min(axis=0), cells.max(axis=0) + 1
    mins = np.array((lo[0] * LDU_PER_STUD, lo[2] * _PLATE_LDU, -hi[1] * LDU_PER_STUD), dtype=float)
    # the highest part always has uncovered studs
    maxs = np.array((hi[0] * LDU_PER_STUD, hi[2] * _PLATE_LDU + _STUD_HEIGHT, -lo[1] * LDU_PER_STUD), dtype=float)
    center = (mins + maxs) / 2
    turn = math.radians(_PREVIEW_TURN_DEGREES)
    dx, dy, dz = np.array(_PREVIEW_DIRECTION) / np.linalg.norm(_PREVIEW_DIRECTION)
    offset = np.array((dx * math.cos(turn) + dz * math.sin(turn), dy, -dx * math.sin(turn) + dz * math.cos(turn)))
    camera_array = center + offset * _PREVIEW_DISTANCE * float((maxs - mins).max())
    forward_array = (center - camera_array) / np.linalg.norm(center - camera_array)
    right_array = np.cross(forward_array, (0.0, 1.0, 0.0))
    right_array /= np.linalg.norm(right_array)
    camera, forward, right = tuple(camera_array), tuple(forward_array), tuple(right_array)
    up = tuple(np.cross(right_array, forward_array))
    canvas_size = size * _PREVIEW_SUPERSAMPLE
    focal = canvas_size / 2 / math.tan(math.radians(_PREVIEW_FOV_DEGREES) / 2)

    def project(point) -> Tuple[float, float]:
        view = (point[0] - camera[0], point[1] - camera[1], point[2] - camera[2])
        depth = _dot(view, forward)
        return (canvas_size / 2 + focal * _dot(view, right) / depth,
                canvas_size / 2 - focal * _dot(view, up) / depth)

    def distance(points) -> float:
        n = len(points)
        centroid = [sum(p[axis] for p in points) / n - camera[axis] for axis in range(3)]
        return _dot(centroid, centroid)

    def faces_camera(normal, point) -> bool:
        return _dot(normal, (camera[0] - point[0], camera[1] - point[1], camera[2] - point[2])) > 0

    def shade(code: int, normal, factor: float = 1.0) -> Tuple[int, int, int]:
        rgb = palette.get(code, ("", "888888"))[1]
        light = min(1.0, 0.5 + 0.5 * max(0.0, _dot(normal, _KEY_LIGHT)) + 0.2 * max(0.0, _dot(normal, _FILL_LIGHT)))
        return tuple(int(int(rgb[i:i + 2], 16) * light * factor) for i in (0, 2, 4))

    polygons = []  # (distance, screen points, fill, edge segments, edge color)
    for cell, index in owner.items():
        code = parts[index][0]
        for axis, sign, (u, w) in _CELL_FACES:
            step = [0, 0, 0]
            step[axis] = sign
            if (cell[0] + step[0], cell[1] + step[1], cell[2] + step[2]) in owner:
                continue
            corners = []
            for du, dw in ((0, 0), (1, 0), (1, 1), (0, 1)):
                corner = list(cell)
                corner[axis] += sign > 0
                corner[u] += du
                corner[w] += dw
                corners.append(_cell_to_world(*corner))
            normal = _cell_normal(axis, sign)
            if not faces_camera(normal, corners[0]):
                continue
            screen = [project(corner) for corner in corners]
            edges = []
            for j, (edge_axis, edge_sign) in enumerate(((w, -1), (u, 1), (w, 1), (u, -1))):
                neighbor = list(cell)
                neighbor[edge_axis] += edge_sign
                beyond = list(neighbor)
                beyond[axis] += sign
                if owner.get(tuple(neighbor)) != index or tuple(beyond) in owner:
                    edges.append((screen[j], screen[(j + 1) % 4]))
            polygons.append((distance(corners), screen, shade(code, normal), edges,
                             shade(code, normal, _EDGE_SHADE)))

    angles = [2 * math.pi * j / _STUD_SEGMENTS for j in range(_STUD_SEGMENTS)]
    for (i, k, h), index in owner.items():
        code, top = parts[index]
        if h != top - 1 or (i, k, h + 1) in owner:
            continue
        x, _, z = _cell_to_world(i + 0.5, k + 0.5, 0)
        y0 = (h + 1) * _PLATE_LDU
        y1 = y0 + _STUD_HEIGHT
        ring = [(x + _STUD_RADIUS * math.cos(a), z + _STUD_RADIUS * math.sin(a)) for a in angles]
        for j, angle in enumerate(angles):
            (ax, az), (bx, bz) = ring[j], ring[(j + 1) % _STUD_SEGMENTS]
            middle = angle + math.pi / _STUD_SEGMENTS
            normal = (math.cos(middle), 0.0, math.sin(middle))
            side = [(ax, y0, az), (bx, y0, bz), (bx, y1, bz), (ax, y1, az)]
            if faces_camera(normal, side[0]):
                polygons.append((distance(side), [project(p) for p in side], shade(code, normal), [], None))
        cap = [(px, y1, pz) for px, pz in ring]
        screen = [project(p) for p in cap]
        normal = (0.0, 1.0, 0.0)
        polygons.append((distance(cap), screen, shade(code, normal),
                         list(zip(screen, screen[1:] + screen[:1])), shade(code, normal, _EDGE_SHADE)))

    image = Image.new("RGB", (canvas_size, canvas_size), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    for _, screen, fill, edges, edge_color in sorted(polygons, key=lambda polygon: -polygon[0]):
        draw.polygon(screen, fill=fill, outline=fill)
        for edge in edges:
            draw.line(edge, fill=edge_color, width=_PREVIEW_SUPERSAMPLE)
    image = image.resize((size, size), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


# --------------------------------------------------------------------------- LDraw audit

_KNOWN_PARTS: Dict[str, Tuple[int, int, int]] = {}  # part -> (length_x, width_z, height_in_plates)
for _table, _plates in ((BRICK_PARTS, 3), (PLATE_PARTS, 1)):
    for (_w, _l), _part in _table.items():
        _KNOWN_PARTS[f"{_part}.dat"] = (_l, _w, _plates)
# other common rectangular bricks, plates and tiles: part -> (width, length, height in plates)
for _part, (_w, _l, _plates) in {
    "3006": (2, 10, 3), "6111": (1, 10, 3), "6112": (1, 12, 3), "2465": (1, 16, 3),
    "3062b": (1, 1, 3), "3941": (2, 2, 3), "6143": (2, 2, 3),
    "3031": (4, 4, 1), "3032": (4, 6, 1), "3035": (4, 8, 1), "3030": (4, 10, 1), "3029": (4, 12, 1),
    "3958": (6, 6, 1), "3036": (6, 8, 1), "3033": (6, 10, 1), "3028": (6, 12, 1), "41539": (8, 8, 1),
    "91405": (16, 16, 1), "3832": (2, 10, 1), "2445": (2, 12, 1), "4477": (1, 10, 1), "60479": (1, 12, 1),
    "3070b": (1, 1, 1), "3069b": (1, 2, 1), "63864": (1, 3, 1), "2431": (1, 4, 1), "6636": (1, 6, 1),
    "4162": (1, 8, 1), "3068b": (2, 2, 1), "87079": (2, 4, 1), "4032": (2, 2, 1),
}.items():
    _KNOWN_PARTS[f"{_part}.dat"] = (_l, _w, _plates)


@dataclass
class LdrawAudit:
    checked: int = 0
    skipped: int = 0
    off_grid: List[int] = field(default_factory=list)       # LDraw line numbers
    overlaps: List[Tuple[int, int]] = field(default_factory=list)
    floating: List[int] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not (self.off_grid or self.overlaps or self.floating)

    def describe(self, limit: int = 10) -> str:
        parts = []
        if self.off_grid:
            parts.append(f"{len(self.off_grid)} part(s) are not aligned to the stud grid / layer heights "
                         f"(lines {', '.join(map(str, self.off_grid[:limit]))})")
        if self.overlaps:
            parts.append(f"{len(self.overlaps)} pair(s) of parts overlap (lines "
                         + ", ".join(f"{a}&{b}" for a, b in self.overlaps[:limit]) + ")")
        if self.floating:
            parts.append(f"{len(self.floating)} part(s) float with nothing below or above them "
                         f"(lines {', '.join(map(str, self.floating[:limit]))})")
        return "; ".join(parts) or "no problems found"


def _upright_part_box(tokens: List[str]) -> Optional[Tuple[float, float, float, int, int, int]]:
    """(x0, z0, bottom plate, fx, fz, plates) of a type-1 line's basic part, or None if unsupported."""
    part = tokens[14].lower()
    if part not in _KNOWN_PARTS:
        return None
    try:
        x, y, z = (float(t) for t in tokens[2:5])
        m = [float(t) for t in tokens[5:14]]
    except ValueError:
        return None
    length, width, plates = _KNOWN_PARTS[part]
    # upright parts rotated a multiple of 90 degrees about Y only
    if not (abs(m[4] - 1) < 1e-6 and all(abs(m[i]) < 1e-6 for i in (1, 3, 5, 7))):
        return None
    if abs(m[0]) > 0.5:          # long side along X
        fx, fz = length, width
    else:                        # long side along Z
        fx, fz = width, length
    return x / LDU_PER_STUD - fx / 2, z / LDU_PER_STUD - fz / 2, -y / 8 - plates, fx, fz, plates


def _ldraw_part_cells(ldr: str) -> Tuple[List[Tuple[int, int]], Dict[Tuple[int, int, int], int]]:
    """(color, top plate level) of each on-grid basic part, and the part filling each cell."""
    parts: List[Tuple[int, int]] = []
    owner: Dict[Tuple[int, int, int], int] = {}
    for line in ldr.splitlines():
        tokens = line.split()
        if len(tokens) != 15 or tokens[0] != "1":
            continue
        box = _upright_part_box(tokens)
        if box is None or not all(abs(v - round(v)) < 0.05 for v in box[:3]):
            continue
        x0, z0, bottom = (int(round(v)) for v in box[:3])
        fx, fz, plates = box[3:]
        parts.append((int(tokens[1]) if tokens[1].isdigit() else -1, bottom + plates))
        for i in range(x0, x0 + fx):
            for k in range(z0, z0 + fz):
                for h in range(bottom, bottom + plates):
                    owner.setdefault((i, k, h), len(parts) - 1)
    return parts, owner


def audit_ldraw(ldr: str) -> LdrawAudit:
    """Check an LDraw model built from basic bricks/plates for off-grid parts, overlapping parts
    and parts touching nothing above or below. Other parts are skipped (counted in .skipped)."""
    audit = LdrawAudit()
    cells: Dict[Tuple[int, int, int], int] = {}
    placed: List[Tuple[int, List[Tuple[int, int, int]]]] = []
    for number, line in enumerate(ldr.splitlines(), start=1):
        tokens = line.split()
        if len(tokens) != 15 or tokens[0] != "1":
            continue
        box = _upright_part_box(tokens)
        if box is None:
            audit.skipped += 1
            continue
        gx, gz, bottom, fx, fz, plates = box
        audit.checked += 1
        if not all(abs(v - round(v)) < 0.05 for v in (gx, gz, bottom)):
            audit.off_grid.append(number)
            continue
        gx, gz, bottom = int(round(gx)), int(round(gz)), int(round(bottom))
        footprint = [(i, k, h) for i in range(gx, gx + fx) for k in range(gz, gz + fz)
                     for h in range(bottom, bottom + plates)]
        hits = {cells[c] for c in footprint if c in cells}
        for other in sorted(hits):
            audit.overlaps.append((other, number))
        for c in footprint:
            cells.setdefault(c, number)
        placed.append((number, footprint))
    if placed and not audit.skipped:  # can't judge support if some parts weren't modeled
        lowest = min(h for _, fp in placed for (_, _, h) in fp)
        for number, footprint in placed:
            bottom = min(h for _, _, h in footprint)
            top = max(h for _, _, h in footprint)
            if bottom == lowest:
                continue
            touching = any((i, k, bottom - 1) in cells for i, k, _ in footprint) or any(
                (i, k, top + 1) in cells for i, k, _ in footprint)
            if not touching:
                audit.floating.append(number)
    return audit
