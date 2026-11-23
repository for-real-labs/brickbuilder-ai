import json

import pytest
from fable_agent.app import Options, Workbench, continue_build, save_reference, start_build
from fable_agent.session import Session, SessionError
from fable_agent.tools import TOOL_DEFINITIONS
from PIL import Image

from fable_agent_support import CABIN, FakeClient, FakeRenderer, InlineRunner, World, reply, tool_use

THINKING = {"type": "thinking", "thinking": "", "signature": "sig-1"}


@pytest.fixture(autouse=True)
def private_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("FABLE_AGENT_CACHE", str(tmp_path / "cache"))


def bench(world, renderer=None):
    return Workbench.open(world.settings(), runner=InlineRunner(world), renderer=renderer or FakeRenderer())


def run(tmp_path, replies, *, options=None, renderer=None, events=None, reference=None):
    world = World(tmp_path / "world")
    client = FakeClient(replies)
    result = start_build("A small cabin", tmp_path / "run", options or Options(max_parts=500), client=client,
                         workbench=bench(world, renderer), reference=reference,
                         on_event=(lambda kind, data: events.append((kind, data))) if events is not None else None)
    return result, client, Session.load(tmp_path / "run"), world


def happy_path():
    return [
        reply(THINKING, tool_use("write_script", "c1", code=CABIN)),
        reply(tool_use("render", "c2", views=["front-right", "back-left"])),
        reply(tool_use("finish", "c3", title="Lake cabin", summary="A small blue cabin on a green base.")),
    ]


def test_a_build_goes_from_script_to_published_model(tmp_path):
    events = []
    result, client, session, _ = run(tmp_path, happy_path(), events=events)
    assert result.status == "published" and result.steps == 3
    assert result.published["title"] == "Lake cabin" and result.published["parts"] > 4
    published = tmp_path / "run" / "published" / "001"
    assert {p.name for p in published.iterdir()} >= {"model.ldr", "build.py", "bom.csv", "report.json", "preview.png"}
    assert (published / "model.ldr").read_bytes().startswith(b"0 Lake cabin\r\n")
    assert (published / "build.py").read_text() == CABIN
    assert "3020,2,Green" in (published / "bom.csv").read_text()
    assert json.loads((published / "report.json").read_text())["ok"] is True
    assert session.meta["status"] == "published" and len(session.meta["usage"]) == 3
    assert [kind for kind, _ in events if kind in ("tool_call", "done")] == ["tool_call"] * 3 + ["done"]


def test_history_is_append_only_and_the_prompt_stays_frozen(tmp_path):
    _, client, session, _ = run(tmp_path, happy_path())
    first, second, third = client.requests
    assert first["system"] == second["system"] == third["system"] == session.meta["system"]
    assert first["tools"] == third["tools"] == TOOL_DEFINITIONS
    assert second["messages"][:len(first["messages"])] == first["messages"]
    assert third["messages"][:len(second["messages"])] == second["messages"]
    # The model's thinking block is passed back exactly as it arrived.
    assert second["messages"][1]["content"][0] == THINKING
    # Pictures are sent as base64 but stored as files, and the same bytes are sent every time.
    stored = session.messages[4]["content"][0]["content"][1]
    assert stored["source"]["type"] == "session_file"
    sent = third["messages"][4]["content"][0]["content"][1]
    assert sent["source"]["type"] == "base64" and sent["source"]["media_type"] == "image/png"
    assert "base64" not in json.dumps(session.messages)
    assert session.api_messages() == session.api_messages()
    assert "Catalog" in first["system"] and "3001" in first["system"] and "Sand_Blue" in first["system"]
    assert "Part limit: at most 500 parts" in first["messages"][0]["content"][-1]["text"]


def test_finish_is_refused_until_the_build_is_clean_and_has_been_looked_at(tmp_path):
    broken = "place('3001', 'Red', 0, 0, 0)\nplace('3001', 'Red', 0, 9, 0)\n"
    result, client, session, _ = run(tmp_path, [
        reply(tool_use("finish", "c0", title="x", summary="y")),
        reply(tool_use("write_script", "c1", code=broken)),
        reply(tool_use("finish", "c2", title="x", summary="y")),
        reply(tool_use("edit_script", "c3", old="0, 9, 0", new="0, 3, 0")),
        reply(tool_use("finish", "c4", title="x", summary="y")),
        reply(tool_use("render", "c5")),
        reply(tool_use("finish", "c6", title="Tower", summary="Two bricks.")),
    ])
    results = [m["content"][0] for m in session.messages if m["role"] == "user" and m["content"][0].get("type") == "tool_result"]
    texts = [r["content"][0]["text"] for r in results]
    assert "no build to look at" in texts[0] and results[0]["is_error"]
    assert "BUILD HAS ERRORS" in texts[1] and "[floating]" in texts[1]
    assert "still has errors" in texts[2]
    assert "Revision 2. BUILD OK" in texts[3]
    assert "has not been rendered" in texts[4]
    assert result.status == "published" and result.published["revision"] == 2


