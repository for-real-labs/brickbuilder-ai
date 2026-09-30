import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from src.requests import generationNotifications as module


class Query:
    def __init__(self, rows):
        self.rows = rows
        self.filters = []
        self.payload = None
        self.maximum = None
        self.sort = None
    def select(self, *args, **kwargs): return self
    def eq(self, field, value): self.filters.append(lambda row: row.get(field) == value); return self
    def in_(self, field, values): self.filters.append(lambda row: row.get(field) in values); return self
    def order(self, field, desc=False): self.sort = (field, desc); return self
    def limit(self, count): self.maximum = count; return self
    def update(self, payload): self.payload = payload; return self
    def execute(self):
        rows = [row for row in self.rows if all(test(row) for test in self.filters)]
        if self.sort: rows.sort(key=lambda row: row.get(self.sort[0], ''), reverse=self.sort[1])
        if self.maximum: rows = rows[:self.maximum]
        if self.payload:
            for row in rows: row.update(self.payload)
        return type('Result', (), {'data': rows})()


@pytest.fixture
def storage(monkeypatch):
    rows = []
    fake = AsyncMock()
    fake.client.table = lambda name: Query(rows)
    async def get(id): return next((row for row in rows if row['id'] == id), None)
    fake.get_generation.side_effect = get
    monkeypatch.setattr(module, 'generation_storage', fake)
    return rows


def model(id, owner='one', status='completed', **extra):
    return {'id': id, 'user_id': owner, 'user_type': 'authenticated', 'status': status,
            'notification_seen': False, 'prompt': id, 'updated_at': '2026-09-30', 'created_at': id, **extra}


def test_notifications_are_owner_scoped_and_do_not_deduplicate_edits(storage):
    storage.extend([model('a'), model('b', source_generation_id='a'), model('pending', status='queued'), model('private', owner='two')])
    feed = asyncio.run(module.list_generation_notifications({'user_id': 'one', 'authenticated': True}))
    assert feed['unread_count'] == 2
    assert {row['id'] for row in feed['notifications']} == {'a', 'b'}
    assert feed['active'][0]['id'] == 'pending'
    assert next(row for row in feed['notifications'] if row['id'] == 'b')['is_edit']
    assert not storage[0]['notification_seen']  # opening the list does not mark anything read


def test_view_receipts_require_owner_and_completed_model_and_are_durable(storage):
    storage.extend([model('a'), model('pending', status='processing')])
    with pytest.raises(HTTPException) as error:
        asyncio.run(module.mark_generation_viewed('a', {'user_id': 'two', 'authenticated': True}))
    assert error.value.status_code == 404
    with pytest.raises(HTTPException) as error:
        asyncio.run(module.mark_generation_viewed('pending', {'user_id': 'one', 'authenticated': True}))
    assert error.value.status_code == 409
    asyncio.run(module.mark_generation_viewed('a', {'user_id': 'one', 'authenticated': True}))
    assert storage[0]['notification_seen'] is True
    assert asyncio.run(module.list_generation_notifications({'user_id': 'one', 'authenticated': True}))['unread_count'] == 0


def test_guest_access_and_latest_edit_recovery(storage):
    storage.extend([model('source', owner='guest', user_type='anonymous'), model('edit', owner='guest', user_type='anonymous', source_generation_id='source', status='queued')])
    auth = {'user_id': 'guest', 'authenticated': False}
    assert asyncio.run(module.latest_generation_edit('source', auth)) == {'generation_id': 'edit'}
    with pytest.raises(HTTPException):
        asyncio.run(module.latest_generation_edit('source', {'user_id': 'another', 'authenticated': False}))
    assert asyncio.run(module.list_generation_notifications(auth))['unread_count'] == 1


def test_old_unread_notifications_are_kept_outside_recent_history(storage):
    storage.append(model('old', updated_at='2020'))
    storage.extend(model(str(i), notification_seen=True, updated_at='2026') for i in range(40))
    feed = asyncio.run(module.list_generation_notifications({'user_id': 'one', 'authenticated': True}))
    assert feed['unread_count'] == 1
    assert any(row['id'] == 'old' for row in feed['notifications'])
