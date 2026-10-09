"""Serialize Nova occurrences, sharing the exact step mapping with build review."""
from __future__ import annotations

from pathlib import Path

MAX_INSTANCES = 100_000


def instruction_steps(occurrences):
    """Map authored hierarchy to the sequential steps shown by BrickBuilder."""
    previous, number, result = None, 0, []
    for occurrence in occurrences:
        path = occurrence.path
        depth = max((i for i, item in enumerate(path) if len(item.model.steps) > 1), default=0)
        key = (*[id(item.piece) for item in path[:depth]], id(path[depth].model), path[depth].local_step)
        if key != previous:
            number += 1
        result.append(number)
        previous = key
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
    physical, _ = document.physical_context(original, common.get_parts(library))
    output.write_text(serialize_placements(original, physical_occurrences(physical), instructions=instructions), encoding='utf-8')


if __name__ == '__main__':
    main()
