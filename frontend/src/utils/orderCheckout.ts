import type { GetPriceResponse } from '../services/getPriceApi';

export type OrderQuote = Pick<GetPriceResponse, 'total_price' | 'total_weight'> &
  Partial<Pick<GetPriceResponse, 'total_parts' | 'unique_part_types'>>;

export function getOrderPricing(quote?: OrderQuote | null) {
  if (!quote || !Number.isFinite(quote.total_price) || quote.total_price <= 0 ||
      !Number.isFinite(quote.total_weight) || quote.total_weight < 0) return null;
  // Preserve the existing kit discount and shipping calculation.
  const fullShippingCents = Math.round(quote.total_weight * 1800 + 400);
  const fullPartSubtotalCents = Math.max(Math.round(quote.total_price * 100) - fullShippingCents, 0);
  const partSubtotalCents = Math.round(fullPartSubtotalCents * 0.5);
  const shippingCents = Math.round(fullShippingCents * 0.5);
  return {
    partSubtotalCents, shippingCents, totalCents: partSubtotalCents + shippingCents,
    fullPartSubtotalCents, fullShippingCents,
    fullTotalCents: fullPartSubtotalCents + fullShippingCents,
  };
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
