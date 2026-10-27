"""One-time credit purchases; amounts and fulfillment are server owned."""
import asyncio
import time
from uuid import UUID

import stripe
from fastapi import HTTPException
from . import billing

PACKS = {
    'builder': {'key': 'builder', 'credits': 800, 'cents': 1080},
    'creator': {'key': 'creator', 'credits': 1500, 'cents': 2280},
}
TAG = 'brickbuilder_credit_pack_v1'
APPLE_PRODUCTS = {f'ai.brickbuilder.app.credits.{p["credits"]}': p for p in PACKS.values()}


async def checkout(identity, pack_key):
    owner = billing.account_id(identity)
    await billing.require_enabled()
    if pack_key not in PACKS:
        raise HTTPException(400, 'Choose a credit pack.')
    if not (await billing.capacity())['checkout_available']:
        raise HTTPException(503, 'Credit purchases are temporarily unavailable.')
    pack = PACKS[pack_key]
    metadata = {'integration': TAG, 'brickbuilder_user_id': owner, 'pack_key': pack_key}
    session = await asyncio.to_thread(stripe.checkout.Session.create,
        mode='payment', client_reference_id=owner, payment_method_types=['card'],
        line_items=[{'price_data': {'currency': 'usd', 'unit_amount': pack['cents'],
            'product_data': {'name': f'BrickBuilder {pack["credits"]} credits'}}, 'quantity': 1}],
        metadata=metadata, payment_intent_data={'metadata': metadata},
        success_url=billing.site_url()+'/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}',
        cancel_url=billing.site_url()+'/billing', api_key=billing.stripe_key())
    return {'url': session.url}


async def reconcile(payment_id, owner=None):
    version = time.time_ns() // 1000000
    payment = await asyncio.to_thread(stripe.PaymentIntent.retrieve, payment_id,
        expand=['latest_charge.dispute'], api_key=billing.stripe_key())
    meta = payment.get('metadata') or {}
    if meta.get('integration') != TAG:
        return False
    user = str(UUID(meta['brickbuilder_user_id']))
    if owner and user != owner:
        raise HTTPException(403, 'This purchase belongs to another account.')
    pack = PACKS.get(meta.get('pack_key'))
    if (not pack or payment.get('livemode') is not billing.live_mode()
            or payment.get('currency') != 'usd' or payment.get('amount') != pack['cents']):
        raise ValueError('Invalid credit payment')
    charge = payment.get('latest_charge') or {}
    if payment.get('status') != 'succeeded' or not charge.get('paid'):
        return False
    refunded = charge.get('amount_refunded', 0)
    dispute = charge.get('dispute') or {}
    disputed = charge.get('disputed') and (not isinstance(dispute, dict) or dispute.get('status') != 'won')
    remaining = 0 if disputed else pack['credits'] * max(0, pack['cents']-refunded) // pack['cents']
    await billing.rpc('billing_apply_credit_pack', p_user_id=user, p_live=billing.live_mode(),
        p_transaction='stripe:'+payment.id, p_pack=meta['pack_key'], p_version=version,
        p_granted=remaining)
    return True


async def event(event):
    obj = event.data.object
    if event.type.startswith('checkout.session.') and (obj.get('metadata') or {}).get('integration') == TAG:
        if event.get('livemode') is not billing.live_mode():
            raise ValueError('Credit payment mode mismatch')
        if obj.get('payment_intent'):
            await reconcile(billing.object_id(obj['payment_intent']))
        return True
    if event.type in ('charge.refunded', 'charge.dispute.created', 'charge.dispute.closed'):
        payment = billing.object_id(obj.get('payment_intent'))
        if payment:
            return await reconcile(payment)
    return False
