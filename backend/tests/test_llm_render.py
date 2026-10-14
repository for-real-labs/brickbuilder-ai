import asyncio
import base64
import importlib
import json
import sys
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.requests.llmRender import (
    DEFAULT_SEGMENTATION_ROUNDS,
    MAX_REFERENCE_IMAGES,
    MAX_SEGMENTATION_ROUNDS_LIMIT,
    MAX_SPLIT_PIECES,
    SEGMENT_PALETTE,
    VIEWS,
    LlmRenderRequest,
    _apply_assignments,
    _apply_segmentation_review,
    _assignment_schema,
    _build_scene_summary,
    _build_voxel_preview_data_url,
    _call_openai_for_segmentation_review,
    _extract_thinking_delta,
    _extract_visible_text_delta,
    _geometric_regions,
    _load_font,
    LlmRenderResponse,
    llm_render,
    llm_render_stream,
    _partition_signature,
    _perceptual_colors,
    _project_segments,
    _quantize_colors,
    _reference_images_description,
    _render_view_tile,
    _rgb_to_lab,
    _segment_voxels,
    _segmentation_review_loop,
    _segmentation_review_schema,
    _voxel_arrays,
)

llm_render_module = importlib.import_module("src.requests.llmRender")


def test_render_defaults_to_opus_5_5():
    assert llm_render_module.DEFAULT_MODEL == 'claude-opus-5-5'


def _block(x_range, y_range, z_range, color):
    return [
        {"x": x, "y": y, "z": z, "r": color[0], "g": color[1], "b": color[2]}
        for x in range(*x_range)
        for y in range(*y_range)
        for z in range(*z_range)
    ]


def _sphere(center, radius, color):
    cx, cy, cz = center
    return [
        {"x": x, "y": y, "z": z, "r": color[0], "g": color[1], "b": color[2]}
        for x in range(cx - radius, cx + radius + 1)
        for y in range(cy - radius, cy + radius + 1)
        for z in range(cz - radius, cz + radius + 1)
        if (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= radius * radius
    ]


YELLOW = (245, 205, 47)


def _same_color_figure(color=YELLOW):
    """Body, thin neck, head and a thin arm, all one colour, so only geometry can
    tell the parts apart."""
    body = _block((0, 10), (0, 10), (0, 12), color)
    neck = _block((3, 7), (3, 7), (12, 14), color)
    head = _block((1, 9), (1, 9), (14, 22), color)
    arm = _block((10, 18), (3, 6), (6, 9), color)
    return body + neck + head + arm


def _segments_of(voxels, segment_ids, predicate):
    coords, _ = _voxel_arrays(voxels)
    mask = np.array([predicate(x, y, z) for x, y, z in coords.tolist()])
    return set(segment_ids[mask].tolist())


def _segments_with_color(voxels, segment_ids, color):
    _, colors = _voxel_arrays(voxels)
    return set(segment_ids[np.all(colors == color, axis=1)].tolist())


BLACK = (20, 20, 20)
MOUTH = (120, 20, 30)
BLUE = (30, 90, 200)
WHITE = (240, 240, 240)
RED = (200, 30, 30)


def _detailed_shell_figure():
    """Hollow figure in the style of generated models: a yellow head sphere on a
    red body, both with smooth baked shading, plus two black 2x2 eyes, a 4-voxel
    mouth, three 2-voxel blue buttons and a 3x3 white logo. Details are 4-9 voxels
    in a ~1000-voxel model, i.e. well below the 0.5% speckle threshold."""
    voxels = {}

    def shade(color, x, z):
        factor = 0.7 + 0.3 * ((x + 1) / 14.0 * 0.5 + (z + 3) / 30.0 * 0.5)
        return tuple(int(round(channel * factor)) for channel in color)

    for x in range(12):
        for y in range(8):
            for z in range(14):
                if x in (0, 11) or y in (0, 7) or z in (0, 13):
                    voxels[(x, y, z)] = shade(RED, x, z)
    cx, cy, cz, radius = 5.5, 3.5, 20, 6
    for x in range(-1, 13):
        for y in range(-3, 11):
            for z in range(14, 27):
                distance = ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) ** 0.5
                if radius - 1.2 <= distance <= radius:
                    voxels[(x, y, z)] = shade(YELLOW, x, z)

    def paint_front(x, z, color):
        for y in range(-3, 11):
            if (x, y, z) in voxels:
                voxels[(x, y, z)] = color
                return

    for x, z in [(3, 21), (4, 21), (3, 22), (4, 22), (7, 21), (8, 21), (7, 22), (8, 22)]:
        paint_front(x, z, BLACK)
    for x in range(4, 8):
        paint_front(x, 18, MOUTH)
    for z in (4, 7, 10):
        voxels[(5, 0, z)] = BLUE
        voxels[(6, 0, z)] = BLUE
    for x in range(7, 10):
        for z in range(8, 11):
            voxels[(x, 0, z)] = WHITE
    return [{"x": x, "y": y, "z": z, "r": c[0], "g": c[1], "b": c[2]} for (x, y, z), c in voxels.items()]


def _two_part_model():
    """A 'body' block with a differently coloured 'head' block stacked on top,
    plus a few noisy voxels inside the body that should be absorbed."""
    body = _block((0, 6), (0, 6), (0, 6), (120, 60, 20))
    head = _block((1, 5), (1, 5), (6, 10), (140, 200, 90))
    for index, voxel in enumerate(body):
        if index % 40 == 0:
            voxel["r"], voxel["g"], voxel["b"] = 90, 90, 90
    return body + head


def test_segment_voxels_splits_by_color_region_and_absorbs_noise():
    voxels = _two_part_model()
    segment_ids = _segment_voxels(voxels, max_segments=16)

    assert segment_ids.min() == 1
    assert segment_ids.max() == 2
    coords, _ = _voxel_arrays(voxels)
    body_segment = segment_ids[coords[:, 2] < 6]
    head_segment = segment_ids[coords[:, 2] >= 6]
    assert len(set(body_segment.tolist())) == 1
    assert len(set(head_segment.tolist())) == 1
    assert body_segment[0] != head_segment[0]
    # Segment 1 is always the largest.
    assert body_segment[0] == 1


def test_segment_voxels_respects_max_segments():
    voxels = []
    for index in range(8):
        voxels += _block((index * 3, index * 3 + 3), (0, 3), (0, 3), (index * 30, 255 - index * 30, 40))
    segment_ids = _segment_voxels(voxels, max_segments=3)
    assert segment_ids.max() == 3
    assert set(np.unique(segment_ids).tolist()) == {1, 2, 3}


