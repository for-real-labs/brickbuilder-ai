import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from src.utils import order_pricing as pricing


def test_margin_is_retained_after_member_discount_and_shipping_is_separate():
    regular = pricing.price_order(100, 1)
    member = pricing.price_order(100, 1, member_discount_percent=20)
    assert regular.full_parts_cents == 15625
    assert member.parts_cents == 12500
    assert (member.parts_cents - 10000) / member.parts_cents == .2
    assert member.member_discount_cents == 3125
    assert member.full_total_cents == regular.total_cents
    assert regular.shipping_cents == member.shipping_cents == 2100
    assert member.total_cents == 14600


@pytest.mark.parametrize('weight,cents', [
    (.016, 408), (.16, 641), (.22, 721), (.55, 1344),
    (1.1, 2268), (2.2, 4157), (4.4, 8129),
])
def test_us_shipping_matches_direct_brickwith_standard_quotes(weight, cents):
    assert pricing.price_order(100, weight).shipping_cents == cents


@pytest.mark.parametrize('weight,cents', [(0, 408), (.001, 408), (.088, 525), (.825, 1806), (6.6, 12101)])
def test_us_shipping_interpolates_and_extends_the_measured_weight_curve(weight, cents):
    assert pricing.price_order(100, weight).shipping_cents == cents


def test_shipping_depends_on_weight_not_brick_price_or_membership():
    assert pricing.price_order(3, .22).shipping_cents == pricing.price_order(200, .22, member_discount_percent=20).shipping_cents == 721
    # Crossing a measured weight must never lower the shipping charge.
    weights = [.0159, .016, .0161, .1599, .16, .1601, .2199, .22, .2201,
               .5499, .55, .5501, 1.0999, 1.1, 1.1001, 2.1999, 2.2, 2.2001, 4.3999, 4.4, 4.4001]
    charges = [pricing.price_order(100, weight).shipping_cents for weight in weights]
    assert charges == sorted(charges)


@pytest.mark.parametrize('cost', [.01, .37, 10, 42.11, 107.02, 172.78])
def test_fractional_cent_rounding_never_loses_target_margin(cost):
    quote = pricing.price_order(cost, .1, member_discount_percent=20)
    assert quote.parts_cents >= cost * 100 / .8 - .001
    assert quote.full_parts_cents - quote.member_discount_cents == quote.parts_cents
    assert quote.total_cents == quote.parts_cents + quote.shipping_cents


@pytest.mark.parametrize('cost,weight', [(0, 1), (-1, 1), (float('nan'), 1), (1, -1), (1, float('inf'))])
def test_invalid_costs_cannot_produce_a_charge(cost, weight):
    with pytest.raises(HTTPException): pricing.price_order(cost, weight)


def test_shipping_uses_receipt_calibrated_destination_and_weight():
    assert pricing.price_order(172.78, 2.435116, 'PL').shipping_cents == 6500
    assert pricing.price_order(48.51, .66413, 'GB').shipping_cents == 959
    assert pricing.price_order(56.71, .7719885, 'ES').shipping_cents == 1748
    assert pricing.price_order(100, 1, 'US').shipping_cents != pricing.price_order(100, 1, 'GB').shipping_cents
    assert pricing.price_order(100, 1, 'JP').shipping_estimated
    with pytest.raises(HTTPException): pricing.price_order(1, 1, 'XX')


@pytest.mark.parametrize('identity', [{}, {'authenticated': False}, {'authenticated': True, 'is_anonymous': True},
                                     {'authenticated': True, 'is_developer': True}])
def test_guests_and_developers_cannot_claim_membership(identity, monkeypatch):
    wallet = AsyncMock()
    monkeypatch.setattr(pricing.billing, 'wallet', wallet)
    assert asyncio.run(pricing.get_member_discount_percent(identity)) == 0
    wallet.assert_not_called()


@pytest.mark.parametrize('plan,status,days,apple,expected', [
    ('builder', 'active', 1, False, 10), ('creator', 'active', 1, False, 20),
    ('master', 'active', 1, False, 20), ('builder', 'active', -1, False, 0),
    ('builder', 'canceled', 1, False, 0), ('free', 'none', 1, False, 0),
    ('free', 'none', 1, True, 10), ('free', 'none', -1, True, 0),
])
def test_membership_comes_from_verified_stripe_or_apple_period(plan, status, days, apple, expected, monkeypatch):
    end = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()
    row = dict(plan_key=plan, subscription_status=status, period_end=end,
               apple_plan='builder' if apple else None, apple_expires_at=end if apple else None,
               cancel_at_period_end=True, apple_remaining=1000)
    wallet = AsyncMock(return_value=row)
    monkeypatch.setattr(pricing.billing, 'wallet', wallet)
    identity = {'authenticated': True, 'user_id': '11111111-1111-4111-8111-111111111111', 'plan_key': 'creator'}
    assert asyncio.run(pricing.get_member_discount_percent(identity)) == expected
    wallet.assert_awaited_once_with(identity['user_id'])


def test_entitlement_failure_blocks_quote_instead_of_silently_overcharging(monkeypatch):
    monkeypatch.setattr(pricing.billing, 'wallet', AsyncMock(side_effect=HTTPException(503, 'Unavailable')))
    with pytest.raises(HTTPException):
        asyncio.run(pricing.get_member_discount_percent({'authenticated': True, 'user_id': '11111111-1111-4111-8111-111111111111'}))


def test_builder_and_creator_discounts_use_the_same_regular_price_and_shipping():
    regular = pricing.price_order(100, 1)
    builder = pricing.price_order(100, 1, member_discount_percent=10)
    creator = pricing.price_order(100, 1, member_discount_percent=20)
    assert regular.full_parts_cents == builder.full_parts_cents == creator.full_parts_cents == 15625
    assert builder.parts_cents == 14063
    assert builder.member_discount_cents == 1562
    assert builder.member_discount_percent == 10
    assert creator.parts_cents == 12500 and creator.member_discount_percent == 20
    assert builder.shipping_cents == creator.shipping_cents == regular.shipping_cents


@pytest.mark.parametrize('percent', [-1, 1, 30, True, 10.5, '20'])
def test_invalid_discount_cannot_change_the_order_price(percent):
    with pytest.raises(HTTPException): pricing.price_order(100, 1, member_discount_percent=percent)


@pytest.mark.parametrize('apple_plan,expected', [('builder',10), ('creator',20)])
def test_active_apple_plan_determines_discount_independently_of_free_wallet(monkeypatch,apple_plan,expected):
    end = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    monkeypatch.setattr(pricing.billing,'wallet',AsyncMock(return_value={
        'plan_key':'free','subscription_status':'none','period_end':end,
        'apple_plan':apple_plan,'apple_expires_at':end}))
    assert asyncio.run(pricing.get_member_discount_percent({'authenticated':True,'user_id':'11111111-1111-4111-8111-111111111111'})) == expected
