from types import SimpleNamespace
import pytest
from experiments.two_pass.engine import compile_scene
from experiments.two_pass.agent import revise


class Catalog:
    parts = {
        (p, 4): SimpleNamespace(max_quantity=None) for p in ("3004", "3005", "3024")
    }


def test_long_axis_and_height():
    assert compile_scene([["box", 4, 0, 0, 0, 2, 1, 3]], Catalog, 1) == [
        "1 4 10 -24 0 1 0 0 0 1 0 0 0 1 3004.dat"
    ]


def test_piece_cap_and_cut():
    plan = [["box", 4, 0, 0, 0, 3, 1, 3]]
    with pytest.raises(ValueError):
        compile_scene(plan, Catalog, 1)
    assert len(compile_scene(plan + [["cut", 0, 2, 0, 0, 1, 1, 3]], Catalog, 1)) == 1


def test_patch_keeps_original_indices():
    assert revise(
        ["a", "b", "c"], {"patch": [[0, None], [2, "x"]], "append": ["z"]}
    ) == ["b", "x", "z"]


def test_roof_faces_both_slopes():
    from experiments.two_pass.engine import roof_rows

    pieces = list(roof_rows("roofX", 4, 0, 0, 0, 4, 4))
    assert len(pieces) == 4
    assert {(r[3], r[5]) for r in pieces} == {(1, 0), (2, 2)}


def test_source_indices_survive_color_filter(tmp_path):
    from experiments.two_pass.source import read_source

    p = tmp_path / "source.mpd"
    line = "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat"
    p.write_text(
        "0 FILE root.ldr\n"
        + line
        + "\n"
        + line.replace("1 4 ", "1 0 ")
        + "\n0 FILE 3001.dat\n"
        + line
    )
    rows, index = read_source(p, 2, 0)
    assert len(rows) == 2 and "[[1, 0," in index


def test_two_call_budget_and_failed_revision_fallback(tmp_path, monkeypatch):
    from experiments.two_pass import agent

    limits = []

    def fake(model, guide, prompt, images, budget):
        limits.append(budget)
        return (
            '[["box",4,0,0,0,2,1,3]]' if len(limits) == 1 else '{"replace":[]}',
            {"cost": 0.02},
        )

    monkeypatch.setattr(agent, "invoke", fake)
    out = tmp_path / "run"
    r = agent.run("astra", "test", [], out, Catalog, 10, lambda *a: [out / "front.png"])
    assert r["model"] == "stage1.mpd" and r["error"] and r["cost"] == 0.04
    assert limits == pytest.approx([0.17, 0.28])
    with pytest.raises(FileExistsError):
        agent.run("astra", "test", [], out, Catalog, 10, lambda *a: [])


def test_transparent_reference_keeps_black_features_visible(tmp_path):
    import base64
    from io import BytesIO
    from PIL import Image
    from experiments.two_pass.provider import encode

    image = Image.new("RGBA", (32, 16), (0, 0, 0, 0))
    image.paste((0, 0, 0, 255), (0, 0, 16, 16))
    p = tmp_path / "reference.png"
    image.save(p)
    encoded = Image.open(BytesIO(base64.b64decode(encode(p))))
    assert max(encoded.getpixel((5, 8))) < 10 and min(encoded.getpixel((28, 8))) > 245
