import asyncio
from functools import wraps
from unittest.mock import AsyncMock
from types import SimpleNamespace
import pytest
import stripe
from fastapi import HTTPException
from src.utils import billing, credit_packs, apple_billing

def async_test(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        return asyncio.run(fn(*args, **kwargs))
    return wrapped

USER = '00000000-0000-4000-8000-000000000001'

@async_test
async def test_payment_validation_partial_refund_and_owner(monkeypatch):
    monkeypatch.setattr(billing, 'stripe_key', lambda: 'test')
    monkeypatch.setattr(billing, 'live_mode', lambda: False)
    rpc = AsyncMock(); monkeypatch.setattr(billing, 'rpc', rpc)
    payment = stripe.PaymentIntent.construct_from(dict(id='pi_one',metadata={'integration':credit_packs.TAG,'brickbuilder_user_id':USER,'pack_key':'builder'},
        livemode=False,currency='usd',amount=1080,status='succeeded',latest_charge={'paid':True,'amount_refunded':540}), 'test')
    monkeypatch.setattr(stripe.PaymentIntent, 'retrieve', lambda *a, **k: payment)
    assert await credit_packs.reconcile('pi_one',USER)
    assert rpc.call_args.kwargs['p_granted'] == 400
    with pytest.raises(HTTPException): await credit_packs.reconcile('pi_one','other')
    payment.amount=1
    with pytest.raises(ValueError): await credit_packs.reconcile('pi_one',USER)

@async_test
async def test_unpaid_never_grants(monkeypatch):
    monkeypatch.setattr(billing, 'stripe_key', lambda: 'test')
    monkeypatch.setattr(billing, 'live_mode', lambda: False)
    rpc=AsyncMock(); monkeypatch.setattr(billing,'rpc',rpc)
    monkeypatch.setattr(stripe.PaymentIntent,'retrieve', lambda *a,**k: stripe.PaymentIntent.construct_from(dict(id='pi_one',
        metadata={'integration':credit_packs.TAG,'brickbuilder_user_id':USER,'pack_key':'creator'},
        livemode=False,currency='usd',amount=2280,status='processing'), 'test'))
    assert not await credit_packs.reconcile('pi_one')
    rpc.assert_not_called()

@async_test
async def test_apple_consumables_validate_and_refund_without_subscription(monkeypatch):
    monkeypatch.setattr(billing,'live_mode',lambda:False)
    rpc=AsyncMock(); monkeypatch.setattr(billing,'rpc',rpc)
    tx=SimpleNamespace(bundleId=apple_billing.BUNDLE_ID,environment=apple_billing.Environment.SANDBOX,
        productId='ai.brickbuilder.app.credits.1500',type='Consumable',inAppOwnershipType='PURCHASED',
        transactionId='123',originalTransactionId='123',purchaseDate=1,signedDate=2,expiresDate=None,
        appAccountToken=USER,quantity=1,revocationDate=None)
    assert apple_billing.validate_transaction(tx,USER)==USER
    await apple_billing.apply_transaction(tx,USER)
    assert rpc.call_args.kwargs['p_granted']==1500
    tx.revocationDate=3
    await apple_billing.apply_transaction(tx,USER)
    assert rpc.call_args.kwargs['p_granted']==0
    tx.quantity=2
    with pytest.raises(HTTPException): apple_billing.validate_transaction(tx,USER)


@async_test
async def test_dispute_reversal_restores_verified_payment(monkeypatch):
    monkeypatch.setattr(billing, 'stripe_key', lambda: 'test')
    monkeypatch.setattr(billing, 'live_mode', lambda: False)
    rpc = AsyncMock(); monkeypatch.setattr(billing, 'rpc', rpc)
    payment = stripe.PaymentIntent.construct_from(dict(id='pi_one',metadata={'integration':credit_packs.TAG,'brickbuilder_user_id':USER,'pack_key':'builder'},
        livemode=False,currency='usd',amount=1080,status='succeeded',latest_charge={'paid':True,'amount_refunded':0,'disputed':True}), 'test')
    def retrieve(*args, **kwargs):
        assert kwargs['expand'] == ['latest_charge']
        return payment
    monkeypatch.setattr(stripe.PaymentIntent, 'retrieve', retrieve)
    dispute = SimpleNamespace(status='needs_response')
    monkeypatch.setattr(stripe.Dispute, 'list', lambda **kwargs: SimpleNamespace(data=[dispute]))
    await credit_packs.reconcile('pi_one', USER)
    assert rpc.call_args.kwargs['p_granted'] == 0
    dispute.status='won'
    await credit_packs.reconcile('pi_one', USER)
    assert rpc.call_args.kwargs['p_granted'] == 800


@pytest.mark.parametrize('cents,plan,credits', [(299,'builder',225),(1999,'creator',1500),(1000,'builder',753),(1000,'creator',751),(50,'builder',38),(999999,'builder',752508)])
def test_custom_quotes_match_monthly_rates_rounding_up(cents,plan,credits):
    assert credit_packs.quote(cents,plan)=={'cents':cents,'credits':credits}


@pytest.mark.parametrize('amount', [0,49,1000000,True,2.99,'299'])
def test_custom_quotes_reject_invalid_amounts(amount):
    with pytest.raises(HTTPException): credit_packs.quote(amount,'builder')


@async_test
async def test_custom_checkout_requires_paid_subscription_and_owns_the_quote(monkeypatch):
    from unittest.mock import Mock
    monkeypatch.setattr(billing,'require_enabled',AsyncMock())
    monkeypatch.setattr(billing,'wallet',AsyncMock(return_value={'plan_key':'free','subscription_status':'none'}))
    create=Mock(return_value=SimpleNamespace(url='https://checkout.stripe.com/test'))
    monkeypatch.setattr(stripe.checkout.Session,'create',create)
    identity={'authenticated':True,'user_id':USER}
    with pytest.raises(HTTPException,match='paid monthly plan') as error:
        await credit_packs.checkout(identity,1000)
    assert error.value.status_code==403
    create.assert_not_called()
    monkeypatch.setattr(billing,'wallet',AsyncMock(return_value={'plan_key':'builder','subscription_status':'active','period_end':'2099-01-01T00:00:00Z'}))
    monkeypatch.setattr(billing,'capacity',AsyncMock(return_value={'checkout_available':True}))
    monkeypatch.setattr(billing,'stripe_key',lambda:'test')
    await credit_packs.checkout(identity,1000)
    args=create.call_args.kwargs
    assert args['line_items'][0]['price_data']['unit_amount']==1000
    assert args['line_items'][0]['price_data']['product_data']['name']=='BrickBuilder 753 credits'
    assert args['metadata']==args['payment_intent_data']['metadata']
    assert args['metadata']['rate_key']=='builder'


@async_test
async def test_custom_payment_refund_reconciles_the_original_quote_after_subscription_ends(monkeypatch):
    monkeypatch.setattr(billing,'stripe_key',lambda:'test')
    monkeypatch.setattr(billing,'live_mode',lambda:False)
    rpc=AsyncMock(); monkeypatch.setattr(billing,'rpc',rpc)
    payment=stripe.PaymentIntent.construct_from(dict(id='pi_custom',metadata={
        'integration':credit_packs.TAG,'brickbuilder_user_id':USER,'pack_key':'custom',
        'amount_cents':'1000','rate_key':'builder','pricing_version':'monthly_v4'},
        livemode=False,currency='usd',amount=1000,status='succeeded',latest_charge={'paid':True,'amount_refunded':500}), 'test')
    monkeypatch.setattr(stripe.PaymentIntent,'retrieve',lambda *a,**k:payment)
    assert await credit_packs.reconcile('pi_custom')
    assert rpc.call_args.kwargs['p_granted']==376
    assert rpc.call_args.kwargs['p_pack']=='custom'
    payment.amount=999
    with pytest.raises(ValueError): await credit_packs.reconcile('pi_custom')


def test_checkout_request_accepts_only_integer_cents():
    from pydantic import ValidationError
    from src.requests.billing import CreditPackRequest
    assert CreditPackRequest(amount_cents=1000).amount_cents==1000
    for amount in [True,49,1000000,100.5,'1000']:
        with pytest.raises(ValidationError): CreditPackRequest(amount_cents=amount)
    with pytest.raises(ValidationError): CreditPackRequest(amount_cents=1000,rate_key='creator',credits=5000)


@async_test
async def test_apple_credit_prepare_rejects_free_accounts(monkeypatch):
    monkeypatch.setattr(billing,'require_enabled',AsyncMock())
    monkeypatch.setattr(billing,'capacity',AsyncMock(return_value={'checkout_available':True}))
    monkeypatch.setattr(apple_billing,'ready',lambda:True)
    monkeypatch.setattr(billing,'wallet',AsyncMock(return_value={'plan_key':'free','subscription_status':'none'}))
    with pytest.raises(HTTPException,match='paid monthly plan') as error:
        await apple_billing.prepare({'authenticated':True,'user_id':USER},consumable=True)
    assert error.value.status_code==403


@async_test
async def test_embedded_credit_checkout_keeps_quote_and_return_on_site(monkeypatch):
    from unittest.mock import Mock
    monkeypatch.setattr(billing,'require_enabled',AsyncMock())
    monkeypatch.setattr(billing,'wallet',AsyncMock(return_value={'plan_key':'builder','subscription_status':'active','period_end':'2099-01-01T00:00:00Z'}))
    monkeypatch.setattr(billing,'capacity',AsyncMock(return_value={'checkout_available':True}))
    monkeypatch.setattr(billing,'stripe_key',lambda:'test')
    create=Mock(return_value=SimpleNamespace(id='cs_credits',client_secret='secret'))
    monkeypatch.setattr(stripe.checkout.Session,'create',create)
    result = await credit_packs.checkout({'authenticated':True,'user_id':USER,'user_email':'buyer@example.test'},1000,'elements')
    assert result == {'session_id':'cs_credits','client_secret':'secret'}
    args=create.call_args.kwargs
    assert args['mode']=='payment' and args['ui_mode']=='elements'
    assert args['allowed_payment_method_types']==['card']
    assert args['stripe_version']=='2026-09-30.endive'
    assert args['customer_email']=='buyer@example.test'
    assert args['return_url'].endswith('/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}')
    assert not {'success_url','cancel_url','shipping_address_collection'} & args.keys()
    assert args['line_items'][0]['price_data']['unit_amount']==1000