def test_segment_voxels_single_color_model_is_one_segment():
    voxels = _block((0, 4), (0, 4), (0, 4), (10, 20, 30))
    segment_ids = _segment_voxels(voxels, max_segments=16)
    assert segment_ids.max() == 1


def test_rgb_to_lab_matches_reference_values():
    lab = _rgb_to_lab(np.array([(255, 255, 255), (0, 0, 0), (255, 0, 0)], dtype=np.float64))
    assert np.allclose(lab[0], (100.0, 0.0, 0.0), atol=1e-3)
    assert np.allclose(lab[1], (0.0, 0.0, 0.0), atol=1e-6)
    assert np.allclose(lab[2], (53.24, 80.09, 67.20), atol=0.05)


def test_geometric_regions_split_at_necks_and_thickness_changes():
    voxels = _same_color_figure()
    coords, _ = _voxel_arrays(voxels)
    regions = _geometric_regions(coords)

    assert len(np.unique(regions)) == 3
    head = set(regions[coords[:, 2] >= 14].tolist())
    body_core = set(regions[(coords[:, 2] < 12) & (coords[:, 0] < 8)].tolist())
    arm_tip = set(regions[coords[:, 0] >= 14].tolist())
    assert len(head) == 1 and len(body_core) == 1 and len(arm_tip) == 1
    assert head != body_core and arm_tip != body_core


def test_geometric_regions_do_not_split_on_bumps_or_steps():
    bumpy_sphere = _sphere((0, 0, 0), 8, YELLOW) + _block((-1, 2), (-1, 2), (8, 10), YELLOW)
    slab_with_step = _block((0, 20), (0, 20), (0, 6), YELLOW) + _block((0, 20), (0, 10), (6, 8), YELLOW)
    l_shape = _block((0, 20), (0, 6), (0, 6), YELLOW) + _block((0, 6), (6, 20), (0, 6), YELLOW)

    for voxels in (bumpy_sphere, slab_with_step, l_shape):
        coords, _ = _voxel_arrays(voxels)
        assert len(np.unique(_geometric_regions(coords))) == 1


def test_geometric_regions_split_touching_spheres():
    coords, _ = _voxel_arrays(_sphere((0, 0, 0), 6, YELLOW) + _sphere((0, 0, 9), 4, YELLOW))
    regions = _geometric_regions(coords)
    assert len(np.unique(regions)) == 2
    assert set(regions[coords[:, 2] <= 4].tolist()) != set(regions[coords[:, 2] >= 7].tolist())


def test_segment_voxels_splits_same_colored_parts_by_geometry():
    voxels = _same_color_figure()
    segment_ids = _segment_voxels(voxels, max_segments=16)

    head = _segments_of(voxels, segment_ids, lambda x, y, z: z >= 14)
    body = _segments_of(voxels, segment_ids, lambda x, y, z: z < 12 and x < 8)
    assert len(head) == 1 and len(body) == 1
    assert head != body


def test_segment_voxels_merges_shading_before_distinct_dark_colors():
    """Under budget pressure, the lit/shaded halves of a grey bar must merge with
    each other rather than black merging with dark brown, which is what a plain
    RGB distance would pick."""
    grey, shaded_grey, black, brown = (150, 150, 150), (112, 112, 112), (30, 30, 30), (70, 45, 25)
    voxels = (
        _block((0, 6), (0, 4), (0, 4), grey)
        + _block((6, 12), (0, 4), (0, 4), shaded_grey)
        + _block((12, 18), (0, 4), (0, 4), black)
        + _block((18, 24), (0, 4), (0, 4), brown)
    )
    segment_ids = _segment_voxels(voxels, max_segments=3)

    grey_segment = _segments_of(voxels, segment_ids, lambda x, y, z: x < 6)
    shaded_segment = _segments_of(voxels, segment_ids, lambda x, y, z: 6 <= x < 12)
    black_segment = _segments_of(voxels, segment_ids, lambda x, y, z: 12 <= x < 18)
    brown_segment = _segments_of(voxels, segment_ids, lambda x, y, z: x >= 18)
    assert grey_segment == shaded_segment
    assert black_segment != brown_segment
    assert black_segment != grey_segment


def test_segment_voxels_prefers_merging_shading_over_crossing_a_neck():
    """Same-coloured head and body separated by a neck, with a shaded patch on
    the body. With room for only two segments, the shaded patch should rejoin
    the body and the head should stay its own segment."""
    shaded = (184, 154, 35)
    body = _block((0, 10), (0, 10), (0, 10), YELLOW)
    for voxel in body:
        if voxel["x"] >= 7:
            voxel["r"], voxel["g"], voxel["b"] = shaded
    neck = _block((4, 6), (4, 6), (10, 11), YELLOW)
    head = _block((2, 8), (2, 8), (11, 17), YELLOW)
    voxels = body + neck + head

    unbudgeted = _segment_voxels(voxels, max_segments=16)
    assert unbudgeted.max() == 3

    segment_ids = _segment_voxels(voxels, max_segments=2)
    assert segment_ids.max() == 2
    assert len(_segments_of(voxels, segment_ids, lambda x, y, z: z < 10)) == 1
    assert _segments_of(voxels, segment_ids, lambda x, y, z: z >= 11) != _segments_of(
        voxels, segment_ids, lambda x, y, z: z < 10
    )


def test_quantize_colors_gives_small_distinct_colors_their_own_cluster():
    """A handful of black voxels among a thousand shaded-yellow ones carry almost
    no weight, but must still end up in a cluster of their own."""
    shades = np.array([(245 - i % 40, 205 - i % 40, 47) for i in range(1000)], dtype=np.float64)
    black = np.array([BLACK] * 8, dtype=np.float64)
    labels = _quantize_colors(_perceptual_colors(np.vstack([shades, black])), clusters=10)

    black_labels = set(labels[1000:].tolist())
    assert len(black_labels) == 1
    assert not black_labels & set(labels[:1000].tolist())


