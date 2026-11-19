import { expect, it } from 'vitest';
import { CREDIT_PACKS, creditPackSavings, findCreditPack } from '../src/utils/creditPurchase';

it('offers only the two fixed credit packs at the agreed prices', () => {
  expect(CREDIT_PACKS.map(({ credits, cents }) => [credits, cents])).toEqual([
    [100, 199], [600, 999],
  ]);
  expect(findCreditPack('600')).toEqual({ key: '600', cents: 999, credits: 600 });
  expect(findCreditPack('800')).toBeUndefined();
});

it('rounds savings per credit against the smallest pack to the nearest whole percent', () => {
  const base = CREDIT_PACKS[0];
  expect(CREDIT_PACKS.map(pack => creditPackSavings(pack.credits, pack.cents, base.credits, base.cents))).toEqual([0, 16]);
  expect(creditPackSavings(600, 7.99, 100, 1.99)).toBe(33);
  expect(creditPackSavings(600, 7.99, 100, 0)).toBe(0);
  expect(creditPackSavings(600, 99.99, 100, 1.99)).toBe(0);
});
