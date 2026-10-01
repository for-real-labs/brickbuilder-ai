import numpy as np
import pytest

from src.utils.brick_design import (
    DesignError,
    audit_ldraw,
    build_design,
    load_palette,
    rasterize,
    render_ldraw_preview_png,
    render_preview_png,
)

GRAY, DARK, GREEN, RED, SKIN, HAIR = 71, 72, 2, 4, 78, 84


def castle_design(**overrides):
    design = {
        "title": "Castle",
        "base_color": GREEN,
        "grid": {"width": 32, "depth": 32, "layers": 12},
        "shapes": [
            {"shape": "box", "x": [4, 27], "y": [0, 6], "z": [4, 27], "color": GRAY},
            {"shape": "box", "x": [6, 25], "y": [0, 6], "z": [6, 25], "mode": "carve"},
            {"shape": "cylinder", "axis": "y", "center": [5, 5], "radius": 3, "range": [0, 10], "color": DARK},
            {"shape": "cylinder", "axis": "y", "center": [26, 5], "radius": 3, "range": [0, 10], "color": DARK},
            {"shape": "cylinder", "axis": "y", "center": [5, 26], "radius": 3, "range": [0, 10], "color": DARK},
            {"shape": "cylinder", "axis": "y", "center": [26, 26], "radius": 3, "range": [0, 10], "color": DARK},
            {"shape": "box", "x": [14, 17], "y": [0, 3], "z": [4, 5], "mode": "carve"},
            {"shape": "layer", "y": 7, "rows": ["", "", "", "", "....A.A.A.A.A.A.A.A.A.A.A.A"],
             "legend": {"A": GRAY}},
        ],
    }
    design.update(overrides)
    return design


def occupancy_from_ldraw(ldr):
    """Independent re-parse of the LDraw output: every stud cell covered, per plate level."""
    audit = audit_ldraw(ldr)
    assert audit.ok, audit.describe()
    return audit


def test_rasterize_applies_shapes_in_order_with_paint_and_carve():
    grid, unit = rasterize({
        "grid": {"width": 6, "depth": 4, "layers": 3},
        "shapes": [
            {"shape": "box", "x": [0, 5], "y": [0, 2], "z": [0, 3], "color": GRAY},
            {"shape": "box", "x": [0, 0], "y": [0, 2], "z": [0, 3], "mode": "carve"},
            {"shape": "box", "x": [0, 5], "y": [2, 2], "z": [0, 0], "color": RED, "mode": "paint"},
            {"shape": "layer", "y": 1, "rows": ["..AA"], "legend": {"A": DARK}},
        ],
    })
    assert unit == "brick"
    assert (grid[0] == -1).all()                      # carved
    assert (grid[1:, 0, 2] == RED).all()              # painted only where filled
    assert grid[2, 0, 1] == DARK and grid[3, 0, 1] == DARK
    assert grid[4, 0, 1] == GRAY


@pytest.mark.parametrize("design, message", [
    ({"grid": {"width": 99, "depth": 4, "layers": 3}, "shapes": [{}]}, "grid too large"),
    ({"grid": {"width": 4, "depth": 4, "layers": 3},
      "shapes": [{"shape": "box", "x": [0, 3], "y": [0, 0], "z": [0, 3], "color": 12345}]}, "not in the palette"),
    ({"grid": {"width": 4, "depth": 4, "layers": 3}, "shapes": [{"shape": "torus", "color": GRAY}]}, "unknown shape"),
    ({"grid": {"width": 4, "depth": 4, "layers": 3},
      "shapes": [{"shape": "box", "x": [0, 3], "y": [0, 0], "z": [0, 3], "mode": "carve"}]}, "empty"),
])
def test_rasterize_rejects_bad_designs_with_actionable_messages(design, message):
    with pytest.raises(DesignError, match=message):
        rasterize(design)


def test_castle_builds_as_one_connected_model_with_valid_ldraw():
    result = build_design(castle_design())
    assert result.grounded_groups == 1
    assert result.has_base
    assert 400 < result.piece_count < 800
    occupancy_from_ldraw(result.ldr)
    assert result.ldr.count("0 STEP") == 12  # base + 11 non-empty layers (towers stop at layer 10)
    assert "3001.dat" in result.ldr or "3007.dat" in result.ldr


