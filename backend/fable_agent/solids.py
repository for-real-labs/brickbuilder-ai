"""Pieces of plastic that are certainly there, and the tests that find two of them in one place.

A part's coarse shape cannot tell a hollow from a wall, so the ordinary overlap check has to let
a script declare an overlap intended. These solids are stricter evidence. Each is a box inscribed
in real material: the top skin and walls of a plain brick, plate or tile, and the measured
features of a few parts that are easy to run into (a seat back, a dish rim, a curved tile, the
side studs of a bracket brick). Cavities are left empty, so a stud in its socket is never a hit.
A hit proves two parts interfere, at any rotation. No hit proves nothing about parts outside
this cover. Dimensions follow the official LDraw parts named below, in LDraw units.

A solid is ``(centre, axes, half)``: a box with its centre, its three axes as matrix columns and
its half-size along each.
"""

from __future__ import annotations

import math
from functools import lru_cache
from itertools import chain, product

import numpy as np

from .kit import Placement

TOLERANCE = 0.05  # ignore touching faces and the library's rounding
# Six-decimal rotations can move an entry of M'M by up to 2 * sqrt(3) * 0.5e-6. Allow that
# without accepting a placement that really is scaled or sheared.
ROTATION_ROUNDING = 4e-6
EXPOSED_PARTS = frozenset({"4079", "3960", "4740"})  # rigid features nothing is meant to press onto
Solid = tuple[np.ndarray, np.ndarray, np.ndarray]


def box(low, high, axes=None) -> Solid:
    low, high = np.array(low, dtype=float), np.array(high, dtype=float)
    return (low + high) / 2, np.eye(3) if axes is None else axes, (high - low) / 2


@lru_cache(maxsize=1)
def _curved_tile_skin() -> list[Solid]:
    # 27925 is a quarter ring centred at (-10, 10), radii 20 and 40, solid through y = 0..4.
    # The cells are inset so they stay clear of its faceted arcs.
    cells = []
    for x, z in product(range(0, 40, 2), repeat=2):
        if math.hypot(x, z) > 20.6 and math.hypot(x + 2, z + 2) < 39.4:
            cells.append(box((x - 10, .25, 10 - z - 2), (x - 8, 1.75, 10 - z)))
    return cells


def _side_studs(height: int) -> list[Solid]:
    # Hollow side studs: only the material between radius 4 and 6. The studs point towards -z
    # and their bore stays empty.
    found = []
    for x, y in product((-10, 10), (10,) if height == 24 else (10, 30)):
        for angle in range(0, 360, 30):
            a = math.radians(angle)
            axes = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
            centre = np.array([x, y, -12]) + axes @ np.array([5., 0, 0])
            found.append((centre, axes, np.array([.55, .7, 1.5])))
    return found


@lru_cache(maxsize=1)
def _minifig_seat() -> list[Solid]:
    # 4079: a 2 x 2 pan with rounded front corners and an open underside. The backrest is 40 tall
    # and flares from z = 20 at the pan to z = 25.
    solids = [
        box((-15.9, .1, -19.9), (15.9, 3.9, 19.9)),
        box((-19.9, .1, -15.9), (19.9, 3.9, 19.9)),
        box((-19.9, -1, 17.1), (19.9, 0, 19.9)),
        box((-19.9, -3.1, 19.9), (19.9, -1, 20.5)),
        box((-19.9, -8, 20.1), (19.9, -3.1, 21.9)),
    ]
    # Above the bend the back moves out one unit per 16 of height. Each slice uses its narrower
    # end, and the top one leaves room for the rounded corners.
    for y in range(-40, -8, 4):
        width = 15.9 if y == -40 else 19.9
        outer = 23 + (-8 - (y + 4)) / 16
        solids.append(box((-width, y + .01, 20.05), (width, y + 4, outer - .05)))
    return solids


@lru_cache(maxsize=2)
def _dish_rim(code: str) -> list[Solid]:
    # The rims are faceted. 3960 has an upright skirt between radii 36 and 40. 4740 has a cone
    # under its lip, rising from y = 8 at radius 20 to y = 5.8 at radius 16.
    large = code == "3960"
    sides, outer, top = (48, 40, 8) if large else (16, 20, 5.6)
    half_angle = math.pi / sides
    solids = []
    for side in range(sides):
        angle = (2 * side + 1) * half_angle
        c, s = math.cos(angle), math.sin(angle)
        axes = np.array([[c, 0, -s], [0, 1, 0], [s, 0, c]])
        for radius in range(outer - 4, outer):
            bottom = 16 if large else 5.8 + .55 * (radius - 16)
            # Local x follows the facet's normal. The inner edge's width is used at both ends so
            # each box stays inside its sector of the ring.
            width = radius * math.sin(half_angle) - .005
            inner = radius * math.cos(half_angle) + .005
            edge = (radius + 1) * math.cos(half_angle) - .005
            centre, _, half = box((inner, top + .005, -width), (edge, bottom - .005, width))
            solids.append((axes @ centre, axes, half))
    return solids


