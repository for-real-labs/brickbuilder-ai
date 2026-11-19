"""Check ordinary LDraw faces against known solid material, including unprofiled neighbors."""
from functools import lru_cache
from itertools import chain

import numpy as np

from material_collision import MAX_REPORTED_PAIRS, TOLERANCE, bounds, overlap_diagnostic, transformed_solids

# Exposed rigid features with no intended press fit. A neighboring part can
# have any shape. Its official polygons, including subparts, supply the other
# side of the test. Stud/socket and Technic fit surfaces keep their own checks.
EXPOSED_PARTS = {'4079', '3960', '4740'}
MAX_PART_TRIANGLES = 100_000


def triangle_loader(parts):
    from ldraw.lines import Quadrilateral, Triangle
    from ldraw.pieces import Piece

    visiting = set()

    @lru_cache(maxsize=64)
    def load(code):
        if code in visiting or len(visiting) >= 150:
            raise ValueError('Invalid part dependency in material review')
        visiting.add(code)
        try:
            chunks, count = [], 0
            for obj in parts.part(code=code).objects:
                if isinstance(obj, Piece):
                    child = load(obj.part.casefold().replace('\\', '/'))
                    position = [obj.position.x, obj.position.y, obj.position.z]
                    faces = child @ np.array(obj.matrix.rows).T + position
                elif isinstance(obj, (Triangle, Quadrilateral)):
                    points = np.array([[p.x, p.y, p.z] for p in obj.points])
                    indices = [[0, 1, 2], [0, 2, 3]] if isinstance(obj, Quadrilateral) else [[0, 1, 2]]
                    faces = points[indices]
                else:
                    continue
                count += len(faces)
                if count > MAX_PART_TRIANGLES:
                    raise ValueError('Part exceeds the surface review limit')
                chunks.append(faces)
            return np.concatenate(chunks) if chunks else np.empty((0, 3, 3))
        finally:
            visiting.remove(code)

    return load


def faces_enter_box(triangles, solid):
    """Triangle/box separating axes: box axes, face normal and edge cross axes."""
    centre, axes, half = solid
    half = half - TOLERANCE
    points = (triangles - centre) @ axes
    inside_slabs = ((points.min(axis=1) < half) & (points.max(axis=1) > -half)).all(axis=1)
    points = points[inside_slabs]
    if not len(points):
        return False
    edges = np.roll(points, -1, axis=1) - points
    normals = np.cross(edges[:, 0], edges[:, 1])
    # Degenerate polygons and edge/conditional-line drawing aids have no face.
    hits = np.linalg.norm(normals, axis=1) > 1e-9
    cross_axes = (np.cross(edge, unit) for edge in edges.transpose(1, 0, 2) for unit in np.eye(3))
    for axis in chain((normals,), cross_axes):
        projected = np.einsum('ijk,ik->ij', points, axis)
        radius = np.abs(axis) @ half
        hits &= (np.linalg.norm(axis, axis=1) < 1e-9) | (
            (projected.min(axis=1) < radius) & (projected.max(axis=1) > -radius))
        if not hits.any():
            return False
    return bool(hits.any())


def crosses_material(faces, solids, lows, highs, candidates):
    face_low, face_high = faces.min(axis=1), faces.max(axis=1)
    for k in np.flatnonzero(candidates):
        near = ((face_low <= highs[k]) & (face_high >= lows[k])).all(axis=1)
        if near.any() and faces_enter_box(faces[near], solids[k]):
            return True
    return False


def exposed_overlaps(occurrences, instances, load, collisions):
    """Use the toolkit's world bounds to restrict polygon work to nearby pieces."""
    if len(collisions) >= MAX_REPORTED_PAIRS:
        return
    exposed = [(i, part) for i, part in enumerate(occurrences)
               if part.part_code.casefold().removesuffix('.dat') in EXPOSED_PARTS]
    if not exposed:
        return
    reported = {tuple(sorted(hit['instances'])) for hit in collisions}
    world_low = np.array([item['bounds']['min'] for item in instances])
    world_high = np.array([item['bounds']['max'] for item in instances])
    for i, part in exposed:
        solids = transformed_solids(part, {})
        lows, highs = bounds(solids)
        nearby = ((world_low < highs.max(axis=0)) & (world_high > lows.min(axis=0))).all(axis=1)
        for j in np.flatnonzero(nearby).tolist():
            pair = tuple(sorted((i, j)))
            if i == j or pair in reported:
                continue
            other = occurrences[j]
            candidates = ((world_low[j] < highs) & (world_high[j] > lows)).all(axis=1)
            if not candidates.any():
                continue
            faces = load(other.part_code.casefold().removesuffix('.dat'))
            offset = [other.position.x, other.position.y, other.position.z]
            faces = faces @ np.array(other.matrix.rows).T + offset
            if crosses_material(faces, solids, lows, highs, candidates):
                reported.add(pair)
                collisions.append(overlap_diagnostic(occurrences, i, j))
                if len(collisions) >= MAX_REPORTED_PAIRS:
                    return
