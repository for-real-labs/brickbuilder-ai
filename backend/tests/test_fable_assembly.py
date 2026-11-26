"""The publication rules of the v2 methods: solid plastic, declared joints and the building order."""

import random

import pytest
from fable_agent.joints import JointReview
from fable_agent.kit import BUILD_TOGETHER, to_ldraw
from fable_agent.ldraw import default_library_dir
from pathlib import Path

import numpy as np
from fable_agent import solids
from fable_agent.kit import Build, Placement
from fable_agent.material import MAX_REPORTED_PAIRS, MaterialReview
from fable_agent.sequence import MAX_PARTS_PER_STEP, NoSequence, SequencePlanner

from fable_agent_support import TECHNIC_PARTS, World

QUARTER = (0.0, 0.0, 1.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0)  # turns a part's x axis onto z


def kinds(issues):
    return [issue.kind for issue in issues]


def base(kit, width=8, depth=2):  # two studs deep: the stand-in plates bond along x only
    kit.fill([(x, z) for x in range(width) for z in range(depth)], 0, "Green", kind="plate", layers=2)


# ----- the rules are the Fable agents' own -----------------------------------

IDENTITY = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
QUARTER_Y = (0.0, 0.0, 1.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0)
PLAIN = {"3022": {"x_studs": 2, "z_studs": 2, "height": 8}, "3021": {"x_studs": 3, "z_studs": 2, "height": 8},
         "3001": {"x_studs": 4, "z_studs": 2, "height": 24}}


def test_nothing_in_the_agent_is_loaded_from_another_service():
    """Pip has its own copy of everything it uses. Its code may credit where a copy came from, in
    comments and notices, but never imports, reads or calls the Nova service or its toolkit."""
    import fable_agent
    root = Path(fable_agent.__file__).parent
    foreign = ("nova-service", "nova_service", "ldraw_tools", "ldraw-nova", "setup_nova", "NOVA_SERVICE")
    checked = 0
    for source in root.rglob("*"):
        if source.suffix not in (".py", ".json", ".jsonl", ".toml", ".cfg", ".sh") or "__pycache__" in source.parts:
            continue
        checked += 1
        for number, line in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
            if source.suffix == ".py" and line.lstrip().startswith("#"):
                continue  # a credit line: where the file or the example came from
            assert not any(name in line for name in foreign), f"{source.relative_to(root)}:{number}"
    assert checked > 50
    assert MAX_PARTS_PER_STEP == 5 and solids.EXPOSED_PARTS == {"4079", "3960", "4740"}


def test_copied_code_keeps_its_notice_and_shared_data_its_licence_and_credit():
    """What was copied from other projects stays under its own licence, with credit that cannot be dropped quietly."""
    import fable_agent
    root = Path(fable_agent.__file__).parent
    repository = root.parents[1]
    agpl = (repository / "LICENSE-AGPL-3.0").read_text(encoding="utf-8")
    assert "GNU AFFERO GENERAL PUBLIC LICENSE" in agpl and "Version 3, 19 November 2007" in agpl
    readme = (repository / "README.md").read_text(encoding="utf-8")
    assert "AGPL-3.0" in readme and "### Third-party data" in readme and "setup_nova.cjs" in readme
    # Copied code: every file says where it came from, its licence and what was changed.
    toolkit = root / "toolkit"
    notice = (toolkit / "NOTICE.md").read_text(encoding="utf-8")
    for source in sorted(toolkit.glob("*.py")):
        head = source.read_text(encoding="utf-8")[:900]
        assert "Carlos Antelo" in head and "GNU Affero General Public License" in head, source.name
        assert "Modified by BrickBuilder, 20" in head, source.name
        assert f"`{source.name}`" in notice or source.name == "__init__.py", source.name
    for data in sorted((toolkit / "data").iterdir()):
        assert f"`data/{data.name}`" in notice, data.name
    # Shared data: the licence text, a notice with the credit, and every file accounted for.
    for folder in ("data/shadow", "guides", "examples/library"):
        legal = (root / folder / "LICENSE-CC-BY-SA-4.0.md").read_text(encoding="utf-8")
        assert "Attribution-ShareAlike 4.0 International" in legal and "Section 1 -- Definitions" in legal, folder
        credit = (root / folder / "NOTICE.md").read_text(encoding="utf-8")
        assert "https://creativecommons.org/licenses/by-sa/4.0/" in credit and "Changes" in credit, folder
        assert "CC BY-SA 4.0" in credit and "Nothing in this repository restricts" in " ".join(credit.split()), folder
        assert f"backend/fable_agent/{folder}/" in readme, folder
    listed = (root / "data/shadow/SOURCES.md").read_text(encoding="utf-8")
    files = sorted((root / "data/shadow").rglob("*.dat"))
    assert len(files) > 4000
    for path in files:
        assert f"`{path.relative_to(root / 'data/shadow').as_posix()}`" in listed, path.name
        assert "!LICENSE CC BY-SA 4.0" in path.read_text(encoding="utf-8", errors="replace")[:600], path.name
    assert "seats.json" in (root / "data/shadow/NOTICE.md").read_text(encoding="utf-8")
    guides = (root / "guides/NOTICE.md").read_text(encoding="utf-8")
    for path in sorted((root / "guides").glob("*.md")):
        if path.name not in ("NOTICE.md", "LICENSE-CC-BY-SA-4.0.md"):
            assert f"`{path.name}`" in guides and path.read_text(encoding="utf-8").startswith("<!-- Adapted from"), path.name


