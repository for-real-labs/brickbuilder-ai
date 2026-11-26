"""Example builds a v2 agent can be shown: the library, how examples are found, and the set importer."""

import importlib.util
import json
import subprocess
from decimal import Decimal
from pathlib import Path

import pytest
from fable_agent import app, examples
from fable_agent.app import Options, Workbench, start_build
from fable_agent.examples import LIBRARY, MOST_SHOWN, PROMPT_BUDGET, Entry, Example, entries, load, prompt_section
from fable_agent.examples.importer import REUSABLE, Limits, SetImporter, flatten, read_file, read_model
from fable_agent.examples.retrieval import (CANDIDATES, JEV_MODEL, JEV_USD_PER_MILLION_INPUT_TOKENS, PER_SET,
                                            ExampleFinder, Retrieval)
from fable_agent.ldraw import default_library_dir
from fable_agent.session import Session
from fable_agent.stock import StockedParts

from fable_agent_support import CABIN, FakeClient, FakeRenderer, InlineRunner, World, reply, tool_use

real_parts = pytest.mark.skipif(
    not (default_library_dir() / "LDConfig.ldr").is_file() or importlib.util.find_spec("ldraw") is None,
    reason="needs an LDraw parts library and pyldraw3")


@pytest.fixture(autouse=True)
def private_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("FABLE_AGENT_CACHE", str(tmp_path / "cache"))


# ----- the library ----------------------------------------------------------


def test_the_index_lists_every_script_and_every_script_carries_its_credit():
    listed = entries()
    assert len(listed) > 300 and len({entry.id for entry in listed}) == len(listed)
    on_disk = {path.relative_to(LIBRARY).with_suffix("").as_posix() for path in LIBRARY.rglob("*.py")}
    assert on_disk == {entry.id for entry in listed}  # nothing unlisted is shipped, nothing listed is missing
    credited = (LIBRARY / "SOURCES.md").read_text(encoding="utf-8")
    for entry in listed:
        header = [line for line in (LIBRARY / f"{entry.id}.py").read_text(encoding="utf-8").splitlines()
                  if line.startswith("#:")]
        facts = {line[2:].partition(":")[0].strip(): line[2:].partition(":")[2].strip() for line in header}
        assert {"title", "source", "author", "licence", "changes"} <= set(facts), entry.id
        # Only files whose own licence allows commercial reuse with credit are adapted.
        assert REUSABLE.search(facts["licence"]) and "non-commercial" not in facts["licence"].lower(), entry.id
        assert f"`{entry.id}.py`" in credited, entry.id
        assert entry.title and entry.kind in ("model", "submodel") and entry.parts >= 3
    assert "non-commercial" not in credited.lower()


def test_an_example_is_read_by_its_id_only_and_its_credit_stays_out_of_the_script():
    first = entries()[0]
    example = load(first.id)
    assert example.entry == first and example.source and example.licence
    assert "#:" not in example.script and example.script.startswith(("place(", "place_ldu("))
    assert len(example.script) == first.chars
    for path in ("../importer", "/etc/passwd", first.id + ".py", "no/such"):
        with pytest.raises(KeyError):
            load(path)


