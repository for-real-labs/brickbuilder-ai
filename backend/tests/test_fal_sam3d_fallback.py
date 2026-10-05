import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from src.utils import sam3d_stream as pipeline
from src.utils import generate_3d_model_from_image as mesh_module


@pytest.mark.parametrize("stream_3d, runpod_enabled, expected", [(True, False, "sam3d"), (False, False, None), (False, True, None)])
def test_mesh_route_supports_fal_sam3d_without_runpod(monkeypatch, stream_3d, runpod_enabled, expected):
    branch = AsyncMock()
    monkeypatch.setattr(pipeline, "RUNPOD_ENABLED", runpod_enabled)
    monkeypatch.setattr(pipeline, "_run_trellis_3d_branch", branch)
    monkeypatch.setattr(pipeline, "generation_storage", AsyncMock())
    monkeypatch.setattr(pipeline, "remove_background_from_url", lambda url, _: url)
    queue = asyncio.Queue()
    asyncio.run(pipeline._pipeline_worker(queue, "https://example.com/image.png", "gen", 20, {}, {}, 0, None, None, None, stream_3d=stream_3d))
    assert branch.await_args.kwargs["model_3d"] == expected
    if expected == "sam3d":
        raw_events = [queue.get_nowait() for _ in range(queue.qsize())]
        events = [json.loads((event.decode() if isinstance(event, bytes) else event).removeprefix("data: ")) for event in raw_events if event]
        assert any("SAM3D through fal.ai" in event.get("message", "") for event in events)


def test_fal_sam3d_mesh_route_stores_standard_brick_artifacts(monkeypatch, tmp_path):
    ldr = tmp_path / "model.ldr"
    ldr.write_text("0 model\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n")
    mpd = tmp_path / "model.mpd"
    mpd.write_text("0 FILE model.ldr\n" + ldr.read_text())
    generate = AsyncMock(return_value=("mesh.glb", str(ldr), None, None, "https://example.com/model.glb", None, None, None, None))
    storage = AsyncMock()
    credits = AsyncMock()

    class Packer:
        def pack_ldraw_model(self, _):
            return str(mpd)

    monkeypatch.setattr(mesh_module, "generate_3d_model_from_image", generate)
    monkeypatch.setattr(pipeline, "generation_storage", storage)
    monkeypatch.setattr(pipeline, "deduct_credits", credits)
    monkeypatch.setattr(pipeline, "LDrawPacker", Packer)
    asyncio.run(pipeline._run_trellis_3d_branch(queue=asyncio.Queue(), generation_id="gen", detail_level=20, user_info={}, auth_info={}, credits_to_deduct=0, original_image_url=None, processed_image_url=None, image_url="https://example.com/image.png", prompt_enhancement=None, model_option="a", model_3d="sam3d"))
    assert generate.await_args.kwargs["model"] == "sam3d"
    assert credits.await_args.kwargs["operation_description"] == "sam3d API call"
    assert {call.kwargs["file_type"] for call in storage.store_model_file.await_args_list} == {"glb", "ldr", "mpd"}
    storage.store_parts_list_csv.assert_awaited_once()
    storage.update_status.assert_awaited_with("gen", "completed")
