"""Read an imported model's physical BOM and estimate safe catalog substitutions."""
import csv
import io
import re
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path

from .ldraw_upload import MAX_PLACEMENTS
from .parts_catalog import PartsUnavailable, normalize_part_id

Inventory = dict[tuple[str, int], int]


def imported_inventory(content: str) -> Inventory:
    sections = {'': []}
    current = ''
    custom_sections = set()
    for line in content.splitlines():
        fields = line.split(None, 14)
        if not fields:
            continue
        if fields[0] == '0' and len(fields) > 1:
            command = fields[1].upper()
            if command == '!COLOUR':
                custom_sections.add(current)
            if command == 'FILE':
                current = line.split(None, 2)[2].replace('\\', '/').lower()
                if current in sections:
                    raise PartsUnavailable('Duplicate submodel definition')
                sections[current] = []
            if command == 'NOFILE':
                current = ''
        elif fields[0] == '1':
            if len(fields) != 15:
                raise PartsUnavailable('Invalid part placement')
            reference = fields[14].replace('\\', '/').lower()
            color = int(fields[1], 16 if fields[1].lower().startswith('0x') else 10)
            matrix = tuple(float(value) for value in fields[5:14])
            rows = (matrix[:3], matrix[3:6], matrix[6:])
            for i, row in enumerate(rows):
                if any(not abs(sum(x*y for x, y in zip(row, other)) - (i == j)) < 0.002
                       for j, other in enumerate(rows)):
                    custom_sections.add(current)
            sections[current].append((reference, color))
        elif fields[0] in {'2', '3', '4', '5'}:
            custom_sections.add(current)

    work = 0

    @lru_cache(maxsize=32)
    def expand(name, inherited_color, depth):
        nonlocal work
        if depth >= 64:
            raise PartsUnavailable('Model nesting is too deep')
        if name.endswith('.dat') or name in custom_sections:
            raise PartsUnavailable('Custom or transformed geometry needs conversion')
        inventory = Counter()
        total = 0
        for reference, color in sections[name]:
            color = inherited_color if color == 16 else color
            if reference in sections:
                nested, size = expand(reference, color, depth + 1)
                total += size
                if total > MAX_PLACEMENTS:
                    raise PartsUnavailable('Expanded model is too large')
                work += len(nested)
                if work > 5 * MAX_PLACEMENTS:
                    raise PartsUnavailable('Expanded model is too complex')
                inventory.update(nested)
            else:
                if not reference.endswith('.dat'):
                    raise PartsUnavailable('Model contains a non-inventory reference')
                total += 1
                if total > MAX_PLACEMENTS:
                    raise PartsUnavailable('Expanded model is too large')
                inventory[(normalize_part_id(reference), color)] += 1
        return inventory, total

    root = next((name for name in sections if name), '')
    if root and (sections[''] or '' in custom_sections):
        raise PartsUnavailable('Geometry outside the root model needs conversion')
    inventory, count = expand(root, 16, 0)
    if not count:
        raise PartsUnavailable('No physical parts to price')
    return dict(inventory)


@lru_cache(maxsize=1)
def color_values():
    with (Path(__file__).resolve().parents[2] / 'gobrick_colors.csv').open() as source:
        colors = {}
        for row in csv.DictReader(source):
            try:
                code = int(row['LDraw'].split()[0])
                value = row['RGB']
                if len(value) == 6:
                    colors[code] = tuple(int(value[i:i+2], 16) for i in (0, 2, 4))
            except (ValueError, IndexError):
                continue
    return colors


def estimated_inventory(inventory: Inventory, catalog) -> Inventory | None:
    """Keep exact pieces first, then look for close colors of the same part.

    Known mold variants are candidates for estimates only. Never quote a partial BOM.
    """
    def mold_family(part_id):
        # LDraw uses letter suffixes for mold variants; prints and arbitrary
        # IDs are not treated as dimensionally equivalent.
        match = re.fullmatch(r'(\d{3,7})[a-d]?', part_id)
        return match.group(1) if match else part_id

    by_family = defaultdict(list)
    for part in catalog.parts.values():
        if part.unit_price is not None and part.weight_kg is not None:
            by_family[mold_family(part.part_id)].append(part)
    colors = color_values()

    def distance(left, right):
        if left == right:
            return 0
        source = colors.get(left)
        if source is None and 0x2000000 <= left <= 0x2FFFFFF:
            source = ((left >> 16) & 255, (left >> 8) & 255, left & 255)
        target = colors.get(right)
        if source is None or target is None:
            return float('inf')
        return sum((a - b) ** 2 for a, b in zip(source, target))

    used, result, remainder = Counter(), Counter(), []
    for (part_id, color), quantity in inventory.items():
        part = catalog.parts.get((part_id, color))
        if part and part.unit_price is not None and part.weight_kg is not None and (
            part.max_quantity is None or used[part.sku] + quantity <= part.max_quantity
        ):
            used[part.sku] += quantity
            result[(part_id, color)] += quantity
        else:
            remainder.append((part_id, color, quantity))
    for part_id, color, quantity in remainder:
        candidates = by_family[mold_family(part_id)]
        for part in sorted(candidates, key=lambda part: (part.part_id != part_id,
                           distance(color, part.color_id), part.part_id, part.color_id)):
            if distance(color, part.color_id) == float('inf'):
                continue
            available = quantity if part.max_quantity is None else min(quantity, part.max_quantity - used[part.sku])
            used[part.sku] += available
            result[(part.part_id, part.color_id)] += available
            quantity -= available
            if quantity == 0:
                break
        if quantity:
            return None
    return {key: quantity for key, quantity in result.items() if quantity}


def fulfillment_csv(inventory: Inventory) -> str:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['LdrawId', 'LDrawColorId', 'Qty'])
    writer.writerows((f'{part}.dat', color, quantity) for (part, color), quantity in sorted(inventory.items()))
    return output.getvalue()
