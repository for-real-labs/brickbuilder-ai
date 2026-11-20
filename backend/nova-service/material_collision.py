"""Supplement Nova's envelope checks with conservative pieces of actual plastic.

These are inscribed solids, not bounding boxes of hollow parts. A hit proves
interference; no hit is not a proof for parts/features outside this coverage.
Dimensions follow the official LDraw parts and primitives named below.
Keep cavities empty so legal stud/socket connections are not rejected.
"""
from functools import lru_cache
from itertools import product
import math

import numpy as np

TOLERANCE = 0.05  # LDU: ignore touching faces and library rounding.
MAX_REPORTED_PAIRS = 30
# Six-decimal LDraw rotations can perturb a Gram-matrix entry by up to
# 2 * sqrt(3) * 0.5e-6 plus quadratic rounding terms. Allow that precision
# without accepting meaningful scaling or shear.
TRANSFORM_ROUNDING_TOLERANCE = 4e-6


def box(low, high, axes=None):
    low, high = np.array(low, dtype=float), np.array(high, dtype=float)
    return (low + high) / 2, np.eye(3) if axes is None else axes, (high - low) / 2


@lru_cache(maxsize=1)
def curved_tile_skin():
    # 27925 is a quarter annulus centred at (-10, 10), radii 20 and 40.
    # Its top is solid through y=0..4. Inset cells avoid the faceted arcs.
    cells = []
    for x, z in product(range(0, 40, 2), repeat=2):
        if math.hypot(x, z) > 20.6 and math.hypot(x + 2, z + 2) < 39.4:
            cells.append(box((x - 10, .25, 10 - z - 2), (x - 8, 1.75, 10 - z)))
    return cells


def side_studs(height):
    # Hollow side studs: retain only material between radius 4 and 6.
    # Local stud axes point toward -Z; the central bore remains empty.
    result = []
    for x, y in product((-10, 10), (10,) if height == 24 else (10, 30)):
        for angle in range(0, 360, 30):
            a = math.radians(angle)
            axes = np.array([[math.cos(a), -math.sin(a), 0],
                             [math.sin(a), math.cos(a), 0], [0, 0, 1]])
            centre = np.array([x, y, -12]) + axes @ np.array([5., 0, 0])
            result.append((centre, axes, np.array([.55, .7, 1.5])))
    return result


@lru_cache(maxsize=1)
def minifig_seat():
    # 4079's 2x2 pan has rounded front corners and an open underside. The
    # backrest is 40 LDU tall and flares from z=20 at the pan to z=25.
    solids = [
        box((-15.9, .1, -19.9), (15.9, 3.9, 19.9)),
        box((-19.9, .1, -15.9), (19.9, 3.9, 19.9)),
        box((-19.9, -1, 17.1), (19.9, 0, 19.9)),
        box((-19.9, -3.1, 19.9), (19.9, -1, 20.5)),
        box((-19.9, -8, 20.1), (19.9, -3.1, 21.9)),
    ]
    # Above the bend, the back moves out one LDU per 16 LDU of height.
    # Use the narrower end of each slice, including the rounded top corners.
    for y in range(-40, -8, 4):
        width = 15.9 if y == -40 else 19.9
        outer = 23 + (-8 - (y + 4)) / 16
        solids.append(box((-width, y + .01, 20.05), (width, y + 4, outer - .05)))
    return solids


@lru_cache(maxsize=2)
def dish_rim(code):
    # The official rims are faceted, not circles. 3960s00 has a vertical
    # skirt between radii 36 and 40. 4740s01 has a cone underneath its lip:
    # its underside rises from y=8 at radius 20 to y=5.8 at radius 16.
    large = code == '3960'
    sides, outer, top = (48, 40, 8) if large else (16, 20, 5.6)
    half_angle = math.pi / sides
    solids = []
    for side in range(sides):
        angle = (2 * side + 1) * half_angle
        c, s = math.cos(angle), math.sin(angle)
        axes = np.array([[c, 0, -s], [0, 1, 0], [s, 0, c]])
        for radius in range(outer - 4, outer):
            bottom = 16 if large else 5.8 + .55 * (radius - 16)
            # Local x follows the facet normal. Use the inner edge's width
            # at both ends so each box stays within its annular sector.
            width = radius * math.sin(half_angle) - .005
            inner = radius * math.cos(half_angle) + .005
            edge = (radius + 1) * math.cos(half_angle) - .005
            centre, _, half = box((inner, top + .005, -width), (edge, bottom - .005, width))
            solids.append((axes @ centre, axes, half))
    return solids


