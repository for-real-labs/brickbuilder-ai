"""Serialize Nova's physical occurrences for BrickBuilder's flat-parts consumers.

Design, expansion, part classification and transforms all come from Nova.
The original hierarchical MPD remains the canonical downloadable model.
"""
import sys
from pathlib import Path
from ldraw_tools.common import get_parts
from ldraw_tools.document import parse_source, physical_context, section_table, is_part

instructions = '--instructions' in sys.argv
source, output, library = map(Path, [arg for arg in sys.argv[1:] if arg != '--instructions'])
if instructions:
    import ldraw_tools.common as common
    import ldraw_tools.document as document
    common.CACHE = document.CACHE = output.parent / 'cache'
original = parse_source(source)
physical, _ = physical_context(original, get_parts(library))
lines = ['0 BrickBuilder construction export from LDraw Nova' if instructions else '0 BrickBuilder display export from LDraw Nova', '0 Name: model.ldr']
previous_step = None
for index, occurrence in enumerate(physical.iter_occurrences()):
    if index >= 100_000:
        raise ValueError('Nova model exceeds the display export placement limit')
    if instructions:
        # Nova's parser owns hierarchy, source steps, placement transforms and
        # inherited colors. Single-step child assemblies belong to the parent
        # step; multi-step subassemblies retain their construction sequence.
        path = occurrence.path
        depth = max((i for i, item in enumerate(path) if len(item.model.steps) > 1), default=0)
        step = (*[id(item.piece) for item in path[:depth]], id(path[depth].model), path[depth].local_step)
        if previous_step is not None and step != previous_step:
            lines.append('0 STEP')
        previous_step = step
    p = occurrence.position
    values = [p.x, p.y, p.z, *(number for row in occurrence.matrix.rows for number in row)]
    transform = ' '.join(format(float(number), '.12g') for number in values)
    lines.append(f'1 {occurrence.colour.code} {transform} {occurrence.reference}')
if instructions and previous_step is not None:
    lines.append('0 STEP')
# Retain embedded physical DAT definitions, including their attribution.
parts = [section for section in section_table(original).values() if is_part(section)]
if parts:
    lines.insert(0, '0 FILE model.ldr')
    for section in parts:
        lines.append('0 FILE ' + section.name)
        lines.extend(str(obj) for obj in section.objects)
output.write_text('\n'.join(lines) + '\n', encoding='utf-8')
