export const CREDIT_PACKS = [
  { key: '100', credits: 100, cents: 199 },
  { key: '600', credits: 600, cents: 999 },
] as const;

export type CreditPackKey = typeof CREDIT_PACKS[number]['key'];
export type AppleCreditPackKey = CreditPackKey | '800' | '1500';

export const appleCreditProduct = (key: AppleCreditPackKey) => `ai.brickbuilder.app.credits.${key}`;

export function findCreditPack(key: string | null) {
  return CREDIT_PACKS.find(pack => pack.key === key);
}

export function creditPackSavings(credits: number, price: number, baseCredits: number, basePrice: number): number {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(basePrice) || basePrice <= 0) return 0;
  return Math.max(0, Math.round(100 * (1 - (price * baseCredits) / (basePrice * credits))));
}
