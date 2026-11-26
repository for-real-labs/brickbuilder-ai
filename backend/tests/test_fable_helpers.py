"""The helpers build scripts can call: ready-made trees, roofs, walls, windows, doors, car parts and more.

These tests use stand-in parts, so they prove the constructions (what rests on what) and the
arguments. tests/test_fable_helpers_real.py checks every style against the real parts library
wherever one is installed.
"""

import pytest
from fable_agent.helpers import HELPERS, bind, prompt_section
from fable_agent.helpers.common import Frame
from fable_agent.helpers.stairs import footprint
from fable_agent.helpers.trees import MAX_WIDTH, MIN_WIDTH, STYLES as TREES, canopy_height, canopy_plan
from fable_agent.helpers.windows import size as window_size
from fable_agent.checks import world_boxes
from fable_agent.kit import KitError, rect, ring
from fable_agent.palette import nearest_color

from fable_agent_support import HELPER_COLORS, HELPER_PARTS, InlineRunner, World

FACINGS = ("front", "back", "left", "right")


@pytest.fixture(autouse=True)
def private_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("FABLE_AGENT_CACHE", str(tmp_path / "cache"))


@pytest.fixture
def world(tmp_path):
    return World(tmp_path, extra=HELPER_PARTS, colors=HELPER_COLORS, max_parts=4000)


def ground(world, x0=-12, z0=-12, x1=30, z1=30):
    kit = world.kit()
    kit.fill(rect(x0, z0, x1, z1), 0, "Green", kind="plate")
    return kit, bind(kit)


def clean(world, kit) -> bool:
    report = world.checker.check(kit.build)
    assert report.ok, [issue.message for issue in report.errors][:3]
    assert all(world.palette.allows(p.part, p.color) for p in kit.build.placements)
    return True


def cells(world, kit, ids) -> set:
    return {(x, z) for index in ids for box in world_boxes(world.shapes.get(kit.build.placements[index].part),
                                                           kit.build.placements[index])
            for x in range(round(box[0] / 20), round(box[3] / 20)) for z in range(round(box[2] / 20), round(box[5] / 20))}


# ----- the registry ------------------------------------------------------------------


def test_every_helper_offers_at_least_fifteen_styles_and_reaches_scripts_and_the_prompt(world):
    assert set(HELPERS) == {"tree", "roof", "wall", "window", "door", "arch", "deck", "stairs", "railing", "wheels",
                            "windscreen", "seats", "chassis", "furniture", "plant", "lamp", "chimney", "column"}
    section = prompt_section()
    for name, helper in HELPERS.items():
        assert len(helper.styles) >= 15 and len(set(helper.styles)) == len(helper.styles), name
        assert helper.signature.startswith(f"{name}(x, y, z") and 'style="' in helper.signature
        assert helper.signature.split('style="')[1].split('"')[0] in helper.styles  # the default style exists
        assert set(helper.notes or {}) <= set(helper.styles)
        assert f"`{helper.signature}`" in section and all(style in section for style in helper.styles)
    assert set(bind(world.kit())) == set(HELPERS)


@pytest.mark.parametrize("name", sorted(HELPERS))
def test_a_helper_explains_a_style_or_position_it_cannot_use(world, name):
    kit, call = ground(world)
    placed = len(kit.build.placements)
    extra = {"roof": (8, 8), "railing": (4,), "wall": (4, 9), "deck": (8, 6)}.get(name, ())
    with pytest.raises(KitError, match="style must be one of"):
        call[name](0, 1, 0, *extra, style="no-such-style")
    with pytest.raises(KitError, match="whole number for x"):
        call[name](0.5, 1, 0, *extra)
    with pytest.raises(KitError, match="number of plates for y"):
        call[name](0, "low", 0, *extra)
    with pytest.raises(KitError, match=f"{name}\\(\\) does not take those arguments. Call it as {name}\\(x, y, z"):
        call[name](0, 1, 0, *extra, wobble=3)
    with pytest.raises(KitError, match="does not take those arguments"):
        call[name](*range(40))
    assert len(kit.build.placements) == placed  # a refused call builds nothing


