"""Joints from connector data, Technic seating and the wheel review of the v2 methods."""

import importlib.util
from pathlib import Path

import numpy as np
import pytest

from fable_agent.kit import Build, Placement
from fable_agent.ldraw import default_library_dir

IDENTITY = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
X_ONTO_Z = (0.0, 0.0, -1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0)  # turns a part's x axis onto z
real_parts = pytest.mark.skipif(
    not (default_library_dir() / "LDConfig.ldr").is_file() or importlib.util.find_spec("ldraw") is None,
    reason="needs an LDraw parts library and pyldraw3")


def placed(part, position=(0.0, 0.0, 0.0), matrix=IDENTITY):
    return Placement(part, 7, position, matrix)


@pytest.fixture(scope="module")
def bench():
    from fable_agent.app import Workbench
    return Workbench.open({"ldraw_dir": None, "catalog_path": None, "open_palette": True, "max_parts": 500,
                           "assembly_rules": True})


@pytest.fixture(scope="module")
def review(bench):
    from fable_agent.connectors import ConnectorLibrary, ConnectorReview
    from fable_agent.shape import default_cache_dir
    return ConnectorReview(ConnectorLibrary(bench.library.root, default_cache_dir()))


def kinds(issues):
    return [issue.kind for issue in issues]


# ----- what fits what ----------------------------------------------------------

@real_parts
def test_a_tyre_is_joined_to_the_rim_made_for_it_and_refused_on_another(review, bench):
    right = review.review([placed("4624"), placed("3641")])
    assert right.joints == {(0, 1)} and not right.unseated()
    wrong = review.review([placed("4624"), placed("6015")])
    assert not wrong.joints
    # The right tyre beside its seat is told how far to move, and one turned off the rim's axis to turn.
    aside = review.review([placed("4624"), placed("3641", (0, 6, 0))])
    assert "move it by (+0.0, -6.0, +0.0) LDU" in aside.misfit(0, 1)
    turned = review.review([placed("4624"), placed("3641", (0, 0, 0), X_ONTO_Z)])
    assert "not turned the same way" in turned.misfit(0, 1)
    assert [(a, b) for a, b, _ in wrong.unseated()] == [(0, 1)]
    assert "fit" not in kinds(bench.checker.check(Build([placed("4624"), placed("3641")])).errors)
    report = bench.checker.check(Build([placed("4624"), placed("6015")]))
    assert "fit" in kinds(report.errors) and "does not fit" in report.to_text()


@real_parts
def test_a_pane_is_joined_to_its_own_frame_and_refused_in_another(review, bench):
    from fable_agent.seats import seat
    assert review.review([placed("60592"), placed("60601", seat("60592", "60601"))]).joints == {(0, 1)}
    wrong = review.review([placed("60596"), placed("60601")])  # a 1 x 2 x 2 pane in a door frame
    assert not wrong.joints and [(a, b) for a, b, _ in wrong.unseated()] == [(0, 1)]
    assert "fit" in kinds(bench.checker.check(Build([placed("60596"), placed("60601")])).errors)


@real_parts
def test_a_declared_joint_between_parts_that_do_not_fit_is_an_error(bench):
    build = Build([placed("60596"), placed("60601", (0.0, -200.0, 0.0))], [(0, 1, "pane in its frame")])
    report = bench.checker.check(build)
    assert any(issue.kind == "joint" and "do not" in issue.message for issue in report.errors)


@real_parts
def test_inset_puts_a_nested_part_on_the_seat_the_data_gives(bench, review):
    from fable_agent.kit import Kit
    from fable_agent.seats import seat
    assert seat("51239", "51266") == (0.0, 4.25, 5.0)
    assert seat("3001", "3002") is None  # two bricks have no seat for each other
    for frame, pane in (("60592", "60601"), ("51239", "51266"), ("2493b", "2494")):
        kit = Kit(bench.library, bench.shapes, bench.palette, bench.finder)
        host = kit.place(frame, "White", 0, 0, 0)
        kit.inset(pane, "Trans_Clear", host)
        assert review.review(kit.build.placements).joints == {(0, 1)}, (frame, pane)


@real_parts
def test_every_window_and_door_the_helpers_build_seats_its_pane(bench, review):
    from fable_agent.helpers import HELPERS, bind
    from fable_agent.kit import Kit, KitError
    for helper in ("window", "door"):
        for style in HELPERS[helper].styles:
            kit = Kit(bench.library, bench.shapes, bench.palette, bench.finder)
            try:
                bind(kit)[helper](0, 0, 0, style=style)
            except (KitError, TypeError):
                continue
            found = review.review(kit.build.placements)
            assert not found.unseated(), (helper, style, found.unseated())


