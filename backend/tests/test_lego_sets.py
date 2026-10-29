import gzip
import importlib.util
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.utils.lego_sets import search_sets, set_inventory
from src.utils.local_db import _QueryBuilder
from src.requests import partsInventory as endpoints


def test_catalog_search_is_bounded_and_parameterized():
    query = Mock()
    for name in ('select', 'ilike', 'order', 'limit'):
        getattr(query, name).return_value = query
    query.execute.return_value = SimpleNamespace(data=[{'set_num': '10698-1'}])
    client = SimpleNamespace(table=lambda _: query)
    assert search_sets(client, '10698') == [{'set_num': '10698-1'}]
    query.ilike.assert_called_once_with('search_text', '%10698%')
    query.limit.assert_called_once_with(20)
    assert search_sets(client, '%,()') == []
    builder = _QueryBuilder(None, threading.Lock(), 'lego_set_catalog').ilike('search_text', '%a%')
    assert builder._build_where() == (' WHERE (doc->>%s) ILIKE %s', ['search_text', '%a%'])


def test_set_selection_excludes_unmapped_parts_without_substituting_colors():
    result = set_inventory({'set_num': '1-1', 'name': 'Test', 'imported_at': '2026-10-29',
        'inventory': [['3001', 4, 2], ['unknown', 4, 5], ['3001', 9999, 3]]}, known_parts=frozenset({'3001'}))
    assert result['inventory']['parts'] == [{'part_id': '3001', 'color_id': 4, 'quantity': 2}]
    assert sum(p['quantity'] for p in result['unavailable']) == 8
    assert result['source_url'] == 'https://rebrickable.com/sets/1-1/'


def test_import_expands_latest_nested_sets_and_minifigs_and_excludes_spares(tmp_path):
    spec = importlib.util.spec_from_file_location('import_lego_sets', Path(__file__).parents[1] / 'scripts/import_lego_sets.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    data = {
        'sets': 'set_num,name,year\n1-1,Box,2020\n2-1,Incomplete,2021\n',
        'inventories': 'id,version,set_num\n1,1,1-1\n2,2,1-1\n3,1,child\n4,1,fig-1\n5,1,2-1\n',
        'inventory_parts': 'inventory_id,part_num,color_id,quantity,is_spare\n1,old,4,99,False\n2,3001,4,2,False\n2,3001,4,10,True\n3,3002,0,3,False\n4,3003,4,1,False\n',
        'inventory_sets': 'inventory_id,set_num,quantity\n2,child,2\n5,missing,1\n',
        'inventory_minifigs': 'inventory_id,fig_num,quantity\n2,fig-1,3\n',
    }
    files = {}
    for name, content in data.items():
        files[name] = tmp_path / (name + '.csv.gz')
        files[name].write_bytes(gzip.compress(content.encode()))
    rows = list(module.build_catalog(files, '2026-10-29'))
    assert len(rows) == 1
    assert rows[0]['num_parts'] == 11
    assert rows[0]['inventory'] == [['3001', 4, 2], ['3002', 0, 6], ['3003', 4, 3]]


def test_upload_endpoint_accepts_multipart_and_returns_actionable_errors():
    app = FastAPI(); app.include_router(endpoints.router)
    client = TestClient(app)
    result = client.post('/parts-inventory/upload', files={'file': ('my.csv', b'part_id,color_id,quantity\n3001,4,2')})
    assert result.status_code == 200 and result.json()['inventory']['parts'][0]['quantity'] == 2
    assert client.post('/parts-inventory/upload', files={'file': ('bad.csv', b'part_id,color_id,quantity\n3001,4,0')}).status_code == 400
    assert client.post('/parts-inventory/upload', files={'file': ('x.exe', b'bad')}).status_code == 400


def test_catalog_missing_or_offline_does_not_invent_a_parts_list(monkeypatch):
    monkeypatch.setattr(endpoints, 'supabase_client', None)
    app = FastAPI(); app.include_router(endpoints.router)
    client = TestClient(app)
    assert client.get('/parts-inventory/sets?q=a').status_code == 422
    assert client.get('/parts-inventory/sets?q=castle').status_code == 503
    assert client.get('/parts-inventory/sets/123-1').status_code == 503


def test_color_refresh_uses_canonical_names_and_rejects_ambiguous_matches():
    spec = importlib.util.spec_from_file_location('refresh_inventory_colors', Path(__file__).parents[1] / 'scripts/refresh_inventory_colors.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    def row(ldraw, note='o'):
        return {'BL Color Code': '85', 'LDraw Color Code': str(ldraw), 'note': note,
                'BL Color Name': 'Dark Bluish Gray', 'LDraw Color Name': 'Dark_Bluish_Gray'}
    rb = [{'id': '72', 'name': 'Dark Bluish Gray'}, {'id': '99', 'name': 'Similar Gray'}]
    assert list(module.cross_references([row(72), row(999, 'to_bl')], rb, '0 !COLOUR Dark_Bluish_Gray CODE 72 VALUE #000000')) == [
        {'system': 'bricklink', 'color_id': 85, 'ldraw_id': 72, 'name': 'Dark Bluish Gray'},
        {'system': 'rebrickable', 'color_id': 72, 'ldraw_id': 72, 'name': 'Dark Bluish Gray'}]
    assert list(module.cross_references([row(72), row(999)], rb, '0 !COLOUR Dark_Bluish_Gray CODE 72\n0 !COLOUR Dark_Bluish_Gray CODE 999')) == []
