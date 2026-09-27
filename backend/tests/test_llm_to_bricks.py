import asyncio
import base64
from pathlib import Path

import pytest
from pydantic import ValidationError

from src.requests import llmToBricks as module
from src.requests.llmToBricks import (
    SUPPORTED_MODELS,
    LlmToBricksRequest,
    _extract_ldr_content,
    process_llm_to_bricks_task,
    validate_ldr_content,
)
from src.utils.llm_tool_conversation import (
    AnthropicToolConversation,
    OpenAIToolConversation,
    ToolCall,
    Turn,
)


VALID_PART = "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat"


def test_request_accepts_text_or_supported_image_and_rejects_invalid_input():
    assert LlmToBricksRequest(prompt="  red castle  ").prompt == "red castle"

    encoded = base64.b64encode(b"image bytes").decode()
    image_request = LlmToBricksRequest(
        image_base64=encoded,
        image_media_type="image/jpeg",
    )
    assert image_request.image_base64 == encoded

    for kwargs in (
        {},
        {"prompt": " "},
        {"image_base64": "not base64"},
        {"image_base64": encoded, "image_media_type": "image/svg+xml"},
        {"prompt": "model", "detail_level": 0},
        {"prompt": "model", "model": "some-unlisted-model"},
    ):
        with pytest.raises(ValidationError):
            LlmToBricksRequest(**kwargs)


def test_request_defaults_to_opus_5_5_and_accepts_listed_claude_and_openai_models():
    assert LlmToBricksRequest(prompt="castle").model == "claude-opus-5-5"
    assert {m.provider for m in SUPPORTED_MODELS.values()} == {"anthropic", "openai"}
    for model_id in SUPPORTED_MODELS:
        assert LlmToBricksRequest(prompt="castle", model=model_id).model == model_id


@pytest.mark.parametrize("model_id, expected", [
    ("claude-opus-5-5", AnthropicToolConversation),
    ("gpt-5.6-sol", OpenAIToolConversation),
])
def test_conversation_uses_the_selected_models_provider(monkeypatch, model_id, expected):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a-key")
    monkeypatch.setenv("OPENAI_API_KEY", "o-key")
    request = LlmToBricksRequest(prompt="a lighthouse", model=model_id)
    conversation = module._open_conversation(request, client=None, system="sys", tools=module.DESIGN_TOOLS)
    assert isinstance(conversation, expected)
    assert conversation.payload()["model"] == model_id


def test_extract_and_validate_ldr_content():
    turn = Turn(tool_calls=[ToolCall("t1", "submit_ldr_model",
                                     {"ldr_content": f"0 FILE model.ldr\n0 My model\n{VALID_PART}"})])
    validated = validate_ldr_content(_extract_ldr_content(turn))
    assert "0 Name: llm-model.ldr" in validated
    assert "0 Author: BrickBuilder AI" in validated
    assert validated.endswith(VALID_PART + "\n")

    with pytest.raises(ValueError, match="Unsafe"):
        validate_ldr_content(VALID_PART.replace("3001.dat", "../3001.dat"))
    with pytest.raises(ValueError, match="Invalid LDraw command"):
        validate_ldr_content("2 4 0 0 0 1 1 1")
    with pytest.raises(ValueError, match="embedded FILE"):
        validate_ldr_content(f"{VALID_PART}\n0 FILE another.ldr\n{VALID_PART}")
    with pytest.raises(ValueError, match="truncated"):
        _extract_ldr_content(Turn(truncated=True))


def test_extract_ldr_content_accepts_text_fallback_for_auto_tool_choice():
    assert validate_ldr_content(_extract_ldr_content(Turn(text=VALID_PART))).endswith(VALID_PART + "\n")
    assert _extract_ldr_content(Turn(text='{"ldr_content": "' + VALID_PART + '"}')) == VALID_PART
    with pytest.raises(ValueError, match="did not return"):
        _extract_ldr_content(Turn())


