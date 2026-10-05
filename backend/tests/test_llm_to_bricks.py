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

        async def store_preview_image(self, generation_id, png):
            calls.append(("preview", generation_id, png))
            return "https://example.com/preview.png"

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
    preview = next(call for call in calls if call[0] == "preview")
    assert preview[1] == "generation-1"
    assert preview[2][:8] == b"\x89PNG\r\n\x1a\n"
    assert calls.index(preview) < calls.index(("status", "generation-1", "completed", None))


def test_background_task_completes_when_preview_render_fails(monkeypatch, tmp_path):
    statuses = []

    class FakeStorage:
        async def update_status(self, generation_id, status, error_message=None):
            statuses.append(status)

        async def store_model_file(self, *_args, **_kwargs):
            return "https://example.com/model"

        async def store_parts_list_csv(self, *_args, **_kwargs):
            return "https://example.com/parts.csv"

        async def store_preview_image(self, *_args):
            raise AssertionError("a failed render must not be stored")

    class FakePacker:
        def pack_ldraw_model(self, _ldr_path):
            mpd_path = tmp_path / "model.mpd"
            mpd_path.write_text("0 FILE model.ldr\n", encoding="utf-8")
            return str(mpd_path)

    async def fake_generate(_request, on_thinking=None):
        return module.LlmBuild(ldr=validate_ldr_content(VALID_PART))

    async def fake_deduct(**_kwargs):
        return {}

    def fail_render(_ldr):
        raise ValueError("render failed")

    monkeypatch.setattr(module, "generation_storage", FakeStorage())
    monkeypatch.setattr(module, "LDrawPacker", FakePacker)
    monkeypatch.setattr(module, "_generate_ldr", fake_generate)
    monkeypatch.setattr(module, "deduct_credits", fake_deduct)
    monkeypatch.setattr(module, "render_ldraw_preview_png", fail_render)
    monkeypatch.setattr(module, "track_image_conversion", lambda **_kwargs: None)

    error = asyncio.run(process_llm_to_bricks_task(
        "generation-1",
        LlmToBricksRequest(prompt="castle"),
        {"user_email": "builder@example.com", "is_developer": False, "is_anonymous": False},
        {"user_id": "user-1"},
    ))

    assert error is None
    assert statuses[-1] == "completed"


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


def test_design_tool_uses_brick_height_voxels_and_discourages_bases():
    properties = module.DESIGN_TOOLS[0].schema["properties"]
    assert properties["layer_unit"]["enum"] == ["brick"]
    assert "base_color" not in properties
    assert "Do not add a display base" in module.DESIGN_SYSTEM_PROMPT


def test_image_input_encourages_stylization_and_preserves_explicit_prompt():
    encoded = base64.b64encode(b"reference image").decode()
    image_only = module._user_input(LlmToBricksRequest(image_base64=encoded))
    assert "distinctive features" in image_only.text
    assert "creative liberty with stylization" in image_only.text
    assert "prominent upper eyelids or eyelashes" in image_only.text
    assert "200-250" in image_only.text
    assert image_only.image_base64 == encoded

    explicit = module._user_input(LlmToBricksRequest(
        image_base64=encoded, prompt="Keep realistic proportions and the exact pose",
    ))
    assert explicit.text == "Keep realistic proportions and the exact pose"
    assert explicit.image_base64 == encoded


@pytest.mark.parametrize("prompt_builder", [module._design_system_prompt, module._direct_system_prompt])
@pytest.mark.parametrize("prompt", [None, "Keep realistic proportions and the exact pose"])
def test_reference_guidance_allows_stylization_without_forcing_character_style(prompt_builder, prompt):
    request = LlmToBricksRequest(
        image_base64=base64.b64encode(b"reference image").decode(), prompt=prompt,
    )
    system = prompt_builder(request)
    assert "distinctive silhouette" in system
    assert "take creative liberty with proportions" in system
    assert "do not force every subject into the same style" in system
    assert "particular style take precedence" in system
    assert "large expressive head" in system
    assert "a compact body and short legs" in system
    assert "inset and projecting features" in system
    assert "prominent upper eyelids or eyelashes" in system
    assert "200-250 finished bricks" in system
    assert "at most 299" in system


