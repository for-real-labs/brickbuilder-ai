"""Build exact color cross-references from canonical Studio and Rebrickable names.

Only Studio's original (`o`) color entries are used; special render/rubber/legacy
aliases must not introduce ambiguity. Names match exactly after removing punctuation
and spaces; there is no fuzzy matching or nearest-RGB fallback.
"""
import argparse
import csv
import gzip
import hashlib
import io
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


def cross_references(studio_rows, rebrickable_rows, ldraw_text):
    names, bricklink = defaultdict(set), defaultdict(set)
    normalize = lambda value: re.sub(r'[^a-z0-9]', '', value.casefold())
    official = defaultdict(set)
    for name, code in re.findall(r'^0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)\b', ldraw_text, re.MULTILINE):
        official[normalize(name)].add(int(code))
    official_codes = {code for values in official.values() for code in values}
    for row in studio_rows:
        if ('o' not in row['note'].split(',') or not row['LDraw Color Code'].isdigit()
                or not row['BL Color Code'].isdigit()):
            continue
        # Resolve the canonical name against the official library; Studio may
        # still list provisional codes for recently standardized colors.
        declared = int(row['LDraw Color Code'])
        matches = official[normalize(row['LDraw Color Name'])]
        if declared in official_codes:
            color = declared
        elif len(matches) == 1:
            color = next(iter(matches))
        else:
            continue
        if color in {16, 24}:
            continue
        bricklink[int(row['BL Color Code'])].add((color, row['BL Color Name']))
        for field in ('BL Color Name', 'LDraw Color Name'):
            if row[field]:
                names[normalize(row[field])].add(color)
    for color, matches in sorted(bricklink.items()):
        if len(matches) == 1:
            ldraw, name = next(iter(matches))
            yield {'system': 'bricklink', 'color_id': color, 'ldraw_id': ldraw, 'name': name}
    for row in rebrickable_rows:
        matches = names[normalize(row['name'])]
        if len(matches) == 1 and int(row['id']) >= 0:
            yield {'system': 'rebrickable', 'color_id': int(row['id']), 'ldraw_id': next(iter(matches)), 'name': row['name']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--studio-colors', type=Path, required=True)
    parser.add_argument('--ldraw-colors', type=Path, required=True, help='Official LDConfig.ldr')
    parser.add_argument('--rebrickable-colors', type=Path, required=True, help='Official colors.csv.gz download')
    args = parser.parse_args()
    source = args.studio_colors.read_bytes()
    rb = args.rebrickable_colors.read_bytes()
    rows = list(cross_references(csv.DictReader(io.StringIO(source.decode('utf-8-sig')), delimiter='\t'),
        csv.DictReader(io.StringIO(gzip.decompress(rb).decode('utf-8-sig'))), args.ldraw_colors.read_text()))
    if len(rows) < 250:
        raise ValueError('Incomplete color references')
    target = Path(__file__).resolve().parents[1] / 'src/data/inventory_colors.csv'
    with target.open('w', newline='') as output:
        writer = csv.DictWriter(output, fieldnames=['system', 'color_id', 'ldraw_id', 'name'], lineterminator='\n')
        writer.writeheader(); writer.writerows(rows)
    target.with_suffix('.metadata.json').write_text(json.dumps({
        'generated_at': datetime.now(timezone.utc).isoformat(), 'entries': len(rows),
        'sources': ['https://rebrickable.com/downloads/', 'https://www.bricklink.com/v3/studio/download.page', 'https://www.ldraw.org/article/547.html'],
        'ldraw_colors_sha256': hashlib.sha256(args.ldraw_colors.read_bytes()).hexdigest(),
        'studio_colors_sha256': hashlib.sha256(source).hexdigest(),
        'rebrickable_colors_sha256': hashlib.sha256(rb).hexdigest(),
        'matching': 'Exact canonical color names resolved against official LDConfig; original Studio entries only; no RGB approximation',
    }, indent=2) + '\n')
    print(f'Wrote {len(rows)} exact color mappings')


if __name__ == '__main__':
    main()
