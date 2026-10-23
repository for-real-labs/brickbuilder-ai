import { authenticatedApiFetch } from './apiFetch';
import { readApiError } from './apiError';

export type PlanKey = 'free' | 'builder' | 'creator' | 'master';
export interface CreditPlan { key: PlanKey; name: string; monthly_cents: number; credits: number }
export interface BillingAccount {
  plan_key: PlanKey; credits_remaining: number; monthly_credits: number; monthly_remaining: number;
  bonus_remaining: number; bonus_available?: number; available?: boolean; checkout_available?: boolean; period_start: string; period_end: string; subscription_status: string;
  cancel_at_period_end: boolean; has_subscription: boolean; enabled: boolean;
  history: { id: number; kind: string; amount: number; bucket: string; created_at: string }[];
}
export const INITIAL_PLANS: CreditPlan[] = [
  { key: 'free', name: 'Free', monthly_cents: 0, credits: 5 },
  { key: 'builder', name: 'Builder', monthly_cents: 900, credits: 30 },
  { key: 'creator', name: 'Creator', monthly_cents: 1900, credits: 75 },
  { key: 'master', name: 'Master Builder', monthly_cents: 3900, credits: 180 },
];
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
  plans: () => request<{ plans: CreditPlan[]; enabled: boolean; available?: boolean; checkout_available?: boolean }>('plans'),
  account: () => request<BillingAccount>('account'),
  checkout: (plan_key: PlanKey) => request<{ url: string }>('checkout', { plan_key }),
  portal: (action: 'manage' | 'cancel') => request<{ url: string }>('portal', { action }),
  sync: (session_id?: string) => request<BillingAccount>('sync', { session_id }),
};

export function openStripe(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['checkout.stripe.com', 'billing.stripe.com'].includes(parsed.hostname)) {
    throw new Error('Unable to open secure billing. Please try again.');
  }
  window.location.assign(url);
}
