import asyncio
import json
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
import stripe

from src.utils import billing, credit_packs, purchase_email


def obj(data):
    return stripe.StripeObject.construct_from(data, None)


def test_confirmation_content_is_branded_and_escapes_values():
    content = purchase_email.purchase_email_content('plan', '<Builder>', 225, 299, '<invoice>')
    assert '&lt;Builder&gt;' in content['html']
    assert '<invoice>' not in content['html']
    assert '$2.99 USD' in content['text']
    assert 'renews monthly' in content['text']
    assert content['reply_to'] == 'support@brickbuilder.ai'
    assert '#f44336' in content['html']
    credits = purchase_email.purchase_email_content('credits', '753 credits', 753, 1000, 'pi_1')
    assert 'one-time' in credits['text']
    assert 'renews monthly' not in credits['text']


@pytest.mark.parametrize('status', [200, 429, 500])
def test_delivery_deduplicates_and_failure_remains_retryable(monkeypatch, status):
    monkeypatch.setenv('RESEND_API_KEY', 'test-key')
    purchase = {'id': 'pi_1', 'metadata': {}}
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(status, json={'id': 'email_1'})
    def mark(identifier, metadata, **kwargs):
        purchase['metadata'].update(metadata)
    resource = Mock()
    resource.modify.side_effect = mark
    async def send():
        await purchase_email.send_confirmation(resource, purchase, 'buyer@example.test',
            api_key='test', kind='credits', label='753 credits', credits=753,
            amount_cents=1000, transport=httpx.MockTransport(handler))
    if status != 200:
        with pytest.raises(RuntimeError, match='delivery failed'):
            asyncio.run(send())
        resource.modify.assert_not_called()
        assert not purchase['metadata']
    else:
        asyncio.run(send())
        asyncio.run(send())
        assert len(requests) == 1
        resource.modify.assert_called_once()
        assert requests[0].headers['Idempotency-Key'] == 'purchase-confirmation/pi_1'
        payload = json.loads(requests[0].content)
        assert payload['from'] == 'BrickBuilder <no-reply@info.brickbuilder.ai>'
        assert payload['to'] == ['buyer@example.test']
        assert payload['reply_to'] == 'support@brickbuilder.ai'


@pytest.mark.parametrize('reason,expected', [('subscription_create', 1), ('subscription_cycle', 0), ('subscription_update', 0)])
def test_only_new_plan_signup_sends_confirmation(monkeypatch, reason, expected):
    send = AsyncMock()
    monkeypatch.setattr(purchase_email, 'send_confirmation', send)
    monkeypatch.setattr(billing, 'stripe_key', lambda: 'test')
    receipt = {'invoice': {'id': 'in_1', 'billing_reason': reason, 'currency': 'usd',
        'amount_paid': 299, 'customer_email': 'buyer@example.test'}, 'plan': billing.PAID_PLANS['builder']}
    asyncio.run(purchase_email.send_plan_confirmation(receipt))
    assert send.await_count == expected


@pytest.mark.parametrize('event_type,expected', [('invoice.paid', 1), ('invoice.payment_failed', 0),
    ('checkout.session.completed', 1), ('checkout.session.async_payment_succeeded', 1), ('customer.subscription.updated', 0)])
def test_plan_email_only_follows_payment_webhooks(monkeypatch, event_type, expected):
    receipt = {'invoice': {'id': 'in_1'}}
    monkeypatch.setattr(billing, 'sync_subscription', AsyncMock(return_value=receipt))
    send = AsyncMock()
    monkeypatch.setattr(purchase_email, 'send_plan_confirmation', send)
    event = obj({'type': event_type, 'livemode': False, 'data': {'object': {
        'id': 'in_1', 'mode': 'subscription', 'subscription': 'sub_1',
        'parent': {'subscription_details': {'subscription': 'sub_1'}}}}})
    monkeypatch.setattr(billing, 'live_mode', lambda: False)
    asyncio.run(billing.handle_billing_event(event))
    assert send.await_count == expected


@pytest.mark.parametrize('status,refund,notify,expected', [('succeeded', 0, True, 1),
    ('processing', 0, True, 0), ('succeeded', 100, True, 0), ('succeeded', 0, False, 0)])
def test_credit_confirmation_requires_paid_unrefunded_webhook(monkeypatch, status, refund, notify, expected):
    user = '00000000-0000-4000-8000-000000000001'
    monkeypatch.setattr(billing, 'stripe_key', lambda: 'test')
    monkeypatch.setattr(billing, 'live_mode', lambda: False)
    grant = AsyncMock()
    monkeypatch.setattr(billing, 'rpc', grant)
    payment = obj({'id': 'pi_1', 'metadata': {'integration': credit_packs.TAG,
        'brickbuilder_user_id': user, 'pack_key': 'builder'}, 'livemode': False,
        'currency': 'usd', 'amount': 1080, 'status': status,
        'latest_charge': {'paid': True, 'amount_refunded': refund}})
    monkeypatch.setattr(stripe.PaymentIntent, 'retrieve', lambda *a, **kw: payment)
    async def after_grant(*args, **kwargs):
        grant.assert_awaited_once()
    send = AsyncMock(side_effect=after_grant)
    monkeypatch.setattr(purchase_email, 'send_confirmation', send)
    asyncio.run(credit_packs.reconcile('pi_1', user,
        confirmation_email='buyer@example.test' if notify else None))
    assert send.await_count == expected


def test_credit_webhook_uses_verified_checkout_recipient(monkeypatch):
    monkeypatch.setattr(billing, 'live_mode', lambda: False)
    monkeypatch.setattr(billing, 'stripe_key', lambda: 'test')
    session = obj({'id': 'cs_1', 'livemode': False, 'payment_intent': 'pi_1',
        'client_reference_id': 'user_1', 'metadata': {'integration': credit_packs.TAG},
        'customer_details': {'email': 'verified@example.test'}})
    monkeypatch.setattr(stripe.checkout.Session, 'retrieve', lambda *a, **kw: session)
    reconcile = AsyncMock()
    monkeypatch.setattr(credit_packs, 'reconcile', reconcile)
    event = obj({'type': 'checkout.session.completed', 'livemode': False,
        'data': {'object': {'id': 'cs_1', 'metadata': {'integration': credit_packs.TAG}}}})
    assert asyncio.run(credit_packs.event(event))
    reconcile.assert_awaited_once_with('pi_1', 'user_1', confirmation_email='verified@example.test')
    session.livemode = True
    with pytest.raises(ValueError, match='mode mismatch'):
        asyncio.run(credit_packs.event(event))
