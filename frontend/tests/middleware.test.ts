import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import middleware from '../middleware';

const originalEnvironment = { ...process.env };

function loginRequest(password: string, returnTo = ''): Request {
  return new Request(`https://example.com/__preview-auth${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(password)}`,
  });
}

describe('preview password middleware', () => {
  beforeEach(() => {
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_REF = 'feature/password-gate';
    process.env.PREVIEW_PASSWORD = 'test-password';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnvironment };
  });

  it('does not run outside Vercel', async () => {
    delete process.env.VERCEL;

    await expect(middleware(new Request('https://example.com/'))).resolves.toBeUndefined();
  });

  it('publishes a complete branded homepage card for link preview crawlers', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain('property="og:image" content="https://brickbuilder.ai/share-card.png"');
    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('property="og:image:height" content="630"');
    expect(html).toContain('property="og:image:alt" content="BrickBuilder AI logo and Pip, the red brick pet"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('name="twitter:image:alt" content="BrickBuilder AI logo and Pip, the red brick pet"');
    const description = html.match(/property="og:description" content="([^"]+)"/)?.[1];
    expect(description?.length).toBeGreaterThanOrEqual(100);
  });

  it('does not run for the main branch', async () => {
    process.env.VERCEL_GIT_COMMIT_REF = 'main';

    await expect(middleware(new Request('https://example.com/'))).resolves.toBeUndefined();
  });

  it.each(['feature/password-gate', undefined])('keeps production public with git ref %s', async branch => {
    process.env.VERCEL_ENV = 'production';
    if (branch) process.env.VERCEL_GIT_COMMIT_REF = branch;
    else delete process.env.VERCEL_GIT_COMMIT_REF;
    delete process.env.PREVIEW_PASSWORD;

    await expect(middleware(new Request('https://brickbuilder.ai/oauth/consent'))).resolves.toBeUndefined();
  });

  it('fails closed when a preview password is not configured', async () => {
    delete process.env.PREVIEW_PASSWORD;

    const response = await middleware(new Request('https://example.com/'));

    expect(response?.status).toBe(503);
  });

  it('shows a password-only form for an unauthenticated preview request', async () => {
    const response = await middleware(new Request('https://example.com/dashboard?change_request=req-1&token_hash=secret'));
    const body = await response?.text();

    expect(response?.status).toBe(200);
    expect(body).toContain('name="password"');
    expect(body).not.toContain('name="username"');
    expect(body).not.toContain('test-password');
    expect(body).toContain(encodeURIComponent('/dashboard?change_request=req-1&token_hash=secret'));
  });

  it('rejects an incorrect password', async () => {
    const response = await middleware(loginRequest('wrong-password'));

    expect(response?.status).toBe(401);
    await expect(response?.text()).resolves.toContain('Incorrect password');
  });

  it('sets a secure cookie after accepting the password', async () => {
    const response = await middleware(loginRequest('test-password', '/?change_request=req-1&token_hash=secret'));

    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe('https://example.com/?change_request=req-1&token_hash=secret');
    expect(response?.headers.get('set-cookie')).toMatch(
      /^brickbuilder_preview_auth=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict;/,
    );
    expect(response?.headers.get('set-cookie')).not.toContain('test-password');
  });

  it('rejects an external return location', async () => {
    const response = await middleware(loginRequest('test-password', '//evil.example/path'));
    expect(response?.headers.get('location')).toBe('https://example.com/');
  });

  it('allows requests with the cookie issued after authentication', async () => {
    const loginResponse = await middleware(loginRequest('test-password'));
    const cookie = loginResponse?.headers.get('set-cookie')?.split(';', 1)[0];

    const response = await middleware(
      new Request('https://example.com/dashboard', {
        headers: { Cookie: cookie ?? '' },
      }),
    );

    expect(response).toBeUndefined();
  });

  it('serves crawler metadata for a completed model at the shared root URL', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.VITE_RAILWAY_API_URL = 'https://api.example.com';
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const shell = '<html><head><title>Home</title><meta property="og:image" content="/old.png" /><meta name="twitter:image" content="/old.png" /><link rel="canonical" href="https://brickbuilder.ai/" /></head><body><div id="root"></div></body></html>';
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Pip & Friends', preview_image_url: 'https://smzdytfghwslpbqnwdov.supabase.co/storage/v1/object/public/models/pip.png' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(shell, { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const response = await middleware(new Request(`https://brickbuilder.ai/?id=${id}&exact=1`));
    const html = await response?.text();
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.example.com/generation/${id}/share-preview`);
    expect(html).toContain('Check out my model: Pip &amp; Friends');
    expect(html).toContain(`property="og:image" content="https://brickbuilder.ai/share-image/${id}.png?card=3&amp;v=pip.png"`);
    expect(html).toContain(`name="twitter:image" content="https://brickbuilder.ai/share-image/${id}.png?card=3&amp;v=pip.png"`);
    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('property="og:image:height" content="630"');
    expect(html).toContain('property="og:image:alt" content="Pip &amp; Friends brick model preview on BrickBuilder AI"');
    expect(html).toContain('name="twitter:image:alt" content="Pip &amp; Friends brick model preview on BrickBuilder AI"');
    expect(html).toContain(`https://brickbuilder.ai/?id=${id}`);
    expect(html).toContain('<div id="root"></div>');
  });

  it.each(['LinkedInBot', 'facebookexternalhit/1.1', 'Twitterbot', 'Slackbot'])('asks %s to retry when the model service is unavailable', async userAgent => {
    process.env.VERCEL_ENV = 'production';
    const id = '123e4567-e89b-12d3-a456-426614174000';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('backend sleeping')));
    const response = await middleware(new Request(`https://brickbuilder.ai/?id=${id}`, { headers: { 'User-Agent': userAgent } }));
    expect(response?.status).toBe(503);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(response?.headers.get('retry-after')).toBe('30');
  });

  it('never serves the app HTML as a model share image', async () => {
    process.env.VERCEL_ENV = 'production';
    const id = '123e4567-e89b-12d3-a456-426614174000';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('backend sleeping')));
    const response = await middleware(new Request(`https://brickbuilder.ai/share-image/${id}.png`));
    expect(response?.status).toBe(503);
    expect(response?.headers.get('cache-control')).toBe('no-store');
  });

  it('uses the static page for invalid IDs and missing previews', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.VITE_RAILWAY_API_URL = 'https://api.example.com';
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: 'Unfinished', preview_image_url: null })));
    vi.stubGlobal('fetch', fetcher);
    await expect(middleware(new Request('https://brickbuilder.ai/?id=invalid'))).resolves.toBeUndefined();
    await expect(middleware(new Request('https://brickbuilder.ai/?id=123e4567-e89b-12d3-a456-426614174000'))).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses the existing public model read while the card endpoint deploys', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.VITE_RAILWAY_API_URL = 'https://api.example.com';
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', endpoint: 'llmToBricks', name: 'Castle', preview_image_url: 'https://images.example.com/castle.png' })))
      .mockResolvedValueOnce(new Response('<html><head><meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" /></head><body></body></html>'));
    vi.stubGlobal('fetch', fetcher);
    const response = await middleware(new Request('https://brickbuilder.ai/?id=123e4567-e89b-12d3-a456-426614174000'));
    const html = await response?.text();
    expect(html).toContain('https://images.example.com/castle.png');
    expect(html).not.toContain('og:image:width');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('serves a public, first-party PNG without upstream crawler restrictions', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.VITE_RAILWAY_API_URL = 'https://api.example.com';
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ preview_image_url: 'https://smzdytfghwslpbqnwdov.supabase.co/storage/v1/object/public/models/pip.png' })))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png', 'X-Robots-Tag': 'none' } }));
    vi.stubGlobal('fetch', fetcher);
    const response = await middleware(new Request(`https://brickbuilder.ai/share-image/${id}.png`));
    expect(response?.headers.get('content-type')).toBe('image/png');
    expect(response?.headers.get('cache-control')).toContain('s-maxage=3600');
    expect(response?.headers.get('x-robots-tag')).toBeNull();
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(fetcher.mock.calls[1][0]).toBe(`https://api.example.com/generation/${id}/share-card.png`);
  });

  it('answers image HEAD probes with PNG headers instead of the app shell', async () => {
    process.env.VERCEL_ENV = 'production';
    const id = '123e4567-e89b-12d3-a456-426614174000';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ preview_image_url: 'https://smzdytfghwslpbqnwdov.supabase.co/storage/pip.png' })))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } })));
    const response = await middleware(new Request(`https://brickbuilder.ai/share-image/${id}.png`, { method: 'HEAD' }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it('briefly caches the raw preview while the branded renderer deploys', async () => {
    process.env.VERCEL_ENV = 'production';
    const id = '123e4567-e89b-12d3-a456-426614174000';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ preview_image_url: 'https://smzdytfghwslpbqnwdov.supabase.co/storage/pip.png' })))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } })));
    const response = await middleware(new Request(`https://brickbuilder.ai/share-image/${id}.png?card=3`));
    expect(response?.headers.get('cache-control')).toBe('public, s-maxage=30');
  });

  it('gives the refreshed share path its own preview URL', async () => {
    process.env.VERCEL_ENV = 'production';
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Cat', preview_image_url: 'https://smzdytfghwslpbqnwdov.supabase.co/storage/cat.png' })))
      .mockResolvedValueOnce(new Response('<html><head></head><body></body></html>'));
    vi.stubGlobal('fetch', fetcher);
    const response = await middleware(new Request(`https://brickbuilder.ai/generated-model?id=${id}&exact=1&card=3`));
    const html = await response?.text();
    expect(html).toContain(`property="og:url" content="https://brickbuilder.ai/generated-model?id=${id}&amp;exact=1&amp;card=3"`);
  });
});
