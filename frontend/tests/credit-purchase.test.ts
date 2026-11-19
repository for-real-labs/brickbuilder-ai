import { expect, it } from 'vitest';
import { CREDIT_PACKS, creditPackSavings, findCreditPack } from '../src/utils/creditPurchase';

it('uses fixed packs with prices about 30%, 20%, and 10% above the Builder rate', () => {
  const premiums = CREDIT_PACKS.map(pack => Math.round(100 * (pack.cents / pack.credits / (299 / 225) - 1)));
  expect(premiums).toEqual([30, 20, 10]);
  expect(findCreditPack('626')).toEqual({ key: '626', cents: 999, credits: 626 });
  expect(findCreditPack('800')).toBeUndefined();
});

it('compares each pack to the smallest pack at the actual prices', () => {
  const base = CREDIT_PACKS[0];
  expect(CREDIT_PACKS.map(pack => creditPackSavings(pack.credits, pack.cents, base.credits, base.cents))).toEqual([0, 8, 15]);
  expect(creditPackSavings(626, 7.99, 115, 1.99)).toBe(26);
  expect(creditPackSavings(626, 7.99, 115, 0)).toBe(0);
  expect(creditPackSavings(626, 99.99, 115, 1.99)).toBe(0);
});
