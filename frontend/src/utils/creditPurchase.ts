import type { PlanKey } from '../services/billingApi';

export function creditPurchaseCents(amount: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) return null;
  const [dollars, fraction = ''] = amount.split('.');
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents >= 50 && cents <= 999999 ? cents : null;
}

export function purchasedCredits(cents: number, plan: PlanKey = 'builder'): number {
  const [credits, price] = plan === 'creator' || plan === 'master' ? [1500, 1999] : [225, 299];
  return Math.ceil(cents * credits / price);
}
