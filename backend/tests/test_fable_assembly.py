"""Nova's publication rules on a Fable build: solid plastic, declared joints and the building order."""

import random

import pytest
from fable_agent.joints import JointReview
from fable_agent.kit import BUILD_TOGETHER, to_ldraw
from fable_agent.ldraw import default_library_dir
from fable_agent.material import MaterialReview
from fable_agent.nova_rules import RULES_DIR, nova_rules, occurrence
from fable_agent.sequence import NoSequence, SequencePlanner

from fable_agent_support import TECHNIC_PARTS, World

QUARTER = (0.0, 0.0, 1.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0)  # turns a part's x axis onto z


def kinds(issues):
    return [issue.kind for issue in issues]


def base(kit, width=8, depth=2):  # two studs deep: the stand-in plates bond along x only
    kit.fill([(x, z) for x in range(width) for z in range(depth)], 0, "Green", kind="plate", layers=2)


# ----- one copy of the rules ------------------------------------------------


def test_the_rules_are_novas_own_files_not_a_copy():
    rules = nova_rules()
    assert rules.sequence.__file__ == str(RULES_DIR / "flatten.py") and rules.sequence.MAX_PARTS_PER_STEP == 5
    assert rules.material.__file__ == str(RULES_DIR / "material_collision.py")
    assert rules.surfaces.EXPOSED_PARTS >= {"4079", "3960", "4740"}
    assert nova_rules() is rules


def test_a_placement_reads_as_a_nova_occurrence(tmp_path):
    kit = World(tmp_path).kit()
    kit.place("3001", "Red", 2, 3, 1, rot=90)
    part = occurrence(kit.build.placements[0])
    assert part.part_code == "3001" and (part.position.x, part.position.y) == kit.build.placements[0].position[:2]
    assert part.matrix.rows[1] == (0.0, 1.0, 0.0) and len(part.matrix.rows) == 3


# ----- solid plastic --------------------------------------------------------


def test_an_overlap_declared_intended_is_still_an_error_when_solid_plastic_meets(tmp_path):
    for assembly, expected in ((False, []), (True, ["material"])):
        world = World(tmp_path / str(assembly), assembly=assembly)
        kit = world.kit()
        base(kit)
        kit.place("3001", "Red", 0, 2, 0)
        kit.place("3001", "White", 1, 2, 0, allow_overlap=True)  # the same row, one stud along
        report = world.checker.check(kit.build)
        assert kinds(report.errors) == expected
    assert "allow_overlap does not cover this" in report.errors[0].message
    assert "3001 Red at x=0 y=2 z=0" in report.errors[0].message and report.plan is None


def test_a_part_turned_off_the_grid_is_checked_for_solid_plastic(tmp_path):
    world = World(tmp_path, assembly=True)
    kit = world.kit()
    base(kit)
    kit.place("3001", "Red", 0, 2, 0)
    kit.place("3020", "White", 1, 2, 0, rot=30)  # the ordinary overlap check skips free rotations
    report = world.checker.check(kit.build)
    assert "material" in kinds(report.errors)
    assert any("free rotation" in note for note in report.notes)


def test_parts_that_stack_or_sit_side_by_side_are_not_collisions(tmp_path):
    world = World(tmp_path, assembly=True)
    kit = world.kit()
    base(kit)
    for x in (0, 4):
        kit.place("3001", "Red", x, 2, 0)
    kit.place("3001", "White", 2, 5, 0)  # bridges the two
    kit.place("3070b", "Black", 2, 8, 0)
    report = world.checker.check(kit.build)
    assert report.ok and not report.warnings


def test_only_plain_boxes_are_given_solid_walls_and_a_tile_keeps_its_groove(tmp_path):
    world = World(tmp_path)
    profiles = MaterialReview(world.library, world.shapes)._profiles
    assert profiles.get("3001") == {"x_studs": 4, "z_studs": 2, "height": 24}
    assert profiles.get("3020") == {"x_studs": 4, "z_studs": 2, "height": 8}
    assert profiles.get("3070b")["height"] == 6  # walls stop above the groove cut under a tile
    assert profiles.get("3039") is None and profiles.get("3659") is None and profiles.get("missing") is None


def test_the_review_finds_the_same_pairs_as_novas_own_sweep(tmp_path):
    world = World(tmp_path)
    review = MaterialReview(world.library, world.shapes)
    rules = nova_rules().material
    chooser = random.Random(7)
    for _ in range(6):
        kit = world.kit()
        for _ in range(40):
            kit.place(chooser.choice(["3001", "3020", "3004", "3022"]), "Red", chooser.randrange(8),
                      chooser.randrange(6), chooser.randrange(8), rot=chooser.choice([0, 90, 30]), allow_overlap=True)
        placements = kit.build.placements
        expected = {tuple(sorted(hit["instances"]))
                    for hit in rules.review_material([occurrence(p) for p in placements], review._profiles)}
        found = {tuple(sorted(pair)) for pair in review.collisions(placements)}
        assert expected and (found == expected or len(expected) >= rules.MAX_REPORTED_PAIRS and len(found) == len(expected))


