"""What the v2 methods add to a build: ready-made trees and automatic repair."""

import pytest
from fable_agent.app import ASSISTED, LEAN, METHODS, Options, Workbench, continue_build, start_build
from fable_agent.checks import world_boxes
from fable_agent.kit import Build, KitError, rect
from fable_agent.lean import LEAN_TOOLS
from fable_agent.palette import nearest_color
from fable_agent.prompts import lean_system_prompt, lean_v2_system_prompt, system_prompt, thorough_v2_system_prompt
from fable_agent.repair import BuildRepairer
from fable_agent.session import Session
from fable_agent.trees import MAX_WIDTH, MIN_WIDTH, STYLES, canopy_height, canopy_plan

from fable_agent_support import (CABIN, TREE_PARTS, FakeClient, FakeRenderer, InlineRunner, World, reply,
                                 tool_use)

GROUND = "fill(rect(-6, -6, 8, 8), 0, 'Green', kind='plate')\n"
# The second fill claims four cells the first already holds, as a script does when two sections meet.
CLASH = GROUND + "fill(rect(0, 0, 4, 2), 1, 'Red')\nfill(rect(2, 0, 6, 2), 1, 'White')\n"


@pytest.fixture(autouse=True)
def private_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("FABLE_AGENT_CACHE", str(tmp_path / "cache"))


def repairer(world) -> BuildRepairer:
    return BuildRepairer(world.library, world.shapes, world.palette, world.finder)


def cells(world, placement) -> set:
    return {(x, z) for box in world_boxes(world.shapes.get(placement.part), placement)
            for x in range(round(box[0] / 20), round(box[3] / 20)) for z in range(round(box[2] / 20), round(box[5] / 20))}


# ----- trees -----------------------------------------------------------------


