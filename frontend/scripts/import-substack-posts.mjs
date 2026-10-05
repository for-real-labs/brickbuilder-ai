import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import Parser from 'rss-parser';
import { fetchFeedItems, normalizeFeedItem } from './substack-content.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const parser = new Parser({ customFields: { item: [['content:encoded', 'contentEncoded'], ['dc:creator', 'creator']] } });

export async function importSubstackPosts({
  feedUrl, proxyUrl, proxySecret, root = ROOT, fetchImpl = fetch,
  feedParser = parser, maximumPosts = 20, now = () => new Date(),
} = {}) {
  if (!feedUrl) return [];
  const source = new URL(feedUrl);
  if (source.protocol !== 'https:' || !source.hostname.endsWith('.substack.com') || source.pathname !== '/feed' || source.search || source.hash) {
    throw new Error('SUBSTACK_FEED_URL must be an HTTPS Substack /feed URL');
  }
  if (!Number.isInteger(maximumPosts) || maximumPosts < 1) throw new Error('maximumPosts must be a positive integer');
  const feed = await fetchFeedItems(source.toString(), proxyUrl, proxySecret, fetchImpl, feedParser);
  const manifestPath = resolve(root, 'public/substack-imports.json');
  const postsPath = resolve(root, 'src/data/substack-posts.json');
  const sitemapPath = resolve(root, 'public/sitemap.xml');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const posts = JSON.parse(await readFile(postsPath, 'utf8'));
  const nativePosts = JSON.parse(await readFile(resolve(root, 'src/data/blog-posts.json'), 'utf8'));
  let sitemap = await readFile(sitemapPath, 'utf8');
  if (manifest.version !== 1 || !Array.isArray(manifest.items) || !Array.isArray(posts) || !Array.isArray(nativePosts)) {
    throw new Error('Substack import data has an unsupported shape');
  }
  if (!sitemap.includes('</urlset>')) throw new Error('Sitemap closing tag was not found');
  const importedIds = new Set(manifest.items.flatMap((item) => [item.guid, item.sourceUrl]));
  const usedSlugs = new Set([...manifest.items.map((item) => item.slug), ...nativePosts.map((post) => post.href.split('/').at(-1))]);
  const unseen = feed.map(normalizeFeedItem)
    .filter((post) => !importedIds.has(post.guid) && !importedIds.has(post.sourceUrl))
    .slice(0, maximumPosts).reverse();
  const imported = [];
  for (const post of unseen) {
    if (importedIds.has(post.guid) || importedIds.has(post.sourceUrl)) continue;
    if (new URL(post.sourceUrl).origin !== source.origin) throw new Error('Post URL does not belong to the configured Substack');
    const slug = new URL(post.sourceUrl).pathname.split('/').filter(Boolean).at(-1);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug || '')) throw new Error('Substack post has an invalid slug');
    if (usedSlugs.has(slug)) throw new Error(`Substack slug already belongs to an existing article: ${slug}`);
    usedSlugs.add(slug);
    importedIds.add(post.guid);
    importedIds.add(post.sourceUrl);
    posts.push({ ...post, slug });
    manifest.items.push({ guid: post.guid, sourceUrl: post.sourceUrl, slug, importedAt: now().toISOString() });
    const url = `https://brickbuilder.ai/blog/${slug}`;
    if (!sitemap.includes(`<loc>${url}</loc>`)) sitemap = sitemap.replace('</urlset>', `  <url><loc>${url}</loc></url>\n</urlset>`);
    imported.push({ post, slug });
  }
  if (imported.length) {
    await writeFile(postsPath, `${JSON.stringify(posts, null, 2)}\n`);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(sitemapPath, sitemap);
  }
  return imported;
}

if (basename(process.argv[1] || '') === 'import-substack-posts.mjs') {
  importSubstackPosts({
    feedUrl: process.env.SUBSTACK_FEED_URL,
    proxyUrl: process.env.SUBSTACK_FEED_PROXY_URL,
    proxySecret: process.env.SUBSTACK_FEED_PROXY_SECRET,
  }).then((posts) => console.log(posts.length ? `Imported ${posts.length} Substack post(s): ${posts.map(({ slug }) => slug).join(', ')}` : 'No new Substack posts found.'))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
