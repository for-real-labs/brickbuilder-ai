import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from fastapi import HTTPException
from fastapi.responses import Response
from fastapi.testclient import TestClient
import pgserver
import psycopg
from psycopg.rows import dict_row
import pytest

from src.utils import auth, billing, instruction_links as links

MIGRATION = (Path(__file__).resolve().parents[2] / 'supabase/migrations/20261024000000_order_instruction_keys.sql').read_text()


@pytest.fixture(scope='module')
def server(tmp_path_factory):
    instance = pgserver.get_server(tmp_path_factory.mktemp('instruction-links'))
    yield instance
    instance.cleanup()


@pytest.fixture
def db(server, monkeypatch):
    with psycopg.connect(server.get_uri(), autocommit=True, row_factory=dict_row) as connection:
        connection.execute('DROP TABLE IF EXISTS orders')
        connection.execute('CREATE TABLE orders(id bigint PRIMARY KEY, generation_id uuid, cancelled boolean DEFAULT false)')
        connection.execute(MIGRATION)

        class Query:
            def __init__(self):
                self.filters, self.values, self.changes = [], [], None

            def select(self, _): return self
            def limit(self, _): return self

            def eq(self, field, value):
                assert field in {'id', 'generation_id', 'cancelled', 'instructions_key_hash'}
                self.filters.append(f'{field} = %s')
                self.values.append(value)
                return self

            def is_(self, field, value):
                assert field == 'instructions_key_hash' and value == 'null'
                self.filters.append('instructions_key_hash IS NULL')
                return self

            def update(self, data):
                self.changes = data['instructions_key_hash']
                return self

            def execute(self):
                prefix = 'SELECT * FROM orders WHERE '
                values = self.values
                if self.changes:
                    prefix = 'UPDATE orders SET instructions_key_hash = %s WHERE '
                    values = [self.changes, *values]
                rows = connection.execute(prefix + ' AND '.join(self.filters) + (' RETURNING *' if self.changes else ''), values).fetchall()
                return SimpleNamespace(data=rows)

        monkeypatch.setattr(auth, 'supabase_client', SimpleNamespace(table=lambda name: Query()))
        yield connection


def test_random_keys_are_unrelated_to_the_public_model_id():
    first, second = links.new_instruction_key(), links.new_instruction_key()
    assert first != second and len(first) == len(second) == 43
    assert len(links.instruction_key_hash(first)) == 64
    assert first not in links.instruction_key_hash(first)


@pytest.mark.parametrize('case,allowed', [('valid', True), ('wrong_model', False), ('wrong_key', False),
                                        ('cancelled', False), ('revoked', False), ('missing_order', False),
                                        ('model_uuid', False), ('malformed', False)])
def test_legacy_key_validation_does_not_restrict_free_instructions(db, monkeypatch, case, allowed):
    from src import api
    generation_id, key = str(uuid4()), links.new_instruction_key()
    if case != 'missing_order':
        db.execute('INSERT INTO orders VALUES (1,%s,%s,%s)',
                   (generation_id, case == 'cancelled', None if case == 'revoked' else links.instruction_key_hash(key)))
    if case == 'wrong_model': generation_id = str(uuid4())
    if case == 'wrong_key': key = links.new_instruction_key()
    if case == 'model_uuid': key = generation_id
    if case == 'malformed': key = "' OR true --"
    monkeypatch.setattr(billing, 'local_unmetered', lambda: False)
    monkeypatch.setattr(billing, 'settings', AsyncMock(return_value={'enabled': True}))
    steps = AsyncMock(return_value=Response('steps', headers={'Cache-Control': 'private, no-store'}))
    monkeypatch.setattr(api, 'get_nova_instructions', steps)
    api.app.dependency_overrides[auth.get_optional_identity] = lambda: {'authenticated': False, 'is_anonymous': True}
    try:
        client = TestClient(api.app)
        headers = {'X-Instruction-Key': key}
        access = client.get(f'/generation/{generation_id}/instruction-access', headers=headers)
        assert access.json() == {'allowed': allowed}
        assert access.headers['cache-control'] == 'private, no-store'
        response = client.get(f'/generation/{generation_id}/nova-instructions.ldr', headers=headers)
        assert response.status_code == 200
        steps.assert_awaited_once_with(generation_id)
        assert key not in response.text
    finally:
        api.app.dependency_overrides.clear()


def test_recovery_preserves_existing_links_unless_explicitly_replaced(db):
    generation = str(uuid4())
    db.execute('INSERT INTO orders(id,generation_id) VALUES (1,%s)', (generation,))
    first = asyncio.run(links.issue_order_instruction_link(1))
    key = parse_qs(urlparse(first['instructions_url']).fragment)['access'][0]
    assert asyncio.run(links.has_instruction_key(generation, key))
    assert key not in str(db.execute('SELECT * FROM orders').fetchall())
    assert parse_qs(urlparse(first['postcard_url']).fragment) == {'access': [key]}
    with pytest.raises(HTTPException) as error:
        asyncio.run(links.issue_order_instruction_link(1))
    assert error.value.status_code == 409
    assert asyncio.run(links.has_instruction_key(generation, key))
    second = asyncio.run(links.issue_order_instruction_link(1, replace=True))
    assert second != first and not asyncio.run(links.has_instruction_key(generation, key))
    db.execute('UPDATE orders SET cancelled=true WHERE id=1')
    with pytest.raises(HTTPException): asyncio.run(links.issue_order_instruction_link(1, replace=True))
    with pytest.raises(HTTPException): asyncio.run(links.issue_order_instruction_link(2))


def test_migration_does_not_replace_order_history_or_existing_keys(db):
    db.execute('INSERT INTO orders VALUES (1,%s,false,%s)', (uuid4(), 'existing-hash'))
    db.execute(MIGRATION)
    assert db.execute('SELECT instructions_key_hash FROM orders').fetchone()['instructions_key_hash'] == 'existing-hash'


def test_order_links_open_exact_landing_instructions_but_postcard_links_open_preview():
    key = 'a' * 43
    assert links.instruction_link('ghost & revision', key) == (
        'https://brickbuilder.ai/?id=ghost+%26+revision&exact=1&instructions=1#access=' + key)
    assert links.instruction_link('ghost', key, postcard=True) == (
        'https://brickbuilder.ai/order?id=ghost#access=' + key)
