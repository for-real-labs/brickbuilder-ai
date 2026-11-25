import { authenticatedApiFetch } from './apiFetch';

export const GOOGLE_SUBSCRIPTION_TEST_CODE = 'googletest';
export const isGoogleSubscriptionTestCode = (value: string) => value.trim().toLowerCase() === GOOGLE_SUBSCRIPTION_TEST_CODE;
export const isGoogleSubscriptionTestSession = (sessionId: string | undefined) => Boolean(sessionId?.startsWith('cs_test_'));

async function sandboxRequest<T>(action: string, body: object): Promise<T> {
  const response = await authenticatedApiFetch(`/stripe-sandbox/subscription/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('The Stripe sandbox is unavailable. Try again.');
  return response.json();
}

export const googleTestSubscription = {
  start: (plan: 'builder' | 'creator', code: string) => sandboxRequest<{ url: string }>('start', { plan, code }),
  confirm: (session_id: string) => sandboxRequest<{ transaction_id?: string }>('confirm', { session_id }),
  reset: () => sandboxRequest<{ reset: boolean }>('reset', {}),
};
