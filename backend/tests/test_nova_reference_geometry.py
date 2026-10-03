import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from src.utils import nova_geometry
from src.utils.nova_geometry import LDrawMeshRenderer


IDENTITY = "1 0 0 0 1 0 0 0 1"


def placement(reference, colour=16, position="0 0 0", matrix=IDENTITY):
    return f"1 {colour} {position} {matrix} {reference}"


@pytest.fixture
def source_library(tmp_path):
    (tmp_path / "parts").mkdir()
    (tmp_path / "p").mkdir()
    (tmp_path / "LDConfig.ldr").write_text(
        "0 !COLOUR Red CODE 4 VALUE #FF0000 EDGE #333333\n"
        "0 !COLOUR Blue CODE 1 VALUE #0000FF EDGE #333333\n"
    )
    (tmp_path / "parts" / "slope.dat").write_text(
        placement("inclined.dat") + "\n"
    )
    (tmp_path / "p" / "inclined.dat").write_text(
        "3 16 -20 0 -10 20 -30 -10 20 0 10\n"
        "3 16 -20 0 -10 20 0 10 -20 0 10\n"
    )
    return tmp_path


def test_render_source_uses_embedded_names_transforms_and_inherited_colours(source_library):
    # Virtual names are opaque MPD identifiers. They may be DAT definitions,
    # contain spaces and folders, and use either LDraw path separator.
    source = "\n".join([
        "0 FILE explicit wrapper.ldr",
        placement("assemblies/Lookout Tower.ldr", colour=4, position="100 0 20",
                  matrix="0 0 1 0 1 0 -1 0 0"),
        "0 FILE assemblies/Lookout Tower.ldr",
        placement(r"custom\roof shape.dat", position="0 -10 0"),
        "0 FILE custom/roof shape.dat",
        "4 16 -20 0 -10 20 0 -10 20 -30 10 -20 -30 10",
        "3 0x20000FF -10 -10 0 10 -10 0 0 -20 5",
        "0 NOFILE",
    ])
    png, report = LDrawMeshRenderer(source_library).render_mpd(source, size=128)
    assert Image.open(io.BytesIO(png)).size == (256, 128)
    assert report == {
        "part_count": 1,
        "triangle_count": 3,
        "source_instance_count": 2,
        "bounds": {"min": [90.0, -40.0, 0.0], "max": [110.0, -10.0, 40.0]},
        "rendered_colours": [4, 0x20000FF],
    }
    pixels = np.asarray(Image.open(io.BytesIO(png)), dtype=int)
    assert np.count_nonzero(pixels[..., 0] > pixels[..., 1] + 20) > 100
    assert np.count_nonzero(pixels[..., 2] > pixels[..., 0] + 20) > 30


def test_render_source_uses_library_slope_mesh_and_reports_original_bounds(source_library):
    source = "0 FILE wrapper.ldr\n" + placement("slope.dat", colour=4, position="100 -24 20")
    png, report = LDrawMeshRenderer(source_library).render_mpd(source, size=100, two_views=False)
    assert Image.open(io.BytesIO(png)).size == (100, 100)
    assert report["triangle_count"] == 2
    assert report["part_count"] == 1
    assert report["bounds"] == {"min": [80.0, -54.0, 10.0], "max": [120.0, -24.0, 30.0]}
    assert report["rendered_colours"] == [4]


def test_source_without_explicit_wrapper_does_not_guess_inherited_colour(source_library):
    _, report = LDrawMeshRenderer(source_library).render_mpd(placement("slope.dat"), size=64)
    assert report["rendered_colours"] == [16]


def test_source_inherits_direct_rgb_from_explicit_wrapper(source_library):
    source = "\n".join([
        "0 FILE wrapper.ldr", placement("embedded part.dat", colour="0x2FF0000"),
        "0 FILE embedded part.dat", placement("slope.dat"),
    ])
    _, report = LDrawMeshRenderer(source_library).render_mpd(source, size=64)
    assert report["rendered_colours"] == [0x2FF0000]
    assert report["part_count"] == 1


def test_virtual_dat_shadows_disk_definition_without_writing_a_file(source_library):
    source = "\n".join([
        "0 FILE wrapper.ldr", placement("slope.dat", colour=1),
        "0 FILE slope.dat", "3 16 0 0 0 10 -10 0 0 0 10",
    ])
    before = (source_library / "parts" / "slope.dat").read_text()
    _, report = LDrawMeshRenderer(source_library).render_mpd(source, size=64)
    assert report["triangle_count"] == 1
    assert report["bounds"] == {"min": [0.0, -10.0, 0.0], "max": [10.0, 0.0, 10.0]}
    assert (source_library / "parts" / "slope.dat").read_text() == before
    assert not (source_library / "slope.dat").exists()


@pytest.mark.parametrize("source,message", [
    ("0 FILE root.ldr\n0 FILE ROOT.LDR", "Duplicate"),
    ("0 FILE root.ldr\n" + placement("root.ldr"), "Cyclic"),
    ("0 FILE root.ldr\n" + placement("missing.ldr"), "Missing"),
    ("0 FILE root.ldr\n" + placement("missing.dat"), "missing"),
    ("0 FILE root.ldr\n" + placement("../secret.dat"), "Unsafe"),
    ("0 FILE root.ldr\n" + placement(r"folder\..\secret.dat"), "Unsafe"),
    ("0 FILE /absolute.ldr", "Unsafe"),
    ("0 FILE C:\\absolute.ldr", "Unsafe"),
    ("0 FILE root.ldr\n" + placement("slope.dat", position="nan 0 0"), "coordinates"),
    ("0 FILE root.ldr\n" + placement("slope.dat", position="1000001 0 0"), "coordinates"),
    ("3 4 0 0 0 10 inf 0 0 0 10", "coordinates"),
    ("4 4 0 0 0 10 0 0 0 0 10", "Incomplete"),
    ("0 FILE root.ldr\n0 NOFILE\n" + placement("slope.dat"), "outside"),
    ("3 -1 0 0 0 10 0 0 0 0 10", "colour"),
])
def test_render_source_rejects_invalid_or_unsafe_inputs(source_library, source, message):
    with pytest.raises(ValueError, match=message):
        LDrawMeshRenderer(source_library).render_mpd(source, size=64)


