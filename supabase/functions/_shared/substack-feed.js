function secretsMatch(expected, received) {
  if (!expected || !received) return false;
  const length = Math.max(expected.length, received.length);
  let mismatch = expected.length ^ received.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (expected.charCodeAt(index) || 0) ^ (received.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function jsonError(error, status) {
  return Response.json({ error }, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function validatedFeedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.substack.com')
        || url.pathname !== '/feed' || url.search || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function handleSubstackFeedRequest(request, {
  secret,
  feedUrl,
  fetchImpl = fetch,
} = {}) {
  if (request.method !== 'GET') return jsonError('Method not allowed.', 405);
  if (!secretsMatch(secret, request.headers.get('x-substack-feed-secret'))) {
    return jsonError('Unauthorized.', 401);
  }
  const sourceUrl = validatedFeedUrl(feedUrl);
  if (!sourceUrl) return jsonError('Feed relay is not configured.', 503);

  const upstream = await fetchImpl(sourceUrl, {
    headers: {
      accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
      'user-agent': 'SessionGalaxySupabaseFeedRelay/1.0',
    },
  });
  if (!upstream.ok) return jsonError(`Substack feed request failed (${upstream.status}).`, 502);
  const xml = await upstream.text();
  if (!xml.trimStart().startsWith('<?xml') || !xml.includes('<rss')) {
    return jsonError('Substack returned an invalid RSS document.', 502);
  }

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
