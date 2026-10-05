import sanitizeHtml from 'sanitize-html';

function safeHttpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return url.toString();
}

function plainText(value) {
  return sanitizeHtml(String(value || ''), { allowedTags: [], allowedAttributes: {} })
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerpt(value, maximumLength = 180) {
  const text = plainText(value);
  if (text.length <= maximumLength) return text;
  return `${text.slice(0, maximumLength - 1).replace(/\s+\S*$/, '')}…`;
}

export async function fetchFeedItems(feedUrl, proxyUrl, proxySecret, fetchImpl, feedParser) {
  const requestUrl = proxyUrl
    ? safeHttpUrl(proxyUrl, 'SUBSTACK_FEED_PROXY_URL')
    : feedUrl;
  if (proxyUrl && !proxySecret) {
    throw new Error('SUBSTACK_FEED_PROXY_SECRET is required when the feed proxy is configured');
  }
  const response = await fetchImpl(requestUrl, {
    headers: {
      accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
      'user-agent': 'SessionGalaxySubstackImporter/1.0',
      ...(proxyUrl ? { 'x-substack-feed-secret': proxySecret } : {}),
    },
  });
  if (!response.ok) {
    const source = proxyUrl ? 'proxy' : 'request';
    throw new Error(`Substack feed ${source} failed: ${response.status}`);
  }
  const feed = await feedParser.parseString(await response.text());
  if (!Array.isArray(feed.items)) throw new Error('Substack feed did not contain any items');
  return feed.items;
}

export function sanitizePostHtml(value) {
  return sanitizeHtml(String(value || ''), {
    allowedTags: [
      'p', 'br', 'h2', 'h3', 'h4', 'strong', 'em', 's', 'blockquote',
      'ul', 'ol', 'li', 'a', 'img', 'figure', 'figcaption', 'hr', 'pre', 'code',
    ],
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attributes) => ({
        tagName,
        attribs: { ...attributes, rel: 'noopener noreferrer' },
      }),
      img: (tagName, attributes) => ({
        tagName,
        attribs: { ...attributes, loading: 'lazy', decoding: 'async' },
      }),
    },
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding'],
    },
  });
}

export function normalizeFeedItem(item) {
  const title = plainText(item?.title);
  const sourceUrl = safeHttpUrl(item?.link, 'Substack post URL');
  const guid = plainText(item?.guid || sourceUrl);
  const content = sanitizePostHtml(
    item?.contentEncoded || item?.content || item?.description || '',
  );
  const description = excerpt(item?.contentSnippet || item?.description || content);

  if (!title) throw new Error('Substack post is missing a title');
  if (!guid) throw new Error(`Substack post "${title}" is missing an identifier`);
  if (!content) throw new Error(`Substack post "${title}" is missing public content`);

  const publishedDate = new Date(item?.isoDate || item?.pubDate || '');
  return {
    title,
    sourceUrl,
    guid,
    content,
    description: description || `Originally published on Substack: ${title}`,
    author: plainText(item?.creator || ''),
    publishedAt: Number.isNaN(publishedDate.getTime()) ? null : publishedDate.toISOString(),
  };
}

