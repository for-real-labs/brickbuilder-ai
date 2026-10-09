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
        assert info['instructions_url'] == 'https://brickbuilder.ai/instructions?id=g%2F123'
    else:
        assert 'instructions_url' not in info
    owner_message = send.call_args.args[0]['html']
    assert ('Include QR instructions postcard' if expected else 'Not requested') in owner_message