# ----- declared joints ------------------------------------------------------


def test_a_declared_joint_between_parts_that_do_not_touch_is_an_error(tmp_path):
    for assembly in (False, True):
        world = World(tmp_path / str(assembly), assembly=assembly)
        kit = world.kit()
        base(kit)
        post = kit.place("3005", "Red", 0, 2, 0)
        sign = kit.place("3022", "White", 4, 9, 0)  # in the air, four studs away
        kit.connect(post, sign, "sign hangs on the post")
        report = world.checker.check(kit.build)
        assert report.ok is not assembly  # taken on trust before; now it needs evidence
    assert kinds(report.errors) == ["joint"] and "do not touch" in report.errors[0].message
    assert "sign hangs on the post" in report.errors[0].message


def pinned(tmp_path, lift=0.0):
    world = World(tmp_path, extra=TECHNIC_PARTS, assembly=True)
    kit = world.kit()
    base(kit)
    brick = kit.place("3700", "Red", 0, 2, 0)
    x, y, z = kit.build.placements[brick].position
    pin = kit.place_ldu("3673", "Black", (x, y + 10 - lift, z), QUARTER, allow_overlap=True)
    kit.connect(brick, pin, "pin in the brick")
    return world.checker.check(kit.build)


def test_a_technic_pin_must_lie_in_a_hole_of_the_part_it_is_joined_to(tmp_path):
    seated = pinned(tmp_path / "in")
    assert seated.ok and any("1 pins or axles found in their holes, 0 others" in note for note in seated.notes)
    beside = pinned(tmp_path / "off", lift=6)  # still touching the brick, but above the hole
    assert kinds(beside.errors) == ["joint"] and "in none of the other part's holes" in beside.errors[0].message


def test_a_joint_the_library_cannot_name_is_checked_for_touching_and_counted(tmp_path):
    world = World(tmp_path, assembly=True)
    kit = world.kit()
    base(kit)
    wall = kit.place("3001", "Red", 0, 2, 0)
    lamp = kit.place("3005", "White", 4, 2, 0)  # beside the wall, on the base
    kit.connect(wall, lamp, "clipped to the wall")
    report = world.checker.check(kit.build)
    assert report.ok and any("1 declared joints: 0 pins or axles found in their holes, 1 others checked only "
                             "for touching" in note for note in report.notes)


@pytest.mark.skipif(not (default_library_dir() / "LDConfig.ldr").is_file(), reason="needs an LDraw parts library")
def test_real_pins_axles_and_holes_are_read_from_the_parts_library():
    from fable_agent.ldraw import LDrawLibrary
    library = LDrawLibrary()
    assert {port.kind for port in library.ports("3673")} == {"pin"}
    assert {port.kind for port in library.ports("43093")} == {"pin", "axle"}
    assert [port.kind for port in library.ports("3700")] == ["pin_hole", "pin_hole"]
    assert library.ports("3001") == () and library.ports("32062") == ()  # an axle's profile is not a hole
    assert len(library.surface("3001")) > len(library.geometry("3001").triangles)  # studs included


# ----- building order -------------------------------------------------------


def wall(world):
    kit = world.kit()
    base(kit, 8, 2)
    kit.module("wall")
    for course in range(4):
        kit.fill([(x, z) for x in range(8) for z in range(2)], 2 + 3 * course, "Red")
    return kit.build


def test_instructions_are_steps_of_at_most_five_connected_pieces_from_the_ground_up(tmp_path):
    world = World(tmp_path, assembly=True)
    build = wall(world)
    report = world.checker.check(build)
    plan = report.plan
    assert report.ok and sorted(plan.order) == list(range(len(build.placements)))
    sizes = [plan.steps.count(step) for step in range(1, plan.step_count + 1)]
    assert max(sizes) <= 5 and min(sizes) >= 1 and plan.steps == tuple(sorted(plan.steps))
    heights = [-build.placements[index].position[1] for index in plan.order]
    assert heights == sorted(heights)  # LDraw's y points down: lowest pieces first
    # Each step is one height of one module, so a step never mixes courses.
    for step in range(1, plan.step_count + 1):
        assert len({build.placements[i].position[1] for i, s in zip(plan.order, plan.steps) if s == step}) == 1
    assert any(f"{plan.step_count} steps of at most 5" in note for note in report.notes)
    assert report.to_dict()["instruction_steps"] == plan.step_count
    text = to_ldraw(build, "Wall", plan)
    assert text.count("0 STEP") == plan.step_count
    assert [line.split()[-1] for line in text.splitlines() if line.startswith("1 ")] == [
        f"{build.placements[index].part}.dat" for index in plan.order]