def local_solids(code: str, profiles) -> list[Solid]:
    """The solids of a part in its own frame. ``profiles.get(code)`` sizes a plain rectangular part."""
    if code == "4079":
        return _minifig_seat()
    if code == "98138":
        # Round tile: the material above its recess, inside the faceted edge.
        return [box((-4, .1, -8.9), (4, 3.9, 8.9)), box((-8.9, .1, -4), (8.9, 3.9, 4))]
    if code in ("3960", "4740"):
        return _dish_rim(code)
    if code == "27925":
        return _curved_tile_skin()
    if code in ("11211", "22885"):
        # The faces with studs have holes, so the brick is not treated as one solid block.
        return _side_studs(24 if code == "11211" else 40)
    profile = profiles.get(code)
    if not profile:
        return []
    x, z, h = profile["x_studs"] * 10, profile["z_studs"] * 10, profile["height"]
    # The top skin and the four walls. Sockets, tubes and studs are left out, not filled in.
    return [box((-x + .5, .25, -z + .5), (x - .5, 1.75, z - .5)),
            box((-x + .25, 1.75, -z + .5), (-x + 1.25, h - 1, z - .5)),
            box((x - 1.25, 1.75, -z + .5), (x - .25, h - 1, z - .5)),
            box((-x + 1.25, 1.75, -z + .25), (x - 1.25, h - 1, -z + 1.25)),
            box((-x + 1.25, 1.75, z - 1.25), (x - 1.25, h - 1, z - .25))]


def placed_solids(placement: Placement, profiles) -> list[Solid]:
    """A placement's solids in model space. Raises ValueError for a scaled or sheared placement."""
    solids = local_solids(placement.part, profiles)
    matrix = np.array(placement.matrix, dtype=float).reshape(3, 3)
    position = np.array(placement.position, dtype=float)
    if not np.isfinite(matrix).all() or not np.isfinite(position).all():
        raise ValueError("Non-finite part transform")
    if solids and not np.allclose(matrix.T @ matrix, np.eye(3), atol=ROTATION_ROUNDING, rtol=0):
        raise ValueError("Solids need an unscaled rotation")
    return [(matrix @ centre + position, matrix @ axes, half) for centre, axes, half in solids]


def bounds(solids: list[Solid]) -> tuple[np.ndarray, np.ndarray]:
    """The axis-aligned low and high corner of each solid."""
    centres = np.array([solid[0] for solid in solids])
    extents = np.array([np.abs(solid[1]) @ solid[2] for solid in solids])
    return centres - extents, centres + extents


def intersects(a: Solid, b: Solid) -> bool:
    """Two boxes share space: no axis of either, nor a cross of their edges, separates them."""
    centre_a, axes_a, half_a = a
    centre_b, axes_b, half_b = b
    for axis in [*axes_a.T, *axes_b.T, *(np.cross(x, y) for x in axes_a.T for y in axes_b.T)]:
        length = np.linalg.norm(axis)
        if length < 1e-8:
            continue
        axis = axis / length
        depth = abs(axes_a.T @ axis) @ half_a + abs(axes_b.T @ axis) @ half_b - abs((centre_b - centre_a) @ axis)
        if depth <= TOLERANCE:
            return False
    return True


def faces_enter(triangles: np.ndarray, solid: Solid) -> bool:
    """Any of the triangles, as (n, 3, 3) in model space, passes through the solid."""
    centre, axes, half = solid
    half = half - TOLERANCE
    points = (triangles - centre) @ axes
    inside_slabs = ((points.min(axis=1) < half) & (points.max(axis=1) > -half)).all(axis=1)
    points = points[inside_slabs]
    if not len(points):
        return False
    edges = np.roll(points, -1, axis=1) - points
    normals = np.cross(edges[:, 0], edges[:, 1])
    # A degenerate polygon has no face to cross.
    hits = np.linalg.norm(normals, axis=1) > 1e-9
    cross_axes = (np.cross(edge, unit) for edge in edges.transpose(1, 0, 2) for unit in np.eye(3))
    for axis in chain((normals,), cross_axes):
        projected = np.einsum("ijk,ik->ij", points, axis)
        radius = np.abs(axis) @ half
        hits &= (np.linalg.norm(axis, axis=1) < 1e-9) | (
            (projected.min(axis=1) < radius) & (projected.max(axis=1) > -radius))
        if not hits.any():
            return False
    return bool(hits.any())
