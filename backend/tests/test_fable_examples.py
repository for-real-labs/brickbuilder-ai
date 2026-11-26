"""Example scripts a v2 agent can ask to see: the library, the model's choice of category and the set importer."""

from decimal import Decimal

import pytest
from fable_agent import examples
from fable_agent.app import Options, Workbench, start_build
from fable_agent.examples import BY_ID, CATEGORIES, PROMPT_BUDGET, load, prompt_section, shown, stocked_categories
from fable_agent.examples.chooser import NONE, TOOL_NAME, choose_category
from fable_agent.examples.importer import Limits, SetImporter, StockedParts, categorize, read_model
from fable_agent.ldraw import default_library_dir
from fable_agent.provider import ProviderError
from fable_agent.session import Session

from fable_agent_support import CABIN, FakeClient, FakeRenderer, InlineRunner, World, reply, tool_use

USAGE = {"input_tokens": 300, "output_tokens": 40}


@pytest.fixture(autouse=True)
def private_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("FABLE_AGENT_CACHE", str(tmp_path / "cache"))


# ----- the library ----------------------------------------------------------


def test_every_category_is_described_and_the_stocked_ones_have_examples():
    assert len({category.id for category in CATEGORIES}) == len(CATEGORIES) and set(BY_ID) >= {"cars", "houses"}
    stocked = stocked_categories()
    assert {"cars", "houses", "buildings", "castles", "animals"} <= {category.id for category in stocked}
    for category in CATEGORIES:
        assert category.covers and category.shows and (category in stocked) == bool(load(category.id))
    with pytest.raises(KeyError):
        load("../secrets")


def test_examples_carry_their_title_and_source_and_keep_them_out_of_the_script():
    cars = load("cars")
    assert [example.name for example in cars[:2]] == ["convertible", "jeep"] and not cars[0].official
    police = next(example for example in cars if example.name == "police_car")
    assert police.title == "Police car" and police.source == "written for BrickBuilder"
    assert "#:" not in police.script and police.script.startswith("# Police car") and "chassis(" in police.script
    sets = [example for category in stocked_categories() for example in load(category.id) if example.official]
    assert len(sets) >= 40
    for example in sets:  # every official set is credited, in its file and in the list of sources
        assert "official set" in example.title and "model file by" in example.source and "place(" in example.script
    listed = (examples.LIBRARY.parent / "SOURCES.md").read_text()
    assert all(example.source.split("set ")[1].split(",")[0] in listed for example in sets)
    assert "Creative Commons Attribution" in listed and "does not sponsor or endorse" in listed


def test_written_examples_come_first_and_a_build_is_shown_only_what_fits_the_budget():
    buildings = load("buildings")
    assert buildings[0].name == "hospital" and all(example.official for example in buildings[1:])
    sizes = [len(example.script) for example in buildings[1:]]
    assert sizes == sorted(sizes)  # official sets from small to large
    for category in stocked_categories():
        every, fitting = load(category.id), shown(category.id)
        assert sum(len(example.script) for example in fitting) <= PROMPT_BUDGET and set(fitting) <= set(every)
        if sum(len(example.script) for example in every) <= PROMPT_BUDGET:
            assert fitting == every  # a category that fits is shown whole
    # Sets have no size limit, so the largest category holds more than one prompt takes: the big ones wait.
    assert len(shown("buildings")) < len(buildings) and shown("buildings")[0].name == "hospital"
    assert max(len(example.script) for example in buildings) > 30_000
    few = shown("buildings", budget=len(buildings[0].script) + len(buildings[1].script))
    assert [example.name for example in few] == [buildings[0].name, buildings[1].name]
    assert shown("buildings", budget=10) == ()