def test_helpers_take_their_arguments_by_position_as_their_signatures_show(world):
    kit, call = ground(world, -20, -30, 40, 30)
    call["tree"](20, 1, 20, 30, 6, "oak", "Green", "Dark_Green", "Black")
    call["roof"](0, 1, 0, 8, 8, "flat", "Red")
    call["wall"](0, 1, 12, 8, 9, "banded", "White", "Red", "front", [(2, 3, 2, 6)])
    call["stairs"](12, 1, 0, 3, 6, "tiled", "White", "Red", "left")
    call["deck"](-16, 1, -20, 8, 6, 5, "patio", "White", "Tan", None, ("front",), "front")
    call["railing"](12, 1, 12, 5, "wall", "White")
    call["column"](30, 1, 0, 9, "round", "White")
    assert clean(world, kit)


def test_a_frame_turns_one_layout_to_face_any_side(world):
    footprints = {}
    for facing in FACINGS:
        kit = world.kit()
        frame = Frame(kit, 10, 0, 20, 4, 2, facing)
        ids = [frame.place("3001", "Red", 0, 0, 0), frame.place("3005", "White", 0, 0, -1)]  # a marker in front
        brick, marker = (cells(world, kit, [index]) for index in ids)
        footprints[facing] = (brick, next(iter(marker)))
        assert frame.side("front") == facing
    wide, deep = rect(10, 20, 14, 22), rect(10, 20, 12, 24)
    assert footprints["front"] == (wide, (10, 19)) and footprints["back"] == (wide, (13, 22))
    assert footprints["left"] == (deep, (9, 23)) and footprints["right"] == (deep, (12, 20))


# ----- trees -------------------------------------------------------------------------