def hit(*placed) -> bool:
    groups = [solids.placed_solids(Placement(part, 0, position, matrix), PLAIN) for part, position, matrix in placed]
    return any(solids.intersects(a, b) for a in groups[0] for b in groups[1])


def test_measured_parts_collide_where_their_plastic_is_and_not_where_it_is_hollow():
    # Two curved corner tiles at the same height, one stud apart, then with clearance.
    assert hit(("27925", (-30, -96, 30), QUARTER_Y), ("27925", (-10, -96, 30), QUARTER_Y))
    assert not hit(("27925", (-30, -96, 30), QUARTER_Y), ("27925", (10, -96, 30), QUARTER_Y))
    # The lower side studs of a bracket brick run into a plate, at any rotation of the pair.
    assert hit(("22885", (-40, -120, 50), IDENTITY), ("3021", (-30, -88, 20), IDENTITY))
    assert not hit(("22885", (-40, -120, 50), IDENTITY), ("3021", (-30, -88, 10), IDENTITY))
    turn = np.array(QUARTER_Y).reshape(3, 3)
    assert hit(("22885", tuple(turn @ np.array([-40, -120, 50])), QUARTER_Y),
               ("3021", tuple(turn @ np.array([-30, -88, 20])), QUARTER_Y))
    # A stud's bore stays empty, and stacked bricks only touch.
    bore = solids.box((-11, 9, -13), (-9, 11, -11))
    assert not any(solids.intersects(solid, bore) for solid in solids.local_solids("22885", PLAIN))
    assert not hit(("3001", (0, 0, 0), IDENTITY), ("3001", (0, -24, 0), IDENTITY))
    assert solids.local_solids("3039", PLAIN) == [] and len(solids.local_solids("4079", PLAIN)) == 13


def test_touching_is_allowed_and_a_scaled_placement_is_refused():
    unit = solids.box((0, 0, 0), (1, 1, 1))
    assert not solids.intersects(unit, solids.box((1, 0, 0), (2, 1, 1)))
    assert solids.intersects(unit, solids.box((.5, 0, 0), (2, 1, 1)))
    rounded = (.469472, 0, -.882948, 0, 1, 0, .882948, 0, .469472)  # six decimals, as a script writes it
    assert solids.placed_solids(Placement("3022", 0, (0, 0, 0), rounded), PLAIN)
    for matrix in ((1.00001, 0, 0, 0, 1.00001, 0, 0, 0, 1.00001), (1, .00001, 0, 0, 1, 0, 0, 0, 1)):
        with pytest.raises(ValueError, match="unscaled"):
            solids.placed_solids(Placement("3022", 0, (0, 0, 0), matrix), PLAIN)


def test_a_surface_that_passes_through_a_solid_is_found():
    wall = solids.box((0, 0, 0), (10, 10, 10))
    through = np.array([[[5, 5, -5], [5, 5, 15], [5, 15, 5]]], dtype=float)
    beside = through + np.array([20, 0, 0])
    assert solids.faces_enter(through, wall) and not solids.faces_enter(beside, wall)
    assert not solids.faces_enter(np.empty((0, 3, 3)), wall)


# ----- solid plastic --------------------------------------------------------


def test_an_overlap_declared_intended_is_still_an_error_when_solid_plastic_meets(tmp_path):
    for assembly, expected in ((False, []), (True, ["material"])):
        world = World(tmp_path / str(assembly), assembly=assembly)
        kit = world.kit()
        base(kit)
        kit.place("3001", "Red", 0, 2, 0)
        kit.place("3001", "White", 1, 2, 0, allow_overlap=True)  # the same row, one stud along
        report = world.checker.check(kit.build)
        assert kinds(report.errors) == expected
    assert "allow_overlap does not cover this" in report.errors[0].message
    assert "3001 Red at x=0 y=2 z=0" in report.errors[0].message and report.plan is None


