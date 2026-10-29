"""Bounded, exact inventories for building with parts the user already owns."""
from __future__ import annotations

import csv
import io
import re
import xml.etree.ElementTree as ET
from collections import Counter
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .ldraw_upload import MAX_UPLOAD_BYTES, normalize_ldraw_upload
from .parts_catalog import CatalogPart, PartsCatalog, normalize_part_id, reject_custom_parts

MAX_PIECES = 100_000
MAX_ROWS = 10_000


class InventoryPart(BaseModel):
    model_config = ConfigDict(extra='forbid')
    part_id: str = Field(max_length=84)
    color_id: int = Field(strict=True, ge=0, le=65535)
    quantity: int = Field(strict=True, gt=0, le=MAX_PIECES)

    @field_validator('part_id')
    @classmethod
    def part(cls, value):
        return normalize_part_id(value)

    @field_validator('color_id')
    @classmethod
    def color(cls, value):
        if value in {16, 24}:
            raise ValueError('Every piece must have a specific color; current/edge colors are not inventories.')
        return value


class PartsInventory(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=200)
    source: Literal['upload', 'set'] = 'upload'
    parts: list[InventoryPart] = Field(min_length=1, max_length=MAX_ROWS)

    @field_validator('name')
    @classmethod
    def clean_name(cls, value):
        value = ''.join(c for c in value if c.isprintable()).strip()
        if not value:
            raise ValueError('An inventory name is required.')
        return value

    @model_validator(mode='after')
    def bounded_inventory(self):
        counts = Counter()
        for part in self.parts:
            counts[(part.part_id, part.color_id)] += part.quantity
        if sum(counts.values()) > MAX_PIECES:
            raise ValueError('Parts lists are limited to 100,000 pieces.')
        self.parts = [InventoryPart(part_id=p, color_id=c, quantity=q) for (p, c), q in sorted(counts.items())]
        return self

    def catalog(self) -> PartsCatalog:
        return PartsCatalog([CatalogPart(p.part_id, p.color_id, p.part_id,
            f'{p.part_id}-{p.color_id}', None, None, p.quantity) for p in self.parts], name=self.name)


@lru_cache(maxsize=2)
def color_mapping(system: str) -> dict[int, int]:
    """Use the checked-in Rebrickable cross-reference, never nearest RGB colors."""
    with (Path(__file__).resolve().parents[1] / 'data/inventory_colors.csv').open(encoding='utf-8-sig') as source:
        return {int(row['color_id']): int(row['ldraw_id']) for row in csv.DictReader(source) if row['system'] == system}


def mapped_color(value: str | int, system: str) -> int:
    color = int(value)
    if system == 'ldraw':
        return color
    try:
        return color_mapping(system)[color]
    except KeyError:
        raise ValueError(f'No exact LDraw mapping for {system} color {color}. Export an LDraw parts list instead.') from None


def _csv_parts(text: str):
    # All accepted layouts have explicit identifier systems. Ambiguous color names
    # or element IDs are rejected instead of guessing a mold or a color.
    reader = csv.DictReader(io.StringIO(text.lstrip('\ufeff')))
    names = {re.sub(r'[\s_\-]', '', name).lower(): name for name in reader.fieldnames or []}
    if 'ldrawid' in names and 'ldrawcolorid' in names:
        part, color, system = 'ldrawid', 'ldrawcolorid', 'ldraw'
    elif 'partid' in names and 'colorid' in names:
        part, color, system = 'partid', 'colorid', 'ldraw'
    elif 'partnum' in names and 'colorid' in names:
        part, color, system = 'partnum', 'colorid', 'rebrickable'
    elif 'part' in names and 'color' in names:
        part, color, system = 'part', 'color', 'rebrickable'
    elif 'partnumber' in names and 'color' in names:
        part, color, system = 'partnumber', 'color', 'bricklink'
    else:
        raise ValueError('CSV needs part_id,color_id,quantity (LDraw), LdrawId,LDrawColorId,Qty, or a Rebrickable parts export.')
    quantity = next((key for key in ('quantity', 'qty', 'maxquantity') if key in names), None)
    if not quantity:
        raise ValueError('CSV needs a quantity or Qty column.')
    for index, row in enumerate(reader):
        if index >= MAX_ROWS:
            raise ValueError('Parts lists are limited to 10,000 rows.')
        if None in row or any(value is None for value in row.values()):
            raise ValueError(f'CSV row {index + 2} has missing or extra columns.')
        yield InventoryPart(part_id=row[names[part]], color_id=mapped_color(row[names[color]], system),
                            quantity=int(row[names[quantity]]))


