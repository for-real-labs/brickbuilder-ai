import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import middleware from '../middleware';

const origin = 'https://brickbuilder.ai';

function signup(email: string, from = origin): Request {
  return new Request(`${origin}/__maintenance-alert`, {
    method: 'POST',
    headers: { Origin: from, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email }).toString(),
  });
}

describe('production maintenance gate', () => {
  beforeEach(() => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('BRICKBUILDER_MAINTENANCE', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(['/', '/generated-model', '/dashboard'])('serves a temporary outage at %s', async path => {
    const response = await middleware(new Request(origin + path));
    expect(response?.status).toBe(503);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(await response?.text()).toContain('BrickBuilder AI is down for maintenance.');
  });

  it('allows only the required Pip assets and supports turning the gate off', async () => {
    const html = await (await middleware(new Request(origin)))?.text();
    expect(html).toContain('id="maintenance-bricks"');
    expect(html).toContain('🚧 🛠️');
    expect(html).not.toContain('Maintenance in progress');
    for (const asset of ['/assets/maintenance-bricks.js', '/pets/christmas-v1/pip-idle-alpha.mov',
      '/pets/christmas-v1/pip-idle-alpha.webm', '/pets/christmas-v1/pip.webp']) {
      expect(html).toContain(asset);
      expect(await middleware(new Request(origin + asset))).toBeUndefined();
    }
    expect((await middleware(new Request(origin + '/assets/app.js')))?.status).toBe(503);
    vi.stubEnv('BRICKBUILDER_MAINTENANCE', 'off');
    expect(await middleware(new Request(origin))).toBeUndefined();
  });

  it('only confirms the subscription after the storage endpoint accepts it', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    const saved = await middleware(signup('builder@example.com'));
    expect(saved?.status).toBe(200);
    expect(await saved?.text()).toContain('You’re on the list!');
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/functions/v1/maintenance-alert'), expect.objectContaining({ body: 'builder@example.com' }));
    const unavailable = await middleware(signup('builder@example.com'));
    expect(unavailable?.status).toBe(503);
    expect(await unavailable?.text()).toContain('Please try again');
  });

  it('rejects cross-origin or oversized submissions without contacting storage', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await middleware(signup('builder@example.com', 'https://example.com')))?.status).toBe(403);
    expect((await middleware(signup('a'.repeat(1100))))?.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
