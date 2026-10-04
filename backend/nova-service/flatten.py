"""Serialize Nova's physical occurrences for BrickBuilder's flat-parts consumers.

Design, expansion, part classification and transforms all come from Nova.
The original hierarchical MPD remains the canonical downloadable model.
"""
import sys
from pathlib import Path
from ldraw_tools.common import get_parts
from ldraw_tools.document import parse_source, physical_context, section_table, is_part

source, output, library = map(Path, sys.argv[1:])
original = parse_source(source)
physical, _ = physical_context(original, get_parts(library))
lines = ['0 BrickBuilder display export from LDraw Nova', '0 Name: model.ldr']
for index, occurrence in enumerate(physical.iter_occurrences()):
    if index >= 100_000:
        raise ValueError('Nova model exceeds the display export placement limit')
    p = occurrence.position
    values = [p.x, p.y, p.z, *(number for row in occurrence.matrix.rows for number in row)]
    transform = ' '.join(format(float(number), '.12g') for number in values)
    lines.append(f'1 {occurrence.colour.code} {transform} {occurrence.reference}')
# Retain embedded physical DAT definitions, including their attribution.
parts = [section for section in section_table(original).values() if is_part(section)]
if parts:
    lines.insert(0, '0 FILE model.ldr')
    for section in parts:
        lines.append('0 FILE ' + section.name)
        lines.extend(str(obj) for obj in section.objects)
output.write_text('\n'.join(lines) + '\n', encoding='utf-8')