@pytest.mark.parametrize("prompt_builder", [module._design_system_prompt, module._direct_system_prompt])
def test_reference_stylization_does_not_change_text_only_or_edit_requests(prompt_builder):
    text_request = LlmToBricksRequest(prompt="Pink-Haired Anime Girl")
    edit_request = LlmToBricksRequest(
        generation_id="existing-model", prompt="Recolor the hat",
        image_base64=base64.b64encode(b"reference image").decode(),
    )
    for request in (text_request, edit_request):
        assert "REFERENCE IMAGE DESIGN" not in prompt_builder(request)


@pytest.mark.parametrize("mode", ["design", "direct"])
@pytest.mark.parametrize("subject", ["a person", "a cartoon character", "a mug", None])
def test_generation_receives_compact_brick_budget(monkeypatch, mode, subject):
    request = LlmToBricksRequest(
        prompt=subject,
        image_base64=base64.b64encode(b"reference image").decode() if subject is None else None,
    )
    turns = ([_call("submit_brick_design", GOOD_DESIGN, "s1")]
             if mode == "design" else [_call("submit_ldr_model", {"ldr_content": VALID_PART}, "s1")])
    _, opened = _scripted(monkeypatch, turns)
    monkeypatch.setattr(module, "DESIGN_REVIEW_ROUNDS", 0)
    generate = module._generate_ldr_with_design if mode == "design" else module._generate_ldr_direct

    asyncio.run(generate(request))

    assert "at most 299" in opened["system"]
    assert "actual bricks after packing, not voxel cells" in opened["system"]
    assert "Use more bricks only" in opened["system"]
    assert "explicit large-scale request" in opened["system"]
    assert "150-500" not in opened["system"]
    if mode == "design":
        assert "detail reference, not a required size" in opened["system"]
        assert "aim for about 40 studs" not in opened["system"]
    if subject is None:
        assert "REFERENCE IMAGE DESIGN" in opened["system"]


@pytest.mark.parametrize("mode", ["design", "direct"])
@pytest.mark.parametrize("instruction", ["Make it bigger with 600 bricks", "Recolor the hat"])
def test_edit_preserves_scale_and_can_exceed_new_model_budget(monkeypatch, mode, instruction):
    request = LlmToBricksRequest(generation_id="existing-model", prompt=instruction)
    request._source_voxels = "0 0 0 201 26 9\n"
    turns = ([_call("submit_brick_design", GOOD_DESIGN, "e1"), _call("accept_design", {}, "e2")]
             if mode == "design" else [_call("submit_ldr_model", {"ldr_content": VALID_PART}, "e1")])
    conversation, opened = _scripted(monkeypatch, turns)
    monkeypatch.setattr(module, "DESIGN_REVIEW_ROUNDS", 1)
    generate = module._generate_ldr_with_design if mode == "design" else module._generate_ldr_direct

    asyncio.run(generate(request))

    assert "Preserve the existing model's scale" in opened["system"]
    assert "allow the brick count to grow as needed" in opened["system"]
    assert "at most 299" not in opened["system"]
    if mode == "design":
        feedback = conversation.tool_results[0][0].text
        assert "allow the brick count to grow as needed" in feedback
        assert "at most 299" not in feedback


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


