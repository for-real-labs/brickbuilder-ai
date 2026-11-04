"""Retail kit pricing, independent of catalog cost and Stripe promotions."""
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
import json
from pathlib import Path

from fastapi import HTTPException
from pydantic import BaseModel

from . import billing

# Standard-shipping quotes to Chicago, Oct 29, 2026: (parts weight in grams, cents).
# Use exact SKU weights, not the checkout's rounded kg display (100 pins = 16g).
US_SHIPPING_QUOTES = ((16, 408), (160, 641), (220, 721), (550, 1344),
                      (1100, 2268), (2200, 4157), (4400, 8129))
# Other destinations retain receipt-based estimates from Aug 29–Oct 29, 2026.
SHIPPING_RATES = {
    'AU': (400, 1583), 'DE': (400, 1601),
    'ES': (400, 1746), 'GB': (400, 842), 'LT': (400, 1975),
    'PL': (400, 2505),
}
DEFAULT_SHIPPING_RATE = (348, 2037)
COUNTRY_CODES = {row['code'] for row in json.loads(
    (Path(__file__).resolve().parents[1] / 'data/shipping_countries.json').read_text())}
PLAN_DISCOUNT_PERCENT = {'builder': 10, 'creator': 20, 'master': 20}
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


async def get_member_discount_percent(identity: dict) -> int:
    # Free-feature rollouts, purchased credits and developer access do not
    # constitute a paid subscription. Read the account owned by the token.
    if (not identity.get('authenticated') or identity.get('is_anonymous')
            or identity.get('is_developer')):
        return 0
    row = await billing.wallet(billing.account_id(identity))
    if not billing.has_paid_features(row):
        return 0
    plan = billing.effective_plan(row)
    return PLAN_DISCOUNT_PERCENT.get(plan, 0)


def _shipping_cents(weight: Decimal, country: str) -> int:
    if country == 'US':
        grams = weight * 1000
        if grams <= US_SHIPPING_QUOTES[0][0]:
            return US_SHIPPING_QUOTES[0][1]
        # Interpolate measured quotes; above 4.4 kg extend the last segment.
        for (low_weight, low_cost), (high_weight, high_cost) in zip(US_SHIPPING_QUOTES, US_SHIPPING_QUOTES[1:]):
            if grams <= high_weight:
                break
        cents = low_cost + (grams - low_weight) * (high_cost - low_cost) / (high_weight - low_weight)
    else:
        base, per_kg = SHIPPING_RATES.get(country, DEFAULT_SHIPPING_RATE)
        cents = Decimal(base) + weight * per_kg
    return int(cents.to_integral_value(rounding=ROUND_HALF_UP))


def price_order(cost: float, weight: float, country: str = 'US', *, member_discount_percent: int = 0) -> OrderPricing:
    if type(member_discount_percent) is not int or member_discount_percent not in (0, 10, 20):
        raise HTTPException(400, 'Invalid member discount')
    cost, weight = Decimal(str(cost)), Decimal(str(weight))
    if not cost.is_finite() or cost <= 0 or not weight.is_finite() or weight < 0:
        raise HTTPException(400, 'Kit pricing is unavailable')
    if country not in COUNTRY_CODES:
        raise HTTPException(400, 'Unsupported shipping country')
    # cost / (1 - margin), then gross up for the member benefit. Supplier
    # coupons are not assumed: fulfillment savings can vary per purchase.
    member_target = (cost * 100 / (1 - TARGET_BRICK_MARGIN)).to_integral_value(rounding=ROUND_CEILING)
    full_parts = int((member_target / Decimal('0.8')).to_integral_value(rounding=ROUND_CEILING))
    multiplier = Decimal(100 - member_discount_percent) / 100
    parts = int((Decimal(full_parts) * multiplier).to_integral_value(rounding=ROUND_HALF_UP))
    shipping = _shipping_cents(weight, country)
    return OrderPricing(full_parts_cents=full_parts, parts_cents=parts, shipping_cents=shipping,
        member_discount_cents=full_parts-parts, member_discount_percent=member_discount_percent,
        full_total_cents=full_parts+shipping, total_cents=parts+shipping, shipping_country=country)
