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
                            path=[SimpleNamespace(model=model, local_step=0, piece=object())])
            for index in range(count)]


def test_bridge_is_placed_before_the_piece_it_supports():
    parts = placements(3)
    contacts = edges((0, 2), (2, 1))
    order = flatten.connected_instruction_order(parts, contacts)
    assert order == [0, 2, 1]
    flatten.verify_instruction_order(order, contacts)


def test_steps_are_capped_at_five_even_when_source_has_one_large_step():
    parts = placements(12)
    contacts = edges(*[(i, i + 1) for i in range(11)])
    assert flatten.connected_instruction_order(parts, contacts) == list(range(12))
    steps = flatten.instruction_steps(parts)
    assert steps == [1] * 5 + [2] * 5 + [3] * 2
    flatten.verify_instruction_order(list(range(12)), contacts)


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
    with pytest.raises(flatten.DisconnectedInstructions):
        flatten.connected_instruction_order(placements(3), contacts)


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
        flatten.verify_instruction_order(order, edges((0, 2), (2, 1)))