def test_segment_voxels_keeps_small_high_contrast_details():
    voxels = _detailed_shell_figure()
    segment_ids = _segment_voxels(voxels, max_segments=16)

    eyes = _segments_with_color(voxels, segment_ids, BLACK)
    mouth = _segments_with_color(voxels, segment_ids, MOUTH)
    buttons = _segments_with_color(voxels, segment_ids, BLUE)
    logo = _segments_with_color(voxels, segment_ids, WHITE)
    # Each detail is exactly one segment, disconnected pieces grouped by colour.
    assert len(eyes) == len(mouth) == len(buttons) == len(logo) == 1
    assert len(eyes | mouth | buttons | logo) == 4
    # ...and that segment contains nothing but the detail.
    for detail, color in ((eyes, BLACK), (mouth, MOUTH), (buttons, BLUE), (logo, WHITE)):
        _, colors = _voxel_arrays(voxels)
        members = colors[segment_ids == next(iter(detail))]
        assert np.all(members == color)


def test_segment_voxels_sacrifices_shading_before_details_under_budget():
    voxels = _detailed_shell_figure()
    segment_ids = _segment_voxels(voxels, max_segments=6)

    assert segment_ids.max() == 6
    details = [
        _segments_with_color(voxels, segment_ids, color) for color in (BLACK, MOUTH, BLUE, WHITE)
    ]
    assert all(len(detail) == 1 for detail in details)
    assert len(set().union(*details)) == 4
    head = _segments_of(voxels, segment_ids, lambda x, y, z: z >= 14)
    body = _segments_of(voxels, segment_ids, lambda x, y, z: z < 14)
    assert len(head - set().union(*details)) == 1
    assert len(body - set().union(*details)) == 1


def test_segment_voxels_absorbs_isolated_noise_voxels():
    """Lone off-colour voxels are texture noise, not details, even when several
    of them share a colour."""
    voxels = _block((0, 8), (0, 8), (0, 8), YELLOW)
    for index in (0, 77, 155, 233, 311):
        voxels[index]["r"], voxels[index]["g"], voxels[index]["b"] = BLACK
    segment_ids = _segment_voxels(voxels, max_segments=16)
    assert segment_ids.max() == 1


def test_build_scene_summary_flags_details_and_island_counts():
    voxels = _detailed_shell_figure()
    segment_ids = _segment_voxels(voxels, max_segments=16)
    summary = _build_scene_summary(voxels, segment_ids)
    by_id = {segment["id"]: segment for segment in summary["segments"]}

    eyes = by_id[next(iter(_segments_with_color(voxels, segment_ids, BLACK)))]
    buttons = by_id[next(iter(_segments_with_color(voxels, segment_ids, BLUE)))]
    logo = by_id[next(iter(_segments_with_color(voxels, segment_ids, WHITE)))]
    assert eyes["is_detail"] and eyes["island_count"] == 2
    assert buttons["is_detail"] and buttons["island_count"] == 3
    assert logo["is_detail"] and logo["island_count"] == 1
    assert "details" in summary
    big = max(summary["segments"], key=lambda s: s["voxel_count"])
    assert not big["is_detail"]