def test_background_task_stores_standard_generation_artifacts(monkeypatch, tmp_path):
    calls = []

    class FakeStorage:
        async def update_status(self, generation_id, status, error_message=None):
            calls.append(("status", generation_id, status, error_message))

        async def store_images(self, **kwargs):
            calls.append(("images", kwargs))

        async def store_model_file(self, generation_id, content, file_type, **kwargs):
            calls.append(("model", generation_id, file_type, content, kwargs))
            return f"https://example.com/{file_type}"

        async def store_parts_list_csv(self, generation_id, content, **kwargs):
            calls.append(("parts", generation_id, content, kwargs))
            return "https://example.com/parts.csv"

        async def update_detail_level(self, generation_id, detail_level):
            calls.append(("detail", generation_id, detail_level))

    class FakePacker:
        def pack_ldraw_model(self, ldr_path):
            mpd_path = tmp_path / "model.mpd"
            mpd_path.write_text("0 FILE model.ldr\n", encoding="utf-8")
            return str(mpd_path)

    voxels = "0 0 0 255 0 0\n3 1 0 255 0 0\n0 0 1 255 0 0\n"

    async def fake_generate(_request, on_thinking=None):
        return module.LlmBuild(ldr=validate_ldr_content(VALID_PART), voxels_xyzrgb=voxels,
                               problematic_xyzrgb="3 1 0 255 0 0\n")

    async def fake_deduct(**_kwargs):
        return {}

    monkeypatch.setattr(module, "generation_storage", FakeStorage())
    monkeypatch.setattr(module, "LDrawPacker", FakePacker)
    monkeypatch.setattr(module, "_generate_ldr", fake_generate)
    monkeypatch.setattr(module, "deduct_credits", fake_deduct)
    monkeypatch.setattr(module, "track_image_conversion", lambda **_kwargs: None)
    monkeypatch.setattr(module, "track_error", lambda **_kwargs: None)

    encoded = base64.b64encode(b"png").decode()
    request = LlmToBricksRequest(prompt="castle", image_base64=encoded)
    asyncio.run(
        process_llm_to_bricks_task(
            "generation-1",
            request,
            {
                "user_email": "builder@example.com",
                "is_developer": False,
                "is_anonymous": False,
            },
            {"user_id": "user-1"},
        )
    )

    assert ("status", "generation-1", "completed", None) in calls
    assert any(call[:3] == ("model", "generation-1", "ldr") for call in calls)
    assert not any(call[:3] == ("model", "generation-1", "mpd") for call in calls)
    assert any(call[0] == "parts" for call in calls)
    assert any(call[0] == "images" for call in calls)
    # the design voxels are saved for the block editor and as the resize source
    assert ("model", "generation-1", "xyzrgb", voxels, {"raise_on_error": True}) in calls
    assert ("model", "generation-1", "design_voxels", voxels, {"raise_on_error": True}) in calls
    assert ("detail", "generation-1", 4) in calls
    assert ("model", "generation-1", "problematic_xyzrgb", "3 1 0 255 0 0\n",
            {"raise_on_error": True}) in calls


def test_voxel_extent_is_the_longest_axis():
    assert module.voxel_extent("0 0 0 1 1 1\n3 1 0 1 1 1\n0 0 5 1 1 1\n") == 6
    assert module.voxel_extent("") == 0


def test_generate_ldr_returns_design_voxels_in_design_mode_and_none_in_direct_mode(monkeypatch):
    result = module.build_design(GOOD_DESIGN)
    converted = []
    real_convert = module._convert_design_voxels

    def convert(xyzrgb):
        build = real_convert(xyzrgb)
        converted.append(build)
        return build

    async def fake_design(_request, on_thinking=None):
        return result

    async def fake_direct(_request, on_thinking=None):
        return validate_ldr_content(VALID_PART)

    monkeypatch.setattr(module, "_generate_ldr_with_design", fake_design)
    monkeypatch.setattr(module, "_generate_ldr_direct", fake_direct)
    monkeypatch.setattr(module, "_convert_design_voxels", convert)
    request = LlmToBricksRequest(prompt="tower")

    monkeypatch.setattr(module, "LDR_MODE", "design")
    design_build = asyncio.run(module._generate_ldr(request))
    assert design_build.voxels_xyzrgb == result.xyzrgb()
    assert design_build is converted[0]
    assert any(line.startswith("1 ") for line in design_build.ldr.splitlines())
    assert design_build.ldr != result.ldr  # the draft packer is not the final artifact

    monkeypatch.setattr(module, "LDR_MODE", "direct")
    assert asyncio.run(module._generate_ldr(request)).voxels_xyzrgb is None
    assert len(converted) == 1


