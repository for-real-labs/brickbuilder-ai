import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from src.utils.nova_geometry import LDrawMeshRenderer, flatten_mpd


def test_flatten_expands_nested_rotations_colours_and_steps():
    source = """0 FILE main.ldr
1 4 100 0 20 0 0 1 0 1 0 -1 0 0 tower.ldr
0 STEP
0 FILE tower.ldr
1 16 20 -24 0 1 0 0 0 1 0 0 0 1 3001.dat
1 14 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat
0 NOFILE
"""
    flat = flatten_mpd(source)
    assert "1 4 100 -24 0 0 0 1 0 1 0 -1 0 0 3001.dat" in flat
    assert "1 14 100 0 20 0 0 1 0 1 0 -1 0 0 3020.dat" in flat
    assert "0 STEP" in flat
    assert "0 FILE" not in flat


@pytest.mark.parametrize("source,message", [
    ("0 FILE ../bad.ldr", "Unsafe"),
    ("0 FILE a.ldr\n0 FILE A.ldr", "Duplicate"),
    ("0 FILE a.ldr\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 a.ldr", "Cyclic"),
    ("0 FILE a.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 missing.ldr", "Missing"),
    ("0 FILE a.ldr\n1 4 nan 0 0 1 0 0 0 1 0 0 0 1 3001.dat", "coordinates"),
    ("0 FILE a.ldr\n3 4 0 0 0 1 0 0 0 1 0", "only contain"),
])
def test_flatten_rejects_unsafe_or_incomplete_assemblies(source, message):
    with pytest.raises(ValueError, match=message):
        flatten_mpd(source)


def test_flatten_enforces_physical_part_budget():
    part = "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat"
    with pytest.raises(ValueError, match="part limit"):
        flatten_mpd("0 FILE main.ldr\n" + "\n".join([part] * 3), max_parts=2)


@pytest.fixture
def mesh_library(tmp_path):
    (tmp_path / "parts").mkdir()
    (tmp_path / "p").mkdir()
    (tmp_path / "LDConfig.ldr").write_text("0 !COLOUR Red CODE 4 VALUE #FF0000 EDGE #333333\n")
    # An inclined custom fixture verifies that arbitrary part mesh geometry is
    # rendered, even when it is absent from BrickBuilder's rectangular palette.
    (tmp_path / "parts" / "slope.dat").write_text(
        "0 Inclined test part\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 wedge.dat\n")
    (tmp_path / "p" / "wedge.dat").write_text(
        "3 16 -20 0 -10 20 -30 -10 20 0 10\n"
        "3 16 -20 0 -10 20 0 10 -20 0 10\n")
    return tmp_path


def test_mesh_renderer_draws_specialized_parts_in_both_views(mesh_library):
    renderer = LDrawMeshRenderer(mesh_library)
    png = renderer.render("1 4 0 0 0 1 0 0 0 1 0 0 0 1 slope.dat\n", size=180)
    image = Image.open(io.BytesIO(png))
    assert image.size == (360, 180)
    pixels = np.asarray(image, dtype=int)
    for half in (pixels[:, :180], pixels[:, 180:]):
        assert np.count_nonzero(half[..., 0] > half[..., 1] + 20) > 100


def test_geometry_library_references_cannot_escape_the_library(mesh_library):
    renderer = LDrawMeshRenderer(mesh_library)
    with pytest.raises(ValueError, match="Unsafe"):
        renderer._mesh("../../secret.dat")
    (mesh_library / "parts" / "cycle.dat").write_text("1 16 0 0 0 1 0 0 0 1 0 0 0 1 cycle.dat")
    with pytest.raises(ValueError, match="Cyclic"):
        renderer._mesh("cycle.dat")


def test_mesh_renderer_preserves_direct_rgb_pattern_colours(mesh_library):
    (mesh_library / "parts" / "pattern.dat").write_text("3 0x2FF0000 -20 0 -10 20 -30 -10 20 0 10\n")
    renderer = LDrawMeshRenderer(mesh_library)
    png = renderer.render("1 7 0 0 0 1 0 0 0 1 0 0 0 1 pattern.dat\n", size=100, two_views=False)
    pixels = np.asarray(Image.open(io.BytesIO(png)), dtype=int)
    assert np.count_nonzero(pixels[..., 0] > pixels[..., 1] + 20) > 100