def test_the_prompt_section_names_the_category_and_holds_each_script_whole():
    section = prompt_section("buildings")
    assert section.startswith("# Example scripts: shops, stations, hospitals")
    assert "Do not copy a design" in section and "official LEGO sets" in section and "#:" not in section
    for example in shown("buildings"):
        assert f"## {example.title}\n\n```python\n{example.script.strip()}\n```" in section
    cars = prompt_section("cars")
    assert "where the body starts on the chassis" in cars and f"Below are {len(shown('cars'))} finished scripts" in cars
    houses = prompt_section("houses")
    assert houses.index("## Log cabin") < houses.index("official set")  # written examples first


@pytest.mark.skipif(not (default_library_dir() / "LDConfig.ldr").is_file(), reason="needs an LDraw parts library")
@pytest.mark.parametrize("example", [example for category in CATEGORIES for example in load(category.id)],
                         ids=lambda example: f"{example.category}/{example.name}")
def test_every_example_passes_the_checks_a_pip_build_must_pass(example):
    from fable_agent.helpers import bind
    from fable_agent.kit import Kit, rect, ring
    bench = Workbench.open({"ldraw_dir": None, "catalog_path": None, "open_palette": False, "max_parts": 100_000,
                            "assembly_rules": True})  # a set may be larger than a build is allowed to be
    kit = Kit(bench.library, bench.shapes, bench.palette, bench.finder, max_placements=100_000)
    scope = {name: getattr(kit, name) for name in ("place", "place_ldu", "fill", "row", "inset", "connect", "module",
                                                   "step")}
    exec(example.script, {**scope, **bind(kit), "rect": rect, "ring": ring})  # noqa: S102 - our own scripts
    report = bench.checker.check(kit.build)
    assert report.ok and not report.warnings, [issue.message for issue in report.errors + report.warnings][:2]
    assert report.plan.step_count >= 1


# ----- the model's choice ---------------------------------------------------


def asked(text="Request: A red fire station"):
    return [{"type": "text", "text": text}]


def test_the_model_is_given_the_stocked_categories_and_names_one():
    client = FakeClient([reply(tool_use(TOOL_NAME, "c1", category="buildings"), usage=USAGE)])
    choice = choose_category(client, asked())
    assert choice.category == "buildings" and choice.reply.usage == USAGE
    sent = client.requests[0]
    assert sent["messages"] == [{"role": "user", "content": asked()}]
    assert "`buildings`: shops, stations" in sent["system"] and f"`{NONE}`: none of these" in sent["system"]
    offered = sent["tools"][0]["input_schema"]["properties"]["category"]["enum"]
    assert offered == [category.id for category in stocked_categories()] + [NONE] and "trains" not in offered


@pytest.mark.parametrize(("answer", "expected"), [
    (reply(tool_use(TOOL_NAME, "c1", category=NONE)), None),
    (reply(tool_use(TOOL_NAME, "c1", category="weapons")), None),  # not a category: no examples
    (reply(tool_use(TOOL_NAME, "c1")), None),
    (reply(tool_use("build", "c1", code="x")), None),
    (reply({"type": "text", "text": "`cars`."}), "cars"),  # answered in words
    (reply({"type": "text", "text": "I would pick cars or houses."}), None),
])
def test_an_answer_that_is_not_one_stocked_category_means_no_examples(answer, expected):
    assert choose_category(FakeClient([answer]), asked()).category == expected


def test_a_failed_call_costs_nothing_and_shows_no_examples():
    class Down:
        model = "gpt-6.2-sol"

        def send(self, *args, **kwargs):
            raise ProviderError("unavailable")

    choice = choose_category(Down(), asked())
    assert choice.category is None and choice.reply is None


# ----- a build with examples ------------------------------------------------


def build(tmp_path, method, examples, first):
    world = World(tmp_path / "world", assembly=method.endswith("-v2"))
    client = FakeClient([first, reply(tool_use("build", "c1", code=CABIN, notes="Walls.")),
                         reply(tool_use("finish", "c2", title="Cabin", summary="A cabin."))])
    bench = Workbench.open(world.settings(), runner=InlineRunner(world), renderer=FakeRenderer())
    events = []
    result = start_build("A small cabin by a lake", tmp_path / "run",
                         Options(max_parts=500, method=method, max_steps=3, examples=examples),
                         client=client, workbench=bench, on_event=lambda kind, data: events.append((kind, data)))
    return result, client, Session.load(tmp_path / "run"), events