def test_a_part_turned_off_the_grid_is_checked_for_solid_plastic(tmp_path):
    world = World(tmp_path, assembly=True)
    kit = world.kit()
    base(kit)
    kit.place("3001", "Red", 0, 2, 0)
    kit.place("3020", "White", 1, 2, 0, rot=30)  # the ordinary overlap check skips free rotations
    report = world.checker.check(kit.build)
    assert "material" in kinds(report.errors)
    assert any("free rotation" in note for note in report.notes)


def test_parts_that_stack_or_sit_side_by_side_are_not_collisions(tmp_path):
    world = World(tmp_path, assembly=True)
    kit = world.kit()
    base(kit)
    for x in (0, 4):
        kit.place("3001", "Red", x, 2, 0)
    kit.place("3001", "White", 2, 5, 0)  # bridges the two
    kit.place("3070b", "Black", 2, 8, 0)
    report = world.checker.check(kit.build)
    assert report.ok and not report.warnings


def test_only_plain_boxes_are_given_solid_walls_and_a_tile_keeps_its_groove(tmp_path):
    world = World(tmp_path)
    profiles = MaterialReview(world.library, world.shapes)._profiles
    assert profiles.get("3001") == {"x_studs": 4, "z_studs": 2, "height": 24}
    assert profiles.get("3020") == {"x_studs": 4, "z_studs": 2, "height": 8}
    assert profiles.get("3070b")["height"] == 6  # walls stop above the groove cut under a tile
    assert profiles.get("3039") is None and profiles.get("3659") is None and profiles.get("missing") is None


def test_the_review_finds_exactly_the_pairs_a_test_of_every_pair_finds(tmp_path):
    world = World(tmp_path)
    review = MaterialReview(world.library, world.shapes)
    chooser = random.Random(7)
    for _ in range(6):
        kit = world.kit()
        for _ in range(24):
            kit.place(chooser.choice(["3001", "3020", "3004", "3022"]), "Red", chooser.randrange(12),
                      chooser.randrange(8), chooser.randrange(12), rot=chooser.choice([0, 90, 30]), allow_overlap=True)
        placements = kit.build.placements
        placed = [solids.placed_solids(placement, review._profiles) for placement in placements]
        expected = {(i, j) for i in range(len(placed)) for j in range(i + 1, len(placed))
                    if any(solids.intersects(a, b) for a in placed[i] for b in placed[j])}
        found = {tuple(sorted(pair)) for pair in review.collisions(placements)}
        assert expected and (found == expected if len(expected) < MAX_REPORTED_PAIRS
                             else found <= expected and len(found) == MAX_REPORTED_PAIRS)


# ----- joints that are measured ---------------------------------------------

UPRIGHT = (0.0, -1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)  # turns a part's x axis to point up


def test_the_library_gives_each_part_its_pegs_and_holes(tmp_path):
    world = World(tmp_path, extra={**TECHNIC_PARTS, "odd": (
        "0 Odd\n"
        "1 16 0 0 0 3 0 0 0 5 0 0 0 9 4-4cyli.dat\n"       # an oval: not a round fit
        "1 16 0 0 0 4 0 0 0 5 0 0 0 4 1-8cyli.dat\n"       # an eighth of a turn: a fillet, not a peg
        "0 BFC INVERTNEXT\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 peghole.dat\n")})  # a hole turned inside out again
    library = world.library
    bar, = library.cylinders("30374")
    assert (bar.inside, bar.base, bar.axis, bar.length, bar.radius) == (False, (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), 80.0, 4.0)
    clip, = library.cylinders("4085c")
    assert clip.inside and (clip.radius, clip.length, clip.axis) == (4.0, 8.0, (0.0, 1.0, 0.0))
    hole, = library.cylinders("3700")
    assert hole.inside and (hole.radius, hole.length, hole.base, hole.axis) == (6.0, 20.0, (0.0, 10.0, 10.0),
                                                                                (0.0, 0.0, -1.0))
    pin, = library.cylinders("3673")
    assert not pin.inside and (pin.radius, pin.length, pin.axis) == (6.0, 20.0, (1.0, 0.0, 0.0))
    turned, = library.cylinders("odd")
    assert not turned.inside and library.cylinders("3001") == ()


def fitted(tmp_path, turn, position):
    """A clip plate on the base and a bar placed by its LDraw origin; the pairs the finder joins."""
    from fable_agent.fits import FitFinder
    world = World(tmp_path, extra=TECHNIC_PARTS)
    kit = world.kit()
    clip = kit.place("4085c", "Red", 0, 0, 0)
    x, y, z = kit.build.placements[clip].position
    bar = kit.place_ldu("30374", "Black", (x + position[0], y + position[1], z + position[2]), turn,
                        allow_overlap=True)
    return FitFinder(world.library).find(kit.build.placements), (clip, bar)


