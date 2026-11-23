import pytest
from fable_agent.checks import _world_boxes
from fable_agent.kit import KitError, rect, ring, to_ldraw

from fable_agent_support import World


def footprint(world, placement):
    boxes = _world_boxes(world.shapes.get(placement.part), placement)
    return (min(b[0] for b in boxes) / 20, min(b[2] for b in boxes) / 20,
            max(b[3] for b in boxes) / 20, max(b[5] for b in boxes) / 20)


def test_place_puts_the_min_corner_on_the_grid_and_the_base_on_the_layer(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3001", "Red", 2, 3, 5)
    placement = kit.build.placements[0]
    # LDraw origin of a 2 x 4 brick is the centre of its top face; Y points down.
    assert placement.position == (80.0, -48.0, 120.0)
    assert placement.color == 4
    assert footprint(world, placement) == (2, 5, 6, 7)


def test_rotation_turns_the_footprint_and_keeps_the_same_corner(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3001", 4, 2, 0, 5, rot=90)
    assert footprint(world, kit.build.placements[0]) == (2, 5, 4, 9)


@pytest.mark.parametrize("facing, low_edge", [("front", "z0"), ("back", "z1"), ("left", "x0"), ("right", "x1")])
def test_facing_points_a_slope_low_edge(tmp_path, facing, low_edge):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3039", 4, 0, 0, 0, facing=facing)
    placement = kit.build.placements[0]
    boxes = _world_boxes(world.shapes.get("3039"), placement)
    lowest_top = max(boxes, key=lambda b: b[1])  # largest Y is the lowest surface
    x0, z0 = min(b[0] for b in boxes), min(b[2] for b in boxes)
    x1, z1 = max(b[3] for b in boxes), max(b[5] for b in boxes)
    edge = {"z0": lowest_top[2] == z0, "z1": lowest_top[5] == z1,
            "x0": lowest_top[0] == x0, "x1": lowest_top[3] == x1}
    assert edge[low_edge]


def test_colors_accept_names_codes_and_reject_unknown_or_reserved(tmp_path):
    kit = World(tmp_path).kit()
    assert kit.color("sand blue") == kit.color("Sand_Blue") == kit.color(379) == 379
    assert kit.color("Light Bluish Gray") == 71
    with pytest.raises(KitError, match="Did you mean"):
        kit.color("Sand_Blu")
    for bad in (16, 24, 12345, True, None):
        with pytest.raises(KitError):
            kit.color(bad)


def test_fill_covers_every_cell_once_and_prefers_large_parts(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.fill(rect(0, 0, 4, 4), 0, "Green", kind="plate")
    covered = []
    for placement in kit.build.placements:
        x0, z0, x1, z1 = footprint(world, placement)
        covered += [(x, z) for x in range(int(x0), int(x1)) for z in range(int(z0), int(z1))]
    assert sorted(covered) == sorted(rect(0, 0, 4, 4))
    assert {p.part for p in kit.build.placements} == {"3020"}


def test_fill_staggers_seams_between_layers_and_interlocks_corners(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.fill(ring(0, 0, 9, 6), 0, "Red", layers=2)
    seams = {0: set(), 1: set()}
    corner_owner = {}
    for placement in kit.build.placements:
        layer = 0 if placement.position[1] == -24 else 1
        x0, z0, x1, z1 = footprint(world, placement)
        if z0 == 0 and z1 == 1:  # front wall
            seams[layer].add(x1)
        if x0 == 0 and z0 == 0:
            corner_owner[layer] = "x" if x1 - x0 > 1 else "z"
    inner = lambda values: {v for v in values if 0 < v < 9}  # noqa: E731
    assert inner(seams[0]) and inner(seams[1])
    assert not inner(seams[0]) & inner(seams[1])
    assert corner_owner[0] != corner_owner[1]


def test_fill_explains_when_a_color_cannot_fill_gaps(tmp_path):
    world = World(tmp_path, skip={("3005", 4)})
    with pytest.raises(KitError, match="No 1 x 1 brick"):
        world.kit().fill(rect(0, 0, 3, 1), 0, "Red")


@pytest.mark.parametrize("call", [
    lambda kit: kit.place("3001", 4, float("nan"), 0, 0),
    lambda kit: kit.place("3001", 4, "1", 0, 0),
    lambda kit: kit.place("nope", 4, 0, 0, 0),
    lambda kit: kit.place("3001", 4, 0, 0, 0, rot=90, facing="left"),
    lambda kit: kit.place("3001", 4, 0, 0, 0, facing="up"),
    lambda kit: kit.place("3001", 4, 1e9, 0, 0),
    lambda kit: kit.fill([(0, 0)], 0, 4, kind="glass"),
    lambda kit: kit.fill(rect(0, 0, 300, 300), 0, 4),
    lambda kit: kit.row("3001", 4, 0, 0, 0, 10_000),
    lambda kit: kit.connect(0, 0),
    lambda kit: kit.place_ldu("3001", 4, (0, 0, 0), [[2, 0, 0], [0, 1, 0], [0, 0, 1]]),
    lambda kit: kit.place_ldu("3001", 4, (0, 0, 0), [[-1, 0, 0], [0, 1, 0], [0, 0, 1]]),
])
def test_invalid_kit_calls_are_refused(tmp_path, call):
    with pytest.raises(KitError):
        call(World(tmp_path).kit())


def test_the_placement_limit_stops_runaway_scripts(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit._max = 3
    with pytest.raises(KitError, match="more than 3 parts"):
        kit.row("3005", 4, 0, 0, 0, 5)


def test_row_steps_by_the_part_size_and_part_reports_measurements(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.row("3001", 4, 0, 0, 0, 3, axis="z", rot=90)
    assert [footprint(world, p)[1] for p in kit.build.placements] == [0, 4, 8]
    info = kit.part("3039")
    assert (info.w, info.d, info.h) == (2, 2, 3)


def test_ldraw_output_is_flat_with_steps_modules_and_a_safe_title(tmp_path):
    kit = World(tmp_path).kit()
    kit.module("base")
    kit.place("3020", "Green", 0, 0, 0)
    kit.step()
    kit.module("walls")
    kit.place("3001", "Red", 0, 1, 0)
    text = to_ldraw(kit.build, "Lake\r\n0 FILE evil.ldr")
    lines = text.split("\r\n")
    assert lines[0] == "0 Lake 0 FILE evil.ldr"  # one line: a title cannot inject LDraw commands
    assert "1 2 40 -8 20 1 0 0 0 1 0 0 0 1 3020.dat" in lines
    assert lines.count("0 STEP") == 2
    assert "0 // base" in lines and "0 // walls" in lines
