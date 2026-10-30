"""Retail kit pricing, independent of catalog cost and Stripe promotions."""
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
import json
from pathlib import Path

from fastapi import HTTPException
from pydantic import BaseModel

from . import billing

# Calibrated from matched Brickwith receipts, Aug 29–Oct 29, 2026.
# Country samples outside the US are sparse; these remain estimates, not carrier quotes.
SHIPPING_RATES = {
    'US': (562, 1786), 'AU': (400, 1583), 'DE': (400, 1601),
    'ES': (400, 1746), 'GB': (400, 842), 'LT': (400, 1975),
    'PL': (400, 2505),
}
DEFAULT_SHIPPING_RATE = (348, 2037)
COUNTRY_CODES = {row['code'] for row in json.loads(
    (Path(__file__).resolve().parents[1] / 'data/shipping_countries.json').read_text())}
MEMBER_DISCOUNT_PERCENT = 20
TARGET_BRICK_MARGIN = Decimal('0.20')


class OrderPricing(BaseModel):
    full_parts_cents: int
    parts_cents: int
    shipping_cents: int
    member_discount_cents: int
    member_discount_percent: int
    full_total_cents: int
    total_cents: int
    shipping_country: str
    shipping_estimated: bool = True


async def member_discount_eligible(identity: dict) -> bool:
    # Free-feature rollouts, purchased credits and developer access do not
    # constitute a paid subscription. Read the account owned by the token.
    if (not identity.get('authenticated') or identity.get('is_anonymous')
            or identity.get('is_developer')):
        return False
    return billing.has_paid_features(await billing.wallet(billing.account_id(identity)))


def price_order(cost: float, weight: float, country: str = 'US', *, member: bool = False) -> OrderPricing:
    cost, weight = Decimal(str(cost)), Decimal(str(weight))
    if not cost.is_finite() or cost <= 0 or not weight.is_finite() or weight < 0:
        raise HTTPException(400, 'Kit pricing is unavailable')
    if country not in COUNTRY_CODES:
        raise HTTPException(400, 'Unsupported shipping country')
    # cost / (1 - margin), then gross up for the member benefit. Supplier
    # coupons are not assumed: fulfillment savings can vary per purchase.
    member_target = (cost * 100 / (1 - TARGET_BRICK_MARGIN)).to_integral_value(rounding=ROUND_CEILING)
    full_parts = int((member_target / Decimal('0.8')).to_integral_value(rounding=ROUND_CEILING))
    parts = int((Decimal(full_parts) * Decimal('0.8')).to_integral_value(rounding=ROUND_HALF_UP)) if member else full_parts
    base, per_kg = SHIPPING_RATES.get(country, DEFAULT_SHIPPING_RATE)
    shipping = int((Decimal(base) + weight * per_kg).to_integral_value(rounding=ROUND_HALF_UP))
    return OrderPricing(full_parts_cents=full_parts, parts_cents=parts, shipping_cents=shipping,
        member_discount_cents=full_parts-parts, member_discount_percent=MEMBER_DISCOUNT_PERCENT if member else 0,
        full_total_cents=full_parts+shipping, total_cents=parts+shipping, shipping_country=country)