def test_a_bar_is_joined_to_a_clip_only_where_it_really_sits_in_it(tmp_path):
    # The clip's grip is 14 units in front of its plate, upright, from the plate's top down 8.
    # LDraw's y points down, so a bar that starts 40 above the plate's top runs down through the grip.
    found, pair = fitted(tmp_path / "in", UPRIGHT, (0, -40, -14))
    assert found == {pair}
    assert fitted(tmp_path / "beside", UPRIGHT, (3, -40, -14))[0] == set()       # off the grip's line
    assert fitted(tmp_path / "across", IDENTITY, (-40, 4, -14))[0] == set()      # lying across it
    assert fitted(tmp_path / "below", UPRIGHT, (0, 20, -14))[0] == set()         # on the line, but past it


def test_a_peg_fits_only_a_hole_of_its_own_size_and_never_another_peg(tmp_path):
    from fable_agent.fits import FitFinder
    world = World(tmp_path, extra=TECHNIC_PARTS)
    kit = world.kit()
    brick = kit.place("3700", "Red", 0, 0, 0)
    x, y, z = kit.build.placements[brick].position
    thin = kit.place_ldu("30374", "Black", (x, y + 10, z + 20), (0, 0, 1, 0, 1, 0, -1, 0, 0), allow_overlap=True)
    pin = kit.place_ldu("3673", "Black", (x, y + 10, z + 10), (0, 0, 1, 0, 1, 0, -1, 0, 0), allow_overlap=True)
    twin = kit.place_ldu("3673", "Black", (x, y + 10, z + 10), (0, 0, 1, 0, 1, 0, -1, 0, 0), allow_overlap=True)
    found = FitFinder(world.library).find(kit.build.placements)
    assert found == {(brick, pin), (brick, twin)} and thin not in {index for pair in found for index in pair}


def test_a_part_held_by_a_pin_needs_no_declared_joint_and_its_overlap_is_expected(tmp_path):
    def build(world):
        kit = world.kit()
        base(kit)
        brick = kit.place("3700", "Red", 0, 2, 0)
        x, y, z = kit.build.placements[brick].position
        kit.place_ldu("3673", "Black", (x, y + 10, z + 10), QUARTER)  # no allow_overlap, no connect()
        return kit.build

    held = World(tmp_path / "v2", extra=TECHNIC_PARTS, assembly=True)
    report = held.checker.check(build(held))
    assert report.ok and report.plan is not None
    assert any("1 joints were measured" in note for note in report.notes)
    assert any("1 overlapping pairs are parts seated in or beside a measured joint" in note for note in report.notes)
    # The first-version methods measure nothing: the same pin is an overlap there, as before.
    plain = World(tmp_path / "v1", extra=TECHNIC_PARTS)
    assert "overlap" in kinds(plain.checker.check(build(plain)).errors)


def test_a_tyre_on_its_rim_and_a_wheel_on_its_pin_are_measured_by_how_they_sit(tmp_path):
    from fable_agent.fits import FitFinder
    from fable_agent_support import HELPER_PARTS
    world = World(tmp_path, extra={**HELPER_PARTS, **TECHNIC_PARTS})
    finder = FitFinder(world.library)
    side = (0.0, 0.0, 1.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0)  # the wheel's z axis, which it turns on, along model x
    rim = Placement("4624", 0, (40.0, -20.0, 0.0), side)
    tyre = Placement("87414", 0, (40.0, -20.0, 0.0), side)
    pin = Placement("3673", 0, (20.0, -20.0, 0.0), IDENTITY)        # its peg runs along x, through the rim's middle
    assert finder.find([rim, tyre, pin]) == {(0, 1), (0, 2)}        # tyre on rim, rim on pin; not tyre on pin
    off = Placement("87414", 0, (40.0, -20.0, 30.0), side)          # a tyre lying beside the wheel
    flat = Placement("87414", 0, (40.0, -20.0, 0.0), IDENTITY)      # around the same point, turned the wrong way
    low = Placement("3673", 0, (20.0, -10.0, 0.0), IDENTITY)        # a pin under the wheel's middle, not through it
    assert finder.find([rim, off]) == set() and finder.find([rim, flat]) == set() and finder.find([rim, low]) == set()
    assert finder.find([tyre, pin]) == set()                        # a tyre needs a rim


