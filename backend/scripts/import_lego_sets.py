"""Import Rebrickable's public CSV snapshot into BrickBuilder's set catalog.

python backend/scripts/import_lego_sets.py --output /tmp/lego-sets.jsonl
python backend/scripts/import_lego_sets.py --upload /tmp/lego-sets.jsonl --env-file backend/.env

Uses official downloads, not scraped/generated inventories. Apply the catalog
migration first. Re-running replaces only matching catalog rows; no user data.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

FILES = ('sets', 'inventories', 'inventory_parts', 'inventory_sets', 'inventory_minifigs')
SOURCE = 'https://rebrickable.com/downloads/'


def download(name: str, cache: Path):
    path = cache / f'{name}.csv.gz'
    if not path.exists():
        url = f'https://cdn.rebrickable.com/media/downloads/{name}.csv.gz'
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read(64 * 1024 * 1024 + 1)
        if len(data) > 64 * 1024 * 1024:
            raise ValueError(f'{name} exceeds download limit')
        path.write_bytes(data)
    return path


def read_rows(path):
    with gzip.open(path, 'rt', encoding='utf-8-sig', newline='') as source:
        yield from csv.DictReader(source)


def build_catalog(files: dict[str, Path], imported_at: str):
    latest = {}
    for row in read_rows(files['inventories']):
        version = int(row['version'])
        if version > latest.get(row['set_num'], (0, 0))[0]:
            latest[row['set_num']] = (version, int(row['id']))
    selected = {value[1] for value in latest.values()}
    parts, children = defaultdict(Counter), defaultdict(list)
    for row in read_rows(files['inventory_parts']):
        inv = int(row['inventory_id'])
        if inv in selected and row['is_spare'].lower() == 'false':
            quantity = int(row['quantity'])
            if quantity <= 0:
                raise ValueError('Invalid source quantity')
            parts[inv][(row['part_num'], int(row['color_id']))] += quantity
    for name, column in [('inventory_sets', 'set_num'), ('inventory_minifigs', 'fig_num')]:
        for row in read_rows(files[name]):
            inv = int(row['inventory_id'])
            if inv in selected:
                quantity = int(row['quantity'])
                if quantity <= 0:
                    raise ValueError('Invalid nested inventory quantity')
                children[inv].append((row[column], quantity))
    memo = {}
    def expand(number, active=frozenset()):
        if number in memo:
            return memo[number]
        if number in active or len(active) > 32 or number not in latest:
            raise ValueError('Incomplete or recursive source inventory')
        inv = latest[number][1]
        result = parts[inv].copy()
        for child, multiplier in children[inv]:
            for pair, count in expand(child, active | {number}).items():
                result[pair] += count * multiplier
        if sum(result.values()) > 100_000 or len(result) > 10_000:
            raise ValueError('Set inventory exceeds supported limits')
        memo[number] = result
        return result
    for row in read_rows(files['sets']):
        try:
            inventory = expand(row['set_num'])
        except ValueError:
            continue  # Missing nested inventories never become partial "complete" sets.
        if not inventory:
            continue
        yield {'set_num': row['set_num'], 'name': row['name'], 'year': int(row['year']),
            'num_parts': sum(inventory.values()),
            'inventory': [[part, color, quantity] for (part, color), quantity in sorted(inventory.items())],
            'search_text': f"{row['set_num']} {row['name']}".casefold(),
            'imported_at': imported_at, 'source_url': SOURCE}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--cache', type=Path, default=Path('/tmp/brickbuilder-rebrickable'))
    parser.add_argument('--upload', type=Path)
    parser.add_argument('--env-file', type=Path)
    args = parser.parse_args()
    if args.output:
        args.cache.mkdir(parents=True, exist_ok=True)
        files = {}
        for name in FILES:
            files[name] = download(name, args.cache)
            print(f'Downloaded {name}', flush=True)
        timestamp = datetime.now(timezone.utc).isoformat()
        count = 0
        with args.output.open('w') as output:
            for row in build_catalog(files, timestamp):
                output.write(json.dumps(row, separators=(',', ':')) + '\n')
                count += 1
        metadata = {'source_url': SOURCE, 'imported_at': timestamp, 'sets': count,
            'files_sha256': {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}}
        args.output.with_suffix('.metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
        print(f'Prepared {count} complete set inventories', flush=True)
    if args.upload:
        import os
        from dotenv import load_dotenv
        import httpx
        import time
        if args.env_file:
            load_dotenv(args.env_file)
        client = httpx.Client(base_url=os.environ['SUPABASE_URL'].rstrip('/') + '/rest/v1/',
            headers={'apikey': os.environ['SUPABASE_SERVICE_ROLE_KEY'],
                     'Prefer': 'resolution=merge-duplicates,return=minimal'}, timeout=120, http2=False)
        def upload_batch(batch):
            for attempt in range(3):
                try:
                    response = client.post('lego_set_catalog', params={'on_conflict': 'set_num'}, json=batch)
                    response.raise_for_status()
                    return
                except httpx.TransportError:
                    if attempt == 2:
                        raise
                    time.sleep(attempt + 1)
        total, batch = 0, []
        with args.upload.open() as source:
            for line in source:
                batch.append(json.loads(line))
                if len(batch) == 100:
                    upload_batch(batch)
                    total += len(batch)
                    batch = []
                    if total % 2000 == 0:
                        print(f'Imported {total} sets', flush=True)
        if batch:
            upload_batch(batch)
            total += len(batch)
        client.close()
        print(f'Imported {total} sets into Supabase', flush=True)
    if not args.output and not args.upload:
        parser.error('Choose --output and/or --upload')


if __name__ == '__main__':
    main()