def local_solids(code, regular):
    if code == '4079':
        return minifig_seat()
    if code == '98138':
        # Round tile: material above the recess, inside the faceted perimeter.
        return [box((-4, .1, -8.9), (4, 3.9, 8.9)),
                box((-8.9, .1, -4), (8.9, 3.9, 4))]
    if code in {'3960', '4740'}:
        return dish_rim(code)
    if code == '27925':
        return curved_tile_skin()
    if code in {'11211', '22885'}:
        # Side faces have holes: do not treat the entire brick as solid.
        return side_studs(24 if code == '11211' else 40)
    profile = regular.get(code)
    if not profile:
        return []
    x, z, h = profile['x_studs'] * 10, profile['z_studs'] * 10, profile['height']
    # Inscribed top skin and exterior walls of the curated rectangular parts.
    # Exclude underside sockets, tubes and studs rather than fill their cavities.
    return [box((-x + .5, .25, -z + .5), (x - .5, 1.75, z - .5)),
            box((-x + .25, 1.75, -z + .5), (-x + 1.25, h - 1, z - .5)),
            box((x - 1.25, 1.75, -z + .5), (x - .25, h - 1, z - .5)),
            box((-x + 1.25, 1.75, -z + .25), (x - 1.25, h - 1, -z + 1.25)),
            box((-x + 1.25, 1.75, z - 1.25), (x - 1.25, h - 1, z - .25))]


def transformed_solids(occurrence, regular):
    code = occurrence.part_code.casefold().removesuffix('.dat')
    solids = local_solids(code, regular)
    matrix = np.array(occurrence.matrix.rows, dtype=float)
    position = np.array([getattr(occurrence.position, axis) for axis in ('x', 'y', 'z')], dtype=float)
    if not np.isfinite(matrix).all() or not np.isfinite(position).all():
        raise ValueError('Non-finite part transform')
    if solids and not np.allclose(matrix.T @ matrix, np.eye(3), atol=TRANSFORM_ROUNDING_TOLERANCE, rtol=0):
        raise ValueError('Material review requires unscaled orthogonal part transforms')
    return [(matrix @ centre + position, matrix @ axes, half) for centre, axes, half in solids]


def bounds(solids):
    centres = np.array([s[0] for s in solids])
    extents = np.array([np.abs(s[1]) @ s[2] for s in solids])
    return centres - extents, centres + extents


def intersects(a, b):
    ca, aa, ha = a
    cb, ab, hb = b
    for axis in [*aa.T, *ab.T, *(np.cross(x, y) for x in aa.T for y in ab.T)]:
        length = np.linalg.norm(axis)
        if length < 1e-8:
            continue
        axis = axis / length
        depth = abs(aa.T @ axis) @ ha + abs(ab.T @ axis) @ hb - abs((cb - ca) @ axis)
        if depth <= TOLERANCE:
            return False
    return True


def overlap_diagnostic(occurrences, i, j):
    return {'code': 'assembly.material_overlap', 'severity': 'error',
            'message': 'Solid plastic intersects; move or replace these parts. Connections do not waive collisions.',
            'instances': [i, j], 'parts': [occurrences[k].part_code for k in (i, j)],
            'positions': [[float(getattr(occurrences[k].position, axis)) for axis in ('x', 'y', 'z')] for k in (i, j)]}


def review_material(occurrences, regular):
    entries = []
    for index, occurrence in enumerate(occurrences):
        solids = transformed_solids(occurrence, regular)
        if solids:
            low, high = bounds(solids)
            entries.append((index, solids, low, high, low.min(axis=0), high.max(axis=0)))
    entries.sort(key=lambda e: e[4][0])
    collisions = []
    for offset, first in enumerate(entries):
        i, a, al, ah, amin, amax = first
        for j, b, bl, bh, bmin, bmax in entries[offset + 1:]:
            if bmin[0] >= amax[0] - TOLERANCE:
                break
            if np.any(np.minimum(amax, bmax) - np.maximum(amin, bmin) <= TOLERANCE):
                continue
            candidates = np.all(np.minimum(ah[:, None], bh) - np.maximum(al[:, None], bl) > TOLERANCE, axis=2)
            if any(intersects(a[u], b[v]) for u, v in zip(*np.nonzero(candidates))):
                collisions.append(overlap_diagnostic(occurrences, i, j))
                if len(collisions) >= MAX_REPORTED_PAIRS:
                    return collisions
    return collisions
