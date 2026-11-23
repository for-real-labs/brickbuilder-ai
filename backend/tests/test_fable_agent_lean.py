import json
from decimal import Decimal

import httpx
import pytest
from fable_agent.app import METHODS, Options, Workbench, continue_build, start_build
from fable_agent.lean import LEAN_TOOLS
from fable_agent.catalog import PartEntry
from fable_agent.prompts import lean_system_prompt, part_facts, system_prompt
from fable_agent.provider import AnthropicClient, Budget, BudgetExhausted, ModelReply
from fable_agent.session import Session
from PIL import Image

from fable_agent_support import CABIN, FakeClient, FakeRenderer, InlineRunner, World, reply, tool_use

LEAN = Options(max_parts=500, method="lean")


@pytest.fixture(autouse=True)
def private_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("FABLE_AGENT_CACHE", str(tmp_path / "cache"))


def bench(world):
    return Workbench.open(world.settings(), runner=InlineRunner(world), renderer=FakeRenderer())


def run(tmp_path, replies, *, options=LEAN, reference=None):
    world = World(tmp_path / "world")
    client = FakeClient(replies)
    result = start_build("A small cabin", tmp_path / "run", options, client=client, workbench=bench(world),
                         reference=reference)
    return result, client, Session.load(tmp_path / "run"), world


def state_text(request) -> str:
    return next(block["text"] for block in reversed(request["messages"][0]["content"]) if block["type"] == "text")


def pictures(request) -> list:
    return [block for block in request["messages"][0]["content"] if block["type"] == "image"]


def three_rounds():
    return [
        reply(tool_use("build", "c1", code=CABIN, notes="Walls are two courses; add a third.")),
        reply(tool_use("patch", "c2", notes="Third course added.", views=["front", "top"],
                       edits=[{"old": "range(2)", "new": "range(3)"}])),
        reply(tool_use("finish", "c3", title="Lake cabin", summary="A small blue cabin.")),
    ]


def test_a_lean_build_is_built_patched_and_published_in_three_rounds(tmp_path):
    result, client, session, _ = run(tmp_path, three_rounds())
    assert result.status == "published" and result.steps == 3 and result.published["title"] == "Lake cabin"
    assert session.meta["settings"]["method"] == "lean" and session.meta["tools"] == LEAN_TOOLS
    assert "range(3)" in (tmp_path / "run" / "published" / "001" / "build.py").read_text()
    assert json.loads((tmp_path / "run" / "published" / "001" / "report.json").read_text())["ok"] is True
    assert len(session.meta["usage"]) == 3


def test_every_round_is_one_fresh_message_that_carries_only_the_current_state(tmp_path):
    _, client, session, _ = run(tmp_path, three_rounds())
    first, second, third = client.requests
    assert all(len(request["messages"]) == 1 and request["messages"][0]["role"] == "user"
               for request in client.requests)
    assert first["system"] == third["system"] == session.meta["system"]

    assert "There is no build script yet" in state_text(first) and "Round 1." in state_text(first)
    assert not pictures(first)

    # Round two opens on the result of round one: its script, report, pictures and the note.
    text = state_text(second)
    assert "Current build script (revision 1)" in text and "range(2)" in text
    assert "BUILD OK" in text and "Walls are two courses; add a third." in text
    assert len(pictures(second)) == 3 and pictures(second)[0]["source"]["type"] == "base64"

    # Round three shows the patched script and the two views it asked for; nothing of round one remains.
    text = state_text(third)
    assert "revision 2" in text and "range(3)" in text and "range(2)" not in text
    assert "Third course added." in text and "Walls are two courses" not in text
    assert "front, top" in text and len(pictures(third)) == 2
    sizes = [len(json.dumps(request["messages"])) for request in client.requests]
    assert sizes[2] < sizes[1] * 1.2  # the request does not grow with the number of rounds

    # The stored transcript is a record with file references, not a conversation to replay.
    assert "base64" not in json.dumps(session.messages) and len(session.messages) == 6


def test_the_brief_is_the_cached_prefix_and_keeps_the_reference_picture(tmp_path):
    photo = tmp_path / "photo.png"
    Image.new("RGB", (64, 48), (90, 120, 160)).save(photo)
    _, client, _, _ = run(tmp_path, three_rounds(), reference=photo)
    for request in client.requests:
        content = request["messages"][0]["content"]
        assert content[0]["type"] == "image" and "Request: A small cabin" in content[1]["text"]
        assert content[1]["cache_control"] == {"type": "ephemeral"}
        assert [index for index, block in enumerate(content) if "cache_control" in block] == [1]
    assert client.requests[0]["messages"][0]["content"][:2] == client.requests[2]["messages"][0]["content"][:2]


