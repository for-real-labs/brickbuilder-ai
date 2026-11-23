import asyncio
import io
import json
from decimal import Decimal

import httpx
import pytest
from PIL import Image
from src.astrology.__main__ import load_design, reference_image, write_json
from src.astrology.agent import design
from src.astrology.render import Views, png
from src.astrology.session import Session
from src.utils.llm_tool_conversation import ToolCall, Turn
from src.utils.supplier_catalog import get_supplier_catalog


def call(name, **args):
    return ToolCall(name, name, args)


def change(name, program):
    return call("revise", sections=[{"name": name, "program": program}])


class Script:
    def __init__(self, *turns):
        self.turns = iter(turns)
        self.inputs = []

    async def decide(self, program, feedback, view, *, final_review=False):
        self.inputs.append((dict(program), feedback[:], view))
        return Turn(tool_calls=next(self.turns))


def render(model):
    assert model.pieces
    data = png(Image.new("RGB", (10, 8), "navy"))
    return Views(data, data)


def test_agent_repairs_checks_and_finishes_only_a_previously_seen_exact_version():
    finish = lambda rev: call("finish", revision=rev, assessment="Front and rear match.")
    script = Script(
        [call("find_parts", query="3633")],
        [change("base", "box 2 0 0 0 4 1 4")],
        [change("detail", "part 3005 4 0 4 0 0")],
        [finish(2)],
        [change("detail", "part 3005 4 0 1 0 0"), finish(3)],
        [finish(1)],
        [finish(3)],
    )
    records = []
    model = asyncio.run(
        design(
            script,
            get_supplier_catalog(),
            20,
            render,
            report=lambda _: None,
            checkpoint=lambda p, checked: records.append((dict(p), checked)),
        )
    )
    assert model.assembly.issues == []
    assert [checked for _, checked in records] == [False, True, False, False, True]
    assert "3633" in script.inputs[1][1][-2]
    assert "disconnected" in script.inputs[3][1][-2]
    assert "previous turn" in script.inputs[-1][1][-2]
    assert script.inputs[-1][2].startswith(b"\xff\xd8")


def test_invalid_edit_invalidates_the_previous_review_and_can_be_removed():
    finish = call("finish", revision=1, assessment="Looks fine.")
    script = Script(
        [change("broken", "part bogus 1 0 2 0 0")],
        [finish],
        [change("broken", "")],
        [call("finish", revision=2, assessment="Reviewed both views.")],
    )
    model = asyncio.run(
        design(
            script,
            get_supplier_catalog(),
            2,
            render,
            program={"base": "box 4 0 0 0 1 3 1"},
            report=lambda _: None,
        )
    )
    assert model.program == {"base": "box 4 0 0 0 1 3 1"}
    assert script.inputs[0][2].startswith(b"\xff\xd8")
    assert script.inputs[1][2] is None
    assert "Unknown geometry" in script.inputs[1][1][-2]


def test_no_accepted_build_at_turn_limit():
    with pytest.raises(ValueError, match="without an accepted build"):
        asyncio.run(
            design(
                Script([call("finish", revision=0)]),
                get_supplier_catalog(),
                20,
                render,
                report=lambda _: None,
                rounds=1,
            )
        )


@pytest.mark.parametrize("approved", [True, False])
def test_final_decision_sees_exact_checked_source_even_after_a_failed_change(approved):
    final = (
        call("finish", revision=1, assessment="The shape matches the photo.")
        if approved
        else call("decline", reason="The subject is missing its tail")
    )
    script = Script(
        [change("body", "box 4 0 0 0 2 3 1")], [change("body", "part missing 4 0 0 0 0")], [final]
    )
    run = design(script, get_supplier_catalog(), 20, render, report=lambda _: None, rounds=2)
    if approved:
        assert asyncio.run(run).program == {"body": "box 4 0 0 0 2 3 1"}
    else:
        with pytest.raises(ValueError, match="missing its tail"):
            asyncio.run(run)
    program, feedback, view = script.inputs[-1]
    assert program == {"body": "box 4 0 0 0 2 3 1"}
    assert "Final review of revision 1" in feedback[0] and view.startswith(b"\xff\xd8")


