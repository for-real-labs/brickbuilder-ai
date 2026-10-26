import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { SubstackSubscribe } from '../src/components/SubstackSubscribe';
import BlogIndexPage from '../src/pages/BlogIndexPage';
import BestAiLegoDesignTools2026Page from '../src/pages/BestAiLegoDesignTools2026Page';
import UsingAiToDesignLego2026Page from '../src/pages/UsingAiToDesignLego2026Page';
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('../src/components/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('../src/components/SiteFooter', () => ({ SiteFooter: () => null }));
it('uses the official compact email embed and a direct fallback', () => {
  const html=renderToStaticMarkup(<SubstackSubscribe placement="article" />);
  expect(html).toContain('src="https://legoai.substack.com/embed"');
  expect(html).toContain('height="150"');
  expect(html).toContain('Subscribe to AI and LEGO newsletter</h2>');
  expect(html).toContain('loading="lazy"');
  expect(html).toContain('title="AI and LEGO email subscription"');
  expect(html).toContain('href="https://legoai.substack.com/subscribe"');
});
it('places the subscription above index articles and after both native articles', () => {
  const index=renderToStaticMarkup(<MemoryRouter><BlogIndexPage /></MemoryRouter>);
  expect(index.indexOf('<iframe')).toBeLessThan(index.indexOf('<article'));
  for (const Page of [BestAiLegoDesignTools2026Page,UsingAiToDesignLego2026Page]) {
    const html=renderToStaticMarkup(<MemoryRouter><Page /></MemoryRouter>);
    expect(html.indexOf('<iframe')).toBeGreaterThan(html.indexOf('</article>'));
  }
});
it('tracks fallback clicks without email addresses', async () => {
  const container=document.createElement('div'); const root=createRoot(container);
  try {
    await act(async()=>root.render(<SubstackSubscribe placement="blog_index" />));
    const link=container.querySelector('a')!;
    link.addEventListener('click',e=>e.preventDefault());
    await act(async()=>link.click());
    expect(posthog.capture).toHaveBeenCalledWith('blog_subscribe_link_clicked',{placement:'blog_index'});
  } finally {await act(async()=>root.unmount());}
});
