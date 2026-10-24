import type { GetPriceResponse } from '../services/getPriceApi';

export type OrderQuote = Pick<GetPriceResponse, 'total_price' | 'total_weight'> &
  Partial<Pick<GetPriceResponse, 'total_parts' | 'unique_part_types'>>;

export function getOrderPricing(quote?: OrderQuote | null) {
  if (!quote || !Number.isFinite(quote.total_price) || quote.total_price <= 0 ||
      !Number.isFinite(quote.total_weight) || quote.total_weight < 0) return null;
  const shippingCents = Math.round(quote.total_weight * 1800 + 400);
  const partSubtotalCents = Math.max(Math.round(quote.total_price * 100) - shippingCents, 0);
  return { partSubtotalCents, shippingCents, totalCents: partSubtotalCents + shippingCents };
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