@real_parts
def test_the_quick_inspection_finds_the_joints_a_full_inspection_finds(review):
    from ldraw import inspect_model, parse_model_result
    from ldraw.connection_types import ConnectionKind as Kind
    from fable_agent.toolkit.connection_adapter import connection_contacts
    from fable_agent.toolkit.technic import curate
    placements = [placed("3700"), placed("3700", (0, 0, 20)), placed("2780", (0, 10, 10), X_ONTO_Z),
                  placed("4624", (100, 0, 0)), placed("3641", (100, 0, 0)), placed("60592", (200, 0, 0)),
                  placed("60601", (200, -0.5, 0)), placed("3001", (300, 0, 0)), placed("3001", (300, -24, 0))]
    text = "\n".join(f"1 7 {' '.join(str(v) for v in (*p.position, *p.matrix))} {p.part}.dat" for p in placements)
    parts = review._library.parts
    full = curate(inspect_model(parse_model_result(text, name="m.ldr", source="m.ldr", parts=parts).model, parts))
    studs = (Kind.STUD, Kind.STUD_RECEPTACLE)
    expected = {tuple(sorted((c.first_occurrence.index, c.second_occurrence.index)))
                for c in connection_contacts(full) if c.first.kind not in studs and c.second.kind not in studs}
    assert review.review(placements).joints == expected == {(0, 2), (1, 2), (3, 4), (5, 6)}


def test_a_build_is_still_checked_when_the_connector_data_cannot_be_read(tmp_path):
    from fable_agent.connectors import ConnectorLibrary, ConnectorReview
    found = ConnectorReview(ConnectorLibrary(tmp_path / "no-library", tmp_path)).review([placed("3001")])
    assert not found.joints and "LDraw library missing" in found.skipped and found.misfit(0, 0) is None


# ----- Technic -------------------------------------------------------------------

@real_parts
def test_a_technic_pin_joins_two_bricks_only_when_it_is_seated_in_their_holes(review, bench):
    bricks = [placed("3700"), placed("3700", (0, 0, 20))]
    seated = review.review([*bricks, placed("2780", (0, 10, 10), X_ONTO_Z)])
    assert seated.joints == {(0, 2), (1, 2)} and not [item for item in seated.technic if item.error]
    shifted = review.review([*bricks, placed("2780", (0, 10, 14), X_ONTO_Z)])
    assert not shifted.joints
    assert {item.code for item in shifted.technic if item.error} == {"technic.invalid_seating"}
    report = bench.checker.check(Build([*bricks, placed("2780", (0, 10, 14), X_ONTO_Z)]))
    assert "technic" in kinds(report.errors)


def recognised(review, *codes) -> bool:
    """Whether this parts library has the exact geometry the registry measured these parts on."""
    from fable_agent.toolkit.technic import definition
    return all(definition(review._library.parts.geometry(code)) is not None for code in codes)


@real_parts
def test_an_axle_too_short_for_its_hole_is_reported_with_the_length_it_needs(review):
    if not recognised(review, "3700", "32062"):
        pytest.skip("this parts library is not the release the Technic axles were measured on")
    centred = review.review([placed("3700"), placed("32062", (0, 10, 10), X_ONTO_Z)])
    assert centred.joints == {(0, 1)} and not [item for item in centred.technic if item.error]
    assert {item.code for item in centred.technic} == {"technic.axial_retention", "technic.bearing_rotation"}
    # Pushed 4 LDU along: the 2-long shaft no longer reaches through the brick.
    found = review.review([placed("3700"), placed("32062", (0, 10, 14), X_ONTO_Z)])
    seating = [item for item in found.technic if item.code == "technic.invalid_seating"]
    assert not found.joints and seating and "needs at least 48" in seating[0].message


@real_parts
def test_what_sits_along_a_measured_axle_is_recorded_for_the_building_order(review):
    if not recognised(review, "3700", "3705"):
        pytest.skip("this parts library is not the release the Technic axles were measured on")
    # A 4-long axle through two Technic bricks 40 LDU apart, with a wheel between them.
    placements = [placed("3705", (0, 10, 40), X_ONTO_Z), placed("3700", (0, 0, 10)), placed("3700", (0, 0, 50)),
                  placed("4624", (0, 10, 40), IDENTITY)]
    found = review.review(placements)
    assert {(0, 1), (0, 2)} <= found.joints
    stations = {part: round(station) for station, part in found.shafts[0]}
    assert stations[1] < stations[2] and set(stations) >= {1, 2}


@real_parts
def test_a_build_with_too_many_technic_parts_is_told_its_seating_was_not_reviewed(review, monkeypatch):
    from fable_agent import connectors
    monkeypatch.setattr(connectors, "TECHNIC_LIMIT", 2)
    found = review.review([placed("3700"), placed("3700", (0, 0, 20)), placed("2780", (0, 10, 14), X_ONTO_Z)])
    assert found.technic_unchecked == 3 and not found.technic


@real_parts
def test_technic_parts_this_library_does_not_match_are_counted_not_guessed(review):
    found = review.review([placed("3700"), placed("32062", (0, 10, 10), X_ONTO_Z)])
    assert found.unreviewed == (0 if recognised(review, "3700", "32062") else 1)