def test_a_v2_build_that_asks_for_examples_reads_the_category_the_model_chose(tmp_path):
    result, client, session, events = build(tmp_path, "lean-v2", True,
                                            reply(tool_use(TOOL_NAME, "c0", category="houses"), usage=USAGE))
    assert result.status == "published" and len(client.requests) == 3
    assert client.requests[0]["messages"][0]["content"][-1]["text"] == "Request: A small cabin by a lake"
    # Every round is sent the same prompt: the examples are added once, before the first round.
    assert client.requests[1]["system"] == client.requests[2]["system"] == session.meta["system"]
    assert session.meta["system"].endswith(prompt_section("houses"))
    assert session.meta["settings"]["examples"] is True and session.meta["settings"]["example_category"] == "houses"
    # The choice is a model call like any other: charged to the run and reported as a turn.
    assert len(session.meta["usage"]) == 3 and session.meta["usage"][0]["input_tokens"] == 300
    turns = [data for kind, data in events if kind == "turn"]
    assert turns[0]["step"] == 0 and turns[0]["usage"] == session.meta["usage"][0] and len(turns) == 3
    assert result.spent_usd == sum(Decimal(call["estimated_cost_usd"])
                                   for call in session.meta["usage"])


def test_a_build_runs_without_examples_when_none_fits_or_none_was_asked_for(tmp_path):
    none = reply(tool_use(TOOL_NAME, "c0", category=NONE), usage=USAGE)
    result, client, session, _ = build(tmp_path / "none", "lean-v2", True, none)
    assert result.status == "published" and "# Example scripts" not in session.meta["system"]
    assert session.meta["settings"]["example_category"] is None and len(session.meta["usage"]) == 3

    # Off, or a first-version method: no choice is made and nothing is added.
    for method, examples in (("lean-v2", False), ("lean", True)):
        client = FakeClient([reply(tool_use("build", "c1", code=CABIN, notes="Walls.")),
                             reply(tool_use("finish", "c2", title="Cabin", summary="A cabin."))])
        world = World(tmp_path / f"{method}-{examples}" / "world")
        start_build("A cabin", tmp_path / f"{method}-{examples}" / "run",
                    Options(max_parts=500, method=method, max_steps=3, examples=examples), client=client,
                    workbench=Workbench.open(world.settings(), runner=InlineRunner(world), renderer=FakeRenderer()))
        session = Session.load(tmp_path / f"{method}-{examples}" / "run")
        assert session.meta["settings"]["examples"] is False and "example_category" not in session.meta["settings"]
        assert "# Example scripts" not in client.requests[0]["system"] and client.requests[0]["tools"][0]["name"] == "build"


# ----- importing official sets ----------------------------------------------

LICENCE = "0 !LICENSE Redistributable under CCAL version 2.0 : see CAreadme.txt"
ONE = "1 0 0 0 1 0 0 0 1"


def model_file(*lines, licence=LICENCE, theme="Town"):
    return "\n".join(["0 FILE 600 - Hut.ldr", "0 Hut", "0 Name: 600 - Hut.ldr", "0 Author: A Builder [builder]",
                      licence, f"0 !THEME {theme}", *lines]) + "\n"


def hut_lines(lift=0):
    """A base plate with a ring of four bricks on it, as an LDraw file writes them."""
    lines = [f"1 2 0 0 0 {ONE} 3020.dat", f"1 2 0 0 40 {ONE} 3020.dat", f"1 2 80 0 0 {ONE} 3020.dat",
             f"1 2 80 0 40 {ONE} 3020.dat"]
    lines += [f"1 4 {x} {-24 - lift} {z} {ONE} 3001.dat" for x, z in ((40, 0), (40, 40))]  # bridge the plates
    lines += [f"1 15 {x} {-48 - lift} 20 {ONE} 3001.dat" for x in (0, 80)]
    return lines