def test_render_view_tile_keeps_small_segments_visible_under_their_labels():
    voxels = _detailed_shell_figure()
    segment_ids = _segment_voxels(voxels, max_segments=16)
    coords, _ = _voxel_arrays(voxels)
    front = next(view for view in VIEWS if view["name"] == "front")
    tile = _render_view_tile(coords, segment_ids, front, 320, _load_font(15))
    pixels = np.array(tile)
    projection = _project_segments(coords, segment_ids, front)
    scale = min(320 // projection.shape[1], 320 // projection.shape[0])

    for detail_color in (BLACK, MOUTH, BLUE, WHITE):
        segment_id = next(iter(_segments_with_color(voxels, segment_ids, detail_color)))
        palette_color = np.array(SEGMENT_PALETTE[segment_id - 1])
        visible = int(np.all(pixels == palette_color, axis=2).sum())
        projected = int((projection == segment_id).sum())
        # The label must sit beside the detail, leaving most of it uncovered.
        assert visible >= projected * scale * scale * 0.75


def test_build_scene_summary_describes_segments_without_colors():
    voxels = _two_part_model()
    segment_ids = _segment_voxels(voxels, max_segments=16)
    summary = _build_scene_summary(voxels, segment_ids)

    assert summary["segment_count"] == 2
    assert summary["voxel_count"] == len(voxels)
    head = next(s for s in summary["segments"] if s["id"] == 2)
    assert head["center"]["z"] > 0.6
    assert head["extent"]["z"][0] > 0.5
    for segment in summary["segments"]:
        assert "rgb" not in segment
        assert "color" not in segment


def test_project_segments_front_view_shows_head_above_body():
    voxels = _two_part_model()
    segment_ids = _segment_voxels(voxels, max_segments=16)
    coords, _ = _voxel_arrays(voxels)
    front = {"h": "x", "flip_h": False, "v": "z", "d": "y", "d_sign": -1}
    projection = _project_segments(coords, segment_ids, front)

    assert projection.shape == (10, 6)
    assert set(np.unique(projection[:4]).tolist()) <= {0, 2}
    assert set(np.unique(projection[4:]).tolist()) == {1}


def test_build_voxel_preview_data_url_returns_labelled_png():
    voxels = _two_part_model()
    segment_ids = _segment_voxels(voxels, max_segments=16)

    data_url = _build_voxel_preview_data_url(voxels, segment_ids)

    assert data_url.startswith("data:image/png;base64,")
    image = Image.open(BytesIO(base64.b64decode(data_url.split(",", 1)[1])))
    assert image.format == "PNG"
    colors = {color for _, color in image.getcolors(maxcolors=image.width * image.height)}
    # Segment ID colours are present; the model's real colours are not.
    assert SEGMENT_PALETTE[0] in colors
    assert SEGMENT_PALETTE[1] in colors
    assert (120, 60, 20) not in colors
    assert (140, 200, 90) not in colors


def test_assignment_schema_requires_every_segment():
    schema = _assignment_schema([1, 2, 3])
    assignments = schema["properties"]["assignments"]
    assert assignments["minItems"] == 3
    assert assignments["maxItems"] == 3
    assert assignments["items"]["properties"]["segment_id"]["enum"] == [1, 2, 3]


def test_extract_visible_text_delta_returns_all_openai_text():
    assert _extract_visible_text_delta(
        {
            "type": "response.reasoning_summary_text.delta",
            "delta": "The reference has a red torso.",
        }
    ) == "The reference has a red torso."
    assert _extract_visible_text_delta(
        {
            "type": "response.output_text.delta",
            "delta": '{"subject":"figure",',
        }
    ) == '{"subject":"figure",'
    assert _extract_visible_text_delta(
        {"type": "response.reasoning_summary_text.delta", "delta": 3}
    ) is None
    assert _extract_visible_text_delta(
        {"type": "response.reasoning_summary_text.done", "text": "done"}
    ) is None


def test_llm_render_stream_relays_thinking_and_result(monkeypatch):
    async def fake_llm_render(_request, _auth_info, on_thinking):
        await on_thinking("I see separate arms and a torso.")
        return LlmRenderResponse(
            xyzrgb_content="0 0 0 255 0 0\n",
            voxel_count=1,
            segment_count=1,
            model="test-model",
            applied_rules=[],
        )

    module = importlib.import_module("src.requests.llmRender")
    monkeypatch.setattr(module, "llm_render", fake_llm_render)

    async def collect_events():
        return [event async for event in llm_render_stream(object(), {})]

    events = [
        json.loads(event.removeprefix("data: "))
        for event in asyncio.run(collect_events())
    ]
    assert events[0] == {"type": "thinking", "delta": "I see separate arms and a torso."}
    assert events[1]["type"] == "result"
    assert events[1]["data"]["xyzrgb_content"] == "0 0 0 255 0 0\n"


def test_llm_render_streams_output_after_initial_processing(monkeypatch):
    module = importlib.import_module("src.requests.llmRender")
    generation_id = "d7f8fdb4-b010-4ef5-bd68-069aa20f96a4"
    voxel = {"x": 0, "y": 0, "z": 0, "r": 0, "g": 0, "b": 0}
    reference_images = {
        name: f"https://example.com/{name}.png"
        for name in ("front", "back", "side", "top")
    }

    class FakeStorage:
        async def get_generation(self, requested_id):
            assert requested_id == generation_id
            return {"reference_images": reference_images}

    async def fake_generate(_primary_url, existing):
        assert existing == reference_images
        return reference_images

    monkeypatch.setattr(module, "generation_storage", FakeStorage())
    monkeypatch.setattr(module, "generate_missing_reference_views", fake_generate)
    monkeypatch.setattr(module, "_fetch_text_url", lambda *_args: asyncio.sleep(0, result="xyz"))
    monkeypatch.setattr(module, "_parse_xyzrgb", lambda _content: [voxel])
    monkeypatch.setattr(module, "_segment_voxels", lambda *_args: np.array([1]))
    monkeypatch.setattr(
        module,
        "_build_scene_summary",
        lambda *_args: {"segments": [{"id": 1}]},
    )
    monkeypatch.setattr(module, "_build_voxel_preview_data_url", lambda *_args: "data:image/png;base64,x")

    async def fake_assignments(**kwargs):
        await kwargs["on_thinking"]("The main body should use red bricks.")
        return (
            [{"segment_id": 1, "part": "body", "reason": "reference", "color": [255, 0, 0]}],
            "model",
        )

    monkeypatch.setattr(module, "_call_openai_for_assignments", fake_assignments)
    monkeypatch.setattr(module, "track_api_call", lambda **_kwargs: None)
    updates = []

    async def collect_progress(delta):
        updates.append(delta)

    request = LlmRenderRequest(
        generation_id=generation_id,
        xyzrgb_url="https://example.com/model.xyzrgb",
        reference_image_url="https://example.com/reference.png",
        check_segmentation=False,
    )
    result = asyncio.run(llm_render(request, {}, collect_progress))

    assert updates == [
        "Rendering model preview...\n",
        "Comparing with reference images...\n\n",
        "The main body should use red bricks.",
    ]
    assert result.xyzrgb_content == "0 0 0 255 0 0\n"


def test_apply_assignments_recolors_segments_and_ignores_invalid_entries():
    voxels = _two_part_model()
    segment_ids = _segment_voxels(voxels, max_segments=16)
    assignments = [
        {"segment_id": 1, "part": "robe", "reason": "large lower block", "color": [200, 150, 100]},
        {"segment_id": 2, "part": "head", "reason": "top block", "color": [300, -5, 50]},
        {"segment_id": 2, "part": "dup", "reason": "duplicate", "color": [0, 0, 0]},
        {"segment_id": 99, "part": "ghost", "reason": "missing", "color": [1, 2, 3]},
        "not a dict",
    ]

    recolored, applied = _apply_assignments(voxels, segment_ids, assignments)

    assert [rule["segment_id"] for rule in applied] == [1, 2, 99]
    assert applied[0]["changed_voxels"] == int((segment_ids == 1).sum())
    assert applied[1]["color"] == [255, 0, 50]
    assert applied[2]["changed_voxels"] == 0
    body = [v for v in recolored if v["z"] < 6]
    head = [v for v in recolored if v["z"] >= 6]
    assert all((v["r"], v["g"], v["b"]) == (200, 150, 100) for v in body)
    assert all((v["r"], v["g"], v["b"]) == (255, 0, 50) for v in head)
    # Geometry untouched.
    assert [(v["x"], v["y"], v["z"]) for v in recolored] == [(v["x"], v["y"], v["z"]) for v in voxels]


def test_llm_render_generates_stores_and_sends_missing_reference_views(monkeypatch):
    generation_id = "d7f8fdb4-b010-4ef5-bd68-069aa20f96a4"
    front_url = "https://storage.example/front.png"
    generated = {
        "front": front_url,
        "back": "https://fal.example/back.png",
        "side": "https://fal.example/side.png",
        "top": "https://fal.example/top.png",
    }
    stored = {
        name: f"https://supabase.example/{name}.png"
        for name in ("back", "side", "top")
    }
    observed = {}

    class FakeStorage:
        async def get_generation(self, requested_id):
            assert requested_id == generation_id
            return {"reference_images": {"front": front_url}}

        async def store_reference_images(self, requested_id, images):
            assert requested_id == generation_id
            observed["stored"] = images
            return stored

    async def fake_generate(primary_url, existing):
        observed["generate"] = (primary_url, existing)
        return generated.copy()

    async def fake_openai(**kwargs):
        observed["openai_references"] = kwargs["reference_image_urls"]
        return ([{"segment_id": 1, "part": "body", "reason": "shape", "color": [1, 2, 3]}], "subject")

    monkeypatch.setattr(llm_render_module, "generation_storage", FakeStorage())
    monkeypatch.setattr(llm_render_module, "generate_missing_reference_views", fake_generate)

    async def fake_fetch(*_args):
        return "0 0 0 10 20 30\n"

    monkeypatch.setattr(llm_render_module, "_fetch_text_url", fake_fetch)
    monkeypatch.setattr(llm_render_module, "_call_openai_for_assignments", fake_openai)
    monkeypatch.setattr(llm_render_module, "track_api_call", lambda **_kwargs: None)

    response = asyncio.run(
        llm_render_module.llm_render(
            LlmRenderRequest(
                generation_id=generation_id,
                xyzrgb_url="https://example.com/model.xyzrgb",
                reference_image_url="https://example.com/primary.png",
                check_segmentation=False,
            ),
            {"user_id": "user"},
        )
    )

    assert observed["generate"] == (
        "https://example.com/primary.png",
        {"front": front_url},
    )
    assert observed["stored"] == {
        "back": generated["back"],
        "side": generated["side"],
        "top": generated["top"],
    }
    assert observed["openai_references"] == [
        "https://example.com/primary.png",
        front_url,
        stored["back"],
        stored["side"],
        stored["top"],
    ]
    assert response.reference_images == {"front": front_url, **stored}


def test_request_accepts_multiple_reference_images_and_dedupes():
    request = LlmRenderRequest(
        generation_id="d7f8fdb4-b010-4ef5-bd68-069aa20f96a4",
        xyzrgb_url="https://example.com/model.xyzrgb",
        reference_image_url="https://example.com/a.png",
        reference_image_urls=["https://example.com/b.png", "https://example.com/a.png"],
    )
    assert request.reference_images() == [
        "https://example.com/a.png",
        "https://example.com/b.png",
    ]
    assert request.check_segmentation is True


def test_request_accepts_reference_image_urls_without_primary():
    request = LlmRenderRequest(
        generation_id="d7f8fdb4-b010-4ef5-bd68-069aa20f96a4",
        xyzrgb_url="https://example.com/model.xyzrgb",
        reference_image_urls=["https://example.com/a.png"],
    )
    assert request.reference_images() == ["https://example.com/a.png"]


def test_request_requires_at_least_one_reference_image():
    with pytest.raises(ValidationError):
        LlmRenderRequest(
            generation_id="d7f8fdb4-b010-4ef5-bd68-069aa20f96a4",
            xyzrgb_url="https://example.com/model.xyzrgb",
        )
    with pytest.raises(ValidationError):
        LlmRenderRequest(
            generation_id="d7f8fdb4-b010-4ef5-bd68-069aa20f96a4",
            xyzrgb_url="https://example.com/model.xyzrgb", reference_image_urls=[]
        )


def test_request_rejects_bad_or_too_many_reference_images():
    with pytest.raises(ValidationError):
        LlmRenderRequest(
            generation_id="d7f8fdb4-b010-4ef5-bd68-069aa20f96a4",
            xyzrgb_url="https://example.com/model.xyzrgb",
            reference_image_urls=["ftp://example.com/a.png"],
        )
    with pytest.raises(ValidationError):
        LlmRenderRequest(
            generation_id="d7f8fdb4-b010-4ef5-bd68-069aa20f96a4",
            xyzrgb_url="https://example.com/model.xyzrgb",
            reference_image_urls=[
                f"https://example.com/{index}.png"
                for index in range(MAX_REFERENCE_IMAGES + 1)
            ],
        )


def test_reference_images_description_counts_images():
    assert _reference_images_description(["a"]) == "Image 1 is the reference"
    assert "Images 1-3" in _reference_images_description(["a", "b", "c"])


def test_segmentation_review_schema_limits_ids_and_pieces():
    schema = _segmentation_review_schema([1, 2, 3])
    merge_items = schema["properties"]["merge_groups"]["items"]
    assert merge_items["items"]["enum"] == [1, 2, 3]
    assert merge_items["minItems"] == 2
    split_items = schema["properties"]["split_segments"]["items"]
    assert split_items["properties"]["segment_id"]["enum"] == [1, 2, 3]
    assert split_items["properties"]["pieces"]["maximum"] == MAX_SPLIT_PIECES
    assert set(schema["required"]) == {"verdict", "merge_groups", "split_segments"}


def test_apply_segmentation_review_merges_fragments_and_renumbers():
    voxels = _two_part_model()
    segment_ids = _segment_voxels(voxels, max_segments=16)
    assert segment_ids.max() == 2

    review = {"verdict": "adjust", "merge_groups": [[1, 2]], "split_segments": []}
    merged_ids, adjustments = _apply_segmentation_review(voxels, segment_ids, review)

    assert set(np.unique(merged_ids).tolist()) == {1}
    assert adjustments == [{"action": "merge", "segment_ids": [1, 2], "into": 1}]


def test_apply_segmentation_review_splits_a_segment_deterministically():
    voxels = _two_part_model()
    # Force the head and body into one segment, as an over-eager budget would.
    segment_ids = _segment_voxels(voxels, max_segments=2)
    review = {
        "verdict": "adjust",
        "merge_groups": [[1, 2]],
        "split_segments": [{"segment_id": 1, "pieces": 2, "reason": "head and body"}],
    }
    new_ids, adjustments = _apply_segmentation_review(voxels, segment_ids, review)

    assert [adjustment["action"] for adjustment in adjustments] == ["merge", "split"]
    assert new_ids.max() == 2
    body = _segments_of(voxels, new_ids, lambda x, y, z: z < 6)
    head = _segments_of(voxels, new_ids, lambda x, y, z: z >= 6)
    assert len(body) == 1 and len(head) == 1 and body != head
    # Renumbered 1..N by descending size: the body is the larger part.
    assert body == {1}


def test_apply_segmentation_review_ignores_invalid_and_noop_reviews():
    voxels = _two_part_model()
    segment_ids = _segment_voxels(voxels, max_segments=16)

    unchanged, adjustments = _apply_segmentation_review(
        voxels, segment_ids, {"verdict": "good", "merge_groups": [], "split_segments": []}
    )
    assert adjustments == []
    assert np.array_equal(unchanged, segment_ids)

    review = {
        "verdict": "adjust",
        "merge_groups": [[1], [1, 99], "not a list", [None, "x"]],
        "split_segments": [
            {"segment_id": 99, "pieces": 2, "reason": "missing"},
            {"segment_id": 1, "pieces": "not a number"},
            "not a dict",
        ],
    }
    unchanged, adjustments = _apply_segmentation_review(voxels, segment_ids, review)
    assert adjustments == []
    assert np.array_equal(unchanged, segment_ids)


def test_apply_segmentation_review_skips_unsplittable_segments():
    voxels = _block((0, 4), (0, 4), (0, 4), (10, 20, 30))
    segment_ids = _segment_voxels(voxels, max_segments=16)
    review = {
        "verdict": "adjust",
        "merge_groups": [],
        "split_segments": [{"segment_id": 1, "pieces": 2, "reason": "uniform cube"}],
    }
    new_ids, adjustments = _apply_segmentation_review(voxels, segment_ids, review)
    assert adjustments == []
    assert np.array_equal(new_ids, segment_ids)


# ---------------------------------------------------------------------------
# Segmentation verification loop
# ---------------------------------------------------------------------------


GOOD_REVIEW = {"verdict": "good", "merge_groups": [], "split_segments": []}
MERGE_ALL_REVIEW = {"verdict": "adjust", "merge_groups": [[1, 2]], "split_segments": []}
SPLIT_FIRST_REVIEW = {
    "verdict": "adjust",
    "merge_groups": [],
    "split_segments": [{"segment_id": 1, "pieces": 2, "reason": "head and body"}],
}


class _ScriptedReviewer:
    """Returns one scripted review per round and records what it was shown."""

    def __init__(self, *reviews):
        self.reviews = list(reviews)
        self.calls = []

    async def __call__(self, scene_summary, preview_url, round_number, previous_rounds, on_thinking=None):
        self.calls.append(
            {
                "round": round_number,
                "segment_ids": [segment["id"] for segment in scene_summary["segments"]],
                "preview_url": preview_url,
                "previous_rounds": [dict(entry) for entry in previous_rounds],
            }
        )
        review = self.reviews.pop(0)
        if isinstance(review, Exception):
            raise review
        return review


def _run_loop(voxels, reviewer, max_rounds=DEFAULT_SEGMENTATION_ROUNDS, **kwargs):
    segment_ids = _segment_voxels(voxels, max_segments=16)
    scene_summary = _build_scene_summary(voxels, segment_ids)
    preview_url = _build_voxel_preview_data_url(voxels, segment_ids)
    return asyncio.run(
        _segmentation_review_loop(
            voxels, segment_ids, scene_summary, preview_url, reviewer, max_rounds, **kwargs
        )
    )


def test_request_validates_max_segmentation_rounds():
    base = {
        "generation_id": "d7f8fdb4-b010-4ef5-bd68-069aa20f96a4",
        "xyzrgb_url": "https://example.com/model.xyzrgb",
        "reference_image_url": "https://example.com/a.png",
    }
    assert LlmRenderRequest(**base).max_segmentation_rounds == DEFAULT_SEGMENTATION_ROUNDS
    assert LlmRenderRequest(**base, max_segmentation_rounds=None).max_segmentation_rounds == DEFAULT_SEGMENTATION_ROUNDS
    assert LlmRenderRequest(**base, max_segmentation_rounds=1).max_segmentation_rounds == 1
    with pytest.raises(ValidationError):
        LlmRenderRequest(**base, max_segmentation_rounds=0)
    with pytest.raises(ValidationError):
        LlmRenderRequest(**base, max_segmentation_rounds=MAX_SEGMENTATION_ROUNDS_LIMIT + 1)


def test_partition_signature_ignores_labels_but_not_grouping():
    assert _partition_signature(np.array([1, 1, 2, 2, 3])) == _partition_signature(np.array([3, 3, 1, 1, 2]))
    assert _partition_signature(np.array([1, 1, 2, 2, 3])) != _partition_signature(np.array([1, 1, 2, 3, 3]))
    assert _partition_signature(np.array([1, 1, 2])) != _partition_signature(np.array([1, 1, 1]))


def test_review_loop_stops_after_one_round_when_segmentation_is_good():
    voxels = _two_part_model()
    reviewer = _ScriptedReviewer(GOOD_REVIEW)
    outcome = _run_loop(voxels, reviewer)

    assert outcome.rounds == 1
    assert outcome.stop_reason == "good"
    assert outcome.adjustments == []
    assert len(reviewer.calls) == 1
    assert reviewer.calls[0]["previous_rounds"] == []


def test_review_loop_re_verifies_adjusted_segmentation():
    voxels = _two_part_model()
    reviewer = _ScriptedReviewer(MERGE_ALL_REVIEW, GOOD_REVIEW)
    thinking = []

    async def on_thinking(delta):
        thinking.append(delta)

    outcome = _run_loop(voxels, reviewer, on_thinking=on_thinking)

    assert outcome.rounds == 2
    assert outcome.stop_reason == "good"
    assert outcome.adjustments == [{"action": "merge", "segment_ids": [1, 2], "into": 1, "round": 1}]
    assert set(np.unique(outcome.segment_ids).tolist()) == {1}
    # Round 2 reviewed the *adjusted* model: one segment, a fresh preview and the
    # history of what round 1 changed.
    assert reviewer.calls[1]["segment_ids"] == [1]
    assert reviewer.calls[1]["preview_url"] != reviewer.calls[0]["preview_url"]
    assert reviewer.calls[1]["previous_rounds"] == [{"round": 1, "adjustments": outcome.adjustments}]
    assert outcome.scene_summary["segments"][0]["id"] == 1 and len(outcome.scene_summary["segments"]) == 1
    assert outcome.preview_image_url == reviewer.calls[1]["preview_url"]
    assert thinking == [
        f"Checking segmentation (round 1/{DEFAULT_SEGMENTATION_ROUNDS})...\n",
        f"Checking segmentation (round 2/{DEFAULT_SEGMENTATION_ROUNDS})...\n",
    ]


def test_review_loop_detects_oscillation():
    voxels = _two_part_model()
    # Merge head+body, then split them apart again: back to the starting partition.
    reviewer = _ScriptedReviewer(MERGE_ALL_REVIEW, SPLIT_FIRST_REVIEW, MERGE_ALL_REVIEW)
    outcome = _run_loop(voxels, reviewer, max_rounds=5)

    assert outcome.rounds == 2
    assert outcome.stop_reason == "cycle"
    assert [adjustment["round"] for adjustment in outcome.adjustments] == [1, 2]
    assert len(reviewer.calls) == 2
    assert outcome.segment_ids.max() == 2
    assert _segments_of(voxels, outcome.segment_ids, lambda x, y, z: z < 6) == {1}


def test_review_loop_respects_round_cap():
    voxels = _two_part_model()
    reviewer = _ScriptedReviewer(MERGE_ALL_REVIEW, GOOD_REVIEW)
    outcome = _run_loop(voxels, reviewer, max_rounds=1)

    assert outcome.rounds == 1
    assert outcome.stop_reason == "max_rounds"
    assert len(reviewer.calls) == 1
    assert len(outcome.adjustments) == 1
    # The adjusted state is still what gets handed on for colouring.
    assert len(outcome.scene_summary["segments"]) == 1


def test_review_loop_stops_when_adjust_verdict_applies_nothing():
    voxels = _two_part_model()
    reviewer = _ScriptedReviewer(
        {"verdict": "adjust", "merge_groups": [[1, 99]], "split_segments": []},
        GOOD_REVIEW,
    )
    outcome = _run_loop(voxels, reviewer)

    assert outcome.rounds == 1
    assert outcome.stop_reason == "no_change"
    assert outcome.adjustments == []
    assert len(reviewer.calls) == 1


def test_review_loop_keeps_earlier_rounds_when_reviewer_fails():
    from fastapi import HTTPException

    voxels = _two_part_model()
    reviewer = _ScriptedReviewer(MERGE_ALL_REVIEW, HTTPException(status_code=502, detail="boom"))
    outcome = _run_loop(voxels, reviewer)

    assert outcome.rounds == 1
    assert outcome.stop_reason == "error"
    assert [adjustment["round"] for adjustment in outcome.adjustments] == [1]
    assert set(np.unique(outcome.segment_ids).tolist()) == {1}


def test_review_loop_unchecked_model_is_left_untouched_on_immediate_failure():
    from fastapi import HTTPException

    voxels = _two_part_model()
    segment_ids = _segment_voxels(voxels, max_segments=16)
    reviewer = _ScriptedReviewer(HTTPException(status_code=504, detail="timeout"))
    outcome = _run_loop(voxels, reviewer)

    assert outcome.rounds == 0
    assert outcome.stop_reason == "error"
    assert np.array_equal(outcome.segment_ids, segment_ids)


def test_segmentation_review_prompt_carries_round_history(monkeypatch):
    module = importlib.import_module("src.requests.llmRender")
    captured = {}

    async def fake_post(payload, on_thinking=None, delta_extractor=None):
        captured["payload"] = payload
        return {"output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(GOOD_REVIEW)}]}]}

    monkeypatch.setattr(module, "_post_openai_responses", fake_post)
    voxels = _two_part_model()
    segment_ids = _segment_voxels(voxels, max_segments=16)
    scene_summary = _build_scene_summary(voxels, segment_ids)
    history = [{"round": 1, "adjustments": [{"action": "merge", "segment_ids": [2, 3], "into": 2, "round": 1}]}]

    review = asyncio.run(
        _call_openai_for_segmentation_review(
            scene_summary=scene_summary,
            reference_image_urls=["https://example.com/a.png"],
            voxel_preview_image_url="data:image/png;base64,AAAA",
            prompt=None,
            model="test-model",
            round_number=2,
            previous_rounds=history,
        )
    )

    assert review == GOOD_REVIEW
    user_text = json.loads(captured["payload"]["input"][1]["content"][0]["text"])
    assert user_text["review_round"] == 2
    assert user_text["previous_rounds"] == history
    assert any("follow-up review" in rule for rule in user_text["rules"])

    # First rounds carry no history and no follow-up rule.
    asyncio.run(
        _call_openai_for_segmentation_review(
            scene_summary=scene_summary,
            reference_image_urls=["https://example.com/a.png"],
            voxel_preview_image_url="data:image/png;base64,AAAA",
            prompt=None,
            model="test-model",
        )
    )
    user_text = json.loads(captured["payload"]["input"][1]["content"][0]["text"])
    assert user_text["review_round"] == 1
    assert user_text["previous_rounds"] == []
    assert not any("follow-up review" in rule for rule in user_text["rules"])


def test_model_provider_routes_claude_to_anthropic():
    module = importlib.import_module("src.requests.llmRender")

    assert module._model_provider("claude-fable-5") == "anthropic"
    assert module._model_provider("Claude-Opus-4.7") == "anthropic"
    assert module._model_provider("gpt-5.6-sol") == "openai"
    assert module._model_provider("") == "openai"


def test_anthropic_image_block_uses_base64_for_data_urls_and_url_for_https():
    module = importlib.import_module("src.requests.llmRender")

    data_block = module._anthropic_image_block("data:image/png;base64,AAAA")
    assert data_block == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"},
    }

    https_block = module._anthropic_image_block("https://example.com/a.png")
    assert https_block == {"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}}


def test_extract_anthropic_tool_json_falls_back_to_text_block():
    from fastapi import HTTPException

    module = importlib.import_module("src.requests.llmRender")

    # tool_choice is "auto" (see _anthropic_tool_payload), so a response that
    # skips the tool call and answers in plain text must still be parsed.
    response = {"content": [{"type": "text", "text": 'noise {"subject": "robot"} more noise'}]}
    assert module._extract_anthropic_tool_json(response, "voxel_segment_colors") == {
        "subject": "robot"
    }

    with pytest.raises(HTTPException):
        module._extract_anthropic_tool_json({"content": []}, "voxel_segment_colors")


def test_post_anthropic_messages_streams_thinking_and_rebuilds_tool_call(monkeypatch):
    import httpx

    module = importlib.import_module("src.requests.llmRender")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    sse_events = [
        {"type": "message_start", "message": {"id": "msg_1"}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Looking at "}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "the robot's arm."}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}},
        {"type": "content_block_stop", "index": 0},
        {
            "type": "content_block_start",
            "index": 1,
            "content_block": {"type": "tool_use", "id": "toolu_1", "name": "voxel_segment_colors", "input": {}},
        },
        {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"subject"'}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": ': "robot"}'}},
        {"type": "content_block_stop", "index": 1},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}},
        {"type": "message_stop"},
    ]
    body = "".join(f"data: {json.dumps(event)}\n\n" for event in sse_events)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-api-key"] == "test-key"
        return httpx.Response(200, content=body.encode())

    original_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original_async_client(transport=httpx.MockTransport(handler)),
    )

    deltas = []

    async def on_thinking(delta: str) -> None:
        deltas.append(delta)

    payload = {"model": "claude-fable-5", "stream": True}
    result = asyncio.run(module._post_anthropic_messages(payload, on_thinking=on_thinking))

    assert deltas == ["Looking at ", "the robot's arm."]
    assert result["content"][1]["type"] == "tool_use"
    assert result["content"][1]["input"] == {"subject": "robot"}