def test_finish_needs_a_clean_build_that_the_model_is_looking_at(tmp_path):
    broken = "place('3001', 'Red', 0, 0, 0)\nplace('3001', 'Red', 0, 9, 0)\n"
    result, client, _, _ = run(tmp_path, [
        reply(tool_use("finish", "c0", title="x", summary="y")),
        reply(tool_use("build", "c1", code=broken, notes="first try")),
        reply(tool_use("finish", "c2", title="x", summary="y")),
        reply(tool_use("build", "c3", code="this is not python", notes="oops")),
        reply(tool_use("build", "c4", code=CABIN, notes="clean now")),
        reply(tool_use("finish", "c5", title="Cabin", summary="Done.")),
    ])
    assert result.status == "published" and result.steps == 6
    told = [state_text(request) for request in client.requests]
    assert "no build to look at yet" in told[1]
    assert "BUILD HAS ERRORS" in told[2] and len(pictures(client.requests[2])) == 3  # errors are still shown
    assert "still has errors" in told[3]
    assert "SCRIPT FAILED" in told[4] and not pictures(client.requests[4])


def test_a_patch_is_all_or_nothing_and_says_which_edit_failed(tmp_path):
    result, client, session, _ = run(tmp_path, [
        reply(tool_use("patch", "c0", notes="", edits=[{"old": "a", "new": "b"}])),
        reply(tool_use("build", "c1", code=CABIN, notes="built")),
        reply(tool_use("patch", "c2", notes="n", edits=[{"old": "range(2)", "new": "range(3)"},
                                                       {"old": "not in the script", "new": "x"}])),
        reply(tool_use("patch", "c3", notes="n", edits=[{"old": "fill(", "new": "fill ("}])),
        reply(tool_use("patch", "c4", notes="n", edits=[{"old": "fill(", "new": "fill (", "replace_all": True}])),
        reply(tool_use("patch", "c5", notes="n", edits="everything")),
        reply(tool_use("finish", "c6", title="Cabin", summary="Done.")),
    ])
    told = [state_text(request) for request in client.requests]
    assert "use build first" in told[1]
    assert "Edit 2: 'old' was not found" in told[3] and "range(2)" in told[3]  # edit 1 was not applied either
    assert len(pictures(client.requests[3])) == 3  # the last good pictures are still the current revision's
    assert "Edit 1: 'old' matches 2 places" in told[4]
    assert "fill (" in told[5] and "'edits' must list" in told[6]
    assert result.status == "published" and session.meta["revision"] == 2


def test_looked_up_facts_stay_in_view_and_notes_are_replaced(tmp_path):
    result, client, session, _ = run(tmp_path, [
        reply(tool_use("look_up", "c0", parts=["3039", "nope"], search="plate 2 x 4", notes="Roof uses 3039.")),
        reply(tool_use("look_up", "c1")),
        reply(tool_use("build", "c2", code=CABIN, notes="")),
        reply(tool_use("finish", "c3", title="Cabin", summary="Done.")),
    ])
    second, third, fourth = (state_text(request) for request in client.requests[1:])
    assert "Parts you looked up:" in second and "3039: Slope Brick 45 2 x 2" in second
    assert "low or open side points to the front" in second and "Search 'plate 2 x 4'" in second
    assert "3020" in second and "Roof uses 3039." in second
    assert "Give up to 12 part ids" in third
    assert "3039: Slope Brick 45" in fourth and "Roof uses 3039." in fourth  # an empty note keeps the old one
    assert result.status == "published"


def test_a_run_that_reaches_its_round_limit_keeps_the_last_clean_build_as_a_draft(tmp_path):
    result, client, session, _ = run(tmp_path, [
        reply(tool_use("build", "c1", code=CABIN, notes="a")),
        reply({"type": "text", "text": "Looks good to me."}),
        reply(tool_use("build", "c2", code="x = (", notes="b"), stop_reason="max_tokens"),
    ], options=Options(max_parts=500, method="lean", max_steps=3))
    assert result.status == "draft" and result.reason == "round limit reached" and result.steps == 3
    assert "Round 3. This is the last round" in state_text(client.requests[2])
    assert "took no action" in state_text(client.requests[2])
    assert "1 more round after this one" in state_text(client.requests[1])
    assert session.meta["revision"] == 1  # the cut-off script was never run
    assert (tmp_path / "run" / "published" / "001" / "build.py").read_text() == CABIN


def test_a_refusal_ends_the_run_and_a_spent_budget_stops_before_the_next_call(tmp_path):
    result, _, session, _ = run(tmp_path, [reply(stop_reason="refusal")])
    assert result.status == "refused" and session.messages == []

    costly = {"input_tokens": 1000, "output_tokens": 20_000}  # $0.81 a round on claude-fable-5-2
    result, client, _, _ = run(tmp_path / "second", [
        reply(tool_use("build", "c1", code=CABIN, notes="a"), usage=costly),
        reply(tool_use("patch", "c2", notes="b", edits=[{"old": "range(2)", "new": "range(3)"}]), usage=costly),
    ], options=Options(max_parts=500, method="lean", budget_usd=1.7))
    assert result.status == "draft" and result.reason == "AI budget used up" and len(client.requests) == 2


