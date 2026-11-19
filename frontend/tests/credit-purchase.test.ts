import { expect, it } from 'vitest';
import { CREDIT_PACKS, creditPackSavings, findCreditPack } from '../src/utils/creditPurchase';

it('offers only the three fixed credit packs at the agreed prices', () => {
  expect(CREDIT_PACKS.map(({ credits, cents }) => [credits, cents])).toEqual([
    [100, 199], [500, 999], [1200, 1999],
  ]);
  expect(findCreditPack('500')).toEqual({ key: '500', cents: 999, credits: 500 });
  expect(findCreditPack('800')).toBeUndefined();
});

it('rounds savings per credit against the smallest pack to the nearest whole percent', () => {
  const base = CREDIT_PACKS[0];
  expect(CREDIT_PACKS.map(pack => creditPackSavings(pack.credits, pack.cents, base.credits, base.cents))).toEqual([0, 0, 16]);
  expect(creditPackSavings(500, 7.99, 100, 1.99)).toBe(20);
  expect(creditPackSavings(500, 7.99, 100, 0)).toBe(0);
  expect(creditPackSavings(500, 99.99, 100, 1.99)).toBe(0);
});
