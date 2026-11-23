import subprocess

import pytest
from fable_agent.render import LeoCadRenderer, RenderError, camera, contact_sheet
from PIL import Image

BOUNDS = (0, -80, 0, 200, 0, 100)  # LDU: x 0..200, y -80..0 (up is negative), z 0..100


def test_cameras_look_at_the_centre_from_the_named_side():
    front, target = camera(BOUNDS, "front")
    assert target == [100, -40, 50]
    assert front[0] == pytest.approx(100) and front[2] < 0 and front[1] < -40  # in front of and above the model
    right, _ = camera(BOUNDS, "right")
    assert right[0] > 200 and right[2] == pytest.approx(50)
    back_left, _ = camera(BOUNDS, "back-left")
    assert back_left[0] < 0 and back_left[2] > 100
    top, _ = camera(BOUNDS, "top")
    assert top[1] < -400 and abs(top[0] - 100) < 1
    near, _ = camera((90, -50, 40, 110, -30, 60), "front")
    assert abs(near[2] - 50) < abs(front[2] - 50)  # a small focus region brings the camera closer
    with pytest.raises(RenderError):
        camera(BOUNDS, "underneath")


def fake_leocad(commands, *, fail=False):
    def run(command, **options):
        commands.append(command)
        if not fail:
            picture = Image.new("RGBA", (400, 300), (0, 0, 0, 0))
            picture.paste((200, 30, 30, 255), (150, 100, 250, 200))
            picture.save(command[command.index("--image") + 1])
        return subprocess.CompletedProcess(command, 1 if fail else 0)
    return run


def test_leocad_is_called_per_view_and_images_are_flattened_and_trimmed(tmp_path):
    commands = []
    renderer = LeoCadRenderer(tmp_path / "ldraw", "/opt/leocad", run=fake_leocad(commands))
    views = renderer.render(tmp_path / "model.ldr", tmp_path / "out", ["front-right", "top"], BOUNDS, prefix="r1")
    assert [view.name for view in views] == ["front-right", "top"]
    assert views[0].path.name == "r1-front-right.png"
    with Image.open(views[0].path) as picture:
        assert picture.mode == "RGB" and picture.size == (156, 156)  # cropped to the model plus a margin
        assert picture.getpixel((0, 0)) == (244, 245, 247)
    command = next(c for c in commands if c[c.index("--image") + 1].endswith("front-right.png"))
    assert command[0] == "/opt/leocad" and command[-1].endswith("model.ldr")
    assert command[command.index("--libpath") + 1] == str(tmp_path / "ldraw")
    position = command.index("--camera-position-ldraw")
    assert command[position + 7:position + 10] == ["0", "-1", "0"]
    assert all(isinstance(argument, str) for argument in command)


def test_render_failures_are_reported_without_leaking_details(tmp_path):
    failing = LeoCadRenderer(tmp_path, "/opt/leocad", run=fake_leocad([], fail=True))
    with pytest.raises(RenderError, match="did not produce"):
        failing.render(tmp_path / "m.ldr", tmp_path / "out", ["front"], BOUNDS)

    def missing(command, **options):
        raise FileNotFoundError("/secret/path/leocad")

    with pytest.raises(RenderError) as failure:
        LeoCadRenderer(tmp_path, "/opt/leocad", run=missing).render(tmp_path / "m.ldr", tmp_path / "o", ["front"], BOUNDS)
    assert "secret" not in str(failure.value)
    with pytest.raises(RenderError, match="at least one view"):
        failing.render(tmp_path / "m.ldr", tmp_path / "out", [], BOUNDS)


def test_a_missing_renderer_explains_how_to_install_it(tmp_path, monkeypatch):
    monkeypatch.setattr("fable_agent.render.find_leocad", lambda: None)
    with pytest.raises(RenderError, match="LEOCAD_BIN"):
        LeoCadRenderer(tmp_path).render(tmp_path / "m.ldr", tmp_path / "out", ["front"], BOUNDS)


def test_contact_sheet_lays_out_labelled_tiles(tmp_path):
    tiles = []
    for index in range(5):
        path = tmp_path / f"{index}.png"
        Image.new("RGB", (60, 40), (index * 40, 0, 0)).save(path)
        tiles.append((f"part {index}", path))
    sheet = contact_sheet(tiles, tmp_path / "sheet.png")
    with Image.open(sheet) as picture:
        assert picture.size == (1000, 568)  # four columns, two rows