def test_segmentation_review_uses_anthropic_for_claude_model(monkeypatch):
    module = importlib.import_module("src.requests.llmRender")
    captured = {}

    async def fake_post_anthropic(payload, on_thinking=None):
        captured["payload"] = payload
        return {
            "content": [
                {"type": "tool_use", "name": "voxel_segmentation_review", "input": GOOD_REVIEW}
            ]
        }

    async def fail_post_openai(payload, on_thinking=None, delta_extractor=None):
        raise AssertionError("OpenAI path should not be used for a claude model")

    monkeypatch.setattr(module, "_post_anthropic_messages", fake_post_anthropic)
    monkeypatch.setattr(module, "_post_openai_responses", fail_post_openai)

    voxels = _two_part_model()
    segment_ids = _segment_voxels(voxels, max_segments=16)
    scene_summary = _build_scene_summary(voxels, segment_ids)

    review = asyncio.run(
        module._call_openai_for_segmentation_review(
            scene_summary=scene_summary,
            reference_image_urls=["https://example.com/a.png"],
            voxel_preview_image_url="data:image/png;base64,AAAA",
            prompt=None,
            model="claude-fable-5",
        )
    )

    assert review == GOOD_REVIEW
    assert captured["payload"]["model"] == "claude-fable-5"
    assert captured["payload"]["tool_choice"] == {"type": "auto"}
    content = captured["payload"]["messages"][0]["content"]
    assert content[0]["type"] == "text"
    assert content[1] == {"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}}
    assert content[2] == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"},
    }