def test_every_piece_is_added_to_something_already_built(tmp_path):
    world = World(tmp_path, assembly=True)
    build = wall(world)
    report = world.checker.check(build)
    # An independent look at the plan: rebuild the stud contacts and walk the order.
    from fable_agent.checks import hash_boxes, stud_contacts, world_boxes
    boxes = {i: world_boxes(world.shapes.get(p.part), p) for i, p in enumerate(build.placements)}
    joined = {frozenset((c.stud, c.receiver)) for c in stud_contacts(build.placements, world.shapes, boxes,
                                                                    hash_boxes(boxes))}
    ground = max(box[4] for own in boxes.values() for box in own)
    built = set()
    for index in report.plan.order:
        on_ground = any(box[4] >= ground - 0.5 for box in boxes[index])
        assert on_ground or any(frozenset((index, other)) in joined for other in built)
        built.add(index)


def test_a_piece_that_hangs_under_its_support_is_built_together_with_it(tmp_path):
    world = World(tmp_path, assembly=True)
    kit = world.kit()
    base(kit, 4, 2)
    kit.place("3004", "Red", 0, 2, 0)                 # a post
    beam = kit.place("3020", "White", 0, 5, 0)        # a plate on the post, reaching out over the base
    hanging = kit.place("3024", "Black", 3, 4, 0)     # held only by the beam above it
    report = world.checker.check(kit.build)
    assert report.ok
    plan = report.plan
    start = plan.order.index(beam)
    assert start in plan.together and plan.order[start + 1] == hanging
    assert plan.steps[start] == plan.steps[start + 1]
    lines = to_ldraw(kit.build, "Beam", plan).splitlines()
    marker = lines.index(BUILD_TOGETHER)
    assert lines[marker + 1].endswith("3020.dat") and lines[marker + 2].endswith("3024.dat")


def test_free_standing_pieces_are_an_error_because_they_share_no_building_order(tmp_path):
    for assembly in (False, True):
        world = World(tmp_path / str(assembly), assembly=assembly)
        kit = world.kit()
        kit.place("3001", "Red", 0, 0, 0)
        kit.place("3001", "White", 8, 0, 0)
        report = world.checker.check(kit.build)
        assert (kinds(report.errors), kinds(report.warnings)) == ((["separate"], []) if assembly else ([], ["separate"]))
    assert "One connected model is needed" in report.errors[0].message
    assert "meant to be separate" not in report.errors[0].message


def test_a_model_no_order_can_build_is_reported_with_the_pieces_left_over(tmp_path, monkeypatch):
    world = World(tmp_path, assembly=True)
    build = wall(world)

    def blocked(self, build, contacts, boxes):
        raise NoSequence("Remaining pieces are disconnected or require a blocked placement", (3, 4))

    monkeypatch.setattr(SequencePlanner, "plan", blocked)
    report = world.checker.check(build)
    assert kinds(report.errors) == ["sequence"] and report.plan is None
    assert "blocked placement" in report.errors[0].message and "#3 " in report.errors[0].message


def test_the_planner_turns_novas_refusal_into_its_own_error(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3001", "Red", 0, 0, 0)
    kit.place("3001", "White", 8, 0, 0)  # nothing joins the two
    from fable_agent.checks import world_boxes
    boxes = {i: world_boxes(world.shapes.get(p.part), p) for i, p in enumerate(kit.build.placements)}
    with pytest.raises(NoSequence) as refused:
        SequencePlanner(world.shapes).plan(kit.build, [], boxes)
    assert refused.value.remaining == (1,)


def test_what_rests_on_the_ground_is_seated_first_and_a_tyre_is_not_a_foundation(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3001", "Red", 0, 0, 0)
    kit.place("3001", "White", 2, 3, 0)
    from fable_agent.checks import world_boxes
    boxes = {i: world_boxes(world.shapes.get(p.part), p) for i, p in enumerate(kit.build.placements)}
    planner = SequencePlanner(world.shapes)
    assert planner._foundation(kit.build, boxes) == {0}
    narrow = {0: [(0.0, -24.0, 0.0, 4.0, 0.0, 40.0)], 1: boxes[1]}  # touches down on a strip, like a tyre
    assert planner._foundation(kit.build, narrow) == set()
    assert planner._foundation(kit.build, {}) == set()


def test_without_a_plan_the_script_steps_are_written_as_before(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3001", "Red", 0, 0, 0)
    kit.step()
    kit.place("3001", "White", 0, 3, 0)
    assert to_ldraw(kit.build, "Two").count("0 STEP") == 2 and BUILD_TOGETHER not in to_ldraw(kit.build, "Two")


def test_joint_review_measures_a_turned_part_by_the_box_that_holds_it(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    first = kit.place("3001", "Red", 0, 0, 0)
    second = kit.place("3020", "White", 4, 0, 0, rot=45)
    kit.connect(first, second, "hinged")
    found = JointReview(world.library, world.shapes).review(kit.build, {}, set())
    assert found.touching == 1 and not found.apart and not found.missed and found.seated == 0
    assert JointReview._gap([], [(0, 0, 0, 1, 1, 1)]) == 0.0