def test_design_review_uses_final_converter_count_instead_of_draft_count(monkeypatch):
    conversation, _ = _scripted(monkeypatch, [
        _call("submit_brick_design", GOOD_DESIGN, "r1"),
        _call("accept_design", {}, "r2"),
    ])
    converted = []

    def convert(xyzrgb):
        converted.append(xyzrgb)
        return module.LlmBuild("\n".join([VALID_PART] * 346))

    monkeypatch.setattr(module, "_convert_design_voxels", convert)
    monkeypatch.setattr(module, "DESIGN_REVIEW_ROUNDS", 1)
    result = asyncio.run(module._generate_ldr_with_design(LlmToBricksRequest(prompt="a girl")))

    assert result.piece_count < 300
    assert converted == [result.xyzrgb()]
    feedback = conversation.tool_results[0][0].text
    assert "final voxel-to-brick converter produces 346 bricks" in feedback
    assert "Simplify or reduce an oversized design" in feedback


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
    assert "at most 299" in review_result.text
    assert "actual final count" in review_result.text
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
    assert notes == [
        "I am blocking out the tower silhouette.\n\n",
        "\n\nChecking the model's connections and stability.\n\n",
        "\n\nReviewing the model from two angles.\n\n",
    ]


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
    _, opened = _scripted(monkeypatch, [
        Turn(
            text="Checking the brick placement",
            tool_calls=[ToolCall("d1", "submit_ldr_model", {"ldr_content": VALID_PART})],
        ),
    ])
    notes = []

    async def on_thinking(delta):
        notes.append(delta)

    asyncio.run(module._generate_ldr_direct(LlmToBricksRequest(prompt="brick"), on_thinking))

    assert notes == ["Checking the brick placement\n\n"]
    assert "1-8 words" in opened["system"]


def test_background_generation_survives_request_cancellation(monkeypatch):
    from unittest.mock import AsyncMock
    from types import SimpleNamespace
    from src.utils import generation_storage as storage_module

    storage = SimpleNamespace(
        create_generation=AsyncMock(return_value="background-1"),
        get_generation=AsyncMock(return_value={"status": "processing"}),
    )
    monkeypatch.setattr(module, "generation_storage", storage)
    monkeypatch.setattr(storage_module, "generation_storage", storage)
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


def test_voxel_edit_loads_current_saved_voxels_and_checks_ownership(monkeypatch):
    from unittest.mock import AsyncMock
    from fastapi import HTTPException
    storage = AsyncMock()
    storage.get_generation.return_value = {
        "user_id": "owner", "user_type": "authenticated", "status": "completed",
        "xyzrgb_url": "saved-current", "design_voxels_url": "old-original",
    }
    storage.download_file_from_storage.return_value = b"0 0 0 255 0 0\n"
    monkeypatch.setattr(module, "generation_storage", storage)
    request = LlmToBricksRequest(prompt="blue roof", source_generation_id="source")
    asyncio.run(module._load_edit_source(request, {"authenticated": True, "user_id": "owner"}))
    storage.download_file_from_storage.assert_awaited_once_with("saved-current")
    assert "0 0 0 255 0 0" in module._user_input(request).text
    storage.download_file_from_storage.reset_mock()
    with pytest.raises(HTTPException):
        asyncio.run(module._load_edit_source(request, {"authenticated": True, "user_id": "other"}))
    storage.download_file_from_storage.assert_not_awaited()


def test_voxel_patch_preserves_untouched_cells_and_uses_shared_converter(monkeypatch):
    from unittest.mock import AsyncMock
    request = LlmToBricksRequest(prompt="change one color", source_generation_id="source")
    request._source_voxels = "0 0 0 255 0 0\n1 0 0 255 0 0\n2 0 0 255 0 0\n"
    conversation = AsyncMock()
    conversation.send.return_value = Turn(tool_calls=[ToolCall("edit", "edit_voxels", {
        "set": [[0, 0, 0, 0, 0, 255]], "remove": [[2, 0, 0]],
    })])
    monkeypatch.setattr(module, "_open_conversation", lambda *args: conversation)
    monkeypatch.setattr(module, "_convert_design_voxels", lambda content: module.LlmBuild("ldr", content))
    result = asyncio.run(module._generate_ldr(request))
    assert result.voxels_xyzrgb == "0 0 0 0 0 255\n1 0 0 255 0 0\n"


@pytest.mark.parametrize("content", ["", "0 0 0 256 0 0", "0 0 0 1 2", "nan 0 0 0 0 0"])
def test_voxel_edit_rejects_invalid_cells(content):
    with pytest.raises(ValueError):
        module._voxel_cells(content)
