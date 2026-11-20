import { describe, expect, it } from 'vitest';
import shippingCountries from '../src/data/shippingCountries.json';
import transitDays from '../src/data/brickwithTransitDays.json';
import { getEstimatedArrival } from '../src/utils/orderDelivery';

const displayRange = (country: string, date: string) =>
  getEstimatedArrival(country, new Date(date))?.replaceAll(/\s/g, ' ');

describe('estimated kit delivery', () => {
  it('matches every snapshot entry to a checkout destination and a valid transit window', () => {
    const destinations = new Set(shippingCountries.map(({ code }) => code));
    for (const [code, methods] of Object.entries(transitDays)) {
      expect(destinations.has(code)).toBe(true);
      for (const [from, through] of Object.values(methods)) {
        expect(Number.isInteger(from) && Number.isInteger(through)).toBe(true);
        expect(from).toBeGreaterThan(0);
        expect(through).toBeGreaterThanOrEqual(from);
      }
    }
  });

  it('uses the warehouse date and excludes weekends from fulfillment', () => {
    expect(displayRange('US', '2026-11-19T15:59:00Z')).toBe('Dec 15 – 22');
    expect(displayRange('US', '2026-11-19T16:00:00Z')).toBe('Dec 16 – 23');
  });

  it('includes China public holidays and the supplier holiday processing extension', () => {
    expect(displayRange('US', '2026-12-28T10:00:00Z')).toBe('Feb 2 – 12');
  });

  it('leaves the window empty for destinations without a reported quote', () => {
    expect(getEstimatedArrival('AQ')).toBeNull();
    expect(getEstimatedArrival('toString')).toBeNull();
  });
});