def test_parts_seated_on_the_same_part_may_share_coarse_space_but_are_not_joined_by_it(tmp_path):
    from fable_agent.fits import around_a_fit
    # A tyre and a pin holder are both fitted to the rim (1); a far part (9) is fitted to nothing shared.
    assert around_a_fit({(0, 1), (1, 2), (8, 9)}) == {(0, 1), (1, 2), (0, 2), (8, 9)}
    assert around_a_fit(set()) == set()

    from fable_agent_support import HELPER_PARTS
    world = World(tmp_path, extra={**HELPER_PARTS, **TECHNIC_PARTS}, assembly=True)
    side = (0.0, 0.0, 1.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0)
    kit = world.kit()
    kit.fill([(x, z) for x in range(-2, 6) for z in range(-1, 1)], 0, "Green", kind="plate", layers=2)
    kit.place("3004", "Red", 0, 2, -1)          # a brick under it, so the tyre clears the ground
    brick = kit.place("3700", "Red", 0, 5, -1)  # its hole points along z
    x, y, z = kit.build.placements[brick].position
    pin = kit.place_ldu("3673", "Black", (x, y + 10, z + 10), QUARTER)          # in the hole, sticking out the front
    rim = kit.place_ldu("4624", "White", (x, y + 10, z + 22), IDENTITY)         # on the pin's line: turns on z
    tyre = kit.place_ldu("87414", "Black", (x, y + 10, z + 22), IDENTITY)
    report = world.checker.check(kit.build)
    assert report.ok, [issue.message for issue in report.errors]
    assert any("joints were measured" in note for note in report.notes)
    order = report.plan.order
    assert order.index(brick) < order.index(pin) < order.index(rim) < order.index(tyre)  # each on what holds it


@pytest.mark.skipif(not (default_library_dir() / "LDConfig.ldr").is_file(), reason="needs an LDraw parts library")
def test_every_wheel_the_helper_mounts_is_measured_on_the_real_parts():
    from fable_agent.app import Workbench
    from fable_agent.assembly import AssemblyReview
    from fable_agent.connectors import ConnectorLibrary, ConnectorReview
    from fable_agent.helpers import HELPERS, bind
    from fable_agent.kit import Kit, KitError
    from fable_agent.shape import default_cache_dir
    bench = Workbench.open({"ldraw_dir": None, "catalog_path": None, "open_palette": False, "max_parts": 500})
    review = AssemblyReview(bench.library, bench.shapes,
                            ConnectorReview(ConnectorLibrary(bench.library.root, default_cache_dir())))
    for style in HELPERS["wheels"].styles:
        for width in (4, 6, 12):
            kit = Kit(bench.library, bench.shapes, bench.palette, bench.finder)
            try:
                bind(kit)["wheels"](0, 8, 0, style=style, width=width)
            except KitError:
                continue
            placed = kit.build.placements
            declared = {(min(a, b), max(a, b)) for a, b, _ in kit.build.links}
            measured = review.measure(placed)
            unmeasured = {(placed[a].part, placed[b].part) for a, b in declared - measured.fits}
            # Only the trolley wheel, which clips into its holder, is taken on the helper's word.
            assert unmeasured <= {("2655", "2496")}, (style, width, unmeasured)
            # Nothing the helper mounts is called a misfit by the connector data.
            assert not measured.refuted and not measured.connectors.unseated(), (style, width)


@pytest.mark.skipif(not (default_library_dir() / "LDConfig.ldr").is_file(), reason="needs an LDraw parts library")
def test_real_pins_bars_clips_and_hinges_are_measured():
    from fable_agent.fits import FitFinder
    from fable_agent.ldraw import LDrawLibrary
    library = LDrawLibrary()
    shown = lambda part: {("hole" if c.inside else "peg", round(c.radius, 1)) for c in library.cylinders(part)}  # noqa: E731
    assert ("peg", 4.0) in shown("30374") and ("hole", 4.0) in shown("4085c")       # a bar and a clip
    assert ("hole", 6.0) in shown("3700") and ("peg", 6.0) in shown("3673")         # a Technic hole and pin
    assert ("hole", 4.0) in shown("2429") and ("peg", 3.9) in shown("2430")         # a hinge base and its top
    finder = FitFinder(library)
    hinge = [Placement("2429", 0, (0.0, 0.0, 0.0), IDENTITY), Placement("2430", 0, (0.0, 0.0, 0.0), IDENTITY)]
    assert finder.find(hinge) == {(0, 1)}
    swung = [hinge[0], Placement("2430", 0, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0))]
    assert finder.find(swung) == {(0, 1)}                                           # a hinge still holds when turned
    apart = [hinge[0], Placement("2430", 0, (40.0, 0.0, 0.0), IDENTITY)]
    assert finder.find(apart) == set()
    bricks = [Placement("3001", 0, (0.0, 0.0, 0.0), IDENTITY), Placement("3001", 0, (0.0, -24.0, 0.0), IDENTITY)]
    assert finder.find(bricks) == set()                                             # studs are the checker's own