def test_design_conversion_uses_image_pipeline_and_cleans_files(monkeypatch, tmp_path):
    voxels = "0 0 0 255 0 0\n1 0 0 255 0 0\n"
    paths = []
    diagnostic = tmp_path / "problematic.xyzrgb"

    def convert(*, glb_path, xyzrgb_path, auto_adjust_brick_count):
        assert not auto_adjust_brick_count
        assert not Path(glb_path).exists()
        assert Path(xyzrgb_path).read_text() == voxels
        paths.append(Path(xyzrgb_path).parent)
        ldr_path = Path(glb_path).with_suffix(".ldr")
        ldr_path.write_text(VALID_PART)
        diagnostic.write_text("1 0 0 255 0 0\n")
        return {"ldr_file": str(ldr_path), "problematic_xyzrgb_file": str(diagnostic)}

    monkeypatch.setattr(module, "glb2brick", convert)
    build = module._convert_design_voxels(voxels)
    assert build.ldr == validate_ldr_content(VALID_PART)
    assert build.voxels_xyzrgb == voxels
    assert build.problematic_xyzrgb == "1 0 0 255 0 0\n"
    assert not diagnostic.exists()
    assert not paths[0].exists()


def test_design_converter_failure_does_not_fall_back_to_draft(monkeypatch):
    async def design(_request, on_thinking=None):
        return module.build_design(GOOD_DESIGN)

    def fail(**kwargs):
        raise ValueError("voxel conversion failed")

    monkeypatch.setattr(module, "LDR_MODE", "design")
    monkeypatch.setattr(module, "_generate_ldr_with_design", design)
    monkeypatch.setattr(module, "glb2brick", fail)
    with pytest.raises(module.HTTPException) as exc:
        asyncio.run(module._generate_ldr(LlmToBricksRequest(prompt="tower")))
    assert exc.value.detail == "voxel conversion failed"


def test_design_conversion_accepts_a_single_voxel():
    build = module._convert_design_voxels("0 0 0 201 26 9\n")
    parts = [line for line in build.ldr.splitlines() if line.startswith("1 ")]
    assert len(parts) == 1
    assert parts[0].lower().endswith("3005.dat")
    with pytest.raises(ValueError, match="any voxels"):
        module._convert_design_voxels("")


def test_design_tool_uses_brick_height_voxels_and_explicit_bases():
    properties = module.DESIGN_TOOLS[0].schema["properties"]
    assert properties["layer_unit"]["enum"] == ["brick"]
    assert "base_color" not in properties
    assert "include it as box shapes" in module.DESIGN_SYSTEM_PROMPT


def test_start_records_the_selected_model_and_llm_endpoint(monkeypatch):
    created = {}

    class FakeStorage:
        async def create_generation(self, **kwargs):
            created.update(kwargs)
            return "generation-2"

    async def fake_task(*_args):
        return None

    monkeypatch.setattr(module, "generation_storage", FakeStorage())
    monkeypatch.setattr(module, "process_llm_to_bricks_task", fake_task)
    monkeypatch.setattr(module, "handle_auth_and_tracking", lambda **_kwargs: {
        "is_anonymous": True, "is_developer": False, "user_email": "anon"})

    async def run():
        return await module.llm_to_bricks(LlmToBricksRequest(prompt="castle", model="gpt-5.6-sol"),
                                          {"user_id": "anon-1"})

    response = asyncio.run(run())
    assert response.generation_id == "generation-2"
    assert created["endpoint"] == "llmToBricks"
    assert created["model_3d"] == "gpt-5.6-sol"


