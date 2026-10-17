const AUTH_PATH = '/__preview-auth';
const AUTH_COOKIE = 'brickbuilder_preview_auth';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function isProtectedDeployment(environment: NodeJS.ProcessEnv): boolean {
  return environment.VERCEL === '1' && environment.VERCEL_ENV !== 'production'
    && environment.VERCEL_GIT_COMMIT_REF !== 'main';
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getCookie(request: Request, name: string): string | undefined {
  const cookies = request.headers.get('cookie');
  if (!cookies) {
    return undefined;
  }

  for (const cookie of cookies.split(';')) {
    const separator = cookie.indexOf('=');
    if (separator === -1) {
      continue;
    }

    if (cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }

  return undefined;
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return difference === 0;
}

function safeReturnTo(value: string | null): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function loginPage(error?: string, returnTo = '/'): Response {
  const errorMessage = error
    ? `<p class="error" role="alert">${error}</p>`
    : '<p class="hint">Enter the preview password to continue.</p>';

  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>Preview Access</title>
    <style>
      * { box-sizing: border-box; }
      body {
        align-items: center;
        background: linear-gradient(145deg, #f8fafc, #e2e8f0);
        color: #0f172a;
        display: flex;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
        padding: 24px;
      }
      main {
        background: #fff;
        border: 1px solid #cbd5e1;
        border-radius: 16px;
        box-shadow: 0 20px 45px rgb(15 23 42 / 12%);
        max-width: 420px;
        padding: 32px;
        width: 100%;
      }
      h1 { font-size: 1.75rem; margin: 0 0 8px; }
      p { color: #475569; line-height: 1.5; margin: 0 0 24px; }
      .error { color: #b91c1c; }
      label { display: block; font-size: 0.875rem; font-weight: 650; margin-bottom: 8px; }
      input {
        border: 1px solid #94a3b8;
        border-radius: 8px;
        font: inherit;
        padding: 12px;
        width: 100%;
      }
      input:focus { border-color: #2563eb; outline: 3px solid rgb(37 99 235 / 18%); }
      button {
        background: #2563eb;
        border: 0;
        border-radius: 8px;
        color: #fff;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
        margin-top: 16px;
        padding: 12px 16px;
        width: 100%;
      }
      button:hover { background: #1d4ed8; }
      @media (max-width: 480px) {
        body { padding: 16px; }
        main { padding: 24px; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Preview Access</h1>
      ${errorMessage}
      <form action="${AUTH_PATH}?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}" method="post">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
        <button type="submit">View preview</button>
      </form>
    </main>
  </body>
</html>`,
    {
      status: error ? 401 : 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      },
    },
  );
}

export default async function middleware(request: Request): Promise<Response | undefined> {
  if (!isProtectedDeployment(process.env)) {
    return undefined;
  }

  const password = process.env.PREVIEW_PASSWORD;
  if (!password) {
    return new Response('Preview access is not configured.', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const expectedToken = await digest(password);
  const suppliedToken = getCookie(request, AUTH_COOKIE);
  if (suppliedToken && timingSafeEqual(suppliedToken, expectedToken)) {
    return undefined;
  }

  const url = new URL(request.url);
  if (url.pathname !== AUTH_PATH || request.method !== 'POST') {
    return loginPage(undefined, `${url.pathname}${url.search}`);
  }

  const form = await request.formData();
  const submittedPassword = form.get('password');
  const submittedToken =
    typeof submittedPassword === 'string' ? await digest(submittedPassword) : '';

  if (!timingSafeEqual(submittedToken, expectedToken)) {
    return loginPage('Incorrect password. Please try again.', url.searchParams.get('returnTo') || '/');
  }

  return new Response(null, {
    status: 303,
    headers: {
      'Cache-Control': 'no-store',
      Location: new URL(safeReturnTo(url.searchParams.get('returnTo')), request.url).toString(),
      'Set-Cookie': `${AUTH_COOKIE}=${expectedToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    },
  });
}

export const config = {
  matcher: '/(.*)',
};