@pytest.mark.parametrize("style", STYLES)
@pytest.mark.parametrize("width", range(MIN_WIDTH, MAX_WIDTH + 1, 2))
@pytest.mark.parametrize(("leaves", "accent"), [("Green", None), ("Red", "White")])
def test_every_tree_holds_together_and_uses_only_stocked_parts(tmp_path, style, width, leaves, accent):
    world = World(tmp_path, extra=TREE_PARTS)
    kit = world.kit()
    kit.fill(rect(-6, -6, 8, 8), 0, "Green", kind="plate")
    ground = len(kit.build.placements)
    placed = kit.tree(0, 1, 0, height=40, width=width, style=style, leaves=leaves, accent=accent, trunk="Black")
    report = world.checker.check(kit.build)
    assert report.ok, [issue.message for issue in report.errors]
    assert placed == list(range(ground, len(kit.build.placements)))
    tree = [kit.build.placements[index] for index in placed]
    covered = set().union(*(cells(world, placement) for placement in tree))
    # The canopy is ``width`` studs across and centered on the 2 x 2 trunk at (0, 0).
    assert (min(x for x, _ in covered), max(x for x, _ in covered) + 1) == (1 - width // 2, 1 + width // 2)
    assert (min(z for _, z in covered), max(z for _, z in covered) + 1) == (1 - width // 2, 1 + width // 2)
    if style == "bush":
        assert not any(placement.part == "3941" for placement in tree)
    else:
        assert abs(report.size[1] - 1 - 40) <= 4  # the trunk takes what the canopy leaves of the height
        assert tree[0].part == "3941" and tree[0].color == 0


def test_a_canopy_never_overhangs_its_support_by_more_than_a_strip_can_bridge():
    for style in STYLES:
        for width in range(MIN_WIDTH, MAX_WIDTH + 1, 2):
            plan = canopy_plan(style, width)
            under = width if style == "bush" else 2  # a bush sits on the ground; a tree on its trunk
            for kind, size in plan:
                assert size - under <= (2 if kind == "strips" else 0), (style, width, kind, size)
                under = size
            assert plan[-1][1] == 4 and max(size for _, size in plan) == width
            assert canopy_height(style, width) == sum(1 if kind == "strips" else 3 for kind, _ in plan)


def test_a_tree_falls_back_to_plain_parts_and_the_closest_stocked_color(tmp_path):
    # No round trunk or dome in this library, and no Red 2 x 4 plate or 1 x 1 brick.
    world = World(tmp_path, skip={("3020", 4), ("3005", 4)})
    kit = world.kit()
    kit.fill(rect(-4, -4, 6, 6), 0, "Green", kind="plate")
    ground = len(kit.build.placements)
    kit.tree(0, 1, 0, height=20, width=4, leaves="Red", trunk="Black")
    report = world.checker.check(kit.build)
    assert report.ok, [issue.message for issue in report.errors]
    tree = kit.build.placements[ground:]
    assert all(world.palette.allows(placement.part, placement.color) for placement in tree)
    assert {placement.color for placement in tree if placement.part == "3020"} == {
        nearest_color(world.library, world.palette, "3020", 4)}
    assert tree[0].part == "3001" or tree[0].part.startswith("300")  # a trunk of plain bricks


@pytest.mark.parametrize("arguments", [
    {"width": 5}, {"width": 12}, {"width": 2}, {"style": "willow"}, {"height": 2}, {"height": 500},
    {"x": 1.5}, {"y": "low"}, {"width": True}, {"leaves": "Blurple"},
])
def test_a_tree_explains_a_bad_request(tmp_path, arguments):
    kit = World(tmp_path, extra=TREE_PARTS).kit()
    with pytest.raises(KitError):
        kit.tree(**{"x": 0, "y": 0, "z": 0, "trunk": "Black", **arguments})
    assert kit.build.placements == [] or "leaves" in arguments


def test_a_script_can_plant_a_tree(tmp_path):
    world = World(tmp_path, extra=TREE_PARTS)
    outcome = InlineRunner(world).run(GROUND + "ids = tree(0, 1, 0, height=24, width=6, style='pine', trunk='Black')\n"
                                               "print(len(ids))\n")
    assert outcome.build is not None and world.checker.check(outcome.build).ok
    ground = len(InlineRunner(world).run(GROUND).build.placements)
    assert int(outcome.output) == len(outcome.build.placements) - ground > 10


def test_the_closest_color_is_one_the_part_comes_in(tmp_path):
    world = World(tmp_path, skip={("3001", 4), ("3001", 15)})
    assert nearest_color(world.library, world.palette, "3001", 2) == 2  # stocked: unchanged
    closest = nearest_color(world.library, world.palette, "3001", 4)
    assert closest in world.palette.colors_for("3001") and closest not in (4, 15)
    assert nearest_color(world.library, world.palette, "no-such-part", 4) is None
    assert world.kit().stocked_color("3001", "Red") == closest
    assert world.kit().plain_part("brick", 4, 2, "Red") == ("3001", closest)
    assert world.kit().plain_part("plate", 9, 9, "Red") is None


# ----- repair ----------------------------------------------------------------


def built(world, script: str) -> Build:
    outcome = InlineRunner(world).run(script)
    assert outcome.build is not None, outcome.error
    return outcome.build


def test_a_plain_part_that_runs_into_another_is_cut_back_to_its_free_cells(tmp_path):
    world = World(tmp_path)
    build = built(world, CLASH)
    assert not world.checker.check(build).ok
    fixed, repairs = repairer(world).repair(build)
    assert world.checker.check(fixed).ok
    assert repairs and sum(repairs.trimmed.values()) == 1 and not repairs.removed and not repairs.recolored
    red = set().union(*(cells(world, p) for p in fixed.placements if p.color == 4))
    white = set().union(*(cells(world, p) for p in fixed.placements if p.color == 15))
    assert red == rect(0, 0, 4, 2) and white == rect(4, 0, 6, 2)  # the earlier part keeps its cells
    assert "1 plain part(s) overlapped another part" in repairs.notes({})[0]


def test_a_shaped_part_is_never_cut_and_two_shaped_parts_are_left_to_the_model(tmp_path):
    world = World(tmp_path)
    # A slope placed first, then a brick laid through it: the brick gives way although it came later or earlier.
    for script in (GROUND + "place('3039', 'Red', 0, 1, 0)\nfill(rect(0, 0, 4, 2), 1, 'White')\n",
                   GROUND + "fill(rect(0, 0, 4, 2), 1, 'White')\nplace('3039', 'Red', 0, 1, 0)\n"):
        fixed, repairs = repairer(world).repair(built(world, script))
        assert world.checker.check(fixed).ok and sum(repairs.trimmed.values()) == 1
        assert [p.part for p in fixed.placements if p.color == 4] == ["3039"]
        assert set().union(*(cells(world, p) for p in fixed.placements if p.color == 15)) == rect(2, 0, 4, 2)
    slopes = built(world, GROUND + "place('3039', 'Red', 0, 1, 0)\nplace('3039', 'White', 1, 1, 0)\n")
    fixed, repairs = repairer(world).repair(slopes)
    assert not repairs and fixed.placements == slopes.placements
    assert [issue.kind for issue in world.checker.check(fixed).errors] == ["overlap"]


def test_repair_removes_a_buried_part_keeps_declared_overlaps_and_leaves_loose_parts(tmp_path):
    world = World(tmp_path)
    buried = built(world, GROUND + "a = place('3001', 'Red', 0, 1, 0)\nplace('3005', 'White', 1, 1, 0)\n"
                                    "b = place('3005', 'Black', 5, 1, 0)\nconnect(a, b, 'clip')\n")
    fixed, repairs = repairer(world).repair(buried)
    assert sum(repairs.removed.values()) == 1 and not repairs.trimmed
    last = len(fixed.placements) - 1  # the link follows its two parts to their new positions
    assert [p.color for p in fixed.placements[-2:]] == [4, 0] and fixed.links == [(last - 1, last, "clip")]
    assert len(fixed.placements) == len(buried.placements) - 1
    declared = built(world, GROUND + "place('3001', 'Red', 0, 1, 0)\n"
                                      "place('3005', 'White', 1, 1, 0, allow_overlap=True)\n")
    assert not repairer(world).repair(declared)[1]
    # A plain brick laid on its side through another: sideways building is deliberate, so it is not cut.
    sideways = built(world, GROUND + "place('3039', 'Red', 0, 1, 0)\n"
                                      "place_ldu('3001', 'White', (20, -44, 20), ((1, 0, 0), (0, 0, -1), (0, 1, 0)))\n")
    assert "overlap" in [issue.kind for issue in world.checker.check(sideways).errors]
    fixed, repairs = repairer(world).repair(sideways)
    assert not repairs and fixed.placements == sideways.placements
    loose = built(world, GROUND + "place('3001', 'Red', 0, 9, 0)\n")
    fixed, repairs = repairer(world).repair(loose)
    assert not repairs and [issue.kind for issue in world.checker.check(fixed).errors] == ["floating"]


def test_a_part_in_a_color_it_does_not_come_in_gets_the_closest_one(tmp_path):
    world = World(tmp_path, skip={("3039", 4)})
    build = built(world, GROUND + "place('3039', 'Red', 0, 1, 0)\nplace('3001', 'Red', 2, 1, 0)\n")
    assert [issue.kind for issue in world.checker.check(build).errors] == ["palette"]
    fixed, repairs = repairer(world).repair(build)
    closest = nearest_color(world.library, world.palette, "3039", 4)
    assert world.checker.check(fixed).ok and dict(repairs.recolored) == {("3039", 4, closest): 1}
    assert [p.color for p in fixed.placements[-2:]] == [closest, 4]  # the stocked red brick is untouched
    names = {color.code: color.name for color in world.library.colors().values()}
    assert f"3039 does not come in Red; 1 placed in {names[closest]} instead." in repairs.notes(names)[0]


# ----- the methods -------------------------------------------------------------


def bench(world):
    return Workbench.open(world.settings(), runner=InlineRunner(world), renderer=FakeRenderer())


def results(session) -> list[str]:
    return [block["content"][0]["text"] for message in session.messages if message["role"] == "user"
            for block in message["content"] if block.get("type") == "tool_result"]


@pytest.mark.parametrize(("method", "repaired"), [("thorough", False), ("thorough-v2", True)])
def test_only_the_second_thorough_version_repairs_what_it_builds(tmp_path, method, repaired):
    world = World(tmp_path / "world")
    result = start_build("A wall", tmp_path / "run", Options(max_parts=500, method=method), workbench=bench(world),
                         client=FakeClient([reply(tool_use("write_script", "c1", code=CLASH), tool_use("render", "c2")),
                                            reply(tool_use("finish", "c3", title="Wall", summary="A wall.")),
                                            reply({"type": "text", "text": "Stopping."}),
                                            reply({"type": "text", "text": "Stopping."})]))
    session = Session.load(tmp_path / "run")
    first = results(session)[0]
    assert session.meta["settings"]["repair"] is repaired
    if not repaired:
        assert "BUILD HAS ERRORS" in first and "Automatic repair" not in first and result.status == "failed"
        return
    assert "BUILD OK" in first and "Note: Automatic repair: 1 plain part(s) overlapped another part" in first
    assert result.status == "published"
    published = tmp_path / "run" / "published" / "001"
    assert (published / "build.py").read_text() == CLASH  # the script is kept as written
    model = (published / "model.ldr").read_text()
    assert model.count("3001.dat") == 1 and model.count("3004.dat") == 2  # the white brick was cut to 2 x 2


def test_lean_v2_repairs_and_offers_trees_while_lean_stays_as_it_was(tmp_path):
    def run(method):
        world = World(tmp_path / method / "world")
        client = FakeClient([reply(tool_use("build", "c1", code=CLASH, notes="Two bricks.")),
                             reply(tool_use("finish", "c2", title="Wall", summary="A wall.")),
                             reply(tool_use("finish", "c3", title="Wall", summary="A wall."))])
        result = start_build("A wall", tmp_path / method / "run", Options(max_parts=500, method=method, max_steps=3),
                             client=client, workbench=bench(world))
        return result, client, Session.load(tmp_path / method / "run"), world

    result, client, session, world = run("lean-v2")
    assert result.status == "published" and result.steps == 2 and session.meta["tools"] == LEAN_TOOLS
    assert session.meta["settings"] == {**session.meta["settings"], "method": "lean-v2", "repair": True}
    assert "Automatic repair: 1 plain part(s)" in client.requests[1]["messages"][0]["content"][-4]["text"]
    prompt = client.requests[0]["system"]
    assert prompt == lean_v2_system_prompt(world.finder, world.shapes, prompt.split("# Catalog: ")[1].splitlines()[0])
    assert "`tree(x, y, z" in prompt and "Automatic repair runs on your build" in prompt

    result, client, session, world = run("lean")
    assert result.status == "failed" and session.meta["settings"]["repair"] is False
    first = lean_system_prompt(world.finder, world.shapes, "x")
    assert client.requests[0]["system"].split("# Catalog: ")[0] == first.split("# Catalog: ")[0]
    for prompt in (first, system_prompt(world.finder, "x")):
        assert "tree(" not in prompt and "Automatic repair" not in prompt
    second = thorough_v2_system_prompt(world.finder, world.shapes, "x")
    assert "`tree(x, y, z" in second and second.index("# More help from the kit") < second.index("# What holds together")


def test_a_repaired_session_is_rebuilt_the_same_way_when_it_continues(tmp_path):
    world = World(tmp_path / "world")
    v2 = Options(max_parts=500, method="lean-v2")
    start_build("A wall", tmp_path / "run", v2, workbench=bench(world), client=FakeClient([
        reply(tool_use("build", "c1", code=CLASH, notes="Two bricks.")),
        reply(tool_use("finish", "c2", title="Wall", summary="A wall."))]))
    # A new process has only the saved script: finishing again must repair it again, not fail on the overlap.
    later = continue_build("Keep it", tmp_path / "run", Options(), workbench=bench(world), client=FakeClient([
        reply(tool_use("finish", "c3", title="Wall", summary="The same wall."))]))
    assert later.status == "published" and later.published["number"] == 2
    assert (tmp_path / "run" / "published" / "002" / "model.ldr").read_text().count("3004.dat") == 2


def test_the_second_versions_share_their_limits_and_kinds_with_the_first():
    assert METHODS["lean-v2"] == METHODS["lean"] and METHODS["thorough-v2"] == METHODS["thorough"]
    assert LEAN == {"lean", "lean-v2"} and ASSISTED == {"lean-v2", "thorough-v2"}
    assert Options(method="lean-v2").resolved("lean-v2").max_steps == 8
