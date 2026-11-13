"""Branded purchase confirmations using the same Resend sender as kit orders."""
import asyncio
import os
from html import escape

import httpx
import stripe

SENT_KEY = 'brickbuilder_confirmation_email'


def purchase_email_content(kind, label, credits, amount_cents, reference):
    """Render only verified, server-owned purchase values; never processor links."""
    plan = kind == 'plan'
    heading = 'Your plan is ready!' if plan else 'Your credits are ready!'
    summary = (f'Your {label} plan is active, with {credits:,} credits each month.' if plan
               else f'Your purchase of {credits:,} credits is confirmed.')
    details = ('Your plan renews monthly until canceled. Manage your subscription in My billing.' if plan
               else 'These are one-time credits. This purchase does not create another subscription.')
    amount = f'${amount_cents / 100:,.2f} USD'
    subject = 'Your BrickBuilder Plan Confirmation' if plan else 'Your BrickBuilder Credit Purchase Confirmation'
    html = f'''<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{heading}</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;">
<tr><td align="center" style="padding:0 0 24px;font-size:30px;font-weight:800;"><span style="color:#f44336;">BRICK</span>BUILDER</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e2e8f0;border-top:6px solid #f44336;border-radius:16px;padding:28px 20px;">
<p style="color:#f44336;font-size:12px;font-weight:bold;letter-spacing:2px;">LET’S BUILD SOMETHING GREAT</p>
<h1 style="font-size:28px;line-height:1.2;">{heading}</h1>
<p style="font-size:16px;line-height:1.7;color:#475569;">{escape(summary)}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;border-radius:12px;"><tr><td style="padding:16px;">
<strong>{escape(label)}</strong><p>Amount paid: {amount}</p><p style="font-size:13px;overflow-wrap:anywhere;">Reference: {escape(reference)}</p></td></tr></table>
<p style="font-size:15px;line-height:1.6;color:#475569;">{details}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" bgcolor="#f44336" style="border-radius:8px;"><a href="https://brickbuilder.ai/" style="display:block;padding:16px 12px;color:#ffffff;text-decoration:none;font-weight:bold;">Start building</a></td></tr></table>
<p style="text-align:center;"><a href="https://brickbuilder.ai/billing" style="color:#f44336;">View My billing</a></p>
<p style="color:#475569;line-height:1.6;">Happy building!<br>The BrickBuilder Team</p>
</td></tr><tr><td align="center" style="padding:24px 12px;color:#64748b;font-size:13px;line-height:1.7;">Need a hand?<br><a href="mailto:support@brickbuilder.ai" style="color:#f44336;">support@brickbuilder.ai</a></td></tr>
</table></td></tr></table></body></html>'''
    return {'subject': subject, 'html': html,
            'text': f'{heading}\n\n{summary}\nAmount paid: {amount}\nReference: {reference}\n\n{details}\n\nStart building: https://brickbuilder.ai/\nMy billing: https://brickbuilder.ai/billing\n\nHappy building!\nThe BrickBuilder Team\nSupport: support@brickbuilder.ai',
            'reply_to': 'support@brickbuilder.ai'}


async def send_confirmation(resource, purchase, email, *, api_key, kind, label, credits, amount_cents,
                            transport=None):
    """Persist delivery on the purchase; Resend also deduplicates concurrent retries.

    Failures propagate so Stripe retries the webhook after fulfillment (which is
    independently idempotent). Never send from account reads or refund events.
    """
    if (purchase.get('metadata') or {}).get(SENT_KEY):
        return
    if not email:
        raise ValueError('Purchase confirmation recipient is missing')
    resend_key = os.environ['RESEND_API_KEY']
    payload = {'from': 'BrickBuilder <no-reply@info.brickbuilder.ai>', 'to': [email],
               **purchase_email_content(kind, label, credits, amount_cents, purchase['id'])}
    async with httpx.AsyncClient(transport=transport, timeout=20) as http:
        response = await http.post('https://api.resend.com/emails', json=payload,
            headers={'Authorization': 'Bearer ' + resend_key,
                     'Idempotency-Key': 'purchase-confirmation/' + purchase['id']})
    # Avoid leaking response bodies or recipient addresses into webhook logs.
    if not response.is_success:
        raise RuntimeError(f'Purchase confirmation delivery failed ({response.status_code})')
    provider_id = response.json().get('id')
    if not provider_id:
        raise RuntimeError('Purchase confirmation delivery was not acknowledged')
    await asyncio.to_thread(resource.modify, purchase['id'],
        metadata={SENT_KEY: provider_id}, api_key=api_key)


async def send_plan_confirmation(receipt):
    invoice = receipt['invoice']
    if invoice.get('billing_reason') != 'subscription_create':
        return
    if invoice.get('currency') != 'usd' or type(invoice.get('amount_paid')) is not int:
        raise ValueError('Unexpected plan confirmation amount')
    from .billing import stripe_key
    plan = receipt['plan']
    await send_confirmation(stripe.Invoice, invoice, invoice.get('customer_email'),
        api_key=stripe_key(), kind='plan', label=plan['name'], credits=plan['credits'],
        amount_cents=invoice['amount_paid'])
