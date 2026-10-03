import asyncio
import json
import base64
import io
from types import SimpleNamespace

import pytest
from PIL import Image

from src.utils import nova_agent, nova_toolkit
from src.utils.llm_tool_conversation import ToolCall, ToolResult, Turn, ConversationSettings, UserInput
from src.utils.nova_agent import NativeToolConversation, build_set, validate_connection_acceptance
from src.utils.nova_toolkit import MAX_REPORT_CHARS, NovaBuild, NovaToolkit, serialize_feedback, validate_plan_boundary


def plan_for(reference="3001.dat", repeat=None):
    placement = {"id": "brick", "ref": reference, "colour": 4, "at": [0, 0, 0]}
    if repeat:
        placement["repeat"] = repeat
    return {"version": 1, "author": "test", "sections": [
        {"name": "main.ldr", "description": "test", "steps": [[placement]]}]}


def test_plan_boundary_limits_io_references_cycles_and_expansion():
    validate_plan_boundary(plan_for(), 100)
    validate_plan_boundary(plan_for("@parts.Bricks.B2x4"), 100)
    unsafe = [plan_for("../secrets.dat"), plan_for("main.ldr"),
              plan_for(repeat={"count": 101, "step": [20, 0, 0]})]
    included = plan_for()
    included["includes"] = ["/etc/passwd"]
    unsafe.append(included)
    non_finite = plan_for()
    non_finite["sections"][0]["steps"][0][0]["at"][0] = float("nan")
    unsafe.append(non_finite)
    for candidate in unsafe:
        with pytest.raises(ValueError):
            validate_plan_boundary(candidate, 100)


def test_plan_boundary_counts_repeated_subassemblies():
    plan = plan_for("module.ldr", {"count": 10, "step": [100, 0, 0]})
    child = plan_for(repeat={"count": 20, "step": [20, 0, 0]})["sections"][0]
    child["name"] = "module.ldr"
    plan["sections"].append(child)
    with pytest.raises(ValueError, match="part limit"):
        validate_plan_boundary(plan, 100)


def test_toolkit_resources_are_scoped_and_virtualenv_path_is_preserved(monkeypatch, tmp_path):
    root = tmp_path / "toolkit"
    docs = root / "docs" / "agent"
    docs.mkdir(parents=True)
    (docs / "geometry.md").write_text("Geometry manual")
    monkeypatch.setenv("NOVA_TOOLKIT_ROOT", str(root))
    monkeypatch.setenv("NOVA_PYTHON", str(root / ".venv" / "bin" / "python"))
    toolkit = NovaToolkit(tmp_path)
    assert toolkit.read_resource("docs/agent/geometry.md") == "Geometry manual"
    assert str(toolkit.python).endswith(".venv/bin/python")
    for path in ("../../secret", "instructions.md", "docs/agent/geometry.sh"):
        with pytest.raises(ValueError):
            toolkit.read_resource(path)


def test_search_falls_back_to_fts_when_jev_fails(monkeypatch, tmp_path):
    monkeypatch.setenv("TYPESAFE_API_KEY", "secret-not-forwarded")
    toolkit = NovaToolkit(tmp_path)
    commands = []

    async def fake_run(arguments):
        commands.append(list(arguments))
        if "jev" in arguments:
            raise ValueError("provider unavailable")
        return {"results": [{"code": "3001.dat"}]}

    monkeypatch.setattr(toolkit, "run", fake_run)
    result = asyncio.run(toolkit.search("parts", "brick"))
    assert result["engine"] == "fts"
    assert "jev" in commands[0] and commands[1][:2] == ["search", "parts"]


