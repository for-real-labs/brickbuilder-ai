from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.utils import order_inventory as module
from src.requests.partsInventory import router
from src.utils.auth import get_optional_identity


@pytest.fixture
def setup(monkeypatch):
    generation = {'id': 'model-1', 'name': 'Red car', 'user_id': 'owner', 'user_type': 'authenticated',
                  'parts_list_csv_url': 'https://example.com/changed.csv'}
    order = {'id': 42, 'generation_id': 'model-1', 'cancelled': False,
             'parts_list_csv_url': 'https://storage.example/storage/v1/object/public/generations/generations/model-1/parts_list_1.csv'}
    query = Mock()
    for method in ('select', 'eq', 'limit'):
        getattr(query, method).return_value = query
    download = Mock(return_value=b'LdrawId,LDrawColorId,Qty\n3001.dat,4,8\n')
    storage = SimpleNamespace(client=SimpleNamespace(table=Mock(return_value=query),
        storage=SimpleNamespace(from_=Mock(return_value=SimpleNamespace(download=download)))),
        get_generation=AsyncMock(return_value=generation))
    monkeypatch.setattr(module, 'generation_storage', storage)
    monkeypatch.setattr(module, 'execute_query', AsyncMock(return_value=SimpleNamespace(data=[order])))
    app = FastAPI(); app.include_router(router)
    identity = {'user_id': 'owner', 'authenticated': True}
    app.dependency_overrides[get_optional_identity] = lambda: identity
    return TestClient(app), order, generation, download, identity


def test_order_snapshot_is_used_instead_of_current_model(setup):
    client, _, _, download, _ = setup
    response = client.get('/parts-inventory/orders/42')
    assert response.status_code == 200
    assert response.json()['inventory'] == {'name': 'Red car (Order #42)', 'source': 'order',
        'parts': [{'part_id': '3001', 'color_id': 4, 'quantity': 8}]}
    download.assert_called_once_with('generations/model-1/parts_list_1.csv')


def test_another_accounts_order_is_never_downloaded(setup):
    client, _, _, download, identity = setup
    identity['user_id'] = 'other'
    assert client.get('/parts-inventory/orders/42').status_code == 404
    download.assert_not_called()


@pytest.mark.parametrize('url', ['', 'https://evil.example/parts.csv',
    'https://storage.example/storage/v1/object/public/generations/generations/other/parts.csv',
    'https://storage.example/storage/v1/object/public/generations/generations/model-1/%2e%2e/parts.csv'])
def test_missing_or_unsafe_snapshot_cannot_fall_back_to_latest_model(setup, url):
    client, order, _, download, _ = setup
    order['parts_list_csv_url'] = url
    assert client.get('/parts-inventory/orders/42').status_code == 422
    download.assert_not_called()


def test_cancelled_order_is_not_available(setup):
    client, order, _, download, _ = setup
    order['cancelled'] = True
    assert client.get('/parts-inventory/orders/42').status_code == 409
    download.assert_not_called()


def test_bad_snapshot_fails_without_partial_inventory(setup):
    client, _, _, download, _ = setup
    download.return_value = b'LdrawId,LDrawColorId,Qty\n3001,4,-1\n'
    assert client.get('/parts-inventory/orders/42').status_code == 422
    download.side_effect = OSError('unavailable')
    assert client.get('/parts-inventory/orders/42').status_code == 503


def test_guest_order_requires_its_original_browser_identity(setup):
    client, _, generation, _, identity = setup
    generation.update(user_type='anonymous', user_id='guest-proof')
    identity.update(authenticated=False, user_id='guest-proof')
    assert client.get('/parts-inventory/orders/42').status_code == 200
    identity['user_id'] = 'other-guest'
    assert client.get('/parts-inventory/orders/42').status_code == 404
