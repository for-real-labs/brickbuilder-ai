import importlib
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest


@pytest.fixture
def surfaces(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).parents[1] / 'nova-service'))
    return importlib.import_module('material_surfaces')


def occurrence(code, x=0):
    return SimpleNamespace(part_code=code, position=SimpleNamespace(x=x, y=0, z=0),
                           matrix=SimpleNamespace(rows=np.eye(3)))


def test_unknown_part_face_crossing_backrest_is_blocked_with_all_vertices_outside(surfaces):
    # A large face through the seat back. The second copy has the same pose
    # relative to its own submodel but sits beyond the seat in world space.
    faces = np.array([[[-45, -20, 21], [45, -20, 21], [0, -48, 21]]])
    pieces = [occurrence('4079'), occurrence('unprofiled'), occurrence('unprofiled', 100)]
    bounds = [{'bounds': {'min': low, 'max': high}} for low, high in [
        ([-20, -40, -20], [20, 8, 25]), ([-45, -48, 21], [45, -20, 21]),
        ([55, -48, 21], [145, -20, 21])]]
    loads = []
    def load(code):
        loads.append(code)
        return faces
    hits = []
    surfaces.exposed_overlaps(pieces, bounds, load, hits)
    assert loads == ['unprofiled']
    assert [hit['parts'] for hit in hits] == [['4079', 'unprofiled']]
    surfaces.exposed_overlaps(pieces, bounds, load, hits)
    assert len(hits) == 1 and loads == ['unprofiled']


@pytest.mark.parametrize('vertices,expected', [
    ([[-3, 0, 0], [3, 0, 0], [0, 3, 0]], True),
    ([[-2, 1, 0], [2, 1, 0], [0, 1, 2]], False),  # flush face
    ([[3, 0, 0], [0, 3, 0], [3, 3, 0]], False),  # overlapping bounds, disjoint face
    ([[-2, 0, 0], [0, 0, 0], [2, 0, 0]], False),  # zero-area face
])
def test_face_box_intersection_in_rotated_world_frame(surfaces, vertices, expected):
    angle = np.pi / 7
    c, s = np.cos(angle), np.sin(angle)
    rotation = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    centre = np.array([42, -83, 19])
    faces = np.array([vertices]) @ rotation.T + centre
    assert surfaces.faces_enter_box(faces, (centre, rotation, np.ones(3))) is expected