def test_offline_search_skips_indexing_and_catalog_only_measures_parts(monkeypatch, tmp_path):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    toolkit = NovaToolkit(tmp_path)
    commands = []

    async def fake_run(arguments):
        commands.append(list(arguments))
        return {"results": []}

    monkeypatch.setattr(toolkit, "run", fake_run)
    asyncio.run(toolkit.search("models", "castle"))
    asyncio.run(toolkit.dispatch("catalog", {"kind": "colours", "query": "red"}, 0))
    asyncio.run(toolkit.dispatch("catalog", {"kind": "parts", "query": "slope"}, 0))
    assert commands[0][:2] == ["search", "models"]
    assert "--measure" not in commands[1] and "--measure" in commands[2]


def test_failed_build_invalidates_previous_candidate(monkeypatch, tmp_path):
    toolkit = NovaToolkit(tmp_path)
    toolkit.last_build = object()

    async def failed_run(arguments):
        return {"checks_passed": False, "written": False, "diagnostics": [{"code": "collision"}]}

    monkeypatch.setattr(toolkit, "run", failed_run)
    report, image = asyncio.run(toolkit.build(plan_for(), 2))
    assert report["accepted"] is False and image is None
    assert toolkit.last_build is None


class FakeConversation:
    def __init__(self, turns):
        self.turns = iter(turns)
        self.results = []

    async def send(self):
        return next(self.turns)

    def add_tool_results(self, results):
        self.results.extend(results)

    def add_user_text(self, text):
        pass


def test_agent_requires_visual_review_in_a_later_turn(monkeypatch, tmp_path):
    build = NovaBuild("ldr", "mpd", {}, {}, b"preview")

    class FakeToolkit:
        last_build = None
        last_build_turn = -1

        def __init__(self, *args):
            pass

        def require_ready(self):
            pass

        async def dispatch(self, name, arguments, turn_number):
            self.last_build, self.last_build_turn = build, turn_number
            return {"accepted": True}, build.preview_png

    review = {"review": "Both views match the subject; physical stability remains unproven."}
    conversation = FakeConversation([
        Turn([ToolCall("b", "submit_plan", {"plan": {}}), ToolCall("a", "accept_model", review)]),
        Turn([ToolCall("final", "accept_model", review)]),
    ])
    monkeypatch.setattr(nova_agent, "NovaToolkit", FakeToolkit)
    monkeypatch.setattr(nova_agent, "create_conversation", lambda *args: conversation)
    request = SimpleNamespace(model="gpt-5.5", auth_mode="api_key", prompt="castle", image_base64=None,
                              image_media_type="image/png", max_parts=5000, max_iterations=4, use_jev=False)
    result = asyncio.run(build_set(request, "openai", tmp_path))
    assert result is build
    assert any(response.call_id == "a" and response.is_error for response in conversation.results)
    assert build.report["agent_review"] == review["review"]


def test_native_cli_returns_tool_protocol_without_executing_model_code(monkeypatch, tmp_path):
    from src.utils import local_provider_agent
    prompts = []

    async def fake_run(provider, workspace, prompt, **kwargs):
        prompts.append((provider, prompt, kwargs))
        return json.dumps({"text": "Searching real parts", "tool_calls": [{"name": "search_references", "input": {"kind": "parts", "query": "wheel"}}]})

    monkeypatch.setattr(local_provider_agent, "run_cli_agent", fake_run)
    settings = ConversationSettings("gpt-5.5", "system", nova_agent.TOOLS, 1000)
    conversation = NativeToolConversation(None, settings, UserInput("car"), "openai", tmp_path)
    turn = asyncio.run(conversation.send())
    assert turn.tool_calls[0].name == "search_references"
    assert "TOOLS:" in prompts[0][1] and "CONVERSATION:" in prompts[0][1]
    assert prompts[0][2]["model"] == "gpt-5.5"


