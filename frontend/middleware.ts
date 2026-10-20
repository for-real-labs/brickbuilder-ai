const AUTH_PATH = '/__preview-auth';
const AUTH_COOKIE = 'brickbuilder_preview_auth';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const MODEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_IMAGE_PATH = /^\/share-image\/([0-9a-f-]{36})\.png$/i;
const PREVIEW_STORAGE_HOST = 'smzdytfghwslpbqnwdov.supabase.co';

function backendBase(): string | undefined {
  return process.env.VERCEL_ENV === 'preview'
    ? process.env.VITE_RAILWAY_API_URL_STAGING || process.env.VITE_RAILWAY_API_URL
    : process.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"'<>]/g, character => ({ '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' })[character]!);
}

function setMeta(document: string, attribute: 'name' | 'property', key: string, value: string): string {
  const expression = new RegExp(`<meta\\b[^>]*${attribute}="${key}"[^>]*>`, 'i');
  const tag = `<meta ${attribute}="${key}" content="${escapeAttribute(value)}" />`;
  return expression.test(document) ? document.replace(expression, tag) : document.replace('</head>', `${tag}</head>`);
}

function modelDocument(shell: string, name: string, image: string, url: string): string {
  const title = `Check out my model: ${name}`;
  const description = `See my ${name} brick model, made with BrickBuilder AI.`;
  let document = shell.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeAttribute(title)}</title>`);
  for (const [attribute, key, value] of [
    ['name', 'title', title], ['name', 'description', description],
    ['property', 'og:title', title], ['property', 'og:description', description],
    ['property', 'og:image', image], ['property', 'og:url', url],
    ['name', 'twitter:title', title], ['name', 'twitter:description', description],
    ['name', 'twitter:image', image], ['name', 'twitter:url', url],
  ] as const) document = setMeta(document, attribute, key, value);
  return document.replace(/<link\b[^>]*rel="canonical"[^>]*>/i, `<link rel="canonical" href="${escapeAttribute(url)}" />`);
}

async function loadShareModel(id: string): Promise<{ name?: unknown; preview_image_url?: unknown } | undefined> {
  const backend = backendBase();
  if (!backend) return undefined;
  try {
    const generationUrl = `${backend.replace(/\/$/, '')}/generation/${encodeURIComponent(id)}`;
    let result = await fetch(`${generationUrl}/share-preview`, {
      signal: AbortSignal.timeout(4000),
    });
    // Railway may still be rolling out the smaller card endpoint after Vercel deploys.
    // The existing model read is public for completed builds and keeps the card live.
    const legacy = result.status === 404;
    if (legacy) result = await fetch(generationUrl, { signal: AbortSignal.timeout(4000) });
    if (!result.ok) return undefined;
    const model = await result.json() as { name?: unknown; preview_image_url?: unknown; status?: unknown; endpoint?: unknown };
    if (legacy && (model.status !== 'completed' || model.endpoint === 'uploadLdraw')) return undefined;
    return model;
  } catch {
    return undefined;
  }
}

async function modelShareResponse(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (request.method !== 'GET') return undefined;
  const imageMatch = SHARE_IMAGE_PATH.exec(url.pathname);
  const id = imageMatch?.[1] || url.searchParams.get('id');
  if (!id || !MODEL_ID.test(id)) return undefined;
  if (!imageMatch && !['/', '/generated-model'].includes(url.pathname)) return undefined;
  const model = await loadShareModel(id);
  if (!model || typeof model.preview_image_url !== 'string') return undefined;
  try {
    const imageUrl = new URL(model.preview_image_url);
    if (imageUrl.protocol !== 'https:') return undefined;
    const isHostedPreview = imageUrl.hostname === PREVIEW_STORAGE_HOST && imageUrl.pathname.endsWith('.png');
    if (imageMatch) {
      if (!isHostedPreview) return undefined;
      const backend = backendBase();
      let cardResponse: Response | undefined;
      try {
        if (backend) cardResponse = await fetch(`${backend.replace(/\/$/, '')}/generation/${encodeURIComponent(id)}/share-card.png`, {
          signal: AbortSignal.timeout(10000),
        });
      } catch { /* A raw preview is still available if the card service is unavailable. */ }
      const branded = Boolean(cardResponse?.ok && cardResponse.headers.get('content-type')?.split(';')[0] === 'image/png');
      const imageResponse = branded
        ? cardResponse!
        : await fetch(imageUrl.href, { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!imageResponse.ok || imageResponse.headers.get('content-type')?.split(';')[0] !== 'image/png') return undefined;
      if (Number(imageResponse.headers.get('content-length') || 0) > 10_000_000) return undefined;
      const bytes = await imageResponse.arrayBuffer();
      if (bytes.byteLength > 10_000_000) return undefined;
      return new Response(bytes, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': branded ? 'public, s-maxage=3600, stale-while-revalidate=86400' : 'public, s-maxage=30' },
      });
    }
    const shellUrl = new URL('/share-shell.html', request.url);
    const shellResponse = await fetch(shellUrl, { headers: { cookie: request.headers.get('cookie') || '' }, signal: AbortSignal.timeout(4000) });
    if (!shellResponse.ok) return undefined;
    const shell = await shellResponse.text();
    const name = typeof model.name === 'string' && model.name.trim() ? model.name.trim().slice(0, 90) : 'Generated model';
    const canonical = url.pathname === '/generated-model'
      ? `https://brickbuilder.ai/generated-model?id=${encodeURIComponent(id)}&exact=1&card=3`
      : `https://brickbuilder.ai/?id=${encodeURIComponent(id)}`;
    const image = isHostedPreview
      ? `https://brickbuilder.ai/share-image/${id}.png?card=3&v=${encodeURIComponent(imageUrl.pathname.split('/').at(-1) || 'preview')}`
      : imageUrl.href;
    return new Response(modelDocument(shell, name, image, canonical), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' },
    });
  } catch {
    return undefined;
  }
}

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
    return modelShareResponse(request);
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
    return modelShareResponse(request);
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