def _xml_parts(text: str):
    if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
        raise ValueError('XML declarations and external entities are not supported.')
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        raise ValueError('This is not a valid BrickLink inventory XML file.') from None
    if root.tag.upper() != 'INVENTORY':
        raise ValueError('Upload a BrickLink inventory XML with ITEMID, COLOR and QTY or MINQTY.')
    for index, item in enumerate(root):
        if index >= MAX_ROWS:
            raise ValueError('Parts lists are limited to 10,000 rows.')
        fields = {child.tag.upper(): (child.text or '').strip() for child in item}
        if item.tag.upper() != 'ITEM' or fields.get('ITEMTYPE', 'P') != 'P':
            raise ValueError('XML must contain individual parts. Export minifigure/set contents as parts first.')
        try:
            yield InventoryPart(part_id=fields['ITEMID'], color_id=mapped_color(fields['COLOR'], 'bricklink'),
                                quantity=int(fields.get('MINQTY') or fields['QTY']))
        except KeyError:
            raise ValueError('Each XML item needs ITEMID, COLOR and QTY or MINQTY.') from None


def _ldraw_parts(filename: str, data: bytes):
    text = normalize_ldraw_upload(filename, data, inventory_only=True)
    text = re.sub(r'(?im)^0\s+(FILE|!COLOUR)\b', lambda match: '0 ' + match[1].upper(), text)
    reject_custom_parts(text)
    sections, current = {}, None
    for line in text.splitlines():
        fields = line.split(None, 14)
        if len(fields) >= 3 and fields[:2] == ['0', 'FILE']:
            current = line.split(None, 2)[2].lower()
            sections[current] = []
        elif fields and fields[0] == '1':
            sections[current].append((fields[14].lower(), int(fields[1])))
    @lru_cache(maxsize=MAX_ROWS)
    def expand(name: str, inherited: int, depth: int = 0):
        if depth > 64:
            raise ValueError('Submodels are nested too deeply.')
        counts, total = Counter(), 0
        for reference, color in sections[name]:
            color = inherited if color == 16 else color
            if reference in sections:
                nested = expand(reference, color, depth + 1)
                counts.update(nested)
                total += sum(nested.values())
            elif reference.endswith('.dat'):
                counts[(normalize_part_id(reference), color)] += 1
                total += 1
            else:
                raise ValueError('The model references a missing part or submodel.')
            if total > MAX_PIECES or len(counts) > MAX_ROWS:
                raise ValueError('Expanded model exceeds the 100,000 piece inventory limit.')
        return counts
    return [InventoryPart(part_id=p, color_id=c, quantity=q) for (p, c), q in expand(next(iter(sections)), 16).items()]


def parse_inventory(filename: str, data: bytes) -> PartsInventory:
    if not data or len(data) > MAX_UPLOAD_BYTES:
        raise ValueError('Upload a nonempty parts list smaller than 16 MB.')
    name = PurePosixPath(filename.replace('\\', '/')).name[:200]
    extension = PurePosixPath(name).suffix.lower()
    if extension in {'.io', '.ldr', '.mpd'}:
        parts = _ldraw_parts(name, data)
    elif extension in {'.csv', '.xml'}:
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise ValueError('Save this parts list with UTF-8 encoding and upload it again.') from None
        parts = list(_csv_parts(text) if extension == '.csv' else _xml_parts(text))
    else:
        raise ValueError('Choose a .csv, .io, .ldr, .mpd or .xml parts list.')
    return PartsInventory(name=name, parts=parts)