def test_script_failures_come_back_with_the_failing_line(tmp_path):
    _, _, session, _ = run(tmp_path, [
        reply(tool_use("write_script", "c1", code="print('hi')\nplace('3001', 'Blurple', 0, 0, 0)\n")),
        reply({"type": "text", "text": "I give up."}),
        reply({"type": "text", "text": "Still nothing."}),
    ])
    failure = session.messages[2]["content"][0]
    assert failure["is_error"] is True
    text = failure["content"][0]["text"]
    assert "SCRIPT FAILED (line 2: place('3001', 'Blurple', 0, 0, 0))" in text and "hi" in text


def test_a_model_that_stops_early_is_nudged_once_then_the_run_fails_honestly(tmp_path):
    result, client, session, _ = run(tmp_path, [reply({"type": "text", "text": "Done?"}),
                                                reply({"type": "text", "text": "Really done."})])
    assert result.status == "failed" and result.published is None
    assert "stopped without publishing" in session.messages[2]["content"][0]["text"]
    assert len(client.requests) == 2


def test_the_last_clean_revision_is_kept_as_a_draft_when_steps_run_out(tmp_path):
    result, _, session, _ = run(tmp_path, [
        reply(tool_use("write_script", "c1", code=CABIN)),
        reply(tool_use("write_script", "c2", code=CABIN + "place('3001', 'Red', 20, 20, 20)\n")),
    ], options=Options(max_steps=2, max_parts=500))
    assert result.status == "draft" and result.reason == "step limit reached"
    assert result.published["revision"] == 1 and result.published["status"] == "draft"
    assert (tmp_path / "run" / "published" / "001" / "build.py").read_text() == CABIN
    assert "Harness note: only 1 steps remain" in session.messages[2]["content"][-1]["text"]


def test_the_budget_stops_the_run_before_it_overspends(tmp_path):
    costly = {"input_tokens": 100_000, "output_tokens": 5_000}
    result, client, _, _ = run(tmp_path, [reply(tool_use("write_script", "c1", code=CABIN), usage=costly),
                                          reply(tool_use("render", "c2"))],
                               options=Options(budget_usd=1.5, max_parts=500))
    assert len(client.requests) == 1  # the next call could not be afforded
    assert result.status == "draft" and result.reason == "AI budget used up"
    assert float(result.spent_usd) == pytest.approx(1.0)


def test_a_refusal_ends_the_run_and_is_not_replayed(tmp_path):
    result, _, session, _ = run(tmp_path, [reply(stop_reason="refusal", stop_details={"category": "cyber"})])
    assert result.status == "refused"
    assert [m["role"] for m in session.messages] == ["user"]


def test_cut_off_or_malformed_tool_calls_are_answered_but_never_run(tmp_path):
    result, _, session, _ = run(tmp_path, [
        reply(tool_use("write_script", "c1"), invalid_inputs={"c1": '{"code": "pla'}),
        reply(tool_use("write_script", "c2", code=CABIN[:40]), stop_reason="max_tokens"),
        reply({"type": "text", "text": "partial"}, stop_reason="max_tokens"),
        reply(*happy_path()[0].content),
        *happy_path()[1:],
    ])
    assert "not valid JSON" in session.messages[2]["content"][0]["content"][0]["text"]
    assert "cut off" in session.messages[4]["content"][0]["content"][0]["text"]
    assert "cut off" in session.messages[6]["content"][0]["text"]
    assert session.meta["revision"] == 1  # only the complete script was ever written
    assert result.status == "published"


def test_a_follow_up_edit_continues_the_same_conversation(tmp_path):
    _, first_client, _, world = run(tmp_path, happy_path())
    client = FakeClient([
        reply(tool_use("edit_script", "e1", old='"Sand_Blue"', new='"Red"')),
        reply(tool_use("render", "e2", views=["front"])),
        reply(tool_use("finish", "e3", title="Red cabin", summary="Now red.")),
    ])
    result = continue_build("Make the walls red", tmp_path / "run", Options(model="claude-opus-5-5"),
                            client=client, workbench=bench(world))
    assert result.status == "published" and result.published["number"] == 2
    request = client.requests[0]
    assert request["system"] == first_client.requests[0]["system"]
    earlier = first_client.requests[-1]["messages"]
    assert request["messages"][:len(earlier)] == earlier
    assert "Change request: Make the walls red" in request["messages"][-1]["content"][0]["text"]
    assert '"Red"' in (tmp_path / "run" / "published" / "002" / "build.py").read_text()
    assert (tmp_path / "run" / "published" / "001" / "build.py").read_text() == CABIN
    session = Session.load(tmp_path / "run")
    assert session.meta["model"] == "claude-fable-5-2" and len(session.meta["usage"]) == 6


