import pytest
from fable_agent.kit import KitError, yaw_matrix

from fable_agent_support import World


def kinds(issues):
    return [issue.kind for issue in issues]


def test_a_bonded_stack_on_a_base_passes(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.fill([(x, z) for x in range(4) for z in range(2)], 0, "Green", kind="plate")
    kit.place("3001", "Red", 0, 1, 0)
    kit.place("3001", "Red", 0, 4, 0)
    report = world.checker.check(kit.build)
    assert report.ok and not report.warnings
    assert report.parts == 3 and report.size == (4, 7, 2)
    assert report.estimated_parts_cost == "0.15"
    assert report.to_dict()["physical_validity"] == "not_proven"


def test_parts_in_the_same_space_are_reported_with_their_location(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.module("walls")
    kit.place("3001", "Red", 0, 0, 0)
    kit.place("3004", "White", 1, 1, 0)  # one plate up: inside the brick
    report = world.checker.check(kit.build)
    assert kinds(report.errors) == ["overlap"]
    assert "x=1 y=1 z=0 [walls]" in report.errors[0].message
    assert "BUILD HAS ERRORS" in report.to_text()


def test_touching_parts_and_stud_engagement_are_not_overlaps(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3001", 4, 0, 0, 0)
    kit.place("3001", 4, 4, 0, 0)  # side by side
    kit.place("3001", 4, 2, 3, 0)  # on top, bridging the seam
    assert world.checker.check(kit.build).ok


def test_declared_nesting_is_allowed_and_noted(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    outer = kit.place("3001", 4, 0, 0, 0)
    inner = kit.place("3005", 15, 1, 1, 0, allow_overlap=True)
    kit.connect(outer, inner, "pane in frame")
    report = world.checker.check(kit.build)
    assert report.ok
    assert any("declared intentional" in note for note in report.notes)
    assert any("connect()" in note for note in report.notes)


def test_inset_seats_a_pane_in_its_frame_without_an_overlap_error(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    frame = kit.place("3659", "White", 0, 0, 0, rot=90)
    pane = kit.inset("3023", "Red", frame)
    seated, host = kit.build.placements[pane], kit.build.placements[frame]
    assert seated.matrix == host.matrix
    # Centred in the frame's height: an 8 LDU plate inside a 24 LDU frame sits 8 LDU down from its top.
    assert seated.position == (host.position[0], host.position[1] + 8, host.position[2])
    assert world.checker.check(kit.build).ok
    with pytest.raises(KitError):
        kit.inset("3023", "Red", 99)


def test_unattached_parts_are_errors(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3001", 4, 0, 0, 0)
    kit.module("balcony")
    kit.place("3004", 15, 0, 9, 0)  # hovering above
    report = world.checker.check(kit.build)
    assert kinds(report.errors) == ["floating"]
    assert "[balcony]" in report.errors[0].message


def test_nothing_attaches_on_top_of_a_tile(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3070b", 4, 0, 0, 0)
    kit.place("3005", 4, 0, 1, 0)
    assert kinds(world.checker.check(kit.build).errors) == ["floating"]


def test_side_by_side_bricks_are_separate_until_something_bridges_them(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3001", 4, 0, 0, 0)
    kit.place("3001", 4, 4, 0, 0)
    report = world.checker.check(kit.build)
    assert report.ok and kinds(report.warnings) == ["separate"]


def test_an_open_arch_span_can_hold_a_part_and_bridges_its_legs(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.fill([(x, 0) for x in range(4)], 0, "Green", kind="plate")
    kit.place("3005", 4, 0, 1, 0)
    kit.place("3005", 4, 3, 1, 0)
    kit.place("3023", 15, 1, 1, 0)  # sits in the opening under the span
    kit.place("3659", 4, 0, 4, 0)
    assert world.checker.check(kit.build).ok


def test_unavailable_colors_name_the_alternatives(tmp_path):
    world = World(tmp_path, skip={("3001", 4)})
    kit = world.kit()
    kit.place("3001", "Red", 0, 0, 0)
    report = world.checker.check(kit.build)
    assert kinds(report.errors) == ["palette"]
    assert "available colors" in report.errors[0].message and "Sand_Blue" in report.errors[0].message
    assert report.estimated_parts_cost is None


def test_the_part_limit_and_empty_builds_are_errors(tmp_path):
    world = World(tmp_path, max_parts=2)
    kit = world.kit()
    assert kinds(world.checker.check(kit.build).errors) == ["empty"]
    kit.fill([(x, 0) for x in range(3)], 0, 4, kind="tile")
    assert "limit" in kinds(world.checker.check(kit.build).errors)


def test_free_rotations_are_reported_as_unchecked_rather_than_passed(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3001", 4, 0, 0, 0)
    kit.place_ldu("3001", 4, (40, 0, 20), [yaw_matrix(30)[0:3], yaw_matrix(30)[3:6], yaw_matrix(30)[6:9]])
    report = world.checker.check(kit.build)
    assert any("free rotation" in note for note in report.notes)
    assert "overlap" not in kinds(report.errors)


def test_many_overlaps_are_summarized_by_module(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    for index in range(12):
        kit.module("a")
        kit.place("3005", 4, index, 0, 0)
        kit.module("b")
        kit.place("3005", 15, index, 0, 0)
    report = world.checker.check(kit.build)
    assert len([i for i in report.errors if i.kind == "overlap"]) == 9
    assert "a / b" in report.errors[8].message
