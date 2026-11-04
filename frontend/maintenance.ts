const SIGNUP_PATH = '/__maintenance-alert';
const PIP_ASSETS = new Set(['/pets/pip-building.mp4', '/pets/pip.webp']);
const SIGNUP_URL = 'https://smzdytfghwslpbqnwdov.supabase.co/functions/v1/maintenance-alert';

const messages = {
  saved: 'You’re on the list! We’ll email you when BrickBuilder.ai is back online.',
  invalid: 'Please enter a valid email address.',
  unavailable: 'We couldn’t save your email right now. Please try again.',
} as const;

function maintenancePage(method: string, status = 503, result?: keyof typeof messages): Response {
  const feedback = result ? `<p class="feedback" role="${result === 'saved' ? 'status' : 'alert'}">${messages[result]}</p>` : '';
  return new Response(method === 'HEAD' ? null : `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Maintenance · BrickBuilder.ai</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 20px;
    background: radial-gradient(circle at top, #ffedb6, #fff9ec 65%); color: #252330;
    font: 1rem/1.5 system-ui, sans-serif; }
  main { width: min(100%, 510px); background: #fff; border: 2px solid #272532; border-radius: 26px;
    overflow: hidden; text-align: center; box-shadow: 0 8px 0 #272532; }
  .tape { height: 15px; background: repeating-linear-gradient(135deg,#ffcf43 0 17px,#272532 17px 32px); }
  .content { padding: clamp(20px, 6vw, 38px); }
  .stage { position: relative; display: grid; place-items: center; margin: 0 auto 12px; width: 180px; height: 150px;
    border-radius: 24px; background: #fff4d3; }
  .stage video, .stage img { width: 138px; height: 138px; object-fit: contain; mix-blend-mode: multiply; }
  .stage img { display: none; }
  .prop { position: absolute; font-size: 1.65rem; }
  .tools { bottom: 7px; left: 7px; } .brick { bottom: 7px; right: 7px; }
  .tag { display: inline-block; border-radius: 999px; padding: 4px 12px; background: #fff0bd;
    font-size: .79rem; font-weight: 750; }
  h1 { font-size: clamp(1.6rem, 6vw, 2.35rem); line-height: 1.12; letter-spacing: -.04em; margin: 12px 0; }
  p { margin: 0 0 20px; color: #4b4757; }
  form { display: grid; gap: 8px; text-align: left; }
  label { font-size: .875rem; font-weight: 700; }
  input, button { width: 100%; min-height: 48px; border-radius: 12px; padding: 10px 14px; font: inherit; }
  input { border: 1px solid #787284; }
  button { border: 0; background: #272532; color: #fff; font-weight: 750; cursor: pointer; }
  button:hover { background: #434050; }
  :focus-visible { outline: 3px solid #195aa8; outline-offset: 3px; }
  .feedback { background: #fff4d3; color: #252330; border-radius: 12px; padding: 12px; }
  .feedback:last-child { margin-bottom: 0; }
  @media (prefers-reduced-motion: reduce) { .stage video { display: none; } .stage img { display: block; } }
</style>
</head>
<body>
<main>
  <div class="tape" aria-hidden="true"></div>
  <div class="content">
    <div class="stage" aria-hidden="true">
      <video src="/pets/pip-building.mp4" poster="/pets/pip.webp" autoplay muted loop playsinline></video>
      <img src="/pets/pip.webp" alt="">
      <span class="prop tools">🛠️</span><span class="prop brick">🧱</span>
    </div>
    <span class="tag">🚧 Maintenance in progress</span>
    <h1>BrickBuilder.ai is down for maintenance.</h1>
    ${result === 'saved' ? feedback : `<p>To be notified when it’s back online, please enter your email.</p>
    ${feedback}
    <form method="post" action="${SIGNUP_PATH}">
      <label for="email">Email address</label>
      <input id="email" name="email" type="email" maxlength="254" autocomplete="email" placeholder="you@example.com" required>
      <button type="submit">Notify me</button>
    </form>`}
  </div>
</main>
</body>
</html>`, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      ...(status === 503 ? { 'Retry-After': '3600' } : {}),
    },
  });
}

async function readFormEmail(request: Request): Promise<string> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return '';
  const reader = request.body?.getReader();
  if (!reader) return '';
  const buffer = new Uint8Array(1024);
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const email = new URLSearchParams(new TextDecoder().decode(buffer.subarray(0, length))).get('email')?.trim();
        return email && email.length <= 254 ? email : '';
      }
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

export async function maintenanceResponse(request: Request, url: URL): Promise<Response | undefined> {
  if (PIP_ASSETS.has(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) return undefined;
  if (url.pathname !== SIGNUP_PATH || request.method !== 'POST') return maintenancePage(request.method);
  if (request.headers.get('origin') !== url.origin) return maintenancePage(request.method, 403, 'invalid');

  try {
    const email = await readFormEmail(request);
    if (!email) return maintenancePage(request.method, 400, 'invalid');
    const response = await fetch(SIGNUP_URL, { method: 'POST', body: email, signal: AbortSignal.timeout(8000) });
    if (response.status === 204) return maintenancePage(request.method, 200, 'saved');
    if (response.status === 400) return maintenancePage(request.method, 400, 'invalid');
  } catch {
    // Show a retryable error without logging email addresses.
  }
  return maintenancePage(request.method, 503, 'unavailable');
}
