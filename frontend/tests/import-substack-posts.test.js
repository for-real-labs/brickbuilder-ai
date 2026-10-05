import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importSubstackPosts } from '../scripts/import-substack-posts.mjs';
import { normalizeFeedItem, sanitizePostHtml } from '../scripts/substack-content.mjs';

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function createSite() {
  const root = await mkdtemp(join(tmpdir(), 'brickbuilder-substack-'));
  directories.push(root);
  await mkdir(join(root, 'public'));
  await mkdir(join(root, 'src/data'), { recursive: true });
  await writeFile(join(root, 'public/substack-imports.json'), JSON.stringify({ version: 1, items: [] }));
  await writeFile(join(root, 'src/data/substack-posts.json'), '[]');
  await writeFile(join(root, 'src/data/blog-posts.json'), JSON.stringify([{ href: '/blog/native-post' }]));
  await writeFile(join(root, 'public/sitemap.xml'), '<urlset>\n</urlset>');
  return root;
}
const item = { title: 'AI & LEGO', link: 'https://writer.substack.com/p/a-post', guid: 'post-1', contentEncoded: '<h2>Bricks</h2><p>Useful content.</p><script>bad()</script>', pubDate: 'Thu, 01 Oct 2026 12:00:00 GMT', creator: 'Jake' };
const options = (root, items = [item]) => ({ root, feedUrl: 'https://writer.substack.com/feed', fetchImpl: async () => new Response('feed'), feedParser: { parseString: async () => ({ items }) } });

describe('Substack content safety', () => {
  it('preserves safe images, links, and formatting and removes executable HTML', () => {
    const content = sanitizePostHtml('<p>Hello</p><img src="https://cdn.example/img.jpg" onerror="bad()"><a href="javascript:bad()">bad</a><script>bad()</script><iframe src="https://example.com"></iframe>');
    expect(content).toContain('<p>Hello</p>');
    expect(content).toContain('loading="lazy"');
    expect(content).toContain('rel="noopener noreferrer"');
    expect(content).not.toMatch(/javascript:|onerror|<script|<iframe/);
  });
  it('normalizes public metadata and invalid dates', () => {
    expect(normalizeFeedItem(item)).toMatchObject({ title: 'AI & LEGO', publishedAt: '2026-10-01T12:00:00.000Z', author: 'Jake' });
    expect(normalizeFeedItem({ ...item, pubDate: 'invalid' }).publishedAt).toBe(null);
  });
  it('rejects unsafe source URLs, empty titles, and absent public content', () => {
    expect(() => normalizeFeedItem({ ...item, link: 'javascript:bad()' })).toThrow('HTTP or HTTPS');
    expect(() => normalizeFeedItem({ ...item, title: '' })).toThrow('missing a title');
    expect(() => normalizeFeedItem({ title: 'Empty', link: item.link })).toThrow('missing public content');
  });
});