def test_call_for_assignments_uses_anthropic_for_claude_model(monkeypatch):
    module = importlib.import_module("src.requests.llmRender")
    captured = {}
    thinking_deltas = []
    fake_assignments = {
        "subject": "a robot",
        "assignments": [{"segment_id": 1, "part": "body", "reason": "r", "color": [1, 2, 3]}],
    }

    async def fake_post_anthropic(payload, on_thinking=None):
        captured["payload"] = payload
        if on_thinking:
            await on_thinking("Looking at the reference image...")
        return {
            "content": [
                {"type": "tool_use", "name": "voxel_segment_colors", "input": fake_assignments}
            ]
        }

    async def fail_post_openai(payload, on_thinking=None, delta_extractor=None):
        raise AssertionError("OpenAI path should not be used for a claude model")

    monkeypatch.setattr(module, "_post_anthropic_messages", fake_post_anthropic)
    monkeypatch.setattr(module, "_post_openai_responses", fail_post_openai)

    voxels = _two_part_model()
    segment_ids = _segment_voxels(voxels, max_segments=16)
    scene_summary = _build_scene_summary(voxels, segment_ids)

    async def on_thinking(delta: str) -> None:
        thinking_deltas.append(delta)

    assignments, subject = asyncio.run(
        module._call_openai_for_assignments(
            scene_summary=scene_summary,
            reference_image_urls=["https://example.com/a.png"],
            voxel_preview_image_url="data:image/png;base64,AAAA",
            prompt=None,
            model="claude-fable-5",
            on_thinking=on_thinking,
        )
    )

    assert subject == "a robot"
    assert assignments == fake_assignments["assignments"]
    assert captured["payload"]["model"] == "claude-fable-5"
    assert captured["payload"]["tool_choice"] == {"type": "auto"}
    assert captured["payload"]["stream"] is True
    assert captured["payload"]["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert thinking_deltas == ["Looking at the reference image..."]


def test_llm_render_reports_verification_loop_outcome(monkeypatch):
    module = importlib.import_module("src.requests.llmRender")
    generation_id = "d7f8fdb4-b010-4ef5-bd68-069aa20f96a4"
    voxels = _two_part_model()
    reviews = [MERGE_ALL_REVIEW, GOOD_REVIEW]
    review_rounds = []

    async def fake_fetch(_url, _max_bytes):
        return "\n".join(f"{v['x']} {v['y']} {v['z']} {v['r']} {v['g']} {v['b']}" for v in voxels)

    async def fake_review(scene_summary, reference_image_urls, voxel_preview_image_url, prompt, model, round_number, previous_rounds, on_thinking=None):
        review_rounds.append(round_number)
        return reviews.pop(0)

    async def fake_assignments(scene_summary, **_kwargs):
        return (
            [{"segment_id": s["id"], "part": "body", "reason": "r", "color": [1, 2, 3]} for s in scene_summary["segments"]],
            "figure",
        )

    class FakeStorage:
        async def get_generation(self, requested_id):
            assert requested_id == generation_id
            return {"reference_images": {}}

        async def store_reference_images(self, requested_id, images):
            return images

    async def fake_generate_views(_primary_url, existing):
        return dict(existing)

    tracked = {}
    monkeypatch.setattr(module, "_fetch_text_url", fake_fetch)
    monkeypatch.setattr(module, "_call_openai_for_segmentation_review", fake_review)
    monkeypatch.setattr(module, "_call_openai_for_assignments", fake_assignments)
    monkeypatch.setattr(module, "track_api_call", lambda **kwargs: tracked.update(kwargs))
    monkeypatch.setattr(module, "generation_storage", FakeStorage())
    monkeypatch.setattr(module, "generate_missing_reference_views", fake_generate_views)

    request = LlmRenderRequest(
        generation_id=generation_id,
        xyzrgb_url="https://example.com/model.xyzrgb",
        reference_image_url="https://example.com/a.png",
    )
    response = asyncio.run(llm_render(request, {"user_id": "tester"}))

    assert review_rounds == [1, 2]
    assert response.segmentation_rounds == 2
    assert response.segmentation_stop_reason == "good"
    assert response.segmentation_adjustments == [{"action": "merge", "segment_ids": [1, 2], "into": 1, "round": 1}]
    # Colours were assigned to the *verified* (merged) segmentation.
    assert response.segment_count == 1
    assert tracked["segmentation_rounds"] == 2
    assert tracked["segmentation_stop_reason"] == "good"

    # With the check disabled nothing runs and the response says so.
    unchecked = LlmRenderRequest(
        generation_id=generation_id,
        xyzrgb_url="https://example.com/model.xyzrgb",
        reference_image_url="https://example.com/a.png",
        check_segmentation=False,
    )
    review_rounds.clear()
    response = asyncio.run(llm_render(unchecked, {"user_id": "tester"}))
    assert review_rounds == []
    assert response.segmentation_rounds == 0
    assert response.segmentation_stop_reason is None
    assert response.segment_count == 2
