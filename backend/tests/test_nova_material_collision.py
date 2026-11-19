import importlib.util
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

spec = importlib.util.spec_from_file_location('material_collision', Path(__file__).parents[1] / 'nova-service/material_collision.py')
material = importlib.util.module_from_spec(spec)
spec.loader.exec_module(material)
I = np.eye(3)
RY90 = np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]])
REGULAR = {'3022': {'x_studs': 2, 'z_studs': 2, 'height': 8},
           '3021': {'x_studs': 3, 'z_studs': 2, 'height': 8},
           '3001': {'x_studs': 4, 'z_studs': 2, 'height': 24}}


def part(code, position, matrix=I):
    return SimpleNamespace(part_code=code, position=SimpleNamespace(**dict(zip(('x', 'y', 'z'), position))),
                           matrix=SimpleNamespace(rows=matrix))


def test_peacock_same_height_corner_tiles_are_rejected():
    pieces = [part('27925', (-30, -96, 30), RY90), part('27925', (-10, -96, 30), RY90)]
    report = material.review_material(pieces, REGULAR)
    assert len(report) == 1
    assert report[0]['parts'] == ['27925', '27925']
    assert set(report[0]['instances']) == {0, 1}


def test_peacock_lower_backrest_studs_hit_seat_plate():
    pieces = [part('22885', (-40, -120, 50)), part('3021', (-30, -88, 20))]
    assert material.review_material(pieces, REGULAR)[0]['code'] == 'assembly.material_overlap'


@pytest.mark.parametrize('rotation', [I, RY90])
def test_global_rotation_does_not_hide_side_stud_collision(rotation):
    pieces = [part('22885', rotation @ np.array([-40, -120, 50]), rotation),
              part('3021', rotation @ np.array([-30, -88, 20]), rotation)]
    assert material.review_material(pieces, REGULAR)


def test_side_stud_with_clearance_is_allowed():
    assert not material.review_material([part('22885', (-40, -120, 50)),
                                        part('3021', (-30, -88, 10))], REGULAR)


def test_tiles_with_clearance_are_allowed():
    assert not material.review_material([part('27925', (-30, -96, 30), RY90),
                                        part('27925', (10, -96, 30), RY90)], REGULAR)


def test_stacked_bricks_and_tile_on_plate_remain_legal():
    assert not material.review_material([part('3001', (0, 0, 0)), part('3001', (0, -24, 0))], REGULAR)
    assert not material.review_material([part('27925', (0, -8, 0)), part('3021', (0, 0, 0))], REGULAR)


def test_hollow_side_stud_does_not_become_a_solid_box():
    solids = material.side_studs(40)
    bore = material.box((-11, 9, -13), (-9, 11, -11))
    assert not any(material.intersects(solid, bore) for solid in solids)


def test_connected_side_stud_and_rotated_plate_socket_remain_legal():
    # Four plate sockets line up with the four side studs; underside at z=-10.
    rotation = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]])
    assert not material.review_material([part('22885', (0, 0, 0)),
                                        part('3022', (0, 20, -18), rotation)], REGULAR)


def test_touching_solid_faces_are_allowed_but_penetration_is_not():
    a = material.box((0, 0, 0), (1, 1, 1))
    assert not material.intersects(a, material.box((1, 0, 0), (2, 1, 1)))
    assert material.intersects(a, material.box((.5, 0, 0), (2, 1, 1)))


def test_nonrigid_supported_parts_fail_closed():
    with pytest.raises(ValueError, match='unscaled'):
        material.review_material([part('27925', (0, 0, 0), I * 2)], REGULAR)


def test_six_decimal_starburst_rotation_keeps_collision_review():
    rotation = np.array([[.469472, 0, -.882948], [0, 1, 0], [.882948, 0, .469472]])
    piece = part('3022', (0, 0, 0), rotation)
    assert not material.review_material([piece], REGULAR)
    assert material.review_material([piece, piece], REGULAR)[0]['code'] == 'assembly.material_overlap'


@pytest.mark.parametrize('matrix', [I * 1.00001, np.array([[1, .00001, 0], [0, 1, 0], [0, 0, 1]])])
def test_rounding_tolerance_still_rejects_scaling_and_shear(matrix):
    with pytest.raises(ValueError, match='unscaled'):
        material.review_material([part('3022', (0, 0, 0), matrix)], REGULAR)


def test_11211_side_studs_cannot_enter_a_plate_wall():
    assert material.review_material([part('11211', (0, 0, 0)), part('3022', (0, 8, -30))], REGULAR)


@pytest.mark.parametrize('rotation', [I, RY90])
def test_griffin_seats_walls_and_dishes_report_every_conflicting_pair(rotation):
    back = RY90 @ RY90
    dish = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]])
    placements = [
        ('4079', (-20, -408, 0), I), ('4079', (20, -408, 0), I),
        ('4079', (0, -416, 40), I),
        ('4079', (-80, -416, 80), back), ('4079', (-40, -416, 80), back),
        ('4079', (40, -416, 80), back), ('4079', (80, -416, 80), back),
        ('4079', (-60, -416, 40), RY90), ('4079', (60, -416, 40), RY90.T),
        ('3004', (-90, -432, 40), RY90), ('3004', (90, -432, 40), RY90),
        ('3023b', (-90, -440, 40), RY90), ('3023b', (90, -440, 40), RY90),
        ('98138', (-90, -448, 50), I), ('98138', (90, -448, 50), I),
        ('3960', (50, -526, -96), dish), ('4740', (0, -512, -100), I),
        ('3960', (-50, -526, -96), dish),
    ]
    profiles = {**REGULAR, '3004': {'x_studs': 2, 'z_studs': 1, 'height': 24},
                '3023b': {'x_studs': 2, 'z_studs': 1, 'height': 8}}
    pieces = [part(code, rotation @ pos, rotation @ matrix) for code, pos, matrix in placements]
    report = material.review_material(pieces, profiles)
    assert {tuple(sorted(hit['instances'])) for hit in report} == {
        (0, 2), (1, 2), (0, 7), (4, 7), (1, 8), (5, 8),
        (3, 9), (6, 10), (3, 11), (6, 12), (3, 13), (6, 14), (15, 16), (16, 17),
    }


def test_seats_side_by_side_on_a_plate_have_clearance():
    pieces = [part('3022', (0, 0, 0)), part('4079', (0, -8, 0)),
              part('4079', (40, -8, 0))]
    assert not material.review_material(pieces, REGULAR)


def test_perpendicular_dishes_with_rim_clearance_pass():
    side = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]])
    pieces = [part('3960', (-50, -526, -96), side), part('4740', (0, -512, -104))]
    assert not material.review_material(pieces, REGULAR)