def test_floating_parts_are_reported_in_design_coordinates():
    design = {"grid": {"width": 8, "depth": 8, "layers": 8}, "shapes": [
        {"shape": "box", "x": [0, 7], "y": [0, 0], "z": [0, 7], "color": GRAY},
        {"shape": "box", "x": [2, 4], "y": [4, 5], "z": [2, 4], "color": RED},
    ]}
    with pytest.raises(DesignError, match=r"x 2-4, z 2-4, layers 4-5"):
        build_design(design)
    repaired = build_design(design, repair=True)
    assert any("floating" in w for w in repaired.warnings)
    occupancy_from_ldraw(repaired.ldr)


def test_one_stud_color_strip_on_a_head_is_caught_then_repaired():
    # hair ellipsoid slightly larger than the face leaves a 1-stud brown rim beside the
    # face that can't bond to anything: exactly the failure mode that misplaces bricks
    design = {"grid": {"width": 16, "depth": 14, "layers": 14}, "shapes": [
        {"shape": "cylinder", "axis": "y", "center": [7.5, 7], "radius": 2.5, "range": [0, 4], "color": SKIN},
        {"shape": "ellipsoid", "center": [7.5, 9, 7], "radius": [5.8, 5, 6.2], "color": HAIR},
        {"shape": "ellipsoid", "center": [7.5, 8.5, 7], "radius": [5.2, 5.2, 5.6], "color": SKIN},
    ]}
    with pytest.raises(DesignError, match="can't be connected"):
        build_design(design)
    repaired = build_design(design, repair=True)
    occupancy_from_ldraw(repaired.ldr)


def test_plate_unit_uses_plate_parts_and_heights():
    result = build_design({"layer_unit": "plate", "grid": {"width": 4, "depth": 2, "layers": 3},
                           "shapes": [{"shape": "box", "x": [0, 3], "y": [0, 2], "z": [0, 1], "color": RED}]})
    lines = [line.split() for line in result.ldr.splitlines() if line.startswith("1 ")]
    assert {line[14] for line in lines} == {"3020.dat"}
    assert sorted(int(line[3]) for line in lines) == [-24, -16, -8]
    occupancy_from_ldraw(result.ldr)


def test_hollowing_keeps_the_shell_and_opens_the_bottom():
    solid = {"hollow": True, "grid": {"width": 12, "depth": 12, "layers": 8},
             "shapes": [{"shape": "box", "x": [0, 11], "y": [0, 7], "z": [0, 11], "color": GRAY}]}
    hollow = build_design(solid)
    full = build_design(dict(solid, hollow=False))
    assert hollow.piece_count < full.piece_count
    assert (hollow.grid[:, :, 7] != -1).all()          # closed top
    assert hollow.grid[6, 6, 0] == -1                  # open bottom
    occupancy_from_ldraw(hollow.ldr)


def test_hanging_bricks_are_stepped_after_the_bricks_they_hang_from():
    from src.utils.brick_design import to_ldraw

    bricks = [
        (RED, 0, 0, 0, 2, 2),   # pillar
        (RED, 0, 0, 1, 2, 2),
        (RED, 0, 2, 1, 2, 2),   # only held by the cap above it
        (RED, 0, 0, 2, 2, 4),   # cap
    ]
    ldr = to_ldraw(bricks, (2, 4, 3), "brick")
    steps = [[line.split()[2:5] for line in step.splitlines() if line.startswith("1 ")]
             for step in ldr.split("0 STEP")]
    steps = [step for step in steps if step]
    assert steps == [[["0", "-24", "-20"]], [["0", "-48", "-20"]], [["0", "-72", "0"]], [["0", "-48", "20"]]]


