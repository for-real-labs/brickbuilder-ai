import { describe, expect, it } from 'vitest';
import { creditPurchaseCents, purchasedCredits } from '../src/utils/creditPurchase';

describe('custom credit purchase quotes', () => {
  it.each([['0.50',50],['2.99',299],['19.99',1999],['10',1000],['0.5',50],['9999.99',999999]])('parses %s without fractional cents', (amount, cents) => {
    expect(creditPurchaseCents(String(amount))).toBe(cents);
  });
  it.each(['', '-1', '0.49', '10000', '1.999', 'NaN', 'Infinity', '1e3'])('rejects invalid dollar amount %s', amount => {
    expect(creditPurchaseCents(amount)).toBeNull();
  });
  it('matches the monthly prices and rounds up only fractional credits', () => {
    expect(purchasedCredits(299,'builder')).toBe(225);
    expect(purchasedCredits(1999,'creator')).toBe(1500);
    expect(purchasedCredits(1000,'builder')).toBe(753);
    expect(purchasedCredits(1000,'creator')).toBe(751);
    expect(purchasedCredits(50,'builder')).toBe(38);
  });
});
