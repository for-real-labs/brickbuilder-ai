import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { HelmetProvider } from 'react-helmet-async';
import { afterEach, expect, it, vi } from 'vitest';
import { stripeSandboxResponse } from '../stripeSandbox';
import StripeSandbox from '../src/pages/StripeSandbox';

const site = 'https://brickbuilder.ai';
const path = '/stripe-sandbox';
const token = 'a'.repeat(64);
const passcode = 'sandbox-test-passcode-only';
const origin = 'https://sandbox-example.trycloudflare.com';
const config = { STRIPE_SANDBOX_ORIGIN: origin, STRIPE_SANDBOX_ACCESS_TOKEN: token, STRIPE_SANDBOX_PASSCODE: passcode };

function login(value: string) {
  return stripeSandboxResponse(new Request(`${site}${path}/access`, {
    method: 'POST', headers: { origin: site, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ passcode: value }).toString(),
  }), config);
}

async function authorizedCookie() {
  return (await login(passcode))?.headers.get('set-cookie')?.split(';')[0] ?? '';
}

afterEach(() => vi.unstubAllGlobals());

it('requires the passcode and issues a scoped cookie that contains neither secret', async () => {
  const prompt = await stripeSandboxResponse(new Request(`${site}${path}?access=${token}`), config);
  expect(await prompt?.text()).toContain('Sandbox passcode');
  expect(prompt?.headers.get('set-cookie')).toBeNull();
  const denied = await login('incorrect');
  expect(denied?.status).toBe(401);
  expect(denied?.headers.get('set-cookie')).toBeNull();
  const response = await login(passcode);
  expect(response?.status).toBe(303);
  expect(response?.headers.get('location')).toBe(path);
  expect(response?.headers.get('set-cookie')).toContain(`Path=${path}; HttpOnly; Secure; SameSite=Lax`);
  expect(response?.headers.get('set-cookie')).not.toContain(token);
  expect(response?.headers.get('set-cookie')).not.toContain(passcode);
});

it('keeps the route disabled without configuration and rejects requests without the sandbox cookie', async () => {
  const request = new Request(`${site}${path}/checkout`, { method: 'POST' });
  expect((await stripeSandboxResponse(request, {}))?.status).toBe(404);
  expect((await stripeSandboxResponse(request, config))?.status).toBe(404);
  expect(await stripeSandboxResponse(new Request(`${site}/billing`), config)).toBeUndefined();
});

it('proxies only sandbox credentials and rejects a live Stripe checkout URL', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ url: 'https://checkout.stripe.com/g/pay/cs_live_abc' }));
  vi.stubGlobal('fetch', fetcher);
  const response = await stripeSandboxResponse(new Request(`${site}${path}/checkout`, {
    method: 'POST', headers: { origin: site, cookie: `production_session=private; ${await authorizedCookie()}` },
  }), config);
  expect(response?.status).toBe(503);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${origin}/checkout`, expect.objectContaining({
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }));
});

it('returns a verified test invoice ID and rejects live checkout IDs before reaching the sandbox', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ subscription_transaction_id: 'in_test', other: 'hidden' }));
  vi.stubGlobal('fetch', fetcher);
  const cookie = await authorizedCookie();
  const request = (sessionId: string) => new Request(`${site}${path}/sync?session_id=${sessionId}`, {
    method: 'POST', headers: { origin: site, cookie },
  });
  expect((await stripeSandboxResponse(request('cs_live_abc'), config))?.status).toBe(400);
  const result = await stripeSandboxResponse(request('cs_test_abc'), config);
  expect(await result?.json()).toEqual({ transaction_id: 'in_test' });
  expect(fetcher).toHaveBeenCalledOnce();
});

it('uses the production data-layer event on return from the Stripe test checkout', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const dataLayer: unknown[] = [];
  vi.stubGlobal('dataLayer', dataLayer);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ transaction_id: 'in_test' })));
  const previous = window.location.href;
  window.history.replaceState(null, '', `${path}/billing?checkout=success&session_id=cs_test_abc`);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HelmetProvider><StripeSandbox /></HelmetProvider>));
    expect(dataLayer).toEqual([{ event: 'subscription_confirmed', transaction_id: 'in_test' }]);
    expect(window.location.search).toBe('');
    expect(container.textContent).toContain('Stripe confirmed the test payment.');
  } finally {
    act(() => root.unmount());
    window.history.replaceState(null, '', previous);
  }
});
