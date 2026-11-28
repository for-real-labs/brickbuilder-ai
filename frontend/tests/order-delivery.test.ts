import { describe, expect, it } from 'vitest';
import shippingCountries from '../src/data/shippingCountries.json';
import transitDays from '../src/data/brickwithTransitDays.json';
import { getEstimatedArrival } from '../src/utils/orderDelivery';

const displayRange = (country: string, date: string) =>
  getEstimatedArrival(country, new Date(date))?.dates.replaceAll(/\s/g, ' ');

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

  it('counts warehouse weekdays and carrier calendar days', () => {
    expect(displayRange('US', '2026-11-19T15:59:00Z')).toBe('Nov 27 – Dec 6');
    expect(displayRange('US', '2026-11-19T16:00:00Z')).toBe('Nov 30 – Dec 7');
  });

  it('applies the Black Friday extension through the last warehouse day of the period', () => {
    expect(displayRange('US', '2026-11-27T23:20:55Z')).toBe('Dec 16 – 28');
    expect(displayRange('US', '2026-12-09T15:59:00Z')).toBe('Dec 28, 2026 – Jan 9, 2027');
    expect(displayRange('US', '2026-12-09T16:00:00Z')).toBe('Dec 18 – 27');
  });

  it('includes warehouse holidays and the Christmas and Chinese New Year extensions', () => {
    expect(displayRange('US', '2026-12-28T10:00:00Z')).toBe('Jan 15 – 29');
    expect(displayRange('US', '2027-02-01T10:00:00Z')).toBe('Mar 3 – 26');
  });

  it('leaves the window empty for destinations without a reported quote', () => {
    expect(getEstimatedArrival('AQ')).toBeNull();
    expect(getEstimatedArrival('toString')).toBeNull();
  });
});
