import { afterEach, expect, it, vi } from 'vitest';
import { authenticatedApiFetch } from '../src/services/apiFetch';
import { billingApi, openStripe } from '../src/services/billingApi';
vi.mock('../src/services/apiFetch', () => ({ authenticatedApiFetch: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('sends only plan, action, or checkout identifiers through the authenticated API', async () => {
  vi.mocked(authenticatedApiFetch).mockImplementation(async () => new Response(JSON.stringify({ url: 'https://checkout.stripe.com/test' })));
  await billingApi.checkout('creator'); await billingApi.portal('cancel'); await billingApi.sync('cs_test');
  const calls = vi.mocked(authenticatedApiFetch).mock.calls;
  expect(calls.map(([url]) => new URL(url).pathname)).toEqual(['/billing/checkout', '/billing/portal', '/billing/sync']);
  expect(calls.map(([, args]) => JSON.parse(String(args?.body)))).toEqual([{ plan_key: 'creator' }, { action: 'cancel' }, { session_id: 'cs_test' }]);
  expect(calls.every(([, args]) => args?.method === 'POST')).toBe(true);
  await billingApi.account(); await billingApi.plans();
  expect(vi.mocked(authenticatedApiFetch).mock.calls.slice(3).map(([, args]) => args)).toEqual([{}, {}]);
});

it('preserves useful errors and restricts external payment redirects to Stripe HTTPS hosts', async () => {
  vi.mocked(authenticatedApiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Sign in to manage your subscription.' }), { status: 401 }));
  await expect(billingApi.account()).rejects.toThrow('Sign in');
  const assign = vi.fn(); vi.stubGlobal('window', { location: { assign } });
  for (const url of ['javascript:alert(1)', 'http://billing.stripe.com/test', 'https://checkout.stripe.com.attacker.test/test']) {
    expect(() => openStripe(url)).toThrow();
  }
  expect(assign).not.toHaveBeenCalled();
  openStripe('https://billing.stripe.com/test');
  expect(assign).toHaveBeenCalledWith('https://billing.stripe.com/test');
});