def test_native_conversation_keeps_the_reference_image_and_reports_real_activity(monkeypatch, tmp_path):
    from src.utils import local_provider_agent
    images, activity = [], []
    png = io.BytesIO()
    Image.new("RGB", (10, 10), "red").save(png, "PNG")

    async def fake_run(provider, workspace, prompt, **kwargs):
        images.extend(kwargs["image_paths"])
        return '{"text":"Refining the red roof","tool_calls":[]}'

    async def output(text):
        activity.append(text)

    monkeypatch.setattr(local_provider_agent, "run_cli_agent", fake_run)
    settings = ConversationSettings("gpt-5.5", "system", nova_agent.TOOLS, 1000)
    conversation = NativeToolConversation(None, settings, UserInput("car", base64.b64encode(png.getvalue()).decode()), "openai", tmp_path)
    for index in range(7):
        conversation.add_tool_results([ToolResult(str(index), "view", png.getvalue())])
    asyncio.run(conversation.send_stream(output))
    assert len(images) == 5 and images[0].name == "reference.png"
    assert "Refining the red roof\n\n" in activity


def disconnected_build(coverage=None):
    return NovaBuild("ldr", "mpd", {}, {"geometry": {
        "complete": True, "contacts_checked": True, "occurrence_count": 10,
        "optimistic_component_count": 3,
        "connection_coverage": coverage or {"complete": 10, "partial": 0, "none": 0},
    }}, b"preview")


def test_accept_requires_repair_of_disconnected_parts_with_complete_coverage():
    build = disconnected_build()
    with pytest.raises(ValueError, match="Repair floating"):
        validate_connection_acceptance(build, "Build one modular lookout station", None)
    with pytest.raises(ValueError, match="does not describe"):
        validate_connection_acceptance(build, "Build one modular lookout station",
            "The three separate vehicles intentionally stand apart from one another.")


def test_accept_allows_explained_independent_objects_requested_by_the_user():
    build = disconnected_build()
    explanation = "The station and the two requested cars are independent assembled objects, each intended to stand separately."
    validate_connection_acceptance(build, "Build a station with two cars", explanation)
    assert build.report["intentional_independent_assemblies"] == explanation


def test_incomplete_connection_metadata_does_not_claim_proven_disconnection():
    validate_connection_acceptance(disconnected_build({"complete": 8, "partial": 2, "none": 0}),
                                   "Build one station", None)


@pytest.mark.parametrize("prompt, explanation", [
    ("Build a lookout station with no separate loose objects", "The separate assemblies are intentional independent objects in this model."),
    ("Build a diorama, but do not include separate objects", "The independent objects intentionally form a display scene and diorama."),
    ("Build a garage without cars", "The requested cars are separate vehicles, intentionally independent from the garage."),
    ("Build a single car", "The car body and wheels are separate vehicles and intentionally independent assemblies."),
    ("Build an aircraft with landing gear", "The aircraft body and gear are separate independent vehicle assemblies."),
    ("Build one minifigure", "The figure torso, legs and head are intentional independent figure assemblies."),
])
def test_negated_and_single_object_contexts_cannot_excuse_disconnected_parts(prompt, explanation):
    with pytest.raises(ValueError, match="does not describe"):
        validate_connection_acceptance(disconnected_build(), prompt, explanation)


@pytest.mark.parametrize("prompt, explanation", [
    ("Build a garage with a car", "The garage and its requested car are separate fully assembled objects, with the vehicle intentionally movable."),
    ("Build a castle with a minifigure", "The castle and its requested minifigure are independent assembled objects for the figure to move around the castle."),
    ("Build a fleet of aircraft", "The aircraft are independent vehicles that form the requested fleet and can be displayed separately."),
    ("Build two red aircraft", "The two requested aircraft are independent vehicle models and intentionally displayed separately."),
    ("Build cars, without minifigures", "The requested cars are independent vehicles, each separately assembled and intended to move freely."),
])
def test_affirmative_multi_object_set_intent_remains_available(prompt, explanation):
    validate_connection_acceptance(disconnected_build(), prompt, explanation)