def test_part_tools_answer_from_measurements(tmp_path):
    world = World(tmp_path / "world")
    session = Session.create(tmp_path / "s", system="s", tools=[], model="m", settings={})
    renderer = FakeRenderer()
    box = bench(world, renderer).toolbox(session)
    found = box.call("search_parts", {"query": "slope 45", "color": "Red"}).text
    assert found.startswith("3039: Slope Brick 45 2 x 2")
    assert box.call("search_parts", {"query": "unicorn"}).text.startswith("No available parts")
    slope = box.call("inspect_part", {"part": "3039"}).text
    assert "2 studs along x by 2 studs along z" in slope and "3 plates tall" in slope
    assert "front (-z)" in slope and "top surface" in slope and "Sand_Blue (379)" in slope
    assert "2 studs on top" in slope
    assert "No studs on top" in box.call("inspect_part", {"part": "3070b"}).text
    assert "underside" in box.call("inspect_part", {"part": "3659"}).text
    sheet = box.call("view_parts", {"parts": ["3001", "3039"]})
    assert sheet.images[0].is_file() and "3001, 3039" in sheet.text
    for name, arguments in [("search_parts", {"query": ""}), ("search_parts", {"query": "x", "limit": 900}),
                            ("search_parts", {"query": "x", "color": "Plaid"}), ("inspect_part", {"part": "../x"}),
                            ("inspect_part", {"part": "424242"}), ("view_parts", {"parts": []}),
                            ("no_such_tool", {}), ("_restore", {}), ("search_parts", "not an object")]:
        assert box.call(name, arguments).is_error, name


def test_script_and_render_tools_validate_their_input(tmp_path):
    world = World(tmp_path / "world")
    session = Session.create(tmp_path / "s", system="s", tools=[], model="m", settings={})
    renderer = FakeRenderer()
    box = bench(world, renderer).toolbox(session)
    assert box.call("edit_script", {"old": "a", "new": "b"}).is_error  # nothing to edit yet
    assert box.call("read_script", {}).text == "There is no script yet."
    assert not box.call("write_script", {"code": CABIN}).is_error
    assert "   2  module(\"base\")" in box.call("read_script", {}).text
    assert "not found" in box.call("edit_script", {"old": "zzz", "new": "y"}).text
    assert "matches" in box.call("edit_script", {"old": "module", "new": "y"}).text
    focused = box.call("render", {"views": ["front"], "elevation": 40,
                                  "focus": {"x0": 0, "x1": 2, "z0": 0, "z1": 1, "y0": 1, "y1": 4}})
    assert "zoomed" in focused.text and renderer.calls[-1]["bounds"] == [0, -32, 0, 40, -8, 20]
    assert renderer.calls[-1]["elevation"] == 40
    assert session.meta["rendered_revision"] is None  # a close-up is not a review of the whole model
    assert box.call("render", {}).images and session.meta["rendered_revision"] == 1
    for arguments in [{"views": ["sideways"]}, {"views": ["front"] * 5}, {"elevation": 120},
                      {"focus": {"x0": 1, "x1": 0, "z0": 0, "z1": 1, "y0": 0, "y1": 1}}, {"focus": {"x0": 1}}]:
        assert box.call("render", arguments).is_error, arguments


def test_sessions_refuse_reuse_damage_and_paths_outside_themselves(tmp_path):
    session = Session.create(tmp_path / "s", system="s", tools=[], model="m", settings={})
    with pytest.raises(SessionError, match="already holds"):
        Session.create(tmp_path / "s", system="s", tools=[], model="m", settings={})
    with pytest.raises(SessionError):
        Session.load(tmp_path / "missing")
    for escape in ("../outside.png", "/etc/passwd", "renders/../../x"):
        with pytest.raises(SessionError):
            session.path(escape)
    (tmp_path / "s" / "note.txt").write_text("x")
    with pytest.raises(SessionError, match="PNG and JPEG"):
        session.image_block(tmp_path / "s" / "note.txt")
    first = session.unique_file("renders", "View A!", ".png")
    first.write_bytes(b"x")
    assert session.unique_file("renders", "View A!", ".png") != first
    (tmp_path / "s" / "transcript.json").write_text("{}")
    with pytest.raises(SessionError, match="damaged"):
        Session.load(tmp_path / "s")


def test_the_reference_picture_is_bounded_reencoded_and_attached_first(tmp_path):
    source = tmp_path / "photo.png"
    picture = Image.new("RGBA", (4000, 2000), (20, 120, 200, 255))
    exif = Image.Exif()
    exif[0x010E] = "home address"
    picture.save(source, exif=exif)
    _, client, session, _ = run(tmp_path, happy_path(), reference=source)
    with Image.open(tmp_path / "run" / "reference.jpg") as saved:
        assert saved.size == (1568, 784) and saved.format == "JPEG" and not saved.getexif()
    first = client.requests[0]["messages"][0]["content"]
    assert first[0]["source"]["media_type"] == "image/jpeg" and "reference" in first[1]["text"]
    session = Session.create(tmp_path / "other", system="s", tools=[], model="m", settings={})
    (tmp_path / "fake.png").write_text("not a picture")
    for bad in (tmp_path / "fake.png", tmp_path / "absent.png"):
        with pytest.raises(ValueError):
            save_reference(bad, session)


def test_empty_requests_are_rejected_before_any_work(tmp_path):
    with pytest.raises(ValueError):
        start_build("   ", tmp_path / "run", Options())
    with pytest.raises(ValueError):
        continue_build("", tmp_path / "run", Options())
