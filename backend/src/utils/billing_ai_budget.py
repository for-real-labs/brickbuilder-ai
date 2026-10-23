"""Conservative monthly reservations for short AI calls outside generation jobs.

Only production uses the live wallet. Unknown outcomes retain their reservation;
missing settings or unavailable storage fail closed before a provider request.
"""
import logging
import os
from decimal import Decimal
from uuid import uuid4

from fastapi import HTTPException

from .generation_budget import GenerationBudget, current_generation_usage, input_token_bound

logger = logging.getLogger(__name__)


def upper_bound(payload):
    budget = GenerationBudget(payload['model'])
    inputs = input_token_bound(payload)
    outputs = payload.get('max_output_tokens', payload.get('max_tokens'))
    if not isinstance(outputs, int) or isinstance(outputs, bool) or not 0 < outputs <= 32768:
        raise ValueError('Unbounded auxiliary AI request')
    # Includes cache-write/long-context/fast-mode worst rates. No unbounded tools.
    if payload.get('tools'):
        raise ValueError('Auxiliary AI tools require their own cost limit')
    rates = budget.prices_for_speed(payload.get('speed', 'standard'))
    multiplier = 5 if budget.model == 'claude-haiku-5-5' and inputs > 100000 else 2 if inputs > 272000 else 1
    return (Decimal(inputs) * max(rates[0], rates[3], rates[4]) + Decimal(outputs) * rates[1]) * multiplier / 1000000


async def reserve(payload):
    from .provider_keys import personal_billing_active
    if personal_billing_active():
        return None
    # Local development does not consume the production allowance.
    if os.getenv('API_MODE', 'local') != 'production':
        return None
    from . import billing
    try:
        if not (await billing.settings())['enabled']:
            return None
        usage = current_generation_usage.get()
        if usage is not None:
            from .database import execute_query
            reservation = await execute_query(billing.client().table('billing_ai_reservations')
                .select('reference').eq('reference', usage.generation_id).eq('livemode', True))
            if reservation.data:
                return None
        reference = 'assistant:' + str(uuid4())
        amount = upper_bound(payload)
        if await billing.rpc('billing_reserve_ai', p_reference=reference, p_live=True,
                             p_bucket='assistant', p_amount=str(amount)):
            return reference
    except Exception:
        raise HTTPException(503, 'Your buddy’s AI replies are temporarily unavailable. Your saved models are still available.') from None
    return None


async def settle(reference, payload, result, provider):
    if not reference:
        return
    from . import billing
    try:
        cost = GenerationBudget(payload['model'])
        token = current_generation_usage.set(None)
        try:
            cost.record_usage(result.get('usage'), provider.lower())
        finally:
            current_generation_usage.reset(token)
        await billing.rpc('billing_settle_ai', p_reference=reference, p_live=True, p_amount=str(cost.spent))
    except Exception:
        # Preserve the conservative hold when usage or its persistence is unknown.
        logger.warning('Auxiliary AI usage could not be settled; budget reservation retained')