def test_large_inspection_feedback_preserves_connection_groups_and_placement_mapping():
    instances = [{"index": index, "part": "3005.dat", "position": [40, -24 * index, 0],
                  "matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "section": "tower.ldr",
                  "description": "bulky metadata " * 200, "connection_metadata": {"coverage": "complete"}}
                 for index in range(52)]
    report = {"checks_passed": True, "diagnostics": [], "geometry": {
        "complete": True, "occurrence_count": 52, "connection_coverage": {"complete": 52, "partial": 0, "none": 0},
        "contacts_checked": True, "optimistic_component_count": 3, "confirmed_component_count": 3,
        "diagnostics": [{"code": "assembly.disconnected_evidence", "component_count": 3}],
        "instances": instances, "contacts": [{"feature_ids": ["large-contact-data" * 200]}] * 100,
        "optimistic_components": [list(range(50)), [50], [51]],
        "confirmed_components": [list(range(50)), [50], [51]], "overlaps": [],
    }}
    raw = json.dumps(report)
    assert raw.index('"optimistic_components"') > MAX_REPORT_CHARS
    serialized = serialize_feedback(report)
    assert len(serialized) <= MAX_REPORT_CHARS
    feedback = json.loads(serialized)
    geometry = feedback["geometry"]
    assert geometry["optimistic_components"][-2:] == [[50], [51]]
    assert geometry["diagnostics"][0]["code"] == "assembly.disconnected_evidence"
    assert geometry["instances"][51]["position"] == [40, -1224, 0]
    assert "contacts" not in geometry and "description" not in geometry["instances"][0]
    assert "omitted" in geometry["feedback_note"]


def test_oversized_resource_feedback_stays_valid_json_and_reports_omission():
    encoded = serialize_feedback({"source": "examples/large.plan.json", "content": '"source"\n' * 12_000})
    assert len(encoded) <= MAX_REPORT_CHARS
    result = json.loads(encoded)
    assert result["feedback_truncated"] is True and result["source"] == "examples/large.plan.json"


def test_resource_pagination_preserves_every_character_and_validates_offsets(monkeypatch, tmp_path):
    root = tmp_path / "toolkit"
    directory = root / "docs" / "agent"
    directory.mkdir(parents=True)
    source = "page-one " * 2000 + "SECOND-PAGE-MARKER\n" + "page-two " * 2100
    (directory / "large.md").write_text(source)
    monkeypatch.setenv("NOVA_TOOLKIT_ROOT", str(root))
    toolkit = NovaToolkit(tmp_path)
    first, image = asyncio.run(toolkit.dispatch("read_resource", {"path": "docs/agent/large.md"}, 0))
    assert image is None and len(first["content"]) == 18_000
    assert first["next_offset"] == 18_000 and first["total_chars"] == len(source)
    second, _ = asyncio.run(toolkit.dispatch("read_resource", {"path": "docs/agent/large.md", "offset": first["next_offset"]}, 0))
    assert second["content"].startswith("SECOND-PAGE-MARKER\n")
    third = toolkit.read_resource_page("docs/agent/large.md", second["next_offset"])
    assert third["next_offset"] is None
    assert first["content"] + second["content"] + third["content"] == source
    for offset in (-1, len(source) + 1, True, "18000", 1.5):
        with pytest.raises(ValueError, match="offset"):
            toolkit.read_resource_page("docs/agent/large.md", offset)


def test_escape_heavy_resource_pages_keep_correct_cursors_after_serialization(monkeypatch, tmp_path):
    root = tmp_path / "toolkit"
    directory = root / "docs" / "agent"
    directory.mkdir(parents=True)
    source = "\u2603" * 25_000
    (directory / "unicode.md").write_text(source)
    monkeypatch.setenv("NOVA_TOOLKIT_ROOT", str(root))
    toolkit = NovaToolkit(tmp_path)
    pages, offset = [], 0
    while offset is not None:
        page = toolkit.read_resource_page("docs/agent/unicode.md", offset)
        encoded = serialize_feedback(page)
        assert len(encoded) <= MAX_REPORT_CHARS
        assert json.loads(encoded)["content"] == page["content"]
        pages.append(page["content"])
        offset = page["next_offset"]
    assert "".join(pages) == source
