import importlib.util
from pathlib import Path
from types import SimpleNamespace
import pytest
spec = importlib.util.spec_from_file_location('flatten', Path(__file__).parents[1] / 'nova-service/flatten.py')
flatten = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flatten)
def edges(*pairs):
    return [{'instances': list(pair), 'status': 'confirmed'} for pair in pairs]


def placements(count, heights=None):
    model = SimpleNamespace(steps=[1])
    return [SimpleNamespace(position=SimpleNamespace(y=(heights or [0] * count)[index]),
                            matrix=SimpleNamespace(rows=[[1, 0, 0], [0, 1, 0], [0, 0, 1]]),
                            path=[SimpleNamespace(model=model, local_step=0, piece=object())])
            for index in range(count)]


def test_bridge_is_placed_before_the_piece_it_supports():
    parts = placements(3)
    contacts = edges((0, 2), (2, 1))
    order = flatten.connected_instruction_order(parts, contacts)
    assert order == [0, 2, 1]
    flatten.verify_instruction_order(order, contacts, parts)


def test_steps_are_capped_at_five_even_when_source_has_one_large_step():
    parts = placements(12)
    contacts = edges(*[(i, i + 1) for i in range(11)])
    assert flatten.connected_instruction_order(parts, contacts) == list(range(12))
    steps = flatten.instruction_steps(parts)
    assert steps == [1] * 5 + [2] * 5 + [3] * 2
    flatten.verify_instruction_order(list(range(12)), contacts, parts)


def test_start_from_low_foundation_and_preserve_authored_priority_when_possible():
    # Positive LDraw Y is down. Three available attachments retain their source order.
    assert flatten.connected_instruction_order(placements(4, [-24, -24, 0, -24]),
                                               edges((2, 0), (2, 1), (2, 3))) == [2, 0, 1, 3]


def test_upper_support_and_newly_unlocked_underside_have_separate_steps():
    # A lower piece becomes attachable only after an upper bridge is placed.
    parts = placements(4, [0, -8, -16, -8])
    order = flatten.connected_instruction_order(parts, edges((0, 1), (1, 2), (2, 3)))
    assert order == [0, 1, 2, 3]
    assert flatten.instruction_steps([parts[i] for i in order]) == [1, 2, 3, 4]


def test_insignificant_transform_roundoff_does_not_split_one_layer():
    assert flatten.instruction_steps(placements(2, [-8, -8.00000001])) == [1, 1]


@pytest.mark.parametrize('contacts', [[], edges((0, 1))])
def test_disconnected_parts_are_never_force_placed(contacts):
    with pytest.raises(flatten.DisconnectedInstructions) as error:
        flatten.connected_instruction_order(placements(3), contacts)
    assert error.value.remaining == ([1, 2] if not contacts else [2])


def test_planner_accepts_potential_contacts_but_rejects_incomplete_evidence():
    assert flatten.connected_instruction_order(placements(2),
        [{'instances': [0, 1], 'status': 'potential'}]) == [0, 1]
    with pytest.raises(ValueError, match='Incomplete connector evidence'):
        flatten.connected_instruction_order(placements(2), edges((0, 2)))


def test_exported_steps_distinguish_repeated_nested_subassemblies():
    root, child = SimpleNamespace(steps=[1, 2]), SimpleNamespace(steps=[1, 2])
    first, second = object(), object()
    def occurrence(piece, local_step):
        return SimpleNamespace(position=SimpleNamespace(y=0),
                               path=[SimpleNamespace(model=root, local_step=0, piece=piece),
                                     SimpleNamespace(model=child, local_step=local_step)])
    assert flatten.instruction_steps([occurrence(first, 0), occurrence(first, 1),
                                      occurrence(second, 0), occurrence(second, 1)]) == [1, 2, 3, 4]
    child.steps = [1]
    assert flatten.instruction_steps([occurrence(first, 0), occurrence(second, 0)]) == [1, 1]


@pytest.mark.parametrize('order', [[0, 1, 2], [0, 2, 2]])
def test_independent_verifier_rejects_floating_or_duplicate_placements(order):
    with pytest.raises(ValueError):
        flatten.verify_instruction_order(order, edges((0, 2), (2, 1)), placements(3))


def stud_edges(*pairs):
    return [dict(contact, kinds=['stud', 'stud_receptacle'], axes=[[0, -1, 0], [0, 1, 0]]) for contact in edges(*pairs)]


def planned_steps(parts, contacts):
    order = flatten.connected_instruction_order(parts, contacts)
    flatten.verify_instruction_order(order, contacts, parts)
    assemblies = flatten.instruction_assemblies(order, contacts, parts)
    return order, assemblies, flatten.instruction_steps([parts[i] for i in order], assemblies)


