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
