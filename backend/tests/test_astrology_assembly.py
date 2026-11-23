import pytest
from src.astrology.assembly import assemble, connected_groups
from src.astrology.design import read_design
from src.astrology.parts import SHAPES, Piece
from src.utils.imported_kit import fulfillment_csv
from src.utils.parts_catalog import flat_model_inventory, parts_csv_inventory
from src.utils.supplier_catalog import get_supplier_catalog


@pytest.fixture(scope="module")
def catalog():
    return get_supplier_catalog()


def test_courses_bridge_and_inventory_matches_serialized_placements(catalog):
    model = assemble(
        {"lawn": "box 288 0 0 0 17 2 11", "tower": "shell 19 3 2 1 5 9 5"}, catalog, 120
    )
    assert model.issues == []
    assert flat_model_inventory(model.ldraw()) == model.inventory
    assert parts_csv_inventory(fulfillment_csv(model.inventory)) == model.inventory
    assert model.ldraw().count("0 STEP\n") == (len(model.pieces) - 1) // 5
    for i in range(1, len(model.pieces)):
        assert len(connected_groups(model.pieces[: i + 1])) == 1


@pytest.mark.parametrize("ridge", ["x", "z"])
@pytest.mark.parametrize("pitch", ["steep", "shallow", "gambrel"])
def test_slopes_face_inward_and_roof_is_connected(ridge, pitch, catalog):
    model = assemble({"roof": f"roof 72 0 0 0 11 12 {ridge} {pitch} 19"}, catalog, 240)
    assert model.issues == []
    slopes = [p for p in model.pieces if p.shape.top == "slope"]
    assert {p.turn for p in slopes} == ({0, 2} if ridge == "x" else {1, 3})
    for slope in slopes:
        origin = slope.ldraw().split()[2:5]
        studs = list(slope.studs())
        assert float(origin[0]) == sum(x * 20 for x, _ in studs) / len(studs)
        assert float(origin[2]) == sum(z * 20 for _, z in studs) / len(studs)


def test_detail_carves_solids_and_rotates_at_its_corner(catalog):
    scene = read_design({"wall": "box 15 0 0 0 1 6 2\npart 60592 15 0 0 0 1"}, catalog)
    assert not scene.cells
    assert scene.fixed[0].ldraw() == "1 15 0 -48 10 0 0 1 0 1 0 -1 0 0 60592.dat"
    slope = Piece(SHAPES["3039"], 72, 2, 0, 3, 2)
    assert set(slope.studs()) == {(2, 3), (3, 3)}
    assert set(slope.sockets()) == {(2, 3), (3, 3), (2, 4), (3, 4)}


def test_nonsquare_profiles_orient_and_carve(catalog):
    scene = read_design(
        {
            "front": "profile 4 1 0 2 front 2 .#/##",
            "top": "profile -1 1 0 2 top 2 .#/#.",
            "side": "profile 2 3 0 2 side 1 .#/##",
        },
        catalog,
    )
    assert scene.cells == {
        (1, 0, 2): 4,
        (2, 0, 3): 4,
        (2, 1, 3): 4,
        (3, 0, 2): 2,
        (3, 0, 3): 2,
        (3, 1, 3): 2,
    }


def test_support_requires_an_actual_stud_and_reports_both_locations_and_limit(catalog):
    model = assemble({"top": "part 3069b 0 0 0 0 0\nbox 4 0 1 0 2 3 1"}, catalog, 1)
    assert "exceed the limit" in model.issues[0]
    assert "disconnected stud groups" in model.issues[1]
    assert len(connected_groups(model.pieces)) == 2
    model = assemble({"edge": "box 4 0 0 0 1 3 1\nbox 15 1 0 0 1 3 1"}, catalog, 20)
    assert model.issues


@pytest.mark.parametrize(
    ("program", "message"),
    [
        ("box 15 0 -1 0 2 2 2", "dimensions"),
        ("part 3039 16 0 0 0 0", "unavailable"),
        ("part ../3001 0 0 0 0 0", "Unknown geometry"),
        ("repeat 2 1 0 0 part 3633 15 0 0 0 0", "Overlapping"),
        ("repeat 2 1 0 0 repeat 2 1 0 0 box 0 0 0 0 1 1 1", "single command"),
        ("repeat 64 0 0 0 box 15 0 0 0 60 30 40", "work limit"),
        ("profile 0 0 0 0 front 4 #/##", "equal rows"),
        ("part 3005 0 0 0 0 5", "quarter turn"),
    ],
)
def test_bad_commands_are_actionable_and_bounded(program, message, catalog):
    with pytest.raises(ValueError, match=message):
        assemble({"subject": program}, catalog, 500)