describe('BrickBuilder Substack import', () => {
  it('parses real RSS with content:encoded, creator, and publication date', async () => {
    const root = await createSite();
    const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>AI and LEGO</title><item><title>AI &amp; LEGO</title><link>${item.link}</link><guid>post-1</guid><dc:creator>Jake</dc:creator><pubDate>${item.pubDate}</pubDate><content:encoded><![CDATA[${item.contentEncoded}]]></content:encoded></item></channel></rss>`;
    expect(await importSubstackPosts({ root, feedUrl: 'https://writer.substack.com/feed', fetchImpl: async () => new Response(xml) })).toHaveLength(1);
    const posts = JSON.parse(await readFile(join(root, 'src/data/substack-posts.json'), 'utf8'));
    expect(posts[0]).toMatchObject({ title: 'AI & LEGO', author: 'Jake', content: '<h2>Bricks</h2><p>Useful content.</p>', publishedAt: '2026-10-01T12:00:00.000Z' });
  });
  it('imports and sanitizes new posts, updates the sitemap, and does not duplicate reruns', async () => {
    const root = await createSite();
    expect(await importSubstackPosts(options(root))).toHaveLength(1);
    expect(await importSubstackPosts(options(root))).toEqual([]);
    const posts = JSON.parse(await readFile(join(root, 'src/data/substack-posts.json'), 'utf8'));
    expect(posts).toHaveLength(1);
    expect(posts[0].content).toBe('<h2>Bricks</h2><p>Useful content.</p>');
    expect(await readFile(join(root, 'public/sitemap.xml'), 'utf8')).toContain('<loc>https://brickbuilder.ai/blog/a-post</loc>');
  });
  it('deduplicates repeated items in one feed', async () => {
    const root = await createSite();
    expect(await importSubstackPosts(options(root, [item, item]))).toHaveLength(1);
  });
  it('skips the Substack copies of already existing native posts', async () => {
    const root = await createSite();
    await writeFile(join(root, 'public/substack-imports.json'), JSON.stringify({ version: 1, items: [{ guid: item.guid, sourceUrl: item.link, slug: 'native-post' }] }));
    expect(await importSubstackPosts(options(root))).toEqual([]);
    expect(await readFile(join(root, 'src/data/substack-posts.json'), 'utf8')).toBe('[]');
  });
  it('rejects slug collisions without touching the site', async () => {
    const root = await createSite();
    await expect(importSubstackPosts(options(root, [{ ...item, link: 'https://writer.substack.com/p/native-post' }]))).rejects.toThrow('existing article');
    expect(await readFile(join(root, 'src/data/substack-posts.json'), 'utf8')).toBe('[]');
  });
  it('rejects foreign post origins and invalid slugs without writes', async () => {
    const root = await createSite();
    await expect(importSubstackPosts(options(root, [{ ...item, link: 'https://other.substack.com/p/a-post' }]))).rejects.toThrow('configured Substack');
    await expect(importSubstackPosts(options(root, [{ ...item, link: 'https://writer.substack.com/p/bad%20slug' }]))).rejects.toThrow('invalid slug');
    expect(await readFile(join(root, 'src/data/substack-posts.json'), 'utf8')).toBe('[]');
  });
  it('fails visibly when the feed request or document fails', async () => {
    const root = await createSite();
    await expect(importSubstackPosts({ ...options(root), fetchImpl: async () => new Response('Unavailable', { status: 503 }) })).rejects.toThrow('failed: 503');
    await expect(importSubstackPosts({ ...options(root), feedParser: { parseString: async () => ({}) } })).rejects.toThrow('any items');
    expect(await readFile(join(root, 'src/data/substack-posts.json'), 'utf8')).toBe('[]');
  });
  it('uses the authenticated relay and rejects missing credentials', async () => {
    const root = await createSite();
    const proxyUrl = 'https://project.supabase.co/functions/v1/substack-feed';
    await expect(importSubstackPosts({ ...options(root), proxyUrl })).rejects.toThrow('SUBSTACK_FEED_PROXY_SECRET is required');
    expect(await importSubstackPosts({ ...options(root), proxyUrl, proxySecret: 'test-secret', fetchImpl: async (url, init) => {
      expect(url).toBe(proxyUrl);
      expect(init.headers['x-substack-feed-secret']).toBe('test-secret');
      return new Response('feed');
    } })).toHaveLength(1);
  });
  it('validates configuration before requesting the feed', async () => {
    expect(await importSubstackPosts()).toEqual([]);
    await expect(importSubstackPosts({ feedUrl: 'http://writer.substack.com/feed' })).rejects.toThrow('HTTPS Substack');
    await expect(importSubstackPosts({ feedUrl: 'https://writer.substack.com/feed', maximumPosts: 0 })).rejects.toThrow('positive integer');
  });
  it('rejects invalid saved data and missing sitemap structure without writes', async () => {
    const root = await createSite();
    await writeFile(join(root, 'public/substack-imports.json'), '{"version":2,"items":[]}');
    await expect(importSubstackPosts(options(root))).rejects.toThrow('unsupported shape');
    await writeFile(join(root, 'public/substack-imports.json'), '{"version":1,"items":[]}');
    await writeFile(join(root, 'public/sitemap.xml'), 'broken');
    await expect(importSubstackPosts(options(root))).rejects.toThrow('closing tag');
    expect(await readFile(join(root, 'src/data/substack-posts.json'), 'utf8')).toBe('[]');
  });
});