def test_provider_receives_the_reference_and_real_review_and_records_reported_usage():
    async def request(req):
        data = json.loads(req.content)
        assert data["model"] == "gpt-6.2-astra" and data["store"] is False
        blocks = data["input"][-1]["content"]
        assert [b["image_url"].split(";")[0] for b in blocks if b["type"] == "input_image"] == [
            "data:image/jpeg",
            "data:image/jpeg",
        ]
        assert data["max_output_tokens"] > 0 and '"walls"' in blocks[2]["text"]
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output": [
                    {
                        "type": "function_call",
                        "name": "find_parts",
                        "call_id": "r1",
                        "arguments": '{"query":"slope"}',
                    }
                ],
                "usage": {"input_tokens": 1000, "output_tokens": 100},
            },
        )

    async def trial():
        async with httpx.AsyncClient(transport=httpx.MockTransport(request)) as client:
            api = Session(client, "Build a fox", 80, b"photo")
            turn = await api.decide({"walls": "a"}, [], b"render")
            assert turn.tool_calls == [ToolCall("r1", "find_parts", {"query": "slope"})]
            assert api.budget.spent == Decimal(".012")

    asyncio.run(trial())


def test_edit_source_preserves_limit_and_image_preparation_strips_metadata(tmp_path):
    path = tmp_path / "design.json"
    design_file = {"version": 1, "max_parts": 19, "sections": {"body": "box 4 0 0 0 1 3 1"}}
    write_json(path, design_file)
    assert load_design(path) == (design_file["sections"], 19)
    source = tmp_path / "ref.png"
    Image.new("RGBA", (2100, 100), (1, 1, 1, 0)).save(source)
    with Image.open(io.BytesIO(reference_image(source))) as im:
        assert im.size == (1152, 55) and im.getpixel((0, 0)) == (255, 255, 255)
        assert not im.getexif()
    write_json(path, {**design_file, "max_parts": True})
    with pytest.raises(ValueError, match="limit"):
        load_design(path)


def test_command_line_exports_an_importable_model_after_review(tmp_path, monkeypatch):
    import sys

    from src.astrology import __main__ as cli
    from src.utils.parts_catalog import flat_model_inventory, parts_csv_inventory

    out = tmp_path / "new build"
    source = tmp_path / "photo.png"
    Image.new("RGB", (30, 20), "red").save(source)
    decisions = iter(
        [
            change("body", "box 4 0 0 0 2 3 1"),
            call("finish", revision=1, assessment="Reviewed front and rear."),
        ]
    )

    def respond(request):
        data = json.loads(request.content)
        decision = next(decisions)
        blocks = data["input"][-1]["content"]
        assert "Piece ceiling: 4" in blocks[0]["text"]
        assert sum(b["type"] == "input_image" for b in blocks) == (
            2 if decision.name == "finish" else 1
        )
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output": [
                    {
                        "type": "function_call",
                        "name": decision.name,
                        "call_id": decision.id,
                        "arguments": json.dumps(decision.input),
                    }
                ],
                "usage": {"input_tokens": 100, "output_tokens": 10},
            },
        )

    monkeypatch.setenv("OPENAI_API_KEY", "local-test")
    monkeypatch.setattr(cli, "Renderer", lambda: render)
    monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda **kw: httpx.MockTransport(respond))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "astrology",
            "A red block under 5 pieces",
            "--image",
            str(source),
            "--max-parts",
            "8",
            "--out",
            str(out),
        ],
    )
    cli.main()
    assert flat_model_inventory((out / "model.ldr").read_text()) == {("3004", 4): 1}
    mpd = (out / "model.mpd").read_text()
    assert mpd == "0 FILE model.ldr\n" + (out / "model.ldr").read_text() + "0 NOFILE\n"
    assert flat_model_inventory(mpd) == {("3004", 4): 1}
    assert parts_csv_inventory((out / "parts.csv").read_text()) == {("3004", 4): 1}
    assert load_design(out / "design.json")[1] == 4
    result = json.loads((out / "result.json").read_text())
    assert result["pieces"] == 1 and result["provider_calls"] == 2
    for name in ["front.png", "back.png"]:
        with Image.open(out / name) as im:
            im.verify()
    with pytest.raises(SystemExit) as retry:
        cli.main()
    assert retry.value.code == 1