@pytest.mark.parametrize("style", sorted(TREES))
@pytest.mark.parametrize("width", range(MIN_WIDTH, MAX_WIDTH + 1, 2))
def test_every_tree_holds_together_and_uses_only_stocked_parts(world, style, width):
    kit, call = ground(world)
    base = len(kit.build.placements)
    placed = call["tree"](0, 1, 0, height=40, width=width, style=style)
    assert clean(world, kit) and placed == list(range(base, len(kit.build.placements)))
    covered = cells(world, kit, placed)
    across = max(size for _, size in canopy_plan(style, width))
    assert (min(x for x, _ in covered), max(x for x, _ in covered) + 1) == (1 - across // 2, 1 + across // 2)


def test_a_canopy_never_overhangs_its_support_by_more_than_a_strip_can_bridge():
    for style, look in TREES.items():
        for width in range(MIN_WIDTH, MAX_WIDTH + 1, 2):
            plan = canopy_plan(style, width)
            under = 2 if look.trunk else width  # a tree stands on its trunk; a bush on the ground
            for kind, size in plan:
                assert size - under <= (2 if kind == "strips" else 0), (style, width, kind, size)
                under = size
            assert canopy_height(style, width) == sum(1 if kind == "strips" else 3 for kind, _ in plan)


def test_a_tree_keeps_its_first_three_styles_and_falls_back_to_stocked_parts(tmp_path):
    # Scripts saved before the other styles existed call these three with these arguments.
    assert list(TREES)[:1] == ["round"] and {"round", "pine", "bush"} <= set(TREES)
    assert canopy_plan("round", 6) == [("strips", 4), ("strips", 6), ("bricks", 6), ("bricks", 6), ("strips", 4),
                                       ("bricks", 4)]
    assert canopy_plan("bush", 4) == [("bricks", 4)] and canopy_plan("pine", 4) == [("strips", 4), ("bricks", 4)]
    bare = World(tmp_path, skip={("3020", 4), ("3005", 4)})  # no round trunk, no dome, no red 2 x 4 plate
    kit, call = ground(bare, -4, -4, 6, 6)
    base = len(kit.build.placements)
    call["tree"](0, 1, 0, height=20, width=4, leaves="Red", trunk="Black")
    assert clean(bare, kit)
    tree = kit.build.placements[base:]
    assert {p.color for p in tree if p.part == "3020"} == {nearest_color(bare.library, bare.palette, "3020", 4)}
    with pytest.raises(KitError, match="even number from 4 to 10"):
        call["tree"](0, 1, 0, width=5)


# ----- roofs -------------------------------------------------------------------------


def house(call, wide, deep):
    call["wall"](0, 1, 0, wide, 6)
    call["wall"](0, 1, deep - 1, wide, 6)
    call["wall"](0, 1, 1, deep - 2, 6, facing="left")
    call["wall"](wide - 1, 1, 1, deep - 2, 6, facing="left")
    return 7


@pytest.mark.parametrize("style", ["gable", "low_gable", "saltbox", "shed", "hip", "mansard", "flat", "tiled",
                                   "parapet", "crenellated", "stepped", "pagoda"])
@pytest.mark.parametrize(("wide", "deep"), [(8, 8), (12, 8), (9, 7)])
@pytest.mark.parametrize("facing", ["front", "left"])
def test_a_roof_rests_on_its_walls_and_every_course_on_the_one_below(world, style, wide, deep, facing):
    kit, call = ground(world)
    top = house(call, wide, deep)
    placed = call["roof"](0, top, 0, wide, deep, style=style, color="Red", trim="White", facing=facing)
    assert placed and clean(world, kit)
    covered = cells(world, kit, placed)
    reach = 1 if style == "pagoda" else 0  # a pagoda's eaves overhang its walls by a stud
    assert covered <= rect(-reach, -reach, wide + reach, deep + reach)
    assert ring(0, 0, wide, deep) <= covered  # it reaches every wall under its edge


def test_a_gable_is_closed_with_ridge_parts_when_they_fit_and_plates_when_they_do_not(world):
    for wide, ridge in ((8, True), (9, True), (8, False)):
        kit, call = ground(world)
        deep = 8 if ridge else 9  # an odd depth leaves a ridge three studs wide, too wide for a ridge part
        placed = call["roof"](0, house(call, wide, deep), 0, wide, deep, style="gable", color="Red")
        parts = {kit.build.placements[index].part for index in placed}
        assert clean(world, kit) and (bool(parts & {"3043", "3044c"}) is ridge)
    kit, call = ground(world)
    with pytest.raises(KitError, match="at most 16"):
        call["roof"](0, 1, 0, 40, 20, style="flat")
    with pytest.raises(KitError, match="more depth"):
        call["roof"](0, 1, 0, 8, 5, style="low_gable")


# ----- walls, windows and doors ------------------------------------------------------


@pytest.mark.parametrize("style", ["plain", "banded", "base", "checker", "timber", "quoins", "castle", "capped",
                                   "cornice", "stone"])
@pytest.mark.parametrize("facing", FACINGS)
def test_a_wall_carries_itself_over_every_opening(world, style, facing):
    kit, call = ground(world)
    openings = [(1, 3, 4, 9), (8, 3, 2, 8), (12, 6, 4, 5)]  # the last one reaches the end of the wall
    placed = call["wall"](0, 1, 0, 16, 21, style=style, color="White", trim="Red", facing=facing, openings=openings)
    assert clean(world, kit)
    span = cells(world, kit, placed)
    along = (lambda cell: cell[0]) if facing in ("front", "back") else (lambda cell: cell[1])
    assert {along(cell) for cell in span} >= set(range(16))


def test_a_wall_leaves_each_opening_clear_for_the_window_or_door_that_fills_it(world):
    kit, call = ground(world)
    call["wall"](0, 1, 0, 14, 21, color="Tan", openings=[(1, 3, 2, 6), (4, 3, 4, 9), (9, 0, 4, 18)])
    window, wide, door = (call["window"](1, 4, 0, style="small"), call["window"](4, 4, 0, style="wide"),
                          call["door"](9, 1, 0, style="panel"))
    assert clean(world, kit)
    # Glass and the door leaf sit in their frames: recorded joints, since no stud makes them.
    notes = [note for _, _, note in kit.build.links]
    assert notes.count("pane in its frame") == 2 and notes.count("door on its hinges") == 1
    assert window_size("small") == (2, 6, 1) and window_size("wide") == (4, 9, 1) and len(window) == len(wide) == 2
    assert len(door) == 2
    with pytest.raises(KitError, match="inside the wall"):
        call["wall"](0, 1, 4, 6, 9, openings=[(4, 0, 4, 6)])
    with pytest.raises(KitError, match="offset, base, width, height"):
        call["wall"](0, 1, 4, 6, 9, openings=[(1, 2)])


def test_windows_and_doors_face_any_side_and_a_pair_of_doors_meets_in_the_middle(world):
    for facing in FACINGS:
        kit, call = ground(world)
        for index, style in enumerate(("small", "double", "stacked", "grid", "shuttered", "wide")):
            call["window"](6 * index - 10, 1, 6 * index - 10, style=style, facing=facing)
        call["door"](-10, 1, 16, style="double", facing=facing)
        call["door"](0, 1, 16, style="doorway", facing=facing)
        call["door"](-10, 1, 0, style="garage", facing=facing)
        assert clean(world, kit)
        hung = [turn for placement, turn in ((kit.build.placements[b], None) for _, b, note in kit.build.links
                                             if note == "door on its hinges")]
        assert len(hung) == 2


# ----- stairs and railings -----------------------------------------------------------


@pytest.mark.parametrize("style", sorted(HELPERS["stairs"].styles))
@pytest.mark.parametrize(("width", "rise"), [(4, 9), (2, 7), (5, 18)])
def test_stairs_stand_on_the_ground_step_by_step_and_fill_the_footprint_they_state(world, style, width, rise):
    if style in ("prefab", "ladder"):
        pytest.skip("a part of fixed size, with its own test")
    kit, call = ground(world, -4, -4, 12, 44)
    placed = call["stairs"](0, 1, 0, width=width, rise=rise, style=style, color="White", trim="Red")
    assert clean(world, kit)
    steps, deep = footprint(style, rise)
    covered = cells(world, kit, placed)
    assert covered <= rect(0, 0, width, deep) and {z for _, z in covered} == set(range(deep))

    def top(row):  # plates above the ground plate at this row of the footprint
        return max(-box[1] for index in placed for box in world_boxes(
            world.shapes.get(kit.build.placements[index].part), kit.build.placements[index])
            if round(box[2] / 20) <= row < round(box[5] / 20)) / 8 - 1

    assert top(deep - 1) >= rise > top(0) - 8  # it starts low at the front and has climbed the rise at the back


@pytest.mark.parametrize("style", sorted(HELPERS["railing"].styles))
@pytest.mark.parametrize("length", [1, 4, 7, 13])
def test_a_railing_of_any_length_is_whole_parts_and_posts(world, style, length):
    kit, call = ground(world)
    for facing, x, z in (("front", 0, 0), ("left", -5, 0)):
        try:
            placed = call["railing"](x, 1, z, length, style=style, color="White", trim="Black", facing=facing)
        except KitError as error:
            assert "catalog has no" in str(error)  # a fence part this stand-in library lacks
            return
        covered = cells(world, kit, placed)
        run = rect(x, z, x + length, z + 1) if facing == "front" else rect(x, z, x + 1, z + length)
        ends = {(x, z), (x + length - 1, z) if facing == "front" else (x, z + length - 1)}
        assert ends <= covered <= run  # it starts and ends where asked and stays one stud deep
    assert clean(world, kit)


# ----- decks -------------------------------------------------------------------------


@pytest.mark.parametrize("style", sorted(HELPERS["deck"].styles))
@pytest.mark.parametrize(("wide", "deep", "height"), [(8, 6, 6), (12, 5, 8), (7, 7, 2), (16, 9, 5)])
def test_a_deck_carries_its_floor_its_railings_and_its_steps(world, style, wide, deep, height):
    kit, call = ground(world, -30, -40, 50, 40)
    for railing, steps in ((("front", "left", "right"), "front"), ((), None), (("front", "back", "left", "right"), "left")):
        placed = call["deck"](0, 1, 0, wide, deep, height, style, railing=railing, steps=steps)
        assert clean(world, kit)
        floor = {cell for index in placed for cell in cells(world, kit, [index])
                 if kit.build.placements[index].part.startswith(("30", "37", "34", "38", "36"))}
        assert rect(0, 0, wide, deep) <= cells(world, kit, placed)  # the floor covers the whole rectangle
        assert floor
        if steps is None:
            assert cells(world, kit, placed) == rect(0, 0, wide, deep)  # nothing outside it without steps
        kit, call = ground(world, -30, -40, 50, 40)


def test_a_deck_one_plate_up_is_only_a_floor_for_walls_that_are_already_there(world):
    kit, call = ground(world)
    call["wall"](0, 1, 0, 8, 9)
    call["wall"](0, 1, 4, 8, 9)
    placed = call["deck"](0, 10, 0, 8, 5, 1, "platform", railing=("front",), steps=None)
    assert clean(world, kit)
    lows = {min(-box[4] for box in world_boxes(world.shapes.get(kit.build.placements[i].part),
                                              kit.build.placements[i])) / 8 for i in placed}
    assert min(lows) == 10  # nothing below the floor: the walls carry it


def test_a_deck_refuses_what_it_cannot_span_and_sides_it_does_not_know(world):
    kit, call = ground(world)
    for arguments, message in (((20, 20), "at most 16"), ((8, 6, 6, "porch", None, None, "fancy"), "rail must be one of"),
                               ((8, 6, 6, "porch", None, None, None, ("north",)), "railing must list sides"),
                               ((8, 6, 6, "porch", None, None, None, (), "up"), "steps must be one of")):
        with pytest.raises(KitError, match=message):
            call["deck"](0, 1, 0, *arguments)
    assert len(kit.build.placements) == len(ground(world)[0].build.placements)


# ----- car parts ---------------------------------------------------------------------


def test_wheels_are_joined_to_what_carries_them_and_a_body_sits_on_its_studs(world):
    for facing in FACINGS:
        kit = world.kit()
        call = bind(kit)
        placed = call["wheels"](0, 2, 0, style="small", facing=facing)
        parts = [kit.build.placements[index].part for index in placed]
        assert parts == ["4600", "4624", "87414", "4624", "87414"]
        assert sorted(note for _, _, note in kit.build.links) == ["tyre on its rim"] * 2 + ["wheel on its pin"] * 2
        across = facing in ("front", "back")  # the axle lies across the way the car drives
        kit.fill(rect(0, 0, 4, 2) if across else rect(0, 0, 2, 4), 3, "Red", kind="plate")  # the body, 4 wide
        assert clean(world, kit)
        axis = 0 if across else 2
        # The holder is centered under the body, so its studs fall on the grid.
        assert kit.build.placements[placed[0]].position[axis] == 40
        rims = [kit.build.placements[index].position for index in placed if kit.build.placements[index].part == "4624"]
        assert abs(rims[0][axis] - rims[1][axis]) == 60 and rims[0][2 - axis] == rims[1][2 - axis]
    with pytest.raises(KitError, match="catalog has no"):
        World_without(world, "56904")["wheels"](0, 5, 0, style="truck")


def World_without(world, *parts):
    """The helpers over a library that lacks some parts, as a small catalog would."""
    from pathlib import Path
    from tempfile import mkdtemp
    lean = World(Path(mkdtemp()), extra={k: v for k, v in HELPER_PARTS.items() if k not in parts},
                 colors=HELPER_COLORS, max_parts=4000)
    return bind(lean.kit())


@pytest.mark.parametrize("style", sorted(HELPERS["wheels"].styles))
def test_every_wheel_style_carries_a_body_and_reaches_the_ground_it_states(world, style):
    from fable_agent.helpers.cars import STYLES
    look = STYLES[style]
    kit = world.kit()
    call = bind(kit)
    try:
        placed = call["wheels"](0, look.drop, 0, style=style, width=4)
    except KitError as error:
        assert "catalog has no" in str(error)  # a wheel this stand-in library lacks
        return
    carriers = [index for index in placed if not kit.build.placements[index].allow_overlap]
    top = max(-box[1] for index in carriers for box in world_boxes(
        world.shapes.get(kit.build.placements[index].part), kit.build.placements[index])) / 8
    wide = 2 if look.mount == "caster" else 4
    kit.fill(rect(0, 0, wide, 2), top, "Red", kind="plate", layers=2)
    assert clean(world, kit)
    assert top - look.drop == (3 if look.mount in ("pins", "axle") else 1)  # where the summary says to build


def test_an_axle_takes_the_longest_rod_that_fits_and_every_joint_is_between_parts_that_meet(world):
    kit = world.kit()
    placed = bind(kit)["wheels"](0, 7, 0, style="balloon", width=6)
    parts = [kit.build.placements[index].part for index in placed]
    assert parts[:2] == ["32064a", "32064a"] and "3737" in parts and "44294" not in parts
    rims = [kit.build.placements[index].position[0] for index in placed if kit.build.placements[index].part == "56145"]
    assert sorted(rims) == [10 - 45, 110 + 45]  # a rim 45 units outside the middle of each side brick
    # Brick to axle, axle to the other brick, axle to each wheel: never brick to brick or brick to wheel.
    joined = sorted((kit.build.placements[a].part, kit.build.placements[b].part, note) for a, b, note in kit.build.links)
    assert joined == [("32064a", "3737", "axle through the axle hole"),
                      ("3737", "32064a", "the same axle through this brick"),
                      ("3737", "56145", "wheel on its axle"), ("3737", "56145", "wheel on its axle"),
                      ("56145", "55976", "tyre on its rim"), ("56145", "55976", "tyre on its rim")]
    from fable_agent.joints import JointReview
    found = JointReview(world.library, world.shapes).review(kit.build, {}, set())
    assert not found.apart and not found.missed and found.touching == 6


def test_a_narrow_truck_gets_an_axle_long_enough_to_clear_the_deck(world):
    kit = world.kit()
    placed = bind(kit)["wheels"](0, 5, 0, style="truck", width=4)
    assert "44294" in [kit.build.placements[index].part for index in placed]  # rims 60 from the middle: an axle of 70
    with pytest.raises(KitError, match="has no axle for the truck style"):
        World_without(world, "3706", "44294")["wheels"](0, 5, 0, style="truck", width=4)


def test_tyres_are_joined_to_a_road_that_is_already_under_them(world):
    kit, call = ground(world)
    call["wheels"](0, 3, 0, style="small")
    kit.fill(rect(0, 0, 4, 2), 4, "Red", kind="plate")
    assert "tyres standing on it" in [note for _, _, note in kit.build.links] and clean(world, kit)
    alone = world.kit()
    bind(alone)["wheels"](0, 2, 0, style="small")
    assert "tyres standing on it" not in [note for _, _, note in alone.build.links]
    road = alone.place("3020", "Red", 20, 0, 20)
    assert alone.stand([road]) is None  # nothing lies under it
    with pytest.raises(KitError, match="ids returned by place"):
        alone.stand([999])


# ----- vehicle bases -----------------------------------------------------------------


@pytest.mark.parametrize("style", sorted(HELPERS["chassis"].styles))
@pytest.mark.parametrize("facing", FACINGS)
def test_a_chassis_is_one_piece_with_its_floor_at_the_deck_its_style_states(world, style, facing):
    from fable_agent.helpers.vehicles import STYLES, deck
    look = STYLES[style]
    kit = world.kit()
    placed = bind(kit)["chassis"](2, 0, 2, style=style, facing=facing)
    floor = [index for index in placed if not kit.build.placements[index].allow_overlap]
    top = max(-box[1] for index in floor for box in world_boxes(
        world.shapes.get(kit.build.placements[index].part), kit.build.placements[index])) / 8
    assert top == deck(style)
    along = facing in ("front", "back")
    body = rect(2, 2, 2 + look.wide, 2 + look.length) if along else rect(2, 2, 2 + look.length, 2 + look.wide)
    kit.fill(body, deck(style), "Red")  # a body over the whole floor
    assert clean(world, kit)
    lowest = min(-box[4] for index in placed for box in world_boxes(
        world.shapes.get(kit.build.placements[index].part), kit.build.placements[index])) / 8
    assert abs(lowest) < 0.6  # the tyres stand on y, as near as whole plates allow


def test_a_chassis_changes_length_and_wheels_and_says_what_it_cannot_carry(world):
    from fable_agent.helpers.vehicles import deck
    for length in (6, 9, 16):
        kit = world.kit()
        placed = bind(kit)["chassis"](0, 0, 0, style="city", length=length)
        kit.fill(rect(0, 0, 4, length), deck("city"), "Red")
        assert clean(world, kit)
        assert cells(world, kit, [i for i in placed if not kit.build.placements[i].allow_overlap]) == rect(0, 0, 4, length)
    for length in (11, 23, 27, 30):  # long floors are cut into pieces whose seams alternate
        kit = world.kit()
        bind(kit)["chassis"](0, 0, 0, style="bus", length=length)
        kit.fill(rect(0, 0, 6, length), deck("bus"), "Red")
        assert clean(world, kit)
    kit = world.kit()
    call = bind(kit)
    swapped = call["chassis"](0, 0, 0, style="pickup", wheels="street", rim="Red")
    assert "55981" in [kit.build.placements[index].part for index in swapped]
    assert 4 in [kit.build.placements[index].color for index in swapped]
    assert deck("pickup", "offroad") == deck("pickup") + 1  # tyres that reach one plate lower raise the deck one
    with pytest.raises(KitError, match="cannot carry small wheels; choose from: medium, sport, street"):
        call["chassis"](20, 0, 0, style="sports", wheels="small")
    with pytest.raises(KitError, match="cannot carry sport wheels; choose from: small, smooth, spoked, classic$"):
        call["chassis"](20, 0, 0, style="city", wheels="sport")
    with pytest.raises(KitError, match="length must be from"):
        call["chassis"](20, 0, 0, style="city", length=40)


def test_a_chassis_stands_on_a_baseplate_and_closes_over_its_wheels_without_a_mudguard_part(world):
    kit, call = ground(world, -4, -4, 30, 40)
    call["chassis"](0, 1, 0, style="city")
    call["chassis"](8, 1, 0, style="truck")
    assert clean(world, kit)
    lean = World_without(world, "60212")
    placed = lean["chassis"](0, 0, 0, style="city")
    assert placed  # the same deck, with plates where the mudguards would be


# ----- furniture ---------------------------------------------------------------------


@pytest.mark.parametrize("style", sorted(HELPERS["furniture"].styles))
def test_every_piece_of_furniture_stands_on_the_floor_within_its_footprint(world, style):
    from fable_agent.helpers.furniture import STYLES
    look = STYLES[style]
    for facing in FACINGS:
        kit, call = ground(world)
        placed = call["furniture"](4, 1, 4, style=style, facing=facing)
        assert clean(world, kit)
        wide, deep = (look.wide, look.deep) if facing in ("front", "back") else (look.deep, look.wide)
        fixed = [index for index in placed if not kit.build.placements[index].allow_overlap]
        covered = cells(world, kit, fixed)
        # A handle, a door or a round seat may reach one stud past the footprint; nothing else does.
        assert covered <= rect(3, 3, 5 + wide, 5 + deep) and covered & rect(4, 4, 4 + wide, 4 + deep)


def test_furniture_seats_its_joined_parts_and_falls_back_to_bricks(world):
    kit, call = ground(world)
    placed = call["furniture"](0, 1, 0, style="desk", color="White", accent="Red")
    parts = [kit.build.placements[index].part for index in placed]
    assert parts.count("92410") == 1 and parts.count("4536") == 2
    assert [note for _, _, note in kit.build.links] == ["drawer in its cupboard"] * 2
    drawers = [kit.build.placements[index] for index in placed if kit.build.placements[index].part == "4536"]
    assert {drawer.color for drawer in drawers} == {4} and clean(world, kit)
    box = call["furniture"](10, 1, 0, style="nightstand", facing="left")
    host = kit.build.placements[box[0]]
    assert host.part == "4345b" and host.position[0] % 20 == 0 and host.position[2] % 20 == 0  # studs on the grid
    lean = World_without(world, "92410", "4738a")
    assert lean["furniture"](0, 0, 0, style="desk")  # bricks stand in for the cupboard
    with pytest.raises(KitError, match="catalog has no chest"):
        lean["furniture"](10, 0, 0, style="chest")
    with pytest.raises(KitError, match="Unknown color"):
        call["furniture"](0, 1, 10, color="Blurple")


# ----- styles added from official sets --------------------------------------------------


def test_a_sheet_of_glass_takes_the_glass_color_and_fills_the_opening_it_states(world):
    kit, call = ground(world)
    placed = call["window"](0, 1, 0, style="glass_wall", color="Red", glass="Trans_Clear")
    sheet = kit.build.placements[placed[0]]
    assert (sheet.part, sheet.color) == ("60581", 47) and window_size("glass_wall") == (4, 9, 1)
    assert window_size("storefront") == (12, 15, 1) and window_size("glass_tower") == (4, 18, 1)
    assert len(call["window"](6, 1, 0, style="storefront")) == 2 and clean(world, kit)


def test_a_ladder_hangs_on_a_post_that_carries_each_length(world):
    kit, call = ground(world)
    placed = call["stairs"](0, 1, 0, rise=14, style="ladder", facing="back")
    parts = [kit.build.placements[index].part for index in placed]
    assert parts.count("4175") == 3 and footprint("ladder", 14) == (3, 2)  # three lengths of 6 plates climb 14
    kit.fill(rect(0, 0, 2, 1), 19, "Red", kind="plate")  # a floor laid on the top length's studs
    assert clean(world, kit)


def test_a_flower_stem_carries_three_flowers_on_its_stalks(world):
    kit, call = ground(world)
    placed = call["plant"](0, 1, 0, "flower_stem", "Yellow")
    parts = [kit.build.placements[index].part for index in placed]
    assert parts == ["3741a", "3742", "3742", "3742"]
    assert [note for _, _, note in kit.build.links] == ["flower on its stalk"] * 3
    stem = kit.build.placements[placed[0]]
    assert (stem.position[0], stem.position[2]) == (10, 10) and clean(world, kit)  # its stud is over the cell's middle
    assert {kit.build.placements[index].color for index in placed[1:]} == {14}


def test_seats_face_the_way_asked_with_the_steering_wheel_in_front_of_the_driver(world):
    for facing in FACINGS:
        kit, call = ground(world)
        placed = call["seats"](0, 1, 0, style="sedan_left", color="Red", facing=facing)
        assert clean(world, kit)
        parts = [kit.build.placements[index].part for index in placed]
        assert parts.count("4079") == 4 and parts.count("16091") == 1 and parts.count("87087") == 1
        assert [note for _, _, note in kit.build.links] == ["steering wheel on a side stud"]
        wide, deep = (4, 8) if facing in ("front", "back") else (8, 4)
        assert cells(world, kit, [i for i in placed if kit.build.placements[i].part != "16091"]) <= rect(0, 0, wide, deep)
    kit, call = ground(world)
    assert len(call["windscreen"](0, 1, 0, style="classic", color="Trans_Clear")) == 1 and clean(world, kit)


# ----- stacks: plants, lamps, chimneys, columns ---------------------------------------


@pytest.mark.parametrize(("name", "style", "parts"), [
    ("plant", "flower", ["4073", "24866"]),
    ("plant", "shrub", ["3941", "30367c"]),
    ("lamp", "street", ["11062", "3062b", "4073"]),
    ("lamp", "bollard", ["3062b", "4073"]),
    ("chimney", "brick", ["3003", "3003", "3003", "3022"]),
    ("column", "round", ["3062b"] * 6),
    ("column", "doric", ["3022", "3941", "3941", "3941", "3941", "3941", "3941", "3022"]),
])
def test_a_stack_sets_each_part_on_the_one_below(world, name, style, parts):
    kit, call = ground(world)
    sized = name in ("chimney", "column")
    placed = call[name](0, 1, 0, *((9 if name == "chimney" else 18,) if sized else ()), style)
    assert [kit.build.placements[index].part for index in placed] == parts and clean(world, kit)
    lows = [min(-box[4] for box in world_boxes(world.shapes.get(kit.build.placements[index].part),
                                              kit.build.placements[index])) for index in placed]
    assert lows == sorted(lows) and lows[0] == 8  # it starts on the ground plate and only goes up
    with pytest.raises(KitError, match="does not take those arguments"):
        call[name](0, 1, 0, sideways=True)


def test_a_stack_takes_its_colors_from_its_arguments_and_the_closest_stocked_color(world):
    kit, call = ground(world)
    placed = call["lamp"](0, 1, 0, style="street", color="Red", light="Trans_Yellow")
    colors = [kit.build.placements[index].color for index in placed]
    assert colors == [4, 46, 4] and clean(world, kit)
    with pytest.raises(KitError, match="Unknown color"):
        call["plant"](4, 1, 0, color="Blurple")


def test_an_arch_stands_on_piers_and_a_wall_can_go_on_over_it(world):
    for facing in FACINGS:
        kit, call = ground(world)
        placed = call["arch"](0, 1, 0, style="flat", color="White", height=9, facing=facing)
        assert kit.build.placements[placed[-1]].part == "3659" and len(placed) > 1
        wide = (4, 1) if facing in ("front", "back") else (1, 4)
        kit.fill(rect(0, 0, *wide), 13, "White")
        assert clean(world, kit)


# ----- in a script -------------------------------------------------------------------


def test_a_script_builds_a_house_from_helpers(world):
    script = """
fill(rect(-4, -6, 22, 16), 0, 'Green', kind='plate')
wall(0, 1, 0, 14, 18, color='Tan', openings=[(2, 6, 2, 6), (6, 0, 4, 18)])
wall(0, 1, 9, 14, 18, color='Tan')
wall(0, 1, 1, 8, 18, color='Tan', facing='left')
wall(13, 1, 1, 8, 18, color='Tan', facing='left')
window(2, 7, 0)
door(6, 1, 0)
roof(0, 19, 0, 14, 10, style='gable', color='Red', gable='Tan')
stairs(6, 1, -2, width=4, rise=1, style='gentle', color='White', facing='front')
tree(17, 1, 4, height=24, width=4)
railing(-3, 1, -4, 8, style='wall', color='White')
print(len(lamp(-3, 1, 6, style='bollard', color='Black')))
"""
    outcome = InlineRunner(world).run(script)
    assert outcome.build is not None, outcome.error
    report = world.checker.check(outcome.build)
    assert report.ok, [issue.message for issue in report.errors][:3]
    assert outcome.output.strip() == "2" and report.parts > 120
    # A script may still define its own function with a helper's name; its own wins.
    own = InlineRunner(world).run("def roof(n):\n    return n + 1\nprint(roof(1))\nplace('3001', 'Red', 0, 0, 0)\n")
    assert own.output.strip() == "2"
