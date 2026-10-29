"""Read the imported Rebrickable set catalog; never invent inventory entries."""
from __future__ import annotations

import os
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path

from .parts_inventory import PartsInventory, InventoryPart, mapped_color
from .parts_catalog import normalize_part_id

CATALOG_TABLE = 'lego_set_catalog'
SOURCE_URL = 'https://rebrickable.com/downloads/'


def search_sets(client, query: str) -> list[dict]:
    words = re.findall(r'[\w-]+', query.casefold(), flags=re.UNICODE)
    if not words:
        return []
    # Escape LIKE metacharacters; punctuation never enters PostgREST expressions.
    pattern = '%' + '%'.join(word.replace('_', r'\_') for word in words) + '%'
    return client.table(CATALOG_TABLE).select('set_num,name,year,num_parts').ilike(
        'search_text', pattern).order('year', desc=True).limit(20).execute().data


@lru_cache(maxsize=1)
def ldraw_part_ids() -> frozenset[str]:
    roots = [Path(os.environ['LDRAW_DIR'])] if os.getenv('LDRAW_DIR') else [Path.home() / 'ldraw', Path('/usr/share/ldraw')]
    root = next((path for path in roots if (path / 'parts').is_dir()), None)
    if root is None:
        raise ValueError('The parts library is unavailable. Please try again later.')
    return frozenset(path.stem.lower() for path in (Path(root) / 'parts').glob('*.dat'))


def set_inventory(row: dict, *, known_parts: frozenset[str] | None = None) -> dict:
    known_parts = ldraw_part_ids() if known_parts is None else known_parts
    counts, unavailable = Counter(), []
    for entry in row['inventory']:
        part, color, quantity = entry
        try:
            part = normalize_part_id(part)
            color = mapped_color(color, 'rebrickable')
            if part not in known_parts:
                raise ValueError('No exact part ID in the LDraw library')
        except ValueError:
            unavailable.append({'part_id': entry[0], 'color_id': entry[1], 'quantity': quantity})
            continue
        counts[(part, color)] += quantity
    if not counts:
        raise ValueError('This set has no parts Nova can identify exactly. Export its inventory as LDraw and upload it instead.')
    inventory = PartsInventory(name=f"{row['name']} ({row['set_num']})"[:200], source='set',
        parts=[InventoryPart(part_id=p, color_id=c, quantity=q) for (p, c), q in counts.items()])
    return {'inventory': inventory.model_dump(), 'unavailable': unavailable,
            'source_url': f"https://rebrickable.com/sets/{row['set_num']}/", 'catalog_updated_at': row['imported_at']}
