import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
import stripe

from src.requests import stripeWebhook as webhook


@pytest.mark.parametrize('selected,expected', [('true', True), ('false', False), (None, False)])
def test_paid_order_saves_postcard_choice_and_instructions_link(monkeypatch, selected, expected):
    metadata = {'generationId': 'g/123'}
    if selected is not None:
        metadata['shipInstructionsPostcard'] = selected
    session = stripe.StripeObject.construct_from({
        'id': 'cs', 'metadata': metadata, 'amount_total': 2500, 'payment_intent': 'pi',
        'customer_details': {'email': 'buyer@example.com'},
        'collected_information': {'shipping_details': {'name': 'Builder', 'address': {'line1': '123 Main', 'city': 'Chicago', 'country': 'US'}}},
    }, None)
    monkeypatch.setattr(webhook.stripe.checkout.Session, 'retrieve', Mock(return_value=session))
    save = AsyncMock(return_value='order-1')
    monkeypatch.setattr(webhook, 'generation_storage', SimpleNamespace(update_payment_status=save))
    monkeypatch.setenv('RESEND_API_KEY', 'test-only')
    send = Mock()
    monkeypatch.setattr(webhook.resend.Emails, 'send', send)
    asyncio.run(webhook.handle_checkout_session_completed(session))
    info = save.call_args.kwargs['shipping_info']
    assert info['instructions_postcard'] is expected
    if expected:
        assert info['instructions_postcard_size'] == '6x4in'
        assert info['instructions_url'] == 'https://brickbuilder.ai/instructions?id=g%2F123'
    else:
        assert 'instructions_postcard_size' not in info
        assert 'instructions_url' not in info
    owner_message = send.call_args.args[0]['html']
    assert ('Include 6 × 4 inch QR instructions postcard' if expected else 'Not requested') in owner_message


@pytest.mark.parametrize('expanded', [True, False])
def test_international_payment_intent_shipping_reaches_the_paid_order(monkeypatch, expanded):
    shipping = {'name': 'Builder', 'address': {'line1': '123 Main', 'city': 'Flying Fish Cove', 'postal_code': '6798', 'country': 'CX'}}
    intent = stripe.StripeObject.construct_from({'id': 'pi', 'shipping': shipping}, None)
    session = stripe.StripeObject.construct_from({
        'id': 'cs', 'metadata': {'generationId': 'g', 'shippingAddressProvided': 'true'}, 'amount_total': 2500,
        'payment_intent': intent if expanded else 'pi', 'customer_details': {'email': 'buyer@example.com'},
        'collected_information': None,
    }, None)
    retrieve = Mock(return_value=session)
    monkeypatch.setattr(webhook.stripe.checkout.Session, 'retrieve', retrieve)
    retrieve_intent = Mock(return_value=intent)
    monkeypatch.setattr(webhook.stripe.PaymentIntent, 'retrieve', retrieve_intent)
    save = AsyncMock(return_value='order-1')
    monkeypatch.setattr(webhook, 'generation_storage', SimpleNamespace(update_payment_status=save))
    monkeypatch.delenv('RESEND_API_KEY', raising=False)
    asyncio.run(webhook.handle_checkout_session_completed(session))
    retrieve.assert_called_once_with('cs', expand=['payment_intent'])
    if expanded:
        retrieve_intent.assert_not_called()
    else:
        retrieve_intent.assert_called_once_with('pi')
    assert save.call_args.kwargs['stripe_payment_intent'] == 'pi'
    assert save.call_args.kwargs['shipping_info']['address']['country'] == 'CX'
    assert save.call_args.kwargs['shipping_info']['name'] == 'Builder'


def test_missing_preprovided_address_requires_a_webhook_retry(monkeypatch):
    from fastapi import HTTPException
    session = stripe.StripeObject.construct_from({'id': 'cs', 'metadata': {'shippingAddressProvided': 'true'}, 'payment_intent': {'id': 'pi'}}, None)
    monkeypatch.setattr(webhook.stripe.checkout.Session, 'retrieve', Mock(return_value=session))
    save = AsyncMock()
    monkeypatch.setattr(webhook, 'generation_storage', SimpleNamespace(update_payment_status=save))
    with pytest.raises(HTTPException) as error:
        asyncio.run(webhook.handle_checkout_session_completed(session))
    assert error.value.status_code == 500
    save.assert_not_called()



def test_shipping_can_be_recovered_from_the_event_after_session_fetch_fails(monkeypatch):
    shipping = {'name': 'Builder', 'address': {'line1': '123 Main', 'city': 'Tokyo', 'postal_code': '100-0001', 'country': 'JP'}}
    session = stripe.StripeObject.construct_from({'id': 'cs', 'metadata': {'generationId': 'g', 'shippingAddressProvided': 'true'}, 'payment_intent': 'pi', 'collected_information': None}, None)
    monkeypatch.setattr(webhook.stripe.checkout.Session, 'retrieve', Mock(side_effect=RuntimeError('Temporary failure')))
    monkeypatch.setattr(webhook.stripe.PaymentIntent, 'retrieve', Mock(return_value={'id': 'pi', 'shipping': shipping}))
    save = AsyncMock(return_value='order-1')
    monkeypatch.setattr(webhook, 'generation_storage', SimpleNamespace(update_payment_status=save))
    asyncio.run(webhook.handle_checkout_session_completed(session))
    assert save.call_args.kwargs['shipping_info']['address']['country'] == 'JP'
