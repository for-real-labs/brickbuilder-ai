import { describe, expect, it, vi } from 'vitest';
import { handleSubstackFeedRequest } from '../../supabase/functions/_shared/substack-feed.js';

const feedUrl = 'https://writer.substack.com/feed';
const secret = 'test-relay-secret';
const request = (overrides = {}) => new Request('https://project.supabase.co/functions/v1/substack-feed', {
  method: 'GET',
  headers: { 'x-substack-feed-secret': secret },
  ...overrides,
});

describe('Substack feed relay', () => {
  it('returns authenticated public RSS without caching it', async () => {
    const fetchImpl = vi.fn(async () => new Response('<?xml version="1.0"?><rss><channel /></rss>', {
      status: 200,
      headers: { 'content-type': 'application/xml' },
    }));

    const response = await handleSubstackFeedRequest(request(), { secret, feedUrl, fetchImpl });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/rss+xml');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('<rss>');
    expect(fetchImpl).toHaveBeenCalledWith(feedUrl, expect.objectContaining({
      headers: expect.objectContaining({ accept: expect.stringContaining('application/rss+xml') }),
    }));
  });

  it('rejects missing credentials and unsupported methods before fetching', async () => {
    const fetchImpl = vi.fn();
    const unauthorized = await handleSubstackFeedRequest(new Request('https://example.com'), {
      secret, feedUrl, fetchImpl,
    });
    const wrongMethod = await handleSubstackFeedRequest(request({ method: 'POST' }), {
      secret, feedUrl, fetchImpl,
    });

    expect(unauthorized.status).toBe(401);
    expect(wrongMethod.status).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects unsafe configuration and invalid upstream responses', async () => {
    const invalidConfig = await handleSubstackFeedRequest(request(), {
      secret, feedUrl: 'http://metadata.internal/feed', fetchImpl: vi.fn(),
    });
    const blocked = await handleSubstackFeedRequest(request(), {
      secret, feedUrl, fetchImpl: async () => new Response('Forbidden', { status: 403 }),
    });
    const invalidXml = await handleSubstackFeedRequest(request(), {
      secret, feedUrl, fetchImpl: async () => new Response('<html>Challenge</html>', { status: 200 }),
    });

    expect(invalidConfig.status).toBe(503);
    expect(blocked.status).toBe(502);
    expect(invalidXml.status).toBe(502);
  });
});
