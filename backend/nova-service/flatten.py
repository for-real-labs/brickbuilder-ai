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


def contact_axes(occurrences, contacts, parts):
    """Carry the matched connector axes into the construction evidence.

    Nova's geometry JSON records feature IDs but omits frames. Read those exact
    features from the cached part geometry, including reviewed Technic ports,
    and transform their axes to world space. No new contacts are inferred.
    """
    from ldraw_tools.technic import definition, local_features, canonical

    features, result = {}, []
    for contact in contacts:
        if set(contact.get('kinds', [])) != {'stud', 'stud_receptacle'}:
            result.append(contact)
            continue
        axes = []
        for index, feature_id in zip(contact['instances'], contact['feature_ids']):
            occurrence = occurrences[index]
            code = occurrence.part_code.casefold()
            if code not in features:
                local = parts.geometry(code)
                ports = list(local.connections)
                entry = definition(local)
                if entry is not None:
                    ports.extend(local_features(canonical(code), entry))
                features[code] = {feature.feature_id: feature.axis for feature in ports}
            if feature_id not in features[code]:
                raise DisconnectedInstructions('Matched connector axis evidence is unavailable')
            axis = occurrence.matrix * features[code][feature_id]
            axes.append([float(axis.x), float(axis.y), float(axis.z)])
        result.append(dict(contact, axes=axes))
    return result


def stud_neighbors(occurrences, contacts):
    """Identify upright support/cover pairs with vertical matched connectors."""
    connection_neighbors(len(occurrences), contacts)
    above = [set() for _ in occurrences]
    below = [set() for _ in occurrences]

    def upright(occurrence):
        return all(math.isclose(occurrence.matrix.rows[row][1], value,
                                rel_tol=0, abs_tol=1e-6)
                   for row, value in enumerate((0, 1, 0)))

    for contact in contacts:
        kinds = contact.get('kinds')
        if kinds == ['stud', 'stud_receptacle']:
            lower, upper = contact['instances']
        elif kinds == ['stud_receptacle', 'stud']:
            upper, lower = contact['instances']
        else:
            continue
        axes = contact.get('axes')
        if axes is None or len(axes) != 2:
            raise DisconnectedInstructions('Matched connector axes are required for insertion review')
        if not all(len(axis) == 3 and all(math.isfinite(value) for value in axis) for axis in axes):
            raise DisconnectedInstructions('Invalid matched connector axes')
        if not all(math.isclose(axis[0], 0, abs_tol=1e-6)
                   and math.isclose(abs(axis[1]), 1, abs_tol=1e-6)
                   and math.isclose(axis[2], 0, abs_tol=1e-6) for axis in axes):
            continue
        if (upright(occurrences[lower]) and upright(occurrences[upper])
                and occurrences[lower].position.y > occurrences[upper].position.y + 1e-6):
            above[lower].add(upper)
            below[upper].add(lower)
    return above, below


def trapped_parts(index, placed, above, below):
    """Missing studded chains enclosed between index and an existing part."""
    def enclosed(direction):
        parents, found = {}, set()
        frontier = [index]
        while frontier:
            current = frontier.pop()
            for neighbor in direction[current]:
                if neighbor in placed:
                    if current != index:
                        found.add(current)
                else:
                    if neighbor not in parents:
                        parents[neighbor] = set()
                        frontier.append(neighbor)
                    if current != index:
                        parents[neighbor].add(current)
        frontier = list(found)
        while frontier:
            for parent in parents[frontier.pop()]:
                if parent not in found:
                    found.add(parent)
                    frontier.append(parent)
        return found
    return enclosed(above) | enclosed(below)


def connected_instruction_order(occurrences, contacts):
    """Grow an attached assembly without trapping an unplaced studded part.

    LDraw's positive Y points down, so start with the lowest part origin.
    Prefer lower placements, then authored order among safe attachments. A part
    can still attach from underneath a bridge while its lower support is absent. This checks upright
    stud sandwiches, not general insertion clearance or balance.
    """
    neighbors = connection_neighbors(len(occurrences), contacts)
    if not occurrences:
        raise DisconnectedInstructions('Missing physical placements')
    above, below = stud_neighbors(occurrences, contacts)
    seed = max(range(len(occurrences)), key=lambda i: (occurrences[i].position.y, -i))
    def priority(index):
        return (-float(occurrences[index].position.y), index)
    frontier, discovered, scheduled = [priority(seed)], {seed}, {seed}
    waiting = [set() for _ in occurrences]
    placed, order = set(), []
    while frontier:
        _, index = heapq.heappop(frontier)
        scheduled.remove(index)
        blockers = trapped_parts(index, placed, above, below)
        if blockers:
            for middle in blockers:
                waiting[middle].add(index)
            continue
        order.append(index)
        placed.add(index)
        for candidate in waiting[index]:
            if candidate not in placed and candidate not in scheduled:
                heapq.heappush(frontier, priority(candidate))
                scheduled.add(candidate)
        for neighbor in neighbors[index]:
            if neighbor not in discovered:
                discovered.add(neighbor)
                heapq.heappush(frontier, priority(neighbor))
                scheduled.add(neighbor)
    if len(order) != len(occurrences):
        raise DisconnectedInstructions('Remaining pieces are disconnected or require a blocked placement')
    return order


def verify_instruction_order(order, contacts, occurrences):
    """Independently check every prefix for attachment and trapped parts."""
    neighbors = connection_neighbors(len(order), contacts)
    if sorted(order) != list(range(len(order))) or len(occurrences) != len(order):
        raise ValueError('Instruction order must contain every physical placement exactly once')
    above, below = stud_neighbors(occurrences, contacts)
    placed = set()
    for index in order:
        if placed and not neighbors[index].intersection(placed):
            raise DisconnectedInstructions('Placement requires a later connection; repair the model')
        # Deliberately validate the prefix directly rather than trust the
        # planner's incremental blocked-candidate queue.
        if trapped_parts(index, placed, above, below):
            raise DisconnectedInstructions('Placement closes over an unplaced supported part; repair the sequence')
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
    physical, physical_parts = document.physical_context(original, parts)
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
        contacts = contact_axes(occurrences, geometry['contacts'], physical_parts)
        order = connected_instruction_order(occurrences, contacts)
        verify_instruction_order(order, contacts, occurrences)
        occurrences = [occurrences[index] for index in order]
    output.write_text(serialize_placements(original, occurrences, instructions=instructions), encoding='utf-8')


if __name__ == '__main__':
    try:
        main()
    except DisconnectedInstructions:
        # Fixed feedback only; no agent source or geometry report crosses the API.
        Path(sys.argv[2]).with_suffix('.error').write_text('Repair disconnected or blocked parts before opening instructions.')
        raise
