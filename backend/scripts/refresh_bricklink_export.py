"""Build supplier-part aliases for XML export from Studio's StudioPartDefinition2.txt."""
import argparse
import csv
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def export_mappings(studio_parts: Path):
    data = ROOT / 'backend/src/data'
    with (data / 'brickwith_parts.csv').open() as source:
        ids = {row[key] for row in csv.DictReader(source) for key in ('part_id', 'studio_part_id') if row[key]}
    aliases = defaultdict(set)
    with studio_parts.open(encoding='utf-8-sig') as source:
        for row in csv.DictReader(source, delimiter='\t'):
            part = row['LDraw ItemNo'].lower().removesuffix('.dat')
            target = row['BL ItemNo'].lower()
            if part in ids and re.fullmatch('[a-z0-9][a-z0-9_-]*', target):
                aliases[part].add(target)
    with (data / 'inventory_colors.csv').open() as source:
        colors = {row['ldraw_id']: int(row['color_id']) for row in csv.DictReader(source) if row['system'] == 'bricklink'}
    output = ROOT / 'frontend/src/utils'
    for name, mapping in [('bricklinkColors', colors), ('bricklinkParts', {
            part: next(iter(matches)) for part, matches in aliases.items() if len(matches) == 1 and part not in matches})]:
        (output / f'{name}.json').write_text(json.dumps(mapping, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('studio_parts', type=Path)
    export_mappings(parser.parse_args().studio_parts)
