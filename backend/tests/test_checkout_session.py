import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from src.requests import createCheckoutSession as checkout
from src.requests.getPrice import GetPriceResponse


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv('STRIPE_SECRET_KEY', 'test-secret')
    monkeypatch.setenv('SITE_URL', 'https://example.com')
    monkeypatch.setenv('API_MODE', 'local')
    row = {'status': 'completed', 'user_type': 'authenticated', 'user_id': 'owner',
           'name': 'Test Frog', 'parts_list_csv_url': 'https://example.com/parts.csv'}
    storage = AsyncMock(return_value=row)
    monkeypatch.setattr(checkout, 'generation_storage', SimpleNamespace(get_generation=storage))
    quote = GetPriceResponse(generation_id='g', total_price=50, total_parts=240,
                            total_weight=0.1, unique_part_types=3, message='quote')
    monkeypatch.setattr(checkout, 'get_price', AsyncMock(return_value=quote))
    create = Mock(return_value=SimpleNamespace(id='cs', url=None, client_secret='client-secret'))
    monkeypatch.setattr(checkout.stripe.checkout.Session, 'create', create)
    track = Mock()
    monkeypatch.setattr(checkout, 'track_api_call', track)
    monkeypatch.setattr(checkout, 'track_error', Mock())
    return storage, create, track


def run(**kwargs):
    return asyncio.run(checkout.create_checkout_session(checkout.CreateCheckoutSessionRequest(generationId='g', **kwargs),
        {'authenticated': True, 'user_id': 'owner'}))


def test_custom_checkout_uses_server_price_and_preserves_fulfillment(setup):
    _, create, _ = setup
    result = run(uiMode='custom', priceCents=1, brickowlCartId='cart')
    params = create.call_args.kwargs
    assert params['line_items'][0]['price_data']['unit_amount'] == 2500
    assert params['line_items'][0]['price_data']['product_data']['name'] == 'Test Frog'
    assert params['ui_mode'] == 'custom'
    assert params['payment_method_types'] == ['card']
    assert params['return_url'] == 'https://example.com/success?session_id={CHECKOUT_SESSION_ID}'
    assert 'success_url' not in params and 'cancel_url' not in params
    assert params['metadata'] == {'generationId': 'g', 'partsListCsvUrl': 'https://example.com/parts.csv', 'brickowlCartId': 'cart'}
    assert params['shipping_address_collection'] == {'allowed_countries': ['US', 'CA']}
    assert result.client_secret == 'client-secret' and result.price_data.total_price == 50


def test_hosted_checkout_retains_redirects_and_does_not_track_contact(setup):
    _, create, track = setup
    create.return_value = SimpleNamespace(id='cs', url='https://checkout.stripe.com/test')
    result = run(customerEmail='builder@example.com')
    params = create.call_args.kwargs
    assert params['ui_mode'] == 'hosted'
    assert params['cancel_url'] == 'https://example.com/order'
    assert params['customer_email'] == 'builder@example.com'
    assert 'return_url' not in params
    assert result.client_secret is None
    assert 'builder@example.com' not in str(track.call_args)


def test_private_checkout_cannot_be_started_by_other_user(setup):
    storage, create, _ = setup
    storage.return_value['user_id'] = 'other'
    with pytest.raises(HTTPException) as error:
        run(uiMode='custom')
    assert error.value.status_code == 404
    create.assert_not_called()


def test_unfinished_model_cannot_be_ordered(setup):
    storage, create, _ = setup
    storage.return_value['status'] = 'processing'
    with pytest.raises(HTTPException) as error:
        run()
    assert error.value.status_code == 400
    create.assert_not_called()


@pytest.mark.parametrize('kwargs', [{'quantity': 2}, {'priceCents': 0}, {'uiMode': 'invalid'}, {'customerEmail': 'bad'}])
def test_validates_checkout_request(kwargs):
    with pytest.raises(ValidationError):
        checkout.CreateCheckoutSessionRequest(**kwargs)


@pytest.mark.parametrize('price,weight,expected', [(50, 0.1, 2500), (0.01, 0, 200), (10.01, 0, 501), (100, 0.123, 5001)])
def test_price_matches_frontend_cent_rounding(price, weight, expected):
    quote = GetPriceResponse(generation_id='g', total_price=price, total_parts=1,
                            total_weight=weight, unique_part_types=1, message='quote')
    assert checkout.checkout_price_cents(quote) == expected


def test_guest_owner_can_order_without_an_account(setup):
    storage, create, _ = setup
    storage.return_value.update(user_id='guest', user_type='anonymous')
    asyncio.run(checkout.create_checkout_session(checkout.CreateCheckoutSessionRequest(generationId='g'),
        {'authenticated': False, 'user_id': 'guest'}))
    create.assert_called_once()


def test_missing_parts_list_never_creates_a_payment(setup):
    storage, create, _ = setup
    storage.return_value['parts_list_csv_url'] = None
    with pytest.raises(HTTPException) as error:
        run()
    assert error.value.status_code == 400
    create.assert_not_called()

@pytest.mark.parametrize('mode', ['embedded', 'elements'])
def test_previous_checkout_clients_survive_the_deployment(setup, mode):
    _, create, _ = setup
    result = run(uiMode=mode)
    params = create.call_args.kwargs
    assert params['ui_mode'] == mode
    assert params['return_url'] == 'https://example.com/success?session_id={CHECKOUT_SESSION_ID}'
    assert params['allowed_payment_method_types' if mode == 'elements' else 'payment_method_types'] == ['card']
    assert result.client_secret == 'client-secret'
    if mode == 'embedded':
        assert params['redirect_on_completion'] == 'if_required'
    else:
        assert params['stripe_version'] == '2026-09-30.endive'