def test_library_symlink_cannot_escape_reference_geometry_root(source_library, tmp_path):
    secret = tmp_path.parent / f"{tmp_path.name}-outside.dat"
    secret.write_text("3 4 0 0 0 10 0 0 0 0 10")
    (source_library / "parts" / "escape.dat").symlink_to(secret)
    with pytest.raises(ValueError, match="missing"):
        LDrawMeshRenderer(source_library).render_mpd(placement("escape.dat"), size=64)


def test_render_source_rejects_library_cycles(source_library):
    (source_library / "parts" / "cycle.dat").write_text(placement("cycle.dat"))
    with pytest.raises(ValueError, match="Cyclic"):
        LDrawMeshRenderer(source_library).render_mpd(placement("cycle.dat"), size=64)


def test_visible_source_cannot_hide_an_empty_official_part(source_library):
    (source_library / "parts" / "empty.dat").write_text("0 Empty part\n")
    source = "\n".join([
        "0 FILE wrapper.ldr", placement("slope.dat", colour=4), placement("empty.dat"),
    ])
    with pytest.raises(ValueError, match="no renderable geometry faces: empty.dat"):
        LDrawMeshRenderer(source_library).render_mpd(source, size=64)


def test_visible_source_cannot_hide_an_empty_embedded_dat(source_library):
    source = "\n".join([
        "0 FILE wrapper.ldr", placement("slope.dat", colour=4),
        placement("custom/empty part.dat"), "0 FILE custom/empty part.dat",
        "2 16 0 0 0 10 10 10",  # Edges alone cannot produce a mesh preview.
    ])
    with pytest.raises(ValueError, match="no renderable geometry faces: custom/empty part.dat"):
        LDrawMeshRenderer(source_library).render_mpd(source, size=64)


def test_render_source_checks_transformed_coordinates(source_library):
    source = "\n".join([
        "0 FILE root.ldr", placement("child.ldr", position="1000000 0 0"),
        "0 FILE child.ldr", placement("slope.dat", position="1000000 0 0"),
    ])
    with pytest.raises(ValueError, match="transformed.*coordinates"):
        LDrawMeshRenderer(source_library).render_mpd(source, size=64)


def test_render_source_enforces_part_face_and_text_budgets(source_library, monkeypatch):
    renderer = LDrawMeshRenderer(source_library)
    repeated_parts = "\n".join([placement("slope.dat")] * 3)
    with pytest.raises(ValueError, match="2-part"):
        renderer.render_mpd(repeated_parts, max_parts=2, size=64)
    monkeypatch.setattr(nova_geometry, "MAX_FACES", 3)
    with pytest.raises(ValueError, match="face preview budget"):
        renderer.render_mpd("\n".join([placement("slope.dat")] * 2), size=64)
    monkeypatch.setattr(nova_geometry, "MAX_REFERENCE_SOURCE_BYTES", 30)
    with pytest.raises(ValueError, match="4 MB"):
        renderer.render_mpd(repeated_parts, size=64)


def test_render_source_bounds_virtual_expansion_even_when_no_parts_are_added(source_library, monkeypatch):
    source = "\n".join([
        "0 FILE root.ldr", placement("empty.ldr"), placement("empty.ldr"),
        placement("empty.ldr"), "0 FILE empty.ldr", "0 No geometry",
    ])
    monkeypatch.setattr(nova_geometry, "MAX_REFERENCE_INSTANCES", 2)
    with pytest.raises(ValueError, match="instance preview budget"):
        LDrawMeshRenderer(source_library).render_mpd(source, max_parts=2, size=64)


def test_render_source_rejects_excessive_virtual_nesting(source_library):
    source = "\n".join(
        f"0 FILE level-{level}.ldr\n" + placement(f"level-{level + 1}.ldr")
        for level in range(41)
    ) + "\n0 FILE level-41.ldr\n" + placement("slope.dat")
    with pytest.raises(ValueError, match="excessively nested"):
        LDrawMeshRenderer(source_library).render_mpd(source, size=64)


@pytest.mark.parametrize("options", [{"max_parts": 0}, {"max_parts": 10001},
                                      {"size": 4096}, {"two_views": "yes"}])
def test_render_source_rejects_unbounded_render_options(source_library, options):
    with pytest.raises(ValueError):
        LDrawMeshRenderer(source_library).render_mpd(placement("slope.dat"), **options)


@pytest.mark.skipif(not (Path.home() / "ldraw" / "parts" / "3039.dat").is_file(),
                    reason="Official LDraw library is not installed")
def test_reference_preview_renders_an_actual_official_slope():
    _, report = LDrawMeshRenderer(Path.home() / "ldraw").render_mpd(
        "0 FILE wrapper.ldr\n" + placement("3039.dat", colour=320), size=64,
    )
    assert report["part_count"] == 1
    assert report["triangle_count"] > 20
    assert report["bounds"] == {"min": [-20.0, -4.0, -30.0], "max": [20.0, 24.0, 10.0]}
    assert report["rendered_colours"] == [320]