def test_chimney_corner_plate_stays_with_its_upper_support_across_authored_steps():
    parts = placements(3, [-96, -120, -96])
    parts[0].path[0].model.steps = [1, 2, 3]
    for index, part in enumerate(parts):
        part.path[0].local_step = index
    assert planned_steps(parts, stud_edges((0, 1), (2, 1))) == ([0, 1, 2], {1: 2}, [1, 2, 2])


def test_two_chimney_pairs_are_distinct_assemblies():
    parts = placements(5, [-96, -120, -96, -120, -96])
    assert planned_steps(parts, stud_edges((0, 1), (2, 1), (0, 3), (4, 3))) == (
        [0, 1, 2, 3, 4], {1: 2, 3: 2}, [1, 2, 2, 3, 3])


def test_several_hanging_pieces_share_one_step_and_the_next_piece_starts_a_new_step():
    parts = placements(5, [0, -24, -8, -8, -8])
    # The last piece has its own mounting connection to the earlier model.
    contacts = stud_edges((0, 1), (2, 1), (3, 1), (4, 1), (0, 4))
    assert planned_steps(parts, contacts) == ([0, 4, 1, 2, 3], {2: 3}, [1, 2, 3, 3, 3])
    # An ordinary piece after a group cannot be folded into it, even at the same height.
    assert flatten.instruction_steps(placements(4, [-24, 0, 0, 0]), {0: 2}) == [1, 1, 2, 2]


def test_dependent_assemblies_are_never_split_to_fit_the_five_piece_cap():
    parts = placements(7, [0, -24, -8, -8, -8, -8, -8])
    contacts = stud_edges((0, 1), *[(i, 1) for i in range(2, 7)])
    order, assemblies, steps = planned_steps(parts, contacts)
    assert assemblies == {} and max(steps.count(step) for step in steps) <= 5
    assert len(order) == 7
    assert planned_steps(parts[:-1], contacts[:-1])[1] == {1: 5}


@pytest.mark.parametrize('contact_index', [0, 1])
def test_sideways_connections_do_not_receive_assemble_first_guidance(contact_index):
    contacts = stud_edges((0, 1), (2, 1))
    contacts[contact_index]['axes'] = [[1, 0, 0], [-1, 0, 0]]
    assert planned_steps(placements(3, [0, -24, -8]), contacts)[1] == {}


def test_a_side_connection_to_the_existing_model_prevents_underside_grouping():
    contacts = stud_edges((0, 1), (2, 1)) + edges((0, 2))
    assert planned_steps(placements(3, [0, -24, -8]), contacts)[1] == {}


def test_unsupported_connector_kinds_and_inverted_parts_keep_separate_steps():
    parts = placements(3, [0, -24, -8])
    assert planned_steps(parts, edges((0, 1), (1, 2)))[1] == {}
    parts[2].matrix.rows = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]
    assert planned_steps(parts, stud_edges((0, 1), (2, 1)))[1] == {}


def test_export_marks_only_the_group_and_preserves_every_placement(monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, 'ldraw_tools.document', SimpleNamespace(section_table=lambda _: {}, is_part=lambda _: False))
    parts = placements(3, [-96, -120, -96])
    for index, part in enumerate(parts):
        part.position.x = part.position.z = 0
        part.colour = SimpleNamespace(code=15)
        part.reference = ['3001.dat', '5152.dat', '2420.dat'][index]
    _, assemblies, _ = planned_steps(parts, stud_edges((0, 1), (2, 1)))
    result = flatten.serialize_placements(None, parts, instructions=True, assemblies=assemblies)
    steps = result.split('0 STEP')
    assert result.count('0 !BRICKBUILDER BUILD_TOGETHER') == 1
    assert 'BUILD_TOGETHER' not in steps[0]
    assert 'BUILD_TOGETHER' in steps[1] and '5152.dat' in steps[1] and '2420.dat' in steps[1]
    assert sum(line.startswith('1 ') for line in result.splitlines()) == 3
    assert 'BUILD_TOGETHER' not in flatten.serialize_placements(None, parts, assemblies=assemblies)


def test_axle_mount_is_seated_before_a_cover_reachable_through_another_support():
    # Source: floor, side wall, cover, axle mount. Both supports sit on the floor.
    parts = placements(4, [0, -24, -48, -24])
    contacts = stud_edges((0, 1), (1, 2), (0, 3), (3, 2))
    order = flatten.connected_instruction_order(parts, contacts)
    assert order == [0, 1, 3, 2]
    flatten.verify_instruction_order(order, contacts, parts)
    with pytest.raises(flatten.DisconnectedInstructions, match='closes over'):
        flatten.verify_instruction_order([0, 1, 2, 3], contacts, parts)