# ----- declared joints ------------------------------------------------------


def test_a_declared_joint_between_parts_that_do_not_touch_is_an_error(tmp_path):
    for assembly in (False, True):
        world = World(tmp_path / str(assembly), assembly=assembly)
        kit = world.kit()
        base(kit)
        post = kit.place("3005", "Red", 0, 2, 0)
        sign = kit.place("3022", "White", 4, 9, 0)  # in the air, four studs away
        kit.connect(post, sign, "sign hangs on the post")
        report = world.checker.check(kit.build)
        assert report.ok is not assembly  # taken on trust before; now it needs evidence
    assert kinds(report.errors) == ["joint"] and "do not touch" in report.errors[0].message
    assert "sign hangs on the post" in report.errors[0].message


def pinned(tmp_path, lift=0.0):
    world = World(tmp_path, extra=TECHNIC_PARTS, assembly=True)
    kit = world.kit()
    base(kit)
    brick = kit.place("3700", "Red", 0, 2, 0)
    x, y, z = kit.build.placements[brick].position
    pin = kit.place_ldu("3673", "Black", (x, y + 10 - lift, z), QUARTER, allow_overlap=True)
    kit.connect(brick, pin, "pin in the brick")
    return world.checker.check(kit.build)


def test_a_technic_pin_must_lie_in_a_hole_of_the_part_it_is_joined_to(tmp_path):
    seated = pinned(tmp_path / "in")
    assert seated.ok and any("1 declared joints: 1 measured as one part seated in the other, 0 others" in note
                             for note in seated.notes)
    beside = pinned(tmp_path / "off", lift=6)  # still touching the brick, but above the hole
    assert kinds(beside.errors) == ["joint"] and "in none of the other part's holes" in beside.errors[0].message


def test_a_joint_the_library_cannot_name_is_checked_for_touching_and_counted(tmp_path):
    world = World(tmp_path, assembly=True)
    kit = world.kit()
    base(kit)
    wall = kit.place("3001", "Red", 0, 2, 0)
    lamp = kit.place("3005", "White", 4, 2, 0)  # beside the wall, on the base
    kit.connect(wall, lamp, "clipped to the wall")
    report = world.checker.check(kit.build)
    assert report.ok and any("1 declared joints: 0 measured as one part seated in the other, 1 others checked "
                             "only for touching" in note for note in report.notes)


@pytest.mark.skipif(not (default_library_dir() / "LDConfig.ldr").is_file(), reason="needs an LDraw parts library")
def test_real_pins_axles_and_holes_are_read_from_the_parts_library():
    from fable_agent.ldraw import LDrawLibrary
    library = LDrawLibrary()
    assert {port.kind for port in library.ports("3673")} == {"pin"}
    # Newer releases of the library draw this part's axle end with another primitive, which is why
    # joints are taken from connector data first (see test_fable_connectors).
    assert {"pin"} <= {port.kind for port in library.ports("43093")} <= {"pin", "axle"}
    assert [port.kind for port in library.ports("3700")] == ["pin_hole", "pin_hole"]
    assert library.ports("3001") == () and library.ports("32062") == ()  # an axle's profile is not a hole
    assert len(library.surface("3001")) > len(library.geometry("3001").triangles)  # studs included


# ----- building order -------------------------------------------------------


def wall(world):
    kit = world.kit()
    base(kit, 8, 2)
    kit.module("wall")
    for course in range(4):
        kit.fill([(x, z) for x in range(8) for z in range(2)], 2 + 3 * course, "Red")
    return kit.build


def test_instructions_are_steps_of_at_most_five_connected_pieces_from_the_ground_up(tmp_path):
    world = World(tmp_path, assembly=True)
    build = wall(world)
    report = world.checker.check(build)
    plan = report.plan
    assert report.ok and sorted(plan.order) == list(range(len(build.placements)))
    sizes = [plan.steps.count(step) for step in range(1, plan.step_count + 1)]
    assert max(sizes) <= 5 and min(sizes) >= 1 and plan.steps == tuple(sorted(plan.steps))
    heights = [-build.placements[index].position[1] for index in plan.order]
    assert heights == sorted(heights)  # LDraw's y points down: lowest pieces first
    # Each step is one height of one module, so a step never mixes courses.
    for step in range(1, plan.step_count + 1):
        assert len({build.placements[i].position[1] for i, s in zip(plan.order, plan.steps) if s == step}) == 1
    assert any(f"{plan.step_count} steps of at most 5" in note for note in report.notes)
    assert report.to_dict()["instruction_steps"] == plan.step_count
    text = to_ldraw(build, "Wall", plan)
    assert text.count("0 STEP") == plan.step_count
    assert [line.split()[-1] for line in text.splitlines() if line.startswith("1 ")] == [
        f"{build.placements[index].part}.dat" for index in plan.order]


