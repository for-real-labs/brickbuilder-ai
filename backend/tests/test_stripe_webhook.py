import asyncio
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlparse
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
import stripe

from src.requests import stripeWebhook as webhook
from src.utils.instruction_links import instruction_key_hash


class EmailLinks(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.links = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.links.append(dict(attrs).get('href'))


@pytest.fixture(autouse=True)
def stripe_configuration(monkeypatch):
    monkeypatch.setenv('API_MODE', 'local')
    monkeypatch.setenv('STRIPE_SECRET_KEY', 'test-secret')
    monkeypatch.setenv('STRIPE_SECRET_KEY_LIVE', 'live-secret')
    monkeypatch.setattr(webhook.stripe, 'api_key', None)


@pytest.mark.parametrize('selected,expected', [('true', True), ('false', False), (None, False)])
def test_paid_order_saves_postcard_choice_and_instructions_link(monkeypatch, selected, expected):
    metadata = {'generationId': 'g/123'}
    if selected is not None:
        metadata['shipInstructionsPostcard'] = selected
    session = stripe.StripeObject.construct_from({
        'id': 'cs', 'metadata': metadata, 'payment_status': 'paid', 'amount_total': 2500, 'payment_intent': 'pi',
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
    else:
        assert 'instructions_postcard_size' not in info
    assert 'instructions_url' not in info
    customer_links = EmailLinks(send.call_args_list[0].args[0]['html']).links
    instructions = next(url for url in customer_links if parse_qs(urlparse(url).query).get('instructions') == ['1'])
    key = parse_qs(urlparse(instructions).fragment)['access'][0]
    assert instruction_key_hash(key) == save.call_args.kwargs['instructions_key_hash']
    assert key not in str(save.call_args)
    owner_message = send.call_args.args[0]['html']
    assert instructions in EmailLinks(owner_message).links
    assert any(urlparse(url).path == '/order' and parse_qs(urlparse(url).fragment) == {'access': [key]}
               for url in EmailLinks(owner_message).links)
    assert ('Include 6 × 4 inch QR instructions postcard' if expected else 'Not requested') in owner_message


@pytest.mark.parametrize('expanded', [True, False])
@pytest.mark.parametrize('mode,key', [('production', 'live-secret'), ('local', 'test-secret')])
def test_international_payment_intent_shipping_reaches_the_paid_order(monkeypatch, expanded, mode, key):
    monkeypatch.setenv('API_MODE', mode)
    shipping = {'name': 'Builder', 'address': {'line1': '123 Main', 'city': 'Flying Fish Cove', 'postal_code': '6798', 'country': 'CX'}}
    intent = stripe.StripeObject.construct_from({'id': 'pi', 'shipping': shipping}, None)
    session = stripe.StripeObject.construct_from({
        'id': 'cs', 'metadata': {'generationId': 'g', 'shippingAddressProvided': 'true'}, 'payment_status': 'paid', 'amount_total': 2500,
        'payment_intent': intent if expanded else 'pi', 'customer_details': {'email': 'buyer@example.com'},
        'collected_information': None,
    }, None)
    retrieve = Mock(return_value=session)
    monkeypatch.setattr(webhook.stripe.checkout.Session, 'retrieve', retrieve)
    retrieve_intent = Mock(return_value=intent)
    monkeypatch.setattr(webhook.stripe.PaymentIntent, 'retrieve', retrieve_intent)
    save = AsyncMock(return_value='order-1')
    monkeypatch.setattr(webhook, 'generation_storage', SimpleNamespace(update_payment_status=save))
    monkeypatch.setenv('RESEND_API_KEY', 'test-only')
    send = Mock()
    monkeypatch.setattr(webhook.resend.Emails, 'send', send)
    asyncio.run(webhook.handle_checkout_session_completed(session))
    retrieve.assert_called_once_with('cs', expand=['payment_intent'], api_key=key)
    if expanded:
        retrieve_intent.assert_not_called()
    else:
        retrieve_intent.assert_called_once_with('pi', api_key=key)
    assert save.call_args.kwargs['stripe_payment_intent'] == 'pi'
    assert save.call_args.kwargs['shipping_info']['address']['country'] == 'CX'
    assert save.call_args.kwargs['shipping_info']['name'] == 'Builder'
    assert send.call_count == 2
    assert send.call_args_list[0].args[0]['to'] == ['buyer@example.com']
    assert send.call_args_list[1].args[0]['to'] == ['jakejohnson3700@gmail.com']
    assert webhook.stripe.api_key is None


def test_missing_preprovided_address_requires_a_webhook_retry(monkeypatch):
    from fastapi import HTTPException
    session = stripe.StripeObject.construct_from({'id': 'cs', 'metadata': {'shippingAddressProvided': 'true'}, 'payment_status': 'paid', 'payment_intent': {'id': 'pi'}}, None)
    monkeypatch.setattr(webhook.stripe.checkout.Session, 'retrieve', Mock(return_value=session))
    save = AsyncMock()
    monkeypatch.setattr(webhook, 'generation_storage', SimpleNamespace(update_payment_status=save))
    with pytest.raises(HTTPException) as error:
        asyncio.run(webhook.handle_checkout_session_completed(session))
    assert error.value.status_code == 500
    save.assert_not_called()



@pytest.mark.parametrize('mode,key', [('production', 'live-secret'), ('local', 'test-secret')])
def test_shipping_can_be_recovered_from_the_event_after_session_fetch_fails(monkeypatch, mode, key):
    monkeypatch.setenv('API_MODE', mode)
    shipping = {'name': 'Builder', 'address': {'line1': '123 Main', 'city': 'Tokyo', 'postal_code': '100-0001', 'country': 'JP'}}
    session = stripe.StripeObject.construct_from({'id': 'cs', 'metadata': {'generationId': 'g', 'shippingAddressProvided': 'true'}, 'payment_status': 'paid', 'payment_intent': 'pi', 'collected_information': None}, None)
    monkeypatch.setattr(webhook.stripe.checkout.Session, 'retrieve', Mock(side_effect=RuntimeError('Temporary failure')))
    retrieve_intent = Mock(return_value={'id': 'pi', 'shipping': shipping})
    monkeypatch.setattr(webhook.stripe.PaymentIntent, 'retrieve', retrieve_intent)
    save = AsyncMock(return_value='order-1')
    monkeypatch.setattr(webhook, 'generation_storage', SimpleNamespace(update_payment_status=save))
    asyncio.run(webhook.handle_checkout_session_completed(session))
    retrieve_intent.assert_called_once_with('pi', api_key=key)
    assert save.call_args.kwargs['shipping_info']['address']['country'] == 'JP'


@pytest.mark.parametrize('mode,missing_key', [('production', 'STRIPE_SECRET_KEY_LIVE'), ('local', 'STRIPE_SECRET_KEY')])
def test_missing_mode_specific_key_requires_retry_before_order_or_email(monkeypatch, mode, missing_key):
    from fastapi import HTTPException
    monkeypatch.setenv('API_MODE', mode)
    monkeypatch.delenv(missing_key)
    # A stale global key must never substitute for the configured mode's key.
    monkeypatch.setattr(webhook.stripe, 'api_key', 'wrong-mode-secret')
    retrieve = Mock()
    monkeypatch.setattr(webhook.stripe.checkout.Session, 'retrieve', retrieve)
    save = AsyncMock()
    monkeypatch.setattr(webhook, 'generation_storage', SimpleNamespace(update_payment_status=save))
    send = Mock()
    monkeypatch.setattr(webhook.resend.Emails, 'send', send)
    with pytest.raises(HTTPException) as error:
        asyncio.run(webhook.handle_checkout_session_completed(SimpleNamespace(id='cs')))
    assert error.value.status_code == 500
    retrieve.assert_not_called()
    save.assert_not_called()
    send.assert_not_called()


def test_repeated_paid_checkout_sends_each_confirmation_only_once(monkeypatch):
    session = stripe.StripeObject.construct_from({
        'id': 'cs_repeat', 'metadata': {'generationId': 'g'}, 'payment_status': 'paid', 'amount_total': 2017,
        'payment_intent': 'pi_repeat', 'customer_details': {'email': 'buyer@example.com'},
        'collected_information': {'shipping_details': {'name': 'Builder', 'address': {'line1': '123 Main'}}},
    }, None)
    monkeypatch.setattr(webhook.stripe.checkout.Session, 'retrieve', Mock(return_value=session))
    save = AsyncMock(side_effect=[95, None, None])
    monkeypatch.setattr(webhook, 'generation_storage', SimpleNamespace(update_payment_status=save))
    monkeypatch.setenv('RESEND_API_KEY', 'test-only')
    send = Mock()
    monkeypatch.setattr(webhook.resend.Emails, 'send', send)
    for _ in range(3):
        asyncio.run(webhook.handle_checkout_session_completed(session))
    assert save.await_count == 3
    assert send.call_count == 2
    assert send.call_args_list[0].args[0]['to'] == ['buyer@example.com']
    assert send.call_args_list[1].args[0]['to'] == ['jakejohnson3700@gmail.com']
    assert send.call_args_list[1].args[0]['subject'] == 'New Order #95 - $20.17'


@pytest.mark.parametrize('generation_id', ['castle', 'g/123 &instructions=0"<>'])
def test_order_emails_link_to_landing_model_and_instructions_dialog(monkeypatch, generation_id):
    session = stripe.StripeObject.construct_from({
        'id': 'cs_links', 'metadata': {'generationId': generation_id, 'petId': 'nib'}, 'payment_status': 'paid', 'amount_total': 2500,
        'payment_intent': 'pi_links', 'customer_details': {'email': 'buyer@example.com'},
        'collected_information': {'shipping_details': {'name': 'Builder', 'address': {'line1': '123 Main'}}},
    }, None)
    monkeypatch.setattr(webhook.stripe.checkout.Session, 'retrieve', Mock(return_value=session))
    monkeypatch.setattr(webhook, 'generation_storage', SimpleNamespace(update_payment_status=AsyncMock(return_value=95), get_generation=AsyncMock(return_value={'name': 'Castle', 'preview_image_url': 'https://example.com/castle.png'})))
    monkeypatch.setenv('RESEND_API_KEY', 'test-only')
    send = Mock()
    monkeypatch.setattr(webhook.resend.Emails, 'send', send)
    asyncio.run(webhook.handle_checkout_session_completed(session))
    assert send.call_count == 2
    for call, recipient, instructions in zip(send.call_args_list, ['buyer@example.com', 'jakejohnson3700@gmail.com'], [True, False]):
        message = call.args[0]
        assert message['to'] == [recipient]
        if instructions:
            assert '/pets/email/nib.png' in message['html']
            assert 'https://example.com/castle.png' in message['html']
        links = [urlparse(link) for link in EmailLinks(message['html']).links]
        model_links = [link for link in links if link.netloc == 'brickbuilder.ai']
        assert len(model_links) == (2 if instructions else 3)
        assert model_links[0].scheme == 'https'
        assert model_links[0].path == '/'
        expected = {'id': [generation_id], 'exact': ['1']}
        assert parse_qs(model_links[0].query) == expected
        if instructions:
            assert model_links[1].path == '/'
            assert parse_qs(model_links[1].query) == {**expected, 'instructions': ['1']}
            assert len(parse_qs(model_links[1].fragment)['access'][0]) == 43


@pytest.mark.parametrize('payment_status', ['unpaid', 'no_payment_required', None])
def test_unpaid_checkout_cannot_issue_an_order_key_or_confirmation(monkeypatch, payment_status):
    session = stripe.StripeObject.construct_from({'id': 'cs_pending', 'payment_status': payment_status}, None)
    monkeypatch.setattr(webhook.stripe.checkout.Session, 'retrieve', Mock(return_value=session))
    save, send = AsyncMock(), Mock()
    monkeypatch.setattr(webhook, 'generation_storage', SimpleNamespace(update_payment_status=save))
    monkeypatch.setattr(webhook.resend.Emails, 'send', send)
    asyncio.run(webhook.handle_checkout_session_completed(session))
    save.assert_not_called()
    send.assert_not_called()


def test_database_failure_requests_a_stripe_retry_instead_of_losing_order_access(monkeypatch):
    from fastapi import HTTPException
    session = stripe.StripeObject.construct_from({'id': 'cs_db_failure', 'payment_status': 'paid',
                                                  'metadata': {'generationId': 'g'}}, None)
    monkeypatch.setattr(webhook.stripe.checkout.Session, 'retrieve', Mock(return_value=session))
    monkeypatch.setattr(webhook, 'generation_storage', SimpleNamespace(update_payment_status=AsyncMock(side_effect=RuntimeError('database unavailable'))))
    with pytest.raises(HTTPException) as error:
        asyncio.run(webhook.handle_checkout_session_completed(session))
    assert error.value.status_code == 503
