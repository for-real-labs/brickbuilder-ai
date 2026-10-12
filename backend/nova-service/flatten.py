"""Serialize Nova occurrences, sharing the exact step mapping with build review."""
from __future__ import annotations

import heapq
import math
import sys
from pathlib import Path

MAX_INSTANCES = 100_000
MAX_PARTS_PER_STEP = 5


class DisconnectedInstructions(ValueError):
    """No connected placement sequence exists for the supplied graph."""


def connection_neighbors(count, contacts):
    neighbors = [set() for _ in range(count)]
    for contact in contacts:
        a, b = contact['instances']
        if (type(a) is not int or type(b) is not int or not 0 <= a < count
                or not 0 <= b < count or contact['status'] not in ('confirmed', 'potential')):
            raise DisconnectedInstructions('Incomplete connector evidence')
        if a != b:
            neighbors[a].add(b)
            neighbors[b].add(a)
    return neighbors


def connected_instruction_order(occurrences, contacts):
    """Grow one assembly, preferring authored order among available placements.

    LDraw's positive Y points down, so start with the lowest part origin.
    Connector evidence proves attachment, not balance or insertion clearance.
    """
    neighbors = connection_neighbors(len(occurrences), contacts)
    if not occurrences:
        raise DisconnectedInstructions('Missing physical placements')
    seed = max(range(len(occurrences)), key=lambda i: (occurrences[i].position.y, -i))
    frontier, discovered, order = [seed], {seed}, []
    while frontier:
        index = heapq.heappop(frontier)
        order.append(index)
        for neighbor in neighbors[index]:
            if neighbor not in discovered:
                discovered.add(neighbor)
                heapq.heappush(frontier, neighbor)
    if len(order) != len(occurrences):
        raise DisconnectedInstructions('Remaining pieces have no connection to the assembly')
    return order


def verify_instruction_order(order, contacts):
    """Independently check every prefix before serializing reordered placements."""
    neighbors = connection_neighbors(len(order), contacts)
    if sorted(order) != list(range(len(order))):
        raise ValueError('Instruction order must contain every physical placement exactly once')
    placed = set()
    for index in order:
        if placed and not neighbors[index].intersection(placed):
            raise DisconnectedInstructions('Placement requires a later connection; repair the model')
        placed.add(index)


def instruction_steps(occurrences):
    """Keep authored boundaries, cap size, and separate upper/underside placements."""
    previous, previous_height, number, result, count = None, None, 0, [], 0
    for occurrence in occurrences:
        path = occurrence.path
        depth = max((i for i, item in enumerate(path) if len(item.model.steps) > 1), default=0)
        key = (*[id(item.piece) for item in path[:depth]], id(path[depth].model), path[depth].local_step)
        height = float(occurrence.position.y)
        height_changed = previous_height is not None and not math.isclose(
            height, previous_height, rel_tol=0, abs_tol=1e-6)
        if key != previous or count == MAX_PARTS_PER_STEP or height_changed:
            number += 1
            count = 0
        result.append(number)
        count += 1
        previous = key
        previous_height = height
    return result


def serialize_placements(original, occurrences, *, instructions=False):
    from ldraw_tools.document import section_table, is_part

    lines = ['0 BrickBuilder construction export from LDraw Nova' if instructions else
             '0 BrickBuilder display export from LDraw Nova', '0 Name: model.ldr']
    steps = instruction_steps(occurrences) if instructions else [1] * len(occurrences)
    previous = None
    for occurrence, step in zip(occurrences, steps):
        if instructions and previous is not None and step != previous:
            lines.append('0 STEP')
        previous = step
        p = occurrence.position
        values = [p.x, p.y, p.z, *(number for row in occurrence.matrix.rows for number in row)]
        transform = ' '.join(format(float(number), '.12g') for number in values)
        lines.append(f'1 {occurrence.colour.code} {transform} {occurrence.reference}')
    if instructions and previous is not None:
        lines.append('0 STEP')
    parts = [section for section in section_table(original).values() if is_part(section)]
    if parts:
        lines.insert(0, '0 FILE model.ldr')
        for section in parts:
            lines.append('0 FILE ' + section.name)
            lines.extend(str(obj) for obj in section.objects)
    return '\n'.join(lines) + '\n'


def physical_occurrences(physical):
    occurrences = []
    for occurrence in physical.iter_occurrences():
        if len(occurrences) >= MAX_INSTANCES:
            raise ValueError('Nova model exceeds the display export placement limit')
        occurrences.append(occurrence)
    return occurrences


def main():
    import sys
    import ldraw_tools.common as common
    import ldraw_tools.document as document

    instructions = '--instructions' in sys.argv
    source, output, library = map(Path, [arg for arg in sys.argv[1:] if arg != '--instructions'])
    common.CACHE = document.CACHE = output.parent / 'cache'
    original = document.parse_source(source)
    parts = common.get_parts(library)
    physical, _ = document.physical_context(original, parts)
    occurrences = physical_occurrences(physical)
    if instructions:
        from ldraw_tools.geometry import analyze_geometry
        geometry = analyze_geometry(original, parts, contacts='all', detail='full',
                                    output_limit=MAX_INSTANCES, pair_limit=20, instance_limit=MAX_INSTANCES)
        if (geometry['complete'] is not True or geometry['contacts_checked'] is not True
                or geometry['contacts_truncated'] or geometry['instances_truncated']
                or geometry['occurrence_count'] != len(occurrences)
                or geometry['contact_count'] != len(geometry['contacts'])):
            raise DisconnectedInstructions('Complete connector evidence is required to order instructions')
        order = connected_instruction_order(occurrences, geometry['contacts'])
        verify_instruction_order(order, geometry['contacts'])
        occurrences = [occurrences[index] for index in order]
    output.write_text(serialize_placements(original, occurrences, instructions=instructions), encoding='utf-8')


if __name__ == '__main__':
    try:
        main()
    except DisconnectedInstructions:
        # Fixed feedback only; no agent source or geometry report crosses the API.
        Path(sys.argv[2]).with_suffix('.error').write_text('Repair disconnected parts before opening instructions.')
        raise