def test_every_piece_is_added_to_something_already_built(tmp_path):
    world = World(tmp_path, assembly=True)
    build = wall(world)
    report = world.checker.check(build)
    # An independent look at the plan: rebuild the stud contacts and walk the order.
    from fable_agent.checks import hash_boxes, stud_contacts, world_boxes
    boxes = {i: world_boxes(world.shapes.get(p.part), p) for i, p in enumerate(build.placements)}
    joined = {frozenset((c.stud, c.receiver)) for c in stud_contacts(build.placements, world.shapes, boxes,
                                                                    hash_boxes(boxes))}
    ground = max(box[4] for own in boxes.values() for box in own)
    built = set()
    for index in report.plan.order:
        on_ground = any(box[4] >= ground - 0.5 for box in boxes[index])
        assert on_ground or any(frozenset((index, other)) in joined for other in built)
        built.add(index)


def test_a_piece_that_hangs_under_its_support_is_built_together_with_it(tmp_path):
    world = World(tmp_path, assembly=True)
    kit = world.kit()
    base(kit, 4, 2)
    kit.place("3004", "Red", 0, 2, 0)                 # a post
    beam = kit.place("3020", "White", 0, 5, 0)        # a plate on the post, reaching out over the base
    hanging = kit.place("3024", "Black", 3, 4, 0)     # held only by the beam above it
    report = world.checker.check(kit.build)
    assert report.ok
    plan = report.plan
    start = plan.order.index(beam)
    assert start in plan.together and plan.order[start + 1] == hanging
    assert plan.steps[start] == plan.steps[start + 1]
    lines = to_ldraw(kit.build, "Beam", plan).splitlines()
    marker = lines.index(BUILD_TOGETHER)
    assert lines[marker + 1].endswith("3020.dat") and lines[marker + 2].endswith("3024.dat")


def test_free_standing_pieces_are_an_error_because_they_share_no_building_order(tmp_path):
    for assembly in (False, True):
        world = World(tmp_path / str(assembly), assembly=assembly)
        kit = world.kit()
        kit.place("3001", "Red", 0, 0, 0)
        kit.place("3001", "White", 8, 0, 0)
        report = world.checker.check(kit.build)
        assert (kinds(report.errors), kinds(report.warnings)) == ((["separate"], []) if assembly else ([], ["separate"]))
    assert "One connected model is needed" in report.errors[0].message
    assert "meant to be separate" not in report.errors[0].message


def test_a_model_no_order_can_build_is_reported_with_the_pieces_left_over(tmp_path, monkeypatch):
    world = World(tmp_path, assembly=True)
    build = wall(world)

    def blocked(self, build, contacts, boxes, fits):
        raise NoSequence("Remaining pieces are disconnected or require a blocked placement", (3, 4))

    monkeypatch.setattr(SequencePlanner, "plan", blocked)
    report = world.checker.check(build)
    assert kinds(report.errors) == ["sequence"] and report.plan is None
    assert "blocked placement" in report.errors[0].message and "#3 " in report.errors[0].message