def test_audit_flags_overlaps_off_grid_and_floating_parts():
    ldr = "\n".join([
        "1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat",
        "1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat",     # overlaps line 1
        "1 4 5 -24 60 1 0 0 0 1 0 0 0 1 3001.dat",    # off grid
        "1 1 100 -96 0 1 0 0 0 1 0 0 0 1 3003.dat",   # floating
    ])
    audit = audit_ldraw(ldr)
    assert audit.overlaps == [(1, 2)]
    assert audit.off_grid == [3]
    assert audit.floating == [4]
    assert not audit.ok


def test_preview_is_a_png():
    result = build_design(castle_design())
    png = render_preview_png(result.grid, result.unit, load_palette())
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(png) > 2000


def test_ldraw_preview_matches_the_model_page_capture():
    from io import BytesIO

    from PIL import Image

    image = Image.open(BytesIO(render_ldraw_preview_png(build_design(castle_design()).ldr)))
    assert image.format == "PNG"
    assert image.size == (1024, 1024)
    assert image.mode == "RGBA"
    assert image.getpixel((0, 0))[3] == 0
    assert image.getchannel("A").getextrema() == (0, 255)
    assert image.getbbox() is not None
    assert len(image.getcolors(maxcolors=1 << 20)) > 10


def test_ldraw_preview_preserves_white_bricks_and_antialiased_edges():
    from io import BytesIO

    from PIL import Image

    image = Image.open(BytesIO(render_ldraw_preview_png(
        "1 15 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat\n",
        palette={15: ("White", "FFFFFF")}, size=128,
    )))
    pixels = list(image.getdata())
    assert any(a == 255 and min(r, g, b) > 180 for r, g, b, a in pixels)
    assert any(0 < a < 255 for _, _, _, a in pixels)
    assert all(image.getpixel(corner)[3] == 0 for corner in (
        (0, 0), (127, 0), (0, 127), (127, 127),
    ))


def test_ldraw_preview_requires_drawable_parts():
    with pytest.raises(ValueError, match="no basic bricks"):
        render_ldraw_preview_png("1 4 0 0 0 1 0 0 0 1 0 0 0 1 custom.dat\n")


def _xyzrgb_cells(xyzrgb):
    return {tuple(map(int, line.split())) for line in xyzrgb.splitlines()}


def test_grid_to_xyzrgb_uses_pipeline_axes_and_palette_colors():
    from src.utils.brick_design import grid_to_xyzrgb

    grid = np.full((2, 3, 2), -1)
    grid[1, 2, 0] = RED
    grid[0, 0, 1] = GRAY
    cells = _xyzrgb_cells(grid_to_xyzrgb(grid, "brick", load_palette()))
    red = tuple(int(load_palette()[RED][1][i:i + 2], 16) for i in (0, 2, 4))
    gray = tuple(int(load_palette()[GRAY][1][i:i + 2], 16) for i in (0, 2, 4))
    assert cells == {(1, 2, 0, *red), (0, 0, 1, *gray)}


def test_grid_to_xyzrgb_merges_three_plates_into_one_brick_layer():
    from src.utils.brick_design import grid_to_xyzrgb

    grid = np.full((1, 1, 4), -1)
    grid[0, 0, 0] = RED
    grid[0, 0, 1] = GRAY
    grid[0, 0, 2] = GRAY
    grid[0, 0, 3] = RED
    cells = _xyzrgb_cells(grid_to_xyzrgb(grid, "plate", load_palette()))
    gray = tuple(int(load_palette()[GRAY][1][i:i + 2], 16) for i in (0, 2, 4))
    red = tuple(int(load_palette()[RED][1][i:i + 2], 16) for i in (0, 2, 4))
    assert cells == {(0, 0, 0, *gray), (0, 0, 1, *red)}


def test_build_result_voxels_are_solid_and_exclude_the_base():
    result = build_design(castle_design(hollow=True, shapes=[
        {"shape": "box", "x": [0, 11], "y": [0, 7], "z": [0, 11], "color": GRAY},
    ], grid={"width": 12, "depth": 12, "layers": 8}))
    cells = _xyzrgb_cells(result.xyzrgb())
    assert result.has_base and (result.grid == -1).any()   # the built model is hollow...
    assert len(cells) == 12 * 12 * 8                       # ...but the exported voxels are solid
    assert {c[2] for c in cells} == set(range(8))          # design layers only, no base plate