def test_a_follow_up_edit_adds_to_the_brief_and_starts_from_the_published_script(tmp_path):
    result, client, session, world = run(tmp_path, three_rounds())
    later = FakeClient([
        reply(tool_use("patch", "c4", notes="red now", edits=[{"old": '"Sand_Blue"', "new": '"Red"'}])),
        reply(tool_use("finish", "c5", title="Red cabin", summary="Now red.")),
    ])
    # The session decides the method: the options passed for an edit cannot switch it.
    again = continue_build("Make it red", tmp_path / "run", Options(method="thorough"), client=later,
                           workbench=bench(world))
    assert again.status == "published" and again.published["title"] == "Red cabin" and again.steps == 2
    content = later.requests[0]["messages"][0]["content"]
    assert content[0]["text"].startswith("Request: A small cabin")
    assert content[1]["text"] == "Change request: Make it red" and "cache_control" in content[1]
    assert "A new request was added" in state_text(later.requests[0]) and "range(3)" in state_text(later.requests[0])
    assert len(pictures(later.requests[0])) == 2  # the pictures of the revision being changed
    assert later.requests[0]["tools"] == LEAN_TOOLS
    assert Session.load(tmp_path / "run").meta["published"][-1]["number"] == 2


def test_the_lean_prompt_carries_measured_part_facts_and_names_only_its_own_tools(tmp_path):
    world = World(tmp_path)
    prompt = lean_system_prompt(world.finder, world.shapes, "test parts")
    assert "3001 2 x 4 (6) {4x2x3}" in prompt and "3070b 1 x 1 with Groove (6) {1x1x1 smooth}" in prompt
    assert part_facts(world.shapes)(world.finder.entry("3039")) == " {2x2x3 low:front}"
    assert part_facts(world.shapes)(PartEntry("no-such-part", "", "", 1)) == ""
    for theirs in ("inspect_part", "search_parts", "write_script", "edit_script", "read_script", "`render`"):
        assert theirs not in prompt
    for ours in ("`build`", "`patch`", "`look_up`", "`finish`", "# The kit", "# What holds together", "Sand_Blue"):
        assert ours in prompt
    # The thorough method's prompt is untouched by the lean one.
    thorough = system_prompt(world.finder, "test parts")
    assert "inspect_part" in thorough and "{2x2x3" not in thorough and "`patch`" not in thorough


def test_each_method_has_its_own_limits_unless_the_caller_sets_them():
    assert METHODS["lean"]["budget_usd"] < METHODS["thorough"]["budget_usd"]
    lean, thorough = Options(method="lean").resolved("lean"), Options().resolved("thorough")
    assert (lean.effort, lean.budget_usd, lean.max_steps) == ("medium", 2.0, 8)
    assert (thorough.effort, thorough.budget_usd, thorough.max_steps) == ("high", 8.0, 60)
    custom = Options(effort="low", budget_usd=0.5, max_steps=3).resolved("lean")
    assert (custom.effort, custom.budget_usd, custom.max_steps, custom.method) == ("low", 0.5, 3, "lean")
    with pytest.raises(ValueError, match="Unknown method"):
        Options().resolved("fast")


def test_a_stateless_round_reserves_only_its_own_request():
    budget = Budget("1.00", "claude-fable-5-2")
    budget.record(ModelReply([], "end_turn", {"input_tokens": 50_000, "output_tokens": 5_000}, "claude-fable-5-2"))
    assert budget.spent == Decimal("0.6")
    with pytest.raises(BudgetExhausted):  # a growing conversation would send those 55K tokens again
        budget.output_allowance(1000, 32_000)
    assert budget.output_allowance(1000, 32_000, carried_context=False) == 9_750  # ($0.40 - $0.01) / $40 per M


def test_claude_requests_can_leave_the_cache_point_to_the_caller():
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(500, json={"error": {"type": "api_error", "message": "x"}})

    for auto in (True, False):
        client = AnthropicClient("k", http=httpx.Client(transport=httpx.MockTransport(handler)),
                                 sleep=lambda s: None, max_retries=0, auto_cache=auto)
        with pytest.raises(Exception):
            client.send("s", [], [{"role": "user", "content": "hi"}], max_tokens=100)
    assert "cache_control" in bodies[0] and "cache_control" not in bodies[1]
    assert bodies[1]["system"][0]["cache_control"] == {"type": "ephemeral"}