def test_pieces_that_nothing_joins_have_no_building_order(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3001", "Red", 0, 0, 0)
    kit.place("3001", "White", 8, 0, 0)  # nothing joins the two
    from fable_agent.checks import world_boxes
    boxes = {i: world_boxes(world.shapes.get(p.part), p) for i, p in enumerate(kit.build.placements)}
    with pytest.raises(NoSequence) as refused:
        SequencePlanner(world.shapes).plan(kit.build, [], boxes)
    assert refused.value.remaining == (1,)


def test_an_order_is_checked_on_its_own_and_a_wrong_one_is_refused(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    base(kit, 4, 2)
    post = kit.place("3004", "Red", 0, 2, 0)
    cap = kit.place("3004", "White", 0, 5, 0)   # on the post
    from fable_agent.checks import hash_boxes, stud_contacts, world_boxes
    boxes = {i: world_boxes(world.shapes.get(p.part), p) for i, p in enumerate(kit.build.placements)}
    contacts = stud_contacts(kit.build.placements, world.shapes, boxes, hash_boxes(boxes))
    planner = SequencePlanner(world.shapes)
    joints, foundation = planner._joints(kit.build, contacts), planner._foundation(kit.build, boxes)
    order = list(planner.plan(kit.build, contacts, boxes).order)
    assert order.index(post) < order.index(cap) and joints.above[post] == {cap} and joints.below[cap] == {post}
    planner._verify(order, joints, foundation)
    swapped = [index for index in order if index != post]
    swapped.insert(swapped.index(cap) + 1, post)  # the cap before the post that holds it
    with pytest.raises(NoSequence, match="before anything that holds it"):
        planner._verify(swapped, joints, foundation)
    with pytest.raises(NoSequence, match="exactly once"):
        planner._verify(order[:-1], joints, foundation)
    with pytest.raises(NoSequence, match="on the ground must be placed"):
        planner._verify([cap, *[index for index in order if index != cap]], joints, foundation)
    with pytest.raises(NoSequence, match="no pieces"):
        planner.plan(world.kit().build, [], {})


def test_a_piece_is_not_placed_over_one_that_would_be_closed_in(tmp_path):
    from fable_agent.sequence import _trapped
    # A stack of three: with the bottom and the top built, the middle one could no longer go in.
    above, below = [{1}, {2}, set()], [set(), {0}, {1}]
    assert _trapped(2, {0}, above, below) == {1} and _trapped(0, {2}, above, below) == {1}
    assert _trapped(1, {0}, above, below) == set() and _trapped(2, {0, 1}, above, below) == set()


def test_a_piece_is_slid_onto_an_axle_before_pieces_sit_on_both_sides_of_its_place():
    from fable_agent.sequence import _Joints, _shaft_stacks, _trapped_on_shaft
    # Axle 0 carries three parts: 1 at 10 LDU along it, 2 at 30 and 3 at 50.
    stacks = _shaft_stacks({0: [(10.0, 1), (30.0, 2), (50.0, 3)]})
    assert _trapped_on_shaft(3, {0, 1}, stacks) == {2}  # the far one now would close in the middle one
    assert _trapped_on_shaft(2, {0, 1}, stacks) == set() and _trapped_on_shaft(3, {0, 1, 2}, stacks) == set()
    assert _trapped_on_shaft(3, {1}, stacks) == set()  # the axle itself is not in yet: nothing is on it
    assert _trapped_on_shaft(0, {1, 3}, stacks) == {2}  # nor may the axle go in through two parts and miss one
    # The order found respects it, and one that does not is refused.
    joints = _Joints([{1, 2, 3}, {0}, {0}, {0}], [set()] * 4, [set()] * 4, stacks)
    order = SequencePlanner._order(Build([Placement("3001", 0, (0, 0, 0), IDENTITY)] * 4), joints, {0})
    assert order.index(2) < max(order.index(1), order.index(3))
    SequencePlanner._verify(order, joints, {0})
    with pytest.raises(NoSequence, match="closed in"):
        SequencePlanner._verify([0, 1, 3, 2], joints, {0})


def test_what_rests_on_the_ground_is_seated_first_and_a_tyre_is_not_a_foundation(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3001", "Red", 0, 0, 0)
    kit.place("3001", "White", 2, 3, 0)
    from fable_agent.checks import world_boxes
    boxes = {i: world_boxes(world.shapes.get(p.part), p) for i, p in enumerate(kit.build.placements)}
    planner = SequencePlanner(world.shapes)
    assert planner._foundation(kit.build, boxes) == {0}
    narrow = {0: [(0.0, -24.0, 0.0, 4.0, 0.0, 40.0)], 1: boxes[1]}  # touches down on a strip, like a tyre
    assert planner._foundation(kit.build, narrow) == set()
    assert planner._foundation(kit.build, {}) == set()


def test_without_a_plan_the_script_steps_are_written_as_before(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    kit.place("3001", "Red", 0, 0, 0)
    kit.step()
    kit.place("3001", "White", 0, 3, 0)
    assert to_ldraw(kit.build, "Two").count("0 STEP") == 2 and BUILD_TOGETHER not in to_ldraw(kit.build, "Two")


def test_joint_review_measures_a_turned_part_by_the_box_that_holds_it(tmp_path):
    world = World(tmp_path)
    kit = world.kit()
    first = kit.place("3001", "Red", 0, 0, 0)
    second = kit.place("3020", "White", 4, 0, 0, rot=45)
    kit.connect(first, second, "hinged")
    found = JointReview(world.library, world.shapes).review(kit.build, {}, set())
    assert found.touching == 1 and not found.apart and not found.missed and found.seated == 0
    assert JointReview._gap([], [(0, 0, 0, 1, 1, 1)]) == 0.0