def test_a_model_file_is_read_with_its_credit_and_only_if_it_may_be_reused():
    model = read_model(model_file(*hut_lines()))
    assert (model.title, model.author, model.theme) == ("Hut", "A Builder [builder]", "Town")
    assert "CCAL version 2.0" in model.licence and len(model.parts) == 8
    assert model.parts[0] == ("3020", 2, (0.0, 0.0, 0.0), (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0))
    assert read_model(model_file(*hut_lines(), licence="0 !LICENSE Free for non-commercial use.")) is None
    assert read_model(model_file(*hut_lines(), licence="0 // no licence line")) is None
    mixed = model_file(*hut_lines()) + "0 FILE roof.ldr\n0 !LICENSE Free for non-commercial use.\n"
    assert read_model(mixed) is None  # one file inside that may not be reused taints the model
    assert read_model(model_file()) is None and read_model("x" * (9 * 1024 * 1024)) is None


def test_submodels_are_flattened_with_their_position_turn_and_color():
    text = "\n".join(["0 FILE main.ldr", "0 Main", LICENCE, "1 4 100 -8 0 0 0 1 0 1 0 -1 0 0 wing.ldr",
                      "0 FILE wing.ldr", "0 Wing", LICENCE, f"1 16 20 0 0 {ONE} 3020.dat"]) + "\n"
    (part, color, position, matrix), = read_model(text).parts
    assert (part, color) == ("3020", 4)  # color 16 takes the color of the reference
    assert position == (100.0, -8.0, -20.0) and matrix == (0.0, 0.0, 1.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0)


def importer(world, **limits):
    return SetImporter(world.library, world.shapes, world.palette, world.finder, world.checker,
                       Limits(least_parts=4, **limits))


def test_a_set_that_stands_and_passes_becomes_a_script_of_plain_place_calls(tmp_path):
    world = World(tmp_path, assembly=True)
    converted = importer(world).convert(read_model(model_file(*hut_lines())))
    assert (converted.parts, converted.of) == (8, 8)
    lines = converted.script.splitlines()
    assert len(lines) == 8 and all(line.startswith('place("') for line in lines)
    assert lines[0].startswith('place("3020", "Green", ') and lines[-1].startswith('place("3001", "White", ')
    # The script is in building order and rebuilds the very same model, on the ground at y = 0.
    kit = world.kit()
    exec(converted.script, {"place": kit.place})  # noqa: S102
    report = world.checker.check(kit.build)
    assert report.ok and not report.warnings and min(-p.position[1] for p in kit.build.placements) >= 0
    assert [-p.position[1] for p in kit.build.placements] == sorted(-p.position[1] for p in kit.build.placements)


def test_parts_the_checks_cannot_join_are_left_out_and_too_many_reject_the_set(tmp_path):
    world = World(tmp_path, assembly=True)
    floating = f"1 4 0 -200 0 {ONE} 3005.dat"       # held by nothing the checks can see
    unknown = f"1 4 0 -24 0 {ONE} 99999.dat"        # not in the parts library at all: not counted
    most = importer(world).convert(read_model(model_file(*hut_lines(), floating, unknown)))
    assert (most.parts, most.of) == (8, 9) and "3005" not in most.script
    strict = importer(world, least_kept=0.95)
    assert strict.convert(read_model(model_file(*hut_lines(), floating))) is None
    # Bricks hovering above the plates: nothing is joined, so nothing is kept.
    assert importer(world).convert(read_model(model_file(*hut_lines(lift=40)))) is None
    assert importer(world, most_parts=6).convert(read_model(model_file(*hut_lines()))) is None