def test_every_axle_mount_precedes_the_shared_cover_even_for_reversed_contacts():
    parts = placements(6, [0, -48, -24, -24, -24, -24])
    contacts = stud_edges(*[(0, i) for i in range(2, 6)], *[(i, 1) for i in range(2, 6)])
    contacts += [dict(instances=[1, 2], kinds=['stud_receptacle', 'stud'], status='potential',
                      axes=[[0, 1, 0], [0, -1, 0]])]
    order = flatten.connected_instruction_order(parts, contacts)
    assert order == [0, 2, 3, 4, 5, 1]
    flatten.verify_instruction_order(order, contacts, parts)


def test_hanging_underside_foot_can_follow_its_bridge_without_lower_support():
    parts = placements(3, [0, 0, -24])
    contacts = stud_edges((0, 2), (1, 2))
    assert flatten.connected_instruction_order(parts, contacts) == [0, 2, 1]


@pytest.mark.parametrize('matrix', [
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[1, 0, 0], [0, -1, 0], [0, 0, -1]],
])
def test_sideways_or_inverted_stud_contacts_do_not_infer_vertical_closure(matrix):
    parts = placements(4, [0, -24, -48, -24])
    parts[3].matrix.rows = matrix
    contacts = stud_edges((0, 1), (1, 2), (0, 3), (3, 2))
    flatten.verify_instruction_order([0, 1, 2, 3], contacts, parts)


def test_separate_support_can_follow_a_bridge_when_its_mount_is_inserted_first():
    parts = placements(5, [0, 0, -24, -24, -48])
    contacts = stud_edges((0, 2), (1, 3), (2, 4), (3, 4))
    order = flatten.connected_instruction_order(parts, contacts)
    assert order == [0, 2, 4, 3, 1]
    flatten.verify_instruction_order(order, contacts, parts)
    with pytest.raises(flatten.DisconnectedInstructions, match='closes over'):
        flatten.verify_instruction_order([0, 2, 4, 1, 3], contacts + edges((0, 1)), parts)


def test_cover_cannot_close_over_several_missing_layers():
    parts = placements(5, [0, -24, -72, -48, -24])
    contacts = stud_edges((0, 1), (1, 2), (0, 4), (4, 3), (3, 2))
    order = flatten.connected_instruction_order(parts, contacts)
    assert order == [0, 1, 4, 3, 2]
    flatten.verify_instruction_order(order, contacts, parts)
    with pytest.raises(flatten.DisconnectedInstructions, match='closes over'):
        flatten.verify_instruction_order([0, 1, 2, 4, 3], contacts, parts)


def test_upright_snot_parts_with_horizontal_studs_do_not_create_cover_constraints():
    parts = placements(4, [0, -24, -48, -24])
    contacts = stud_edges((0, 1), (1, 2), (0, 3), (3, 2))
    contacts[-1]['axes'] = [[1, 0, 0], [-1, 0, 0]]
    flatten.verify_instruction_order([0, 1, 2, 3], contacts, parts)
    contacts[-1]['axes'] = [[0, 0, 1], [0, 0, -1]]
    flatten.verify_instruction_order([0, 1, 2, 3], contacts, parts)


@pytest.mark.parametrize('axes', [None, [], [[0, 1, 0]], [[0, float('nan'), 0], [0, -1, 0]]])
def test_insertion_review_rejects_missing_or_invalid_connector_axes(axes):
    contact = dict(stud_edges((0, 1))[0], axes=axes)
    with pytest.raises(flatten.DisconnectedInstructions, match='connector axes'):
        flatten.connected_instruction_order(placements(2, [0, -24]), [contact])


def test_contact_axes_resolve_exact_feature_ids_and_transform_to_world(monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, 'ldraw_tools.technic', SimpleNamespace(
        definition=lambda local: None, local_features=lambda *args: [], canonical=lambda code: code))
    axis = SimpleNamespace(x=0, y=-1, z=0)
    class Rotation:
        def __mul__(self, vector):
            return SimpleNamespace(x=-vector.y, y=vector.x, z=vector.z)
    parts = SimpleNamespace(geometry=lambda code: SimpleNamespace(connections=[
        SimpleNamespace(feature_id='side-stud', axis=axis)]))
    occurrences = [SimpleNamespace(part_code='4070', matrix=Rotation())] * 2
    contact = dict(instances=[0, 1], kinds=['stud', 'stud_receptacle'],
                   feature_ids=['side-stud', 'side-stud'], status='confirmed')
    [result] = flatten.contact_axes(occurrences, [contact], parts)
    assert result['axes'] == [[1, 0, 0], [1, 0, 0]]
    assert 'axes' not in contact
    contact['feature_ids'][1] = 'missing-feature'
    with pytest.raises(flatten.DisconnectedInstructions, match='axis evidence'):
        flatten.contact_axes(occurrences, [contact], parts)


