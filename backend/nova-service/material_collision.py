"""Supplement Nova's envelope checks with conservative pieces of actual plastic.

These are inscribed solids, not bounding boxes of hollow parts. A hit proves
interference; no hit is not a proof for parts/features outside this coverage.
Dimensions follow official LDraw 27925/s27925s01, 22885, 11211 and stud2(a).
Keep cavities empty so legal stud/socket connections are not rejected.
"""
from functools import lru_cache
from itertools import product
import math

import numpy as np

TOLERANCE = 0.05  # LDU: ignore touching faces and library rounding.
MAX_REPORTED_PAIRS = 30


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


def local_solids(code, regular):
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
    if solids and not np.allclose(matrix.T @ matrix, np.eye(3), atol=1e-6, rtol=0):
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
                collisions.append({'code': 'assembly.material_overlap', 'severity': 'error',
                    'message': 'Solid plastic intersects; move or replace these parts. Connections do not waive collisions.',
                    'instances': [i, j], 'parts': [occurrences[k].part_code for k in (i, j)],
                    'positions': [[float(getattr(occurrences[k].position, axis)) for axis in ('x', 'y', 'z')] for k in (i, j)]})
                if len(collisions) >= MAX_REPORTED_PAIRS:
                    return collisions
    return collisions
