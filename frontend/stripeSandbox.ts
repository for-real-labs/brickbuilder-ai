const PREFIX = '/stripe-sandbox';
const ACCESS_COOKIE = 'brickbuilder_stripe_sandbox';
const CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\/g\/pay\/cs_test_[A-Za-z0-9]+(?:#[^\s]*)?$/;

function reply(status: number, data: object): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
}

function passcodePage(invalid = false): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>BrickBuilder Stripe sandbox</title>
<style>body{font:1rem system-ui,sans-serif;color:#171717;margin:0}main{max-width:28rem;margin:12vh auto;padding:0 1.25rem}label,input{display:block}input,button{box-sizing:border-box;font:inherit;padding:.7rem;margin-top:.5rem}input{width:100%}button{background:#bc2525;color:#fff;border:0;border-radius:.4rem;cursor:pointer}</style>
</head><body><main><h1>Stripe sandbox</h1><form method="post" action="${PREFIX}/access">
<label for="passcode">Sandbox passcode</label><input id="passcode" name="passcode" type="password" required maxlength="128" autocomplete="current-password">
${invalid ? '<p role="alert">That passcode did not match.</p>' : ''}<button>Open sandbox</button>
</form></main></body></html>`, { status: invalid ? 401 : 200, headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  } });
}

async function sessionValue(token: string, passcode: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ACCESS_COOKIE}:${token}:${passcode}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function stripeSandboxResponse(request: Request, env: NodeJS.ProcessEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.hostname !== 'brickbuilder.ai' || (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`))) return;

  const origin = env.STRIPE_SANDBOX_ORIGIN;
  const token = env.STRIPE_SANDBOX_ACCESS_TOKEN;
  const passcode = env.STRIPE_SANDBOX_PASSCODE;
  if (!origin || !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin) || !token || !/^[a-f0-9]{48,}$/.test(token)
      || !passcode || !/^[A-Za-z0-9_-]{20,128}$/.test(passcode)) {
    return reply(404, { error: 'Sandbox unavailable.' });
  }

  const path = url.pathname.slice(PREFIX.length);
  const session = await sessionValue(token, passcode);
  if (request.method === 'POST' && path === '/access' && request.headers.get('origin') === url.origin) {
    if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return passcodePage(true);
    const form = new URLSearchParams(await request.text());
    if (form.get('passcode') !== passcode) return passcodePage(true);
    return new Response(null, { status: 303, headers: {
      Location: PREFIX, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Set-Cookie': `${ACCESS_COOKIE}=${session}; Path=${PREFIX}; HttpOnly; Secure; SameSite=Lax; Max-Age=14400`,
    } });
  }

  const allowed = request.headers.get('cookie')?.split(';').some(part => part.trim() === `${ACCESS_COOKIE}=${session}`);
  if (!allowed) return request.method === 'GET' && path === '' ? passcodePage() : reply(404, { error: 'Sandbox unavailable.' });
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
