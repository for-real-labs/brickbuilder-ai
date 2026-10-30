import type { OrderPricing } from '../../src/services/getPriceApi';

/** A server response fixture; UI tests deliberately do not repeat retail math. */
export function orderPricing(total = 5000, shipping = 580, memberDiscount = 0, country = 'US'): OrderPricing {
  return { full_parts_cents: total - shipping + memberDiscount, parts_cents: total - shipping,
    shipping_cents: shipping, member_discount_cents: memberDiscount,
    member_discount_percent: memberDiscount ? 20 : 0, full_total_cents: total + memberDiscount,
    total_cents: total, shipping_country: country, shipping_estimated: true };
}
