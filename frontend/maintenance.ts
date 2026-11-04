import { petPosterPath, petVideoSources } from './src/pets';

const SIGNUP_PATH = '/__maintenance-alert';
const BRICKS_SCRIPT = '/assets/maintenance-bricks.js';
const PIP_POSTER = petPosterPath('pip');
const PIP_SOURCES = petVideoSources('pip', 'idle');
const MAINTENANCE_ASSETS = new Set([BRICKS_SCRIPT, PIP_POSTER, ...PIP_SOURCES.map(({ src }) => src)]);
const SIGNUP_URL = 'https://smzdytfghwslpbqnwdov.supabase.co/functions/v1/maintenance-alert';

const messages = {
  saved: 'You’re on the list! We’ll email you when BrickBuilder AI is back online.',
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
<title>Maintenance · BrickBuilder AI</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 16px;
    background: #fbfbfd; color: #0f172a; font: 1rem/1.5 system-ui, sans-serif; }
  canvas, .backdrop { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  canvas { opacity: .25; }
  .backdrop { background: rgb(2 6 23 / 25%); }
  main { position: relative; width: min(100%, 28rem); background: #fff; border: 1px solid #e2e8f0;
    border-radius: 24px; padding: clamp(24px, 6vw, 32px); text-align: center;
    box-shadow: 0 25px 50px -12px rgb(0 0 0 / 25%); }
  .pet { display: block; margin: 0 auto 12px; width: 136px; height: 136px; object-fit: contain; }
  img.pet { display: none; }
  h1 { margin: 0; font-size: 1.5rem; line-height: 1.3; font-weight: 700; letter-spacing: -.025em; }
  .icons { white-space: nowrap; }
  p { margin: 8px 0 0; color: #475569; }
  form { display: grid; gap: 4px; margin-top: 20px; text-align: left; }
  label { font-size: .875rem; font-weight: 500; color: #334155; }
  input, button { width: 100%; min-height: 44px; padding: 8px 12px; font: inherit; }
  input { border-radius: 8px; border: 1px solid #cbd5e1; }
  button { margin-top: 12px; border: 0; border-radius: 12px; background: #f44336;
    color: #0f172a; font-weight: 600; cursor: pointer; }
  button:hover { background: #ff6b6b; }
  :focus-visible { outline: 3px solid #195aa8; outline-offset: 3px; }
  .feedback { background: #f1f5f9; border-radius: 12px; padding: 12px; margin-top: 16px; }
  @media (prefers-reduced-motion: reduce) { video.pet { display: none; } img.pet { display: block; } }
</style>
<script type="module" src="${BRICKS_SCRIPT}"></script>
</head>
<body>
<canvas id="maintenance-bricks" aria-hidden="true"></canvas>
<div class="backdrop" aria-hidden="true"></div>
<main>
    <video class="pet" aria-hidden="true" poster="${PIP_POSTER}" autoplay muted loop playsinline disablepictureinpicture>
      ${PIP_SOURCES.map(({ src, type }) => `<source src="${src}" type='${type}'>`).join('')}
    </video>
    <img class="pet" src="${PIP_POSTER}" alt="">
    <h1>BrickBuilder AI is down for maintenance. <span class="icons" aria-hidden="true">🚧 🛠️</span></h1>
    ${result === 'saved' ? feedback : `<p>To be notified when it’s back online, please enter your email.</p>
    ${feedback}
    <form method="post" action="${SIGNUP_PATH}">
      <label for="email">Email address</label>
      <input id="email" name="email" type="email" maxlength="254" autocomplete="email" placeholder="you@example.com" required>
      <button type="submit">Notify me</button>
    </form>`}
</main>
</body>
</html>`, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src 'self'; media-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
  if (MAINTENANCE_ASSETS.has(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) return undefined;
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
