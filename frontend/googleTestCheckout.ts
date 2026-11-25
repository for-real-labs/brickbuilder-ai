const PREFIX = '/stripe-sandbox/subscription/';
const MARKER = 'brickbuilder_google_test_user';
const TEST_SESSION = /^cs_test_[a-zA-Z0-9]{1,150}$/;
const TEST_CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\/g\/pay\/cs_test_[a-zA-Z0-9]+(?:#[^\s]*)?$/;

function json(status: number, data: object): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
}

export async function googleTestCheckoutResponse(request: Request, env: NodeJS.ProcessEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.hostname !== 'brickbuilder.ai' || !url.pathname.startsWith(PREFIX)) return;
  const action = url.pathname.slice(PREFIX.length);
  if (request.method !== 'POST' || request.headers.get('origin') !== url.origin || !['start', 'confirm', 'reset'].includes(action)) {
    return json(404, { error: 'Sandbox unavailable.' });
  }

  const key = env.GOOGLE_TEST_STRIPE_KEY;
  const customer = env.GOOGLE_TEST_STRIPE_CUSTOMER;
  const owner = env.GOOGLE_TEST_USER_ID;
  const authorization = request.headers.get('authorization');
  if (!key || !/^(rk|sk)_test_/.test(key) || !customer || !/^cus_[a-zA-Z0-9]+$/.test(customer) || !owner || !authorization?.startsWith('Bearer ')
      || !env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) return json(404, { error: 'Sandbox unavailable.' });

  const stripe = async (path: string, method = 'GET', fields?: URLSearchParams) => {
    const response = await fetch(`https://api.stripe.com/v1${path}`, {
      method, body: fields, redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': '2025-07-30.basil' },
    });
    if (!response.ok) throw new Error('Stripe Sandbox request failed');
    return response.json();
  };

  try {
    const auth = await fetch(new URL('/auth/v1/user', env.VITE_SUPABASE_URL), {
      headers: { Authorization: authorization, apikey: env.VITE_SUPABASE_ANON_KEY }, redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!auth.ok || (await auth.json()).id !== owner) return json(404, { error: 'Sandbox unavailable.' });
    if (action === 'start') {
      const { code, plan } = await request.json();
      if (typeof code !== 'string' || code.trim().toLowerCase() !== 'googletest' || !['builder', 'creator'].includes(plan)) {
        return json(400, { error: 'Enter a valid subscription test code.' });
      }
      const prices = await stripe(`/prices?active=true&limit=2&lookup_keys%5B%5D=brickbuilder_${plan}_monthly_v4`);
      const price = prices.data?.[0];
      if (prices.data?.length !== 1 || price?.livemode !== false || price.currency !== 'usd' || price.recurring?.interval !== 'month') {
        return json(503, { error: 'The sandbox plan is unavailable.' });
      }
      const checkout = await stripe('/checkout/sessions', 'POST', new URLSearchParams({
        mode: 'subscription', customer, 'line_items[0][price]': price.id, 'line_items[0][quantity]': '1',
        'payment_method_types[0]': 'card', [`metadata[${MARKER}]`]: owner, [`subscription_data[metadata][${MARKER}]`]: owner,
        success_url: `${url.origin}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${url.origin}/checkout-plan?plan=${plan}&test=1`,
      }));
      if (checkout.livemode === false && TEST_SESSION.test(checkout.id) && typeof checkout.url === 'string' && TEST_CHECKOUT_URL.test(checkout.url)) {
        return json(200, { url: checkout.url });
      }
    }

    if (action === 'confirm') {
      const { session_id: id } = await request.json();
      if (typeof id !== 'string' || !TEST_SESSION.test(id)) return json(400, { error: 'Invalid Stripe test session.' });
      const checkout = await stripe(`/checkout/sessions/${id}?expand%5B%5D=invoice`);
      if (checkout.livemode !== false || checkout.mode !== 'subscription' || checkout.customer !== customer || checkout.metadata?.[MARKER] !== owner) {
        return json(404, { error: 'Sandbox checkout not found.' });
      }
      const invoice = checkout.invoice;
      if (checkout.status === 'complete' && checkout.payment_status === 'paid' && invoice?.livemode === false
          && invoice.status === 'paid' && invoice.billing_reason === 'subscription_create' && invoice.amount_paid > 0 && /^in_[a-zA-Z0-9]+$/.test(invoice.id)) {
        return json(200, { transaction_id: invoice.id });
      }
      return json(200, {});
    }

    if (action === 'reset') {
      const [sessions, subscriptions] = await Promise.all([
        stripe(`/checkout/sessions?customer=${customer}&status=open&limit=100`),
        stripe(`/subscriptions?customer=${customer}&status=all&limit=100`),
      ]);
      const owned = (item: { livemode: boolean; customer: string; metadata?: Record<string, string> }) =>
        item.livemode === false && item.customer === customer && item.metadata?.[MARKER] === owner;
      for (const session of sessions.data.filter(owned)) await stripe(`/checkout/sessions/${session.id}/expire`, 'POST');
      for (const subscription of subscriptions.data.filter(owned)) {
        if (!['canceled', 'incomplete_expired'].includes(subscription.status)) await stripe(`/subscriptions/${subscription.id}`, 'DELETE');
      }
      return json(200, { reset: true });
    }
  } catch { /* An unavailable upstream must not fall back to live checkout. */ }
  return json(503, { error: 'The Stripe sandbox is temporarily unavailable.' });
}