@real_parts
def test_the_measured_technic_parts_are_recognised_in_this_parts_library(review):
    """The registry is keyed to each part's exact geometry; a fingerprint that fails on this
    platform would silently turn its checks off."""
    from fable_agent.toolkit.technic import definition, registry
    parts = review._library.parts
    present = [code for code in registry()["parts"] if parts.find_part(code=code) is not None]
    unknown = [code for code in present if definition(parts.geometry(code)) is None]
    assert len(present) >= 40
    # The beams, bricks and pins have not changed in years; an axle or bush may differ in an older library.
    assert not {"3700", "3701", "32523", "32316", "2780", "3673", "6558"} & set(unknown)
    if unknown:
        pytest.skip(f"{len(unknown)} of {len(present)} measured parts are another release in this parts library: "
                    f"{', '.join(unknown)}. Their Technic checks are off here and say so in each report.")


# ----- studs the connector data taught Nova, which Pip measures by shape ---------

@real_parts
def test_wing_plates_stack_on_a_single_stud_at_any_angle(bench):
    angle = np.radians(17)
    turn = np.array([[np.cos(angle), 0, np.sin(angle)], [0, 1, 0], [-np.sin(angle), 0, np.cos(angle)]])
    origin = turn @ np.array([10.0, 0.0, -10.0])
    matrix = tuple(float(v) for v in turn.ravel())
    build = Build([placed("3024"), placed("65429", tuple(origin + [0, -8, 0]), matrix),
                   placed("65429", tuple(origin + [0, -16, 0]), matrix)])
    report = bench.checker.check(build)
    assert "floating" not in kinds(report.errors) and "separate" not in kinds(report.errors)


# ----- wheels as running gear ---------------------------------------------------

def wheel(instance, x, z, *, bottom=0.0, radius=15.0):
    from fable_agent.toolkit.vehicle_review import Wheel
    return Wheel(instance, (x, bottom - radius, z), (1.0, 0.0, 0.0), radius, 14.0)


needs_toolkit = pytest.mark.skipif(importlib.util.find_spec("ldraw") is None, reason="needs pyldraw3")


@needs_toolkit
def test_four_wheels_on_one_road_in_mirrored_pairs_raise_nothing():
    from fable_agent.toolkit.vehicle_review import review_wheels
    car = [wheel(0, -30, 0), wheel(1, 30, 0), wheel(2, -30, 100), wheel(3, 30, 100)]
    base = [(9, 0.0, 8.0)]  # a plate wholly under the road plane: what the car stands on
    assert review_wheels(car, base) == []
    assert review_wheels([wheel(0, 0, 0), wheel(1, 0, 60)]) == []  # a motorcycle: one wheel per station


@needs_toolkit
def test_a_wheel_off_the_road_an_odd_axle_and_bodywork_below_the_tyres_are_reported():
    from fable_agent.toolkit.vehicle_review import review_wheels
    car = [wheel(0, -30, 0), wheel(1, 30, 0), wheel(2, -30, 100), wheel(3, 30, 100, bottom=-8.0)]
    assert {d["code"] for d in review_wheels(car)} == {"vehicle.ground_contact", "vehicle.axle_symmetry"}
    three = [wheel(0, -30, 0), wheel(1, 30, 0), wheel(2, -30, 100)]
    assert "vehicle.axle_pair" in {d["code"] for d in review_wheels(three)}
    square = [wheel(0, -30, 0), wheel(1, 30, 0), wheel(2, -30, 100), wheel(3, 30, 100)]
    low = review_wheels(square, [(7, -20.0, 6.0)])  # crosses the road plane
    assert [(d["code"], d["instances"]) for d in low] == [("vehicle.below_road", [7])]
    lopsided = [wheel(0, -30, 0), wheel(1, 40, 0), wheel(2, -30, 100), wheel(3, 30, 100)]
    assert "vehicle.axle_symmetry" in {d["code"] for d in review_wheels(lopsided)}


@real_parts
def test_wheel_findings_are_warnings_on_a_build_and_name_the_parts(bench):
    from fable_agent.vehicle import WheelReview
    side = (0.0, 0.0, 1.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0)
    tyres = [placed("3641", (x, y, z), side) for x, y, z in ((-30, 0, 0), (30, 0, 0), (-30, 0, 100), (30, -8, 100))]
    found = WheelReview(bench.library).review(tyres, {}, set(), lambda index: f"#{index}")
    assert {item.code for item in found} == {"vehicle.ground_contact", "vehicle.axle_symmetry"}
    assert all("#" in item.message for item in found)
    report = bench.checker.check(Build(tyres))
    assert "vehicle" in kinds(report.warnings) and "vehicle" not in kinds(report.errors)
    # A spare lying flat on the other four is not on their axis, and is not reported.
    square = [placed("3641", (x, 0, z), side) for x, z in ((-30, 0), (30, 0), (-30, 100), (30, 100))]
    assert WheelReview(bench.library).review([*square, placed("3641", (0, -60, 50))], {}, set(), str) == []
