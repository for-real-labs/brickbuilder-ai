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
