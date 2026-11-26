"""Every helper style, built with the real parts and judged by the real checks.

The stand-in parts of tests/test_fable_helpers.py prove the constructions; this proves the parts:
that each slope, window, wheel and arch really is the size and has the studs a helper assumes.
It needs an LDraw parts library (``LDRAW_DIR`` or ``~/ldraw``), so it is skipped where none is
installed, as in CI. Run it after changing or adding a helper:

    cd backend && uv run --group dev pytest tests/test_fable_helpers_real.py
"""

import pytest
from fable_agent.checks import world_boxes
from fable_agent.helpers import HELPERS, bind
from fable_agent.helpers import doors, windows
from fable_agent.kit import Kit, KitError
from fable_agent.ldraw import default_library_dir

pytestmark = pytest.mark.skipif(not (default_library_dir() / "LDConfig.ldr").is_file(),
                                reason="needs an LDraw parts library")
FACINGS = ("front", "back", "left", "right")
ROOF_SIZES = ((8, 8), (12, 8), (13, 9), (10, 10), (16, 12), (9, 7), (11, 15))
# Sizes a style is right to refuse, with a message that says what to change.
MAY_REFUSE = ("needs more depth", "can span at most", "cannot bridge", "larger footprint", "length must be from",
              "needs more length")


@pytest.fixture(scope="module")
def bench():
    from fable_agent.app import Workbench
    return Workbench.open({"ldraw_dir": None, "catalog_path": None, "open_palette": False, "max_parts": 6000})


@pytest.fixture(scope="module")
def strict():
    """The same parts held to the publication rules, as the v2 methods check a build."""
    from fable_agent.app import Workbench
    return Workbench.open({"ldraw_dir": None, "catalog_path": None, "open_palette": False, "max_parts": 6000,
                           "assembly_rules": True})


def fresh(bench, ground=True):
    kit = Kit(bench.library, bench.shapes, bench.palette, bench.finder)
    if ground:
        kit.fill({(x, z) for x in range(-24, 48) for z in range(-24, 60)}, 0, "Green", kind="plate")
    return kit


def cases(name: str, style: str):
    if name == "tree":
        return [dict(height=height, width=width, style=style) for width in (4, 6, 8, 10) for height in (18, 40)]
    if name == "roof":
        return [dict(width=wide, depth=deep, style=style, facing=facing) for wide, deep in ROOF_SIZES
                for facing in ("front", "left")]
    if name == "stairs":
        return [dict(width=width, rise=rise, style=style, facing=facing)
                for width, rise, facing in ((1, 3, "front"), (2, 7, "left"), (3, 9, "back"), (4, 9, "front"),
                                            (4, 18, "right"), (6, 18, "front"))]
    if name == "railing":
        return [dict(length=length, style=style, facing=facing) for length in (1, 4, 7, 12, 17)
                for facing in ("front", "left")]
    if name == "wall":
        return [dict(length=length, height=height, style=style, facing=facing, openings=openings)
                for length, height, openings in ((8, 12, ()), (12, 18, [(2, 3, 2, 6), (6, 0, 4, 18)]),
                                                 (16, 21, [(1, 3, 4, 9), (8, 3, 2, 8), (12, 6, 4, 5)]),
                                                 (5, 9, [(0, 0, 4, 6)]), (14, 24, [(4, 3, 6, 18)]))
                for facing in ("front", "right")]
    if name == "deck":
        return [dict(width=wide, depth=deep, height=height, style=style, railing=railing, steps=steps)
                for wide, deep in ((8, 6), (12, 5), (16, 9), (7, 7))
                for height in (2, 5, 6, 8)
                for railing, steps in ((("front", "left", "right"), "front"), ((), None),
                                       (("front", "back", "left", "right"), "left"))]
    if name in ("plant", "lamp"):
        return [dict(style=style), dict(style=style, color="Blue")]
    if name in ("chimney", "column"):
        return [dict(height=height, style=style) for height in (3, 9, 18, 40)]
    if name == "arch":
        return [dict(style=style, height=height, facing=facing) for height in (0, 9) for facing in FACINGS]
    if name == "wheels":
        return [dict(style=style, width=width, facing=facing) for width in (4, 6, 8) for facing in FACINGS]
    if name == "chassis":
        return [dict(style=style, facing=facing, length=length) for facing in FACINGS
                for length in (None, 7, 11, 16, 23, 30)]
    return [dict(style=style, facing=facing) for facing in FACINGS]


def ring_of_wall(kit, wide, deep):
    cells = {(x, z) for x in range(wide) for z in range(deep)} - {(x, z) for x in range(1, wide - 1)
                                                                 for z in range(1, deep - 1)}
    kit.fill(cells, 1, "White", layers=2)
    return 7