GOOD_DESIGN = {
    "title": "Tower",
    "base_color": 2,
    "grid": {"width": 8, "depth": 8, "layers": 6},
    "shapes": [{"shape": "cylinder", "axis": "y", "center": [3.5, 3.5], "radius": 3, "range": [0, 5], "color": 71}],
}
FLOATING_DESIGN = {
    "grid": {"width": 8, "depth": 8, "layers": 8},
    "shapes": [
        {"shape": "box", "x": [0, 7], "y": [0, 0], "z": [0, 7], "color": 71},
        {"shape": "box", "x": [2, 4], "y": [4, 5], "z": [2, 4], "color": 4},
    ],
}


class ScriptedConversation:
    """Stands in for a provider conversation: replays turns and records what the loop sent back."""

    def __init__(self, turns):
        self.turns = list(turns)
        self.sent = 0
        self.tool_results = []
        self.user_texts = []

    async def send(self):
        self.sent += 1
        return self.turns[self.sent - 1]

    async def send_stream(self, on_text):
        turn = await self.send()
        if turn.text:
            await on_text(turn.text + "\n\n")
        return turn

    def add_tool_results(self, results):
        self.tool_results.append(list(results))

    def add_user_text(self, text):
        self.user_texts.append(text)


def _call(name, tool_input, call_id):
    return Turn(tool_calls=[ToolCall(call_id, name, tool_input)])


def _scripted(monkeypatch, turns):
    conversation = ScriptedConversation(turns)
    opened = {}

    def fake_open(request, client, system, tools):
        opened.update(system=system, tools=tools, model=request.model)
        return conversation

    monkeypatch.setattr(module, "_open_conversation", fake_open)
    return conversation, opened


def test_design_mode_feeds_build_errors_back_then_reviews_then_accepts(monkeypatch):
    conversation, opened = _scripted(monkeypatch, [
        _call("submit_brick_design", FLOATING_DESIGN, "t1"),
        _call("submit_brick_design", GOOD_DESIGN, "t2"),
        _call("accept_design", {}, "t3"),
    ])
    monkeypatch.setattr(module, "DESIGN_REVIEW_ROUNDS", 1)
    monkeypatch.setattr(module, "DESIGN_MAX_ATTEMPTS", 3)

    ldr = asyncio.run(module._generate_ldr_with_design(LlmToBricksRequest(prompt="a tower"))).ldr

    assert conversation.sent == 3
    assert opened["tools"][0].name == "submit_brick_design"
    assert "COLORS" in opened["system"] and "71 Light Bluish Gray" in opened["system"]
    error_result = conversation.tool_results[0][0]
    assert error_result.is_error and "float" in error_result.text
    review_result = conversation.tool_results[1][0]
    assert review_result.image_png[:8] == b"\x89PNG\r\n\x1a\n"
    assert "Built" in review_result.text
    validated = validate_ldr_content(ldr)
    assert module.audit_ldraw(validated).ok
    assert "0 STEP" in validated


def test_design_mode_streams_visible_thinking_text(monkeypatch):
    conversation, _ = _scripted(monkeypatch, [
        Turn(
            text="I am blocking out the tower silhouette.",
            tool_calls=[ToolCall("s1", "submit_brick_design", GOOD_DESIGN)],
        ),
        _call("accept_design", {}, "a1"),
    ])
    monkeypatch.setattr(module, "DESIGN_REVIEW_ROUNDS", 1)
    notes = []

    async def on_thinking(delta):
        notes.append(delta)

    asyncio.run(module._generate_ldr_with_design(LlmToBricksRequest(prompt="a tower"), on_thinking))

    assert conversation.sent == 2
    assert notes == ["I am blocking out the tower silhouette.\n\n"]


def test_design_mode_answers_every_tool_call_and_nudges_text_only_turns(monkeypatch):
    conversation, _ = _scripted(monkeypatch, [
        Turn(text="Here is my plan"),
        Turn(tool_calls=[ToolCall("a1", "accept_design", {}),
                         ToolCall("s1", "submit_brick_design", GOOD_DESIGN)]),
        _call("accept_design", {}, "a2"),
    ])
    monkeypatch.setattr(module, "DESIGN_REVIEW_ROUNDS", 1)
    ldr = asyncio.run(module._generate_ldr_with_design(LlmToBricksRequest(prompt="a tower"))).ldr
    assert conversation.user_texts == ["Please submit the model with the submit_brick_design tool."]
    early_accept, review = conversation.tool_results[0]
    assert (early_accept.call_id, early_accept.is_error) == ("a1", True)
    assert review.call_id == "s1" and review.image_png is not None
    assert "0 STEP" in ldr


