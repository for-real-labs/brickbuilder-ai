import type { GetPriceResponse } from '../services/getPriceApi';

export type OrderQuote = Pick<GetPriceResponse, 'total_price' | 'total_weight'> &
  Partial<Pick<GetPriceResponse, 'total_parts' | 'unique_part_types' | 'order_pricing'>>;

export function getOrderPricing(quote?: OrderQuote | null) {
  if (!quote || !Number.isFinite(quote.total_price) || quote.total_price <= 0 ||
      !Number.isFinite(quote.total_weight) || quote.total_weight < 0) return null;
  // Cached catalog costs are not retail quotes. Only display the server's
  // destination-specific price with its verified subscription entitlement.
  const price = quote.order_pricing;
  if (!price || ![price.full_parts_cents, price.parts_cents, price.shipping_cents,
    price.member_discount_cents, price.full_total_cents, price.total_cents].every(value => Number.isSafeInteger(value) && value >= 0)
    || price.total_cents <= 0 || price.parts_cents + price.shipping_cents !== price.total_cents
    || price.full_parts_cents - price.member_discount_cents !== price.parts_cents
    || price.full_parts_cents + price.shipping_cents !== price.full_total_cents) return null;
  return { partSubtotalCents: price.parts_cents, shippingCents: price.shipping_cents,
    totalCents: price.total_cents, fullPartSubtotalCents: price.full_parts_cents,
    fullTotalCents: price.full_total_cents, memberDiscountCents: price.member_discount_cents,
    memberDiscountPercent: price.member_discount_percent, shippingCountry: price.shipping_country };
}

export function formatOrderPrice(cents: number) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export type DeliveryDetails = {
  email: string;
  firstName: string;
  lastName: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
};

export function getShippingContact(details: DeliveryDetails, country: string) {
  return {
    name: [details.firstName.trim(), details.lastName.trim()].filter(Boolean).join(' '),
    address: {
      line1: details.line1.trim(), line2: details.line2.trim() || null,
      city: details.city.trim(), state: details.region.trim(),
      postal_code: details.postalCode.trim(), country,
    },
  };
}