@real_parts
def test_examples_marked_checked_pass_the_checks_a_pip_build_must_pass_apart_from_the_catalog():
    """Examples marked ``checked`` passed these checks when they were converted. This runs a spread
    of them again, on this machine's parts library, so a change to a check is noticed."""
    from fable_agent.connectors import ConnectorLibrary
    from fable_agent.kit import Kit
    from fable_agent.shape import default_cache_dir
    from fable_agent.toolkit.technic import definition
    connectors = ConnectorLibrary(default_library_dir(), default_cache_dir())
    if definition(connectors.parts.geometry("3705")) is None:
        pytest.skip("this parts library is an older release than the one the examples were converted with")
    bench = Workbench.open({"ldraw_dir": None, "catalog_path": None, "open_palette": True, "max_parts": 100_000,
                            "assembly_rules": True})
    listed = [entry for entry in entries() if entry.checked]
    assert listed
    for entry in listed[:: max(1, len(listed) // 40)]:
        kit = Kit(bench.library, bench.shapes, bench.palette, bench.finder, max_placements=100_000)
        exec(load(entry.id).script, {"place": kit.place, "place_ldu": kit.place_ldu, "__builtins__": {}})  # noqa: S102
        report = bench.checker.check(kit.build)
        assert report.ok and not report.warnings, (entry.id, [i.message for i in report.errors + report.warnings][:2])
        assert report.parts == entry.parts and report.plan.step_count >= 1


def example(identity="60000-1/model", title="Fire station with a garage", kind="model", parts=120, script=None):
    script = script or 'place("3001", "Red", 0, 0, 0)\n' * 3
    return Example(Entry(identity, title, kind, identity.split("/")[0], parts, len(script)),
                   "LDraw Official Model Repository, 60000-1.mpd", "A Builder", "CCAL version 2.0", script)


def test_the_prompt_section_shows_each_script_whole_and_says_examples_are_not_held_to_the_catalog():
    assert prompt_section(()) == ""
    section = prompt_section([example(), example("60000-1/roof", "Sloped roof with a chimney", "submodel", 30)])
    assert section.startswith("# Example builds") and "Below are 2 finished builds" in section
    assert "may use parts and colors the catalog does not stock" in section and "catalog parts only" in section
    assert "## Fire station with a garage\n\n(whole model, 120 parts)" in section
    assert "## Sloped roof with a chimney\n\n(one section of a model, 30 parts)" in section
    assert section.count("```python") == 2 and "A Builder" not in section and "#:" not in section
    assert "Below is 1 finished build " in prompt_section([example()])


# ----- finding examples -----------------------------------------------------

ROWS = [("60000-1/model", "Red fire station with a garage door and a hose tower", "model", 400),
        ("60000-1/fire-engine", "Fire engine with a ladder and a hose reel", "submodel", 300),
        ("60000-1/station-roof", "Flat fire station roof with a siren", "submodel", 300),
        ("7000-1/model", "Small sailing boat with a white sail", "model", 300),
        ("7001-1/model", "Fire boat with water cannons", "model", 300),
        ("7002-1/model", "Large fire brigade headquarters with three garage doors", "model", 30_000)]


def library(tmp_path, rows=ROWS):
    root = tmp_path / "library"
    lines = []
    for identity, title, kind, chars in rows:
        script = ('place("3001", "Red", 0, 0, 0)\n' * (chars // 31 + 1))[:chars - 1] + "\n"
        target = root / f"{identity}.py"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"#: title: {title}\n#: source: test\n#: author: A\n#: licence: CCAL\n{script}")
        lines.append(json.dumps({"id": identity, "title": title, "kind": kind, "set": identity.split("/")[0],
                                 "parts": 20, "chars": len(script.strip()) + 1}))
    (root / "index.jsonl").write_text("\n".join(lines) + "\n")
    return root


class FakeJev:
    """Stands in for the jev-rerank command: answers with a ranking, or fails the way it is told to."""

    def __init__(self, ranked=(), *, tokens=100_000, returncode=0, stdout=None, error=None):
        self.ranked, self.tokens, self.returncode, self.stdout, self.error = ranked, tokens, returncode, stdout, error
        self.calls = []

    def __call__(self, command, **options):
        self.calls.append((command, options))
        if self.error is not None:
            raise self.error
        answer = self.stdout if self.stdout is not None else json.dumps({
            "results": [{"rank": n + 1, "score": 0.9, "source": {"key": {"id": identity}}}
                        for n, identity in enumerate(self.ranked)],
            "stats": {"input_tokens": self.tokens, "output_tokens": 50}})
        return subprocess.CompletedProcess(command, self.returncode, answer, "")


def test_jev_ranks_the_descriptions_and_the_best_that_fit_are_returned_with_what_the_search_cost(tmp_path):
    jev = FakeJev(["7002-1/model", "60000-1/model", "60000-1/fire-engine", "60000-1/station-roof", "7001-1/model",
                   "not-in-the-library"])
    found = ExampleFinder(tmp_path, library=library(tmp_path), api_key="secret-key-123", runner=jev, budget=1000).find(
        "  A red   fire station ")
    # The largest does not fit the prompt, a third of one set is left for another set, unknown ids are ignored.
    assert [e.entry.id for e in found.examples] == ["60000-1/model", "60000-1/fire-engine", "7001-1/model"]
    assert PER_SET == 2 and found.engine == "jev" and found.note == ""
    assert found.input_tokens == 100_000 and found.cost_usd == Decimal("0.0042")
    assert JEV_USD_PER_MILLION_INPUT_TOKENS == Decimal("0.042")
    command, options = jev.calls[0]
    assert command[0] == "jev-rerank" and command[command.index("--model") + 1] == JEV_MODEL
    assert command[command.index("--table-field") + 1] == "candidates.full_description"
    assert command[command.index("--candidates") + 1] == str(CANDIDATES)
    assert json.loads(command[command.index("--query") + 1])["query"] == "A red fire station"
    # The command is given the key and nothing else of the API's environment.
    assert set(options["env"]) == {"TYPESAFE_API_KEY", "PATH", "HOME"} and options["timeout"] > 0
    record = found.record()
    assert record["engine"] == "jev" and record["estimated_cost_usd"] == "0.004200" and len(record["examples"]) == 3
    assert options["env"]["TYPESAFE_API_KEY"] == "secret-key-123" and "secret-key-123" not in json.dumps(record)


@pytest.mark.parametrize("jev", [
    FakeJev(returncode=2), FakeJev(stdout="not json"), FakeJev(stdout=json.dumps({"results": [{"rank": 1}]})),
    FakeJev(error=subprocess.TimeoutExpired("jev-rerank", 45)), FakeJev(error=FileNotFoundError("jev-rerank")),
], ids=["fails", "garbage", "odd answer", "times out", "not installed"])
def test_when_jev_fails_the_keyword_search_stands_in_and_the_result_says_so(tmp_path, jev):
    found = ExampleFinder(tmp_path, library=library(tmp_path), api_key="k", runner=jev, budget=1000).find(
        "Please build a fire station")
    assert found.engine == "keywords" and "Jev was not used" in found.note and found.cost_usd == 0
    ids = [e.entry.id for e in found.examples]
    assert ids and "7000-1/model" not in ids and set(ids) <= {"60000-1/model", "60000-1/station-roof",
                                                               "60000-1/fire-engine", "7001-1/model"}


def test_without_a_key_jev_is_not_called_and_a_request_nothing_matches_gets_no_examples(tmp_path):
    jev = FakeJev(["60000-1/model"])
    finder = ExampleFinder(tmp_path, library=library(tmp_path), api_key="", runner=jev)
    found = finder.find("a sailing boat")
    assert not jev.calls and found.engine == "keywords" and "TYPESAFE_API_KEY is not set" in found.note
    assert [e.entry.id for e in found.examples][0] == "7000-1/model" and len(found.examples) <= MOST_SHOWN
    nothing = finder.find("xylophone")
    assert nothing.examples == () and nothing.engine == "none" and "no example matched" in nothing.note


def test_a_search_never_stops_a_build(tmp_path):
    empty = ExampleFinder(tmp_path, library=tmp_path / "missing", api_key="k", runner=FakeJev()).find("a house")
    assert empty.examples == () and "empty" in empty.note
    assert ExampleFinder(tmp_path, library=library(tmp_path), api_key="k", runner=FakeJev()).find("  ").examples == ()
    broken = library(tmp_path / "b")
    (broken / "60000-1" / "model.py").unlink()  # listed but gone
    lost = ExampleFinder(tmp_path / "b", library=broken, api_key="k", runner=FakeJev(["60000-1/model"])).find("fire")
    assert lost.examples == () and "could not be searched" in lost.note


def test_the_shipped_library_is_searched_by_what_a_request_is_about(tmp_path):
    found = ExampleFinder(tmp_path, api_key="").find("a fire station with a garage")
    assert found.engine == "keywords" and found.examples
    assert sum(e.entry.chars for e in found.examples) <= PROMPT_BUDGET
    assert any("fire" in e.entry.title.lower() for e in found.examples)


# ----- a build with examples ------------------------------------------------


class StubFinder:
    def __init__(self, *args, **kwargs):
        pass

    def find(self, request):
        StubFinder.asked = request
        return Retrieval((example(),), "jev", "", 1.5, 100_000, Decimal("0.0042"))


def build(tmp_path, method, use_examples, monkeypatch, finder=StubFinder):
    monkeypatch.setattr(app, "ExampleFinder", finder)
    world = World(tmp_path / "world", assembly=method.endswith("-v2"))
    client = FakeClient([reply(tool_use("build", "c1", code=CABIN, notes="Walls.")),
                         reply(tool_use("finish", "c2", title="Cabin", summary="A cabin."))])
    bench = Workbench.open(world.settings(), runner=InlineRunner(world), renderer=FakeRenderer())
    events = []
    result = start_build("A small cabin by a lake", tmp_path / "run",
                         Options(max_parts=500, method=method, max_steps=3, examples=use_examples),
                         client=client, workbench=bench, on_event=lambda kind, data: events.append((kind, data)))
    return result, client, Session.load(tmp_path / "run"), events


def test_a_v2_build_that_asks_for_examples_is_shown_what_was_found_and_charged_for_the_search(tmp_path, monkeypatch):
    result, client, session, events = build(tmp_path, "lean-v2", True, monkeypatch)
    assert result.status == "published" and len(client.requests) == 2  # the search is not a model call
    assert StubFinder.asked == "A small cabin by a lake"
    # The website adds design guidance to the request; examples are searched for the customer's own words.
    world = World(tmp_path / "web" / "world", assembly=True)
    start_build("Guidance the app adds.\n\nUser request:\nA lighthouse", tmp_path / "web" / "run",
                Options(max_parts=500, method="lean-v2", max_steps=3, examples=True, example_query="A lighthouse"),
                client=FakeClient([reply(tool_use("build", "c1", code=CABIN, notes="Walls.")),
                                   reply(tool_use("finish", "c2", title="Cabin", summary="A cabin."))]),
                workbench=Workbench.open(world.settings(), runner=InlineRunner(world), renderer=FakeRenderer()))
    assert StubFinder.asked == "A lighthouse"
    # Every round is sent the same prompt: the examples are added once, before the first round.
    assert client.requests[0]["system"] == client.requests[1]["system"] == session.meta["system"]
    assert session.meta["system"].endswith(prompt_section([example()]))
    search = session.meta["settings"]["example_search"]
    assert session.meta["settings"]["examples"] is True and search["engine"] == "jev"
    assert search["examples"] == ["60000-1/model"] and search["seconds"] == 1.5
    # The search is charged to the run and reported like a turn.
    first = session.meta["usage"][0]
    assert first["model"] == "jev-1.13.0" and first["estimated_cost_usd"] == "0.0042" and len(session.meta["usage"]) == 3
    turns = [data for kind, data in events if kind == "turn"]
    assert turns[0]["step"] == 0 and turns[0]["usage"] == first
    assert result.spent_usd == sum(Decimal(call["estimated_cost_usd"]) for call in session.meta["usage"])


def test_a_build_runs_without_examples_when_none_is_found_or_none_was_asked_for(tmp_path, monkeypatch):
    class Nothing(StubFinder):
        def find(self, request):
            return Retrieval(note="Jev was not used (x); examples were ranked by shared words; no example matched "
                                  "the request")

    result, client, session, _ = build(tmp_path / "none", "lean-v2", True, monkeypatch, Nothing)
    assert result.status == "published" and "# Example builds" not in session.meta["system"]
    assert session.meta["settings"]["example_search"]["engine"] == "none" and len(session.meta["usage"]) == 2
    assert "Jev was not used" in session.meta["settings"]["example_search"]["note"]

    # Off, or a first-version method: nothing is searched and nothing is added.
    class Never(StubFinder):
        def find(self, request):
            raise AssertionError("examples were searched although the build did not ask for them")

    for method, use_examples in (("lean-v2", False), ("lean", True)):
        _, client, session, _ = build(tmp_path / f"{method}-{use_examples}", method, use_examples, monkeypatch, Never)
        assert session.meta["settings"]["examples"] is False and "example_search" not in session.meta["settings"]
        assert "# Example builds" not in client.requests[0]["system"]


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
                       Limits(**{"least_parts": 4, "reference": False, **limits}))


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


def test_an_example_keeps_the_parts_its_set_uses_whether_or_not_they_are_stocked(tmp_path):
    from fable_agent.assembly import AssemblyReview
    from fable_agent.catalog import PartFinder
    from fable_agent.checks import ModelChecker
    from fable_agent.palette import load_palette
    from fable_agent_support import COLORS
    world = World(tmp_path, skip={("3001", color) for color in COLORS}, assembly=True)  # the 2 x 4 brick is not sold
    model = read_model(model_file(*hut_lines()))
    # Held to the catalog, the set loses its bricks and is not an example.
    assert importer(world, original_parts=False).convert(model) is None
    # As an example it keeps them: it is checked on an open palette, which is every check but the catalog.
    everything = load_palette(world.library, None, open_palette=True)
    checker = ModelChecker(world.library, world.shapes, everything, assembly=AssemblyReview(world.library, world.shapes))
    free = SetImporter(world.library, world.shapes, everything, PartFinder(world.library, everything), checker,
                       Limits(least_parts=4, reference=False))
    converted, reason = free.verdict(model)
    assert reason == "" and (converted.parts, converted.of) == (8, 8) and converted.script.count('"3001"') == 4
    assert Limits().original_parts is True


def test_each_section_of_a_file_can_be_an_example_and_a_reason_is_given_for_what_is_not_used(tmp_path):
    wing = [f"1 2 {x} 0 0 {ONE} 3020.dat" for x in (0, 80)] + [f"1 4 40 -24 0 {ONE} 3001.dat"] * 1
    text = (model_file(*hut_lines(), f"1 16 400 0 0 {ONE} wing.ldr", f"1 16 0 -100 0 {ONE} sticker.dat")
            + "\n".join(["0 FILE wing.ldr", "0 Wing of the hut", "0 Author: Someone Else [else]", LICENCE, *wing,
                          "0 FILE sticker.dat", "0 A custom sticker", LICENCE, f"1 16 0 0 0 {ONE} 3020.dat"]) + "\n")
    file = read_file(text)
    assert list(file.sections) == ["600 - hut.ldr", "wing.ldr", "sticker.dat"] and file.theme == "Town"
    whole, part = flatten(file), flatten(file, "wing.ldr")
    assert len(whole.parts) == 11 and whole.title == "Hut"  # the wing's parts, not the part defined in the file
    assert (part.title, part.author, len(part.parts)) == ("Wing of the hut", "Someone Else [else]", 3)
    assert flatten(file, "no such section") is None
    world = World(tmp_path, assembly=True)
    assert importer(world).verdict(part)[1] == "too few parts"
    assert importer(world, least_parts=3).verdict(part)[0].parts == 3
    assert importer(world).verdict(read_model(model_file(*hut_lines(lift=40))))[1] == \
        "too many parts overlap or are not joined"


def test_as_a_reference_a_model_keeps_what_the_checks_cannot_follow_and_says_whether_it_passes(tmp_path):
    world = World(tmp_path, assembly=True)
    floating = f"1 4 0 -200 0 {ONE} 3005.dat"  # held by nothing the checks can see
    reference = SetImporter(world.library, world.shapes, world.palette, world.finder, world.checker,
                            Limits(least_parts=4))
    assert Limits().reference is True
    kept, reason = reference.verdict(read_model(model_file(*hut_lines(), floating)))
    assert reason == "" and (kept.parts, kept.of) == (9, 9) and '"3005"' in kept.script and not kept.checked
    whole, _ = reference.verdict(read_model(model_file(*hut_lines())))
    assert whole.checked and whole.parts == 8
    # Held to the checks instead, the loose brick is dropped and what is left passes.
    strict = importer(world).verdict(read_model(model_file(*hut_lines(), floating)))[0]
    assert strict.parts == 8 and strict.checked
    # A model the checks cannot follow is shown as one, and the prompt says how to use it.
    marked = Example(Entry("1-1/model", "A hut", "model", "1-1", 9, len(kept.script), checked=False),
                     "test", "A", "CCAL", kept.script)
    assert "uses joints your report cannot verify" in prompt_section([marked])


def test_a_file_without_licence_lines_takes_the_licence_of_its_collection_and_only_a_reusable_one(tmp_path):
    bare = "\n".join(["0 FILE cottage.ldr", "0 Willow Porch Cottage", "0 Author: an atlas", *hut_lines()]) + "\n"
    assert flatten(read_file(bare)) is None  # nothing says it may be reused
    atlas = flatten(read_file(bare, licence="CC BY-SA 4.0 (examples by their author)"))
    assert atlas.licence.startswith("CC BY-SA 4.0") and atlas.title == "Willow Porch Cottage" and len(atlas.parts) == 8
    assert flatten(read_file(bare, licence="Free for non-commercial use.")) is None
