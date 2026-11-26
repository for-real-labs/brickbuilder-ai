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
def test_technic_parts_this_library_does_not_match_are_counted_not_guessed(review, monkeypatch):
    from fable_agent.toolkit import technic
    assert review.review([placed("3700"), placed("32062", (0, 10, 10), X_ONTO_Z)]).unreviewed == 0
    monkeypatch.setattr(technic, "definition", lambda local: None)
    assert review.review([placed("3700"), placed("32062", (0, 10, 10), X_ONTO_Z)]).unreviewed == 2


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


# ----- what the request is about decides how strict the vehicle review is -------------------

@pytest.mark.parametrize(("request_text", "kind"), [
    ("A red pickup truck on a road base", "road"), ("An orange off-road jeep", "road"),
    ("A truck carrying a boat", "road"), ("A tugboat", "boat"), ("A seaplane on the water", "aircraft"),
    ("A fighter jet", "aircraft"), ("A vintage motorcycle", "motorcycle"),
    ("A lake house with a small dock", None), ("Fire fighters at a station", None), ("A fish tank", None),
    ("", None), (None, None),
])
def test_the_kind_of_vehicle_is_read_from_the_request(request_text, kind):
    from fable_agent.vehicle import vehicle_kind
    assert vehicle_kind(request_text) == kind


@real_parts
def test_wheel_problems_are_errors_only_when_the_request_is_a_wheeled_vehicle(bench):
    from fable_agent.vehicle import WheelReview
    side = (0.0, 0.0, 1.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0)
    lifted = [placed("3641", (x, y, z), side) for x, y, z in ((-30, 0, 0), (30, 0, 0), (-30, 0, 100), (30, -8, 100))]
    review = WheelReview(bench.library)
    as_car = {item.code: item.error for item in review.review(lifted, {}, set(), str, "road")}
    assert as_car["vehicle.ground_contact"] is True and as_car["vehicle.axle_symmetry"] is False
    assert not any(item.error for item in review.review(lifted, {}, set(), str, None))


@real_parts
def test_a_part_inside_the_space_a_tyre_turns_in_is_reported_and_one_above_it_is_not(bench):
    from fable_agent.checks import world_boxes
    from fable_agent.vehicle import WheelReview
    side = (0.0, 0.0, 1.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0)
    tyre = placed("3641", (0, -18, 0), side)  # radius 18: it reaches from y=0 up to y=-36
    review = WheelReview(bench.library)
    for height, reported in ((-30, True), (-40, False)):  # a 1 x 2 plate's underside at that height
        plate = placed("3023", (0, height - 8, 0), side)
        boxes = {1: world_boxes(bench.shapes.get("3023"), plate)}
        found = review.review([tyre, plate], boxes, set(), str, "road")
        assert ("vehicle.wheel_space" in {item.code for item in found}) is reported, height
    # The road it stands on is not in its way, and a spare lying on its side is not checked at all.
    road = placed("3020", (0, 8, 0))
    found = review.review([tyre, road], {1: world_boxes(bench.shapes.get("3020"), road)}, set(), str, "road")
    assert "vehicle.wheel_space" not in {item.code for item in found}
    flat = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, -1.0, 0.0)  # turns the tyre's axis upright
    spare = placed("3641", (0, -18, 0), flat)
    plate = placed("3023", (0, -16, 0), side)  # inside the circle it would turn in, were it a wheel
    found = review.review([spare, plate], {1: world_boxes(bench.shapes.get("3023"), plate)}, set(), str, "road")
    assert "vehicle.wheel_space" not in {item.code for item in found}


@real_parts
def test_a_plane_whose_wing_is_missing_on_one_side_is_reported_and_a_mirrored_one_is_not(bench):
    from fable_agent.checks import world_boxes
    from fable_agent.vehicle import WheelReview
    def boxes_of(parts):
        return {i: world_boxes(bench.shapes.get(p.part), p) for i, p in enumerate(parts)}
    lift = -48  # on a stand: what is within three plates of the ground is its base, not its shape
    body = [placed("3001", (0, lift - 24, z)) for z in (-80, -40, 0, 40)]  # a fuselage along z, longer in front
    body.append(placed("3022", (0, lift - 32, -120)))  # and a nose: the plane is not the same front and back
    wings = [placed("3001", (x, lift - 24, 0)) for x in (-40, -80, 40, 80)]
    base = [placed("3020", (-60, -8, 0)), placed("3001", (0, -48, 0))]  # off-centre base and a pillar
    review = WheelReview(bench.library)
    whole = [*base, *body, *wings]
    assert review.review(whole, boxes_of(whole), set(), str, "aircraft") == []
    one_sided = [*base, *body, *wings[:2]]
    found = review.review(one_sided, boxes_of(one_sided), set(), str, "aircraft")
    assert [item.code for item in found] == ["vehicle.symmetry"] and not found[0].error
    assert review.review(one_sided, boxes_of(one_sided), set(), str, None) == []  # not a plane: not checked


@real_parts
def test_saved_truck_rims_are_outside_the_bricks_even_when_connector_anchors_coincide(bench):
    # In the original truck the old rim anchor was at the same station as the adjacent brick.
    parts = [placed("3707", (60, -54, 200)),
             placed("56904", (-10, -54, 200), X_ONTO_Z),
             placed("56904", (130, -54, 200), (0, 0, 1, 0, 1, 0, -1, 0, 0)),
             placed("32064a", (10, -64, 200), (0, 0, 1, 0, 1, 0, -1, 0, 0)),
             placed("32064a", (110, -64, 200), (0, 0, 1, 0, 1, 0, -1, 0, 0))]
    measured = bench.checker._assembly.measure(parts)
    stations = {part: at for at, part in measured.connectors.shafts[0]}
    assert stations[1] < stations[3] < stations[4] < stations[2]
