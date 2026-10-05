import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import posthog from 'posthog-js';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { getBlogPosts, findSubstackPost, type SubstackPost } from '../src/utils/blog-posts';

vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('../src/components/SiteFooter', () => ({ SiteFooter: () => null }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/data/substack-posts.json', () => ({ default: [{
  title: 'New brick ideas', description: 'A public post', slug: 'new-brick-ideas', guid: 'post-1',
  sourceUrl: 'https://writer.substack.com/p/new-brick-ideas', content: '<h2>Build</h2><p>Use bricks.</p>',
  author: 'Jake', publishedAt: '2026-10-05T00:00:00.000Z',
}] }));
import SubstackPostPage from '../src/pages/SubstackPostPage';

const post: SubstackPost = { title: 'Latest', description: 'Ideas', slug: 'latest', guid: '1', sourceUrl: 'https://writer.substack.com/p/latest', content: '<p>Bricks.</p>', author: 'Jake', publishedAt: '2026-10-05T00:00:00.000Z' };

describe('blog post selection', () => {
  it('sorts new imports ahead of existing articles without changing native URLs', () => {
    const posts = getBlogPosts([post]);
    expect(posts[0].href).toBe('/blog/latest');
    expect(posts[0].date).toBe('October 5, 2026');
    expect(posts.map((item) => item.href)).toContain('/blog/using-ai-to-design-lego-in-2026');
  });
  it('handles no imported posts and missing dates', () => {
    expect(getBlogPosts([])).toHaveLength(2);
    expect(getBlogPosts([{ ...post, publishedAt: null }]).at(-1)?.date).toBe('AI and LEGO');
  });
  it('finds exact slugs and leaves unknown or absent slugs unmatched', () => {
    expect(findSubstackPost('latest', [post])).toBe(post);
    expect(findSubstackPost('missing', [post])).toBeUndefined();
    expect(findSubstackPost(undefined, [post])).toBeUndefined();
  });
});

describe('Substack article route', () => {
  it('tracks source-link clicks with categorical context only', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<MemoryRouter initialEntries={['/blog/new-brick-ideas']}><Routes><Route path="/blog/:slug" element={<SubstackPostPage />} /></Routes></MemoryRouter>));
      const link = container.querySelector('a[href="https://writer.substack.com/p/new-brick-ideas"]')!;
      link.addEventListener('click', (event) => event.preventDefault());
      await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
      expect(posthog.capture).toHaveBeenCalledWith('blog_original_source_clicked', { source: 'substack' });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  it('renders imported public content with attribution and its original link', () => {
    const markup = renderToStaticMarkup(<MemoryRouter initialEntries={['/blog/new-brick-ideas']}><Routes><Route path="/blog/:slug" element={<SubstackPostPage />} /></Routes></MemoryRouter>);
    expect(markup).toContain('<h2>Build</h2><p>Use bricks.</p>');
    expect(markup).toContain('New brick ideas');
    expect(markup).toContain('https://writer.substack.com/p/new-brick-ideas');
    expect(markup).toContain('October 5, 2026');
  });
  it('renders no article for an unknown slug', () => {
    const markup = renderToStaticMarkup(<MemoryRouter initialEntries={['/blog/missing']}><Routes><Route path="/blog/:slug" element={<SubstackPostPage />} /></Routes></MemoryRouter>);
    expect(markup).not.toContain('substack-article');
  });
});