def test_a_part_held_by_a_pin_is_kept_because_the_joint_is_measured(tmp_path):
    from fable_agent_support import TECHNIC_PARTS
    world = World(tmp_path, extra=TECHNIC_PARTS, assembly=True)
    # On the hut: a Technic brick, a pin through its hole, and nothing else holding the pin.
    brick = f"1 4 100 -24 0 {ONE} 3700.dat"
    pin = "1 0 100 -14 10 0 0 1 0 1 0 -1 0 0 3673.dat"
    converted = importer(world).convert(read_model(model_file(*hut_lines(), brick, pin)))
    assert converted is not None and (converted.parts, converted.of) == (10, 10)
    assert 'place_ldu("3673"' in converted.script or 'place("3673"' in converted.script
    assert "connect(" not in converted.script and "allow_overlap" not in converted.script


def test_a_set_of_any_size_is_taken_unless_a_limit_is_given(tmp_path):
    assert Limits().most_parts is None and Limits().most_raw == 0.5
    world = World(tmp_path, assembly=True)
    rows = [f"1 2 {80 * column} 0 {40 * row} {ONE} 3020.dat" for column in range(6) for row in range(2)]
    rows += [f"1 4 {80 * column + 40} -24 {40 * row} {ONE} 3001.dat" for column in range(5) for row in range(2)]
    rows += [f"1 15 {80 * column} -48 20 {ONE} 3001.dat" for column in range(6)]
    big = read_model(model_file(*rows))
    assert importer(world).convert(big).parts == 28 and importer(world, most_parts=20).convert(big) is None


def test_a_part_is_matched_to_the_stocked_number_it_moved_to_or_from_or_a_twin_variant(tmp_path):
    from fable_agent_support import COLORS, PARTS
    unstocked = {(part, color) for part in ("3001", "3004a", "3622a") for color in COLORS}
    world = World(tmp_path, skip=unstocked, extra={
        "3001new": "0 ~Moved to 3001\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n",  # stocked under its old number
        "3004a": PARTS["3004"],   # an unstocked twin of the stocked 3004
        "3622a": PARTS["3010"], "3622": PARTS["3004"]})  # same number, different size: not a stand-in
    stock = StockedParts(world.library, world.shapes, world.palette)
    assert stock.find("3020") == "3020"                    # stocked as it is
    assert stock.find("3660") == "3039"                    # the number it moved to
    assert stock.find("3001") == "3001new"                 # a stocked number whose file moved to this one
    assert stock.find("3004a") == "3004"                   # a variant that measures the same
    assert stock.find("3622a") is None                     # a variant that does not
    assert stock.find("not a part!") is None and stock.find("77777") is None


def test_an_alias_file_stands_for_the_part_it_points_to(tmp_path):
    from fable_agent_support import COLORS
    world = World(tmp_path, skip={("3001alias", color) for color in COLORS},
                  extra={"3001alias": "0 =Brick  2 x  4\n0 Name: 3001alias.dat\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n"})
    assert StockedParts(world.library, world.shapes, world.palette).find("3001alias") == "3001"


@pytest.mark.parametrize(("name", "theme", "category"), [
    ("Empire State Building", "Architecture", "buildings"), ("Lighthouse", "", "buildings"),
    ("Bricktober Train Station", "", "buildings"), ("Steam Locomotive", "", "trains"), ("House", "", "houses"),
    ("Tugboat", "", "boats"), ("Seaplane", "", "aircraft"), ("Flyers", "", "aircraft"),
    ("Star Destroyer - Mini", "Star Wars", "spacecraft"), ("Halloween Bat", "", "characters"),
    ("South African Flag", "", "flat"), ("Lion", "Creator", "animals"), ("Race car", "", "cars"),
    ("X-Wing Fighter", "Star Wars", "spacecraft"), ("Unnamed", "Architecture", "buildings"),
    ("Cartoon carpet", "", None), ("Unnamed", "Technic", None),
])
def test_a_set_is_sorted_by_the_words_in_its_name_and_then_by_its_theme(name, theme, category):
    assert categorize(name, theme) == category