def body_on(bench, kit, ids):
    """Plates on the studs of whatever carries the wheels, as a vehicle's body would sit."""
    cells, level = set(), 0
    for index in ids:
        placement = kit.build.placements[index]
        if placement.allow_overlap:
            continue
        m, t = placement.matrix, placement.position
        for sx, sy, sz, *_ in bench.shapes.get(placement.part).studs:
            cells.add((int((m[0] * sx + m[1] * sy + m[2] * sz + t[0]) // 20),
                       int((m[6] * sx + m[7] * sy + m[8] * sz + t[2]) // 20)))
            level = round(-(m[3] * sx + m[4] * sy + m[5] * sz + t[1]) / 8)
    xs, zs = [x for x, _ in cells], [z for _, z in cells]
    kit.fill({(x, z) for x in range(min(xs), max(xs) + 1) for z in range(min(zs), max(zs) + 1)}, level, "Red",
             kind="plate", layers=2)


@pytest.mark.parametrize(("name", "style"), [(name, style) for name, helper in HELPERS.items()
                                             for style in helper.styles])
def test_every_style_builds_clean_with_real_parts(bench, strict, name, style):
    built = 0
    for arguments in cases(name, style):
        kit = fresh(bench, ground=name not in ("wheels", "chassis"))
        call = bind(kit)[name]
        try:
            if name == "roof":
                wide, deep = arguments.pop("width"), arguments.pop("depth")
                placed = call(0, ring_of_wall(kit, wide, deep), 0, wide, deep, **arguments)
            elif name == "deck":
                placed = call(4, 1, 4, arguments.pop("width"), arguments.pop("depth"), **arguments)
            elif name == "wheels":
                placed = call(0, 0, 0, **arguments)
                body_on(bench, kit, placed)
            elif name == "chassis":
                placed = call(4, 0, 4, **arguments)
                body_on(bench, kit, placed)
            else:
                placed = call(4, 1, 4, **arguments)
        except KitError as error:
            assert any(reason in str(error) for reason in MAY_REFUSE), (arguments, str(error))
            continue
        report = bench.checker.check(kit.build)
        assert report.ok, (arguments, [issue.message for issue in report.errors][:2])
        # No solid plastic in the same place and no joint without evidence. (The test's ground is
        # loose plates, so the one-model rule is tried on a bonded ground in the test below.)
        refused = [issue.message for issue in strict.checker.check(kit.build).errors
                   if issue.kind in ("material", "joint")]
        assert not refused, (arguments, refused[:2])
        assert placed and all(bench.palette.allows(kit.build.placements[i].part, kit.build.placements[i].color)
                              for i in placed)
        built += 1
    assert built, f"{name} {style} refused every size it was asked for"


@pytest.mark.parametrize("name", sorted(HELPERS))
def test_every_helper_can_be_built_in_small_connected_steps(strict, name):
    """On a bonded ground each helper's first buildable case passes the publication rules and gets its instructions."""
    for style in HELPERS[name].styles[:3]:
        for arguments in cases(name, style)[:2]:
            kit = Kit(strict.library, strict.shapes, strict.palette, strict.finder)
            wheeled = name in ("wheels", "chassis")  # a vehicle stands on its own tyres, with a body on top
            if not wheeled:
                kit.fill({(x, z) for x in range(-12, 44) for z in range(-12, 44)}, 0, "Green", kind="plate", layers=2)
            call = bind(kit)[name]
            try:
                if name == "roof":
                    wide, deep = arguments.pop("width"), arguments.pop("depth")
                    walls = {(x, z) for x in range(wide) for z in range(deep)} - {
                        (x, z) for x in range(1, wide - 1) for z in range(1, deep - 1)}
                    kit.fill(walls, 2, "White", layers=2)
                    call(0, 8, 0, wide, deep, **arguments)
                elif name == "deck":
                    call(4, 2, 4, arguments.pop("width"), arguments.pop("depth"), **arguments)
                elif wheeled:
                    body_on(strict, kit, call(4, 0, 4, **arguments))
                else:
                    call(4, 2, 4, **arguments)
            except KitError as error:
                assert any(reason in str(error) for reason in MAY_REFUSE), (arguments, str(error))
                continue
            report = strict.checker.check(kit.build)
            assert report.ok, (style, arguments, [issue.message for issue in report.errors][:2])
            steps = report.plan.steps
            assert report.plan.step_count > 1 and max(steps.count(step) for step in set(steps)) <= 5


@pytest.mark.parametrize("style", sorted(windows.STYLES))
def test_each_window_fills_the_opening_its_style_states(bench, style):
    wide, tall, deep = windows.size(style)
    kit = fresh(bench)
    call = bind(kit)
    if deep == 1:
        call["wall"](0, 1, 0, wide + 2, tall + 6, color="Tan", openings=[(1, 3, wide, tall)])
    placed = call["window"](1, 4 if deep == 1 else 1, 0, style=style)  # a deep window stands on the ground here
    report = bench.checker.check(kit.build)
    assert report.ok, [issue.message for issue in report.errors][:2]
    boxes = [box for index in placed if not kit.build.placements[index].allow_overlap
             for box in world_boxes(bench.shapes.get(kit.build.placements[index].part), kit.build.placements[index])]
    assert round(max(b[3] for b in boxes) / 20 - min(b[0] for b in boxes) / 20) == wide
    assert round((max(-b[1] for b in boxes) - min(-b[4] for b in boxes)) / 8) == tall


@pytest.mark.parametrize("style", sorted(name for name, look in doors.STYLES.items() if look.kind != "part"
                                         and look.kind != "pair"))
def test_each_door_fills_the_opening_its_style_states(bench, style):
    look = doors.STYLES[style]
    kit = fresh(bench)
    call = bind(kit)
    call["wall"](0, 1, 0, look.wide + 2, look.tall + 3, color="Tan", openings=[(1, 0, look.wide, look.tall)])
    call["door"](1, 1, 0, style=style)
    report = bench.checker.check(kit.build)
    assert report.ok, [issue.message for issue in report.errors][:2]


def extent(bench, kit, ids):
    boxes = [box for index in ids for box in world_boxes(bench.shapes.get(kit.build.placements[index].part),
                                                         kit.build.placements[index])]
    return [min(box[axis] for box in boxes) for axis in range(3)], [max(box[axis + 3] for box in boxes) for axis in range(3)]


@pytest.mark.parametrize("style", sorted(HELPERS["wheels"].styles))
@pytest.mark.parametrize("width", [4, 6])
def test_wheels_sit_evenly_either_side_of_the_body_and_reach_the_ground_their_note_states(bench, style, width):
    from fable_agent.helpers.cars import STYLES
    look = STYLES[style]
    kit = fresh(bench, ground=False)
    placed = bind(kit)["wheels"](0, look.drop, 0, style=style, width=width)
    wheels = [index for index in placed if kit.build.placements[index].allow_overlap]
    low, high = extent(bench, kit, wheels)
    body = {"holder": 4, "caster": 2}.get(look.mount, width)  # studs across the body the axle sits under
    assert abs((low[0] + high[0]) / 40 - body / 2) < 0.3, "the two wheels are not centered on the body"
    assert abs(-high[1] / 8) < 0.6, "the tyres do not stand on the ground the note promises"
    carriers = [index for index in placed if not kit.build.placements[index].allow_overlap]
    for index in carriers:  # every stud of a carrier is on the grid, so a body can sit on it
        placement = kit.build.placements[index]
        m, t = placement.matrix, placement.position
        for sx, sy, sz, *_ in bench.shapes.get(placement.part).studs:
            wx, wz = m[0] * sx + m[1] * sy + m[2] * sz + t[0], m[6] * sx + m[7] * sy + m[8] * sz + t[2]
            assert (wx - 10) % 20 == 0 and (wz - 10) % 20 == 0, (placement.part, wx, wz)


@pytest.mark.parametrize("style", sorted(HELPERS["chassis"].styles))
def test_a_chassis_floor_is_at_its_deck_and_it_stands_on_a_baseplate(bench, style):
    from fable_agent.helpers.vehicles import STYLES, deck
    look = STYLES[style]
    kit = fresh(bench)
    placed = bind(kit)["chassis"](4, 1, 4, style=style, facing="left")
    kit.fill({(x, z) for x in range(4, 4 + look.length) for z in range(4, 4 + look.wide)}, 1 + deck(style), "Red")
    report = bench.checker.check(kit.build)
    assert report.ok, [issue.message for issue in report.errors][:2]
    floor = [index for index in placed if not kit.build.placements[index].allow_overlap]
    low, high = extent(bench, kit, floor)
    assert round(-low[1] / 8, 2) == 1 + deck(style)  # the top of the floor, where the body starts
    wheels = [index for index in placed if kit.build.placements[index].allow_overlap
              and kit.build.placements[index].part not in ("3022",)]
    assert abs(-extent(bench, kit, wheels)[1][1] / 8 - 1) < 0.6  # tyres on the baseplate's top
