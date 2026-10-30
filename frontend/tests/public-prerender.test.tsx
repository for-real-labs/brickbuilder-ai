// @vitest-environment node
import React from 'react';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { publicPagePaths, renderPublicDocument } from '../src/public-prerender';
import { IMAGE_MODEL_PAGES } from '../src/imageModelPages';
import { getBlogPosts } from '../src/utils/blog-posts';

vi.stubGlobal('React', React);
vi.stubGlobal('localStorage', { clear() {}, getItem() { return null; }, setItem() {} });

const shell = readFileSync('index.html', 'utf8');
const landingPaths = ['/', '/image-to-lego', '/photo-to-lego', '/use-ai-to-edit-ldraw'];
const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
const sitemap = new JSDOM(readFileSync('public/sitemap.xml', 'utf8'), { contentType: 'text/xml' }).window.document;

describe('public page indexing', () => {
  it.each(publicPagePaths)('serves unique content and one self canonical before JavaScript at %s', (path) => {
    const document = new JSDOM(renderPublicDocument(shell, path)).window.document;
    const url = `https://brickbuilder.ai${path}`;
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(url);
    expect(document.head.querySelectorAll('title')).toHaveLength(1);
    // The site controls the iOS prompt in every browser; avoid a duplicate Safari-owned banner.
    expect(document.head.querySelector('meta[name="apple-itunes-app"]')).toBeNull();
    for (const selector of ['meta[name="description"]', 'meta[name="robots"]', 'meta[property="og:url"]', 'meta[name="twitter:url"]']) {
      expect(document.head.querySelectorAll(selector)).toHaveLength(1);
    }
    expect(document.head.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(url);
    expect(document.head.querySelector('meta[name="twitter:url"]')?.getAttribute('content')).toBe(url);
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('index, follow');
    expect(document.querySelector('#root h1')).not.toBeNull();
    expect(document.querySelector('#root')?.textContent?.length).toBeGreaterThan(100);
    expect(document.querySelector('script[src="/src/main.tsx"]')).not.toBeNull();
    if (landingPaths.includes(path)) {
      expect(document.querySelector('footer')).toBeNull();
      expect(document.querySelector('#how-it-works')).toBeNull();
      expect(document.querySelector('[aria-label="Community models"]')).toBeNull();
    } else {
      expect(document.querySelector('footer a[href="https://apps.apple.com/app/brickbuilder-ai/id6815050463"]')?.textContent).toContain('Download for iOS');
    }
    const schemas = Array.from(document.head.querySelectorAll('script[type="application/ld+json"]'));
    expect(schemas).toHaveLength(1);
    const schema = JSON.parse(schemas[0].textContent!);
    expect(JSON.stringify(schema)).toContain(url);
    expect(JSON.stringify(schema)).not.toContain('aggregateRating');
  });

  it.each(['static shell', 'prerender'])('keeps homepage SEO consistent in the %s', source => {
    const document = new JSDOM(source === 'static shell' ? shell : renderPublicDocument(shell, '/')).window.document;
    const title = 'Free AI LEGO-compatible Model Maker | BrickBuilder AI';
    expect(document.title).toBe(title);
    for (const selector of ['meta[name="title"]', 'meta[property="og:title"]', 'meta[name="twitter:title"]']) {
      expect(document.querySelector(selector)?.getAttribute('content')).toBe(title);
    }
    const description = 'Create LEGO-compatible models from text or photos with AI. Start with free monthly credits, preview your model in 3D, and download free building instructions.';
    for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
      expect(document.querySelector(selector)?.getAttribute('content')).toBe(description);
    }
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      expect(JSON.parse(script.textContent!).description).toBe(description);
    }
    expect(document.querySelector('meta[property="og:image"]')?.getAttribute('content')).toBe('https://brickbuilder.ai/share-card.png');
    expect(document.querySelector('meta[property="og:image:width"]')?.getAttribute('content')).toBe('1200');
    expect(document.querySelector('meta[property="og:image:height"]')?.getAttribute('content')).toBe('630');
    expect(document.querySelector('meta[property="og:image:alt"]')?.getAttribute('content')).toContain('Pip');
    expect(document.head.textContent).not.toMatch(/experimental|results may vary|beta 1\.0/i);
  });

  it.each(landingPaths)('omits the iOS download from the landing header before JavaScript at %s', path => {
    const document = new JSDOM(renderPublicDocument(shell, path)).window.document;
    expect(document.querySelector('nav[aria-label="Main navigation"] a[href="https://apps.apple.com/app/brickbuilder-ai/id6815050463"]')).toBeNull();
  });

  it('pre-renders every sitemap URL and every native or imported blog article', () => {
    const urls = Array.from(sitemap.querySelectorAll('loc')).map((node) => node.textContent!);
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) expect(publicPagePaths).toContain(new URL(url).pathname);
    for (const post of getBlogPosts()) expect(publicPagePaths).toContain(post.href);
    expect(urls).not.toContain('https://brickbuilder.ai/landing');
    expect(new Set(publicPagePaths).size).toBe(publicPagePaths.length);
  });

  it('routes public URLs to their generated documents before the SPA fallback', () => {
    for (const path of publicPagePaths.filter((path) => path !== '/')) {
      const source = path.startsWith('/blog/') ? '/blog/:slug' : path;
      const destination = `${source}.html`;
      expect(config.rewrites.slice(0, -1)).toContainEqual({ source, destination });
      expect(config.redirects).toContainEqual({ source: destination, destination: source, permanent: true });
    }
    expect(config.rewrites.at(-1).destination).toBe('/index.html');
    const fallback = new RegExp(`^${config.rewrites.at(-1).source}$`);
    expect(fallback.test('/dashboard')).toBe(true);
    for (const path of publicPagePaths.filter((path) => path !== '/')) {
      expect(fallback.test(`${path}.html`)).toBe(false);
    }
    for (const path of ['/assets/app.js', '/sitemap.xml', '/robots.txt', '/substack-imports.json', '/og-preview.html']) {
      expect(fallback.test(path)).toBe(false);
    }
    expect(config.trailingSlash).toBe(false);
    expect(config.redirects).toContainEqual({ source: '/landing', destination: '/', permanent: true });
    expect(config.redirects).toContainEqual({ source: '/index.html', destination: '/', permanent: true });
  });

  it('rejects unknown routes, traversal, and incomplete application shells', () => {
    for (const path of ['/missing', '/blog/missing', '/../privacy', '/landing']) {
      expect(() => renderPublicDocument(shell, path)).toThrow('Unsupported public page');
    }
    expect(() => renderPublicDocument('<html></html>', '/')).toThrow('missing application shell');
  });

  it('publishes dedicated OBJ metadata, matching FAQ schema, and crawlable converter links', () => {
    const document = new JSDOM(renderPublicDocument(shell, '/obj-to-lego')).window.document;
    expect(document.title).toBe('OBJ to LEGO Converter | 3D Model to LEGO | BrickBuilder AI');
    expect(document.querySelector('h1')?.textContent).toBe('OBJ to LEGO Converter');
    expect(document.querySelector('input[type=file]')?.getAttribute('accept')).toBe('.obj');
    expect(document.querySelector('a[href="/glb-to-lego"]')).not.toBeNull();
    const schemas = JSON.parse(document.querySelector('script[type="application/ld+json"]')!.textContent!);
    expect(schemas[0].url).toBe('https://brickbuilder.ai/obj-to-lego');
    for (const question of schemas[1].mainEntity) {
      expect(document.querySelector('main')?.textContent).toContain(question.name);
      expect(document.querySelector('main')?.textContent).toContain(question.acceptedAnswer.text);
    }
    expect(schemas[0].offers).toBeUndefined();
    expect(Array.from(sitemap.querySelectorAll('loc')).map(node => node.textContent)).toContain('https://brickbuilder.ai/obj-to-lego');
  });

  it.each(IMAGE_MODEL_PAGES)('publishes unique image conversion content, matching FAQ data, and LEGO links at $path', page => {
    const document = new JSDOM(renderPublicDocument(shell, page.path)).window.document;
    expect(document.title).toBe(page.title);
    expect(document.querySelector('h1')?.textContent).toBe(page.name);
    expect(document.querySelector('main')?.textContent).toContain(page.body);
    const schemas = JSON.parse(document.querySelector('script[type="application/ld+json"]')!.textContent!);
    expect(schemas[0].url).toBe(`https://brickbuilder.ai${page.path}`);
    expect(schemas[0].offers).toBeUndefined();
    expect(schemas[2]['@type']).toBe('BreadcrumbList');
    for (const question of schemas[1].mainEntity) {
      expect(document.querySelector('main')?.textContent).toContain(question.name);
      expect(document.querySelector('main')?.textContent).toContain(question.acceptedAnswer.text);
    }
    for (const destination of ['/glb-to-lego', '/image-to-lego', '/#landing-build-prompt']) {
      expect(document.querySelector(`aside a[href="${destination}"]`)).not.toBeNull();
    }
    for (const other of IMAGE_MODEL_PAGES) {
      expect(document.querySelector(`a[href="${other.path}"]`)).not.toBeNull();
      expect(Array.from(sitemap.querySelectorAll('loc')).map(node => node.textContent)).toContain(`https://brickbuilder.ai${other.path}`);
    }
  });

  it('keeps successive article and converter renders independent', () => {
    const article = new JSDOM(renderPublicDocument(shell, '/blog/using-ai-to-design-lego-in-2026')).window.document;
    const converter = new JSDOM(renderPublicDocument(shell, '/glb-to-lego')).window.document;
    expect(article.title).toBe('Using AI to Design LEGO in 2026 | BrickBuilder AI');
    expect(article.head.querySelector('meta[property="og:type"]')?.getAttribute('content')).toBe('article');
    expect(converter.title).toBe('GLB to LEGO Converter | 3D Model to LEGO | BrickBuilder AI');
    expect(converter.head.querySelector('meta[property="og:type"]')?.getAttribute('content')).toBe('website');
  });
});
