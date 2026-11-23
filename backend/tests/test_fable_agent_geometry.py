import numpy as np
import pytest
from fable_agent.catalog import PartFinder
from fable_agent.ldraw import LDrawError, LDrawLibrary, PartGeometry, normalize_part_id
from fable_agent.palette import OpenPalette
from fable_agent.shape import ShapeLibrary, compute_shape

from fable_agent_support import World


def test_library_reads_colors_descriptions_and_follows_moved_parts(tmp_path):
    world = World(tmp_path)
    assert world.library.colors()[379].name == "Sand_Blue"
    assert world.library.description("3001") == "Brick 2 x 4"
    assert world.library.description("3660") == "Slope Brick 45 2 x 2"
    assert world.shapes.get("3660").boxes == world.shapes.get("3039").boxes


def test_library_rejects_missing_roots_unknown_parts_and_unsafe_ids(tmp_path):
    with pytest.raises(LDrawError):
        LDrawLibrary(tmp_path / "nowhere")
    world = World(tmp_path)
    with pytest.raises(LDrawError):
        world.library.geometry("9999")
    for unsafe in ("../secrets", "a/b", "", "3001;rm"):
        with pytest.raises(LDrawError):
            normalize_part_id(unsafe)
    assert normalize_part_id("parts\\3001.DAT") == "3001"


def test_a_hollow_brick_is_measured_as_one_solid_box_with_its_studs(tmp_path):
    shape = World(tmp_path).shapes.get("3001")
    assert (shape.width, shape.depth, shape.height) == (4, 2, 3)
    # The underside cavity is walled in on every side, so the basin fill closes it.
    assert shape.boxes == ((-40.0, 0.0, -20.0, 40.0, 24.0, 20.0),)
    assert len(shape.up_studs()) == 8
    assert shape.up_studs()[0] == (0.5, 0.5, 3.0)
    assert shape.front_yaw == 0


def test_a_slope_keeps_its_profile_and_faces_downhill(tmp_path):
    shape = World(tmp_path).shapes.get("3039")
    assert shape.front_yaw == 0  # low edge at -z, as authored
    front_row = [column[0] for column in shape.top]
    back_row = [column[-1] for column in shape.top]
    assert all(value > 8 for value in front_row)  # well below the top
    assert all(value == 0 for value in back_row)
    assert len(shape.boxes) > 1
    assert shape.up_studs() == [(0.5, 1.5, 3.0), (1.5, 1.5, 3.0)]


def test_an_arch_span_stays_open_underneath(tmp_path):
    shape = World(tmp_path).shapes.get("3659")
    middle = shape.bottom[len(shape.bottom) // 2][0]
    leg = shape.bottom[0][0]
    assert leg == 24 and middle == 8


def test_boxes_stop_at_the_edge_of_parts_that_are_not_whole_cells_wide():
    corners = [(-12.5, 0, -3), (12.5, 0, -3), (12.5, 0, 3), (-12.5, 0, 3)]
    top = [[corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]]]
    bottom = [[(x, 30, z) for x, _, z in triangle] for triangle in top]
    shape = compute_shape("pane", PartGeometry(np.array(top + bottom, dtype=float), np.zeros((0, 6))))
    assert (shape.width, shape.depth) == (1.25, 0.3)
    assert max(box[3] for box in shape.boxes) == 12.5 and max(box[5] for box in shape.boxes) == 3
    assert not shape.directional


def test_tiles_have_no_studs(tmp_path):
    assert World(tmp_path).shapes.get("3070b").up_studs() == []


def test_shapes_survive_a_disk_cache_round_trip(tmp_path):
    world = World(tmp_path)
    first = ShapeLibrary(world.library, tmp_path / "cache").get("3039")
    cached = list((tmp_path / "cache").rglob("3039-*.json"))
    assert len(cached) == 1
    assert ShapeLibrary(world.library, tmp_path / "cache").get("3039") == first
    cached[0].write_text("not json")  # a damaged cache entry is recomputed, not trusted
    assert ShapeLibrary(world.library, tmp_path / "cache").get("3039") == first


def test_search_ranks_exact_sizes_first_and_filters_by_color(tmp_path):
    world = World(tmp_path, skip={("3039", 4)})
    assert world.finder.search("brick 2x4")[0].part_id == "3001"
    assert world.finder.search("roof")[0].part_id == "3039"  # synonym for slope
    assert world.finder.search("smooth 1 x 1")[0].part_id == "3070b"
    assert all(entry.part_id != "3039" for entry in world.finder.search("slope", color=4))
    assert world.finder.search("zeppelin") == []


def test_basic_families_and_starter_sheet_come_from_the_catalog(tmp_path):
    world = World(tmp_path)
    assert ("3001", 2, 4) in world.finder.basic_family("brick")
    assert world.finder.basic_alternatives("tile") == {(1, 1): ["3070b"]}
    sheet = world.finder.sheet()
    assert "Brick: " in sheet and "3001" in sheet and "Arch" in sheet
    assert "379 Sand_Blue" in world.finder.color_sheet()


def test_open_palette_allows_library_parts_in_standard_colors_only(tmp_path):
    world = World(tmp_path)
    palette = OpenPalette(world.library)
    assert palette.allows("3001", 4)
    assert not palette.allows("3001", 16)  # the inherited color is not a real color
    assert not palette.allows("9999", 4)
    assert "3001" in PartFinder(world.library, palette).sheet()