def test_baseplate_seats_separate_feet_before_their_bridge():
    parts = placements(3, [-8, -24, -8])
    contacts = stud_edges((0, 1), (2, 1))
    order = flatten.connected_instruction_order(parts, contacts, {0, 2})
    assert order == [0, 2, 1]
    flatten.verify_instruction_order(order, contacts, parts, {0, 2})
    with pytest.raises(flatten.DisconnectedInstructions, match='baseplate-supported'):
        flatten.verify_instruction_order([0, 1, 2], contacts, parts, {0, 2})


def test_baseplate_support_cannot_hide_a_disconnected_model():
    parts = placements(3, [-8, -24, -8])
    with pytest.raises(flatten.DisconnectedInstructions, match='disconnected'):
        flatten.connected_instruction_order(parts, stud_edges((0, 1)), {0, 2})
    with pytest.raises(flatten.DisconnectedInstructions, match='disconnected'):
        flatten.verify_instruction_order([0, 2, 1], stud_edges((0, 1)), parts, {0, 2})


def test_ground_first_still_places_axle_mounts_before_covers():
    parts = placements(5, [0, -24, -48, -24, 0])
    contacts = stud_edges((0, 1), (1, 2), (0, 3), (3, 2), (4, 3))
    order = flatten.connected_instruction_order(parts, contacts, {0, 4})
    assert order == [0, 4, 1, 3, 2]
    flatten.verify_instruction_order(order, contacts, parts, {0, 4})


class GroundVector:
    def __init__(self, x=0, y=0, z=0):
        self.x, self.y, self.z = x, y, z

    def __add__(self, other):
        return GroundVector(self.x + other.x, self.y + other.y, self.z + other.z)


class GroundMatrix:
    def __init__(self, inverted=False):
        self.rows = [[1, 0, 0], [0, -1 if inverted else 1, 0], [0, 0, 1]]

    def __mul__(self, vector):
        return GroundVector(vector.x, self.rows[1][1] * vector.y, vector.z)


def ground_occurrence(code, y=0, x=10, inverted=False):
    return SimpleNamespace(part_code=code, position=GroundVector(x, y, 10), matrix=GroundMatrix(inverted))


def ground_library():
    def part(code):
        # Real LDraw plate/brick receivers sit 8/24 LDU below their origins.
        height = {'plate': 8, 'brick': 24, 'wheel': 0}[code]
        return SimpleNamespace(connections=[] if code == 'wheel' else [SimpleNamespace(
            kind='stud_receptacle', occupied=False, position=GroundVector(0, height, 0),
            axis=GroundVector(0, -1, 0))])
    return SimpleNamespace(geometry=part)


def test_foundation_uses_receiver_height_not_origin_and_accepts_translated_grid():
    parts = [ground_occurrence('plate', -8), ground_occurrence('brick', -24, 30),
             ground_occurrence('plate', -16, 50), ground_occurrence('plate', -8, 15),
             ground_occurrence('plate', 8, 70, inverted=True)]
    assert flatten.baseplate_foundation(parts, {'bounds': {'max': [100, 0, 100]}}, ground_library()) == {0, 1}


def test_wheels_set_ground_below_chassis_so_car_keeps_connected_build_order():
    parts = [ground_occurrence('wheel', 0), ground_occurrence('plate', -8)]
    # Tire bottom at y=16; the chassis underside at y=0 is not a foundation.
    foundation = flatten.baseplate_foundation(parts, {'bounds': {'max': [100, 16, 100]}}, ground_library())
    assert foundation == set()
    assert flatten.connected_instruction_order(placements(3, [0, 0, -24]),
                                               stud_edges((0, 2), (1, 2)), foundation) == [0, 2, 1]


@pytest.mark.parametrize('code', ['assembly.body_overlap', 'assembly.duplicate', 'geometry.incomplete'])
def test_validation_errors_cannot_be_published_as_warnings(tmp_path, code):
    output = tmp_path / 'instructions.ldr'
    with pytest.raises(flatten.DisconnectedInstructions, match='Validation errors'):
        flatten.require_valid_geometry([{'code': code, 'severity': 'error'}], output)
    import json
    assert json.loads(output.with_suffix('.review.json').read_text())['diagnostics'][0]['code'] == code
    assert not output.exists()


def test_coverage_warnings_do_not_claim_or_require_full_material_proof(tmp_path):
    flatten.require_valid_geometry([{'code': 'coverage.collision_review', 'severity': 'warning'}], tmp_path / 'instructions.ldr')
