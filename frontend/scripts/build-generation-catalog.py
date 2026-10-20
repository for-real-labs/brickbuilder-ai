"""Pack renderable Brickwith catalog parts for anonymous, cacheable generation previews.
Run with: python3 frontend/scripts/build-generation-catalog.py ~/ldraw
"""
import csv
import gzip
import importlib.util
import io
import json
import re
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('packer', root / 'backend/src/utils/pack_ldraw_model.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
library = Path(sys.argv[1]).expanduser()
output = root / 'frontend/public/assets/generation-parts'
output.mkdir(parents=True, exist_ok=True)
for license_file in ['CAreadme.txt', 'CAlicense.txt', 'CAlicense4.txt']:
    (output / license_file).write_text('\n'.join(line.rstrip() for line in (library / license_file).read_text().splitlines()).rstrip() + '\n')
parts = {}
with (root / 'backend/src/data/brickwith_parts.csv').open() as source:
    for row in csv.DictReader(source):
        part = row['part_id'].lower()
        if not re.fullmatch(r'[a-z0-9_-]+', part) or not row['color_id'].isdigit():
            continue
        entry = parts.setdefault(part, {'id': part, 'colors': [], 'name': row['name']})
        color = int(row['color_id'])
        if color not in entry['colors']:
            entry['colors'].append(color)
catalog = []
with tempfile.TemporaryDirectory() as directory:
    for part, entry in sorted(parts.items()):
        if not (library / 'parts' / (part + '.dat')).is_file():
            continue
        source = Path(directory) / 'piece.ldr'
        source.write_text(f'1 16 0 0 0 1 0 0 0 1 0 0 0 1 {part}.dat\n')
        packer = module.LDrawPacker(str(library))
        with redirect_stdout(io.StringIO()):
            packed = Path(packer.pack_ldraw_model(str(source)))
        if packer.list_of_not_found:
            continue
        (output / f'{part}.mpd.gz').write_bytes(gzip.compress(packed.read_bytes(), mtime=0))
        catalog.append(entry)
(output / 'catalog.json').write_text(json.dumps(catalog, separators=(',', ':')) + '\n')
print(f'Packed {len(catalog)} of {len(parts)} catalog parts with complete LDraw geometry')
