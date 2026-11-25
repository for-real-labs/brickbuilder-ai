import { afterEach, expect, it, vi } from 'vitest';
import { googleTestCheckoutResponse } from '../googleTestCheckout';

const site = 'https://brickbuilder.ai';
const config = {
  GOOGLE_TEST_STRIPE_KEY: 'rk_test_fixture', GOOGLE_TEST_STRIPE_CUSTOMER: 'cus_test',
  GOOGLE_TEST_USER_ID: 'owner', VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: 'public',
};
const owned = { customer: 'cus_test', livemode: false, metadata: { brickbuilder_google_test_user: 'owner' } };
const request = (action: string, body = {}, origin = site) => new Request(`${site}/stripe-sandbox/subscription/${action}`, {
  method: 'POST', headers: { origin, Authorization: 'Bearer session', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

afterEach(() => vi.unstubAllGlobals());

it('checks the authenticated account before using Stripe and rejects cross-site requests', async () => {
  const mock = vi.fn().mockResolvedValueOnce(Response.json({ id: 'someone-else' }));
  vi.stubGlobal('fetch', mock);
  expect((await googleTestCheckoutResponse(request('reset', {}, 'https://other.test'), config))?.status).toBe(404);
  expect(mock).not.toHaveBeenCalled();
  expect((await googleTestCheckoutResponse(request('reset'), config))?.status).toBe(404);
  expect(mock).toHaveBeenCalledOnce();
});

it('requires a test Stripe key and the exact code before creating a checkout', async () => {
  const mock = vi.fn().mockResolvedValueOnce(Response.json({ id: 'owner' }));
  vi.stubGlobal('fetch', mock);
  expect((await googleTestCheckoutResponse(request('start'), { ...config, GOOGLE_TEST_STRIPE_KEY: 'sk_live_q' }))?.status).toBe(404);
  expect(mock).not.toHaveBeenCalled();
  expect((await googleTestCheckoutResponse(request('start', { plan: 'builder', code: 'wrong' }), config))?.status).toBe(400);
  expect(mock).toHaveBeenCalledOnce();
});

it('uses sandbox plan pricing and returns to normal Billing after checkout', async () => {
  const checkoutUrl = 'https://checkout.stripe.com/g/pay/cs_test_checkout';
  const mock = vi.fn().mockResolvedValueOnce(Response.json({ id: 'owner' }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'price_test_creator', livemode: false, currency: 'usd', recurring: { interval: 'month' } }] }))
    .mockResolvedValueOnce(Response.json({ id: 'cs_test_checkout', url: checkoutUrl, livemode: false }));
  vi.stubGlobal('fetch', mock);
  const result = await googleTestCheckoutResponse(request('start', { plan: 'creator', code: 'googletest' }), config);
  expect(await result?.json()).toEqual({ url: checkoutUrl });
  expect(mock.mock.calls[1][0]).toContain('brickbuilder_creator_monthly_v4');
  const fields = mock.mock.calls[2][1].body as URLSearchParams;
  expect(fields.get('success_url')).toBe(`${site}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  expect(fields.get('cancel_url')).toBe(`${site}/checkout-plan?plan=creator&test=1`);
  expect(fields.get('line_items[0][price]')).toBe('price_test_creator');
});

it.each([['paid', 'subscription_create', 'in_verified'], ['open', 'subscription_create', undefined], ['paid', 'subscription_cycle', undefined]])(
  'only returns the invoice ID for a verified first paid test invoice (%s, %s)',
  async (invoiceStatus, reason, expected) => {
    const mock = vi.fn().mockResolvedValueOnce(Response.json({ id: 'owner' }))
      .mockResolvedValueOnce(Response.json({ ...owned, status: 'complete', mode: 'subscription', payment_status: 'paid',
        invoice: { id: 'in_verified', livemode: false, status: invoiceStatus, billing_reason: reason, amount_paid: 299 },
      }));
    vi.stubGlobal('fetch', mock);
    const result = await googleTestCheckoutResponse(request('confirm', { session_id: 'cs_test_checkout' }), config);
    expect(await result?.json()).toEqual(expected ? { transaction_id: expected } : {});
  },
);

it('expires only owned test checkouts and cancels only owned nonterminal test subscriptions', async () => {
  const mock = vi.fn().mockResolvedValueOnce(Response.json({ id: 'owner' }))
    .mockResolvedValueOnce(Response.json({ data: [{ ...owned, id: 'cs_test_open' }, { ...owned, id: 'cs_live_open', livemode: true }] }))
    .mockResolvedValueOnce(Response.json({ data: [
      { ...owned, id: 'sub_test', status: 'active' }, { ...owned, id: 'sub_past', status: 'canceled' },
      { ...owned, id: 'sub_other', status: 'active', customer: 'cus_other' },
    ] })).mockImplementation(async () => Response.json({}));
  vi.stubGlobal('fetch', mock);
  const result = await googleTestCheckoutResponse(request('reset'), config);
  expect(await result?.json()).toEqual({ reset: true });
  expect(mock.mock.calls.slice(3).map(([url, init]) => [url, init.method])).toEqual([
    ['https://api.stripe.com/v1/checkout/sessions/cs_test_open/expire', 'POST'],
    ['https://api.stripe.com/v1/subscriptions/sub_test', 'DELETE'],
  ]);
});
