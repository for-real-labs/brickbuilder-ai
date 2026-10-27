import { isAppleApp } from './applePurchases';
import { authenticatedApiFetch } from './apiFetch';
import { readApiError } from './apiError';

export type PlanKey = 'free' | 'builder' | 'creator' | 'master';
export type PaidFeature = 'ldraw' | 'io' | 'instructions';
export type FeatureAccess = 'loading' | 'unavailable' | 'locked' | 'allowed';
export interface CreditPlan { key: PlanKey; name: string; monthly_cents: number; credits: number }
export interface BillingAccount {
  subscription_provider?: 'apple' | 'stripe' | null; apple_remaining?: number; apple_plan?: PlanKey; apple_expires_at?: string;
  plan_key: PlanKey; credits_remaining: number; monthly_credits: number; monthly_remaining: number;
  bonus_remaining: number; bonus_available?: number; available?: boolean; checkout_available?: boolean; period_start: string; period_end: string; subscription_status: string;
  cancel_at_period_end: boolean; has_subscription: boolean; enabled: boolean; paid_features?: boolean;
  ordered_instruction_models?: string[];
  history: { id: number; kind: string; amount: number; bucket: string; created_at: string }[];
}
export const INITIAL_PLANS: CreditPlan[] = [
  { key: 'free', name: 'Free', monthly_cents: 0, credits: 300 },
  { key: 'builder', name: 'Builder', monthly_cents: 900, credits: 800 },
  { key: 'creator', name: 'Creator', monthly_cents: 1900, credits: 1500 },
];
export const LEGACY_MASTER_PLAN: CreditPlan = { key: 'master', name: 'Master Builder', monthly_cents: 3900, credits: 1000 };
const mode = import.meta.env.VITE_API_MODE || 'local';
const base = mode === 'local' ? import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002'
  : mode === 'railway_staging' ? import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app'
  : import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';

async function request<T>(path: string, body?: object): Promise<T> {
  const response = await authenticatedApiFetch(`${base}/billing/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}
export const billingApi = {
  plans: () => request<{ plans: CreditPlan[]; apple_ready?: boolean; enabled: boolean; ready?: boolean; available?: boolean; checkout_available?: boolean }>('plans'),
  account: () => request<BillingAccount>('account'),
  applePrepare: () => request<{ app_account_token: string }>('apple/prepare', {}),
  appleSync: (transaction_id: string) => request<BillingAccount>('apple/sync', { transaction_id }),
  checkout: (plan_key: PlanKey) => isAppleApp() ? Promise.reject(new Error('Use Apple subscriptions in the iOS app.')) : request<{ url: string }>('checkout', { plan_key }),
  portal: (action: 'manage' | 'cancel') => request<{ url: string }>('portal', { action }),
  sync: (session_id?: string) => request<BillingAccount>('sync', { session_id }),
};

export function openStripe(url: string) {
  if (isAppleApp()) throw new Error('Manage web subscriptions on the BrickBuilder website.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['checkout.stripe.com', 'billing.stripe.com'].includes(parsed.hostname)) {
    throw new Error('Unable to open secure billing. Please try again.');
  }
  window.location.assign(url);
}
