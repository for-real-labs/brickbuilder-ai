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


def test_cancelled_edits_do_not_resume_and_resizes_remain_cancellable(storage):
    storage.extend([model('source'), model('cancelled', status='cancelled', source_generation_id='source')])
    auth = {'user_id': 'one', 'authenticated': True}
    assert asyncio.run(module.latest_generation_edit('source', auth)) == {'generation_id': None}
    storage.append(model('resize', status='resizing', source_generation_id='source'))
    assert asyncio.run(module.latest_generation_edit('source', auth)) == {'generation_id': 'resize'}
    feed = asyncio.run(module.list_generation_notifications(auth))
    assert [row['id'] for row in feed['active']] == ['resize']
    assert all(row['id'] != 'cancelled' for row in feed['notifications'])


@pytest.mark.parametrize('authenticated', [True, False])
def test_bulk_read_only_changes_displayed_completed_models_for_current_owner(storage, authenticated):
    from uuid import uuid4
    ids = [str(uuid4()) for _ in range(5)]
    owner_type = 'authenticated' if authenticated else 'anonymous'
    storage.extend([
        model(ids[0], user_type=owner_type),
        model(ids[1], user_type=owner_type, status='processing'),
        model(ids[2], owner='two', user_type=owner_type),
        model(ids[3], user_type='anonymous' if authenticated else 'authenticated'),
        model(ids[4], user_type=owner_type),  # arrived after the displayed snapshot
    ])
    request = module.MarkNotificationsReadRequest(generation_ids=ids[:4])
    auth = {'user_id': 'one', 'authenticated': authenticated}
    result = asyncio.run(module.mark_notifications_read(request, auth))
    assert result == {'seen_ids': [ids[0]]}
    assert storage[0]['notification_seen']
    assert all(not row['notification_seen'] for row in storage[1:])
    assert asyncio.run(module.list_generation_notifications(auth))['unread_count'] == 1
    assert asyncio.run(module.mark_notifications_read(request, auth)) == result


def test_bulk_read_requires_identity_even_with_empty_list(storage):
    request = module.MarkNotificationsReadRequest(generation_ids=[])
    with pytest.raises(HTTPException) as error:
        asyncio.run(module.mark_notifications_read(request, {}))
    assert error.value.status_code == 401
    assert asyncio.run(module.mark_notifications_read(request, {'user_id': 'one'})) == {'seen_ids': []}


def test_bulk_read_storage_failure_is_retryable(monkeypatch):
    from unittest.mock import Mock
    from uuid import uuid4
    fake = Mock()
    fake.client.table.side_effect = RuntimeError('database unavailable')
    monkeypatch.setattr(module, 'generation_storage', fake)
    with pytest.raises(HTTPException) as error:
        asyncio.run(module.mark_notifications_read(
            module.MarkNotificationsReadRequest(generation_ids=[uuid4()]), {'user_id': 'one', 'authenticated': True}))
    assert error.value.status_code == 503
