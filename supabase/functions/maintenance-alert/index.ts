const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

async function readEmail(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const buffer = new Uint8Array(254);
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return new TextDecoder().decode(buffer.subarray(0, length)).trim().toLowerCase();
      if (length + value.length > buffer.length) {
        await reader.cancel();
        return '';
      }
      buffer.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

async function captureSignup(): Promise<void> {
  const key = Deno.env.get('POSTHOG_API_KEY');
  if (!key) return;
  try {
    await fetch(new URL('/capture/', Deno.env.get('POSTHOG_HOST') || 'https://us.i.posthog.com'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key, event: 'maintenance_alert_subscribed',
        properties: { distinct_id: crypto.randomUUID(), $geoip_disable: true },
      }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Analytics must not affect the signup.
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const email = await readEmail(request);
  if (!emailPattern.test(email)) return new Response(null, { status: 400 });

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return new Response(null, { status: 503 });
  try {
    const result = await fetch(`${url}/rest/v1/waitlist_emails?on_conflict=email`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ email, maintenance_alert: true }),
      signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) return new Response(null, { status: 503 });
    await captureSignup();
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 503 });
  }
});