def test_design_mode_repairs_on_last_attempt_instead_of_failing(monkeypatch):
    _scripted(monkeypatch, [_call("submit_brick_design", FLOATING_DESIGN, "t1")])
    monkeypatch.setattr(module, "DESIGN_MAX_ATTEMPTS", 1)
    monkeypatch.setattr(module, "DESIGN_REVIEW_ROUNDS", 0)
    ldr = asyncio.run(module._generate_ldr_with_design(LlmToBricksRequest(prompt="a slab"))).ldr
    assert "3001.dat" in ldr or "3007.dat" in ldr


def test_design_mode_reports_truncation(monkeypatch):
    _scripted(monkeypatch, [Turn(truncated=True)])
    with pytest.raises(ValueError, match="truncated"):
        asyncio.run(module._generate_ldr_with_design(LlmToBricksRequest(prompt="a slab")))


def test_direct_mode_sends_audit_feedback_and_uses_the_corrected_model(monkeypatch):
    overlapping = f"{VALID_PART}\n{VALID_PART}"
    conversation, opened = _scripted(monkeypatch, [
        _call("submit_ldr_model", {"ldr_content": overlapping}, "d1"),
        _call("submit_ldr_model", {"ldr_content": VALID_PART}, "d2"),
    ])
    monkeypatch.setattr(module, "DIRECT_FIX_ROUNDS", 1)
    ldr = asyncio.run(module._generate_ldr_direct(LlmToBricksRequest(prompt="brick", model="gpt-5.5")))
    assert conversation.sent == 2
    assert opened["model"] == "gpt-5.5"
    feedback = conversation.tool_results[0][0]
    assert feedback.call_id == "d1" and feedback.is_error and "overlap" in feedback.text
    assert ldr.count("3001.dat") == 1


def test_direct_mode_streams_visible_thinking_text(monkeypatch):
    _scripted(monkeypatch, [
        Turn(
            text="I'll use a single brick while I verify the placement.",
            tool_calls=[ToolCall("d1", "submit_ldr_model", {"ldr_content": VALID_PART})],
        ),
    ])
    notes = []

    async def on_thinking(delta):
        notes.append(delta)

    asyncio.run(module._generate_ldr_direct(LlmToBricksRequest(prompt="brick"), on_thinking))

    assert notes == ["I'll use a single brick while I verify the placement.\n\n"]


def test_background_generation_survives_request_cancellation(monkeypatch):
    from unittest.mock import AsyncMock

    monkeypatch.setattr(module.generation_storage, "create_generation", AsyncMock(return_value="background-1"))
    monkeypatch.setattr(module, "handle_auth_and_tracking", lambda **kwargs: {
        "is_anonymous": True, "is_developer": False, "user_email": "anon",
    })

    async def scenario():
        started = asyncio.Event()
        release = asyncio.Event()
        completed = asyncio.Event()
        responded = asyncio.Event()

        async def generate(*args):
            started.set()
            await release.wait()
            completed.set()

        monkeypatch.setattr(module, "process_llm_to_bricks_task", generate)

        async def request():
            response = await module.llm_to_bricks(LlmToBricksRequest(prompt="castle"), {"user_id": "anon"})
            assert response.generation_id == "background-1"
            responded.set()
            await asyncio.Future()

        connection = asyncio.create_task(request())
        await asyncio.wait_for(responded.wait(), 1)
        await asyncio.wait_for(started.wait(), 1)
        assert not completed.is_set()
        assert len(module._background_tasks) == 1
        connection.cancel()
        with pytest.raises(asyncio.CancelledError):
            await connection
        release.set()
        await asyncio.wait_for(completed.wait(), 1)
        await asyncio.gather(*module._background_tasks)
        await asyncio.sleep(0)
        assert not module._background_tasks

    asyncio.run(scenario())
