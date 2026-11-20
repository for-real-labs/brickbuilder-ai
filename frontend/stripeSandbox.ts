const PREFIX = '/stripe-sandbox';
const ACCESS_COOKIE = 'brickbuilder_stripe_sandbox';
const CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\/g\/pay\/cs_test_[A-Za-z0-9]+(?:#[^\s]*)?$/;

function reply(status: number, data: object): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
}

export async function stripeSandboxResponse(request: Request, env: NodeJS.ProcessEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.hostname !== 'brickbuilder.ai' || (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`))) return;

  const origin = env.STRIPE_SANDBOX_ORIGIN;
  const token = env.STRIPE_SANDBOX_ACCESS_TOKEN;
  if (!origin || !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin) || !token || !/^[a-f0-9]{48,}$/.test(token)) {
    return reply(404, { error: 'Sandbox unavailable.' });
  }

  const path = url.pathname.slice(PREFIX.length);
  if (request.method === 'GET' && path === '' && url.searchParams.get('access') === token) {
    url.searchParams.delete('access');
    return new Response(null, { status: 303, headers: {
      Location: url.pathname + url.search, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Set-Cookie': `${ACCESS_COOKIE}=${token}; Path=${PREFIX}; HttpOnly; Secure; SameSite=Lax; Max-Age=14400`,
    } });
  }

  const allowed = request.headers.get('cookie')?.split(';').some(part => part.trim() === `${ACCESS_COOKIE}=${token}`);
  if (!allowed) return reply(404, { error: 'Sandbox unavailable.' });
  if (request.method === 'GET' && ['', '/billing', '/pricing'].includes(path)) return;
  if (request.method !== 'POST' || request.headers.get('origin') !== url.origin || !['/checkout', '/sync'].includes(path)) {
    return reply(404, { error: 'Sandbox unavailable.' });
  }

  try {
    let sessionId: string | null = null;
    if (path === '/sync') {
      sessionId = url.searchParams.get('session_id');
      if (!sessionId || !/^cs_test_[A-Za-z0-9]{1,150}$/.test(sessionId)) return reply(400, { error: 'Invalid test checkout.' });
    }
    const upstream = await fetch(origin + path, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionId ? { session_id: sessionId } : {}),
    });
    if (!upstream.ok) return reply(503, { error: 'The sandbox could not complete this request.' });
    const data = await upstream.json();
    if (path === '/checkout' && typeof data.url === 'string' && CHECKOUT_URL.test(data.url)) return reply(200, { url: data.url });
    if (path === '/sync') {
      const id = data.subscription_transaction_id;
      return reply(200, typeof id === 'string' && /^in_[A-Za-z0-9]+$/.test(id) ? { transaction_id: id } : {});
    }
  } catch { /* Return the same error for an unavailable or invalid sandbox response. */ }
  return reply(503, { error: 'The sandbox could not complete this request.' });
}
